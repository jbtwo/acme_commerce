/**
 * Database-level tests: migrations, constraints, triggers, and the seed loader.
 *
 * These bypass HTTP entirely. They exist because the database is the last line of defence: the
 * API can be bypassed by a migration, a seed script, or a psql session, and the constraints
 * that hold in those cases are the ones actually protecting the data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { resetTestDatabase, type TestDatabase } from '../helpers/database.js';
import { getMigrationStatus } from '../../src/db/migrator.js';
import { deterministicId, seedDatabase } from '../../src/db/seed/index.js';
import { SEED_EXPECTED } from '../../src/db/seed/data.js';
import { isPgError, PG_ERROR } from '../../src/http/errors.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await resetTestDatabase();
});
afterAll(async () => {
  await t?.close();
});

/** Run a statement and return the PostgreSQL SQLSTATE it failed with, or null on success. */
async function sqlstateOf(statement: string): Promise<string | null> {
  try {
    await sql.raw(statement).execute(t.db);
    return null;
  } catch (err) {
    if (isPgError(err)) return err.code ?? 'unknown';
    throw err;
  }
}

describe('migrations', () => {
  it('applies cleanly to an empty database and reports as current', async () => {
    const status = await getMigrationStatus(t.db, t.config.database.schema);
    expect(status.pending).toEqual([]);
    expect(status.applied).toContain('0001_catalog');
    expect(status.isUpToDate).toBe(true);
    expect(status.lastAppliedAt).toBeInstanceOf(Date);
  });

  it('creates the tables inside the application schema, not public', async () => {
    // The isolation property that makes `DROP SCHEMA acme CASCADE` a safe reset.
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = ${t.config.database.schema}
      order by table_name
    `.execute(t.db);
    const names = rows.rows.map((r) => r.table_name);
    expect(names).toContain('products');
    expect(names).toContain('variants');
    expect(names).toContain('kysely_migration');
  });

  it('leaves the public schema empty', async () => {
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from information_schema.tables where table_schema = 'public'
    `.execute(t.db);
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('creates the indexes the documented filters rely on', async () => {
    const rows = await sql<{ indexname: string }>`
      select indexname from pg_indexes where schemaname = ${t.config.database.schema}
    `.execute(t.db);
    const names = rows.rows.map((r) => r.indexname);
    for (const expected of [
      'products_status_idx',
      'products_vendor_lower_idx',
      'products_tags_gin_idx',
      'products_created_at_id_idx',
      'variants_sku_unique',
      'variants_product_position_idx',
    ]) {
      expect(names, `missing index ${expected}`).toContain(expected);
    }
  });
});

describe('constraints', () => {
  const PRODUCT =
    "insert into products (id, title) values ('prod_000000000000000000000001', 'Constraint fixture')";

  it('rejects an identifier that does not match the documented format', async () => {
    expect(await sqlstateOf("insert into products (id, title) values ('nope_1', 'X')")).toBe(
      PG_ERROR.CHECK_VIOLATION,
    );
  });

  it('rejects an unknown product status', async () => {
    expect(
      await sqlstateOf(
        "insert into products (id, title, status) values ('prod_00000000000000000000000a', 'X', 'pending')",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });

  it('rejects an empty title', async () => {
    expect(
      await sqlstateOf(
        "insert into products (id, title) values ('prod_00000000000000000000000b', '')",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });

  it('refuses to let status and archived_at disagree', async () => {
    // Without this, an "archived" product with no archived_at is a row nobody can explain.
    expect(
      await sqlstateOf(
        "insert into products (id, title, status) values ('prod_00000000000000000000000c', 'X', 'archived')",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
    expect(
      await sqlstateOf(
        "insert into products (id, title, status, archived_at) values ('prod_00000000000000000000000d', 'X', 'active', now())",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });

  it('enforces SKU uniqueness with a unique index, which cannot be raced', async () => {
    await sql.raw(PRODUCT).execute(t.db);
    await sql
      .raw(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_000000000000000000000001', 'prod_000000000000000000000001', 'CONSTRAINT-SKU', 'A', 100)",
      )
      .execute(t.db);
    expect(
      await sqlstateOf(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_000000000000000000000002', 'prod_000000000000000000000001', 'CONSTRAINT-SKU', 'B', 200)",
      ),
    ).toBe(PG_ERROR.UNIQUE_VIOLATION);
  });

  it('rejects a negative price', async () => {
    expect(
      await sqlstateOf(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_000000000000000000000003', 'prod_000000000000000000000001', 'NEG', 'X', -1)",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });

  it('rejects a currency that is not a three-letter uppercase code', async () => {
    expect(
      await sqlstateOf(
        "insert into variants (id, product_id, sku, title, price_cents, currency) values ('var_000000000000000000000004', 'prod_000000000000000000000001', 'CUR', 'X', 100, 'cad')",
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });

  it('rejects a variant whose product does not exist', async () => {
    expect(
      await sqlstateOf(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_000000000000000000000005', 'prod_00000000000000000000dead', 'ORPHAN', 'X', 100)",
      ),
    ).toBe(PG_ERROR.FOREIGN_KEY_VIOLATION);
  });

  it('cascades a hard product delete to its variants', async () => {
    // The API never hard-deletes, so this fires only for an operator running SQL directly.
    // Worth having: it prevents orphan variants that no API path could ever reach.
    await sql
      .raw(
        "insert into products (id, title) values ('prod_000000000000000000000002', 'Cascade fixture')",
      )
      .execute(t.db);
    await sql
      .raw(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_00000000000000000000000c', 'prod_000000000000000000000002', 'CASCADE-SKU', 'X', 100)",
      )
      .execute(t.db);
    await sql.raw("delete from products where id = 'prod_000000000000000000000002'").execute(t.db);
    const remaining = await t.db
      .selectFrom('variants')
      .select('id')
      .where('product_id', '=', 'prod_000000000000000000000002')
      .execute();
    expect(remaining).toEqual([]);
  });

  it('rejects more than 50 tags', async () => {
    const tags = Array.from({ length: 51 }, (_u, i) => `'t${i}'`).join(',');
    expect(
      await sqlstateOf(
        `insert into products (id, title, tags) values ('prod_00000000000000000000000e', 'X', ARRAY[${tags}])`,
      ),
    ).toBe(PG_ERROR.CHECK_VIOLATION);
  });
});

describe('updated_at trigger', () => {
  it('advances updated_at on any update, without the application setting it', async () => {
    // Maintained by the database precisely so no future code path can forget it. If the
    // application owned it, `sort=updated_at` would silently return wrong answers whenever
    // somebody added a new write path.
    await sql
      .raw(
        "insert into products (id, title) values ('prod_000000000000000000000003', 'Trigger fixture')",
      )
      .execute(t.db);
    const before = await t.db
      .selectFrom('products')
      .select(['created_at', 'updated_at'])
      .where('id', '=', 'prod_000000000000000000000003')
      .executeTakeFirstOrThrow();

    await new Promise((r) => setTimeout(r, 15));
    await sql
      .raw(
        "update products set title = 'Trigger fixture v2' where id = 'prod_000000000000000000000003'",
      )
      .execute(t.db);

    const after = await t.db
      .selectFrom('products')
      .select(['created_at', 'updated_at'])
      .where('id', '=', 'prod_000000000000000000000003')
      .executeTakeFirstOrThrow();

    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
  });

  it('applies to variants as well as products', async () => {
    await sql
      .raw(
        "insert into variants (id, product_id, sku, title, price_cents) values ('var_000000000000000000000006', 'prod_000000000000000000000003', 'TRIGGER-SKU', 'X', 100)",
      )
      .execute(t.db);
    const before = await t.db
      .selectFrom('variants')
      .select('updated_at')
      .where('id', '=', 'var_000000000000000000000006')
      .executeTakeFirstOrThrow();
    await new Promise((r) => setTimeout(r, 15));
    await sql
      .raw("update variants set price_cents = 200 where id = 'var_000000000000000000000006'")
      .execute(t.db);
    const after = await t.db
      .selectFrom('variants')
      .select('updated_at')
      .where('id', '=', 'var_000000000000000000000006')
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe('seed data', () => {
  it('loads the documented number of products and variants', async () => {
    const products = await t.db
      .selectFrom('products')
      .select(({ fn }) => fn.countAll<string>().as('c'))
      .where('id', 'like', 'prod_%')
      .executeTakeFirstOrThrow();
    // Constraint fixtures above added rows, so assert the seeded ones are present rather than
    // asserting an exact table count.
    expect(Number(products.c)).toBeGreaterThanOrEqual(SEED_EXPECTED.products);

    const trailhead = await t.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', deterministicId('prod', 'trailhead-30l-backpack'))
      .executeTakeFirst();
    expect(trailhead?.title).toBe('Trailhead 30L Backpack');
  });

  it('produces the same identifiers on every machine', () => {
    // Determinism is what lets a test, or a documentation example, reference a seeded record
    // by id rather than by "whatever came back first".
    expect(deterministicId('prod', 'trailhead-30l-backpack')).toBe(
      deterministicId('prod', 'trailhead-30l-backpack'),
    );
    expect(deterministicId('prod', 'trailhead-30l-backpack')).toMatch(/^prod_[0-9a-f]{24}$/);
    expect(deterministicId('prod', 'a')).not.toBe(deterministicId('prod', 'b'));
    // Kind is part of the derivation, so a product and a variant sharing a natural key differ.
    expect(deterministicId('prod', 'x')).not.toBe(
      deterministicId('var', 'x').replace('var', 'prod'),
    );
  });

  it('includes the SKU referenced by the documentation examples', async () => {
    const variant = await t.db
      .selectFrom('variants')
      .selectAll()
      .where('sku', '=', 'ACME-BAG-BLK')
      .executeTakeFirst();
    expect(variant).toBeDefined();
    expect(variant?.price_cents).toBe(12900);
  });

  it('spreads data across every documented filter axis', async () => {
    const rows = await t.db
      .selectFrom('products')
      .selectAll()
      .where('id', 'like', 'prod_%')
      .execute();
    const seeded = rows.filter((r) => r.vendor !== null);
    expect(new Set(seeded.map((p) => p.status)).size).toBe(3);
    expect(new Set(seeded.map((p) => p.vendor)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(seeded.map((p) => p.product_type)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(seeded.flatMap((p) => p.tags)).size).toBeGreaterThanOrEqual(10);
    // Creation dates must actually differ, or sorting by created_at proves nothing.
    expect(new Set(seeded.map((p) => p.created_at.getTime())).size).toBe(seeded.length);
  });

  it('is idempotent — running it twice changes no counts', async () => {
    const countBefore = await t.db
      .selectFrom('variants')
      .select(({ fn }) => fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    await seedDatabase(t.db);
    const countAfter = await t.db
      .selectFrom('variants')
      .select(({ fn }) => fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(countAfter.c).toBe(countBefore.c);
  });

  it('does not delete records created outside the seed', async () => {
    // A seed command that quietly wipes your Postman work is a seed command you learn to fear.
    await sql
      .raw(
        "insert into products (id, title) values ('prod_000000000000000000000099', 'Hand-made, must survive')",
      )
      .execute(t.db);
    await seedDatabase(t.db);
    const survivor = await t.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', 'prod_000000000000000000000099')
      .executeTakeFirst();
    expect(survivor?.title).toBe('Hand-made, must survive');
  });
});
