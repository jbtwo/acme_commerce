import type { FastifyInstance, FastifySchema } from 'fastify';
import { FixedWindowRateLimiter } from '../../http/rate-limit.js';
import { RateLimitedError } from '../../http/errors.js';
import { authenticate } from '../../http/authorize.js';
import { issueToken } from './service.js';
import type { TokenRequestInput } from './schemas.js';
import type { Principal } from './permissions.js';

const ref = (id: string) => ({ $ref: `${id}#` });
const TAG = 'Authentication';

function errorResponses(extra: Record<number, string> = {}): Record<number, unknown> {
  const base: Record<number, string> = {
    400: 'The request is malformed (`VALIDATION_ERROR` or `INVALID_JSON`).',
    ...extra,
    500: 'An unexpected server error. `error.request_id` identifies it in the logs.',
    503: 'The database is unreachable. Safe to retry.',
  };
  return Object.fromEntries(
    Object.entries(base).map(([s, description]) => [s, { ...ref('Error'), description }]),
  );
}

const identityPayload = (p: Principal) => ({
  id: p.id,
  email: p.email,
  name: p.name,
  role: p.role,
  permissions: [...p.permissions],
  token_expires_at: new Date(p.expiresAt * 1000).toISOString(),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // One limiter for the lifetime of the app instance. Deliberately not per-request state.
  const limiter = new FixedWindowRateLimiter({
    max: app.appConfig.auth.rateLimitMax,
    windowSeconds: app.appConfig.auth.rateLimitWindowSeconds,
  });

  const tokenSchema: FastifySchema = {
    operationId: 'createToken',
    summary: 'Exchange credentials for a bearer token',
    description: [
      'Issues a signed JWT for a known development user.',
      '',
      '**This is a development authentication flow, not an identity provider.** There is no',
      'registration, password reset, email verification, refresh token, or session. It exists',
      'so that bearer tokens, roles, permissions, and expiry have something real to attach to.',
      'Do not model a production auth system on it.',
      '',
      '**The token is signed, not encrypted.** Decode the middle segment and you can read every',
      'claim — that is normal and expected. The signature makes the claims tamper-evident, not',
      'secret. Nothing sensitive is put inside it.',
      '',
      '**Tokens cannot be revoked.** A stateless token is valid until it expires; the only',
      'global lever is rotating the signing secret. That is why the lifetime is short. A',
      'deactivated user *is* rejected immediately, because the account is re-read on every',
      'request rather than trusted from the token.',
      '',
      'Unknown email, wrong password, and deactivated account all return the identical',
      '`401 INVALID_CREDENTIALS`, in comparable time. Distinguishing them would let this',
      'endpoint be used to discover which accounts exist.',
      '',
      'Rate limited per client IP — it is unauthenticated and runs a deliberately expensive',
      'password hash on every call.',
    ].join('\n'),
    tags: [TAG],
    body: ref('TokenRequest'),
    response: {
      200: { ...ref('TokenResponse'), description: 'A newly issued bearer token.' },
      ...errorResponses({
        401: 'Email or password is incorrect (`INVALID_CREDENTIALS`).',
        429: 'Too many attempts from this client. See the `Retry-After` header (`RATE_LIMITED`).',
      }),
    },
  };

  app.post<{ Body: TokenRequestInput }>(
    '/auth/token',
    { schema: tokenSchema },
    async (request, reply) => {
      const decision = limiter.check(request.ip);
      if (!decision.allowed) {
        throw new RateLimitedError(
          decision.retryAfterSeconds,
          decision.limit,
          app.appConfig.auth.rateLimitWindowSeconds,
        );
      }

      const issued = await issueToken(app.db, request.body, app.appConfig.auth);

      // A successful login clears the counter, so a legitimate user who fat-fingered their
      // password a few times is not then locked out by their own success.
      limiter.reset(request.ip);

      reply.header('cache-control', 'no-store');
      return {
        data: {
          access_token: issued.accessToken,
          token_type: issued.tokenType,
          expires_in: issued.expiresInSeconds,
          expires_at: issued.expiresAt,
          principal: identityPayload(issued.principal),
        },
      };
    },
  );

  app.get(
    '/auth/me',
    {
      onRequest: authenticate(app),
      schema: {
        operationId: 'getCurrentIdentity',
        summary: 'Describe the authenticated caller',
        description: [
          'Returns the identity behind the presented token, including the full permission set',
          'and when the token expires.',
          '',
          'The most useful endpoint in the API while you are debugging a `403`: it answers',
          '"who does the server think I am, and what am I allowed to do" without guessing.',
          '',
          "Permissions are resolved from the user's **current** role, not from the `role` claim",
          "in the token. Change someone's role and it takes effect on their next request rather",
          'than when their token expires.',
        ].join('\n'),
        tags: [TAG],
        security: [{ bearerAuth: [] }],
        response: {
          200: { ...ref('IdentityResponse'), description: 'The authenticated identity.' },
          ...errorResponses({
            401: 'Missing, malformed, invalid, or expired token.',
          }),
        },
      },
    },
    async (request) => ({ data: identityPayload(request.principal!) }),
  );
}
