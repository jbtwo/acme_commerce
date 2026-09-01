/**
 * Response envelopes.
 *
 * One shape for a single resource, one shape for a collection, one shape for an error.
 * A consumer that can parse one endpoint can parse every endpoint.
 *
 * Why wrap at all, rather than returning the resource bare? Two reasons that show up later:
 * a bare array has nowhere to put pagination metadata without inventing headers, and a
 * top-level object gives you a place to add `meta`, `warnings`, or `deprecations` additively
 * — that is, without breaking existing clients. An envelope is cheap insurance against a
 * breaking change you have not thought of yet.
 *
 * The exception, deliberately: /health and /ready. See src/http/platform-routes.ts.
 */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ResourceEnvelope<T> {
  data: T;
}

export interface CollectionEnvelope<T> {
  data: T[];
  pagination: Pagination;
}

export function resource<T>(data: T): ResourceEnvelope<T> {
  return { data };
}

export function collection<T>(
  data: T[],
  { page, limit, total }: { page: number; limit: number; total: number },
): CollectionEnvelope<T> {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      // Zero results means zero pages, not one empty page. `Math.ceil(0 / 25)` is already 0;
      // stated explicitly because "how many pages when there is nothing" is a question every
      // consumer asks and most APIs answer inconsistently.
      total_pages: Math.ceil(total / limit),
    },
  };
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}
