/**
 * Catalog schemas — the API contract, in one file.
 *
 * These objects are JSON Schema. That single fact is what makes this project's OpenAPI
 * document trustworthy, because the same object is used for three jobs:
 *
 *   1. Ajv validates incoming requests against it (a request the schema forbids never
 *      reaches a handler).
 *   2. fast-json-stringify serializes outgoing responses through it (a field the schema does
 *      not declare is stripped from the response).
 *   3. @fastify/swagger publishes it as `components.schemas` in /openapi.json.
 *
 * There is therefore no separate document that can drift from the code, because there is no
 * separate document. What CAN still drift is meaning: a `description` can become misleading
 * and an `example` can go stale. That is what review and `npm run openapi:lint` are for.
 *
 * TypeBox is used rather than Zod because TypeBox's output IS JSON Schema. Zod's is not, and
 * converting it would insert a lossy translation step into the middle of the mechanism above.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { idPatternString } from '../ids.js';

/**
 * A closed set of string values, emitted as `enum` rather than `anyOf: [{const}]`.
 *
 * TypeBox's `Type.Union([Type.Literal(...)])` is correct JSON Schema but produces `anyOf`,
 * which renders poorly in documentation tools and imports into Postman as an opaque union.
 * `enum` is what a human reading the contract wants to see.
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options: { description: string; default?: T[number]; examples?: unknown[] },
) {
  return Type.Unsafe<T[number]>({ type: 'string', enum: [...values], ...options });
}

/** A property that may legitimately hold null. OpenAPI 3.1 permits a type array; 3.0 did not. */
function Nullable<S extends TSchema>(schema: S, description: string) {
  const { type, ...rest } = schema as unknown as { type: string; [k: string]: unknown };
  return Type.Unsafe<Static<S> | null>({ ...rest, type: [type, 'null'], description });
}

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export const VARIANT_STATUSES = ['active', 'archived'] as const;

/**
 * Sortable product fields — an allowlist, not a formality.
 *
 * A client-supplied column name interpolated into `ORDER BY` is a SQL injection vector. It
 * also silently widens your contract: every column becomes part of the public API the moment
 * someone can sort by it.
 */
export const PRODUCT_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'title',
  'vendor',
  'product_type',
  'status',
] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/** GET /products/{id}/variants is unpaginated; this is the documented hard ceiling. */
export const MAX_VARIANTS_PER_PRODUCT = 250;

// ---------------------------------------------------------------------------
// Resource representations
// ---------------------------------------------------------------------------

export const ProductSchema = Type.Object(
  {
    id: Type.String({
      pattern: idPatternString('prod'),
      description:
        'Server-assigned product identifier. Always `prod_` followed by 24 lowercase hex ' +
        'characters. Assigned by the API; never constructed by a client.',
      examples: ['prod_7ebf51270d4d3de9f7acad4c'],
    }),
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Customer-facing product name.',
      examples: ['Trailhead 30L Backpack'],
    }),
    description: Nullable(
      Type.String({ maxLength: 5000 }),
      'Long-form product description. Null when none has been written.',
    ),
    status: StringEnum(PRODUCT_STATUSES, {
      description:
        'Publication state. `draft` is not customer-visible, `active` is for sale, ' +
        '`archived` is retired but retained so historical orders remain meaningful.',
    }),
    vendor: Nullable(
      Type.String({ maxLength: 100 }),
      'Brand or supplier. Filterable via the `vendor` query parameter (case-insensitive exact match).',
    ),
    product_type: Nullable(
      Type.String({ maxLength: 100 }),
      'Merchandising category, e.g. "Backpacks". Filterable via `product_type`.',
    ),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
      maxItems: 50,
      description:
        'Free-form labels used for merchandising. Filterable one at a time via `tag`. ' +
        'Always an array; an untagged product has `[]`, never null.',
      examples: [['outdoor', 'hiking', 'bestseller']],
    }),
    created_at: Type.String({
      format: 'date-time',
      description: 'RFC 3339 timestamp of creation, in UTC. Immutable.',
      examples: ['2025-01-14T15:20:00.000Z'],
    }),
    updated_at: Type.String({
      format: 'date-time',
      description:
        'RFC 3339 timestamp of the most recent change, in UTC. Maintained by a database ' +
        'trigger, so it cannot be left stale by application code that forgets to set it.',
    }),
    archived_at: Nullable(
      Type.String({ format: 'date-time' }),
      'When the product was archived. Non-null exactly when `status` is `archived`.',
    ),
  },
  {
    $id: 'Product',
    title: 'Product',
    description:
      'A sellable item in the Acme Commerce catalog. A product carries merchandising ' +
      'information; the purchasable units with SKUs and prices are its variants.',
    additionalProperties: false,
  },
);
export type ProductResource = Static<typeof ProductSchema>;

export const VariantSchema = Type.Object(
  {
    id: Type.String({
      pattern: idPatternString('var'),
      description: 'Server-assigned variant identifier.',
      examples: ['var_1a2b3c4d5e6f708192a3b4c5'],
    }),
    product_id: Type.String({
      pattern: idPatternString('prod'),
      description: 'Identifier of the product this variant belongs to.',
    }),
    sku: Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        'Stock-keeping unit. Unique across the ENTIRE catalog, not merely within one ' +
        'product. Creating a variant with a SKU that already exists returns 409.',
      examples: ['ACME-BAG-BLK'],
    }),
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Variant name, typically the option combination.',
      examples: ['Black', 'Granite / Medium'],
    }),
    price_cents: Type.Integer({
      minimum: 0,
      description:
        'Price in the smallest unit of `currency` — 12900 means CAD 129.00. An integer, ' +
        'never a decimal: IEEE-754 floats cannot represent 0.10 exactly, and money ' +
        'arithmetic in floats produces off-by-a-cent errors that survive most test suites.',
      examples: [12900],
    }),
    compare_at_price_cents: Nullable(
      Type.Integer({ minimum: 0 }),
      'Reference "was" price in minor units, used to display a markdown. Null when the ' +
        'variant is not on sale. Not validated against `price_cents`.',
    ),
    currency: Type.String({
      pattern: '^[A-Z]{3}$',
      description: 'ISO 4217 currency code for `price_cents` and `compare_at_price_cents`.',
      examples: ['CAD'],
    }),
    barcode: Nullable(Type.String({ maxLength: 64 }), 'UPC, EAN, or ISBN. Null when unknown.'),
    inventory_item_id: Nullable(
      Type.String({ maxLength: 64 }),
      'Reference to the inventory item that tracks stock for this variant. Always null in ' +
        'Milestone 1 — the Inventory API that populates it arrives in Milestone 2. Present ' +
        'in the contract now so the seam is visible rather than pretended away.',
    ),
    status: StringEnum(VARIANT_STATUSES, {
      description:
        'Variant state. Variants have no `draft`: publication is a product-level concept, ' +
        'so a variant of a draft product is `active` and simply not reachable by customers.',
    }),
    position: Type.Integer({
      minimum: 1,
      description:
        'Display order within the product. `GET /products/{id}/variants` returns variants ' +
        'sorted by this value, then by `id` to break ties.',
    }),
    created_at: Type.String({
      format: 'date-time',
      description: 'RFC 3339 creation timestamp, UTC.',
    }),
    updated_at: Type.String({
      format: 'date-time',
      description: 'RFC 3339 last-modified timestamp, UTC.',
    }),
    archived_at: Nullable(
      Type.String({ format: 'date-time' }),
      'When the variant was archived. Non-null exactly when `status` is `archived`.',
    ),
  },
  {
    $id: 'Variant',
    title: 'Variant',
    description:
      'A purchasable unit of a product: one SKU, one price. Inventory and orders reference ' +
      'variants, not products.',
    additionalProperties: false,
  },
);
export type VariantResource = Static<typeof VariantSchema>;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const CreateProductSchema = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Required. Customer-facing product name.',
    }),
    description: Type.Optional(
      Type.String({ maxLength: 5000, description: 'Optional long-form description.' }),
    ),
    status: Type.Optional(
      StringEnum(PRODUCT_STATUSES, {
        description: 'Optional. Defaults to `draft`, so a new product is not accidentally live.',
        default: 'draft',
      }),
    ),
    vendor: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100, description: 'Optional brand or supplier.' }),
    ),
    product_type: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'Optional merchandising category.',
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
        maxItems: 50,
        description: 'Optional labels. Defaults to an empty array.',
      }),
    ),
  },
  {
    $id: 'ProductCreate',
    title: 'ProductCreate',
    description:
      'Body for creating a product. Unknown properties are REJECTED with 400 rather than ' +
      'ignored — a silently-dropped `titel` is a typo that ships to production believing it ' +
      'worked.',
    // Note: `id`, `created_at`, `updated_at`, and `archived_at` are absent on purpose.
    // They are server-assigned. A client that could set `id` could collide with an existing
    // record or forge a timestamp.
    additionalProperties: false,
    examples: [
      {
        title: 'Riverbend Packable Rain Jacket',
        description: 'A 2.5-layer shell that stuffs into its own pocket.',
        status: 'active',
        vendor: 'Acme',
        product_type: 'Apparel',
        tags: ['waterproof', 'lightweight'],
      },
    ],
  },
);
export type CreateProductInput = Static<typeof CreateProductSchema>;

export const UpdateProductSchema = Type.Object(
  {
    title: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'New product name.' }),
    ),
    description: Type.Optional(
      Nullable(Type.String({ maxLength: 5000 }), 'New description. Send null to clear it.'),
    ),
    status: Type.Optional(
      StringEnum(PRODUCT_STATUSES, {
        description:
          'New publication state. Setting `archived` here is equivalent to calling DELETE; ' +
          'moving away from `archived` un-archives the product and clears `archived_at`.',
      }),
    ),
    vendor: Type.Optional(
      Nullable(Type.String({ maxLength: 100 }), 'New vendor. Send null to clear it.'),
    ),
    product_type: Type.Optional(
      Nullable(Type.String({ maxLength: 100 }), 'New product type. Send null to clear it.'),
    ),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
        maxItems: 50,
        description: 'Replaces the entire tag array. This is not a merge; send the full list.',
      }),
    ),
  },
  {
    $id: 'ProductUpdate',
    title: 'ProductUpdate',
    description:
      'Partial update. Only the properties you send are changed. An omitted property is left ' +
      'alone; an explicit null clears a nullable property. Those are genuinely different ' +
      'operations, which is the whole reason PATCH exists rather than PUT. An empty body is ' +
      'rejected with 400 — it is far more often a client bug than a deliberate no-op.',
    additionalProperties: false,
    minProperties: 1,
    examples: [{ status: 'active', tags: ['outdoor', 'bestseller'] }],
  },
);
export type UpdateProductInput = Static<typeof UpdateProductSchema>;

export const CreateVariantSchema = Type.Object(
  {
    sku: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'Required. Must be unique across the entire catalog.',
    }),
    title: Type.String({ minLength: 1, maxLength: 200, description: 'Required. Variant name.' }),
    price_cents: Type.Integer({
      minimum: 0,
      description: 'Required. Price in minor units. Must be a non-negative integer.',
    }),
    compare_at_price_cents: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Optional reference price in minor units.' }),
    ),
    currency: Type.Optional(
      Type.String({
        pattern: '^[A-Z]{3}$',
        default: 'CAD',
        description: 'Optional ISO 4217 code. Defaults to CAD.',
      }),
    ),
    barcode: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, description: 'Optional UPC/EAN.' }),
    ),
    position: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'Optional display order. Defaults to one past the current highest position.',
      }),
    ),
  },
  {
    $id: 'VariantCreate',
    title: 'VariantCreate',
    description:
      'Body for creating a variant. The parent product is taken from the URL path, not the ' +
      'body, so the two cannot disagree.',
    additionalProperties: false,
    examples: [
      {
        sku: 'ACME-RAIN-BLK-M',
        title: 'Black / Medium',
        price_cents: 18900,
        compare_at_price_cents: 22900,
        currency: 'CAD',
      },
    ],
  },
);
export type CreateVariantInput = Static<typeof CreateVariantSchema>;

export const UpdateVariantSchema = Type.Object(
  {
    sku: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'New SKU. Still subject to global uniqueness.',
      }),
    ),
    title: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'New variant name.' }),
    ),
    price_cents: Type.Optional(
      Type.Integer({ minimum: 0, description: 'New price in minor units.' }),
    ),
    compare_at_price_cents: Type.Optional(
      Nullable(
        Type.Integer({ minimum: 0 }),
        'New reference price. Send null to remove the markdown.',
      ),
    ),
    currency: Type.Optional(
      Type.String({ pattern: '^[A-Z]{3}$', description: 'New ISO 4217 currency code.' }),
    ),
    barcode: Type.Optional(
      Nullable(Type.String({ maxLength: 64 }), 'New barcode. Send null to clear it.'),
    ),
    status: Type.Optional(
      StringEnum(VARIANT_STATUSES, {
        description: 'New variant state. `archived` is equivalent to DELETE.',
      }),
    ),
    position: Type.Optional(Type.Integer({ minimum: 1, description: 'New display order.' })),
  },
  {
    $id: 'VariantUpdate',
    title: 'VariantUpdate',
    description:
      'Partial update of a variant. Same omitted-versus-null semantics as ProductUpdate.',
    additionalProperties: false,
    minProperties: 1,
    examples: [{ price_cents: 11900, compare_at_price_cents: null }],
  },
);
export type UpdateVariantInput = Static<typeof UpdateVariantSchema>;

// ---------------------------------------------------------------------------
// Path parameters and query strings
// ---------------------------------------------------------------------------

export const ProductIdParams = Type.Object(
  {
    productId: Type.String({
      description: 'Product identifier as returned by the API.',
      examples: ['prod_7ebf51270d4d3de9f7acad4c'],
    }),
  },
  { additionalProperties: false },
);
export type ProductIdParamsType = Static<typeof ProductIdParams>;

export const VariantIdParams = Type.Object(
  {
    variantId: Type.String({
      description: 'Variant identifier as returned by the API.',
      examples: ['var_1a2b3c4d5e6f708192a3b4c5'],
    }),
  },
  { additionalProperties: false },
);
export type VariantIdParamsType = Static<typeof VariantIdParams>;

/*
 * Note on path-parameter validation: the `pattern` is deliberately NOT applied here.
 *
 * If Ajv rejected a malformed id, the caller would get a generic 400 VALIDATION_ERROR that
 * looks identical to a bad request body. The service layer checks the format instead and
 * raises 400 MALFORMED_ID with the expected pattern in `details` — a materially more useful
 * error for someone whose string interpolation produced `prod_undefined`.
 *
 * The pattern IS published on the Product/Variant `id` response properties, so the constraint
 * is still machine-readable in the contract.
 */

export const ProductListQuery = Type.Object(
  {
    page: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: 1,
        description:
          'One-based page number. Requesting a page past the end returns an empty `data` array with 200, not 404.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        default: DEFAULT_PAGE_SIZE,
        description: `Records per page. Default ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}. A larger value is rejected with 400 rather than silently clamped, so a client asking for 1000 learns that it cannot have 1000.`,
      }),
    ),
    status: Type.Optional(
      StringEnum(PRODUCT_STATUSES, {
        description:
          'Filter by publication state. NOTE: with no `status` filter, products of ALL ' +
          'statuses are returned, archived included. This API applies no hidden default ' +
          'filter — the result set is fully determined by the query string.',
      }),
    ),
    vendor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'Filter by vendor. Case-insensitive EXACT match, not a prefix or substring.',
        examples: ['Acme'],
      }),
    ),
    product_type: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: 'Filter by product type. Case-insensitive exact match.',
        examples: ['Backpacks'],
      }),
    ),
    tag: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 50,
        description:
          'Filter to products carrying this tag. Case-sensitive exact match on an array ' +
          'element. One tag per request in this version.',
        examples: ['bestseller'],
      }),
    ),
    q: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'Case-insensitive substring search across `title`, `description`, and `vendor`. ' +
          'Does not search variant SKUs. Combines with the filters using AND.',
        examples: ['backpack'],
      }),
    ),
    sort: Type.Optional(
      StringEnum(PRODUCT_SORT_FIELDS, {
        default: 'created_at',
        description:
          'Field to sort by. Restricted to this allowlist; any other value returns 400 with ' +
          'the permitted values in `error.details.allowed`. `id` is always appended as a ' +
          'tiebreaker so paging is stable across requests.',
      }),
    ),
    order: Type.Optional(
      StringEnum(SORT_ORDERS, {
        default: 'desc',
        description: 'Sort direction. Applies to the tiebreaker too.',
      }),
    ),
  },
  {
    // Unknown query parameters are REJECTED, not ignored. Most public APIs ignore them; this
    // one does not, because `?statuss=active` silently returning every product is a far worse
    // outcome for someone learning the API than a 400 that names the unknown parameter.
    // Documented in README.md as a deliberate strictness choice.
    additionalProperties: false,
  },
);
export type ProductListQueryType = Static<typeof ProductListQuery>;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const ref = <T>(id: string) => Type.Unsafe<T>({ $ref: `${id}#` });

export const PaginationSchema = Type.Object(
  {
    page: Type.Integer({ minimum: 1, description: 'The page that was returned.' }),
    limit: Type.Integer({ minimum: 1, description: 'The page size that was applied.' }),
    total: Type.Integer({
      minimum: 0,
      description: 'Total records matching the filters, across all pages.',
    }),
    total_pages: Type.Integer({
      minimum: 0,
      description:
        'Number of pages at this `limit`. Zero when `total` is zero — not one empty page.',
    }),
  },
  {
    $id: 'Pagination',
    title: 'Pagination',
    description: 'Offset pagination metadata, present on every collection response.',
    additionalProperties: false,
  },
);

export const ErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({
          description:
            'Stable machine-readable error code. Branch on this, never on `message`. The ' +
            'full list is documented in README.md.',
          examples: ['SKU_ALREADY_EXISTS'],
        }),
        message: Type.String({
          description:
            'Human-readable explanation, for a log or a response pane. May be reworded in ' +
            'any release; it is not part of the contract.',
        }),
        request_id: Type.String({
          description:
            'Correlation identifier for this request, also returned in the `X-Request-Id` ' +
            'response header. Quote it when reporting a problem — it is what locates the ' +
            'server-side log lines.',
          examples: ['req_18f3a9c4e21b7d05f6a3b8c1'],
        }),
        details: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                'Optional structured context. Its shape depends on `code`: ' +
                '`VALIDATION_ERROR` carries a `fields` array, `MALFORMED_ID` carries ' +
                '`expected_pattern`, `SKU_ALREADY_EXISTS` carries the conflicting `sku`.',
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'Error',
    title: 'Error',
    description: 'The single error shape returned by every Acme Commerce API error response.',
    additionalProperties: false,
    examples: [
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request body is invalid.',
          request_id: 'req_18f3a9c4e21b7d05f6a3b8c1',
          details: {
            fields: [{ field: 'body.title', rule: 'required', message: '"title" is required.' }],
          },
        },
      },
    ],
  },
);

export const ProductResponseSchema = Type.Object(
  { data: ref<ProductResource>('Product') },
  {
    $id: 'ProductResponse',
    title: 'ProductResponse',
    description: 'A single product.',
    additionalProperties: false,
  },
);

export const ProductListResponseSchema = Type.Object(
  {
    data: Type.Array(ref<ProductResource>('Product'), {
      description: 'The requested page of products. Empty when nothing matches.',
    }),
    pagination: ref<Static<typeof PaginationSchema>>('Pagination'),
  },
  {
    $id: 'ProductListResponse',
    title: 'ProductListResponse',
    description: 'A page of products plus the pagination metadata needed to fetch the rest.',
    additionalProperties: false,
  },
);

export const VariantResponseSchema = Type.Object(
  { data: ref<VariantResource>('Variant') },
  {
    $id: 'VariantResponse',
    title: 'VariantResponse',
    description: 'A single variant.',
    additionalProperties: false,
  },
);

export const VariantListResponseSchema = Type.Object(
  {
    data: Type.Array(ref<VariantResource>('Variant'), {
      maxItems: MAX_VARIANTS_PER_PRODUCT,
      description:
        'All variants of the product, ordered by `position` then `id`. This sub-collection ' +
        'is not paginated: a product has tens of variants, not thousands. The response is ' +
        `capped at ${MAX_VARIANTS_PER_PRODUCT}.`,
    }),
  },
  {
    $id: 'VariantListResponse',
    title: 'VariantListResponse',
    description: 'Every variant belonging to one product, unpaginated.',
    additionalProperties: false,
  },
);

/**
 * Schemas registered with Fastify via `addSchema`, which is what lifts them into
 * `components.schemas` in the OpenAPI document so consumers see named, reusable types instead
 * of the same object inlined into fourteen operations.
 */
export const CATALOG_SHARED_SCHEMAS = [
  ProductSchema,
  VariantSchema,
  PaginationSchema,
  ErrorSchema,
  CreateProductSchema,
  UpdateProductSchema,
  CreateVariantSchema,
  UpdateVariantSchema,
  ProductResponseSchema,
  ProductListResponseSchema,
  VariantResponseSchema,
  VariantListResponseSchema,
];
