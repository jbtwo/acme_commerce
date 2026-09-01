/**
 * Configuration validation tests.
 *
 * Configuration is the layer that turns "a wrong environment variable" into either a clear
 * startup failure or a confusing runtime one. These tests pin it to the former.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  parseConnectionString,
  redactConnectionString,
} from '../../src/config/index.js';

const MINIMAL = { DATABASE_URL: 'postgres://u:secret@db.local:5432/acme' };

describe('loadConfig', () => {
  it('applies documented defaults when only a database URL is given', () => {
    const config = loadConfig({ env: MINIMAL });
    expect(config.appEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('info');
    expect(config.database.schema).toBe('acme');
    expect(config.database.poolMax).toBe(10);
    // The important default: migrations do NOT run on boot.
    expect(config.migrateOnStartup).toBe(false);
  });

  it('parses the connection string into comparable parts', () => {
    const config = loadConfig({ env: MINIMAL });
    expect(config.database.host).toBe('db.local');
    expect(config.database.port).toBe(5432);
    expect(config.database.database).toBe('acme');
    expect(config.database.user).toBe('u');
  });

  it('builds a connection string from discrete PG* variables', () => {
    const config = loadConfig({
      env: {
        PGHOST: 'pg.unraid.local',
        PGPORT: '5433',
        PGDATABASE: 'acme_commerce',
        PGUSER: 'acme_app',
        PGPASSWORD: 'p@ss word/with?chars',
      },
    });
    expect(config.database.host).toBe('pg.unraid.local');
    expect(config.database.port).toBe(5433);
    expect(config.database.database).toBe('acme_commerce');
    // Special characters must survive the round trip, or a correct password produces an
    // authentication failure that looks like a wrong password.
    expect(config.database.connectionString).toContain(encodeURIComponent('p@ss word/with?chars'));
  });

  it('refuses DATABASE_URL and PG* together rather than silently picking one', () => {
    expect(() => loadConfig({ env: { ...MINIMAL, PGHOST: 'other.host' } })).toThrowError(
      ConfigError,
    );
  });

  it('refuses when no database configuration is present at all', () => {
    expect(() => loadConfig({ env: {} })).toThrowError(/No database configuration found/);
  });

  it('refuses an incomplete discrete configuration', () => {
    expect(() => loadConfig({ env: { PGHOST: 'h', PGDATABASE: 'd' } })).toThrowError(
      /Incomplete discrete database configuration/,
    );
  });

  it('reports every problem at once, so one restart reveals every typo', () => {
    try {
      loadConfig({ env: { ...MINIMAL, PORT: 'nope', LOG_LEVEL: 'shouty', DB_SSL: 'maybe' } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems.length).toBe(3);
    }
  });

  it('accepts PORT=0, meaning "let the OS choose an ephemeral port"', () => {
    expect(loadConfig({ env: { ...MINIMAL, PORT: '0' } }).port).toBe(0);
  });

  it.each([
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '1000'],
    ['APP_ENV', 'staging'],
    ['DB_SSL', 'sortof'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadConfig({ env: { ...MINIMAL, [key]: value } })).toThrowError(ConfigError);
  });

  it.each(['public; drop table x', 'Acme', 'schema-with-dash', '1leading_digit', ''])(
    'rejects DB_SCHEMA %j because it is interpolated into DDL',
    (schema) => {
      expect(() => loadConfig({ env: { ...MINIMAL, DB_SCHEMA: schema } })).toThrowError(
        ConfigError,
      );
    },
  );

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['ON', true],
    ['false', false],
    ['0', false],
    ['no', false],
  ])('accepts MIGRATE_ON_STARTUP=%s as %s', (raw, expected) => {
    expect(loadConfig({ env: { ...MINIMAL, MIGRATE_ON_STARTUP: raw } }).migrateOnStartup).toBe(
      expected,
    );
  });

  it('rejects an unparseable boolean rather than treating it as false', () => {
    // Silently reading "maybe" as false is how a flag you believe is on turns out to be off.
    expect(() => loadConfig({ env: { ...MINIMAL, MIGRATE_ON_STARTUP: 'maybe' } })).toThrowError(
      ConfigError,
    );
  });

  it('marks production as production', () => {
    expect(loadConfig({ env: { ...MINIMAL, APP_ENV: 'production' } }).isProduction).toBe(true);
  });
});

describe('parseConnectionString', () => {
  it('defaults an omitted port to 5432', () => {
    expect(parseConnectionString('postgres://u:p@h/db').port).toBe(5432);
  });

  it('accepts the postgresql:// scheme as well as postgres://', () => {
    expect(parseConnectionString('postgresql://u:p@h:5432/db').database).toBe('db');
  });

  it.each([
    ['mysql://u:p@h/db', /unsupported scheme/],
    ['postgres://u:p@h', /does not name a database/],
    ['not a url', /not a valid URL/],
  ])('rejects %s', (value, pattern) => {
    expect(() => parseConnectionString(value)).toThrowError(pattern);
  });
});

describe('redactConnectionString', () => {
  it('removes the password but keeps everything needed to identify the target', () => {
    const redacted = redactConnectionString('postgres://acme_app:hunter2@db.local:5432/acme');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('acme_app');
    expect(redacted).toContain('db.local');
    expect(redacted).toContain('acme');
  });

  it('does not throw on an unparseable string — it is used in error paths', () => {
    expect(redactConnectionString('garbage')).toBe('<unparseable connection string>');
  });
});
