import { Type, type Static } from '@sinclair/typebox';
import { idPatternString } from '../ids.js';

/**
 * Worked examples for inventory, shared across the entity schemas and their envelopes.
 *
 * The arithmetic reconciles on purpose: `available` is `on_hand - reserved` everywhere it
 * appears, and the network totals in SKU_INVENTORY_EXAMPLE are the sum of the per-location
 * rows beneath them. An inventory example that does not add up teaches a consumer to distrust
 * the numbers, which is the opposite of what an example is for.
 */
export const INVENTORY_LEVEL_EXAMPLE = {
  sku: 'ACME-BAG-BLK',
  location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
  location_name: 'Toronto Warehouse',
  on_hand: 120,
  reserved: 18,
  available: 102,
  updated_at: '2025-01-14T15:20:00.000Z',
};

export const INVENTORY_ADJUSTMENT_EXAMPLE = {
  id: 'invadj_6b3c1d8e2f0a9b7c5d4e3f21',
  sku: 'ACME-BAG-BLK',
  location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
  location_name: 'Toronto Warehouse',
  quantity_delta: 24,
  reason: 'received',
  reference: 'PO-2025-0114',
  actor: 'dev@acme.example',
  created_at: '2025-01-14T15:20:00.000Z',
};

export const INVENTORY_RESERVATION_EXAMPLE = {
  id: 'invres_8d2e4f6a0b1c3d5e7f9a2b4c',
  sku: 'ACME-BAG-BLK',
  location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
  quantity: 2,
  status: 'active',
  reference: 'cart_9f8e7d6c',
  actor: 'dev@acme.example',
  expires_at: '2025-01-14T15:50:00.000Z',
  released_at: null,
  created_at: '2025-01-14T15:20:00.000Z',
};

/** Two locations, and the totals are their sum: 120 + 40 on hand, 18 + 2 reserved. */
export const SKU_INVENTORY_EXAMPLE = {
  sku: 'ACME-BAG-BLK',
  tracked: true,
  totals: { on_hand: 160, reserved: 20, available: 140 },
  locations: [
    INVENTORY_LEVEL_EXAMPLE,
    {
      sku: 'ACME-BAG-BLK',
      location_id: 'loc_5f1a3b7c9d2e4f6a8b0c1d3e',
      location_name: 'Barrie Retail Location',
      on_hand: 40,
      reserved: 2,
      available: 38,
      updated_at: '2025-01-13T09:41:12.000Z',
    },
  ],
};

export const ADJUSTMENT_REASONS = [
  'received',
  'sold',
  'damaged',
  'correction',
  'transfer_in',
  'transfer_out',
  'return',
] as const;
export const RESERVATION_STATUSES = ['active', 'released', 'expired'] as const;
export const INVENTORY_SORT_FIELDS = ['sku', 'available', 'on_hand', 'updated_at'] as const;

const enumOf = <T extends readonly string[]>(values: T, description: string, dflt?: T[number]) =>
  Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    description,
    ...(dflt ? { default: dflt } : {}),
  });

const SkuParam = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Stock-keeping unit.',
  examples: ['ACME-BAG-BLK'],
});

export const InventoryLevelSchema = Type.Object(
  {
    sku: Type.String({ description: 'The SKU this level is for.' }),
    location_id: Type.String({
      pattern: idPatternString('loc'),
      description: 'Where the stock is.',
    }),
    location_name: Type.String({
      description: 'Location name, so a response is readable without a second call.',
    }),
    on_hand: Type.Integer({ minimum: 0, description: 'Units physically present.' }),
    reserved: Type.Integer({ minimum: 0, description: 'Units held by active reservations.' }),
    available: Type.Integer({
      description:
        'What can still be reserved or sold: `on_hand - reserved`. **Computed, never stored** — ' +
        'a third stored number is the first thing to disagree with the other two.',
    }),
    updated_at: Type.String({ format: 'date-time', description: 'When this level last changed.' }),
  },
  {
    $id: 'InventoryLevel',
    examples: [INVENTORY_LEVEL_EXAMPLE],
    title: 'InventoryLevel',
    additionalProperties: false,
    description: 'Stock for one SKU at one location.',
  },
);
export type InventoryLevelResource = Static<typeof InventoryLevelSchema>;

export const SkuInventorySchema = Type.Object(
  {
    sku: Type.String({ description: 'The SKU.' }),
    tracked: Type.Boolean({ description: 'Whether stock is tracked for this SKU.' }),
    totals: Type.Object(
      {
        on_hand: Type.Integer({ description: 'Summed across every location.' }),
        reserved: Type.Integer({ description: 'Summed across every location.' }),
        available: Type.Integer({ description: 'Summed across every location.' }),
      },
      { additionalProperties: false, description: 'Network-wide totals.' },
    ),
    locations: Type.Array(Type.Unsafe<InventoryLevelResource>({ $ref: 'InventoryLevel#' }), {
      description:
        'Per-location breakdown. A location with no stock row for this SKU is absent, not zero.',
    }),
  },
  {
    $id: 'SkuInventory',
    examples: [SKU_INVENTORY_EXAMPLE],
    title: 'SkuInventory',
    additionalProperties: false,
    description: 'Availability for one SKU across every location.',
  },
);

export const AdjustmentSchema = Type.Object(
  {
    id: Type.String({ pattern: idPatternString('invadj'), description: 'Adjustment identifier.' }),
    sku: Type.String({ description: 'The SKU adjusted.' }),
    location_id: Type.String({ description: 'Where.' }),
    location_name: Type.Optional(
      Type.String({ description: 'Location name, on history responses.' }),
    ),
    quantity_delta: Type.Integer({ description: 'Signed change. Negative removes stock.' }),
    reason: enumOf(
      ADJUSTMENT_REASONS,
      'Why the stock moved. A closed set so history can be grouped.',
    ),
    reference: Type.Unsafe<string | null>({
      type: ['string', 'null'],
      description: 'Free-text link to a PO, order, or ticket.',
    }),
    actor: Type.String({
      description: 'Who did it — taken from the bearer token, never from the body.',
    }),
    created_at: Type.String({
      format: 'date-time',
      description: 'When. Append-only; never updated.',
    }),
  },
  {
    $id: 'InventoryAdjustment',
    examples: [INVENTORY_ADJUSTMENT_EXAMPLE],
    title: 'InventoryAdjustment',
    additionalProperties: false,
    description: 'One entry in the append-only stock audit log.',
  },
);

export const ReservationSchema = Type.Object(
  {
    id: Type.String({ pattern: idPatternString('invres'), description: 'Reservation identifier.' }),
    sku: Type.String({ description: 'The SKU held.' }),
    location_id: Type.String({ description: 'Where the stock is held.' }),
    quantity: Type.Integer({ minimum: 1, description: 'Units held.' }),
    status: enumOf(
      RESERVATION_STATUSES,
      'Lifecycle state. `expired` is reported as soon as `expires_at` passes, whether or not ' +
        'the stock has been swept back yet.',
    ),
    reference: Type.Unsafe<string | null>({
      type: ['string', 'null'],
      description: 'Free-text link to a cart or order.',
    }),
    actor: Type.String({ description: 'Who reserved it.' }),
    expires_at: Type.String({
      format: 'date-time',
      description: 'After this, the hold lapses and the stock returns.',
    }),
    released_at: Type.Unsafe<string | null>({
      type: ['string', 'null'],
      format: 'date-time',
      description: 'When it was released or expired. Null while active.',
    }),
    created_at: Type.String({ format: 'date-time', description: 'When it was created.' }),
  },
  {
    $id: 'InventoryReservation',
    examples: [INVENTORY_RESERVATION_EXAMPLE],
    title: 'InventoryReservation',
    additionalProperties: false,
    description: 'A temporary hold on stock.',
  },
);

export const AdjustmentRequestSchema = Type.Object(
  {
    sku: SkuParam,
    location_id: Type.String({
      pattern: idPatternString('loc'),
      description: 'Which location to adjust.',
    }),
    quantity_delta: Type.Integer({
      description:
        'Signed change. Positive adds, negative removes. Zero is rejected — an adjustment that ' +
        'changes nothing is a client bug, not a no-op worth recording.',
      examples: [25, -3],
    }),
    reason: enumOf(
      ADJUSTMENT_REASONS,
      'Required. Closed set so the audit log can be grouped and reported on.',
    ),
    reference: Type.Optional(
      Type.String({ maxLength: 200, description: 'Optional PO number, order id, or ticket.' }),
    ),
  },
  {
    $id: 'AdjustmentRequest',
    title: 'AdjustmentRequest',
    additionalProperties: false,
    description: 'Increase, decrease, or correct stock at one location.',
    examples: [
      {
        sku: 'ACME-BAG-BLK',
        location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
        quantity_delta: 25,
        reason: 'received',
        reference: 'PO-4471',
      },
    ],
  },
);
export type AdjustmentRequestInput = Static<typeof AdjustmentRequestSchema>;

export const ReservationRequestSchema = Type.Object(
  {
    sku: SkuParam,
    location_id: Type.String({
      pattern: idPatternString('loc'),
      description: 'Which location to hold stock at.',
    }),
    quantity: Type.Integer({
      minimum: 1,
      maximum: 100_000,
      description: 'Units to hold. Must be positive.',
    }),
    reference: Type.Optional(
      Type.String({ maxLength: 200, description: 'Optional cart or order reference.' }),
    ),
    ttl_seconds: Type.Optional(
      Type.Integer({
        minimum: 60,
        maximum: 86_400,
        default: 900,
        description: 'How long the hold lasts. Defaults to 15 minutes.',
      }),
    ),
  },
  {
    $id: 'ReservationRequest',
    title: 'ReservationRequest',
    additionalProperties: false,
    description: 'Hold stock for a pending transaction.',
    examples: [
      {
        sku: 'ACME-BAG-BLK',
        location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
        quantity: 2,
        reference: 'cart_9931',
        ttl_seconds: 900,
      },
    ],
  },
);
export type ReservationRequestInput = Static<typeof ReservationRequestSchema>;

export const InventoryListQuery = Type.Object(
  {
    page: Type.Optional(
      Type.Integer({ minimum: 1, default: 1, description: 'One-based page number.' }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Records per page, max 100.',
      }),
    ),
    sku: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, description: 'Exact SKU match.' }),
    ),
    location_id: Type.Optional(Type.String({ description: 'Restrict to one location.' })),
    available_below: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Only levels whose computed availability is strictly below this. The low-stock query ' +
          'a merchandiser actually wants.',
        examples: [5],
      }),
    ),
    sort: Type.Optional(
      enumOf(INVENTORY_SORT_FIELDS, 'Sort field. Allowlisted; `id` breaks ties.', 'sku'),
    ),
    order: Type.Optional(enumOf(['asc', 'desc'] as const, 'Sort direction.', 'asc')),
  },
  { additionalProperties: false },
);
export type InventoryListQueryType = Static<typeof InventoryListQuery>;

export const HistoryQuery = Type.Object(
  {
    page: Type.Optional(
      Type.Integer({ minimum: 1, default: 1, description: 'One-based page number.' }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Records per page, max 100.',
      }),
    ),
    sku: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, description: 'Exact SKU match.' }),
    ),
    location_id: Type.Optional(Type.String({ description: 'Restrict to one location.' })),
    reason: Type.Optional(enumOf(ADJUSTMENT_REASONS, 'Restrict to one reason.')),
    created_after: Type.Optional(
      Type.String({ format: 'date-time', description: 'Inclusive lower bound, RFC 3339.' }),
    ),
    created_before: Type.Optional(
      Type.String({ format: 'date-time', description: 'Inclusive upper bound, RFC 3339.' }),
    ),
  },
  { additionalProperties: false },
);
export type HistoryQueryType = Static<typeof HistoryQuery>;

export const SkuParams = Type.Object(
  {
    sku: Type.String({
      description: 'Stock-keeping unit. Note this is a natural key, not an opaque id.',
    }),
  },
  { additionalProperties: false },
);
export type SkuParamsType = Static<typeof SkuParams>;

export const ReservationIdParams = Type.Object(
  { reservationId: Type.String({ description: 'Reservation identifier as returned by the API.' }) },
  { additionalProperties: false },
);
export type ReservationIdParamsType = Static<typeof ReservationIdParams>;

export const InventoryListResponseSchema = Type.Object(
  {
    data: Type.Array(Type.Unsafe<InventoryLevelResource>({ $ref: 'InventoryLevel#' }), {
      description: 'A page of stock levels.',
    }),
    pagination: Type.Unsafe<unknown>({ $ref: 'Pagination#' }),
  },
  {
    $id: 'InventoryListResponse',
    examples: [
      {
        data: [INVENTORY_LEVEL_EXAMPLE],
        pagination: { page: 1, limit: 25, total: 2, total_pages: 1 },
      },
    ],
    title: 'InventoryListResponse',
    additionalProperties: false,
    description: 'A page of inventory levels.',
  },
);

export const SkuInventoryResponseSchema = Type.Object(
  { data: Type.Unsafe<unknown>({ $ref: 'SkuInventory#' }) },
  {
    $id: 'SkuInventoryResponse',
    examples: [{ data: SKU_INVENTORY_EXAMPLE }],
    title: 'SkuInventoryResponse',
    additionalProperties: false,
    description: 'Availability for one SKU.',
  },
);

export const AdjustmentResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        adjustment: Type.Unsafe<unknown>({ $ref: 'InventoryAdjustment#' }),
        level: Type.Object(
          {
            sku: Type.String({ description: 'The SKU.' }),
            location_id: Type.String({ description: 'The location.' }),
            on_hand: Type.Integer({ description: 'On hand after the adjustment.' }),
            reserved: Type.Integer({ description: 'Reserved after the adjustment.' }),
            available: Type.Integer({ description: 'Available after the adjustment.' }),
          },
          {
            additionalProperties: false,
            description: 'The resulting level, so no follow-up read is needed.',
          },
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'AdjustmentResponse',
    examples: [
      {
        data: {
          adjustment: INVENTORY_ADJUSTMENT_EXAMPLE,
          level: {
            sku: 'ACME-BAG-BLK',
            location_id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
            on_hand: 144,
            reserved: 18,
            available: 126,
          },
        },
      },
    ],
    title: 'AdjustmentResponse',
    additionalProperties: false,
    description: 'The adjustment recorded, and the level it produced.',
  },
);

export const HistoryResponseSchema = Type.Object(
  {
    data: Type.Array(Type.Unsafe<unknown>({ $ref: 'InventoryAdjustment#' }), {
      description: 'A page of audit-log entries, newest first.',
    }),
    pagination: Type.Unsafe<unknown>({ $ref: 'Pagination#' }),
  },
  {
    $id: 'HistoryResponse',
    examples: [
      {
        data: [INVENTORY_ADJUSTMENT_EXAMPLE],
        pagination: { page: 1, limit: 25, total: 7, total_pages: 1 },
      },
    ],
    title: 'HistoryResponse',
    additionalProperties: false,
    description: 'A page of inventory adjustments.',
  },
);

export const ReservationResponseSchema = Type.Object(
  { data: Type.Unsafe<unknown>({ $ref: 'InventoryReservation#' }) },
  {
    $id: 'ReservationResponse',
    examples: [{ data: INVENTORY_RESERVATION_EXAMPLE }],
    title: 'ReservationResponse',
    additionalProperties: false,
    description: 'A single reservation.',
  },
);

export const INVENTORY_SHARED_SCHEMAS = [
  InventoryLevelSchema,
  SkuInventorySchema,
  AdjustmentSchema,
  ReservationSchema,
  AdjustmentRequestSchema,
  ReservationRequestSchema,
  InventoryListResponseSchema,
  SkuInventoryResponseSchema,
  AdjustmentResponseSchema,
  HistoryResponseSchema,
  ReservationResponseSchema,
];
