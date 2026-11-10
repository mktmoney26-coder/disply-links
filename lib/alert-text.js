// Traduz e resume em português os avisos da Meta (health_status, status de número e de template),
// sempre no formato "o que aconteceu → como resolver".

const ENTITY = { WABA: 'Conta', PHONE_NUMBER: 'Número', BUSINESS: 'Empresa', APP: 'App', MESSAGE_TEMPLATE: 'Template' };

// Regras na ordem de prioridade: [teste no texto da Meta, problema, solução]
const RULES = [
  [/\bSIP\b|calling/i, null, null], // chamadas de voz: não afeta mensagens (ignorado)
  [/payment|billing|credit line|pagamento/i,
    'Forma de pagamento com erro ou ausente. Sem ela, a conta não inicia conversas.',
    'No Gerenciador do WhatsApp da conta, abra Configurações de pagamento e cadastre ou atualize o cartão.'],
  [/not linked|not registered|register|otp|verification code/i,
    'Número não registrado na API (código SMS não confirmado).',
    'No Gerenciador do WhatsApp, abra o número e conclua o registro com o código SMS.'],
  [/banned|ban\b|disabled|policy|violat|restrict/i,
    'Bloqueado pela Meta por violação de política.',
    'No Gerenciador do WhatsApp, veja o motivo e solicite uma análise. Se não reverter, troque o número/conta.'],
  [/business.*verif|verif.*business|not verified|unverified/i,
    'Empresa (BM) não verificada.',
    'Conclua a verificação da empresa em Configurações do negócio → Central de Segurança.'],
  [/display name|name.*(approv|reject|review)/i,
    'Nome de exibição do número não aprovado.',
    'Ajuste o nome de exibição no Gerenciador do WhatsApp e envie para análise de novo.'],
  [/messaging limit|tier|rate limit|limit/i,
    'Limite de mensagens atingido.',
    'Aguarde a renovação do limite (24h) e reduza o volume. Boa qualidade faz o limite subir.'],
  [/quality/i,
    'Qualidade do número baixa (muitos bloqueios ou denúncias).',
    'Pause os disparos deste número por alguns dias, revise a lista e o texto do template.'],
  [/review|pending|under analysis/i,
    'Em análise pela Meta.',
    'Aguarde a análise terminar. Não precisa fazer nada agora.'],
  [/access token|permission|unauthori/i,
    'Problema de permissão no app da Meta.',
    'Confira se o usuário do sistema tem acesso total à conta e ao app.'],
  [/certificate|two.?step|pin/i,
    'Registro do número incompleto (certificado ou PIN de verificação em duas etapas).',
    'No Gerenciador do WhatsApp, abra o número e conclua o registro.']
];

function translateIssue(entity, desc, sol) {
  const text = `${desc || ''} ${sol || ''}`;
  for (const [re, problem, fix] of RULES) {
    if (re.test(text)) return problem ? { entity: ENTITY[entity] || 'Conta', problem, fix } : null;
  }
  return { entity: ENTITY[entity] || 'Conta', problem: 'A Meta apontou um problema sem detalhe conhecido.', fix: 'Abra o Gerenciador do WhatsApp para ver o aviso completo.' };
}

function formatIssues(issues) {
  const seen = new Set(); const lines = [];
  for (const i of issues) {
    if (!i) continue;
    const key = i.problem; if (seen.has(key)) continue; seen.add(key);
    lines.push(`${i.problem} → ${i.fix}`);
  }
  return lines.join('\n');
}

// health_status da Meta → texto curto em português
function healthDetail(h) {
  if (!h || !Array.isArray(h.entities)) return '';
  const issues = [];
  for (const e of h.entities) for (const er of e.errors || []) issues.push(translateIssue(e.entity_type, er.error_description, er.possible_solution));
  return formatIssues(issues);
}

// Converte textos antigos (no formato "[WABA] texto em inglês Solução sugerida: ...") para o novo.
function translateLegacy(text) {
  if (!text || !/\[(WABA|PHONE_NUMBER|BUSINESS|APP|MESSAGE_TEMPLATE)\]|Status: [A-Z_]+|Status do número: [A-Z_]+|Envio (BLOQUEADO|LIMITADO)/.test(text)) return text;
  const issues = []; const rest = [];
  for (const line of String(text).split('\n')) {
    const m = /^\[([A-Z_]+)\]\s*(.*?)(?:\s*Solução sugerida:\s*(.*))?$/.exec(line.trim());
    if (m) issues.push(translateIssue(m[1], m[2], m[3]));
    else if (/^Status: ([A-Z_]+)$/.test(line.trim())) rest.push(statusLine(line.trim().slice(8)));
    else if (/^Status do número: ([A-Z_]+) \(antes: ([A-Z_]+)\)$/.test(line.trim())) { const [, a, b] = /^Status do número: ([A-Z_]+) \(antes: ([A-Z_]+)\)$/.exec(line.trim()); rest.push(statusLine(a, b)); }
    else if (/^Envio (BLOQUEADO|LIMITADO)$/.test(line.trim())) continue;
    else if (line.trim()) rest.push(line.trim());
  }
  return joinUnique([...rest, formatIssues(issues)].filter(Boolean));
}

const STATUS = {
  CONNECTED: ['Conectado', null],
  PENDING: ['Pendente', 'Registro não concluído → No Gerenciador do WhatsApp, abra o número e confirme o código SMS.'],
  FLAGGED: ['Sinalizado', 'Qualidade caiu muito → Pause os disparos deste número por alguns dias e revise lista e template.'],
  RESTRICTED: ['Restrito', 'A Meta limitou o envio → Reduza o volume e aguarde. Veja o motivo no Gerenciador do WhatsApp.'],
  BANNED: ['Banido', 'Número banido pela Meta → Solicite análise no Gerenciador do WhatsApp ou substitua o número.'],
  DISCONNECTED: ['Desconectado', 'O número saiu da API → Registre o número de novo no Gerenciador do WhatsApp.'],
  UNVERIFIED: ['Não verificado', 'Verificação do número pendente → Conclua o registro com o código SMS.'],
  MIGRATED: ['Migrado', null],
  DELETED: ['Excluído', null]
};
const statusPt = (s) => (STATUS[s] ? STATUS[s][0] : s || '—');
function statusLine(now, before) {
  const s = STATUS[now];
  const head = `Status: ${statusPt(now)}${before ? ` (antes: ${statusPt(before)})` : ''}.`;
  return s && s[1] ? `${head}\n${s[1]}` : head;
}

const TEMPLATE = {
  PAUSED: ['pausado', 'A Meta pausou por denúncias/baixa qualidade → Use outro template ou troque o texto; a pausa dura algumas horas.'],
  DISABLED: ['desativado', 'Desativado após pausas repetidas → Crie um template novo com outro texto.'],
  REJECTED: ['reprovado', 'Reprovado na análise → Veja o motivo no Gerenciador do WhatsApp, ajuste o texto e envie de novo.']
};
const templateAlert = (name, status) => ({ title: `Template ${name} ${TEMPLATE[status] ? TEMPLATE[status][0] : status}`, fix: TEMPLATE[status] ? TEMPLATE[status][1] : '' });

function translateLegacyTitle(title) {
  const m = /^Template (.+): (PAUSED|DISABLED|REJECTED)$/.exec(title || '');
  return m ? templateAlert(m[1], m[2]).title : title;
}

const QUALITY = {
  YELLOW: 'Qualidade média → Atenção: reduza o volume e evite listas frias por alguns dias.',
  RED: 'Qualidade baixa → Pause os disparos deste número, revise a lista e o texto do template.'
};

// Junta linhas sem repetir a mesma orientação (ex.: "Pendente" e "não registrado" pedem o mesmo código SMS).
function joinUnique(lines) {
  const out = []; let sms = false;
  for (const l of lines.join('\n').split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (/código SMS/.test(l)) { if (sms) continue; sms = true; }
    if (!out.includes(l)) out.push(l);
  }
  return out.join('\n');
}

module.exports = { joinUnique, healthDetail, translateLegacy, translateLegacyTitle, statusLine, statusPt, templateAlert, QUALITY };
