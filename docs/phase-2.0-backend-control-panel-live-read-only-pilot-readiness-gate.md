# Phase 2.0 M7 — Backend Control Panel Live Read-Only Pilot Readiness Gate (DEV-only)

**Status:** Documentation/review-only · Readiness gate (does not implement or authorize a live pilot)
**Accepted checkpoint at authoring:** `8f75858fe7696d3495cbc512ab5b90469fb5d16f` (Phase 2.0 M6)
**Authoring milestone:** Phase 2.0 M7

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

This is a **documentation/review-only** readiness gate. It determines whether the project is ready to **request** a later, separately scoped **DEV-only live read-only pilot** milestone for the Backend Control Panel (BCP). It **does not implement or authorize** a live pilot, enable any live read API, enable live session authorization or Supabase auth, or approve any cutover.

**Honest finding:** the Phase 2.0 **documentation/design gates (M1–M6) are strong and complete**, but the **implementation and test gates do not exist yet** — there are no BCP live read APIs, no server DTO mappers, no read models, and no implemented parity/isolation/RBAC/redaction tests. Grounding confirms this directly: `src/backend-control-plane/` contains only UI and mock modules (no fetch/network calls, no mapper/read-model code), and the server-derived authorization flags remain default-off and non-production-only. Accordingly the decision is **Decision B — Conditionally Ready for limited DEV-only pilot planning, not implementation.**

## 2. Current State and Boundary

- **M1–M6 are complete** (architecture/gates, contract map, reconciliation, DTO design, redaction rules, isolation/RBAC test plan, auth/session parity review).
- **The BCP remains mock-only** and DEV-gated at `/dev/backend-control-plane` (`BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON`); frontend-only, read-only, code-split.
- **No live BCP read APIs exist** (no fetch/network calls in `src/backend-control-plane/`).
- **No live session auth is enabled**; **Supabase auth is not enabled**; all server identity/authz flags are default-off and non-production-only.
- **Supabase is not ready for a Firebase cutover.**
- **M7 is a readiness gate only.** Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Readiness Decision

**Decision B — CONDITIONALLY READY FOR LIMITED DEV-ONLY PILOT PLANNING, NOT IMPLEMENTATION.**

**Why:** All M1–M6 documentation/design gates pass, the two authority planes are reconciled, redaction/evidence/isolation/RBAC rules and the parity review exist, and M6's independent Codex review returned no HIGH issues (its MEDIUM findings were incorporated). However, the live read APIs, server DTO mappers, read models, and the parity/isolation/RBAC/redaction **tests are not implemented or passed**. A live pilot must not start on unimplemented, untested foundations.

**Next milestone to request:** **Phase 2.0 M7A — DEV-only Live Read-Only Pilot Implementation Plan and Gate-Closure Checklist** (planning + closure design, still not the implementation itself). The project is ready for limited DEV-only pilot **planning**, but **not implementation**, until the remaining implementation/test gates are satisfied. M8 (Supabase migration cutover readiness) remains later and separate.

## 4. Gate Summary Matrix

| Gate | Source | Required condition | Current status | Evidence | Result | Next action |
|---|---|---|---|---|---|---|
| Documentation architecture | M1 | Architecture + safety gates documented | Complete | M1 doc | PASS | — |
| Read-only contract map | M2 | C-01..C-09 contracts mapped (placeholders) | Complete | M2 doc | PASS | — |
| Authority-plane reconciliation | M2.1 | Two planes distinct; ordering corrected | Complete | M2.1 doc | PASS | — |
| DTO / read-model design | M3 | Envelope + empty-state design | Design only | M3 doc; no code in `src/backend-control-plane/` | PARTIAL | Implement mappers later |
| Redaction / evidence rules | M4 | Server-side redaction; evidence modes | Design only | M4 doc | PARTIAL | Implement + test later |
| Tenant/store isolation test plan | M5 | Server-side isolation; negative tests planned | Plan only | M5 doc | PARTIAL | Implement tests later |
| Auth/session parity review | M6 | Parity reviewed; no HIGH | Complete (review) | M6 doc; Codex no HIGH | PARTIAL | Run parity tests later |
| Implemented live API availability | — | Live read API exists | Absent | 0 network calls in BCP | BLOCKED | Build under later pilot |
| Implemented server DTO mappers | — | Mappers exist + tested | Absent | No mapper code | BLOCKED | Build under later pilot |
| Implemented read models | — | Read models exist | Absent | No read-model code | BLOCKED | Build under later pilot |
| Implemented redaction tests | — | Redaction tests pass | Absent | None | BLOCKED | Build under later pilot |
| Implemented isolation/RBAC tests | — | Isolation/RBAC tests pass | Absent | None | BLOCKED | Build under later pilot |
| Implemented parity tests | — | Parity tests pass | Absent | None | BLOCKED | Build under later pilot |
| DEV-only route gating | foundation | BCP DEV-gated | In place | `BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON` | PASS | — |
| Production exposure block | foundation | No production exposure | In place | Code-split, DEV-only, default-off | PASS | — |
| Backend action block | foundation | No mutation/actions | In place | Read-only/mock-only | PASS | — |
| Supabase cutover block | M6 | No cutover approved | In place | M6 §14 | PASS | M8 later |

## 5. Candidate Pilot Scope

Conservative classification for a future DEV-only pilot. **No contract is cleared for implementation here.**

| Contract | Classification |
|---|---|
| C-01 Readiness/posture summary | Candidate for future pilot planning (Wave 1), only after implementation + tests |
| C-02 System operations summary | Candidate for future pilot planning (Wave 1), only after implementation + tests |
| C-03 Support diagnostics summary | Candidate only after implementation tests (scope/redaction) |
| C-04 Audit visibility | Candidate only after implementation tests + sensitive-permission design |
| C-05 Configuration posture | Blocked/deferred (config/secrets) |
| C-06 Tenant / store posture | Blocked-on-schema (read model not ready) |
| C-07 Billing / plan posture | Blocked-on-schema + blocked-on-sensitive-permission design |
| C-08 Data governance posture | Candidate only after implementation tests (redaction/evidence) |
| C-09 Identity readiness posture | Candidate only after sensitive-permission design; posture-only; no raw identity / no cutover |

The least-sensitive aggregated posture contracts (C-01, C-02) are the **only** plausible first-wave candidates, and even those advance only after their mappers, redaction, isolation, and denied/empty-state tests are implemented and pass.

## 6. Contracts Not Eligible for Pilot Yet

Must remain blocked until separately satisfied/approved:

- **C-06** — tenant/store schema/read model is not ready (blocked-on-schema).
- **C-07** — billing/plan schema/read model is not ready, and sensitive-permission design is required (blocked-on-schema + sensitive).
- **C-09** — remains posture-only; ineligible if it would require exposing `identity_link` rows or enabling cutover.
- **C-05** — configuration/secrets posture remains blocked/deferred.
- **Wave 3 areas** — logs/telemetry, jobs/workers, API traffic, backups/recovery, deployments/releases, config/secrets, identity-link details — all deferred unless separately approved later with dedicated redaction/isolation design.

## 7. Authority Gate

- Firebase / legacy AccessContext remains the current frontend/app authority.
- Future live reads require the server-derived authorization principal (anchored on `internal_user_id`, provider-aware).
- No client UID/email authority.
- No live session auth enabled; no Supabase auth enabled; no cutover approved (flags default-off, non-prod-only).

**Hard fail (binding for any later implementation):** if a live read path ever falls back to a client-supplied UID, an email, or any frontend-only claim as authority, that is an immediate stop condition — the path must fail closed, never silently downgrade authority.

**Result: PARTIAL.** The authority *design* is correct and the dangerous paths are off, but the server-derived principal is not yet validated by implemented/passing parity tests for live use.

## 8. Parity Gate

- M6 returned **no unresolved HIGH**; independent **Codex review found no HIGH**; MEDIUM findings were incorporated.
- However, the **future parity tests (§16 of M6) are not implemented or passed**.

**Result: PARTIAL.** Parity is reviewed and reconciled on paper; it is not yet proven by passing tests.

## 9. Tenant / Store Isolation Gate

- M5 isolation plan exists; server-side isolation principle defined; no UI-side enforcement as a security boundary; tests planned.
- Tests are **not implemented or passed**.

**Result: PARTIAL.** Plan is sound; enforcement and negative tests are unbuilt.

## 10. RBAC Visibility Gate

- Proposed visibility classes and sensitive-section classification exist (M5); RBAC visibility test plan exists.
- Permissions remain **conceptual until implemented**; tests are **not implemented or passed**.

**Result: PARTIAL.** Model exists conceptually; nothing enforced or tested.

## 11. Redaction / Evidence Gate

- M4 redaction/evidence rules exist; server-side redaction by default; no UI-side filtering; evidence safety rules and modes defined.
- Redaction mappers/tests are **not implemented**.

**Result: PARTIAL.** Rules are complete; enforcement and tests are unbuilt.

## 12. DTO / Read Model Gate

- M3 DTO/read-model design exists; standard already-redacted envelope and empty-state design exist.
- **No DTO code, no read-model code, no mapper code** (confirmed: `src/backend-control-plane/` has only UI/mock modules).

**Result: PARTIAL.** Design complete; implementation absent.

## 13. Runtime / Route / API Gate

- BCP DEV route remains gated (`BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON`); BCP is mock-only.
- No live read APIs exist; no backend endpoints implemented; no production exposure.

**Result: PASS** for the *safety* posture (correctly closed/mock-only). Live API availability itself is intentionally **BLOCKED/absent** and is a separate implementation gate (see §4).

## 14. Data Source Readiness Gate

| Data source category | Classification |
|---|---|
| Readiness / status posture | Documentation-ready only; candidate for future read model |
| System operations posture | Documentation-ready only; candidate for future read model |
| Support diagnostics posture | Candidate for future read model; blocked-on-redaction until tested |
| Audit visibility aggregate | Blocked-on-redaction (net-new server-composed redacted aggregate) |
| Configuration posture | Blocked/deferred (config/secrets) |
| Tenant / store posture | Blocked-on-schema |
| Billing / plan posture | Blocked-on-schema |
| Data governance posture | Blocked-on-redaction |
| Identity readiness posture | Blocked-on-parity (posture-only; no raw identity; no cutover) |

## 15. Evidence Required Before Implementation

Before any future pilot implementation may start:

- Accepted readiness gate (this document, accepted + backed up).
- No unresolved HIGH risks.
- No open MEDIUM affecting the pilot scope.
- Server-principal readiness proof (validated server-derived principal for the pilot scope).
- Implemented DTO mapper tests (passing).
- Implemented redaction tests (passing).
- Implemented isolation/RBAC tests (passing).
- Implemented parity tests (passing).
- No-mutation proof.
- No-production-exposure proof.
- Safe empty-state proof.
- Redacted-evidence proof.

## 16. M7A / Next Implementation Scope Recommendation

Given **Decision B**, recommend:

**Phase 2.0 M7A — DEV-only Live Read-Only Pilot Implementation Plan and Gate-Closure Checklist** — a planning/closure milestone that enumerates the exact implementation steps, the per-contract gate-closure checklist, and the passing-evidence required, **still without implementing the pilot**. The actual implementation remains a later, separately scoped and accepted milestone, beginning (if approved) with the least-sensitive Wave 1 contracts (C-01/C-02) under the §17 guardrails.

## 17. Pilot Guardrails if Later Authorized

Any later DEV-only pilot must hold all of:

- DEV-only.
- Default-off flag.
- No production exposure.
- No normal SaaS navigation exposure.
- Read-only only.
- No backend actions.
- No writes.
- No DB mutation.
- No Supabase cutover.
- No raw identifiers.
- No raw audit logs.
- No raw `identity_link` rows.
- No payment/provider identifiers.
- No secrets/tokens/DB URLs.
- Fail closed.
- Safe empty states.
- Redacted evidence only.

## 18. Risk Register

| ID | Risk | Severity | Current status | Mitigation | Gate result |
|---|---|---|---|---|---|
| R-1 | Authority-plane confusion | High | Mitigated by design (M2.1/M6) | Planes distinct; server authz token→`internal_user_id` only | PARTIAL |
| R-2 | Parity tests not implemented | High | Open | Implement + pass before pilot | PARTIAL |
| R-3 | Isolation tests not implemented | High | Open | Implement + pass before pilot | PARTIAL |
| R-4 | RBAC permissions only conceptual | Medium | Open | Implement + map to catalog; fail closed | PARTIAL |
| R-5 | DTO mappers not implemented | Medium | Open | Build mappers with redaction + tests | PARTIAL |
| R-6 | Redaction tests not implemented | High | Open | Implement + pass before pilot | PARTIAL |
| R-7 | Schema / read-model gaps (C-06/C-07) | Medium | Open | Blocked-on-schema; defer | BLOCKED |
| R-8 | Premature pilot | High | Mitigated by ordering | M7 gate precedes any pilot; Decision B | PARTIAL |
| R-9 | False Supabase readiness claim | Medium | Mitigated by documentation | Explicit "not ready / no cutover" | PASS |
| R-10 | Accidental production exposure | High | Mitigated by posture | DEV-gated, code-split, default-off | PASS |
| R-11 | Backend action leakage | High | Mitigated by posture | Read-only/mock-only; no mutation | PASS |
| R-12 | Raw data leakage | High | Mitigated by rules | M4 redaction; no raw payloads | PASS (rules) / PARTIAL (tests) |

R-2, R-3, and R-6 are **unresolved HIGH implementation blockers** — they must be closed (implemented and passing) before any live pilot implementation. They are acceptable for **accepting this documentation-only planning gate** (Decision B) precisely because the gate's purpose is to record them as blockers, not to clear them. No HIGH risk is dismissed or treated as closed; the remaining HIGH items are explicitly carried forward as pilot-implementation prerequisites.

## 19. Codex Review Result

Codex (gpt-5.5) was invoked as an independent read-only reviewer of this readiness gate (its shell sandbox is environment-blocked, so the document text was reviewed inline). **Codex returned NO HIGH ISSUES**, so there is no blocker. It raised two MEDIUM and three LOW observations; the substantive ones were reconciled into this document (the §18 open-HIGH wording was clarified, this §19 result was made self-contained, the client-UID/email fallback hard-fail was added to §7/§20, and the §20 stop conditions were expanded to match the redaction promise). Codex modified no files. A HIGH issue would have been a blocker until reconciled; none was found.

## 20. Stop Conditions

Halt and reassess if readiness would require any of:

- Live DB access.
- Supabase MCP.
- Enabling live session auth.
- Enabling Supabase auth.
- A cutover.
- Implementing APIs (within this gate milestone).
- Raw IDs.
- Raw `identity_link` rows.
- Raw audit logs.
- Payment identifiers.
- Raw permission/entitlement key lists.
- Raw auth claims, raw provider UIDs, or mismatch lists.
- DB URLs, provider credentials, tokens, or secrets.
- Any fallback to a client-supplied UID, email, or frontend-only claim as authority (must fail closed).
- UI-side security filtering.
- Treating unimplemented tests as passed.
- Production exposure.
- Backend actions.

## 21. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It states an honest readiness decision (A/B/C) with rationale (§3) and does not force a "ready" answer.
- It provides the gate summary matrix (§4), candidate pilot scope (§5), ineligible contracts (§6), and per-gate evaluations (§7–§14) with PASS/PARTIAL/BLOCKED results.
- It defines the evidence required before implementation (§15), the M7A recommendation (§16), pilot guardrails (§17), the risk register (§18), the Codex review result (§19/report), and stop conditions (§20).
- It preserves the M2.1–M6 assumptions (two authority planes, redaction/evidence, isolation/RBAC, parity, M20 posture).
- It claims **no** live API implementation, **no** live session auth, **no** Supabase auth, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, or BCP UI change was made; nothing was staged, committed, pushed, or backed up.

## 22. Recommended Next Milestone

**Phase 2.0 M7 — Scoped Commit and Backup Authorization** (to commit/back up this gate), then **Phase 2.0 M7A — DEV-only Live Read-Only Pilot Implementation Plan and Gate-Closure Checklist** (planning/closure, not implementation).
