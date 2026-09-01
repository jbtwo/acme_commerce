# Build verification report — Milestone 1A

**Milestone:** 1A — Foundation and Catalog API
**Date:** 2026-09-01
**Verdict:** Built and verified on the development machine. Not yet verified on the Unraid server.

Everything in §1–§13 was executed and the output observed. Nothing is claimed on the basis of
"it should work". §14 lists what could **not** be verified here, and §15 is the specific list of
things that require your Unraid server — that section is a deliverable, not a caveat.

**Postman was not used.** Neither were Newman, the Postman CLI, nor any generated collection.
That separation is the point: you will be learning against an API already known to work, so
when a request fails, "the API is broken" is a hypothesis to rule out rather than the assumed
answer.

---

## 1. What was implemented

| Area                         | Delivered                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Repository structure         | `src/` by concern and domain, `tests/`, `scripts/`, `docs/`, `openapi/`, `postman/`                                                 |
| Configuration                | Fail-fast validation of 15 variables, reporting **every** problem at once, exit code 78                                             |
| PostgreSQL connectivity      | `pg` pool, dedicated `acme` schema, TLS modes, pool and timeout controls                                                            |
| Migrations                   | Kysely migrator + project CLI: `up`, `down`, `status`, `create`                                                                     |
| Seed data                    | 20 products, 49 variants — deterministic and idempotent                                                                             |
| Destructive-operation safety | `src/db/guard.ts`, four independent checks, 34 of its own unit tests                                                                |
| Platform endpoints           | `GET /health`, `GET /ready`, `GET /openapi.json`, `GET /docs`                                                                       |
| Product API                  | `POST`, `GET` (list), `GET` (one), `PATCH`, `DELETE` (archive)                                                                      |
| Variant API                  | `POST`, `GET` (list), `GET` (one), `PATCH`, `DELETE` (archive)                                                                      |
| Collection behaviour         | Pagination, 4 filters, substring search, 6-field allowlisted sort, stable ordering                                                  |
| Validation                   | TypeBox → JSON Schema; two Ajv instances; readable field-level errors                                                               |
| Structured errors            | 12 error codes, one envelope, `request_id` on every response                                                                        |
| Request correlation          | `X-Request-Id` in and out, validated, on every log line                                                                             |
| OpenAPI                      | 3.1.0, 7 paths, 14 component schemas, snapshot-committed with a drift check                                                         |
| Logging                      | pino JSON, one line per request with route pattern and duration, credential redaction                                               |
| Tests                        | 261 automated (114 unit, 147 integration) + 103 command-line smoke assertions                                                       |
| Container                    | Multi-stage `node:26-alpine`, non-root, `HEALTHCHECK`, graceful shutdown                                                            |
| Documentation                | README, plan, architecture, PostgreSQL setup, Unraid deployment, decisions, workflow, learning guide, personas, Postman conventions |

**Deliberately absent:** authentication (Milestone 2), GitHub Actions (Milestone 5), any Postman
collection or environment (yours), any Docker Compose file (never).

---

## 2. Technology and architecture

| Concern              | Selection                                                                           |
| -------------------- | ----------------------------------------------------------------------------------- |
| Language / runtime   | TypeScript 5.9.3 (strict) on Node **26** — pinned in `engines` and the `Dockerfile` |
| Web framework        | Fastify 5.12.1                                                                      |
| Schemas / validation | TypeBox 0.34.52 + Ajv 8.20.0 + ajv-formats 3.0.1                                    |
| OpenAPI              | `@fastify/swagger` 9.8.1, `@fastify/swagger-ui` 6.1.1 → OpenAPI 3.1.0               |
| Database driver      | `pg` 8.23.0                                                                         |
| Query layer          | Kysely 0.29.5                                                                       |
| Tests                | Vitest 4.1.11                                                                       |
| Logging              | pino (via Fastify), `pino-pretty` 13.1.3 for local terminals                        |
| Lint / format        | ESLint 10.9.1 + typescript-eslint 8.69.0 + Prettier 3.9.6                           |
| Spec linting         | `@redocly/cli` 2.49.1                                                               |
| Container base       | `node:26-alpine`                                                                    |

`npm audit`: **0 vulnerabilities**.

Architecture: one process, one container, one pool. Three layers per domain module — route
(HTTP) → service (business rules) → repository (SQL) — with a strict dependency direction. Full
detail in [`ARCHITECTURE.md`](ARCHITECTURE.md); every choice with alternatives and costs in
[`DECISIONS.md`](DECISIONS.md).

---

## 3. Startup

```bash
./scripts/dev-postgres.sh   # once: creates the local dev PostgreSQL and writes .env
npm install
npm run migrate:up
npm run db:seed
npm run dev                 # http://127.0.0.1:3000
```

Compiled: `npm run build && npm start`.

Observed startup log (development, `LOG_PRETTY=false`):

```json
{"level":30,"time":"2026-09-01T16:35:30.550Z","service":"acme-commerce","env":"development","version":"0.1.0","msg":"Server listening at http://127.0.0.1:3000"}
{"level":30,"time":"2026-09-01T16:35:30.550Z","service":"acme-commerce","env":"development","version":"0.1.0","app_env":"development","version":"0.1.0","database":"postgres://acme_app:****@127.0.0.1:55432/acme_commerce_dev","db_schema":"acme","migrate_on_startup":false,"docs_url":"http://127.0.0.1:3000/docs","openapi_url":"http://127.0.0.1:3000/openapi.json","msg":"acme-commerce is listening"}
```

No deprecation warnings. The database target is logged with the password redacted.

---

## 4. Required configuration

Minimum to start: **`DATABASE_URL`** (or the complete `PG*` set). Everything else has a
documented default. Full table in the [README §5](../README.md#5-configuration) and
`.env.example`.

Verified behaviours:

| Input                                                          | Result                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| No database configuration                                      | Refuses to start, names the problem, **exit code 78** (`EX_CONFIG`)         |
| `PORT=notanumber`, `LOG_LEVEL=shouty`, `DB_SSL=maybe` together | Reports **all three** problems in one message, then exits                   |
| `DATABASE_URL` **and** `PGHOST` both set                       | Refuses — rejected rather than resolved by precedence                       |
| `DB_SCHEMA=public; drop table x`                               | Refuses — validated against `/^[a-z_][a-z0-9_]{0,62}$/` before reaching DDL |

Observed:

```
Invalid configuration (3 problems):
  - PORT must be an integer between 0 and 65535 (got "notanumber")
  - LOG_LEVEL must be one of trace | debug | info | warn | error | fatal | silent (got "shouty")
  - DB_SSL must be one of disable | require | no-verify (got "maybe")

See .env.example for every supported variable and its meaning.
```

```bash
$ docker run --rm acme-commerce:0.1.0 >/dev/null 2>&1; echo $?
78
```

---

## 5. Database

**Verified against:** PostgreSQL **17.11** (aarch64, `postgres:17-alpine`) in a throwaway
container on host port 55432, created by `./scripts/dev-postgres.sh`.

The application role `acme_app` is **not a superuser**. It owns its databases, which under
PostgreSQL 15+ makes it the effective owner of each `public` schema via `pg_database_owner` —
enough to create the `acme` schema and everything in it, with no further grants. The script
proves this on every run with a create-schema probe.

Observed:

```
$ ./scripts/dev-postgres.sh
  ✓ Created container acme-pg-dev
  ✓ PostgreSQL is accepting connections
  server version 17.11
  ✓ Role acme_app exists with the password in .dev-postgres.env
  ✓ Created database acme_commerce_dev owned by acme_app
  ✓ Created database acme_commerce_test owned by acme_app
  ✓ Role acme_app can create schemas in acme_commerce_dev without superuser rights
```

Idempotent — a second run reports "already exists" for each object and re-asserts the role
password.

### Migrations

```
$ npm run migrate:status          # before
  [pending] 0001_catalog
0 applied, 1 pending, 1 total.
Database is NOT up to date.        # exit code 2

$ npm run migrate:up
  applied  0001_catalog
1 migration(s) applied.

$ npm run migrate:status          # after
  [applied] 0001_catalog
1 applied, 0 pending, 1 total.
Last applied at 2026-09-01T16:17:56.207Z.
Database is up to date.            # exit code 0
```

Objects created, confirmed by direct inspection:

```
 Schema |         Name          | Type  |  Owner
--------+-----------------------+-------+----------
 acme   | kysely_migration      | table | acme_app
 acme   | kysely_migration_lock | table | acme_app
 acme   | products              | table | acme_app
 acme   | variants              | table | acme_app
```

The `public` schema is **empty** — asserted by a test, not merely observed.

Indexes verified present: `products_status_idx`, `products_vendor_lower_idx`,
`products_type_lower_idx`, `products_tags_gin_idx`, `products_created_at_id_idx`,
`variants_sku_unique`, `variants_product_position_idx`, `variants_status_idx`.

### Seed data

```
$ npm run db:seed
Seeded 20 products and 49 variants (20 products / 49 variants written).

$ npm run db:seed          # second run
Seeded 20 products and 49 variants (20 products / 49 variants written).
```

Row counts unchanged after the second run — idempotency confirmed by direct query.

Spread: 5 vendors (Acme, Summit Supply, Cascade Gear, Northwind Traders, Barrie Bicycle Works);
10 product types; 12 tags; statuses `active: 15`, `draft: 3`, `archived: 2`; prices $9.50–$1,449;
creation dates from 2025-01-14 to 2026-08-12, every one distinct.

Includes `ACME-BAG-BLK` at 12900 cents — the SKU referenced by the documentation examples and by
the Milestone 2 pricing examples.

Identifiers are deterministic (SHA-256 of the product handle):
`prod_7ebf51270d4d3de9f7acad4c` is the Trailhead 30L Backpack on any machine.

**Verified non-destructive:** a product created by hand survives re-seeding (asserted in
`tests/integration/database.test.ts`). Separately verified by hand: archiving a seeded product
through the API and then re-seeding restores it to `active` without violating the
`products_archived_sync` CHECK constraint.

### Destructive-operation safety

```
$ npm run db:reset                                    # no confirmation
Refusing to drop and recreate schema "acme" in postgres://acme_app:****@127.0.0.1:55432/acme_commerce_dev.
  ✗ Destructive intent was not stated. Re-run with the flag --i-know-this-deletes-data, or set CONFIRM_DESTRUCTIVE=yes in the environment.

$ APP_ENV=production npm run db:reset -- --i-know-this-deletes-data
Refusing to drop and recreate schema "acme" in postgres://acme_app:****@127.0.0.1:55432/acme_commerce_dev.
  ✗ APP_ENV or NODE_ENV is "production". This command is disabled in production.
```

The confirmation flag is **not** an override for production. Also verified inside the running
container, where `APP_ENV=production`.

```
$ npm run db:reset -- --i-know-this-deletes-data       # development
  schema dropped and recreated
  1 migration(s) applied
  20 products, 49 variants seeded
Reset complete.
```

### Test-database guard, verified empirically

```
$ TEST_DATABASE_URL='postgres://acme_app:...@localhost:55432/acme_commerce_dev' npm run test:integration
UnsafeDatabaseOperationError: Refusing to run integration tests against the configured database.
  ✗ TEST_DATABASE_URL and DATABASE_URL resolve to the same database (localhost:55432/acme_commerce_dev). Running this would destroy the data you are developing against.
  ✗ Database "acme_commerce_dev" does not look like a test database. The name must match one of: test_*, *_test, *_test_*. Rename the database rather than relaxing this check.

$ APP_ENV=production npm run test:integration
UnsafeDatabaseOperationError: Refusing to run integration tests against the configured database.
  ✗ APP_ENV or NODE_ENV is "production". Destructive database tooling is unconditionally disabled in production.
```

Note that the first case differs from `DATABASE_URL` **only** by `localhost` versus `127.0.0.1`.
Comparing raw connection strings would have let it through. Host normalisation is what catches
it, and it has its own unit tests.

---

## 6. Base URL and endpoints

Local base URL: **`http://127.0.0.1:3000`**

All 14 exercised at least once, by both the automated tests and `scripts/smoke.sh`.

| Method   | Path                                    | Status           | `operationId`         |
| -------- | --------------------------------------- | ---------------- | --------------------- |
| `GET`    | `/health`                               | 200              | `getHealth`           |
| `GET`    | `/ready`                                | 200 / 503        | `getReadiness`        |
| `GET`    | `/openapi.json`                         | 200              | `getOpenApiDocument`  |
| `GET`    | `/docs/`                                | 200 (HTML)       | —                     |
| `POST`   | `/api/v1/products`                      | 201 + `Location` | `createProduct`       |
| `GET`    | `/api/v1/products`                      | 200              | `listProducts`        |
| `GET`    | `/api/v1/products/{productId}`          | 200              | `getProduct`          |
| `PATCH`  | `/api/v1/products/{productId}`          | 200              | `updateProduct`       |
| `DELETE` | `/api/v1/products/{productId}`          | 200 (archives)   | `archiveProduct`      |
| `POST`   | `/api/v1/products/{productId}/variants` | 201 + `Location` | `createVariant`       |
| `GET`    | `/api/v1/products/{productId}/variants` | 200              | `listProductVariants` |
| `GET`    | `/api/v1/variants/{variantId}`          | 200              | `getVariant`          |
| `PATCH`  | `/api/v1/variants/{variantId}`          | 200              | `updateVariant`       |
| `DELETE` | `/api/v1/variants/{variantId}`          | 200 (archives)   | `archiveVariant`      |

---

## 7. Authentication

**None in Milestone 1.** Every endpoint above — including `POST`, `PATCH`, and `DELETE` — is
open to anyone who can reach the port. Bearer tokens and internal roles arrive in Milestone 2;
partner API keys in Milestone 4.

**Do not expose this build to an untrusted network.** No safe development credentials are
provided because none exist yet.

One thing is already in place: `src/observability/logger.ts` redacts `authorization`, `cookie`,
`x-api-key`, and `proxy-authorization` headers and any field named `password`, `secret`, or
`token`. Redaction added after the first credential exists is redaction added after that
credential was already logged.

---

## 8. Representative requests and responses

### Health

```bash
curl -i http://127.0.0.1:3000/health
```

```
HTTP/1.1 200 OK
x-request-id: req_01a05dd29f0d47065df73ef2
content-type: application/json; charset=utf-8

{"status":"ok","service":"acme-commerce","version":"0.1.0","environment":"development","uptime_seconds":5.79}
```

### Readiness

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

### List products

```bash
curl -s 'http://127.0.0.1:3000/api/v1/products?status=active&vendor=Acme&q=backpack&page=1&limit=25&sort=created_at&order=desc'
```

```json
{
  "data": [
    {
      "id": "prod_7ebf51270d4d3de9f7acad4c",
      "title": "Trailhead 30L Backpack",
      "description": "A thirty-litre daypack for long trail days. ...",
      "status": "active",
      "vendor": "Acme",
      "product_type": "Backpacks",
      "tags": ["outdoor", "hiking", "bestseller", "lightweight"],
      "created_at": "2025-01-14T15:20:00.000Z",
      "updated_at": "2025-01-14T15:20:00.000Z",
      "archived_at": null
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 1, "total_pages": 1 }
}
```

### Create a product

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/products \
  -H 'Content-Type: application/json' \
  -d '{"title":"Riverbend Packable Rain Jacket","description":"A 2.5-layer shell.","status":"active","vendor":"Acme","product_type":"Apparel","tags":["waterproof","lightweight"]}'
```

`201 Created`, `Location: /api/v1/products/prod_…`, body `{"data": { … }}`.

With only a title: `201`, `status` defaults to `"draft"`, `tags` to `[]`.

### Create a variant

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/products/prod_…/variants \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ACME-RAIN-BLK-M","title":"Black / Medium","price_cents":18900,"compare_at_price_cents":22900}'
```

`201`, `currency` defaults to `"CAD"`, `position` to `1`, `inventory_item_id` is `null`.

### Archive

```bash
curl -s -X DELETE http://127.0.0.1:3000/api/v1/products/prod_…
```

`200` with the archived product: `status: "archived"`, `archived_at` set, and every variant of
that product archived with it. A second `DELETE` returns `200` again.

---

## 9. Error scenarios verified

Every one of these was executed and the status **and** `error.code` asserted.

| Scenario                                                              | Status | Code                          |
| --------------------------------------------------------------------- | ------ | ----------------------------- |
| Unknown product (well-formed id)                                      | 404    | `PRODUCT_NOT_FOUND`           |
| Unknown variant                                                       | 404    | `VARIANT_NOT_FOUND`           |
| Malformed identifier (`prod_zzz`)                                     | 400    | `MALFORMED_ID`                |
| Malformed identifier (`prod_undefined`)                               | 400    | `MALFORMED_ID`                |
| Variant id where a product id belongs                                 | 400    | `MALFORMED_ID`                |
| Unknown route                                                         | 404    | `ROUTE_NOT_FOUND`             |
| Missing required product field (`title`)                              | 400    | `VALIDATION_ERROR`            |
| Missing required variant fields                                       | 400    | `VALIDATION_ERROR`            |
| Invalid product status (`pending`)                                    | 400    | `VALIDATION_ERROR`            |
| Invalid price — negative                                              | 400    | `VALIDATION_ERROR`            |
| Invalid price — non-integer (`19.99`)                                 | 400    | `VALIDATION_ERROR`            |
| Invalid price — numeric string (`"1999"`)                             | 400    | `VALIDATION_ERROR`            |
| Client-supplied `id`                                                  | 400    | `VALIDATION_ERROR`            |
| Unknown body property (`titel`)                                       | 400    | `VALIDATION_ERROR`            |
| Empty `PATCH` body                                                    | 400    | `VALIDATION_ERROR`            |
| Malformed JSON                                                        | 400    | `INVALID_JSON`                |
| `Content-Type: text/plain`                                            | 415    | `UNSUPPORTED_MEDIA_TYPE`      |
| Duplicate SKU                                                         | 409    | `SKU_ALREADY_EXISTS`          |
| Variant on an unknown product                                         | 404    | `PRODUCT_NOT_FOUND`           |
| Invalid pagination (`page=0`, `page=-1`)                              | 400    | `VALIDATION_ERROR`            |
| Invalid pagination (`limit=0`, `limit=101`, `limit=abc`, `limit=1.5`) | 400    | `VALIDATION_ERROR`            |
| Invalid sort field (`sort=password`)                                  | 400    | `VALIDATION_ERROR`            |
| Invalid sort order (`order=sideways`)                                 | 400    | `VALIDATION_ERROR`            |
| Invalid status filter                                                 | 400    | `VALIDATION_ERROR`            |
| Unknown query parameter (`statuss`)                                   | 400    | `VALIDATION_ERROR`            |
| PostgreSQL unreachable → `/ready`                                     | 503    | `not_ready`, `database: fail` |

Error quality, also asserted rather than assumed:

- The missing-field error names `body.title` specifically.
- The enum error carries `allowed: ["draft","active","archived"]`.
- The sort error carries the six permitted fields and does **not** include the rejected value.
- `MALFORMED_ID` carries `expected_pattern: "^prod_[0-9a-f]{24}$"` and the offending `value`.
- `SKU_ALREADY_EXISTS` carries the `sku` and the `conflicting_variant_id`.
- `INVALID_JSON` carries the parser's own message.
- Every error body has exactly one top-level key (`error`), and `error.request_id` **equals** the
  `X-Request-Id` response header.
- No error body contains a stack trace or the string `select `.

### Two real defects found by verification

Both were found by `scripts/smoke.sh` — invisible to every other test level — and both are fixed:

1. **Malformed JSON returned `500 INTERNAL_ERROR`** instead of `400 INVALID_JSON`. Fastify wraps
   the `JSON.parse` failure in `FST_ERR_CTP_INVALID_JSON_BODY` rather than letting the
   `SyntaxError` through, and the error handler was only looking for the latter.
2. **`Content-Type: text/plain` returned `500`.** Fastify's built-in text parser accepted it, the
   body arrived as a string, and it failed schema validation confusingly. Fixed by removing the
   `text/plain` parser, so no parser claims it and Fastify returns `415`.

Both are now asserted by the smoke script and by `tests/integration/errors.test.ts`.

---

## 10. Automated tests

```
$ npm test
 ✓ tests/integration/catalog-write.test.ts   (22 tests)
 ✓ tests/integration/catalog-read.test.ts    (30 tests)
 ✓ tests/integration/platform.test.ts        (14 tests)
 ✓ tests/integration/errors.test.ts          (34 tests)
 ✓ tests/integration/contract.test.ts        (25 tests)
 ✓ tests/integration/database.test.ts        (22 tests)
 ✓ tests/unit/ids.test.ts                    (18 tests)
 ✓ tests/unit/config.test.ts                 (35 tests)
 ✓ tests/unit/catalog-logic.test.ts          (17 tests)
 ✓ tests/unit/guard.test.ts                  (34 tests)
 ✓ tests/unit/validation.test.ts             (10 tests)

 Test Files  11 passed (11)
      Tests  261 passed (261)
   Duration  2.86s
```

Integration tests ran against `acme_commerce_test`, migrating from empty each file — so every
run also exercises the migrations.

Notable coverage beyond the obvious:

- **SKU uniqueness under concurrency.** Eight simultaneous creates of the same SKU: exactly one
  `201`, seven `409`s, one row in the table. This is what a `SELECT`-then-`INSERT` would fail.
- **Ordering stability.** A deliberately-tied sort (`sort=status`, three distinct values across
  20 rows) paged four times: 20 distinct ids, no overlap, and identical results on repeat.
- **Archive cascade and un-archive.** Archiving a product archives its variants; moving it back
  to `active` restores them.
- **PATCH omitted versus null.** Sending `{"description": null}` clears it while leaving an
  omitted `vendor` untouched.
- **`updated_at` trigger.** Advances on update without the application setting it; `created_at`
  never moves.
- **Search escaping.** `q=%25` and `q=a_e` match nothing, proving `LIKE` metacharacters are
  escaped rather than treated as wildcards.
- **The safety guard itself.** 34 tests including host normalisation and the production refusal.
- **Documented examples are accepted.** The `ProductCreate` and `VariantCreate` examples are
  taken from the published OpenAPI document, `POST`ed, and asserted `201`.

Composite gate:

```
$ npm run verify
prettier --check .   ✓
eslint .             ✓  (0 problems)
tsc --noEmit         ✓
vitest run           ✓  261 passed
openapi:check        ✓  OpenAPI snapshot is up to date.
openapi:lint         ✓  valid; 3 problems explicitly ignored
```

---

## 11. Command-line smoke test

```
$ npm run smoke
  103 passed, 0 failed   (seeded catalog reported 20 products)
All smoke assertions passed.
```

`scripts/smoke.sh` is committed as reproducible evidence rather than transcript-only output. It
uses only `curl` and `python3` — **no Postman, no Newman**. Nine sections: platform endpoints,
request correlation, collection reads, catalog writes, variants, archive semantics, identifier
failures, validation failures, query-parameter failures.

It is the only verification level that crosses a real TCP socket to a separately-running process,
which is exactly why it found the two defects in §9.

---

## 12. OpenAPI validation

```
$ npm run openapi:generate
Wrote openapi/openapi.json
  7 paths, 14 component schemas

$ npm run openapi:check
OpenAPI snapshot is up to date.

$ npm run openapi:lint
Woohoo! Your API description is valid. 🎉
3 problems are explicitly ignored.
```

- OpenAPI version **3.1.0**.
- Component schemas named by `$id` (`Product`, `Variant`, `Error`, …) — not `def-0`, `def-1`.
  Asserted by a test.
- Nullability expressed as an OpenAPI 3.1 type array (`["string","null"]`).
- Every operation has a unique `operationId`, a `summary`, a `description`, and a tag.
- Every parameter and every declared response has a description.
- Every property of `Product`, `Variant`, and `Pagination` has a description.
- Every `/api/v1` error response references the shared `Error` schema.
- The server URL is relative (`/`), so the same document is correct on localhost, on Unraid, and
  behind a proxy — a hard-coded `http://localhost:3000` is the most common reason an imported
  collection cannot reach anything.

The three ignored lint problems are `operation-4xx-response` on `/health`, `/ready`, and
`/openapi.json`, which genuinely return no 4xx. Recorded with reasons in
`.redocly.lint-ignore.yaml` rather than the rule being disabled.

**The drift check was proven to work, not merely run.** Injecting changes into the committed
snapshot produced:

```
CONTRACT DRIFT: the served OpenAPI document differs from openapi/openapi.json.
  - Paths added: /ready
  - Schema changed: Product
  - Schema changed: Variant
```

That third line matters: a renamed or retyped property changes no path and no schema _name_, so
name-set comparison alone would have reported nothing while the contract had in fact moved.

---

## 13. Container

```
$ docker build -t acme-commerce:0.1.0 .
  ✓ built
$ docker images acme-commerce:0.1.0 --format '{{.Size}}'
293MB
```

Multi-stage on `node:26-alpine`. Production dependencies installed fresh rather than pruned, so
nothing dev-only can survive by accident.

Verified inside the running container:

| Check                                                  | Result                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Runs as                                                | `node` (non-root)                                    |
| Node version                                           | `v26.8.1`                                            |
| `GET /health`                                          | 200                                                  |
| `GET /ready`                                           | 200, all three checks `ok`                           |
| `GET /api/v1/products?limit=2`                         | 200, `total: 20`                                     |
| `GET /docs/`                                           | 200, `text/html`                                     |
| `GET /openapi.json`                                    | 200                                                  |
| Docker `HEALTHCHECK`                                   | `healthy`                                            |
| `node dist/db/cli.js status`                           | Reports 1 applied, 0 pending                         |
| `node dist/db/cli.js reset --i-know-this-deletes-data` | **Refused** — `APP_ENV=production`                   |
| `/ready` in production mode                            | Omits the database target (`"detail": "configured"`) |

### Both connection models exercised

**Model A — shared user-defined Docker network.** PostgreSQL addressed by container name on its
internal port 5432:

```
DATABASE_URL=postgres://acme_app:****@acme-pg-dev:5432/acme_commerce_dev
→ /ready 200, database ok, migrations ok
```

**Model B — via the host's published port.** PostgreSQL addressed by host gateway on the
published port 55432:

```
DATABASE_URL=postgres://acme_app:****@host.docker.internal:55432/acme_commerce_dev
→ /ready 200, database ok, migrations ok
```

On Unraid, Model B uses the Unraid host's LAN IP rather than `host.docker.internal`, which is a
Docker Desktop convenience. Documented in `UNRAID_DEPLOYMENT.md` §2.

### Graceful shutdown

```
$ docker stop -t 15 acme-app-test
  stop took 168ms (a SIGKILL fallback would take ~15000ms)
  exit code: 0
```

```json
{"...":"...","signal":"SIGTERM","msg":"shutdown signal received; draining"}
{"...":"...","msg":"shutdown complete"}
```

SIGTERM stops accepting connections, drains in-flight requests, and closes the pool.

### Readiness when PostgreSQL is unreachable

Pointed at an unroutable address:

```
GET /health  → 200   {"status":"ok", ...}                    ← liveness is NOT readiness
GET /ready   → 503
  configuration: ok   - configured; database target postgres://acme_app:****@10.255.255.1:5432/...
  database:      fail - Connection terminated due to connection timeout
  migrations:    fail - skipped because the database check failed
```

`/health` staying `200` while the database is down is the intended behaviour
([D-016](DECISIONS.md#d-016)): a liveness probe that fails during a database blip causes the
orchestrator to restart every container, turning a database outage into a database outage plus a
thundering herd of cold starts.

---

## 14. Known limitations

1. **No authentication.** Milestone 2. Every endpoint including the writes is open.
2. **Search cannot use an index.** `ILIKE '%term%'` with a leading wildcard forces a sequential
   scan. Irrelevant at 20 products. The fix is a `pg_trgm` GIN index, which needs
   `CREATE EXTENSION` and therefore privileges this project deliberately does not require.
3. **Offset pagination is unstable under concurrent writes.** A row inserted while you page can
   cause an item to be skipped or repeated. Real, documented, and chosen deliberately
   ([D-012](DECISIONS.md#d-012)).
4. **One `tag` filter per request.** Multiple-tag AND/OR is not implemented.
5. **`q` does not search variant SKUs.** A cross-table search; the boundary is documented rather
   than guessed at.
6. **`src/db/schema.ts` is hand-maintained.** A schema change requires editing it as well as the
   migration. The accepted cost of having no generated artifact ([D-004](DECISIONS.md#d-004)).
7. **Variant sub-collection is unpaginated,** capped at 250 and documented.
8. **`compare_at_price_cents` is not validated against `price_cents`.** A "sale" price above the
   regular price is accepted. Deliberate — merchandising sometimes wants it.
9. **Migration files are numbered sequentially.** Fine for one developer; two concurrent branches
   would collide. The fix is a timestamp prefix, noted rather than pre-solved.
10. **Sequential identifier collision window is theoretical but non-zero.** 48 bits of randomness
    per millisecond. 20,000 generated ids in one test produced no collision.
11. **No load testing.** One concurrency test exists (eight simultaneous inserts). Nothing here
    says anything about sustained throughput.
12. **No TLS to PostgreSQL was exercised.** `DB_SSL=disable` throughout, because the local
    container does not present a certificate. The `require` and `no-verify` code paths are
    implemented and **untested**.
13. **No CI.** Milestone 5, per the milestone map.
14. **Prettier formats the Markdown.** It aligns tables and normalises emphasis markers. Content
    is unaffected; raw-file diffs are noisier than hand-formatted Markdown would be.

---

## 15. Requires verification on your Unraid server

This is the list of things that **cannot** be closed from a development machine. Each is a
specific check with a specific way to run it.

| #   | What                                                      | How to verify                                                                                          | Why it cannot be verified here                                                                                                                                       |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PostgreSQL server version**                             | `SELECT version();` on your instance                                                                   | Verified against 17.11 locally. The schema uses no extensions and no superuser operations, which is what should make it portable to 15+ — but "should" is not "did". |
| 2   | **Role and database creation on your instance**           | `POSTGRES_SETUP.md` §2, then the §2.5 privilege probe                                                  | Your instance's existing roles, `pg_hba.conf`, and whether you can set a database owner are all unknown here.                                                        |
| 3   | **Network reachability, app container → PostgreSQL**      | `GET /ready`; on 503 follow `UNRAID_DEPLOYMENT.md` §12                                                 | Depends entirely on your Docker network topology.                                                                                                                    |
| 4   | **Which connection model you use**                        | Model A (shared network) or Model B (host port) — §2 of the deployment guide                           | Both were exercised locally. Which is right for you depends on whether your PostgreSQL publishes a port and whether you want it LAN-reachable.                       |
| 5   | **Container-name DNS on a user-defined network**          | `docker network inspect acme-net --format '{{range .Containers}}{{.Name}} {{end}}'`                    | Requires your actual container and network names. This is the single most common Model A failure (`ENOTFOUND`).                                                      |
| 6   | **TLS to PostgreSQL** (`DB_SSL=require` / `no-verify`)    | Set it and check `/ready`                                                                              | The local container presents no certificate. **These code paths are implemented and untested.**                                                                      |
| 7   | **Image transfer** (build on host / GHCR / `docker save`) | `UNRAID_DEPLOYMENT.md` §3                                                                              | Depends on your registry access and preference.                                                                                                                      |
| 8   | **Unraid Docker UI template**                             | Add the container per §5 and confirm it starts                                                         | The UI cannot be driven from here. The field mapping is documented but unexercised.                                                                                  |
| 9   | **Port mapping and LAN access**                           | `curl http://YOUR_UNRAID_HOST:3000/health` from another machine                                        | Requires your host and a free port.                                                                                                                                  |
| 10  | **Migrations inside your deployed container**             | `docker exec acme-commerce node dist/db/cli.js up`                                                     | Verified locally against the local database; not against yours.                                                                                                      |
| 11  | **`max_connections` headroom**                            | `SHOW max_connections;` versus the sum of `DB_POOL_MAX` across every container plus your other clients | Your server's setting and its other clients are unknown.                                                                                                             |
| 12  | **Image update preserving data**                          | §9: stop, remove, run the new tag, migrate, check `/health` reports the new version                    | The mechanism is sound (the app writes nothing to disk) but the sequence has not been run on your host.                                                              |
| 13  | **Backup and restore**                                    | `POSTGRES_SETUP.md` §8–9. **Restore one into a scratch database and count the rows.**                  | A backup you have not restored is a hypothesis. Also worth finding out whether your PostgreSQL data directory is already on a share you snapshot.                    |
| 14  | **`--restart unless-stopped` surviving a host reboot**    | Reboot Unraid and check `/ready`                                                                       | Cannot reboot your host from here.                                                                                                                                   |
| 15  | **Behaviour under your actual latency**                   | `/ready` reports per-check durations; compare with the local 1–15 ms                                   | Local PostgreSQL is on the same machine. Yours is over a network.                                                                                                    |

---

## 16. Repository state

11 test files, 261 automated tests, 103 smoke assertions, 12 documented error codes, 7 OpenAPI
paths, 14 component schemas, 22 decision records, 0 npm vulnerabilities, 0 lint problems.

No Docker Compose file. No Postman collection. No Postman environment. No GitHub Actions
workflow. All four absences are deliberate and explained above.

---

## 17. What this means for the checkpoint

The Catalog API works, and the claim is backed by the output above rather than by assertion. When
a Postman request fails at Checkpoint 1, the likely causes in rough order are:

1. No environment selected, so `{{base_url}}` resolves to nothing.
2. A variable name typo, so `{{base_url}}` appears literally in the URL.
3. A missing `Content-Type: application/json` on a `POST` or `PATCH` → `415`.
4. An unknown query parameter or body property → `400`, because this API is strict on purpose.
5. A genuine API defect. **This is still possible** — two were found during this build, and both
   were found by a test rather than by reasoning.

For (5), the diagnostic path is: read `error.code` and `error.request_id`, find the matching log
line (`docker logs` or the `npm run dev` terminal), and compare the request against
`/openapi.json`. That is the loop this project is built to teach, and the `request_id` is what
makes it a loop rather than a guess.
