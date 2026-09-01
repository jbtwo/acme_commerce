/**
 * Resource identifiers.
 *
 * Format: `<prefix>_<24 lowercase hex characters>`
 *
 *   prod_0199f3a9c4e2  1b7d05f6a3b8
 *   \__/ \__________/  \__________/
 *    |         |             |
 *    |         |             +-- 12 hex of cryptographic randomness (48 bits)
 *    |         +---------------- 12 hex of Unix epoch milliseconds (good to the year 10889)
 *    +-------------------------- resource type
 *
 * Two properties are being bought here.
 *
 * 1. The prefix makes a MALFORMED identifier syntactically distinguishable from a WELL-FORMED
 *    identifier that does not exist. `prod_zzz` is a client bug (400); `prod_0000...0000` is a
 *    request for something absent (404). Most APIs collapse both into 404 and leave the caller
 *    unable to tell "I sent garbage" from "it's gone".
 *
 * 2. The timestamp prefix makes IDs lexicographically sortable by creation time, which is why
 *    appending `id` as a tiebreaker to an `ORDER BY created_at` produces a stable, sensible
 *    order rather than an arbitrary one.
 *
 * Tradeoff, recorded in docs/DECISIONS.md: this is not a standard format. A client library that
 * expects UUIDs will not recognise it. The format is documented in the OpenAPI contract with an
 * explicit `pattern`, so the constraint is machine-readable rather than folklore.
 */
import { randomBytes } from 'node:crypto';

export const ID_PREFIXES = {
  product: 'prod',
  variant: 'var',
  request: 'req',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;

const HEX_LENGTH = 24;
const TIMESTAMP_HEX_LENGTH = 12;
const RANDOM_BYTES = 6; // 6 bytes -> 12 hex characters

/** Compiled once per prefix; building a RegExp per request would be wasteful and needless. */
const PATTERN_CACHE = new Map<string, RegExp>();

export function idPattern(prefix: string): RegExp {
  let re = PATTERN_CACHE.get(prefix);
  if (!re) {
    re = new RegExp(`^${prefix}_[0-9a-f]{${HEX_LENGTH}}$`);
    PATTERN_CACHE.set(prefix, re);
  }
  return re;
}

/** The same constraint as a string, for embedding in JSON Schema / OpenAPI. */
export function idPatternString(prefix: string): string {
  return `^${prefix}_[0-9a-f]{${HEX_LENGTH}}$`;
}

export function generateId(kind: ResourceKind, now: number = Date.now()): string {
  const ts = now.toString(16).padStart(TIMESTAMP_HEX_LENGTH, '0').slice(-TIMESTAMP_HEX_LENGTH);
  const rand = randomBytes(RANDOM_BYTES).toString('hex');
  return `${ID_PREFIXES[kind]}_${ts}${rand}`;
}

export function isValidId(kind: ResourceKind, value: unknown): value is string {
  return typeof value === 'string' && idPattern(ID_PREFIXES[kind]).test(value);
}

/**
 * Recover the creation timestamp encoded in an ID. Useful when debugging a log line that
 * contains an ID and nothing else. Returns null for anything not matching the format.
 */
export function timestampFromId(kind: ResourceKind, value: string): Date | null {
  if (!isValidId(kind, value)) return null;
  const hex = value.slice(
    ID_PREFIXES[kind].length + 1,
    ID_PREFIXES[kind].length + 1 + TIMESTAMP_HEX_LENGTH,
  );
  const ms = Number.parseInt(hex, 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export const productId = () => generateId('product');
export const variantId = () => generateId('variant');
export const requestId = () => generateId('request');
