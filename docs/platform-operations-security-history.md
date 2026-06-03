# Platform Operations & Security — Implementation History

> Detailed long-form implementation history for the Platform Operations & Security
> workstream (System Owner surfaces: Command Center, Audit & Security, Support Tools,
> Domains, Team Management). This file is the deep reference moved out of `replit.md`
> to keep the main project README concise. **No accepted rule has been removed** — the
> high-level locked rules remain summarized in `replit.md`; the full narrative,
> correction sequences, and debugging-grade detail live here.
>
> Order follows phase / correction sequence. Preserve warnings and limitations.

---

## Phase 1.1 — Platform Operations Foundation

-   **Platform Operations & Security**: A suite of System Owner surfaces (Audit & Security, Support Tools, Platform Settings, Domains, Team Management) for governance and operational control. Includes mock data, a platform audit helper, and truth labels for manual verification.
-   **Command Center**: A central dashboard providing platform health overview, needs attention queue, tenant risk summary, and workflow health summary, with live updates.
-   **Audit & Security Upgrade**: Includes saved views, CSV export, high-risk flags, linked case badges, and detailed drawers for event analysis, related events, actor profiles, and support case creation from audit events.
-   **Support Tools Upgrade**: Features SLA timers, saved views, escalation mechanisms, tenant health mini-cards, a note composer with macro inserter, and related entities panels.
-   **Risk Scoring (`deriveTenantRisk`)**: Calculates a per-tenant risk score based on critical audits, escalated cases, overdue/at-risk SLA cases, and domain verification statuses.
-   **SLA Timer Logic (`deriveSlaStatus`)**: Determines the status of support cases (overdue, at_risk, paused, met) based on predefined deadlines and case status.
-   **High-Risk Audit Flag Logic (`deriveHighRiskFlag`)**: Identifies critical, sensitive, or burst audit events.

### IAM/RBAC Role Stack (project knowledge)

Platform permission work is approached through the lenses of: IAM Specialist, Access Analyst, Senior RBAC Architect, Platform Team Governance Leader, Senior Platform Operations Architect, Senior Support Tools / Audit & Security Engineer, Senior React/TypeScript Engineer, QA Gatekeeper, and Side Auditor. Responsibilities span role mapping, least-privilege enforcement, effective-access validation, lifecycle audit, and inheritance/explicit-deny troubleshooting. Subjects = Dev Session role + platform roles + future team members. Objects = sidebar modules / pages / sections / widgets / action buttons / support cases / escalation actions / audit logs / commercial controls. Permissions = None / View Only / Create / Edit / Approve / Manage / Full Access (rank-ordered).

### Four-Level Effective Access Model

Every gate decision is evaluated at one of four levels — (1) **sidebar visibility** uses `hasEffectiveFeatureAccess` (parent OR any child >= view), (2) **page/route access** uses the same effective check with `NAV_FEATURE_SECONDARY_KEYS` mapping, (3) **section/widget visibility** uses `hasSectionAccess(role, subKey)` against the EXACT child sub-permission (independent of parent so explicit child grants reveal only that section), (4) **action/handler authorization** uses `hasActionAccess(role, subKey)` and is re-checked inside every mutation handler so stale UI / dropdowns cannot bypass the gate. `explainAccessDecision` returns `{allowed, effectiveLevel, source, reason, threshold}` where `source ∈ {system_owner, explicit_child, explicit_parent, default_parent, denied_explicit_child, denied_no_access}` (sub-permissions inherit the parent default, so there is no separate `default_child`) for full explainability.

### Global Permissions Matrix as Source of Truth

The `platformPermissionsConfig.ts` matrix is the single authority for sidebar visibility, page access, and action gating across all platform pages. Key design:

-   `hasEffectiveFeatureAccess(role, featureKey)` resolves visibility by checking the parent level OR any child sub-permission >= view, enabling child-granted sidebar access even when the parent is None.
-   `canAccess()` in `AccessContext.tsx` uses effective access with secondary key mapping (e.g. `plans` → `addon_governance`) for nav items that span multiple feature groups.
-   `gatedCan()` in SupportToolsPage returns the matrix result directly without falling through to old `can()` logic, so matrix-granted actions are never blocked by legacy role checks.
-   CommandCenter gates Operational Pulse, NBA, and Needs Attention sections with `view_operational_pulse`, `view_next_best_actions`, `view_needs_attention` sub-permissions. NBA action buttons gated by `act_on_nba_recommendations`.
-   AuditSecurityPage gates the audit log table with `view_audit_logs`.
-   TenantDetailPage gates Trial/Paid Override/Revoke/End Trial/Re-trial/Re-grant Paid buttons with `grant_trial`, `grant_paid_override`, `revoke_addon_override`.
-   PlansPage hides the Add-ons tab when `addon_governance` effective access is denied.
-   TeamManagementPage shows a confirmation modal before resetting all permission overrides to defaults.
-   The Effective Access Preview panel highlights child-granted visibility (amber) and System Owner locked status.

### Section-Level Gating in Command Center

Mission Control hero, Operational Widgets, Workflow Health, How-Risk-Derived legend, and the Quick Actions bar are wrapped in `viewPageGate.allowed`/`useQuickActionsGate.allowed` so when only `view_needs_attention=View Only` is granted (parent None), only the Needs Attention section renders — Mission Control, widgets, NBA, pulse, and quick actions stay hidden.

### Handler-Level Gating in Support Tools

`changeStatus`, `changeSeverity`, and `changeAssignee` re-check `change_support_status` / `change_support_severity` / `assign_support_case` at the top of the handler and abort with a toast if denied. Status and severity selects render disabled (with reason tooltip) when the matching permission is missing.

### De-escalate Confirmation Flow

The de-escalate banner button is hidden when `deescalate_support_case` is denied; when granted, it opens the confirmation modal (it never calls `deescalateCase` directly). The modal requires a non-empty reason — Confirm is disabled until one is provided.

---

## Phase 1.1.1 — UX Polish

### Add-on Create/Edit Modal — UX Improvement

The Add-on modal in `PlansPage.tsx` widened from `max-w-3xl max-h-[92vh]` to `max-w-5xl max-h-[94vh]` with relaxed body spacing (`p-10 space-y-7`) so name, pricing, governance, lifecycle, compatible-plans, and readiness sections breathe. No behavior change — only layout/spacing.

---

## Phase 1.1.2 — Competitive Maturity

### Benchmark Note (Platform Operations maturity)

The System Owner surfaces (Command Center intelligence, Audit & Security, Support Tools, Domains, Team Management) are designed to mirror the operational-intelligence depth of mature multi-tenant SaaS control planes (e.g. tenant risk scoring, correlated incident episodes, what-changed deltas, and rule-based next-best-actions). All intelligence is deterministic and explainable by design — favoring auditable, rule-based derivations over opaque ML so every signal can be traced to its source data and threshold.

### Platform Operations Role-Stack (project knowledge)

Advanced Command Center work is approached through the lenses of: Senior Platform Operations Architect (signal model + correlation design), Site Reliability / Incident Commander (episode clustering, what-changed deltas, triage prioritization), Senior RBAC Architect (permission gating of every intelligence surface), Senior React/TypeScript Engineer (deterministic derivations + memoized UI), Data/Analytics Engineer (risk scoring + confidence model), QA Gatekeeper (count-vs-list reconciliation, truth-label verification), and Side Auditor (auditability + honest "rule-based, not AI" labeling).

---

## Phase 1.1.3A — Operating Model + Permission-Aware Escalation

### Operating Model + Permission-Aware Escalation

Introduces an advisory operating model with `PlatformOpsRole` unions, structured `EscalationStatus`, `EscalationLevel`, `EscalationReasonCode`, and `EscalationTargetTeam`. Includes a `can(role, action, ctx)` helper for UX guarding of escalation lifecycle actions.

### Pre-QA Blocker Correction (Effective Permission Resolver Hardening)

A focused correction pass closed 9 verifier-flagged blockers without expanding scope. Catalog gained 8 new Support Tools sub-permissions (`view_support_sla`, `view_support_tenant_health`, `view_support_related_entities`, `add_internal_support_note`, `use_support_macro`, `manage_support_macros`, `edit_support_case`, `reopen_support_case`); the NBA key was renamed to its canonical form `view_next_best_actions` and the legacy `view_nba_recommendations` is preserved as an alias via `PLATFORM_SUB_PERMISSION_ALIASES` so existing callsites still resolve. SupportToolsPage wires all 9 new sub-perms (handler-level checks in `addNote` / `closeCase` / `reopenCase` / `insertMacro`; section-level gates around the SLA pill, Tenant Health card, Related Entities panel, NoteComposer, macro picker, Reopen button; and an Assignee input now disables with a tooltip when `assign_support_case` is denied). The Resolve Escalation modal mirrors the close-warn confirm-time re-check pattern so a stale UI state cannot bypass `resolve_escalation`. AuditSecurityPage wires 4 sub-perms: `view_actor_profile` gates the Actor drawer tab, `view_related_event_timeline` gates the Related drawer tab (separate keys per spec), `view_escalation_lifecycle_audit` gates the escalation transition card, and `view_restricted_audit_details` redacts the free-form Note body and "Why flagged" reasons for high-risk events. TenantDetailPage End-Trial now requires BOTH `grant_trial` AND `revoke_addon_override` (ending an active trial is jointly a trial-lifecycle action and an override revocation). CommandCenter Tenant Risk Summary becomes the minimal Tenant 360 surface: it now renders when the operator holds either parent Command Center access OR the explicit `view_tenant_360` child grant. De-escalate visibility deferral remains as previously documented (button hidden when `deescalate_support_case` is denied; modal still required for confirmation when allowed).

### Permission Dependency / Prerequisite Model

`platformPermissionsConfig.ts` ships a `PLATFORM_PERMISSION_DEPENDENCIES` map declaring direct prerequisites for dependent sub-permissions. `explainAccessDecision` auto-reconciles deps: when ANY prerequisite resolves to denied, the dependent action is denied with `source = 'denied_prerequisite'` and a reason naming the missing prerequisite (transitive, with a recursion guard). `hasPlatformPermission` delegates to `explainAccessDecision`, so every UI gate, tooltip, handler check, and Effective Access Preview reads off the same reconciled result without callsites repeating the dep check. Mapped relationships include: `act_on_nba_recommendations → view_next_best_actions`; every Support Tools child action (`change_support_status/severity`, `assign_support_case`, `close_support_case`, `reopen_support_case`, escalate/acknowledge/deescalate/resolve/level/close-with-escalation, `add_internal_support_note`, `view_support_sla/tenant_health/related_entities`, `manage_support_macros`) → `view_support_tools`; `use_support_macro → add_internal_support_note`; `close_with_active_escalation → close_support_case`; `view_audit_logs/actor_profile/related_event_timeline/restricted_audit_details/escalation_lifecycle_audit`, `add_security_note`, `delete_security_note` → `view_audit_security`; `export_audit_csv → view_audit_logs`; `create_support_case_from_audit` requires BOTH `view_audit_security` AND `create_support_case`; all add-on mutations (`create_addon`, `edit_addon`, `archive_delete_addon`, `manage_addon_compatible_plans`, `manage_addon_readiness`, `generate_addon_implementation_brief`, `grant_trial`, `grant_paid_override`, `revoke_addon_override`, `edit_addon_overrides`) → `view_addon_governance`. Enforcement is UI-only this phase — server-side RBAC/PIM/PAM remains Phase 1.3.

### Permission Dependency Auto-Sync (write-time)

`reconcileSubPermissionChange(role, subKey, prev, next, overrides)` and `reconcileFeatureLevelChange(role, featureKey, prev, next, overrides, before)` in `platformPermissionsConfig.ts` apply direction-aware IAM rules whenever the Global Permissions Matrix is edited: (1) **Raising** a dependent action transitively auto-raises each currently-denied prerequisite to the minimum level that satisfies its own threshold (never beyond — least-privilege preserved). (2) **Lowering** a prerequisite (sub or parent feature) transitively auto-caps each dependent that was previously allowed but now resolves to `denied_prerequisite`, by writing explicit `none` on the dependent. (3) **Lowering** a dependent action never touches its read-only prerequisite. (4) System Owner is locked and never reconciled. Returned `PermissionAdjustment[]` drives a non-blocking indigo "Dependent permissions adjusted to preserve least-privilege consistency" notice in the matrix (auto-dismissed after 8s) and a deduplicated `platform_permission_dependency_reconciled` audit row per adjustment (with old/new value, role/permission target, and a short `note` describing which trigger permission caused the auto-adjustment).

### Matrix Dependency Feedback (UX)

In `TeamManagementPage.tsx` Global Permissions Matrix, each sub-permission row with a prerequisite renders a quiet "depends on …" badge (with full tooltip listing every prereq). Per-role status cell uses `explainAccessDecision` and shows `enabled` / `blocked by prereq` (indigo) / `disabled` so editors immediately see why an action is inactive. Effective Access Preview surfaces a `N blocked by prereq` indicator per feature when prerequisite-denied children exist for the previewed role — wording chosen to stay quiet (no toasts, no auto-flipping of stored levels; the resolver simply computes the reconciled state on read).

### Request De-escalation (lightweight)

Support case banner shows a "Request De-escalation" affordance when `deescalate_support_case` is denied but `add_internal_support_note` is granted. Opens a modal with a required reason; on confirm it re-checks `add_internal_support_note`, posts an internal note (`De-escalation requested by [operator] ([role]): [reason]`) via the existing `addNote` handler, and writes a `support_case_deescalation_requested` audit row. Never mutates escalation status — front-line operators get a documented review path without elevating privileges.

### De-escalate Confirm-Time Re-Check

The De-escalate confirmation modal now re-checks `deescalate_support_case` at confirm time (mirrors the close-warn / resolve-escalation pattern) so a stale UI cannot bypass the gate.

### Request De-escalation (visibility rules)

The lightweight Request De-escalation affordance on the escalation banner appears when ALL of (a) the case is currently escalated, (b) the operator cannot actually de-escalate (`hasPlatformPermission(role, 'deescalate_support_case').allowed === false` — i.e. effective level is below the spec `edit` threshold; a View-Only override on de-escalate qualifies), and (c) the operator can add internal notes (`add_internal_support_note` Create or higher). Submitting requires a non-empty reason, re-checks `add_internal_support_note` at confirm time, posts an internal note via `addNote`, and writes a `support_case_deescalation_requested` audit row. It never mutates escalation status — the actual De-escalate path continues to require Approve / Manage / Full Access via the standard confirmation modal with its own confirm-time recheck. When the operator lacks note permission, the request affordance is hidden (preferred per spec) rather than shown disabled.

### Request De-escalation Pending-Review Lifecycle

Submitting a Request De-escalation now persists `deescalationRequestStatus = 'pending'` on the `SupportCaseRecord` (plus `deescalationRequestedAt / By / ByRole / Reason`), alongside the existing internal note + `support_case_deescalation_requested` audit row. While a request is pending, the requester's "Request De-escalation" button is replaced with a non-actionable "De-escalation Request Submitted" pill (one active pending request per case — duplicates blocked at handler level too). Reviewers who hold `deescalate_support_case` see a yellow "Pending De-escalation Request" card directly under the escalation banner showing the requester, requested-at, and reason, with two actions: (1) **Approve & De-escalate** routes through the existing De-escalate confirmation modal (confirm-time re-check intact); on confirm the case is de-escalated AND the request is flipped to `approved` with reviewer + reviewed-at recorded, emitting a paired `support_case_deescalation_request_approved` audit row (in addition to the standard `support_case_deescalated` row). (2) **Reject** opens a modal requiring a rejection reason, re-checks `deescalate_support_case` at confirm-time, marks the request `rejected` with reviewer + reason, adds a timeline note, and emits `support_case_deescalation_request_rejected` — escalation status is never mutated. After a rejection, requesters may submit a new request (default). No external notifications. All new fields are optional / additive so existing seed cases remain valid.

### Escalation Signal Single Source of Truth (`isActiveEscalation`)

A shared predicate `isActiveEscalation(c)` (and convenience `getActiveEscalatedCases(cases)`) in `platformOpsDerive.ts` wraps `effectiveEscalationStatus(c).active` and is the authoritative answer for "is this case actively escalated?" across every surface. All count/list/visibility decisions for escalation MUST route through it:

-   **Support Tools case detail**: the red escalation banner (with reason / who / when / De-escalate or Request De-escalation), the Pending De-escalation Request reviewer card, the rejected-status echo pill, and the header `Escalated` summary pill all gate on `isActiveEscalation(selected)` — so a case escalated via the structured `escalationStatus` (without the legacy `escalated` boolean) still shows the banner, and the banner / detail escalation card / De-escalate button cannot drift apart. The lower escalation detail card already gated on `effectiveEscalationStatus(c).active` for its action buttons and continues to do so.
-   **Command Center**: `escalatedCases` count, `focusedEscalatedCases` widget list, the Mission Control "Escalated" rollup chip, and the per-case `Escalated` badge in the Tenant 360 Open Cases block all use `isActiveEscalation`. Count and list are derived from the same predicate over the same focus-mode-narrowed source — clicking the escalated widget shows exactly the cases counted by the rollup / pulse cell.
-   **Operational Pulse / Needs Attention / Next Best Actions**: the legacy `escalated` pulse cell, `deriveOverallPlatformState`, and the structured escalation NBAs all read from `isActiveEscalation` (the lifecycle sub-cells — unacknowledged, overdue-ack, unassigned — continue to layer their own conditions on top).
-   **Focus Mode source filter**: `applyFocusModeToCases` (Incident Review mode) admits cases via `isActiveEscalation` so a focused escalation cannot disappear from the widget list while still being counted at the top.
-   **Tenant 360 (Command Center drawer)**: `deriveTenant360` returns an `activeEscalations: SupportCaseRecord[]` slice. The drawer renders a dedicated "Active Escalations" block above Open Cases showing status, level, owner-or-team-or-Unassigned, and reason, with a per-case `data-testid="tenant360-escalation-open-<caseId>"` Link that opens the exact case in Support Tools. Tenant Risk Summary continues to flag escalation as a risk signal via `deriveTenantRisk` (open-cases input, which is itself filtered through the shared predicate at the Command Center caller).

### Phase 1.1.3A — Escalation View Model + Count/List Reconciliation (runtime correction)

A focused correction pass fixing four QA failures without scope creep. Two new exports in `platformOpsDerive.ts`:

-   **`buildEscalationViewModel(case): EscalationViewModel`** — the single escalation view model for the Support case detail. It wraps `effectiveEscalationStatus` and returns `{ isActive, isTerminal, status, statusLabel, level, levelLabel, ownerOrTeam, reason, escalatedBy/At, acknowledgedBy/At, pendingDeescalationRequest, canShowEscalationBanner (===isActive), canShowEscalationCard (always true) }`. SupportToolsPage computes `escVm = useMemo(buildEscalationViewModel(selected))` once and every escalation surface reads from it — the red banner (`escVm.canShowEscalationBanner`), the header "Escalated" pill, the reviewer card, the rejected-request pill (`escVm.isActive`), and the escalation detail card's `eff = { status, level, active }` (so the card's De-escalate button can never drift from the banner). This bulletproofs the invariant **"De-escalate visible ⟺ banner/card visible"** and fixes QA #1/#2 (a case escalated via the structured `escalationStatus` without the legacy `escalated:true` boolean now shows the banner). Because `selected` is re-derived from the latest `cases` list by id, the view model never reflects a stale escalation state.
-   **`deriveEscalationSignal(cases, now): EscalationSignal`** — ONE escalation signal `{ activeEscalatedCases, unacknowledgedEscalatedCases, overdueEscalatedCases, unassignedEscalatedCases }` derived via `getActiveEscalatedCases`. CommandCenter computes `escalationSignal = deriveEscalationSignal(focusedCases)` over the SAME focus/time-filtered slice that feeds the Operational Pulse, then builds the Needs Attention "Escalated support case" items AND the lifecycle attention items from `escalationSignal.activeEscalatedCases`. This fixes QA #3/#4: previously the escalation attention items were suppressed by an `alreadyQueuedCaseIds` dedup-skip when a case was already queued as Critical/Overdue, so the escalated pulse COUNT (e.g. 3) disagreed with the escalated FILTER list (0). Count and list now read from one source and cannot drift.
-   **Session refresh consistency (Part F)**: SupportToolsPage adds a `support_cases:changed` / `storage` listener that reloads from the canonical `sessionStorage['support_cases_v1']` store (with a `JSON.stringify` identity guard to prevent the self-dispatched save→dispatch→reload loop), so an escalation mutation on another surface is reflected in the open drawer. Truth label: operational signals refresh from current app/session state — Firestore real-time listeners are future live-backend work.
-   **Support case ROW escalation badge consistency (final correction)**: The Support Tools case-list row renders an explicit red **Escalated** badge (`data-testid="support-case-row-esc-active-<caseId>"`) whenever `effectiveEscalationStatus(c).active` is true — the SAME active-escalation truth source the detail view's `escVm` uses. It appears for EVERY active escalation, including `acknowledged` / `in_review` / security-review states (e.g. case_006 shows "In Review" + "Security Review" + "Security Lead" AND the Escalated badge), so a case that shows the Incident Escalated banner + De-escalate in the detail can never appear un-escalated in the list. The badge is ADDED alongside (never replacing) the existing status / level / Ack-Overdue / Unassigned / owner / Legacy chips. Terminal `deescalated` / `resolved` cases are not active, so they never show it. Because every saved view / queue (All Open, Critical, Unacknowledged Escalations, Escalation Active, Unassigned Escalations, De-escalated, etc.) renders through the single `filteredCases.map` row renderer, the badge is consistent across all of them by construction.
-   **Needs Attention escalation destination (no invisible filter)**: Clicking the Operational Pulse "Escalated" cell sets `activePulseFilter='escalated'`, scrolls the Needs Attention section into view, and renders a VISIBLE "Pulse filter active: Escalated cases" chip (`data-testid="needs-attention-pulse-filter"`) with a "Clear filter ✕" action; the list is filtered to `type === 'Escalated support case'` items and shows a truthful "No items match the active pulse filter." empty state when none. The escalated pulse COUNT and this filtered LIST are derived from the same `deriveEscalationSignal(focusedCases)` source, so count === list length. There is no invisible-filter behavior — the destination always shows the active filter chip, the matching items, or a clear empty state. The Mission Control "Escalated" rollup chip is a non-interactive indicator (no routing). No change to the permissions / dependency auto-sync model.

### Refresh / Session Consistency Note

Support case state is held in `sessionStorage['support_cases_v1']`. SupportToolsPage dispatches `window.dispatchEvent(new Event('support_cases:changed'))` on every mutation; CommandCenter listens for `support_cases:changed` and `storage` events and calls `reloadAll()` so the escalated count / list / Pulse / Needs Attention / NBAs / Tenant 360 reflect the latest case state after navigation or refresh. **Truthful label**: operational signals refresh from the current app / session state — Firestore real-time listeners are future live-backend work.

---

## Phase 1.1.3B — Advanced Command Center Intelligence

A deterministic, rule-based operational-intelligence layer added on top of the existing Command Center. Everything is derived synchronously from the SAME focus-mode / time-range filtered slices that feed the Operational Pulse, so the new surfaces never disagree with existing counts/lists. There is NO AI/ML, no live infra/uptime, no real DNS/SSL/SSO/SCIM, no external notifications, and no Firestore realtime — all signals are computed in `platformOpsDerive.ts` from mock/session data.

-   **Intelligence data model (`platformOpsDerive.ts`)**: New exports `deriveCommercialBlockers` (tenants × billing → failed-payment / provisioning blockers), `deriveCommandSignals` (unified `CommandSignal` stream across escalations, SLA, high-risk audits, domains, commercial), `deriveTenantHealthSignals` (per-tenant `TenantHealthSignal` with `score`/`tier`/`reasons`/`recommendedAction`), `deriveCorrelatedRiskGroups` (clusters related signals into `CorrelatedRiskGroup` episodes with `whyGrouped` + `confidence`), `buildCommandCenterSnapshot` + `diffCommandCenterSnapshots` (review baseline → `SnapshotDelta` with `newlyActive` / `gettingWorse`), `deriveIntelligenceRibbon` (6 `RibbonCard`s with tone + trend + drawer link), and `enrichNextBestActions` + `deriveCommercialNbas` + `nbaMatchesFilter` + `NBA_FILTERS` (NBA upgrade with `actionType` / `category` / `confidence`). Truth-label constants (`INTELLIGENCE_TRUTH_LABEL`, `CORRELATION_TRUTH_LABEL`, `SIGNAL_SOURCE_LABEL`, `ATTENTION_PRIORITY_LABEL`) keep every surface honestly labeled as rule-based.
-   **UI surfaces (`CommandCenterPage.tsx`)**: An Operational Intelligence ribbon (6 clickable cards), a What-Changed panel (newly-active / getting-worse vs. an explicit review baseline with a "Mark reviewed" button), a Tenant Risk Heatmap (tiled by derived risk, opens Tenant 360), a Correlated Episodes list, an upgraded Next Best Actions block (type filter chips + confidence/type pills), and a Command Signal drilldown drawer. The ribbon, what-changed, heatmap, and episodes are gated by the parent `view_command_center` (page-level) check; NBA continues to use `view_next_best_actions` / `act_on_nba_recommendations`; Tenant 360 tiles respect `view_tenant_360`.
-   **Auditability**: A persisted review baseline lives in `localStorage['cc_intel_snapshot_v1']`. "Mark reviewed" writes `command_center_snapshot_saved`; opening any drilldown drawer writes `command_center_intelligence_drawer_opened` (both `info` severity). No new permission keys were introduced — intelligence surfaces reuse the existing Command Center permission model.

### Duplicate Escalated Badge UI Correction

Smallest-safe UI correction. In the Support Tools case list, an active escalated case whose structured status was literally `escalated` showed TWO red "Escalated" badges: the standalone active-escalation badge (`support-case-row-esc-active-<caseId>`) AND the status badge (`support-case-row-esc-status-<caseId>`), because `ESCALATION_STATUS_LABEL.escalated === 'Escalated'`. Fix: the standalone active-escalation badge now renders only when `eff.active && eff.status !== 'escalated'`, so a plain escalated case shows exactly one "Escalated" (the status badge), while other active states (`acknowledged` / `in_review` / security review) still show the standalone "Escalated" badge plus their differently-labeled status badge — one escalation identity badge, no duplicate. Terminal `deescalated` / `resolved` cases are not active and show no active-escalation badge. All other badges (L3, Ack Overdue, Unassigned, Engineering/Platform Ops, In Review, Security Review, Security Lead, Legacy, status, level, owner) are preserved. The active-escalation truth source is unchanged, so detail-view banner / De-escalate / Command Center reconciliation behave identically.

---

## Phase 1.1.3C — Support Queue / SLA / Macro Maturity

A deterministic maturity pass over the owner Support Tools workspace. Everything is rule-based and derived synchronously from the same `supportCases` list the table renders; there is NO AI/ML, no external notifications (templates are internal-only), no Firestore realtime, and no server-side RBAC (UI gating only, reusing the existing Support permission keys). Every new intelligence surface carries a visible truth label.

### Deterministic helpers (`platformOpsDerive.ts`)

-   **Response (first-reply) SLA** — `deriveResponseSlaStatus(c, now)` returns the same `SlaStatus` vocabulary (`on_track` / `at_risk` / `overdue` / `met` / `none`) used by the existing resolution-SLA derivation (`deriveSlaStatus`), so both pills reuse `SLA_STATUS_LABEL` / `SLA_STATUS_STYLES`. It keys off `firstRespondedAt` vs. opened time against a per-severity first-response target; closed/resolved cases without a first response report `met` to avoid false overdue noise.
-   **SLA Policy Preview** — `SLA_POLICY_PREVIEW` (per-severity first-response + resolution targets) plus `SLA_POLICY_PREVIEW_LABEL`. This is **reference-only / read-only** this phase; editable SLA policy authoring is explicitly deferred (documented as future).
-   **Support queues** — `SupportQueueId` + `SUPPORT_QUEUES` (queue metadata: id/label/helper) + `matchesSupportQueue(c, queueId, now)` (single predicate) + `deriveSupportQueues(cases, now)` (returns `SupportQueueSummary` with `count` / `urgentCount` / `oldestDays`). The Queue Center card count and the drilldown list are produced by the **same** `matchesSupportQueue` predicate, so count and list can never drift.
-   **Case signal** — `deriveSupportCaseSignal(c, now)` rolls up response + resolution SLA, effective escalation, age/idle days, `attentionFlags`, and `recommendedActions` into one `SupportCaseSignal` for the case-detail Operations panel. Pure read-only triage aid; it mutates nothing.
-   **Workload** — `deriveSupportWorkload(cases, now)` aggregates open work per owner (`open` / `escalated` / `overdueSla` / `urgent`) as `SupportWorkloadRow[]`. Read-only rollup; no assignment happens here.
-   **Macro placeholders** — `MACRO_PLACEHOLDERS` (placeholder catalogue) + `MacroPlaceholderCtx` (a `Partial<Record<string, string|null|undefined>>`) + `resolveMacroPlaceholders(body, ctx)` which substitutes `{{token}}` tokens from in-app case context and returns `{ text, resolved[], unresolved[] }` so the UI can show which tokens were filled vs. left literal.
-   **Truth labels** — `PHASE_113C_SLA_LABEL`, `PHASE_113C_QUEUE_LABEL`, `PHASE_113C_MACRO_LABEL` keep each surface honestly described as deterministic / rule-based / internal-only.

### Macro data-model maturity (`mockData.ts`)

`SupportMacro` was extended **additively** with optional `purpose` (when to reach for the macro) and `placeholders` (the `{{token}}` keys present in the body) so all existing seeds remain valid. The macro library was expanded to 8 templates (added `macro_first_response`, `macro_status_update`, `macro_resolution`), each given a `purpose`, declared `placeholders`, and `{{token}}` bodies.

### UI surfaces (`SupportToolsPage.tsx`)

-   **Queue Center** — a card grid above the case list; each card is clickable (`selectQueue`) and shows the queue count, an urgent badge, and oldest-age. Selecting a queue puts the list into an **exclusive** queue mode driven by `matchesSupportQueue` (free-text search still narrows on top and is itself visible), shows a removable active-queue chip (`support-active-queue-chip` + clear), and any status-tab click exits queue mode. Count → drilldown cannot drift (shared predicate).
-   **Response + resolution SLA indicators** — the case list SLA cell now shows a secondary "1st reply" pill beneath the existing resolution pill (header layout unchanged), and the case-detail header shows both SLA pills. Both gate on the existing `view_support_sla` permission.
-   **SLA Policy Preview** — a read-only panel (toggle) rendering `SLA_POLICY_PREVIEW` with its truth label, gated by `view_support_sla`.
-   **Workload view** — a read-only panel (toggle) rendering `deriveSupportWorkload` rows with a truth label.
-   **Case Operations panel** — at the top of the case detail drawer, renders `deriveSupportCaseSignal` (SLA states, age/idle, attention flags, recommended actions) labeled deterministic / rule-based / in-app state. Read-only.
-   **Macro library maturity** — `NoteComposer` gained a searchable + category-filtered template library (replacing the single dropdown) and a placeholder-aware preview: the preview resolves `{{token}}`s against case context (`tenant_name`, `case_id`, `case_subject`, `severity`, `status`, `operator_name`, `date`) and shows filled vs. unfilled token chips. Insertion still routes through the existing 2-step pick → preview → Insert Template flow and the existing `support_case_macro_inserted` audit path; templates remain internal-only (no external send). All gated by the existing `use_support_macro`.

### Deferred (documented as future)

-   **Editable SLA policy authoring** — the SLA Policy Preview is read-only this phase.
-   **Safe bulk triage** — multi-select bulk status/assignment actions are deferred.
-   These remain future work; nothing in this phase fakes them.

## Phase 1.1.3C — Support Queue / SLA / Macro Maturity — Focused Correction

A QA-driven correction pass over the same Support Tools workspace. It addressed feedback that the Queue Center cards were low-value, SLA data leaked when `view_support_sla` was denied, queue membership was invisible at the case level, macros inserted raw `{{token}}` text, there was no way to manage templates, and bulk triage looked clickable but did nothing. Still deterministic, rule-based, internal-only — no AI, no external send, no Firestore realtime, no server RBAC.

### Helpers / data / audit

-   **`resolveMacroPlaceholders`** now resolves BOTH `{{token}}` and single-brace `{token}` forms. Any token with no value resolves to a single shared sentinel (`MACRO_UNRESOLVED_TEXT` = "Not available") and is reported in `unresolved[]` so the preview can flag it.
-   **`MACRO_PLACEHOLDERS`** gained `assigned_owner`, `assigned_team`, `sla_status`, `escalation_level`, and `current_date` (alias of `date`). The meta shape uses `key` / `label` / `description`.
-   **`SUPPORT_QUEUES`** metadata gained `purpose` (why the queue matters operationally), `recommendedAction` (the next best action), and `slaDependent` (whether the queue is defined by SLA timing). SLA-dependent queues are gated by `view_support_sla` in the UI.
-   **`deriveSupportQueues`** summaries gained `severityMix`, `unassignedCount` / `assignedCount`, `slaPressure`, `topReason`, `topCases`, and `oldestCaseId` so each card can show real triage substance.
-   **`deriveCaseQueueMemberships(c, now)`** returns the `SupportQueueMeta[]` a single case belongs to, computed via the SAME `matchesSupportQueue` predicate as the Queue Center — so a case's chips can never drift from the queue counts.
-   **Audit** gained `support_macro_created` / `support_macro_updated` / `support_macro_disabled` / `support_macro_enabled` (all `notice` severity).
-   **`SupportMacro`** gained optional `active?` (disabled macros are hidden from the insert picker but kept in the management library) and `origin?` (`seed` vs `custom`). A single-brace demonstration macro (`macro_internal_handoff`) was added.

### UI surfaces (`SupportToolsPage.tsx`)

-   **Part A — Queue Center cards** rewritten (responsive grid) to show purpose, top reason, severity mix, owner/team split, oldest case, SLA pressure (gated), a top 1–3 case preview, the recommended action, and an Open-queue affordance. SLA-dependent cards render a locked state when `view_support_sla` is denied. An unmistakable **Queue Mode** banner (purpose + recommended action + Clear) appears whenever a queue is active; status tabs and saved views still exit queue mode.
-   **Part B — SLA gating** is handler-level, not CSS: the case-table SLA column header and `<td>` are fully omitted (not blanked) when denied, the empty-state `colSpan` adjusts (7/6), and the Workload "Overdue SLA" header + cell, SLA Policy preview, queue cards, membership chips, and the `sla_status` macro token are all suppressed without the permission.
-   **Part C — Queue Memberships** section in the case-detail Operations area renders `deriveCaseQueueMemberships` as chips (same rules as Queue Center), filters out SLA-dependent queues when denied, and shows a truthful empty state.
-   **Part D — Macro resolution**: a single `buildMacroCtx(case)` builds the placeholder context used by BOTH the preview and the actually-inserted note, so inserted notes contain resolved values (and "Not available" for blanks) instead of raw tokens. The composer is fed only `active !== false` macros from state.
-   **Part E — Macro Management** modal (Templates button in the Queue Center toolbar) gated by `manage_support_macros`: create / edit / disable / enable with `localStorage` persistence (`support_macros_v1`, seeds merged with stored) and an audit row per mutation. Operators with only `use_support_macro` get a read-only library view.
-   **Part F — Bulk Triage** is surfaced as an explicit "Future · not yet available" informational panel with a truth label — no checkboxes, no batch mutation, no hidden behaviour.

### Still deferred (unchanged)

-   Editable SLA policy authoring and functional bulk triage remain future work; the correction makes the deferral visible rather than faking the capability.

## Phase 1.1.3C — SLA Visibility Permission Enforcement Correction

A strict focused correction over the same Support Tools workspace. QA found that `view_support_sla` was not fully respected — SLA-specific information still leaked when the permission was denied (notably the Case Operations attention flags / recommended-action copy, SLA-based saved views, and a lingering SLA filter/queue mode). This pass makes `view_support_sla` the single source of truth for ALL SLA visibility in Support Tools. SLA visibility is all-or-nothing for SLA-specific fields this phase. Still deterministic, rule-based, internal-only.

### Central SLA access helper

-   A single boolean `canViewSupportSla` (wrapping `hasPlatformPermission(sessionRole, 'view_support_sla').allowed`) is computed once per render and is the ONLY way SLA visibility is decided anywhere in `SupportToolsPage`. Every prior scattered `viewSupportSlaGate.allowed` check was replaced by this one constant so no surface can compute SLA visibility differently.

### Surfaces gated (all keyed on `canViewSupportSla`)

-   **Case list** — SLA column header + `<td>` omitted (not blanked), empty-state `colSpan` adjusts (7/6), First Response + Resolution pills hidden.
-   **Case detail header** — SLA / 1st-reply pills hidden.
-   **Case Operations panel** — the SLA tiles fall back to a "Restricted" tile, AND `deriveSupportCaseSignal` now takes a `{ canViewSla }` option so SLA-derived attention flags ("Response/Resolution SLA overdue/at risk") and SLA recommended-action copy ("Resolution is overdue …") are never produced when denied. Non-SLA signals (no first response, unassigned, escalation, age/idle) still render.
-   **Queue Memberships** — SLA-dependent queue chips suppressed; truthful empty state preserved.
-   **SLA Policy Preview + toggle** — hidden entirely when denied.
-   **Workload panel** — the "Overdue SLA" header + cell hidden; the rest of the workload rollup remains.
-   **Queue cards** — SLA-dependent cards render a locked/restricted state with no counts or SLA detail; SLA pressure line suppressed.
-   **Saved views / filters** — SLA-status saved views (e.g. "Overdue", `filters.sla`) are removed from the lens row when denied, so no SLA filter option is exposed.
-   **Macro placeholder** — `sla_status` token resolves to "Not available" in both the preview and the inserted note when denied (via the shared `buildMacroCtx`), never exposing live SLA status.

### Queue-mode safety + Queue Center tune-up

-   A render effect clears any SLA-exposing lens when the permission is revoked: it resets the SLA status filter, exits an SLA-based saved view, and exits an SLA-dependent queue, falling back to a safe default list with no SLA leakage.
-   A small Queue Center value note was added: "Queues are operational triage lenses, not just filters. Each queue groups cases by ownership, SLA pressure, escalation, age, and attention reason."

### Non-regression

-   Macro management, macro placeholder resolution (except the SLA-token permission behavior), bulk-triage deferral, escalation operating model, request de-escalation workflow, Command Center intelligence, permission dependency auto-sync, Add-on Governance, Shipping, Store Permissions Matrix, tenant provisioning, paid override invoice workflow, and server PII logging rules are all untouched.

## Phase 1.1.3D — Audit Investigation Center

A deterministic, rule-based investigation workspace layered onto the existing System Owner Audit & Security page. NO AI/ML, NO SIEM, NO realtime listeners, NO prediction, NO immutable/legal-grade/compliance-certified claims, NO external notification, NO server-side RBAC/PIM/PAM. Everything is derived from the same audit data already on screen (`audit_logs` session store + the `auditLogs` seed). Built and accepted milestone-by-milestone.

All investigation derivations live in their own module `src/owner/platformOpsInvestigation.ts` (NOT `platformOpsDerive.ts`, which stays the locked Command Center/SLA/escalation source of truth). The new module reuses the existing `deriveHighRiskFlag` so high-risk classification never forks.

### Data model + helpers (Milestone 1)

-   `AuditInvestigationEvent` — normalized, derived event (1:1 with each raw audit row by `id`): id, date, actor, action, target, severity, category + `categoryFamily`, tenantId, derived `sourceSurface`, before/after values, note, `flag` + `flagReasons`, `isHighRisk`.
-   Truth constraints baked in: audit rows are **date-granular only** (YYYY-MM-DD, no sub-day timestamp, no recorded actor role, no recorded source surface). Correlation windows are therefore expressed in **whole days** (`dayIndex()`), never hours. `sourceSurface` is **derived** best-effort from category and labeled as derived, never claimed as recorded.

### Layout + search / filters / lenses (Milestone 2)

-   `AuditSearchQueryState` + `matchesAuditSearch(event, query, ctx)` single predicate drives the visible list; `countForLens` runs the SAME functions over the same `investigationEvents`, so **count and list can never drift**.
-   Investigation lenses / saved views (`AUDIT_INVESTIGATION_LENSES`): all, high_risk, unlinked_high_risk, needs_review, restricted, etc. Selecting a lens resets ad-hoc filters so the visible list equals the lens card count.
-   **No invisible filters**: every active filter (keyword, severity, time, category, tenant, actor, action, source, review status, linked-case, restricted-only, high-risk-only) plus the active lens renders as a visible, removable chip with a truthful empty state.

### Drawer + actor profile + entity timeline + correlation (Milestone 3)

-   The page keeps `selected: AuditRow | null` as the single selection unit; derivations operate on normalized investigation events, bridged by `rowById`. Any clickable derived item resolves back to its row before `setSelected`.
-   Investigation drawer tabs: Detail (with rule-based "why this matters" risk signals), Related entity timeline, Entity/actor timeline, and Actor profile — actor profile + related timeline respect `view_restricted_audit_details`.
-   Correlated event groups: card count and expanded member list both derive from `group.eventIds` (one source), with a plain-language "why grouped" explanation. Day-window based, labeled deterministic.

### Review status + investigation notes + case-from-audit + evidence (Milestone 4)

-   **Review status overlay** — each event carries `needs_review` (default) / `reviewed` / `dismissed`. Persisted in a SEPARATE session overlay (`AUDIT_INVESTIGATION_STORAGE_KEY`, dispatches `audit_investigation:changed`), distinct from both the audit rows and the existing global `SecurityNote` system (`platform_security_notes`). **Original audit rows are never mutated.** A "last set by … · timestamp" stamp records attribution.
-   **Investigation notes** — internal-only, timestamped, actor + role recorded, **append-only** (prepend, newest-first). Delete goes through a confirmation modal.
-   **Permission reuse (no new keys)** — marking review status and adding an investigation note reuse `add_security_note`; deleting an investigation note reuses `delete_security_note`. Honors the locked permissions architecture: no new permission keys were introduced.
-   **No audit spam** — all overlay writes go through pure helpers (`setAuditReviewStatus` / `addAuditInvestigationNote` / `deleteAuditInvestigationNote`) + `writeAuditInvestigationState`; handlers read fresh via `readAuditInvestigationState()` before writing (no stale closures). `markReview` no-ops when the status is unchanged, so only real transitions emit an audit row. Five new audit actions: `audit_event_marked_reviewed`, `audit_event_marked_needs_review`, `audit_event_dismissed`, `audit_investigation_note_added`, `audit_investigation_note_deleted`.
-   **Evidence summary (Part K)** — `buildAuditEvidenceSummary` / `formatEvidenceSummaryText` produce a deterministic, internal, **copy-only** plain-text summary (Preview + Copy) assembled from on-screen data: event facts, rule-based risk signals, related event IDs, notes, linked case, review status. Explicitly labeled internal and **not** legal/compliance-certified. The Part K "should include" list is treated as the EXCLUSION list: no legal-grade vault, no automated containment/remediation, no external notification, no server RBAC. Restricted detail (flag reasons + free-form note on flagged events) is redacted with an explicit `[restricted …]` placeholder unless `view_restricted_audit_details` is granted — never silently dropped.
-   **Duplicate support-case prevention (Part J)** — `createCaseFromEvent` reads FRESH persisted cases from storage (`readPersistedCases`, not React state) and holds a synchronous `useRef` re-entrancy lock, so a double-click / stale render cannot create two linked cases for the same audit event. Created cases still open the Support Tools case detail.

### Command Center click-through + non-regression (Milestone 5)

-   Command Center high-risk audit/security signals now deep-link to the exact event: both the Needs Attention queue items and the High-risk audit stream widget rows link to `/owner/audit-security?event=<id>`, which opens that event's investigation drawer (Detail tab). The Tenant 360 quick link continues to deep-link `/owner/audit-security?tenant=<id>`.
-   The Audit & Security page reads `?event`, `?tenant`, and (optional, validated) `?lens` on mount. Applied params become a **visible, clearable chip** (tenant / lens) or an opened drawer (event) — never an invisible filter — and the URL is cleared afterward so the deep-link is not sticky on refresh. The deep-linked event is resolved once async-loaded rows are available. A stale/invalid `?event` id **fails loudly**: if it can't be resolved shortly after rows load, a dismissible notice is shown and the pending id is cleared, so it never lingers or auto-opens a drawer later.
-   **Non-regression** — Command Center Intelligence, Support Queue / SLA / Macro Maturity, the escalation operating model + `isActiveEscalation` single source of truth, permission dependency auto-sync, Add-on Governance, Shipping, Store Permissions Matrix, tenant provisioning, paid override invoice workflow, and server PII logging rules are all untouched. Permission enforcement remains UI-only this phase.

## Phase 1.2 — Domains + Platform Settings Maturity

A deterministic, rule-based maturity pass over the System Owner **Domains** and **Platform Settings** surfaces. NO real DNS lookups, NO SSL automation/issuance, NO provider/registrar integrations, NO external notifications, NO SSO/SCIM, NO server-side RBAC/PIM/PAM, NO realtime listeners, NO runtime enforcement. Everything is derived from seeded mock data + in-session `localStorage`. Built and accepted milestone-by-milestone (M1–M4 each accepted before the next; M5 = cross-surface verification + docs).

### Domains model + helpers (Milestones 1–2 — `platformOpsDomains.ts`)

-   New pure module `src/owner/platformOpsDomains.ts` holds the domain governance model and all derivations, separate from the locked `platformOpsDerive.ts` (Command Center) and `platformOpsInvestigation.ts` (Audit). It re-exports the underlying `DomainStatus` / `DomainSslStatus` / `DomainKind` field vocabulary from `mockData.ts` and layers a **derived** `DomainLifecycleStatus` on top (`deriveDomainLifecycle`) — the raw `status` / `ssl` fields on `TenantDomainRecord` are unchanged, so any surface that reads them keeps working.
-   Deterministic DNS/SSL **readiness** is derived and rendered as instructions + manual-verify guidance, never as a live check. A domain "issue" classification (`deriveDomainIssue`) covers failed verification, SSL failure, pending custom-domain DNS, verifying/subdomain-pending, and verified-but-SSL-pending. Truth labels make clear these are manual/operator-confirmed states, not real propagation checks.
-   **Single domain store**: the Domains page, Command Center, Support Tools, and Dashboard all read the same `tenant_domains_v1` `localStorage` key (seeded from `tenantDomains`), so domain counts/signals cannot diverge across surfaces.

### Domain lifecycle UX (Milestone 2 — `DomainsPage.tsx`)

-   Lifecycle actions are explicit, confirmed, and audited: create, status change, mark SSL state, disable, re-enable, delete. Destructive transitions (disable/delete) go through confirmation modals (Framer Motion via `motion/react`), never a silent `<select>` `onChange`.
-   Each action emits a typed audit row (`domain_created` / `domain_status_changed` / `domain_ssl_changed` / `domain_disabled` / `domain_reenabled` / `domain_deleted`) under category `domains`. Page visibility uses `view_domains`; lifecycle mutation uses `manage_domain_lifecycle`.
-   Faceted counts use one predicate per facet (no drift), and all readiness/DNS/SSL guidance carries explicit "no real DNS/SSL, manual verification" truth labels.

### Platform Settings governance model (Milestone 3 — `platformOpsSettings.ts`)

-   New pure registry `src/owner/platformOpsSettings.ts`: `SETTINGS_REGISTRY` has **one entry per `platformDefaults` field**, each carrying key / group / field / label / description / valueType / default / **enforcement** / **risk** / **owner** / **impactSummary** / **truthLabel** (plus min/max/placeholder for rendering). Helpers: `getSettingValue`, `getSettingDefault`, `isSettingModified`, `formatSettingValue`, `getSettingsForGroup`, `getSettingByKey`, `deriveSettingsPosture`.
-   **Enforcement honesty**: the `enforced` value exists in the type for future use but is assigned to **nothing** today — branding/support are `display_only`, maintenance is `advisory` (banner only), security is `documentation_only`. The page carries three standing truth labels (governance is rule-based · nothing is enforced at runtime · real enforcement is future work).
-   Page visibility uses `hasEffectiveFeatureAccess('platform_settings')` (parent level OR any child sub-permission ≥ view), per the locked Global Permissions Matrix rule; editing is gated separately by the child `edit_platform_settings` (read-only otherwise). A code review corrected an initial over-restrictive gate that used the child `view_platform_settings`.

### Settings change-review / impact / audit UX (Milestone 4 — `PlatformSettingsPage.tsx`)

-   **Review before save**: each group's "Review & Save (N)" opens a review modal listing every changed setting with an old → new diff, risk + enforcement badges, impact summary, and truth label. The review list derives from the **unfiltered** change set (`changedByGroup`), so an active search / group filter can never hide a change about to be persisted.
-   **High-risk confirmation**: a batch containing any high-risk setting shows a red banner + a required acknowledgment checkbox; Confirm & Save is gated by the checkbox **and** re-checked defensively inside the save handler (no UI bypass).
-   **Reset-to-default**: per-setting reset (shown when draft ≠ default) confirms draft → default, stages the default into the draft only, then flows through the same review/save path — no separate reset audit row.
-   **Search / nav / unsaved state**: search over label/description/key/owner/impact; group pills (All + 4 groups, dirty dots); visible clearable filter chips + truthful empty state; header unsaved total + dirty-group count; per-group "N unsaved" badge; per-row unsaved highlight; per-group Discard; and a `beforeunload` guard while changes are pending.
-   **No drift / preserved persistence**: one predicate `isChangedFromPersisted` feeds dirty counts, badges, the review list, and the audit note. Persistence is unchanged (`platform_settings_v1` key); exactly **one** `pushPlatformAudit('platform_setting_updated')` row (category `configuration`) per confirmed group save — severity `warning` if any high-risk, else `notice`. All mutation entrypoints (update/review/save/reset/discard) self-gate on `canEdit`.

### Cross-surface integration + non-regression (Milestone 5)

-   **Command Center domain signals verified accurate** after the Domains maturity work: `deriveCommandSignals` / `deriveTenantRisk` read the raw `status` (`failed` / `pending` / `verifying`) and `ssl` fields from the shared `tenant_domains_v1` store — the same fields the matured model preserves — so failed/pending domain signals and tenant domain risk stay correct. The added derived `DomainLifecycleStatus` is presentation-only and is not consumed by Command Center.
-   **Platform-settings risk is read-only and truthful**: Command Center does NOT read `platformOpsSettings` / `platform_settings_v1` / `platformDefaults`; the only "risk" surfacing for settings is the Platform Settings page's own posture (high-risk / high-risk-modified), explicitly labeled not-enforced. No fake runtime enforcement anywhere.
-   **Audit & Security coverage confirmed**: the page's category filter includes `domains` and `configuration`, so domain lifecycle rows and `platform_setting_updated` rows surface where emitted.
-   **Non-regression**: Command Center Intelligence, Support Queue / SLA / Macro Maturity, the Audit Investigation Center, the escalation operating model + `isActiveEscalation` single source of truth, permission dependency auto-sync, Add-on Governance, Shipping, Store Permissions Matrix, tenant provisioning, paid override invoice workflow, and server PII logging rules are all untouched. Permission enforcement remains UI-only this phase. Typecheck baseline unchanged (only pre-existing errors in untouched non-owner files).

## Phase 1.2 — Focused Acceptance Correction

A scoped pass over six QA HOLD items raised against the Phase 1.2 deliverable. No phase reopen, no scope beyond the six items, and none of the locked rules above were relaxed. Still **no real DNS/SSL/provider/notifications/SSO/SCIM/server-RBAC/realtime**, and **no new permission keys** (reuses `view_domains` / `manage_domain_lifecycle` / `edit_platform_settings`).

### A/B — Lifecycle tab / posture clickability affordance

-   Tailwind v4 no longer applies `cursor: pointer` to `<button>` by default, which made the Domains lifecycle tabs, posture cards, filter chips, "Clear all", and "+ Add" controls feel unclickable. Added explicit `cursor-pointer` plus an `active:` press feel to those affordances. The existing filter/clear behavior was verified working — this was purely a missing affordance, not a broken handler.

### C — Add Domain three-mode create flow

-   The Add-Domain modal now supports three explicit create modes: **root** (custom apex domain), **subdomain** (under a tenant's existing managed root), and **platform subdomain** (under the platform root suffix). Subdomain mode offers a parent dropdown sourced from the tenant's existing root domains with a truthful empty state when none exist. Each mode shows a live composed-hostname preview and mode-appropriate validation (`DNS_LABEL_RE` for labels, `ROOT_DOMAIN_RE` for apex domains). `handleCreate` records `domainRole` and `parentDomainId` accordingly.

### D — Root vs subdomain distinction (list + drawer)

-   Domain role is derived (`deriveDomainRole`) and surfaced as a Role column in the list and a role badge in the drawer. The drawer adds a Hierarchy section: a root shows its child subdomains; a subdomain shows its managed parent (or the platform root for platform subdomains). The raw `status`/`ssl`/`kind` fields remain the source of truth — role/hierarchy are a derived presentation layer.

### E — Platform Settings Default Baseline (editable override store)

-   A second **Default Baseline** mode on the Platform Settings page edits the registry default baseline through a separate override store (`platform_settings_defaults_v1` localStorage key), distinct from the in-effect settings store (`platform_settings_v1`). Helpers `getRegistryDefault` / `getEffectiveDefault(def, overrides?)` / `isDefaultOverridden` and an override-aware `isSettingModified` / `deriveSettingsPosture` (optional param, backward compatible) keep both surfaces consistent.
-   Baseline edits flow through the same review-before-save discipline: per-group review modal with registry-default → new diff, high-risk acknowledgment (re-checked inside the handler), and exactly one `platform_setting_default_updated` audit row (category `configuration`) per confirmed group save. Saving drops an override key when its value equals the registry default (no-noise store). Baseline reset stages the registry default into the draft and flows through the same review/save path. The in-effect **Settings** mode now resets to and compares against the **effective** default (registry ± baseline override), so the two surfaces never disagree.

### F — Command Center domain deep-linking

-   Per-domain Command Center attention items, next-best-action items, and `failed_domain` / `pending_domain` operational signals now link to `/owner/domains?domain=<id>` instead of the bare page. Generic domain-bucket drilldowns keep their existing `?status=<key>` behavior. The Domains page reads `?domain` and `?status` via `useSearchParams`: a valid `?domain` opens that domain's drawer, a stale id shows a truthful "domain no longer exists" notice, `?status` pre-applies the raw-status filter (with a visible clearable chip), and the params are stripped (`replace: true`) after being honored so a refresh/back doesn't re-trigger.

### Verification

-   Typecheck baseline unchanged at 12 pre-existing errors, all in untouched non-owner files (server adapters/event-processor, Dashboard/Login/POS/ShippingCenter/TemplateEditor, Owner/Tenant layouts, BillingPage). All files touched in this correction (`mockData.ts`, `platformOpsDomains.ts`, `platformOpsSettings.ts`, `platformOpsAudit.ts`, `DomainsPage.tsx`, `PlatformSettingsPage.tsx`, `CommandCenterPage.tsx`, `platformOpsDerive.ts`) typecheck clean.

## Phase 1.2 — Domain Control Panel + Default Baseline UX Correction

A second focused, presentation-layer correction over the same surfaces. No phase reopen, no new permission keys (reuses `view_domains` / `manage_domain_lifecycle` / `view_platform_settings` / `edit_platform_settings`), no real DNS/SSL/DNSSEC/registrar/provider/notification work. All additions are deterministic, rule-based derivations over the existing `tenant_domains_v1` store and registry; the raw `status`/`ssl`/`kind` fields remain the source of truth.

### A — Domain Control Panel model (drawer)

-   The domain drawer now reads like an operator control panel. New derivations live in `platformOpsDomains.ts` (the separate, non-locked module): `deriveDomainDnsReadiness` (a DNS-configuration concept distinct from SSL — `managed` for platform subdomains, `not_configured` → `propagating` → `confirmed` for custom domains, plus `failed` / `not_applicable`), and `deriveDomainSecurityIndicators` returning SSL (mapped from the live recorded readiness) plus **DNSSEC, domain lock, and transfer protection** as `future` registrar-level placeholders. All are surfaced in a "Security & readiness" section with truth labels (`DOMAIN_TRUTH_LABELS.futureSecurity`). A registrar/DNS-provider explanation note (`DOMAIN_TRUTH_LABELS.registrarExternal`) makes explicit that registrar ownership and DNS provider configuration are managed outside the app this phase.

### B — Root Domain Management section

-   For root domains the drawer section is titled "Root domain management" and lists the related (child) subdomains with a truthful empty state, alongside the existing required DNS records, security/readiness, action checklist, and risk reasons.

### C — Subdomain management clarity

-   For subdomains the section is titled "Subdomain details" and adds an inherited-relationship explanation: the hostname is generated from the editable label plus the locked root domain, and routing/SSL handling is inherited from the root. The parent root (or shared platform root) link is retained.

### D — Manual action checklist

-   `deriveDomainChecklist` produces a read-only, lifecycle-derived checklist of manual operator steps (add DNS records → confirm propagation externally → mark verified → review SSL → mark SSL ready; with `failed`/`disabled`/platform-subdomain variants). Each step carries a `done`/`current`/`todo`/`future` state and an optional hint; the section is truth-labeled as manual (`DOMAIN_TRUTH_LABELS.manual`) and performs no automation, DNS lookup, or provider call.

### E — Default Baseline UX simplification

-   The Platform Settings Default Baseline mode gains a concise, plain-language explanation card: what the baseline does (the fallback used by Settings-tab "Reset to default"), that editing it never changes the in-effect setting and is enforced by nothing at runtime, and a three-step edit → review & save → reset flow summary. The existing baseline rows already expose current baseline, registry default, customized/overridden badge, risk, and enforcement — no change to the override store, review/diff, high-risk acknowledgment, audit (`platform_setting_default_updated`), or reset path.

### F — Command Center deep-linking (verified)

-   Per-domain Command Center hrefs (`/owner/domains?domain=<id>`) and the Domains page `?domain`/`?status` reader remain intact and unchanged.

### Verification

-   Typecheck baseline unchanged at 12 pre-existing errors, all in untouched non-owner files. The files touched in this correction (`platformOpsDomains.ts`, `DomainsPage.tsx`, `PlatformSettingsPage.tsx`) typecheck clean.
