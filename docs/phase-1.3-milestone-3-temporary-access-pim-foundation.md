# Phase 1.3 — Milestone 3: Temporary Access / PIM Foundation

> **Status:** Local, advisory, **non-enforcing** foundation. This milestone turns the Milestone 1 `TemporaryAccessGrant` types + derived/lazy status helpers into a usable **request → approve/grant → revoke** workflow (plus **deny** and **cancel**) inside the existing Team Management UI. **No current permission behavior changed.** Granting temporary access does **not** alter a member's real permissions; current platform access remains **UI/client-gated only**; server-side enforcement, PIM/PAM, SSO/SCIM, and automatic expiration remain **future/deferred**. There is **no scheduler**, **no automatic permission escalation**, and **no automatic permission revocation**.

Source module: [`src/owner/platformTemporaryAccess.ts`](../src/owner/platformTemporaryAccess.ts).
UI surface: the new **Temporary Access** tab in [`src/owner/TeamManagementPage.tsx`](../src/owner/TeamManagementPage.tsx).
Built on the Milestone 1 model: [`docs/phase-1.3-platform-team-governance-model.md`](phase-1.3-platform-team-governance-model.md).

---

## 1. What Milestone 3 added

- **`src/owner/platformTemporaryAccess.ts`** — a new pure-ish foundation module:
  - A **session-scoped store** (`sessionStorage` key `platform_temporary_access_v1`) of grants, with a `platform_temporary_access:changed` event so open views refresh. **Not durable backend state.**
  - A `StoredTemporaryAccessGrant` type that **extends** the Milestone 1 `TemporaryAccessGrant` (kept pristine) with three additive, display/trail-only fields: `elevatedRoleLabel`, `requestedDurationMs`, and an append-only `history[]`.
  - **Reason-required lifecycle transition helpers** — `createTemporaryAccessRequest`, `approveTemporaryAccess`, `denyTemporaryAccess`, `revokeTemporaryAccess`, `cancelTemporaryAccess` — each validating allowed transitions and appending a reason-captured `TemporaryAccessEvent` to the grant's trail.
  - Derived helpers: `availableTemporaryAccessActions` (UI gating) and `summarizeTemporaryAccess` (single-source counts).
- **A Temporary Access tab** in Team Management: derived-status summary counts, a grant table (subject, advisory elevation target, window, derived status, per-grant trail), a **Request Temporary Access** modal, reason-required **approve / deny / revoke / cancel** confirm modals, and a manual **Refresh Status** button.
- **Five additive audit actions** in [`platformOpsAudit.ts`](../src/owner/platformOpsAudit.ts) (`platform_temporary_access_requested/approved/denied/revoked/cancelled`, category `team`). No existing action or behavior changed.

## 2. The foundation is advisory and non-enforcing

A grant is a **documented record with a derived status**. It is **never applied to the live permission resolver**: the module never calls `explainAccessDecision`, never reads or writes `platform_permissions_v1`, and never touches role defaults, thresholds, or dependency auto-sync. The Effective Access Preview and the Global Permissions Matrix are unaffected by any grant. Approving a "temporary elevation" changes **no real permission** — the elevation target is an **advisory label only** (the UI says so on the column header, the request modal, and the truth banner).

## 3. Reason is required for every transition

`request`, `approve/grant`, `deny`, `revoke`, and `cancel` each require a reason (≥ 3 chars). The transition helpers reject empty/short reasons with a structured error (`{ ok: false, error }`) — they never throw — and the UI also disables the confirm button until a reason is entered (defence in depth). Every accepted transition records a `TemporaryAccessEvent { action, actor, reason, at, fromStatus, toStatus }` in the grant's append-only `history[]`, and **also** mirrors to both the in-page Activity Log and the shared platform Audit & Security log (the same dual pattern used by role/permission changes).

## 4. Expiration is derived/lazy — no scheduler, no automatic revocation

Status is computed at read time by the Milestone 1 `getTemporaryAccessStatus(grant, now)`:

- On **approval**, the time-box clock is **re-anchored to approval time**: `startsAt = approvalNow`, `expiresAt = approvalNow + requestedDurationMs`. (The proposed window stored at request time is informational; the real clock starts when granted.)
- A grant only **appears** expired when something reads it after `expiresAt`. The stored `status` is **never auto-mutated** to `expired` and access is **never automatically revoked**. There is **no `setInterval`/scheduler** anywhere in this milestone.
- The UI exposes a manual **Refresh Status** button that simply recomputes `now` — it is operator-initiated, not a background timer.
- Consequence (truthful): a **pending request** whose *proposed* window lapses also derives to `expired` (expiry wins over `requested` in the M1 helper) and then has no available actions. This is consistent derived behavior, documented here, and listed as a follow-up consideration in §9.

## 5. System Owner stays system-protected

System Owner has `eligibleForTemporaryElevation: false` in the Milestone 1 catalog, so it can never be a temporary-elevation **subject**, and it is excluded from the elevation **target** list. The request helper rejects both cases. Custom/non-catalog roles are not modelled here and are excluded from the eligible-subject list with a truthful note.

## 6. Gating + persistence

- **Gating** mirrors the rest of Team Management: request/approve/deny/revoke/cancel are System-Owner-only in the UI (`session.role === 'system_owner'`). **No new permission keys were introduced** — role defaults, thresholds, the resolver, and dependency auto-sync are untouched.
- **Persistence** is session-scoped (`sessionStorage`), consistent with the platform-permission overrides store and the "not durable backend state" reality from the Milestone 0 inventory.

## 7. No drift

The summary counts (`summarizeTemporaryAccess`) and the visible rows derive from the **same** `getTemporaryAccessStatus` over the **same** grant list and the **same** `nowTick`. Counts and rows cannot disagree.

## 8. Truthful labels reaffirmed

advisory · non-enforcing · derived/lazy expiry · no scheduler · no automatic escalation · no automatic revocation · no server-side enforcement · no Firestore rules · no server middleware · session-scoped persistence · not applied to the live resolver · UI/client-gated only. System Owner remains system-protected.

## 9. Known behavior / follow-up considerations (NOT in scope for M3)

- A pending request can derive to `expired` once its proposed window lapses, after which it has no actions (see §4). A future milestone could keep pending requests actionable until explicitly resolved, or separate "request validity" from "grant window."
- No notifications, approvals routing, SoD checks, or backend enforcement — those remain future Phase 1.3+/Phase 2 work.

## 10. How this prepares later milestones

- **Milestone 4 (Access Review + Sensitive-Action Reason Capture):** the reason-capture + audit-trail pattern and the `PRIVILEGED_ACTION_CATALOG` advisories established here carry directly into access-review reason prompts and stale-access flagging.
- **Milestone 5 (Command Center / Audit integration):** the new `platform_temporary_access_*` audit actions give Command Center / Audit a consistent category to surface temporary-access signals.

## 11. Non-regression confirmation

No existing behavior changed. The resolver, thresholds, role defaults, dependency auto-sync, role assignment, routes, server, and Firestore rules are all untouched. The only changes are: one new module, an additive extension of the audit action union + severity map, and additive UI (a new tab + two modals + display-only helpers) in Team Management. `tsc --noEmit` remains at the pre-existing **12-error baseline** (none in the touched files). A 38-check automated QA harness over the lifecycle logic passed 38/38.
