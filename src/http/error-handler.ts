/**
 * The single place an error becomes an HTTP response.
 *
 * Every failure — a validation rejection, a domain rule, a dead database, a genuine bug —
 * leaves the application through this function. Centralising it is what makes "every error has
 * the same shape" a property of the system rather than a convention people remember unevenly.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, isConnectivityError, isPgError, PG_ERROR, ValidationError } from './errors.js';
import type { ErrorBody } from './envelope.js';
import { REQUEST_ID_HEADER } from '../observability/request-id.js';
import { translateAjvErrors } from './validation.js';

/**
 * Fastify's own error codes that map to a meaningful client-facing response.
 * Anything not listed becomes a 500, which is the right default for "we did not plan for this".
 */
function fromFastifyError(err: FastifyError): AppError | null {
  switch (err.code) {
    case 'FST_ERR_VALIDATION': {
      const part =
        (err as FastifyError & { validationContext?: string }).validationContext ?? 'body';
      const problems = translateAjvErrors(part, err.validation ?? []);
      return new ValidationError(
        `The request ${part === 'querystring' ? 'query string' : part} is invalid.`,
        problems,
      );
    }
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      // Fastify wraps the JSON.parse failure in its own error rather than letting the
      // SyntaxError through, so the parser's message has to be recovered from `err.message`.
      // Worth the branch: "Unexpected end of JSON input" tells a caller far more than a bare
      // 400, and this is one of the most common mistakes made by hand-built request bodies.
      return new AppError('INVALID_JSON', 'The request body is not valid JSON.', {
        details: {
          parser_message: err.message,
          hint: 'Check for a trailing comma, an unquoted key, or a truncated body.',
        },
      });
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return new AppError(
        'VALIDATION_ERROR',
        'A JSON request body is required but the body was empty.',
        {
          details: {
            fields: [{ field: 'body', rule: 'required', message: 'A JSON object is required.' }],
          },
        },
      );
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'This endpoint accepts application/json only. Set the Content-Type header accordingly.',
        { details: { received: err.message } },
      );
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError(
        'PAYLOAD_TOO_LARGE',
        'The request body is larger than this endpoint accepts.',
      );
    default:
      return null;
  }
}

/**
 * Malformed JSON.
 *
 * Fastify surfaces this as a SyntaxError from JSON.parse with statusCode 400. Worth its own
 * branch: "Unexpected token } in JSON at position 42" is one of the most useful errors an API
 * can return, because it names the exact offset, and collapsing it into a generic 400 throws
 * that away.
 */
function fromJsonParseError(err: unknown): AppError | null {
  if (!(err instanceof SyntaxError)) return null;
  const statusCode = (err as SyntaxError & { statusCode?: number }).statusCode;
  if (statusCode !== undefined && statusCode !== 400) return null;
  return new AppError('INVALID_JSON', 'The request body is not valid JSON.', {
    details: { parser_message: err.message },
  });
}

/**
 * PostgreSQL errors that represent a client-correctable problem.
 *
 * A unique violation is normally translated by the service layer, which knows WHICH constraint
 * and can therefore produce a specific code. This is the backstop for a constraint nobody
 * anticipated: better a 409 that names the constraint than an opaque 500.
 */
function fromPgError(err: unknown): AppError | null {
  if (isConnectivityError(err)) {
    return new AppError(
      'DATABASE_UNAVAILABLE',
      'The database is not reachable. Try again shortly.',
      {
        retryAfterSeconds: 5,
        cause: err,
      },
    );
  }
  if (!isPgError(err)) return null;
  switch (err.code) {
    case PG_ERROR.UNIQUE_VIOLATION:
      return new AppError('VALIDATION_ERROR', 'That value conflicts with an existing record.', {
        details: { constraint: err.constraint ?? null },
      });
    case PG_ERROR.CHECK_VIOLATION:
    case PG_ERROR.NOT_NULL_VIOLATION:
      return new AppError('VALIDATION_ERROR', 'The request violates a database constraint.', {
        details: { constraint: err.constraint ?? null },
      });
    case PG_ERROR.QUERY_CANCELED:
      return new AppError('DATABASE_UNAVAILABLE', 'The query took too long and was cancelled.', {
        retryAfterSeconds: 2,
        cause: err,
      });
    default:
      return null;
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const fromJson = fromJsonParseError(err);
  if (fromJson) return fromJson;
  if (
    typeof (err as FastifyError)?.code === 'string' &&
    String((err as FastifyError).code).startsWith('FST_')
  ) {
    const mapped = fromFastifyError(err as FastifyError);
    if (mapped) return mapped;
  }
  const fromPg = fromPgError(err);
  if (fromPg) return fromPg;

  // Anything reaching here is a bug. The client gets no detail: an exception message was
  // written for a developer reading a stack trace, and leaking it is an information-disclosure
  // surface (table names, file paths, query fragments). The full error goes to the log,
  // correlated by request id.
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: err });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(err);
    const requestId = request.id;

    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        request_id: requestId,
        ...(appError.details ? { details: appError.details } : {}),
      },
    };

    // 5xx is our fault and gets the stack. 4xx is the caller's and gets one line — a client
    // looping on a bad request must not be able to fill the disk with stack traces.
    if (appError.statusCode >= 500) {
      request.log.error(
        {
          err: appError.cause instanceof Error ? appError.cause : err,
          error_code: appError.code,
          status_code: appError.statusCode,
        },
        `request failed: ${appError.code}`,
      );
    } else {
      request.log.warn(
        { error_code: appError.code, status_code: appError.statusCode, details: appError.details },
        `request rejected: ${appError.code}`,
      );
    }

    reply.header(REQUEST_ID_HEADER, requestId);
    if (appError.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(appError.retryAfterSeconds));
    }
    // The error body is sent without a response schema, so it is serialized as-is. `details`
    // has a code-dependent shape and a fast-json-stringify schema would strip the parts it
    // did not know about — which is the one place in this API where schema-driven
    // serialization would actively destroy information.
    reply.code(appError.statusCode).type('application/json; charset=utf-8').send(body);
  });

  /**
   * Unmatched route.
   *
   * Distinguished from a missing resource by its code: ROUTE_NOT_FOUND means the URL is not
   * part of this API at all, PRODUCT_NOT_FOUND means the URL is valid and the thing is absent.
   * When a base URL variable is wrong, this is the error you get — and being able to tell the
   * two apart is what turns "404" from a dead end into a diagnosis.
   */
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorBody = {
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `No route matches ${request.method} ${request.url}.`,
        request_id: request.id,
        details: {
          method: request.method,
          path: request.url,
          hint: 'Check the path and the API version prefix. GET /openapi.json lists every route.',
        },
      },
    };
    request.log.warn({ error_code: 'ROUTE_NOT_FOUND', status_code: 404 }, 'route not found');
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.code(404).type('application/json; charset=utf-8').send(body);
  });
}
