// Integração com o Número Virtual (app.numero-virtual.com): compra número, coloca na conta do WhatsApp
// da BM, lê o código do SMS pela API deles, confirma na Meta e ativa o número no Disply.
// Documentação da API deles: https://app.numero-virtual.com/api/v1/docs
const crypto = require('crypto');
const { encrypt, decrypt } = require('./secrets');
const meta = require('./meta');

const NV = 'https://app.numero-virtual.com/api/v1';
const KEY_SETTING = 'nv_key';
const FINAL = ['ativo', 'cancelado', 'expirado'];

class NvError extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

let ready = null;
async function ensure(sql) {
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists nv_numbers (
        id serial primary key,
        activation_id text not null unique,
        phone text,
        ddd text,
        price_cents integer,
        nv_status text,
        sms_code text,
        bm_ref integer,
        waba_id text,
        phone_number_id text,
        display_name text,
        step text not null default 'comprado',
        error text,
        pin_enc text,
        instance_id integer,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`;
    })().catch((e) => { ready = null; throw e; });
  }
  await ready;
}

async function getKey(sql) {
  const r = await sql`select value from as_settings where key = ${KEY_SETTING}`;
  if (!r.length || !r[0].value) return null;
  try { return decrypt(r[0].value); } catch { return null; }
}

async function call(key, method, path, body) {
  const r = await fetch(NV + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'disply/1.0' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
  if (!r.ok || (j && j.success === false)) {
    const e = (j && j.error) || {};
    const msg = (typeof e === 'string' ? e : e.message) || (j && j.message) || `Erro ${r.status} no Número Virtual`;
    const retry = Number(r.headers.get('retry-after'));
    throw new NvError(String(msg) + (r.status === 429 && retry ? ` Tente de novo em ${retry} s.` : ''), r.status === 401 || r.status === 403 ? 400 : 502);
  }
  return j && j.data !== undefined ? j.data : j;
}

// Campos da ativação (aceita os nomes mais comuns da resposta).
function readActivation(d) {
  d = d || {};
  const pick = (...k) => { for (const x of k) if (d[x] != null && d[x] !== '') return d[x]; return null; };
  return {
    id: pick('id', 'activationId', 'activation_id'),
    phone: String(pick('phone', 'phoneNumber', 'phone_number', 'number') || '').replace(/\D/g, ''),
    status: pick('status'),
    code: pick('smsCode', 'sms_code', 'code'),
    price: pick('price', 'priceCents', 'amount'),
    expires: pick('expiresAt', 'expires_at', 'expiration')
  };
}

const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function balance(key) {
  const d = await call(key, 'GET', '/balance');
  const v = d && (d.balance ?? d.balanceCents ?? d.amount ?? d.saldo);
  const cents = d && d.balanceCents != null ? Number(d.balanceCents) : (v != null && String(v).includes('.') ? Math.round(Number(v) * 100) : Number(v));
  return { cents: Number.isFinite(cents) ? cents : null, raw: d };
}

// Serviço WhatsApp no Brasil, com as opções (fornecedores) e preços. Guardado por 5 min (a API limita 6 consultas/min).
let svcCache = null;
async function whatsappService(key) {
  if (svcCache && Date.now() - svcCache.at < 5 * 60000) return svcCache.data;
  const d = await call(key, 'GET', '/services?country=BR');
  const list = (d && d.services) || [];
  const s = list.find((x) => String(x.serviceCode || '').toLowerCase() === 'wa') || list.find((x) => /whats\s?app/i.test(String(x.serviceName || '')));
  if (!s) throw new NvError('O Número Virtual não tem WhatsApp do Brasil disponível agora.');
  const data = {
    serviceId: s.serviceId, name: s.serviceName, priceCents: s.price, available: s.available,
    options: (s.options || []).map((o) => ({ apiId: o.apiId, name: o.name, priceCents: o.price, available: o.available })).sort((a, b) => (a.priceCents || 0) - (b.priceCents || 0))
  };
  svcCache = { at: Date.now(), data };
  return data;
}

async function bmFor(sql, bmRef) {
  const b = (await sql`select id, name, token_enc from as_bms where id = ${bmRef} and active`)[0];
  if (!b) throw new NvError('BM não encontrada.');
  const w = (await sql`select waba_id from as_wabas where bm_ref = ${bmRef} order by (review_status = 'REJECTED'), waba_id limit 1`)[0];
  if (!w) throw new NvError('Esta BM ainda não tem conta do WhatsApp no Disply. Clique em Atualizar na Gestão de BMs.');
  return { ...b, waba_id: w.waba_id, token: decrypt(b.token_enc) };
}

function splitPhone(digits) {
  if (/^55\d{10,11}$/.test(digits)) return { cc: '55', number: digits.slice(2) };
  throw new NvError('Telefone em formato inesperado: ' + digits);
}

// Avança o processo de um número o máximo possível nesta chamada.
async function advance(sql, row, key) {
  const set = async (fields) => {
    const r = { ...row, ...fields };
    await sql`update nv_numbers set phone = ${r.phone}, nv_status = ${r.nv_status}, sms_code = ${r.sms_code}, waba_id = ${r.waba_id},
      phone_number_id = ${r.phone_number_id}, step = ${r.step}, error = ${r.error || null}, pin_enc = ${r.pin_enc}, instance_id = ${r.instance_id},
      expires_at = ${r.expires_at}, updated_at = now() where id = ${row.id}`;
    row = r;
  };
  if (FINAL.includes(row.step)) return row;
  try {
    // Situação no Número Virtual
    const act = readActivation(await call(key, 'GET', `/activations/${row.activation_id}`));
    if (act.phone && act.phone !== row.phone) row.phone = act.phone;
    row.nv_status = act.status || row.nv_status;
    if (act.expires) row.expires_at = new Date(act.expires);
    if (!act.code && ['cancelled', 'expired', 'refunded'].includes(act.status)) { await set({ step: act.status === 'expired' ? 'expirado' : 'cancelado', error: null }); return row; }
    if (!row.bm_ref) { await set({ error: null }); return row; } // comprado sem BM: espera vincular

    const bm = await bmFor(sql, row.bm_ref);
    if (row.step === 'comprado' || row.step === 'meta_add') {
      const { cc, number } = splitPhone(row.phone);
      const r = await meta.graph(`/${bm.waba_id}/phone_numbers?cc=${cc}&phone_number=${number}&verified_name=${encodeURIComponent(row.display_name)}`, bm.token, { method: 'POST', body: '{}' });
      await set({ waba_id: bm.waba_id, phone_number_id: String(r.id), step: 'pedir_codigo', error: null });
    }
    if (row.step === 'pedir_codigo') {
      await meta.graph(`/${row.phone_number_id}/request_code`, bm.token, { method: 'POST', body: JSON.stringify({ code_method: 'SMS', language: 'pt_BR' }) });
      await set({ step: 'aguardando_sms', error: null });
    }
    if (row.step === 'aguardando_sms') {
      if (!act.code) { await set({ error: null }); return row; }
      const code = String(act.code).replace(/\D/g, '');
      await meta.graph(`/${row.phone_number_id}/verify_code`, bm.token, { method: 'POST', body: JSON.stringify({ code }) });
      await set({ sms_code: code, step: 'ativando', error: null });
    }
    if (row.step === 'ativando') {
      const pin = row.pin_enc ? decrypt(row.pin_enc) : String(crypto.randomInt(100000, 999999));
      if (!row.pin_enc) await set({ pin_enc: encrypt(pin) });
      await meta.registerNumber(row.phone_number_id, bm.token, pin);
      try { await meta.subscribeApp(row.waba_id, bm.token, null); } catch {}
      const display = '+55 ' + row.phone.slice(2, 4) + ' ' + row.phone.slice(4, -4) + '-' + row.phone.slice(-4);
      const ins = await sql`insert into wa_instances (name, waba_id, phone_number_id, display_phone, verified_name, token_enc)
        values (${(bm.name + ' · ' + display).slice(0, 80)}, ${row.waba_id}, ${row.phone_number_id}, ${display}, ${row.display_name}, ${bm.token_enc})
        on conflict (phone_number_id) do update set waba_id = excluded.waba_id, token_enc = excluded.token_enc, active = true, updated_at = now()
        returning id`;
      const instId = ins[0].id;
      try {
        for (const t of await meta.listTemplates(row.waba_id, bm.token)) {
          await sql`insert into wa_templates (instance_id, name, language, category, status, components)
            values (${instId}, ${t.name}, ${t.language}, ${t.category || null}, ${t.status || null}, ${JSON.stringify(t.components || [])})
            on conflict (instance_id, name, language) do update set category = excluded.category, status = excluded.status, components = excluded.components, synced_at = now()`;
        }
      } catch {}
      try { await call(key, 'POST', `/activations/${row.activation_id}/complete`); } catch {}
      await set({ step: 'ativo', instance_id: instId, error: null });
      try { await require('./assets-monitor').runCheck(sql, row.bm_ref); } catch {}
    }
  } catch (err) {
    const msg = (err.code ? `(#${err.code}) ` : '') + String(err.message || err).slice(0, 400);
    await set({ error: msg });
  }
  return row;
}

function view(r) {
  const left = r.expires_at ? Math.max(0, Math.round((new Date(r.expires_at).getTime() - Date.now()) / 1000)) : null;
  return {
    id: r.id, activation_id: r.activation_id, phone: r.phone, ddd: r.ddd, price_cents: r.price_cents, nv_status: r.nv_status,
    bm_ref: r.bm_ref, bm: r.bm || null, display_name: r.display_name, step: r.step, error: r.error, has_code: Boolean(r.sms_code),
    pin: r.pin_enc && r.step === 'ativo' ? decrypt(r.pin_enc) : null, instance_id: r.instance_id, seconds_left: left,
    created_at: r.created_at, updated_at: r.updated_at
  };
}

// Rotas: GET (situação, saldo, preços, números) · POST a=key|buy|step|cancel|resend|attach · DELETE a=key
async function handle(sql, req, body, a, { logActivity }) {
  await ensure(sql);
  const key = await getKey(sql);
  if (req.method === 'POST' && a === 'key') {
    const k = String(body.key || '').trim();
    if (!/^nv_(live|test)_[A-Za-z0-9_-]{8,}$/.test(k)) throw new NvError('Chave inválida. Ela começa com nv_live_.');
    await balance(k); // confere a chave antes de salvar
    await sql`insert into as_settings (key, value) values (${KEY_SETTING}, ${encrypt(k)}) on conflict (key) do update set value = excluded.value`;
    await logActivity(sql, 'Chave do Número Virtual salva');
    return { ok: true };
  }
  if (req.method === 'DELETE' && a === 'key') {
    await sql`delete from as_settings where key = ${KEY_SETTING}`;
    await logActivity(sql, 'Chave do Número Virtual removida');
    return { ok: true };
  }
  const listRows = async () => (await sql`select n.*, b.name as bm from nv_numbers n left join as_bms b on b.id = n.bm_ref order by n.created_at desc limit 200`).map(view);
  if (req.method === 'GET') {
    if (!key) return { configured: false, numbers: await listRows() };
    const out = { configured: true };
    try { out.balance = await balance(key); } catch (e) { out.balance_error = e.message; }
    if (String(req.query.precos || '') === '1') { try { out.service = await whatsappService(key); } catch (e) { out.service_error = e.message; } }
    out.numbers = await listRows();
    return out;
  }
  if (!key) throw new NvError('Salve a chave de API do Número Virtual primeiro.');
  const getRow = async () => {
    const r = (await sql`select * from nv_numbers where id = ${Number(body.id) || 0}`)[0];
    if (!r) throw new NvError('Número não encontrado.', 404);
    return r;
  };
  if (a === 'buy') {
    const ddd = body.ddd ? String(body.ddd).replace(/\D/g, '') : '';
    if (ddd && !/^[1-9]{2}$/.test(ddd)) throw new NvError('DDD inválido.');
    const bmRef = body.bm_ref ? Number(body.bm_ref) : null;
    const name = String(body.display_name || '').trim().slice(0, 100);
    if (bmRef) { if (name.length < 3) throw new NvError('Escreva o nome de exibição do número (como vai aparecer no WhatsApp).'); await bmFor(sql, bmRef); }
    const svc = await whatsappService(key);
    const p = { serviceId: svc.serviceId, country: 'BR' };
    if (body.apiId) p.apiId = Number(body.apiId);
    if (ddd) p.ddd = ddd;
    const act = readActivation(await call(key, 'POST', '/activations', p));
    if (!act.id) throw new NvError('O Número Virtual não devolveu a ativação.');
    const row = (await sql`insert into nv_numbers (activation_id, phone, ddd, price_cents, nv_status, bm_ref, display_name, step, expires_at)
      values (${String(act.id)}, ${act.phone || null}, ${ddd || (act.phone ? act.phone.slice(2, 4) : null)}, ${act.price != null ? Number(act.price) : null}, ${act.status || null},
              ${bmRef}, ${name || null}, ${'comprado'}, ${act.expires ? new Date(act.expires) : new Date(Date.now() + 20 * 60000)})
      returning *`)[0];
    await logActivity(sql, `Número ${act.phone || ''} comprado no Número Virtual${ddd ? ' (DDD ' + ddd + ')' : ''}`);
    const r = await advance(sql, row, key);
    return { number: view(r) };
  }
  if (a === 'step') {
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean).slice(0, 10) : [];
    const rows = ids.length ? await sql`select * from nv_numbers where id = any(${ids}::int[])` : [await getRow()];
    const out = [];
    for (const r of rows) out.push(view(await advance(sql, r, key)));
    return { numbers: out };
  }
  if (a === 'attach') {
    const row = await getRow();
    if (row.bm_ref) throw new NvError('Este número já está ligado a uma BM.');
    const name = String(body.display_name || '').trim().slice(0, 100);
    if (name.length < 3) throw new NvError('Escreva o nome de exibição.');
    await bmFor(sql, Number(body.bm_ref));
    await sql`update nv_numbers set bm_ref = ${Number(body.bm_ref)}, display_name = ${name}, step = 'comprado', error = null where id = ${row.id}`;
    return { number: view(await advance(sql, { ...row, bm_ref: Number(body.bm_ref), display_name: name, step: 'comprado', error: null }, key)) };
  }
  if (a === 'resend') {
    const row = await getRow();
    try { await call(key, 'POST', `/activations/${row.activation_id}/retry`); } catch {}
    if (row.step === 'aguardando_sms') await sql`update nv_numbers set step = 'pedir_codigo', error = null where id = ${row.id}`;
    return { number: view(await advance(sql, { ...row, step: row.step === 'aguardando_sms' ? 'pedir_codigo' : row.step }, key)) };
  }
  if (a === 'cancel') {
    const row = await getRow();
    if (row.sms_code) throw new NvError('O código já chegou: o Número Virtual não devolve o valor depois disso.');
    await call(key, 'DELETE', `/activations/${row.activation_id}`);
    await sql`update nv_numbers set step = 'cancelado', error = null, updated_at = now() where id = ${row.id}`;
    await logActivity(sql, `Número ${row.phone || ''} cancelado no Número Virtual (valor devolvido ao saldo)`);
    return { ok: true };
  }
  throw new NvError('Ação desconhecida.', 404);
}

module.exports = { handle, money };
