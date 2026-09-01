/**
 * Safety guards for destructive database tooling.
 *
 * Two operations in this repository can destroy data: the integration test bootstrap (which
 * drops and recreates the application schema between test files) and `npm run db:reset`.
 * Both call into this module first and refuse to proceed unless every check passes.
 *
 * The guard is defence in depth against a specific, extremely common accident: a stale
 * `.env`, a forgotten shell export, or a copy-pasted command wiping the database you were
 * actually using. It is unit-tested in tests/unit/guard.test.ts, because an untested
 * safety mechanism is a comment that looks like code.
 */
import { parseConnectionString, type ParsedConnection } from '../config/index.js';

export interface GuardInput {
  /** APP_ENV */
  appEnv?: string | undefined;
  /** NODE_ENV */
  nodeEnv?: string | undefined;
  /** The normal application connection string (DATABASE_URL). */
  appDatabaseUrl?: string | undefined;
  /** The connection string the destructive operation wants to target. */
  testDatabaseUrl?: string | undefined;
}

export interface GuardResult {
  safe: boolean;
  /** Every reason the operation was refused. Empty when `safe` is true. */
  reasons: string[];
  /** The resolved test target, when it could be parsed. */
  target?: ParsedConnection;
}

/**
 * Collapse the many spellings of "this machine" into one value.
 *
 * This is the check that actually earns its keep. Comparing raw connection strings would let
 * `postgres://u:p@localhost:5432/acme` and `postgres://u:p@127.0.0.1:5432/acme` look like two
 * different databases when they are one database, and the guard would wave through a reset of
 * the developer's own data. Same for an omitted port, which means 5432.
 */
export function normaliseHost(host: string): string {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(h)) {
    return 'localhost';
  }
  return h;
}

/** The comparable address of a database: host, port, and database name. Credentials excluded. */
export function connectionTarget(parsed: ParsedConnection): string {
  return `${normaliseHost(parsed.host)}:${parsed.port}/${parsed.database}`;
}

/**
 * Does this database name look like it was created for testing?
 *
 * A name-shape heuristic is weaker than the identity comparison above, and it catches a
 * different mistake: pointing TEST_DATABASE_URL at a real database on a *different* host,
 * where the identity check has nothing to compare against.
 */
export function looksLikeTestDatabase(databaseName: string): boolean {
  return /(^test_|_test$|_test_)/i.test(databaseName);
}

export function checkTestDatabaseSafety(input: GuardInput): GuardResult {
  const reasons: string[] = [];

  // -- 1. Never in production, under any circumstances ----------------------
  const envs = [input.appEnv, input.nodeEnv].filter(Boolean).map((v) => v!.trim().toLowerCase());
  if (envs.includes('production')) {
    reasons.push(
      'APP_ENV or NODE_ENV is "production". Destructive database tooling is unconditionally ' +
        'disabled in production.',
    );
  }

  // -- 2. A test target must be configured ----------------------------------
  const testUrl = input.testDatabaseUrl?.trim();
  if (!testUrl) {
    reasons.push(
      'TEST_DATABASE_URL is not set. Destructive tooling will not fall back to the ' +
        'application database — an unset variable must never resolve to "use the real one".',
    );
    return { safe: false, reasons };
  }

  let testTarget: ParsedConnection;
  try {
    testTarget = parseConnectionString(testUrl);
  } catch (err) {
    reasons.push(`TEST_DATABASE_URL ${(err as Error).message}`);
    return { safe: false, reasons };
  }

  // -- 3. The test target must not BE the application database --------------
  const appUrl = input.appDatabaseUrl?.trim();
  if (appUrl) {
    try {
      const appTarget = parseConnectionString(appUrl);
      if (connectionTarget(appTarget) === connectionTarget(testTarget)) {
        reasons.push(
          `TEST_DATABASE_URL and DATABASE_URL resolve to the same database ` +
            `(${connectionTarget(testTarget)}). Running this would destroy the data you are ` +
            `developing against.`,
        );
      }
    } catch {
      // An unparseable DATABASE_URL is the config layer's problem to report, not the guard's.
      // It is not a reason to block a test run.
    }
  }

  // -- 4. The name must look intentional ------------------------------------
  if (!looksLikeTestDatabase(testTarget.database)) {
    reasons.push(
      `Database "${testTarget.database}" does not look like a test database. The name must ` +
        `match one of: test_*, *_test, *_test_*. Rename the database rather than relaxing ` +
        `this check.`,
    );
  }

  return reasons.length === 0
    ? { safe: true, reasons: [], target: testTarget }
    : { safe: false, reasons, target: testTarget };
}

export class UnsafeDatabaseOperationError extends Error {
  readonly reasons: string[];
  constructor(operation: string, reasons: string[]) {
    super(
      `Refusing to ${operation}.\n\n` +
        reasons.map((r) => `  ✗ ${r}`).join('\n') +
        `\n\nSee docs/MILESTONE_1_PLAN.md §4 and docs/POSTGRES_SETUP.md for the rules.\n`,
    );
    this.name = 'UnsafeDatabaseOperationError';
    this.reasons = reasons;
  }
}

/** Throws unless every safety check passes. Returns the verified target. */
export function assertSafeTestDatabase(
  input: GuardInput,
  operation = 'operate on the test database',
): ParsedConnection {
  const result = checkTestDatabaseSafety(input);
  if (!result.safe) throw new UnsafeDatabaseOperationError(operation, result.reasons);
  return result.target!;
}

export interface DestructiveIntentInput {
  appEnv?: string | undefined;
  nodeEnv?: string | undefined;
  /** True when the operator passed --i-know-this-deletes-data or CONFIRM_DESTRUCTIVE=yes. */
  confirmed: boolean;
}

/**
 * Gate for `npm run db:reset`, which drops the application schema in the *development*
 * database. Distinct from the test guard: the target here is intentionally the dev database,
 * so identity comparison is meaningless and explicit human intent is the safeguard.
 *
 * There is no interactive prompt. A prompt cannot run in CI, and a prompt that can be piped
 * `yes` into is not a safeguard.
 */
export function assertDestructiveAllowed(input: DestructiveIntentInput, operation: string): void {
  const reasons: string[] = [];
  const envs = [input.appEnv, input.nodeEnv].filter(Boolean).map((v) => v!.trim().toLowerCase());

  if (envs.includes('production')) {
    reasons.push('APP_ENV or NODE_ENV is "production". This command is disabled in production.');
  }
  if (!input.confirmed) {
    reasons.push(
      'Destructive intent was not stated. Re-run with the flag --i-know-this-deletes-data, ' +
        'or set CONFIRM_DESTRUCTIVE=yes in the environment.',
    );
  }
  if (reasons.length > 0) throw new UnsafeDatabaseOperationError(operation, reasons);
}
