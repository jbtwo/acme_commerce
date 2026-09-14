/**
 * Password hashing with scrypt.
 *
 * scrypt is in `node:crypto`, so this needs no dependency, and it is a correct modern choice
 * alongside argon2 and bcrypt. What makes all three correct and a bare SHA-256 wrong is that
 * they are deliberately **slow and memory-hard**: the cost is the security property. A fast
 * hash lets an attacker with a stolen database try billions of candidates per second.
 *
 * That same cost is why the endpoint calling this is rate-limited — see
 * src/http/rate-limit.ts. An unauthenticated endpoint running a deliberately expensive
 * function per request is a denial-of-service vector as much as a login form.
 *
 * Encoded form:
 *
 *     scrypt$16384$8$1$<salt-base64>$<hash-base64>
 *     ^      ^     ^ ^  ^             ^
 *     |      N     r p  salt          derived key
 *     algorithm
 *
 * The parameters travel with the hash rather than living in code, so N can be raised later
 * without invalidating every existing row: old hashes keep verifying with their own
 * parameters, and rehashing can happen opportunistically on next successful login.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Node's defaults. N=16384 is ~16 MB of memory per hash and a few tens of milliseconds. */
const DEFAULT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt's own guard rejects N*r*128 above maxmem; give it room for the parameters we use. */
const maxmemFor = (N: number, r: number): number => 256 * N * r;

export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params.N, params.r),
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns false rather than throwing on a malformed stored hash. A corrupt row should fail
 * the login, not crash the endpoint — and it must fail in a way indistinguishable from a wrong
 * password, or the error becomes an oracle telling an attacker which accounts are broken.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile or corrupt row must not be able to make us allocate gigabytes.
  if (N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, Buffer.from(parts[4]!, 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    return false;
  }

  // Constant-time. A byte-by-byte `===` leaks how many leading bytes matched via timing,
  // which over enough samples reconstructs the hash. `timingSafeEqual` throws on a length
  // mismatch, which is why the lengths are reconciled above.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
