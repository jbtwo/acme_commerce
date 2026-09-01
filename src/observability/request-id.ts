/**
 * Request correlation.
 *
 * One header, `X-Request-Id`, present on the way in and guaranteed on the way out. It is the
 * only mechanism that lets you take a response you are looking at in Postman and find the
 * matching server-side log lines.
 */
import { requestId as generateRequestId } from '../domain/ids.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller-supplied request id is accepted only if it looks like an identifier.
 *
 * This is not pedantry. The value is written into every log line for the request, so an
 * unvalidated client string is a log-injection vector (newlines forging fake log entries) and
 * an unbounded-cardinality problem for anything that indexes on it. Restricting to
 * URL-safe characters with a length cap removes both.
 */
const VALID_INBOUND = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidInboundRequestId(value: unknown): value is string {
  return typeof value === 'string' && VALID_INBOUND.test(value);
}

/**
 * Resolve the request id for an incoming request.
 *
 * An invalid inbound value is replaced silently rather than rejected. Failing a request over a
 * cosmetic tracing header would be hostile: the caller wanted a product, and telling them
 * "your correlation id had a space in it" helps nobody. The generated value is returned to
 * them, so they can still correlate.
 */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isValidInboundRequestId(raw) ? raw : generateRequestId();
}
