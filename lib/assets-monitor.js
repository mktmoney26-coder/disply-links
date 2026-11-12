// Monitor de ativos da Meta (reconstrução do "Ativos Meta"): BMs, contas do WhatsApp (WABAs),
// números e templates. A cada consulta compara com o estado anterior e cria alertas só quando algo muda.
const { getDispatchDb } = require('./dispatch-db');
const { decrypt } = require('./secrets');
const { graph } = require('./meta');
const T = require('./alert-text');
const healthDetail = T.healthDetail;

let ready = null;

async function getAssetsDb() {
  const sql = await getDispatchDb();
  if (!sql) return null;
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists as_bms (
        id serial primary key,
        profile text,
        name text not null,
        bm_id text not null unique,
        waba_ids text,
        supplier text,
        launched_at date,
        token_enc text not null,
        active boolean not null default true,
        last_check timestamptz,
        last_error text,
        created_at timestamptz not null default now()
      )`;
      await sql`create table if not exists as_wabas (
        waba_id text primary key,
        bm_ref integer not null,
        name text,
        review_status text,
        health text,
        health_detail text,
        updated_at timestamptz not null default now()
      )`;
      await sql`create table if not exists as_numbers (
        phone_number_id text primary key,
        waba_id text not null,
        bm_ref integer not null,
        display_phone text,
        verified_name text,
        quality text,
        status text,
        health text,
        health_detail text,
        limit_tier text,
        sent30 integer,
        last_sent timestamptz,
        updated_at timestamptz not null default now()
      )`;
      await sql`create table if not exists as_templates (
        waba_id text not null,
        name text not null,
        language text not null,
        category text,
        status text,
        bm_ref integer,
        updated_at timestamptz not null default now(),
        primary key (waba_id, name, language)
      )`;
      await sql`create table if not exists as_alerts (
        id bigserial primary key,
        bm_ref integer,
        level text not null default 'warn',
        title text not null,
        detail text,
        seen boolean not null default false,
        created_at timestamptz not null default now()
      )`;
      await sql`create index if not exists as_alerts_seen_idx on as_alerts (seen, created_at)`;
      await sql`create table if not exists as_settings (key text primary key, value text)`;
      await sql`alter table as_wabas add column if not exists restriction text`;
      await sql`alter table as_wabas add column if not exists restriction_at timestamptz`;
      await sql`alter table as_bms add column if not exists review_at timestamptz`;
      await sql`alter table as_bms add column if not exists manual_status text`;
      await sql`alter table as_bms add column if not exists limit_tier text`;
      await sql`create table if not exists as_activity (
        id bigserial primary key,
        text text not null,
        created_at timestamptz not null default now()
      )`;
      // Textos antigos em inglês → português resumido (uma vez; é idempotente)
      for (const r of await sql`select id, title, detail from as_alerts where detail like '%[WABA]%' or detail like '%[PHONE_NUMBER]%' or detail like '%Status: %' or title like 'Template %: %' or title like 'Conta WhatsApp %' or title like 'Número % (%)'`) {
        let title = T.translateLegacyTitle(r.title).replace(/^Conta WhatsApp /, 'Conta ').replace(/ com envio /, ': envio ');
        const m = /^(Número [+\d][\d\s-]+?) \(.+\)$/.exec(title);
        if (m) title = m[1] + (/Envio BLOQUEADO/.test(r.detail || '') ? ': envio bloqueado' : /Envio LIMITADO/.test(r.detail || '') ? ': envio limitado' : /Envio voltou/.test(r.detail || '') ? ': envio normalizado' : '');
        const detail = T.translateLegacy(r.detail);
        if (title !== r.title || detail !== r.detail) await sql`update as_alerts set title = ${title}, detail = ${detail} where id = ${r.id}`;
      }
      for (const r of await sql`select phone_number_id, health_detail from as_numbers where health_detail like '%[%]%'`) {
        await sql`update as_numbers set health_detail = ${T.translateLegacy(r.health_detail) || null} where phone_number_id = ${r.phone_number_id}`;
      }
    })().catch((err) => { ready = null; throw err; });
  }
  await ready;
  return sql;
}

async function getSetting(sql, key) {
  const r = await sql`select value from as_settings where key = ${key}`;
  return r.length ? r[0].value : null;
}
async function setSetting(sql, key, value) {
  await sql`insert into as_settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
}
async function logActivity(sql, text) {
  await sql`insert into as_activity (text) values (${String(text).slice(0, 300)})`;
}

// Chamada à Meta com campos "preferidos"; se algum campo não existir nesta versão, tenta os básicos.
async function graphFields(path, token, fields, fallback) {
  try {
    return await graph(`${path}${path.includes('?') ? '&' : '?'}fields=${fields}`, token);
  } catch (err) {
    if (fallback && Number(err.code) === 100) return graph(`${path}${path.includes('?') ? '&' : '?'}fields=${fallback}`, token);
    throw err;
  }
}

const HEALTH_PT = { AVAILABLE: 'Disponível', LIMITED: 'Limitado', BLOCKED: 'Bloqueado' };
const QUALITY_PT = { GREEN: 'Verde', YELLOW: 'Amarela', RED: 'Vermelha', UNKNOWN: 'Sem dados' };
const BAD_TEMPLATE = ['PAUSED', 'DISABLED', 'REJECTED'];

function tierLabel(t) {
  const m = /TIER_(\d+)(K)?/i.exec(String(t || ''));
  if (!m) return t === 'TIER_UNLIMITED' ? 'Ilimitado' : null;
  return m[2] ? `${m[1]} mil` : m[1];
}

// Contas do WhatsApp atribuídas ao usuário do sistema dono do token (não precisa de business_management).
async function assignedWabas(token) {
  try {
    const out = []; let path = '/me/assigned_whatsapp_business_accounts?fields=id&limit=100';
    for (let i = 0; i < 10 && path; i++) {
      const d = await graph(path, token);
      out.push(...(d.data || []).map((w) => String(w.id)));
      const next = d.paging && d.paging.next;
      path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
    }
    return [...new Set(out)];
  } catch { return []; }
}

// Contas do WhatsApp liberadas para o token (lidas do próprio token, via debug_token).
async function tokenWabas(token) {
  try {
    const d = await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
    const scopes = (d.data && d.data.granular_scopes) || [];
    const out = [];
    for (const g of scopes) if (/^whatsapp_business_(management|messaging)$/.test(g.scope)) out.push(...(g.target_ids || []));
    return [...new Set(out.map(String))];
  } catch { return []; }
}

// Traduz os erros mais comuns da Meta para algo acionável.
function friendlyError(err) {
  const m = String(err.message || '');
  if (Number(err.code) === 190 || /access token|session has expired|validating/i.test(m)) return 'Token inválido ou expirado. Gere um novo token e troque em Editar.';
  if (Number(err.code) === 200 || /permission/i.test(m)) return 'Não consegui achar as contas do WhatsApp sozinho (o token não tem a permissão business_management). Clique em Editar e cole o ID da conta do WhatsApp (na Meta: Configurações → Contas do WhatsApp → abra a conta → Identificação).';
  return `A Meta recusou a consulta${err.code ? ' (código ' + err.code + ')' : ''}. Clique em Diagnóstico na BM para ver os detalhes.`;
}

// Mensagens enviadas por número nos últimos 30 dias, segundo a própria Meta
// (inclui o que foi disparado por outras plataformas, como a Revenue).
async function sentStats(wabaId, phone, token) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const end = Math.floor(Date.now() / 1000); const start = end - 30 * 86400;
  try {
    const d = await graph(`/${wabaId}?fields=analytics.start(${start}).end(${end}).granularity(DAY).phone_numbers(["${digits}"])`, token);
    const pts = (d.analytics && d.analytics.data_points) || [];
    let sent = 0; let last = null;
    for (const p of pts) {
      const n = Number(p.sent || 0); sent += n;
      if (n > 0 && (!last || p.end > last)) last = p.end;
    }
    return { sent, last: last ? new Date(last * 1000).toISOString() : null };
  } catch { return null; }
}

// Consulta uma BM inteira e devolve os alertas novos.
async function checkBm(sql, bm) {
  const alerts = [];
  const push = (level, title, detail) => alerts.push({ level, title, detail: detail || null });
  const token = decrypt(bm.token_enc);

  try {
    // 1) Contas do WhatsApp
    let wabas = [];
    let ids = String(bm.waba_ids || '').split(/[\s,;]+/).filter((x) => /^\d{5,25}$/.test(x));
    if (!ids.length) {
      // Pela BM (precisa da permissão business_management)...
      let edgeErr = null;
      for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
        try {
          const d = await graph(`/${bm.bm_id}/${edge}?fields=id&limit=100`, token);
          ids.push(...(d.data || []).map((w) => w.id));
        } catch (err) { if (edge === 'owned_whatsapp_business_accounts') edgeErr = err; }
      }
      // ...ou pelas contas que o próprio token enxerga (funciona sem business_management).
      if (!ids.length) ids = await assignedWabas(token);
      if (!ids.length) ids = await tokenWabas(token);
      if (!ids.length && edgeErr) throw edgeErr;
    }
    // Uma conta sem acesso não derruba as outras: segue com as que funcionam e avisa quais falharam.
    const denied = [];
    for (const id of [...new Set(ids)]) {
      try { wabas.push(await graphFields(`/${id}`, token, 'id,name,account_review_status,health_status', 'id,name,account_review_status')); }
      catch (err) { denied.push({ id, err }); }
    }
    if (!wabas.length && denied.length) throw denied[0].err;
    const partial = denied.length ? `Parcial: sem acesso à conta ${denied.map((d) => d.id + ' (' + String(d.err.message || '').slice(0, 120) + ')').join(', ')}. Atribua essa conta ao usuário do sistema na Meta (Atribuir ativos → Contas do WhatsApp).` : null;
    const seen = new Set(); wabas = wabas.filter((w) => w && w.id && !seen.has(w.id) && seen.add(w.id));

    for (const w of wabas) {
      const prev = (await sql`select * from as_wabas where waba_id = ${w.id}`)[0];
      const health = w.health_status && w.health_status.can_send_message || null;
      const detail = healthDetail(w.health_status);
      if (prev) {
        if (w.account_review_status === 'REJECTED' && prev.review_status !== 'REJECTED') push('bad', `Conta ${w.name} reprovada pela Meta`, 'A conta foi reprovada na revisão → Veja o motivo no Gerenciador do WhatsApp e peça nova análise.');
        if (health && health !== prev.health && health !== 'AVAILABLE') push(health === 'BLOCKED' ? 'bad' : 'warn', `Conta ${w.name}: envio ${HEALTH_PT[health].toLowerCase()}`, detail);
        if (health === 'AVAILABLE' && prev.health && prev.health !== 'AVAILABLE') push('ok', `Conta ${w.name}: envio normalizado`, 'A conta voltou a enviar normalmente.');
      } else if (w.account_review_status === 'REJECTED' || (health && health !== 'AVAILABLE')) {
        push(health === 'BLOCKED' || w.account_review_status === 'REJECTED' ? 'bad' : 'warn', `Conta ${w.name}: ${w.account_review_status === 'REJECTED' ? 'reprovada pela Meta' : 'envio ' + HEALTH_PT[health].toLowerCase()}`, detail || (w.account_review_status === 'REJECTED' ? 'Veja o motivo no Gerenciador do WhatsApp e peça nova análise.' : null));
      }
      await sql`insert into as_wabas (waba_id, bm_ref, name, review_status, health, health_detail, updated_at)
        values (${w.id}, ${bm.id}, ${w.name || null}, ${w.account_review_status || null}, ${health}, ${detail || null}, now())
        on conflict (waba_id) do update set bm_ref = excluded.bm_ref, name = excluded.name, review_status = excluded.review_status,
          health = excluded.health, health_detail = excluded.health_detail, updated_at = now()`;

      // 2) Números
      // Limite diário: a Meta passou a informar no nível do portfólio (whatsapp_business_manager_messaging_limit);
      // o campo antigo (messaging_limit_tier) fica como reserva.
      let nums;
      try { nums = await graph(`/${w.id}/phone_numbers?limit=100&fields=id,display_phone_number,verified_name,quality_rating,status,health_status,whatsapp_business_manager_messaging_limit`, token); }
      catch (e) {
        nums = await graphFields(`/${w.id}/phone_numbers?limit=100`, token,
          'id,display_phone_number,verified_name,quality_rating,status,health_status,messaging_limit_tier',
          'id,display_phone_number,verified_name,quality_rating,status');
      }
      for (const n of nums.data || []) {
        const lim = n.whatsapp_business_manager_messaging_limit;
        if (lim && !n.messaging_limit_tier) n.messaging_limit_tier = typeof lim === 'object' ? (lim.current_limit || lim.tier || lim.limit || null) : lim;
      }
      for (const n of nums.data || []) {
        const p = (await sql`select * from as_numbers where phone_number_id = ${n.id}`)[0];
        const nh = n.health_status && n.health_status.can_send_message || null;
        const nd = healthDetail(n.health_status);
        const label = `Número ${n.display_phone_number}`;
        const st = await sentStats(w.id, n.display_phone_number, token);
        if (p) {
          if (n.status && p.status && n.status !== p.status) push(['BANNED', 'FLAGGED', 'RESTRICTED', 'DISCONNECTED'].includes(n.status) ? 'bad' : 'info', `${label}: ${T.statusPt(n.status).toLowerCase()}`, T.statusLine(n.status, p.status));
          if (n.quality_rating && p.quality && n.quality_rating !== p.quality && n.quality_rating !== 'GREEN') push(n.quality_rating === 'RED' ? 'bad' : 'warn', `${label}: qualidade ${n.quality_rating === 'RED' ? 'baixa' : 'média'}`, T.QUALITY[n.quality_rating] || null);
          if (nh && nh !== p.health && nh !== 'AVAILABLE') push(nh === 'BLOCKED' ? 'bad' : 'warn', `${label}: envio ${HEALTH_PT[nh].toLowerCase()}`, nd || 'A Meta não informou o motivo → Veja o aviso no Gerenciador do WhatsApp.');
          if (nh === 'AVAILABLE' && p.health && p.health !== 'AVAILABLE') push('ok', `${label}: envio normalizado`, 'O número voltou a enviar normalmente.');
        } else if ((nh && nh !== 'AVAILABLE') || ['BANNED', 'FLAGGED', 'RESTRICTED'].includes(n.status)) {
          push(nh === 'BLOCKED' || n.status === 'BANNED' ? 'bad' : 'warn', `${label}: ${nh && nh !== 'AVAILABLE' ? 'envio ' + HEALTH_PT[nh].toLowerCase() : T.statusPt(n.status).toLowerCase()}`, T.joinUnique([n.status && n.status !== 'CONNECTED' ? T.statusLine(n.status) : '', nd].filter(Boolean)) || null);
        }
        await sql`insert into as_numbers (phone_number_id, waba_id, bm_ref, display_phone, verified_name, quality, status, health, health_detail, limit_tier, sent30, last_sent, updated_at)
          values (${n.id}, ${w.id}, ${bm.id}, ${n.display_phone_number || null}, ${n.verified_name || null}, ${n.quality_rating || null},
                  ${n.status || null}, ${nh}, ${nd || null}, ${n.messaging_limit_tier || null}, ${st ? st.sent : null}, ${st ? st.last : null}, now())
          on conflict (phone_number_id) do update set waba_id = excluded.waba_id, bm_ref = excluded.bm_ref, display_phone = excluded.display_phone,
            verified_name = excluded.verified_name, quality = excluded.quality, status = excluded.status, health = excluded.health,
            health_detail = excluded.health_detail, limit_tier = coalesce(excluded.limit_tier, as_numbers.limit_tier),
            sent30 = coalesce(excluded.sent30, as_numbers.sent30), last_sent = coalesce(excluded.last_sent, as_numbers.last_sent), updated_at = now()`;
      }

      // Números excluídos na Meta deixam de aparecer aqui.
      const keep = (nums.data || []).map((n) => String(n.id));
      await sql`delete from as_numbers where waba_id = ${w.id} and not (phone_number_id = any(${keep}::text[]))`;

      // 3) Templates
      const tpls = await graph(`/${w.id}/message_templates?fields=name,language,status,category&limit=250`, token);
      const prevT = new Map((await sql`select name, language, status from as_templates where waba_id = ${w.id}`).map((r) => [r.name + '|' + r.language, r]));
      for (const t of tpls.data || []) {
        const pt = prevT.get(t.name + '|' + t.language);
        if (pt && pt.status === t.status) continue; // nada mudou
        if (pt && pt.status !== t.status && BAD_TEMPLATE.includes(t.status)) { const ta = T.templateAlert(t.name, t.status); push(t.status === 'PAUSED' ? 'warn' : 'bad', ta.title, ta.fix); }
        await sql`insert into as_templates (waba_id, name, language, category, status, bm_ref, updated_at)
          values (${w.id}, ${t.name}, ${t.language}, ${t.category || null}, ${t.status || null}, ${bm.id}, now())
          on conflict (waba_id, name, language) do update set status = excluded.status, category = excluded.category, bm_ref = excluded.bm_ref, updated_at = now()`;
      }
    }
    // Limite do portfólio direto na BM (aparece mesmo quando ainda não há número na conta).
    try {
      const d = await graph(`/${bm.bm_id}?fields=whatsapp_business_manager_messaging_limit`, token);
      const lim = d.whatsapp_business_manager_messaging_limit;
      const tier = lim && (typeof lim === 'object' ? (lim.current_limit || lim.tier || lim.limit) : lim);
      if (tier) await sql`update as_bms set limit_tier = ${String(tier)} where id = ${bm.id}`;
    } catch {}
    await sql`update as_bms set last_check = now(), last_error = ${partial} where id = ${bm.id}`;
    // A consulta voltou a funcionar: os avisos de falha antigos desta BM deixam de ser pendência.
    if (bm.last_error && !String(bm.last_error).startsWith('Parcial')) await sql`update as_alerts set seen = true where bm_ref = ${bm.id} and not seen and title like 'Falha ao consultar%'`;
  } catch (err) {
    const msg = friendlyError(err).slice(0, 400);
    if (msg !== bm.last_error) push('bad', `Falha ao consultar "${bm.name}"`, msg);
    await sql`update as_bms set last_check = now(), last_error = ${msg} where id = ${bm.id}`;
  }

  for (const a of alerts) {
    await sql`insert into as_alerts (bm_ref, level, title, detail) values (${bm.id}, ${a.level}, ${a.title.slice(0, 300)}, ${a.detail ? String(a.detail).slice(0, 3000) : null})`;
  }
  return alerts.map((a) => ({ ...a, bm: bm.name }));
}

// Consulta todas as BMs ativas (4 por vez) e avisa o webhook de alertas, se houver.
async function runCheck(sql, onlyId) {
  const bms = onlyId
    ? await sql`select * from as_bms where id = ${onlyId}`
    : await sql`select * from as_bms where active order by id`;
  const all = [];
  for (let i = 0; i < bms.length; i += 4) {
    const res = await Promise.all(bms.slice(i, i + 4).map((bm) => checkBm(sql, bm).catch(() => [])));
    res.forEach((r) => all.push(...r));
  }
  await setSetting(sql, 'last_run', new Date().toISOString());
  if (all.length) await notify(sql, all);
  return { checked: bms.length, alerts: all.length };
}

async function notify(sql, alerts, test) {
  const url = await getSetting(sql, 'alert_webhook');
  if (!url) return { sent: false };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origem: 'Disply · Ativos', teste: Boolean(test), alertas: alerts.map((a) => ({ nivel: a.level, bm: a.bm, titulo: a.title, detalhe: a.detail })) }),
      signal: AbortSignal.timeout(5000)
    });
    return { sent: true, status: r.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// Diagnóstico do acesso de uma BM: o que o token enxerga (sem nunca devolver o token).
async function diagnose(bm) {
  const token = decrypt(bm.token_enc);
  const out = [];
  const step = async (label, fn) => {
    try { out.push({ etapa: label, ok: true, resultado: await fn() }); }
    catch (err) { out.push({ etapa: label, ok: false, erro: `(#${err.code || '?'}${err.subcode ? '/' + err.subcode : ''}) ${err.message}` }); }
  };
  await step('Token (debug_token)', async () => {
    const d = (await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token)).data || {};
    return { gerado_em: d.issued_at ? new Date(d.issued_at * 1000).toISOString() : null, valido: d.is_valid, tipo: d.type, app: d.application, app_id: d.app_id, expira: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'nunca',
      permissoes: d.scopes, por_ativo: (d.granular_scopes || []).map((g) => ({ permissao: g.scope, ids: g.target_ids || 'todos' })) };
  });
  await step('Usuário do token (/me)', () => graph('/me?fields=id,name', token));
  await step('Papel do usuário do sistema', async () => { try { return await graph('/me?fields=id,name,role', token); } catch (e) { return 'não informado: ' + e.message; } });
  await step('App do token', async () => { const d = (await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token)).data || {}; return graph(`/${d.app_id}?fields=id,name,link,category`, token).catch((e) => ({ app_id: d.app_id, erro: e.message })); });
  await step('BMs que o usuário enxerga (/me/businesses)', async () => ((await graph('/me/businesses?fields=id,name&limit=50', token)).data || []));
  await step('Contas do WhatsApp atribuídas ao usuário (/me/assigned_whatsapp_business_accounts)', async () => ((await graph('/me/assigned_whatsapp_business_accounts?fields=id,name&limit=100', token)).data || []));
  for (const id of String(bm.waba_ids || '').split(/[\s,;]+/).filter((x) => /^\d{5,25}$/.test(x))) {
    await step(`Conta do WhatsApp ${id}`, () => graph(`/${id}?fields=id,name,account_review_status`, token));
    await step(`Números da conta ${id}`, async () => ((await graph(`/${id}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type,account_mode,name_status,code_verification_status,is_official_business_account&limit=50`, token)).data || []));
    await step(`Apps ligados à conta ${id}`, async () => ((await graph(`/${id}/subscribed_apps`, token)).data || []).map((x) => ({ app: x.whatsapp_business_api_data && x.whatsapp_business_api_data.name, id: x.whatsapp_business_api_data && x.whatsapp_business_api_data.id, override: x.override_callback_uri || null })));
  }
  await step(`BM ${bm.bm_id}`, () => graph(`/${bm.bm_id}?fields=id,name,verification_status`, token));
  await step('Contas do WhatsApp da própria BM', async () => ((await graph(`/${bm.bm_id}/owned_whatsapp_business_accounts?fields=id,name&limit=100`, token)).data || []));
  await step('Contas do WhatsApp compartilhadas com a BM', async () => ((await graph(`/${bm.bm_id}/client_whatsapp_business_accounts?fields=id,name&limit=100`, token)).data || []));
  return out;
}

module.exports = { diagnose, getAssetsDb, runCheck, notify, getSetting, setSetting, logActivity, tierLabel, HEALTH_PT, QUALITY_PT };
