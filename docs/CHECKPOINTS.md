# Learning checkpoints

The build side of this project produces an API. This document is the other half: what you do
with it, in what order, and how you know you are done.

Revised 2026-09-14 against `docs/LEARNING_PLAN_AUDIT.md`. The audit's central finding was that
the original sequence put governance, contract validation and CI **last** — behind four
milestones of ecommerce domain modelling — when the gate is the centre of what a Strategic
Solutions Engineer is measured on. Checkpoint 2 now sits immediately after Milestone 2A instead
of at Milestone 5.

---

## How a checkpoint works

Unchanged from Milestone 1, because the separation is the point.

1. The API is **built and independently verified without Postman** — tests, `scripts/smoke.sh`,
   curl. Evidence lands in `docs/BUILD_VERIFICATION.md`.
2. Work stops.
3. **You build every Postman asset by hand.** Nothing in `postman/` is generated. Not the
   collection, not the environments, not the tests, not the scripts.
4. Tasks arrive in groups of three to five. You report results before the next group.
5. Your exported assets get reviewed — recommendations, not edits.

The reason for step 3 is worth restating: a generated collection teaches you what a generator
produces. Building one by hand teaches you what a variable scope is, why a base URL belongs in
an environment, and — most usefully — what it feels like when a request fails and you have to
work out whether the fault is yours or the API's. The API is verified first specifically so
that "the API is broken" is a hypothesis you have to rule out rather than assume. Twice now it
genuinely has been.

### Done-when conditions

Every checkpoint below ends with a condition phrased as something you can **explain**, not
something you performed. That is deliberate and it follows `docs/MILESTONE_1_PLAN.md` §14.

Performing a task proves you followed instructions. Explaining why it works — and what it does
_not_ prove — is what survives into a customer conversation where nobody hands you the steps.

---

## Sequence

| #       | Name                                | Type               | Status                                         |
| ------- | ----------------------------------- | ------------------ | ---------------------------------------------- |
| **M1A** | Foundation and Catalog API          | Build              | ✅ Built, verified, deployed                   |
| **CP1** | Collection and testing depth        | Checkpoint         | 🔨 Groups 1–4 done; 5–7 added by this revision |
| **M2A** | Auth, Locations, Inventory, Pricing | Build              | ✅ Complete                                    |
| **CP2** | **Gate**                            | Checkpoint         | ⬅ **Next**                                     |
| **M3A** | Idempotency and one state machine   | Build (compressed) | Not started                                    |
| **CP3** | Validate                            | Checkpoint         | Not started                                    |
| **M4A** | Webhooks                            | Build (reduced)    | Not started                                    |
| **CP4** | Monitor                             | Checkpoint         | Not started                                    |
| **M5A** | Versioning and deprecation          | Build (reduced)    | Not started                                    |
| **M6**  | Management Plane                    | Non-build          | Not started                                    |

Two changes from the audit's own §6 table, and the reasons:

- **CP3 moved to sit after M3A**, not after M4A. The audit's ordering put two build milestones
  back to back with no checkpoint between them, which breaks the build→verify→learn rhythm the
  whole project runs on.
- **Webhooks (M4A) pair with CP4** rather than CP3. Webhook delivery and monitoring are both
  "observe what the system actually did", and both need the deployed instance.

---

## CP1 — Collection and testing depth

**Objective.** Get fluent in the mechanics a QA lead will probe. This is your stated priority
and the thing your audience already knows, so shallow coverage here is the most expensive kind.

**Status.** Groups 1–4 are complete: workspace, collection, two environments, folder structure,
collection-level pre-request guard, request chaining, and a unique-SKU generator so the Workflow
folder is re-runnable. Groups 5–7 are added by this revision — the audit was right that three
`pm.test()` assertions on `/health` is day one, not expertise.

### Group 5 — Assertions that are worth writing

Three status checks is not a test suite. The interesting assertions are the ones that fail for
a reason you would not have guessed.

1. **Assert a response against its own published schema.** `pm.response.to.have.jsonSchema()`
   takes a JSON Schema object. You already serve one: fetch `{{base_url}}/openapi.json` in a
   pre-request script, pull `components.schemas.Product` out of it, and assert `List products`
   against it.
2. **Break the schema deliberately** — assert against `Variant` instead of `Product` — and read
   the failure. A schema assertion that has never failed is a schema assertion you cannot
   interpret.
3. **Assert a business rule, not just a shape.** On `List products?sort=title&order=asc`, assert
   the titles come back sorted. On `Archive product`, assert `archived_at` is non-null _and_
   `status` is `archived` — the two agreeing is a real invariant the database enforces.
4. **Assert something about the error contract.** In a new `Catalog / Error cases` folder, send
   `?sort=password` and assert `400`, `error.code === 'VALIDATION_ERROR'`, and that
   `error.details.fields[0].allowed` contains `created_at`.

**On that last one:** you said earlier you would rather not save broken examples. The reframe is
that a request which is _supposed_ to return 400 is not broken — it is a passing test. Green,
not red. It matters because a happy-path-only collection proves the API works when used
correctly and proves nothing about the error contract, which is equally published and equally
able to regress.

**What to inspect.** What does `jsonSchema()` report when it fails — the path, or just "invalid"?
Which of your four assertions would still pass if the API returned an empty array?

### Group 6 — The Collection Runner, properly

You have run a folder. That is the surface of it.

1. **Run the collection with iterations.** Runner → set iterations to 5. Watch `Create product`
   run five times. Look at what happened to your `product_id` collection variable — and work out
   why the fifth iteration's `Archive product` did not archive the first iteration's product.
2. **Add a delay** and watch the run slow down. Then ask yourself what a delay is hiding if a
   test only passes with one.
3. **Persist variables after the run** and observe that the runner can leave state behind.
4. **Export the run results** as JSON. Open the file. That structure is what a CI reporter
   consumes, which is the whole of CP2's second half.

### Group 7 — Data-driven runs

The single biggest coverage multiplier in Postman, and absent from the original plan.

1. **Build a data file.** A CSV with columns `sku`, `expected_status`, `description`. Include
   seeded SKUs, a SKU that does not exist, and a malformed one.
2. **Reference it from a request** with `{{sku}}` in the URL and `pm.iterationData.get('sku')`
   in a script.
3. **Assert against the expected value from the row**, not a hard-coded one:
   `pm.response.to.have.status(Number(pm.iterationData.get('expected_status')))`.
4. **Run it.** One request, N scenarios, one report.

**Why this matters beyond convenience.** A QA lead's question is never "can you write a test",
it is "how do you get from forty tests to four thousand without forty thousand lines". This is
the answer, and `pm.iterationData` is the mechanism. Your seeded catalog — 20 products, 49
variants, 45 stock levels — is a ready-made data file.

### Done when you can explain

- Why a request with no assertions can never fail a collection run, and what that means for a
  green CI result.
- What `pm.response.to.have.jsonSchema()` proves that `to.have.status(200)` does not — and what
  it still does not prove.
- Why a data-driven run with 200 rows is a different thing from 200 saved requests, in
  maintenance terms and not just in effort.
- What the Runner's exported JSON is _for_.

### What CP1 does not prove

Nothing here runs anywhere but your machine, on demand, when you remember. Every assertion you
have written can be skipped by not clicking Run. That gap is exactly what CP2 closes.

---

## CP2 — Gate ⭐

**Objective.** Turn a collection you run into a gate that runs itself and blocks a merge. This
is the centre of the Design → **Gate** → Validate → Monitor → Improve motion, and per your own
ramp plan contract testing is your largest single gap.

Split into **tier A** (works on any plan — do this regardless) and **tier B** (Enterprise-gated
— confirm first, and do not plan around it).

### Task 0 — the prerequisite nobody flagged

**Your collection cannot run in CI today, and this will stop you dead at task 3.**

The auth helper reads the seeded password from **Postman Local Vault** via `pm.vault.get()`.
Local Vault secrets are, by design, never synced anywhere — which is what makes them the right
home for a credential, and which is also why **the Postman CLI cannot read them**. Local Vault
supports manual runs and collection runs; Shared Vault supports the CLI, monitors, and scheduled
runs.

Three ways out, and choosing between them is the actual lesson:

| Option                                                                                              | Works in CI | Cost                                                                |
| --------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| **Shared Vault**                                                                                    | Yes         | Team feature; the secret now lives in Postman cloud                 |
| **Inject at run time** — `postman collection run --env-var "password=$SECRET"` from a GitHub secret | Yes         | The credential lives in GitHub, not Postman. Two places to rotate   |
| Hard-code it in the environment                                                                     | Yes         | Never. It reaches the repository and `git rm` does not unpublish it |

For a seeded fixture password the stakes are low, which makes it a good place to practise the
decision. For a real credential the second option is usually right: the secret lives in the
place that already manages secrets for that pipeline.

### Tier A — any plan

**1. Spec Hub.** Put `openapi/openapi.json` into Spec Hub. Generate a collection from it —
separately from your hand-built one, so you can compare. Change the spec, watch the sync, and
read the **Issues** tab.

The comparison is the point. What does the generated collection give you that yours does not
(coverage, descriptions, examples)? What does yours have that no generator could produce
(variable choices, chaining, the assertions in group 5)? That gap is the honest answer to
"can't AI just generate my tests".

**2. Postman CLI in CI.** Add a job to the existing `.github/workflows/release.yml` — you do not
need a second pipeline — that runs the collection with the Postman CLI and fails the build on a
non-zero exit code. Emit **JUnit**, then try JSON and HTML and look at what each is for.

Exit codes are the mechanism. A test report nobody reads is documentation; a non-zero exit code
is a gate.

**3. Ship a deliberate breaking change.** Rename a response property or add a required request
field, on a branch. Watch the gate block the merge. **This is the demo you will give**, so run
it until you can narrate it without looking.

**4. Make a test flaky on purpose.** Add a timing-dependent assertion. Run it five times. Notice
your own impulse to re-run rather than fix.

That impulse is the whole diagnosis. A gate that gets re-run until it passes is not a gate, and
Gate Coverage × Flake Rate is the second of the five metrics you are expected to name. Being
able to say "your gate is muted" in one sentence in discovery is worth more than the mechanics.

**5. Git-connected workspace.** You already have `.postman/resources.yaml` and the sync working.
Understand what it is doing: the repo as the versioned source of truth rather than a manual
export, and what happens when the two diverge.

### Tier B — Enterprise only

> **Confirm before planning around this.** Postman → **Team Settings → Plan**. API Governance,
> configurable and custom rules, and API Catalog are Enterprise features. Your team
> `justin-v12` shows Enterprise-grade limits, but limits are not the same as plan entitlement
> and this has not been verified in-app. If the answer is no, tier A stands entirely on its own
> and is the majority of the value.

**6. Rebuild a Redocly rule as a Postman governance rule.** You already have real governance —
`redocly.yaml` enforces `operation-operationId`, `parameter-description`, `operation-4xx-response`
and more, and `.redocly.lint-ignore.yaml` records three reviewed exceptions rather than
switching the rule off. That is structurally the same idea. But a customer will never ask about
Redocly. Configure the equivalent under **API Catalog → Governance Groups**, applied to your spec
in Spec Hub.

Keep Redocly as the "what a lint rule is" teacher. Rebuild one rule in Postman as the "what the
customer buys" version.

**7. `postman spec lint` with reporting.** Verified against current docs:

```bash
postman spec lint openapi/openapi.json --workspace-id <id>
postman spec lint <spec-id> --report-events        # on by default
postman spec lint openapi.yaml --fail-severity WARNING --output JSON
```

Results appear in **API Catalog → your service → Test tab → CI Pipeline Runs → View report**.
Reporting requires that the spec exists in Postman — linting a standalone local file that is not
synced will not report.

**Vocabulary trap:** `postman api lint` is the **v11 API Builder** command and is not supported
in v12+. Use `postman spec lint`. Getting this wrong in front of a platform team is an avoidable
tell.

**8. API Catalog.** Register the service. Look at the Service Health Scorecard — test pass rates,
spec compliance and gateway metrics aggregated in one place. This is the Management Plane, and
it is the half of Postman this project has taught you nothing about so far.

### Done when you can explain

- Why a gate that can be re-run until it passes is not a gate, and what you would look at first
  to find out whether a customer's gate is muted.
- What the Postman CLI puts somewhere a platform team can see that Newman does not — and why
  that difference, not a verdict about which is better, is the defensible answer.
- Which half of API governance is Enterprise-gated, and why that boundary is a differentiator
  rather than an inconvenience. **You can answer this from the docs whether or not tier B turns
  out to be enabled for you** — and if it is not, being able to say precisely what you would see
  is the deliverable.
- The difference between a spec that is valid and a spec that is good, and which tool catches
  which.

### What CP2 does not prove

A gate proves a change did not break what you thought to assert. It says nothing about what you
did not think of, nothing about behaviour under load, and nothing about whether the API is
useful. It also proves nothing about production: everything here runs against a build, not
against the deployed instance. That is CP4.

---

## CP3 — Validate

**Objective.** Reuse and simulation. Runs after M3A, so there is an idempotent endpoint and a
state machine to build a real workflow against.

### Task groups

**1. Package Library.** Publish one reusable module — an auth helper or a standard
schema-and-error assertion — and consume it from more than one collection.

Do this even though your collection is small, because **Package Adoption Rate is the first of
the five metrics you are expected to name**, and you cannot talk credibly about a metric whose
mechanism you have never used.

**2. Mock servers, both kinds.** The distinction matters and the old framing is stale:

|                    | Example-based mock          | Code-based local mock                                  |
| ------------------ | --------------------------- | ------------------------------------------------------ |
| Responses          | Static, from saved examples | Dynamic — any JavaScript                               |
| Runs               | Postman cloud, always on    | Locally, or deployed                                   |
| State              | None                        | Yes, via `pm.state` (beta)                             |
| CI                 | Via a collection run        | `postman mock run`, as a dependency of your test suite |
| Failure simulation | No                          | Scenarios: latency, errors, rate limits, chaos mode    |

Build the example-based one from your OpenAPI examples. Then build a code-based local mock that
does something the static one structurally cannot — return a different response on the second
call, or inject a 503 — and run your collection against it with `postman collection run --mock`.

**3. `pm.execution.setNextRequest()`.** Branch inside a run: if inventory is insufficient, skip
the order and jump to the cleanup request. This is how a collection stops being a straight line.

**4. The end-to-end chain.** Authenticate → find a product → check inventory → reserve → price it
→ place the order → release on failure. Every step feeding the next from a captured variable.

### Done when you can explain

- What a mock proves and what it structurally cannot — and why "mocks are stateless and cannot
  surprise you" stopped being true in 2026.
- Why publishing a package once beats copying an auth check into forty collections, in terms a
  platform lead cares about rather than a developer.
- When branching in a run is the right answer and when it means your collection is doing a job
  that belongs in the API.

---

## CP4 — Monitor

**Prerequisite: the Unraid deployment, live and reachable.** A monitor against `127.0.0.1` is
meaningless. This is the checkpoint the deployment exists for.

**1. A cloud monitor** against the deployed instance. Schedule it, break the API deliberately,
watch it catch that.

**2. Monitor Runners.** Your Unraid box is behind home NAT and unreachable from Postman's cloud.
That is the same shape as the named gap in your ramp plan — _"our APIs are internal, behind the
firewall, on EKS"_ — and Monitor Runners exist precisely for it.

You will have the real problem on your own hardware rather than a described one. Reasoning
toward that answer in an interview is not the same as having hit it.

**3. Alert routing** to Slack, Jira or PagerDuty. An alert nobody receives is a log line.

**4. Synthetic coverage.** Which of your endpoints does a monitor actually cover, and which
failures would it never see?

**Performance testing is concept-only.** Your team has `perf_test_milli_vuh` at 0, so cloud
performance runs are unavailable. Know the four profiles — Fixed, Ramp, Spike, Peak VU — and
what each is for; there is no task here to perform, and a checkpoint containing an unperformable
task is worse than an honest gap. See `LEARNING_GUIDE.md`.

### Done when you can explain

- Why a monitor against localhost is meaningless, and exactly what Monitor Runners solve that a
  cloud monitor cannot.
- The difference between a monitor and a gate — same collection, different question.
- Which of the four performance profiles you would reach for to answer "will Black Friday break
  us", and why the other three answer different questions.

---

## M6 — Management Plane (non-build)

Reading and access, not building. A local project cannot teach these, and no amount of milestone
work will change that.

- **API Catalog vs Private API Network.** Producers versus consumers. Named as the primary field
  confusion; five minutes to learn and high embarrassment cost to get wrong.
- **Service accounts** and their specific failure modes: personal PMAKs return 401 at token
  minting; an org-level Admin role still 403s at workspace create without a sub-team role;
  Workspace Management Settings allowlists override roles independently.
- **The three-plane model**, the five FY27 motions, and the reframe verbatim.
- **The five metrics** — Package Adoption, Gate × Flake, DER, MTTD, CFR — and what "broken" looks
  like for each.
- **SSO / SCIM / Domain Capture / RBAC / audit logs / Secret Scanner / Vault / BYOK**, and the
  Enterprise versus ASA commercial line.
- **What not to say:** "Postman is a better Insomnia", "Postman is where you test APIs".

### Done when you can explain

- The difference between API Catalog and Private API Network without hedging.
- Why a service account is a security control and not a convenience.
- Each of the five metrics, and one concrete symptom of each being broken.
