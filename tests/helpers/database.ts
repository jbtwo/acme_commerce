/**
 * Integration-test database harness.
 *
 * Every integration test file resets the application schema in the DEDICATED test database
 * before it runs, so no test inherits another's leftovers. Vitest is configured with
 * `fileParallelism: false` precisely so that reset cannot happen while another file is
 * mid-assertion.
 *
 * The first thing this module does — before it opens a connection, let alone drops anything —
 * is run src/db/guard.ts. That is the difference between a test suite and an accident.
 */
import { loadConfig, loadDotEnvIfPresent, type Config } from '../../src/config/index.js';
import { assertSafeTestDatabase } from '../../src/db/guard.js';
import { createDatabase, createPool, type AppDatabase } from '../../src/db/index.js';
import { dropAndRecreateSchema, ensureSchema, migrateToLatest } from '../../src/db/migrator.js';
import { seedDatabase } from '../../src/db/seed/index.js';

let cachedConfig: Config | undefined;

/**
 * Build the configuration pointing at the TEST database, after proving it is safe to destroy.
 *
 * The guard checks, in order: not production; TEST_DATABASE_URL is set; it does not resolve to
 * the same (host, port, database) as DATABASE_URL; and its name looks like a test database.
 * Any failure throws with every reason listed, rather than proceeding.
 */
export function testConfig(): Config {
  if (cachedConfig) return cachedConfig;
  loadDotEnvIfPresent();

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  assertSafeTestDatabase(
    {
      appEnv: process.env.APP_ENV,
      nodeEnv: process.env.NODE_ENV,
      appDatabaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl,
    },
    'run integration tests against the configured database',
  );

  cachedConfig = loadConfig({
    // A fresh environment rather than a mutated `process.env`: the config layer refuses when
    // DATABASE_URL and the discrete PG* variables are both present, and a developer's shell
    // may well have PGHOST exported for unrelated reasons.
    env: {
      APP_ENV: 'test',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
      DATABASE_URL: testDatabaseUrl,
      DB_SSL: process.env.DB_SSL ?? 'disable',
      DB_SCHEMA: process.env.DB_SCHEMA ?? 'acme',
      DB_POOL_MAX: '5',
      MIGRATE_ON_STARTUP: 'false',
      // Fixed rather than random so a token signed in one test verifies in another within the
      // same run, and so a failure is reproducible.
      AUTH_TOKEN_SECRET: 'integration-test-signing-key-at-least-32-chars',
      AUTH_TOKEN_TTL_SECONDS: '3600',
      // High enough that a test suite hammering the token endpoint is not itself rate limited;
      // the limiter's own behaviour is covered by unit tests and one dedicated integration test.
      AUTH_RATE_LIMIT_MAX: '1000',
    },
    version: 'test',
  });
  return cachedConfig;
}

export interface TestDatabase {
  db: AppDatabase;
  config: Config;
  close: () => Promise<void>;
}

/**
 * Drop the application schema, re-apply every migration, and load seed data.
 *
 * Migrating from empty each time rather than truncating tables is slower by a few hundred
 * milliseconds and buys something worth having: every test run also exercises the migrations
 * themselves. A migration that does not apply cleanly to an empty database fails the test
 * suite instead of failing a deployment.
 */
export async function resetTestDatabase(options: { seed?: boolean } = {}): Promise<TestDatabase> {
  const config = testConfig();
  const pool = createPool(config.database);
  const db = createDatabase(pool, config.database.schema);

  await ensureSchema(db, config.database.schema);
  await dropAndRecreateSchema(db, config.database.schema);

  const result = await migrateToLatest(db, config.database.schema);
  if (result.error) {
    await db.destroy();
    throw new Error(`Test database migration failed: ${String(result.error)}`);
  }

  if (options.seed !== false) await seedDatabase(db);

  return { db, config, close: () => db.destroy() };
}
