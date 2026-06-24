# Phase 2.0 M2.1 — Pre-M3 Backend Control Panel Design Reconciliation

**Status:** Documentation-only · Controlling preamble for Phase 2.0 M3
**Accepted checkpoint at authoring:** `ece1f7f01fff556506350b81464f042d603ff9fe` (Phase 2.0 M2)
**Authoring milestone:** Phase 2.0 M2.1

> Redaction-first. No real tenant/store/customer data, raw IDs, row dumps, emails,
> domains, DB URLs, tokens, secrets, payment identifiers, permission/entitlement
> key lists, or mismatch lists. No runtime, route, auth, DB, Supabase, DTO/type,
> read-model, or Backend Control Panel (BCP) UI change is made by this milestone.

---

## 1. Executive Summary

A consolidated pre-M3 backend re-review found the **implemented BCP code is safe and GO (no blockers)**, but the Phase 2.0 design docs (M1 gates, M2 contract map) carry three HIGH consistency gaps that must be reconciled before M3 designs read models and DTOs. This document resolves those gaps and records the medium items as mandatory M3 design inputs. It is the controlling preamble for Phase 2.0 M3.

## 2. Review Outcome

- **Code / safety review: GO — no blockers.**
- BCP remains **DEV-gated, read-only, mock-only, frontend-only, code-split**.
- **No** fetch, DB, Supabase, forms, mutation primitives, or production exposure.
- **33-module registry remains consistent** (20 included ↔ 20 screens; placeholders fall through).
- **Focus-visible accessibility present** on every interactive control.
- **0 new BCP type errors** (tsc at 12 pre-existing baseline).
- Only Low/Nit cosmetic findings exist (see §12); none affect the safety envelope.

## 3. Decision

**Decision B — small documentation reconciliation before M3.**
**M3 must not proceed until this reconciliation is accepted and backed up.**

## 4. HIGH-1 — Authority Plane Reconciliation

There are **two distinct authority planes**; the M2 contract map conflated them.

**Frontend / app authority plane:**
- Firebase / legacy AccessContext remains the **current frontend application authority**.
- **No Firebase→Supabase cutover is approved.**
- **No production auth authority change** occurs in Phase 2.0 M2.1.

**Server-side BCP read authorization plane:**
- Future BCP read APIs must authorize from the **server-derived authorization principal**.
- The server-derived path is based on the **platform identity model** and the **`internal_user_id` anchor**.
- Supabase-token-driven server authorization is **dormant / flag-gated / shadow / readiness-gated** until explicitly enabled.
- BCP read APIs must **not rely on Firebase frontend session claims** as the final server authorization authority.
- **Client-supplied UID must never be authority.**
- **Email must never be authority.**
- **Provider-aware identity mapping must be preserved.**

**Corrected design language:**
- Do **not** state that future BCP read APIs are authorized by the "Firebase frontend session" alone.
- State instead: **Firebase remains the current frontend/app authority, while future BCP live read APIs must use the server-derived authorization principal after parity/safety gates pass.**

## 5. C-09 Identity Readiness Contract Correction

The Identity Readiness posture contract (C-09) must report readiness **without implying Supabase cutover**. C-09 represents:
- Firebase frontend/app authority remains current.
- Supabase auth remains **dormant / shadow / readiness-only**.
- Server-derived principal readiness is **gated**.
- `identity_link` is **schema-present in DEV but not used for live write/control flows**.
- `identity_link` rows are **not exposed**.
- **No raw provider UID dumps.**
- **No raw `identity_link` rows.**
- **No email authority.**
- **No client-supplied UID authority.**
- **M20 write exercise remains blocked / paused.**

(The earlier `sessionAuthority: "firebase"` field described the wrong layer; the field is reframed as frontend-app authority, distinct from the server-derived API authorizer.)

## 6. HIGH-2 — Phase 2 Ordering Reconciliation

The entry plan ordered Parity-before-Pilot; Phase 2.0 M1 §15 had reordered Pilot-before-Parity. **Controlling order (this document wins):**

| Milestone | Title |
|-----------|-------|
| Phase 2.0 M3 | Read Model and DTO Design |
| Phase 2.0 M4 | Redaction, Masking, and Evidence Rules |
| Phase 2.0 M5 | Tenant / Store Isolation and RBAC Visibility Test Plan |
| Phase 2.0 M6 | Firebase vs Supabase Auth / Session Parity Review |
| Phase 2.0 M7 | Backend CP Live Read-Only Pilot, DEV-only |
| Phase 2.0 M8 | Supabase Migration Cutover Readiness Gate |
| Phase 2.0 M9 | DEV/STAGING UAT and Release Decision |

**Rationale:**
- A live pilot **must not depend on an unvalidated server principal**.
- **Parity review (M6) must occur before any live read-only pilot (M7)** that relies on the server-derived principal.
- A Wave-1-only pilot before parity **may be considered only if** it uses no Supabase/server-derived auth dependency **and** is explicitly approved — this is **not** the default plan.

## 7. HIGH-3 — M20 / identity_link Posture Reconciliation

Precise M20 posture (replaces the vague "paused" label):
- `004_identity_link` migration **exists / applied in DEV as a schema-only foundation**.
- `identity_link` is **empty** unless separately proven otherwise.
- `identity_link` has **RLS protection**.
- `identity_link` is **not exposed to the BCP**.
- `identity_link` **write / control exercise remains blocked / paused**.
- Service / repository / audit adapters **exist and are tested but dormant / unwired**.
- **No live identity-link provisioning is authorized.**
- **No identity-link write capability is available in the BCP.**
- M20 is **not "absent"; it is partially built, dormant, and paused at the controlled DB write exercise.**

## 8. Medium Items to Carry into M3 (mandatory design inputs)

- **BCP-access / sensitive-view / cross-tenant RBAC are net-new** and must be mapped to the existing permission catalog (server-derived authorization model), not invented casually.
- **Tenant / store / billing live contracts are blocked-on-schema / read-model readiness**, not merely "governed" (the backing tables do not exist yet).
- **C-04 audit visibility is a net-new server-composed redacted aggregate** — the existing audit foundation is append/write-focused; there is no audit read path.
- **Redaction must remain server-side.**
- **UI must consume already-redacted safe-label DTOs only.**
- **DTOs must map into existing safe UI shapes** without carrying raw values.
- **Live empty results require explicit empty-state DTO design** — do not rely on non-empty mock-array assumptions.

## 9. Optional Code Nits Deferred (non-blocking; not fixed here)

- `useState<EnvLabel>('DEV')` type widening.
- `MODULES[1]` magic-index fallback.
- Stale "23-module" comments (registry is 33).
- Duplicated KPI literals.

These are recorded as deferred and **not** fixed in this documentation-only milestone.

## 10. Corrected Phase 2 Sequence

The §6 table is the **controlling Phase 2.0 sequence (M3→M9)** unless changed by a later accepted milestone. Key correction vs. the M1 sequence: **Parity Review (M6) precedes the Live Read-Only Pilot (M7)**.

## 11. M3 Design Constraints

Phase 2.0 M3 must incorporate all of:
- **Two authority planes** (frontend-app = Firebase; BCP read API = server-derived principal).
- **Server-derived BCP read authorizer** (`internal_user_id` anchor; no Firebase-session, client-UID, or email authority).
- **Parity before live pilot.**
- **Precise M20 posture** (schema-applied/empty/RLS-protected/unwired/write-blocked).
- **Server-side redaction.**
- **Blocked-on-schema Wave 2 contracts** (tenant/store/billing).
- **Net-new RBAC visibility extensions** mapped onto the existing catalog.
- **Empty-state DTO design.**
- **No raw row / table passthrough.**
- **No Supabase cutover claim.**

## 12. Safety Boundaries

- Documentation-only · no runtime changes · no UI changes · no route/API changes · no auth changes · no DB/SQL · no Supabase MCP · no live API/fetch · no production exposure · no real data · no DTO code / TypeScript types / read-model implementation.

## 13. Acceptance Criteria

Acceptable if: HIGH-1, HIGH-2, HIGH-3 are explicitly resolved; M3 has clear design constraints; the corrected sequence is documented; no code/runtime/UI/auth/API/DB change occurs; and the document claims **no** live readiness, production readiness, or Supabase cutover readiness.

## 14. Recommended Next Milestone

**Phase 2.0 M2.1 — Scoped Commit and Backup Authorization**, then **Phase 2.0 M3 — Backend Control Panel Read Model and DTO Design**.
