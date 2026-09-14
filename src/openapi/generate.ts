#!/usr/bin/env node
/**
 * Generate the committed OpenAPI snapshot, or verify that the committed one is current.
 *
 *   npm run openapi:generate   write openapi/openapi.json
 *   npm run openapi:check      regenerate, diff against the committed file, exit 1 on drift
 *
 * `openapi:check` is the mechanism that makes an undocumented API change a build failure.
 * Change a route schema without regenerating, and this fails with the paths that moved.
 *
 * Why keep a snapshot in the repository at all, when /openapi.json serves it live?
 *   - It is reviewable. A pull request shows the contract change as a diff, so a reviewer sees
 *     "this response field became optional" without running the server.
 *   - It is fetchable without a running application, by a consumer, a linter, or a mock.
 *   - It gives contract drift somewhere to be detected. A generated-only spec cannot drift,
 *     because there is nothing to compare it to.
 *
 * Deliberately does NOT need a database. It builds the app in-process, and the PostgreSQL pool
 * is lazy, so no connection is ever opened. That means CI can validate the contract before it
 * has provisioned a database, and a contributor can regenerate without one at all.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../app.js';
import type { Config } from '../config/index.js';
import { APP_VERSION } from '../version.js';

const OUTPUT_PATH = path.join(process.cwd(), 'openapi', 'openapi.json');

/**
 * A synthetic configuration for spec generation.
 *
 * Hard-coded rather than read from the environment on purpose: if it came from `.env`, the
 * generated document would vary by machine (different ports, different database names in the
 * /ready description) and `openapi:check` would fail for everyone but its author.
 */
function specConfig(): Config {
  return {
    appEnv: 'development',
    isProduction: false,
    host: '127.0.0.1',
    port: 3000,
    // No log output while generating a file; a pino line on stdout would corrupt nothing here
    // but is pure noise in CI.
    logLevel: 'silent',
    logPretty: false,
    migrateOnStartup: false,
    database: {
      connectionString: 'postgres://spec:spec@127.0.0.1:5432/spec',
      host: '127.0.0.1',
      port: 5432,
      database: 'spec',
      user: 'spec',
      ssl: 'disable',
      schema: 'acme',
      poolMax: 1,
      idleTimeoutMs: 1000,
      connectTimeoutMs: 1000,
      statementTimeoutMs: 1000,
    },
    auth: {
      // A fixed placeholder, never used to sign anything: generating the spec boots the app
      // but issues no tokens. Hard-coded rather than read from the environment for the same
      // reason as everything else here — the generated document must not vary by machine.
      tokenSecret: 'spec-generation-placeholder-not-a-real-signing-key',
      tokenTtlSeconds: 3600,
      rateLimitMax: 10,
      rateLimitWindowSeconds: 60,
    },
    testDatabaseUrl: undefined,
    version: APP_VERSION,
  };
}

/**
 * Serialize with sorted object keys.
 *
 * @fastify/swagger builds the document by iterating internal structures, and key order is not
 * guaranteed to be stable between runs or Node versions. Unstable key order would make
 * `openapi:check` fail at random and make every contract diff unreadable. Sorting is what
 * turns this file into a reviewable artifact.
 */
function stableStringify(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sortKeys(v)]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

async function generate(): Promise<string> {
  const app = await buildApp({ config: specConfig() });
  try {
    await app.ready();
    return stableStringify(app.swagger());
  } finally {
    await app.close();
  }
}

/** Report which top-level sections differ, so a failure is actionable without a manual diff. */
function describeDrift(committed: string, current: string): string[] {
  const notes: string[] = [];
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(committed) as Record<string, unknown>;
    b = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return ['The committed file is not valid JSON.'];
  }

  const pathsA = Object.keys((a.paths ?? {}) as object);
  const pathsB = Object.keys((b.paths ?? {}) as object);
  const added = pathsB.filter((p) => !pathsA.includes(p));
  const removed = pathsA.filter((p) => !pathsB.includes(p));
  if (added.length) notes.push(`Paths added: ${added.join(', ')}`);
  if (removed.length) notes.push(`Paths removed: ${removed.join(', ')}`);

  const schemasA = Object.keys(((a.components as Record<string, object>)?.schemas ?? {}) as object);
  const schemasB = Object.keys(((b.components as Record<string, object>)?.schemas ?? {}) as object);
  const schemaAdded = schemasB.filter((s) => !schemasA.includes(s));
  const schemaRemoved = schemasA.filter((s) => !schemasB.includes(s));
  if (schemaAdded.length) notes.push(`Schemas added: ${schemaAdded.join(', ')}`);
  if (schemaRemoved.length) notes.push(`Schemas removed: ${schemaRemoved.join(', ')}`);

  // Schemas that exist on both sides but whose contents differ. This is the most important
  // case and the easiest to miss: a renamed or retyped property changes no path and no schema
  // name, so name-set comparison alone reports nothing while the contract has in fact moved.
  for (const name of schemasB.filter((s) => schemasA.includes(s))) {
    const left = stableStringify(
      (a.components as Record<string, Record<string, unknown>>).schemas![name],
    );
    const right = stableStringify(
      (b.components as Record<string, Record<string, unknown>>).schemas![name],
    );
    if (left !== right) notes.push(`Schema changed: ${name}`);
  }

  for (const p of pathsB.filter((p) => pathsA.includes(p))) {
    const left = stableStringify((a.paths as Record<string, unknown>)[p]);
    const right = stableStringify((b.paths as Record<string, unknown>)[p]);
    if (left !== right) notes.push(`Operation changed: ${p}`);
  }

  if (notes.length === 0)
    notes.push('Differences are outside paths and schemas (info, tags, or servers).');
  return notes;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const current = await generate();

  if (!checkOnly) {
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, current, 'utf8');
    const parsed = JSON.parse(current) as {
      paths?: object;
      components?: { schemas?: object };
    };
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
    console.log(
      `  ${Object.keys(parsed.paths ?? {}).length} paths, ` +
        `${Object.keys(parsed.components?.schemas ?? {}).length} component schemas`,
    );
    return;
  }

  let committed: string;
  try {
    committed = await readFile(OUTPUT_PATH, 'utf8');
  } catch {
    console.error(
      `\nopenapi/openapi.json does not exist.\n` +
        `Run 'npm run openapi:generate' and commit the result.\n`,
    );
    process.exit(1);
  }

  if (committed === current) {
    console.log('OpenAPI snapshot is up to date.');
    return;
  }

  console.error(
    '\nCONTRACT DRIFT: the served OpenAPI document differs from openapi/openapi.json.\n',
  );
  for (const note of describeDrift(committed, current)) console.error(`  - ${note}`);
  console.error(
    `\nThe implementation changed without the contract being regenerated.\n` +
      `  1. Confirm the change is intended.\n` +
      `  2. If it is, run 'npm run openapi:generate' and commit openapi/openapi.json.\n` +
      `  3. If it is not, fix the route schema instead.\n` +
      `\nIf the change removes or renames a field, or narrows a type, it is a BREAKING change\n` +
      `for existing consumers even though this check treats every difference the same.\n`,
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
