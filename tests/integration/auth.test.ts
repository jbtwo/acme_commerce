/**
 * Authentication and authorization over HTTP.
 *
 * The 403 matrix is the part that matters most: it exercises the `support` role against
 * **every** write endpoint rather than one representative. A thin authorization test is how
 * exactly one route ends up ungated, and nothing else would notice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestHarness,
  json,
  SEED_LOGINS,
  type ApiError,
  type TestHarness,
} from '../helpers/app.js';

let h: TestHarness;
let devAuth: string;
let supportAuth: string;

beforeAll(async () => {
  h = await createTestHarness();
  devAuth = await bearer(h, 'developer');
  supportAuth = await bearer(h, 'support');
});
afterAll(async () => {
  await h?.close();
});

const errorOf = (body: string) => json<ApiError>(body).error;

describe('POST /api/v1/auth/token', () => {
  it('issues a token for valid credentials', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: SEED_LOGINS.developer,
    });
    expect(res.statusCode).toBe(200);
    const d = json<{ data: Record<string, unknown> }>(res.body).data;
    expect(String(d.access_token).split('.')).toHaveLength(3);
    expect(d.token_type).toBe('Bearer');
    expect(d.expires_in).toBe(3600);
  });

  it('sets Cache-Control: no-store so the token is not cached by anything in between', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: SEED_LOGINS.developer,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is case-insensitive about the email', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { email: 'DEV@ACME.EXAMPLE', password: SEED_LOGINS.developer.password },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns the identity alongside the token, so a client need not decode it', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: SEED_LOGINS.support,
    });
    const p = json<{ data: { principal: { role: string; permissions: string[] } } }>(res.body).data
      .principal;
    expect(p.role).toBe('support');
    expect(p.permissions).not.toContain('inventory:write');
  });

  it.each([
    ['wrong password', { email: 'dev@acme.example', password: 'nope' }],
    ['unknown email', { email: 'nobody@acme.example', password: 'dev-password-123' }],
  ])('returns an indistinguishable 401 for %s', async (_label, payload) => {
    // Identical code and message for both, so the endpoint cannot be used to discover which
    // accounts exist.
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload });
    expect(res.statusCode).toBe(401);
    const err = errorOf(res.body);
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(err.message).toBe('Email or password is incorrect.');
  });

  it('never echoes the password back in an error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { email: 'dev@acme.example', password: 'hunter2-should-not-appear' },
    });
    expect(res.body).not.toContain('hunter2-should-not-appear');
  });

  it('rejects a missing password with 400, not 401 — that is a malformed request', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { email: 'dev@acme.example' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('describes the caller', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: devAuth },
    });
    expect(res.statusCode).toBe(200);
    const d = json<{ data: Record<string, unknown> }>(res.body).data;
    expect(d.email).toBe('dev@acme.example');
    expect(d.role).toBe('developer');
    expect(d.permissions).toContain('catalog:write');
    expect(typeof d.token_expires_at).toBe('string');
  });

  it('never returns the password hash', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: devAuth },
    });
    expect(res.body).not.toContain('scrypt');
    expect(res.body).not.toContain('password');
  });
});

describe('401 — the four distinct causes', () => {
  it.each([
    ['no Authorization header', undefined, 'AUTHENTICATION_REQUIRED'],
    ['wrong scheme', 'Basic dXNlcjpwYXNz', 'INVALID_TOKEN'],
    ['Bearer with no token', 'Bearer', 'INVALID_TOKEN'],
    ['a token that is not a JWT', 'Bearer not-a-jwt', 'INVALID_TOKEN'],
  ])('%s -> %s', async (_label, header, expected) => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      ...(header ? { headers: { authorization: header } } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe(expected);
  });

  it('rejects a token signed with a different secret', async () => {
    // Forged with the right shape and the wrong key.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(
        JSON.stringify({ sub: 'usr_x', email: 'e', name: 'n', role: 'admin', exp: 9e9, iat: 1 }),
      ).toString('base64url') +
      '.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo';
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe('INVALID_TOKEN');
  });

  it('sets WWW-Authenticate, which is what tells a generic client how to retry', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });
});

describe('403 — the support role against every write endpoint', () => {
  const writes: [string, 'POST' | 'PATCH' | 'DELETE', string, string, unknown][] = [
    ['create product', 'POST', '/api/v1/products', 'catalog:write', { title: 'x' }],
    [
      'update product',
      'PATCH',
      '/api/v1/products/prod_00000000000000000000dead',
      'catalog:write',
      { title: 'x' },
    ],
    [
      'archive product',
      'DELETE',
      '/api/v1/products/prod_00000000000000000000dead',
      'catalog:write',
      undefined,
    ],
    [
      'create variant',
      'POST',
      '/api/v1/products/prod_00000000000000000000dead/variants',
      'catalog:write',
      { sku: 's', title: 't', price_cents: 1 },
    ],
    [
      'update variant',
      'PATCH',
      '/api/v1/variants/var_00000000000000000000dead',
      'catalog:write',
      { title: 'x' },
    ],
    [
      'archive variant',
      'DELETE',
      '/api/v1/variants/var_00000000000000000000dead',
      'catalog:write',
      undefined,
    ],
    [
      'create location',
      'POST',
      '/api/v1/locations',
      'locations:write',
      { name: 'x', type: 'warehouse' },
    ],
    [
      'update location',
      'PATCH',
      '/api/v1/locations/loc_00000000000000000000dead',
      'locations:write',
      { name: 'x' },
    ],
  ];

  it.each(writes)('support cannot %s', async (_label, method, url, permission, payload) => {
    const res = await h.app.inject({
      method,
      url,
      headers: { authorization: supportAuth },
      ...(payload ? { payload } : {}),
    });
    // 403, not 404 — the authorization gate runs before the resource is looked up, so a
    // non-existent id in the path is irrelevant here.
    expect(res.statusCode, `${method} ${url}`).toBe(403);
    const err = errorOf(res.body);
    expect(err.code).toBe('INSUFFICIENT_PERMISSION');
    expect(err.details?.required_permission).toBe(permission);
  });

  it('names the permissions the caller does hold, so the fix is self-service', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { authorization: supportAuth },
      payload: { name: 'x', type: 'warehouse' },
    });
    expect(errorOf(res.body).details?.your_permissions).toEqual(
      expect.arrayContaining(['locations:read']),
    );
  });

  it('lets the same support token through on every read', async () => {
    for (const url of [
      '/api/v1/products',
      '/api/v1/locations',
      '/api/v1/auth/me',
      '/api/v1/inventory',
      '/api/v1/inventory/history',
      '/api/v1/pricing/ACME-BAG-BLK',
    ]) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { authorization: supportAuth },
      });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

describe('the Milestone 1 catalog, after auth arrived', () => {
  it('still serves reads to anonymous callers — a storefront has no credentials', async () => {
    for (const url of [
      '/api/v1/products',
      '/api/v1/products/prod_7ebf51270d4d3de9f7acad4c',
      '/api/v1/products/prod_7ebf51270d4d3de9f7acad4c/variants',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('now refuses anonymous writes', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      payload: { title: 'anonymous' },
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe('AUTHENTICATION_REQUIRED');
  });
});
