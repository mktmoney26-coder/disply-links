// Entrega a imagem de prévia de um link criado pelo painel, só no domínio do próprio link.
const { getDb, requestHost } = require('../lib/db');

module.exports = async (req, res) => {
  const slug = String(req.query.file || '').replace(/\.(jpe?g|png|webp)$/i, '').toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
    res.status(404).end();
    return;
  }

  const sql = await getDb();
  const rows = sql
    ? await sql`select image_b64, image_type from links
        where slug = ${slug} and host = ${requestHost(req)} and active and image_b64 is not null`
    : [];
  if (!rows.length) {
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', rows[0].image_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).end(Buffer.from(rows[0].image_b64, 'base64'));
};
