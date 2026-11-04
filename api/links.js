// API do painel: listar, criar e editar links. Protegida pela senha do painel.
const crypto = require('crypto');
const { getDb } = require('../lib/db');
const { isAuthorized } = require('../lib/auth');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem letras/números que se confundem
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function newSlug(size = 6) {
  const bytes = crypto.randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function checkDestination(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseImage(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES.includes(m[1])) return { erro: 'Imagem inválida. Use JPG, PNG ou WebP.' };
  const bytes = Buffer.byteLength(m[2], 'base64');
  if (bytes > MAX_IMAGE_BYTES) return { erro: 'Imagem muito grande (máximo 1,5 MB).' };
  return { type: m[1], b64: m[2] };
}

function cleanLabel(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!isAuthorized(req)) {
    res.status(401).json({ erro: 'Senha do painel inválida.' });
    return;
  }

  const sql = await getDb();
  if (!sql) {
    res.status(500).json({ erro: 'Banco de dados não conectado ao projeto.' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (req.method === 'GET') {
    const rows = await sql`
      select l.slug, l.label, l.destination, l.active, l.created_at, l.updated_at,
             (l.image_b64 is not null) as has_image,
             coalesce(c.cliques, 0)::int as cliques,
             c.ultimo_clique
      from links l
      left join (
        select slug, count(*) as cliques, max(created_at) as ultimo_clique
        from clicks group by slug
      ) c on c.slug = l.slug
      order by l.created_at desc`;
    res.status(200).json({ links: rows });
    return;
  }

  if (req.method === 'POST') {
    const destination = checkDestination(body.destination);
    if (!destination) {
      res.status(400).json({ erro: 'URL de destino inválida. Ela precisa começar com https://' });
      return;
    }
    let image = null;
    if (body.image) {
      image = parseImage(body.image);
      if (image.erro) { res.status(400).json(image); return; }
    }
    const label = cleanLabel(body.label);

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = newSlug();
      const rows = await sql`
        insert into links (slug, label, destination, image_b64, image_type)
        values (${slug}, ${label}, ${destination}, ${image ? image.b64 : null}, ${image ? image.type : null})
        on conflict (slug) do nothing
        returning slug`;
      if (rows.length) {
        res.status(201).json({ slug });
        return;
      }
    }
    res.status(500).json({ erro: 'Não foi possível gerar um link novo. Tente de novo.' });
    return;
  }

  if (req.method === 'PATCH') {
    const slug = typeof body.slug === 'string' ? body.slug : '';
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
      res.status(400).json({ erro: 'Link inválido.' });
      return;
    }

    let destination = null;
    if (body.destination !== undefined) {
      destination = checkDestination(body.destination);
      if (!destination) {
        res.status(400).json({ erro: 'URL de destino inválida. Ela precisa começar com https://' });
        return;
      }
    }
    let image = null;
    if (body.image) {
      image = parseImage(body.image);
      if (image.erro) { res.status(400).json(image); return; }
    }
    const label = body.label !== undefined ? cleanLabel(body.label) : null;
    const active = typeof body.active === 'boolean' ? body.active : null;
    const removeImage = body.removeImage === true;

    const rows = await sql`
      update links set
        destination = coalesce(${destination}::text, destination),
        label       = coalesce(${label}::text, label),
        active      = coalesce(${active}::boolean, active),
        image_b64   = case when ${removeImage}::boolean then null
                           when ${image ? image.b64 : null}::text is not null then ${image ? image.b64 : null}::text
                           else image_b64 end,
        image_type  = case when ${removeImage}::boolean then null
                           when ${image ? image.type : null}::text is not null then ${image ? image.type : null}::text
                           else image_type end,
        updated_at  = now()
      where slug = ${slug}
      returning slug`;
    if (!rows.length) {
      res.status(404).json({ erro: 'Link não encontrado.' });
      return;
    }
    res.status(200).json({ slug });
    return;
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  res.status(405).json({ erro: 'Método não permitido.' });
};
