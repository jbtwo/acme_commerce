/**
 * Collection endpoint behaviour: pagination, filtering, search, sorting, ordering stability.
 *
 * These run against the real seeded catalog in PostgreSQL, because every one of them is a
 * statement about SQL. A fake repository would happily agree with whatever the test expected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, json, type TestHarness } from '../helpers/app.js';
import type { ProductResource } from '../../src/domain/catalog/schemas.js';

interface ListBody {
  data: ProductResource[];
  pagination: { page: number; limit: number; total: number; total_pages: number };
}

let h: TestHarness;
const list = async (query = ''): Promise<{ status: number; body: ListBody }> => {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/products${query}` });
  return { status: res.statusCode, body: json<ListBody>(res.body) };
};

beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('pagination', () => {
  it('returns the whole seeded catalog on the default page', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.pagination).toEqual({ page: 1, limit: 25, total: 20, total_pages: 1 });
    expect(body.data).toHaveLength(20);
  });

  it('honours page and limit and reports the correct page count', async () => {
    const { body } = await list('?page=2&limit=7');
    expect(body.pagination).toEqual({ page: 2, limit: 7, total: 20, total_pages: 3 });
    expect(body.data).toHaveLength(7);
  });

  it('returns a short final page rather than padding it', async () => {
    const { body } = await list('?page=3&limit=7');
    expect(body.data).toHaveLength(6);
  });

  it('returns 200 with an empty array past the end, not 404', async () => {
    const { status, body } = await list('?page=99&limit=25');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    // The total still describes the whole matching set, not the empty page.
    expect(body.pagination.total).toBe(20);
  });

  it('does not repeat or skip a record across consecutive pages', async () => {
    const p1 = await list('?page=1&limit=6&sort=created_at&order=desc');
    const p2 = await list('?page=2&limit=6&sort=created_at&order=desc');
    const p3 = await list('?page=3&limit=6&sort=created_at&order=desc');
    const p4 = await list('?page=4&limit=6&sort=created_at&order=desc');
    const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data, ...p4.body.data].map(
      (p) => p.id,
    );
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });
});

describe('filtering', () => {
  it('filters by status and returns nothing of another status', async () => {
    const { body } = await list('?status=active');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((p) => p.status === 'active')).toBe(true);
    expect(body.pagination.total).toBe(body.data.length);
  });

  it('returns products of ALL statuses when no status filter is given', async () => {
    // The deliberate design choice: no hidden default filter. Archived products are visible
    // unless you exclude them, so DELETE is observable as a state change.
    const { body } = await list();
    const statuses = new Set(body.data.map((p) => p.status));
    expect(statuses.has('active')).toBe(true);
    expect(statuses.has('draft')).toBe(true);
    expect(statuses.has('archived')).toBe(true);
  });

  it('matches vendor case-insensitively but exactly', async () => {
    const lower = await list('?vendor=acme');
    const upper = await list('?vendor=ACME');
    expect(lower.body.pagination.total).toBeGreaterThan(0);
    expect(upper.body.pagination.total).toBe(lower.body.pagination.total);
    expect(lower.body.data.every((p) => p.vendor?.toLowerCase() === 'acme')).toBe(true);
  });

  it('does not treat the vendor filter as a prefix', async () => {
    // "Acme" must not match a vendor merely beginning with those letters.
    const { body } = await list('?vendor=Ac');
    expect(body.pagination.total).toBe(0);
  });

  it('filters by product_type case-insensitively', async () => {
    const { body } = await list('?product_type=backpacks');
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.data.every((p) => p.product_type === 'Backpacks')).toBe(true);
  });

  it('filters by tag using array containment', async () => {
    const { body } = await list('?tag=bestseller');
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.data.every((p) => p.tags.includes('bestseller'))).toBe(true);
  });

  it('combines filters with AND, never OR', async () => {
    const { body } = await list('?vendor=Acme&status=active&product_type=Backpacks');
    expect(
      body.data.every(
        (p) => p.vendor === 'Acme' && p.status === 'active' && p.product_type === 'Backpacks',
      ),
    ).toBe(true);
    const vendorOnly = await list('?vendor=Acme');
    expect(body.pagination.total).toBeLessThan(vendorOnly.body.pagination.total);
  });

  it('reports total as the size of the filtered set, not the whole table', async () => {
    const filtered = await list('?status=draft');
    const all = await list();
    expect(filtered.body.pagination.total).toBeLessThan(all.body.pagination.total);
    expect(filtered.body.pagination.total).toBe(filtered.body.data.length);
  });
});

describe('search', () => {
  it('matches a substring of the title, case-insensitively', async () => {
    const { body } = await list('?q=BACKPACK');
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.data.some((p) => p.title.toLowerCase().includes('backpack'))).toBe(true);
  });

  it('searches the description as well as the title', async () => {
    const { body } = await list('?q=hydration');
    expect(body.pagination.total).toBeGreaterThan(0);
  });

  it('searches the vendor', async () => {
    const { body } = await list('?q=Northwind');
    expect(body.pagination.total).toBeGreaterThan(0);
  });

  it('returns an empty page for no matches, with total_pages 0', async () => {
    const { status, body } = await list('?q=zzzznotathinginthecatalog');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.total_pages).toBe(0);
  });

  it('treats % as a literal character, not a wildcard', async () => {
    // Without LIKE-escaping, this would match every product.
    const { body } = await list('?q=%25');
    expect(body.pagination.total).toBe(0);
  });

  it('treats _ as a literal character, not a single-character wildcard', async () => {
    const { body } = await list('?q=a_e');
    expect(body.pagination.total).toBe(0);
  });

  it('combines search with filters', async () => {
    const { body } = await list('?q=backpack&vendor=Acme&status=active');
    expect(body.data.every((p) => p.vendor === 'Acme' && p.status === 'active')).toBe(true);
  });
});

describe('sorting', () => {
  it('sorts by title ascending', async () => {
    const { body } = await list('?sort=title&order=asc&limit=100');
    const titles = body.data.map((p) => p.title);
    expect(titles).toEqual([...titles].sort());
  });

  it('sorts by title descending', async () => {
    const { body } = await list('?sort=title&order=desc&limit=100');
    const titles = body.data.map((p) => p.title);
    expect(titles).toEqual([...titles].sort().reverse());
  });

  it('defaults to created_at descending — newest first', async () => {
    const { body } = await list('?limit=100');
    const times = body.data.map((p) => Date.parse(p.created_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('sorts by created_at ascending when asked', async () => {
    const { body } = await list('?sort=created_at&order=asc&limit=100');
    const times = body.data.map((p) => Date.parse(p.created_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('produces a stable order for a heavily tied sort key', async () => {
    // `status` has only three distinct values across 20 products, so almost every row is tied.
    // Without the `id` tiebreaker in the ORDER BY, PostgreSQL may return tied rows in a
    // different order between two identical queries — and paging would then skip and repeat.
    const first = await list('?sort=status&order=asc&limit=100');
    const second = await list('?sort=status&order=asc&limit=100');
    expect(first.body.data.map((p) => p.id)).toEqual(second.body.data.map((p) => p.id));
  });

  it('pages a tied sort without overlap or omission', async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const { body } = await list(`?sort=status&order=asc&limit=5&page=${page}`);
      ids.push(...body.data.map((p) => p.id));
    }
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('applies the sort direction to the tiebreaker too', async () => {
    const asc = await list('?sort=status&order=asc&limit=100');
    const desc = await list('?sort=status&order=desc&limit=100');
    expect(asc.body.data.map((p) => p.id)).toEqual(desc.body.data.map((p) => p.id).reverse());
  });
});

describe('single resource reads', () => {
  it('retrieves a product by id', async () => {
    const { body } = await list('?limit=1');
    const target = body.data[0]!;
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/products/${target.id}` });
    expect(res.statusCode).toBe(200);
    expect(json<{ data: ProductResource }>(res.body).data.id).toBe(target.id);
  });

  it("lists a product's variants ordered by position", async () => {
    const products = await list('?q=Trailhead');
    const productId = products.body.data[0]!.id;
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/variants`,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ data: { position: number; sku: string }[] }>(res.body);
    expect(body.data.length).toBeGreaterThan(1);
    expect(body.data.map((v) => v.position)).toEqual(
      [...body.data.map((v) => v.position)].sort((a, b) => a - b),
    );
    // A sub-collection response carries no pagination object, and that is documented.
    expect(body).not.toHaveProperty('pagination');
  });

  it('returns 404 for the variants of a product that does not exist, not an empty list', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/products/prod_00000000000000000000dead/variants',
    });
    expect(res.statusCode).toBe(404);
  });
});
