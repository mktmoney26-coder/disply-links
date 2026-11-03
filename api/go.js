// Página de cada link: mostra a prévia no WhatsApp, registra o clique e redireciona.
// Todo visitante recebe exatamente a mesma página e vai para o mesmo destino.
const links = require('../links.json');
const { getDb } = require('../lib/db');

// Robôs que só buscam a prévia do link. Eles recebem a mesma página,
// apenas não contam como clique.
const PREVIEW_FETCHERS = /(WhatsApp|facebookexternalhit|Facebot|TelegramBot|Twitterbot|Slackbot|LinkedInBot|Discordbot|SkypeUriPreview|Googlebot|bingbot)/i;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = async (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase();
  const link = Object.prototype.hasOwnProperty.call(links, slug) ? links[slug] : null;

  if (!link || !/^https:\/\//.test(link.destination || '')) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Link não encontrado.');
    return;
  }

  const userAgent = String(req.headers['user-agent'] || '');
  const isPreview = PREVIEW_FETCHERS.test(userAgent);
  const contact = typeof req.query.c === 'string' ? req.query.c.slice(0, 64) : null;

  if (!isPreview) {
    try {
      const sql = await getDb();
      if (sql) {
        await sql`insert into clicks (slug, contact, country, user_agent)
          values (${slug}, ${contact}, ${req.headers['x-vercel-ip-country'] || null}, ${userAgent.slice(0, 300)})`;
      }
    } catch (err) {
      console.error('Erro ao registrar clique:', err);
    }
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `https://${host}`;
  const image = /^https?:\/\//.test(link.image) ? link.image : base + link.image;
  const dest = link.destination;

  // Título e descrição são opcionais: sem eles, a prévia mostra só a imagem e o domínio.
  // "title" preenche os dois; "htmlTitle" e "ogTitle" permitem controlar cada um separadamente.
  const htmlTitle = link.htmlTitle ?? link.title;
  const ogTitle = link.ogTitle ?? link.title;
  const textTags = [
    htmlTitle ? `<title>${esc(htmlTitle)}</title>` : '',
    ogTitle ? `<meta property="og:title" content="${esc(ogTitle)}">` : '',
    link.description ? `<meta name="description" content="${esc(link.description)}">` : '',
    link.description ? `<meta property="og:description" content="${esc(link.description)}">` : ''
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${textTags}
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base + '/' + slug)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${esc(dest)}">
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;text-align:center}a{color:#0F6E5C;font-weight:700}</style>
</head>
<body>
<p>Abrindo… <a href="${esc(dest)}">toque aqui se não abrir</a>.</p>
<script>location.replace(${JSON.stringify(dest)});</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(html);
};
