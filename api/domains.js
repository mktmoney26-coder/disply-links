// API do painel: listar e cadastrar os domínios (um por BM).
const { getDb } = require('../lib/db');
const { guard } = require('../lib/auth');

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  const sql = await getDb();
  if (!sql) {
    res.status(500).json({ erro: 'Banco de dados não conectado ao projeto.' });
    return;
  }

  if (req.method === 'GET') {
    const rows = await sql`
      select d.host, d.label, d.created_at, count(l.slug)::int as links
      from domains d
      left join links l on l.host = d.host
      group by d.host, d.label, d.created_at
      order by d.created_at`;
    res.status(200).json({ domains: rows });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const host = String(body.host || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : null;

  if (req.method === 'POST') {
    if (!HOST_RE.test(host)) {
      res.status(400).json({ erro: 'Domínio inválido. Exemplo: aurora-ofertas.vercel.app' });
      return;
    }
    const rows = await sql`
      insert into domains (host, label) values (${host}, ${label})
      on conflict (host) do update set label = coalesce(excluded.label, domains.label)
      returning host`;
    res.status(201).json({ host: rows[0].host });
    return;
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ erro: 'Método não permitido.' });
};
