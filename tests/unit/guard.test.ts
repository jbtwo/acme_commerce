/**
 * Tests for the destructive-operation safety guard.
 *
 * This file matters more than its size suggests. The guard is the only thing standing between
 * a stale environment variable and a wiped development database, and a safety mechanism that
 * is never exercised is a comment that happens to compile.
 *
 * Note in particular the host-normalisation cases: comparing raw connection strings would let
 * `localhost` and `127.0.0.1` look like different databases when they are the same one, which
 * is exactly the accident the guard exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  assertDestructiveAllowed,
  assertSafeTestDatabase,
  checkTestDatabaseSafety,
  connectionTarget,
  looksLikeTestDatabase,
  normaliseHost,
  UnsafeDatabaseOperationError,
} from '../../src/db/guard.js';
import { parseConnectionString } from '../../src/config/index.js';

const APP = 'postgres://u:p@127.0.0.1:55432/acme_commerce_dev';
const TEST = 'postgres://u:p@127.0.0.1:55432/acme_commerce_test';

describe('normaliseHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'LOCALHOST'])(
    'collapses %s to a single canonical value',
    (host) => {
      expect(normaliseHost(host)).toBe('localhost');
    },
  );

  it('leaves a real hostname alone, lowercased', () => {
    expect(normaliseHost('Postgres.Unraid.Local')).toBe('postgres.unraid.local');
  });

  it('strips IPv6 brackets so [::1] and ::1 compare equal', () => {
    expect(normaliseHost('[::1]')).toBe(normaliseHost('::1'));
  });
});

describe('connectionTarget', () => {
  it('treats an omitted port as 5432, matching PostgreSQL', () => {
    expect(connectionTarget(parseConnectionString('postgres://u:p@db.local/acme'))).toBe(
      connectionTarget(parseConnectionString('postgres://u:p@db.local:5432/acme')),
    );
  });

  it('ignores credentials — the same database with two users is still the same database', () => {
    expect(connectionTarget(parseConnectionString('postgres://alice:x@db/acme'))).toBe(
      connectionTarget(parseConnectionString('postgres://bob:y@db/acme')),
    );
  });

  it('distinguishes different database names on the same server', () => {
    expect(connectionTarget(parseConnectionString(APP))).not.toBe(
      connectionTarget(parseConnectionString(TEST)),
    );
  });
});

describe('looksLikeTestDatabase', () => {
  it.each(['acme_commerce_test', 'test_acme', 'acme_test_ci'])('accepts %s', (name) => {
    expect(looksLikeTestDatabase(name)).toBe(true);
  });

  it.each(['acme_commerce', 'production', 'acme_commerce_dev', 'testing'])('rejects %s', (name) => {
    expect(looksLikeTestDatabase(name)).toBe(false);
  });
});

describe('checkTestDatabaseSafety', () => {
  it('permits a correctly configured test database', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      nodeEnv: 'test',
      appDatabaseUrl: APP,
      testDatabaseUrl: TEST,
    });
    expect(result.safe).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.target?.database).toBe('acme_commerce_test');
  });

  it('refuses when APP_ENV is production, even with an otherwise valid test database', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'production',
      appDatabaseUrl: APP,
      testDatabaseUrl: TEST,
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/production/i);
  });

  it('refuses when NODE_ENV is production even if APP_ENV is not', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      nodeEnv: 'production',
      appDatabaseUrl: APP,
      testDatabaseUrl: TEST,
    });
    expect(result.safe).toBe(false);
  });

  it('refuses when TEST_DATABASE_URL is missing, rather than falling back to DATABASE_URL', () => {
    const result = checkTestDatabaseSafety({ appEnv: 'test', appDatabaseUrl: APP });
    expect(result.safe).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/TEST_DATABASE_URL is not set/);
  });

  it('refuses when the test and application databases are literally identical', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      appDatabaseUrl: APP,
      testDatabaseUrl: APP,
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/same database/);
  });

  it('refuses when they differ only by localhost vs 127.0.0.1 — the accident this exists for', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      appDatabaseUrl: 'postgres://u:p@localhost:55432/acme_commerce_test',
      testDatabaseUrl: 'postgres://u:p@127.0.0.1:55432/acme_commerce_test',
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/same database/);
  });

  it('refuses when they differ only by an omitted default port', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      appDatabaseUrl: 'postgres://u:p@db.local/acme_test',
      testDatabaseUrl: 'postgres://u:p@db.local:5432/acme_test',
    });
    expect(result.safe).toBe(false);
  });

  it('refuses a database whose name does not look like a test database', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      appDatabaseUrl: APP,
      testDatabaseUrl: 'postgres://u:p@other.host:5432/acme_commerce',
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/does not look like a test database/);
  });

  it('refuses an unparseable TEST_DATABASE_URL instead of guessing', () => {
    const result = checkTestDatabaseSafety({ appEnv: 'test', testDatabaseUrl: 'not-a-url' });
    expect(result.safe).toBe(false);
  });

  it("does not block on an unparseable DATABASE_URL — that is the config layer's problem", () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'test',
      appDatabaseUrl: 'garbage',
      testDatabaseUrl: TEST,
    });
    expect(result.safe).toBe(true);
  });

  it('reports every reason at once rather than stopping at the first', () => {
    const result = checkTestDatabaseSafety({
      appEnv: 'production',
      appDatabaseUrl: APP,
      testDatabaseUrl: 'postgres://u:p@127.0.0.1:55432/acme_commerce',
    });
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('assertSafeTestDatabase', () => {
  it('returns the resolved target when safe', () => {
    const target = assertSafeTestDatabase({
      appEnv: 'test',
      appDatabaseUrl: APP,
      testDatabaseUrl: TEST,
    });
    expect(target.database).toBe('acme_commerce_test');
    expect(target.port).toBe(55432);
  });

  it('throws UnsafeDatabaseOperationError naming the operation and every reason', () => {
    expect(() =>
      assertSafeTestDatabase({ appEnv: 'production', testDatabaseUrl: TEST }, 'wipe everything'),
    ).toThrowError(UnsafeDatabaseOperationError);

    try {
      assertSafeTestDatabase({ appEnv: 'production', testDatabaseUrl: TEST }, 'wipe everything');
    } catch (err) {
      expect((err as Error).message).toContain('wipe everything');
      expect((err as UnsafeDatabaseOperationError).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('assertDestructiveAllowed', () => {
  it('permits a confirmed reset outside production', () => {
    expect(() =>
      assertDestructiveAllowed({ appEnv: 'development', confirmed: true }, 'reset'),
    ).not.toThrow();
  });

  it('refuses without explicit confirmation, even in development', () => {
    expect(() =>
      assertDestructiveAllowed({ appEnv: 'development', confirmed: false }, 'reset'),
    ).toThrowError(/Destructive intent was not stated/);
  });

  it('refuses in production even WITH confirmation — the flag is not an override', () => {
    expect(() =>
      assertDestructiveAllowed({ appEnv: 'production', confirmed: true }, 'reset'),
    ).toThrowError(/disabled in production/);
  });
});
