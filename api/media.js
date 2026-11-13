// Serve as imagens de cabeçalho enviadas pelo painel (a Meta busca por este link no disparo).
const { getDispatchDb } = require('../lib/dispatch-db');

module.exports = async (req, res) => {
  const id = String(req.query.file || '').replace(/\.(jpe?g|png|xlsx|csv)$/i, '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) { res.status(404).end(); return; }
  const sql = await getDispatchDb();
  const rows = sql ? await sql`select content_type, b64, filename from wa_media where id = ${id}` : [];
  if (!rows.length) { res.status(404).end(); return; }
  res.setHeader('Content-Type', rows[0].content_type);
  if (rows[0].filename) {
    const ext = rows[0].content_type === 'text/csv' ? 'csv' : 'xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].filename}.${ext}"`);
    res.setHeader('X-Robots-Tag', 'noindex');
  }
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.status(200).end(Buffer.from(rows[0].b64, 'base64'));
};
