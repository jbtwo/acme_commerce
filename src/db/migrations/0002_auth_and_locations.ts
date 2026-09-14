import { sql, type Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function up(db: Kysely<any>): Promise<void> {
  // -- users ---------------------------------------------------------------
  // Development identities only. No registration, no password reset, no email
  // verification — see docs/MILESTONE_2_PLAN.md §2.1 for what this deliberately is not.
  await sql`
    create table users (
      id            text        primary key,
      email         text        not null,
      name          text        not null,
      -- scrypt$N$r$p$salt$hash. Parameters travel with the hash so N can be raised later
      -- without invalidating existing rows.
      password_hash text        not null,
      role          text        not null,
      is_active     boolean     not null default true,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now(),

      constraint users_id_format    check (id ~ '^usr_[0-9a-f]{24}$'),
      -- Case-insensitive uniqueness: Dev@acme.example and dev@acme.example are one account.
      constraint users_email_length check (char_length(email) between 3 and 320),
      constraint users_name_length  check (char_length(name) between 1 and 200),
      constraint users_role_valid   check (role in ('developer', 'support', 'admin')),
      constraint users_hash_format  check (password_hash like 'scrypt$%')
    )
  `.execute(db);
  await sql`create unique index users_email_lower_idx on users (lower(email))`.execute(db);
  await sql`
    create trigger users_set_updated_at before update on users
      for each row execute function set_updated_at()
  `.execute(db);

  // -- locations -----------------------------------------------------------
  await sql`
    create table locations (
      id             text        primary key,
      name           text        not null,
      type           text        not null,
      address_line1  text,
      address_line2  text,
      city           text,
      region         text,
      postal_code    text,
      country        text,
      is_active      boolean     not null default true,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now(),

      constraint locations_id_format   check (id ~ '^loc_[0-9a-f]{24}$'),
      constraint locations_name_length check (char_length(name) between 1 and 100),
      -- 'virtual' covers dropship and in-transit stock. Included now because widening an
      -- enum later is a breaking change for any client switching on it.
      constraint locations_type_valid  check (type in ('warehouse', 'retail', 'virtual')),
      constraint locations_country_fmt check (country is null or country ~ '^[A-Z]{2}$')
    )
  `.execute(db);
  await sql`create unique index locations_name_lower_idx on locations (lower(name))`.execute(db);
  await sql`create index locations_type_idx on locations (type)`.execute(db);
  await sql`create index locations_active_idx on locations (is_active)`.execute(db);
  await sql`
    create trigger locations_set_updated_at before update on locations
      for each row execute function set_updated_at()
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table if exists locations`.execute(db);
  await sql`drop table if exists users`.execute(db);
}
