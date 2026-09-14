/**
 * Seed loader.
 *
 * Two properties, both deliberate:
 *
 * **Idempotent.** Running it twice leaves the same state as running it once. It upserts on the
 * primary key rather than inserting, so a half-finished run can simply be re-run.
 *
 * **Non-destructive.** It never deletes. If you created a product by hand at a Postman
 * checkpoint, seeding again will not remove it. Getting back to a pristine catalog is the job
 * of `npm run db:reset`, which is explicitly destructive and gated. A seed command that
 * quietly wipes your work is a seed command you learn to fear.
 */
import { createHash } from 'node:crypto';
import type { AppDatabase } from '../index.js';
import { SEED_EXPECTED, SEED_PRODUCTS } from './data.js';
import { SEED_AUTH_EXPECTED, SEED_LOCATIONS, SEED_USERS } from './auth-data.js';
import { SEED_INVENTORY, SEED_INVENTORY_EXPECTED, SEED_PRICING_RULES } from './inventory-data.js';
import { hashPassword } from '../../domain/auth/passwords.js';

/**
 * Derive a stable identifier from a natural key.
 *
 * SHA-256 truncated to 24 hex characters. This gives up the timestamp prefix that
 * `generateId()` embeds — a deliberate tradeoff, because determinism is worth more here than
 * sortable-by-id. Ordering of seed data comes from the explicit `created_at` values instead.
 */
export function deterministicId(prefix: string, naturalKey: string): string {
  const hex = createHash('sha256').update(`acme-commerce:${prefix}:${naturalKey}`).digest('hex');
  return `${prefix}_${hex.slice(0, 24)}`;
}

export interface SeedSummary {
  products: number;
  variants: number;
  productsInserted: number;
  variantsInserted: number;
  users: number;
  locations: number;
  inventoryLevels: number;
  pricingRules: number;
}

/** Archived seed records need a consistent archived_at — the schema CHECK requires it. */
function archivedAt(createdAt: string): Date {
  return new Date(new Date(createdAt).getTime() + 30 * 24 * 60 * 60 * 1000);
}

export async function seedDatabase(db: AppDatabase): Promise<SeedSummary> {
  let productsInserted = 0;
  let variantsInserted = 0;

  // One transaction for the whole load. A partial catalog — products present, variants missing
  // — is worse than no catalog, because it looks like it worked.
  await db.transaction().execute(async (trx) => {
    for (const p of SEED_PRODUCTS) {
      const id = deterministicId('prod', p.handle);
      const isArchived = p.status === 'archived';

      const inserted = await trx
        .insertInto('products')
        .values({
          id,
          title: p.title,
          description: p.description,
          status: p.status,
          vendor: p.vendor,
          product_type: p.product_type,
          tags: p.tags,
          created_at: new Date(p.created_at),
          archived_at: isArchived ? archivedAt(p.created_at) : null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: p.title,
            description: p.description,
            status: p.status,
            vendor: p.vendor,
            product_type: p.product_type,
            tags: p.tags,
            archived_at: isArchived ? archivedAt(p.created_at) : null,
          }),
        )
        .returning('id')
        .executeTakeFirst();
      if (inserted) productsInserted += 1;

      for (const v of p.variants) {
        const variantRow = await trx
          .insertInto('variants')
          .values({
            id: deterministicId('var', v.sku),
            product_id: id,
            sku: v.sku,
            title: v.title,
            price_cents: v.price_cents,
            compare_at_price_cents: v.compare_at_price_cents ?? null,
            currency: 'CAD',
            barcode: v.barcode ?? null,
            // Left null on purpose: the Inventory API in Milestone 2 populates it. A visible
            // unpopulated seam is more honest than pretending the catalog stands alone.
            inventory_item_id: null,
            // A variant of an archived product is itself archived. Modelling this here rather
            // than deriving it at read time keeps `status` meaningful on a variant fetched
            // directly by id, without a join back to the product.
            status: isArchived ? 'archived' : 'active',
            archived_at: isArchived ? archivedAt(p.created_at) : null,
            position: v.position,
            created_at: new Date(p.created_at),
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              product_id: id,
              sku: v.sku,
              title: v.title,
              price_cents: v.price_cents,
              compare_at_price_cents: v.compare_at_price_cents ?? null,
              barcode: v.barcode ?? null,
              status: isArchived ? 'archived' : 'active',
              archived_at: isArchived ? archivedAt(p.created_at) : null,
              position: v.position,
            }),
          )
          .returning('id')
          .executeTakeFirst();
        if (variantRow) variantsInserted += 1;
      }
    }
  });

  // Guards against this file and data.ts drifting apart: if the loader silently skipped rows,
  // the counts disagree and the command fails loudly instead of leaving a short catalog that
  // makes later tests fail for reasons nobody can trace back to here.
  if (productsInserted !== SEED_EXPECTED.products) {
    throw new Error(
      `Seed wrote ${productsInserted} products but expected ${SEED_EXPECTED.products}`,
    );
  }
  if (variantsInserted !== SEED_EXPECTED.variants) {
    throw new Error(
      `Seed wrote ${variantsInserted} variants but expected ${SEED_EXPECTED.variants}`,
    );
  }

  const { users, locations } = await seedAuthAndLocations(db);
  const { inventoryLevels, pricingRules } = await seedInventoryAndPricing(db);

  return {
    products: SEED_EXPECTED.products,
    variants: SEED_EXPECTED.variants,
    productsInserted,
    variantsInserted,
    users,
    locations,
    inventoryLevels,
    pricingRules,
  };
}

/**
 * Inventory items, stock levels, and pricing rules.
 *
 * Creates one inventory item per seeded SKU and links it back onto the variant — this is what
 * finally populates `variants.inventory_item_id`, the column deliberately left null in
 * Milestone 1 so the seam between catalog and inventory would be visible rather than pretended
 * away.
 *
 * Levels are set with an absolute `on_hand` rather than an adjustment, and deliberately write
 * no rows to `inventory_adjustments`. The audit log records what people did; fabricating
 * history for fixture data would make it a worse record, and every real adjustment made
 * through the API from now on appears there truthfully.
 */
async function seedInventoryAndPricing(
  db: AppDatabase,
): Promise<{ inventoryLevels: number; pricingRules: number }> {
  let inventoryLevels = 0;
  let pricingRules = 0;

  await db.transaction().execute(async (trx) => {
    // One inventory item per SKU that appears in the level fixtures.
    const skus = [...new Set(SEED_INVENTORY.map(([sku]) => sku))];
    for (const sku of skus) {
      const itemId = deterministicId('invitem', sku);
      await trx
        .insertInto('inventory_items')
        .values({ id: itemId, sku, tracked: true })
        .onConflict((oc) => oc.column('id').doUpdateSet({ sku, tracked: true }))
        .execute();
      await trx
        .updateTable('variants')
        .set({ inventory_item_id: itemId })
        .where('sku', '=', sku)
        .execute();
    }

    for (const [sku, locationHandle, onHand] of SEED_INVENTORY) {
      const itemId = deterministicId('invitem', sku);
      const locId = deterministicId('loc', locationHandle);
      const written = await trx
        .insertInto('inventory_levels')
        .values({
          id: deterministicId('invlvl', `${sku}:${locationHandle}`),
          inventory_item_id: itemId,
          location_id: locId,
          on_hand: onHand,
          reserved: 0,
        })
        .onConflict((oc) =>
          // Re-seeding resets stock to the fixture value and clears reservations, so a
          // development database returns to a known state rather than drifting with use.
          oc.column('id').doUpdateSet({ on_hand: onHand, reserved: 0 }),
        )
        .returning('id')
        .executeTakeFirst();
      if (written) inventoryLevels += 1;
    }

    for (const r of SEED_PRICING_RULES) {
      const written = await trx
        .insertInto('pricing_rules')
        .values({
          id: deterministicId('prule', r.handle),
          name: r.name,
          type: r.type,
          scope_kind: r.scope_kind,
          scope_value: r.scope_value,
          adjustment_kind: r.adjustment_kind,
          adjustment_value: r.adjustment_value,
          min_quantity: r.min_quantity,
          customer_group: r.customer_group,
          partner_id: r.partner_id,
          priority: r.priority,
          starts_at: null,
          ends_at: null,
          is_active: true,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            name: r.name,
            type: r.type,
            scope_kind: r.scope_kind,
            scope_value: r.scope_value,
            adjustment_kind: r.adjustment_kind,
            adjustment_value: r.adjustment_value,
            min_quantity: r.min_quantity,
            customer_group: r.customer_group,
            partner_id: r.partner_id,
            priority: r.priority,
            is_active: true,
          }),
        )
        .returning('id')
        .executeTakeFirst();
      if (written) pricingRules += 1;
    }

    // Reservations created by earlier runs would otherwise keep stock held against fixture
    // levels that were just reset to reserved = 0.
    await trx
      .updateTable('inventory_reservations')
      .set({ status: 'released', released_at: new Date() })
      .where('status', '=', 'active')
      .execute();
  });

  if (inventoryLevels !== SEED_INVENTORY_EXPECTED.levels) {
    throw new Error(
      `Seed wrote ${inventoryLevels} inventory levels but expected ${SEED_INVENTORY_EXPECTED.levels}`,
    );
  }
  if (pricingRules !== SEED_INVENTORY_EXPECTED.rules) {
    throw new Error(
      `Seed wrote ${pricingRules} pricing rules but expected ${SEED_INVENTORY_EXPECTED.rules}`,
    );
  }
  return { inventoryLevels, pricingRules };
}

/**
 * Seed development users and inventory locations.
 *
 * Password hashing is done once per user per seed run rather than storing a precomputed hash
 * in source. scrypt is salted, so a checked-in hash would be a fixed salt shared by every
 * clone of this repository — a bad habit to demonstrate even where the password is public.
 */
async function seedAuthAndLocations(
  db: AppDatabase,
): Promise<{ users: number; locations: number }> {
  const userRows = await Promise.all(
    SEED_USERS.map(async (u) => ({
      id: deterministicId('usr', u.handle),
      email: u.email,
      name: u.name,
      password_hash: await hashPassword(u.password),
      role: u.role,
      is_active: true,
    })),
  );

  let users = 0;
  let locations = 0;

  await db.transaction().execute(async (trx) => {
    for (const row of userRows) {
      const written = await trx
        .insertInto('users')
        .values(row)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            email: row.email,
            name: row.name,
            // Re-hashed on every seed, which also means changing SEED_PASSWORD takes effect
            // on the next `db:seed` rather than needing a reset.
            password_hash: row.password_hash,
            role: row.role,
            is_active: true,
          }),
        )
        .returning('id')
        .executeTakeFirst();
      if (written) users += 1;
    }

    for (const l of SEED_LOCATIONS) {
      const written = await trx
        .insertInto('locations')
        .values({
          id: deterministicId('loc', l.handle),
          name: l.name,
          type: l.type,
          address_line1: l.address_line1,
          address_line2: null,
          city: l.city,
          region: l.region,
          postal_code: l.postal_code,
          country: l.country,
          is_active: true,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            name: l.name,
            type: l.type,
            address_line1: l.address_line1,
            city: l.city,
            region: l.region,
            postal_code: l.postal_code,
            country: l.country,
          }),
        )
        .returning('id')
        .executeTakeFirst();
      if (written) locations += 1;
    }
  });

  if (users !== SEED_AUTH_EXPECTED.users) {
    throw new Error(`Seed wrote ${users} users but expected ${SEED_AUTH_EXPECTED.users}`);
  }
  if (locations !== SEED_AUTH_EXPECTED.locations) {
    throw new Error(
      `Seed wrote ${locations} locations but expected ${SEED_AUTH_EXPECTED.locations}`,
    );
  }
  return { users, locations };
}
