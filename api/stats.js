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

  // ?detalhe=1: raio-x dos cliques (dia, hora, país, tipo de aparelho, robôs e picos por minuto).
  if (slug && String(req.query.detalhe) === '1') {
    const tz = 'America/Sao_Paulo';
    const [total] = await sql`select count(*)::int as cliques, min(created_at) as primeiro, max(created_at) as ultimo,
      count(distinct user_agent)::int as uas_distintos from clicks where slug = ${slug}`;
    const porDia = await sql`select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as dia, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 1`;
    const porHora = await sql`select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD HH24') as hora, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 1`;
    const porPais = await sql`select coalesce(country, '?') as pais, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 2 desc`;
    const porTipo = await sql`select case
        when coalesce(user_agent, '') = '' then 'sem identificação (UA vazio)'
        when user_agent ~* '(bot|crawl|spider|curl|wget|python|httpclient|http-client|go-http|okhttp|java/|axios|node-fetch|headless|phantom|selenium|puppeteer|playwright|scan|preview|monitor|check|lighthouse|meta-external|facebookexternal)' then 'robô / automação'
        when user_agent ~* '(iphone|ipad|ipod)' then 'iPhone/iPad'
        when user_agent ~* 'android' then 'Android'
        when user_agent ~* '(windows|macintosh|x11|linux x86)' then 'computador'
        else 'outro' end as tipo, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 2 desc`;
    const apps = await sql`select case
        when user_agent ~* 'instagram' then 'Instagram'
        when user_agent ~* '(fban|fbav|fb_iab)' then 'Facebook'
        when user_agent ~* 'wv\\)' then 'navegador interno de app (Android)'
        when user_agent ~* 'samsungbrowser' then 'Samsung Internet'
        when user_agent ~* 'crios|chrome' then 'Chrome'
        when user_agent ~* 'safari' then 'Safari'
        else 'outro' end as app, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 2 desc`;
    const topUas = await sql`select user_agent, count(*)::int as n
      from clicks where slug = ${slug} group by 1 order by 2 desc limit 25`;
    const picos = await sql`select to_char(date_trunc('minute', created_at) at time zone ${tz}, 'YYYY-MM-DD HH24:MI') as minuto,
        count(*)::int as n, count(distinct user_agent)::int as uas
      from clicks where slug = ${slug} group by 1 order by 2 desc limit 20`;
    const rajadas = await sql`select count(*)::int as n from (
        select id, created_at - lag(created_at) over (partition by user_agent order by created_at) as gap
        from clicks where slug = ${slug}) t where gap < interval '2 seconds'`;
    res.status(200).json({ slug, total, porDia, porHora, porPais, porTipo, apps, topUas, picos,
      repetidosMesmoAparelhoEm2s: rajadas[0].n });
    return;
  }

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
