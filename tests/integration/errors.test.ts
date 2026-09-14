/**
 * Structured error behaviour.
 *
 * Every assertion here is about the contract a client actually programs against: the status
 * code, the stable `error.code`, and the presence of `request_id`. Where an error is supposed
 * to be *useful* — naming the offending field, listing permitted values — that is asserted
 * too, because "returns 400" and "returns a 400 you can act on" are different products.
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
let productId: string;

beforeAll(async () => {
  h = await createTestHarness();
  auth = await bearer(h, 'developer');
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: { authorization: auth },
    payload: { title: 'Error fixture product', status: 'active' },
  });
  productId = json<{ data: { id: string } }>(res.body).data.id;
});
afterAll(async () => {
  await h?.close();
});

const expectError = (body: string, code: string): ApiError['error'] => {
  const parsed = json<ApiError>(body);
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.request_id).toMatch(/^(req_[0-9a-f]{24}|[A-Za-z0-9_-]{1,128})$/);
  expect(typeof parsed.error.message).toBe('string');
  expect(parsed.error.message.length).toBeGreaterThan(0);
  return parsed.error;
};

describe('identifier errors', () => {
  it('404 PRODUCT_NOT_FOUND for a well-formed id that names nothing', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/products/prod_00000000000000000000dead',
    });
    expect(res.statusCode).toBe(404);
    const err = expectError(res.body, 'PRODUCT_NOT_FOUND');
    expect(err.details?.product_id).toBe('prod_00000000000000000000dead');
  });

  it('404 VARIANT_NOT_FOUND likewise', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/variants/var_00000000000000000000dead',
    });
    expect(res.statusCode).toBe(404);
    expectError(res.body, 'VARIANT_NOT_FOUND');
  });

  it('400 MALFORMED_ID for a syntactically invalid id, with the expected pattern', async () => {
    // The distinction that matters: 400 says "your string is wrong", 404 says "it is gone".
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products/prod_undefined' });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'MALFORMED_ID');
    expect(err.details?.expected_pattern).toBe('^prod_[0-9a-f]{24}$');
    expect(err.details?.value).toBe('prod_undefined');
  });

  it('400 MALFORMED_ID when a variant id is passed where a product id belongs', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/products/var_0199f3a9c4e21b7d05f6a3b8',
    });
    expect(res.statusCode).toBe(400);
    expectError(res.body, 'MALFORMED_ID');
  });

  it.each([
    'DELETE /api/v1/products/prod_bad',
    'GET /api/v1/products/prod_bad/variants',
    'GET /api/v1/variants/nope',
    'DELETE /api/v1/variants/nope',
  ])('%s also returns MALFORMED_ID', async (spec) => {
    const [method, url] = spec.split(' ') as [string, string];
    // Authenticated: on a protected route the auth gate runs first, so without a token this
    // would be 401 and would say nothing about the identifier. See the test below.
    const res = await h.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(400);
    expectError(res.body, 'MALFORMED_ID');
  });

  it('authenticates before it validates — an anonymous caller learns nothing about their input', async () => {
    // DELETE is protected, so a malformed id from an unauthenticated caller is 401, not 400.
    // That ordering is deliberate: the auth gate is outside everything, and telling an
    // anonymous caller "your identifier was well-formed but the resource is missing" is a
    // disclosure they have not earned.
    const anonymous = await h.app.inject({ method: 'DELETE', url: '/api/v1/products/prod_bad' });
    expect(anonymous.statusCode).toBe(401);
    expectError(anonymous.body, 'AUTHENTICATION_REQUIRED');

    // The identical request with a token reaches validation and gets the useful answer.
    const authenticated = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/products/prod_bad',
      headers: { authorization: auth },
    });
    expect(authenticated.statusCode).toBe(400);
    expectError(authenticated.body, 'MALFORMED_ID');
  });

  it('404 ROUTE_NOT_FOUND is distinct from a missing resource', async () => {
    // This is the error you get from a wrong base URL, and telling it apart from
    // PRODUCT_NOT_FOUND turns a dead end into a diagnosis.
    const res = await h.app.inject({ method: 'GET', url: '/api/v2/products' });
    expect(res.statusCode).toBe(404);
    const err = expectError(res.body, 'ROUTE_NOT_FOUND');
    expect(err.details?.path).toBe('/api/v2/products');
  });
});

describe('body validation errors', () => {
  it('names a missing required field', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: auth },
      payload: { vendor: 'Acme' },
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { field: string; rule: string }[];
    expect(fields[0]).toMatchObject({ field: 'body.title', rule: 'required' });
  });

  it('lists the permitted values for an invalid enum', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: auth },
      payload: { title: 'X', status: 'pending' },
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { field: string; allowed?: string[] }[];
    expect(fields[0]?.field).toBe('body.status');
    expect(fields[0]?.allowed).toEqual(['draft', 'active', 'archived']);
  });

  it('rejects an unknown property rather than silently dropping it', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: auth },
      payload: { title: 'X', titel: 'typo' },
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { field: string; rule: string }[];
    expect(fields[0]).toMatchObject({ field: 'body.titel', rule: 'unknown_property' });
  });

  it('rejects a client-supplied id — identifiers are server-assigned', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: auth },
      payload: { title: 'X', id: 'prod_0199f3a9c4e21b7d05f6a3b8' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports several field problems in one response', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/variants`,
      headers: { authorization: auth },
      payload: { position: 0 },
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    expect((err.details?.fields as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an empty PATCH body', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${productId}`,
      headers: { authorization: auth },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { rule: string }[];
    expect(fields[0]?.rule).toBe('min_properties');
  });

  it.each([
    ['negative', -100],
    ['non-integer', 19.99],
    ['a numeric string', '1999'],
  ])('rejects a price that is %s', async (_label, price) => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/variants`,
      headers: { authorization: auth },
      payload: {
        sku: `BAD-${Date.now()}-${Math.random()}`,
        title: 'Bad price',
        price_cents: price,
      },
    });
    expect(res.statusCode).toBe(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });

  it('does NOT coerce a numeric string in a body, unlike a query parameter', async () => {
    // Coercion is enabled for query strings (where everything is a string) and disabled for
    // bodies (where JSON already carries types). Sending "1999" for a number is a client bug.
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/variants`,
      headers: { authorization: auth },
      payload: { sku: `COERCE-${Date.now()}`, title: 'X', price_cents: '1999' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 INVALID_JSON with the parser message for malformed JSON', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'content-type': 'application/json', authorization: auth },
      payload: '{"title":',
    });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'INVALID_JSON');
    expect(err.details?.parser_message).toBeDefined();
  });

  it('answers 401 before it ever looks at the body — auth is the outermost gate', async () => {
    // Registered as an onRequest hook rather than a preHandler, so authentication runs before
    // body parsing and before schema validation. Without that, an anonymous caller sending
    // malformed JSON to a protected route would get 400 and learn that the route exists and
    // what it expects. Now every protected route answers anonymous callers identically.
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });
    expect(res.statusCode).toBe(401);
    expectError(res.body, 'AUTHENTICATION_REQUIRED');
  });

  it('returns 415 for a non-JSON content type', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'content-type': 'text/plain', authorization: auth },
      payload: 'title=X',
    });
    expect(res.statusCode).toBe(415);
    expectError(res.body, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('query parameter validation errors', () => {
  it.each([
    ['?page=0', 'page below the minimum'],
    ['?page=-1', 'a negative page'],
    ['?limit=0', 'a zero limit'],
    ['?limit=101', 'a limit above the maximum'],
    ['?limit=abc', 'a non-numeric limit'],
    ['?limit=1.5', 'a fractional limit'],
    ['?status=nonsense', 'an unknown status'],
    ['?order=sideways', 'an unknown sort direction'],
  ])('rejects %s (%s)', async (query) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/products${query}` });
    expect(res.statusCode).toBe(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });

  it('rejects a sort field outside the allowlist and names the permitted ones', async () => {
    // The allowlist is a SQL-injection boundary as well as a contract boundary.
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products?sort=password' });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { allowed?: string[] }[];
    expect(fields[0]?.allowed).toContain('created_at');
    expect(fields[0]?.allowed).not.toContain('password');
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    // `?statuss=active` silently returning everything is worse than a loud 400.
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products?statuss=active' });
    expect(res.statusCode).toBe(400);
    const err = expectError(res.body, 'VALIDATION_ERROR');
    const fields = err.details?.fields as { field: string }[];
    expect(fields[0]?.field).toBe('query.statuss');
  });

  it('does coerce a valid numeric string in a query parameter', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products?limit=5&page=1' });
    expect(res.statusCode).toBe(200);
    expect(json<{ pagination: { limit: number } }>(res.body).pagination.limit).toBe(5);
  });
});

describe('error envelope consistency', () => {
  it('uses the same shape for every error, whatever produced it', async () => {
    const cases = [
      { method: 'GET' as const, url: '/api/v1/products/prod_bad' },
      { method: 'GET' as const, url: '/api/v1/products/prod_00000000000000000000dead' },
      { method: 'GET' as const, url: '/api/v1/products?limit=999' },
      { method: 'GET' as const, url: '/nope' },
      { method: 'POST' as const, url: '/api/v1/products', payload: {} },
    ];
    for (const c of cases) {
      const res = await h.app.inject(c);
      const body = json<ApiError>(res.body);
      expect(Object.keys(body)).toEqual(['error']);
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('request_id');
      expect(res.headers['x-request-id']).toBe(body.error.request_id);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('never leaks a stack trace or SQL into an error body', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products/prod_bad' });
    expect(res.body).not.toMatch(/\bat .*\.ts:\d+/);
    expect(res.body.toLowerCase()).not.toContain('select ');
  });
});
