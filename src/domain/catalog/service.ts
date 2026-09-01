/**
 * Catalog business logic.
 *
 * This layer decides what the rules ARE. It knows that a missing product is an error, that
 * archiving is idempotent, and that archiving a product must archive its variants. It does not
 * know about HTTP: it throws typed domain errors and returns domain objects, and the route
 * layer decides which status code each of those becomes.
 *
 * The separation is not ceremony. It means these rules can be unit-tested against a fake
 * repository with no database and no web server, and it means the same rules would hold if
 * this logic were ever called from a queue consumer or a CLI instead of a route.
 */
import {
  isPgError,
  MalformedIdError,
  NotFoundError,
  PG_ERROR,
  SkuConflictError,
} from '../../http/errors.js';
import type { AppDatabase } from '../../db/index.js';
import type { ProductRow, VariantRow } from '../../db/schema.js';
import { ID_PREFIXES, idPattern, idPatternString, productId, variantId } from '../ids.js';
import * as repo from './repository.js';
import type {
  CreateProductInput,
  CreateVariantInput,
  ProductListQueryType,
  ProductResource,
  UpdateProductInput,
  UpdateVariantInput,
  VariantResource,
} from './schemas.js';
import { DEFAULT_PAGE_SIZE } from './schemas.js';

// ---------------------------------------------------------------------------
// Row -> API resource
// ---------------------------------------------------------------------------

/**
 * Timestamps are converted to ISO-8601 strings here rather than left to the JSON serializer.
 *
 * fast-json-stringify would in fact format a `Date` correctly for a `date-time` property, but
 * relying on that makes the response shape depend on serializer behaviour instead of on code
 * you can read and unit-test. It also means these mappers return exactly what the client
 * receives, which is what lets a unit test assert on a resource without an HTTP round trip.
 */
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toProductResource(row: ProductRow): ProductResource {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    vendor: row.vendor,
    product_type: row.product_type,
    tags: row.tags,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    archived_at: iso(row.archived_at),
  };
}

export function toVariantResource(row: VariantRow): VariantResource {
  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku,
    title: row.title,
    price_cents: row.price_cents,
    compare_at_price_cents: row.compare_at_price_cents,
    currency: row.currency,
    barcode: row.barcode,
    inventory_item_id: row.inventory_item_id,
    status: row.status,
    position: row.position,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    archived_at: iso(row.archived_at),
  };
}

// ---------------------------------------------------------------------------
// Identifier checks
// ---------------------------------------------------------------------------

/**
 * Reject an identifier that cannot possibly name a product, before touching the database.
 *
 * This is what separates 400 MALFORMED_ID from 404 PRODUCT_NOT_FOUND. `prod_undefined` is a
 * client bug — almost always a template string that interpolated a missing variable — and
 * saying so is far more useful than "not found", which sends the caller looking for a deleted
 * record that never existed.
 */
export function assertProductId(value: string): void {
  if (!idPattern(ID_PREFIXES.product).test(value)) {
    throw new MalformedIdError('productId', value, idPatternString(ID_PREFIXES.product));
  }
}

export function assertVariantId(value: string): void {
  if (!idPattern(ID_PREFIXES.variant).test(value)) {
    throw new MalformedIdError('variantId', value, idPatternString(ID_PREFIXES.variant));
  }
}

function productNotFound(id: string): NotFoundError {
  return new NotFoundError('PRODUCT_NOT_FOUND', `No product exists with id "${id}".`, {
    product_id: id,
  });
}

function variantNotFound(id: string): NotFoundError {
  return new NotFoundError('VARIANT_NOT_FOUND', `No variant exists with id "${id}".`, {
    variant_id: id,
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface ProductListResult {
  products: ProductResource[];
  page: number;
  limit: number;
  total: number;
}

export async function listProducts(
  db: AppDatabase,
  query: ProductListQueryType,
): Promise<ProductListResult> {
  // Ajv has already applied the schema defaults, so these fallbacks are belt-and-braces for
  // callers that reach the service directly (tests, and any future non-HTTP entry point).
  const page = query.page ?? 1;
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;

  const result = await repo.listProducts(
    db,
    {
      status: query.status,
      vendor: query.vendor,
      productType: query.product_type,
      tag: query.tag,
      q: query.q,
    },
    { field: query.sort ?? 'created_at', direction: query.order ?? 'desc' },
    { page, limit },
  );

  return { products: result.rows.map(toProductResource), page, limit, total: result.total };
}

export async function getProduct(db: AppDatabase, id: string): Promise<ProductResource> {
  assertProductId(id);
  const row = await repo.findProductById(db, id);
  if (!row) throw productNotFound(id);
  return toProductResource(row);
}

export async function createProduct(
  db: AppDatabase,
  input: CreateProductInput,
): Promise<ProductResource> {
  const status = input.status ?? 'draft';
  const row = await repo.insertProduct(db, {
    id: productId(),
    title: input.title,
    description: input.description ?? null,
    status,
    vendor: input.vendor ?? null,
    product_type: input.product_type ?? null,
    tags: input.tags ?? [],
    // The database CHECK constraint products_archived_sync requires archived_at to be set
    // exactly when status is 'archived'. Creating a product directly in the archived state is
    // unusual but permitted, so the timestamp has to be filled in here too.
    archived_at: status === 'archived' ? new Date() : null,
  });
  return toProductResource(row);
}

export async function patchProduct(
  db: AppDatabase,
  id: string,
  input: UpdateProductInput,
): Promise<ProductResource> {
  assertProductId(id);

  const existing = await repo.findProductById(db, id);
  if (!existing) throw productNotFound(id);

  const patch: Parameters<typeof repo.updateProduct>[2] = {};
  // Only properties actually present in the body are touched. `'title' in input` rather than
  // `input.title !== undefined` because they differ for an explicit null, and PATCH has to be
  // able to tell "leave it alone" from "set it to null".
  if ('title' in input) patch.title = input.title;
  if ('description' in input) patch.description = input.description ?? null;
  if ('vendor' in input) patch.vendor = input.vendor ?? null;
  if ('product_type' in input) patch.product_type = input.product_type ?? null;
  if ('tags' in input) patch.tags = input.tags;

  let statusChangedTo: 'archived' | 'unarchived' | null = null;
  if ('status' in input && input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    if (input.status === 'archived') {
      patch.archived_at = new Date();
      statusChangedTo = 'archived';
    } else if (existing.status === 'archived') {
      patch.archived_at = null;
      statusChangedTo = 'unarchived';
    }
  }

  if (Object.keys(patch).length === 0) {
    // Every property sent already held the value it was set to. Returning the current record
    // is correct and idempotent: the caller asked for a state, and the record is in it.
    return toProductResource(existing);
  }

  const updated = await repo.updateProduct(db, id, patch);
  if (!updated) throw productNotFound(id);

  // Archiving a product archives its variants, and un-archiving restores them. A live variant
  // on an archived product would be reachable by SKU through the Inventory and Orders APIs in
  // later milestones, which is exactly the inconsistency archiving is meant to prevent.
  if (statusChangedTo === 'archived') {
    await repo.archiveVariantsOfProduct(db, id, updated.archived_at ?? new Date());
  } else if (statusChangedTo === 'unarchived') {
    await repo.unarchiveVariantsOfProduct(db, id);
  }

  return toProductResource(updated);
}

/**
 * DELETE semantics: archive, do not destroy.
 *
 * Idempotent by design. Archiving an already-archived product returns it unchanged with 200
 * rather than raising a conflict, because "make sure this is archived" is a reasonable thing
 * for a client to say twice — after a network timeout, for instance.
 */
export async function archiveProduct(db: AppDatabase, id: string): Promise<ProductResource> {
  assertProductId(id);
  const existing = await repo.findProductById(db, id);
  if (!existing) throw productNotFound(id);
  if (existing.status === 'archived') return toProductResource(existing);

  const archivedAt = new Date();
  const updated = await repo.updateProduct(db, id, { status: 'archived', archived_at: archivedAt });
  if (!updated) throw productNotFound(id);
  await repo.archiveVariantsOfProduct(db, id, archivedAt);
  return toProductResource(updated);
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export async function listVariants(
  db: AppDatabase,
  productIdValue: string,
): Promise<VariantResource[]> {
  assertProductId(productIdValue);
  // Checked explicitly so that an unknown product returns 404 rather than an empty list. An
  // empty array would mean "this product has no variants", which is a different fact.
  if (!(await repo.productExists(db, productIdValue))) throw productNotFound(productIdValue);
  const rows = await repo.listVariantsByProduct(db, productIdValue);
  return rows.map(toVariantResource);
}

export async function getVariant(db: AppDatabase, id: string): Promise<VariantResource> {
  assertVariantId(id);
  const row = await repo.findVariantById(db, id);
  if (!row) throw variantNotFound(id);
  return toVariantResource(row);
}

/**
 * Translate a PostgreSQL unique violation on the SKU index into a domain error.
 *
 * Note what is NOT happening: there is no `SELECT ... WHERE sku = ?` before the insert. A
 * check-then-insert has a race window — two concurrent requests both see the SKU as free and
 * both proceed — and the pre-check version passes every single-threaded test while failing in
 * production under load. The UNIQUE index cannot be raced, so the insert is attempted and the
 * failure is interpreted.
 */
async function withSkuConflictTranslation<T>(
  db: AppDatabase,
  sku: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isPgError(err, PG_ERROR.UNIQUE_VIOLATION) && err.constraint === 'variants_sku_unique') {
      // Look up the conflicting record so the error can name it. Best-effort: if this lookup
      // fails, the 409 is still correct, just less helpful.
      const conflicting = await repo.findVariantBySku(db, sku).catch(() => undefined);
      throw new SkuConflictError(sku, conflicting?.id);
    }
    throw err;
  }
}

export async function createVariant(
  db: AppDatabase,
  productIdValue: string,
  input: CreateVariantInput,
): Promise<VariantResource> {
  assertProductId(productIdValue);
  const product = await repo.findProductById(db, productIdValue);
  if (!product) throw productNotFound(productIdValue);

  // Default position is one past the current highest. Two concurrent creates can land on the
  // same position; that is harmless because `position` is a display hint, not an identity, and
  // ties are broken by `id` in the documented ordering.
  const position = input.position ?? (await repo.maxVariantPosition(db, productIdValue)) + 1;
  const isArchived = product.status === 'archived';

  const row = await withSkuConflictTranslation(db, input.sku, () =>
    repo.insertVariant(db, {
      id: variantId(),
      product_id: productIdValue,
      sku: input.sku,
      title: input.title,
      price_cents: input.price_cents,
      compare_at_price_cents: input.compare_at_price_cents ?? null,
      currency: input.currency ?? 'CAD',
      barcode: input.barcode ?? null,
      inventory_item_id: null,
      // A new variant on an archived product is created archived. The alternative — an active
      // variant hanging off a retired product — is the inconsistency archiving exists to avoid.
      status: isArchived ? 'archived' : 'active',
      archived_at: isArchived ? new Date() : null,
      position,
    }),
  );
  return toVariantResource(row);
}

export async function patchVariant(
  db: AppDatabase,
  id: string,
  input: UpdateVariantInput,
): Promise<VariantResource> {
  assertVariantId(id);
  const existing = await repo.findVariantById(db, id);
  if (!existing) throw variantNotFound(id);

  const patch: Parameters<typeof repo.updateVariant>[2] = {};
  if ('sku' in input) patch.sku = input.sku;
  if ('title' in input) patch.title = input.title;
  if ('price_cents' in input) patch.price_cents = input.price_cents;
  if ('compare_at_price_cents' in input)
    patch.compare_at_price_cents = input.compare_at_price_cents ?? null;
  if ('currency' in input) patch.currency = input.currency;
  if ('barcode' in input) patch.barcode = input.barcode ?? null;
  if ('position' in input) patch.position = input.position;

  if ('status' in input && input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    patch.archived_at = input.status === 'archived' ? new Date() : null;
  }

  if (Object.keys(patch).length === 0) return toVariantResource(existing);

  const updated = await withSkuConflictTranslation(db, input.sku ?? existing.sku, () =>
    repo.updateVariant(db, id, patch),
  );
  if (!updated) throw variantNotFound(id);
  return toVariantResource(updated);
}

export async function archiveVariant(db: AppDatabase, id: string): Promise<VariantResource> {
  assertVariantId(id);
  const existing = await repo.findVariantById(db, id);
  if (!existing) throw variantNotFound(id);
  if (existing.status === 'archived') return toVariantResource(existing);

  const updated = await repo.updateVariant(db, id, {
    status: 'archived',
    archived_at: new Date(),
  });
  if (!updated) throw variantNotFound(id);
  return toVariantResource(updated);
}
