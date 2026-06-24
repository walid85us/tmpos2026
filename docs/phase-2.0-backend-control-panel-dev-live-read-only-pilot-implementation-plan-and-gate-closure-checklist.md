# Phase 2.0 M7A — DEV-only Live Read-Only Pilot Implementation Plan and Gate-Closure Checklist

**Status:** Documentation/planning-only · Implementation plan + gate-closure checklist (implements, enables, and authorizes no pilot)
**Accepted checkpoint at authoring:** `fe988f6ec8ef18458a4f690359821ed721e14dff` (Phase 2.0 M7)
**Authoring milestone:** Phase 2.0 M7A

> Redaction-first document. Contains no real tenant/store/customer data, raw UIDs,
> raw emails, domains, tenant/store IDs, row dumps, DB URLs, tokens, secrets,
> provider credentials, permission/entitlement key lists, mismatch lists, raw auth
> claims, or raw `identity_link` rows. This milestone makes no runtime, route,
> auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, or Backend
> Control Panel (BCP) UI change; enables no live session authorization or Supabase
> auth; implements and authorizes no pilot. Nothing is staged, committed, pushed,
> or backed up.

---

## 1. Executive Summary

This is a **documentation/planning-only** milestone. It translates the M7 **Decision B** outcome into a precise, **implementation-plannable** plan and gate-closure checklist (candidate-ready *after* the gates close — not implementation-ready today) for a future, separately scoped, limited **DEV-only live read-only pilot** of the Backend Control Panel (BCP). It **does not implement, enable, or authorize** a live read-only pilot, any live read API, live session authorization, Supabase auth, or any cutover.

The plan is deliberately conservative: it identifies the safest possible first candidate (C-01 Readiness Summary, optionally C-02 System Operations Summary), enumerates the gates that must close before any implementation, and breaks future work into safe, separable work packages — none of which are executed here. Because the test harness, mapper contracts, and server-principal validation scaffolding do not yet exist, the planning decision is **Decision B — ready to request a pilot foundation / test-harness milestone before any live API implementation.**

## 2. Current State and Boundary

- **M1–M7 are complete and backed up.** M7 outcome was **Decision B** (conditionally ready for planning, not implementation).
- **The BCP remains mock-only** and DEV-gated at `/dev/backend-control-plane`; frontend-only, read-only, code-split.
- **No live BCP read APIs exist**; no DTO/read-model/mapper code for live BCP APIs exists.
- **No live session auth is enabled**; **Supabase auth is not enabled**; identity/authz flags default-off and non-production-only.
- **Supabase is not ready for a Firebase cutover.**
- **M7A plans future implementation gates only.** Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Planning Decision

**Decision B — READY TO REQUEST A PILOT FOUNDATION / TEST-HARNESS MILESTONE BEFORE LIVE API IMPLEMENTATION.**

**Why:** The candidate contract (C-01, optionally C-02) is identifiable and the gate-closure checklist is definable, but implementation must not start until a pilot foundation exists: a DEV-only flag + route boundary plan, a server authorization guard plan, a redacted DTO mapper contract, and the parity/isolation/RBAC/redaction **test harness**. None of these are implemented today. Requesting a live API implementation milestone now would skip the test scaffolding that makes the pilot safe. Therefore the next milestone should be a **foundation/test-harness** milestone, not a live-API implementation milestone.

This honors M7 Decision B: limited DEV-only pilot **planning** is ready; **implementation is not authorized**.

## 4. Candidate Contract Selection

Conservative classification. **No contract is cleared for implementation here.**

| Contract | Classification |
|---|---|
| C-01 Readiness summary | Candidate for first pilot implementation (only after gate closure) — aggregate, redacted, DEV-only, read-only |
| C-02 System operations summary | Candidate for first pilot implementation (secondary) — aggregate, redacted, DEV-only, read-only |
| C-03 Support diagnostics summary | Candidate for later pilot — blocked-on-redaction until tests exist |
| C-04 Audit visibility | Candidate for later pilot — blocked-on-redaction + sensitive permission design |
| C-05 Configuration posture | Blocked/deferred (config/secrets) |
| C-06 Tenant / store posture | Blocked-on-schema |
| C-07 Billing / plan posture | Blocked-on-schema + blocked-on-sensitive permission design |
| C-08 Data governance posture | Candidate for later pilot — blocked-on-redaction |
| C-09 Identity readiness posture | Blocked-on-parity + sensitive permission design; posture-only; no raw identity / no cutover |

C-01 is the safest because it is the lowest-sensitivity aggregated posture surface (status/readiness labels), requires no tenant/store row data, and maps cleanly onto an already-redacted DTO.

## 5. Proposed First Pilot Scope

**Recommended first candidate: C-01 Readiness Summary** (C-02 optional secondary). This scope is **proposed for a future milestone only**; it is not implemented or authorized here.

- **Contract ID:** C-01 (Readiness/posture summary).
- **Why safest:** aggregated posture labels only; no tenant/store/customer rows; lowest sensitivity; no payment/identity data; would map to a simple already-redacted DTO once the mapper is built (no DTO/mapper exists today).
- **Data-source expectation:** server-composed readiness/posture aggregate; no table passthrough.
- **Required read model:** a server-owned readiness posture read model returning safe labels/aggregates only.
- **Required DTO:** the M3 already-redacted envelope (`schemaVersion`/`environment`/`generatedAt`/`data`/`redaction`/`freshness`/`authorizationContext`/`emptyState`/`warnings`) with posture-label `data`.
- **Required mapper:** a pure mapper that redacts before return, blocks forbidden fields, and emits redaction/freshness/authorizationContext metadata + safe empty state.
- **Required tests:** route-disabled-by-default, DEV-only gate, authorization fail-closed, no client UID/email authority, DTO schema, mapper forbidden-field, redaction, empty-state, tenant/store isolation (N/A-or-platform-scope asserted), RBAC visibility, parity, no-mutation, no-production-exposure.
- **Required feature flag:** a dedicated DEV-only, default-off pilot flag (separate from existing flags).
- **Required route/API boundary:** a DEV-only namespaced read-only GET; no mutation verbs; no write side effects.
- **Required evidence:** redacted/aggregate evidence proving authorization, redaction, empty-state, and no-mutation — no raw identifiers.
- **Stop conditions:** any need for raw IDs, mutation, production exposure, client-UID/email authority fallback, or unimplemented tests treated as passed (see §19).

## 6. Contracts Explicitly Excluded from First Pilot

- **C-06** — excluded while tenant/store schema/read model is not ready.
- **C-07** — excluded while billing/plan schema/read model is not ready (and pending sensitive-permission design).
- **C-09** — excluded if it would require raw `identity_link` rows, provider-UID exposure, or cutover; posture-only otherwise.
- **C-05** — config/secrets excluded/deferred.
- **Wave 3 areas** — logs/telemetry, jobs/workers, API traffic, backups/recovery, deployments/releases, identity-link details — all excluded.
- **Any contract requiring backend actions or mutation** — excluded (Phase 3).

## 7. Gate-Closure Checklist

All must be closed before any implementation milestone starts:

- [ ] Accepted M7A plan.
- [ ] Exact pilot contract chosen (proposed: C-01).
- [ ] DEV-only flag named (dedicated, default-off).
- [ ] Route/API boundary defined (DEV-only namespace, read-only GET).
- [ ] Server authorization boundary defined.
- [ ] Server-derived principal requirement defined (`internal_user_id` anchor, provider-aware).
- [ ] No client UID/email authority (hard fail).
- [ ] DTO envelope defined (M3 already-redacted envelope).
- [ ] Mapper behavior defined (redact-before-return, fail closed).
- [ ] Read model source defined (server-owned aggregate).
- [ ] Redaction rules mapped (M4).
- [ ] Tenant/store isolation tests **implemented and passing** (M5).
- [ ] RBAC visibility tests **implemented and passing** (M5).
- [ ] Parity tests **implemented and passing** (M6).
- [ ] Redaction + empty-state tests **implemented and passing**.
- [ ] No-mutation tests **implemented and passing**.
- [ ] No-production-exposure tests **implemented and passing**.

**Gate strength (binding for Decision B):** the isolation, RBAC, parity, redaction, empty-state, no-mutation, and no-production-exposure tests must be **implemented and passing in the foundation/test-harness milestone before any live read API implementation begins** — "defined on paper" is not sufficient to start implementation.
- [ ] Rollback/disable path defined (flag default-off, immediate disable).
- [ ] Evidence requirements defined (redacted/aggregate only).
- [ ] Stop conditions defined.

## 8. Future Work Package Plan

Future implementation broken into safe, separable packages — **none executed here; no listed file is edited now.** The "files likely affected later" column is **indicative planning only**, not a pre-scoped or pre-approved implementation: the foundation/test-harness milestone (M7B) and the §7 gate-closure checklist must close before any of these packages is scoped for execution.

| WP | Purpose | Files likely affected later | Safety requirements | Required tests | Stop conditions |
|---|---|---|---|---|---|
| WP1 | DEV-only feature flag + server route boundary plan | new server route module; DEV flag config | DEV-only, default-off, read-only GET | route-disabled-by-default; DEV-only gate | any production exposure |
| WP2 | Server authorization guard plan | new server authz guard (reuse `internal_user_id` path) | verified principal only; fail closed | authorization fail-closed; no client UID/email | client UID/email authority |
| WP3 | Read model source plan | new server read-model module | server-owned; aggregate; no passthrough | read-model shape; blocked-field omission | raw row/table passthrough |
| WP4 | DTO mapper plan | new server mapper module | redact-before-return; fail closed | mapper forbidden-field; schema | raw source object leak |
| WP5 | Redaction + empty-state mapper tests plan | new test module | redaction by default | redaction; empty-state | unredacted output |
| WP6 | Isolation/RBAC/parity tests plan | new test module | server-side isolation; fail closed | isolation; RBAC; parity (negative) | cross-tenant leak |
| WP7 | BCP UI adapter plan | `src/backend-control-plane/*` (consume redacted DTO) | consume already-redacted DTO only | UI renders safe labels/empty states | UI-side security filtering |
| WP8 | Audit/evidence/no-mutation proof plan | new evidence/test module | redacted evidence only | no-mutation; evidence safety | raw audit/identifier evidence |
| WP9 | Manual QA plan | docs only | DEV-only QA | QA checklist pass | unsafe QA data |
| WP10 | Rollback/disable plan | flag config | immediate disable | disable path test | disable depends on DB/auth cutover |

## 9. Server Authorization Plan

Authorization-plane reminder: pilot read authorization is owned by the **server-side BCP read authorization plane** (server-derived principal), which is **distinct from** the current Firebase / legacy AccessContext frontend/app plane. The frontend plane is never the final authority for a pilot read decision.

Future requirements (not implemented):

- Verified bearer / server principal only.
- `internal_user_id` anchor.
- Provider-aware mapping (provider identity ≠ authority by itself).
- Fail closed.
- No request-body / client-UID authority.
- No email authority.
- No frontend-only claim authority.
- No unreviewed Supabase claim authority — and for this pilot, any Supabase claim **remains explicitly non-authoritative** until a separate, accepted cutover/auth milestone changes it.
- Default-off feature flag.
- DEV-only environment gate.

## 10. API Boundary Plan

Future pilot API requirements (not created here):

- DEV-only route namespace.
- Read-only GET only unless separately justified.
- No mutation verbs.
- No write side effects.
- No DB writes.
- No backend actions.
- No production exposure.
- No normal SaaS navigation exposure.
- Structured, safe error responses (generic; no internals).
- Safe empty-state responses.
- Redacted DTO envelope only.

## 11. Read Model Plan

Future read model requirements (not implemented):

- Server-owned.
- No table passthrough.
- No raw row dumps.
- Aggregate / status posture preferred.
- Source readiness classified.
- Blocked fields omitted.
- Safe labels only.
- No secrets/tokens/payment identifiers.
- No raw audit logs.
- No raw `identity_link` rows.

## 12. DTO Mapper Plan

Future mapper requirements (not implemented):

- Pure mapper.
- Already-authorized inputs.
- Redaction before return.
- No raw source object passthrough.
- Stable `schemaVersion`.
- Redaction metadata.
- Freshness metadata.
- `authorizationContext` metadata.
- `emptyState` support.
- Forbidden-field tests.
- Fail closed.

## 13. Test Plan for Future Implementation

Tests required before any future implementation is accepted (none implemented here):

- Route disabled by default.
- DEV-only route gate.
- Authorization fail closed.
- No client UID/email authority.
- No mutation.
- DTO schema.
- Mapper forbidden-field tests.
- Redaction tests.
- Empty-state tests.
- Tenant/store isolation tests.
- RBAC visibility tests.
- Parity tests.
- No production exposure.
- No real data.
- Rollback/disable.

## 14. Evidence and QA Plan

Future evidence requirements (not produced here):

- Redacted evidence only.
- No raw identifiers.
- No raw audit logs.
- No raw `identity_link` rows.
- No secrets/tokens/DB URLs.
- No permission/entitlement key dumps.
- No mismatch lists.
- Manual QA checklist.
- Codex / independent review.
- Final owner acceptance.

## 15. Rollback / Disable Plan

Future requirements (not implemented):

- Feature flag default-off.
- Immediate disable path (flip flag → instant revert to mock/no-data).
- No data-migration dependency.
- No DB-write dependency.
- No auth-cutover dependency.
- No production-exposure dependency.
- Safe failure mode (fail closed to mock/no-data).
- Audit/evidence of disable only if safe and redacted.

## 16. Pilot Guardrails

Any later pilot must hold all of:

- DEV-only.
- Default-off.
- Read-only.
- No backend actions.
- No writes.
- No DB mutation.
- No Supabase cutover.
- No production exposure.
- No normal SaaS navigation exposure.
- No raw identifiers.
- No raw audit logs.
- No raw `identity_link` rows.
- No payment/provider identifiers.
- No secrets/tokens/DB URLs.
- Fail closed.
- Safe empty states.
- Redacted evidence only.

## 17. Risk Register

| ID | Risk | Severity | Mitigation | Required closure gate |
|---|---|---|---|---|
| R-1 | Premature implementation | High | Decision B requests foundation/test-harness first | Accepted M7A + foundation milestone |
| R-2 | Authority fallback (client UID/email) | High | Hard fail closed; no body/client authority | Authorization fail-closed tests |
| R-3 | Server principal not validated | High | Parity tests before live use | Parity test harness |
| R-4 | Route exposed outside DEV | High | DEV-only namespace + default-off flag | Route-disabled-by-default test |
| R-5 | UI assumes a security boundary | Medium | UI consumes already-redacted DTO only | UI adapter + redaction tests |
| R-6 | Mapper leaks raw source object | High | Pure mapper; redact-before-return; fail closed | Mapper forbidden-field tests |
| R-7 | Redaction test gap | High | Redaction tests required pre-accept | Redaction test harness |
| R-8 | Isolation/RBAC test gap | High | Isolation/RBAC tests required pre-accept | Isolation/RBAC test harness |
| R-9 | Parity test gap | High | Parity tests required pre-accept | Parity test harness |
| R-10 | Production exposure | High | No production exposure; DEV-only | No-production-exposure test |
| R-11 | Backend mutation leakage | High | Read-only GET only; no mutation verbs | No-mutation test |
| R-12 | Supabase cutover confusion | Medium | Explicit "no cutover" boundary | M8 (separate) |

No HIGH risk is treated as closed; each maps to a required closure gate that must pass before implementation.

## 18. Codex Review Result

Codex was invoked as an independent read-only reviewer of this plan. The result is recorded in the final report; Codex modified no files. Any HIGH issue Codex raises is a blocker until reconciled. If Codex is environment-blocked, that is stated plainly and is not, by itself, a blocker for this documentation-only milestone.

## 19. Stop Conditions

Halt and reassess if any of the following arise:

- M7A tries to implement the pilot.
- Implementation requires DB access now.
- Implementation requires Supabase MCP now.
- Implementation requires enabling live session auth now.
- Implementation requires enabling Supabase auth now.
- Implementation requires a cutover.
- Implementation requires production exposure.
- Implementation requires backend actions.
- Implementation requires mutation.
- Implementation relies on client UID/email authority.
- Implementation relies on UI-side security filtering.
- Implementation lacks redaction tests.
- Implementation lacks isolation/RBAC tests.
- Implementation lacks parity tests.
- Implementation requires raw IDs, raw `identity_link` rows, raw audit logs, secrets, tokens, DB URLs, payment identifiers, permission keys, entitlement keys, mismatch lists, or raw auth claims.

## 20. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It records an honest planning decision (A/B/C) with rationale (§3) and does not pre-authorize implementation.
- It provides candidate contract selection (§4), the proposed first pilot scope (§5), excluded contracts (§6), the gate-closure checklist (§7), and the future work-package plan (§8).
- It defines the server authorization (§9), API boundary (§10), read model (§11), DTO mapper (§12), test (§13), evidence/QA (§14), and rollback/disable (§15) plans, plus guardrails (§16), the risk register (§17), the Codex result (§18/report), and stop conditions (§19).
- It preserves the M2.1–M7 assumptions (two authority planes, M20 posture, redaction/evidence, isolation/RBAC, parity, Decision B).
- It claims **no** pilot implementation, **no** live API, **no** live session auth, **no** Supabase auth, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, or BCP UI change was made; nothing was staged, committed, pushed, or backed up.

## 21. Recommended Next Milestone

**Phase 2.0 M7B — DEV-only Pilot Foundation and Test Harness Plan** — the foundation/test-harness milestone that must precede any live-API implementation (per Decision B). The actual C-01 live read-only implementation remains a later, separately scoped and accepted milestone, contingent on the §7 gate-closure checklist passing.
