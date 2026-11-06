// Entrega a página de disparos só no projeto principal (onde existe STATS_KEY).
const fs = require('fs');
const path = require('path');
const { panelEnabled } = require('../lib/auth');

let html = null;

module.exports = (req, res) => {
  if (!panelEnabled()) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Página não encontrada.');
    return;
  }
  if (!html) html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'disparos.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(200).end(html);
};
