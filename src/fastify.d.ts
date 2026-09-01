/**
 * Module augmentation for Fastify.
 *
 * `app.decorate()` attaches values to the instance at runtime; this file tells TypeScript
 * about them, so `request.server.db` is typed rather than `any`.
 */
// Loads @fastify/swagger's augmentation of `FastifySchema`, which is what makes
// `operationId`, `summary`, `description`, `tags`, and `security` valid on a route schema.
import '@fastify/swagger';
import type { AppDatabase } from './db/index.js';
import type { Config } from './config/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The Kysely instance, scoped to the application schema. */
    db: AppDatabase;
    /** Validated configuration, loaded once at startup. */
    appConfig: Config;
  }
}
