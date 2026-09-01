/**
 * Platform endpoint integration tests.
 *
 * The distinction these pin down — liveness answers "is this process alive", readiness answers
 * "can it serve traffic" — is the one most commonly got wrong, and getting it wrong turns a
 * database blip into a full restart storm.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, json, type TestHarness } from '../helpers/app.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestHarness();
});
// Optional-chained on purpose: when beforeAll fails, an unguarded teardown throws a second,
// less informative error that buries the first.
afterAll(async () => {
  await h?.close();
});

describe('GET /health', () => {
  it('returns 200 with process state', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = json<{ status: string; service: string; uptime_seconds: number }>(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('acme-commerce');
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('carries X-Request-Id like every other response', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('reports the version, which is how you confirm a deploy took effect', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(json<{ version: string }>(res.body).version).toBe('test');
  });
});

describe('GET /ready', () => {
  it('returns 200 with all three checks passing against a migrated database', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = json<{ status: string; checks: Record<string, { status: string }> }>(res.body);
    expect(body.status).toBe('ready');
    expect(body.checks.configuration?.status).toBe('ok');
    expect(body.checks.database?.status).toBe('ok');
    expect(body.checks.migrations?.status).toBe('ok');
  });

  it('reports a duration per check, so slow and unreachable look different', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    const body = json<{ checks: Record<string, { duration_ms: number }> }>(res.body);
    expect(body.checks.database?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('never exposes the database password, even outside production', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.body).toContain('****');
    expect(res.body).not.toMatch(/:[^*@/]{6,}@/);
  });

  it('reports migration currency, not merely connectivity', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    const body = json<{ checks: { migrations: { detail: string } } }>(res.body);
    expect(body.checks.migrations.detail).toMatch(/applied.*current/);
  });
});

describe('GET /openapi.json', () => {
  it('serves an OpenAPI 3.1 document', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const spec = json<{ openapi: string; info: { title: string } }>(res.body);
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Acme Commerce API');
  });
});

describe('GET /docs', () => {
  it('serves Swagger UI', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});

describe('request correlation', () => {
  it('echoes a valid caller-supplied X-Request-Id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'checkout-attempt-42' },
    });
    expect(res.headers['x-request-id']).toBe('checkout-attempt-42');
  });

  it('replaces an invalid one silently rather than failing the request', async () => {
    // Failing a request over a cosmetic tracing header would be hostile. Accepting it verbatim
    // would be a log-injection vector. Replacing it is the third option.
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'has spaces\nand a newline' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('replaces one that is too long', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'a'.repeat(200) },
    });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('puts the request id on error responses too, in the header and the body', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/products/prod_zzz',
      headers: { 'x-request-id': 'trace-me-please' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-request-id']).toBe('trace-me-please');
    expect(json<{ error: { request_id: string } }>(res.body).error.request_id).toBe(
      'trace-me-please',
    );
  });

  it('correlates a 404 from the router, which no handler ever saw', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(json<{ error: { code: string } }>(res.body).error.code).toBe('ROUTE_NOT_FOUND');
  });
});
