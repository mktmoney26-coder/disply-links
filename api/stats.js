// Relatório de cliques por contato de um link, protegido pela senha do painel.
const { getDb } = require('../lib/db');
const { guard } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  const sql = await getDb();
  if (!sql) {
    res.status(500).json({ erro: 'Banco de dados não conectado ao projeto.' });
    return;
  }

  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  const contatos = slug
    ? await sql`
        select contact as contato,
               count(*)::int as cliques,
               min(created_at) as primeiro_clique
        from clicks
        where slug = ${slug} and contact is not null
        group by contact
        order by primeiro_clique desc
        limit 1000`
    : [];

  const totais = slug
    ? await sql`select count(*)::int as cliques from clicks where slug = ${slug}`
    : [{ cliques: 0 }];

  res.status(200).json({ cliques: totais[0].cliques, contatos });
};
