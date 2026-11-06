// Tabelas do módulo de disparos. Criadas sozinhas na primeira vez (sem migração manual).
const { getDb } = require('./db');

let ready = null;

async function getDispatchDb() {
  const sql = await getDb();
  if (!sql) return null;
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists wa_instances (
        id serial primary key,
        name text not null,
        waba_id text not null,
        phone_number_id text not null unique,
        display_phone text,
        verified_name text,
        quality text,
        token_enc text not null,
        app_secret_enc text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`;
      await sql`create table if not exists wa_templates (
        id serial primary key,
        instance_id integer not null,
        name text not null,
        language text not null,
        category text,
        status text,
        components text,
        synced_at timestamptz not null default now(),
        unique (instance_id, name, language)
      )`;
      await sql`create table if not exists wa_lists (
        id serial primary key,
        name text not null,
        total integer not null default 0,
        created_at timestamptz not null default now()
      )`;
      await sql`create table if not exists wa_contacts (
        id bigserial primary key,
        list_id integer not null,
        name text,
        phone text not null,
        unique (list_id, phone)
      )`;
      await sql`create table if not exists wa_optouts (
        phone text primary key,
        instance_id integer,
        created_at timestamptz not null default now()
      )`;
      await sql`create table if not exists wa_operations (
        id serial primary key,
        name text not null,
        instance_id integer not null,
        template_id integer not null,
        header_type text,
        header_value text,
        body_vars text,
        button_param text,
        name_fallback text,
        list_id integer not null,
        quantity integer not null,
        tps integer not null default 40,
        status text not null default 'running',
        lock_until timestamptz,
        created_at timestamptz not null default now(),
        started_at timestamptz,
        finished_at timestamptz
      )`;
      await sql`create table if not exists wa_recipients (
        id bigserial primary key,
        operation_id integer not null,
        name text,
        phone text not null,
        status text not null default 'pending',
        wamid text,
        error text,
        sent_at timestamptz,
        updated_at timestamptz not null default now()
      )`;
      await sql`create index if not exists wa_recipients_op_idx on wa_recipients (operation_id, status)`;
      await sql`create index if not exists wa_recipients_wamid_idx on wa_recipients (wamid)`;
      await sql`create table if not exists wa_inbound (
        id bigserial primary key,
        instance_id integer,
        phone text,
        name text,
        text text,
        wamid text,
        created_at timestamptz not null default now()
      )`;
      await sql`create table if not exists wa_media (
        id text primary key,
        content_type text not null,
        b64 text not null,
        created_at timestamptz not null default now()
      )`;
    })().catch((err) => { ready = null; throw err; });
  }
  await ready;
  return sql;
}

module.exports = { getDispatchDb };
