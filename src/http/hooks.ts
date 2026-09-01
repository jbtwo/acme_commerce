/**
 * Request lifecycle hooks: correlation and access logging.
 */
import type { FastifyInstance } from 'fastify';
import { REQUEST_ID_HEADER } from '../observability/request-id.js';

export function registerHooks(app: FastifyInstance): void {
  /**
   * Put the request id on the response as early as possible.
   *
   * `onRequest` runs before body parsing and before validation, so the header is present even
   * on responses the handler never produced — a 400 from Ajv, a 415 from the content-type
   * parser, a 404 from the router. An error you cannot correlate is an error you cannot
   * investigate, and those early failures are exactly the ones you most need to trace.
   */
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  /**
   * One access-log line per completed request, with the fields you actually filter on.
   *
   * Fastify logs request/response pairs by default; this adds `duration_ms` and the resolved
   * route pattern (`/api/v1/products/:productId` rather than the concrete URL), which is what
   * makes "p99 latency by endpoint" answerable without parsing paths.
   */
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        path: request.url,
        status_code: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime * 100) / 100,
      },
      'request completed',
    );
  });
}
