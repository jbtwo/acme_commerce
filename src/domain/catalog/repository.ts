/**
 * Catalog data access.
 *
 * This layer owns SQL and nothing else. It does not know what an HTTP status code is, it does
 * not decide whether "not found" is an error, and it does not enforce business rules. Its job
 * is to turn a typed request for data into a query and typed rows back.
 *
 * The payoff for that discipline is testability: these functions can be integration-tested
 * against real PostgreSQL without a web server, which is where SQL bugs actually live.
 */
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { AppDatabase } from '../../db/index.js';
import { toCount } from '../../db/index.js';
import type { Database } from '../../db/schema.js';
import type {
  NewProductRow,
  NewVariantRow,
  ProductRow,
  ProductStatus,
  ProductUpdate,
  VariantRow,
  VariantUpdate,
} from '../../db/schema.js';
import { PRODUCT_SORT_FIELDS, MAX_VARIANTS_PER_PRODUCT } from './schemas.js';

export interface ProductFilters {
  status?: ProductStatus | undefined;
  vendor?: string | undefined;
  productType?: string | undefined;
  tag?: string | undefined;
  q?: string | undefined;
}

export interface ProductSort {
  field: (typeof PRODUCT_SORT_FIELDS)[number];
  direction: 'asc' | 'desc';
}

export interface PageRequest {
  page: number;
  limit: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

/**
 * Escape the LIKE metacharacters in user input.
 *
 * Without this, `q=100%` matches everything starting with "100" instead of searching for the
 * literal string, and `q=a_b` matches "axb". The user typed a search term, not a pattern.
 * PostgreSQL's default LIKE escape character is backslash, so no ESCAPE clause is needed.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Build the WHERE clause for the documented product filters.
 *
 * Returned as a single boolean expression rather than applied directly to a query builder, so
 * the page query and the count query share one definition of "matching". Writing the filters
 * twice is how a collection endpoint ends up reporting `total: 47` above a page of rows drawn
 * from a different set.
 */
function productFilters(
  eb: ExpressionBuilder<Database, 'products'>,
  filters: ProductFilters,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];

  if (filters.status) {
    conditions.push(eb('status', '=', filters.status));
  }
  if (filters.vendor) {
    // Case-insensitive EXACT match. Matches the products_vendor_lower_idx functional index,
    // so this filter is an index scan rather than a sequential one.
    conditions.push(eb(sql<string>`lower(vendor)`, '=', filters.vendor.toLowerCase()));
  }
  if (filters.productType) {
    conditions.push(eb(sql<string>`lower(product_type)`, '=', filters.productType.toLowerCase()));
  }
  if (filters.tag) {
    // Array containment, served by the GIN index on tags. Case-sensitive, unlike vendor:
    // tags are controlled values applied by merchandisers, not free text typed by a caller.
    conditions.push(sql<SqlBool>`tags @> ARRAY[${filters.tag}]::text[]`);
  }
  if (filters.q) {
    const pattern = `%${escapeLikePattern(filters.q)}%`;
    conditions.push(
      eb.or([
        eb('title', 'ilike', pattern),
        eb('description', 'ilike', pattern),
        eb('vendor', 'ilike', pattern),
      ]),
    );
  }

  // No filters means match everything. `eb.and([])` is not guaranteed to render as TRUE, so
  // the empty case is spelled out.
  return conditions.length === 0 ? sql<SqlBool>`true` : eb.and(conditions);
}

export async function listProducts(
  db: AppDatabase,
  filters: ProductFilters,
  sort: ProductSort,
  page: PageRequest,
): Promise<Page<ProductRow>> {
  const offset = (page.page - 1) * page.limit;

  /*
   * The page and the total are read inside one REPEATABLE READ transaction.
   *
   * Two separate statements at the default READ COMMITTED isolation each take their own
   * snapshot, so a concurrent insert between them yields a response where `total` and `data`
   * describe slightly different worlds — `total: 21` alongside 20 rows on a single-page
   * result. Rare, confusing, and essentially impossible to reproduce on demand.
   *
   * The cost is a transaction per list request. That is the right trade for a collection
   * endpoint whose whole job is to report a consistent count.
   */
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rows = await trx
        .selectFrom('products')
        .selectAll()
        .where((eb) => productFilters(eb, filters))
        .orderBy(sort.field, sort.direction)
        // The unique tiebreaker. Without it, `sort=status` across rows with equal status has
        // no defined order, and PostgreSQL is free to return them differently between two
        // queries — so paging can show one row twice and skip another. This bug passes every
        // single-page test.
        .orderBy('id', sort.direction)
        .limit(page.limit)
        .offset(offset)
        .execute();

      const counted = await trx
        .selectFrom('products')
        .select(({ fn }) => fn.countAll().as('total'))
        .where((eb) => productFilters(eb, filters))
        .executeTakeFirstOrThrow();

      return { rows, total: toCount(counted.total as string) };
    });
}

export async function findProductById(
  db: AppDatabase,
  id: string,
): Promise<ProductRow | undefined> {
  return db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function insertProduct(db: AppDatabase, row: NewProductRow): Promise<ProductRow> {
  return db.insertInto('products').values(row).returningAll().executeTakeFirstOrThrow();
}

/** Returns undefined when no row matched, which the service turns into a 404. */
export async function updateProduct(
  db: AppDatabase,
  id: string,
  patch: ProductUpdate,
): Promise<ProductRow | undefined> {
  return db
    .updateTable('products')
    .set(patch)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export async function productExists(db: AppDatabase, id: string): Promise<boolean> {
  const row = await db.selectFrom('products').select('id').where('id', '=', id).executeTakeFirst();
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export async function listVariantsByProduct(
  db: AppDatabase,
  productId: string,
): Promise<VariantRow[]> {
  return (
    db
      .selectFrom('variants')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('position', 'asc')
      .orderBy('id', 'asc')
      // A hard ceiling rather than pagination. Documented in the contract, and enforced here so
      // an unpaginated endpoint cannot become an unbounded one if somebody bulk-loads variants.
      .limit(MAX_VARIANTS_PER_PRODUCT)
      .execute()
  );
}

export async function findVariantById(
  db: AppDatabase,
  id: string,
): Promise<VariantRow | undefined> {
  return db.selectFrom('variants').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findVariantBySku(
  db: AppDatabase,
  sku: string,
): Promise<VariantRow | undefined> {
  return db.selectFrom('variants').selectAll().where('sku', '=', sku).executeTakeFirst();
}

export async function insertVariant(db: AppDatabase, row: NewVariantRow): Promise<VariantRow> {
  return db.insertInto('variants').values(row).returningAll().executeTakeFirstOrThrow();
}

export async function updateVariant(
  db: AppDatabase,
  id: string,
  patch: VariantUpdate,
): Promise<VariantRow | undefined> {
  return db
    .updateTable('variants')
    .set(patch)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/** Highest `position` currently used by a product's variants, or 0 when it has none. */
export async function maxVariantPosition(db: AppDatabase, productId: string): Promise<number> {
  const row = await db
    .selectFrom('variants')
    .select(({ fn }) => fn.max('position').as('max_position'))
    .where('product_id', '=', productId)
    .executeTakeFirst();
  const value = row?.max_position;
  return value === null || value === undefined ? 0 : Number(value);
}

/** Used only by the archive cascade: archiving a product archives its variants. */
export async function archiveVariantsOfProduct(
  db: AppDatabase,
  productId: string,
  archivedAt: Date,
): Promise<number> {
  const result = await db
    .updateTable('variants')
    .set({ status: 'archived', archived_at: archivedAt })
    .where('product_id', '=', productId)
    .where('status', '<>', 'archived')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function unarchiveVariantsOfProduct(
  db: AppDatabase,
  productId: string,
): Promise<number> {
  const result = await db
    .updateTable('variants')
    .set({ status: 'active', archived_at: null })
    .where('product_id', '=', productId)
    .where('status', '=', 'archived')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
