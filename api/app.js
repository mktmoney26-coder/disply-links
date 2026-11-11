// Sistema central da Disply (/app). Só existe no projeto principal (onde há STATS_KEY).
// Endereços antigos (/painel e /disparos) e a raiz levam para a tela certa do /app.
const fs = require('fs');
const path = require('path');
const { panelEnabled } = require('../lib/auth');
const { getRawDb, requestHost, PRIMARY_HOST } = require('../lib/db');

let html = null;
const TARGETS = { links: '/app#links', disparos: '/app#ops', home: '/app' };

const relatorio = require('../lib/relatorio');
const privacidade = require('../lib/privacidade');

// Domínios das BMs (links) apontam para este mesmo projeto: neles o sistema não existe (404),
// para o domínio da BM não ficar ligado à Disply.
let bmHosts = { at: 0, set: new Set() };
async function isBmHost(host) {
  if (!host || host === PRIMARY_HOST) return false;
  if (Date.now() - bmHosts.at > 60000) {
    try {
      const sql = getRawDb();
      if (sql) bmHosts = { at: Date.now(), set: new Set((await sql`select host from domains`).map((r) => r.host).filter((h) => h !== PRIMARY_HOST)) };
    } catch (e) { /* sem banco: segue */ }
  }
  return bmHosts.set.has(host);
}

module.exports = async (req, res) => {
  if (await isBmHost(requestHost(req))) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Página não encontrada.');
    return;
  }
  const page = String((req.query || {}).page || '');
  if (page === 'relatorio') return relatorio(req, res);
  if (page === 'privacidade') return privacidade(req, res);
  if (!panelEnabled()) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Página não encontrada.');
    return;
  }
  const to = String((req.query || {}).to || '');
  if (TARGETS[to]) { res.statusCode = 302; res.setHeader('Location', TARGETS[to]); res.end(); return; }
  if (!html) html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'app.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(200).end(html);
};
