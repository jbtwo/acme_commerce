import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestHarness,
  json,
  type ApiError,
  type TestHarness,
} from '../helpers/app.js';
import type { LocationResource } from '../../src/domain/locations/schemas.js';

let h: TestHarness;
let auth: string;

beforeAll(async () => {
  h = await createTestHarness();
  auth = await bearer(h, 'developer');
});
afterAll(async () => {
  await h?.close();
});

interface ListBody {
  data: LocationResource[];
  pagination: { page: number; limit: number; total: number; total_pages: number };
}

const list = async (query = ''): Promise<ListBody> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/locations${query}`,
    headers: { authorization: auth },
  });
  expect(res.statusCode).toBe(200);
  return json<ListBody>(res.body);
};

let counter = 0;
const uniqueName = () => `Test Location ${Date.now()}-${(counter += 1)}`;

const create = async (body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: { authorization: auth },
    payload: body,
  });

describe('seeded locations', () => {
  it('has the three documented locations', async () => {
    const body = await list('?limit=100');
    const names = body.data.map((l) => l.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Toronto Warehouse',
        'Vancouver Warehouse',
        'Barrie Retail Location',
      ]),
    );
  });

  it('gives them the same deterministic ids in every environment', async () => {
    const body = await list('?q=Toronto');
    expect(body.data[0]?.id).toMatch(/^loc_[0-9a-f]{24}$/);
    // Derived from a hash of the handle, so this id is identical on any machine that seeds.
    const again = await list('?q=Toronto');
    expect(again.data[0]?.id).toBe(body.data[0]?.id);
  });
});

describe('listing', () => {
  it('paginates with the same envelope as every other collection', async () => {
    const body = await list('?limit=2&page=1');
    expect(body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it('filters by type', async () => {
    const body = await list('?type=retail');
    expect(body.data.every((l) => l.type === 'retail')).toBe(true);
    expect(body.pagination.total).toBeGreaterThan(0);
  });

  it('searches name and city', async () => {
    expect((await list('?q=Vancouver')).pagination.total).toBeGreaterThan(0);
    expect((await list('?q=Barrie')).pagination.total).toBeGreaterThan(0);
  });

  it('returns 200 with an empty page when nothing matches', async () => {
    const body = await list('?q=zzzznowhere');
    expect(body.data).toEqual([]);
    expect(body.pagination.total_pages).toBe(0);
  });

  it('sorts by an allowlisted field and rejects anything else', async () => {
    const body = await list('?sort=name&order=asc&limit=100');
    const names = body.data.map((l) => l.name);
    expect(names).toEqual([...names].sort());

    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/v1/locations?sort=password',
      headers: { authorization: auth },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns both active and retired locations with no is_active filter', async () => {
    const created = await create({ name: uniqueName(), type: 'virtual', is_active: false });
    const id = json<{ data: LocationResource }>(created.body).data.id;
    const all = await list('?limit=100');
    expect(all.data.some((l) => l.id === id)).toBe(true);
    const activeOnly = await list('?is_active=true&limit=100');
    expect(activeOnly.data.some((l) => l.id === id)).toBe(false);
  });
});

describe('creating', () => {
  it('creates with 201 and a Location header', async () => {
    const name = uniqueName();
    const res = await create({
      name,
      type: 'warehouse',
      address_line1: '1 Test Way',
      city: 'Toronto',
      region: 'ON',
      postal_code: 'M1M 1M1',
      country: 'CA',
    });
    expect(res.statusCode).toBe(201);
    const loc = json<{ data: LocationResource }>(res.body).data;
    expect(loc.id).toMatch(/^loc_[0-9a-f]{24}$/);
    expect(loc.is_active).toBe(true);
    expect(res.headers.location).toBe(`/api/v1/locations/${loc.id}`);
  });

  it('allows a virtual location with no address', async () => {
    const res = await create({ name: uniqueName(), type: 'virtual' });
    expect(res.statusCode).toBe(201);
    expect(json<{ data: LocationResource }>(res.body).data.address_line1).toBeNull();
  });

  it('rejects a duplicate name case-insensitively', async () => {
    const name = uniqueName();
    expect((await create({ name, type: 'warehouse' })).statusCode).toBe(201);
    const dup = await create({ name: name.toUpperCase(), type: 'retail' });
    expect(dup.statusCode).toBe(409);
    const err = json<ApiError>(dup.body).error;
    expect(err.code).toBe('LOCATION_NAME_EXISTS');
    expect(err.details?.conflicting_location_id).toMatch(/^loc_/);
  });

  it('survives concurrent creates of the same name with exactly one winner', async () => {
    // Enforced by a unique index rather than a pre-check, so there is no race window.
    const name = uniqueName();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => create({ name, type: 'warehouse' })),
    );
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(5);
  });

  it.each([
    ['unknown type', { name: 'x', type: 'spaceport' }],
    ['missing name', { type: 'warehouse' }],
    ['lowercase country', { name: 'x', type: 'warehouse', country: 'ca' }],
    ['unknown property', { name: 'x', type: 'warehouse', nickname: 'y' }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await create(payload);
    expect(res.statusCode).toBe(400);
  });
});

describe('updating', () => {
  it('patches only what was sent', async () => {
    const created = await create({ name: uniqueName(), type: 'warehouse', city: 'Toronto' });
    const id = json<{ data: LocationResource }>(created.body).data.id;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${id}`,
      headers: { authorization: auth },
      payload: { region: 'ON' },
    });
    expect(res.statusCode).toBe(200);
    const loc = json<{ data: LocationResource }>(res.body).data;
    expect(loc.region).toBe('ON');
    expect(loc.city).toBe('Toronto');
  });

  it('clears a nullable field with an explicit null', async () => {
    const created = await create({ name: uniqueName(), type: 'retail', city: 'Barrie' });
    const id = json<{ data: LocationResource }>(created.body).data.id;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${id}`,
      headers: { authorization: auth },
      payload: { city: null },
    });
    expect(json<{ data: LocationResource }>(res.body).data.city).toBeNull();
  });

  it('retires a location with is_active false, since there is no DELETE', async () => {
    const created = await create({ name: uniqueName(), type: 'warehouse' });
    const id = json<{ data: LocationResource }>(created.body).data.id;
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${id}`,
      headers: { authorization: auth },
      payload: { is_active: false },
    });
    expect(json<{ data: LocationResource }>(res.body).data.is_active).toBe(false);
  });

  it('has no DELETE route at all', async () => {
    const created = await create({ name: uniqueName(), type: 'warehouse' });
    const id = json<{ data: LocationResource }>(created.body).data.id;
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${id}`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    expect(json<ApiError>(res.body).error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('identifier errors', () => {
  it('400 for a malformed id, 404 for a well-formed absent one', async () => {
    const malformed = await h.app.inject({
      method: 'GET',
      url: '/api/v1/locations/loc_nope',
      headers: { authorization: auth },
    });
    expect(malformed.statusCode).toBe(400);
    expect(json<ApiError>(malformed.body).error.code).toBe('MALFORMED_ID');

    const absent = await h.app.inject({
      method: 'GET',
      url: '/api/v1/locations/loc_00000000000000000000dead',
      headers: { authorization: auth },
    });
    expect(absent.statusCode).toBe(404);
    expect(json<ApiError>(absent.body).error.code).toBe('LOCATION_NOT_FOUND');
  });
});
