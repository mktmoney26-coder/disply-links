// API do módulo Ativos (BMs, números, templates, alertas). Protegida pela senha do painel.
// Rotas: ?r=overview | bms | numbers | templates | alerts | check | settings | activity
const { guard } = require('../lib/auth');
const { encrypt } = require('../lib/secrets');
const { graph } = require('../lib/meta');
const { diagnose, getAssetsDb, runCheck, notify, getSetting, setSetting, logActivity } = require('../lib/assets-monitor');
const { cronKey } = require('./ativos-cron');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

async function overview(sql) {
  const one = async (q) => { try { const r = await q; return Number((r[0] && r[0].n) || 0); } catch { return 0; } };
  const numbers = await numberRows(sql);
  const restricted = (n) => ['LIMITED', 'BLOCKED'].includes(n.health) || ['BANNED', 'FLAGGED', 'RESTRICTED'].includes(n.status) || n.quality === 'RED';
  const c = {
    bms: await one(sql`select count(*)::int as n from as_bms where active`),
    bms_erro: await one(sql`select count(*)::int as n from as_bms where active and last_error is not null`),
    numeros: numbers.length,
    restritos: numbers.filter(restricted).length,
    parados: numbers.filter((n) => n.dias_parado == null || n.dias_parado >= 7).length,
    alertas: await one(sql`select count(*)::int as n from as_alerts where not seen`),
    templates_ruins: await one(sql`select count(*)::int as n from as_templates t join as_bms b on b.id = t.bm_ref and b.active where t.status in ('PAUSED','DISABLED','REJECTED')`),
    ops_ativas: await one(sql`select count(*)::int as n from wa_operations where status in ('running','paused')`),
    enviadas_24h: await one(sql`select count(*)::int as n from wa_recipients where sent_at > now() - interval '24 hours'`),
    inbox_nao_lidas: await one(sql`select count(*)::int as n from wa_inbound where not is_read`),
    cliques_24h: await one(sql`select count(*)::int as n from clicks where created_at > now() - interval '24 hours'`)
  };
  const alerts = await sql`select a.*, b.name as bm from as_alerts a left join as_bms b on b.id = a.bm_ref
    where not a.seen order by a.created_at desc limit 50`;
  return { ...c, last_run: await getSetting(sql, 'last_run'), alerts };
}

// Números com as métricas de envio desta plataforma (últimos 30 dias e último envio).
async function numberRows(sql) {
  const rows = await sql`select n.*, b.name as bm, b.profile, b.supplier, w.name as waba_name,
      i.id as instance_id, s.sent30 as plat_sent30, s.last_sent as plat_last
    from as_numbers n
    join as_bms b on b.id = n.bm_ref and b.active
    left join as_wabas w on w.waba_id = n.waba_id
    left join wa_instances i on i.phone_number_id = n.phone_number_id
    left join (
      select r_i.phone_number_id, count(*)::int as sent30, max(r.sent_at) as last_sent
      from wa_recipients r
      join wa_operations o on o.id = r.operation_id
      join wa_instances r_i on r_i.id = o.instance_id
      where r.sent_at > now() - interval '30 days'
      group by r_i.phone_number_id
    ) s on s.phone_number_id = n.phone_number_id
    order by b.name, n.display_phone`;
  const now = Date.now();
  return rows.map((n) => {
    const lasts = [n.last_sent, n.plat_last].filter(Boolean).map((d) => new Date(d).getTime());
    const last = lasts.length ? Math.max(...lasts) : null;
    return {
      ...n,
      sent30: Math.max(Number(n.sent30 || 0), Number(n.plat_sent30 || 0)),
      last_sent: last ? new Date(last).toISOString() : null,
      dias_parado: last ? Math.max(0, Math.floor((now - last) / 86400000)) : null
    };
  });
}

async function bms(sql, req, body, a) {
  if (req.method === 'GET') {
    return sql`select b.id, b.profile, b.name, b.bm_id, b.waba_ids, b.supplier, b.launched_at, b.active, b.last_check, b.last_error, b.created_at,
        coalesce(w.c, 0)::int as contas, coalesce(n.c, 0)::int as numeros
      from as_bms b
      left join (select bm_ref, count(*) as c from as_wabas group by bm_ref) w on w.bm_ref = b.id
      left join (select bm_ref, count(*) as c from as_numbers group by bm_ref) n on n.bm_ref = b.id
      order by b.active desc, b.name`;
  }
  if (req.method === 'POST' && a === 'create') {
    const name = clean(body.name, 120); const bmId = clean(body.bm_id, 30).replace(/\D/g, '');
    const token = clean(body.token, 1000);
    if (!name) throw new HttpError(400, 'Informe o nome da BM.');
    if (!/^\d{5,25}$/.test(bmId)) throw new HttpError(400, 'ID da BM inválido (só números).');
    if (token.length < 20) throw new HttpError(400, 'Cole o token do usuário do sistema.');
    try { await graph(`/${bmId}?fields=id,name`, token); }
    catch (err) { throw new HttpError(400, `A Meta recusou o token para esta BM: ${err.message}`); }
    const launched = /^\d{4}-\d{2}-\d{2}$/.test(String(body.launched_at || '')) ? body.launched_at : new Date().toISOString().slice(0, 10);
    let row;
    try {
      [row] = await sql`insert into as_bms (profile, name, bm_id, waba_ids, supplier, launched_at, token_enc)
        values (${clean(body.profile, 80) || null}, ${name}, ${bmId}, ${clean(body.waba_ids, 500) || null}, ${clean(body.supplier, 120) || null}, ${launched}, ${encrypt(token)})
        returning id`;
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) throw new HttpError(400, 'Esta BM já está cadastrada.');
      throw err;
    }
    await logActivity(sql, `BM cadastrada: ${name}`);
    await runCheck(sql, row.id);
    return { ok: true, id: row.id };
  }
  if (req.method === 'PATCH') {
    const id = Number(body.id);
    const [bm] = await sql`select * from as_bms where id = ${id}`;
    if (!bm) throw new HttpError(404, 'BM não encontrada.');
    if (a === 'diag') return { bm: bm.name, etapas: await diagnose(bm) };
    if (a === 'delete') {
      await sql`delete from as_templates where bm_ref = ${id}`;
      await sql`delete from as_numbers where bm_ref = ${id}`;
      await sql`delete from as_wabas where bm_ref = ${id}`;
      await sql`delete from as_alerts where bm_ref = ${id}`;
      await sql`delete from as_bms where id = ${id}`;
      await logActivity(sql, `BM removida: ${bm.name}`);
      return { ok: true };
    }
    let tokenEnc = bm.token_enc;
    if (body.token) {
      const token = clean(body.token, 1000);
      try { await graph(`/${bm.bm_id}?fields=id`, token); }
      catch (err) { throw new HttpError(400, `A Meta recusou o novo token: ${err.message}`); }
      tokenEnc = encrypt(token);
    }
    const pick = (k, max) => (body[k] !== undefined ? clean(body[k], max) || null : bm[k]);
    const launched = /^\d{4}-\d{2}-\d{2}$/.test(String(body.launched_at || '')) ? body.launched_at : bm.launched_at;
    const active = body.active === undefined ? bm.active : Boolean(body.active);
    await sql`update as_bms set profile = ${pick('profile', 80)}, name = ${pick('name', 120) || bm.name}, waba_ids = ${pick('waba_ids', 500)},
      supplier = ${pick('supplier', 120)}, launched_at = ${launched}, token_enc = ${tokenEnc}, active = ${active} where id = ${id}`;
    await logActivity(sql, `BM editada: ${bm.name}${body.token ? ' (token trocado)' : ''}${active !== bm.active ? (active ? ' (reativada)' : ' (pausada)') : ''}`);
    return { ok: true };
  }
  throw new HttpError(405, 'Método não permitido.');
}

async function alerts(sql, req, body, a) {
  if (req.method === 'GET') {
    const all = String(req.query.todos || '') === '1';
    return all
      ? sql`select a.*, b.name as bm from as_alerts a left join as_bms b on b.id = a.bm_ref order by a.created_at desc limit 300`
      : sql`select a.*, b.name as bm from as_alerts a left join as_bms b on b.id = a.bm_ref where not a.seen order by a.created_at desc limit 300`;
  }
  if (req.method === 'POST' && a === 'seen') { await sql`update as_alerts set seen = true where id = ${Number(body.id)}`; return { ok: true }; }
  if (req.method === 'POST' && a === 'seen-all') { await sql`update as_alerts set seen = true where not seen`; return { ok: true }; }
  throw new HttpError(405, 'Método não permitido.');
}

async function settings(sql, req, body, a) {
  if (req.method === 'GET') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return { alert_webhook: (await getSetting(sql, 'alert_webhook')) || '', cron_url: `https://${host}/api/ativos-cron?key=${cronKey()}` };
  }
  if (req.method === 'POST' && a === 'test') {
    const r = await notify(sql, [{ level: 'info', bm: 'Teste', title: 'Teste do webhook de alertas', detail: 'Se você recebeu isto, está funcionando.' }], true);
    if (!r.sent) throw new HttpError(400, r.error ? `Não consegui enviar: ${r.error}` : 'Salve uma URL primeiro.');
    return r;
  }
  if (req.method === 'POST') {
    const url = clean(body.alert_webhook, 500);
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, 'A URL precisa começar com https://');
    await setSetting(sql, 'alert_webhook', url);
    await logActivity(sql, url ? 'Webhook de alertas atualizado' : 'Webhook de alertas removido');
    return { ok: true };
  }
  throw new HttpError(405, 'Método não permitido.');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  try {
    const sql = await getAssetsDb();
    if (!sql) throw new HttpError(500, 'Banco de dados não conectado ao projeto.');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = String(req.query.r || ''); const a = String(req.query.a || '');
    let out;
    if (r === 'overview') out = await overview(sql);
    else if (r === 'bms') out = await bms(sql, req, body, a);
    else if (r === 'numbers') out = await numberRows(sql);
    else if (r === 'templates') out = await sql`select t.*, b.name as bm, w.name as waba_name from as_templates t
        join as_bms b on b.id = t.bm_ref and b.active left join as_wabas w on w.waba_id = t.waba_id
        order by case when t.status in ('PAUSED','DISABLED','REJECTED') then 0 else 1 end, b.name, t.name`;
    else if (r === 'alerts') out = await alerts(sql, req, body, a);
    else if (r === 'check' && req.method === 'POST') {
      const last = await getSetting(sql, 'last_run');
      // "auto": só consulta se a última consulta tem mais de 5 minutos (várias abas abertas não multiplicam chamadas).
      if (a === 'auto' && last && Date.now() - new Date(last).getTime() < 4.5 * 60000) out = { skipped: true, last_run: last };
      else out = await runCheck(sql, body.id ? Number(body.id) : null);
    }
    else if (r === 'settings') out = await settings(sql, req, body, a);
    else if (r === 'activity') out = await sql`select * from as_activity order by created_at desc limit 200`;
    else throw new HttpError(404, 'Recurso não encontrado.');
    res.status(200).json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('ativos:', err);
    res.status(status).json({ erro: err.message || 'Erro inesperado.' });
  }
};
