// API do módulo Ativos (BMs, números, templates, alertas). Protegida pela senha do painel.
// Rotas: ?r=overview | bms | numbers | templates | alerts | check | settings | activity
const { guard } = require('../lib/auth');
const { encrypt, decrypt } = require('../lib/secrets');
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
    bms_erro: await one(sql`select count(*)::int as n from as_bms where active and last_error is not null and last_error not like 'Parcial%'`),
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
    // Troca a moeda de cobrança de uma conta do WhatsApp (API de migração de moeda da Meta).
    // step=start (cria a conta nova na moeda), status, complete (passa os números para a conta nova).
    if (a === 'currency') {
      const token = decrypt(bm.token_enc);
      const waba = String(body.waba || '').replace(/\D/g, '');
      const step = String(body.step || 'status');
      if (step === 'start') {
        if (!waba) throw new HttpError(400, 'Informe a conta do WhatsApp.');
        const cur = String(body.currency || 'BRL').toUpperCase().slice(0, 3);
        const r = await graph(`/${waba}/set_payment_method_migration_intent`, token, { method: 'POST', body: JSON.stringify({ currency: cur }) });
        await logActivity(sql, `Troca de moeda iniciada (${bm.name}): conta ${waba} para ${cur}`);
        return r;
      }
      const mig = String(body.migration_id || '').replace(/\D/g, '');
      if (!mig) throw new HttpError(400, 'Informe o migration_id.');
      if (step === 'complete') {
        const r = await graph(`/${mig}/resume_migration`, token, { method: 'POST', body: '{}' });
        await logActivity(sql, `Troca de moeda concluída (${bm.name}): migração ${mig}`);
        return r;
      }
      return await graph(`/${mig}`, token);
    }
    // Migra templates aprovados de uma conta do WhatsApp para outra da mesma BM (sem nova revisão da Meta).
    // dry=1: só mostra moeda das contas e quantos templates aprovados existem na origem.
    if (a === 'migrate') {
      const token = decrypt(bm.token_enc);
      const src = String(body.source || '').replace(/\D/g, '');
      const dst = String(body.dest || '').replace(/\D/g, '');
      if (!src || !dst || src === dst) throw new HttpError(400, 'Informe a conta de origem e a de destino.');
      const info = async (w) => {
        const d = await graph(`/${w}?fields=id,name,currency,owner_business_info`, token);
        const t = await graph(`/${w}/message_templates?fields=name,status,language,category&limit=500`, token);
        const list = t.data || [];
        return { id: d.id, name: d.name, currency: d.currency, owner: d.owner_business_info,
          templates: list.length, approved: list.filter((x) => x.status === 'APPROVED').map((x) => `${x.name} (${x.language}, ${x.category})`) };
      };
      const origem = await info(src);
      const destino = await info(dst);
      if (body.dry) return { origem, destino };
      const out = { migrados: [], falhas: {} };
      for (let page = 0; page < 10; page++) {
        let r;
        try { r = await graph(`/${dst}/migrate_message_templates`, token, { method: 'POST', body: JSON.stringify({ source_waba_id: src, page_number: page }) }); }
        catch (err) { if (page > 0 && /no templates found/i.test(err.message)) break; throw err; }
        out.migrados.push(...(r.migrated_templates || []));
        Object.assign(out.falhas, r.failed_templates || {});
        if (!(r.migrated_templates || []).length && !Object.keys(r.failed_templates || {}).length) break;
      }
      await logActivity(sql, `Templates migrados (${bm.name}): ${src} → ${dst}, ${out.migrados.length} ok, ${Object.keys(out.falhas).length} falhas`);
      return { origem, destino, ...out };
    }
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
    // Token novo vale também para as instâncias de disparo dos números desta BM.
    if (body.token) {
      try { await sql`update wa_instances set token_enc = ${tokenEnc}, updated_at = now() where phone_number_id in (select phone_number_id from as_numbers where bm_ref = ${id})`; } catch (e) {}
    }
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

// ---------------- Criar o mesmo template em várias contas ----------------
const GRAPH = 'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v24.0');
const appCache = new Map(); // bm_ref -> app_id (o envio de mídia é feito pelo app dono do token)
async function appOf(bm) {
  if (appCache.has(bm.id)) return appCache.get(bm.id);
  const token = decrypt(bm.token_enc);
  const d = await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
  const app = (d.data && d.data.app_id) || null;
  if (app) appCache.set(bm.id, app);
  return app;
}
function tplError(err) {
  const m = String(err.message || '');
  if (/already exists|já existe|2388023|2388024/i.test(m) || err.subcode === 2388023 || err.subcode === 2388024) return 'Já existe um template com esse nome e idioma nesta conta.';
  if (/content.*deleted|being deleted|2388025/i.test(m)) return 'Um template com esse nome foi excluído há pouco; a Meta só libera o nome depois de 30 dias. Use outro nome.';
  if (/handle/i.test(m)) return 'A Meta não aceitou a mídia do cabeçalho (envie de novo).';
  if (err.code === 190) return 'Token da BM expirado. Atualize o token em BMs.';
  if (err.code === 200 || err.code === 10) return 'O token não tem permissão de gerenciar templates nesta conta (whatsapp_business_management).';
  if (/limit/i.test(m) && /template/i.test(m)) return 'A conta atingiu o limite de templates.';
  return m || 'A Meta recusou o template.';
}
async function templatesBulk(sql, req, body, a) {
  await sql`create table if not exists as_uploads (upload_id text not null, idx integer not null, data text not null,
    created_at timestamptz not null default now(), primary key (upload_id, idx))`;
  if (req.method === 'GET') {
    const rows = await sql`select w.waba_id, w.name as waba_name, b.id as bm_ref, b.name as bm, b.profile, b.token_enc, b.last_error,
        (select count(*)::int from as_numbers n where n.waba_id = w.waba_id) as numeros
      from as_wabas w join as_bms b on b.id = w.bm_ref and b.active order by b.name, w.name`;
    const apps = {};
    await Promise.all([...new Map(rows.map((r) => [r.bm_ref, r])).values()].map(async (r) => {
      try { apps[r.bm_ref] = await appOf({ id: r.bm_ref, token_enc: r.token_enc }); } catch (e) { apps[r.bm_ref] = null; }
    }));
    return rows.map(({ token_enc, ...r }) => ({ ...r, app_id: apps[r.bm_ref] || null }));
  }
  if (a === 'chunk') {
    const id = clean(body.upload_id, 40); const idx = Number(body.idx);
    if (!/^[a-z0-9-]{8,40}$/.test(id) || !Number.isInteger(idx) || idx < 0 || idx > 40) throw new HttpError(400, 'Envio de arquivo inválido.');
    const data = String(body.data || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, 'Arquivo inválido.');
    await sql`insert into as_uploads (upload_id, idx, data) values (${id}, ${idx}, ${data}) on conflict (upload_id, idx) do update set data = excluded.data`;
    return { ok: true };
  }
  if (a === 'handle') {
    // Junta as partes e envia o arquivo para o app da BM; devolve o "handle" que vai no exemplo do cabeçalho.
    const id = clean(body.upload_id, 40); const mime = clean(body.mime, 60); const total = Number(body.parts);
    if (!/^(image\/(jpeg|png)|video\/mp4|application\/pdf)$/.test(mime)) throw new HttpError(400, 'Formato não aceito: use JPG, PNG, MP4 ou PDF.');
    const [bm] = await sql`select id, token_enc from as_bms where id = ${Number(body.bm_ref)}`;
    if (!bm) throw new HttpError(404, 'BM não encontrada.');
    const parts = await sql`select idx, data from as_uploads where upload_id = ${id} order by idx`;
    if (!parts.length || parts.length !== total) throw new HttpError(400, 'O arquivo não chegou inteiro. Envie de novo.');
    const buf = Buffer.concat(parts.map((p) => Buffer.from(p.data, 'base64')));
    const token = decrypt(bm.token_enc); const app = await appOf(bm);
    if (!app) throw new HttpError(400, 'Não consegui identificar o app do token desta BM.');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'application/pdf': 'pdf' }[mime];
    const session = await graph(`/${app}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(mime)}&file_name=cabecalho.${ext}`, token, { method: 'POST' });
    const r = await fetch(GRAPH + '/' + session.id, { method: 'POST', headers: { Authorization: 'OAuth ' + token, file_offset: '0' }, body: buf });
    let up = {}; try { up = await r.json(); } catch {}
    if (!r.ok || !up.h) throw new HttpError(400, 'A Meta recusou o arquivo: ' + ((up.error && (up.error.error_user_msg || up.error.message)) || r.status));
    return { handle: up.h, app_id: app };
  }
  if (a === 'cleanup') {
    await sql`delete from as_uploads where upload_id = ${clean(body.upload_id, 40)} or created_at < now() - interval '1 day'`;
    return { ok: true };
  }
  if (a === 'create') {
    const waba = clean(body.waba_id, 30);
    const [row] = await sql`select w.waba_id, b.id, b.name, b.token_enc from as_wabas w join as_bms b on b.id = w.bm_ref where w.waba_id = ${waba}`;
    if (!row) throw new HttpError(404, 'Conta não encontrada.');
    const t = body.template || {};
    const name = clean(t.name, 512);
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new HttpError(400, 'Nome do template: só letras minúsculas, números e _.');
    if (!['MARKETING', 'UTILITY'].includes(t.category)) throw new HttpError(400, 'Categoria inválida.');
    const payload = { name, language: clean(t.language, 10) || 'pt_BR', category: t.category, components: Array.isArray(t.components) ? t.components : [] };
    try {
      const r = await graph(`/${waba}/message_templates`, decrypt(row.token_enc), { method: 'POST', body: JSON.stringify(payload) });
      await logActivity(sql, `Template ${name} enviado para aprovação em ${row.name} (${waba}): ${r.status || 'PENDING'}`);
      try {
        await sql`insert into as_templates (waba_id, bm_ref, name, language, category, status, updated_at)
          values (${waba}, ${row.id}, ${name}, ${payload.language}, ${r.category || payload.category}, ${r.status || 'PENDING'}, now())
          on conflict do nothing`;
      } catch (e) {}
      return { ok: true, id: r.id, status: r.status || 'PENDING', category: r.category || payload.category };
    } catch (err) {
      return { ok: false, erro: tplError(err) };
    }
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
    else if (r === 'tpl-bulk') out = await templatesBulk(sql, req, body, a);
    else if (r === 'activity') out = await sql`select * from as_activity order by created_at desc limit 200`;
    else throw new HttpError(404, 'Recurso não encontrado.');
    res.status(200).json(out);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('ativos:', err);
    res.status(status).json({ erro: err.message || 'Erro inesperado.' });
  }
};
