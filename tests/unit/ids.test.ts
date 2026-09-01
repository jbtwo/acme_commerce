/**
 * Identifier format tests.
 *
 * The format is part of the published contract (it appears as a `pattern` on every `id`
 * property in the OpenAPI document), so changing it is a breaking change for consumers. These
 * tests are what make that concrete rather than aspirational.
 */
import { describe, expect, it } from 'vitest';
import {
  generateId,
  idPattern,
  idPatternString,
  isValidId,
  productId,
  requestId,
  timestampFromId,
  variantId,
} from '../../src/domain/ids.js';

describe('generateId', () => {
  it('produces the documented shape for each resource kind', () => {
    expect(productId()).toMatch(/^prod_[0-9a-f]{24}$/);
    expect(variantId()).toMatch(/^var_[0-9a-f]{24}$/);
    expect(requestId()).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('is unique across a large batch', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => productId()));
    expect(ids.size).toBe(20_000);
  });

  it('sorts lexicographically by creation time', () => {
    // The reason `ORDER BY created_at, id` produces a sensible order rather than an arbitrary
    // one within a millisecond.
    const early = generateId('product', new Date('2024-01-01T00:00:00Z').getTime());
    const later = generateId('product', new Date('2026-01-01T00:00:00Z').getTime());
    expect(early < later).toBe(true);
  });

  it('keeps the same width across a very wide range of timestamps', () => {
    for (const ms of [0, 1, Date.now(), new Date('2099-12-31T23:59:59Z').getTime()]) {
      expect(generateId('product', ms)).toMatch(/^prod_[0-9a-f]{24}$/);
    }
  });
});

describe('isValidId', () => {
  it('accepts a well-formed id of the right kind', () => {
    expect(isValidId('product', 'prod_0199f3a9c4e21b7d05f6a3b8')).toBe(true);
  });

  it('rejects the right shape with the wrong prefix', () => {
    // The whole reason for prefixes: a variant id is not silently usable as a product id.
    expect(isValidId('product', 'var_0199f3a9c4e21b7d05f6a3b8')).toBe(false);
  });

  it.each([
    ['prod_zzz', 'too short and not hex'],
    ['prod_undefined', 'the classic broken string interpolation'],
    ['prod_0199F3A9C4E21B7D05F6A3B8', 'uppercase hex'],
    ['prod-0199f3a9c4e21b7d05f6a3b8', 'hyphen instead of underscore'],
    ['0199f3a9c4e21b7d05f6a3b8', 'no prefix'],
    ['prod_0199f3a9c4e21b7d05f6a3b', '23 characters, one short'],
    ['prod_0199f3a9c4e21b7d05f6a3b8c', '25 characters, one long'],
    ['', 'empty string'],
  ])('rejects %s (%s)', (value) => {
    expect(isValidId('product', value)).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(isValidId('product', value)).toBe(false);
    }
  });
});

describe('idPatternString', () => {
  it('matches the compiled RegExp, so the contract and the code cannot disagree', () => {
    // The string form goes into OpenAPI; the RegExp form validates at runtime. If they ever
    // diverge, the API would reject an id its own contract declares valid.
    const asString = idPatternString('prod');
    const asRegExp = idPattern('prod');
    expect(new RegExp(asString).source).toBe(asRegExp.source);
    expect(asRegExp.test('prod_0199f3a9c4e21b7d05f6a3b8')).toBe(true);
  });
});

describe('timestampFromId', () => {
  it('recovers the creation time embedded in an id', () => {
    const when = new Date('2026-03-15T12:34:56.000Z');
    const id = generateId('product', when.getTime());
    expect(timestampFromId('product', id)?.toISOString()).toBe(when.toISOString());
  });

  it('returns null for a malformed id rather than a nonsense date', () => {
    expect(timestampFromId('product', 'prod_zzz')).toBeNull();
  });
});
