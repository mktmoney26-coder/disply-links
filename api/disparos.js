// API do módulo de disparos. Só funciona no projeto principal, com a senha do painel.
//   ?r=instances | templates | lists | media | ops | webhook-info   (a=ação opcional)
const crypto = require('crypto');
const { getDispatchDb } = require('../lib/dispatch-db');
const { requestHost } = require('../lib/db');
const { guard } = require('../lib/auth');
const { encrypt, decrypt, verifyToken } = require('../lib/secrets');
const meta = require('../lib/meta');
const { runOperation, loadContext, sendOne } = require('../lib/runner');

let waitUntil = (p) => p.catch(() => {});
try { ({ waitUntil } = require('@vercel/functions')); } catch {}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function webhookUrl(req) { return `https://${requestHost(req)}/api/wa-webhook`; }

// Dispara a próxima rodada do motor sem esperar ela terminar.
function kick(req, opId) {
  const url = `https://${requestHost(req)}/api/disparos?r=ops&a=run`;
  waitUntil(fetch(url, {
    method: 'POST',
    headers: { Authorization: req.headers.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: opId }),
    signal: AbortSignal.timeout(4000)
  }).catch(() => {}));
}

// ---------------- Instâncias ----------------
async function instances(sql, req, body, a) {
  if (req.method === 'GET') {
    const rows = await sql`select i.id, i.name, i.waba_id, i.phone_number_id, i.display_phone, i.verified_name, i.quality,
        i.active, i.created_at, (i.app_secret_enc is not null) as has_secret,
        sum(case when t.status = 'APPROVED' then 1 else 0 end)::int as approved
      from wa_instances i left join wa_templates t on t.instance_id = i.id
      group by i.id, i.name, i.waba_id, i.phone_number_id, i.display_phone, i.verified_name, i.quality, i.active, i.created_at, i.app_secret_enc
      order by i.created_at desc`;
    // Números monitorados em Ativos que ainda não viraram instância (conectam com um clique).
    let available = [];
    try {
      available = await sql`select n.phone_number_id, n.display_phone, n.verified_name, n.waba_id, n.status, n.health, b.name as bm
        from as_numbers n join as_bms b on b.id = n.bm_ref and b.active
        left join wa_instances i on i.phone_number_id = n.phone_number_id
        where i.id is null order by b.name, n.display_phone`;
    } catch (e) { available = []; }
    return { instances: rows, available };
  }
  if (a === 'from-asset') {
    // Cria a instância usando o token da BM já cadastrada em Ativos (o token continua criptografado).
    const pnid = str(body.phone_number_id, 40);
    const rows0 = await sql`select n.*, b.name as bm, b.token_enc from as_numbers n join as_bms b on b.id = n.bm_ref where n.phone_number_id = ${pnid}`;
    if (!rows0.length) throw new HttpError(404, 'Número não encontrado em Ativos.');
    const n = rows0[0];
    const name = `${n.bm} · ${n.display_phone || pnid}`.slice(0, 80);
    const rows = await sql`insert into wa_instances (name, waba_id, phone_number_id, display_phone, verified_name, quality, token_enc)
      values (${name}, ${n.waba_id}, ${pnid}, ${n.display_phone || null}, ${n.verified_name || null}, ${n.quality || null}, ${n.token_enc})
      on conflict (phone_number_id) do update set waba_id = excluded.waba_id, token_enc = excluded.token_enc, active = true, updated_at = now()
      returning id`;
    // Liga o app do token à conta do WhatsApp (necessário para enviar). Não altera o webhook de outras plataformas.
    try { await meta.subscribeApp(n.waba_id, decrypt(n.token_enc), null); } catch (e) {}
    let synced = 0, syncError = null;
    try { synced = await syncTemplates(sql, rows[0].id); } catch (e) { syncError = e.message; }
    return { id: rows[0].id, synced, syncError };
  }
  if (a === 'lookup') {
    const waba = str(body.waba_id, 40); const token = str(body.token, 1000);
    if (!/^\d{5,25}$/.test(waba)) bad('WABA ID inválido: use só números.');
    if (!token) bad('Cole o token de acesso.');
    return { numbers: await meta.listNumbers(waba, token) };
  }
  if (a === 'sync') return { synced: await syncTemplates(sql, int(body.id)) };
  if (a === 'diag') {
    // Mostra o que o token da instância enxerga (sem revelar o token) e quando foi gerado.
    const inst = await getInstance(sql, int(body.id));
    const token = decrypt(inst.token_enc);
    const out = {};
    const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = `(#${e.code || '?'}) ${e.message}`; } };
    await step('token', async () => { const d = (await meta.graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token)).data || {}; return { gerado_em: d.issued_at ? new Date(d.issued_at * 1000).toISOString() : null, app: d.application, escopos: d.granular_scopes }; });
    await step('numero', () => meta.graph(`/${inst.phone_number_id}?fields=id,display_phone_number,status,platform_type,account_mode`, token));
    await step('apps_ligados', () => meta.graph(`/${inst.waba_id}/subscribed_apps`, token));
    return out;
  }
  if (a === 'profile') {
    const inst = await getInstance(sql, int(body.id || req.query.id));
    const pr = await meta.getProfile(inst.phone_number_id, decrypt(inst.token_enc));
    return { photo: pr.profile_picture_url || null, about: pr.about || '', description: pr.description || '' };
  }
  if (a === 'photo') {
    const inst = await getInstance(sql, int(body.id));
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) bad('Envie uma imagem JPG ou PNG.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) bad('Imagem muito grande (máximo 5 MB).');
    try { await meta.setProfilePhoto(inst.phone_number_id, decrypt(inst.token_enc), buf, m[1]); }
    catch (err) { throw new HttpError(400, 'A Meta não aceitou a foto: ' + err.message); }
    const pr = await meta.getProfile(inst.phone_number_id, decrypt(inst.token_enc)).catch(() => ({}));
    return { ok: true, photo: pr.profile_picture_url || null };
  }
  if (a === 'subscribe') {
    const inst = await getInstance(sql, int(body.id));
    const r = await meta.subscribeApp(inst.waba_id, decrypt(inst.token_enc), body.override ? webhookUrl(req) : null, verifyToken());
    return { ok: Boolean(r.success !== false) };
  }
  if (req.method === 'PATCH') {
    const id = int(body.id);
    const name = body.name !== undefined ? str(body.name, 80) || null : null;
    const active = typeof body.active === 'boolean' ? body.active : null;
    const token = str(body.token, 1000);
    const rows = await sql`update wa_instances set name = coalesce(${name}::text, name), active = coalesce(${active}::boolean, active),
      token_enc = coalesce(${token ? encrypt(token) : null}::text, token_enc), updated_at = now() where id = ${id} returning id`;
    if (!rows.length) throw new HttpError(404, 'Instância não encontrada.');
    return { id };
  }
  if (req.method === 'POST') {
    const name = str(body.name, 80); const waba = str(body.waba_id, 40); const token = str(body.token, 1000);
    const pnid = str(body.phone_number_id, 40); const secret = str(body.app_secret, 200);
    if (!name) bad('Dê um nome para a instância.');
    if (!/^\d{5,25}$/.test(waba)) bad('WABA ID inválido.');
    if (!/^\d{5,25}$/.test(pnid)) bad('Escolha o número de telefone.');
    if (!token) bad('Cole o token de acesso.');
    const n = await meta.getNumber(pnid, token); // confirma que o token acessa o número
    const rows = await sql`insert into wa_instances (name, waba_id, phone_number_id, display_phone, verified_name, quality, token_enc, app_secret_enc)
      values (${name}, ${waba}, ${pnid}, ${n.display_phone_number || null}, ${n.verified_name || null}, ${n.quality_rating || null},
              ${encrypt(token)}, ${secret ? encrypt(secret) : null})
      on conflict (phone_number_id) do update set name = excluded.name, waba_id = excluded.waba_id, token_enc = excluded.token_enc,
        app_secret_enc = coalesce(excluded.app_secret_enc, wa_instances.app_secret_enc), display_phone = excluded.display_phone,
        verified_name = excluded.verified_name, quality = excluded.quality, active = true, updated_at = now()
      returning id`;
    let synced = 0, syncError = null;
    try { synced = await syncTemplates(sql, rows[0].id); } catch (e) { syncError = e.message; }
    return { id: rows[0].id, synced, syncError };
  }
  throw new HttpError(405, 'Método não permitido.');
}

async function getInstance(sql, id) {
  const rows = await sql`select * from wa_instances where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'Instância não encontrada.');
  return rows[0];
}

async function syncTemplates(sql, id) {
  const inst = await getInstance(sql, id);
  const token = decrypt(inst.token_enc);
  const list = await meta.listTemplates(inst.waba_id, token);
  for (const t of list) {
    await sql`insert into wa_templates (instance_id, name, language, category, status, components)
      values (${id}, ${t.name}, ${t.language}, ${t.category || null}, ${t.status || null}, ${JSON.stringify(t.components || [])})
      on conflict (instance_id, name, language) do update set category = excluded.category, status = excluded.status,
        components = excluded.components, synced_at = now()`;
  }
  try {
    const n = await meta.getNumber(inst.phone_number_id, token);
    await sql`update wa_instances set quality = ${n.quality_rating || null}, display_phone = ${n.display_phone_number || inst.display_phone}, updated_at = now() where id = ${id}`;
  } catch {}
  return list.length;
}

// ---------------- Templates ----------------
async function templates(sql, req) {
  const inst = int(req.query.instance);
  const rows = inst
    ? await sql`select * from wa_templates where instance_id = ${inst} order by status = 'APPROVED' desc, name`
    : await sql`select * from wa_templates order by instance_id, name`;
  return { templates: rows.map((t) => ({ id: t.id, instance_id: t.instance_id, name: t.name, language: t.language,
    category: t.category, status: t.status, synced_at: t.synced_at, info: meta.describeTemplate(t.components) })) };
}

// ---------------- Listas ----------------
async function lists(sql, req, body, a) {
  if (req.method === 'GET' && a === 'sample') {
    const id = int(req.query.id);
    const first = await sql`select c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
      where c.list_id = ${id} and o.phone is null order by c.id limit 1`;
    const avail = await sql`select count(*)::int as n from wa_contacts c left join wa_optouts o on o.phone = c.phone
      where c.list_id = ${id} and o.phone is null`;
    return { sample: first[0] || null, available: avail[0].n };
  }
  if (req.method === 'GET') {
    const rows = await sql`select l.id, l.name, l.created_at, count(c.id)::int as total,
        sum(case when o.phone is not null then 1 else 0 end)::int as blocked
      from wa_lists l left join wa_contacts c on c.list_id = l.id left join wa_optouts o on o.phone = c.phone
      group by l.id, l.name, l.created_at order by l.created_at desc`;
    const opt = await sql`select count(*)::int as n from wa_optouts`;
    return { lists: rows, optouts: opt[0].n };
  }
  if (a === 'add') {
    const id = int(body.id);
    const contacts = Array.isArray(body.contacts) ? body.contacts.slice(0, 2000) : [];
    const clean = [];
    for (const c of contacts) {
      const phone = meta.normalizePhone(c && c.phone);
      if (phone) clean.push([str(c.name, 120) || null, phone]);
    }
    for (let i = 0; i < clean.length; i += 400) {
      const chunk = clean.slice(i, i + 400);
      const params = [];
      const values = chunk.map(([n, p], j) => { params.push(id, n, p); return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`; });
      await sql.query(`insert into wa_contacts (list_id, name, phone) values ${values.join(',')} on conflict (list_id, phone) do nothing`, params);
    }
    const total = await sql`select count(*)::int as n from wa_contacts where list_id = ${id}`;
    await sql`update wa_lists set total = ${total[0].n} where id = ${id}`;
    return { received: contacts.length, valid: clean.length, total: total[0].n };
  }
  if (req.method === 'POST') {
    const name = str(body.name, 120);
    if (!name) bad('Dê um nome para a lista.');
    const rows = await sql`insert into wa_lists (name) values (${name}) returning id`;
    return { id: rows[0].id };
  }
  throw new HttpError(405, 'Método não permitido.');
}

// ---------------- Mídia (imagem enviada pelo painel, servida por URL pública) ----------------
async function media(sql, req, body) {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
  if (!m) bad('Envie uma imagem JPG ou PNG. Para vídeo, use um link público.');
  if (Buffer.byteLength(m[2], 'base64') > 3.5 * 1024 * 1024) bad('Imagem muito grande (máximo 3,5 MB).');
  const id = crypto.randomBytes(9).toString('base64url');
  await sql`insert into wa_media (id, content_type, b64) values (${id}, ${m[1]}, ${m[2]})`;
  return { url: `https://${requestHost(req)}/m/${id}.${m[1] === 'image/png' ? 'png' : 'jpg'}` };
}

// ---------------- Operações ----------------
function readOpInput(body) {
  const body_vars = body.body_vars && typeof body.body_vars === 'object' ? body.body_vars : {};
  const clean = {};
  for (const [k, v] of Object.entries(body_vars)) if (/^[A-Za-z0-9_]{1,40}$/.test(k)) clean[k] = str(v, 1000);
  return {
    name: str(body.name, 120),
    instance_id: int(body.instance_id),
    template_id: int(body.template_id),
    header_value: str(body.header_value, 2000),
    body_vars_obj: clean,
    button_param: str(body.button_param, 500),
    name_fallback: str(body.name_fallback, 40) || 'cliente',
    list_id: int(body.list_id),
    quantity: int(body.quantity),
    tps: Math.max(1, Math.min(80, int(body.tps) || 40))
  };
}

async function validateOp(sql, op) {
  const tpl = (await sql`select * from wa_templates where id = ${op.template_id} and instance_id = ${op.instance_id}`)[0];
  if (!tpl) bad('Escolha um template desta instância.');
  if (tpl.status !== 'APPROVED') bad('Este template ainda não está aprovado pela Meta.');
  const info = meta.describeTemplate(tpl.components);
  if (info.carousel) bad('Templates de carrossel ainda não são suportados nesta versão.');
  if (info.needsMedia && !/^https:\/\/\S+$/.test(op.header_value)) bad('Este template precisa de mídia no cabeçalho: envie a imagem ou cole o link público (https://).');
  for (const v of info.bodyVars) if (!op.body_vars_obj[v]) bad(`Preencha a variável {{${v}}}.`);
  if (info.headerType === 'TEXT' && info.headerVars.length && !op.header_value) bad('Preencha a variável do cabeçalho.');
  if (info.dynamicButton && !op.button_param) bad('Preencha o final do link do botão.');
  const inst = (await sql`select * from wa_instances where id = ${op.instance_id} and active`)[0];
  if (!inst) bad('Instância inativa ou não encontrada.');
  return { tpl, info, inst };
}

async function ops(sql, req, body, a) {
  if (req.method === 'GET' && a === 'failures') {
    const id = int(req.query.id);
    return { rows: await sql`select name, phone, error from wa_recipients where operation_id = ${id} and status = 'failed' order by id limit 50000` };
  }
  if (req.method === 'GET' && req.query.id) {
    const id = int(req.query.id);
    const op = (await sql`select o.*, i.name as instance_name, i.display_phone, t.name as template_name, l.name as list_name
      from wa_operations o left join wa_instances i on i.id = o.instance_id left join wa_templates t on t.id = o.template_id
      left join wa_lists l on l.id = o.list_id where o.id = ${id}`)[0];
    if (!op) throw new HttpError(404, 'Operação não encontrada.');
    const counts = await sql`select status, count(*)::int as n from wa_recipients where operation_id = ${id} group by status`;
    const errors = await sql`select error, count(*)::int as n from wa_recipients where operation_id = ${id} and status = 'failed'
      group by error order by count(*) desc limit 5`;
    const stalled = op.status === 'running' && (!op.lock_until || new Date(op.lock_until) < new Date());
    return { operation: op, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), errors, stalled };
  }
  if (req.method === 'GET') {
    const rows = await sql`select o.id, o.name as name, o.status, o.quantity, o.created_at, o.finished_at, i.name as instance_name, t.name as template_name,
        sum(case when r.status in ('sent','delivered','read') then 1 else 0 end)::int as sent,
        sum(case when r.status in ('delivered','read') then 1 else 0 end)::int as delivered,
        sum(case when r.status = 'read' then 1 else 0 end)::int as read,
        sum(case when r.status = 'failed' then 1 else 0 end)::int as failed,
        count(r.id)::int as total
      from wa_operations o left join wa_instances i on i.id = o.instance_id left join wa_templates t on t.id = o.template_id
      left join wa_recipients r on r.operation_id = o.id
      group by o.id, o.name, o.status, o.quantity, o.created_at, o.finished_at, i.name, t.name
      order by o.created_at desc limit 100`;
    return { operations: rows };
  }
  if (a === 'test') {
    const op = readOpInput(body);
    const { tpl, info, inst } = await validateOp(sql, op);
    const phone = meta.normalizePhone(body.phone);
    if (!phone) bad('Telefone de teste inválido.');
    const sample = body.sample && typeof body.sample === 'object' ? body.sample : {};
    const r = await sendOne({ op, tpl, info, inst, token: decrypt(inst.token_enc) }, { name: str(sample.name, 120), phone });
    if (!r.ok) bad('A Meta recusou o teste: ' + r.error);
    return { ok: true, wamid: r.wamid };
  }
  if (a === 'run') {
    const id = int(body.id);
    const r = await runOperation(sql, id);
    if (r.more) kick(req, id);
    return r;
  }
  if (a === 'status') {
    const id = int(body.id); const status = str(body.status, 20);
    if (!['running', 'paused', 'canceled'].includes(status)) bad('Status inválido.');
    const rows = await sql`update wa_operations set status = ${status},
        finished_at = case when ${status} = 'canceled' then now() else finished_at end
      where id = ${id} and status in ('running','paused') returning id`;
    if (!rows.length) bad('Esta operação já terminou.');
    if (status === 'canceled') await sql`update wa_recipients set status = 'skipped', updated_at = now() where operation_id = ${id} and status = 'pending'`;
    if (status === 'running') kick(req, id);
    return { id, status };
  }
  if (req.method === 'POST') {
    const op = readOpInput(body);
    if (!op.name) bad('Dê um nome para a operação.');
    await validateOp(sql, op);
    const avail = (await sql`select count(*)::int as n from wa_contacts c left join wa_optouts o on o.phone = c.phone
      where c.list_id = ${op.list_id} and o.phone is null`)[0].n;
    if (!avail) bad('A lista não tem contatos disponíveis.');
    const qty = Math.min(avail, op.quantity && op.quantity > 0 ? op.quantity : avail);
    const rows = await sql`insert into wa_operations (name, instance_id, template_id, header_value, body_vars, button_param, name_fallback, list_id, quantity, tps)
      values (${op.name}, ${op.instance_id}, ${op.template_id}, ${op.header_value || null}, ${JSON.stringify(op.body_vars_obj)},
              ${op.button_param || null}, ${op.name_fallback}, ${op.list_id}, ${qty}, ${op.tps}) returning id`;
    const id = rows[0].id;
    try {
      await sql`insert into wa_recipients (operation_id, name, phone)
        select ${id}::int, c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
        where c.list_id = ${op.list_id}::int and o.phone is null order by c.id limit ${qty}::int`;
    } catch (err) {
      await sql`delete from wa_operations where id = ${id}`; // não deixa operação pela metade
      throw err;
    }
    kick(req, id);
    return { id, quantity: qty };
  }
  throw new HttpError(405, 'Método não permitido.');
}

// ---------------- Inbox ----------------
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function inbox(sql, req, body, a) {
  if (req.method === 'GET' && a === 'thread') {
    const instanceId = int(req.query.instance);
    const phone = meta.normalizePhone(req.query.phone) || str(req.query.phone, 20);
    const inbound = await sql`select id, name, text, msg_type, created_at from wa_inbound
      where instance_id = ${instanceId} and phone = ${phone} order by created_at desc limit 300`;
    const outbound = await sql`select id, text, status, error, created_at from wa_outbound
      where instance_id = ${instanceId} and phone = ${phone} order by created_at desc limit 300`;
    const campaigns = await sql`select r.id, r.status, r.error, r.sent_at as created_at, o.name as operation_name, t.name as template_name,
        o.body_vars, r.name as contact_name
      from wa_recipients r join wa_operations o on o.id = r.operation_id left join wa_templates t on t.id = o.template_id
      where o.instance_id = ${instanceId} and r.phone = ${phone} and r.sent_at is not null order by r.sent_at desc limit 50`;
    await sql`update wa_inbound set is_read = true where instance_id = ${instanceId} and phone = ${phone} and not is_read`;
    const items = [
      ...inbound.map((m) => ({ dir: 'in', id: 'i' + m.id, text: m.text, type: m.msg_type, at: m.created_at })),
      ...outbound.map((m) => ({ dir: 'out', id: 'o' + m.id, text: m.text, status: m.status, error: m.error, at: m.created_at })),
      ...campaigns.map((c) => ({ dir: 'out', kind: 'template', id: 'c' + c.id, text: `Template ${c.template_name || ''} · operação “${c.operation_name}”`, status: c.status, error: c.error, at: c.created_at }))
    ].sort((x, y) => new Date(x.at) - new Date(y.at));
    const lastIn = inbound[0] ? new Date(inbound[0].created_at).getTime() : 0;
    const optout = (await sql`select 1 from wa_optouts where phone = ${phone}`).length > 0;
    return {
      phone, name: (inbound.find((m) => m.name) || {}).name || (campaigns[0] && campaigns[0].contact_name) || null,
      items, optout, window_open: lastIn > 0 && Date.now() - lastIn < WINDOW_MS,
      window_closes_at: lastIn ? new Date(lastIn + WINDOW_MS) : null
    };
  }
  if (req.method === 'GET') {
    const instanceId = int(req.query.instance);
    const q = str(req.query.q, 60).toLowerCase();
    const rows = instanceId
      ? await sql`select instance_id, phone, name, text, created_at, is_read from wa_inbound where instance_id = ${instanceId} order by created_at desc limit 5000`
      : await sql`select instance_id, phone, name, text, created_at, is_read from wa_inbound order by created_at desc limit 5000`;
    const convs = new Map();
    for (const m of rows) {
      const k = m.instance_id + ':' + m.phone;
      let c = convs.get(k);
      if (!c) { c = { instance_id: m.instance_id, phone: m.phone, name: m.name, last_text: m.text, last_at: m.created_at, unread: 0, total: 0 }; convs.set(k, c); }
      if (!c.name && m.name) c.name = m.name;
      c.total++; if (!m.is_read) c.unread++;
    }
    let list = [...convs.values()];
    if (q) list = list.filter((c) => c.phone.includes(q.replace(/\D/g, '') || '§') || String(c.name || '').toLowerCase().includes(q));
    if (req.query.unread === '1') list = list.filter((c) => c.unread > 0);
    const unreadTotal = [...convs.values()].reduce((s, c) => s + c.unread, 0);
    return { conversations: list.slice(0, 300), unread: unreadTotal };
  }
  if (a === 'reply') {
    const instanceId = int(body.instance_id);
    const phone = meta.normalizePhone(body.phone);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4096) : '';
    if (!phone) bad('Telefone inválido.');
    if (!text) bad('Escreva a mensagem.');
    const last = await sql`select created_at from wa_inbound where instance_id = ${instanceId} and phone = ${phone} order by created_at desc limit 1`;
    if (!last.length || Date.now() - new Date(last[0].created_at).getTime() >= WINDOW_MS) {
      bad('A janela de 24 horas está fechada: o cliente não manda mensagem há mais de 24h. Para falar com ele, use um template em uma operação.');
    }
    const inst = await getInstance(sql, instanceId);
    let r;
    try { r = await meta.sendText(inst.phone_number_id, decrypt(inst.token_enc), phone, text); }
    catch (err) { bad('A Meta recusou a mensagem: ' + err.message); }
    const wamid = r.messages && r.messages[0] && r.messages[0].id;
    await sql`insert into wa_outbound (instance_id, phone, text, wamid) values (${instanceId}, ${phone}, ${text}, ${wamid || null})`;
    return { ok: true };
  }
  throw new HttpError(405, 'Método não permitido.');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  try {
    const sql = await getDispatchDb();
    if (!sql) throw new HttpError(500, 'Banco de dados não conectado ao projeto.');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = String(req.query.r || ''); const a = String(req.query.a || '');
    let out;
    if (r === 'instances') out = await instances(sql, req, body, a);
    else if (r === 'templates') out = await templates(sql, req);
    else if (r === 'lists') out = await lists(sql, req, body, a);
    else if (r === 'media' && req.method === 'POST') out = await media(sql, req, body);
    else if (r === 'ops') out = await ops(sql, req, body, a);
    else if (r === 'inbox') out = await inbox(sql, req, body, a);
    else if (r === 'webhook-info') out = { callback: webhookUrl(req), verify_token: verifyToken() };
    else throw new HttpError(404, 'Recurso não encontrado.');
    res.status(200).json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : (err.status && err.status < 500 ? 400 : 500);
    if (status >= 500) console.error('disparos:', err);
    res.status(status).json({ erro: err.message || 'Erro inesperado.' });
  }
};
