#!/usr/bin/env node
/**
 * Database command-line tool.
 *
 *   npm run migrate:up       apply every pending migration
 *   npm run migrate:down     roll back exactly one migration
 *   npm run migrate:status   report applied and pending migrations (read-only)
 *   npm run migrate:create   scaffold a new timestamped migration file
 *   npm run db:seed          load realistic development data (idempotent)
 *   npm run db:reset         DESTRUCTIVE: drop the app schema, migrate, and seed
 *
 * In a container the compiled equivalents are `node dist/db/cli.js <command>`.
 *
 * This tool talks to the connection in DATABASE_URL / PG* — the same one the application
 * uses. That is intentional for migrations (you migrate the database you run against) and it
 * is exactly why `reset` is gated behind an explicit destructive-intent flag.
 */
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, loadDotEnvIfPresent, redactConnectionString } from '../config/index.js';
import { createDatabase, createPool, pingDatabase, type AppDatabase } from './index.js';
import {
  dropAndRecreateSchema,
  ensureSchema,
  getMigrationStatus,
  migrateDownOne,
  migrateToLatest,
  migrationFolder,
} from './migrator.js';
import { assertDestructiveAllowed, UnsafeDatabaseOperationError } from './guard.js';
import { seedDatabase } from './seed/index.js';
import { APP_VERSION } from '../version.js';

const COMMANDS = ['up', 'down', 'status', 'create', 'seed', 'reset'] as const;
type Command = (typeof COMMANDS)[number];

function usage(): string {
  return `
Acme Commerce database tool

  Usage: node dist/db/cli.js <command> [options]
         npm run migrate:up

  Commands:
    up                 Apply all pending migrations
    down               Roll back the most recently applied migration
    status             Show applied and pending migrations (makes no changes)
    create <name>      Scaffold a new migration file
    seed               Load development seed data (idempotent, non-destructive)
    reset              DESTRUCTIVE: drop the application schema, re-migrate, re-seed

  Options:
    --i-know-this-deletes-data   Required by 'reset'. Or set CONFIRM_DESTRUCTIVE=yes.
`;
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n${message}\n`);
  process.exit(exitCode);
}

async function withDatabase<T>(fn: (db: AppDatabase, schema: string) => Promise<T>): Promise<T> {
  loadDotEnvIfPresent();
  const config = loadConfig({ version: APP_VERSION });
  const pool = createPool(config.database);
  const db = createDatabase(pool, config.database.schema);
  try {
    return await fn(db, config.database.schema);
  } finally {
    await db.destroy(); // also ends the underlying pool
  }
}

async function commandStatus(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  console.log(`Database: ${redactConnectionString(config.database.connectionString)}`);
  console.log(`Schema:   ${config.database.schema}\n`);

  const pool = createPool(config.database);
  const db = createDatabase(pool, config.database.schema);
  try {
    await pingDatabase(db);
    const status = await getMigrationStatus(db, config.database.schema);
    if (status.total === 0) {
      console.log('No migration files found in ' + migrationFolder());
      return;
    }
    for (const name of status.applied) console.log(`  [applied] ${name}`);
    for (const name of status.pending) console.log(`  [pending] ${name}`);
    console.log(
      `\n${status.applied.length} applied, ${status.pending.length} pending, ${status.total} total.`,
    );
    if (status.lastAppliedAt) console.log(`Last applied at ${status.lastAppliedAt.toISOString()}.`);
    console.log(status.isUpToDate ? 'Database is up to date.' : 'Database is NOT up to date.');
    // Non-zero exit when migrations are pending, so CI and deployment scripts can gate on it
    // without parsing this output.
    if (!status.isUpToDate) process.exitCode = 2;
  } finally {
    await db.destroy();
  }
}

async function commandUp(): Promise<void> {
  await withDatabase(async (db, schema) => {
    const before = await getMigrationStatus(db, schema).catch(() => null);
    if (before && before.pending.length === 0 && before.total > 0) {
      console.log('Nothing to do — already up to date.');
      return;
    }
    const result = await migrateToLatest(db, schema);
    for (const name of result.applied) console.log(`  applied  ${name}`);
    for (const name of result.failed) console.error(`  FAILED   ${name}`);
    if (result.error) {
      // Kysely rolls back the failing migration's transaction; earlier ones stay applied.
      fail(
        `Migration failed:\n${result.error instanceof Error ? result.error.stack : String(result.error)}`,
      );
    }
    console.log(
      result.applied.length === 0
        ? 'Nothing to do — already up to date.'
        : `\n${result.applied.length} migration(s) applied.`,
    );
  });
}

async function commandDown(): Promise<void> {
  await withDatabase(async (db, schema) => {
    const result = await migrateDownOne(db, schema);
    if (result.error) {
      fail(
        `Rollback failed:\n${result.error instanceof Error ? result.error.stack : String(result.error)}`,
      );
    }
    console.log(
      result.applied.length === 0
        ? 'Nothing to roll back.'
        : `Rolled back: ${result.applied.join(', ')}`,
    );
  });
}

async function commandCreate(rawName: string | undefined): Promise<void> {
  if (!rawName)
    fail('A migration name is required.\n  npm run migrate:create -- add_product_handle');
  const slug = rawName!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) fail(`"${rawName}" does not produce a usable migration name.`);

  const folder = migrationFolder();
  const existing = (await readdir(folder)).filter((f) => /^\d{4}_/.test(f));
  const nextNumber = String(existing.length + 1).padStart(4, '0');
  const fileName = `${nextNumber}_${slug}.ts`;
  const filePath = path.join(folder, fileName);

  // Sequential numbering rather than a timestamp: with one developer, sequential names are
  // readable and sort correctly. Two people creating migrations on separate branches would
  // collide, and the fix at that point is a timestamp prefix — noted here rather than
  // pre-solved for a team that does not exist yet.
  const template = `import { sql, type Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function up(db: Kysely<any>): Promise<void> {
  await sql\`
    -- TODO: forward migration
  \`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql\`
    -- TODO: reverse the change made in up()
  \`.execute(db);
}
`;
  await writeFile(filePath, template, { flag: 'wx' });
  console.log(`Created ${path.relative(process.cwd(), filePath)}`);
  console.log('Remember: update src/db/schema.ts to match, or Kysely types will drift.');
}

async function commandSeed(): Promise<void> {
  await withDatabase(async (db, schema) => {
    const status = await getMigrationStatus(db, schema);
    if (!status.isUpToDate) {
      fail(
        `Cannot seed: ${status.pending.length} migration(s) are pending. Run 'npm run migrate:up' first.`,
      );
    }
    const summary = await seedDatabase(db);
    console.log(
      `Seeded ${summary.products} products, ${summary.variants} variants, ` +
        `${summary.users} users, ${summary.locations} locations, ` +
        `${summary.inventoryLevels} inventory levels, ${summary.pricingRules} pricing rules.`,
    );
  });
}

async function commandReset(argv: string[]): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const confirmed =
    argv.includes('--i-know-this-deletes-data') ||
    (process.env.CONFIRM_DESTRUCTIVE ?? '').toLowerCase() === 'yes';

  assertDestructiveAllowed(
    { appEnv: config.appEnv, nodeEnv: process.env.NODE_ENV, confirmed },
    `drop and recreate schema "${config.database.schema}" in ` +
      `${redactConnectionString(config.database.connectionString)}`,
  );

  console.log(`Resetting schema "${config.database.schema}"`);
  console.log(`  in ${redactConnectionString(config.database.connectionString)}`);
  console.log('  This destroys all Acme Commerce data in that schema.\n');

  const pool = createPool(config.database);
  const db = createDatabase(pool, config.database.schema);
  try {
    await dropAndRecreateSchema(db, config.database.schema);
    console.log('  schema dropped and recreated');
    await ensureSchema(db, config.database.schema);
    const result = await migrateToLatest(db, config.database.schema);
    if (result.error) fail(`Migration failed after reset: ${String(result.error)}`);
    console.log(`  ${result.applied.length} migration(s) applied`);
    const summary = await seedDatabase(db);
    console.log(
      `  ${summary.products} products, ${summary.variants} variants, ` +
        `${summary.users} users, ${summary.locations} locations, ` +
        `${summary.inventoryLevels} levels, ${summary.pricingRules} pricing rules seeded`,
    );
    console.log('\nReset complete.');
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const [, , rawCommand, ...rest] = process.argv;
  if (!rawCommand || rawCommand === '--help' || rawCommand === '-h') {
    console.log(usage());
    return;
  }
  if (!COMMANDS.includes(rawCommand as Command)) {
    fail(`Unknown command "${rawCommand}".${usage()}`);
  }

  switch (rawCommand as Command) {
    case 'up':
      return commandUp();
    case 'down':
      return commandDown();
    case 'status':
      return commandStatus();
    case 'create':
      return commandCreate(rest[0]);
    case 'seed':
      return commandSeed();
    case 'reset':
      return commandReset(rest);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UnsafeDatabaseOperationError) fail(err.message, 3);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
