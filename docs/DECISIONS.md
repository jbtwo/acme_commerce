# Decision log

Every entry records what was chosen, why, what else was considered, what it costs, and whether
it is expected to last. An entry marked **Provisional** is one we expect to revisit; **Settled**
means changing it would be a significant rework.

The point of writing these down is not ceremony. Six months from now the question will not be
"what does this code do" — that is readable — it will be "why is it like this, and may I
change it?" A decision without a recorded reason gets either cargo-culted forever or ripped out
along with the reason it existed.

---

## D-001 — TypeScript on Node 26

**Status:** Settled

**Selected.** TypeScript 5.9 (strict) on Node 26, pinned identically in `package.json`
`engines`, the `Dockerfile`, and (from Milestone 5) CI.

**Why.** The decisive argument is language cohesion with the _learning_ goal, not performance.
Postman pre-request scripts and `pm.test()` assertions are JavaScript, and the Postman CLI is
distributed as a Node program. One language spans the API implementation, the automated tests, and the
Postman assets, so nothing is lost in translation between the two halves of this project.

**Alternatives.** Python + FastAPI would have given a first-class OpenAPI story and Pydantic
validation, and is arguably the better choice for a pure API project — but it puts a language
boundary between the backend and every Postman script. Go would have produced a smaller
container and a faster process, neither of which is a constraint here, at the cost of more
ceremony per endpoint.

**Costs.** Node 26 became Current in April 2026 and reaches LTS in October 2026, so it is
one release ahead of the conservative choice. Mitigated by every dependency being pure
JavaScript — there is no native module to fail to build.

---

## D-002 — Fastify, not Express or NestJS

**Status:** Settled

**Selected.** Fastify 5.

**Why.** Fastify treats JSON Schema as part of a route definition and then uses that one
object for three things: runtime request validation, response serialization, and the generated
OpenAPI document. That is not a convenience — it is the central teaching artifact of this
project. "The contract" stops being a document that describes the code and becomes the thing
the code is made of.

**Alternatives.** Express is more widely known and would need three independently-rotting
copies of the same information (a validator, a serializer, a spec). NestJS gives the same
single-source benefit buried under decorators and a DI container, which costs the ability to
read a request path top to bottom — the opposite of what a learning environment wants.

**Costs.** Response serialization goes _through_ the response schema, so **a field absent from
the schema is silently stripped from the response**. This surprises everyone once. It is also
the cleanest possible demonstration of why a contract is load-bearing, and it is what makes the
Milestone 5 contract-drift exercise work at all. Integration tests assert on whole response
bodies rather than just status codes specifically to catch it.

---

## D-003 — TypeBox for schemas, not Zod

**Status:** Settled

**Selected.** TypeBox, with `Static<typeof Schema>` for the TypeScript types.

**Why.** TypeBox's output _is_ JSON Schema. Zod's is not, and converting it inserts a lossy
third-party translation step into the middle of the validate-serialize-publish mechanism above.

**Alternatives.** Zod is more popular and has a nicer API. Hand-written JSON Schema with
separate TypeScript interfaces would work and lets the two drift apart.

**Costs.** TypeBox's API is less ergonomic than Zod's, and unions of literals render as `anyOf`
rather than `enum`. Worked around with a small `StringEnum` helper in
`src/domain/catalog/schemas.ts`, because `enum` is what a human reading the contract wants to
see and what Postman imports cleanly.

---

## D-004 — Kysely, not Prisma or raw SQL strings

**Status:** Settled

**Selected.** Kysely, a typed query builder whose method chain reads like the SQL it emits.

**Why.** You can see the query. This project's stated goal is that you understand the complete
system, and Prisma puts three layers between you and the database: a proprietary schema
language, a code-generation step, and a query-engine binary.

**Alternatives.** Prisma has the best developer experience of any Node ORM and the worst
transparency. Raw `pg` strings would be maximally transparent and give up compile-time
knowledge of table and column names — the one place TypeScript genuinely earns its keep in
data access. Drizzle sits between the two and its migration story is schema-diffing, which is
the wrong thing here (see D-005).

**Costs.** `src/db/schema.ts` is hand-maintained and must be kept in step with the migrations.
That is a real obligation. It is the price of having no generated artifact that can be stale.

---

## D-005 — Hand-written SQL migrations with a project-owned CLI

**Status:** Settled

**Selected.** Kysely's migrator, migrations as TypeScript files containing explicit SQL, wrapped
in a ~250-line CLI (`src/db/cli.ts`) providing `up`, `down`, `status`, `create`, `seed`, and a
guarded `reset`.

**Why.** No schema-diffing. Drizzle Kit and Prisma Migrate both generate DDL by diffing a
declared schema against the database. That is efficient and it is exactly wrong for learning,
because the generated statements are something you review rather than something you decide.
The CLI's `status` function does double duty as the migration check behind `GET /ready`.

**Alternatives.** `node-pg-migrate` is mature and would have saved the CLI wrapper, at the cost
of another dependency and less visibility into how migration state is tracked.

**Costs.** ~250 lines of tooling to maintain. Migration files are numbered sequentially
(`0001_`, `0002_`), which is readable for one developer and would collide across concurrent
branches — the fix at that point is a timestamp prefix, noted rather than pre-solved.

---

## D-006 — A dedicated `acme` PostgreSQL schema, not `public`

**Status:** Settled

**Selected.** Every application table lives in a schema named `acme` (configurable via
`DB_SCHEMA`). The connection pool pins `search_path` to it, and Kysely qualifies every table
reference with `.withSchema()`.

**Why.** Three properties, all responses to the constraint that this application must not touch
unrelated databases or schemas:

1. Acme Commerce can share a PostgreSQL _database_ with something else and stay isolated.
2. The destructive development reset becomes provably narrow. `DROP SCHEMA acme CASCADE`
   cannot reach an object outside that schema. Compare with truncating a hand-maintained list
   of table names in `public`, where the safety of the operation depends on the list being
   complete and current — and it silently stops being so the moment someone adds a table.
3. Required privileges shrink. The role owns its database and needs no rights anywhere else:
   no superuser, no `public` schema grants, no `CREATE EXTENSION`.

**Alternatives.** `public`, which is the default and needs no explanation, and gives up all
three properties.

**Costs.** `DB_SCHEMA` is interpolated into DDL, because PostgreSQL does not accept a bind
parameter in an identifier position. Mitigated by validating it against
`/^[a-z_][a-z0-9_]{0,62}$/` in the config layer before it can reach a statement, and asserting
the same pattern again in `src/db/migrator.ts`.

---

## D-007 — Prefixed, time-sortable hex identifiers

**Status:** Settled

**Selected.** `prod_` / `var_` followed by 24 lowercase hex characters: 12 hex of millisecond
timestamp, 12 hex of randomness.

**Why.** Two properties.

The prefix makes a **malformed** identifier syntactically distinguishable from a **well-formed
identifier that does not exist**. `prod_undefined` is a client bug — nearly always a template
string that interpolated a missing variable — and returning `400 MALFORMED_ID` says so. A
well-formed id naming nothing returns `404`. Most APIs collapse both into 404, leaving the
caller unable to tell a broken string interpolation from a deleted record.

The timestamp prefix makes ids lexicographically sortable by creation time, which is what makes
`ORDER BY created_at, id` produce a sensible order rather than an arbitrary one within a
millisecond.

**Alternatives.** UUIDv4 is standard and universally recognised, and gives up both properties.
UUIDv7 would give sortability but not the type prefix. Sequential integers leak volume and
enable enumeration.

**Costs.** Non-standard, so a client library expecting UUIDs will not recognise them. Mitigated
by publishing the exact `pattern` on every `id` property in the OpenAPI document, so the
constraint is machine-readable rather than folklore. Note the tradeoff in returning 400: it
confirms the id format to an unauthenticated caller. Accepted, because the format is published
in the contract anyway — there is nothing left to conceal.

---

## D-008 — Money as integer minor units

**Status:** Settled

**Selected.** `price_cents: 12900` (integer) alongside `currency: "CAD"`. Never a float, never
a decimal string.

**Why.** IEEE-754 doubles cannot represent `0.10` exactly. Money arithmetic in floats produces
off-by-a-cent errors that survive every test suite written by someone who did not expect them,
and then surface in a reconciliation report months later.

**Alternatives.** Shopify exposes `price: "19.99"` as a decimal _string_, which is safe and
requires every client to parse it. PostgreSQL `numeric(12,2)` is exact in the database and
arrives in JavaScript as a string anyway. Stripe uses integer minor units; we follow Stripe.

**Costs.** `12900` is less immediately readable to a human than `"129.00"`, and every client
must know the scale — which is not the same for every currency (JPY has no minor unit). The
`currency` field is present from the start so a future non-decimal currency is a data problem
rather than a contract change.

---

## D-009 — DELETE archives; it does not destroy

**Status:** Settled

**Selected.** `DELETE` sets `status = 'archived'` and `archived_at`, and returns `200` with the
resulting resource. Archiving a product cascades to its variants. The operation is idempotent.
No hard delete is exposed.

**Why.** Ecommerce catalog data is referenced by historical orders. Hard-deleting a variant
that a two-year-old order points at destroys that order's meaning. Archiving is what real
catalogs do.

Returning `200` with a body rather than `204 No Content` lets you _see_ the state transition in
the response you are already looking at, which matters more in a learning environment than
protocol tidiness.

Idempotency: repeating a delete after a network timeout is not an error, so a second call
returns `200` again rather than `409`.

**Alternatives.** `204 No Content`, which is the conventional answer and hides the transition.
Hard delete, which is simpler and loses data.

**Costs.** A `DELETE` that returns a body surprises people. Documented in the operation's
OpenAPI description, in the README, and in the smoke test's assertions.

---

## D-010 — `GET /products` applies no implicit status filter

**Status:** Provisional

**Selected.** With no `status` query parameter, products of _every_ status are returned,
archived ones included.

**Why.** Two reasons. It makes `DELETE` observable as a **state change** rather than as a
disappearance, which is the point of D-009. And it means the response is fully determined by
the query string, with no hidden term — so "why is this product missing?" is always answerable
from the URL.

**Alternatives.** Hiding archived records by default, which is what most catalog APIs do and
which is probably what a real storefront would want.

**Costs.** A storefront integrating naively would display retired products. This is the entry
most likely to change if this project ever grew a real consumer — hence **Provisional**.
Documented prominently in the operation description so it cannot be mistaken for an oversight.

---

## D-011 — Unknown request properties and query parameters are rejected

**Status:** Provisional

**Selected.** `additionalProperties: false` on every request body, and on the product list
query string. An unknown field or parameter returns `400 VALIDATION_ERROR` naming it.

**Why.** `{"titel": "..."}` silently ignored is a typo that ships to production believing it
worked. `?statuss=active` silently returning every product is a wrong answer that looks like a
right one. Both are worse outcomes than a loud error, particularly for someone learning the
API by poking at it.

**Alternatives.** Ignoring unknown input, which is what most public APIs do — it makes clients
more robust to server changes and lets a caller send extra fields harmlessly.

**Costs.** Stricter than conventional. A client that appends its own tracking parameters to a
URL would break. Marked **Provisional** because a genuinely public API would probably relax the
query-string half of this.

---

## D-012 — Offset pagination, not cursor

**Status:** Provisional

**Selected.** `page` (default 1) and `limit` (default 25, maximum 100), with
`{page, limit, total, total_pages}` on every collection response. Every `ORDER BY` ends with
`id` in the same direction as a unique tiebreaker.

**Why.** `page`/`limit` is what the target API surface specifies, and offset pagination has a
real, teachable defect: a row inserted while you are paging can cause an item to be skipped or
repeated across pages. Meeting that defect is a better lesson than being handed a fix you never
understood the need for.

The unique tiebreaker is not optional. Sorting by `status` across 20 products produces large
ties, and PostgreSQL is under no obligation to return tied rows in a consistent order between
queries — so paging can show the same row twice and never show another. That bug is nearly
invisible in testing, which is why `tests/integration/catalog-read.test.ts` pages a
deliberately-tied sort and asserts no overlap.

**Alternatives.** Cursor pagination fixes the instability and gives up the ability to jump to
page 7 or to display "page 3 of 12".

**Costs.** `COUNT(*)` on every list request, and `OFFSET 100000` degrades. Revisit past roughly
100k rows.

---

## D-013 — Two Ajv instances: coercion for query strings, none for bodies

**Status:** Settled

**Selected.** `src/http/validation.ts` replaces Fastify's single Ajv instance with two.
`coerceTypes: true` for query strings, path parameters, and headers; `false` for request bodies.
`removeAdditional: false` and `allErrors: true` on both.

**Why.** Query parameters arrive as strings, so `?limit=25` must become the number 25 before an
`Integer` schema can accept it. Request bodies arrive as parsed JSON that already has real
types, so coercing there would turn `{"price_cents": "1999"}` into a valid request — quietly
accepting a client bug.

`removeAdditional: false` overrides Fastify's default of `true`, which would silently _delete_
unknown properties rather than rejecting them, defeating D-011 entirely.

`allErrors: true` means a body with four mistakes takes one round trip to fix, not four.

**Alternatives.** One shared instance, which makes the distinction impossible to express.

**Costs.** ~30 lines of custom validator compiler, and Ajv's documented caution that
`allErrors` is a denial-of-service consideration for untrusted _schemas_ (not untrusted data,
which is the case here).

---

## D-014 — Hybrid OpenAPI: schema-authored, code-integrated, snapshot-committed

**Status:** Settled

**Selected.** Schemas hand-authored as TypeBox, attached to Fastify routes, assembled into
OpenAPI 3.1 by `@fastify/swagger`, served live at `/openapi.json`, and committed as a snapshot
at `openapi/openapi.json` with `npm run openapi:check` failing the build on any difference.

**Why.** Design-first (author YAML, generate stubs) produces the best contract and drifts from
the code the moment someone edits a handler, because nothing structurally connects them.
Code-first-with-annotations is cheapest and documents whatever the code happens to do, including
its accidents. This approach makes the schema _be_ the validator: a request the spec forbids
cannot reach a handler, and a response field the spec omits cannot be serialized.

The committed snapshot exists for three reasons a live endpoint cannot cover: a pull request
shows a contract change as a reviewable diff; a consumer or linter can fetch it without a
running server; and drift has something to be detected against.

**Costs.** The guarantee is structural, not semantic. It cannot detect a misleading
`description`, a stale `example`, or a missing operation. That is what `npm run openapi:lint`
(Redocly) and human review are for, and the boundary is worth stating rather than glossing.

---

## D-015 — Platform endpoints outside the version prefix and the response envelope

**Status:** Settled

**Selected.** `/health`, `/ready`, and `/openapi.json` are unversioned and return their own
body shapes rather than `{data}` / `{error}`. `/ready` returns the same shape on both 200 and 503.

**Why.** They describe the process, not the product. They are consumed by a Docker
`HEALTHCHECK`, by Unraid, and by a human diagnosing a container — not by an application
developer writing an integration. A container probe should not have to track API versions, and
forcing per-check readiness detail into an error envelope would strip exactly the information
the endpoint exists to provide.

**Costs.** It is a genuine inconsistency in an API that otherwise has one shape everywhere. It
is the kind a governance review should notice and receive an answer for — as distinct from the
_unintentional_ inconsistencies to be planted deliberately in Milestone 5. Recorded here, in
`src/http/platform-routes.ts`, in the OpenAPI description, and as an explicit exception in
`.redocly.lint-ignore.yaml`.

---

## D-016 — `/health` never touches the database

**Status:** Settled

**Selected.** `/health` answers from process state alone. Database connectivity and migration
currency are `/ready`'s job.

**Why.** This is a classic outage amplifier. If a liveness probe fails during a database blip,
the orchestrator restarts every application container — and now you have a database outage
_plus_ a thundering herd of cold starts, all of which also fail. Liveness answers "should this
process be killed and replaced?", and a database outage is not a reason to kill this process.

**Costs.** `/health` returning 200 while the application cannot serve a single useful request
looks wrong until you know why. Explained in the endpoint's own OpenAPI description, since that
is where someone will be when they wonder.

---

## D-017 — SKU uniqueness enforced by a database constraint, never a pre-check

**Status:** Settled

**Selected.** A `UNIQUE` index on `acme.variants.sku`. The service attempts the `INSERT` and
translates SQLSTATE `23505` into `409 SKU_ALREADY_EXISTS`.

**Why.** A `SELECT ... WHERE sku = ?` followed by an `INSERT` has a race window: two concurrent
requests both find the SKU free, and both insert. The pre-check version passes every
single-threaded test and fails in production under load. A unique index cannot be raced.

`tests/integration/catalog-write.test.ts` fires eight concurrent creates of the same SKU and
asserts exactly one `201`, seven `409`s, and one row.

**Costs.** The error path depends on a PostgreSQL error code and a constraint name, so renaming
`variants_sku_unique` in a migration would silently turn 409s into 500s. Worth knowing;
the concurrency test would catch it.

---

## D-018 — `updated_at` maintained by a database trigger

**Status:** Settled

**Selected.** A `BEFORE UPDATE` trigger sets `updated_at = now()`. The application never writes
it, and the Kysely type marks it unwritable on update.

**Why.** If the application owned it, every future write path that forgot it would produce a
row whose `updated_at` is a lie — and `sort=updated_at` would quietly return wrong answers.
Making it structurally impossible to forget is worth a trigger.

**Costs.** Behaviour that lives in the database rather than in readable application code, which
is exactly the complaint people have about triggers. Mitigated by there being only one, doing
one obvious thing, tested directly in `tests/integration/database.test.ts`.

---

## D-019 — Redundant validation in the schema _and_ the database

**Status:** Settled

**Selected.** Constraints such as price ≥ 0, valid status, and identifier format are expressed
both as JSON Schema (for requests) and as `CHECK` constraints (in the migration).

**Why.** They are not the same mechanism doing the same job twice. Request validation produces
a good `400` for an HTTP caller and cannot protect anything else. A database constraint is the
last line that holds when data arrives from a migration, a seed script, a `psql` session, or a
future endpoint whose author forgot a rule. **The API can be bypassed; the database cannot.**

**Costs.** Two places to change a rule, and they can drift. The database is the stricter of the
two by design, so drift surfaces as an unexpected `500` from a constraint violation rather than
as bad data — a loud failure rather than a silent one.

---

## D-020 — `MIGRATE_ON_STARTUP` defaults to false

**Status:** Settled

**Selected.** Migrations are an explicit operator step. The flag exists, is documented, and is
off by default — in `.env.example`, in the `Dockerfile`, and in the config defaults.

**Why.** Automatic migration on boot is convenient and it is also how two container replicas
start the same migration in the same second. Kysely takes an advisory lock so the second would
queue rather than corrupt, but the deeper problem stands: a deployment that migrates implicitly
gives you no moment at which to decide _not_ to.

**Costs.** One more step in a deployment, and a container that starts and reports `not_ready`
until you run it. The `/ready` migration check exists to make that state legible rather than
mysterious.

---

## D-021 — Local development PostgreSQL is a throwaway container, created by a script

**Status:** Provisional

**Selected.** `scripts/dev-postgres.sh` creates a `postgres:17-alpine` container on host port
55432 with an `acme_app` role and `acme_commerce_dev` + `acme_commerce_test` databases, and
writes the connection strings into `.env`.

**Why.** Development needs a PostgreSQL. The script's SQL is deliberately identical to what
`docs/POSTGRES_SETUP.md` documents for a real server — including the application role _not_
being a superuser — so the privilege model you develop against is the one you deploy against.

**Explicitly not part of deployment.** The `Dockerfile` does not reference it,
`docs/UNRAID_DEPLOYMENT.md` does not use it, and no Docker Compose file exists anywhere in this
project. Acme Commerce never creates or manages a PostgreSQL instance in an environment it is
deployed to.

**Alternatives.** Connecting development directly to the Unraid PostgreSQL, which couples local
work to network reachability and risks a stray `db:reset` against real data.

**Costs.** The local server version may differ from Unraid's. Mitigated by using no extensions
and no superuser operations, which is what makes the schema portable. **Provisional** because
if the Unraid instance turns out to be reachable and convenient, pointing a second
`.env` at it is a reasonable change.

---

## D-022 — No authentication in Milestone 1

**Status:** Provisional — superseded in Milestone 2

**Selected.** Every Catalog endpoint is open. No token, no API key, no middleware.

**Why.** The milestone map puts authentication in Milestone 2. Adding a token check now "for
realism" would mean the first Postman checkpoint spends its attention on credentials instead of
on request anatomy, pagination, and error shapes — and would have to be redesigned when the
real role model arrives.

**Costs.** This build must not be exposed to an untrusted network. Stated in the OpenAPI
description, in the README, and in `docs/UNRAID_DEPLOYMENT.md`.
