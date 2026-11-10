// Monitor de ativos da Meta (reconstrução do "Ativos Meta"): BMs, contas do WhatsApp (WABAs),
// números e templates. A cada consulta compara com o estado anterior e cria alertas só quando algo muda.
const { getDispatchDb } = require('./dispatch-db');
const { decrypt } = require('./secrets');
const { graph } = require('./meta');

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
      await sql`create table if not exists as_activity (
        id bigserial primary key,
        text text not null,
        created_at timestamptz not null default now()
      )`;
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

// Texto legível do health_status da Meta (envio disponível / limitado / bloqueado e por quê).
function healthDetail(h) {
  if (!h || !Array.isArray(h.entities)) return '';
  const lines = [];
  for (const e of h.entities) {
    for (const er of e.errors || []) {
      lines.push(`[${e.entity_type}] ${er.error_description || ''}${er.possible_solution ? ' Solução sugerida: ' + er.possible_solution : ''}`.trim());
    }
  }
  return lines.join('\n');
}

const HEALTH_PT = { AVAILABLE: 'Disponível', LIMITED: 'Limitado', BLOCKED: 'Bloqueado' };
const QUALITY_PT = { GREEN: 'Verde', YELLOW: 'Amarela', RED: 'Vermelha', UNKNOWN: 'Sem dados' };
const BAD_TEMPLATE = ['PAUSED', 'DISABLED', 'REJECTED'];

function tierLabel(t) {
  const m = /TIER_(\d+)(K)?/i.exec(String(t || ''));
  if (!m) return t === 'TIER_UNLIMITED' ? 'Ilimitado' : null;
  return m[2] ? `${m[1]} mil` : m[1];
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
    const manual = String(bm.waba_ids || '').split(/[\s,;]+/).filter((x) => /^\d{5,25}$/.test(x));
    if (manual.length) {
      for (const id of manual) wabas.push(await graphFields(`/${id}`, token, 'id,name,account_review_status,health_status', 'id,name,account_review_status'));
    } else {
      for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
        try {
          const d = await graphFields(`/${bm.bm_id}/${edge}?limit=100`, token, 'id,name,account_review_status,health_status', 'id,name,account_review_status');
          wabas.push(...(d.data || []));
        } catch (err) { if (edge === 'owned_whatsapp_business_accounts') throw err; }
      }
    }
    const seen = new Set(); wabas = wabas.filter((w) => w && w.id && !seen.has(w.id) && seen.add(w.id));

    for (const w of wabas) {
      const prev = (await sql`select * from as_wabas where waba_id = ${w.id}`)[0];
      const health = w.health_status && w.health_status.can_send_message || null;
      const detail = healthDetail(w.health_status);
      if (prev) {
        if (w.account_review_status === 'REJECTED' && prev.review_status !== 'REJECTED') push('bad', `Conta WhatsApp ${w.name} reprovada na revisão da Meta`, `${bm.name}`);
        if (health && health !== prev.health && health !== 'AVAILABLE') push(health === 'BLOCKED' ? 'bad' : 'warn', `Conta WhatsApp ${w.name} com envio ${HEALTH_PT[health].toLowerCase()}`, detail);
        if (health === 'AVAILABLE' && prev.health && prev.health !== 'AVAILABLE') push('ok', `Conta WhatsApp ${w.name} voltou a enviar normalmente`, bm.name);
      } else if (w.account_review_status === 'REJECTED' || (health && health !== 'AVAILABLE')) {
        push(health === 'BLOCKED' || w.account_review_status === 'REJECTED' ? 'bad' : 'warn', `Conta WhatsApp ${w.name}: ${w.account_review_status === 'REJECTED' ? 'reprovada na revisão' : 'envio ' + HEALTH_PT[health].toLowerCase()}`, detail);
      }
      await sql`insert into as_wabas (waba_id, bm_ref, name, review_status, health, health_detail, updated_at)
        values (${w.id}, ${bm.id}, ${w.name || null}, ${w.account_review_status || null}, ${health}, ${detail || null}, now())
        on conflict (waba_id) do update set bm_ref = excluded.bm_ref, name = excluded.name, review_status = excluded.review_status,
          health = excluded.health, health_detail = excluded.health_detail, updated_at = now()`;

      // 2) Números
      const nums = await graphFields(`/${w.id}/phone_numbers?limit=100`, token,
        'id,display_phone_number,verified_name,quality_rating,status,health_status,messaging_limit_tier',
        'id,display_phone_number,verified_name,quality_rating,status');
      for (const n of nums.data || []) {
        const p = (await sql`select * from as_numbers where phone_number_id = ${n.id}`)[0];
        const nh = n.health_status && n.health_status.can_send_message || null;
        const nd = healthDetail(n.health_status);
        const label = `Número ${n.display_phone_number} (${w.name || bm.name})`;
        const st = await sentStats(w.id, n.display_phone_number, token);
        if (p) {
          if (n.status && p.status && n.status !== p.status) push(['BANNED', 'FLAGGED', 'RESTRICTED', 'DISCONNECTED'].includes(n.status) ? 'bad' : 'info', label, `Status do número: ${n.status} (antes: ${p.status})`);
          if (n.quality_rating && p.quality && n.quality_rating !== p.quality && n.quality_rating !== 'GREEN') push(n.quality_rating === 'RED' ? 'bad' : 'warn', label, `Qualidade ${QUALITY_PT[n.quality_rating] || n.quality_rating} (antes: ${QUALITY_PT[p.quality] || p.quality})`);
          if (nh && nh !== p.health && nh !== 'AVAILABLE') push(nh === 'BLOCKED' ? 'bad' : 'warn', label, `Envio ${HEALTH_PT[nh].toUpperCase()}\n${nd}`.trim());
          if (nh === 'AVAILABLE' && p.health && p.health !== 'AVAILABLE') push('ok', label, 'Envio voltou ao normal');
        } else if ((nh && nh !== 'AVAILABLE') || ['BANNED', 'FLAGGED', 'RESTRICTED'].includes(n.status)) {
          push(nh === 'BLOCKED' || n.status === 'BANNED' ? 'bad' : 'warn', label, `${n.status ? 'Status: ' + n.status : ''}${nh ? '\nEnvio ' + HEALTH_PT[nh].toUpperCase() : ''}\n${nd}`.trim());
        }
        await sql`insert into as_numbers (phone_number_id, waba_id, bm_ref, display_phone, verified_name, quality, status, health, health_detail, limit_tier, sent30, last_sent, updated_at)
          values (${n.id}, ${w.id}, ${bm.id}, ${n.display_phone_number || null}, ${n.verified_name || null}, ${n.quality_rating || null},
                  ${n.status || null}, ${nh}, ${nd || null}, ${n.messaging_limit_tier || null}, ${st ? st.sent : null}, ${st ? st.last : null}, now())
          on conflict (phone_number_id) do update set waba_id = excluded.waba_id, bm_ref = excluded.bm_ref, display_phone = excluded.display_phone,
            verified_name = excluded.verified_name, quality = excluded.quality, status = excluded.status, health = excluded.health,
            health_detail = excluded.health_detail, limit_tier = coalesce(excluded.limit_tier, as_numbers.limit_tier),
            sent30 = coalesce(excluded.sent30, as_numbers.sent30), last_sent = coalesce(excluded.last_sent, as_numbers.last_sent), updated_at = now()`;
      }

      // 3) Templates
      const tpls = await graph(`/${w.id}/message_templates?fields=name,language,status,category&limit=250`, token);
      const prevT = new Map((await sql`select name, language, status from as_templates where waba_id = ${w.id}`).map((r) => [r.name + '|' + r.language, r]));
      for (const t of tpls.data || []) {
        const pt = prevT.get(t.name + '|' + t.language);
        if (pt && pt.status === t.status) continue; // nada mudou
        if (pt && pt.status !== t.status && BAD_TEMPLATE.includes(t.status)) push(t.status === 'PAUSED' ? 'warn' : 'bad', `Template ${t.name}: ${t.status}`, `${w.name || bm.name} · antes: ${pt.status}`);
        await sql`insert into as_templates (waba_id, name, language, category, status, bm_ref, updated_at)
          values (${w.id}, ${t.name}, ${t.language}, ${t.category || null}, ${t.status || null}, ${bm.id}, now())
          on conflict (waba_id, name, language) do update set status = excluded.status, category = excluded.category, bm_ref = excluded.bm_ref, updated_at = now()`;
      }
    }
    await sql`update as_bms set last_check = now(), last_error = null where id = ${bm.id}`;
  } catch (err) {
    const msg = String(err.message || 'Erro desconhecido').slice(0, 300);
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

module.exports = { getAssetsDb, runCheck, notify, getSetting, setSetting, logActivity, tierLabel, HEALTH_PT, QUALITY_PT };
