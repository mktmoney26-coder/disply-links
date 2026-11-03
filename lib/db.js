// Conexão com o banco (Neon/Postgres criado pela Vercel).
// A tabela de cliques é criada sozinha na primeira vez que o sistema roda.
const { neon } = require('@neondatabase/serverless');

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
    })().catch((err) => {
      ready = null; // tenta de novo na próxima requisição
      throw err;
    });
  }
  await ready;
  return sql;
}

module.exports = { getDb };
