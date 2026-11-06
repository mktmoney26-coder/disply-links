// Criptografa os tokens da Meta antes de guardar no banco (AES-256-GCM).
// A chave vem de ENCRYPTION_KEY ou, se não existir, da senha do painel (STATS_KEY).
// Atenção: se a chave mudar, os tokens salvos precisam ser cadastrados de novo.
const crypto = require('crypto');

function key() {
  const base = process.env.ENCRYPTION_KEY || process.env.STATS_KEY;
  if (!base) throw new Error('Configure STATS_KEY (ou ENCRYPTION_KEY) para guardar tokens.');
  return crypto.createHash('sha256').update('disply:tokens:' + base).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Token que a Meta usa para confirmar o webhook. Derivado da senha, sempre o mesmo.
function verifyToken() {
  if (process.env.WA_VERIFY_TOKEN) return process.env.WA_VERIFY_TOKEN;
  const base = process.env.STATS_KEY || '';
  return 'disply-' + crypto.createHash('sha256').update('disply:verify:' + base).digest('hex').slice(0, 24);
}

module.exports = { encrypt, decrypt, verifyToken };
