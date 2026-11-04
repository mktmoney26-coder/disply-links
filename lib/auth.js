// Confere a senha do painel (variável STATS_KEY na Vercel).
const crypto = require('crypto');

function isAuthorized(req) {
  const expected = process.env.STATS_KEY;
  if (!expected) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isAuthorized };
