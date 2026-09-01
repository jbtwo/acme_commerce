/**
 * Pure catalog logic: pagination arithmetic, resource mapping, identifier assertions, and
 * search-pattern escaping. No database and no HTTP — these run in milliseconds and pin the
 * decisions that would otherwise only be observable through a full stack.
 */
import { describe, expect, it } from 'vitest';
import { collection, resource } from '../../src/http/envelope.js';
import { escapeLikePattern } from '../../src/domain/catalog/repository.js';
import {
  assertProductId,
  assertVariantId,
  toProductResource,
  toVariantResource,
} from '../../src/domain/catalog/service.js';
import { MalformedIdError } from '../../src/http/errors.js';
import type { ProductRow, VariantRow } from '../../src/db/schema.js';

describe('collection envelope', () => {
  it('computes total_pages by rounding up', () => {
    expect(collection([], { page: 1, limit: 25, total: 51 }).pagination.total_pages).toBe(3);
    expect(collection([], { page: 1, limit: 25, total: 50 }).pagination.total_pages).toBe(2);
    expect(collection([], { page: 1, limit: 25, total: 1 }).pagination.total_pages).toBe(1);
  });

  it('reports zero pages for zero results, not one empty page', () => {
    // The question every consumer asks and most APIs answer inconsistently.
    const { pagination } = collection([], { page: 1, limit: 25, total: 0 });
    expect(pagination.total).toBe(0);
    expect(pagination.total_pages).toBe(0);
  });

  it('echoes the page and limit that were actually applied', () => {
    const { pagination } = collection([1, 2], { page: 4, limit: 2, total: 9 });
    expect(pagination).toEqual({ page: 4, limit: 2, total: 9, total_pages: 5 });
  });
});

describe('resource envelope', () => {
  it('wraps a single resource under `data`', () => {
    expect(resource({ id: 'x' })).toEqual({ data: { id: 'x' } });
  });
});

describe('escapeLikePattern', () => {
  it('escapes % so a search for a percentage is not a wildcard', () => {
    // Without this, q=100% matches everything beginning with "100".
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('escapes _ so it matches a literal underscore, not any character', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes a backslash first so escaping cannot be escaped away', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary search terms untouched', () => {
    expect(escapeLikePattern('backpack')).toBe('backpack');
  });
});

describe('identifier assertions', () => {
  it('accepts a well-formed identifier', () => {
    expect(() => assertProductId('prod_0199f3a9c4e21b7d05f6a3b8')).not.toThrow();
    expect(() => assertVariantId('var_0199f3a9c4e21b7d05f6a3b8')).not.toThrow();
  });

  it('raises MALFORMED_ID with the expected pattern in details', () => {
    try {
      assertProductId('prod_undefined');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedIdError);
      const e = err as MalformedIdError;
      expect(e.code).toBe('MALFORMED_ID');
      expect(e.statusCode).toBe(400);
      expect(e.details?.expected_pattern).toBe('^prod_[0-9a-f]{24}$');
      expect(e.details?.value).toBe('prod_undefined');
    }
  });

  it('rejects a variant id supplied where a product id belongs', () => {
    expect(() => assertProductId('var_0199f3a9c4e21b7d05f6a3b8')).toThrowError(MalformedIdError);
  });
});

const productRow = (overrides: Partial<ProductRow> = {}): ProductRow =>
  ({
    id: 'prod_0199f3a9c4e21b7d05f6a3b8',
    title: 'Trailhead 30L Backpack',
    description: null,
    status: 'active',
    vendor: 'Acme',
    product_type: 'Backpacks',
    tags: ['outdoor'],
    created_at: new Date('2025-01-14T15:20:00Z'),
    updated_at: new Date('2025-02-01T09:00:00Z'),
    archived_at: null,
    ...overrides,
  }) as ProductRow;

const variantRow = (overrides: Partial<VariantRow> = {}): VariantRow =>
  ({
    id: 'var_0199f3a9c4e21b7d05f6a3b8',
    product_id: 'prod_0199f3a9c4e21b7d05f6a3b8',
    sku: 'ACME-BAG-BLK',
    title: 'Black',
    price_cents: 12900,
    compare_at_price_cents: 15900,
    currency: 'CAD',
    barcode: null,
    inventory_item_id: null,
    status: 'active',
    position: 1,
    created_at: new Date('2025-01-14T15:20:00Z'),
    updated_at: new Date('2025-01-14T15:20:00Z'),
    archived_at: null,
    ...overrides,
  }) as VariantRow;

describe('row to resource mapping', () => {
  it('renders timestamps as RFC 3339 strings in UTC', () => {
    const product = toProductResource(productRow());
    expect(product.created_at).toBe('2025-01-14T15:20:00.000Z');
    expect(product.updated_at).toBe('2025-02-01T09:00:00.000Z');
  });

  it('preserves null rather than dropping the property', () => {
    // A missing key and an explicit null are different things to a consumer: one means "not
    // in this response", the other means "known to be empty".
    const product = toProductResource(productRow({ description: null, archived_at: null }));
    expect(product.description).toBeNull();
    expect(product.archived_at).toBeNull();
    expect('description' in product).toBe(true);
  });

  it('exposes exactly the documented product properties, no more', () => {
    expect(Object.keys(toProductResource(productRow())).sort()).toEqual([
      'archived_at',
      'created_at',
      'description',
      'id',
      'product_type',
      'status',
      'tags',
      'title',
      'updated_at',
      'vendor',
    ]);
  });

  it('exposes exactly the documented variant properties, no more', () => {
    expect(Object.keys(toVariantResource(variantRow())).sort()).toEqual([
      'archived_at',
      'barcode',
      'compare_at_price_cents',
      'created_at',
      'currency',
      'id',
      'inventory_item_id',
      'position',
      'price_cents',
      'product_id',
      'sku',
      'status',
      'title',
      'updated_at',
    ]);
  });

  it('keeps money as an integer, never a float or a string', () => {
    const variant = toVariantResource(variantRow({ price_cents: 12900 }));
    expect(variant.price_cents).toBe(12900);
    expect(Number.isInteger(variant.price_cents)).toBe(true);
  });

  it('renders archived_at when the record is archived', () => {
    const product = toProductResource(
      productRow({ status: 'archived', archived_at: new Date('2026-05-01T00:00:00Z') }),
    );
    expect(product.status).toBe('archived');
    expect(product.archived_at).toBe('2026-05-01T00:00:00.000Z');
  });
});
