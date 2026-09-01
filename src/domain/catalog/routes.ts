/**
 * Catalog HTTP routes.
 *
 * This layer owns transport concerns only: which schema validates the request, which status
 * code a success produces, what the response envelope looks like, and which OpenAPI metadata
 * the operation carries. Business decisions live in service.ts and SQL lives in repository.ts.
 *
 * Every route declares its `schema` because that object does three jobs at once — request
 * validation, response serialization, and the published contract. A route without a response
 * schema is a route whose contract is "trust me".
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { collection, resource } from '../../http/envelope.js';
import * as service from './service.js';
import {
  ProductIdParams,
  ProductListQuery,
  VariantIdParams,
  type CreateProductInput,
  type CreateVariantInput,
  type ProductIdParamsType,
  type ProductListQueryType,
  type UpdateProductInput,
  type UpdateVariantInput,
  type VariantIdParamsType,
} from './schemas.js';

/** `$ref` to a schema registered via `addSchema`, which becomes a `components.schemas` entry. */
const ref = (id: string) => ({ $ref: `${id}#` });

/**
 * The correlation header, declared so it appears in the OpenAPI contract as a documented
 * request parameter rather than as folklore.
 *
 * `additionalProperties: true` is essential: with it false, every ordinary header a client
 * sends (Accept, User-Agent, Content-Length) would fail validation.
 */
const CorrelationHeaders = Type.Object(
  {
    'x-request-id': Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9_-]{1,128}$',
        description:
          'Optional caller-supplied correlation id, echoed back in the X-Request-Id response ' +
          'header and included in structured errors. When absent or not matching this ' +
          'pattern, the server generates one. Supplying your own lets you correlate a request ' +
          'across your system and ours.',
        examples: ['my-app-checkout-attempt-42'],
      }),
    ),
  },
  { additionalProperties: true },
);

/** Error responses shared by every operation, so the contract is complete rather than optimistic. */
function errorResponses(extra: Record<number, string> = {}): Record<number, unknown> {
  const base: Record<number, string> = {
    400: 'The request is malformed. `error.code` is VALIDATION_ERROR, MALFORMED_ID, or INVALID_JSON.',
    ...extra,
    500: 'An unexpected server error. `error.request_id` identifies the failure in the server logs.',
    503: 'The database is unreachable. Safe to retry; see the Retry-After header.',
  };
  return Object.fromEntries(
    Object.entries(base).map(([status, description]) => [status, { ...ref('Error'), description }]),
  );
}

const TAG = 'Catalog';

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  const listProductsSchema: FastifySchema = {
    operationId: 'listProducts',
    summary: 'List products',
    description: [
      'Returns a page of products with pagination metadata.',
      '',
      '**No implicit filtering.** With no `status` parameter, products of every status are',
      'returned, archived ones included. This API applies no hidden default filter: the result',
      'set is fully determined by the query string. Most catalog APIs hide archived records;',
      'this one does not, so that DELETE is observable as a state change rather than as a',
      'disappearance.',
      '',
      'Filters combine with AND. An empty result is `200` with `"data": []`, never `404` —',
      'an empty collection is a successful answer to a well-formed question. A page past the',
      'end is also `200` with an empty array.',
      '',
      '**Unknown query parameters are rejected with 400**, not ignored. `?statuss=active`',
      'silently returning every product is a worse outcome than a loud error.',
      '',
      'Ordering always ends with `id` as a tiebreaker, so paging through a sorted list cannot',
      'show the same record twice.',
      '',
      'Every response carries an `X-Request-Id` header.',
    ].join('\n'),
    tags: [TAG],
    querystring: ProductListQuery,
    headers: CorrelationHeaders,
    response: {
      200: { ...ref('ProductListResponse'), description: 'A page of products.' },
      ...errorResponses(),
    },
  };

  app.get<{ Querystring: ProductListQueryType }>(
    '/products',
    { schema: listProductsSchema },
    async (request) => {
      const result = await service.listProducts(app.db, request.query);
      return collection(result.products, {
        page: result.page,
        limit: result.limit,
        total: result.total,
      });
    },
  );

  app.post<{ Body: CreateProductInput }>(
    '/products',
    {
      schema: {
        operationId: 'createProduct',
        summary: 'Create a product',
        description: [
          'Creates a product. The identifier, timestamps, and archive state are assigned by the',
          'server and cannot be supplied.',
          '',
          'A new product defaults to `draft` status so that creating one does not accidentally',
          'publish it.',
          '',
          'Unknown body properties are rejected with `400` rather than ignored, so a misspelled',
          'field is visible immediately instead of shipping to production believing it worked.',
          '',
          'Responds `201` with a `Location` header pointing at the new product.',
        ].join('\n'),
        tags: [TAG],
        body: ref('ProductCreate'),
        headers: CorrelationHeaders,
        response: {
          201: { ...ref('ProductResponse'), description: 'The product that was created.' },
          ...errorResponses(),
        },
      },
    },
    async (request, reply) => {
      const product = await service.createProduct(app.db, request.body);
      reply.code(201).header('location', `/api/v1/products/${product.id}`);
      return resource(product);
    },
  );

  app.get<{ Params: ProductIdParamsType }>(
    '/products/:productId',
    {
      schema: {
        operationId: 'getProduct',
        summary: 'Retrieve a product',
        description: [
          'Returns one product by identifier.',
          '',
          'Two different failures are deliberately distinguished. A syntactically invalid id',
          'such as `prod_undefined` returns `400 MALFORMED_ID`, because that is a client bug.',
          'A well-formed id that names nothing returns `404 PRODUCT_NOT_FOUND`. Collapsing both',
          'into 404 — as many APIs do — leaves the caller unable to tell a broken string',
          'interpolation from a deleted record.',
        ].join('\n'),
        tags: [TAG],
        params: ProductIdParams,
        headers: CorrelationHeaders,
        response: {
          200: { ...ref('ProductResponse'), description: 'The requested product.' },
          ...errorResponses({
            404: 'No product exists with that identifier (`PRODUCT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => resource(await service.getProduct(app.db, request.params.productId)),
  );

  app.patch<{ Params: ProductIdParamsType; Body: UpdateProductInput }>(
    '/products/:productId',
    {
      schema: {
        operationId: 'updateProduct',
        summary: 'Partially update a product',
        description: [
          'Updates only the properties present in the body.',
          '',
          'Omitting a property leaves it unchanged; sending an explicit `null` clears a',
          'nullable property. Those are different operations, and being able to express both',
          'is the reason this is PATCH rather than PUT.',
          '',
          '`tags` is replaced wholesale, not merged — send the complete list you want.',
          '',
          'An empty body returns `400`: it is far more often a client bug than a deliberate',
          'no-op. Setting `status` to `archived` here is equivalent to calling DELETE, and',
          'moving it away from `archived` un-archives the product and its variants.',
        ].join('\n'),
        tags: [TAG],
        params: ProductIdParams,
        body: ref('ProductUpdate'),
        headers: CorrelationHeaders,
        response: {
          200: { ...ref('ProductResponse'), description: 'The product after the update.' },
          ...errorResponses({
            404: 'No product exists with that identifier (`PRODUCT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) =>
      resource(await service.patchProduct(app.db, request.params.productId, request.body)),
  );

  app.delete<{ Params: ProductIdParamsType }>(
    '/products/:productId',
    {
      schema: {
        operationId: 'archiveProduct',
        summary: 'Archive a product',
        description: [
          '**Archives the product; it is not destroyed.** Status becomes `archived`,',
          '`archived_at` is set, and all of its variants are archived with it.',
          '',
          'Catalog records are referenced by historical orders. Hard-deleting a variant that a',
          "two-year-old order points at destroys that order's meaning, so retiring a product",
          'is a state change rather than a deletion. Archived products remain retrievable and',
          'still appear in `GET /products` unless you filter them out.',
          '',
          'Responds `200` with the archived product rather than `204 No Content`, so the state',
          'transition is visible in the response you are already looking at.',
          '',
          '**Idempotent.** Archiving an already-archived product returns `200` again, not a',
          'conflict — repeating a delete after a network timeout is not an error.',
        ].join('\n'),
        tags: [TAG],
        params: ProductIdParams,
        headers: CorrelationHeaders,
        response: {
          200: {
            ...ref('ProductResponse'),
            description: 'The archived product. Returned for a repeat call too.',
          },
          ...errorResponses({
            404: 'No product exists with that identifier (`PRODUCT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => resource(await service.archiveProduct(app.db, request.params.productId)),
  );

  // -------------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------------

  app.get<{ Params: ProductIdParamsType }>(
    '/products/:productId/variants',
    {
      schema: {
        operationId: 'listProductVariants',
        summary: "List a product's variants",
        description: [
          'Returns every variant of the product, ordered by `position` then `id`.',
          '',
          'Deliberately **not paginated**: a product has tens of variants, not thousands, and',
          'forcing a caller to page through a size run would be pointless ceremony. The',
          'response is capped at 250 variants, which is documented rather than assumed.',
          '',
          'Because it is not a paginated collection, the response has no `pagination` object —',
          'the one place in this API where a collection differs in shape, and it is called out',
          'here so that a governance review can confirm the reason rather than flag an',
          'inconsistency.',
          '',
          'An unknown product returns `404`, not an empty list: "this product has no variants"',
          'and "this product does not exist" are different facts.',
        ].join('\n'),
        tags: [TAG],
        params: ProductIdParams,
        headers: CorrelationHeaders,
        response: {
          200: { ...ref('VariantListResponse'), description: 'Every variant of the product.' },
          ...errorResponses({
            404: 'No product exists with that identifier (`PRODUCT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => ({ data: await service.listVariants(app.db, request.params.productId) }),
  );

  app.post<{ Params: ProductIdParamsType; Body: CreateVariantInput }>(
    '/products/:productId/variants',
    {
      schema: {
        operationId: 'createVariant',
        summary: 'Create a variant',
        description: [
          'Adds a variant to the product named in the path. The parent is taken from the URL,',
          'not the body, so the two cannot disagree.',
          '',
          '`sku` must be unique across the ENTIRE catalog, not merely within this product. A',
          'duplicate returns `409 SKU_ALREADY_EXISTS` with the conflicting variant id in',
          '`error.details`. Uniqueness is enforced by a database constraint rather than by a',
          'lookup before insert, because two concurrent requests can both pass a lookup.',
          '',
          '`position` defaults to one past the current highest.',
          '',
          'Responds `201` with a `Location` header.',
        ].join('\n'),
        tags: [TAG],
        params: ProductIdParams,
        body: ref('VariantCreate'),
        headers: CorrelationHeaders,
        response: {
          201: { ...ref('VariantResponse'), description: 'The variant that was created.' },
          ...errorResponses({
            404: 'No product exists with that identifier (`PRODUCT_NOT_FOUND`).',
            409: 'A variant with that SKU already exists (`SKU_ALREADY_EXISTS`).',
          }),
        },
      },
    },
    async (request, reply) => {
      const variant = await service.createVariant(app.db, request.params.productId, request.body);
      reply.code(201).header('location', `/api/v1/variants/${variant.id}`);
      return resource(variant);
    },
  );

  app.get<{ Params: VariantIdParamsType }>(
    '/variants/:variantId',
    {
      schema: {
        operationId: 'getVariant',
        summary: 'Retrieve a variant',
        description:
          'Returns one variant by identifier. Variants are addressable directly, without going ' +
          'through their product, because inventory and orders reference variants rather than ' +
          'products.',
        tags: [TAG],
        params: VariantIdParams,
        headers: CorrelationHeaders,
        response: {
          200: { ...ref('VariantResponse'), description: 'The requested variant.' },
          ...errorResponses({
            404: 'No variant exists with that identifier (`VARIANT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => resource(await service.getVariant(app.db, request.params.variantId)),
  );

  app.patch<{ Params: VariantIdParamsType; Body: UpdateVariantInput }>(
    '/variants/:variantId',
    {
      schema: {
        operationId: 'updateVariant',
        summary: 'Partially update a variant',
        description:
          'Updates only the properties present in the body, with the same omitted-versus-null ' +
          'semantics as updating a product. Changing `sku` is permitted and remains subject to ' +
          'global uniqueness, so it can return `409`.',
        tags: [TAG],
        params: VariantIdParams,
        body: ref('VariantUpdate'),
        headers: CorrelationHeaders,
        response: {
          200: { ...ref('VariantResponse'), description: 'The variant after the update.' },
          ...errorResponses({
            404: 'No variant exists with that identifier (`VARIANT_NOT_FOUND`).',
            409: 'Another variant already uses that SKU (`SKU_ALREADY_EXISTS`).',
          }),
        },
      },
    },
    async (request) =>
      resource(await service.patchVariant(app.db, request.params.variantId, request.body)),
  );

  app.delete<{ Params: VariantIdParamsType }>(
    '/variants/:variantId',
    {
      schema: {
        operationId: 'archiveVariant',
        summary: 'Archive a variant',
        description:
          'Archives the variant; it is not destroyed. Same rationale and same idempotency as ' +
          'archiving a product: historical orders reference variants, so retiring one is a ' +
          'state change. Responds `200` with the archived variant, including on a repeat call.',
        tags: [TAG],
        params: VariantIdParams,
        headers: CorrelationHeaders,
        response: {
          200: {
            ...ref('VariantResponse'),
            description: 'The archived variant. Returned for a repeat call too.',
          },
          ...errorResponses({
            404: 'No variant exists with that identifier (`VARIANT_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => resource(await service.archiveVariant(app.db, request.params.variantId)),
  );
}
