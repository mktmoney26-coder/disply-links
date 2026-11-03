// Relatório de cliques, protegido pela senha definida em STATS_KEY.
const crypto = require('crypto');
const { getDb } = require('../lib/db');

function sameKey(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  const expected = process.env.STATS_KEY;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !sameKey(given, expected)) {
    res.status(401).json({ erro: 'Senha do painel inválida.' });
    return;
  }

  const sql = await getDb();
  if (!sql) {
    res.status(500).json({ erro: 'Banco de dados não conectado ao projeto.' });
    return;
  }

  const porLink = await sql`
    select slug,
           count(*)::int as cliques,
           count(distinct contact)::int as contatos_unicos,
           max(created_at) as ultimo_clique
    from clicks
    group by slug
    order by cliques desc`;

  let contatos = [];
  if (typeof req.query.slug === 'string' && req.query.slug) {
    contatos = await sql`
      select contact as contato,
             count(*)::int as cliques,
             min(created_at) as primeiro_clique
      from clicks
      where slug = ${req.query.slug} and contact is not null
      group by contact
      order by primeiro_clique desc
      limit 1000`;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ porLink, contatos });
};
