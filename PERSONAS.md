# Engineering personas

Who participates in the API lifecycle, what they are actually trying to do, and where this
project's artifacts meet them.

This is a working reference, not marketing copy. Each entry describes the real job first: what
the person is measured on, what wastes their time, and what evidence they need before they will
agree with you. Postman appears only where it genuinely helps, and where it does not solve the
problem, that is said.

A note on scope: personas below are marked **Active now** where Milestone 1 already gives them
something to do, and **Arrives later** where their work depends on a milestone not yet built.
The later entries are deliberately shorter — writing a detailed account of a job that does not
yet exist here would be speculation dressed as documentation.

---

## 1. Frontend / application developer — _Active now_

### What they are trying to accomplish

Ship a screen. They need product data on it, and the API is an obstacle between them and that.
They are measured on the screen working, not on understanding your data model.

### Which APIs they touch

`GET /api/v1/products` (with every filter and sort combination the UI offers),
`GET /api/v1/products/{id}`, `GET /api/v1/products/{id}/variants`. Later: orders, pricing,
inventory.

### Artifacts they use

`/openapi.json` (usually via a generated client), `/docs`, and examples. They rarely read the
README.

### Where they enter the lifecycle

Ideally at **contract design**, before implementation — because they know what the screen needs
and the backend does not. In practice, often after the endpoint already exists, which is how you
end up with `GET /products` followed by 25 calls to `GET /products/{id}` because the list
response omitted something.

### What frustrates them

- Waiting for a backend that is not built. The whole reason mocking exists.
- A response missing one field they need, forcing an N+1 call pattern.
- Pagination without `total_pages`, so they cannot render a pager.
- An error body they cannot show a user and cannot branch on.
- Behaviour that differs from the documentation, discovered at 4pm.

### Risks they care about

A breaking change shipped without warning. A response shape that varies between endpoints, so
their parsing code cannot be shared.

### Questions they ask

_"Can I filter by two tags?"_ (No — one per request in this version.) _"Are archived products in
the default list?"_ (Yes, deliberately — [D-010](docs/DECISIONS.md#d-010).) _"Is `description`
ever null?"_ (Yes — the contract says `["string","null"]`.) _"Will this field always be there?"_

### Evidence they need

A response body they can paste into their code. The `total_pages` field. A definitive answer on
nullability — which the contract gives, in a machine-readable form.

### How Postman helps

Explore before writing a line of client code. Import the OpenAPI document, click through the
Catalog folder, see real shapes with real values. Later: a **mock server** from the contract, so
they build the screen while the endpoint is still being written.

**Where it does not help:** Postman will not tell them whether the field they need _should_
exist. That is a conversation.

---

## 2. Backend / API developer — _Active now_

### What they are trying to accomplish

Implement the endpoint correctly, without breaking the four consumers they cannot see.

### Which APIs they touch

All of them, plus `/health` and `/ready` while debugging their own work.

### Artifacts they use

The whole repository. Specifically: `docs/ARCHITECTURE.md` for the layering,
`docs/DECISIONS.md` to find out why something is the way it is before changing it, the migration
CLI, `npm run verify`, and `git diff openapi/openapi.json` to see what their change did to the
contract.

### Where they enter the lifecycle

Steps 4–8 of [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) — contract design
through OpenAPI update. Increasingly also step 3, identifying consumers, because that determines
whether the change is allowed to be breaking.

### What frustrates them

- A requirement that does not survive contact with the data model, discovered mid-implementation.
- Tests that assert the implementation rather than the behaviour, so a refactor breaks fifty of
  them.
- Not knowing who consumes a field they want to remove.
- A schema change that requires touching four files (here: the migration, `src/db/schema.ts`, the
  TypeBox schema, and the tests — an accepted cost of having no generated artifact,
  [D-004](docs/DECISIONS.md#d-004)).
- Being asked "is this breaking?" with no way to answer definitively.

### Risks they care about

Shipping a breaking change unnoticed. Data loss from a migration. A race condition that passes
every single-threaded test — the SKU pre-check is the canonical example
([D-017](docs/DECISIONS.md#d-017)).

### Questions they ask

_"Is this additive or breaking?"_ _"What happens on a retry?"_ _"Is this enforced or just
validated?"_ _"Who reads this field?"_

### Evidence they need

`npm run openapi:check` output — a definitive, mechanical answer to "did I change the contract?"
A green test suite. A migration that applied to an empty database (which every integration test
run proves, because it migrates from empty each time).

### How Postman helps

Reproducing a bug report exactly as the reporter sent it. Manually exercising a path that is
awkward to unit-test.

**Where it does not help:** it is not a substitute for the test suite, and a passing Postman
request says nothing about the code path that was not requested.

---

## 3. QA engineer — _Active now_

### What they are trying to accomplish

Find the case nobody thought about, before a customer does. They are the persona whose job is
most directly served by this API's design.

### Which APIs they touch

All of them, and the boundaries hardest: `page=0`, `limit=101`, `sort=password`,
`prod_undefined`, empty results, tied sorts, duplicate SKUs, concurrent writes.

### Artifacts they use

`/openapi.json` as the oracle for what _should_ happen. `docs/BUILD_VERIFICATION.md` for what has
already been checked, so they do not repeat it. `error.code` values as assertion targets.

### Where they enter the lifecycle

Ideally at **requirement clarification** (step 2), because "what should happen when it is empty"
is a QA question and asking it early is cheaper than finding out late. In practice often at
step 13.

### What frustrates them

- A contract that does not say what should happen in the boundary case, so a bug and a
  difference of opinion are indistinguishable.
- Non-deterministic behaviour. A tied sort with no unique tiebreaker is the exact example: the
  test fails one run in twenty and gets dismissed as flaky ([D-012](docs/DECISIONS.md#d-012)).
- Error messages that do not say which field.
- Test data too thin to exercise a filter. Twenty products across five vendors, ten types, twelve
  tags, and three statuses exists precisely so every documented parameter has something to find.

### Risks they care about

A bug that only appears under concurrency. A contract that is right and an implementation that is
not. Regressions with no test to catch them.

### Questions they ask

_"What does an empty result return — 200 or 404?"_ (200 with `"data": []`.) _"Is the order stable
between calls?"_ (Yes — every sort appends `id`.) _"What happens if I send both?"_ _"Is this
documented, or did it just happen?"_

### Evidence they need

A named `error.code` to assert on, not a message string. Deterministic ordering. Seed data that
is the same on every machine (this project's seed ids derive from a SHA-256 of the product
handle, precisely so a test can reference a known record).

### How Postman helps

This is the persona Postman fits best. Negative-case collections. Folder runs. `pm.test()`
assertions on status, schema, and business rules. Chained workflows that reproduce a real
sequence. Then the same collection in CI via the Postman CLI, giving regression coverage that a
non-developer can extend.

---

## 4. Platform / infrastructure engineer — _Active now_

### What they are trying to accomplish

Make it run reliably somewhere that is not a laptop, and be able to tell whether it is running.

### Which APIs they touch

`/health` and `/ready`, almost exclusively.

### Artifacts they use

`Dockerfile`, `.env.example`, `docs/UNRAID_DEPLOYMENT.md`, `docs/POSTGRES_SETUP.md`, the log
output, the migration CLI.

### Where they enter the lifecycle

Deployment and observability — steps 15–17. They should also be consulted at step 4 when a change
adds a dependency or a new environment variable, and usually are not.

### What frustrates them

- An application that writes to disk, so an image update needs volume archaeology. (This one
  writes nothing: all state is in PostgreSQL.)
- A liveness probe that fails when a dependency is down, causing a restart storm during an
  outage. **This is the big one** — see [D-016](docs/DECISIONS.md#d-016).
- Configuration that fails at the first request instead of at startup, so a bad deploy looks
  healthy.
- A process that ignores `SIGTERM`, so every restart severs live requests.
- Undocumented environment variables.
- Migrations running automatically on boot, so two replicas race.

### Risks they care about

Restart loops. Connection-pool exhaustion (`DB_POOL_MAX` is per container, and PostgreSQL's
`max_connections` is shared with everything else on the box). Data loss on update. Credentials in
an image.

### Questions they ask

_"What does it need to start?"_ _"How do I know it is healthy versus ready?"_ _"How many
PostgreSQL connections will it open?"_ _"Does an update lose data?"_ _"How do I roll back?"_

### Evidence they need

`/ready` returning 503 with the **specific** failing check. A non-zero exit code on bad config
(78, `EX_CONFIG`). A measured graceful-shutdown time (168 ms). `/health` reporting `version`, so
"did the update take effect?" is answerable.

### How Postman helps

A saved post-deployment check: the same collection, a different environment. That is exactly what
environments are for, and it beats a shell script somebody has to maintain.

**Where it does not help:** logs, container inspection, and connection counts are not Postman's
job.

---

## 5. DevOps / release engineer — _Arrives properly in Milestone 5_

### What they are trying to accomplish

Make merging safe and deploying boring.

### Artifacts they use

The GitHub Actions workflow (Milestone 5), `npm run verify`, the container build, the migration
CLI.

### What frustrates them

- A test suite that needs a hand-configured database, so it cannot run in CI.
- Non-deterministic tests, which train everyone to ignore red.
- A build that passes CI and fails on deploy — usually because CI ran on a different Node major.
  Hence the identical pin in `engines`, the `Dockerfile`, and CI.
- Migrations that cannot run unattended.

### Evidence they need

A single command that runs everything (`npm run verify`). A test suite that works with no `.env`,
no cached modules, and an empty database — which is why integration tests migrate from empty
every run rather than truncating.

### How Postman helps

Milestone 5: the exported collection runs in CI via the Postman CLI, giving a
post-deployment smoke test that a non-developer can read and extend.

---

## 6. Engineering manager — _Active now, lightly_

### What they are trying to accomplish

Know whether the work is on track and where the risk is, without reading the diff.

### Artifacts they use

`docs/MILESTONE_1_PLAN.md`, `docs/BUILD_VERIFICATION.md`, `docs/DECISIONS.md`, the README's
milestone table.

### What frustrates them

- "Nearly done" repeated for three weeks.
- Not knowing which decisions are load-bearing, so every question becomes a deep dive.
- Discovering a breaking change at deployment.
- Work that cannot be verified, so "done" is an opinion.

### Evidence they need

A milestone status that distinguishes _built_, _verified_, and _verified where_. A list of what
was **not** verified — which is the section most status reports omit and the one that actually
predicts trouble.

### How Postman helps

Indirectly. A collection that runs green is a demonstrable artifact, which is a better status
report than a paragraph.

---

## 7. API platform owner / architect — _Active now_

### What they are trying to accomplish

Keep the API a coherent product rather than an accumulation of endpoints added by different
people at different times.

### Artifacts they use

`/openapi.json` as a whole. `redocly.yaml` and `.redocly.lint-ignore.yaml`.
`docs/DECISIONS.md`.

### Where they enter the lifecycle

Contract design (step 4) and review (step 13). Their leverage is entirely at those two points.

### What frustrates them

- Inconsistency: `snake_case` here and `camelCase` there, one pagination shape in one place and
  another elsewhere, three error formats.
- Duplicated schemas that drift.
- A rule turned off instead of an exception recorded. This project takes the second route: the
  three platform endpoints that legitimately return no `4xx` are listed in
  `.redocly.lint-ignore.yaml` **with reasons**, rather than the rule being disabled. A rule turned
  off is a rule nobody re-examines; an exception list is a thing a reviewer reads.
- Deliberate inconsistency indistinguishable from accidental. Hence
  [D-015](docs/DECISIONS.md#d-015) documenting _why_ platform endpoints sit outside the envelope.

### Risks they care about

Contract drift. Breaking changes shipped without a deprecation path. An API that is hard to learn
because every endpoint is slightly different.

### Questions they ask

_"Why does this endpoint differ?"_ _"Is this new schema a duplicate of an existing one?"_ _"How
would a consumer find out this changed?"_

### Evidence they need

`npm run openapi:lint` passing. `npm run openapi:check` in CI. A decision record for each
deliberate departure.

### How Postman helps

Importing the contract shows what a **new consumer** sees on day one, which is not what the
authors see — because the authors know what they meant. That gap is the most honest governance
review available.

---

## 8. Security engineer — _Active now, with a caveat_

### What they are trying to accomplish

Reduce the blast radius of the mistake that will eventually happen.

### Artifacts they use

`docs/POSTGRES_SETUP.md` (privileges), `src/observability/logger.ts` (redaction),
`docs/UNRAID_DEPLOYMENT.md` §13, the `Dockerfile` (non-root, no dev dependencies), error bodies.

### What frustrates them

- Credentials in source control, or in a Postman environment export.
- Over-privileged database roles. This project's role has no `SUPERUSER`, no `CREATEDB`, no
  `CREATEROLE` — if it leaks, the damage is bounded.
- Stack traces in error responses. `500` here exposes only `code`, a generic message, and
  `request_id`.
- Unvalidated input reaching a query. The `sort` allowlist exists partly for this reason.
- Redaction added after the first credential was already logged.
- Containers running as root.

### Risks they care about

Injection. Credential leakage. Information disclosure through errors. Log injection — which is
why an inbound `X-Request-Id` is validated against `^[A-Za-z0-9_-]{1,128}$` before it goes
anywhere near a log line.

### Questions they ask

_"What can this role do if the credential leaks?"_ _"Is anything sensitive in the logs?"_ _"What
does a 500 tell an attacker?"_ _"Is client input ever interpolated into SQL?"_

### Evidence they need

Redaction configured before credentials exist. A non-superuser role. A `500` body with no
detail. An allowlist rather than a denylist for `sort`.

**The caveat, stated plainly:** Milestone 1 has **no authentication at all**. Every endpoint,
including the writes, is open. This build must not be exposed to an untrusted network. That is
recorded in the OpenAPI description, the README, and the deployment guide — because a security
posture that is only in someone's head is not one.

### How Postman helps

Milestones 2 and 4: deliberately sending a missing credential, an invalid one, one with the
wrong scope, and one belonging to a different partner — verifying the answers are `401`, `403`,
and `404` rather than data.

---

## 9. Technical writer — _Active now_

### What they are trying to accomplish

Make the API learnable without a conversation.

### Artifacts they use

`/openapi.json` descriptions, examples, the README, `LEARNING_GUIDE.md`.

### What frustrates them

- Empty `description` fields, leaving them to reverse-engineer intent from code.
- Examples that are `"string"` and `0`.
- Behaviour that is surprising and undocumented — like `DELETE` returning `200` with a body, or
  archived products appearing in the default listing. Both are documented here **because** they
  are surprising.
- Documentation that must be rewritten every release because it was copied rather than generated.

### Evidence they need

A description on every operation, parameter, and property. `npm run openapi:lint` enforces the
first two as errors, and `tests/integration/contract.test.ts` asserts the third for the resource
schemas — so a property with no description fails the build.

### Questions they ask

_"What is this field for?"_ — not "what type is it", which the schema already says. _"When would
someone use this?"_ _"What is the most common mistake?"_

### How Postman helps

Published documentation from a collection, with examples they can curate. And using the API
themselves, which is the fastest way to find the thing the docs do not explain.

---

## 10. Support engineer — _Active now_

### What they are trying to accomplish

Turn "it's broken" into either a fix or a well-formed bug report, quickly.

### Artifacts they use

`error.code` and `error.request_id`. Server logs. `/ready`. `/health` for the deployed version.

### Where they enter the lifecycle

After deployment, when something goes wrong. Their needs are set entirely by decisions made at
step 4 — which is why error design and correlation are worth arguing about early.

### What frustrates them

- An error the customer cannot describe and they cannot reproduce.
- No correlation id, so finding the request means searching logs by timestamp and hoping.
- Error messages that are not actionable.
- Not knowing which version is deployed.

### Risks they care about

Escalating something that is a customer misconfiguration. Not escalating something that is a real
bug.

### Questions they ask

_"What was the request id?"_ — the first question, and the one that determines whether the next
five minutes are productive. _"Which version is running?"_ _"Is this us or them?"_

### Evidence they need

`X-Request-Id` on **every** response, including errors, including the ones no handler produced.
`error.code` distinct enough to triage on: `MALFORMED_ID` is the caller's bug,
`DATABASE_UNAVAILABLE` is ours, `ROUTE_NOT_FOUND` is usually a wrong base URL.

### How Postman helps

Reproducing a customer's request exactly, in the customer's environment, and capturing the
`request_id` to attach to an escalation.

---

## 11. External API consumer — _Arrives in Milestone 4_

### What they are trying to accomplish

Integrate with a company they do not work for, using only public documentation.

### What frustrates them

- Documentation that assumes internal knowledge.
- No sandbox.
- Breaking changes with no notice — they cannot redeploy on your schedule, which is the whole
  reason deprecation windows exist.
- Errors that do not distinguish "your credential is wrong" from "you lack permission" from "it
  does not exist".
- Internal fields leaking into an external response, which is confusing at best and a data
  problem at worst.

### Evidence they need

A complete contract, working examples, and a stated versioning policy.

### How Postman helps

An importable OpenAPI document is often the fastest possible onboarding. A published collection
is faster still.

---

## 12. Partner integration developer — _Arrives in Milestone 4_

### What they are trying to accomplish

Build and operate a two-way integration: pull the catalog, push orders, receive webhooks.

### What frustrates them

- Scopes that are not documented, so a `403` is a guessing game.
- Webhooks with no delivery history, so "did it arrive?" is unanswerable.
- No way to replay a failed delivery.
- Signature verification documented ambiguously — which byte range, which encoding, which header.
- Not being told that delivery is at-least-once, so their consumer is not idempotent and a
  duplicate creates a duplicate order.

### Evidence they need

Delivery attempt records with status and duration. A worked signature-verification example.
Explicit delivery guarantees.

### How Postman helps

Comparing two partner credential sets with different scopes, side by side, to see isolation
working. Verifying an HMAC signature in a test script against a real delivered payload.

---

## Cross-cutting: what every persona needs

Five things come up in nearly every entry above. They are worth naming, because they are
cross-cutting requirements rather than features:

1. **A correlation id on every response.** Support needs it to escalate; developers need it to
   debug; platform engineers need it to trace. `X-Request-Id`.
2. **A stable, machine-readable error code.** Clients branch on it, QA asserts on it, support
   triages on it. Never the message.
3. **An accurate contract.** Frontend developers build from it, QA treats it as the oracle,
   writers document from it, architects govern with it.
4. **A distinction between liveness and readiness.** Platform engineers need it to avoid restart
   storms; everyone else needs it to answer "is it up?"
5. **Written reasons for deliberate oddities.** The difference between a decision and an accident
   is a decision record. `docs/DECISIONS.md` exists so that "why is `DELETE` a `200` with a body?"
   has an answer that is not archaeology.
