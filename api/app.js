// Sistema central da Disply (/app). Só existe no projeto principal (onde há STATS_KEY).
// Endereços antigos (/painel e /disparos) e a raiz levam para a tela certa do /app.
const fs = require('fs');
const path = require('path');
const { panelEnabled } = require('../lib/auth');

let html = null;
const TARGETS = { links: '/app#links', disparos: '/app#ops', home: '/app' };

const relatorio = require('../lib/relatorio');
const privacidade = require('../lib/privacidade');

module.exports = (req, res) => {
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
