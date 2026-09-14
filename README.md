# Acme Commerce

A fictional ecommerce API platform, built as a controlled environment for learning how API
products are designed, built, tested, documented, governed, deployed, observed, and versioned.

**The APIs are the product.** There is no frontend and none is planned.

---

## Contents

- [1. Purpose](#1-purpose)
- [2. Stack](#2-stack)
- [3. Repository structure](#3-repository-structure)
- [4. Required software](#4-required-software)
- [5. Configuration](#5-configuration)
- [6. Database setup](#6-database-setup)
- [7. Migrations](#7-migrations)
- [8. Seed data](#8-seed-data)
- [9. Local startup](#9-local-startup)
- [10. Health and readiness](#10-health-and-readiness)
- [11. Endpoints](#11-endpoints)
- [12. Conventions](#12-conventions)
- [13. Error codes](#13-error-codes)
- [14. Automated testing](#14-automated-testing)
- [15. OpenAPI](#15-openapi)
- [16. Container build](#16-container-build)
- [17. Unraid deployment](#17-unraid-deployment)
- [18. Milestone status](#18-milestone-status)
- [19. Documentation index](#19-documentation-index)

---

## 1. Purpose

This repository has two separate outputs.

**A working ecommerce API platform.** Built and independently verified without Postman — with
unit tests, integration tests against real PostgreSQL, contract tests, OpenAPI validation, and a
command-line smoke script.

**A guided learning platform.** At the end of each build milestone, work stops at a
**STOP AND LEARN** checkpoint where the Postman collection, environments, variables, and tests
are built **by hand, by the learner**. Nothing in `postman/` is generated.

The order is deliberate: the API is verified first, so that when a Postman request fails, "the
API is broken" is a hypothesis to be ruled out rather than the assumed answer.

Not intended to become a production business. **Do not expose it to the internet** — there is
no authentication until Milestone 2.

---

## 2. Stack

| Concern              | Choice                                           | Why (short form)                                                                   |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Language / runtime   | TypeScript 5.9 (strict) on **Node 26**           | One language across the API, the tests, and the Postman scripts you will write     |
| Web framework        | **Fastify 5**                                    | A route's JSON Schema _is_ the validator, the serializer, and the OpenAPI document |
| Schemas / validation | **TypeBox** + Ajv                                | TypeBox's output _is_ JSON Schema — no lossy conversion step                       |
| Database             | **PostgreSQL 15+** via `pg`                      | Provided externally; never created or managed by this app                          |
| Query layer          | **Kysely**                                       | A typed query builder you can read as SQL                                          |
| Migrations           | Kysely migrator + a project-owned CLI            | Hand-written SQL, no schema-diffing                                                |
| Tests                | **Vitest** + `fastify.inject()`                  | Full stack, no socket, fast                                                        |
| Logging              | **pino**                                         | Structured JSON; a log line is a queryable event                                   |
| OpenAPI              | `@fastify/swagger` → **3.1**, snapshot-committed | Drift is a build failure, not a discovery                                          |
| Spec linting         | `@redocly/cli`                                   | Catches a spec that is valid and useless                                           |
| Container            | multi-stage `node:26-alpine`, non-root           | One image, all config from the environment                                         |

Node 26 is pinned in `package.json` `engines`, in the `Dockerfile`, and (from Milestone 5) in
CI. Three environments on three different majors is a class of bug this project exists to teach
rather than suffer.

Every choice, its alternatives, and its costs are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

**No Docker Compose, anywhere.** The application connects to a PostgreSQL instance that already
exists.

---

## 3. Repository structure

```text
.
├── README.md                     this file
├── LEARNING_GUIDE.md             API engineering concepts, as they appear in this project
├── PERSONAS.md                   who participates in the API lifecycle, and what they need
├── .env.example                  every supported variable, documented, with placeholders
├── Dockerfile                    multi-stage, non-root, no Compose
├── redocly.yaml                  OpenAPI governance rules
├── .redocly.lint-ignore.yaml     reviewed and accepted lint exceptions
├── openapi/openapi.json          committed contract snapshot (generated; drift-checked)
├── src/
│   ├── index.ts                  entrypoint: config, listen, graceful shutdown
│   ├── app.ts                    builds Fastify WITHOUT listening — tests import this
│   ├── version.ts                deployed version, surfaced by /health
│   ├── config/                   environment parsing and fail-fast validation
│   ├── observability/            logger, request-id correlation
│   ├── db/
│   │   ├── index.ts              pool, Kysely instance
│   │   ├── schema.ts             hand-maintained TypeScript view of the schema
│   │   ├── migrator.ts           migrations + the status check behind /ready
│   │   ├── cli.ts                up / down / status / create / seed / reset
│   │   ├── guard.ts              destructive-operation safety checks
│   │   ├── migrations/           hand-written SQL
│   │   └── seed/                 deterministic, idempotent seed data
│   ├── http/
│   │   ├── errors.ts             error codes and the AppError hierarchy
│   │   ├── error-handler.ts      the single place an error becomes a response
│   │   ├── validation.ts         two Ajv instances; Ajv errors → readable fields
│   │   ├── envelope.ts           {data} / {data, pagination} / {error}
│   │   ├── hooks.ts              correlation header, access log
│   │   └── platform-routes.ts    /health, /ready, /openapi.json
│   ├── domain/
│   │   ├── ids.ts                identifier format and generation
│   │   └── catalog/              schemas, repository, service, routes
│   └── openapi/                  document metadata; generate + drift check
├── tests/
│   ├── helpers/                  test harness and the test-DB guard call site
│   ├── unit/                     no database, no server
│   └── integration/              real PostgreSQL, real HTTP stack
├── scripts/
│   ├── dev-postgres.sh           local throwaway PostgreSQL (dev only)
│   └── smoke.sh                  103 assertions over a real socket
├── docs/                         plan, verification, architecture, setup, deployment, decisions
└── postman/                      YOUR collection and environments (see its README)
```

---

## 4. Required software

|                   | Version    | Notes                                                             |
| ----------------- | ---------- | ----------------------------------------------------------------- |
| Node.js           | **26.x**   | `node --version`. Pinned in `engines`.                            |
| npm               | 11+        | Ships with Node 26.                                               |
| PostgreSQL        | 15+        | Reachable, not necessarily local. Verified against 17.11.         |
| Docker            | any recent | Only for the container build and the optional local dev database. |
| `curl`, `python3` | any        | Used by `scripts/smoke.sh`.                                       |

---

## 5. Configuration

All configuration comes from the environment. Nothing is baked into the image, which is what
makes the same image runnable unchanged on a laptop and on Unraid.

```bash
cp .env.example .env
```

`.env.example` documents every variable with its meaning and tradeoffs. `.env` is gitignored.

| Variable                                                     | Default       | Purpose                                                                                        |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                    | `development` | `development` / `test` / `production`. Production disables destructive tooling.                |
| `HOST`                                                       | `127.0.0.1`   | **`0.0.0.0` in a container** — the image default. `127.0.0.1` there means nothing can connect. |
| `PORT`                                                       | `3000`        | `0` means "let the OS choose".                                                                 |
| `LOG_LEVEL`                                                  | `info`        | `trace`…`fatal`, `silent`.                                                                     |
| `LOG_PRETTY`                                                 | `false`       | `true` for a human at a terminal.                                                              |
| `DATABASE_URL`                                               | —             | Full connection string. **Or** the `PG*` set below, never both.                                |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | —             | Discrete alternative.                                                                          |
| `DB_SSL`                                                     | `disable`     | `disable` / `require` / `no-verify`.                                                           |
| `DB_SCHEMA`                                                  | `acme`        | The schema this app owns.                                                                      |
| `DB_POOL_MAX`                                                | `10`          | **Per container.**                                                                             |
| `DB_STATEMENT_TIMEOUT_MS`                                    | `15000`       | Server-side cap on one query.                                                                  |
| `MIGRATE_ON_STARTUP`                                         | `false`       | Deliberately off. See [D-020](docs/DECISIONS.md#d-020).                                        |
| `TEST_DATABASE_URL`                                          | —             | Integration tests only. Must resolve to a _different_ database.                                |

Configuration is validated once at startup. Invalid configuration prevents the process from
starting and reports **every** problem at once, exiting with code **78** (`EX_CONFIG`) —
because an operator fixing a remote deployment should not restart six times to find six typos.

---

## 6. Database setup

### Local development (fastest path)

```bash
./scripts/dev-postgres.sh
```

Creates a throwaway `postgres:17-alpine` container on host port 55432, an unprivileged
`acme_app` role, and the `acme_commerce_dev` and `acme_commerce_test` databases, then writes the
connection strings into `.env`. Idempotent — safe to re-run. `--down` removes it.

It runs the same SQL documented for a real server, including the application role _not_ being a
superuser, so the privilege model you develop against is the one you deploy against. **It has no
role in deployment** and touches nothing on your Unraid server.

### Your own PostgreSQL

[`docs/POSTGRES_SETUP.md`](docs/POSTGRES_SETUP.md) has the SQL, the privileges, TLS options,
pool sizing, backup, restore, and troubleshooting. The essentials:

```sql
CREATE ROLE acme_app WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
CREATE DATABASE acme_commerce OWNER acme_app ENCODING 'UTF8';
```

No superuser, no extensions. The role owns its database, which under PostgreSQL 15+ is enough to
create the `acme` schema and nothing else.

---

## 7. Migrations

```bash
npm run migrate:status                       # read-only; exits 2 when migrations are pending
npm run migrate:up                           # apply everything pending
npm run migrate:down                         # roll back exactly one
npm run migrate:create -- add_some_column    # scaffold a new file
```

In a container: `docker exec acme-commerce node dist/db/cli.js up`.

Migrations are hand-written SQL in `src/db/migrations/`. Nothing is generated by diffing.
`MIGRATE_ON_STARTUP` defaults to `false` — migration is a deliberate step, because automatic
migration on boot is how two replicas start the same migration in the same second.

After a schema change, **also update `src/db/schema.ts`** so Kysely's types match. That
obligation is the accepted cost of having no generated artifact to go stale
([D-004](docs/DECISIONS.md#d-004)).

---

## 8. Seed data

```bash
npm run db:seed
```

20 products, 49 variants. Five vendors, ten product types, twelve tags, all three statuses,
prices from $9.50 to $1,449, creation dates across nineteen months — enough that every
documented filter, sort field, and search term returns a different, non-trivial answer.

- **Idempotent.** Upserts on the primary key.
- **Non-destructive.** Never deletes. A product you created by hand at a checkpoint survives.
- **Deterministic.** Identifiers derive from a SHA-256 of each product's handle, so the
  Trailhead backpack has the same id on your laptop, in CI, and on Unraid.

All names, brands, and descriptions are fictional.

To get back to a pristine catalog:

```bash
npm run db:reset -- --i-know-this-deletes-data
```

Refuses in production — and the flag is not an override. Scoped by construction:
`DROP SCHEMA acme CASCADE` cannot reach anything outside our schema.

---

## 9. Local startup

```bash
./scripts/dev-postgres.sh   # once
npm install
npm run migrate:up
npm run db:seed
npm run dev                 # http://127.0.0.1:3000
```

Then, in another terminal:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
curl -s 'http://127.0.0.1:3000/api/v1/products?limit=3'
npm run smoke               # 103 assertions across every endpoint
```

Open <http://127.0.0.1:3000/docs> for Swagger UI.

Compiled equivalent: `npm run build && npm start`.

---

## 10. Health and readiness

|                                 | `/health`                                   | `/ready`                               |
| ------------------------------- | ------------------------------------------- | -------------------------------------- |
| Question                        | Should this process be killed and replaced? | Should traffic be sent to it?          |
| Touches PostgreSQL              | **No**                                      | Yes                                    |
| Fails when the database is down | **No**                                      | Yes, `503`                             |
| Use for                         | Docker `HEALTHCHECK`                        | Deployment verification, load balancer |

The separation is not pedantry. A liveness probe that fails during a database blip causes the
orchestrator to restart every container, turning a database outage into a database outage _plus_
a thundering herd of cold starts ([D-016](docs/DECISIONS.md#d-016)).

`/ready` runs three checks — configuration, database connectivity, and **migration currency** —
each with its own duration, so "slow" and "unreachable" look different:

```json
{
  "status": "ready",
  "checks": {
    "configuration": {
      "status": "ok",
      "detail": "configured; database target postgres://acme_app:****@127.0.0.1:55432/acme_commerce_dev, schema \"acme\"",
      "duration_ms": 0.03
    },
    "database": {
      "status": "ok",
      "detail": "connection established and query round-tripped",
      "duration_ms": 1.06
    },
    "migrations": {
      "status": "ok",
      "detail": "1 of 1 applied; schema is current",
      "duration_ms": 5.2
    }
  },
  "checked_at": "2026-09-01T16:35:43.405Z"
}
```

Outside production it names the database it checked, password redacted. That is usually the
fastest way to find out a container is pointed at the wrong host. In production those details
are omitted.

---

## 11. Endpoints

### Platform — unversioned, deliberately ([D-015](docs/DECISIONS.md#d-015))

| Method | Path            | `operationId`        |
| ------ | --------------- | -------------------- |
| `GET`  | `/health`       | `getHealth`          |
| `GET`  | `/ready`        | `getReadiness`       |
| `GET`  | `/openapi.json` | `getOpenApiDocument` |
| `GET`  | `/docs`         | — (Swagger UI)       |

### Authentication — `/api/v1`

| Method | Path                 | `operationId`        | Requires         |
| ------ | -------------------- | -------------------- | ---------------- |
| `POST` | `/api/v1/auth/token` | `createToken`        | — (rate limited) |
| `GET`  | `/api/v1/auth/me`    | `getCurrentIdentity` | any valid token  |

**Seeded development users.** These passwords are fixtures, published deliberately — you cannot
practise authentication against credentials you do not have.

| Email                  | Role        | Password           |
| ---------------------- | ----------- | ------------------ |
| `dev@acme.example`     | `developer` | `dev-password-123` |
| `support@acme.example` | `support`   | `dev-password-123` |
| `admin@acme.example`   | `admin`     | `dev-password-123` |

| Permission        | `developer` | `support` | `admin` |
| ----------------- | ----------- | --------- | ------- |
| `catalog:read`    | ✅          | ✅        | ✅      |
| `catalog:write`   | ✅          | —         | ✅      |
| `locations:read`  | ✅          | ✅        | ✅      |
| `locations:write` | ✅          | —         | ✅      |
| `inventory:read`  | ✅          | ✅        | ✅      |
| `inventory:write` | ✅          | —         | ✅      |
| `pricing:read`    | ✅          | ✅        | ✅      |

`support` is read-only everywhere, which is what makes a `403` reachable against a real identity.

### Locations — `/api/v1`

| Method  | Path                             | `operationId`    | Requires          |
| ------- | -------------------------------- | ---------------- | ----------------- |
| `GET`   | `/api/v1/locations`              | `listLocations`  | `locations:read`  |
| `POST`  | `/api/v1/locations`              | `createLocation` | `locations:write` |
| `GET`   | `/api/v1/locations/{locationId}` | `getLocation`    | `locations:read`  |
| `PATCH` | `/api/v1/locations/{locationId}` | `updateLocation` | `locations:write` |

There is no `DELETE`. Inventory levels and the adjustment audit log reference locations, so
retiring one is `{"is_active": false}` — which is what "delete this warehouse" means in a
business that has shipped from it.

### Catalog — `/api/v1`

| Method   | Path                                    | `operationId`         | Success            |
| -------- | --------------------------------------- | --------------------- | ------------------ |
| `POST`   | `/api/v1/products`                      | `createProduct`       | `201` + `Location` |
| `GET`    | `/api/v1/products`                      | `listProducts`        | `200`              |
| `GET`    | `/api/v1/products/{productId}`          | `getProduct`          | `200`              |
| `PATCH`  | `/api/v1/products/{productId}`          | `updateProduct`       | `200`              |
| `DELETE` | `/api/v1/products/{productId}`          | `archiveProduct`      | `200` (archives)   |
| `POST`   | `/api/v1/products/{productId}/variants` | `createVariant`       | `201` + `Location` |
| `GET`    | `/api/v1/products/{productId}/variants` | `listProductVariants` | `200`              |
| `GET`    | `/api/v1/variants/{variantId}`          | `getVariant`          | `200`              |
| `PATCH`  | `/api/v1/variants/{variantId}`          | `updateVariant`       | `200`              |
| `DELETE` | `/api/v1/variants/{variantId}`          | `archiveVariant`      | `200` (archives)   |

**Catalog reads are open; writes require `catalog:write`.** A storefront browses the catalog
without credentials. Everything that writes needs a bearer token.

### `GET /api/v1/products` query parameters

| Parameter      | Type                                                                              | Default      | Behaviour                                                            |
| -------------- | --------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `page`         | integer ≥ 1                                                                       | `1`          | Past the end → `200` with `"data": []`, never `404`                  |
| `limit`        | integer 1–100                                                                     | `25`         | Above the maximum → `400`, not silently clamped                      |
| `status`       | `draft` \| `active` \| `archived`                                                 | _none_       | **No implicit filter.** Archived products appear unless excluded     |
| `vendor`       | string                                                                            | _none_       | Case-insensitive **exact** match, not a prefix                       |
| `product_type` | string                                                                            | _none_       | Case-insensitive exact match                                         |
| `tag`          | string                                                                            | _none_       | Array containment, case-sensitive. One tag per request               |
| `q`            | string                                                                            | _none_       | Case-insensitive substring across `title`, `description`, `vendor`   |
| `sort`         | `created_at` \| `updated_at` \| `title` \| `vendor` \| `product_type` \| `status` | `created_at` | Strict allowlist; anything else → `400` listing the permitted values |
| `order`        | `asc` \| `desc`                                                                   | `desc`       | Applies to the tiebreaker too                                        |

```http
GET /api/v1/products?status=active&vendor=Acme&q=backpack&page=1&limit=25&sort=created_at&order=desc
```

Four behaviours worth knowing before you meet them:

- **Filters combine with AND.** No `OR`, no filter expression language.
- **Every sort appends `id` as a tiebreaker.** Without it, paging a tied sort can show the same
  record twice and skip another — a bug that passes every single-page test.
- **`GET /products` applies no implicit status filter** ([D-010](docs/DECISIONS.md#d-010)). This
  makes `DELETE` observable as a state change rather than a disappearance, and means the result
  set is fully determined by the query string.
- **Unknown query parameters are rejected with `400`.** `?statuss=active` silently returning
  every product is worse than a loud error ([D-011](docs/DECISIONS.md#d-011)).

---

## 12. Conventions

**Envelopes.** Single resource `{ "data": { ... } }`. Collection
`{ "data": [ ... ], "pagination": { "page", "limit", "total", "total_pages" } }`. Error
`{ "error": { "code", "message", "request_id", "details"? } }`.

`total_pages` is `0` when `total` is `0` — not one empty page.

**Field naming.** `snake_case` in JSON, everywhere, in both directions.

**Money.** Integer minor units plus a separate currency: `price_cents: 12900` with
`currency: "CAD"` is CAD 129.00. Never a float — IEEE-754 cannot represent `0.10` exactly, and
float money arithmetic produces off-by-a-cent errors that survive most test suites
([D-008](docs/DECISIONS.md#d-008)).

**Timestamps.** RFC 3339, UTC, always with an explicit offset.

**Identifiers.** `prod_` or `var_` followed by 24 lowercase hex characters. Server-assigned;
never constructed by a client. A syntactically invalid id returns **`400 MALFORMED_ID`**; a
well-formed id naming nothing returns **`404`**. Most APIs collapse both into 404, leaving the
caller unable to tell a broken string interpolation from a deleted record
([D-007](docs/DECISIONS.md#d-007)).

**Correlation.** Send `X-Request-Id` to correlate with your own systems, or omit it and one is
generated. Either way it comes back in the **`X-Request-Id` response header on every response**,
success or failure, appears in `error.request_id`, and is on every server log line for that
request. An invalid value is replaced silently rather than rejected — failing a request over a
cosmetic tracing header would be hostile.

**DELETE archives.** It sets `status = 'archived'` and `archived_at`, cascades to variants,
returns `200` with the resource, and is **idempotent**. Historical orders reference catalog
records, so retiring one is a state change rather than a deletion
([D-009](docs/DECISIONS.md#d-009)).

**PATCH distinguishes omitted from null.** An omitted property is left alone; an explicit `null`
clears a nullable property. `tags` is replaced wholesale, not merged. An empty body is `400`.

---

## 13. Error codes

Branch on `error.code`. Never on `error.message` — the code is the contract, the message is prose
that may be reworded in any release.

| Code                     | Status | Meaning                                            | `details` contains                                                         |
| ------------------------ | ------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `VALIDATION_ERROR`       | 400    | Request failed schema validation                   | `fields[]` — each with `field`, `rule`, `message`, and `allowed` for enums |
| `MALFORMED_ID`           | 400    | Identifier is not shaped like one                  | `field`, `value`, `expected_pattern`                                       |
| `INVALID_JSON`           | 400    | Body is not parseable JSON                         | `parser_message`                                                           |
| `PAYLOAD_TOO_LARGE`      | 413    | Body above 1 MiB                                   | —                                                                          |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | Content-Type is not `application/json`             | `received`                                                                 |
| `ROUTE_NOT_FOUND`        | 404    | The URL is not part of this API                    | `method`, `path`, `hint`                                                   |
| `PRODUCT_NOT_FOUND`      | 404    | Well-formed product id, no such product            | `product_id`                                                               |
| `VARIANT_NOT_FOUND`      | 404    | Well-formed variant id, no such variant            | `variant_id`                                                               |
| `SKU_ALREADY_EXISTS`     | 409    | SKU is in use — uniqueness is catalog-wide         | `sku`, `conflicting_variant_id`                                            |
| `DATABASE_UNAVAILABLE`   | 503    | Database unreachable. Retryable; see `Retry-After` | —                                                                          |
| `INTERNAL_ERROR`         | 500    | A bug on our side                                  | _nothing_ — see below                                                      |

`500` responses expose only `code`, a generic `message`, and `request_id`. An exception message
was written for a developer reading a stack trace, and leaking it discloses table names, file
paths, and query fragments. The full error goes to the log, findable by `request_id`.

`ROUTE_NOT_FOUND` versus `PRODUCT_NOT_FOUND` is a useful distinction in practice: the first is
what a wrong base URL produces.

---

## 14. Automated testing

```bash
npm test                   # everything: 261 tests
npm run test:unit          # 114 tests, no database
npm run test:integration   # 147 tests, real PostgreSQL
npm run openapi:check      # contract drift — fails on any difference
npm run openapi:lint       # Redocly structural + governance rules
npm run verify             # format, lint, typecheck, test, openapi:check, openapi:lint
npm run smoke              # 103 assertions over a real socket (needs a running server)
```

Integration tests use `TEST_DATABASE_URL` and drop the application schema between files. Before
opening a connection, `src/db/guard.ts` refuses to proceed if the environment is production, if
`TEST_DATABASE_URL` is unset, if it resolves to the **same** `(host, port, database)` as
`DATABASE_URL` — normalising `localhost` / `127.0.0.1` / `::1` and a default port, because
comparing raw strings would let that difference defeat the check — or if the database name does
not look like a test database. The guard has 34 of its own unit tests.

What each level proves, and does not:

|                  | Proves                                                                     | Does not prove                   |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------- |
| Unit             | Logic is right                                                             | Anything is wired together       |
| DB integration   | SQL is right: filters, search, sort stability, constraints, cascade        | Anything about HTTP              |
| HTTP integration | Status codes, headers, envelopes, every documented error                   | Anything about the network       |
| Contract         | Served spec = committed spec; responses validate against published schemas | That a `description` is truthful |
| Smoke            | It works from outside, over TCP                                            | Behaviour under load             |

**What remains unproven when all of it passes:** behaviour under real concurrency and load,
anything about TLS or proxies, whether the descriptions are accurate, whether the data model
suits a requirement nobody has stated — and whether the thing is _useful_.

Postman is not used for any of this, on purpose.

---

## 15. OpenAPI

- Live: `GET /openapi.json` — OpenAPI **3.1.0**
- Committed: [`openapi/openapi.json`](openapi/openapi.json) — 7 paths, 14 component schemas
- Browser: `GET /docs`

Schemas are hand-authored TypeBox attached to Fastify routes, so the **same object** validates
requests, serializes responses, and appears in the document. It is therefore impossible for the
spec to describe a request the server would reject or a response field the server would strip
([D-014](docs/DECISIONS.md#d-014)).

```bash
npm run openapi:generate   # regenerate the snapshot
npm run openapi:check      # regenerate and diff; non-zero on any difference
npm run openapi:lint       # Redocly
```

`openapi:check` makes an undocumented API change a build failure. It reports what moved — paths
added or removed, schemas added, removed, **or changed** — and reminds you that a removal,
rename, retype, or narrowing is _breaking_ even though the check treats every difference alike.

**The guarantee is structural, not semantic.** It cannot tell that a `description` is
misleading, an `example` is stale, or an operation is missing. That is what `openapi:lint` and
review are for. Accepted lint exceptions are recorded in `.redocly.lint-ignore.yaml` with
reasons rather than the rules being switched off.

To import into Postman: **Import** → **Link** → `http://127.0.0.1:3000/openapi.json`.

---

## 16. Container build

```bash
docker build -t acme-commerce:0.1.0 .
```

Multi-stage `node:26-alpine`, ~293 MB, runs as the non-root `node` user, no dev dependencies in
the final image, `HEALTHCHECK` against `/health`.

```bash
docker run -d --name acme-commerce -p 3000:3000 \
  -e DATABASE_URL='postgres://acme_app:REPLACE_PASSWORD@REPLACE_HOST:5432/acme_commerce' \
  -e APP_ENV=production \
  acme-commerce:0.1.0

docker exec acme-commerce node dist/db/cli.js up     # migrations are a deliberate step
curl -s http://127.0.0.1:3000/ready
```

`HOST` defaults to `0.0.0.0` in the image. **Do not override it to `127.0.0.1`** — the container
will start cleanly and refuse every connection from outside, which is the most common "it starts
but nothing works" cause in containerised applications.

`SIGTERM` stops accepting connections, drains in-flight requests, and closes the pool. Measured
at 168 ms, exit code 0.

---

## 17. Unraid deployment

[`docs/UNRAID_DEPLOYMENT.md`](docs/UNRAID_DEPLOYMENT.md) covers it end to end: preparing the
database, both connection models, getting the image onto the host, every environment variable,
how the settings map to the Unraid Docker UI, applying migrations, verifying, updating without
data loss, backup and restore, and troubleshooting.

The two connection models:

**Model A — a shared user-defined Docker network (recommended).** The application addresses
PostgreSQL by container name on its internal port 5432. PostgreSQL need not publish a port to
the LAN at all. Container-name DNS works **only** on a user-defined network — never on the
default bridge, where you get `ENOTFOUND` that looks like a typo.

**Model B — the Unraid host's published PostgreSQL port.** The application connects to the LAN
IP on whatever port PostgreSQL publishes. Simpler if that port already exists and other things
use it; costs having the database reachable from the whole LAN.

Both were exercised locally. Neither has been run on an actual Unraid server — see
[`docs/BUILD_VERIFICATION.md`](docs/BUILD_VERIFICATION.md) for exactly what remains.

---

## 18. Milestone status

| Milestone        | Scope                                           | Status                |
| ---------------- | ----------------------------------------------- | --------------------- |
| **1A**           | Foundation + Catalog API                        | ✅ Built and verified |
| **1** checkpoint | **You build the first Postman collection**      | ⬅ **Current**         |
| 2A               | Auth, Locations, Inventory, Pricing             | Not started           |
| 3A               | Customers, Orders, Fulfillment                  | Not started           |
| 4A               | Partner API, Webhooks                           | Not started           |
| 5A               | Contract validation, governance, versioning, CI | Not started           |
| 6                | Complete learning platform                      | Not started           |

### Current checkpoint: STOP AND LEARN 1 — Catalog API

The Catalog API is built and independently verified. Evidence, exact commands, and observed
output are in [`docs/BUILD_VERIFICATION.md`](docs/BUILD_VERIFICATION.md).

**Next: you build your first Postman collection, by hand.** Nothing in `postman/` is generated.
[`LEARNING_GUIDE.md`](LEARNING_GUIDE.md) §7 covers variable scopes and the local-versus-shared
value distinction that keeps credentials out of the repository.

What you need:

|                | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Base URL       | `http://127.0.0.1:3000`                                 |
| OpenAPI        | `http://127.0.0.1:3000/openapi.json`                    |
| Swagger UI     | `http://127.0.0.1:3000/docs`                            |
| Authentication | **None** in Milestone 1                                 |
| Seeded catalog | 20 products, 49 variants                                |
| Prerequisites  | `./scripts/dev-postgres.sh` running, then `npm run dev` |

Milestone 2A does not begin until the checkpoint is complete, the Postman assets are exported
and committed, they have been reviewed, and continuation is explicitly authorised.

---

## 19. Documentation index

| Document                                                       | What it is for                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`docs/MILESTONE_1_PLAN.md`](docs/MILESTONE_1_PLAN.md)         | The plan written **before** the code, for review                   |
| [`docs/BUILD_VERIFICATION.md`](docs/BUILD_VERIFICATION.md)     | What was verified, how, with observed output — and what was not    |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                 | Layering, request flow, error handling, observability, deployment  |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)                       | 22 decisions: what, why, alternatives, costs, whether settled      |
| [`docs/POSTGRES_SETUP.md`](docs/POSTGRES_SETUP.md)             | SQL, privileges, TLS, pooling, safety, backup, restore             |
| [`docs/UNRAID_DEPLOYMENT.md`](docs/UNRAID_DEPLOYMENT.md)       | Deployment, both connection models, UI mapping, troubleshooting    |
| [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) | The 17-step change lifecycle, and what each step catches           |
| [`LEARNING_GUIDE.md`](LEARNING_GUIDE.md)                       | API engineering concepts as they appear here. Grows each milestone |
| [`PERSONAS.md`](PERSONAS.md)                                   | Who participates, what they need, what frustrates them             |
