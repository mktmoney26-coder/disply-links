// Webhook da WhatsApp Cloud API: status (enviada/entregue/lida/falhou), respostas e pedidos de SAIR.
// URL para cadastrar na Meta: https://<domínio principal>/api/wa-webhook
const crypto = require('crypto');
const { getDispatchDb } = require('../lib/dispatch-db');
const { decrypt, verifyToken } = require('../lib/secrets');
const { normalizePhone } = require('../lib/meta');

const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|n[aã]o quero mais|parar promo[cç][oõ]es|stop promotions)\s*[.!]*\s*$/i;

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

// Texto legível de qualquer tipo de mensagem recebida.
function describeMessage(m) {
  const t = String(m.type || '');
  if (t === 'text') return (m.text && m.text.body) || '';
  if (t === 'button') return (m.button && m.button.text) || '[botão]';
  if (t === 'interactive') {
    const i = m.interactive || {};
    return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '[resposta interativa]';
  }
  const labels = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', voice: 'Áudio', document: 'Documento', sticker: 'Figurinha', location: 'Localização', contacts: 'Contato', reaction: 'Reação' };
  const media = m[t] || {};
  const extra = media.caption || media.filename || (t === 'reaction' ? media.emoji : '') || (t === 'location' ? [media.name, media.address].filter(Boolean).join(' – ') : '');
  return `[${labels[t] || t || 'mensagem'}]${extra ? ' ' + extra : ''}`;
}

function validSignature(raw, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(String(header || '')); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Token de verificação público para configurar o webhook nos apps das BMs pelo painel da Meta.
// Só confirma o endereço do webhook; não dá acesso a nada.
const PUBLIC_VERIFY = 'disply-webhook';

// Restrições que a Meta avisa pelo webhook e que nem sempre aparecem na consulta da conta.
const RESTR_PT = {
  RESTRICTED_BIZ_INITIATED_MESSAGING: 'não pode iniciar conversas (disparos)',
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: 'não pode responder clientes',
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: 'não pode adicionar números'
};
async function accountUpdate(sql, wabaId, v, raw, sig) {
  await require('../lib/assets-monitor').getAssetsDb();
  const w = (await sql`select waba_id from as_wabas where waba_id = ${wabaId}`.catch(() => []))[0];
  if (!w) return;
  // Confere a assinatura com o app de algum número desta conta, quando houver.
  const inst = (await sql`select i.app_secret_enc from wa_instances i join as_numbers n on n.phone_number_id = i.phone_number_id
    where n.waba_id = ${wabaId} and i.app_secret_enc is not null limit 1`.catch(() => []))[0];
  if (inst) { let secret = null; try { secret = decrypt(inst.app_secret_enc); } catch {} if (secret && !validSignature(raw, sig, secret)) return; }
  const ev = String(v.event || '');
  let text = null;
  if (ev === 'ACCOUNT_RESTRICTION' && Array.isArray(v.restriction_info) && v.restriction_info.length) {
    text = 'Conta restrita pela Meta: ' + v.restriction_info.map((r) => (RESTR_PT[r.restriction_type] || r.restriction_type) + (r.expiration ? ' até ' + new Date(Number(r.expiration) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '')).join('; ') + '. → Peça análise na Página Inicial do Suporte.';
  } else if (ev === 'ACCOUNT_VIOLATION') {
    text = 'A Meta registrou violação de política' + (v.violation_info && v.violation_info.violation_type ? ` (${v.violation_info.violation_type})` : '') + '. → Veja no Gerenciador do WhatsApp e peça análise se discordar.';
  } else if (ev === 'DISABLED_UPDATE' || (v.ban_info && /DISABLE|BAN/i.test(String(v.ban_info.waba_ban_state || '')))) {
    text = 'Conta desativada pela Meta. → Peça análise na Página Inicial do Suporte.';
  } else if (/REINSTATE|RESTRICTION_LIFTED|ACCOUNT_REINSTATEMENT/i.test(ev)) {
    await sql`update as_wabas set restriction = null, restriction_at = now() where waba_id = ${wabaId}`;
    return;
  }
  if (!text) return;
  await sql`update as_wabas set restriction = ${text.slice(0, 600)}, restriction_at = now() where waba_id = ${wabaId}`;
  await sql`insert into as_alerts (bm_ref, level, title, detail) select bm_ref, 'bad', ${'Conta ' + (wabaId) + ': ' + (ev === 'ACCOUNT_VIOLATION' ? 'violação registrada' : 'restrita pela Meta')}, ${text} from as_wabas where waba_id = ${wabaId}`.catch(() => {});
}

module.exports = async (req, res) => {
  // Verificação inicial feita pela Meta ao salvar o webhook
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && (q['hub.verify_token'] === verifyToken() || q['hub.verify_token'] === PUBLIC_VERIFY)) {
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
        // Avisos da conta (restrição, violação, banimento): entry.id é a conta do WhatsApp.
        if (change.field === 'account_update' && entry.id) {
          try { await accountUpdate(sql, String(entry.id), value, raw, req.headers['x-hub-signature-256']); } catch (e) { console.error('account_update:', e.message); }
          continue;
        }
        const pnid = value.metadata && value.metadata.phone_number_id;
        if (!pnid) continue;
        const inst = (await sql`select id, app_secret_enc from wa_instances where phone_number_id = ${String(pnid)}`)[0];
        if (!inst) continue; // número que não é nosso
        try { await sql`update wa_instances set webhook_at = now() where id = ${inst.id}`; } catch (e) { /* coluna ainda não criada */ }
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
            await sql`update wa_outbound set status = 'failed', error = ${msg} where wamid = ${s.id}`;
          } else if (RANK[status] !== undefined) {
            const lower = Object.keys(RANK).filter((k) => RANK[k] < RANK[status]);
            await sql`update wa_recipients set status = ${status}, updated_at = now()
              where wamid = ${s.id} and status = any(${lower}::text[])`;
            await sql`update wa_outbound set status = ${status} where wamid = ${s.id} and status = any(${lower}::text[])`;
          }
        }

        const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
        for (const m of value.messages || []) {
          const phone = normalizePhone(m.from) || String(m.from); // mesmo formato das listas (com o nono dígito)
          const md = ['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(m.type) ? (m[m.type] || {}) : {};
          await sql`insert into wa_inbound (instance_id, phone, name, text, wamid, msg_type, media_id, media_mime)
            values (${inst.id}, ${phone}, ${names[m.from] || null}, ${describeMessage(m).slice(0, 4000)}, ${m.id}, ${String(m.type || 'text')},
                    ${md.id || null}, ${md.mime_type || null})`;
          // Quem respondeu leu a mensagem: marca como lida mesmo que a pessoa tenha desligado a confirmação de leitura.
          try {
            await sql`update wa_recipients set status = 'read', updated_at = now()
              where phone = ${phone} and status in ('sent','delivered') and sent_at > now() - interval '30 days'
                and operation_id in (select id from wa_operations where instance_id = ${inst.id})`;
            await sql`update wa_outbound set status = 'read' where instance_id = ${inst.id} and phone = ${phone} and status in ('sent','delivered')`;
          } catch (e) { console.error('marcar lida:', e.message); }
          const text = m.text ? m.text.body : m.button ? m.button.text : '';
          if (OPT_OUT.test(String(text || ''))) {
            await sql`insert into wa_optouts (phone, instance_id) values (${phone}, ${inst.id}) on conflict (phone) do nothing`;
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
