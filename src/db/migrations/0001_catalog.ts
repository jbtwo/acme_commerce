/**
 * Migration 0001 — Catalog: products and variants.
 *
 * Written as explicit SQL rather than generated from a schema diff. Every statement below is
 * one somebody chose.
 *
 * Objects are created unqualified and land in the application schema because the connection
 * pool pins `search_path` to it (see src/db/index.ts). That keeps migrations free of a
 * hard-coded schema name, so DB_SCHEMA remains genuinely configurable.
 *
 * Note the deliberate redundancy between the CHECK constraints here and the JSON Schema
 * validation in src/domain/catalog/schemas.ts. They are not the same mechanism doing the same
 * job twice. Request validation produces a good 400 for an HTTP caller. A database constraint
 * is the last line that holds when data arrives from a migration, a seed script, a psql
 * session, or a future endpoint whose author forgot a rule. The API can be bypassed; the
 * database cannot.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function up(db: Kysely<any>): Promise<void> {
  // -- Trigger function backing `updated_at` --------------------------------
  // `updated_at` is maintained by the database, not the application. If it were the
  // application's job, every future code path that forgets it would silently produce a row
  // whose updated_at is a lie — and `sort=updated_at` would quietly return wrong answers.
  await sql`
    create or replace function set_updated_at() returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$
  `.execute(db);

  // -- products -------------------------------------------------------------
  await sql`
    create table products (
      id            text        primary key,
      title         text        not null,
      description   text,
      status        text        not null default 'draft',
      vendor        text,
      product_type  text,
      tags          text[]      not null default '{}',
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now(),
      archived_at   timestamptz,

      constraint products_id_format      check (id ~ '^prod_[0-9a-f]{24}$'),
      constraint products_title_length   check (char_length(title) between 1 and 200),
      constraint products_desc_length    check (description is null or char_length(description) <= 5000),
      constraint products_status_valid   check (status in ('draft', 'active', 'archived')),
      constraint products_vendor_length  check (vendor is null or char_length(vendor) between 1 and 100),
      constraint products_type_length    check (product_type is null or char_length(product_type) between 1 and 100),
      constraint products_tags_count     check (coalesce(array_length(tags, 1), 0) <= 50),
      -- Keeps the archive flag and the archive timestamp from disagreeing. A product with
      -- status 'archived' and archived_at NULL is a row nobody can explain later.
      constraint products_archived_sync  check (
        (status = 'archived' and archived_at is not null) or
        (status <> 'archived' and archived_at is null)
      )
    )
  `.execute(db);

  await sql`
    create trigger products_set_updated_at
      before update on products
      for each row execute function set_updated_at()
  `.execute(db);

  // Indexes matching the documented filters. Each one exists because a documented query
  // parameter would otherwise force a sequential scan.
  await sql`create index products_status_idx on products (status)`.execute(db);
  // Functional index: the `vendor` filter is case-insensitive exact match, so the index has
  // to be on lower(vendor) or it will not be used.
  await sql`create index products_vendor_lower_idx on products (lower(vendor))`.execute(db);
  await sql`create index products_type_lower_idx on products (lower(product_type))`.execute(db);
  // GIN supports the array-containment operator used by the `tag` filter.
  await sql`create index products_tags_gin_idx on products using gin (tags)`.execute(db);
  // Matches the default sort exactly, including the unique tiebreaker, so the default listing
  // is an index scan with no sort step.
  await sql`create index products_created_at_id_idx on products (created_at desc, id desc)`.execute(
    db,
  );

  // -- variants -------------------------------------------------------------
  await sql`
    create table variants (
      id                      text        primary key,
      product_id              text        not null,
      sku                     text        not null,
      title                   text        not null,
      price_cents             integer     not null,
      compare_at_price_cents  integer,
      currency                text        not null default 'CAD',
      barcode                 text,
      inventory_item_id       text,
      status                  text        not null default 'active',
      position                integer     not null default 1,
      created_at              timestamptz not null default now(),
      updated_at              timestamptz not null default now(),
      archived_at             timestamptz,

      constraint variants_id_format    check (id ~ '^var_[0-9a-f]{24}$'),
      -- ON DELETE CASCADE: a variant cannot outlive its product. Note that the API never
      -- hard-deletes a product, so this fires only for a genuine DELETE run by an operator.
      constraint variants_product_fk   foreign key (product_id) references products (id) on delete cascade,
      -- THE uniqueness rule. Enforced here, in the database, and not by a SELECT-then-INSERT
      -- in the service layer: two concurrent requests can both pass a pre-check and both
      -- insert. A UNIQUE index cannot be raced. The service translates SQLSTATE 23505 into
      -- 409 SKU_ALREADY_EXISTS.
      constraint variants_sku_unique   unique (sku),
      constraint variants_sku_length   check (char_length(sku) between 1 and 64),
      constraint variants_title_length check (char_length(title) between 1 and 200),
      constraint variants_price_nonneg  check (price_cents >= 0),
      constraint variants_compare_nonneg check (compare_at_price_cents is null or compare_at_price_cents >= 0),
      constraint variants_currency_fmt check (currency ~ '^[A-Z]{3}$'),
      constraint variants_barcode_len  check (barcode is null or char_length(barcode) between 1 and 64),
      constraint variants_status_valid check (status in ('active', 'archived')),
      constraint variants_position_pos check (position >= 1),
      constraint variants_archived_sync check (
        (status = 'archived' and archived_at is not null) or
        (status <> 'archived' and archived_at is null)
      )
    )
  `.execute(db);

  await sql`
    create trigger variants_set_updated_at
      before update on variants
      for each row execute function set_updated_at()
  `.execute(db);

  // Supports GET /products/{id}/variants, in its documented order, without a sort step.
  await sql`create index variants_product_position_idx on variants (product_id, position, id)`.execute(
    db,
  );
  await sql`create index variants_status_idx on variants (status)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order. Triggers and indexes go with their tables; the function is shared, so it
  // is dropped last.
  await sql`drop table if exists variants`.execute(db);
  await sql`drop table if exists products`.execute(db);
  await sql`drop function if exists set_updated_at()`.execute(db);
}
