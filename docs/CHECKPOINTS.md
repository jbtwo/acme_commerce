# Feature tours

What to do with the API, in what order, and how you know you are done.

Revised **2026-09-16**. The previous version went deep on API-engineering craft — schema
assertion subtleties, ordering stability, error-contract design. That is good engineering and
it is not what you are being assessed on. This version optimises for **breadth of the Postman
feature surface**, weighted toward the **Enterprise** features, at the shallowest depth that
still lets you speak to them.

## The standard being aimed at

For each feature: **you have touched it once, you know what it does, you know who buys it, and
you know whether it is Enterprise-gated.** Not "you can explain its failure modes under
concurrency."

That is deliberately a lower bar than the previous revision and a higher one than reading the
docs. The difference between "I've read about Spec Hub" and "I've put a spec in Spec Hub and
watched a collection follow it" is the difference between describing a product and demonstrating
one.

**Depth comes later, and only where it pays.** Base API testing is your stated strength area and
the one place extra depth is worth buying — Tour 1 carries that. Everywhere else, one pass.

## What stays from before

Nothing in `postman/` is generated. You build it. The API is verified without Postman first, so
that when something fails, "the API is broken" is a hypothesis to rule out rather than assume.
That has caught real defects twice and it is not overhead.

## Build work is now on demand

The API is scaffolding. Milestones 3A, 4A and 5A are **no longer scheduled** — they get built
only if a tour needs something that does not exist yet. As things stand, only a webhooks tour
would require new endpoints.

---

## Sequence

| #      | Tour                       | Plane      | Enterprise?     | Status         |
| ------ | -------------------------- | ---------- | --------------- | -------------- |
| **T1** | Activity Plane essentials  | Activity   | No              | 🔨 Mostly done |
| **T2** | Design — Spec Hub          | Management | Partly          | ⬅ **Next**     |
| **T3** | Gate — CLI, CI, governance | Management | Governance only | Not started    |
| **T4** | Catalog and discovery      | Management | **Yes**         | Not started    |
| **T5** | Identity and security      | Management | **Mostly**      | Not started    |
| **T6** | Simulate and observe       | Both       | Runners only    | Not started    |
| **T7** | Collaborate and distribute | Management | Partly          | Not started    |

One sitting each, roughly. T2 and T3 are the two that close the gap the audit flagged; do those
first even if you skip others.

> **Enterprise gating is unconfirmed.** Several tours depend on your team `justin-v12` being on
> Enterprise. Check **Team Settings → Plan** before T4. Where a feature is gated, each tour says
> what to do instead — and "know what it does and who it is for" is reachable from the docs
> either way.

---

## T1 — Activity Plane essentials 🔨

Collections, environments, variables and scopes, collection-level auth with per-request
override, pre-request and post-response scripts, chaining. **All done.**

Three gaps left, and they are quick:

1. **Collection Runner, beyond running a folder.** Run with iterations set to 5. Note the export
   button — that result file is what CI consumes, which is T3.
2. **Data-driven runs.** A CSV with `sku` and `expected_status` columns, referenced as
   `{{sku}}` and read with `pm.iterationData.get('sku')`. One request, N scenarios, one report.
   This is the answer to "how do you get from forty tests to four thousand", which is the
   question a QA lead is actually asking.
3. **One schema assertion.** `pm.response.to.have.jsonSchema()` against a schema pulled from
   your own `/openapi.json`. Once, so you know it exists.

**Done when you can say:** what the Runner produces that a single send does not, and why
data-driven runs are a coverage multiplier rather than a convenience.

---

## T2 — Design: Spec Hub ⬅

**What it is.** The API specification as a first-class object in Postman — versioned, linked to
the collections generated from it, with an Issues tab.

**Why it matters commercially.** Your spec currently lives in a git repository, so the only
people who can see it are people who can clone it. Spec Hub is the answer to "where does the
contract live so that design, test and documentation all point at the same thing".

**Do this:**

1. Put `openapi/openapi.json` into Spec Hub.
2. Generate a collection from it. Keep it separate from your hand-built one.
3. Change something in the spec and watch the sync. Read the **Issues** tab.

**Worth noticing:** compare the generated collection with yours. It has coverage, descriptions
and examples you did not type. It has none of your variable choices, chaining or assertions.
That gap is the honest answer to "can't AI just generate my tests" — and you will be asked.

**Buyer:** Platform Engineering / API CoE. Proof point: spec and collection stay in sync, no
manual import/export.

**Done when you can say:** what Spec Hub gives you that a spec file in a repo does not.

---

## T3 — Gate: Postman CLI, CI, governance

The centre of the Design → **Gate** → Validate → Monitor → Improve motion, and the thing your
own ramp plan stars as your largest gap.

**First, a blocker.** Your auth helper reads the password from **Postman Local Vault**, and the
Postman CLI cannot read Local Vault. Pick one:

| Option                                           | Cost                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| **Shared Vault**                                 | Team feature; secret lives in Postman cloud               |
| **`--env-var` at run time** from a GitHub secret | Two places to rotate. Usually right for a real credential |

**Do this:**

1. `postman login`, then `postman collection run <id>` locally. Watch it pass.
2. Add `--reporters junit` and look at the file. That is what a CI system reads.
3. Add a job to the existing `.github/workflows/release.yml`. Non-zero exit code fails the
   build.
4. Break something on a branch — rename a response field — and watch the gate block it. **This
   is the demo you will give.**
5. _(Enterprise)_ `postman spec lint openapi/openapi.json`. Rebuild one `redocly.yaml` rule as a
   Postman governance rule under **API Catalog → Governance Groups**.

**Vocabulary trap:** `postman api lint` is the v11 API Builder command, not supported in v12+.
Use `postman spec lint`. Getting this wrong in front of a platform team is an avoidable tell.

**On Newman, don't overclaim.** It is not deprecated — Postman still ships full Newman docs and
plenty of QA leads run it in Jenkins. The defensible line is the difference, not a verdict:
_"Newman runs the collection. The Postman CLI runs it and puts the result somewhere your
platform team can see — which is the difference between a test and a gate with evidence."_

**Buyer:** Platform Engineering, QA lead.

**Done when you can say:** what the Postman CLI does that Newman does not, and why a gate that
can be re-run until it passes is not a gate.

---

## T4 — Catalog and discovery

**Enterprise-gated. Confirm your plan first.** If the answer is no, this becomes a reading tour —
and the vocabulary below is the part that actually gets asked about.

**The distinction to get right**, named as the primary field confusion:

|                         | Answers                                        | Audience      |
| ----------------------- | ---------------------------------------------- | ------------- |
| **API Catalog**         | "What do we operate, and is it healthy?"       | **Producers** |
| **Private API Network** | "Does something already exist that does this?" | **Consumers** |

Read as one feature they sound redundant. They are not.

**Do this:** register Acme Commerce as a service in the Catalog. Look at the Service Health
Scorecard — test pass rates, spec compliance and gateway metrics in one view. If T3 step 5 ran
with reporting on, your lint results are already there under **Test → CI Pipeline Runs**.

Then publish the API to the Private API Network and search for it as a consumer would.

**Buyer:** Platform Engineering. PAN is described as the "aha" feature for platform leads.

**Done when you can say:** the Catalog/PAN distinction without hedging, and what a health
scorecard aggregates.

---

## T5 — Identity and security

Mostly Enterprise, and mostly the Security/IT buyer — a persona this project has given you
nothing for so far.

**Touch these:**

1. **Vault.** You use Local Vault already. Understand the boundary: Local never syncs and is
   invisible to the CLI and monitors; Shared reaches them and lives in the cloud.
2. **Service accounts.** A non-human CI identity with its own short-lived token and audit trail,
   so a pipeline is not running as someone who might leave. Create one if you can.
3. **Workspace roles / RBAC.** Look at the roles available on a workspace and what each permits.

**Read, don't build:** SSO, SCIM, Domain Capture, audit logs, Secret Scanner, BYOK — and the
Enterprise versus ASA commercial line.

**Failure modes worth knowing before you hit them:** a personal API key returns **401** at token
minting, not a warning. An org-level Admin role still **403s** at workspace create without a role
on the specific sub-team. Workspace Management Settings allowlists override roles independently,
so granting a role does not clear them.

**Buyer:** Security / IT Administration. Demo order: SSO/SCIM → Domain Capture → audit log export
→ Secret Scanner → Vault → service account for CI.

**Done when you can say:** why a service account is a security control rather than a
convenience, and which of Local/Shared Vault a monitor can read.

---

## T6 — Simulate and observe

**Mocks — two kinds, and the old framing is stale.**

|                    | Example-based               | Code-based local                               |
| ------------------ | --------------------------- | ---------------------------------------------- |
| Responses          | Static, from saved examples | Dynamic — any JavaScript                       |
| Runs               | Postman cloud, always on    | Locally, or deployed                           |
| State              | None                        | Yes, via `pm.state`                            |
| In CI              | Via a collection run        | `postman mock run`, as a test dependency       |
| Failure simulation | No                          | Scenarios: latency, errors, rate limits, chaos |

Build the example-based one from your OpenAPI examples. Then look at what a code-based mock can
do that it cannot — that capability is why "mocks are just static examples" is now a wrong
answer.

**Monitors.** Schedule one against `http://10.0.1.7:3001`. Break the API and watch it catch that.
Route an alert to Slack.

**Monitor Runners** — the one worth the most to you. Your Unraid box is behind home NAT and
unreachable from Postman's cloud. That is the same shape as the named gap in your ramp plan:
_"our APIs are internal, behind the firewall, on EKS."_ You have the real problem on your own
hardware. Solve it once and you can describe it rather than reason toward it.

**Performance: concept only.** Your team has `perf_test_milli_vuh` at 0, so there is nothing to
run. Know the four profiles and what each answers — Fixed (normal load), Ramp (where it
degrades), Spike (flash sale and recovery), Peak (will Black Friday break us).

**Buyer:** Product Engineering (mocks), Platform Engineering (monitors).

**Done when you can say:** what a code-based mock does that a static one cannot, and exactly what
Monitor Runners solve.

---

## T7 — Collaborate and distribute

**Touch these:**

1. **Workspace types** — personal, team, partner, public. What changes between them.
2. **Fork and pull request.** Fork your collection, change it, open a PR, merge it. API
   governance using a review model developers already know.
3. **Git-connected workspace.** You have this working. Understand what it changes: the repo as
   source of truth rather than a place exports land.
4. **Published documentation.** Publish your collection's docs and look at the result.
5. **Partner Workspaces** _(if Enterprise)_ — publish once, fork many, partners stay in sync.

**Buyer:** Partner / API Product Owners, and Platform Engineering for the fork/PR model.

**Done when you can say:** when a partner workspace beats a public one, and what the fork/PR flow
gives an API team that a shared workspace does not.

---

## After the tours

Non-build reading, no hands-on possible: the three-plane model · the five FY27 motions · the five
metrics (Package Adoption, Gate × Flake, DER, MTTD, CFR) and what broken looks like for each ·
what not to say ("Postman is a better Insomnia", "Postman is where you test APIs").

**Depth, if and where you want it.** Package Library at T3 or T7, Postman Flows, `setNextRequest`
branching, and the idempotency/webhook build milestones. All optional, all worth more once the
breadth is in place.
