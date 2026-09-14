import type { FastifyInstance } from 'fastify';
import { collection, resource } from '../../http/envelope.js';
import { protectedBy } from '../../http/authorize.js';
import * as service from './service.js';
import {
  HistoryQuery,
  InventoryListQuery,
  ReservationIdParams,
  SkuParams,
  type AdjustmentRequestInput,
  type HistoryQueryType,
  type InventoryListQueryType,
  type ReservationIdParamsType,
  type ReservationRequestInput,
  type SkuParamsType,
} from './schemas.js';

const ref = (id: string) => ({ $ref: `${id}#` });
const TAG = 'Inventory';
const security = [{ bearerAuth: [] }];

function errorResponses(extra: Record<number, string> = {}): Record<number, unknown> {
  const base: Record<number, string> = {
    400: 'The request is malformed (`VALIDATION_ERROR` or `MALFORMED_ID`).',
    401: 'Missing, malformed, invalid, or expired bearer token.',
    403: 'Authenticated, but your role lacks the required permission.',
    ...extra,
    500: 'An unexpected server error.',
    503: 'The database is unreachable. Safe to retry.',
  };
  return Object.fromEntries(
    Object.entries(base).map(([s, description]) => [s, { ...ref('Error'), description }]),
  );
}

const NOT_FOUND_SKU =
  'Either no such SKU exists in the catalog (`VARIANT_NOT_FOUND`) or it exists but is not ' +
  'inventory-tracked (`INVENTORY_ITEM_NOT_FOUND`). Deliberately distinct — they need different fixes.';

export async function registerInventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: InventoryListQueryType }>(
    '/inventory',
    {
      onRequest: protectedBy(app, 'inventory:read'),
      schema: {
        operationId: 'listInventory',
        summary: 'List stock levels',
        description: [
          'Paginated stock levels across SKUs and locations.',
          '',
          '`available` is `on_hand - reserved`, **computed at read time**. There is no stored',
          'availability column, because a third stored number is the first thing to disagree',
          'with the other two.',
          '',
          '`?available_below=5` is the low-stock query — it filters on the computed value, not',
          'on `on_hand`, so stock that is physically present but entirely reserved correctly',
          'counts as unavailable.',
        ].join('\n'),
        tags: [TAG],
        security,
        querystring: InventoryListQuery,
        response: {
          200: { ...ref('InventoryListResponse'), description: 'A page of stock levels.' },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const r = await service.listInventory(app.db, request.query);
      return collection(r.levels, { page: r.page, limit: r.limit, total: r.total });
    },
  );

  // Registered before `/inventory/:sku` so the literal paths win the route match.
  app.get<{ Querystring: HistoryQueryType }>(
    '/inventory/history',
    {
      onRequest: protectedBy(app, 'inventory:read'),
      schema: {
        operationId: 'listInventoryHistory',
        summary: 'Retrieve the stock audit log',
        description: [
          'Every adjustment ever made, newest first, filterable by SKU, location, reason, and',
          'date range.',
          '',
          'The log is **append-only**: entries are never updated and never deleted. That is what',
          'makes it an audit log rather than a cache of current belief — the sum of the deltas',
          'for a SKU and location reconciles with its `on_hand`.',
          '',
          'Note that seeded fixture stock has no history. Fabricating adjustments for data that',
          'was never adjusted would make the log a worse record.',
        ].join('\n'),
        tags: [TAG],
        security,
        querystring: HistoryQuery,
        response: {
          200: { ...ref('HistoryResponse'), description: 'A page of adjustments.' },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const r = await service.listHistory(app.db, request.query);
      return collection(r.adjustments, { page: r.page, limit: r.limit, total: r.total });
    },
  );

  app.post<{ Body: AdjustmentRequestInput }>(
    '/inventory/adjustments',
    {
      onRequest: protectedBy(app, 'inventory:write'),
      schema: {
        operationId: 'createInventoryAdjustment',
        summary: 'Increase, decrease, or correct stock',
        description: [
          'Applies a signed change to one SKU at one location and records it in the audit log.',
          '',
          '`actor` is taken from your bearer token, never from the request body. An audit log a',
          "caller can sign someone else's name to is not an audit log.",
          '',
          'Refuses to drive `on_hand` below zero, and refuses to drive it below the quantity',
          'already `reserved` — both return `409 INVENTORY_INSUFFICIENT` with the current numbers',
          'so you can see why.',
          '',
          'Creates the level row automatically if this is the first stock at that location.',
        ].join('\n'),
        tags: [TAG],
        security,
        body: ref('AdjustmentRequest'),
        response: {
          201: {
            ...ref('AdjustmentResponse'),
            description: 'The adjustment, and the resulting level.',
          },
          ...errorResponses({
            404: `${NOT_FOUND_SKU} Or no such location (\`LOCATION_NOT_FOUND\`).`,
            409: 'The change would leave negative or over-reserved stock (`INVENTORY_INSUFFICIENT`).',
          }),
        },
      },
    },
    async (request, reply) => {
      const actor = request.principal!.email;
      const result = await service.adjustInventory(app.db, request.body, actor);
      reply.code(201);
      return resource(result);
    },
  );

  app.post<{ Body: ReservationRequestInput }>(
    '/inventory/reservations',
    {
      onRequest: protectedBy(app, 'inventory:write'),
      schema: {
        operationId: 'createInventoryReservation',
        summary: 'Reserve stock for a pending transaction',
        description: [
          'Holds stock so it cannot be sold twice while a transaction is in flight.',
          '',
          '**Two callers cannot both reserve the last unit.** The hold is applied by attempting',
          'the update and letting a database constraint arbitrate, not by reading availability',
          'and then writing. A read-check-write has a race window that only appears under',
          'concurrency — which is to say, only in production. Losing that race returns',
          '`409 INVENTORY_INSUFFICIENT` with the authoritative available quantity.',
          '',
          'Reservations expire (15 minutes by default). Expired holds are swept back inside the',
          'next reservation attempt for the same SKU and location, so lapsed stock frees itself',
          'on next use rather than needing a scheduler.',
        ].join('\n'),
        tags: [TAG],
        security,
        body: ref('ReservationRequest'),
        response: {
          201: { ...ref('ReservationResponse'), description: 'The reservation that was created.' },
          ...errorResponses({
            404: `${NOT_FOUND_SKU} Or no such location (\`LOCATION_NOT_FOUND\`).`,
            409: 'Not enough available stock (`INVENTORY_INSUFFICIENT`). `error.details.available` is authoritative.',
          }),
        },
      },
    },
    async (request, reply) => {
      const actor = request.principal!.email;
      const reservation = await service.createReservation(app.db, request.body, actor);
      reply.code(201).header('location', `/api/v1/inventory/reservations/${reservation.id}`);
      return resource(reservation);
    },
  );

  app.get<{ Params: ReservationIdParamsType }>(
    '/inventory/reservations/:reservationId',
    {
      onRequest: protectedBy(app, 'inventory:read'),
      schema: {
        operationId: 'getInventoryReservation',
        summary: 'Retrieve a reservation',
        description:
          'Returns one reservation. A hold whose `expires_at` has passed is reported as ' +
          '`expired` immediately, even if the sweep that returns its stock has not run yet — ' +
          'reporting it as still active would be the worse lie.',
        tags: [TAG],
        security,
        params: ReservationIdParams,
        response: {
          200: { ...ref('ReservationResponse'), description: 'The requested reservation.' },
          ...errorResponses({ 404: 'No such reservation (`RESERVATION_NOT_FOUND`).' }),
        },
      },
    },
    async (request) => resource(await service.getReservation(app.db, request.params.reservationId)),
  );

  app.post<{ Params: ReservationIdParamsType }>(
    '/inventory/reservations/:reservationId/release',
    {
      onRequest: protectedBy(app, 'inventory:write'),
      schema: {
        operationId: 'releaseInventoryReservation',
        summary: 'Release a reservation',
        description: [
          'Returns held stock to available and marks the reservation `released`.',
          '',
          '**Idempotent.** Releasing an already-released reservation returns `200` with it',
          'unchanged, for the same reason archiving a product twice does: "make sure this is',
          'released" is a reasonable thing to say twice, especially after a network timeout.',
          '',
          'Releasing an **expired** reservation is different and returns `409` — its stock was',
          'already reclaimed, so succeeding silently would let you believe you had returned',
          'stock you had not.',
        ].join('\n'),
        tags: [TAG],
        security,
        params: ReservationIdParams,
        response: {
          200: {
            ...ref('ReservationResponse'),
            description: 'The released reservation. Returned for a repeat call too.',
          },
          ...errorResponses({
            404: 'No such reservation (`RESERVATION_NOT_FOUND`).',
            409: 'The reservation had already expired (`RESERVATION_NOT_ACTIVE`).',
          }),
        },
      },
    },
    async (request) =>
      resource(await service.releaseReservation(app.db, request.params.reservationId)),
  );

  app.get<{ Params: SkuParamsType }>(
    '/inventory/:sku',
    {
      onRequest: protectedBy(app, 'inventory:read'),
      schema: {
        operationId: 'getInventoryForSku',
        summary: 'Retrieve availability for one SKU',
        description: [
          'Stock for a single SKU across every location, with network-wide totals.',
          '',
          '**The path parameter is a SKU, not an opaque id** — the one place in this API where a',
          'human-meaningful natural key sits in a path, because that is how people refer to',
          'inventory. The tradeoff: renaming a SKU changes the URL, which an opaque id would',
          'have insulated you from.',
          '',
          'A location with no stock row for this SKU is absent from `locations` rather than',
          'reported as zero. Never stocked there and stocked-but-empty are different facts.',
        ].join('\n'),
        tags: [TAG],
        security,
        params: SkuParams,
        response: {
          200: { ...ref('SkuInventoryResponse'), description: 'Availability across locations.' },
          ...errorResponses({ 404: NOT_FOUND_SKU }),
        },
      },
    },
    async (request) => resource(await service.getInventoryForSku(app.db, request.params.sku)),
  );
}
