# Phase 2.0 M7B — DEV-only Pilot Foundation and Test Harness Plan

**Status:** Documentation/planning-only · Foundation + test-harness plan (implements no foundation, harness, live API, route, DTO, read model, mapper, or pilot)
**Accepted checkpoint at authoring:** `646cc0d2a642f88f463ed852cb34e66828147702` (Phase 2.0 M7A)
**Authoring milestone:** Phase 2.0 M7B

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

This is a **documentation/planning-only** milestone. It defines the **DEV-only pilot foundation and test harness** that must exist before any BCP live read-only API implementation can be requested. It **does not implement** the foundation, the test harness, a live API, a route, a DTO, a read model, a mapper, or the pilot, and it enables no live session authorization, Supabase auth, or cutover.

The plan keeps two things strictly separate: (a) a **foundation + test-harness** layer — a DEV-only default-off feature flag, an **inert** route/guard skeleton, and a **synthetic-input** test harness for authorization/redaction/isolation/RBAC/parity/no-mutation — and (b) **live C-01 data integration**, which remains out of scope and separately authorized. Because the foundation/harness can be built and validated against synthetic inputs with **no live DB reads and no live data**, its implementation can be safely isolated from live-API work.

## 2. Current State and Boundary

- **M1–M7A are complete and backed up.** M7 outcome was Decision B (planning ready, not implementation); M7A outcome was Decision B (request a foundation/test-harness milestone before live API implementation).
- **The BCP remains mock-only** and DEV-gated at `/dev/backend-control-plane`; frontend-only, read-only, code-split.
- **No live BCP read APIs exist**; no DTO/read-model/mapper code for live BCP APIs exists.
- **No live session auth is enabled**; **Supabase auth is not enabled**; identity/authz flags default-off, non-production-only.
- **Supabase is not ready for a Firebase cutover.**
- **M7B plans the foundation/test-harness only.** Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Planning Decision

**Decision A — READY TO REQUEST DEV-ONLY PILOT FOUNDATION AND TEST HARNESS IMPLEMENTATION.**

**Why (and the binding condition):** the foundation/test-harness implementation scope **can be safely isolated from live API implementation**. A future M7C may build only an inert, default-off, DEV-only scaffold (flag + route/guard skeleton) and a **synthetic-input** test harness that proves authorization fail-closed, redaction, empty-state, isolation, RBAC, parity-guard, and no-mutation behavior — with **no live DB reads, no live data, and no UI navigation exposure**. Live C-01 data integration is **not** part of that scope and remains separately authorized. Decision A is chosen over "more design" (Decision B) because M7B already fully specifies the foundation and harness; another pure-design pass would be redundant. Decision A is bounded by the §8 M7C boundary and the §21 stop conditions.

## 4. Minimum Safe Pilot Candidate

- **C-01 Readiness Summary is the only acceptable initial candidate** for future foundation/harness work: lowest-sensitivity aggregated posture, no tenant/store rows, no payment/identity data.
- **C-02 System Operations Summary remains optional** and **must not be added** unless it demonstrably does **not** expand data-source, redaction, or test risk beyond C-01. The harness should be designed C-01-first; C-02 is a later, additive consideration only.

## 5. Foundation Scope Definition

Future foundation scope (not implemented here):

- **DEV-only feature flag boundary** — a dedicated, default-off flag, non-production-only, separate from existing flags.
- **Route/API boundary plan** — a DEV-only namespaced boundary that is **inert/disabled by default**.
- **Server authorization guard plan** — a guard requiring the server-derived principal; fail closed.
- **No-mutation guarantee plan** — read-only shape only; no write verbs or side effects.
- **Redacted DTO envelope harness** — the M3 already-redacted envelope as the only output shape.
- **Empty-state harness** — safe bounded statuses; empty indistinguishable from hidden.
- **Safe error response harness** — generic, non-revealing errors.
- **Disabled-by-default behavior** — absent/inert unless the flag is explicitly on in DEV.
- **Rollback/disable behavior** — flipping the flag off instantly reverts to mock/no-data.

## 6. Test Harness Scope Definition

Future test harness scope (not implemented here):

- Disabled-by-default tests.
- DEV-only route gate tests.
- Authorization fail-closed tests.
- No client UID/email authority tests.
- No mutation tests.
- DTO schema tests.
- Mapper forbidden-field tests.
- Redaction tests.
- Empty-state tests.
- Tenant/store isolation tests.
- RBAC visibility tests.
- Parity guard tests.
- No production exposure tests.
- No real data tests.
- Rollback/disable tests.

All harness tests use **synthetic inputs only**.

## 7. What M7B Must Not Implement

M7B does **not** implement any of:

- Live API.
- Live data integration.
- Backend CP UI adapter.
- Production exposure.
- Normal SaaS navigation exposure.
- Supabase cutover.
- Backend actions.
- DB writes.
- `identity_link` writes.
- Real tenant/store/billing/customer data.
- C-01 live read model.
- C-01 live DTO mapper.
- C-01 route.

## 8. Future M7C Implementation Boundary

If approved later, a future **M7C** foundation/test-harness implementation **may** include only:

- A DEV-only, default-off feature flag.
- An **inert route boundary skeleton** (registered behavior gated off by default; no live handler logic).
- An **authorization guard skeleton** (fail-closed shape; not wired to live data).
- **Test harness scaffolding.**
- A **mock/synthetic DTO contract test fixture** (synthetic-only).

M7C **must not** include:

- Live DB reads.
- Production exposure.
- Live data.
- UI navigation exposure.
- Backend actions.

**Binding:** M7C must **not** implement live C-01 data integration unless separately authorized by a later milestone. The line between "inert scaffold + synthetic harness" (allowed in M7C if approved) and "live C-01 read integration" (not allowed in M7C) is the controlling boundary.

## 9. Server Authorization Harness Plan

Future harness requirements (not implemented):

- Verified server principal only.
- `internal_user_id` anchor.
- Provider-aware mapping (provider identity ≠ authority by itself).
- Fail closed.
- No request-body / client-UID authority.
- No email authority.
- No frontend-only claim authority.
- No unreviewed auth-claim authority.
- Default-off feature flag.
- DEV-only environment gate.
- **Negative tests for all forbidden authority inputs** (each forbidden input must be proven to fail closed).

## 10. Route / API Boundary Harness Plan

Future harness requirements (not implemented):

- DEV-only namespace.
- Default-off.
- GET-only if a route skeleton is later authorized.
- No mutation verbs.
- No write side effects.
- No DB writes.
- No backend actions.
- No production exposure.
- No normal SaaS navigation exposure.
- Safe error responses.
- Safe empty-state responses.
- Redacted DTO envelope only.
- No live provider calls.

## 11. DTO / Mapper Harness Plan

Future harness requirements (not implemented):

- `schemaVersion`.
- Redaction metadata.
- Freshness metadata.
- `authorizationContext` metadata.
- `emptyState` metadata.
- Safe `warnings`.
- Pure mapper.
- No raw source passthrough.
- Forbidden-field tests.
- Fail-closed behavior.
- **Synthetic-only test inputs** unless separately authorized.

## 12. Read Model Harness Plan

Future harness requirements (not implemented):

- Server-owned read model interface or design seam.
- No table passthrough.
- No raw row dumps.
- **No DB dependency for the initial harness** unless separately authorized (harness validates against synthetic inputs).
- Aggregate/status posture only.
- Source readiness classification.
- Blocked fields omitted.
- Safe labels only.

## 13. Redaction and Evidence Harness Plan

Future harness requirements (not implemented):

- Redaction applied before DTO return.
- Evidence `safe_summary` or `aggregate_only` only.
- No raw identifiers.
- No raw audit logs.
- No raw `identity_link` rows.
- No secrets/tokens/DB URLs.
- No permission/entitlement key dumps.
- No mismatch lists.
- Redaction negative tests.
- Evidence negative tests.

## 14. Tenant / Store Isolation Harness Plan

Future harness requirements (not implemented):

- **Synthetic** tenant/store scope scenarios only.
- Unauthorized tenant denied/empty safely.
- Unauthorized store denied/empty safely.
- No client-side filtering as a security boundary.
- Cross-tenant visibility disabled unless explicitly tested as denied.
- No raw tenant/store/customer IDs.

## 15. RBAC Visibility Harness Plan

Future harness requirements (not implemented):

- No-BCP-access class denied.
- Overview viewer allowed for low-sensitivity posture only.
- Sensitive viewer **denied by default**.
- Cross-tenant viewer **denied by default**.
- System-owner / full read-only posture (still read-only).
- No Phase 3 action permission implied.
- No raw permission key exposure.
- No entitlement key dumps.

## 16. Parity Guard Harness Plan

Future harness requirements (not implemented):

- Server-principal readiness guard.
- Stale/unknown parity returns blocked/denied.
- **No pilot route becomes usable when the parity gate is unresolved.**
- No unreviewed claim authority.
- Safe parity-blocked empty state.
- No raw mismatch lists.

## 17. No-Mutation and Production-Exposure Harness Plan

Future harness requirements (not implemented):

- No mutation verbs.
- No write functions.
- No DB writes.
- No audit writes unless separately authorized and safe.
- No production route registration.
- No production bundle exposure.
- No normal SaaS navigation exposure.
- No backend action affordances.

## 18. Manual QA Plan

Manual QA steps for a future implementation:

- Route absent when the flag is off.
- Route inaccessible outside DEV.
- Unauthorized user denied safely.
- Forbidden authority inputs fail closed.
- No mutation behavior.
- No raw data in payload.
- Empty state safe.
- Rollback/disable verified.
- No production exposure.
- No normal SaaS navigation exposure.

## 19. Evidence Requirements

Required evidence for a future implementation:

- Scoped file list.
- Flag default-off proof.
- Route DEV-only proof.
- Auth fail-closed proof.
- No-mutation proof.
- No-production-exposure proof.
- Test results.
- Redaction scan.
- Manual QA results.
- Rollback proof.
- Final `git status`.

All evidence must be redacted/aggregate; no raw identifiers.

## 20. Risk Register

| ID | Risk | Severity | Mitigation | Closure requirement |
|---|---|---|---|---|
| R-1 | Foundation accidentally becomes a live API | High | Inert skeleton; default-off; synthetic-only; live integration separate | M7C boundary + no-live-read test |
| R-2 | Route exposure outside DEV | High | DEV-only namespace + default-off flag | Route-disabled-by-default + DEV-gate tests |
| R-3 | Test harness uses real data | High | Synthetic-only inputs | No-real-data test + redaction scan |
| R-4 | Auth guard trusts client UID/email | High | Server principal only; fail closed | Forbidden-authority negative tests |
| R-5 | Mapper leaks raw source object | High | Pure mapper; redact-before-return | Mapper forbidden-field tests |
| R-6 | Redaction tests incomplete | High | Redaction + evidence negative tests required | Redaction harness passing |
| R-7 | Isolation tests incomplete | High | Synthetic isolation scenarios; fail closed | Isolation harness passing |
| R-8 | RBAC tests incomplete | High | Default-deny sensitive/cross-tenant | RBAC harness passing |
| R-9 | Parity guard incomplete | High | Parity-blocked → denied/empty | Parity guard harness passing |
| R-10 | Production exposure | High | DEV-only; no prod registration/bundle | No-production-exposure test |
| R-11 | Backend mutation leakage | High | Read-only; no write verbs/functions | No-mutation test |
| R-12 | Cutover confusion | Medium | Explicit "no cutover" boundary | M8 (separate) |

No HIGH risk is treated as closed; each maps to a closure requirement that must pass in the future implementation.

## 21. Stop Conditions

Halt and reassess if the foundation plan would require any of:

- Live DB reads now.
- Supabase MCP now.
- Enabling live session auth now.
- Enabling Supabase auth now.
- A cutover.
- Production exposure.
- Backend actions.
- Mutation.
- Reliance on client UID/email authority.
- Reliance on UI-side security filtering.
- Missing redaction tests.
- Missing isolation/RBAC tests.
- Missing parity guard tests.
- Raw IDs, raw `identity_link` rows, raw audit logs, secrets, tokens, DB URLs, payment identifiers, permission keys, entitlement keys, mismatch lists, or raw auth claims.

## 22. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It records an honest planning decision (A/B/C) with rationale and a binding isolation condition (§3).
- It defines the minimum safe candidate (§4), foundation scope (§5), test-harness scope (§6), the explicit non-implementation list (§7), and the M7C implementation boundary (§8).
- It defines the server-authorization (§9), route/API (§10), DTO/mapper (§11), read-model (§12), redaction/evidence (§13), tenant/store isolation (§14), RBAC (§15), parity-guard (§16), and no-mutation/production-exposure (§17) harness plans, plus the manual QA plan (§18), evidence requirements (§19), risk register (§20), and stop conditions (§21).
- It preserves the M2.1–M7A assumptions (two authority planes, M20 posture, redaction/evidence, isolation/RBAC, parity, C-01-first, Decision B chain).
- It claims **no** foundation/harness implementation, **no** live API, **no** live session auth, **no** Supabase auth, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, or BCP UI change was made; nothing was staged, committed, pushed, or backed up.

## 23. Recommended Next Milestone

**Phase 2.0 M7C — DEV-only Pilot Foundation and Test Harness Implementation** — implementing **only** the inert, default-off, DEV-only scaffold (flag + route/guard skeleton) and the synthetic-input test harness per §8, with **no live C-01 data integration** (which remains separately authorized). The plan cleanly separates foundation/test-harness from live data integration, satisfying the conservative condition for recommending an implementation milestone.
