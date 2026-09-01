/**
 * OpenAPI document metadata.
 *
 * The paths, schemas, and parameters are assembled by @fastify/swagger from the route
 * definitions. This file supplies everything that is not derivable from a route: the title,
 * the prose that explains the API's conventions, the tag descriptions, and the server list.
 *
 * That prose matters more than it looks. It is the first thing a consumer reads after
 * importing the contract into Postman, and it is where cross-cutting behaviour — pagination,
 * errors, correlation — is documented once instead of repeated in fourteen operations.
 */
import type { SwaggerOptions } from '@fastify/swagger';
import type { Config } from '../config/index.js';

export const OPENAPI_VERSION = '3.1.0';

const API_DESCRIPTION = `
Acme Commerce is a fictional ecommerce platform whose APIs are the product. This document
describes the internal API used by first-party applications.

## Conventions

**Envelopes.** A single resource is \`{ "data": { ... } }\`. A paginated collection is
\`{ "data": [ ... ], "pagination": { ... } }\`. Every error is
\`{ "error": { "code", "message", "request_id", "details"? } }\`. Wrapping leaves room to add
metadata later without breaking existing clients.

The platform endpoints \`/health\`, \`/ready\`, and \`/openapi.json\` sit outside that envelope
and outside the version prefix, deliberately: they describe the process, not the product, and
a container probe should not have to track API versions.

**Field naming.** \`snake_case\` in JSON, everywhere, in both directions.

**Money.** Integer minor units with a separate currency — \`price_cents: 12900\` with
\`currency: "CAD"\` means CAD 129.00. Never a float: IEEE-754 cannot represent 0.10 exactly,
and money arithmetic in floats produces off-by-a-cent errors that survive most test suites.

**Timestamps.** RFC 3339 in UTC, always with an explicit offset.

**Identifiers.** Prefixed and opaque: \`prod_\` or \`var_\` followed by 24 lowercase hex
characters. Assigned by the server; never constructed by a client. A syntactically invalid id
returns \`400 MALFORMED_ID\`, while a well-formed id naming nothing returns \`404\` — so a
broken string interpolation is distinguishable from a deleted record.

## Correlation

Send \`X-Request-Id\` to correlate a request with your own systems, or omit it and the server
generates one. Either way the value comes back in the \`X-Request-Id\` **response header** on
every response, success or failure, and appears in \`error.request_id\`. It is on every server
log line for that request. When something goes wrong, that string is what makes the server-side
story findable.

## Pagination

Offset-based: \`page\` (default 1) and \`limit\` (default 25, maximum 100). An out-of-range
\`limit\` is rejected with \`400\` rather than silently clamped. An empty result set is \`200\`
with \`"data": []\`, never \`404\`. \`total_pages\` is \`0\` when \`total\` is \`0\`.

Every sort appends \`id\` as a tiebreaker, so paging through a sorted list cannot show the same
record twice or skip one.

## Strictness

Unknown properties in a request body, and unknown query parameters, are **rejected with 400**
rather than ignored. Most public APIs ignore them. This one does not, because
\`?statuss=active\` quietly returning every product is a worse outcome than a loud error that
names the unrecognised parameter.

## Errors

Branch on \`error.code\`, never on \`error.message\` — the code is the contract and the message
is prose that may be reworded at any time. \`error.details\` carries structured context whose
shape depends on the code.

## Authentication

**None in Milestone 1.** Every endpoint here is open. Bearer tokens and roles arrive in
Milestone 2, and partner API keys in Milestone 4. This is a learning environment; do not
deploy it anywhere it can be reached from the internet.
`.trim();

export function buildSwaggerOptions(config: Config): SwaggerOptions {
  return {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: {
        title: 'Acme Commerce API',
        version: config.version,
        summary: 'Internal ecommerce platform API for catalog, inventory, orders, and fulfillment.',
        description: API_DESCRIPTION,
        contact: { name: 'Acme Commerce Platform Team', email: 'platform@acme.example' },
        license: { name: 'MIT', identifier: 'MIT' },
      },
      servers: [
        {
          // A relative server URL. Whatever host you reached this document on is the host the
          // operations apply to, which is what makes the same spec correct on localhost, on
          // Unraid, and behind a reverse proxy without an edit.
          url: '/',
          description: 'The server this document was fetched from.',
        },
      ],
      tags: [
        {
          name: 'Platform',
          description:
            'Liveness, readiness, and the machine-readable contract. Outside the version ' +
            'prefix and outside the response envelope, on purpose.',
        },
        {
          name: 'Catalog',
          description:
            'Products and their variants. A product carries merchandising information; a ' +
            'variant is a purchasable unit with a SKU and a price. Inventory and orders ' +
            'reference variants, not products.',
        },
      ],
      externalDocs: {
        url: 'https://github.com/jbtwo/acme_commerce#readme',
        description: 'Repository README, architecture notes, and the learning guide.',
      },
    },
    /**
     * Without this, every schema registered via `addSchema` lands in `components.schemas` as
     * `def-0`, `def-1`, `def-2`. Naming them by `$id` is what turns the components section
     * from an accident into documentation.
     */
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return typeof json.$id === 'string' && json.$id.length > 0 ? json.$id : `Schema${i}`;
      },
    },
  };
}
