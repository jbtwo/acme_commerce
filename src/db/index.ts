/**
 * PostgreSQL connection pool and Kysely instance.
 *
 * One pool per process. The pool is created at startup and closed during graceful shutdown;
 * nothing else in the application opens a connection.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { PoolConfig } from 'pg';
import type { DatabaseConfig } from '../config/index.js';
import type { Database } from './schema.js';

const { Pool, types } = pg;

/**
 * Stop node-postgres from parsing `bigint` (OID 20) into a JavaScript number.
 *
 * A JS number loses precision above 2^53. `COUNT(*)` comes back as bigint, and the default
 * parser hands you a string for exactly this reason. We convert deliberately at the one place
 * it matters (the pagination total) rather than globally, so the loss is visible in code
 * instead of implicit.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => value);

function sslConfig(mode: DatabaseConfig['ssl']): PoolConfig['ssl'] {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      // Verifies the server certificate chain. Correct across any network you do not control.
      return { rejectUnauthorized: true };
    case 'no-verify':
      // Encrypts the connection but does NOT authenticate the server, so it protects against
      // passive eavesdropping and not against an active attacker. Acceptable only as a
      // stopgap for a self-signed certificate.
      return { rejectUnauthorized: false };
  }
}

export function buildPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.connectionString,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectTimeoutMs,
    ssl: sslConfig(config.ssl),
    // Server-side cap. A runaway query is cancelled by PostgreSQL instead of pinning a
    // connection until the pool starves.
    ...(config.statementTimeoutMs > 0 ? { statement_timeout: config.statementTimeoutMs } : {}),
    // Pins every connection to the application's own schema. Combined with `withSchema()`
    // below this is redundant, and it is kept because raw SQL in migrations relies on it.
    options: `-c search_path=${config.schema}`,
    // Shows up in pg_stat_activity, so "which client is holding this lock" has an answer.
    application_name: 'acme-commerce',
  };
}

export function createPool(config: DatabaseConfig): pg.Pool {
  const pool = new Pool(buildPoolConfig(config));
  // A pool with no 'error' listener crashes the process when an idle backend dies — for
  // instance when PostgreSQL restarts underneath us. Handling it lets the pool recycle
  // the connection and lets /ready report the outage instead of the container exiting.
  pool.on('error', (err) => {
    process.emitWarning(`Idle PostgreSQL client error: ${err.message}`, 'DatabasePoolWarning');
  });
  return pool;
}

export type AppDatabase = Kysely<Database>;

/**
 * Build the Kysely instance, scoped to the application schema.
 *
 * `.withSchema()` qualifies every table reference Kysely generates, so a query cannot
 * accidentally resolve against `public` if search_path is ever different from what we expect.
 */
export function createDatabase(pool: pg.Pool, schema: string): AppDatabase {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema(schema);
}

/** Round-trip a trivial query. Used by /ready and by the CLI to prove connectivity. */
export async function pingDatabase(db: AppDatabase): Promise<void> {
  await sql`select 1`.execute(db);
}

/** Convert a bigint-as-string (see the type parser above) into a safe JS number. */
export function toCount(value: string | number | bigint): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Count ${String(value)} exceeds the safe integer range`);
  }
  return n;
}
