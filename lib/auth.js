// Confere a senha do painel (variável STATS_KEY).
// Só o projeto principal tem STATS_KEY; nos projetos das BMs o painel e a API ficam desligados.
const crypto = require('crypto');

function panelEnabled() {
  return Boolean(process.env.STATS_KEY);
}

function isAuthorized(req) {
  const expected = process.env.STATS_KEY;
  if (!expected) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Responde 404 (como se não existisse) quando o painel está desligado, ou 401 sem senha.
function guard(req, res) {
  if (!panelEnabled()) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Página não encontrada.');
    return false;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ erro: 'Senha do painel inválida.' });
    return false;
  }
  return true;
}

module.exports = { panelEnabled, isAuthorized, guard };
