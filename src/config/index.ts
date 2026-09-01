/**
 * Configuration loading and validation.
 *
 * Design rule: the application reads configuration exactly once, at startup, validates all
 * of it, and either produces a fully-typed `Config` object or refuses to start with a message
 * naming every problem it found.
 *
 * Why fail fast, and why report ALL errors rather than the first one: a process that boots
 * with a missing variable and then throws on the first request that needs it has converted a
 * five-second startup failure into a production incident. And an operator fixing config on a
 * remote server should not have to restart six times to discover six typos.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnv = 'development' | 'test' | 'production';
export type SslMode = 'disable' | 'require' | 'no-verify';

export interface DatabaseConfig {
  /** Full connection string, always materialised even when discrete PG* vars were supplied. */
  connectionString: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: SslMode;
  schema: string;
  poolMax: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface Config {
  appEnv: AppEnv;
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  logPretty: boolean;
  migrateOnStartup: boolean;
  database: DatabaseConfig;
  /** Present only when TEST_DATABASE_URL (or discrete test vars) is configured. */
  testDatabaseUrl: string | undefined;
  /** Read from package.json at build time; surfaced by /health for deployment verification. */
  version: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Load a `.env` file into process.env if one exists, using Node's built-in loader.
 *
 * No `dotenv` dependency: Node has done this natively since 20.12. Values already present in
 * the real environment win, which is the behaviour you want — an operator's `-e` flag or a
 * CI secret must not be silently overridden by a file that happened to get into the image.
 */
export function loadDotEnvIfPresent(cwd: string = process.cwd()): boolean {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

const VALID_APP_ENVS: readonly AppEnv[] = ['development', 'test', 'production'];
const VALID_SSL_MODES: readonly SslMode[] = ['disable', 'require', 'no-verify'];
const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/** Reads a boolean the forgiving way. Operators type `1`, `yes`, and `TRUE`. */
function parseBoolean(raw: string | undefined, fallback: boolean): boolean | null {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  return null; // signals "unparseable" so the caller can record a problem
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number },
): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (n < min || n > max) return null;
  return n;
}

/**
 * Turn a set of discrete PG* variables into a connection string, so that the rest of the
 * application only ever deals with one representation.
 */
function buildConnectionString(parts: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  const u = encodeURIComponent(parts.user);
  const p = encodeURIComponent(parts.password);
  const h = parts.host.includes(':') ? `[${parts.host}]` : parts.host; // IPv6 literal
  return `postgres://${u}:${p}@${h}:${parts.port}/${encodeURIComponent(parts.database)}`;
}

export interface ParsedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
}

/**
 * Parse a PostgreSQL connection string into its addressable parts.
 * Throws a plain Error on anything unparseable; callers convert that into a config problem.
 */
export function parseConnectionString(connectionString: string): ParsedConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(
      `has unsupported scheme "${url.protocol}" (expected postgres:// or postgresql://)`,
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('does not name a database (nothing after the final "/")');
  // `new URL` strips IPv6 brackets into hostname already; keep the bare form for comparison.
  const host = url.hostname;
  if (!host) throw new Error('does not name a host');
  return {
    host,
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    database,
    user: decodeURIComponent(url.username),
  };
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  version?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const problems: string[] = [];

  // -- Application environment ---------------------------------------------
  const rawAppEnv = (env.APP_ENV ?? env.NODE_ENV ?? 'development').trim() as AppEnv;
  let appEnv: AppEnv = 'development';
  if (!VALID_APP_ENVS.includes(rawAppEnv)) {
    problems.push(`APP_ENV must be one of ${VALID_APP_ENVS.join(' | ')} (got "${rawAppEnv}")`);
  } else {
    appEnv = rawAppEnv;
  }

  // -- HTTP -----------------------------------------------------------------
  const host = (env.HOST ?? '127.0.0.1').trim();
  // 0 is permitted and means "let the operating system assign an ephemeral port". Tests and
  // local experiments rely on it; a deployment should always set a real port.
  const port = parseInteger(env.PORT, 3000, { min: 0, max: 65535 });
  if (port === null)
    problems.push(`PORT must be an integer between 0 and 65535 (got "${env.PORT}")`);

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(' | ')} (got "${logLevel}")`);
  }
  const logPretty = parseBoolean(env.LOG_PRETTY, false);
  if (logPretty === null) problems.push(`LOG_PRETTY must be a boolean (got "${env.LOG_PRETTY}")`);

  const migrateOnStartup = parseBoolean(env.MIGRATE_ON_STARTUP, false);
  if (migrateOnStartup === null) {
    problems.push(`MIGRATE_ON_STARTUP must be a boolean (got "${env.MIGRATE_ON_STARTUP}")`);
  }

  // -- Database connection: DATABASE_URL xor discrete PG* -------------------
  const hasUrl = Boolean(env.DATABASE_URL?.trim());
  const discreteKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const;
  const presentDiscrete = discreteKeys.filter((k) => Boolean(env[k]?.trim()));

  let connectionString = '';
  if (hasUrl && presentDiscrete.length > 0) {
    problems.push(
      `Set either DATABASE_URL or the discrete PG* variables, not both. ` +
        `Found DATABASE_URL together with ${presentDiscrete.join(', ')}. ` +
        `Resolving this silently would make the effective connection depend on precedence ` +
        `rules nobody remembers.`,
    );
  } else if (hasUrl) {
    connectionString = env.DATABASE_URL!.trim();
  } else if (presentDiscrete.length > 0) {
    const missing = discreteKeys.filter((k) => k !== 'PGPORT' && !env[k]?.trim());
    if (missing.length > 0) {
      problems.push(`Incomplete discrete database configuration: missing ${missing.join(', ')}`);
    } else {
      const pgPort = parseInteger(env.PGPORT, 5432, { min: 1, max: 65535 });
      if (pgPort === null) {
        problems.push(`PGPORT must be an integer between 1 and 65535 (got "${env.PGPORT}")`);
      } else {
        connectionString = buildConnectionString({
          host: env.PGHOST!.trim(),
          port: pgPort,
          database: env.PGDATABASE!.trim(),
          user: env.PGUSER!.trim(),
          password: env.PGPASSWORD!,
        });
      }
    }
  } else {
    problems.push(
      'No database configuration found. Set DATABASE_URL, or all of ' +
        'PGHOST / PGDATABASE / PGUSER / PGPASSWORD (PGPORT defaults to 5432).',
    );
  }

  let parsed: ParsedConnection = { host: '', port: 5432, database: '', user: '' };
  if (connectionString) {
    try {
      parsed = parseConnectionString(connectionString);
    } catch (err) {
      problems.push(`DATABASE_URL ${(err as Error).message}`);
    }
  }

  const ssl = (env.DB_SSL ?? 'disable').trim().toLowerCase() as SslMode;
  if (!VALID_SSL_MODES.includes(ssl)) {
    problems.push(`DB_SSL must be one of ${VALID_SSL_MODES.join(' | ')} (got "${env.DB_SSL}")`);
  }

  const schema = (env.DB_SCHEMA ?? 'acme').trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    problems.push(
      `DB_SCHEMA must be a plain lowercase PostgreSQL identifier matching ` +
        `/^[a-z_][a-z0-9_]{0,62}$/ (got "${schema}"). It is interpolated into DDL, so it is ` +
        `restricted to a character set that cannot carry SQL.`,
    );
  }

  const poolMax = parseInteger(env.DB_POOL_MAX, 10, { min: 1, max: 200 });
  if (poolMax === null)
    problems.push(`DB_POOL_MAX must be an integer 1–200 (got "${env.DB_POOL_MAX}")`);

  const idleTimeoutMs = parseInteger(env.DB_POOL_IDLE_TIMEOUT_MS, 30_000, {
    min: 0,
    max: 3_600_000,
  });
  if (idleTimeoutMs === null) problems.push(`DB_POOL_IDLE_TIMEOUT_MS must be an integer 0–3600000`);

  const connectTimeoutMs = parseInteger(env.DB_CONNECT_TIMEOUT_MS, 10_000, {
    min: 100,
    max: 120_000,
  });
  if (connectTimeoutMs === null)
    problems.push(`DB_CONNECT_TIMEOUT_MS must be an integer 100–120000`);

  const statementTimeoutMs = parseInteger(env.DB_STATEMENT_TIMEOUT_MS, 15_000, {
    min: 0,
    max: 600_000,
  });
  if (statementTimeoutMs === null)
    problems.push(`DB_STATEMENT_TIMEOUT_MS must be an integer 0–600000`);

  // -- Test database (optional; validated hard by src/db/guard.ts when used) --
  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim() || undefined;

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    appEnv,
    isProduction: appEnv === 'production',
    host,
    port: port!,
    logLevel,
    logPretty: logPretty!,
    migrateOnStartup: migrateOnStartup!,
    database: {
      connectionString,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      ssl,
      schema,
      poolMax: poolMax!,
      idleTimeoutMs: idleTimeoutMs!,
      connectTimeoutMs: connectTimeoutMs!,
      statementTimeoutMs: statementTimeoutMs!,
    },
    testDatabaseUrl,
    version: options.version ?? process.env.APP_VERSION ?? '0.1.0',
  };
}

/**
 * A connection string with the password replaced. Used anywhere a connection target is
 * logged or returned by an endpoint — including /ready, which reports which database it
 * checked. A readiness endpoint that leaks a password is a readiness endpoint that
 * causes an incident.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '****';
    return url.toString();
  } catch {
    return '<unparseable connection string>';
  }
}
