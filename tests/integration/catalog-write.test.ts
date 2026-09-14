/**
 * Write-path behaviour: create, partial update, archive semantics, and SKU uniqueness.
 *
 * Assertions go against both the HTTP response and the database row where the two could
 * disagree — a response that says a product was archived while the row says otherwise is
 * exactly the class of bug an API-only test cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestHarness,
  json,
  type ApiError,
  type TestHarness,
} from '../helpers/app.js';
import type { ProductResource, VariantResource } from '../../src/domain/catalog/schemas.js';

let h: TestHarness;
let auth: string;

beforeAll(async () => {
  h = await createTestHarness();
  auth = await bearer(h, 'developer');
});
afterAll(async () => {
  await h?.close();
});

const createProduct = async (body: Record<string, unknown>) => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: { authorization: auth },
    payload: body,
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: json<{ data: ProductResource }>(res.body),
  };
};

let counter = 0;
const uniqueSku = () => `TEST-SKU-${Date.now()}-${(counter += 1)}`;

describe('POST /api/v1/products', () => {
  it('creates a product and returns 201 with a Location header', async () => {
    const { status, headers, body } = await createProduct({
      title: 'Riverbend Packable Rain Jacket',
      description: 'A 2.5-layer shell.',
      status: 'active',
      vendor: 'Acme',
      product_type: 'Apparel',
      tags: ['waterproof', 'lightweight'],
    });
    expect(status).toBe(201);
    expect(headers.location).toBe(`/api/v1/products/${body.data.id}`);
    expect(body.data.id).toMatch(/^prod_[0-9a-f]{24}$/);
    expect(body.data.title).toBe('Riverbend Packable Rain Jacket');
    expect(body.data.tags).toEqual(['waterproof', 'lightweight']);
    expect(body.data.archived_at).toBeNull();
  });

  it('defaults status to draft, so creating does not publish', async () => {
    const { body } = await createProduct({ title: 'Only a title' });
    expect(body.data.status).toBe('draft');
    expect(body.data.tags).toEqual([]);
    expect(body.data.description).toBeNull();
    expect(body.data.vendor).toBeNull();
  });

  it('persists the row, not merely the response', async () => {
    const { body } = await createProduct({ title: 'Persisted product', vendor: 'Acme' });
    const row = await h.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', body.data.id)
      .executeTakeFirst();
    expect(row?.title).toBe('Persisted product');
    expect(row?.vendor).toBe('Acme');
  });

  it('sets archived_at when a product is created directly in the archived state', async () => {
    // The database CHECK requires status and archived_at to agree; the service must fill it in.
    const { status, body } = await createProduct({ title: 'Born archived', status: 'archived' });
    expect(status).toBe(201);
    expect(body.data.archived_at).not.toBeNull();
  });
});

describe('PATCH /api/v1/products/{id}', () => {
  it('updates only the properties present in the body', async () => {
    const created = await createProduct({
      title: 'Patch me',
      vendor: 'Acme',
      product_type: 'Apparel',
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
      payload: { product_type: 'Outerwear' },
    });
    expect(res.statusCode).toBe(200);
    const patched = json<{ data: ProductResource }>(res.body).data;
    expect(patched.product_type).toBe('Outerwear');
    // Untouched properties must survive.
    expect(patched.title).toBe('Patch me');
    expect(patched.vendor).toBe('Acme');
  });

  it('distinguishes an omitted property from an explicit null', async () => {
    const created = await createProduct({
      title: 'Null test',
      description: 'present',
      vendor: 'Acme',
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
      payload: { description: null },
    });
    const patched = json<{ data: ProductResource }>(res.body).data;
    expect(patched.description).toBeNull();
    // `vendor` was omitted, so it must NOT have been cleared.
    expect(patched.vendor).toBe('Acme');
  });

  it('replaces the tag array wholesale rather than merging', async () => {
    const created = await createProduct({ title: 'Tag test', tags: ['a', 'b', 'c'] });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
      payload: { tags: ['z'] },
    });
    expect(json<{ data: ProductResource }>(res.body).data.tags).toEqual(['z']);
  });

  it('advances updated_at via the database trigger', async () => {
    const created = await createProduct({ title: 'Timestamp test' });
    const before = created.body.data.updated_at;
    await new Promise((r) => setTimeout(r, 15));
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
      payload: { title: 'Timestamp test v2' },
    });
    const after = json<{ data: ProductResource }>(res.body).data;
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before));
    // created_at must never move.
    expect(after.created_at).toBe(created.body.data.created_at);
  });

  it('is a no-op that still returns 200 when every value already matches', async () => {
    const created = await createProduct({ title: 'Idempotent patch', status: 'draft' });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
      payload: { status: 'draft' },
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ data: ProductResource }>(res.body).data.status).toBe('draft');
  });
});

describe('variants', () => {
  it('creates a variant with money as integer minor units', async () => {
    const product = await createProduct({ title: 'Variant host', status: 'active' });
    const sku = uniqueSku();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku, title: 'Black / Medium', price_cents: 18900, compare_at_price_cents: 22900 },
    });
    expect(res.statusCode).toBe(201);
    const variant = json<{ data: VariantResource }>(res.body).data;
    expect(variant.price_cents).toBe(18900);
    expect(variant.currency).toBe('CAD');
    expect(variant.position).toBe(1);
    expect(variant.status).toBe('active');
    expect(variant.inventory_item_id).toBeNull();
    expect(res.headers.location).toBe(`/api/v1/variants/${variant.id}`);
  });

  it('auto-increments position for each subsequent variant', async () => {
    const product = await createProduct({ title: 'Position host', status: 'active' });
    const positions: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/products/${product.body.data.id}/variants`,
        headers: { authorization: auth },
        payload: { sku: uniqueSku(), title: `V${i}`, price_cents: 100 },
      });
      positions.push(json<{ data: VariantResource }>(res.body).data.position);
    }
    expect(positions).toEqual([1, 2, 3]);
  });

  it('rejects a duplicate SKU with 409 and names the conflicting variant', async () => {
    const product = await createProduct({ title: 'SKU conflict host', status: 'active' });
    const sku = uniqueSku();
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku, title: 'First', price_cents: 100 },
    });
    expect(first.statusCode).toBe(201);
    const firstId = json<{ data: VariantResource }>(first.body).data.id;

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku, title: 'Second', price_cents: 200 },
    });
    expect(second.statusCode).toBe(409);
    const err = json<ApiError>(second.body);
    expect(err.error.code).toBe('SKU_ALREADY_EXISTS');
    expect(err.error.details?.sku).toBe(sku);
    expect(err.error.details?.conflicting_variant_id).toBe(firstId);
  });

  it('enforces SKU uniqueness across DIFFERENT products, not just within one', async () => {
    const a = await createProduct({ title: 'Product A', status: 'active' });
    const b = await createProduct({ title: 'Product B', status: 'active' });
    const sku = uniqueSku();
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${a.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku, title: 'A', price_cents: 100 },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${b.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku, title: 'B', price_cents: 100 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('survives concurrent creates of the same SKU with exactly one winner', async () => {
    // The reason uniqueness is a database constraint rather than a SELECT before INSERT: a
    // pre-check has a race window that a single-threaded test would never expose.
    const product = await createProduct({ title: 'Race host', status: 'active' });
    const sku = uniqueSku();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        h.app.inject({
          method: 'POST',
          url: `/api/v1/products/${product.body.data.id}/variants`,
          headers: { authorization: auth },
          payload: { sku, title: `Racer ${i}`, price_cents: 100 + i },
        }),
      ),
    );
    const created = attempts.filter((r) => r.statusCode === 201);
    const conflicted = attempts.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);

    const rows = await h.db.selectFrom('variants').select('id').where('sku', '=', sku).execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects changing a SKU to one already in use', async () => {
    const product = await createProduct({ title: 'Rename host', status: 'active' });
    const takenSku = uniqueSku();
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: takenSku, title: 'Taken', price_cents: 100 },
    });
    const mine = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: uniqueSku(), title: 'Mine', price_cents: 100 },
    });
    const mineId = json<{ data: VariantResource }>(mine.body).data.id;

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/variants/${mineId}`,
      headers: { authorization: auth },
      payload: { sku: takenSku },
    });
    expect(res.statusCode).toBe(409);
  });

  it('creates a variant of an archived product in the archived state', async () => {
    const product = await createProduct({ title: 'Archived host', status: 'archived' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: uniqueSku(), title: 'On an archived product', price_cents: 100 },
    });
    expect(res.statusCode).toBe(201);
    const variant = json<{ data: VariantResource }>(res.body).data;
    expect(variant.status).toBe('archived');
    expect(variant.archived_at).not.toBeNull();
  });
});

describe('DELETE archives rather than destroys', () => {
  it('archives a product, sets archived_at, and returns 200 with the record', async () => {
    const created = await createProduct({ title: 'To archive', status: 'active' });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const archived = json<{ data: ProductResource }>(res.body).data;
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).not.toBeNull();

    // The row is still there. That is the whole point.
    const row = await h.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', created.body.data.id)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.status).toBe('archived');
  });

  it('is idempotent — archiving twice is 200 both times, never 409', async () => {
    const created = await createProduct({ title: 'Archive twice', status: 'active' });
    const first = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
    });
    const second = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(json<{ data: ProductResource }>(second.body).data.status).toBe('archived');
  });

  it('keeps an archived product retrievable', async () => {
    const created = await createProduct({ title: 'Still readable', status: 'active' });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${created.body.data.id}`,
      headers: { authorization: auth },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/products/${created.body.data.id}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('cascades the archive to every variant of the product', async () => {
    const product = await createProduct({ title: 'Cascade host', status: 'active' });
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/products/${product.body.data.id}/variants`,
        headers: { authorization: auth },
        payload: { sku: uniqueSku(), title: `V${i}`, price_cents: 100 },
      });
    }
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${product.body.data.id}`,
      headers: { authorization: auth },
    });

    const rows = await h.db
      .selectFrom('variants')
      .selectAll()
      .where('product_id', '=', product.body.data.id)
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.every((v) => v.status === 'archived' && v.archived_at !== null)).toBe(true);
  });

  it('un-archives the variants when a product is moved back to active', async () => {
    const product = await createProduct({ title: 'Unarchive host', status: 'active' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: uniqueSku(), title: 'V', price_cents: 100 },
    });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${product.body.data.id}`,
      headers: { authorization: auth },
    });

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${product.body.data.id}`,
      headers: { authorization: auth },
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ data: ProductResource }>(res.body).data.archived_at).toBeNull();

    const rows = await h.db
      .selectFrom('variants')
      .selectAll()
      .where('product_id', '=', product.body.data.id)
      .execute();
    expect(rows.every((v) => v.status === 'active' && v.archived_at === null)).toBe(true);
  });

  it('archives a single variant without touching its siblings', async () => {
    const product = await createProduct({ title: 'Single variant archive', status: 'active' });
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: uniqueSku(), title: 'Target', price_cents: 100 },
    });
    const sibling = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.body.data.id}/variants`,
      headers: { authorization: auth },
      payload: { sku: uniqueSku(), title: 'Sibling', price_cents: 100 },
    });
    const targetId = json<{ data: VariantResource }>(created.body).data.id;
    const siblingId = json<{ data: VariantResource }>(sibling.body).data.id;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/variants/${targetId}`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ data: VariantResource }>(res.body).data.status).toBe('archived');

    const siblingRow = await h.db
      .selectFrom('variants')
      .selectAll()
      .where('id', '=', siblingId)
      .executeTakeFirst();
    expect(siblingRow?.status).toBe('active');
  });
});
