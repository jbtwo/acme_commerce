# Learning plan audit — Strategic SE readiness

Date: 2026-09-14
Auditor: MARVIN
Subject: `LEARNING_GUIDE.md`, the milestone table in `README.md` §18, `docs/MILESTONE_1_PLAN.md`,
`docs/MILESTONE_2_PLAN.md`

**Scope call.** This audits the **acme_commerce** learning plan. `~/Documents/marvin/state/learning-plan.md`
(the SE technical ramp) is used as an _input_ — it carries an assessed gap list for this specific
learner — not as the audit target. Say so if you wanted the other one.

---

## 1. The criterion this is audited against

The stated purpose of the repo is that you build Postman collections by hand in order to **learn
the features and be able to speak to them as a Strategic SE**. So the question is not "is this a
good API-engineering curriculum." By that standard it is excellent — genuinely better than most
paid courses, and §6 (testing levels) and §7 (variable scopes / local-vs-shared) are things most
SEs never get straight.

The question is narrower and harsher:

> Does this substrate and this sequence exercise the **Postman product surface** a Strategic SE
> has to demonstrate and defend in front of a buyer?

Against that criterion the plan has one large structural problem, a short cut-list, and a
specific set of gaps.

### Sources used to define "the required surface"

| Source                                           | What it contributes                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-08-12-API-Catalog-SDLC-Automation-CotM.md` | The active play. §7 Design→Gate→Validate→Monitor→Improve, the five metrics, eight test types, §8 Enterprise-only differentiators                                                            |
| `FY27-Platform-Motion.md`                        | Three-plane model, five GTM motions, Q2 capabilities, the reframe                                                                                                                           |
| `POSTMAN_CONTEXT.md`                             | Capability inventory, five buyer personas with proof points and demo ordering, ASA commercial line                                                                                          |
| `.claude/skills/peas/SKILL.md`                   | The actual mechanics of the SDLC automation motion (service accounts, bootstrap + repo-sync, Catalog placement)                                                                             |
| Web research, 2026-09-14                         | Post-May-2026 shipping: Service Health Scorecards (Jul 2), code-based local mocks, Autonomous API Engineer (Jun 8), Wiz + gateway ingestion, Postman CLI v1.54–1.56, 12.27.1 static-IP perf |

---

## 2. Headline findings

**F1 — The plan is back-loaded against exactly the thing you are being measured on.**
Governance, contract validation, versioning and CI all sit in **Milestone 5**, the last build
milestone. You are currently at the **Milestone 1 checkpoint**. The SDLC automation play _is_
Design→**Gate**→Validate→Monitor→Improve, and your own ramp plan stars contract testing as
"your biggest single gap. Do not skip or rush this one." Under the current sequence you reach it
after building auth, inventory, pricing, customers, orders, fulfillment, partner APIs and
webhooks. That is four milestones of e-commerce domain modelling standing between you and the
one subject that matters most. **This is the single change worth making.**

**F2 — The Postman surface exercised is the Activity Plane almost exclusively.**
Requests, environments, variables, `pm.test()`, mocks. That is the plane that FY27 guidance
explicitly says _opens_ conversations but does not close Enterprise deals — and the doc tells you
not to describe Postman as "where you test APIs." The Management Plane (API Catalog, governance
rules, scorecards, service accounts, Git-connected workspaces) appears **zero times** across every
markdown file in the repo. Verified by grep: `API Catalog` 0, `SpecHub`/`Spec Hub` 0, `Agent Mode`
0, `Postbot` 0, `Collection Runner` 0, `service account` 0, `Private API Network` 0, `scorecard` 0,
`SCIM`/`RBAC` 0. `Postman CLI` appears 7 times, all as passing asides, never as an exercise.

**F3 — "Governance" in this repo means Redocly, not Postman.**
`redocly.yaml` and `npm run openapi:lint` are real governance — structurally the same idea — but a
customer will not ask you about Redocly. The Postman mechanism is: governance rules configured
under **API Catalog → Governance Groups**, applied to specs in **Spec Hub**, enforced by the
**Postman CLI** in the pipeline, with lint reports surfacing back into the Catalog. The rule
library ships Postman's own guidelines plus Zalando and OWASP, and supports custom rules and
custom functions. None of that is currently in the plan. This is an easy, high-value swap: keep
Redocly as the "what a lint rule is" teacher, then rebuild the same rule in Postman.

**F4 — §8 Mocking is factually stale as written.**
It says a mock "returns the examples from your collection or OpenAPI document," "has no state,"
and "agrees with the contract by construction." That describes classic static mocks. Since the
April 2026 platform release Postman also ships **code-based local mock servers** that run locally
_and inside the CI test loop_, and the Postman CLI v1.54+ syncs code mocks and simulations for
Git-based collaboration. If you say "mocks are stateless and can't surprise you" to a platform
lead in 2026, you are describing the old product. Fix the section; the _pedagogy_ of it is fine.

**F5 — This is a second build spine, and week 6 is now.**
`state/learning-plan.md` declares "one build spine" and names Graham's SDLC automation environment
— a team commitment with a ~80%-of-team demo-delivery target. acme_commerce is a second spine, and
today is the last week of that plan's sequence. acme is the better _teacher_ (you own every layer,
so failures are diagnosable); Graham's is the thing you owe the team and the thing that actually
demonstrates the Enterprise motion. Your call, but they should not both run at full weight. See §6
for a proposed split.

---

## 3. Coverage matrix

Legend: ✅ covered well · ⚠️ partial / conceptual only · ❌ absent · 🚫 unbuildable locally

### Design → Gate → Validate → Monitor → Improve

| Stage          | Postman capability (per CotM §7)                      | acme coverage                                                         | Verdict                          |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| **Design**     | Spec Hub, spec→collection sync, Issues tab            | OpenAPI is generated and contract-tested, but never lands in Spec Hub | ⚠️                               |
|                | Agent Mode / Postbot generation                       | absent                                                                | ❌                               |
|                | Package Library (shared auth/schema/error modules)    | absent                                                                | ❌                               |
|                | AI migration from ReadyAPI/SoapUI/Karate              | absent, and unbuildable here                                          | 🚫                               |
| **Gate**       | Postman CLI in CI as pre-merge gate                   | M5, passing mention only                                              | ⚠️                               |
|                | Governance rules (Spectral) enforced org-wide         | Redocly only                                                          | ⚠️ F3                            |
|                | Contract tests                                        | Excellent — but as **vitest**, not as Postman contract tests          | ⚠️                               |
|                | Flake, and what a muted gate looks like               | absent                                                                | ❌                               |
| **Validate**   | Collection Runner                                     | absent                                                                | ❌                               |
|                | Data-driven runs (CSV/JSON)                           | absent                                                                | ❌                               |
|                | Performance (Fixed/Ramp/Spike/Peak VU)                | absent                                                                | ❌                               |
|                | Mock servers                                          | conceptual, M5, and stale                                             | ⚠️ F4                            |
|                | Multi-protocol (gRPC, GraphQL, WebSocket, Kafka/MQTT) | REST only by construction                                             | ❌                               |
| **Monitor**    | Monitors                                              | one passing mention                                                   | ❌                               |
|                | **Monitor Runners** (internal APIs behind firewall)   | absent                                                                | ❌ — named gap in your ramp plan |
|                | Alert routing (Slack/Jira/PagerDuty)                  | absent                                                                | ❌                               |
| **Improve**    | Test/perf reports, JUnit/HTML reporters               | absent                                                                | ❌                               |
|                | API Catalog Service Health Scorecards                 | absent                                                                | ❌ 🚫                            |
|                | Postman Insights                                      | absent                                                                | 🚫                               |
|                | Autonomous API Engineer                               | absent                                                                | 🚫                               |
| **Foundation** | Git-connected workspaces                              | `.postman/resources.yaml` exists; never taught                        | ⚠️                               |
|                | Service accounts (Enterprise-only, CI identity)       | absent                                                                | ❌ 🚫                            |

### Eight test types (CotM §7)

| Type                 | acme                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| Functional           | ✅ planned at checkpoint 1                                            |
| Contract             | ⚠️ taught as a concept and as vitest; not as a Postman contract suite |
| Integration          | ✅ conceptually strong (§6)                                           |
| End-to-end           | ⚠️ workflow chaining lands M3                                         |
| Regression           | ⚠️ implied, never named as a Postman motion                           |
| Performance          | ❌                                                                    |
| Security             | ❌ (auth arrives M2, but not security _testing_)                      |
| Synthetic monitoring | ❌                                                                    |

### Management Plane / commercial knowledge

| Item                                                                 | acme  | Note                                                   |
| -------------------------------------------------------------------- | ----- | ------------------------------------------------------ |
| API Catalog vs Private API Network (the #1 field confusion, CotM §1) | ❌    | Pure knowledge. No build teaches it                    |
| Governance engine as the Enterprise differentiator                   | ❌    |                                                        |
| Service accounts as the Enterprise differentiator                    | ❌    | PEAS skill has the real detail incl. the 401/403 traps |
| Three-plane model, five FY27 motions                                 | ❌    |                                                        |
| SSO / SCIM / Domain Capture / RBAC / audit logs                      | ❌ 🚫 | Your ramp plan M6 owns this                            |
| Enterprise vs ASA commercial line                                    | ❌ 🚫 |                                                        |
| Private Data Buckets, Private Runner, BYOK                           | ❌ 🚫 | Regulated-account unblockers                           |
| Five metrics (Package Adoption, Gate×Flake, DER, MTTD, CFR)          | ❌    |                                                        |

---

## 4. Cut list — what is not necessary

Nothing here is _wrong_; it is all well-built. This is about where **further** time goes.

**Explicitly kept, by the learner's decision (2026-09-14): the Unraid deployment and the
PostgreSQL setup.** The goal is a real production instance to test against. An earlier draft of
this audit listed both as cut candidates on the grounds that the ramp plan excludes
infrastructure depth. That was wrong for this case, and the reason matters:

- **A deployed instance is a hard prerequisite for CP4.** Monitors need a reachable target. You
  cannot learn Monitors, alert routing, or synthetic coverage against `127.0.0.1`.
- **An Unraid box behind home NAT is the best available substrate for the single named gap in
  `state/learning-plan.md` M4** — _"our APIs are internal, behind the firewall, on EKS."_ That is
  exactly what **Monitor Runners** exist to solve, and you will have the real problem on your own
  hardware rather than a described one. Reasoning toward that answer in an interview is not the
  same as having done it.
- **`base_url` swapping between local and deployed** is what makes `LEARNING_GUIDE.md` §7's
  environment diagnostics real instead of hypothetical.

The boundary that still holds: build it, deploy it, keep it running — but do not turn it into a
homelab project. Postgres tuning, backup/restore rehearsals, and connection-model comparisons past
the one you actually use are where the diminishing returns start.

| Cut                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dockerfile / GHCR release-pipeline depth**                   | The multi-tag `edge`/`vX.Y.Z` strategy is good engineering and near-zero SE value. The CI you need is a **Postman CLI gate job**, not a better image pipeline.                                                                                                                                                                                                                      |
| **Milestone 3 (Customers, Orders, Fulfillment) at full scope** | Idempotency and state machines are worth one endpoint each. A full order/fulfillment domain is weeks of modelling that teaches commerce, not Postman. Compress hard.                                                                                                                                                                                                                |
| **Milestone 4 Partner API + webhooks at full scope**           | Keep webhooks — Postman shipped first-class webhook support in May 2026 and it is a real demo asset. Cut the partner API-key/isolation domain work; Partner Workspaces is the SE-relevant concept and it is a product feature, not something you build.                                                                                                                             |
| **PERSONAS.md — 12 engineering personas**                      | Genuinely good writing, but it is an _engineering_ persona set. The five you are assessed on are Platform Eng/DevEx/API CoE, Security/IT, QA lead, Product Eng/EM, and Partner/API product owner — each with proof points and a demo order, in `POSTMAN_CONTEXT.md` §"Buyer Personas". Don't expand PERSONAS.md; add a short mapping table from its 12 to those 5, and learn the 5. |

---

## 5. Gap list — what is missing, and where to put it

### 5a. Base API testing — your explicit priority

You said you need to be expert here because it is what your audience already knows. The plan's
_conceptual_ coverage of testing (§6) is the strongest section in the document. The **hands-on
Postman** coverage is thin. Checkpoint 1 as written asks for three `pm.test()` assertions on
`/health`. That is day one, not expertise.

What a QA lead will actually probe, and where acme stands:

| Capability                                                                          | Status                                                   | Where to add                                                            |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pm.test()` + chai assertion styles (`to.have.status`, `to.be.json`, deep equality) | ⚠️ three examples                                        | Checkpoint 1 — expand                                                   |
| `pm.response.to.have.jsonSchema()` — schema assertion from the OpenAPI schema       | ❌                                                       | Checkpoint 1. You already serve `/openapi.json`; assert against it      |
| Pre-request vs post-response scripts, and execution order                           | ❌                                                       | Checkpoint 1                                                            |
| Variable chaining (`pm.collectionVariables.set` from a response)                    | ⚠️ the _scope rule_ is taught in §7; the mechanic is not | Checkpoint 2                                                            |
| `pm.sendRequest` for setup/teardown                                                 | ❌                                                       | Checkpoint 2 (fetch a token in a pre-request script)                    |
| Collection Runner — iterations, delay, persisting variables                         | ❌                                                       | Checkpoint 1                                                            |
| **Data-driven runs from CSV/JSON** (`pm.iterationData`)                             | ❌                                                       | Checkpoint 1. Your 20 products / 49 variants are a ready-made data file |
| `pm.execution.setNextRequest()` — branching in a run                                | ❌                                                       | Checkpoint 3                                                            |
| Folder-level and collection-level scripts, and inheritance                          | ❌                                                       | Checkpoint 2                                                            |
| Collection-level auth + inheritance vs per-request override                         | ❌                                                       | Checkpoint 2 — this is the natural M2 payoff                            |
| **Postman CLI vs Newman** — which one, and why Newman is legacy                     | ❌                                                       | Move to Checkpoint 2. Newman is named once, in a stack-choice aside     |
| CLI reporters: CLI / JSON / **JUnit** / HTML, and results syncing back to the app   | ❌                                                       | Checkpoint 2                                                            |
| Exit codes as the pipeline gate                                                     | ❌                                                       | Checkpoint 2                                                            |
| Performance testing — Fixed / Ramp / Spike / Peak VU profiles                       | ❌                                                       | Checkpoint 4                                                            |
| Monitors + **Monitor Runners behind a firewall**                                    | ❌                                                       | Checkpoint 4                                                            |
| Package Library — publish an auth/schema check once, consume everywhere             | ❌                                                       | Checkpoint 3                                                            |

The last one deserves emphasis. **Package Adoption Rate is the first of the five metrics you are
expected to name.** You cannot talk credibly about it without having published a package.

### 5b. The gate — move it forward

Insert a new **Checkpoint 2: Gate** immediately after the current one, before Milestone 3 domain
work. Split by plan tier, because half of this is Enterprise-gated and you should know which half
before you hit a wall and blame your setup.

**Your access (verified 2026-09-14):** you are **admin + billing on your own team `justin-v12`**
(team id 32777836). Limits read Enterprise-grade — unlimited internal specifications, reusable
packages, collection runs, mock usage, custom domains; 10,000 monitor request runs; Postman
Insights enabled. Two caveats: **`perf_test_milli_vuh` is 0**, so cloud performance testing is
not available to you without VU hours, and Enterprise governance/Catalog access should be
confirmed in-app before you plan around it (see the tier-B note).

**Tier A — runs on any plan, do this now:**

1. Put `openapi/openapi.json` into **Spec Hub**. Generate a collection from it. Change the spec,
   watch the sync, read the **Issues** tab.
2. Wire the **Postman CLI** into `.github/workflows/` (there is an official Postman CLI GitHub
   Action) as a job that runs the collection and fails the build on a non-zero exit code. Emit
   **JUnit**; also try the JSON and HTML reporters.
3. **Ship a deliberate breaking change** — rename a response property, add a required request
   field — and watch the gate block the merge. This is the demo you will give.
4. **Make a test flaky on purpose.** Add a timing-dependent assertion. Run it five times. Notice
   the impulse to re-run rather than fix. That impulse _is_ the muted-gate diagnosis you need to
   name in one sentence in discovery — and Gate Coverage × Flake Rate is metric #2 of the five.
5. Connect the repo as a **Git-connected workspace** so `postman/` is the versioned source of
   truth rather than a manual export.

**Tier B — Enterprise only (confirmed in Postman Docs):**

6. **API Governance** and **configurable/custom rules** are Enterprise-plan features. Rules are
   configured under **API Catalog → Governance Groups** and applied to specs in **Spec Hub**.
   Rebuild one of your Redocly rules as a Postman custom rule.
7. Run `postman spec lint` against the spec, with **`--report-events`** so violations and
   conformance upload to Postman and appear in the **API Catalog** under Integrated services →
   your service → Test tab → CI Pipeline Runs. That loop — CLI lints, Catalog shows it — is the
   thing you demo.
   **Vocabulary trap:** `postman api lint` is the _v11 API Builder_ command and is **not**
   supported in v12+. Use `postman spec lint`. Getting this wrong in front of a platform team is
   an avoidable tell.
8. **API Catalog** itself (Enterprise only) — register the service, look at the Service Health
   Scorecard, see test pass rates + spec compliance + gateway metrics aggregate.

If tier B turns out not to be enabled on `justin-v12`, that is the access ask in §5c — not a
reason to skip tier A, which is the majority of the value and closes the starred gap.

Tier A is roughly a week.

### 5c. Unbuildable-but-required — needs a non-build path

A local project on your laptop cannot teach these, and no amount of milestone work will fix that.
They need a different vehicle: the SE demo org, a sandbox, or reading.

- **API Catalog** — registering a service, health scorecards, gateway/repo/Wiz ingestion.
  Enterprise-only, which is exactly why it is a differentiator.
- **Service accounts** — and the specific failure modes. `.claude/skills/peas/SKILL.md` documents
  these in painful detail: personal PMAKs 401 at token minting; an org-level Admin role still 403s
  at workspace create without a sub-team role; Workspace Management Settings allowlists override
  roles. That knowledge is worth more in a POV than another endpoint.
- **SSO / SCIM / Domain Capture / RBAC / audit logs / Secret Scanner / Vault / BYOK**, and the
  **Enterprise vs ASA** commercial line. Your ramp plan M6 owns this; keep it there.
- **Private Data Buckets, Private Runner** — the regulated-account unblockers.
- **API Catalog vs Private API Network.** CotM §1 calls this the primary field confusion. Producers
  vs consumers. Pure vocabulary, five minutes, high embarrassment cost if you get it wrong.

**Recommendation: `/peas` against `openapi/openapi.json` — but treat it as an access request
first, not an action.** PEAS takes the spec you already have and produces a workspace, contract
collections, a mock, a monitor, a CI workflow and a Catalog entry. It is the SDLC automation
motion end to end using _your_ API, which means you can narrate every layer — the whole reason
you built acme. But it has four **gating** prerequisites, and the run 403s on its first step
without them:

1. A **service account** on the target team plus its PMAK. Personal PMAKs return **401** at token
   minting — not a warning, a hard stop.
2. That SA granted **Team Manager or Admin on the specific sub-team**. An org-level Admin role
   alone still 403s at workspace create.
3. Confirmation that **Workspace Management Settings** does not block workspace creation for that
   SA. This allowlist is independent of role — granting a role does not clear it. Workaround: an
   admin pre-creates the workspace in the UI and you point bootstrap at the `workspace-id`.
4. A **Catalog-admin key** for the system-environment association, or an admin to run that one
   call. The SA can read system environments but cannot write associations.

**Which team to run it on:**

- **`justin-v12` (yours — you are admin + billing)** — the "team you don't administer" problem in
  the PEAS skill does _not_ apply. You can self-provision items 1–3. Try here first; confirm the
  team is on Enterprise, since PEAS targets the Catalog.
- **SE demo org** — all four items are admin-gated. Take the list above to the team admin as a
  request; do not plan around self-serving it.
- **`sandbox.postman.com`** — available, but your ramp plan carries Bryan's caveat that sandboxes
  are _"not identical to production teams — don't demo Enterprise-only behaviour from one."_ PEAS
  is entirely Enterprise-only behaviour. Use a sandbox to learn the mechanics, never to demo.

### 5d. Knowledge that has no build at all

Blocked out as reading, not building: three-plane model · five FY27 motions · the reframe verbatim
("system of record for your API estate — the control plane that connects design, test, govern, and
distribute") · the velocity paradox · the five why-now forces · the five metrics and what "broken"
looks like for each · three operating models and who owns the gate in each · what NOT to say
("Postman is a better Insomnia", "where you test APIs").

---

### 5e. Newman vs Postman CLI — get this right, don't overclaim

Worth its own note because it is a question you will be asked and the lazy answer is wrong.

**Newman is not deprecated.** Postman still ships a full Newman doc tree — install, command
reference, file uploads, built-in and custom reporters, Docker, CI, Jenkins, Travis — alongside a
"Migrate to the Postman CLI" page. Plenty of QA leads run it in Jenkins today. If you tell one it
is legacy, you have just told them their pipeline is wrong and you will spend the rest of the call
on defence.

The defensible answer is the difference, not a verdict:

|                           | Newman                         | Postman CLI                                               |
| ------------------------- | ------------------------------ | --------------------------------------------------------- |
| Source                    | Open source (Apache-2.0), npm  | Closed source, official, single binary + install script   |
| Account                   | None required                  | Requires Postman API key / `postman login`                |
| Collection source         | Local JSON files               | Pull from Postman cloud by ID, or local file              |
| Run results               | Terminal + reporter files only | **Sync back to the Postman app and API Catalog**          |
| Spec linting / governance | No                             | **`postman spec lint` against Spec Hub governance rules** |
| CI identity               | Personal or file-based         | **Service accounts** (Enterprise)                         |

The SE framing: _"Newman runs the collection. The Postman CLI runs the collection and puts the
result somewhere your platform team can see it — which is the difference between a test and a
gate with evidence."_ That connects directly to Audit Evidence Completeness, one of the three
executive outcomes in CotM §7.

---

## 6. Recommended revision

### Milestone table

**Ordering note.** CP2 (Gate) goes **after M2A, not before it.** A gate on an unauthenticated API
cannot teach collection-level auth inheritance or service-account CI identity, and both are on the
required list. So: CP1 → M2A → CP2. This still pulls governance and CI forward by three
milestones, which is the point of F1.

| Was | Becomes | Change |
|---|---|---|
| CP1 — first collection | **CP1 — Collection + testing depth** | Expand: schema assertions, Runner, CSV data-driven, scripts. Your stated priority |
| M2A — Auth, Locations, Inventory, Pricing | M2A, unchanged | Good as planned. Collection-level auth is the Postman payoff, and CP2 depends on it |
| — | **CP2 — Gate** ⭐ NEW | Spec Hub, governance rules, Postman CLI in CI, breaking change, deliberate flake, Git-connected workspace. **Insert here, not at M5** |
| M3A — Customers, Orders, Fulfillment | **Compressed** | One idempotent endpoint + one state machine. Skip the domain |
| M4A — Partner API, Webhooks | **Webhooks only** | Cut partner API-key isolation |
| — | **CP3 — Validate** NEW | Package Library, mock servers (incl. code-based local mocks), `setNextRequest`, e2e chain |
| — | **CP4 — Monitor** NEW | **Prereq: the Unraid deployment, live.** Monitors, **Monitor Runners** against the box behind your home firewall, alert routing. Performance profiles are conceptual only — `perf_test_milli_vuh` is 0 |
| M5A — Contract validation, governance, versioning, CI | **Versioning + deprecation only** | Governance and CI moved to CP2 |
| M6 — Complete learning platform | **Management Plane, non-build** | `/peas` + API Catalog + ASA reading. Plan-gated — see §5b tier B |

### Two-spine split (F5)

- **acme_commerce** = the depth spine. You own every layer, so when a Postman request fails you can
  prove where. Irreplaceable for base API testing expertise, which is your stated priority.
- **Graham's SDLC environment / PEAS** = the demo spine. Enterprise surface, team commitment,
  what you actually present.

Keep both, but weight the next two weeks toward **CP2 + `/peas`**. Those two together close the
contract-testing gap, put the Management Plane in your hands, and discharge the team obligation.
Milestones 3 and 4 can wait.

**Name the tradeoff, because this is a choice and not a free one.** `state/learning-plan.md` puts
week 6 (Sep 14–18 — this week) on **M6 identity/security + M7 discovery**, with the **mock demo**
due. Spending it on CP2 + `/peas` means M6/M7 slip by roughly a week. The argument for doing it
anyway: the mock demo is _of_ the SDLC automation motion, and right now you would be demoing a
Management Plane you have never touched. The argument against: M6 (Enterprise vs ASA routing) and
M7 (the discovery ladder) are graded milestones with other people's calendars attached, and
slipping them has a cost CP2 does not. **Your call — but make it explicitly rather than by
drift.** A middle path: tier A of CP2 only (~a week), defer tier B and `/peas` to week 7.

---

## 7. Corrections to make in `LEARNING_GUIDE.md`

1. **§8 Mocking** — add code-based local mock servers that run in the CI test loop (April 2026
   platform release). "Mocks are stateless and cannot surprise you" is no longer the whole truth. F4.
2. **§6 "Explore it in Postman"** — three assertions is not a checkpoint. Add
   `pm.response.to.have.jsonSchema()`, a Collection Runner run, and a CSV-driven run.
3. **§9 forward references** — add Spec Hub, governance rules, Postman CLI, Package Library,
   monitors and Monitor Runners. Right now a reader finishes the guide without learning that
   Postman's Management Plane exists.
4. **§7 Environments** — the local-vs-shared tension it flags ("cloud runners can only read shared
   values") has a named product answer: **Vault integration** and **service accounts**. Name them.
5. **`docs/MILESTONE_1_PLAN.md` §14** — outcome 8 says "import it into Postman, and notice where it
   lies." Extend to Spec Hub: import, sync to a collection, break the spec, read the Issues tab.

---

## 8. Verdict

As an API-engineering curriculum: excellent, and better than what you would get from a course.
Keep it.

As Strategic SE preparation: it builds deep **Activity Plane** fluency and zero **Management
Plane** fluency, and it puts the gate — the centre of the play you are being measured on — last.
Two changes fix most of it:

1. **Insert Checkpoint 2 (Gate) now**, before any more domain modelling.
2. **Run `/peas` against your own spec on `justin-v12`**, where you are admin, to reach the
   Management Plane surface a laptop cannot. Clear the four access prerequisites in §5c first.

Then expand Checkpoint 1's testing depth, because that is the part your audience will actually
test you on.
