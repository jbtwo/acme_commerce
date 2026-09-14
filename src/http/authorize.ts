/**
 * Route protection.
 *
 * Two hooks. `authenticate` establishes who the caller is; `requirePermission` decides whether
 * they may proceed. Keeping them separate is what makes `401` and `403` structurally different
 * outcomes rather than two branches of one check.
 *
 * ## Why `onRequest` and not `preHandler`
 *
 * Fastify's lifecycle is: onRequest -> preParsing -> preValidation -> **validation** ->
 * preHandler -> handler. Registering authentication as a `preHandler` therefore puts it
 * *after* schema validation, which produces an inconsistency that is easy to miss:
 *
 *     DELETE /products/prod_bad        (no body)      -> 401, as you would expect
 *     POST   /products  {}             (bad body)     -> 400, before auth ever ran
 *
 * An anonymous caller probing a protected endpoint gets told about its request schema. In this
 * API that discloses nothing — the schema is published in /openapi.json — but the inconsistency
 * itself is the defect: two protected routes answering an anonymous caller differently means
 * nobody can state a simple rule about what unauthenticated access reveals.
 *
 * `onRequest` runs before body parsing and before validation, so authentication is
 * unconditionally the outermost gate and the rule is simply: no token, no information.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { AuthenticationError, AuthorizationError } from './errors.js';
import { extractBearerToken } from '../domain/auth/tokens.js';
import { resolvePrincipal } from '../domain/auth/service.js';
import type { Permission, Principal } from '../domain/auth/permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` preHandler. Absent on unauthenticated routes. */
    principal?: Principal;
  }
}

/**
 * Require a valid bearer token. Attaches `request.principal`.
 *
 * `WWW-Authenticate` is set on every 401, because RFC 9110 requires it and because it is how
 * a generic HTTP client knows which scheme to retry with.
 */
export function authenticate(app: FastifyInstance): onRequestHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = extractBearerToken(header);

    if (!token) {
      reply.header('www-authenticate', 'Bearer realm="acme-commerce"');
      throw header
        ? new AuthenticationError(
            'INVALID_TOKEN',
            'The Authorization header must be in the form: Bearer <token>.',
            { received_scheme: header.split(' ')[0] ?? '(empty)' },
          )
        : new AuthenticationError(
            'AUTHENTICATION_REQUIRED',
            'This endpoint requires authentication. Send an Authorization: Bearer <token> header.',
            { hint: 'Get a token from POST /api/v1/auth/token' },
          );
    }

    try {
      request.principal = await resolvePrincipal(app.db, token, app.appConfig.auth);
    } catch (err) {
      reply.header('www-authenticate', 'Bearer realm="acme-commerce", error="invalid_token"');
      throw err;
    }
  };
}

/**
 * Require a specific permission. Runs after `authenticate`.
 *
 * Returns 403, not 404. Hiding a resource's existence behind a 404 is a legitimate technique
 * when the resource identifier is itself sensitive; here the routes are published in the
 * OpenAPI document, so concealment buys nothing and costs the caller a clear answer.
 */
export function requirePermission(permission: Permission): onRequestHookHandler {
  return async (request: FastifyRequest) => {
    const principal = request.principal;
    if (!principal) {
      // Belt and braces: this means a route declared requirePermission without authenticate.
      throw new AuthenticationError(
        'AUTHENTICATION_REQUIRED',
        'This endpoint requires authentication.',
      );
    }
    if (!principal.permissions.includes(permission)) {
      throw new AuthorizationError(permission, principal.permissions);
    }
  };
}

/**
 * The two hooks a protected route almost always wants, in order.
 *
 * Spread into a route's `onRequest` option: `onRequest: protectedBy(app, 'catalog:write')`.
 */
export function protectedBy(app: FastifyInstance, permission: Permission): onRequestHookHandler[] {
  return [authenticate(app), requirePermission(permission)];
}
