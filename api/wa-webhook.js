// Webhook da WhatsApp Cloud API: status (enviada/entregue/lida/falhou), respostas e pedidos de SAIR.
// URL para cadastrar na Meta: https://<domínio principal>/api/wa-webhook
const crypto = require('crypto');
const { getDispatchDb } = require('../lib/dispatch-db');
const { decrypt, verifyToken } = require('../lib/secrets');

const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|n[aã]o quero mais)\s*[.!]*\s*$/i;

function readRaw(req) {
  // Lê o corpo cru (necessário para conferir a assinatura). Não tocamos em req.body,
  // que na Vercel é interpretado sob demanda e consumiria o conteúdo.
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validSignature(raw, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(String(header || '')); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  // Verificação inicial feita pela Meta ao salvar o webhook
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === verifyToken()) {
      res.status(200).setHeader('Content-Type', 'text/plain');
      res.end(String(q['hub.challenge'] || ''));
      return;
    }
    res.status(403).end('Token de verificação inválido.');
    return;
  }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let raw = '';
  try { raw = await readRaw(req); } catch { res.status(400).end(); return; }
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { res.status(400).end(); return; }

  try {
    const sql = await getDispatchDb();
    if (!sql) { res.status(200).end('ok'); return; }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const pnid = value.metadata && value.metadata.phone_number_id;
        if (!pnid) continue;
        const inst = (await sql`select id, app_secret_enc from wa_instances where phone_number_id = ${String(pnid)}`)[0];
        if (!inst) continue; // número que não é nosso
        if (inst.app_secret_enc) {
          let secret = null;
          try { secret = decrypt(inst.app_secret_enc); } catch {}
          if (secret && !validSignature(raw, req.headers['x-hub-signature-256'], secret)) continue; // assinatura inválida: ignora
        }

        for (const s of value.statuses || []) {
          const status = String(s.status || '');
          if (status === 'failed') {
            const e = (s.errors || [])[0] || {};
            const msg = `(#${e.code || '?'}) ${e.error_data && e.error_data.details || e.message || e.title || 'Falha na entrega'}`.slice(0, 400);
            await sql`update wa_recipients set status = 'failed', error = ${msg}, updated_at = now()
              where wamid = ${s.id} and status in ('sending','sent','delivered')`;
          } else if (RANK[status] !== undefined) {
            const lower = Object.keys(RANK).filter((k) => RANK[k] < RANK[status]);
            await sql`update wa_recipients set status = ${status}, updated_at = now()
              where wamid = ${s.id} and status = any(${lower}::text[])`;
          }
        }

        const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
        for (const m of value.messages || []) {
          const text = m.text ? m.text.body : m.button ? m.button.text : m.interactive ? JSON.stringify(m.interactive).slice(0, 500) : `[${m.type}]`;
          await sql`insert into wa_inbound (instance_id, phone, name, text, wamid)
            values (${inst.id}, ${m.from}, ${names[m.from] || null}, ${String(text || '').slice(0, 4000)}, ${m.id})`;
          if (OPT_OUT.test(String(text || ''))) {
            await sql`insert into wa_optouts (phone, instance_id) values (${m.from}, ${inst.id}) on conflict (phone) do nothing`;
          }
        }
      }
    }
  } catch (err) {
    console.error('wa-webhook:', err);
  }
  // Sempre 200: a Meta reenvia e pode desativar o webhook se receber erros repetidos.
  res.status(200).end('ok');
};
