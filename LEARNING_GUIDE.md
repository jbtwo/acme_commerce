# Learning guide

How API engineering concepts appear in **this** project — what each one is for, which problem
it solves, who cares about it, what artifact represents it, how it fails, and how to explore it
in Postman.

This guide grows with the build. Sequence revised 2026-09-14 — see
[`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md), which holds the checkpoint tasks and their
done-when conditions. This guide explains the concepts; that document says what to do with them.

| Milestone / checkpoint | Topics added                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1A** ✅             | _(build — the Catalog API every concept below is explored against)_                                                                                                                             |
| **CP1** 🔨             | HTTP request anatomy · collection endpoints · API contracts · error design · request correlation · testing levels · environments · **schema assertions · Collection Runner · data-driven runs** |
| **M2A** ✅             | Authentication · authorization · roles · permissions · 401 vs 403 · token anatomy · local vs shared secrets                                                                                     |
| **CP2** ⬅              | **The gate** · Spec Hub · governance rules · Postman CLI in CI · exit codes and reporters · deliberate breaking changes · flake · Git-connected workspaces                                      |
| M3A                    | Idempotency · state machines                                                                                                                                                                    |
| CP3                    | Package Library · mocks, static and code-based · branching in a run · end-to-end chains                                                                                                         |
| M4A                    | Webhooks · delivery, retries, signatures                                                                                                                                                        |
| CP4                    | Monitors · Monitor Runners behind a firewall · alert routing · performance profiles (concept)                                                                                                   |
| M5A                    | Versioning · deprecation · breaking changes                                                                                                                                                     |
| M6                     | The Management Plane: API Catalog vs Private API Network · service accounts · the five metrics                                                                                                  |

Topics marked "not yet" below are placeholders on purpose — a forward reference is more honest
than pretending the subject does not exist.

**One structural note about what follows.** Sections 1 to 8 are the Postman **Activity Plane**:
requests, environments, variables, assertions, mocks. That is the half of the product that opens
a conversation, and on its own it invites the description "Postman is where you test APIs" —
which is both reductive and, for an Enterprise buyer, the wrong pitch. The **Management Plane**
— API Catalog, governance rules, service accounts, Git-connected workspaces, health scorecards —
is the half that answers "who is enforcing this across four hundred developers", and it starts
at §10.

---

## 1. Anatomy of an HTTP request

### Why the concept exists

Every interaction with this API is one HTTP request and one HTTP response. Most API confusion
turns out to be a misunderstanding about _which part_ carries what — a value in a header that
belonged in the query string, a path parameter that was never interpolated. Being able to name
each part is what makes a failure diagnosable rather than mysterious.

### The parts, and which layer of this server consumes each

```
POST      https://api.example.com:443/api/v1/products/prod_7ebf.../variants?dry_run=false
└─┬──┘    └─┬─┘ └───────┬────────┘ └┬┘└──────────────┬──────────────────┘ └───────┬──────┘
method   scheme       host        port             path                     query string

Content-Type: application/json          ← headers
X-Request-Id: my-app-attempt-42

{"sku": "ACME-RAIN-BLK-M", ...}         ← request body
```

| Part               | What it means here                                                                                                                                             | Consumed by                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Method**         | The verb. `GET` reads, `POST` creates, `PATCH` partially updates, `DELETE` archives.                                                                           | Fastify's router                                      |
| **Scheme**         | `http` locally. `https` would mean TLS; this app does not terminate TLS itself.                                                                                | The transport                                         |
| **Host**           | Which machine. `127.0.0.1` locally, your Unraid host in deployment. **This is the part that belongs in a Postman environment variable.**                       | DNS, then the OS                                      |
| **Port**           | Which process on that machine. `3000` here. Wrong port → connection refused, not a 404.                                                                        | The OS                                                |
| **Path**           | Which resource. `/api/v1/products/{productId}/variants`.                                                                                                       | Fastify's router                                      |
| **Path parameter** | A value embedded _in_ the path: the `prod_7ebf...` above. Identifies **which** thing.                                                                          | `params` schema, then the service                     |
| **Query string**   | `?status=active&limit=25`. Modifies **how** a collection is read: filter, sort, paginate.                                                                      | `querystring` schema (with type coercion)             |
| **Headers**        | Metadata about the request. `Content-Type` says what the body is; `X-Request-Id` carries correlation; `Authorization` will carry credentials from Milestone 2. | The content-type parser, hooks, `headers` schema      |
| **Body**           | The payload, JSON here. Only meaningful for `POST`/`PATCH`/`PUT`.                                                                                              | The JSON parser, then the `body` schema (no coercion) |

### Path parameter or query parameter?

The distinction that trips people up, with the rule that actually works:

- **Path** identifies a resource. `/products/prod_abc` — there is exactly one such thing.
  Removing the parameter changes _what_ you are addressing.
- **Query** modifies a request against a collection. `?status=active` — remove it and you still
  have a valid request, just a broader one.

Which is why `GET /products?id=prod_abc` would be wrong in this API, and `GET /products/active`
would be too.

### Response parts

| Part            | Here                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status code** | `200` read, `201` created, `400` your mistake, `404` absent, `409` conflicts with existing state, `415` wrong content type, `500` our bug, `503` dependency down |
| **Headers**     | `Content-Type: application/json`, `X-Request-Id` on **every** response, `Location` on `201`, `Retry-After` on `503`                                              |
| **Body**        | `{data}`, `{data, pagination}`, or `{error}`                                                                                                                     |

### The status code families

`2xx` it worked. `3xx` look elsewhere (unused here). `4xx` **the caller can fix it**. `5xx` the
caller cannot — retrying may help if it is `503`, and will not if it is `500`.

That "who can fix it" split is the useful part. It tells a client whether to show the user an
error message or to retry.

### Request correlation

Every response from this API carries `X-Request-Id`. Send your own and it is echoed; omit it and
one is generated (`req_` + 24 hex).

**Why it exists.** It is the only mechanism connecting a response you are looking at in Postman
to the server-side story. Every log line for that request carries the same value, and it appears
in `error.request_id`.

```bash
# From an error you saw in Postman:
docker logs acme-commerce 2>&1 | grep 'req_01a05de39cd00de472b6f7f6'
```

Without it you search by timestamp and hope.

**A design detail worth noticing.** An _invalid_ inbound value — with spaces, or 200 characters
long — is replaced silently rather than rejected. Two reasons: failing a request over a cosmetic
tracing header would be hostile, and echoing an unvalidated client string into logs is a
log-injection vector (a newline can forge a fake log entry) and an unbounded-cardinality problem
for anything that indexes on it.

### How it fails

| Symptom                                                          | Cause                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Connection refused                                               | Nothing listening. Wrong port, or the server is not running.                                                       |
| `404 ROUTE_NOT_FOUND`                                            | Reached the server, wrong path. Often a wrong base URL — note this is a _different_ code from `PRODUCT_NOT_FOUND`. |
| `400 MALFORMED_ID` with `prod_undefined`                         | A template string interpolated a variable that was not set.                                                        |
| `415 UNSUPPORTED_MEDIA_TYPE`                                     | Body sent without `Content-Type: application/json`.                                                                |
| `400 VALIDATION_ERROR` naming a field you did not think you sent | A typo — unknown properties are rejected, not ignored.                                                             |

### Who cares

Every persona. It is the shared vocabulary. See [PERSONAS.md](PERSONAS.md).

### Explore it in Postman

Send `GET {{base_url}}/health`. Then open the response pane's **Headers** tab and find
`X-Request-Id`. Send it again — the value changes. Now add a request header
`X-Request-Id: my-first-trace` and send again: the response echoes your value. Then set it to
`my first trace` (with spaces) and watch it get replaced.

---

## 2. Collection endpoints

### Why the concept exists

`GET /products` cannot return every product forever. The moment there are more products than a
response should carry, four questions appear: how much do I get, which ones, in what order, and
how do I get the rest. Pagination, filtering, sorting, and search are the four answers, and a
collection endpoint owes its caller all four plus the metadata to navigate them.

### Pagination

This API uses **offset** pagination:

```http
GET /api/v1/products?page=2&limit=7
```

```json
{ "data": [ ... 7 products ... ],
  "pagination": { "page": 2, "limit": 7, "total": 20, "total_pages": 3 } }
```

- `total` is the size of the **filtered** set, not the table.
- `total_pages` is `0` when `total` is `0` — not one empty page. Every consumer asks this and
  most APIs answer it inconsistently.
- A page past the end is `200` with `"data": []`. **Not `404`.** An empty collection is a
  successful answer to a well-formed question; `404` would mean the _endpoint_ does not exist.
- `limit=101` is `400`, not silently clamped to 100. A client asking for 1000 should learn it
  cannot have 1000 rather than believe it got it.

**The defect offset pagination has, which you should know about.** If a product is inserted while
you are paging, rows shift and an item can be skipped or seen twice. Cursor pagination fixes
that and gives up the ability to jump to page 7 or display "page 3 of 12". This API chose
offset deliberately, and the tradeoff is recorded in [D-012](docs/DECISIONS.md#d-012).

**A consistency detail.** The page and the `COUNT` are read inside one `REPEATABLE READ`
transaction. At PostgreSQL's default isolation, two statements each take their own snapshot, and
a concurrent insert between them yields `total: 21` above 20 rows — rare, confusing, and
essentially impossible to reproduce on demand.

### Filtering

| Parameter      | Semantics                                                 |
| -------------- | --------------------------------------------------------- |
| `status`       | Exact enum match                                          |
| `vendor`       | Case-insensitive **exact** — `?vendor=Ac` matches nothing |
| `product_type` | Case-insensitive exact                                    |
| `tag`          | Array containment, case-sensitive                         |

Filters combine with **AND**. There is no `OR` and no filter-expression language, because both
are large features and neither has been asked for.

**`GET /products` applies no implicit status filter.** Archived products appear in the default
listing. Most catalog APIs hide them; this one does not, so that `DELETE` is observable as a
_state change_ rather than a disappearance, and so the result set is fully determined by the
query string with no hidden term ([D-010](docs/DECISIONS.md#d-010)). It is documented
prominently precisely so it cannot be mistaken for an oversight — which is itself a lesson about
what documentation is for.

### Searching

`q` does a case-insensitive substring match across `title`, `description`, and `vendor`. It does
not search variant SKUs — a boundary that is documented rather than guessed at.

Two things a careful reader will notice:

**`%` and `_` are escaped.** They are SQL `LIKE` wildcards. Without escaping, `q=100%` would
match everything beginning with "100" and `q=a_b` would match "axb". The user typed a search
term, not a pattern.

**It cannot use an index.** `ILIKE '%term%'` with a leading wildcard forces a sequential scan.
At 20 products that is irrelevant; at 200,000 it is the whole problem. The real fix is a
`pg_trgm` GIN index, which needs `CREATE EXTENSION` and therefore privileges this project has
chosen not to require. Documented as a known limitation rather than hidden.

### Sorting, and the bug that matters

`sort` accepts a strict allowlist. Anything else is `400` **with the permitted values in
`error.details.allowed`** — an error that tells you the answer is worth writing.

The allowlist is not a formality. A client-supplied column name interpolated into `ORDER BY` is
a SQL injection vector, and it also silently widens your contract: every column becomes part of
the public API the moment someone can sort by it.

**Every sort in this API appends `id` as a final tiebreaker in the same direction.** Here is why
that is not pedantry:

`sort=status` across 20 products produces three distinct values, so almost every row is tied.
PostgreSQL is under **no obligation** to return tied rows in a consistent order between two
identical queries — it may use a different plan, a different worker, a different buffer state.
Without a unique tiebreaker, paging through a sorted list can show you the same row on page 1
and page 2 and never show you another row at all.

This bug passes every single-page test. `tests/integration/catalog-read.test.ts` pages a
deliberately-tied sort across four pages and asserts twenty distinct ids, which is the only kind
of test that catches it.

### Invalid query values

Unknown query parameters are **rejected with `400`**, not ignored. `?statuss=active` silently
returning every product is a wrong answer that looks like a right one — worse than a loud error,
particularly when you are learning the API by poking at it. Most public APIs ignore unknown
parameters; this is a deliberate departure ([D-011](docs/DECISIONS.md#d-011)).

### Who cares

**Frontend developers** need `total_pages` to render a pager. **QA engineers** live in the
boundary cases: `page=0`, `limit=101`, empty results, tied sorts. **Platform engineers** care
that the filters have indexes.

### Explore it in Postman

`GET {{base_url}}/api/v1/products` — note `pagination.total` is 20 and `limit` defaults to 25.
Add `?limit=5&page=2`, then `?limit=5&page=99` (200 with an empty array). Try
`?sort=status&order=asc&limit=7&page=1` twice and compare the ids — identical, thanks to the
tiebreaker. Then `?sort=password` and read `error.details.fields[0].allowed`. Finally
`?statuss=active` and see what strictness feels like.

---

## 3. API contracts

### Why the concept exists

A contract is the agreement between the side that produces an API and the sides that consume it.
Without one written down, every consumer discovers behaviour by experiment, encodes the accidents
along with the intent, and breaks when you fix a bug.

### What represents it here

`GET /openapi.json` — an **OpenAPI 3.1** document. Committed at `openapi/openapi.json` so a pull
request shows a contract change as a reviewable diff.

The thing worth understanding about this project's contract is _where it comes from_.

The schemas in `src/domain/catalog/schemas.ts` are TypeBox, and TypeBox's output **is** JSON
Schema. Fastify uses that same object for three jobs:

1. **Validating the request.** A request the schema forbids never reaches a handler.
2. **Serializing the response.** The response goes _through_ the schema.
3. **Publishing the contract.** `@fastify/swagger` assembles the same objects into OpenAPI.

So the document cannot describe a request the server would reject, or a response field the server
would strip. There is no separate document to fall out of step, because there is no separate
document.

**A consequence that will bite you once.** Because responses are serialized through the schema, a
field absent from the response schema is **silently removed** from the response body. Add a field
to a handler's return value, forget the schema, and the field simply does not appear. That is
also the cleanest possible demonstration of why the contract is load-bearing.

### Schemas, required and optional

```json
{
  "title": "ProductCreate",
  "type": "object",
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "status": { "type": "string", "enum": ["draft", "active", "archived"], "default": "draft" }
  },
  "required": ["title"],
  "additionalProperties": false
}
```

- `required` lists what must be present. Everything else is optional.
- `default` documents what happens when you omit it — and Ajv actually applies it, so the
  contract and the behaviour cannot disagree.
- `enum` closes a set. The error for a wrong value lists the right ones.
- `additionalProperties: false` rejects unknown fields.

Note what is **absent** from `ProductCreate`: `id`, `created_at`, `updated_at`, `archived_at`.
They are server-assigned. A client that could set `id` could collide with an existing record or
forge a timestamp. The contract expresses that by omission, and the strictness makes the omission
enforceable.

### Examples

Every request body and success response in this contract carries an example. They matter more
than they look:

- Postman surfaces them on import, so a thin example produces a thin collection.
- They are the first thing a consumer copies.
- A **stale** example is one of the very few contract defects that generation cannot prevent.

Which is why `tests/integration/contract.test.ts` takes the `ProductCreate` example straight out
of the published document, `POST`s it, and asserts `201`. A documented example that the API would
reject is a lie the tests now catch.

### Producer and consumer responsibilities

**The producer** (this API) owes: an accurate contract, no unannounced breaking changes,
meaningful error codes, and honest documentation.

**The consumer** owes something too, and it is less obvious: **do not depend on undocumented
behaviour**. If the contract says `sort` accepts six values, do not rely on a seventh that
happens to work. If it says branch on `error.code`, do not parse `error.message`. Depending on
an accident makes a bug fix into a breaking change.

### Backward compatibility

| Change                                     | Breaking?                              | Why                                                               |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- |
| Add an optional request property           | No                                     | Existing requests still validate                                  |
| Add a response property                    | No                                     | Existing consumers ignore it                                      |
| Add an enum value to a **response**        | **Yes, subtly**                        | A consumer switching exhaustively on it now has an unhandled case |
| Add an enum value to a **request**         | No                                     | Existing values still work                                        |
| Remove a response property                 | **Yes**                                | A consumer reading it gets `undefined`                            |
| Rename anything                            | **Yes**                                | A remove plus an add, and the remove is what hurts                |
| Make an optional request property required | **Yes**                                | Existing requests start failing                                   |
| Make a required response property optional | **Yes**                                | A consumer that assumed presence now sees null                    |
| Narrow a type (`string` → `enum`)          | **Yes**                                | Previously-valid input is now rejected                            |
| Widen a type (`enum` → `string`)           | No for requests, **yes** for responses | Same asymmetry as enums                                           |
| Change a status code                       | **Yes**                                | Clients branch on it                                              |
| Change an `error.code` string              | **Yes**                                | That string is the contract                                       |

The pattern: **adding to what you accept and to what you send is usually safe. Removing,
renaming, narrowing, or retyping is not.** Milestone 5 works through what to do about it.

### Contract drift

Drift is when the implemented behaviour and the documented contract disagree. It happens
gradually, by small edits nobody regenerated the spec for, and it is corrosive because a wrong
contract is worse than no contract — people trust it.

The mechanism against it is already here:

```bash
npm run openapi:check
```

Regenerates the document, diffs it against the committed snapshot, and **exits non-zero on any
difference**. It reports paths added or removed and schemas added, removed, **or changed** —
that last case being the easy one to miss, since a renamed property changes no path and no
schema name.

Milestone 5 introduces a deliberate drift for you to find. The mechanism is built now; the
drift is not planted yet.

**What this cannot catch:** a `description` that has become misleading, an `example` that is
stale in a way the schema still accepts, or an operation that was never documented at all.
Nothing automated can. That is what `npm run openapi:lint` (structural and coverage rules) and
human review are for, and the boundary is worth knowing precisely rather than vaguely.

### Who cares

**Frontend and partner developers** read it to build against. **QA** uses it as the oracle for
what should happen. **Technical writers** turn it into prose. **API platform owners** use it to
review a change before it ships.

### Explore it in Postman

Import `http://127.0.0.1:3000/openapi.json` via **Import → Link**. Then compare the generated
collection with a request you wrote yourself — notice what the import gives you (paths,
parameters, descriptions, examples) and what it cannot (variable choices, chaining, tests). That
gap is the difference between a contract and a working collection, and it is worth seeing
directly.

---

## 4. Error design

### Why the concept exists

An error is a response too, and usually the more important one. A caller who gets a `400` with
no detail has to guess; a caller who gets a `400` naming the field and the rule fixes it in
seconds. The difference is entirely in the design of the error.

### What represents it here

One shape, from every endpoint, for every failure:

```json
{
  "error": {
    "code": "SKU_ALREADY_EXISTS",
    "message": "A variant with SKU \"ACME-BAG-BLK\" already exists.",
    "request_id": "req_01a05dd29f0d47065df73ef2",
    "details": {
      "sku": "ACME-BAG-BLK",
      "conflicting_variant_id": "var_...",
      "hint": "SKUs are unique across the entire catalog, not just within one product."
    }
  }
}
```

Four questions, four answers:

| Question           | Answer                                                    |
| ------------------ | --------------------------------------------------------- |
| What failed?       | `code` — stable, machine-readable, the thing to branch on |
| Why?               | `message` + `details`                                     |
| Can I fix it?      | The status class. `4xx` yes, `5xx` no                     |
| How do I trace it? | `request_id`                                              |

**`code` is the contract; `message` is prose.** A client that parses `message` breaks when
someone fixes a typo. This is worth internalising because it is a mistake almost everyone makes
once.

### `details` varies by code, on purpose

| Code                 | `details`                                                                  |
| -------------------- | -------------------------------------------------------------------------- |
| `VALIDATION_ERROR`   | `fields[]`, each with `field`, `rule`, `message`, plus `allowed` for enums |
| `MALFORMED_ID`       | `field`, `value`, `expected_pattern`                                       |
| `SKU_ALREADY_EXISTS` | `sku`, `conflicting_variant_id`                                            |
| `INVALID_JSON`       | `parser_message` — the parser's own message, with the offset               |
| `INTERNAL_ERROR`     | **nothing**                                                                |

That last row is a security decision, not an oversight. A `500` exposes only `code`, a generic
message, and `request_id`. An exception message was written for a developer reading a stack
trace, and leaking it discloses table names, file paths, and query fragments. The full error goes
to the log, findable by `request_id`.

### 400 versus 404 for an identifier

A real design choice, and this API takes the less common side.

- `prod_zzz` → **`400 MALFORMED_ID`**. This cannot possibly name a product; it is a client bug.
- `prod_00000000000000000000dead` → **`404 PRODUCT_NOT_FOUND`**. Well-formed; there is simply no
  such thing.

Most APIs return `404` for both. That leaves the caller unable to tell "my string interpolation
broke" from "the record was deleted" — and the first is the actual cause far more often. The
overwhelmingly common real-world case is `prod_undefined`, and being told "that is not an
identifier" saves an hour of looking for a deleted record that never existed.

**The counter-argument, stated fairly:** returning `400` confirms your id format to an
unauthenticated caller. Some APIs return `404` for both specifically to avoid that disclosure.
This API publishes its id format as a `pattern` in the contract anyway, so there is nothing left
to conceal ([D-007](docs/DECISIONS.md#d-007)).

There is a third distinction worth noticing: `404 ROUTE_NOT_FOUND` means the URL is not part of
this API at all. That is what a wrong base URL produces, and telling it apart from
`PRODUCT_NOT_FOUND` turns a dead end into a diagnosis.

### Why 409 for a duplicate SKU

`400` would say "your request was malformed" — it was not. `409 Conflict` says "your request was
fine, but it conflicts with existing state." The distinction tells the client whether to fix the
request or to fix its assumption about the world.

**And it is enforced, not validated.** There is no `SELECT ... WHERE sku = ?` before the insert.
A check-then-insert has a race window: two concurrent requests both find the SKU free, both
insert, one wins. The pre-check version passes every single-threaded test. This API relies on a
`UNIQUE` index — which cannot be raced — and translates PostgreSQL error `23505` into the `409`.
`tests/integration/catalog-write.test.ts` fires eight concurrent creates of the same SKU and
asserts exactly one `201`, seven `409`s, and one row.

That distinction — validating a rule versus _enforcing_ one — generalises well beyond SKUs.

### Reporting every problem at once

Ajv runs with `allErrors: true`, so a body with four mistakes produces four entries in
`fields[]`. With it off, Ajv stops at the first failure and fixing four mistakes takes four
round trips.

### Who cares

**Application developers** debugging an integration. **Support engineers** who need `request_id`
to escalate. **Security engineers** who care that `500` bodies say nothing.

### Explore it in Postman

`POST {{base_url}}/api/v1/products` with `{"vendor": "Acme"}` — read
`error.details.fields[0]`. Then `{"title": "X", "status": "pending"}` and read `allowed`. Then
`{"title": "X", "titel": "typo"}`. Then `GET /api/v1/products/prod_undefined`. Then
`GET /api/v1/products/prod_00000000000000000000dead`. Four different errors, one shape.

---

## 5. Authentication and authorization

Not yet — **Milestone 2**. Everything in this API is currently open.

Two things are worth saying now.

**The vocabulary.** _Authentication_ is who you are. _Authorization_ is what you may do. They
are different questions with different failure codes: `401 Unauthorized` means "I do not know
who you are" (in fact a misnomer — it should have been _Unauthenticated_), while `403 Forbidden`
means "I know who you are and you may not do this." Sending a valid token that lacks a scope is
`403`, not `401`.

**Redaction is already in place.** `src/observability/logger.ts` already redacts `authorization`,
`cookie`, `x-api-key`, and `proxy-authorization` headers and any field named `password`,
`secret`, or `token` — before any of those exist. Redaction added _after_ the credential exists
is redaction added after the credential was already logged, and log retention means "already"
can mean "for the next ninety days".

---

## 6. API testing

### Why the concept exists

Not "to catch bugs" — that is too vague to guide anything. Each _kind_ of test proves a specific
class of statement, and knowing which is which tells you where to put a new test and what your
suite still does not cover.

### The levels in this project

| Level                | Where                                | Count | Proves                                                                                                            | Does **not** prove               |
| -------------------- | ------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Unit**             | `tests/unit/`                        | 114   | Pure logic: id format, pagination arithmetic, Ajv error translation, config validation, the safety guard          | That anything is wired together  |
| **DB integration**   | `tests/integration/database.test.ts` | 22    | SQL and schema: constraints, triggers, cascade, index existence, seed determinism                                 | Anything about HTTP              |
| **HTTP integration** | `tests/integration/*.test.ts`        | 100   | Status codes, headers, envelopes, filters, sort stability, every documented error                                 | Anything about the network       |
| **Contract**         | `tests/integration/contract.test.ts` | 25    | Served spec = committed spec; real responses validate against published schemas; documented examples are accepted | That a `description` is truthful |
| **CLI smoke**        | `scripts/smoke.sh`                   | 103   | It works over a real TCP socket, from outside the process                                                         | Behaviour under load             |

### What each level actually buys you

**Unit tests** are fast and precise, and they can test things no other level reaches. The best
example here is the **test-database safety guard**: 34 tests covering host normalisation
(`localhost` and `127.0.0.1` must compare equal), the identity check, and the production
refusal. You cannot integration-test "refuses to wipe the wrong database" without wiping the
wrong database. An untested safety mechanism is a comment that happens to compile.

**Integration tests** catch what unit tests structurally cannot: that the router reaches the
handler, that the SQL is valid, that the response schema does not strip a field you added. They
use `fastify.inject()`, which drives a full request through the real router, hooks, validation,
handler, and serializer **without opening a socket** — fast, and honest about everything except
the network.

**Contract tests** are the level most projects skip. They do not test behaviour; they test that
the published contract and the running server agree. Including one that takes the `example` out
of the OpenAPI document and `POST`s it, because a stale example is a defect generation cannot
prevent.

**The smoke script** is the only thing here that goes over a real TCP connection, through real
HTTP parsing, to a separately-running process. It found two real bugs during the build:
malformed JSON returned `500` instead of `400 INVALID_JSON`, and `text/plain` was parsed as a
string instead of returning `415`. Both were invisible to every other level.

### Positive and negative cases

A suite that only tests success paths is testing the half that will be exercised anyway. The
error cases are where the design lives: `error.code`, the field names, the `allowed` list, the
`400`-versus-`404` decision. `tests/integration/errors.test.ts` is 34 tests and every one of
them is a failure.

### What remains unproven when all 261 pass

Worth stating precisely, because "the tests pass" invites more confidence than it earns:

- **Load and real concurrency.** One concurrency test exists (eight simultaneous SKU inserts).
  Nothing here says anything about a hundred requests a second.
- **TLS, proxies, timeouts.** Not exercised at all.
- **Whether the descriptions are true.** A `description` can be confidently wrong and every test
  still passes.
- **Whether the data model fits a requirement nobody has stated.** Tests confirm the code does
  what it was written to do. They cannot confirm it was the right thing to write.
- **Whether it is useful.** No test answers this.

### What Postman tests will prove that these do not

From Checkpoint 1 you will write `pm.test()` assertions. They are not redundant:

- They run against a **deployed** instance, over the network, with real TLS and real DNS.
- They exercise the **client's** view: your headers, your variable substitutions, your
  environment.
- They can be run by someone who cannot build the project.
- They express **workflows** — create a product, capture the id, add a variant, check inventory,
  place an order — which is awkward to express in a unit test and is exactly what an integration
  partner does.

And what they will not prove: anything about internal logic that is not reachable through HTTP,
and anything about a code path you did not think to request.

### Who cares

**QA engineers** own the boundary cases. **Backend developers** live in the unit and integration
levels. **Platform engineers** care that the whole thing runs in CI without a `.env`. **API
platform owners** care about the contract level.

### Explore it in Postman

Write your first test on the health request:

```javascript
pm.test('status is 200', () => pm.response.to.have.status(200));
pm.test('reports ok', () => pm.expect(pm.response.json().status).to.eql('ok'));
pm.test('carries a correlation id', () =>
  pm.expect(pm.response.headers.get('X-Request-Id')).to.be.a('string'),
);
```

Then write one that fails on purpose, to see what a failure looks like before you need to
diagnose a real one.

That is day one. Three assertions on `/health` is not expertise, and a QA lead will find the
floor of it in about ninety seconds. Three things take you past it:

**Assert against the schema, not just the status.** `pm.response.to.have.jsonSchema(schema)`
takes a JSON Schema object — and you already publish one at `/openapi.json`. Fetch it, pull
`components.schemas.Product` out of it, and assert a real response against the contract the
server claims to honour:

```javascript
const spec = pm.collectionVariables.get('openapi_spec'); // fetched in a pre-request script
pm.test('matches the published Product schema', () => {
  pm.response.to.have.jsonSchema(JSON.parse(spec).components.schemas.Product);
});
```

What that proves which a status check does not: every property, its type, its nullability, and
that no undeclared field crept in. What it still does not prove: that the _values_ are right. A
product with the wrong price passes a schema assertion cleanly.

**Run the collection, not the request.** The Collection Runner does iterations, delay,
persisting variables, and an exportable result file. That file is what a CI reporter consumes —
which is the entire bridge from "I ran my tests" to "the pipeline ran my tests", and the subject
of CP2.

**Drive it from data.** `pm.iterationData.get('sku')` reads a column from a CSV or JSON file, so
one request becomes N scenarios with one report. The question a QA lead is actually asking is
never "can you write a test", it is "how do you get from forty tests to four thousand without
forty thousand lines of maintenance". This is the answer.

Full task list in [`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md) CP1, groups 5 to 7.

---

## 7. Environments

### Why the concept exists

The same request must run against your laptop and against your Unraid deployment. If the host
is typed into the request, you need two collections and they drift apart. An environment is the
mechanism for keeping one collection and swapping the values.

### What represents it here

The API is built for it. **Every** setting comes from an environment variable — no config file
is baked into the image — which is what makes the identical image runnable unchanged in both
places. See `.env.example` for the whole list.

On the Postman side, two environments with **identical variable names** and different values:

| Variable   | Local                   | Unraid                            |
| ---------- | ----------------------- | --------------------------------- |
| `base_url` | `http://127.0.0.1:3000` | `http://REPLACE_UNRAID_HOST:3000` |

**The diagnostic that follows from this:** if a request works in one environment and not the
other, something that should be a variable is hard-coded. That is a useful thing to be able to
conclude in one step.

### Variable scopes, and where things belong

Postman has several scopes. The ones that matter, narrowest-wins:

| Scope               | Use for                                              | Example                 |
| ------------------- | ---------------------------------------------------- | ----------------------- |
| **Environment**     | Anything that differs between local and Unraid       | `base_url`, credentials |
| **Collection**      | Same everywhere, used in many requests               | a default page size     |
| **Local / runtime** | Values captured from a response during a run         | —                       |
| **Global**          | Almost nothing. Global state is hard to reason about | —                       |

**Identifiers captured from a response belong in collection variables, not the environment.**
`product_id` extracted from a `POST` is _run state_, not configuration. Putting it in an
environment means your committed environment file carries a stale id from last Tuesday, and
whoever imports it gets a `404` they cannot explain.

### How it fails

| Symptom                                     | Cause                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ECONNREFUSED`                              | No environment selected, so `{{base_url}}` is empty. **The most common first-day failure.** |
| Requests hit the wrong server               | Wrong environment selected. Check the dropdown before debugging anything else.              |
| `{{base_url}}` appears literally in the URL | The variable is not defined in the selected environment                                     |
| Works locally, `404` on Unraid              | A path was hard-coded, or the deployment is on a different port                             |
| A committed environment leaks a token       | Values were exported as _initial_ values instead of _current_ ones                          |

### The local-versus-shared distinction

The single most useful thing to know about Postman and secrets. The terminology changed
recently, so both names are worth carrying:

| Postman app       | VS Code extension | Synced to cloud and git | Visible to the Postman CLI / monitors |
| ----------------- | ----------------- | ----------------------- | ------------------------------------- |
| **Value** (local) | Current value     | **No**                  | No                                    |
| **Shared value**  | Initial value     | **Yes**                 | Yes                                   |

In the Postman app there is now one **Value** column plus an explicit share action per row. The
older two-column Initial/Current layout survives only in the VS Code extension.

So a secret set as a **local value** does not travel into your export, and one set as a
**shared value** does — into the Postman cloud, into your repository, and into every clone and
fork, permanently, because `git rm` does not unpublish it.

The corollary catches people out in the other direction too: an **unshared `base_url` syncs as
an empty string**. The collection works perfectly for you and is a shell for everyone else,
including CI. Configuration should be shared; credentials should not.

That leaves a genuine tension, and it has a named product answer rather than only a workaround.

Cloud runners can only read shared values, so a collection that needs a credential in CI cannot
simply keep it local. **Postman Vault** is the mechanism: a **Local Vault** secret is referenced
as `{{vault:secret-name}}` or `await pm.vault.get('name')`, never syncs anywhere, and is
therefore invisible to the Postman CLI, monitors, and scheduled runs. A **Shared Vault** secret
does reach those, at the cost of living in Postman cloud.

|                            | Local Vault | Shared Vault |
| -------------------------- | ----------- | ------------ |
| Manual and collection runs | ✅          | ✅           |
| Postman CLI                | ❌          | ✅           |
| Monitors, scheduled runs   | ❌          | ✅           |
| Syncs off your machine     | Never       | Yes          |

The third option, and usually the right one for a real credential, is **not to put it in Postman
at all**: inject it at run time from whatever already manages secrets for that pipeline —
`postman collection run --env-var "password=$SECRET"` reading a GitHub secret.

For CI identity specifically the Enterprise answer is a **service account**: a non-human
identity with its own short-lived token and its own audit trail, so a pipeline is not running as
a person who might leave the company. That is a Management Plane feature and it is covered in
§10.

You will hit this concretely at CP2 task 0 — your auth helper currently uses Local Vault, so the
collection cannot run in CI until you choose one of the three.

Nothing in Milestone 1 needs a credential. The habit belongs in place before the secret does.

### Who cares

**Everyone who runs a request.** **DevOps and platform engineers** own the deployed values.
**Security engineers** care that credentials are not in the repository.

### Explore it in Postman

Create an environment `Acme Commerce — Local` with `base_url = http://127.0.0.1:3000`. Change
your health request's URL to `{{base_url}}/health`. Then **deselect** the environment and send it
again — read the error carefully. That is the failure you will meet again, and recognising it
instantly is worth thirty seconds now.

---

## 8. Mocking

Covered in depth at **CP3**, but the concept is worth having early because the _reason_ for it
appears before the tooling does.

### Why the concept exists

A frontend developer needs `GET /api/v1/orders` to exist before the backend has built it. Three
options: wait, hard-code fake data into the client and remember to remove it, or agree the
contract now and develop against a mock of it.

Only the third has both sides making progress and neither guessing. It requires one thing first:
**a contract**. Which is why design-first and mocking are the same subject.

### Two kinds, and the difference matters

The framing most people carry — "a mock returns your saved examples, has no state, and cannot
surprise you" — describes only one of the two kinds Postman ships, and describing it as the
whole picture in 2026 is describing the old product.

|                       | Example-based mock           | Code-based local mock                                 |
| --------------------- | ---------------------------- | ----------------------------------------------------- |
| Responses             | Static, from saved examples  | Dynamic — any JavaScript                              |
| Where it runs         | Postman cloud, always on     | Locally, or deployed                                  |
| State across requests | None                         | Yes, via `pm.state` (beta)                            |
| Request matching      | Postman's matching algorithm | Your own handler logic                                |
| In CI                 | Via a collection run         | `postman mock run`, as a dependency of the test suite |
| Failure simulation    | No                           | Scenarios — latency, errors, rate limits, chaos mode  |

An **example-based mock** is built from your collection or OpenAPI examples and always runs in
Postman's cloud. It is the right tool for stubbing a frontend, and CORS is enabled so a browser
can call it directly.

A **code-based local mock** is a JavaScript request handler. It can hold state with `pm.state`,
query datasets with `pm.datasets`, assert with `pm.test` inside the mock itself, and — the part
that changes the picture — run as a **local dependency of your CI test suite** via
`postman mock run`, with `postman collection run --mock` pointing at it.

That last capability is why the old framing is now wrong in a way that matters commercially: a
platform lead asking "can I run contract tests in CI without standing up the real service" has a
product answer, and it is not "no, mocks are just static examples".

### Your examples become the mock

The examples in `openapi/openapi.json` are not decoration — for an example-based mock they
_become_ its behaviour. A thin example produces a useless mock, which is a concrete reason to
write good ones. This project's contract tests already assert that the documented `ProductCreate`
and `VariantCreate` examples are accepted by the real API, so they cannot quietly go stale.

### What a mock cannot do

The limitation to be precise about, because it is where mocks mislead:

- **A static mock returns what you told it to.** It will not surprise you with a `409`, a
  timeout, or a validation error you did not anticipate. A code-based mock _can_ — but only the
  failures you thought to script.
- **A mock agrees with the contract by construction.** So it proves nothing about whether the
  implementation agrees.

That second point is the deep one. A mock and a real server can both satisfy a contract and
behave differently. Comparing the two is how you find contract drift, and it is precisely the
Milestone 5 exercise.

## 9. Idempotency, webhooks, versioning

Milestones 3, 4 and 5. Listed so the shape of what is coming is visible:

- **Idempotency** (M3A) — why clients retry, why a retried `POST` can duplicate a side effect,
  how an `Idempotency-Key` makes it safe, and what should happen when the same key arrives with
  a different payload. You have already met the free case: `DELETE` is idempotent by nature
  because it asserts a state, and §4 covers why `POST` gets none of that for nothing.
- **Webhooks** (M4A) — polling versus event delivery, delivery attempts and retries, why
  at-least-once delivery makes the _consumer's_ idempotency the producer's problem, HMAC
  signature verification, replay protection, and why ordering is not guaranteed.
- **Versioning and breaking changes** (M5A) — URL versus header versioning, deprecation windows,
  expand-then-contract migrations, and how to coordinate a change with a consumer who cannot
  redeploy on your schedule.

---

## 10. The Management Plane

Everything above is the **Activity Plane** — the requests, environments, variables and
assertions an individual developer touches. It is genuinely most of what people know Postman
for, and on its own it supports the description "Postman is where you test APIs".

That description is the problem. It is the pitch for a tool, and it invites the obvious reply:
_we already have one._ The Management Plane is the part that answers a different question —
**who is enforcing this across four hundred developers, and how would you know if they stopped?**

Nothing in this repository taught you any of it until now, which was the single largest finding
of `docs/LEARNING_PLAN_AUDIT.md`. The build gets you Activity Plane depth, and that depth is
real and necessary. It does not get you here.

### Spec Hub — the contract as a first-class object

You have an OpenAPI document, you drift-check it in CI, and you lint it with Redocly. All of
that is real. But the spec lives in a git repository, so the only people who can see it are
people who can clone it.

**Spec Hub** puts the specification in Postman: versioned, linked to the collections generated
from it, with an **Issues** tab that surfaces problems against it. The property worth
understanding is the _link_ — change the spec and the collection can follow, so "the collection
has drifted from the contract" stops being a thing that happens silently.

Exercised at **CP2 tier A, task 1**.

### Governance rules — where lint becomes policy

`redocly.yaml` in this repository is a real governance implementation. It requires an
`operationId`, a description on every parameter, and a `4xx` on every operation, and
`.redocly.lint-ignore.yaml` records three reviewed exceptions with reasons rather than switching
the rule off. That is exactly the right instinct.

A customer will never ask you about Redocly.

The Postman mechanism is: rules configured under **API Catalog → Governance Groups**, applied to
specs in **Spec Hub**, enforced by the **Postman CLI** in the pipeline, with results reported
back into the Catalog. The rule library ships Postman's own guidelines plus Zalando and OWASP,
and supports custom rules and custom functions.

The difference that matters is not the linting. Both lint. The difference is **where the result
goes**: a Redocly failure is a red line in someone's terminal, and a Postman governance failure
lands in a Catalog a platform lead can look at across every service without asking anyone.

Governance rules are **Enterprise-gated**, which is the point rather than an inconvenience — it
is the boundary between a tool a team adopts and a platform an organisation standardises on.

Exercised at **CP2 tier B, tasks 6 and 7**. Confirm your plan first.

### The Postman CLI — and an honest answer about Newman

`postman spec lint <spec>` validates a specification against your governance rules and, with
`--report-events` (on by default), uploads the result to the API Catalog, where it appears under
**your service → Test tab → CI Pipeline Runs**.

**Vocabulary trap:** `postman api lint` is the v11 API Builder command and is not supported in
v12+. Use `postman spec lint`.

On Newman, get this right, because it is a question you will be asked and the lazy answer costs
you the room. **Newman is not deprecated.** Postman still ships a full Newman documentation tree
— install, command reference, reporters, Docker, Jenkins — alongside a migration guide. Plenty
of QA leads run it in Jenkins today, and telling one it is legacy is telling them their pipeline
is wrong.

The defensible answer is the difference, not a verdict:

|                   | Newman                      | Postman CLI                                      |
| ----------------- | --------------------------- | ------------------------------------------------ |
| Source            | Open source, npm            | Closed source, official single binary            |
| Account           | None required               | Postman API key / `postman login`                |
| Collection source | Local JSON file             | Postman cloud by ID, or a local file             |
| Results           | Terminal and reporter files | **Sync back to the app and the API Catalog**     |
| Spec linting      | No                          | **`postman spec lint` against governance rules** |
| CI identity       | Personal or file-based      | **Service accounts** (Enterprise)                |

The framing: _"Newman runs the collection. The Postman CLI runs the collection and puts the
result somewhere your platform team can see it — which is the difference between a test and a
gate with evidence."_

### Service accounts — CI identity as a security control

A pipeline authenticating as a person is a pipeline that breaks when that person leaves, and an
audit trail that attributes automated actions to a human. A **service account** is a non-human
identity with its own short-lived token and its own trail. Enterprise-only, and it is one of the
proof points a Security or IT buyer asks about unprompted.

The failure modes are specific and worth knowing before you hit them: a personal API key returns
**401** at token minting rather than a warning; an org-level Admin role still **403s** at
workspace create without a role on the specific sub-team; and Workspace Management Settings
allowlists override roles independently, so granting a role does not clear them.

### Git-connected workspaces

You already have this working — `.postman/resources.yaml`, and `postman/` versioned alongside
the code. What is worth understanding is what it changes: the repository becomes the source of
truth rather than a place exports get dropped, which is what makes a collection reviewable in a
pull request like any other artifact.

### API Catalog versus Private API Network

The primary field confusion, and pure vocabulary — five minutes to learn, high cost to get wrong
in front of a platform team.

- **API Catalog** — the **producer** view. Every API the organisation runs, with health
  scorecards aggregating test pass rates, spec compliance and gateway metrics.
- **Private API Network** — the **consumer** view. The internal directory developers search when
  they want to _use_ an API someone else owns.

One answers "what do we operate and is it healthy". The other answers "does something already
exist that does this". Read as one feature, they sound redundant; they are not.

### The five metrics

Named in `docs/CHECKPOINTS.md` M6, and worth carrying because they are how the motion is
measured rather than described: **Package Adoption Rate**, **Gate Coverage × Flake Rate**,
**Design Escape Rate**, **Mean Time To Detect**, **Change Failure Rate**.

Two of them you will meet directly. You publish a package at CP3 — you cannot speak credibly
about adoption of a mechanism you have never used. And you deliberately make a test flaky at
CP2, because the impulse to re-run rather than fix _is_ the muted-gate diagnosis, and Gate
Coverage × Flake Rate is the number that exposes it.

### What none of this proves

The Management Plane tells you what is being enforced and whether it is working. It does not
tell you whether the API is any good, whether the tests assert anything meaningful, or whether
anyone acts on a red scorecard. A governance rule nobody has tuned and a gate everybody bypasses
produce excellent dashboards.

---

## 11. Performance testing

Concept only in this project, and honestly so: cloud performance runs need VU hours, and your
team's `perf_test_milli_vuh` is **0**. There is no task to perform here, and a checkpoint with
an unperformable task is worse than an acknowledged gap.

What to know:

| Profile   | Shape                                 | Answers                                              |
| --------- | ------------------------------------- | ---------------------------------------------------- |
| **Fixed** | Constant virtual users for a duration | "Does it hold up at our normal load?"                |
| **Ramp**  | Users increase steadily               | "Where does it start to degrade?"                    |
| **Spike** | Sudden jump, then back down           | "Does a flash sale take us down, and do we recover?" |
| **Peak**  | Ramp to a target, hold, ramp down     | "Will Black Friday break us?"                        |

The distinction that matters in conversation is that these answer _different_ questions rather
than being sizes of the same test. "Will Black Friday break us" is Peak. "Why did it fall over
at 3pm" is Ramp — you want the knee of the curve, not a pass or fail.

And the thing performance testing cannot tell you: whether the load profile you modelled
resembles real traffic. A clean Peak run against the wrong distribution is a confident wrong
answer.
