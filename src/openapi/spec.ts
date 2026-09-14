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

Get a token from \`POST /api/v1/auth/token\` and send it as \`Authorization: Bearer <token>\`.

**Catalog reads are deliberately open.** A storefront browses products without credentials.
Everything that writes — and all of locations, inventory, and pricing — requires a token.

Three roles, and permissions are what routes actually check:

| Role | Holds |
|---|---|
| \`developer\` | every read and write except admin-only actions |
| \`support\` | **read-only** across every domain |
| \`admin\` | everything |

\`401\` means the server does not know who you are — send credentials. \`403\` means it knows
exactly who you are and the answer is still no; retrying with the same token will not help. A
\`403\` always names the permission it wanted, in \`error.details.required_permission\`.
\`GET /api/v1/auth/me\` reports the permissions you actually hold.

This is a **development** auth flow, not an identity provider. Tokens cannot be revoked
individually and seeded passwords are published in the README. Do not deploy this where it can
be reached from the internet. Partner API keys arrive in Milestone 4.
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
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'A development bearer token from `POST /api/v1/auth/token`.\n\n' +
              'Send it as `Authorization: Bearer <token>`.\n\n' +
              'The token is a JWT: signed, **not encrypted**. Anyone holding it can read every ' +
              'claim inside it, so treat it as a credential and keep it out of anything you ' +
              'commit. It cannot be revoked individually — it is valid until it expires.\n\n' +
              'Catalog **reads** are deliberately unauthenticated: a storefront browses the ' +
              'catalog without credentials. Everything that writes, and everything under ' +
              'locations, inventory, and pricing, requires a token.',
          },
        },
      },
      tags: [
        {
          name: 'Platform',
          description:
            'Liveness, readiness, and the machine-readable contract. Outside the version ' +
            'prefix and outside the response envelope, on purpose.',
        },
        {
          name: 'Authentication',
          description:
            'Development credential exchange. Not an identity provider — see the operation ' +
            'descriptions for what that means and what it does not give you.',
        },
        {
          name: 'Locations',
          description:
            'Places inventory is held: warehouses, retail stores, and virtual locations for ' +
            'dropship or in-transit stock.',
        },
        {
          name: 'Inventory',
          description:
            'Stock levels, adjustments, and reservations. `available` is always computed as ' +
            '`on_hand - reserved` rather than stored, and stock movements are arbitrated by ' +
            'database constraints so two callers cannot both take the last unit.',
        },
        {
          name: 'Pricing',
          description:
            'Effective price calculation. Responses explain the derivation — every rule ' +
            'considered, applied or skipped, and why.',
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
