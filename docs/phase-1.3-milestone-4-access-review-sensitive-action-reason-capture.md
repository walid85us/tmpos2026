# Phase 1.3 — Milestone 4: Access Review + Sensitive Action Reason Capture

> **Status:** Local, advisory, **non-enforcing** foundation. This milestone turns the Milestone 1 `AccessReviewRecord` types + access-review derivation helpers into a usable **create → record-outcome** access-review workflow, and adds **Sensitive Action Reason Capture** around existing sensitive governance actions — both inside the existing Team Management UI. **No current permission behavior changed.** Recording a review outcome (even *change required*) does **not** alter a member's role or permissions; current platform access remains **UI/client-gated only**; server-side enforcement, automatic review/reminders/revocation, and compliance-evidence automation remain **future/deferred**. There is **no scheduler**, **no automatic review completion**, **no automatic permission change**, and **no automatic access revocation**.

Source module: [`src/owner/platformAccessReview.ts`](../src/owner/platformAccessReview.ts).
UI surface: the new **Access Review** tab in [`src/owner/TeamManagementPage.tsx`](../src/owner/TeamManagementPage.tsx) (plus a sensitive-action reason capture panel and a reason field on the existing matrix **Reset to Defaults** action).
Built on the Milestone 1 model: [`docs/phase-1.3-platform-team-governance-model.md`](phase-1.3-platform-team-governance-model.md).

---

## 1. What Milestone 4 added

- **`src/owner/platformAccessReview.ts`** — a new local/advisory foundation module:
  - A **session-scoped store** of access-review records (`sessionStorage` key `platform_access_review_v1` + a `platform_access_review:changed` event) and a parallel **sensitive-action reason log** (`platform_sensitive_action_reason_v1` + `platform_sensitive_action_reason:changed`). **Not durable backend state.**
  - A `StoredAccessReviewRecord` type that **extends** the Milestone 1 `AccessReviewRecord` (kept pristine) with additive display/trail-only fields: `reviewedRoleLabel`, `reviewedRoleKnown`, `systemProtected`, `createdBy`, `recommendedCadenceLabel`, and an append-only `history[]`.
  - **Reason-required transition helpers** — `createAccessReviewRecord` (validates subject / role / period / reviewer) and `completeAccessReview` (records one of four terminal outcomes; reason required; never silent) — each appending a reason-captured `AccessReviewEvent` to the record's trail. They return a structured `{ ok, error }` and never throw.
  - **Sensitive-action reason capture** — `captureSensitiveActionReason` builds a reason-captured `SensitiveActionReasonCapture` record (actor, action category from the M1 privileged-action catalog, reason, target, before/after, advisory label). Pure: it never changes a permission result.
  - Derived helpers — `deriveAccessReviewStatus`, `availableAccessReviewActions`, `summarizeAccessReviews` — all reusing the Milestone 1 `isAccessReviewOverdue` so terminal/explicit states never auto-flip and only an aged `pending` review derives to `overdue`.
- **An Access Review tab** in Team Management: a truthful advisory notice, single-source derived summary counts, a record table (subject, role + recommended cadence, period/reviewer, derived status, reviewed/updated, per-record trail), a **Create Review Record** modal, a **Seed Team Reviews** action (duplicate-safe), a reason-required **Record Outcome** modal, a manual **Refresh Status** button, and a **Sensitive Action Reason Capture** panel listing the local reason log.
- **Sensitive-action reason capture** wired into two in-scope existing sensitive actions: every **access-review outcome** (completion / change-required / escalation / deferral) and the Global Permissions Matrix **Reset to Defaults** action (which gained a required reason field; its existing behavior and `platform_permissions_reset` audit row are unchanged).
- **Six additive audit actions** in [`platformOpsAudit.ts`](../src/owner/platformOpsAudit.ts) (`access_review_created`, `access_review_completed`, `access_review_change_required`, `access_review_escalated`, `access_review_deferred`, `sensitive_action_reason_captured`, category `team`). **No existing action or severity changed.**

## 2. Access review is local/advisory today

A review record is a **documented governance record with a derived status**. It is **never applied to the live permission resolver**: the module never calls `explainAccessDecision`, never reads or writes `platform_permissions_v1`, and never touches role defaults, thresholds, or dependency auto-sync. Recording an outcome changes **no real permission**.

## 3. Review outcomes do not change live roles or permissions

The four reviewer-selectable outcomes are `reviewed_no_change`, `reviewed_change_required`, `escalated`, and `deferred`. A **reason is required for every one** (≥ 3 chars) — there is **no silent completion** (the helper rejects empty/short reasons and the confirm button is disabled until a reason is entered). When the outcome is **change required**, the record is flagged `actionRequired` and carries the label **“Action required — advisory only; no permission change applied.”** No role or permission is mutated for any outcome.

## 4. Derived overdue / stale labels are advisory only

`overdue` is a **derived label**, never a stored, reviewer-selected outcome. `deriveAccessReviewStatus` reuses the Milestone 1 `isAccessReviewOverdue`: only an open `pending` review ages into `overdue` (based on the reviewed role's recommended-cadence window against a caller-supplied `now`); completed / escalated / deferred states are terminal/explicit and **never auto-flip**. There is **no scheduler, no automatic reminders, and no automatic revocation** — the manual **Refresh Status** button simply recomputes `now`.

## 5. Sensitive Action Reason Capture documents reasons; it does not enforce

Reason capture records **why** an existing sensitive governance action was taken. It does **not** change the permission result, broaden who can act, change dependency auto-sync, or add server-side enforcement. It is wired to:
- **Access-review outcomes** — the reason is logged to the sensitive-action log (the `access_review_*` audit row already records the action, so no duplicate audit row is emitted).
- **Reset to Defaults** — the reset behavior and its existing `platform_permissions_reset` audit row are unchanged; a required reason is now captured and a `sensitive_action_reason_captured` audit row + log entry are added.

Per-cell matrix edits, member edits, and the Milestone 3 temporary-access actions keep their **existing** audit trails and are intentionally **not** re-gated this phase (see §9). Every captured reason carries the standing label: **“Reason captured locally/advisory. This does not represent server-side enforcement or compliance certification.”**

## 6. System Owner stays system-protected

System Owner is in-scope for access review (reviewed for **existence/ownership**, per the Milestone 1 catalog), but it is **system-protected**: a review row shows **System Protected · Review Carefully · No Automatic Downgrade · No Permission Change Applied**; the completion modal repeats the protection notice; and any recorded outcome explicitly notes that System Owner is never downgraded and no permission change is applied. No outcome mutates its role or permissions (true for every subject — there is no permission mutation at all).

## 7. Gating + persistence

- **Gating** mirrors the rest of Team Management: create / seed / record-outcome are System-Owner-only in the UI (`session.role === 'system_owner'`). **No new permission keys were introduced** — role defaults, thresholds, the resolver, and dependency auto-sync are untouched. (Limitation: this reuses the page's existing System-Owner gating rather than a dedicated access-review permission key; a future server-side phase would authorize these against the resolver.)
- **Persistence** is session-scoped (`sessionStorage`), consistent with the platform-permission overrides store and the temporary-access store — **not durable backend state**.

## 8. No drift

The summary counts (`summarizeAccessReviews`) and the visible rows derive from the **same** `deriveAccessReviewStatus` over the **same** record list and the **same** `nowTick`. Each record maps to exactly one bucket, so counts and rows cannot disagree.

## 9. Known behavior / follow-up considerations (NOT in scope for M4)

- The four outcomes are **terminal** (advisory). A future milestone could allow re-opening a `deferred` review for a later period, or separate "review validity" from "decision."
- Per-cell Global Permissions Matrix edits, member role/status edits, and temporary-access lifecycle actions keep their existing audit trails and are **not** individually reason-gated this phase (to preserve the accepted M2/M3 UX); extending reason capture to them is a future consideration.
- No notifications, approvals routing, SoD checks, scheduler, or backend enforcement — those remain future Phase 1.3+/Phase 2/Phase 3 work. **These records are not compliance certification evidence.**

## 10. How this prepares Milestone 5

- **Milestone 5 (Command Center / Audit integration):** the six new `access_review_*` / `sensitive_action_reason_captured` audit actions (category `team`) give Command Center / Audit a consistent category to surface review and reason-capture signals. (Milestone 5 is **not started**; only additive local audit entries were added here.)

## 11. Truthful labels reaffirmed

advisory · local/session-based · non-enforcing · derived/lazy overdue · no scheduler · no automatic reminders · no automatic review completion · no automatic permission change · no automatic revocation · not applied to the live permission resolver · UI/client-gated only · no server-side enforcement · no Firestore rules · no server middleware · **not compliance certification evidence**. System Owner remains system-protected.

## 12. Non-regression confirmation

No existing behavior changed. The resolver, thresholds, role defaults, dependency auto-sync, role assignment, routes, server, and Firestore rules are all untouched (`platformPermissionsConfig.ts`, `platformTemporaryAccess.ts`, `accessConfig.ts`, and `server/index.ts` have **no diff**). The Milestone 1 governance model (`platformTeamGovernance.ts`) is consumed but **unchanged**. The only changes are: one new module, an additive extension of the audit action union + severity map, and additive UI (a new tab + two modals + a reason field on the existing Reset modal + a sensitive-action panel) in Team Management. `tsc --noEmit` remains at the pre-existing **12-error baseline** (none in the touched files); a 49-check automated QA harness over the access-review + reason-capture logic passed 49/49 (the harness was temporary and was removed after QA). Milestone 5 remains **not started**; Phase 1.3 is **not complete**.
