// API do módulo de disparos. Só funciona no projeto principal, com a senha do painel.
//   ?r=instances | templates | lists | media | ops | webhook-info   (a=ação opcional)
const crypto = require('crypto');
const { getDispatchDb } = require('../lib/dispatch-db');
const { requestHost } = require('../lib/db');
const { guard } = require('../lib/auth');
const { encrypt, decrypt, verifyToken } = require('../lib/secrets');
const meta = require('../lib/meta');
const { runOperation, loadContext, sendOne } = require('../lib/runner');
const { reportKey } = require('../lib/relatorio');

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
    // Limite diário e BM de cada número (vem do monitoramento de Ativos).
    try {
      const tiers = await sql`select n.phone_number_id, n.limit_tier, n.bm_ref, n.health, b.name as bm from as_numbers n join as_bms b on b.id = n.bm_ref`;
      const byPn = new Map(tiers.map((t) => [t.phone_number_id, t]));
      for (const r of rows) { const t = byPn.get(r.phone_number_id); if (t) { r.limit_tier = t.limit_tier; r.bm_ref = t.bm_ref; r.bm = t.bm; r.health = t.health; } }
    } catch (e) { /* sem Ativos: segue sem limite */ }
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
  if (a === 'register') {
    // Ativa o número na API oficial. O PIN vira a senha de verificação em duas etapas do número.
    const inst = await getInstance(sql, int(body.id));
    const pin = /^\d{6}$/.test(String(body.pin || '')) ? String(body.pin) : String(crypto.randomInt(100000, 999999));
    try { await meta.registerNumber(inst.phone_number_id, decrypt(inst.token_enc), pin); }
    catch (err) { throw new HttpError(400, 'A Meta não registrou o número: ' + (err.code ? '(#' + err.code + ') ' : '') + err.message); }
    try { await meta.subscribeApp(inst.waba_id, decrypt(inst.token_enc), null); } catch (e) {}
    return { ok: true, pin };
  }
  if (a === 'profile') {
    const inst = await getInstance(sql, int(body.id || req.query.id));
    const pr = await meta.getProfile(inst.phone_number_id, decrypt(inst.token_enc));
    return { photo: pr.profile_picture_url || null, about: pr.about || '', description: pr.description || '' };
  }
  // Dados para montar a imagem "Foto de perfil" que vai para o cliente (a foto vem como data URL para o navegador poder desenhar).
  if (a === 'card') {
    const inst = await getInstance(sql, int(body.id || req.query.id));
    const token = decrypt(inst.token_enc);
    const pr = await meta.getProfile(inst.phone_number_id, token).catch(() => ({}));
    let n = {};
    try { n = await meta.graph(`/${inst.phone_number_id}?fields=display_phone_number,verified_name`, token); } catch (e) {}
    let photo = null;
    const url = pr.profile_picture_url;
    if (url && /^https:\/\/[^/]*(whatsapp\.net|fbcdn\.net|fbsbx\.com)\//.test(url)) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 6 * 1024 * 1024) photo = `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
        }
      } catch (e) {}
    }
    return { phone: n.display_phone_number || inst.display_phone || '', name: n.verified_name || inst.verified_name || '', photo };
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
    const tot = await sql`select count(*)::int as n from wa_contacts where list_id = ${id}`;
    return { sample: first[0] || null, available: avail[0].n, total: tot[0].n, blocked: tot[0].n - avail[0].n };
  }
  if (req.method === 'GET') {
    const rows = await sql`select l.id, l.name, l.created_at, l.check_summary, count(c.id)::int as total,
        sum(case when o.phone is not null then 1 else 0 end)::int as blocked
      from wa_lists l left join wa_contacts c on c.list_id = l.id left join wa_optouts o on o.phone = c.phone
      group by l.id, l.name, l.created_at, l.check_summary order by l.created_at desc`;
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
  if (a === 'delete') {
    const id = int(body.id);
    const busy = await sql`select name from wa_operations where list_id = ${id} and status in ('running','paused') limit 1`;
    if (busy.length) bad(`Esta lista está em uso na operação “${busy[0].name}”. Finalize a operação antes de excluir.`);
    await sql`delete from wa_contacts where list_id = ${id}`;
    await sql`delete from wa_lists where id = ${id}`;
    return { ok: true };
  }
  if (req.method === 'POST') {
    const name = str(body.name, 120);
    if (!name) bad('Dê um nome para a lista.');
    const check = body.check && typeof body.check === 'object' ? JSON.stringify(body.check).slice(0, 2000) : null;
    const rows = await sql`insert into wa_lists (name, check_summary) values (${name}, ${check}) returning id`;
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

// Guarda o envio de teste para acompanhar a entrega pelo webhook (entregue / falhou e o motivo).
async function logTest(sql, instId, phone, tplName, r) {
  if (!r || !r.ok || !r.wamid) return;
  try { await sql`insert into wa_outbound (instance_id, phone, text, wamid) values (${instId}, ${phone}, ${'[Teste] ' + tplName}, ${r.wamid})`; } catch (e) {}
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

// Uma lista grande dividida entre vários números: cada número recebe um lote (A, B, C…) até o seu limite.
const TAGS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
async function createSplit(sql, req, body) {
  const base = readOpInput(body);
  if (!base.name) bad('Dê um nome para a operação.');
  // Opcional: incluir quem pediu SAIR (o número pode estar em outra lista, de outro nicho).
  const incl = body.include_optouts === true;
  const parts = [];
  const seen = new Set();
  for (const p of body.split.slice(0, 50)) {
    const instance_id = int(p && p.instance_id); const limit = int(p && p.limit);
    if (!instance_id || seen.has(instance_id)) continue;
    if (!limit || limit < 1) bad('Informe o limite de envios de cada número.');
    const own = body.per_number && p.template_id ? readOpInput({ ...body, ...p, instance_id, template_id: p.template_id }) : null;
    seen.add(instance_id); parts.push({ instance_id, limit, own });
  }
  if (parts.length < 2) bad('Escolha pelo menos dois números para dividir a lista.');
  if (parts[0].instance_id !== base.instance_id) bad('O primeiro lote precisa ser o número principal.');
  const main = await validateOp(sql, base);
  const problems = [];
  // Template próprio por número (cada BM com o seu template e as suas variáveis).
  if (body.per_number) {
    for (const p of parts) {
      if (!p.own) { problems.push(`número ${p.instance_id}: escolha o template`); continue; }
      try { await validateOp(sql, p.own); p.template_id = p.own.template_id; }
      catch (e) { const inst = (await sql`select name from wa_instances where id = ${p.instance_id}`)[0]; problems.push(`${inst ? inst.name : p.instance_id}: ${e.message}`); }
    }
    if (problems.length) bad('Confira os templates: ' + problems.join('; '));
  }
  // Mesmo template (nome e idioma) aprovado em cada número.
  for (const p of body.per_number ? [] : parts) {
    if (p.instance_id === base.instance_id) { p.template_id = base.template_id; continue; }
    const inst = (await sql`select id, name, active from wa_instances where id = ${p.instance_id}`)[0];
    if (!inst || !inst.active) { problems.push(`instância ${p.instance_id} inativa`); continue; }
    const t = (await sql`select id, status from wa_templates where instance_id = ${p.instance_id} and name = ${main.tpl.name} and language = ${main.tpl.language}`)[0];
    if (!t) problems.push(`${inst.name}: não tem o template “${main.tpl.name}”`);
    else if (t.status !== 'APPROVED') problems.push(`${inst.name}: template “${main.tpl.name}” ainda não aprovado`);
    else p.template_id = t.id;
  }
  if (problems.length) bad('Não dá para dividir: ' + problems.join('; ') + '.');
  const avail = (await sql`select count(*)::int as n from wa_contacts c left join wa_optouts o on o.phone = c.phone
    where c.list_id = ${base.list_id} and (o.phone is null or ${incl}::boolean)`)[0].n;
  if (!avail) bad('A lista não tem contatos disponíveis.');
  const capacity = parts.reduce((s, p) => s + p.limit, 0);
  let left = Math.min(avail, capacity, base.quantity && base.quantity > 0 ? base.quantity : avail);
  const created = [];
  let offset = 0; let groupId = null;
  const mix = body.distribution === 'mix';
  const seed = crypto.randomBytes(6).toString('hex');
  try {
    for (let i = 0; i < parts.length && left > 0; i++) {
      const p = parts[i]; const n = Math.min(p.limit, left); const tag = TAGS[i] || String(i + 1);
      const c = p.own || base;
      const [row] = await sql`insert into wa_operations (name, instance_id, template_id, header_value, body_vars, button_param, name_fallback, list_id, quantity, tps, group_id, tag, status)
        values (${base.name + ' · Lote ' + tag}, ${p.instance_id}, ${p.template_id}, ${c.header_value || null}, ${JSON.stringify(c.body_vars_obj)},
                ${c.button_param || null}, ${base.name_fallback}, ${base.list_id}, ${n}, ${base.tps}, ${groupId}, ${tag}, 'paused') returning id`;
      if (!groupId) { groupId = row.id; await sql`update wa_operations set group_id = ${groupId} where id = ${row.id}`; }
      created.push({ id: row.id, tag, quantity: n });
      if (mix) {
        // Misturado: mesma ordem sorteada (fixa por campanha) para todos os lotes, então ninguém se repete.
        await sql`insert into wa_recipients (operation_id, name, phone)
          select ${row.id}::int, c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
          where c.list_id = ${base.list_id}::int and (o.phone is null or ${incl}::boolean) order by md5(c.phone || ${seed}), c.id offset ${offset}::int limit ${n}::int`;
      } else {
        await sql`insert into wa_recipients (operation_id, name, phone)
          select ${row.id}::int, c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
          where c.list_id = ${base.list_id}::int and (o.phone is null or ${incl}::boolean) order by c.id offset ${offset}::int limit ${n}::int`;
      }
      offset += n; left -= n;
    }
  } catch (err) {
    for (const c of created) { await sql`delete from wa_recipients where operation_id = ${c.id}`; await sql`delete from wa_operations where id = ${c.id}`; }
    throw err;
  }
  // Só começa depois que todos os lotes estão montados.
  for (const c of created) { await sql`update wa_operations set status = 'running' where id = ${c.id}`; kick(req, c.id); }
  return { id: created[0].id, group_id: groupId, lotes: created, quantity: created.reduce((s, c) => s + c.quantity, 0), avail, capacity };
}

// Status de uma campanha a partir dos lotes: enviando se algum envia; pausada se algum pausado; senão concluída/cancelada.
function groupStatus(list) {
  if (list.includes('running')) return 'running';
  if (list.includes('paused')) return 'paused';
  if (list.includes('error')) return 'error';
  if (list.every((s) => s === 'canceled')) return 'canceled';
  return 'done';
}

async function ops(sql, req, body, a) {
  if (req.method === 'GET' && a === 'meta-delivered') {
    // Contagem oficial da Meta (WhatsApp Manager › Insights): enviadas e entregues por número no período da campanha.
    // Serve mesmo quando o webhook não registrou as entregas.
    const id = int(req.query.id);
    const op = (await sql`select * from wa_operations where id = ${id}`)[0];
    if (!op) throw new HttpError(404, 'Operação não encontrada.');
    const lots = op.group_id ? await sql`select o.id, o.tag, o.created_at, o.finished_at, o.instance_id from wa_operations o where o.group_id = ${op.group_id} order by o.id` : [op];
    const start = Math.floor(new Date(req.query.from || Math.min(...lots.map((l) => new Date(l.created_at)))).getTime() / 1000) - 3600;
    const end = Math.floor((req.query.to ? new Date(req.query.to).getTime() : Date.now()) / 1000) + 3600;
    const out = [];
    for (const l of lots) {
      const inst = (await sql`select * from wa_instances where id = ${l.instance_id}`)[0];
      const row = { id: l.id, tag: l.tag || null, number: inst ? inst.display_phone : null, name: inst ? inst.name : null, sent: null, delivered: null, error: null };
      try {
        const digits = String(inst.display_phone || '').replace(/\D/g, '');
        const tok = decrypt(inst.token_enc);
        const d = await meta.graph(`/${inst.waba_id}?fields=analytics.start(${start}).end(${end}).granularity(HALF_HOUR).phone_numbers(["${digits}"])`, tok);
        const pts = (d.analytics && d.analytics.data_points) || [];
        row.sent = pts.reduce((a, p) => a + (p.sent || 0), 0); row.delivered = pts.reduce((a, p) => a + (p.delivered || 0), 0);
        // Mensagens cobradas pela Meta (entregues e cobráveis), por categoria.
        try {
          const pa = await meta.graph(`/${inst.waba_id}?fields=pricing_analytics.start(${start}).end(${end}).granularity(HALF_HOUR).phone_numbers(["${digits}"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`, tok);
          const pp = ((pa.pricing_analytics && pa.pricing_analytics.data) || []).flatMap((x) => x.data_points || []);
          row.billable = pp.reduce((a, p) => a + (p.volume || 0), 0);
          row.cost = Math.round(pp.reduce((a, p) => a + (p.cost || 0), 0) * 100) / 100;
        } catch (e2) { row.billable_error = e2.message; }
      } catch (e) { row.error = e.message; }
      out.push(row);
    }
    const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0);
    return { from: new Date(start * 1000), to: new Date(end * 1000), lots: out, sent: sum('sent'), delivered: sum('delivered') };
  }
  if (req.method === 'GET' && a === 'test-status') {
    const ids = String(req.query.wamids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
    const rows = ids.length ? await sql`select o.wamid, o.status, o.error, o.created_at, i.display_phone, i.name from wa_outbound o
      left join wa_instances i on i.id = o.instance_id where o.wamid = any(${ids}::text[])` : [];
    return { rows };
  }
  if (req.method === 'GET' && a === 'tests') {
    // Últimos testes (48h), com status de entrega.
    return { rows: await sql`select o.wamid, o.phone, o.text, o.status, o.error, o.created_at, i.display_phone, i.name from wa_outbound o
      left join wa_instances i on i.id = o.instance_id where o.text like '[Teste]%' and o.created_at > now() - interval '48 hours' order by o.created_at desc limit 100` };
  }
  if (req.method === 'GET' && a === 'failures') {
    const id = int(req.query.id);
    if (req.query.group) return { rows: await sql`select r.name, r.phone, r.error, o.tag from wa_recipients r join wa_operations o on o.id = r.operation_id
      where o.group_id = ${id} and r.status = 'failed' order by r.id limit 50000` };
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
    const lotes = op.group_id ? await sql`select o.id, o.tag, o.status, o.quantity, i.name as instance_name,
        sum(case when r.status in ('sent','delivered','read') then 1 else 0 end)::int as sent,
        sum(case when r.status = 'failed' then 1 else 0 end)::int as failed
      from wa_operations o left join wa_instances i on i.id = o.instance_id left join wa_recipients r on r.operation_id = o.id
      where o.group_id = ${op.group_id} group by o.id, o.tag, o.status, o.quantity, i.name order by o.id` : [];
    let group = null;
    if (op.group_id) {
      const gc = await sql`select r.status, count(*)::int as n from wa_recipients r join wa_operations o on o.id = r.operation_id
        where o.group_id = ${op.group_id} group by r.status`;
      const ge = await sql`select r.error, count(*)::int as n from wa_recipients r join wa_operations o on o.id = r.operation_id
        where o.group_id = ${op.group_id} and r.status = 'failed' group by r.error order by count(*) desc limit 8`;
      const gl = await sql`select o.id, o.tag, o.status, o.quantity, o.lock_until, i.name as instance_name, i.display_phone, t.name as template_name,
          count(r.id)::int as total,
          sum(case when r.status in ('sent','delivered','read') then 1 else 0 end)::int as sent,
          sum(case when r.status in ('delivered','read') then 1 else 0 end)::int as delivered,
          sum(case when r.status = 'read' then 1 else 0 end)::int as read,
          sum(case when r.status = 'failed' then 1 else 0 end)::int as failed,
          sum(case when r.status in ('pending','sending') then 1 else 0 end)::int as queued,
          sum(case when r.status = 'skipped' then 1 else 0 end)::int as skipped
        from wa_operations o left join wa_instances i on i.id = o.instance_id left join wa_templates t on t.id = o.template_id
        left join wa_recipients r on r.operation_id = o.id
        where o.group_id = ${op.group_id} group by o.id, o.tag, o.status, o.quantity, o.lock_until, i.name, i.display_phone, t.name order by o.id`;
      const now = new Date();
      const lots = gl.map((l) => ({ ...l, stalled: l.status === 'running' && (!l.lock_until || new Date(l.lock_until) < now) }));
      group = { id: op.group_id, name: String(op.name).replace(/\s·\sLote\s\S+$/, ''), status: groupStatus(lots.map((l) => l.status)),
        counts: Object.fromEntries(gc.map((c) => [c.status, c.n])), errors: ge, lots };
    }
    return { operation: op, group, lotes, group_report_url: op.group_id ? `/relatorio/${op.group_id}?t=${reportKey(op.group_id)}&grupo=1` : null, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), errors, stalled, report_url: `/relatorio/${id}?t=${reportKey(id)}` };
  }
  if (req.method === 'GET') {
    const rows = await sql`select o.id, o.name as name, o.status, o.quantity, o.created_at, o.finished_at, o.group_id, o.tag, i.name as instance_name, t.name as template_name,
        sum(case when r.status in ('sent','delivered','read') then 1 else 0 end)::int as sent,
        sum(case when r.status in ('delivered','read') then 1 else 0 end)::int as delivered,
        sum(case when r.status = 'read' then 1 else 0 end)::int as read,
        sum(case when r.status = 'failed' then 1 else 0 end)::int as failed,
        count(r.id)::int as total
      from wa_operations o left join wa_instances i on i.id = o.instance_id left join wa_templates t on t.id = o.template_id
      left join wa_recipients r on r.operation_id = o.id
      group by o.id, o.name, o.status, o.quantity, o.created_at, o.finished_at, o.group_id, o.tag, i.name, t.name
      order by o.created_at desc limit 300`;
    // Campanhas com vários números aparecem como uma operação só (os lotes ficam dentro dela).
    const out = []; const groups = new Map();
    for (const r of rows) {
      if (!r.group_id) { out.push(r); continue; }
      let g = groups.get(r.group_id);
      if (!g) {
        g = { id: r.group_id, group_id: r.group_id, is_group: true, name: String(r.name).replace(/\s·\sLote\s\S+$/, ''), created_at: r.created_at, finished_at: r.finished_at,
          quantity: 0, sent: 0, delivered: 0, read: 0, failed: 0, total: 0, lots: 0, statuses: [], templates: new Set() };
        groups.set(r.group_id, g); out.push(g);
      }
      g.lots++; g.statuses.push(r.status); if (r.template_name) g.templates.add(r.template_name);
      for (const k of ['quantity', 'sent', 'delivered', 'read', 'failed', 'total']) g[k] += Number(r[k]) || 0;
      if (new Date(r.created_at) < new Date(g.created_at)) g.created_at = r.created_at;
    }
    for (const g of groups.values()) {
      g.status = groupStatus(g.statuses); g.instance_name = `${g.lots} BMs`; g.template_name = [...g.templates].join(', '); delete g.statuses; delete g.templates;
    }
    return { operations: out.slice(0, 100) };
  }
  if (a === 'test') {
    const op = readOpInput(body);
    const { tpl, info, inst } = await validateOp(sql, op);
    const phone = meta.normalizePhone(body.phone);
    if (!phone) bad('Telefone de teste inválido.');
    const sample = body.sample && typeof body.sample === 'object' ? body.sample : {};
    // Operação dividida em lotes: envia o teste por cada número escolhido (mesmo template em todos).
    if (Array.isArray(body.split) && body.split.length > 1) {
      const results = [];
      let ids = [...new Set(body.split.map((x) => int(x && x.instance_id)).filter(Boolean))].slice(0, 20);
      // Teste só nos números marcados (opcional).
      if (Array.isArray(body.test_ids) && body.test_ids.length) { const only = body.test_ids.map(int); ids = ids.filter((x) => only.includes(x)); }
      if (!ids.length) bad('Marque pelo menos um número para o teste.');
      for (const iid of ids) {
        const i2 = (await sql`select * from wa_instances where id = ${iid}`)[0];
        const label = i2 ? (i2.display_phone || i2.name) : String(iid);
        try {
          if (!i2) throw new Error('número não encontrado');
          const part = body.split.find((x) => int(x && x.instance_id) === iid) || {};
          if (body.per_number) {
            if (!part.template_id) throw new Error('escolha o template');
            const own = readOpInput({ ...body, ...part, instance_id: iid, template_id: part.template_id });
            const v = await validateOp(sql, own);
            const r3 = await sendOne({ op: own, tpl: v.tpl, info: v.info, inst: v.inst, token: decrypt(v.inst.token_enc) }, { name: str(sample.name, 120), phone });
            await logTest(sql, iid, phone, v.tpl.name, r3);
            results.push({ number: label, ok: r3.ok, error: r3.ok ? null : r3.error, wamid: r3.wamid || null });
            continue;
          }
          let t2 = tpl;
          if (iid !== inst.id) {
            t2 = (await sql`select * from wa_templates where instance_id = ${iid} and name = ${tpl.name} and language = ${tpl.language}`)[0];
            if (!t2) throw new Error(`não tem o template “${tpl.name}”`);
            if (t2.status !== 'APPROVED') throw new Error(`template “${tpl.name}” não aprovado`);
          }
          const r2 = await sendOne({ op: { ...op, instance_id: iid, template_id: t2.id }, tpl: t2, info, inst: i2, token: decrypt(i2.token_enc) }, { name: str(sample.name, 120), phone });
          await logTest(sql, iid, phone, t2.name, r2);
          results.push({ number: label, ok: r2.ok, error: r2.ok ? null : r2.error, wamid: r2.wamid || null });
        } catch (e) { results.push({ number: label, ok: false, error: e.message }); }
      }
      return { ok: results.every((x) => x.ok), results };
    }
    const r = await sendOne({ op, tpl, info, inst, token: decrypt(inst.token_enc) }, { name: str(sample.name, 120), phone });
    if (!r.ok) bad('A Meta recusou o teste: ' + r.error);
    await logTest(sql, inst.id, phone, tpl.name, r);
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
    if (body.group) {
      // Campanha com vários números: aplica em todos os lotes que ainda não terminaram.
      const rows = await sql`update wa_operations set status = ${status},
          finished_at = case when ${status} = 'canceled' then now() else finished_at end
        where group_id = ${id} and status in ('running','paused') returning id`;
      if (!rows.length) bad('Esta campanha já terminou.');
      for (const r of rows) {
        if (status === 'canceled') await sql`update wa_recipients set status = 'skipped', updated_at = now() where operation_id = ${r.id} and status = 'pending'`;
        if (status === 'running') kick(req, r.id);
      }
      return { id, status, lotes: rows.length };
    }
    const rows = await sql`update wa_operations set status = ${status},
        finished_at = case when ${status} = 'canceled' then now() else finished_at end
      where id = ${id} and status in ('running','paused') returning id`;
    if (!rows.length) bad('Esta operação já terminou.');
    if (status === 'canceled') await sql`update wa_recipients set status = 'skipped', updated_at = now() where operation_id = ${id} and status = 'pending'`;
    if (status === 'running') kick(req, id);
    return { id, status };
  }
  if (req.method === 'POST' && Array.isArray(body.split) && body.split.length > 1) return createSplit(sql, req, body);
  if (req.method === 'POST') {
    const op = readOpInput(body);
    if (!op.name) bad('Dê um nome para a operação.');
    const incl = body.include_optouts === true;
    await validateOp(sql, op);
    const avail = (await sql`select count(*)::int as n from wa_contacts c left join wa_optouts o on o.phone = c.phone
      where c.list_id = ${op.list_id} and (o.phone is null or ${incl}::boolean)`)[0].n;
    if (!avail) bad('A lista não tem contatos disponíveis.');
    const qty = Math.min(avail, op.quantity && op.quantity > 0 ? op.quantity : avail);
    const rows = await sql`insert into wa_operations (name, instance_id, template_id, header_value, body_vars, button_param, name_fallback, list_id, quantity, tps)
      values (${op.name}, ${op.instance_id}, ${op.template_id}, ${op.header_value || null}, ${JSON.stringify(op.body_vars_obj)},
              ${op.button_param || null}, ${op.name_fallback}, ${op.list_id}, ${qty}, ${op.tps}) returning id`;
    const id = rows[0].id;
    try {
      await sql`insert into wa_recipients (operation_id, name, phone)
        select ${id}::int, c.name, c.phone from wa_contacts c left join wa_optouts o on o.phone = c.phone
        where c.list_id = ${op.list_id}::int and (o.phone is null or ${incl}::boolean) order by c.id limit ${qty}::int`;
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

// Texto real da mensagem enviada (corpo do template com as variáveis do contato).
async function templatePreviews(sql, opIds) {
  const map = new Map();
  if (!opIds.length) return map;
  let ops = [];
  try {
    ops = await sql`select o.id, o.name, o.body_vars, o.name_fallback, o.header_value, t.components
    from wa_operations o left join wa_templates t on t.id = o.template_id where o.id = any(${opIds}::int[])`;
  } catch (err) { console.error('prévia do template:', err.message); }
  for (const o of ops) {
    let vars = {}; try { vars = JSON.parse(o.body_vars || '{}'); } catch {}
    map.set(o.id, { name: o.name, info: meta.describeTemplate(o.components), header: o.header_value, op: { body_vars_obj: vars, name_fallback: o.name_fallback } });
  }
  return map;
}
function campaignText(p, contact) {
  if (!p) return 'Mensagem do disparo';
  const t = meta.previewText(p.info, p.op, contact).trim();
  const head = { IMAGE: '🖼️ ', VIDEO: '🎬 ', DOCUMENT: '📄 ' }[p.info.headerType] || '';
  return head + (t || 'Mensagem do disparo');
}

async function inbox(sql, req, body, a) {
  // Mídia recebida do cliente (foto, áudio, vídeo, documento): busca na Meta com o token do número.
  if (req.method === 'GET' && a === 'media') {
    const row = (await sql`select i.media_id, i.media_mime, i.instance_id from wa_inbound i where i.id = ${int(req.query.id)}`)[0];
    if (!row || !row.media_id) throw new HttpError(404, 'Mídia não encontrada.');
    const inst = await getInstance(sql, row.instance_id);
    const token = decrypt(inst.token_enc);
    let info;
    try { info = await meta.graph(`/${row.media_id}`, token); } catch (err) { throw new HttpError(410, 'A Meta não tem mais esta mídia (ela some depois de alguns dias).'); }
    if (Number(info.file_size || 0) > 4 * 1024 * 1024) throw new HttpError(413, 'Arquivo grande demais para mostrar aqui.');
    const r = await fetch(info.url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new HttpError(502, 'Não consegui baixar a mídia da Meta.');
    return { raw: Buffer.from(await r.arrayBuffer()), type: info.mime_type || row.media_mime || 'application/octet-stream' };
  }
  if (req.method === 'GET' && a === 'thread') {
    const instanceId = int(req.query.instance);
    const phone = meta.normalizePhone(req.query.phone) || str(req.query.phone, 20);
    const inbound = await sql`select id, name, text, msg_type, media_id, media_mime, created_at from wa_inbound
      where instance_id = ${instanceId} and phone = ${phone} order by created_at desc limit 300`;
    const outbound = await sql`select id, text, status, error, created_at from wa_outbound
      where instance_id = ${instanceId} and phone = ${phone} order by created_at desc limit 300`;
    const campaigns = await sql`select r.id, r.status, r.error, r.sent_at as created_at, r.operation_id, o.name as operation_name,
        r.name as contact_name
      from wa_recipients r join wa_operations o on o.id = r.operation_id
      where o.instance_id = ${instanceId} and r.phone = ${phone} and r.sent_at is not null order by r.sent_at desc limit 50`;
    const previews = await templatePreviews(sql, [...new Set(campaigns.map((c) => c.operation_id))]);
    await sql`update wa_inbound set is_read = true where instance_id = ${instanceId} and phone = ${phone} and not is_read`;
    const items = [
      ...inbound.map((m) => ({ dir: 'in', id: 'i' + m.id, text: m.text, type: m.msg_type, at: m.created_at,
        media: m.media_id ? { kind: m.msg_type === 'voice' ? 'audio' : m.msg_type, inbound: m.id, mime: m.media_mime } : null })),
      ...outbound.map((m) => ({ dir: 'out', id: 'o' + m.id, text: m.text, status: m.status, error: m.error, at: m.created_at })),
      ...campaigns.map((c) => {
        const p = previews.get(c.operation_id);
        const kind = p && { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' }[p.info.headerType];
        return { dir: 'out', kind: 'template', id: 'c' + c.id, op: c.operation_name,
          text: p ? meta.previewText(p.info, p.op, { name: c.contact_name, phone }).trim() : campaignText(p, { name: c.contact_name, phone }),
          media: kind && /^https:\/\/\S+$/.test(String(p.header || '')) ? { kind, url: p.header } : null,
          buttons: p && p.info.buttons ? p.info.buttons.map((b) => b.text) : [],
          status: c.status, error: c.error, at: c.created_at };
      })
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
      if (!c) { c = { instance_id: m.instance_id, phone: m.phone, name: m.name, last_text: m.text, last_at: m.created_at, last_dir: 'in', replied: true, unread: 0, total: 0 }; convs.set(k, c); }
      if (!c.name && m.name) c.name = m.name;
      c.total++; if (!m.is_read) c.unread++;
    }
    // Envios dos disparos (últimas 48h): aparecem na hora em que saem, com o status atualizado pelo webhook.
    const withSends = req.query.sends !== '0';
    let live = [];
    if (withSends) try {
      const sends = instanceId
        ? await sql`select r.operation_id, o.instance_id, r.phone, r.name, r.status, r.sent_at from wa_recipients r join wa_operations o on o.id = r.operation_id
            where r.sent_at > now() - interval '48 hours' and o.instance_id = ${instanceId} order by r.sent_at desc limit 3000`
        : await sql`select r.operation_id, o.instance_id, r.phone, r.name, r.status, r.sent_at from wa_recipients r join wa_operations o on o.id = r.operation_id
            where r.sent_at > now() - interval '48 hours' order by r.sent_at desc limit 3000`;
      const previews = await templatePreviews(sql, [...new Set(sends.map((r) => r.operation_id))]);
      for (const r of sends) {
        const k = r.instance_id + ':' + r.phone;
        let c = convs.get(k);
        if (!c) {
          c = { instance_id: r.instance_id, phone: r.phone, name: r.name, last_text: campaignText(previews.get(r.operation_id), r), last_at: r.sent_at, last_dir: 'out', status: r.status, replied: false, unread: 0, total: 0 };
          convs.set(k, c);
        } else {
          if (!c.name && r.name) c.name = r.name;
          if (c.status === undefined) c.status = r.status;
          if (new Date(r.sent_at) > new Date(c.last_at)) { c.last_at = r.sent_at; c.last_text = campaignText(previews.get(r.operation_id), r); c.last_dir = 'out'; }
        }
        c.total++;
      }
      // Placar das operações em andamento ou terminadas nas últimas 2 horas.
      live = await sql`select o.id, o.name, o.status, o.instance_id,
          count(r.id)::int as total,
          sum(case when r.status in ('sent','delivered','read') then 1 else 0 end)::int as enviadas,
          sum(case when r.status in ('delivered','read') then 1 else 0 end)::int as entregues,
          sum(case when r.status = 'read' then 1 else 0 end)::int as lidas,
          sum(case when r.status = 'failed' then 1 else 0 end)::int as falhas
        from wa_operations o join wa_recipients r on r.operation_id = o.id
        where o.status in ('running','paused') or o.finished_at > now() - interval '2 hours'
        group by o.id, o.name, o.status, o.instance_id order by o.id desc limit 5`;
      for (const o of live) {
        const [x] = await sql`select count(distinct i.phone)::int as n from wa_inbound i join wa_recipients r on r.phone = i.phone and r.operation_id = ${o.id}
          where i.instance_id = ${o.instance_id} and i.created_at >= r.sent_at`;
        o.respostas = x ? x.n : 0;
      }
    } catch (err) { console.error('inbox ao vivo:', err.message); }
    let list = [...convs.values()].sort((x, y) => new Date(y.last_at) - new Date(x.last_at));
    const all = list;
    if (q) {
      // Busca por nome, número ou qualquer mensagem recebida.
      const hit = new Set(rows.filter((m) => String(m.text || '').toLowerCase().includes(q)).map((m) => m.instance_id + ':' + m.phone));
      const digits = q.replace(/\D/g, '');
      list = list.filter((c) => (digits && c.phone.includes(digits)) || String(c.name || '').toLowerCase().includes(q)
        || String(c.last_text || '').toLowerCase().includes(q) || hit.has(c.instance_id + ':' + c.phone));
    }
    const counts = { todas: all.length, nao_lidas: all.filter((c) => c.unread > 0).length, respondidas: all.filter((c) => c.replied).length };
    if (req.query.unread === '1') list = list.filter((c) => c.unread > 0);
    if (req.query.replied === '1') list = list.filter((c) => c.replied);
    const unreadTotal = [...convs.values()].reduce((s, c) => s + c.unread, 0);
    // Não lidas por número (para os ícones da coluna de números), sempre de todos os números.
    const perInstance = {};
    try {
      for (const r of await sql`select instance_id, count(distinct phone)::int as n from wa_inbound where not is_read group by instance_id`) perInstance[r.instance_id] = r.n;
    } catch (e) {}
    const keys = typeof req.query.keys === 'string' ? req.query.keys.split(',').slice(0, 200) : [];
    const pinned = keys.length ? list.filter((c) => keys.includes(c.instance_id + ':' + c.phone)) : [];
    let out = list.slice(0, 400);
    for (const p of pinned) if (!out.includes(p)) out.push(p);
    return { conversations: out, unread: unreadTotal, live, counts, per_instance: perInstance };
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
    if (out && out.raw) { res.setHeader('Content-Type', out.type); res.setHeader('Cache-Control', 'private, max-age=3600'); res.status(200).end(out.raw); return; }
    res.status(200).json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : (err.status && err.status < 500 ? 400 : 500);
    if (status >= 500) console.error('disparos:', err);
    res.status(status).json({ erro: err.message || 'Erro inesperado.' });
  }
};
