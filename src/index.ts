/**
 * Process entrypoint.
 *
 * Responsibilities kept deliberately narrow: load configuration, optionally migrate, start
 * listening, and shut down cleanly. Everything else lives in src/app.ts, which is what tests
 * import.
 */
import {
  loadConfig,
  loadDotEnvIfPresent,
  ConfigError,
  redactConnectionString,
} from './config/index.js';
import { buildApp } from './app.js';
import { createDatabase, createPool } from './db/index.js';
import { getMigrationStatus, migrateToLatest } from './db/migrator.js';
import { APP_VERSION } from './version.js';

/** Seconds to let in-flight requests finish before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  loadDotEnvIfPresent();

  let config;
  try {
    config = loadConfig({ version: APP_VERSION });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Configuration problems are reported before the logger exists, because the logger's own
      // settings are part of what failed to validate. Plain stderr, every problem at once, so
      // an operator fixing a remote deployment does not restart six times to find six typos.
      console.error(`\n${err.message}\n`);
      console.error('See .env.example for every supported variable and its meaning.\n');
      process.exit(78); // EX_CONFIG, sysexits.h
    }
    throw err;
  }

  /*
   * Optional startup migration.
   *
   * Off by default. It is convenient, and it is also how two container replicas start the same
   * migration in the same second. Run migrations as a deliberate step; the flag exists for a
   * single-container deployment where that ceremony is not worth it, and it announces itself
   * loudly in the log when it is on.
   */
  if (config.migrateOnStartup) {
    const pool = createPool(config.database);
    const migrationDb = createDatabase(pool, config.database.schema);
    try {
      const before = await getMigrationStatus(migrationDb, config.database.schema);
      if (before.pending.length > 0) {
        console.error(
          `MIGRATE_ON_STARTUP is enabled; applying ${before.pending.length} pending migration(s): ` +
            before.pending.join(', '),
        );
        const result = await migrateToLatest(migrationDb, config.database.schema);
        if (result.error) {
          console.error('Startup migration failed:', result.error);
          process.exit(1);
        }
        console.error(`Applied: ${result.applied.join(', ') || '(none)'}`);
      }
    } finally {
      await migrationDb.destroy();
    }
  }

  const app = await buildApp({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.fatal({ err }, 'failed to bind the listening socket');
    process.exit(1);
  }

  app.log.info(
    {
      app_env: config.appEnv,
      version: config.version,
      database: redactConnectionString(config.database.connectionString),
      db_schema: config.database.schema,
      migrate_on_startup: config.migrateOnStartup,
      docs_url: `http://${config.host}:${config.port}/docs`,
      openapi_url: `http://${config.host}:${config.port}/openapi.json`,
    },
    'acme-commerce is listening',
  );

  /*
   * Graceful shutdown.
   *
   * `app.close()` stops accepting new connections, lets in-flight requests finish, then runs
   * onClose hooks — which is where the PostgreSQL pool is ended. Without this, a container
   * restart severs live requests mid-response and leaves server-side connections to time out.
   *
   * The watchdog exists because a wedged request would otherwise hold the process open past
   * Docker's own 10-second SIGKILL deadline, turning a clean shutdown into a hard kill. It is
   * unref'd so it cannot itself keep the event loop alive.
   */
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      app.log.warn({ signal }, 'second shutdown signal received; exiting immediately');
      process.exit(130);
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown signal received; draining');

    const watchdog = setTimeout(() => {
      app.log.error({ grace_ms: SHUTDOWN_GRACE_MS }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    watchdog.unref();

    try {
      await app.close();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means a promise failed with nobody watching. Logging it and exiting
  // is the honest response: the process is in a state its author did not plan for, and a
  // container that exits gets restarted, whereas one limping along silently does not.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled promise rejection; exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception; exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
