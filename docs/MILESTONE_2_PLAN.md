# Milestone 2A Plan — Authentication, Locations, Inventory, Pricing

Status: **planned**
Date: 2026-09-11

Written before the implementation, like `MILESTONE_1_PLAN.md`. This is the document to
disagree with cheaply.

Milestone 1 built a catalog that anyone could read _and write_. This milestone introduces
identity, then three domains that need it: where stock lives, how much of it there is, and what
it costs.

---

## 1. Scope

| Area      | Endpoints                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth      | `POST /api/v1/auth/token`, `GET /api/v1/auth/me`                                                                                                                                                                   |
| Locations | `POST`, `GET` (list), `GET` (one), `PATCH` on `/api/v1/locations`                                                                                                                                                  |
| Inventory | `GET /inventory`, `GET /inventory/{sku}`, `POST /inventory/adjustments`, `GET /inventory/history`, `POST /inventory/reservations`, `GET /inventory/reservations/{id}`, `POST /inventory/reservations/{id}/release` |
| Pricing   | `GET /api/v1/pricing/{sku}`                                                                                                                                                                                        |

Plus: a role and permission model, `401`/`403` handling, five new tables, seed data for all of
them, OpenAPI updates, and tests.

**Out of scope, deliberately:** customers, orders, fulfillment (Milestone 3); partner API keys
and webhooks (Milestone 4); CI integration tests and governance exercises (Milestone 5).

---

## 2. Authentication

### 2.1 What this is not

Not an identity provider. There is no registration, no password reset, no email verification,
no refresh tokens, no session management, no MFA, no OAuth. Building those would be a project
in itself and would teach almost nothing about API engineering that a bearer token does not.

What it _is_: a credential exchange that issues a signed, expiring bearer token, so that every
downstream concept — `Authorization` headers, `401` versus `403`, roles, scopes, token expiry,
collection-level auth in Postman — has something real to attach to.

This will be stated in the OpenAPI description, the README, and the token endpoint's own
documentation, because a development auth flow that isn't labelled as one eventually gets
deployed by somebody.

### 2.2 Token format: JWT (HS256)

`POST /api/v1/auth/token` with an email and password returns a JWT.

**Why a JWT rather than an opaque random string.** An opaque token would be simpler and is
genuinely better for revocation. A JWT is chosen because you can **paste it into a decoder and
read it** — three base64url segments, a header, a claims payload, a signature. Being able to
see `sub`, `role`, `exp` and then watch a request fail once `exp` passes turns an abstraction
into an object you can hold. The claims are visible in Postman's response pane without any
tooling.

The corresponding lesson is the one people get wrong: **a JWT is signed, not encrypted.**
Anyone holding it can read every claim. That is a property to design around, not a flaw, and
it is why nothing sensitive goes in a token.

**Signed with `jose`, not by hand.** Implementing HS256 signing with `node:crypto` is about
sixty lines and would make the mechanics visible in our own source. It is also how you end up
with a verifier that accepts `alg: none`, or compares signatures non-constant-time. The
anatomy will be explained in documentation and in comments; the verification will be done by a
library that has already had those bugs found in it.

**Revocation is not supported, and that is the tradeoff.** A stateless token cannot be
withdrawn before it expires. Mitigated by a short default TTL (1 hour, configurable). Recorded
as a decision rather than glossed, because "we used JWTs and then needed logout" is one of the
most common regrets in this space.

### 2.3 Passwords

A `users` table with **scrypt** hashes — `node:crypto`, no new dependency, and the correct
modern choice for password storage alongside argon2 and bcrypt.

Stored as `scrypt$N$r$p$<salt-b64>$<hash-b64>` so the parameters travel with the hash and can
be raised later without invalidating existing rows. Verification uses `timingSafeEqual`.

Seeded development users, with passwords documented in the README because they are fixtures,
not secrets:

| Email                  | Role        | Password           |
| ---------------------- | ----------- | ------------------ |
| `dev@acme.example`     | `developer` | `dev-password-123` |
| `support@acme.example` | `support`   | `dev-password-123` |
| `admin@acme.example`   | `admin`     | `dev-password-123` |

A wrong password returns `401 INVALID_CREDENTIALS` — the same code and the same message as an
unknown email, so the endpoint cannot be used to enumerate which addresses exist.

### 2.3.1 Rate limiting the token endpoint

`POST /api/v1/auth/token` is unauthenticated and runs **scrypt on every call**. Scrypt is
deliberately expensive — that is the entire point of a password KDF — which makes an open
endpoint that runs one per request a cheap CPU-exhaustion target. This is deployed on a NAS on
a home LAN, alongside whatever else is on that network.

A fixed-window counter, in memory, keyed on client IP: **10 attempts per minute**, then `429`
with a `Retry-After` header and a `RATE_LIMITED` code. About thirty lines, no dependency.

Two things it buys beyond not falling over: it slows credential guessing to uselessness, and it
gives the API a `429` — a response class it has nowhere else, and one every consumer eventually
has to handle.

Deliberately _not_ distributed. An in-memory counter resets on restart and does not coordinate
across replicas. For a single container that is fine; the limitation is recorded rather than
papered over, and a shared store is the kind of thing that should arrive with a second replica,
not before one.

### 2.4 Roles and permissions

Three roles, each a fixed set of permission strings. Roles are the coarse label; **permissions
are what the code actually checks**, so adding a role later does not mean editing every route.

| Permission        | `developer` | `support` | `admin` |
| ----------------- | ----------- | --------- | ------- |
| `catalog:read`    | ✅          | ✅        | ✅      |
| `catalog:write`   | ✅          | —         | ✅      |
| `locations:read`  | ✅          | ✅        | ✅      |
| `locations:write` | ✅          | —         | ✅      |
| `inventory:read`  | ✅          | ✅        | ✅      |
| `inventory:write` | ✅          | —         | ✅      |
| `pricing:read`    | ✅          | ✅        | ✅      |

`support` is deliberately read-only across the board. That is what makes a `403` reachable
without inventing a contrived role: log in as support, try to adjust inventory, get `403`.

### 2.5 `401` versus `403`

The distinction most APIs blur, given its own error codes:

| Situation                                  | Status  | Code                      |
| ------------------------------------------ | ------- | ------------------------- |
| No `Authorization` header                  | 401     | `AUTHENTICATION_REQUIRED` |
| Malformed header (not `Bearer <token>`)    | 401     | `INVALID_TOKEN`           |
| Signature invalid, or claims tampered with | 401     | `INVALID_TOKEN`           |
| Token expired                              | 401     | `TOKEN_EXPIRED`           |
| Valid token, insufficient permission       | **403** | `INSUFFICIENT_PERMISSION` |

`401` means _I do not know who you are_ — retry with credentials. `403` means _I know exactly
who you are and the answer is still no_ — retrying with the same token is pointless.

`TOKEN_EXPIRED` is separated from `INVALID_TOKEN` on purpose: it is the one `401` where the
correct client behaviour is "get a new token and retry", and a client cannot infer that from a
generic code.

`403` responses will name the permission that was required, in `error.details.required_permission`.
An authorization failure that does not tell you what you needed is a support ticket.

### 2.6 Which endpoints require what — and a change to Milestone 1 behaviour

**Catalog reads stay public. Catalog writes now require `catalog:write`.**

This is a deliberate, defensible split rather than a blanket lock: a storefront reads the
catalog without credentials, and nobody writes to it except internal systems. It is also the
model most real commerce APIs use.

| Endpoint                                          | Requires                         |
| ------------------------------------------------- | -------------------------------- |
| `GET /health`, `/ready`, `/openapi.json`, `/docs` | —                                |
| `POST /api/v1/auth/token`                         | —                                |
| `GET /api/v1/auth/me`                             | any valid token                  |
| `GET` catalog (products, variants)                | — _(unchanged from Milestone 1)_ |
| `POST`/`PATCH`/`DELETE` catalog                   | `catalog:write`                  |
| `GET` locations                                   | `locations:read`                 |
| `POST`/`PATCH` locations                          | `locations:write`                |
| `GET` inventory, history, reservations            | `inventory:read`                 |
| `POST` adjustments, reservations, release         | `inventory:write`                |
| `GET /api/v1/pricing/{sku}`                       | `pricing:read`                   |

**This breaks four requests in the existing Postman collection** — everything in
`Catalog / Workflow`. That is intentional and proportionate: it is a real experience of an
auth change arriving, contained to four requests, with the `Reads` folder still passing so the
contrast is visible. The alternative — leaving Milestone 1 endpoints permanently unauthenticated
— would be an inconsistency with no defence.

Pricing requires a permission because `?customer_id=` returns customer-specific pricing.
Exposing that publicly would leak commercial terms.

---

## 3. Locations

`acme.locations`

| Column                                                                       | Type               | Notes                                       |
| ---------------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| `id`                                                                         | `text` PK          | `loc_` + 24 hex                             |
| `name`                                                                       | `text` NOT NULL    | unique, 1–100 chars                         |
| `type`                                                                       | `text` NOT NULL    | CHECK in (`warehouse`, `retail`, `virtual`) |
| `address_line1`, `address_line2`, `city`, `region`, `postal_code`, `country` | `text`             | `country` is ISO-3166-1 alpha-2             |
| `is_active`                                                                  | `boolean` NOT NULL | default `true`                              |
| `created_at` / `updated_at`                                                  | `timestamptz`      | trigger-maintained                          |

Seeded: Toronto Warehouse, Vancouver Warehouse, Barrie Retail Location.

No `DELETE`. A location with inventory history cannot be removed without orphaning it, and
`is_active = false` expresses the real intent. The absence is documented rather than silent —
the endpoint map for this milestone does not include one either.

`virtual` exists for future dropship and in-transit stock. Present now so the enum does not
need widening later, which would be a breaking change for a client switching on it.

---

## 4. Inventory

The largest piece, and the one with the most interesting failure modes.

### 4.1 Model

```
variants ──1:1── inventory_items ──1:N── inventory_levels ──N:1── locations
                       │
                       ├──1:N── inventory_adjustments   (audit log, append-only)
                       └──1:N── inventory_reservations
```

**`inventory_items`** — one per SKU. `id` (`invitem_`), `sku` (unique, FK to `variants.sku`),
`tracked` (boolean). This is what `variants.inventory_item_id` — the null column deliberately
left in Milestone 1 — finally points at.

**`inventory_levels`** — one row per (item, location). `on_hand` and `reserved`, both
integers.

`available` is **computed, never stored**: `available = on_hand - reserved`. Storing it would
create a third number that can disagree with the other two, and the first bug in any inventory
system is exactly that disagreement.

Constraints, which do the real work:

```sql
CHECK (on_hand  >= 0)
CHECK (reserved >= 0)
CHECK (reserved <= on_hand)   -- cannot reserve stock that is not there
UNIQUE (inventory_item_id, location_id)
```

**`inventory_adjustments`** — append-only audit log. `quantity_delta` (signed), `reason`
(CHECK enum: `received`, `sold`, `damaged`, `correction`, `transfer_in`, `transfer_out`,
`return`), `reference` (free text — a PO number, an order id), `actor` (the authenticated
subject), `created_at`. Never updated, never deleted.

**`inventory_reservations`** — `quantity`, `status` (`active`, `released`, `expired`),
`expires_at`, `reference`, `actor`.

### 4.2 Concurrency — the lesson of this milestone

Two requests reserving the last unit must not both succeed. The naive implementation reads
`available`, checks it, then writes — and loses that race every time under load, while passing
every single-threaded test.

The approach mirrors the SKU uniqueness decision from Milestone 1 ([D-017](DECISIONS.md)):
**do not check, attempt and interpret the failure.**

```sql
UPDATE inventory_levels
   SET reserved = reserved + $qty
 WHERE inventory_item_id = $item AND location_id = $loc
```

If that would push `reserved` past `on_hand`, the `CHECK (reserved <= on_hand)` constraint
rejects it, and SQLSTATE `23514` becomes `409 INVENTORY_INSUFFICIENT` with the available
quantity in `error.details`. The database arbitrates; no application-level lock is needed and
no race window exists.

A test will fire N concurrent reservations against a level with fewer than N units and assert
that exactly the right number succeed — the direct analogue of the eight-way SKU test.

### 4.3 Reservation lifecycle

```
              POST /reservations
                     │
                     ▼
                 [ active ] ──── POST /{id}/release ────▶ [ released ]
                     │
                     └──── expires_at passes ──────────▶ [ expired ]
```

- **Release** returns the quantity to available and sets `status = 'released'`.
- **Duplicate release** returns `200` with the already-released reservation. Idempotent, for
  the same reasons as archiving ([D-009](DECISIONS.md)): it is a state assertion, the response
  is truthful, and a retry after a timeout is not an error.
- **Expiry is swept on write, not on read, and not by a scheduler.**

  The naive version — treat a reservation as expired whenever you happen to read it — is wrong
  in a way that is easy to miss. `reserved` is a stored column guarded by
  `CHECK (reserved <= on_hand)`. If expired reservations never decrement it, the column stays
  inflated and the constraint begins **rejecting legitimate reservations** for stock that is
  genuinely available. The concurrency test would still pass; real usage would wedge.

  So: every reservation attempt first releases any expired reservations for that
  `(inventory_item, location)`, **inside the same transaction**, before attempting its own
  increment. Roughly ten lines, no scheduler, and the constraint stays meaningful.

  The cleaner long-term answer is to stop storing `reserved` at all and derive it as a sum over
  active, unexpired reservations — no column, nothing to drift, no sweep. That is a larger
  change to the model and a good candidate for a later refactor exercise; it is recorded here
  so the choice is visible rather than defaulted into.

  Residual limitation: stock held by an expired reservation at a location nobody is currently
  reserving from stays counted until someone tries. Bounded, and self-healing on next use.

### 4.4 Endpoints

`GET /api/v1/inventory` — paginated, filters `sku`, `location_id`, `available_below`. That last
one answers "what is nearly out of stock", which is the query a merchandiser actually has.

`GET /api/v1/inventory/{sku}` — one SKU across all locations, with a `totals` object. Note the
path parameter is a **SKU**, not an opaque id — the one place in this API where a
human-meaningful natural key is in the path, because that is how people refer to inventory.
Worth documenting as deliberate.

Its two `404`s are kept distinct, because they need different fixes. `VARIANT_NOT_FOUND` means
no such SKU exists in the catalog — check the SKU. `INVENTORY_ITEM_NOT_FOUND` means the SKU
exists but is not inventory-tracked — create the inventory item. Collapsing them sends someone
hunting for a typo that isn't there.

`POST /api/v1/inventory/adjustments` — `{sku, location_id, quantity_delta, reason, reference?}`.
Returns the adjustment and the resulting level. Refuses to drive `on_hand` below zero, and
below `reserved`.

`GET /api/v1/inventory/history` — the adjustment log, filterable by `sku`, `location_id`,
`reason`, and a date range.

---

## 5. Pricing

`GET /api/v1/pricing/{sku}?customer_id=&partner_id=&quantity=&currency=`

### 5.1 The response explains itself

The requirement is that the response explain the calculation rather than return one number.
So it returns the base price, every rule considered, which applied, and the arithmetic:

```json
{
  "data": {
    "sku": "ACME-BAG-BLK",
    "currency": "CAD",
    "quantity": 10,
    "base_price_cents": 12900,
    "adjustments": [
      {
        "rule_id": "prule_...",
        "type": "sale",
        "description": "Autumn sale — 15% off Backpacks",
        "amount_cents": -1935,
        "applied": true
      },
      {
        "rule_id": "prule_...",
        "type": "quantity_break",
        "description": "10 or more: 5% off",
        "amount_cents": -548,
        "applied": true
      },
      {
        "rule_id": "prule_...",
        "type": "customer_group",
        "description": "Wholesale tier",
        "amount_cents": -1290,
        "applied": false,
        "skipped_reason": "customer_id not supplied"
      }
    ],
    "effective_unit_price_cents": 10417,
    "total_price_cents": 104170,
    "applied_rule_ids": ["prule_...", "prule_..."]
  }
}
```

Including the rules that did **not** apply, with a reason, is the difference between an API a
support engineer can answer a question with and one that produces a number nobody can explain.

### 5.2 Rules

`acme.pricing_rules`: `type` (`sale`, `customer_group`, `quantity_break`, `partner`), a scope
(all / product_type / sku), `adjustment_kind` (`percentage` / `fixed_amount`), `adjustment_value`,
`priority`, `starts_at` / `ends_at`, `is_active`.

**Application order is by `priority` ascending, and each adjustment applies to the running
subtotal, not to the base price.** That ordering is a business decision with a visible
consequence — two 10% discounts compound to 19%, not 20% — so it is documented in the operation
description and asserted in a test. Getting this wrong silently is how pricing bugs reach
customers.

Rounding: half-up, to whole cents, after each adjustment. Stated because rounding rules are
never obvious and always matter.

Seeded rules will produce different outcomes for: no parameters, a quantity break, a
customer group, and a sale on a product type.

No admin endpoints for managing rules in this milestone — the endpoint map says they are
optional, and seed data plus `GET` demonstrates every behaviour worth demonstrating.

---

## 6. Errors added

| Code                       | Status |
| -------------------------- | ------ |
| `AUTHENTICATION_REQUIRED`  | 401    |
| `INVALID_TOKEN`            | 401    |
| `TOKEN_EXPIRED`            | 401    |
| `INVALID_CREDENTIALS`      | 401    |
| `INSUFFICIENT_PERMISSION`  | 403    |
| `LOCATION_NOT_FOUND`       | 404    |
| `INVENTORY_ITEM_NOT_FOUND` | 404    |
| `RESERVATION_NOT_FOUND`    | 404    |
| `INVENTORY_INSUFFICIENT`   | 409    |
| `RESERVATION_NOT_ACTIVE`   | 409    |
| `LOCATION_NAME_EXISTS`     | 409    |
| `PRICING_UNAVAILABLE`      | 404    |

---

## 7. Configuration added

| Variable                 | Default      | Notes                                                           |
| ------------------------ | ------------ | --------------------------------------------------------------- |
| `AUTH_TOKEN_SECRET`      | _(required)_ | HS256 signing key. Startup fails if shorter than 32 characters. |
| `AUTH_TOKEN_TTL_SECONDS` | `3600`       | Short by default, because tokens cannot be revoked.             |

`AUTH_TOKEN_SECRET` becoming **required** means an existing deployment will refuse to start
after upgrading without it. That is the correct behaviour — a signing key with a default value
is not a signing key — and it is a real, small taste of an operationally breaking change, which
makes it worth doing deliberately and documenting in the deployment guide.

---

## 8. Testing

Everything from Milestone 1, plus:

- **Unit** — permission resolution per role, scrypt hash/verify round trip, token sign/verify,
  tampered signature rejected, `alg` confusion rejected, expiry, pricing arithmetic and
  rounding, compounding order.
- **Integration** — every endpoint's happy path; `401` for each of the four causes; **`403` for
  the `support` role against every single write endpoint, not one representative** — a thin
  authorization matrix is how exactly one route ends up ungated; concurrent reservation
  contention; the expired-reservation sweep freeing stock; adjustments refusing to drive
  `on_hand` below zero or below `reserved`; duplicate release; `429` from the token endpoint;
  the audit log summing to the levels.
- **Contract** — the `bearerAuth` scheme exists, and **every operation that requires a
  permission declares `security`**. Without that assertion the spec quietly under-documents
  auth: catalog reads are legitimately unauthenticated, so "some operations have no `security`
  block" is not by itself a defect, and only a test can tell those two cases apart.

The concurrency test is the one that matters most, and the one most likely to be skipped.

---

## 9. Sequence

Auth → locations → inventory → pricing. Each is a complete vertical slice — migration, seed,
repository, service, routes, schemas, tests — verified before the next begins, so a failure is
attributable to the slice that caused it.

**Verified and committed in two halves**, not four and not one:

1. **Auth + Locations** — `BUILD_VERIFICATION.md` updated, committed, tagged. The entire
   `401`/`403` matrix must be green before anything else is built, because every remaining
   endpoint depends on it being right.
2. **Inventory + Pricing** — verified and committed on top.

One STOP AND LEARN checkpoint at the end, covering both. The split exists so that if reservation
concurrency turns out to be a day's work, there is a real, working, tagged fallback point rather
than a half-finished milestone.

### 9.1 Upgrading the running deployment

`AUTH_TOKEN_SECRET` is required, so **the Unraid container will refuse to start after pulling
this version until it is set** — exit code 78, with the reason named. That is correct behaviour
for a missing signing key, and it is also a real, if small, operationally breaking change. It
belongs in the checkpoint's upgrade steps where it will actually be read, not only in the
deployment guide.

`scripts/dev-postgres.sh` will generate one into `.env` for local development.

---

## 10. Risks

| Risk                                              | Mitigation                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Breaking the existing Postman collection          | Deliberate and scoped to four requests; called out in the checkpoint before it is discovered  |
| `AUTH_TOKEN_SECRET` breaking a running deployment | Documented in the deployment guide and in the checkpoint's upgrade steps                      |
| Reservation concurrency subtly wrong              | Enforced by a database constraint, not application logic, and tested with concurrent requests |
| Pricing arithmetic disputes                       | Compounding order and rounding documented and asserted, not left implicit                     |
| Milestone too large to verify well                | Four independent slices, each verified before the next                                        |
| Expired reservations inflating `reserved`         | Documented limitation with a stated fix; candidate for a later exercise                       |
