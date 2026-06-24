# Phase 2.0 M1 — Backend Control Panel Live Read-Only Architecture & Safety Gates Plan

**Status:** Documentation-only · Architecture + gates only (no live integration implemented)
**Accepted checkpoint at authoring:** `0a796f01aa75d98d4afccf05ad8615f8b2a0b18a` (M31)
**Authoring milestone:** Phase 2.0 M1

> Redaction-first document. Contains no real tenant/store/customer data, raw IDs,
> row dumps, emails, domains, DB URLs, tokens, secrets, payment identifiers,
> permission/entitlement key lists, or mismatch lists. This milestone makes no
> runtime, route, auth, DB, Supabase, or Backend Control Panel (BCP) UI change.

---

## 1. Executive Summary

Phase 2.0 begins the move of the Backend Control Panel from its Phase 1.6 read-only/mock-only foundation toward **live read-only data integration** — but this milestone (M1) defines **architecture and safety gates only**. No live API, read model, DB connection, Supabase call, or UI change is implemented here. The BCP remains DEV-gated, read-only, mock-only, frontend-only, and code-split. Firebase / the legacy AccessContext remains authoritative; Supabase remains dormant/shadow/readiness-only. This plan establishes which screens may receive live read-only data first, what server-side contracts/read models/redaction are required, and the isolation, RBAC, audit, environment, and testing gates that must pass before any live data is wired.

## 2. Phase 2.0 Objective

Define the safe architecture for **live read-only Backend CP data integration**. Phase 2 is explicitly **not** backend control actions (Phase 3) and **not** production release (Phase 4). The objective is observational, governed, redacted, read-only visibility — server-authoritative, tenant/store-isolated, and DEV/STAGING-gated — with a clear, gated path toward Supabase migration *readiness* (not cutover).

## 3. Current State

- Backend CP foundation **closed at M31** (Phase 1.6 M21–M31 complete and backed up).
- Current checkpoint: `0a796f01aa75d98d4afccf05ad8615f8b2a0b18a`.
- Backend CP is **DEV-review ready**.
- Backend CP is **still mock-only** (all data static/local).
- **Firebase remains authoritative**; legacy AccessContext unchanged.
- **Supabase not ready for cutover** (dormant/shadow/readiness-only).
- M20 identity-link / DEV test-data registry stream remains **paused**.
- DEV-gated route `/dev/backend-control-plane`; 33-module registry; 20 implemented read-only/mock-only screens; 13 placeholder/deferred/blocked modules; all 13 DEV-review areas covered; code-split preserved.

## 4. Readiness Boundary

| Stage | Verdict | Meaning |
|-------|---------|---------|
| DEV review | **Ready** | Read-only/mock-only review complete. |
| Live read-only | **Not Ready — this is Phase 2 work** | Requires the gates in §6–§13 below. |
| Supabase migration | **Not Ready** | Firebase authoritative; cutover gated (§12). |
| Controlled backend actions | **Not Ready — Phase 3** | Mutations/approvals/audit-write deferred (§16). |
| Production | **Not Ready — Phase 4** | Hardening/UAT/release gated (§17). |

These five readiness states are kept strictly distinct so "DEV-review ready" is never read as "live-ready" or "production-ready."

## 5. Candidate Screens for Phase 2 Live Read-Only Integration

Integration proceeds in waves, safest first. Each wave is independently gated; a screen advances only after the §6–§13 gates pass for its data.

**Wave 1 — safest read-only candidates (aggregated posture, low sensitivity):**
- Readiness gate status
- System operations summary
- Audit visibility summary (redacted)
- Support / diagnostic posture
- Static configuration metadata where safe

**Wave 2 — governed tenant/store/billing visibility (aggregated, redacted, isolation-gated):**
- Tenant / store posture
- Billing / plan posture
- Data governance posture
- Identity readiness posture

**Wave 3 — higher-risk or deferred (requires stronger gates or remains blocked):**
- Identity-link details
- Jobs / workers
- API traffic
- Logs / telemetry
- Backups / recovery
- Deployments / releases
- Config / secrets
- Any screen requiring real identifiers or sensitive operational detail

## 6. Read-Only API Contract Principles

Rules for any future BCP-facing API:
- **GET / read-only only**; no mutation endpoints.
- **No POST/PUT/PATCH/DELETE.**
- **Server-side authorization required** on every call (never client-trusted).
- **Tenant/store isolation enforced server-side.**
- **Response minimization** — return only what the screen needs.
- **Redaction by default.**
- **No raw secrets**, no payment identifiers, no unrestricted row dumps.
- **No permission/entitlement key dumps**; **no mismatch lists** exposed to the UI.
- **Stable DTOs** (versioned, additive), decoupled from table shape.
- **Explicit environment scope** on every contract (DEV/STAGING).
- **Audit-safe read tracking** where appropriate (read access observable without leaking subjects).

## 7. Server-Side Read Model Principles

- **Backend-owned read models** — the server composes what the UI sees.
- **Aggregated posture summaries preferred** over row-level detail.
- **No direct table passthrough** to the client.
- **No client-side filtering for security** (filtering is a presentation concern, never an authorization boundary).
- **No client-supplied UID authority** — the client cannot assert who it is.
- **`internal_user_id` remains the stable application anchor.**
- **Provider-aware identity model preserved** (provider identity ≠ authority by itself).
- **Email is never identity authority.**
- **Tenant/store boundaries resolved server-side** from the authenticated principal.

## 8. Redaction and Masking Policy

Data is classified into categories; only the safe categories may reach the UI:
1. **Public-safe labels** — safe for the read-only UI (e.g. status categories, posture labels).
2. **Internal-safe metadata** — safe aggregated/operational metadata (counts, states).
3. **Sensitive operational metadata** — masked/aggregated only; never raw.
4. **Restricted security/auth data** — blocked from the UI unless explicitly approved and redacted.
5. **Blocked secrets / payment / provider tokens** — never exposed.
6. **Blocked raw identifiers** — blocked unless explicitly approved with a documented justification.

## 9. Tenant and Store Isolation Gates

Required validations before any live data is wired:
- **Tenant scope cannot bleed across tenants.**
- **Store scope cannot bleed across stores.**
- **Cross-tenant admin views require explicit platform permission** (not implied by BCP access).
- **No UI-only enforcement** — isolation is enforced server-side.
- **Server-side tests required** for every read path.
- **Negative tests required** (attempted cross-tenant/store access must fail closed).
- **Redacted evidence required** for sign-off (no raw rows in evidence).

## 10. RBAC Visibility Gates

- Define **who may view the Backend CP** at all.
- Define **which platform roles may view which sections.**
- **Sensitive screens require stronger permission** than general posture screens.
- **Read-only visibility is not action authorization** — viewing never implies the right to act.
- **No Phase 3 action permission is implied or granted** by any Phase 2 visibility grant.

## 11. Audit Visibility Gates

- **Audit summaries may be live-read-only after redaction.**
- The **audit writer is not changed in Phase 2.0.**
- **No audit-write capability** exists in the Backend CP.
- **No evidence-ingestion capability** is added.
- Any future **audit read API must be redaction-safe** (no raw subjects, IDs, or payloads).

## 12. Supabase Migration Readiness Gates

Supabase cutover is **not part of this milestone**. Future readiness requires all of:
- **Firebase vs Supabase auth/session parity** validated.
- **Identity mapping validation** (provider identity → `internal_user_id`).
- **`platform_identity` / `identity_link` safety review** (the M20 stream remains paused until separately approved).
- **No email authority.**
- **No client-supplied UID authority.**
- **RLS review** (row-level security correctness).
- **Shadow comparison** (Supabase observed alongside Firebase, non-authoritative).
- **Rollback strategy** proven.
- **DEV/STAGING validation** passed.
- **Explicit cutover approval gate** before any production consideration.

## 13. Environment Strategy

- **DEV first**, then **STAGING**.
- **Production blocked until Phase 4.**
- **Feature flags required** for any live read-only wiring.
- **Kill switch required** (instant revert to mock/no-data).
- **No production exposure during early Phase 2.**
- **No normal SaaS navigation exposure** until separately approved.

## 14. Testing Strategy

Future tests (planned here; none run in this milestone):
- **Unit tests for read-model mappers.**
- **Authorization tests** (allowed vs denied per role/scope).
- **Tenant/store isolation tests.**
- **Redaction tests** (no restricted category leaks).
- **Negative tests** (cross-tenant/store and over-privilege attempts fail closed).
- **No live mutation tests** (no mutation exists).
- **No production tests.**
- **No migrations in this planning milestone.**

## 15. Phase 2 Implementation Sequence

Recommended milestones (documented only; not implemented now):
- **Phase 2.0 M1** — Live Read-Only Architecture & Safety Gates Plan *(this milestone)*
- **Phase 2.0 M2** — Read-Only API Contract Map
- **Phase 2.0 M3** — Read Model and DTO Design
- **Phase 2.0 M4** — Redaction / Masking / Evidence Rules
- **Phase 2.0 M5** — Tenant / Store Isolation Test Plan
- **Phase 2.0 M6** — Backend CP Live Read-Only Pilot, DEV-only
- **Phase 2.0 M7** — Firebase vs Supabase Auth/Session Parity Review
- **Phase 2.0 M8** — Supabase Migration Cutover Readiness Gate
- **Phase 2.0 M9** — DEV/STAGING UAT and Release Decision

## 16. Phase 3 Boundary

Phase 3 (controlled backend actions) is required — and remains blocked until then — for:
- Controlled actions
- Approvals
- Reason capture
- Audit write
- Rollback
- Mutation APIs
- Permission-gated execution

## 17. Phase 4 Boundary

Phase 4 (production hardening & release readiness) is required — and remains blocked until then — for:
- Production hardening
- Monitoring / logging
- Incident response
- Security review
- UAT
- Production release approval

## 18. Stop Conditions

Halt and reassess if any of the following arise during Phase 2:
- Any need for **mutation**.
- Any need for **raw secrets**.
- Any **cross-tenant leakage risk**.
- Any **auth authority ambiguity**.
- Any **Supabase/Firebase mismatch**.
- Any **production exposure pressure**.
- Any **unredacted evidence need**.

## 19. Acceptance Criteria for Phase 2.0 M1

This planning milestone is complete when:
- The single planning document exists under `docs/` and is redaction-safe.
- It defines the live read-only architecture and the §6–§13 safety gates.
- It classifies candidate screens into Wave 1 / Wave 2 / Wave 3.
- It states the Supabase position (Firebase authoritative; no cutover in Phase 1.6/early Phase 2).
- It separates DEV-review, live-read-only, Supabase-migration, controlled-action (Phase 3), and production (Phase 4) readiness.
- No runtime, route, auth, DB, Supabase, or BCP UI change was made; nothing was committed/pushed/backed up.

## 20. Recommended Next Milestone

**Phase 2.0 M2 — Backend Control Panel Read-Only API Contract Map.**
