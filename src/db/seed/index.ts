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

  return {
    products: SEED_EXPECTED.products,
    variants: SEED_EXPECTED.variants,
    productsInserted,
    variantsInserted,
  };
}
