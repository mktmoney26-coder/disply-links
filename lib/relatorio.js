// Relatório de uma operação de disparo, pronto para o cliente (abre no navegador e salva em PDF).
// Endereço: /relatorio/<id>?t=<chave>  — a chave é gerada pelo sistema; sem ela, a página não abre.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDispatchDb } = require('./dispatch-db');
const meta = require('./meta');

function reportKey(id) {
  return crypto.createHmac('sha256', 'disply:relatorio:' + (process.env.STATS_KEY || '')).update(String(id)).digest('hex').slice(0, 24);
}
function same(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const pct = (a, b) => (b ? (a / b * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');
const dt = (d) => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—';

// Agrupa os erros da Meta em motivos que o cliente entende.
function failReason(err) {
  const e = String(err || '');
  const code = (/#(\d{3,6})/.exec(e) || [])[1];
  const map = {
    131026: 'Número sem WhatsApp ou que não pode receber mensagens',
    131049: 'A Meta limitou mensagens de marketing para esse contato',
    131050: 'O contato bloqueou mensagens de marketing',
    130472: 'Contato em teste da Meta (não recebe marketing)',
    131047: 'Fora da janela de atendimento',
    131021: 'Número igual ao remetente',
    131042: 'Problema de pagamento da conta',
    131056: 'Muitas mensagens para o mesmo contato em pouco tempo',
    131053: 'Falha no envio da mídia',
    132001: 'Template indisponível', 132000: 'Erro nas variáveis do template', 132012: 'Erro nas variáveis do template',
    132015: 'Template pausado pela Meta', 132016: 'Template desativado pela Meta',
    130429: 'Limite de velocidade da Meta', 131048: 'Limite de envio do número', 368: 'Bloqueio temporário por política'
  };
  if (code && map[code]) return map[code];
  if (/invalid|inválid|não tem whatsapp/i.test(e)) return 'Número inválido';
  return 'Outros motivos';
}

let logo = null;
function logoData() {
  if (logo === null) {
    try { logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'brand', 'logo-cor.png')).toString('base64'); }
    catch { logo = ''; }
  }
  return logo;
}

module.exports = async (req, res) => {
  const id = parseInt((req.query || {}).id, 10);
  if (!process.env.STATS_KEY || !Number.isFinite(id) || !same((req.query || {}).t, reportKey(id))) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Relatório não encontrado.'); return;
  }
  try {
    const sql = await getDispatchDb();
    const op = (await sql`select o.*, i.name as instance_name, i.display_phone, i.verified_name, i.phone_number_id, i.waba_id,
        t.name as template_name, t.category, t.language, t.components, l.name as list_name
      from wa_operations o left join wa_instances i on i.id = o.instance_id
      left join wa_templates t on t.id = o.template_id left join wa_lists l on l.id = o.list_id where o.id = ${id}`)[0];
    if (!op) { res.status(404).end('Relatório não encontrado.'); return; }

    // Campanha dividida em lotes (vários números): ?grupo=1 junta todos os lotes num relatório só.
    let opIds = [id];
    if (String((req.query || {}).grupo) === '1' && op.group_id === id) {
      const lotes = await sql`select o.id, i.display_phone, o.finished_at, o.status from wa_operations o left join wa_instances i on i.id = o.instance_id
        where o.group_id = ${id} order by o.id`;
      opIds = lotes.map((l) => l.id);
      op.name = String(op.name).replace(/ · Lote [A-Z0-9]+$/, '');
      op.display_phone = lotes.map((l) => l.display_phone).filter(Boolean).join(', ');
      op.lotes = lotes.length;
      const running = lotes.find((l) => ['running', 'paused'].includes(l.status));
      op.status = running ? running.status : op.status;
      op.finished_at = running ? null : lotes.reduce((m, l) => (l.finished_at && (!m || new Date(l.finished_at) > new Date(m)) ? l.finished_at : m), null);
    }

    // Cliente = nome da BM em Ativos (se houver), senão o nome verificado do número.
    let client = op.verified_name || op.instance_name || '';
    try {
      const b = await sql`select b.name from as_numbers n join as_bms b on b.id = n.bm_ref where n.phone_number_id = ${op.phone_number_id}`;
      if (b.length) client = b[0].name;
    } catch {}

    const q = req.query || {};
    const grupo = String(q.grupo) === '1' && opIds.length > 1 ? '&grupo=1' : '';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const base = `https://${host}/relatorio/${id}?t=${reportKey(id)}${grupo}`;
    const since0 = op.started_at || op.created_at;
    const STATUS_TXT = { read: 'Lida', delivered: 'Entregue', sent: 'Enviada (sem confirmação de entrega)', failed: 'Não entregue', skipped: 'Não enviada (cancelada)', pending: 'Não enviada', sending: 'Não enviada' };
    async function contactRows() {
      const rows = await sql`select r.name, r.phone, r.status, r.error, r.sent_at, o.tag from wa_recipients r join wa_operations o on o.id = r.operation_id
        where r.operation_id = any(${opIds}::int[]) order by r.id limit 200000`;
      const replied = new Set((await sql`select distinct i.phone from wa_inbound i join wa_recipients r on r.phone = i.phone and r.operation_id = any(${opIds}::int[])
        join wa_operations o on o.id = r.operation_id and o.instance_id = i.instance_id where i.created_at >= ${since0}`).map((x) => x.phone));
      const out = new Set((await sql`select o.phone from wa_optouts o join (select distinct phone from wa_recipients where operation_id = any(${opIds}::int[])) r on r.phone = o.phone
        where o.created_at >= ${since0}`).map((x) => x.phone));
      return rows.map((r) => ({ ...r, replied: replied.has(r.phone), optout: out.has(r.phone) }));
    }
    // Planilha com todos os contatos do disparo (o cliente confere que foi a lista dele).
    if (q.formato === 'csv') {
      const rows = await contactRows();
      const sep = q.sep === 'virgula' ? ',' : ';';
      const cell = (v) => { const x = String(v == null ? '' : v); return /[",;\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
      const head = ['Telefone', 'Nome', 'Status', 'Enviado em', 'Respondeu', 'Pediu SAIR', 'Motivo (se não entregue)'].concat(grupo ? ['Lote'] : []);
      const lines = [head.join(sep)].concat(rows.map((r) => [r.phone, r.name || '', STATUS_TXT[r.status] || r.status, r.sent_at ? dt(r.sent_at).replace(',', '') : '', r.replied ? 'Sim' : 'Não', r.optout ? 'Sim' : 'Não',
        r.status === 'failed' ? failReason(r.error) : ''].concat(grupo ? [r.tag || ''] : []).map(cell).join(sep)));
      const fname = 'contatos-' + String(op.name).replace(/ · Lote [A-Z0-9]+$/, '').normalize('NFD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60) + '.csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `${q.sep === 'virgula' ? 'inline' : 'attachment'}; filename="${fname}"`);
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
      res.status(200).end((sep === ';' ? '﻿' : '') + lines.join('\r\n'));
      return;
    }
    const annex = String(q.anexo) === '1' ? await contactRows() : null;

    const counts = Object.fromEntries((await sql`select status, count(*)::int as n from wa_recipients where operation_id = any(${opIds}::int[]) group by status`).map((r) => [r.status, r.n]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const sent = (counts.sent || 0) + (counts.delivered || 0) + (counts.read || 0);
    const delivered = (counts.delivered || 0) + (counts.read || 0);
    const read = counts.read || 0;
    const failed = counts.failed || 0;
    const notSent = (counts.skipped || 0) + (counts.pending || 0) + (counts.sending || 0);
    const [times] = await sql`select min(sent_at) as first_at, max(sent_at) as last_at from wa_recipients where operation_id = any(${opIds}::int[]) and sent_at is not null`;
    const since = op.started_at || op.created_at;

    const [replies] = await sql`select count(distinct i.phone)::int as n from wa_inbound i
      join wa_recipients r on r.phone = i.phone and r.operation_id = any(${opIds}::int[])
      join wa_operations o on o.id = r.operation_id and o.instance_id = i.instance_id
      where i.created_at >= ${since}`;
    const [optouts] = await sql`select count(*)::int as n from wa_optouts o
      join (select distinct phone from wa_recipients where operation_id = any(${opIds}::int[])) r on r.phone = o.phone
      where o.created_at >= ${since}`;

    // Cliques: quando o final do link do botão é um link do painel
    let clicks = null;
    const slug = String(op.button_param || '').trim().toLowerCase();
    if (/^[a-z0-9-]{1,64}$/.test(slug)) {
      try {
        const [c] = await sql`select count(*)::int as n, count(distinct contact)::int as u from clicks
          where slug = ${slug} and created_at >= ${since} and created_at < ${new Date(new Date(since).getTime() + 7 * 86400000)}`;
        if (c && c.n) clicks = c;
      } catch {}
    }

    const reasonsRaw = await sql`select error, count(*)::int as n from wa_recipients where operation_id = any(${opIds}::int[]) and status = 'failed' group by error`;
    const reasons = {};
    for (const r of reasonsRaw) { const k = failReason(r.error); reasons[k] = (reasons[k] || 0) + r.n; }
    const reasonRows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);

    // Por hora (entregas)
    const hourly = await sql`select date_trunc('hour', sent_at) as h, count(*)::int as n from wa_recipients
      where operation_id = any(${opIds}::int[]) and sent_at is not null group by date_trunc('hour', sent_at) order by date_trunc('hour', sent_at) limit 72`;

    let preview = '';
    try {
      const info = meta.describeTemplate(op.components);
      try { op.body_vars_obj = JSON.parse(op.body_vars || '{}'); } catch { op.body_vars_obj = {}; }
      preview = meta.previewText(info, op, { name: 'Maria Silva', phone: '' });
    } catch {}

    const statusPt = { running: 'Em andamento', paused: 'Pausada', done: 'Concluída', canceled: 'Cancelada', error: 'Com erro', queued: 'Na fila' }[op.status] || op.status;
    const maxH = Math.max(1, ...hourly.map((h) => h.n));
    const funnel = [
      ['Público da operação', total, 'var(--muted)'],
      ['Enviadas', sent, 'var(--azul)'],
      ['Entregues', delivered, 'var(--teal)'],
      ['Lidas', read, '#0a8f6f']
    ];

    const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Relatório · ${esc(op.name)}</title>
<style>
  :root{--teal:#00D4A3;--azul:#007BFF;--marca:linear-gradient(120deg,#00D4A3,#007BFF);--ink:#0D1B2A;--muted:#5b6b80;--line:#dfe6ef;--soft:#f4f7fb;--bad:#b91c1c}
  *{box-sizing:border-box} body{margin:0;background:#e9eef5;color:var(--ink);font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45}
  .page{max-width:820px;margin:24px auto;background:#fff;padding:36px 40px;border-radius:10px;box-shadow:0 2px 16px rgba(13,27,42,.08)}
  .bar{height:5px;background:var(--marca);margin:-36px -40px 28px;border-radius:10px 10px 0 0}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:22px}
  header img{height:34px} h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .meta{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 24px;font-size:13px} .meta b{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:700}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px} .kpi{border:1px solid var(--line);border-radius:10px;padding:14px}
  .kpi span{font-size:12px;color:var(--muted);font-weight:600} .kpi b{display:block;font-size:26px;margin-top:4px;letter-spacing:-.02em} .kpi small{color:var(--muted)}
  .kpi.main{background:var(--marca);color:#fff;border:0} .kpi.main span,.kpi.main small{color:rgba(255,255,255,.9)}
  .row{display:flex;align-items:center;gap:10px;margin:6px 0} .row .l{flex:0 0 160px;font-size:13px} .row .t{flex:1;height:22px;background:var(--soft);border-radius:6px;overflow:hidden} .row .t i{display:block;height:100%;border-radius:6px} .row .v{flex:0 0 120px;text-align:right;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse} td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left} th{font-size:11px;color:var(--muted);text-transform:uppercase} td.n{text-align:right;font-variant-numeric:tabular-nums}
  .bubble{background:#E9E3D8;border-radius:12px;padding:14px} .bubble div{background:#fff;border-radius:8px;padding:10px 12px;max-width:440px;white-space:pre-wrap;font-size:13px}
  .hours{display:flex;align-items:flex-end;gap:3px;height:90px;border-bottom:1px solid var(--line)} .hours i{flex:1;background:var(--azul);border-radius:3px 3px 0 0;min-height:2px}
  .hl{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px}
  footer{margin-top:28px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:12px}
  .tools{max-width:820px;margin:16px auto 0;display:flex;justify-content:flex-end;gap:8px;padding:0 16px}
  .tools .tl{font-weight:600;border:1px solid var(--line);border-radius:7px;padding:9px 14px;background:#fff;color:var(--ink);text-decoration:none}
  .tools{flex-wrap:wrap}
  .box{border:1px solid var(--line);border-radius:10px;padding:16px}
  .lnk{display:inline-block;margin-top:6px;font-weight:700;color:var(--azul);word-break:break-all}
  .annex{font-size:10.5px} .annex td,.annex th{padding:3px 5px} .annex tr{break-inside:avoid}
  .st-ok{color:#047857;font-weight:600} .st-bad{color:var(--bad);font-weight:600}
  .tools button{font:inherit;font-weight:600;border:0;border-radius:7px;padding:10px 16px;background:var(--marca);color:#fff;cursor:pointer}
  @media (max-width:700px){.page{margin:0;border-radius:0;padding:24px 18px}.bar{margin:-24px -18px 20px}.kpis{grid-template-columns:repeat(2,1fr)}.meta{grid-template-columns:1fr}.row .l{flex-basis:110px}.row .v{flex-basis:90px}}
  @media print{@page{size:A4;margin:12mm} body{background:#fff} .page{box-shadow:none;margin:0;max-width:none;padding:0} .bar{margin:0 0 20px;border-radius:0} .tools{display:none} .kpi.main{-webkit-print-color-adjust:exact;print-color-adjust:exact} *{-webkit-print-color-adjust:exact;print-color-adjust:exact} section{break-inside:avoid}}
</style></head><body>
<div class="tools"><a class="tl" href="${esc(annex ? base : base + '&anexo=1')}">${annex ? 'Tirar a lista de contatos do PDF' : 'Incluir a lista de contatos no PDF'}</a><a class="tl" href="${esc(base + '&formato=csv')}">Baixar planilha</a><button type="button" onclick="window.print()">Baixar PDF</button></div>
<div class="page"><div class="bar"></div>
<header><div><h1>Relatório de disparo</h1><div style="color:var(--muted)">${esc(client)}</div></div>${logoData() ? `<img src="${logoData()}" alt="Disply">` : '<strong>Disply</strong>'}</header>
<section><div class="meta">
  <div><b>Campanha</b>${esc(op.name)}</div>
  <div><b>Situação</b>${esc(statusPt)}</div>
  <div><b>${op.lotes ? `Números que enviaram (${op.lotes} lotes)` : 'Número que enviou'}</b>${esc(op.display_phone || '—')}</div>
  <div><b>Template</b>${esc(op.template_name || '—')}${op.category ? ' · ' + esc(op.category === 'MARKETING' ? 'Marketing' : op.category === 'UTILITY' ? 'Utilidade' : op.category) : ''}</div>
  <div><b>Início</b>${dt(times && times.first_at || since)}</div>
  <div><b>Término</b>${op.finished_at ? dt(op.finished_at) : (times && times.last_at ? dt(times.last_at) : '—')}</div>
</div></section>

<h2>Resultado</h2>
<section class="kpis">
  <div class="kpi main"><span>Leads entregues</span><b>${num(delivered)}</b><small>${pct(delivered, sent)} das enviadas</small></div>
  <div class="kpi"><span>Enviadas</span><b>${num(sent)}</b><small>de ${num(total)} contatos</small></div>
  <div class="kpi"><span>Lidas</span><b>${num(read)}</b><small>${pct(read, delivered)} das entregues</small></div>
  <div class="kpi"><span>Responderam</span><b>${num(replies.n)}</b><small>${pct(replies.n, delivered)} das entregues</small></div>
</section>
${clicks ? `<section class="kpis" style="margin-top:10px;grid-template-columns:repeat(2,1fr)"><div class="kpi"><span>Cliques no link</span><b>${num(clicks.n)}</b><small>${pct(clicks.n, delivered)} das entregues</small></div><div class="kpi"><span>Pessoas que clicaram</span><b>${num(clicks.u || clicks.n)}</b><small>contatos únicos identificados</small></div></section>` : ''}

<h2>Funil</h2>
<section>${funnel.map(([l, v, c]) => `<div class="row"><div class="l">${l}</div><div class="t"><i style="width:${total ? Math.max(1, v / total * 100) : 0}%;background:${c}"></i></div><div class="v"><b>${num(v)}</b> · ${pct(v, total)}</div></div>`).join('')}</section>

${hourly.length > 1 ? `<h2>Envios ao longo do tempo</h2><section><div class="hours">${hourly.map((h) => `<i style="height:${Math.round(h.n / maxH * 100)}%" title="${dt(h.h)}: ${num(h.n)}"></i>`).join('')}</div><div class="hl"><span>${dt(hourly[0].h)}</span><span>${dt(hourly[hourly.length - 1].h)}</span></div></section>` : ''}

<h2>Não entregues</h2>
<section><table><thead><tr><th>Motivo</th><th style="text-align:right">Contatos</th></tr></thead><tbody>
${reasonRows.length ? reasonRows.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${num(n)}</td></tr>`).join('') : '<tr><td colspan="2" style="color:var(--muted)">Nenhuma falha de envio.</td></tr>'}
${notSent ? `<tr><td>Não enviadas (operação pausada ou cancelada)</td><td class="n">${num(notSent)}</td></tr>` : ''}
${sent - delivered > 0 ? `<tr><td>Enviadas sem confirmação de entrega (celular desligado, sem internet etc.)</td><td class="n">${num(sent - delivered)}</td></tr>` : ''}
</tbody></table>${optouts.n ? `<p style="font-size:12px;color:var(--muted);margin:8px 0 0">${num(optouts.n)} contato(s) entregue(s) pediram para não receber mais mensagens (SAIR) e foram removidos dos próximos envios.</p>` : ''}</section>

${preview ? `<h2>Mensagem enviada</h2><section class="bubble"><div>${esc(preview)}</div></section><p style="font-size:11px;color:var(--muted);margin:6px 0 0">Exemplo com o nome "Maria Silva". Cada contato recebeu a mensagem com o próprio nome.</p>` : ''}

<h2>Lista de contatos do disparo</h2>
<section class="box">
  <div style="font-size:13px">Planilha com <b>todos os ${num(total)} contatos</b> desta campanha: telefone, nome, status (entregue, lida, não entregue e o motivo), horário de envio, se respondeu e se pediu SAIR. Pode ser comparada com a lista original.</div>
  <a class="lnk" href="${esc(base + '&formato=csv')}">${esc(base + '&formato=csv')}</a>
  <div style="font-size:11.5px;color:var(--muted);margin-top:8px">Abre no Excel. No Google Planilhas, para ver online e sempre atualizado, cole numa célula: <code style="font-size:11px">=IMPORTDATA("${esc(base + '&formato=csv&sep=virgula')}")</code></div>
</section>
${annex ? `<h2 style="break-before:page">Anexo · todos os contatos (${num(annex.length)})</h2>
<table class="annex"><thead><tr><th>#</th><th>Telefone</th><th>Nome</th><th>Status</th><th>Enviado em</th>${grupo ? '<th>Lote</th>' : ''}</tr></thead><tbody>
${annex.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.phone)}</td><td>${esc(r.name || '')}</td><td class="${['delivered', 'read'].includes(r.status) ? 'st-ok' : r.status === 'failed' ? 'st-bad' : ''}">${esc(r.status === 'failed' ? 'Não entregue · ' + failReason(r.error) : (STATUS_TXT[r.status] || r.status))}${r.replied ? ' · respondeu' : ''}</td><td>${r.sent_at ? dt(r.sent_at) : '—'}</td>${grupo ? `<td>${esc(r.tag || '')}</td>` : ''}</tr>`).join('')}
</tbody></table>` : ''}

<footer><span>Relatório gerado em ${dt(new Date())} · Dados oficiais da API do WhatsApp (Meta).</span><span>Disply</span></footer>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.status(200).end(html);
  } catch (err) {
    console.error('relatorio:', err);
    res.status(500).end('Erro ao gerar o relatório.');
  }
};

module.exports.reportKey = reportKey;
