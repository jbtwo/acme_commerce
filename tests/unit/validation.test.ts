/**
 * Ajv error translation tests.
 *
 * Ajv's raw output is written for a schema author: it uses JSON-Pointer paths, omits the field
 * name from the message, and reads as a sentence fragment. A consumer debugging a failed POST
 * needs the field name, the rule, and — for a closed set — the values that would have worked.
 * These tests pin that translation, because it is the difference between an error that helps
 * and an error that requires reading the schema.
 */
import { describe, expect, it } from 'vitest';
import type { ErrorObject } from 'ajv';
import { translateAjvErrors } from '../../src/http/validation.js';

const err = (partial: Partial<ErrorObject>): ErrorObject =>
  ({
    instancePath: '',
    schemaPath: '#/x',
    keyword: 'type',
    params: {},
    message: 'is invalid',
    ...partial,
  }) as ErrorObject;

describe('translateAjvErrors', () => {
  it('names the missing property, which Ajv puts in params rather than the path', () => {
    const [problem] = translateAjvErrors('body', [
      err({ keyword: 'required', instancePath: '', params: { missingProperty: 'title' } }),
    ]);
    expect(problem).toEqual({
      field: 'body.title',
      rule: 'required',
      message: '"title" is required.',
    });
  });

  it('lists the permitted values for an enum, so the error tells you the answer', () => {
    const [problem] = translateAjvErrors('body', [
      err({
        keyword: 'enum',
        instancePath: '/status',
        params: { allowedValues: ['draft', 'active', 'archived'] },
      }),
    ]);
    expect(problem?.field).toBe('body.status');
    expect(problem?.allowed).toEqual(['draft', 'active', 'archived']);
    expect(problem?.message).toContain('draft, active, archived');
  });

  it('names an unknown property and explains why it was not ignored', () => {
    const [problem] = translateAjvErrors('body', [
      err({ keyword: 'additionalProperties', params: { additionalProperty: 'titel' } }),
    ]);
    expect(problem?.field).toBe('body.titel');
    expect(problem?.rule).toBe('unknown_property');
    expect(problem?.message).toMatch(/rejected rather than ignored/);
  });

  it('converts a JSON-Pointer path into a readable dotted path with array indices', () => {
    const [problem] = translateAjvErrors('body', [
      err({ keyword: 'minLength', instancePath: '/tags/2', params: { limit: 1 } }),
    ]);
    expect(problem?.field).toBe('body.tags[2]');
  });

  it('labels the querystring as "query", which is what a caller calls it', () => {
    const [problem] = translateAjvErrors('querystring', [
      err({ keyword: 'minimum', instancePath: '/page', params: { comparison: '>=', limit: 1 } }),
    ]);
    expect(problem?.field).toBe('query.page');
    expect(problem?.message).toContain('>= 1');
  });

  it('labels path parameters as "path"', () => {
    const [problem] = translateAjvErrors('params', [
      err({ keyword: 'pattern', instancePath: '/productId', params: { pattern: '^prod_' } }),
    ]);
    expect(problem?.field).toBe('path.productId');
  });

  it('explains minProperties in terms of an empty PATCH body', () => {
    const [problem] = translateAjvErrors('body', [
      err({ keyword: 'minProperties', params: { limit: 1 } }),
    ]);
    expect(problem?.rule).toBe('min_properties');
    expect(problem?.message).toMatch(/at least one property/);
  });

  it('reports every distinct problem, not just the first', () => {
    const problems = translateAjvErrors('body', [
      err({ keyword: 'required', params: { missingProperty: 'sku' } }),
      err({ keyword: 'required', params: { missingProperty: 'price_cents' } }),
      err({
        keyword: 'maximum',
        instancePath: '/position',
        params: { comparison: '<=', limit: 99 },
      }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.field)).toEqual(['body.sku', 'body.price_cents', 'body.position']);
  });

  it('de-duplicates the same field-and-rule, which Ajv emits for unions', () => {
    const duplicate = err({
      keyword: 'type',
      instancePath: '/price_cents',
      params: { type: 'integer' },
    });
    expect(translateAjvErrors('body', [duplicate, duplicate])).toHaveLength(1);
  });

  it('falls back gracefully on a keyword it does not know', () => {
    const [problem] = translateAjvErrors('body', [
      err({ keyword: 'multipleOf', instancePath: '/qty', message: 'must be multiple of 5' }),
    ]);
    expect(problem?.rule).toBe('multipleOf');
    expect(problem?.field).toBe('body.qty');
  });
});
