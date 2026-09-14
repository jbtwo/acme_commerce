import { sql, type Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function up(db: Kysely<any>): Promise<void> {
  // -- inventory_items -----------------------------------------------------
  // One per SKU. This is what variants.inventory_item_id — the column left deliberately null
  // in Milestone 1 — finally points at.
  await sql`
    create table inventory_items (
      id          text        primary key,
      sku         text        not null unique references variants (sku) on update cascade,
      tracked     boolean     not null default true,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now(),
      constraint inventory_items_id_format check (id ~ '^invitem_[0-9a-f]{24}$')
    )
  `.execute(db);
  await sql`
    create trigger inventory_items_set_updated_at before update on inventory_items
      for each row execute function set_updated_at()
  `.execute(db);

  await sql`
    alter table variants
      add constraint variants_inventory_item_fk
      foreign key (inventory_item_id) references inventory_items (id) on delete set null
  `.execute(db);

  // -- inventory_levels ----------------------------------------------------
  //
  // `available` is NOT stored. It is on_hand - reserved, computed at read time.
  //
  // Storing it would create a third number that can disagree with the other two, and the
  // first bug every inventory system gets is exactly that disagreement. The two columns that
  // ARE stored are guarded so they cannot describe an impossible world.
  await sql`
    create table inventory_levels (
      id                 text        primary key,
      inventory_item_id  text        not null references inventory_items (id) on delete cascade,
      location_id        text        not null references locations (id) on delete restrict,
      on_hand            integer     not null default 0,
      reserved           integer     not null default 0,
      created_at         timestamptz not null default now(),
      updated_at         timestamptz not null default now(),

      constraint inventory_levels_id_format   check (id ~ '^invlvl_[0-9a-f]{24}$'),
      constraint inventory_levels_on_hand_nonneg  check (on_hand >= 0),
      constraint inventory_levels_reserved_nonneg check (reserved >= 0),
      --
      constraint inventory_levels_not_oversold check (reserved <= on_hand),
      constraint inventory_levels_unique unique (inventory_item_id, location_id)
    )
  `.execute(db);
  await sql`create index inventory_levels_location_idx on inventory_levels (location_id)`.execute(
    db,
  );
  await sql`
    create trigger inventory_levels_set_updated_at before update on inventory_levels
      for each row execute function set_updated_at()
  `.execute(db);

  // -- inventory_adjustments ----------------------------------------------
  // Append-only audit log. Never updated, never deleted: the whole point of an audit log is
  // that it records what happened rather than what is currently believed.
  await sql`
    create table inventory_adjustments (
      id                 text        primary key,
      inventory_item_id  text        not null references inventory_items (id) on delete cascade,
      location_id        text        not null references locations (id) on delete restrict,
      quantity_delta     integer     not null,
      reason             text        not null,
      reference          text,
      actor              text        not null,
      created_at         timestamptz not null default now(),

      constraint inventory_adjustments_id_format check (id ~ '^invadj_[0-9a-f]{24}$'),
      constraint inventory_adjustments_delta_nonzero check (quantity_delta <> 0),
      constraint inventory_adjustments_reason_valid check (
        reason in ('received', 'sold', 'damaged', 'correction', 'transfer_in', 'transfer_out', 'return')
      ),
      constraint inventory_adjustments_reference_len check (reference is null or char_length(reference) <= 200)
    )
  `.execute(db);
  await sql`create index inventory_adjustments_item_idx on inventory_adjustments (inventory_item_id, created_at desc)`.execute(
    db,
  );
  await sql`create index inventory_adjustments_location_idx on inventory_adjustments (location_id)`.execute(
    db,
  );
  await sql`create index inventory_adjustments_created_idx on inventory_adjustments (created_at desc, id desc)`.execute(
    db,
  );

  // -- inventory_reservations ---------------------------------------------
  await sql`
    create table inventory_reservations (
      id                 text        primary key,
      inventory_item_id  text        not null references inventory_items (id) on delete cascade,
      location_id        text        not null references locations (id) on delete restrict,
      quantity           integer     not null,
      status             text        not null default 'active',
      reference          text,
      actor              text        not null,
      expires_at         timestamptz not null,
      released_at        timestamptz,
      created_at         timestamptz not null default now(),
      updated_at         timestamptz not null default now(),

      constraint inventory_reservations_id_format check (id ~ '^invres_[0-9a-f]{24}$'),
      constraint inventory_reservations_qty_positive check (quantity > 0),
      constraint inventory_reservations_status_valid check (status in ('active', 'released', 'expired')),
      constraint inventory_reservations_released_sync check (
        (status = 'active' and released_at is null) or (status <> 'active' and released_at is not null)
      )
    )
  `.execute(db);
  await sql`create index inventory_reservations_item_loc_idx on inventory_reservations (inventory_item_id, location_id, status)`.execute(
    db,
  );
  await sql`create index inventory_reservations_expiry_idx on inventory_reservations (status, expires_at)`.execute(
    db,
  );
  await sql`
    create trigger inventory_reservations_set_updated_at before update on inventory_reservations
      for each row execute function set_updated_at()
  `.execute(db);

  // -- pricing_rules -------------------------------------------------------
  await sql`
    create table pricing_rules (
      id                text        primary key,
      name              text        not null,
      type              text        not null,
      scope_kind        text        not null default 'all',
      scope_value       text,
      adjustment_kind   text        not null,
      adjustment_value  integer     not null,
      min_quantity      integer,
      customer_group    text,
      partner_id        text,
      priority          integer     not null default 100,
      starts_at         timestamptz,
      ends_at           timestamptz,
      is_active         boolean     not null default true,
      created_at        timestamptz not null default now(),
      updated_at        timestamptz not null default now(),

      constraint pricing_rules_id_format check (id ~ '^prule_[0-9a-f]{24}$'),
      constraint pricing_rules_type_valid check (type in ('sale', 'customer_group', 'quantity_break', 'partner')),
      constraint pricing_rules_scope_valid check (scope_kind in ('all', 'product_type', 'sku')),
      constraint pricing_rules_scope_value check (
        (scope_kind = 'all' and scope_value is null) or (scope_kind <> 'all' and scope_value is not null)
      ),
      constraint pricing_rules_adjustment_kind check (adjustment_kind in ('percentage', 'fixed_amount')),
      constraint pricing_rules_percentage_range check (
        adjustment_kind <> 'percentage' or (adjustment_value between -10000 and 10000)
      ),
      constraint pricing_rules_window check (starts_at is null or ends_at is null or starts_at < ends_at)
    )
  `.execute(db);
  await sql`create index pricing_rules_active_idx on pricing_rules (is_active, priority)`.execute(
    db,
  );
  await sql`
    create trigger pricing_rules_set_updated_at before update on pricing_rules
      for each row execute function set_updated_at()
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table variants drop constraint if exists variants_inventory_item_fk`.execute(db);
  await sql`drop table if exists pricing_rules`.execute(db);
  await sql`drop table if exists inventory_reservations`.execute(db);
  await sql`drop table if exists inventory_adjustments`.execute(db);
  await sql`drop table if exists inventory_levels`.execute(db);
  await sql`drop table if exists inventory_items`.execute(db);
}
