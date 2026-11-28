// Motor de envio: processa os destinatários pendentes de uma operação em lotes por segundo.
// Cada execução roda por até ~45 s e agenda a próxima até terminar a operação.
const { decrypt } = require('./secrets');
const { describeTemplate, buildTemplatePayload, sendTemplate, subscribeApp, isRetryable } = require('./meta');

const RUN_BUDGET_MS = 45000;

// Erros que indicam que a BM/número chegou ao limite ou foi travado pela Meta (não o contato):
// 131048 limite de envio, 131031 conta bloqueada, 131042 pagamento, 368 bloqueio temporário, 130497 país bloqueado.
const BM_LIMIT_RE = /\(#(131048|131031|131042|368|130497)\)/;
const BM_LIMIT_SQL = '\\(#(131048|131031|131042|368|130497)\\)';
// Falhas do contato (número sem WhatsApp, inválido, não entregue): não gastam o limite da BM; a vaga é reaproveitada.
const CONTACT_FAIL_SQL = '\\(#(131026|131009|131021|131049|131050)\\)';
// Falhas que não contam como "da BM": envio interrompido e lotes marcados na conferência com a Meta.
const NOT_BM_SQL = '^(Envio interrompido|Não enviada:|Devolvido para a reserva)';
const RETURNED = 'Devolvido para a reserva';
const ERR_HEAD_SQL = '\\(#[0-9]+\\)[^(]{0,60}';
const BM_GRACE_MS = 20000; // depois do último envio, segue de olho nas falhas da BM que chegam pelo webhook
const BM_WINDOW = 40;      // últimas tentativas olhadas para detectar BM com problema
const BM_TRIP = 0.5;       // metade ou mais falhando por motivo da BM: para o lote
const GRACE_MS = Number(process.env.DISPLY_GRACE_MS) || 90000;    // depois do último envio, espera as falhas que chegam pelo webhook antes de encerrar o lote
const FILL_WINDOW = 100;   // olha as últimas N tentativas
const FILL_TRIP = 15;      // a partir de N falhas de limite nessa janela, passa para a próxima BM
const LOCK_MS = 70000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadContext(sql, opId) {
  const ops = await sql`select * from wa_operations where id = ${opId}`;
  if (!ops.length) return null;
  const op = ops[0];
  const inst = (await sql`select * from wa_instances where id = ${op.instance_id}`)[0];
  const tpl = (await sql`select * from wa_templates where id = ${op.template_id}`)[0];
  if (!inst || !tpl) return { op, error: 'Instância ou template não encontrado.' };
  try { op.body_vars_obj = JSON.parse(op.body_vars || '{}'); } catch { op.body_vars_obj = {}; }
  return { op, inst, tpl, info: describeTemplate(tpl.components), token: decrypt(inst.token_enc) };
}

// Envia uma mensagem e devolve o resultado (sem gravar).
async function sendOne(ctx, contact) {
  const payload = buildTemplatePayload(ctx.tpl, ctx.info, ctx.op, contact);
  try {
    let r;
    try { r = await sendTemplate(ctx.inst.phone_number_id, ctx.token, contact.phone, payload); }
    catch (err) {
      // (#10) sem permissão: normalmente o app do token ainda não está ligado à conta do WhatsApp.
      // Liga o app (sem trocar o webhook de outras plataformas) uma única vez e tenta de novo.
      if (Number(err.code) !== 10 || ctx.linkedApp) throw err;
      ctx.linkedApp = true;
      await subscribeApp(ctx.inst.waba_id, ctx.token, null).catch(() => {});
      r = await sendTemplate(ctx.inst.phone_number_id, ctx.token, contact.phone, payload);
    }
    return { ok: true, wamid: r.messages && r.messages[0] && r.messages[0].id };
  } catch (err) {
    return { ok: false, retry: isRetryable(err), error: `${err.code ? '(#' + err.code + ') ' : ''}${err.message}`.slice(0, 400) };
  }
}

// Tenta pegar a "vez" de processar a operação (evita dois processos ao mesmo tempo).
async function acquire(sql, opId) {
  const now = new Date();
  const rows = await sql`update wa_operations set lock_until = ${new Date(now.getTime() + LOCK_MS)}
    where id = ${opId} and status = 'running' and (lock_until is null or lock_until < ${now})
    returning id`;
  return rows.length > 0;
}

async function release(sql, opId) {
  await sql`update wa_operations set lock_until = null where id = ${opId}`;
}

// Modo "encher cada BM": encerra este lote e passa o que falta (pendentes + recusados por limite) para a próxima BM.
async function cascade(sql, op, reason) {
  const next = op.group_id ? (await sql`select id, tag from wa_operations where group_id = ${op.group_id} and status = 'waiting' order by id limit 1`)[0] : null;
  const rows = await sql`select id from wa_recipients where operation_id = ${op.id}
    and (status = 'pending' or (status = 'failed' and not (coalesce(error,'') ~ ${CONTACT_FAIL_SQL}) and not (coalesce(error,'') ~ ${NOT_BM_SQL})))`;
  const ids = rows.map((r) => r.id);
  await sql`update wa_operations set status = 'done', finished_at = now() where id = ${op.id} and status = 'running'`;
  if (!ids.length) return { more: false };
  if (!next) {
    await sql`update wa_recipients set status = 'skipped', error = ${'Todas as BMs da campanha chegaram ao limite (' + reason + ')'}, updated_at = now()
      where id = any(${ids}::bigint[]) and status = 'pending'`;
    return { more: false };
  }
  await sql`insert into wa_recipients (operation_id, name, phone) select ${next.id}::int, name, phone from wa_recipients where id = any(${ids}::bigint[]) order by id`;
  await sql`update wa_recipients set status = 'skipped', error = ${'Transferido para o lote ' + next.tag + ' (' + reason + ')'}, updated_at = now() where id = any(${ids}::bigint[])`;
  await sql`update wa_operations set quantity = ${ids.length}, status = 'running' where id = ${next.id} and status = 'waiting'`;
  return { more: false, next: next.id, moved: ids.length, reason };
}

// Contagem para o modo "encher": quantas tentativas valeram e quantas falharam por limite da BM.
async function fillStats(sql, opId) {
  const [a] = await sql`select count(*) filter (where status in ('sending','sent','delivered','read') or (status = 'failed' and not (coalesce(error,'') ~ ${BM_LIMIT_SQL})))::int as n,
      count(*) filter (where status = 'failed' and coalesce(error,'') ~ ${CONTACT_FAIL_SQL})::int as cfail,
      count(*) filter (where status not in ('pending','skipped'))::int as tried
    from wa_recipients where operation_id = ${opId}`;
  const [b] = await sql`select count(*) filter (where status = 'failed' and error ~ ${BM_LIMIT_SQL})::int as n
    from (select status, error from wa_recipients where operation_id = ${opId} and status not in ('pending','skipped') order by updated_at desc limit ${FILL_WINDOW}::int) x`;
  // Falhas do contato não contam no máximo da BM, a não ser que sejam demais (template ou BM com problema).
  const sent = healthy(a) ? a.n - a.cfail : a.n;
  return { sent, limitFails: b.n };
}

// Muitas falhas "do contato" seguidas indicam problema no template ou na BM: aí não reaproveita as vagas.
const healthy = (q) => q.tried < 50 || q.cfail <= q.tried * 0.4;

async function quotaUsed(sql, opId) {
  const [q] = await sql`select count(*) filter (where status <> 'skipped' and not (status = 'failed' and coalesce(error,'') ~ ${CONTACT_FAIL_SQL}))::int as used,
      count(*) filter (where status = 'failed' and coalesce(error,'') ~ ${CONTACT_FAIL_SQL})::int as cfail,
      count(*) filter (where status not in ('pending','skipped'))::int as tried, max(sent_at) as last_at
    from wa_recipients where operation_id = ${opId}`;
  return q;
}

// Saúde da BM neste lote: nas últimas tentativas, quantas falharam por motivo da BM (não do contato).
async function bmHealth(sql, opId) {
  const [h] = await sql`select count(*)::int as tried,
      count(*) filter (where status = 'failed' and not (coalesce(error,'') ~ ${CONTACT_FAIL_SQL}) and not (coalesce(error,'') ~ ${NOT_BM_SQL}))::int as bad,
      mode() within group (order by case when status = 'failed' then substring(coalesce(error,'') from ${ERR_HEAD_SQL}) end) as top
    from (select status, error from wa_recipients where operation_id = ${opId} and status not in ('pending','skipped')
          order by updated_at desc limit ${BM_WINDOW}::int) x`;
  const [c] = await sql`select max(sent_at) as last_at from wa_recipients where operation_id = ${opId}`;
  return { ...h, last_at: c.last_at };
}

// BM com problema: para o lote e devolve à reserva o que ainda não saiu e o que falhou por causa da BM
// (o contato não recebeu), para outras BMs usarem.
async function stopLot(sql, op, reason) {
  const msg = (RETURNED + ' (' + reason + ')').slice(0, 400);
  const r = await sql`update wa_recipients set status = 'skipped', error = ${msg}, updated_at = now()
    where operation_id = ${op.id} and (status = 'pending' or (status = 'failed' and not (coalesce(error,'') ~ ${CONTACT_FAIL_SQL}) and not (coalesce(error,'') ~ ${NOT_BM_SQL})))
    returning id`;
  await sql`update wa_operations set status = 'done', finished_at = now(), stop_reason = ${('BM com problema: ' + reason).slice(0, 300)} where id = ${op.id} and status = 'running'`;
  const head = op.group_id || op.id;
  // Garante que a campanha tenha reserva para os devolvidos.
  await sql`update wa_operations set reserve_cap = coalesce(reserve_cap, (select count(*) from wa_recipients r join wa_operations g on g.id = r.operation_id where g.id = ${head} or g.group_id = ${head})),
    reserve_incl = coalesce(reserve_incl, false) where id = ${head}`;
  return { more: false, stopped: true, returned: r.length, reason };
}

// Puxa até `want` leads da reserva da campanha para este lote. Devolve quantos vieram (-1 = outro lote está puxando).
async function refill(sql, op, want) {
  const head = op.group_id || op.id;
  const [h] = await sql`update wa_operations set reserve_lock = now() + interval '20 seconds'
    where id = ${head} and reserve_cap is not null and (reserve_lock is null or reserve_lock < now())
    returning list_id, reserve_cap, reserve_seed, reserve_incl`;
  if (!h) {
    const [x] = await sql`select reserve_cap from wa_operations where id = ${head}`;
    return x && x.reserve_cap != null ? -1 : 0;
  }
  try {
    const [a] = await sql`select count(*)::int as n from wa_recipients r join wa_operations g on g.id = r.operation_id
      where (g.id = ${head} or g.group_id = ${head}) and not (r.status = 'skipped' and (coalesce(r.error,'') like 'Transferido para o lote %' or coalesce(r.error,'') like ${RETURNED + '%'}))`;
    const n = Math.min(want, h.reserve_cap - a.n);
    if (n <= 0) return 0;
    const seed = h.reserve_seed || null;
    const rows = await sql`insert into wa_recipients (operation_id, name, phone)
      select ${op.id}::int, c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
      where c.list_id = ${h.list_id}::int and (o.phone is null or ${Boolean(h.reserve_incl)}::boolean)
        and not exists (select 1 from wa_recipients r join wa_operations g on g.id = r.operation_id
                        where (g.id = ${head} or g.group_id = ${head}) and r.phone = c.phone
                          and not (r.status = 'skipped' and coalesce(r.error,'') like ${RETURNED + '%'}))
      order by case when ${seed}::text is null then null else md5(c.phone || ${seed}::text) end, c.id
      limit ${n}::int returning id`;
    if (rows.length) await sql`update wa_operations set quantity = coalesce(quantity, 0) + ${rows.length} where id = ${op.id}`;
    return rows.length;
  } finally {
    await sql`update wa_operations set reserve_lock = null where id = ${head}`;
  }
}

// Processa por até RUN_BUDGET_MS. Retorna { more } indicando se ainda há pendentes.
async function runOperation(sql, opId) {
  if (!(await acquire(sql, opId))) return { busy: true, more: false };
  try {
    const ctx = await loadContext(sql, opId);
    if (!ctx || ctx.error) {
      await sql`update wa_operations set status = 'error', finished_at = now() where id = ${opId}`;
      return { more: false, error: ctx && ctx.error };
    }
    if (!ctx.op.started_at) await sql`update wa_operations set started_at = now() where id = ${opId}`;

    // Mensagens que ficaram "enviando" numa execução interrompida: não reenviamos para não duplicar.
    await sql`update wa_recipients set status = 'failed', error = 'Envio interrompido antes da confirmação. Confira antes de reenviar.', updated_at = now()
      where operation_id = ${opId} and status = 'sending' and updated_at < ${new Date(Date.now() - 120000)}`;

    const tps = Math.max(1, Math.min(80, Number(ctx.op.tps) || 40));
    const fill = Boolean(ctx.op.fill_mode);
    const soft = Number(ctx.op.fill_soft) || 0;
    const cap = Number(ctx.op.fill_cap) || 0;
    const quota = Number(ctx.op.quota) || 0;
    const deadline = Date.now() + RUN_BUDGET_MS;
    let waiting = false; let noReserve = false;

    while (Date.now() < deadline) {
      const current = (await sql`select status from wa_operations where id = ${opId}`)[0];
      if (!current || current.status !== 'running') return { more: false };

      // BM com problema (nome de exibição, pagamento, template pausado, erro genérico…): para antes de queimar a lista.
      const hb = await bmHealth(sql, opId);
      if (hb.tried >= 20 && hb.bad >= hb.tried * BM_TRIP) {
        const why = (hb.top || 'falhas da BM').replace(/\s+/g, ' ').trim();
        if (fill) return await cascade(sql, ctx.op, why);
        return await stopLot(sql, ctx.op, why);
      }
      // Modo "encher": passa para a próxima BM quando chega no máximo ou a Meta começa a recusar por limite.
      let size = tps;
      if (fill) {
        const st = await fillStats(sql, opId);
        if (cap && st.sent >= cap) return await cascade(sql, ctx.op, 'máximo de ' + cap + ' na BM');
        if (st.limitFails >= FILL_TRIP) return await cascade(sql, ctx.op, 'limite da Meta');
        // Passou do limite nominal: vai mais devagar para perceber a trava da Meta a tempo.
        if (soft && st.sent >= soft) size = Math.min(tps, 20);
        if (cap) size = Math.max(1, Math.min(size, cap - st.sent));
      }

      // Pega o próximo lote e marca como "enviando" numa única consulta.
      const batch = await sql`update wa_recipients set status = 'sending', updated_at = now()
        where id in (select id from wa_recipients where operation_id = ${opId} and status = 'pending' order by id limit ${size}::int)
          and status = 'pending' returning id, name, phone`;
      if (!batch.length) {
        // No modo "encher", quem foi recusado por limite ainda pode sair pela próxima BM.
        if (fill) {
          const [f] = await sql`select count(*)::int as n from wa_recipients where operation_id = ${opId} and status = 'failed' and error ~ ${BM_LIMIT_SQL}`;
          if (f.n > 0) return await cascade(sql, ctx.op, 'limite da Meta');
        }
        // Cota da BM: o que falhou por causa do contato volta como vaga e é completado com leads da reserva.
        if (quota && !noReserve) {
          const q = await quotaUsed(sql, opId);
          const ok = healthy(q);
          const free = quota - q.used;
          if (free > 0 && ok) {
            const got = await refill(sql, ctx.op, free);
            if (got > 0) { waiting = false; continue; }
            if (got < 0) { waiting = true; await sleep(2000); continue; }
            noReserve = true;
          }
          if (!noReserve && ok && q.last_at && Date.now() - new Date(q.last_at).getTime() < GRACE_MS) {
            waiting = true; await sleep(5000); continue;
          }
        }
        // Antes de encerrar, espera as falhas que ainda chegam pelo webhook: se a BM estava com problema,
        // o lote para e os leads que não receberam voltam para a reserva.
        if (hb.last_at && Date.now() - new Date(hb.last_at).getTime() < BM_GRACE_MS) { waiting = true; await sleep(3000); continue; }
        await sql`update wa_operations set status = 'done', finished_at = now() where id = ${opId} and status = 'running'`;
        return { more: false };
      }

      const started = Date.now();
      await Promise.all(batch.map(async (row) => {
        const r = await sendOne(ctx, row);
        if (r.ok) {
          await sql`update wa_recipients set status = 'sent', wamid = ${r.wamid || null}, sent_at = now(), error = null, updated_at = now() where id = ${row.id}`;
        } else if (r.retry) {
          await sql`update wa_recipients set status = 'pending', error = ${r.error}, updated_at = now() where id = ${row.id}`;
        } else {
          await sql`update wa_recipients set status = 'failed', error = ${r.error}, updated_at = now() where id = ${row.id}`;
        }
      }));
      let wait = 1000 - (Date.now() - started);
      // Acima do limite nominal, dá tempo para as falhas de entrega (webhook) chegarem antes do próximo bloco.
      if (fill && soft && size < tps) wait = Math.max(wait, 3000);
      if (wait > 0) await sleep(wait);
    }
    const left = await sql`select count(*)::int as n from wa_recipients where operation_id = ${opId} and status = 'pending'`;
    return { more: left[0].n > 0 || waiting };
  } finally {
    await release(sql, opId);
  }
}

module.exports = { runOperation, loadContext, sendOne, BM_LIMIT_RE, CONTACT_FAIL_SQL };
