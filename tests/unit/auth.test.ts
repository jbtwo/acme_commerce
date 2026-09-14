/**
 * Authentication primitives.
 *
 * The token cases are the ones worth having: `alg: none` and signature tampering are named,
 * repeatedly-exploited JWT attacks, and a verifier that stops rejecting them fails silently —
 * every legitimate request still works.
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/domain/auth/passwords.js';
import {
  extractBearerToken,
  signToken,
  verifyToken,
  TokenVerificationError,
} from '../../src/domain/auth/tokens.js';
import {
  PERMISSIONS,
  ROLES,
  isRole,
  permissionsForRole,
  roleHasPermission,
} from '../../src/domain/auth/permissions.js';
import { FixedWindowRateLimiter } from '../../src/http/rate-limit.js';

const SECRET = 'unit-test-signing-key-at-least-32-characters-long';
const CLAIMS = {
  sub: 'usr_01',
  email: 'dev@acme.example',
  name: 'Dev',
  role: 'developer',
} as const;

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('encodes its parameters so they can be raised without invalidating existing rows', async () => {
    const hash = await hashPassword('x');
    expect(hash.split('$').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
  });

  it('verifies against a hash made with different parameters', async () => {
    const cheap = await hashPassword('x', { N: 1024, r: 8, p: 1 });
    expect(await verifyPassword('x', cheap)).toBe(true);
  });

  it.each([
    ['garbage', 'not an encoded hash'],
    ['scrypt$16384$8', 'too few segments'],
    ['bcrypt$16384$8$1$AAAA$AAAA', 'wrong algorithm'],
    ['scrypt$abc$8$1$AAAA$AAAA', 'non-numeric parameters'],
    ['scrypt$99999999$8$1$AAAA$AAAA', 'absurd N that would exhaust memory'],
  ])('returns false rather than throwing on %s (%s)', async (encoded) => {
    // A corrupt row must fail the login the same way a wrong password does. Throwing would
    // turn the error into an oracle telling an attacker which accounts are broken.
    await expect(verifyPassword('x', encoded)).resolves.toBe(false);
  });
});

describe('tokens', () => {
  it('produces three base64url segments with readable claims', async () => {
    const { token } = await signToken(CLAIMS, { secret: SECRET, ttlSeconds: 3600 });
    const [header, payload, signature] = token.split('.');
    expect([header, payload, signature].every(Boolean)).toBe(true);
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    // Signed, not encrypted: the claims are legible to anyone holding the token.
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({
      sub: 'usr_01',
      role: 'developer',
    });
  });

  it('verifies a token it signed', async () => {
    const { token } = await signToken(CLAIMS, { secret: SECRET, ttlSeconds: 3600 });
    const verified = await verifyToken(token, { secret: SECRET });
    expect(verified.sub).toBe('usr_01');
    expect(verified.role).toBe('developer');
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signToken(CLAIMS, { secret: SECRET, ttlSeconds: 3600 });
    await expect(
      verifyToken(token, { secret: 'a-completely-different-key-32-chars-plus' }),
    ).rejects.toThrow(TokenVerificationError);
  });

  it('rejects a tampered payload — this is what "tamper-evident" means', async () => {
    const { token } = await signToken(CLAIMS, { secret: SECRET, ttlSeconds: 3600 });
    const [header, , signature] = token.split('.');
    const escalated = Buffer.from(JSON.stringify({ ...CLAIMS, role: 'admin' })).toString(
      'base64url',
    );
    await expect(
      verifyToken(`${header}.${escalated}.${signature}`, { secret: SECRET }),
    ).rejects.toThrow();
  });

  it('rejects alg: none', async () => {
    // The classic JWT attack: if the verifier honours the token's own `alg` header, an
    // attacker sets it to `none`, supplies no signature, and forges any claims they like.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, exp: 9e9, iat: 1 })).toString(
      'base64url',
    );
    await expect(verifyToken(`${header}.${payload}.`, { secret: SECRET })).rejects.toThrow();
  });

  it('reports expiry distinctly, because only then does re-authenticating help', async () => {
    const { token } = await signToken(CLAIMS, {
      secret: SECRET,
      ttlSeconds: 60,
      now: new Date(Date.now() - 3_600_000),
    });
    await expect(verifyToken(token, { secret: SECRET })).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('reports every other failure as invalid', async () => {
    await expect(verifyToken('not.a.jwt', { secret: SECRET })).rejects.toMatchObject({
      reason: 'invalid',
    });
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['BEARER   abc123', 'abc123'],
  ])('accepts %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  it.each(['Basic abc', 'abc', 'Bearer', 'Bearer a b', ''])('rejects %j', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe('permissions', () => {
  it('gives admin every permission', () => {
    expect([...permissionsForRole('admin')].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('makes support read-only across every domain', () => {
    const writes = permissionsForRole('support').filter((p) => p.endsWith(':write'));
    expect(writes).toEqual([]);
    expect(permissionsForRole('support').length).toBeGreaterThan(0);
  });

  it('gives developer catalog and inventory write but support neither', () => {
    expect(roleHasPermission('developer', 'inventory:write')).toBe(true);
    expect(roleHasPermission('support', 'inventory:write')).toBe(false);
    expect(roleHasPermission('support', 'inventory:read')).toBe(true);
  });

  it('never grants a permission outside the declared set', () => {
    for (const role of ROLES) {
      for (const p of permissionsForRole(role)) expect(PERMISSIONS).toContain(p);
    }
  });

  it('recognises valid roles and nothing else', () => {
    expect(isRole('developer')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit then refuses', () => {
    const rl = new FixedWindowRateLimiter({ max: 3, windowSeconds: 60 });
    const t = 1_000_000;
    expect([1, 2, 3].map(() => rl.check('ip', t).allowed)).toEqual([true, true, true]);
    expect(rl.check('ip', t).allowed).toBe(false);
  });

  it('reports a Retry-After only once it is refusing', () => {
    const rl = new FixedWindowRateLimiter({ max: 1, windowSeconds: 60 });
    const t = 1_000_000;
    expect(rl.check('ip', t).retryAfterSeconds).toBe(0);
    expect(rl.check('ip', t).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each client separately', () => {
    const rl = new FixedWindowRateLimiter({ max: 1, windowSeconds: 60 });
    const t = 1_000_000;
    rl.check('a', t);
    expect(rl.check('a', t).allowed).toBe(false);
    expect(rl.check('b', t).allowed).toBe(true);
  });

  it('starts a fresh window once the old one passes', () => {
    const rl = new FixedWindowRateLimiter({ max: 1, windowSeconds: 60 });
    const t = 1_000_000;
    rl.check('ip', t);
    expect(rl.check('ip', t).allowed).toBe(false);
    expect(rl.check('ip', t + 61_000).allowed).toBe(true);
  });

  it('clears a key on reset, so a successful login is not punished by its own failures', () => {
    const rl = new FixedWindowRateLimiter({ max: 1, windowSeconds: 60 });
    const t = 1_000_000;
    rl.check('ip', t);
    rl.reset('ip');
    expect(rl.check('ip', t).allowed).toBe(true);
  });
});
