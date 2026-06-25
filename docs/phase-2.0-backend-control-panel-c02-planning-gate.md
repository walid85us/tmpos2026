# Phase 2.0 M8 — C-02 Planning Gate (Backend Control Panel)

**Status:** Documentation / planning only. No code, tests, UI, route, DTO, or backend behavior was changed. This milestone selects the next C-02 readiness slice after frozen C-01, classifies its risk, and decides the next planning step. It does **not** implement C-02.

**Accepted checkpoint:** `5a1f0de8aebd242778fc626c747ef4c0c02a586b`
**Most recent committed milestone:** Phase 2.0 M7QC — C-01 baseline freeze.

---

## 1. Executive Summary

The recommended C-02 direction is **Candidate A — Backend CP Route / Module Registry Readiness Lens**: a read-only, DEV-only, code/config-only lens that inventories the existing Backend CP modules, route boundaries, feature flags, and readiness-state coverage. It is the **safest** next slice (same code/config, no-DB risk class as the frozen C-01) while adding genuinely **new operational value** (a registry/map rather than a single readiness summary). Implementation is **not** authorized by this gate. Decision: **Decision A — PASS: C-02 candidate selected and ready for source inventory / schema readiness review.** Recommended next milestone: **Phase 2.0 M8A — C-02 Source Inventory and Schema Readiness Review.**

## 2. C-01 Freeze Context

M8 begins only after C-01 was frozen (M7QC, `5a1f0de`) as the **Phase 2.0 DEV QA baseline** — not production-ready, not a C-02 authorization. Frozen C-01 is: DEV-only, default-off (`ENABLE_BCP_DEV_READONLY_PILOT`), production-disabled, isolated in the Backend CP area, read-only, GET-only success (`/dev/bcp/readiness-summary` via proxy `/__identity/...`), code/config posture only, v1 code/config DTO with v0 synthetic compatibility, hardened client parser, safe labels only, no DB/Supabase/provider/live source, no backend actions, no mutation, no production exposure; 106/106 tests; 0 C-01 touched-file type errors. Global constraints unchanged: Firebase/legacy AccessContext remains app authority; Supabase dormant/readiness-only; no cutover; controlled actions = Phase 3; production = Phase 4.

## 3. Planning Decision

**Decision A — PASS: C-02 CANDIDATE SELECTED AND READY FOR SOURCE INVENTORY / SCHEMA READINESS REVIEW.**

A clear, low-risk C-02 candidate is selected (Candidate A). This gate authorizes only the **next planning step** (source inventory / schema readiness review) — **not** C-02 implementation.

## 4. Candidate Evaluation Matrix

| Candidate | Purpose | Source Type | Value | Safety | DB/Supabase Dep. | Data Sensitivity | Impl. Complexity | Redaction Need | RBAC/Visibility Need | Recommended Status |
|---|---|---|---|---|---|---|---|---|---|---|
| **A — Route/Module Registry Readiness Lens** | Inventory BCP modules, route boundaries, flags, readiness coverage | code/config/static | High (new operational map) | High | None | Low (operational metadata) | Low–Med | Low (bounded labels) | System Owner only | **SELECTED (primary)** |
| **E — Feature Flag / Environment Posture Lens** | Summarize flag/DEV-gate/production-disabled/env posture | code/config/static | Medium (overlaps C-01) | High | None | Low | Low | Low | System Owner only | Strong secondary (could be a sub-lens of A) |
| **B — Tenant/Store Boundary Readiness Lens** | Show tenant/store readiness for live integration | DB/Supabase/identity (later) | High | Low (until gated) | High | High (tenant rows) | High | High | Strict; not yet | Deferred — needs source inventory + redaction foundation first |
| **C — Platform Identity / Session Authorization Lens** | Identity/session posture | platform_identity / session resolver | High | Low | High | Very high (UIDs, claims) | High | Very high | Strict; not yet | Deferred — highest risk; defer until B-class foundations proven |
| **D — Audit / Evidence Readiness Lens** | Summarize audit/evidence posture | audit_event / evidence (later) | High (compliance) | Low | High | High (audit rows) | High | Very high (aggregation) | Strict; not yet | Deferred — needs strong aggregation/redaction rules first |

## 5. Recommended C-02 Candidate

**Primary: Candidate A — Backend CP Route / Module Registry Readiness Lens.**

Why it is the best next step after C-01:
- **Same safe risk class as frozen C-01.** It reads only code/config/static metadata — no DB, no Supabase, no provider, no live source — so it inherits C-01's proven safety envelope and introduces no new sensitive-source risk.
- **New value beyond C-01.** C-01 is a single readiness *summary*; Candidate A is a *registry/map* of the Backend CP surface (modules, route boundaries, feature flags, readiness coverage), improving operational visibility and preparing a future, carefully gated live-read expansion.
- **Generalizes the proven pattern.** C-01 validated the DEV-only, default-off, GET-only, bounded-label, additive-DTO, hardened-client pattern for one resource. Candidate A reuses that exact pattern for an inventory view — low marginal risk, high reuse.
- **Why code/config-only is safer before live DB reads:** it requires no new authority plane, no DB credentials, no tenant data, and no redaction of live rows; the sensitive candidates (B/C/D) must wait until a dedicated source inventory + redaction/RBAC foundation is approved.

Candidate E is a strong secondary but overlaps C-01's existing `feature_flag_posture` / `production_disabled_posture` categories; it is best folded into Candidate A as a sub-lens rather than run standalone.

## 6. C-02 Scope Boundary

C-02 (Candidate A) **may later become**, only under separate authorization, a DEV-only read-only registry lens over code/config metadata of the Backend CP surface. Explicitly out of scope / binding constraints:
- C-02 planning does **not** implement C-02.
- C-02 is **not** production-ready.
- C-02 must remain **DEV-only** until separately authorized.
- C-02 must remain **read-only** until Phase 3.
- C-02 must **not** create mutation capability.
- C-02 must **not** expose raw tenant/store/customer/identity/audit data.
- C-02 must **not** approve Supabase auth.
- C-02 must **not** approve Firebase-to-Supabase cutover.

## 7. Source Inventory Requirements for Next Milestone (M8A)

The source inventory / readiness review must inspect (read-only):
- **Source files:** `server/bcp-pilot/*` (authorization guard, pilot config, readiness harness, read-only route, express adapter, C-01 code/config read model) and `src/backend-control-plane/*` (shell, app, screens, env, client, UI, types) — to enumerate the registry's static inputs.
- **Route boundaries:** `/dev/bcp/readiness-summary` (API) and `/dev/backend-control-plane` (shell), plus how routes are registered/gated.
- **Feature flags:** `ENABLE_BCP_DEV_READONLY_PILOT` (server pilot), `VITE_ENABLE_BACKEND_CONTROL_PLANE` (frontend shell), and the `BCP_ROUTE_ENABLED = IS_DEV && BCP_FLAG_ON` gate.
- **DTO/schema candidates:** an additive registry DTO (version-aware, bounded labels) — design only.
- **Existing test files:** `server/bcp-pilot/*.test.ts`, `src/backend-control-plane/bcpC01Client.test.ts` — as patterns to mirror.
- **Redaction requirements**, **RBAC/visibility requirements**, **error categories**, **empty-state behavior**, **safe labels**, **no-live-data constraints**, **DB/Supabase boundary** — confirm each is satisfiable with code/config-only sources.

## 8. Data Classification

| Class | Examples for Candidate A | Disposition |
|---|---|---|
| Public-safe labels | module names (bounded), `enabled`/`ready`/`production_disabled` statuses, route-registered boolean posture | **Allowed** (bounded labels) |
| Internal operational metadata | flag presence (boolean), readiness coverage counts | **Allowed if aggregated/bounded** (no values) |
| Tenant-sensitive data | tenant/store/customer rows | **Blocked** (out of scope for Candidate A) |
| Identity-sensitive data | internal_user_id, provider UIDs, auth claims, identity_link rows | **Blocked** |
| Audit-sensitive data | audit_event rows | **Blocked** |
| Secrets/credentials | DB URLs, tokens, service-role keys | **Blocked** |
| Prohibited raw values | raw IDs, emails, domains, payment identifiers, row dumps, raw errors/stack traces | **Blocked** |

Candidate A is designed so that **only the top two classes** are ever produced; everything else is structurally out of its (code/config) source.

## 9. Redaction / Masking Rules

For any future C-02 output, the following must never render and must be redacted/blocked (reusing C-01's `safeLabel` allow-list + denylist + id-shape + whitespace guards, and a `redacted_label`-style sentinel): raw IDs; internal_user_id; provider UIDs; auth claims; identity_link rows; audit rows; permission keys; entitlement keys; mismatch lists; secrets; tokens; DB URLs; emails; domains; payment identifiers; tenant/store/customer rows; row dumps; stack traces; raw errors. Output is restricted to bounded posture/label values; any value failing the safe-label rules becomes a neutral sentinel, never the raw value.

## 10. RBAC / Visibility Planning

- **System Owner only** by default for the first DEV slice (no other roles) unless separately justified.
- **No tenant user access**; **no customer-facing access**; **no normal SaaS navigation exposure**.
- Feature-flag gates (`VITE_ENABLE_BACKEND_CONTROL_PLANE` + DEV, and the server pilot flag) **remain required**.
- Backend CP **area isolation remains required**.
- Future RBAC/visibility must be **server-derived**, never relying on client-supplied identity authority (mirrors C-01).

## 11. Route / API Boundary Planning (design only — not implemented)

If C-02 later gains a route, it must mirror C-01's boundary: DEV-only; default-off flag required; production-disabled; GET-only success; HEAD/OPTIONS handled safely; mutation methods blocked (405); server-side authorization guard; parity/blocked handling where applicable; safe bounded error categories; no raw errors. Isolated to the platform-identity API (or an equally isolated DEV surface), never the main SaaS server, never the client bundle.

## 12. DTO / Schema Planning (design only)

Future C-02 DTO principles: additive versioning; `sourceMode` honesty (e.g. `code_config`); freshness labels (e.g. `code-config-no-live-read`); bounded labels only; explicit empty-state handling; a `redacted_label`-equivalent sentinel for unsafe values; v0/v1 compatibility if a synthetic path exists; unknown-schema compatibility (shape-based classification); no raw IDs/secrets; no row dumps.

## 13. Test Plan for Future C-02 Implementation (before any build)

Required test categories (mirroring the C-01 suites): route boundary tests (DEV/flag gating, GET success, 405 mutations, HEAD/OPTIONS); DTO/schema tests (v1 fields, additive, v0 compatibility, unknown schema); client/parser tests; redaction tests (forbidden substrings, id-shaped, email/token, whitespace); unsafe/malicious payload tests; fetch behavior tests (GET-only, no body, `credentials:'omit'`, no auth/identity); no-mutation tests; no DB/Supabase tests unless separately authorized later; production-disabled tests; typecheck / touched-file checks (0 new errors).

## 14. Manual QA Planning (later)

DEV route access only; idle state; unavailable / feature-disabled states; success state; no auto-fetch; safe labels only; no destructive controls; no normal SaaS navigation exposure; no customer-facing exposure; no raw sensitive data. (Owner pixel-level visual evidence handled per the C-01 precedent: capture or explicit owner acceptance of automated/transport evidence.)

## 15. Stop Conditions (block future C-02 work)

DB/Supabase access appearing without an approved source inventory; raw IDs or secrets exposed; tenant/customer rows exposed; production route exposure; normal SaaS navigation exposure; customer-facing exposure; mutation capability; backend actions; auth/cutover implication; route registration changed unexpectedly; test failure; typecheck touched-file errors; incomplete source classification; incomplete redaction rules; undefined RBAC/visibility.

## 16. Explicit Non-Readiness Statements

- C-02 is **not** implemented.
- C-02 planning does **not** authorize C-02 implementation.
- Backend CP is **not** production-ready.
- Supabase auth is **not** enabled.
- Firebase-to-Supabase cutover is **not** approved.
- Live session authorization is **not** enabled.
- DB/Supabase live reads are **not** implemented.
- Backend actions are **not** implemented.
- Mutation capability is **not** implemented.
- Phase 3 controlled actions are **not** started.
- Phase 4 production hardening is **not** started.

## 17. Recommended Next Milestone

**Phase 2.0 M8A — C-02 Source Inventory and Schema Readiness Review** (read-only inventory of the Candidate A code/config sources, DTO/schema readiness, redaction/RBAC confirmation — still no implementation). *(Procedural step first: Phase 2.0 M8 — Scoped Commit and Backup Authorization for this planning document.)*

## 18. Acceptance Criteria for M8

- One docs file only; no code/test/runtime changes; no DB/Supabase/live access; no C-02 implementation.
- A C-02 candidate is selected (Candidate A) with rationale.
- Source inventory needs, data classification, redaction rules, and RBAC/visibility needs are defined.
- Stop conditions defined; next milestone recommended.

All criteria are met.

---

*Documentation/planning only. No code, tests, UI, route, DTO, or backend behavior was changed; C-02 was not implemented. No DB connection, SQL, migration, Supabase access, Supabase MCP, live provider, or production call occurred; no commit/push/backup was performed. This document does not implement C-02, does not modify route behavior, does not claim C-02 is implemented, does not claim live session auth or Supabase auth is enabled, does not claim the Backend Control Panel is production-ready, does not authorize production deployment, and does not claim Supabase is ready for a Firebase cutover. No real tenant/store/customer data, raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission/entitlement key lists, mismatch lists, secrets, tokens, DB URLs, emails, domains, or payment identifiers appear herein.*
