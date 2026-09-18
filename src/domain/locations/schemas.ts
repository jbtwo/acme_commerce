import { Type, type Static } from '@sinclair/typebox';
import { idPatternString } from '../ids.js';

/** A worked example of a location, shared with the envelopes that wrap it. */
export const LOCATION_EXAMPLE = {
  id: 'loc_2d7e9f1a3b5c7d9e1f2a3b4c',
  name: 'Toronto Warehouse',
  type: 'warehouse',
  address_line1: '55 Commerce Court',
  address_line2: 'Unit 4',
  city: 'Toronto',
  region: 'ON',
  postal_code: 'M5L 1E2',
  country: 'CA',
  is_active: true,
  created_at: '2025-01-09T11:02:41.000Z',
  updated_at: '2025-01-09T11:02:41.000Z',
};

export const LOCATION_TYPES = ['warehouse', 'retail', 'virtual'] as const;
export const LOCATION_SORT_FIELDS = ['name', 'type', 'created_at', 'updated_at'] as const;

const TypeSchema = Type.Unsafe<(typeof LOCATION_TYPES)[number]>({
  type: 'string',
  enum: [...LOCATION_TYPES],
  description:
    'Kind of location. `warehouse` fulfils orders, `retail` is a physical store, `virtual` ' +
    'covers dropship and in-transit stock that has no address.',
});

const nullableString = (maxLength: number, description: string) =>
  Type.Unsafe<string | null>({ type: ['string', 'null'], maxLength, description });

export const LocationSchema = Type.Object(
  {
    id: Type.String({
      pattern: idPatternString('loc'),
      description: 'Server-assigned identifier.',
    }),
    name: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'Human-readable name. Unique, case-insensitively.',
    }),
    type: TypeSchema,
    address_line1: nullableString(200, 'Street address. Null for a virtual location.'),
    address_line2: nullableString(200, 'Unit, suite, or floor.'),
    city: nullableString(100, 'City.'),
    region: nullableString(100, 'Province, state, or region.'),
    postal_code: nullableString(20, 'Postal or ZIP code.'),
    country: nullableString(2, 'ISO 3166-1 alpha-2 country code, uppercase.'),
    is_active: Type.Boolean({
      description:
        'Whether the location is in use. Locations are never deleted — inventory history ' +
        'references them — so retiring one means setting this to false.',
    }),
    created_at: Type.String({ format: 'date-time', description: 'RFC 3339 creation timestamp.' }),
    updated_at: Type.String({
      format: 'date-time',
      description: 'RFC 3339 last-modified timestamp.',
    }),
  },
  {
    $id: 'Location',
    examples: [LOCATION_EXAMPLE],
    title: 'Location',
    additionalProperties: false,
    description: 'A place where inventory is held.',
  },
);
export type LocationResource = Static<typeof LocationSchema>;

export const CreateLocationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100, description: 'Required. Must be unique.' }),
    type: TypeSchema,
    address_line1: Type.Optional(Type.String({ maxLength: 200, description: 'Street address.' })),
    address_line2: Type.Optional(Type.String({ maxLength: 200, description: 'Unit or suite.' })),
    city: Type.Optional(Type.String({ maxLength: 100, description: 'City.' })),
    region: Type.Optional(Type.String({ maxLength: 100, description: 'Province or state.' })),
    postal_code: Type.Optional(Type.String({ maxLength: 20, description: 'Postal or ZIP code.' })),
    country: Type.Optional(
      Type.String({ pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2, uppercase.' }),
    ),
    is_active: Type.Optional(Type.Boolean({ default: true, description: 'Defaults to true.' })),
  },
  {
    $id: 'LocationCreate',
    title: 'LocationCreate',
    additionalProperties: false,
    description: 'Body for creating an inventory location.',
    examples: [
      {
        name: 'Calgary Warehouse',
        type: 'warehouse',
        address_line1: '3020 Centre Street NE',
        city: 'Calgary',
        region: 'AB',
        postal_code: 'T2E 2X7',
        country: 'CA',
      },
    ],
  },
);
export type CreateLocationInput = Static<typeof CreateLocationSchema>;

export const UpdateLocationSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'New name.' })),
    type: Type.Optional(TypeSchema),
    address_line1: Type.Optional(nullableString(200, 'New street address; null clears it.')),
    address_line2: Type.Optional(nullableString(200, 'New unit or suite; null clears it.')),
    city: Type.Optional(nullableString(100, 'New city; null clears it.')),
    region: Type.Optional(nullableString(100, 'New region; null clears it.')),
    postal_code: Type.Optional(nullableString(20, 'New postal code; null clears it.')),
    country: Type.Optional(
      Type.Unsafe<string | null>({
        type: ['string', 'null'],
        pattern: '^[A-Z]{2}$',
        description: 'New ISO 3166-1 alpha-2 code; null clears it.',
      }),
    ),
    is_active: Type.Optional(
      Type.Boolean({ description: 'Set false to retire the location without deleting it.' }),
    ),
  },
  {
    $id: 'LocationUpdate',
    title: 'LocationUpdate',
    additionalProperties: false,
    minProperties: 1,
    description: 'Partial update. Omitted properties are unchanged; explicit null clears one.',
    examples: [{ is_active: false }],
  },
);
export type UpdateLocationInput = Static<typeof UpdateLocationSchema>;

export const LocationIdParams = Type.Object(
  { locationId: Type.String({ description: 'Location identifier as returned by the API.' }) },
  { additionalProperties: false },
);
export type LocationIdParamsType = Static<typeof LocationIdParams>;

export const LocationListQuery = Type.Object(
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
    type: Type.Optional(TypeSchema),
    is_active: Type.Optional(
      Type.Boolean({
        description: 'Filter by active state. Omit to return locations of both states.',
      }),
    ),
    q: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'Case-insensitive substring match on name and city.',
      }),
    ),
    sort: Type.Optional(
      Type.Unsafe<(typeof LOCATION_SORT_FIELDS)[number]>({
        type: 'string',
        enum: [...LOCATION_SORT_FIELDS],
        default: 'name',
        description: 'Sort field. Allowlisted; `id` is appended as a stable tiebreaker.',
      }),
    ),
    order: Type.Optional(
      Type.Unsafe<'asc' | 'desc'>({
        type: 'string',
        enum: ['asc', 'desc'],
        default: 'asc',
        description: 'Sort direction.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type LocationListQueryType = Static<typeof LocationListQuery>;

export const LocationResponseSchema = Type.Object(
  { data: Type.Unsafe<LocationResource>({ $ref: 'Location#' }) },
  {
    $id: 'LocationResponse',
    examples: [{ data: LOCATION_EXAMPLE }],
    title: 'LocationResponse',
    additionalProperties: false,
    description: 'A single location.',
  },
);

export const LocationListResponseSchema = Type.Object(
  {
    data: Type.Array(Type.Unsafe<LocationResource>({ $ref: 'Location#' }), {
      description: 'The requested page of locations.',
    }),
    pagination: Type.Unsafe<unknown>({ $ref: 'Pagination#' }),
  },
  {
    $id: 'LocationListResponse',
    examples: [
      { data: [LOCATION_EXAMPLE], pagination: { page: 1, limit: 25, total: 3, total_pages: 1 } },
    ],
    title: 'LocationListResponse',
    additionalProperties: false,
    description: 'A page of locations with pagination metadata.',
  },
);

export const LOCATION_SHARED_SCHEMAS = [
  LocationSchema,
  CreateLocationSchema,
  UpdateLocationSchema,
  LocationResponseSchema,
  LocationListResponseSchema,
];
