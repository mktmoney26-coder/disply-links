// Cria automaticamente o domínio de uma BM (nome.vercel.app) no projeto principal e cadastra no sistema.
// Só funciona no projeto principal (STATS_KEY) e precisa da variável VERCEL_TOKEN.
//
//   GET  /api/bms                          -> { enabled } (a automação está configurada?)
//   POST /api/bms { name, label }          -> adiciona nome.vercel.app ao projeto e cadastra o domínio
//   GET  /api/bms?projectId=&deploymentId= -> acompanha o deploy; quando pronto, cadastra o domínio
const { getDb } = require('../lib/db');
const { guard } = require('../lib/auth');

const API = 'https://api.vercel.com';
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function config() {
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  return {
    token: process.env.VERCEL_TOKEN,
    team: process.env.VERCEL_TEAM_SLUG || 'mkt-money',
    repo: process.env.VERCEL_REPO || (owner && slug ? `${owner}/${slug}` : 'mktmoney26-coder/disply-links'),
    branch: process.env.VERCEL_GIT_COMMIT_REF || 'main',
    dbUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL
  };
}

async function vercel(cfg, path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${path}${sep}slug=${encodeURIComponent(cfg.team)}`, {
    ...options,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (data.error && data.error.message) || `Erro ${r.status} na Vercel`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  const cfg = config();
  const enabled = Boolean(cfg.token && cfg.dbUrl);

  try {
    // ---------- Status de um projeto em criação ----------
    if (req.method === 'GET' && req.query.projectId) {
      if (!enabled) { res.status(400).json({ erro: 'Automação não configurada.' }); return; }
      const projectId = String(req.query.projectId);
      const deploymentId = String(req.query.deploymentId || '');
      if (!ID_RE.test(projectId) || !ID_RE.test(deploymentId)) {
        res.status(400).json({ erro: 'Projeto inválido.' });
        return;
      }

      const dep = await vercel(cfg, `/v13/deployments/${encodeURIComponent(deploymentId)}`);
      const state = dep.readyState || dep.status || 'QUEUED';
      if (state === 'ERROR' || state === 'CANCELED') {
        res.status(200).json({ state, erro: 'O deploy falhou. Veja os detalhes em Deployments na Vercel.' });
        return;
      }
      if (state !== 'READY') {
        res.status(200).json({ state });
        return;
      }

      const d = await vercel(cfg, `/v9/projects/${encodeURIComponent(projectId)}/domains`);
      const host = ((d.domains || [])
        .map((x) => String(x.name || '').toLowerCase())
        .find((n) => n.endsWith('.vercel.app') && !n.includes('-git-'))) || '';
      if (!host) {
        res.status(200).json({ state: 'BUILDING' }); // domínio ainda sendo atribuído
        return;
      }

      const label = typeof req.query.label === 'string' ? req.query.label.trim().slice(0, 80) : null;
      const sql = await getDb();
      await sql`insert into domains (host, label) values (${host}, ${label})
        on conflict (host) do update set label = coalesce(excluded.label, domains.label)`;
      res.status(200).json({ state: 'READY', host });
      return;
    }

    // ---------- A automação está configurada? ----------
    if (req.method === 'GET') {
      res.status(200).json({ enabled });
      return;
    }

    // ---------- Criar projeto de uma BM ----------
    if (req.method === 'POST') {
      if (!enabled) {
        res.status(400).json({ erro: 'Automação não configurada: crie a variável VERCEL_TOKEN no projeto principal.' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = String(body.name || '').trim().toLowerCase();
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';

      if (!NAME_RE.test(name)) {
        res.status(400).json({ erro: 'Nome inválido. Use de 3 a 50 letras minúsculas, números e hífen (ex.: sorridi-ofertas).' });
        return;
      }
      if (name.includes('disply')) {
        res.status(400).json({ erro: 'Não use "disply" no nome: o domínio da BM não deve ser ligado à Disply.' });
        return;
      }

      // O domínio novo (nome.vercel.app) entra no projeto principal: não cria projeto nem publica nada,
      // então fica pronto na hora e não gasta o limite diário de publicações da Vercel.
      const host = `${name}.vercel.app`;
      const projectId = process.env.VERCEL_PROJECT_ID || 'disply-links';
      try {
        await vercel(cfg, `/v10/projects/${encodeURIComponent(projectId)}/domains`, { method: 'POST', body: JSON.stringify({ name: host }) });
      } catch (err) {
        if (err.status === 409 || /in use|already|taken|not available/i.test(err.message)) {
          res.status(400).json({ erro: `O endereço ${host} já está em uso na Vercel. Escolha outro nome.` });
          return;
        }
        throw err;
      }
      const sql = await getDb();
      await sql`insert into domains (host, label) values (${host}, ${label || null})
        on conflict (host) do update set label = coalesce(excluded.label, domains.label)`;
      res.status(201).json({ state: 'READY', host, name, label });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ erro: 'Método não permitido.' });
  } catch (err) {
    console.error('Erro na automação de BM:', err.message);
    const msg = err.status === 409 ? 'Esse nome já está em uso na Vercel. Escolha outro.'
      : err.status === 403 || err.status === 401 ? 'O VERCEL_TOKEN não tem permissão. Confira o token e o escopo do time.'
      : err.message;
    res.status(err.status && err.status < 500 ? 400 : 500).json({ erro: msg });
  }
};
