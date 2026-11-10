// Conexão com o banco (Neon/Postgres). O mesmo banco é conectado a todos os projetos.
// As tabelas são criadas e atualizadas sozinhas na primeira vez que o sistema roda.
const { neon } = require('@neondatabase/serverless');

// Domínio do projeto principal (onde fica o painel e os links antigos).
const PRIMARY_HOST = (process.env.PRIMARY_HOST || 'disply-links.vercel.app').toLowerCase();

let sql = null;
let ready = null;

async function getDb() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!sql) sql = neon(url);
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists clicks (
        id bigserial primary key,
        slug text not null,
        contact text,
        country text,
        user_agent text,
        created_at timestamptz not null default now()
      )`;
      await sql`create index if not exists clicks_slug_idx on clicks (slug, created_at)`;
      await sql`create table if not exists links (
        slug text primary key,
        label text,
        destination text not null,
        image_b64 text,
        image_type text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`;
      await sql`alter table links add column if not exists host text`;
      await sql`create table if not exists domains (
        host text primary key,
        label text,
        created_at timestamptz not null default now()
      )`;
      await sql`insert into domains (host, label) values (${PRIMARY_HOST}, 'Principal (testes)') on conflict (host) do nothing`;
      await sql`update links set host = ${PRIMARY_HOST} where host is null`;
    })().catch((err) => {
      ready = null; // tenta de novo na próxima requisição
      throw err;
    });
  }
  await ready;
  return sql;
}

// Conexão direta, sem a checagem de tabelas (para o redirecionamento ficar o mais rápido possível).
function getRawDb() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!sql) sql = neon(url);
  return sql;
}

// Domínio que o visitante acessou, em minúsculas e sem porta.
function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

module.exports = { getDb, getRawDb, requestHost, PRIMARY_HOST };
