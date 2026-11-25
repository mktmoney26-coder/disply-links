// Importação de BMs em lote (MVP).
// Ideia: cada perfil do Facebook (Rian, Julia, 94…) tem 1 app próprio, onde ele é admin.
// Com o token desse perfil, o Disply enxerga todas as BMs que o perfil administra e integra
// cada uma só por API: cadastro, contas, números, webhook e PIN. Nada de criar app por BM.
// Rotas (todas em /api/ativos?r=lote&a=...):
//   GET  state                → perfis, cartões, fila de pagamento
//   POST profile-save         → cadastra/atualiza perfil (app, token, limite por dia)
//   POST app-webhook          → configura o webhook do app do perfil (uma vez por app)
//   GET  discover&profile=ID  → BMs que o perfil administra e se já estão no Disply
//   POST import-one           → integra 1 BM (a tela chama uma por vez, em sequência)
//   POST card-save | card-off | card-assign | pay-mark
const { encrypt, decrypt } = require('./secrets');
const { graph } = require('./meta');
const { runCheck, logActivity } = require('./assets-monitor');

const GRAPH = 'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v24.0');
const NEEDED = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'];
const WEBHOOK_FIELDS = ['messages', 'message_template_status_update', 'message_template_quality_update', 'phone_number_quality_update', 'account_update'];
const PUBLIC_VERIFY = 'disply-webhook';

class LoteError extends Error { constructor(status, msg) { super(msg); this.status = status; this.name = 'LoteError'; this.expose = true; } }
const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const digits = (v, max = 30) => clean(v, max).replace(/\D/g, '');

let ready = false;
async function ensure(sql) {
  if (ready) return;
  await sql`create table if not exists as_profiles (
    id serial primary key,
    name text not null unique,
    app_id text,
    app_secret_enc text,
    token_enc text,
    fb_user text,
    token_expires timestamptz,
    scopes text,
    daily_limit integer not null default 30,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`create table if not exists as_cards (
    id serial primary key,
    label text not null,
    last4 text,
    max_bms integer not null default 30,
    active boolean not null default true,
    created_at timestamptz not null default now()
  )`;
  await sql`alter table as_bms add column if not exists profile_ref integer`;
  await sql`alter table as_bms add column if not exists card_ref integer`;
  await sql`alter table as_bms add column if not exists paid_at timestamptz`;
  await sql`alter table as_bms add column if not exists import_log text`;
  ready = true;
}

// Início do dia em São Paulo (o limite diário zera à meia-noite daqui).
const TODAY = "date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'";

async function profileRow(sql, id) {
  const [p] = await sql`select * from as_profiles where id = ${Number(id)}`;
  if (!p) throw new LoteError(404, 'Perfil não encontrado.');
  if (!p.token_enc) throw new LoteError(400, `O perfil ${p.name} ainda não tem token. Cole o token do perfil primeiro.`);
  return { ...p, token: decrypt(p.token_enc) };
}

async function usedToday(sql, profileId) {
  const r = await sql.query(`select count(*)::int as n from as_bms where profile_ref = $1 and created_at >= ${TODAY}`, [profileId]);
  return r[0] ? r[0].n : 0;
}

// Token curto (Graph API Explorer) → token longo (~60 dias), quando o app secret estiver cadastrado.
async function longLived(appId, secret, token) {
  const u = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}&fb_exchange_token=${encodeURIComponent(token)}`;
  const r = await fetch(u); let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok || !d.access_token) throw new LoteError(400, 'A Meta não trocou o token por um de longa duração: ' + ((d.error && d.error.message) || r.status) + '. Confira o App ID e a chave secreta do app.');
  return d.access_token;
}

async function inspect(token, appToken) {
  const d = (await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, appToken || token)).data || {};
  if (d.is_valid === false) throw new LoteError(400, 'A Meta diz que este token não é válido (expirou ou foi revogado). Gere outro.');
  const scopes = d.scopes || [];
  const missing = NEEDED.filter((s) => !scopes.includes(s));
  if (missing.length) throw new LoteError(400, 'Faltam permissões no token: ' + missing.join(', ') + '. Gere de novo marcando as três.');
  if (d.type && d.type !== 'USER') throw new LoteError(400, 'Este token não é de perfil (é ' + d.type + '). Gere o token no Graph API Explorer, logado no perfil.');
  return { appId: d.app_id ? String(d.app_id) : null, expires: d.expires_at ? new Date(d.expires_at * 1000) : null, scopes };
}

async function state(sql) {
  const profiles = await sql.query(`select p.id, p.name, p.app_id, p.fb_user, p.token_expires, p.daily_limit, p.active, p.updated_at,
      (p.app_secret_enc is not null) as has_secret, (p.token_enc is not null) as has_token,
      (select count(*)::int from as_bms b where b.profile_ref = p.id) as bms,
      (select count(*)::int from as_bms b where b.profile_ref = p.id and b.created_at >= ${TODAY}) as hoje
    from as_profiles p order by p.name`);
  const cards = await sql`select c.*, (select count(*)::int from as_bms b where b.card_ref = c.id and b.active) as usadas
    from as_cards c order by c.active desc, c.id`;
  const queue = await sql`select b.id, b.name, b.bm_id, b.profile, b.paid_at, b.card_ref, b.created_at, b.last_error,
      c.label as card_label, c.last4 as card_last4,
      (select string_agg(w.waba_id, ',') from as_wabas w where w.bm_ref = b.id) as wabas,
      (select count(*)::int from as_numbers n where n.bm_ref = b.id and n.status = 'CONNECTED') as conectados,
      (select count(*)::int from as_numbers n where n.bm_ref = b.id and n.health = 'BLOCKED') as bloqueados
    from as_bms b left join as_cards c on c.id = b.card_ref
    where b.active and b.profile_ref is not null
    order by (b.paid_at is not null), c.id nulls last, b.created_at desc limit 500`;
  return { profiles, cards, queue };
}

async function profileSave(sql, body) {
  const id = Number(body.id) || null;
  const name = clean(body.name, 80);
  const old = id ? (await sql`select * from as_profiles where id = ${id}`)[0] : null;
  if (id && !old) throw new LoteError(404, 'Perfil não encontrado.');
  if (!name && !old) throw new LoteError(400, 'Dê um nome ao perfil (ex.: Rian).');
  const appId = digits(body.app_id) || (old && old.app_id) || null;
  const secretIn = clean(body.app_secret, 100);
  const secret = secretIn || (old && old.app_secret_enc ? decrypt(old.app_secret_enc) : null);
  const limit = Math.max(1, Math.min(500, Number(body.daily_limit) || (old && old.daily_limit) || 30));
  let tokenEnc = old ? old.token_enc : null; let expires = old ? old.token_expires : null; let fbUser = old ? old.fb_user : null; let scopes = old ? old.scopes : null;
  const tokenIn = clean(body.token, 2000);
  if (tokenIn) {
    if (tokenIn.length < 30) throw new LoteError(400, 'Token curto demais. Copie o token inteiro.');
    let token = tokenIn;
    if (appId && secret) token = await longLived(appId, secret, tokenIn);
    const info = await inspect(token, appId && secret ? `${appId}|${secret}` : null);
    if (appId && info.appId && info.appId !== appId) throw new LoteError(400, `Este token é do app ${info.appId}, mas o perfil está ligado ao app ${appId}. Gere o token escolhendo o app certo.`);
    const me = await graph('/me?fields=id,name', token);
    tokenEnc = encrypt(token); expires = info.expires; fbUser = me.name || me.id; scopes = info.scopes.join(',');
  }
  let row;
  try {
    if (old) {
      [row] = await sql`update as_profiles set name = ${name || old.name}, app_id = ${appId}, app_secret_enc = ${secretIn ? encrypt(secretIn) : old.app_secret_enc},
        token_enc = ${tokenEnc}, token_expires = ${expires}, fb_user = ${fbUser}, scopes = ${scopes}, daily_limit = ${limit}, updated_at = now()
        where id = ${id} returning id, name`;
    } else {
      [row] = await sql`insert into as_profiles (name, app_id, app_secret_enc, token_enc, token_expires, fb_user, scopes, daily_limit)
        values (${name}, ${appId}, ${secretIn ? encrypt(secretIn) : null}, ${tokenEnc}, ${expires}, ${fbUser}, ${scopes}, ${limit}) returning id, name`;
    }
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) throw new LoteError(400, 'Já existe um perfil com esse nome.');
    throw err;
  }
  // Token novo do perfil vale para todas as BMs e números que vieram dele.
  if (tokenIn && old) {
    await sql`update as_bms set token_enc = ${tokenEnc} where profile_ref = ${row.id}`;
    try { await sql`update wa_instances set token_enc = ${tokenEnc}, updated_at = now() where phone_number_id in (select n.phone_number_id from as_numbers n join as_bms b on b.id = n.bm_ref where b.profile_ref = ${row.id})`; } catch (e) {}
  }
  await logActivity(sql, `Perfil ${row.name} ${old ? 'atualizado' : 'cadastrado'}${tokenIn ? ' (token novo)' : ''}`);
  return { ok: true, id: row.id, expires, fb_user: fbUser };
}

// Webhook no nível do app: feito uma vez por app, com o token do app (App ID|chave secreta).
async function appWebhook(sql, body, host) {
  const [p] = await sql`select * from as_profiles where id = ${Number(body.id)}`;
  if (!p) throw new LoteError(404, 'Perfil não encontrado.');
  if (!p.app_id || !p.app_secret_enc) throw new LoteError(400, 'Cadastre o App ID e a chave secreta do app deste perfil.');
  const appToken = `${p.app_id}|${decrypt(p.app_secret_enc)}`;
  const callback = `https://${host}/api/wa-webhook`;
  const qs = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: callback, verify_token: PUBLIC_VERIFY, fields: WEBHOOK_FIELDS.join(','), include_values: 'true' });
  await graph(`/${p.app_id}/subscriptions?${qs}`, appToken, { method: 'POST' });
  const subs = ((await graph(`/${p.app_id}/subscriptions`, appToken)).data || []).find((s) => s.object === 'whatsapp_business_account');
  await logActivity(sql, `Webhook configurado no app do perfil ${p.name}`);
  return { ok: true, callback, fields: subs ? (subs.fields || []).map((f) => f.name || f) : [] };
}

async function discover(sql, req) {
  const p = await profileRow(sql, req.query.profile);
  const list = [];
  let path = '/me/businesses?fields=id,name,created_time,verification_status&limit=100';
  for (let page = 0; page < 30 && path; page++) {
    const d = await graph(path, p.token);
    list.push(...(d.data || []));
    const next = d.paging && d.paging.next;
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
  }
  const known = new Map((await sql`select bm_id, id, profile_ref from as_bms`).map((r) => [r.bm_id, r]));
  const hoje = await usedToday(sql, p.id);
  return {
    profile: { id: p.id, name: p.name, daily_limit: p.daily_limit, hoje, restante: Math.max(0, p.daily_limit - hoje) },
    bms: list.map((b) => ({ bm_id: b.id, name: b.name, created_time: b.created_time || null, verification: b.verification_status || null,
      imported: known.has(b.id), bm_ref: known.has(b.id) ? known.get(b.id).id : null }))
      .sort((a, b) => (a.imported - b.imported) || String(b.created_time || '').localeCompare(String(a.created_time || '')))
  };
}

async function pickCard(sql) {
  const [c] = await sql`select c.id from as_cards c where c.active and
      (select count(*) from as_bms b where b.card_ref = c.id and b.active) < c.max_bms order by c.id limit 1`;
  return c ? c.id : null;
}

async function importOne(sql, body) {
  const p = await profileRow(sql, body.profile);
  const bmId = digits(body.bm_id);
  if (!/^\d{5,25}$/.test(bmId)) throw new LoteError(400, 'ID da BM inválido.');
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail: detail ? String(detail).slice(0, 300) : null });

  const exists = (await sql`select id, name from as_bms where bm_id = ${bmId}`)[0];
  if (exists) return { ok: true, skipped: true, bm_ref: exists.id, name: exists.name, steps: [{ name: 'Já estava no Disply', ok: true }] };
  const hoje = await usedToday(sql, p.id);
  if (hoje >= p.daily_limit) throw new LoteError(429, `Limite do dia do perfil ${p.name} atingido (${p.daily_limit} BMs). Continue amanhã ou aumente o limite.`);

  // 1) O token do perfil enxerga a BM?
  let info;
  try { info = await graph(`/${bmId}?fields=id,name`, p.token); step('Acesso à BM', true); }
  catch (err) { throw new LoteError(400, `O perfil ${p.name} não consegue acessar a BM ${bmId}: ${err.message}`); }
  const name = clean(body.name, 120) || info.name || bmId;

  // 2) Cadastro (o mesmo do "+ Cadastrar BM", com o token do perfil)
  const card = await pickCard(sql);
  const [row] = await sql`insert into as_bms (profile, name, bm_id, supplier, launched_at, token_enc, profile_ref, card_ref)
    values (${p.name}, ${name}, ${bmId}, ${clean(body.supplier, 120) || null}, ${new Date().toISOString().slice(0, 10)}, ${p.token_enc}, ${p.id}, ${card})
    returning id`;
  step('Cadastro no Disply', true, card ? 'Cartão do lote definido' : 'Sem cartão com vaga: cadastre um cartão');

  // 3) Consulta completa: contas, números, templates e ativação automática dos números com SMS confirmado
  try { await runCheck(sql, row.id); } catch (e) { step('Consulta na Meta', false, e.message); }
  const [bm] = await sql`select last_error from as_bms where id = ${row.id}`;
  const wabas = await sql`select waba_id, name from as_wabas where bm_ref = ${row.id}`;
  step('Contas do WhatsApp', wabas.length > 0 && !(bm.last_error && !bm.last_error.startsWith('Parcial')), bm.last_error || `${wabas.length} conta(s)`);

  // 4) Liga o app do perfil a cada conta (sem isso não chegam entregas, leituras e respostas)
  for (const w of wabas) {
    try { await graph(`/${w.waba_id}/subscribed_apps`, p.token, { method: 'POST', body: '{}' }); step(`Webhook na conta ${w.name || w.waba_id}`, true); }
    catch (e) { step(`Webhook na conta ${w.name || w.waba_id}`, false, e.message); }
  }

  // 5) Números: os já conectados viram instância de disparo (o mesmo que "from-asset" faz um a um)
  const nums = (await sql`select phone_number_id, waba_id, display_phone, verified_name, quality, status, code_status, auto_error from as_numbers where bm_ref = ${row.id}`)
    .filter((n) => !/^\+?1\s?555/.test(String(n.display_phone || '').trim()));
  for (const n of nums.filter((x) => x.status === 'CONNECTED')) {
    try {
      await sql`insert into wa_instances (name, waba_id, phone_number_id, display_phone, verified_name, token_enc)
        values (${(name + ' · ' + (n.display_phone || n.phone_number_id)).slice(0, 80)}, ${n.waba_id}, ${n.phone_number_id}, ${n.display_phone || null}, ${n.verified_name || null}, ${p.token_enc})
        on conflict (phone_number_id) do update set waba_id = excluded.waba_id, token_enc = excluded.token_enc, active = true, updated_at = now()`;
    } catch (e) { n.auto_error = 'Instância não criada: ' + e.message; n.status = 'ERRO'; }
  }
  if (!nums.length) step('Números', false, 'Nenhum número real: compre um número (Comprar números)');
  for (const n of nums) {
    const ok = n.status === 'CONNECTED';
    const detail = ok ? 'Conectado' : n.auto_error ? 'Erro ao ativar: ' + n.auto_error
      : n.code_status === 'VERIFIED' ? 'Pendente (o Disply ativa na próxima consulta)'
      : 'Código SMS não confirmado: peça o código ao fornecedor ou compre um número';
    step(`Número ${n.display_phone}`, ok, detail);
  }
  // Assinatura do webhook: os números desta BM passam a conferir com a chave do app do perfil.
  if (p.app_secret_enc) {
    try { await sql`update wa_instances set app_secret_enc = ${p.app_secret_enc} where phone_number_id in (select phone_number_id from as_numbers where bm_ref = ${row.id})`; } catch (e) {}
  }
  const log = JSON.stringify(steps);
  await sql`update as_bms set import_log = ${log} where id = ${row.id}`;
  await logActivity(sql, `BM importada em lote pelo perfil ${p.name}: ${name}`);
  return { ok: true, bm_ref: row.id, name, steps };
}

async function handle(sql, req, body, a, ctx = {}) {
  await ensure(sql);
  if (req.method === 'GET' && (a === 'state' || !a)) return state(sql);
  if (req.method === 'GET' && a === 'discover') return discover(sql, req);
  if (req.method !== 'POST') throw new LoteError(405, 'Método não permitido.');
  if (a === 'profile-save') return profileSave(sql, body);
  if (a === 'profile-off') { await sql`update as_profiles set active = ${body.active === true} where id = ${Number(body.id)}`; return { ok: true }; }
  if (a === 'app-webhook') return appWebhook(sql, body, ctx.host);
  if (a === 'import-one') return importOne(sql, body);
  if (a === 'card-save') {
    const label = clean(body.label, 60); if (!label) throw new LoteError(400, 'Dê um apelido ao cartão (ex.: Nubank Rian).');
    const last4 = digits(body.last4, 4); if (last4 && last4.length !== 4) throw new LoteError(400, 'Informe só os 4 últimos dígitos.');
    const max = Math.max(1, Math.min(500, Number(body.max_bms) || 30));
    const id = Number(body.id) || null;
    if (id) await sql`update as_cards set label = ${label}, last4 = ${last4 || null}, max_bms = ${max} where id = ${id}`;
    else await sql`insert into as_cards (label, last4, max_bms) values (${label}, ${last4 || null}, ${max})`;
    return { ok: true };
  }
  if (a === 'card-off') { await sql`update as_cards set active = ${body.active === true} where id = ${Number(body.id)}`; return { ok: true }; }
  if (a === 'card-assign') {
    const card = body.card_ref ? Number(body.card_ref) : null;
    await sql`update as_bms set card_ref = ${card} where id = ${Number(body.bm_ref)}`; return { ok: true };
  }
  if (a === 'pay-mark') {
    await sql`update as_bms set paid_at = ${body.paid === false ? null : new Date()} where id = ${Number(body.bm_ref)}`;
    return { ok: true };
  }
  throw new LoteError(404, 'Ação não encontrada.');
}

module.exports = { handle, NEEDED, WEBHOOK_FIELDS };
