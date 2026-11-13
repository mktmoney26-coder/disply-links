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
      await sql`create index if not exists wa_recipients_sent_idx on wa_recipients (sent_at)`;
      await sql`alter table wa_lists add column if not exists check_summary text`;
      await sql`alter table wa_operations add column if not exists group_id integer`;
      await sql`alter table wa_operations add column if not exists tag text`;
      await sql`create table if not exists wa_inbound (
        id bigserial primary key,
        instance_id integer,
        phone text,
        name text,
        text text,
        wamid text,
        created_at timestamptz not null default now()
      )`;
      await sql`alter table wa_inbound add column if not exists msg_type text`;
      await sql`alter table wa_inbound add column if not exists is_read boolean not null default false`;
      await sql`alter table wa_inbound add column if not exists media_id text`;
      await sql`alter table wa_inbound add column if not exists media_mime text`;
      await sql`alter table wa_instances add column if not exists webhook_at timestamptz`;
      await sql`create index if not exists wa_inbound_conv_idx on wa_inbound (instance_id, phone, created_at)`;
      // Respostas enviadas pelo Inbox (mensagens livres dentro da janela de 24h)
      await sql`create table if not exists wa_outbound (
        id bigserial primary key,
        instance_id integer not null,
        phone text not null,
        text text not null,
        wamid text,
        status text not null default 'sent',
        error text,
        created_at timestamptz not null default now()
      )`;
      await sql`create index if not exists wa_outbound_wamid_idx on wa_outbound (wamid)`;
      await sql`create table if not exists wa_media (
        id text primary key,
        content_type text not null,
        b64 text not null,
        created_at timestamptz not null default now()
      )`;
      await sql`alter table wa_media add column if not exists filename text`;
      // Correção única: quem respondeu a um disparo leu a mensagem (vale para os envios anteriores a essa regra).
      await sql`create table if not exists wa_flags (k text primary key, at timestamptz not null default now())`;
      const done = await sql`insert into wa_flags (k) values ('lida_por_resposta_v1') on conflict (k) do nothing returning k`;
      if (done.length) {
        await sql`update wa_recipients set status = 'read', updated_at = now()
          where status in ('sent','delivered') and id in (
            select r.id from wa_recipients r join wa_operations o on o.id = r.operation_id
            join wa_inbound i on i.instance_id = o.instance_id and i.phone = r.phone and i.created_at >= r.sent_at
            where r.status in ('sent','delivered'))`;
      }
    })().catch((err) => { ready = null; throw err; });
  }
  await ready;
  return sql;
}

module.exports = { getDispatchDb };
