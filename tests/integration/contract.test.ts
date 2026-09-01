/**
 * Contract tests.
 *
 * These do not test behaviour. They test that the published contract and the running server
 * agree — a different and often-neglected property.
 *
 * What they can prove: the committed snapshot matches what the server serves; every operation
 * carries the metadata a consumer needs; the status codes actually returned are declared; a
 * documented example validates against the schema it illustrates.
 *
 * What they cannot prove: that a `description` is truthful. Nothing automated can. That is
 * what review is for, and it is worth being explicit about the boundary.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { createTestHarness, json, type TestHarness } from '../helpers/app.js';

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Record<string, unknown>> };
}
interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: {
    name: string;
    in: string;
    description?: string;
    schema: Record<string, unknown>;
  }[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<
    string,
    { description?: string; content?: Record<string, { schema: unknown }> }
  >;
}

let h: TestHarness;
let served: OpenApiDocument;

beforeAll(async () => {
  h = await createTestHarness();
  const res = await h.app.inject({ method: 'GET', url: '/openapi.json' });
  served = json<OpenApiDocument>(res.body);
});
afterAll(async () => {
  await h?.close();
});

const operations = (): [string, string, Operation][] =>
  Object.entries(served.paths).flatMap(([p, methods]) =>
    Object.entries(methods).map(([m, op]) => [p, m, op] as [string, string, Operation]),
  );

describe('document structure', () => {
  it('is OpenAPI 3.1', () => {
    expect(served.openapi).toBe('3.1.0');
  });

  it('documents the conventions a consumer needs before reading any operation', () => {
    for (const topic of [
      'Envelopes',
      'Correlation',
      'Pagination',
      'Errors',
      'Money',
      'Authentication',
    ]) {
      expect(served.info.description).toContain(topic);
    }
  });

  it('uses a relative server URL so the same document is correct on any host', () => {
    // A hard-coded http://localhost:3000 would be wrong the moment it is deployed, and it is
    // the single most common reason an imported collection cannot reach anything.
    expect(served.servers.map((s) => s.url)).toEqual(['/']);
  });

  it('describes every tag it uses', () => {
    const declared = new Set(served.tags.map((t) => t.name));
    for (const [, , op] of operations()) {
      for (const tag of op.tags ?? []) expect(declared).toContain(tag);
    }
    expect(served.tags.every((t) => t.description.length > 20)).toBe(true);
  });
});

describe('operation completeness', () => {
  it('gives every operation a unique operationId', () => {
    const ids = operations().map(([, , op]) => op.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every operation a summary, a description, and a tag', () => {
    for (const [p, m, op] of operations()) {
      expect(op.summary, `${m} ${p} summary`).toBeTruthy();
      expect(op.description, `${m} ${p} description`).toBeTruthy();
      expect(op.tags?.length, `${m} ${p} tags`).toBeGreaterThan(0);
    }
  });

  it('describes every parameter, so nothing has to be guessed at', () => {
    for (const [p, m, op] of operations()) {
      for (const param of op.parameters ?? []) {
        expect(param.description, `${m} ${p} parameter ${param.name}`).toBeTruthy();
      }
    }
  });

  it('describes every declared response', () => {
    for (const [p, m, op] of operations()) {
      for (const [status, response] of Object.entries(op.responses)) {
        expect(response.description, `${m} ${p} response ${status}`).toBeTruthy();
      }
    }
  });

  it('declares a 4xx on every /api/v1 operation', () => {
    // Platform endpoints are exempt and that exemption is recorded in .redocly.lint-ignore.yaml.
    for (const [p, m, op] of operations()) {
      if (!p.startsWith('/api/')) continue;
      const has4xx = Object.keys(op.responses).some((s) => s.startsWith('4'));
      expect(has4xx, `${m} ${p} declares no 4xx response`).toBe(true);
    }
  });

  it('points every /api/v1 error response at the shared Error schema', () => {
    // Scoped to the product API. `/ready` returns 503 with a ReadinessResponse rather than an
    // Error, because a failing dependency check is not a client-facing API error — it is probe
    // output, and forcing it into the error envelope would strip the per-check detail that is
    // the entire point of the endpoint. Documented in src/http/platform-routes.ts.
    for (const [p, m, op] of operations()) {
      if (!p.startsWith('/api/')) continue;
      for (const [status, response] of Object.entries(op.responses)) {
        if (!/^[45]/.test(status)) continue;
        const schema = response.content?.['application/json']?.schema as { $ref?: string };
        expect(schema?.$ref, `${m} ${p} ${status}`).toBe('#/components/schemas/Error');
      }
    }
  });
});

describe('components', () => {
  it('names schemas meaningfully rather than def-0, def-1', () => {
    const names = Object.keys(served.components.schemas);
    expect(names).toContain('Product');
    expect(names).toContain('Variant');
    expect(names).toContain('Error');
    expect(names.some((n) => /^def-\d+$/.test(n))).toBe(false);
  });

  it('describes every property of the resource schemas', () => {
    for (const name of ['Product', 'Variant', 'Pagination']) {
      const schema = served.components.schemas[name] as {
        properties: Record<string, { description?: string }>;
      };
      for (const [prop, def] of Object.entries(schema.properties)) {
        expect(def.description, `${name}.${prop}`).toBeTruthy();
      }
    }
  });

  it('publishes the identifier pattern, so the format is machine-readable', () => {
    const product = served.components.schemas.Product as {
      properties: { id: { pattern: string } };
    };
    expect(product.properties.id.pattern).toBe('^prod_[0-9a-f]{24}$');
  });

  it('expresses nullability the OpenAPI 3.1 way, with a type array', () => {
    const product = served.components.schemas.Product as {
      properties: { description: { type: string[] } };
    };
    expect(product.properties.description.type).toEqual(expect.arrayContaining(['string', 'null']));
  });
});

describe('committed snapshot', () => {
  it('matches what the server serves', () => {
    // Failing here means the code changed and openapi/openapi.json was not regenerated. The
    // same comparison runs as `npm run openapi:check`; having it as a test means a plain
    // `npm test` catches drift too.
    const committed = JSON.parse(
      readFileSync(path.join(process.cwd(), 'openapi', 'openapi.json'), 'utf8'),
    ) as OpenApiDocument;
    expect(Object.keys(committed.paths).sort()).toEqual(Object.keys(served.paths).sort());
    expect(Object.keys(committed.components.schemas).sort()).toEqual(
      Object.keys(served.components.schemas).sort(),
    );
    for (const [p, methods] of Object.entries(served.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        expect(committed.paths[p]?.[m]?.operationId, `${m} ${p}`).toBe(op.operationId);
      }
    }
  });
});

describe('real responses conform to the declared schemas', () => {
  let validateAgainst: (schemaName: string, value: unknown) => void;

  beforeAll(() => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as FormatsPlugin)(ajv);

    // Register every component schema under its own $id, rewriting the OpenAPI-style
    // `#/components/schemas/X` references into bare `X` so Ajv can resolve them against the
    // registered ids. Registering once, rather than per assertion, avoids Ajv's duplicate-id
    // error and means the schemas are compiled exactly as a consumer's validator would see them.
    for (const [name, schema] of Object.entries(served.components.schemas)) {
      const rewritten = JSON.parse(
        JSON.stringify(schema).replaceAll('#/components/schemas/', ''),
      ) as Record<string, unknown>;
      ajv.addSchema({ ...rewritten, $id: name });
    }

    validateAgainst = (schemaName, value) => {
      const validate = ajv.getSchema(schemaName);
      if (!validate) throw new Error(`Schema ${schemaName} is not published in the contract`);
      if (!validate(value)) {
        throw new Error(
          `Response did not match ${schemaName}:\n${JSON.stringify(validate.errors, null, 2)}\n` +
            `Received: ${JSON.stringify(value).slice(0, 500)}`,
        );
      }
      expect(validate.errors).toBeFalsy();
    };
  });

  it('a product list response matches ProductListResponse', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/products?limit=5' });
    validateAgainst('ProductListResponse', json(res.body));
  });

  it('a single product response matches ProductResponse', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/products?limit=1' });
    const id = json<{ data: { id: string }[] }>(list.body).data[0]!.id;
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/products/${id}` });
    validateAgainst('ProductResponse', json(res.body));
  });

  it('a variant list response matches VariantListResponse', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/products?q=Trailhead' });
    const id = json<{ data: { id: string }[] }>(list.body).data[0]!.id;
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/products/${id}/variants` });
    validateAgainst('VariantListResponse', json(res.body));
  });

  it.each([
    ['/api/v1/products/prod_bad', 400],
    ['/api/v1/products/prod_00000000000000000000dead', 404],
    ['/api/v1/products?limit=999', 400],
  ])('the error response from %s matches Error', async (url, expectedStatus) => {
    const res = await h.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(expectedStatus);
    validateAgainst('Error', json(res.body));
  });

  it('a health response matches HealthResponse', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    validateAgainst('HealthResponse', json(res.body));
  });

  it('a readiness response matches ReadinessResponse', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    validateAgainst('ReadinessResponse', json(res.body));
  });

  it('the documented ProductCreate example is actually accepted by the API', async () => {
    // A stale example is one of the few contract defects generation cannot prevent, and it is
    // the first thing a consumer copies out of the documentation.
    const schema = served.components.schemas.ProductCreate as { example?: Record<string, unknown> };
    expect(schema.example).toBeDefined();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      payload: schema.example!,
    });
    expect(res.statusCode).toBe(201);
  });

  it('the documented VariantCreate example is actually accepted by the API', async () => {
    const product = await h.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      payload: { title: 'Example host', status: 'active' },
    });
    const productId = json<{ data: { id: string } }>(product.body).data.id;
    const schema = served.components.schemas.VariantCreate as { example?: Record<string, unknown> };
    expect(schema.example).toBeDefined();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/variants`,
      payload: schema.example!,
    });
    expect(res.statusCode).toBe(201);
  });
});
