// Motor de envio: processa os destinatários pendentes de uma operação em lotes por segundo.
// Cada execução roda por até ~45 s e agenda a próxima até terminar a operação.
const { decrypt } = require('./secrets');
const { describeTemplate, buildTemplatePayload, sendTemplate, subscribeApp, isRetryable } = require('./meta');

const RUN_BUDGET_MS = 45000;
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
    const deadline = Date.now() + RUN_BUDGET_MS;

    while (Date.now() < deadline) {
      const current = (await sql`select status from wa_operations where id = ${opId}`)[0];
      if (!current || current.status !== 'running') return { more: false };

      // Pega o próximo lote e marca como "enviando" numa única consulta.
      const batch = await sql`update wa_recipients set status = 'sending', updated_at = now()
        where id in (select id from wa_recipients where operation_id = ${opId} and status = 'pending' order by id limit ${tps}::int)
          and status = 'pending' returning id, name, phone`;
      if (!batch.length) {
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
      const wait = 1000 - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    const left = await sql`select count(*)::int as n from wa_recipients where operation_id = ${opId} and status = 'pending'`;
    return { more: left[0].n > 0 };
  } finally {
    await release(sql, opId);
  }
}

module.exports = { runOperation, loadContext, sendOne };
