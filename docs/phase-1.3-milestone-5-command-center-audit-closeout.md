# Phase 1.3 — Milestone 5: Command Center + Audit Integration + Documentation Closeout

> **Status:** Visibility + closeout milestone — **local, advisory, non-enforcing**. This milestone makes the Phase 1.3 governance work (Milestone 3 temporary access, Milestone 4 access review + sensitive-action reason capture) **visible and coherent** across the existing owner monitoring surfaces — the **Command Center** and the **Audit Investigation Center** — without adding any enforcement. **No current permission behavior changed.** Current platform access remains **UI/client-gated only**; there is **no server-side enforcement, no Firestore rule, no server middleware, no scheduler, no background worker, and no automatic revocation/review**. These signals are **not production compliance evidence** and are **not** automated compliance-evidence generation.

Surfaces touched: [`src/owner/CommandCenterPage.tsx`](../src/owner/CommandCenterPage.tsx) (new governance signals section) and [`src/owner/platformOpsInvestigation.ts`](../src/owner/platformOpsInvestigation.ts) (one additive audit investigation lens consumed by [`src/owner/AuditSecurityPage.tsx`](../src/owner/AuditSecurityPage.tsx)).
Signal sources (read-only): [`src/owner/platformTemporaryAccess.ts`](../src/owner/platformTemporaryAccess.ts) (M3) and [`src/owner/platformAccessReview.ts`](../src/owner/platformAccessReview.ts) (M4).
Built on: [`docs/phase-1.3-milestone-3-temporary-access-pim-foundation.md`](phase-1.3-milestone-3-temporary-access-pim-foundation.md), [`docs/phase-1.3-milestone-4-access-review-sensitive-action-reason-capture.md`](phase-1.3-milestone-4-access-review-sensitive-action-reason-capture.md).

---

## 1. What Milestone 5 added

> **Correction pass (post-implementation):** the M3–M5 governance capabilities are now controlled by the **Platform Global Permissions Matrix** (seven additive sub-permissions), not by hardcoded System-Owner gating. See **§13** for the full correction. The original section text below is preserved for history; where it said "no new permission key," read it against §13.

- **Command Center — a "Platform Team Governance" section** (`CommandCenterPage.tsx`), placed after Workflow Health and now gated by **both** Command Center access (`view_command_center`) **and** the new matrix permission `view_governance_signals` (see §13). It reads the M3/M4 session stores (read-only) and renders single-source derived-count cards:
  - **Temporary Access — Advisory Grants:** Pending Requests, Active Advisory Grants, Expired Advisory Grants, Total Advisory Grants (from `summarizeTemporaryAccess`).
  - **Access Reviews — Advisory Records:** Pending, Overdue (derived), Escalated, Change Required (from `summarizeAccessReviews`).
  - **Sensitive Actions — Captured Reasons:** count of `readSensitiveActionReasons()`.
  - A standing **advisory notice**, truthful **empty states** per group, a **future-state footer**, and cross-links to **Team Management** and the **Audit Investigation** governance lens.
- **Audit Investigation — a "Governance Activity (Advisory)" lens** (`platformOpsInvestigation.ts`), appended to `AUDIT_INVESTIGATION_LENSES` (+ its `AuditLensId`). It is a deterministic substring match over the M3/M4 action names (`temporary access` / `access review` / `sensitive action reason`) and surfaces automatically as a lens card on the Audit & Security page (the page already maps over the lens list). Its count and list share one predicate (no drift), consistent with the existing lens contract.
- **Cross-link deep-link:** the Command Center "Audit Investigation" link points at `/owner/audit-security?lens=governance_advisory`, which the Audit page's existing `?lens=` deep-link handler applies as a **visible, clearable** lens (never an invisible filter).
- **Documentation closeout:** this artifact, an M5 note in the governance-model doc, an M5 section in the history doc, and a minimal factual `replit.md` update.

## 2. The M3/M4 governance events were already auditable; M5 makes them coherent

The Milestone 3 (`platform_temporary_access_*`) and Milestone 4 (`access_review_*`, `sensitive_action_reason_captured`) audit actions already flow into the shared `audit_logs` stream (category `team`) and were therefore already visible in **All Events** and filterable by the existing `team` category. **Milestone 5 changed none of that.** It adds **one grouped lens** so an operator can scope the stream to exactly the Phase 1.3 advisory governance events in a single tap — and adds the Command Center summary cards so the same activity is visible at the monitoring level. No audit row is mutated, no existing lens behavior changed, and no new audit action was introduced in M5.

## 3. Command Center signals are derived from the M3/M4 stores only

Every Command Center number is computed from the **same** session store and **same** summarize helper the Team Management governance tabs use:

- Temporary access cards ← `readTemporaryAccessGrants()` → `summarizeTemporaryAccess()`.
- Access review cards ← `readAccessReviewRecords()` → `summarizeAccessReviews()`.
- Sensitive-action card ← `readSensitiveActionReasons().length`.

The Command Center **never writes** a grant/record, **never calls** the resolver, and **never** touches `platform_permissions_v1`, role defaults, thresholds, or dependency auto-sync. Derived expired/overdue status is recomputed at **load/refresh** time (the manual **Refresh** button re-reads the stores); there is **no scheduler and no background worker**.

## 4. Truthful empty states (no fake data)

When a store has no records the section shows the exact truthful empty state instead of a zero-filled card grid:

- "No local advisory temporary access records in this session."
- "No local advisory access review records in this session."
- "No sensitive-action reasons captured in this session."

The footer additionally states: "Server-side enforcement remains future/deferred. These signals are not production compliance evidence." No placeholder/seeded/fabricated governance data is ever shown.

## 5. Standing advisory notice (verbatim)

The section renders this notice verbatim:

> Phase 1.3 governance signals are local/advisory in this phase. They do not represent server-side enforcement, automated compliance evidence, or production PAM/IAM monitoring.

The audit lens description carries the same boundary: "Local advisory audit trail only; not server-side enforcement or production compliance evidence."

## 6. Truthful enforcement / future-state labels

Used consistently across both surfaces:

- **Local advisory audit trail** · **Governance activity (advisory)**
- **No server-side enforcement** · **No Firestore rules** · **No server middleware**
- **No scheduler / no background worker / no automatic revocation / no automatic review**
- **Production compliance evidence — future/deferred** · **Not compliance certification evidence**
- **UI/client-gated only** · derived counts recompute on Refresh

## 7. Gating + non-regression

- **Gating (superseded by §13):** as originally shipped, the Command Center section reused `view_command_center` and the audit lens needed no permission of its own. The **correction pass (§13)** added seven matrix sub-permissions so the System Owner can control governance visibility/management per role. **No route entries and no resolver-logic change** in either pass.
- **Non-regression:** existing Command Center sections (Mission Control, Pulse, Widgets, Tenant Risk, Next Best Actions, Quick Actions, Needs Attention, Workflow Health) and existing Audit Investigation behavior (filters, lenses, review overlay, evidence summary, deep-links) are **preserved**. The M3/M4 modules are consumed **read-only** and are unchanged. No backend/server/Firestore enforcement, scheduler, or worker was added.

## 8. No drift

Command Center governance counts and the audit lens both follow the project's single-source rule: each count derives from one helper/predicate over one record set, so a count can never disagree with the records behind it. The audit lens count (`countForLens`) and the list it scopes share one predicate.

## 9. Known behavior / follow-up considerations (NOT in scope for M5)

- The Command Center cards reflect the **last load/refresh**; derived expired/overdue advances when the stores are re-read (Refresh, or any governance store-change event) — there is intentionally **no timer-driven auto-advance** (consistent with M3/M4 "no scheduler").
- The audit governance lens is a **substring** match on action names (deterministic). Were a future milestone to rename these actions, the lens regex would need to be updated alongside.
- Server-side enforcement, real PAM/PIM monitoring, SoD checks, automated compliance evidence, SSO/SCIM, notifications, and approval routing remain **future Phase 1.3+/Phase 2/Phase 3** work. These signals are **not compliance certification evidence**.

## 10. Truthful labels reaffirmed

advisory · local/session-based · non-enforcing · derived counts (recompute on refresh) · no scheduler · no background worker · no automatic revocation/review · not applied to the live permission resolver · UI/client-gated only · no server-side enforcement · no Firestore rules · no server middleware · **not production compliance evidence**. System Owner remains system-protected.

## 11. Non-regression confirmation

No existing behavior changed. The resolver, `platformPermissionMeets`, `explainAccessDecision`, `hasPlatformPermission`, `hasEffectiveFeatureAccess`, `hasSectionAccess`, `hasActionAccess`, `AccessContext.canAccess`, role defaults, thresholds, and dependency auto-sync are all **untouched**. `platformTemporaryAccess.ts`, `platformAccessReview.ts`, `platformTeamGovernance.ts`, `platformPermissionsConfig.ts`, `accessConfig.ts`, `server/index.ts`, and the Firestore rules have **no behavior change** (M3/M4 modules are imported read-only; `platformOpsAudit.ts` was **not** modified in M5). The only changes are: one additive audit lens (type member + array entry + matcher regex), one additive Command Center section (+ one small display-only `GovStat` sub-component and read-only store subscriptions), and documentation. `tsc --noEmit` remains at the pre-existing **12-error baseline** (none in the touched files).

## 12. Phase 1.3 completion criteria

Phase 1.3 can be considered **functionally complete only after**: (1) this Milestone 5 implementation report, (2) validation, (3) automated QA / static verification, (4) **manual QA acceptance**, and (5) the **final GitHub backup**. **Milestone 5 implementation does not mark Phase 1.3 complete.**

## 13. Correction Pass — Governance Permission Matrix Integration

A post-implementation correction integrated the M3–M5 governance capabilities into the **Platform Global Permissions Matrix** so the System Owner controls — per platform role — who can **view** or **manage** them. This replaces the prior hardcoded System-Owner gating. **The permission resolver was not changed** (`platformPermissionMeets`, `explainAccessDecision`, `hasPlatformPermission`, `hasEffectiveFeatureAccess`, `getPlatformSubPermissionLevel`, role defaults, thresholds, and dependency auto-sync are all unchanged) — only **data** (new sub-permission entries + dependency entries) and **UI gating** (callsites that read the existing resolver) were added.

### 13.1 New sub-permissions (7, additive)

Added to the existing feature groups in `platformPermissionsConfig.ts` (they render automatically in the data-driven matrix UI with their labels, descriptions, thresholds, sensitive badges, and dependency chips):

| Sub-permission | Group | Threshold | Sensitive | Controls |
|---|---|---|---|---|
| `view_temporary_access` | team_management | view | — | See the Temporary Access tab + advisory grants |
| `manage_temporary_access` | team_management | manage | ✓ | Request / approve / deny / revoke / cancel grants |
| `view_access_reviews` | team_management | view | — | See the Access Review tab + advisory records |
| `manage_access_reviews` | team_management | manage | ✓ | Create / seed reviews + record outcomes |
| `capture_sensitive_action_reasons` | team_management | manage | ✓ | See the Sensitive Action Reason Capture log |
| `view_governance_signals` | command_center | view | — | See the Command Center governance signals section |
| `view_governance_audit_lens` | audit_security | view | — | See/use the "Governance Activity (Advisory)" audit lens |

### 13.2 Dependencies (additive, use the existing auto-sync)

`manage_temporary_access → view_temporary_access`; `manage_access_reviews → view_access_reviews`; `capture_sensitive_action_reasons → view_access_reviews`; `view_governance_signals → view_command_center`; `view_governance_audit_lens → view_audit_security`. These reuse the **existing** direction-aware dependency auto-sync (granting a dependent auto-raises a denied prerequisite to its threshold; lowering a prerequisite auto-caps the dependent). Verified by the QA harness.

### 13.3 Where the gates are applied

- **Team Management** (`TeamManagementPage.tsx`): the **Temporary Access** and **Access Review** tabs are hidden without their `view_*` permission (with a defensive no-access panel); every lifecycle/outcome action and the create/seed/request buttons require the `manage_*` permission (view-only roles see a truthful "view-only" note and disabled/hidden actions); the Sensitive Action Reason Capture log requires `capture_sensitive_action_reasons`.
- **Command Center** (`CommandCenterPage.tsx`): the governance section requires `view_command_center` **and** `view_governance_signals`; the Audit cross-link requires `view_governance_audit_lens` (no dead deep-links).
- **Audit Investigation** (`AuditSecurityPage.tsx`): the governance lens card is hidden, the `?lens=governance_advisory` deep-link is ignored, and the active lens falls back to "All Events" without `view_governance_audit_lens`.
- **System Owner** resolves to Full Access for every key, so it remains **fully allowed and protected**. The Reset-to-Defaults reason capture keeps its **existing** gate (System Owner only) — who can reset was **not broadened**, and reset behavior is unchanged.

### 13.4 Default role posture (least privilege)

Sub-permissions **inherit the parent feature level** (the existing resolver rule) unless the System Owner sets an explicit override in the matrix. With the unchanged role feature-defaults, the resulting default posture is:

| Role | View (temp / review / signals / lens) | Manage temp / reviews / capture |
|---|---|---|
| **System Owner** | ✓ all | ✓ all (locked Full Access) |
| **Security/Audit Admin** | ✓ all | ✓ all |
| **Operations Admin** | ✓ all | · none |
| **Support Admin** | ✓ all | · none |
| **Billing Admin** | ✓ all | · none |

So **only System Owner and Security Admin can manage** governance or see the sensitive-action reason log by default; Operations/Support/Billing are **view-only**. The view-level visibility for Billing/Support/Operations follows their **existing** view-level access to the parent features (Team Management / Command Center / Audit) — it was **not** newly broadened, and the System Owner can set any of these to **None** per role in the matrix (now possible — the point of this correction). This posture was verified by a temporary 74-check QA harness (catalog placement, thresholds, sensitive flags, dependencies, per-role resolution, System-Owner allow-all, and dependency auto-sync raise/cap), which passed 74/74 and was then removed.

### 13.5 Truthful boundaries (unchanged by the correction)

These controls are **UI/client-gated only**. **No server-side enforcement, no Firestore rules, no server middleware, no scheduler/worker** were added; the governance features remain **local/advisory/non-enforcing**; the live permission resolver behavior is **unchanged**; future server-side enforcement remains **deferred**. Granting `manage_*` does not make any governance record change a real role or permission — the records stay advisory.
