// Consulta automática dos ativos.
// - Agendador da Vercel (1x por dia no plano gratuito): reconhecido pelo cabeçalho que ela envia.
// - Agendador externo (ex.: cron-job.org a cada 5 min): URL /api/ativos-cron?key=<chave mostrada em Configurações>.
// Só funciona no projeto principal (onde existe STATS_KEY).
const crypto = require('crypto');
const { getAssetsDb, runCheck, getSetting } = require('../lib/assets-monitor');

function same(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cronKey() {
  return process.env.CRON_SECRET || crypto.createHash('sha256').update('disply:cron:' + process.env.STATS_KEY).digest('hex').slice(0, 32);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.STATS_KEY) { res.status(404).end('Página não encontrada.'); return; }
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String((req.query || {}).key || '');
  const vercelCron = /^vercel-cron\//i.test(String(req.headers['user-agent'] || ''));
  if (!same(given, cronKey()) && !vercelCron) { res.status(401).end('Não autorizado.'); return; }
  try {
    const sql = await getAssetsDb();
    const last = await getSetting(sql, 'last_run');
    // Sem chave, só consulta se a última consulta tem mais de 5 minutos (evita abuso).
    if (last && Date.now() - new Date(last).getTime() < 4.5 * 60000) { res.status(200).json({ skipped: true }); return; }
    res.status(200).json(await runCheck(sql));
  } catch (err) {
    console.error('ativos-cron:', err);
    res.status(500).json({ erro: err.message });
  }
};

module.exports.cronKey = cronKey;
