// Comunicação com a WhatsApp Cloud API (API oficial da Meta) e regras de template.
const GRAPH = 'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v24.0');

async function graph(path, token, options = {}) {
  const r = await fetch(GRAPH + path, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.error) {
    const e = data.error || {};
    const err = new Error(e.error_user_msg || e.message || ('Erro ' + r.status + ' na Meta'));
    err.code = e.code;
    err.subcode = e.error_subcode;
    err.status = r.status;
    throw err;
  }
  return data;
}

function listNumbers(wabaId, token) {
  return graph(`/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=50`, token)
    .then((d) => d.data || []);
}

function getNumber(phoneNumberId, token) {
  return graph(`/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,quality_rating`, token);
}

async function listTemplates(wabaId, token) {
  const out = [];
  let path = `/${encodeURIComponent(wabaId)}/message_templates?fields=name,language,status,category,components&limit=100`;
  for (let page = 0; page < 20 && path; page++) {
    const d = await graph(path, token);
    out.push(...(d.data || []));
    const next = d.paging && d.paging.next;
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
  }
  return out;
}

function subscribeApp(wabaId, token, callbackUrl, verifyToken) {
  const body = callbackUrl ? { override_callback_uri: callbackUrl, verify_token: verifyToken } : {};
  return graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, token, { method: 'POST', body: JSON.stringify(body) });
}

function sendTemplate(phoneNumberId, token, to, template) {
  return graph(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template })
  });
}

// Mensagem de texto livre (só é aceita dentro da janela de 24h após a última mensagem do cliente).
function sendText(phoneNumberId, token, to, body) {
  return graph(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } })
  });
}

// ---------- Leitura da estrutura do template ----------
const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function varsIn(text) {
  const seen = [];
  for (const m of String(text || '').matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

// Resume o que um template precisa receber no disparo.
function describeTemplate(componentsJson) {
  let components = [];
  try { components = typeof componentsJson === 'string' ? JSON.parse(componentsJson) : (componentsJson || []); } catch {}
  const info = { headerType: null, headerVars: [], bodyText: '', bodyVars: [], footer: '', buttons: [], dynamicButton: null, copyCode: null, carousel: false };
  for (const c of components) {
    const type = String(c.type || '').toUpperCase();
    if (type === 'HEADER') {
      info.headerType = String(c.format || 'TEXT').toUpperCase();
      if (info.headerType === 'TEXT') { info.headerText = c.text || ''; info.headerVars = varsIn(c.text); }
    } else if (type === 'BODY') {
      info.bodyText = c.text || '';
      info.bodyVars = varsIn(c.text);
    } else if (type === 'FOOTER') {
      info.footer = c.text || '';
    } else if (type === 'BUTTONS') {
      (c.buttons || []).forEach((b, index) => {
        info.buttons.push({ type: b.type, text: b.text, url: b.url || null });
        if (String(b.type).toUpperCase() === 'URL' && varsIn(b.url).length && !info.dynamicButton) {
          info.dynamicButton = { index, url: b.url };
        }
        if (String(b.type).toUpperCase() === 'COPY_CODE' && !info.copyCode) info.copyCode = { index };
      });
    } else if (type === 'CAROUSEL') {
      info.carousel = true;
    }
  }
  info.named = info.bodyVars.some((v) => !/^\d+$/.test(v));
  info.needsMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(info.headerType);
  return info;
}

// ---------- Personalização ----------
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Troca {nome}, {primeiro_nome} e {telefone} pelos dados do contato.
function renderText(template, contact, fallback) {
  const values = {
    nome: String(contact.name || '').trim(),
    primeiro_nome: firstName(contact.name),
    telefone: contact.phone || ''
  };
  let out = String(template || '').replace(/\{\s*(nome|primeiro_nome|telefone)\s*\}/gi, (_, k) => {
    const v = values[k.toLowerCase()];
    return v || (k.toLowerCase() === 'telefone' ? '' : (fallback || ''));
  });
  out = out.replace(/\s+/g, ' ').trim(); // a Meta não aceita quebra de linha nem tabs em variáveis
  return out || (fallback || '-');
}

// Monta o bloco "template" da chamada de envio.
function buildTemplatePayload(tpl, info, op, contact) {
  const components = [];
  if (info.needsMedia) {
    const kind = info.headerType.toLowerCase();
    const media = { link: op.header_value };
    if (kind === 'document') media.filename = 'documento.pdf';
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: media }] });
  } else if (info.headerType === 'TEXT' && info.headerVars.length) {
    const hp = { type: 'text', text: renderText(op.header_value, contact, op.name_fallback) };
    if (!/^\d+$/.test(info.headerVars[0])) hp.parameter_name = info.headerVars[0];
    components.push({ type: 'header', parameters: [hp] });
  }
  const vars = op.body_vars_obj || {};
  if (info.bodyVars.length) {
    components.push({
      type: 'body',
      parameters: info.bodyVars.map((v) => {
        const p = { type: 'text', text: renderText(vars[v], contact, op.name_fallback) };
        if (info.named) p.parameter_name = v;
        return p;
      })
    });
  }
  if (info.dynamicButton) {
    components.push({
      type: 'button', sub_type: 'url', index: String(info.dynamicButton.index),
      parameters: [{ type: 'text', text: renderText(op.button_param, contact, '') }]
    });
  }
  if (info.copyCode) {
    // Cupom do botão "Copiar código" (guardado junto das variáveis, na chave _cupom).
    components.push({
      type: 'button', sub_type: 'copy_code', index: String(info.copyCode.index),
      parameters: [{ type: 'coupon_code', coupon_code: String(vars._cupom || '').trim().slice(0, 15) }]
    });
  }
  const out = { name: tpl.name, language: { code: tpl.language } };
  if (components.length) out.components = components;
  return out;
}

// Texto da prévia (como a pessoa vai ler).
function previewText(info, op, contact) {
  const vars = op.body_vars_obj || {};
  return String(info.bodyText || '').replace(VAR_RE, (_, v) => renderText(vars[v], contact, op.name_fallback));
}

// ---------- Telefones ----------
// Aceita números brasileiros com ou sem 55, com máscara. Retorna só dígitos, com DDI.
function normalizePhone(raw, country = '55') {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^0+/, '');
  if (country === '55') {
    if (d.length === 10 || d.length === 11) d = '55' + d;
    if (!/^55\d{10,11}$/.test(d)) return null;
    // Celular sem o nono dígito (como a Meta costuma devolver): 55 + DDD + 8 dígitos começando em 6–9.
    if (d.length === 12 && /^55\d\d[6-9]/.test(d)) d = d.slice(0, 4) + '9' + d.slice(4);
    return d;
  }
  return d.length >= 8 && d.length <= 15 ? d : null;
}

// Erros da Meta que valem tentar de novo depois (limite de velocidade).
function isRetryable(err) {
  return [4, 80007, 130429, 131056].includes(Number(err && err.code)) || (err && err.status >= 500);
}

// ---------- Perfil do número (foto e textos) ----------
function getProfile(phoneNumberId, token) {
  return graph(`/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile?fields=profile_picture_url,about,description,vertical,websites,email,address`, token)
    .then((d) => (d.data && d.data[0]) || {});
}

// Troca a foto: 1) descobre o app do token, 2) sobe a imagem pela API de upload retomável, 3) aplica no perfil.
async function setProfilePhoto(phoneNumberId, token, buffer, mime) {
  const dbg = await graph(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
  const appId = dbg.data && dbg.data.app_id;
  if (!appId) throw new Error('Não consegui identificar o app do token.');
  const session = await graph(`/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mime)}&file_name=perfil.jpg`, token, { method: 'POST' });
  const r = await fetch(GRAPH + '/' + session.id, { method: 'POST', headers: { Authorization: 'OAuth ' + token, file_offset: '0' }, body: buffer });
  let up = {}; try { up = await r.json(); } catch {}
  if (!r.ok || !up.h) {
    const e = up.error || {};
    const err = new Error(e.error_user_msg || e.message || 'A Meta recusou o envio da imagem.'); err.code = e.code; throw err;
  }
  await graph(`/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile`, token, {
    method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: up.h })
  });
  return true;
}

// Registra o número na Cloud API (necessário depois de adicionar e verificar o número).
function registerNumber(phoneNumberId, token, pin) {
  return graph(`/${encodeURIComponent(phoneNumberId)}/register`, token, {
    method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin: String(pin) })
  });
}

module.exports = { registerNumber, getProfile, setProfilePhoto,
  graph, listNumbers, getNumber, listTemplates, subscribeApp, sendTemplate, sendText,
  describeTemplate, renderText, buildTemplatePayload, previewText, normalizePhone, isRetryable
};
