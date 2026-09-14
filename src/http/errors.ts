/**
 * The application's error model.
 *
 * Every error the API returns has the same shape:
 *
 *   { "error": { "code", "message", "request_id", "details"? } }
 *
 * `code` is the contract. It is stable, machine-readable, and the only field a client should
 * branch on. `message` is for a human reading a log or a Postman response pane and may be
 * reworded at any time — treating a human-readable string as an API is how clients break on
 * a typo fix.
 *
 * Every error answers four questions:
 *   what failed          -> code
 *   why                  -> message + details
 *   can the caller fix it-> the status class (4xx yes, 5xx no)
 *   how do I trace it    -> request_id
 */

/** Every application error code. Documented for consumers in README.md. */
export const ERROR_CODES = {
  // -- Client errors the caller can correct ---------------------------------
  VALIDATION_ERROR: 400,
  MALFORMED_ID: 400,
  INVALID_JSON: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,

  // -- Authentication: we do not know who you are ---------------------------
  AUTHENTICATION_REQUIRED: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,

  // -- Authorization: we know who you are, and the answer is no -------------
  INSUFFICIENT_PERMISSION: 403,

  // -- Too many requests ----------------------------------------------------
  RATE_LIMITED: 429,

  // -- Absent resources ------------------------------------------------------
  ROUTE_NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,

  // -- Conflicts with existing state ----------------------------------------
  SKU_ALREADY_EXISTS: 409,
  LOCATION_NAME_EXISTS: 409,

  // -- Server-side ----------------------------------------------------------
  INTERNAL_ERROR: 500,
  DATABASE_UNAVAILABLE: 503,
  NOT_READY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetails {
  [key: string]: unknown;
}

/**
 * Base class for every deliberate error. Anything thrown that is NOT an AppError is treated
 * as a bug and becomes an opaque 500 — which is the correct default, because an unplanned
 * exception's message was not written with an external audience in mind.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetails | undefined;
  /** Set on 503s so the caller knows retrying is meaningful. Emitted as `Retry-After`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ErrorDetails; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * A well-formed identifier that does not refer to anything.
 *
 * 404, not 400: the request was syntactically valid, the server simply has no such thing.
 */
export class NotFoundError extends AppError {
  constructor(
    code: Extract<ErrorCode, `${string}NOT_FOUND`>,
    message: string,
    details?: ErrorDetails,
  ) {
    super(code, message, details ? { details } : {});
    this.name = 'NotFoundError';
  }
}

/**
 * An identifier that cannot possibly refer to anything, because it is not shaped like an
 * identifier of that type.
 *
 * 400, not 404. The tradeoff is real and worth stating: returning 400 confirms to an
 * unauthenticated caller what your ID format is. Some APIs return 404 for both cases
 * specifically to avoid that disclosure. This API chooses the clearer error, because its
 * ID format is published in the OpenAPI contract anyway — there is nothing left to conceal,
 * and an integration developer with a broken string interpolation deserves to be told so.
 */
export class MalformedIdError extends AppError {
  constructor(field: string, value: string, expectedPattern: string) {
    super('MALFORMED_ID', `"${field}" is not a valid identifier.`, {
      details: {
        field,
        value,
        expected_pattern: expectedPattern,
        hint: 'Identifiers are returned by the API. They are not constructed by the client.',
      },
    });
    this.name = 'MalformedIdError';
  }
}

/** One field-level problem found during request validation. */
export interface FieldProblem {
  /** Dotted path to the offending field, e.g. `body.variants[0].price_cents`. */
  field: string;
  /** Machine-readable rule that was violated, e.g. `required`, `enum`, `minimum`. */
  rule: string;
  message: string;
  /** Present for `enum` and similar closed sets, so the error tells you the answer. */
  allowed?: readonly unknown[];
}

export class ValidationError extends AppError {
  constructor(message: string, fields: FieldProblem[], extra?: ErrorDetails) {
    super('VALIDATION_ERROR', message, { details: { fields, ...extra } });
    this.name = 'ValidationError';
  }
}

export class SkuConflictError extends AppError {
  constructor(sku: string, conflictingVariantId?: string) {
    super('SKU_ALREADY_EXISTS', `A variant with SKU "${sku}" already exists.`, {
      details: {
        sku,
        ...(conflictingVariantId ? { conflicting_variant_id: conflictingVariantId } : {}),
        hint: 'SKUs are unique across the entire catalog, not just within one product.',
      },
    });
    this.name = 'SkuConflictError';
  }
}

/**
 * 401 — the caller is not authenticated.
 *
 * Note the four distinct codes. `AUTHENTICATION_REQUIRED` (no header at all),
 * `INVALID_TOKEN` (present but not usable), `TOKEN_EXPIRED` (was fine, isn't now), and
 * `INVALID_CREDENTIALS` (username/password rejected). Only `TOKEN_EXPIRED` tells a client
 * that re-authenticating will help — collapsing them all into one code takes that away.
 */
export class AuthenticationError extends AppError {
  constructor(
    code: 'AUTHENTICATION_REQUIRED' | 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'INVALID_CREDENTIALS',
    message: string,
    details?: ErrorDetails,
  ) {
    super(code, message, details ? { details } : {});
    this.name = 'AuthenticationError';
  }
}

/**
 * 403 — authenticated, but not permitted.
 *
 * Always names the permission that was required. An authorization failure that does not say
 * what you needed is a support ticket; one that does is a self-service fix.
 */
export class AuthorizationError extends AppError {
  constructor(required: string, held: readonly string[]) {
    super('INSUFFICIENT_PERMISSION', `This action requires the "${required}" permission.`, {
      details: {
        required_permission: required,
        your_permissions: [...held],
        hint: 'Permissions come from your role. GET /api/v1/auth/me shows what yours are.',
      },
    });
    this.name = 'AuthorizationError';
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, limit: number, windowSeconds: number) {
    super('RATE_LIMITED', 'Too many requests. Slow down and try again shortly.', {
      retryAfterSeconds,
      details: { limit, window_seconds: windowSeconds, retry_after_seconds: retryAfterSeconds },
    });
    this.name = 'RateLimitedError';
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super('DATABASE_UNAVAILABLE', 'The database is not reachable. Try again shortly.', {
      retryAfterSeconds: 5,
      cause,
    });
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * PostgreSQL error codes this application translates into meaningful HTTP responses.
 * Anything not listed here is a bug on our side and becomes a 500.
 * Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  UNDEFINED_TABLE: '42P01',
  INSUFFICIENT_PRIVILEGE: '42501',
  CONNECTION_FAILURE: '08006',
  CANNOT_CONNECT_NOW: '57P03',
  QUERY_CANCELED: '57014',
} as const;

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
}

export function isPgError(err: unknown, code?: string): err is Error & PgLikeError {
  if (!(err instanceof Error)) return false;
  const c = (err as PgLikeError).code;
  if (typeof c !== 'string') return false;
  return code === undefined || c === code;
}

/** True for errors that mean "the database is not reachable right now", not "your query was bad". */
export function isConnectivityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as PgLikeError & { errno?: number }).code;
  return (
    code === PG_ERROR.CONNECTION_FAILURE ||
    code === PG_ERROR.CANNOT_CONNECT_NOW ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    /timeout exceeded when trying to connect/i.test(err.message) ||
    /terminating connection due to administrator command/i.test(err.message)
  );
}
