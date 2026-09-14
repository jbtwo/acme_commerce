# Prompt: revise the learning plan against the SE readiness audit

Two versions. **Use the short one** unless the agent has a small context window or has already
proven it skims — the audit is the specification, and the short prompt just supplies the
instruction framing and guardrails an audit does not contain.

---

## Short version (recommended)

Read `docs/LEARNING_PLAN_AUDIT.md` in full. It audits this project's learning plan against what I
need to know as a Postman Strategic Solutions Engineer, and **it is the specification for this
task** — implement its recommendations, including the revised sequence in §6, the Checkpoint 1
expansion in §5a, the tier-split Checkpoint 2 in §5b, the non-build track in §5c/§5d, the Newman
framing in §5e, and the five document corrections in §7.

Constraints the audit does not state:

1. **Revise plan documents only.** No application code, no new endpoints, no change to the
   Milestone 2A build scope. The output is a revised curriculum, not a revised API.
2. **Preserve the STOP AND LEARN model.** Nothing in `postman/` is generated; I build it by hand.
   Every new checkpoint follows that rule.
3. **Match the existing voice.** These documents explain why a concept exists before what it is,
   state what something does _not_ prove, and name failure modes. Do not flatten that into
   bullet-point courseware.
4. **Extend, don't replace.** `LEARNING_GUIDE.md` §6 and §7 are the strongest parts of the
   project. §8 needs correcting (see audit §7); the rest gets added to.
5. **Every checkpoint needs a done-when condition** phrased as something I can _explain_, not
   just something I performed — matching `docs/MILESTONE_1_PLAN.md` §14.
6. **Keep the three indexes consistent** — `README.md` §18's milestone table, `LEARNING_GUIDE.md`'s
   topic table, and `README.md` §19. Drift between them is what `docs/BUILD_VERIFICATION.md`
   exists to prevent.
7. **Treat the Enterprise plan status of my team `justin-v12` as unconfirmed.** Audit §5b tier B
   and the `/peas` recommendation both depend on it. Write those behind an explicit "confirm Team
   Settings → Plan first" gate; tier A and everything else must stand on their own if the answer
   is no.

Before editing anything: give me the revised milestone/checkpoint sequence as a table, and flag
anything in the audit you think is wrong. It is a recommendation, not scripture. Wait for my
go-ahead.

---

## Long version

Use this if the agent needs the reasoning restated inline rather than read from the audit. It is
self-contained but redundant with `LEARNING_PLAN_AUDIT.md`.

## Context you need that the repo does not contain

I am a Postman SE in onboarding. This project exists so that I learn the Postman product deeply
enough to demo it and defend it in front of enterprise engineering buyers. The API is the
substrate; **Postman is the subject.** My org's current play is **SDLC automation** —
Design → Gate → Validate → Monitor → Improve — and the "Gate" stage (contract testing,
governance rules, CI enforcement) is my single biggest assessed gap.

Two priorities, both real, neither subordinate to the other:

1. **Base API testing depth.** The people I talk to already know Postman as a testing tool. I
   need to be unambiguously expert there — scripting, assertions, the Collection Runner,
   data-driven runs, the CLI, reporters. This is the floor, not the ceiling.
2. **The Management Plane and the SDLC story.** API Catalog, Spec Hub, governance rules,
   service accounts, Git-connected workspaces, monitors. Currently absent from this repo
   entirely.

## Scope of the change

Revise the **plan documents**. Do **not** write application code, add endpoints, or change the
Milestone 2A build scope in this pass. The output is a revised curriculum, not a revised API.

### 1. Restructure the milestone sequence

Implement the table in audit §6, with one amendment below. The core move is **pulling the Gate
material out of Milestone 5 and inserting it as a new Checkpoint 2**, because governance and CI
are what I need first, not last.

**The sequence is CP1 → M2A → CP2 → M3A(compressed) → M4A(webhooks) → CP3 → CP4 → M5A → M6.**
CP2 sits _after_ Milestone 2A, not before it: a gate on an unauthenticated API cannot teach
collection-level auth inheritance or service-account CI identity, and both are on my required
list. This still pulls governance and CI forward by three milestones, which is the whole point.

Split Checkpoint 2 into **Tier A (works on any plan)** and **Tier B (Enterprise only)** exactly
as audit §5b does. The tier split is not cosmetic: if I hit an Enterprise-gated feature without
knowing it, I will waste a day debugging my own setup. Carry the two vocabulary traps the audit
names — `postman spec lint` is the v12 command and `postman api lint` is v11-only; and
`--report-events` is what pushes lint results into the Catalog.

### 2. Amendment to the audit's cut list — KEEP the infrastructure work

The audit originally proposed cutting the Unraid deployment and Postgres setup. **I have
overruled that and the audit has been updated** (see the "Explicitly kept" note in §4). Reason:
I want a genuinely deployed production instance to test against, and that is a **prerequisite**
for the Monitor checkpoint, not a distraction from it. Specifically:

- Monitors need a reachable target. `127.0.0.1` cannot teach synthetic monitoring.
- An Unraid box behind home NAT is the best substrate I will get for **Monitor Runners** — the
  "our APIs are internal, behind the firewall" problem, which is a named gap for me.
- Swapping `base_url` between local and deployed makes `LEARNING_GUIDE.md` §7 real.

So: treat "the deployment is live" as a **prerequisite of Checkpoint 4**, and reflect that in
the sequencing. Do not cut `docs/UNRAID_DEPLOYMENT.md` or `docs/POSTGRES_SETUP.md`. Do not
expand them either — no Postgres tuning, no backup/restore rehearsals, no comparing connection
models beyond the one I actually deploy.

Apply the **remaining** cuts in audit §4 as written: compress Milestone 3 to one idempotent
endpoint plus one state machine, reduce Milestone 4 to webhooks only, and leave the GHCR
release pipeline where it is rather than elaborating it. For `PERSONAS.md`, do not expand it —
add a short table mapping its 12 engineering personas to the five Postman buyer personas
(Platform Eng/DevEx/API CoE, Security/IT, QA lead, Product Eng/EM, Partner/API product owner).

### 3. Deepen Checkpoint 1 — this is the priority, not a footnote

Checkpoint 1 currently asks for three `pm.test()` assertions on `/health`. That is day one. Take
the table in audit §5a and turn every row marked "Checkpoint 1" into an actual exercise with a
stated done-when condition. At minimum it must reach: `pm.response.to.have.jsonSchema()` asserted
against the served OpenAPI schema; pre-request vs post-response scripts and their execution
order; the Collection Runner; and a **data-driven run from a CSV** — the seeded 20 products and
49 variants are already a usable data file, so use them rather than inventing data.

### 4. Rewrite the stale and thin sections of `LEARNING_GUIDE.md`

Apply all five corrections in audit §7. The two that matter most:

- **§8 Mocking is factually out of date.** It describes only static example-driven mocks. Since
  the April 2026 platform release Postman also ships code-based local mock servers that run
  locally and inside the CI test loop. Keep the existing teaching about what mocks cannot prove
  — that reasoning is good — but stop presenting stateless static mocking as the whole product.
- **§9 forward references** omit the entire Management Plane. Add Spec Hub, governance rules,
  Postman CLI, Package Library, monitors and Monitor Runners, so a reader finishes the guide
  aware that these exist.

Also add the Newman vs Postman CLI comparison from audit §5e somewhere sensible. Present it as a
difference table, **not** as "Newman is deprecated" — it is still shipped and documented, and
asserting otherwise in front of a QA lead who runs it in Jenkins would be a costly mistake.

### 5. Add the non-build track

Some of what I need cannot be built on a laptop: API Catalog, service accounts, SSO/SCIM/Domain
Capture/RBAC, the Enterprise-vs-ASA commercial line, and the API Catalog vs Private API Network
distinction. Audit §5c and §5d cover these. Add a clearly-labelled **non-build track** to the
plan so these are scheduled reading and sandbox work rather than silently missing. Do not invent
a milestone that pretends to build them.

Note in that section that cloud **performance testing is unavailable to me** right now — my
`perf_test_milli_vuh` quota is 0 — so the four VU profiles (Fixed, Ramp, Spike, Peak) are
conceptual until that changes.

**Unverified assumption, flag it as such in the plan:** the audit infers my team `justin-v12` is
on Enterprise from its quota shape, but that is not confirmed, and the zero VU-hour quota points
the other way. Everything in CP2 tier B and the `/peas` recommendation depends on it. Write those
sections with an explicit "confirm Team Settings → Plan before scheduling this" gate rather than
assuming access. Tier A and the rest of the plan must stand on their own if the answer is no.

## How to do it

- **Match the existing voice.** These documents are unusually good: direct, they explain why a
  concept exists before what it is, they state what something does _not_ prove, and they name
  failure modes. Do not flatten that into bullet-point courseware.
- **Preserve the "STOP AND LEARN" model.** Nothing in `postman/` is generated; I build it by
  hand. Every new checkpoint follows that rule.
- **Every checkpoint needs a done-when condition** phrased as something I can _explain_, not
  just something I performed — matching the style of `docs/MILESTONE_1_PLAN.md` §14.
- **Do not delete the existing conceptual material.** §6 and §7 of `LEARNING_GUIDE.md` are the
  strongest parts of the project. Extend them; do not replace them.
- Keep `README.md` §18's milestone table, `LEARNING_GUIDE.md`'s topic table at the top, and the
  §19 documentation index all consistent with the new sequence. Drift between them is the exact
  failure mode `docs/BUILD_VERIFICATION.md` exists to prevent.

## Before you start

Tell me the revised milestone/checkpoint sequence as a table, and flag anything in the audit you
think is wrong. The audit is a recommendation, not scripture — if the CP1 → M2A → CP2 ordering
creates a dependency problem I have not spotted, say so and propose the ordering that actually
works. Wait for my go-ahead before editing files.
