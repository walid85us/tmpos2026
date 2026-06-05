# Phase 1.3 — Milestone 1: Platform Team Governance Model

> **Status:** Additive model only — **non-enforcing**. This milestone adds the foundational governance *types, constants, and pure helper logic* that later Phase 1.3 milestones will build on. **No current permission behavior changed.** Current platform access remains **UI/client-gated only**; server-side enforcement, PIM, and access-review workflows remain **future/deferred**. There is **no persistence, no UI, no workflow, no scheduler, and no automatic expiration** in this milestone. Every helper output is an **advisory label/recommendation** and must never block an action.

Source module: [`src/owner/platformTeamGovernance.ts`](../src/owner/platformTeamGovernance.ts).
Built on the Milestone 0 inventory: [`docs/phase-1.3-platform-access-inventory.md`](phase-1.3-platform-access-inventory.md).

---

## 1. What Milestone 1 added

A single pure module, `src/owner/platformTeamGovernance.ts`, containing:

- **Role catalog metadata** for the 5 **current** platform roles (`PLATFORM_ROLE_CATALOG`).
- **Governance category** labels (`GovernanceCategory`, `GOVERNANCE_CATEGORY_LABEL`).
- **Risk posture** + **review cadence** label maps.
- **Privileged/sensitive action catalog** (`PRIVILEGED_ACTION_CATALOG`, 14 categories) derived from Milestone 0 tiers.
- **Server-side enforcement boundary labels** (`ServerEnforcementBoundaryLabel`) mirroring the Milestone 0 Tier 0–3 model.
- **Temporary access types** (`TemporaryAccessGrant`, `TemporaryAccessStatus`) — future use only.
- **Access review types** (`AccessReviewRecord`, `AccessReviewStatus`) — future use only.
- **Future role concepts** (`FUTURE_ROLE_CONCEPTS`: Read-only Auditor, Platform Admin) — documented as **deferred concepts only**, not active roles, not wired anywhere.
- **Pure helper functions** (advisory only) — see §5.

The module reuses the existing `Role`, `PermissionLevel`, `PlatformFeatureKey`, and `PLATFORM_ROLE_DISPLAY_LABEL` from the permission config — it **does not fork** the resolver model.

## 2. The model is additive and non-enforcing today

Nothing in this module is wired to runtime behavior. It exports data + pure functions. The resolver (`explainAccessDecision`), `platformPermissionMeets`, the wrappers, role defaults, thresholds, and dependency auto-sync are **untouched**. No callsite consumes this module yet.

## 3. Current platform access remains UI/client-gated

As documented in Milestone 0: `server/index.ts` enforces only shipping-provider config + test-mode; it does **not** check platform roles or sub-permissions. This module does not change that — it only labels the boundary for future planning.

## 4. Server-side enforcement remains future work

The `ServerEnforcementBoundaryLabel` values (`ui_only_currently`, `future_server_validation_recommended`, `future_server_validation_strongly_required`, `future_privileged_pim_controlled_server_action`) are **advisory labels for documentation and planning**. No backend enforcement is implemented. Any future server enforcement must reuse the resolver model, never fork it.

## 5. PIM / access-review workflows are not active

The temporary-access and access-review **types** exist for future milestones, but there is **no workflow, no persistence, and no UI**. The pure helpers compute **derived/lazy** status only:

- **Temporary access:** `getTemporaryAccessStatus`, `isTemporaryAccessActive`, `isTemporaryAccessExpired`, `getTemporaryAccessDisplayLabel`.
- **Access review:** `isAccessReviewOverdue`, `getAccessReviewStatusLabel`, `shouldIncludeRoleInAccessReview`, `getRecommendedReviewCadence`.
- **Role risk / governance:** `getRoleRiskPosture`, `getRoleGovernanceSummary`.
- **Privileged-action advisories:** `shouldRequireReasonForPrivilegedAction`, `shouldAuditPrivilegedAction`, `shouldRecommendPimForAction`, `getFutureServerEnforcementRecommendation`.
- **Utility:** `isPlatformRoleId` (type guard).

## 6. No automated expiration exists

Temporary-access status is computed at read time from the `[startsAt, expiresAt)` window against a caller-supplied `now`. **There is no scheduler and no automatic revocation.** A grant only *appears* expired when something reads it after `expiresAt`.

## 7. Helper outputs are advisory labels only

Every helper returns a label, recommendation, boolean hint, or derived status. **None block actions or change permissions.** They exist to drive future UI copy, future audit context, and future planning decisions.

## 8. How this prepares later milestones

- **Milestone 2 (Directory + Role Matrix UI):** `PLATFORM_ROLE_CATALOG`, `getRoleGovernanceSummary`, `getRoleRiskPosture`, and `getRecommendedReviewCadence` provide the role metadata + advisory labels the directory/role-matrix UI can display (read-only, no behavior change).
- **Milestone 3 (Temporary Access / PIM Foundation):** `TemporaryAccessGrant` + the temporary-access helpers define the shape and derived-status logic; a future store/UI can adopt them with reason capture and audit (still derived expiry until a scheduler exists).
- **Milestone 4 (Access Review + Sensitive-Action Reason Capture):** `AccessReviewRecord` + the access-review helpers and `PRIVILEGED_ACTION_CATALOG` (`shouldRequireReasonForPrivilegedAction`, `shouldAuditPrivilegedAction`) define which actions warrant reason prompts and how stale access is flagged.
- **Milestone 5 (Command Center / Audit integration):** `PRIVILEGED_ACTION_CATALOG` + `getFutureServerEnforcementRecommendation` provide consistent categories/labels for surfacing privileged-action signals.

## 9. Truthful labels reaffirmed

advisory · future/deferred · no active enforcement · no scheduler · no persistence · no workflow yet · UI/client-gated only. System Owner remains system-protected and is **not** downgradeable through this milestone.

## 10. Non-regression confirmation

No code behavior changed. The only code addition is the new pure module (no imports of it elsewhere). No UI, route, model, persistence, resolver, threshold, default, or server change. Typecheck remains at the pre-existing baseline (see the milestone reply for the exact result).
