/**
 * Application assembly.
 *
 * `buildApp()` returns a configured Fastify instance that has NOT started listening. That
 * split is what makes the whole test strategy possible: integration tests build the same
 * application the container runs and drive it through `app.inject()`, exercising the real
 * router, hooks, validation, handlers, and serializers without binding a port.
 *
 * Registration order matters and is not arbitrary:
 *   validation -> decorators -> hooks -> error handler -> swagger -> schemas -> routes
 * Swagger must be registered before any route, or those routes are absent from the document.
 * Schemas must be registered before the routes that `$ref` them, or `$ref` resolution fails
 * at boot.
 */
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from './config/index.js';
import { createDatabase, createPool, type AppDatabase } from './db/index.js';
import { buildLoggerOptions } from './observability/logger.js';
import { resolveRequestId } from './observability/request-id.js';
import { registerErrorHandler } from './http/error-handler.js';
import { registerHooks } from './http/hooks.js';
import { setupValidation } from './http/validation.js';
import { PLATFORM_SHARED_SCHEMAS, registerPlatformRoutes } from './http/platform-routes.js';
import { CATALOG_SHARED_SCHEMAS } from './domain/catalog/schemas.js';
import { registerCatalogRoutes } from './domain/catalog/routes.js';
import { buildSwaggerOptions } from './openapi/spec.js';

export const API_V1_PREFIX = '/api/v1';

export interface BuildAppOptions {
  config: Config;
  /**
   * An existing database handle. Tests pass one so a whole suite shares a single pool;
   * production leaves it out and the app owns the pool's lifecycle.
   */
  db?: AppDatabase;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const ownsDatabase = options.db === undefined;

  const app = Fastify({
    logger: buildLoggerOptions(config),

    // Fastify's default is to read `request-id` and trust it verbatim. Disabling that forces
    // every request through genReqId, so the correlation id is always validated (see
    // src/observability/request-id.ts for why an unvalidated one is a log-injection vector).
    requestIdHeader: false,
    genReqId: (req) => resolveRequestId(req.headers['x-request-id']),

    logController: new LogController({
      // Fastify's built-in request/response logging is replaced by the onResponse hook in
      // src/http/hooks.ts, which emits one line per request including duration and the
      // resolved route pattern. Leaving both on produces three lines per request saying
      // similar things.
      disableRequestLogging: true,
      // `request_id` rather than Fastify's default `reqId`, so the log field, the response
      // header, and `error.request_id` all use the same name. Three names for one value is
      // how a correlation id stops being useful.
      requestIdLogLabel: 'request_id',
    }),

    // 1 MiB. Stated rather than inherited so the limit is a decision on the record; a catalog
    // payload is kilobytes, and an unbounded body is a memory-exhaustion surface.
    bodyLimit: 1_048_576,

    routerOptions: {
      // Reject a URL path segment longer than this outright. Same reasoning as bodyLimit.
      maxParamLength: 256,
    },
  });

  /*
   * Remove Fastify's built-in text/plain body parser.
   *
   * With it registered, `Content-Type: text/plain` is accepted and the body arrives as a
   * string, which then fails schema validation with a confusing "body must be of type object"
   * 400. This is a JSON-only API, so the honest answer to a non-JSON content type is
   * `415 Unsupported Media Type` — which is what Fastify returns once no parser claims it.
   *
   * Found by scripts/smoke.sh, which is the entire reason that script exists.
   */
  app.removeContentTypeParser('text/plain');

  // Two Ajv instances (coercing for query/params, strict for bodies) plus the shared-schema
  // registration helper. Must precede addSchema and route registration.
  const validation = setupValidation(app);

  const db = options.db ?? createDatabase(createPool(config.database), config.database.schema);
  app.decorate('db', db);
  app.decorate('appConfig', config);

  if (ownsDatabase) {
    // Closing the app closes the pool. Without this, a test suite or a SIGTERM leaves
    // PostgreSQL connections open until they time out server-side.
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  }

  registerHooks(app);
  registerErrorHandler(app);

  await app.register(swagger, buildSwaggerOptions(config));

  // Registering with `validation.addSchema` puts each schema into Fastify (for `$ref`
  // resolution and OpenAPI components) AND into both Ajv instances (so `$ref` resolves during
  // validation). Registering with only one of the two produces a boot-time failure that is
  // surprisingly hard to read.
  for (const schema of [...PLATFORM_SHARED_SCHEMAS, ...CATALOG_SHARED_SCHEMAS]) {
    validation.addSchema(schema as unknown as Record<string, unknown>);
  }

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, displayRequestDuration: true },
    staticCSP: true,
  });

  await app.register(registerPlatformRoutes);
  await app.register(registerCatalogRoutes, { prefix: API_V1_PREFIX });

  return app;
}
