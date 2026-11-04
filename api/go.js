// Página de cada link: mostra a prévia no WhatsApp, registra o clique e redireciona.
// Todo visitante recebe exatamente a mesma página e vai para o mesmo destino.
const links = require('../links.json');
const { getDb, requestHost, PRIMARY_HOST } = require('../lib/db');

// Robôs que só buscam a prévia do link. Eles recebem a mesma página,
// apenas não contam como clique.
const PREVIEW_FETCHERS = /(WhatsApp|facebookexternalhit|Facebot|TelegramBot|Twitterbot|Slackbot|LinkedInBot|Discordbot|SkypeUriPreview|Googlebot|bingbot)/i;

// Título invisível: no teste, foi o formato que mostrou só a imagem e o domínio.
const INVISIBLE_TITLE = '‎';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notFound(res) {
  res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Link não encontrado.');
}

module.exports = async (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return notFound(res);

  let sql = null;
  try {
    sql = await getDb();
  } catch (err) {
    console.error('Erro ao conectar no banco:', err);
  }

  const host = requestHost(req);

  // 1) Links criados pelo painel (banco de dados), só no domínio ao qual o link pertence
  let link = null;
  if (sql) {
    try {
      const rows = await sql`
        select destination, active, updated_at, (image_b64 is not null) as has_image
        from links where slug = ${slug} and host = ${host}`;
      if (rows.length) {
        if (!rows[0].active) return notFound(res);
        const version = new Date(rows[0].updated_at).getTime();
        link = {
          title: INVISIBLE_TITLE,
          destination: rows[0].destination,
          image: rows[0].has_image ? `/i/${slug}.jpg?v=${version}` : null
        };
      }
    } catch (err) {
      console.error('Erro ao buscar link:', err);
    }
  }

  // 2) Links antigos do arquivo links.json, só no domínio principal
  if (!link && host === PRIMARY_HOST && Object.prototype.hasOwnProperty.call(links, slug)) link = links[slug];

  if (!link || !/^https:\/\//.test(link.destination || '')) return notFound(res);

  const userAgent = String(req.headers['user-agent'] || '');
  const isPreview = PREVIEW_FETCHERS.test(userAgent);
  const contact = typeof req.query.c === 'string' ? req.query.c.slice(0, 64) : null;

  if (!isPreview && sql) {
    try {
      await sql`insert into clicks (slug, contact, country, user_agent)
        values (${slug}, ${contact}, ${req.headers['x-vercel-ip-country'] || null}, ${userAgent.slice(0, 300)})`;
    } catch (err) {
      console.error('Erro ao registrar clique:', err);
    }
  }

  const base = `https://${host}`;
  const dest = link.destination;

  // Título e descrição são opcionais: sem eles, a prévia mostra só a imagem e o domínio.
  // "title" preenche os dois; "htmlTitle" e "ogTitle" permitem controlar cada um separadamente.
  const htmlTitle = link.htmlTitle ?? link.title;
  const ogTitle = link.ogTitle ?? link.title;
  const image = link.image ? (/^https?:\/\//.test(link.image) ? link.image : base + link.image) : null;

  // Sem imagem = sem prévia: a página não manda nenhuma informação para o WhatsApp montar o cartão.
  const headTags = !image ? '' : [
    htmlTitle ? `<title>${esc(htmlTitle)}</title>` : '',
    ogTitle ? `<meta property="og:title" content="${esc(ogTitle)}">` : '',
    link.description ? `<meta name="description" content="${esc(link.description)}">` : '',
    link.description ? `<meta property="og:description" content="${esc(link.description)}">` : '',
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    image ? '<meta property="og:image:width" content="1200">' : '',
    image ? '<meta property="og:image:height" content="630">' : '',
    image ? '<meta name="twitter:card" content="summary_large_image">' : ''
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${headTags}${image ? `
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base + '/' + slug)}">` : ''}
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
