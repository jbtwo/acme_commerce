/**
 * Inventory over HTTP.
 *
 * The concurrency test is the one that matters. Everything else here would also pass against
 * a naive read-check-write implementation; only firing simultaneous reservations at the last
 * few units distinguishes a correct implementation from one that oversells under load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestHarness,
  json,
  type ApiError,
  type TestHarness,
} from '../helpers/app.js';

let h: TestHarness;
let auth: string;
let toronto: string;
let vancouver: string;

interface Level {
  sku: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  available: number;
}
interface Reservation {
  id: string;
  sku: string;
  quantity: number;
  status: string;
  expires_at: string;
}

beforeAll(async () => {
  h = await createTestHarness();
  auth = await bearer(h, 'developer');
  const locs = json<{ data: { id: string; name: string }[] }>(
    (
      await h.app.inject({
        method: 'GET',
        url: '/api/v1/locations?limit=100',
        headers: { authorization: auth },
      })
    ).body,
  ).data;
  toronto = locs.find((l) => l.name === 'Toronto Warehouse')!.id;
  vancouver = locs.find((l) => l.name === 'Vancouver Warehouse')!.id;
});
afterAll(async () => {
  await h?.close();
});

const get = async (url: string) =>
  h.app.inject({ method: 'GET', url, headers: { authorization: auth } });
const post = async (url: string, payload?: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url,
    headers: { authorization: auth },
    ...(payload ? { payload } : {}),
  });

const skuInventory = async (sku: string) =>
  json<{
    data: { totals: { on_hand: number; reserved: number; available: number }; locations: Level[] };
  }>((await get(`/api/v1/inventory/${sku}`)).body).data;

describe('reading levels', () => {
  it('lists seeded stock with computed availability', async () => {
    const res = await get('/api/v1/inventory?limit=100');
    expect(res.statusCode).toBe(200);
    const body = json<{ data: Level[]; pagination: { total: number } }>(res.body);
    expect(body.pagination.total).toBeGreaterThan(40);
    for (const l of body.data) expect(l.available).toBe(l.on_hand - l.reserved);
  });

  it('filters to low stock on the COMPUTED value, not on_hand', async () => {
    const res = await get('/api/v1/inventory?available_below=5&limit=100');
    const body = json<{ data: Level[] }>(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((l) => l.on_hand - l.reserved < 5)).toBe(true);
  });

  it('counts fully-reserved stock as unavailable', async () => {
    // 15 on hand at Vancouver; reserve all of it and it should appear in available_below=1.
    await post('/api/v1/inventory/reservations', {
      sku: 'CSC-RUN-M09',
      location_id: vancouver,
      quantity: 15,
    });
    const res = await get('/api/v1/inventory?available_below=1&sku=CSC-RUN-M09&limit=10');
    const body = json<{ data: Level[] }>(res.body);
    expect(
      body.data.some((l) => l.sku === 'CSC-RUN-M09' && l.on_hand > 0 && l.available === 0),
    ).toBe(true);
  });

  it('filters by location and by sku', async () => {
    const byLoc = json<{ data: Level[] }>(
      (await get(`/api/v1/inventory?location_id=${toronto}&limit=100`)).body,
    );
    expect(byLoc.data.every((l) => l.location_id === toronto)).toBe(true);
    const bySku = json<{ data: Level[] }>((await get('/api/v1/inventory?sku=ACME-BAG-BLK')).body);
    expect(bySku.data.every((l) => l.sku === 'ACME-BAG-BLK')).toBe(true);
    expect(bySku.data.length).toBe(3);
  });

  it('returns per-location breakdown and totals for one SKU', async () => {
    const d = await skuInventory('ACME-BAG-BLK');
    expect(d.locations.length).toBe(3);
    expect(d.totals.on_hand).toBe(d.locations.reduce((n, l) => n + l.on_hand, 0));
    expect(d.totals.available).toBe(d.totals.on_hand - d.totals.reserved);
  });

  it('omits locations where the SKU has never been stocked, rather than reporting zero', async () => {
    const d = await skuInventory('SUM-PACK45-GRY-S');
    expect(d.locations).toHaveLength(1);
  });

  it('distinguishes an unknown SKU from an untracked one', async () => {
    const unknown = await get('/api/v1/inventory/NO-SUCH-SKU');
    expect(unknown.statusCode).toBe(404);
    expect(json<ApiError>(unknown.body).error.code).toBe('VARIANT_NOT_FOUND');

    // CSC-ANRK-YEL-M is a real variant with no inventory item seeded.
    const untracked = await get('/api/v1/inventory/CSC-ANRK-YEL-M');
    expect(untracked.statusCode).toBe(404);
    expect(json<ApiError>(untracked.body).error.code).toBe('INVENTORY_ITEM_NOT_FOUND');
  });
});

describe('adjustments', () => {
  it('adds stock and records who did it', async () => {
    const before = (await skuInventory('ACME-LAMP-350')).totals.on_hand;
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'ACME-LAMP-350',
      location_id: toronto,
      quantity_delta: 25,
      reason: 'received',
      reference: 'PO-4471',
    });
    expect(res.statusCode).toBe(201);
    const d = json<{ data: { adjustment: { actor: string; reason: string }; level: Level } }>(
      res.body,
    ).data;
    // Actor comes from the token, never the body.
    expect(d.adjustment.actor).toBe('dev@acme.example');
    expect(d.level.on_hand).toBe(before + 25);
  });

  it('removes stock', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'ACME-LAMP-350',
      location_id: toronto,
      quantity_delta: -5,
      reason: 'damaged',
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses to drive on_hand below zero', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'ACME-LAMP-350',
      location_id: toronto,
      quantity_delta: -99999,
      reason: 'correction',
    });
    expect(res.statusCode).toBe(409);
    const err = json<ApiError>(res.body).error;
    expect(err.code).toBe('INVENTORY_INSUFFICIENT');
    expect(err.details?.on_hand).toBeTypeOf('number');
  });

  it('refuses to drive on_hand below what is already reserved', async () => {
    await post('/api/v1/inventory/adjustments', {
      sku: 'NWT-TOQUE-FOR',
      location_id: toronto,
      quantity_delta: 10,
      reason: 'received',
    });
    await post('/api/v1/inventory/reservations', {
      sku: 'NWT-TOQUE-FOR',
      location_id: toronto,
      quantity: 8,
    });
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'NWT-TOQUE-FOR',
      location_id: toronto,
      quantity_delta: -5,
      reason: 'damaged',
    });
    expect(res.statusCode).toBe(409);
    expect(json<ApiError>(res.body).error.message).toMatch(/already reserved/);
  });

  it('creates a level row for a location with no stock yet', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'SUM-PACK45-GRY-S',
      location_id: vancouver,
      quantity_delta: 6,
      reason: 'transfer_in',
    });
    expect(res.statusCode).toBe(201);
    expect((await skuInventory('SUM-PACK45-GRY-S')).locations).toHaveLength(2);
  });

  it.each([
    ['zero delta', { quantity_delta: 0, reason: 'correction' }],
    ['unknown reason', { quantity_delta: 1, reason: 'shrinkage' }],
    ['missing reason', { quantity_delta: 1 }],
  ])('rejects %s', async (_l, extra) => {
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'ACME-LAMP-350',
      location_id: toronto,
      ...extra,
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s on an unknown location', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      sku: 'ACME-LAMP-350',
      location_id: 'loc_00000000000000000000dead',
      quantity_delta: 1,
      reason: 'received',
    });
    expect(res.statusCode).toBe(404);
    expect(json<ApiError>(res.body).error.code).toBe('LOCATION_NOT_FOUND');
  });

  it('appends to the audit log, and the deltas reconcile with the level', async () => {
    const sku = 'ACME-BTL-500-BLK';
    const before = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === toronto,
    )!.on_hand;
    for (const delta of [10, -3, 5]) {
      await post('/api/v1/inventory/adjustments', {
        sku,
        location_id: toronto,
        quantity_delta: delta,
        reason: 'correction',
      });
    }
    const after = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === toronto,
    )!.on_hand;
    expect(after).toBe(before + 12);

    const hist = json<{ data: { quantity_delta: number }[] }>(
      (await get(`/api/v1/inventory/history?sku=${sku}&location_id=${toronto}&limit=100`)).body,
    );
    expect(hist.data.reduce((n, a) => n + a.quantity_delta, 0)).toBe(after - before);
  });

  it('returns history newest first and filters by reason', async () => {
    const res = await get('/api/v1/inventory/history?reason=damaged&limit=50');
    expect(res.statusCode).toBe(200);
    const body = json<{ data: { reason: string; created_at: string }[] }>(res.body);
    expect(body.data.every((a) => a.reason === 'damaged')).toBe(true);
    const times = body.data.map((a) => Date.parse(a.created_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('reservations', () => {
  it('holds stock and reduces availability without touching on_hand', async () => {
    const sku = 'ACME-BTL-750-WHT';
    const before = (await skuInventory(sku)).locations.find((l) => l.location_id === vancouver)!;
    const res = await post('/api/v1/inventory/reservations', {
      sku,
      location_id: vancouver,
      quantity: 4,
      reference: 'cart_9931',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toMatch(/^\/api\/v1\/inventory\/reservations\/invres_/);

    const after = (await skuInventory(sku)).locations.find((l) => l.location_id === vancouver)!;
    expect(after.on_hand).toBe(before.on_hand);
    expect(after.reserved).toBe(before.reserved + 4);
    expect(after.available).toBe(before.available - 4);
  });

  it('refuses more than is available, and says how much there is', async () => {
    const res = await post('/api/v1/inventory/reservations', {
      sku: 'NWT-PAN-20-YEL',
      location_id: toronto,
      quantity: 500,
    });
    expect(res.statusCode).toBe(409);
    const err = json<ApiError>(res.body).error;
    expect(err.code).toBe('INVENTORY_INSUFFICIENT');
    expect(err.details?.requested).toBe(500);
    expect(err.details?.available).toBeTypeOf('number');
  });

  it('lets exactly one of many simultaneous callers take the last unit', async () => {
    // BBW-CRUISE-56 has 1 unit at Barrie. Ten callers, one winner — enforced by
    // CHECK (reserved <= on_hand), not by an application-level read-then-write.
    const locs = json<{ data: { id: string; name: string }[] }>(
      (await get('/api/v1/locations?limit=100')).body,
    ).data;
    const barrie = locs.find((l) => l.name === 'Barrie Retail Location')!.id;

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/v1/inventory/reservations', {
          sku: 'BBW-CRUISE-56',
          location_id: barrie,
          quantity: 1,
        }),
      ),
    );
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(9);

    const d = await skuInventory('BBW-CRUISE-56');
    const level = d.locations.find((l) => l.location_id === barrie)!;
    expect(level.reserved).toBe(1);
    expect(level.available).toBe(0);
  });

  it('never lets concurrent partial reservations oversell', async () => {
    // 3 units, six callers wanting 1 each: at most three can win, and reserved must equal
    // exactly the number that did.
    const locs = json<{ data: { id: string; name: string }[] }>(
      (await get('/api/v1/locations?limit=100')).body,
    ).data;
    const barrie = locs.find((l) => l.name === 'Barrie Retail Location')!.id;
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        post('/api/v1/inventory/reservations', {
          sku: 'BBW-CRUISE-52',
          location_id: barrie,
          quantity: 1,
        }),
      ),
    );
    const won = attempts.filter((r) => r.statusCode === 201).length;
    expect(won).toBe(3);
    // The losers must be told why, not handed a 500.
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(6 - won);
    const level = (await skuInventory('BBW-CRUISE-52')).locations.find(
      (l) => l.location_id === barrie,
    )!;
    expect(level.reserved).toBe(won);
    expect(level.available).toBe(0);
  });

  it('retrieves a reservation', async () => {
    const created = await post('/api/v1/inventory/reservations', {
      sku: 'ACME-BAG-OLV',
      location_id: toronto,
      quantity: 2,
    });
    const id = json<{ data: Reservation }>(created.body).data.id;
    const res = await get(`/api/v1/inventory/reservations/${id}`);
    expect(res.statusCode).toBe(200);
    expect(json<{ data: Reservation }>(res.body).data.status).toBe('active');
  });

  it('releases stock back, and is idempotent', async () => {
    const sku = 'ACME-BAG-OLV';
    const created = await post('/api/v1/inventory/reservations', {
      sku,
      location_id: vancouver,
      quantity: 3,
    });
    const id = json<{ data: Reservation }>(created.body).data.id;
    const held = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === vancouver,
    )!.reserved;

    const first = await post(`/api/v1/inventory/reservations/${id}/release`);
    expect(first.statusCode).toBe(200);
    expect(json<{ data: Reservation }>(first.body).data.status).toBe('released');

    const second = await post(`/api/v1/inventory/reservations/${id}/release`);
    expect(second.statusCode).toBe(200);
    expect(json<{ data: Reservation }>(second.body).data.status).toBe('released');

    const after = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === vancouver,
    )!.reserved;
    // Released once, not twice — a double release must not credit the stock twice.
    expect(after).toBe(held - 3);
  });

  it('reports a lapsed hold as expired, and sweeps its stock back on the next attempt', async () => {
    const sku = 'ACME-BAG-DWN-REG';
    const before = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === toronto,
    )!.available;

    const created = await post('/api/v1/inventory/reservations', {
      sku,
      location_id: toronto,
      quantity: 5,
      ttl_seconds: 60,
    });
    const id = json<{ data: Reservation }>(created.body).data.id;

    // Reach past the API to age it, which is the only way to test expiry without waiting.
    await h.db
      .updateTable('inventory_reservations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', id)
      .execute();

    const read = await get(`/api/v1/inventory/reservations/${id}`);
    expect(json<{ data: Reservation }>(read.body).data.status).toBe('expired');

    // The sweep runs inside the next reservation attempt for the same SKU and location.
    await post('/api/v1/inventory/reservations', { sku, location_id: toronto, quantity: 1 });
    const after = (await skuInventory(sku)).locations.find(
      (l) => l.location_id === toronto,
    )!.available;
    expect(after).toBe(before - 1);
  });

  it('refuses to release an expired reservation', async () => {
    const created = await post('/api/v1/inventory/reservations', {
      sku: 'ACME-BAG-DWN-REG',
      location_id: toronto,
      quantity: 1,
      ttl_seconds: 60,
    });
    const id = json<{ data: Reservation }>(created.body).data.id;
    await h.db
      .updateTable('inventory_reservations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', id)
      .execute();
    // Sweep it, so it is genuinely expired rather than merely lapsed.
    await post('/api/v1/inventory/reservations', {
      sku: 'ACME-BAG-DWN-REG',
      location_id: toronto,
      quantity: 1,
    });

    const res = await post(`/api/v1/inventory/reservations/${id}/release`);
    expect(res.statusCode).toBe(409);
    expect(json<ApiError>(res.body).error.code).toBe('RESERVATION_NOT_ACTIVE');
  });

  it('404s and 400s on reservation identifiers', async () => {
    const absent = await get('/api/v1/inventory/reservations/invres_00000000000000000000dead');
    expect(absent.statusCode).toBe(404);
    expect(json<ApiError>(absent.body).error.code).toBe('RESERVATION_NOT_FOUND');

    const malformed = await get('/api/v1/inventory/reservations/nope');
    expect(malformed.statusCode).toBe(400);
    expect(json<ApiError>(malformed.body).error.code).toBe('MALFORMED_ID');
  });
});
