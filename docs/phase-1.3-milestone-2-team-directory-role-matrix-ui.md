# Phase 1.3 — Milestone 2: Platform Team Directory + Role Matrix UI

> **Status:** UI maturity only — **non-enforcing**. This milestone makes the Platform Team Management area consume the
> Milestone 1 **advisory** governance model for display purposes. **No permission behavior changed.** Current platform
> access remains **UI/client-gated only**. There is **no PIM, no access-review workflow, no temporary-access workflow,
> no server-side enforcement, no scheduler, and no new persistence** in this milestone.

Touched surface: [`src/owner/TeamManagementPage.tsx`](../src/owner/TeamManagementPage.tsx).
Advisory model consumed: [`src/owner/platformTeamGovernance.ts`](../src/owner/platformTeamGovernance.ts) (Milestone 1).
Built on the Milestone 0 inventory: [`docs/phase-1.3-platform-access-inventory.md`](phase-1.3-platform-access-inventory.md).

> **Note on file location:** the Phase 1.3 planning prompt referenced `src/pages/owner/TeamManagementPage.tsx`. The
> actual file in this repo is `src/owner/TeamManagementPage.tsx` (this project keeps owner pages under `src/owner/`, not
> `src/pages/owner/`). No file was moved; the existing path was edited in place.

---

## 1. What Milestone 2 added

All additions are **display-only** and consume the Milestone 1 advisory helpers/catalog. The permission resolver and
every permission behavior are untouched.

**Platform Team Directory (Team tab)**
- The directory table now resolves each member's role string onto the governance catalog and shows, per member:
  - **Role & Governance** — role badge plus the role's governance category (or a truthful fallback for non-catalog roles).
  - **Access Posture (advisory)** — a compact badge cluster: risk posture, recommended review cadence, *System Protected*
    (where applicable), *Included in Future Access Review* / *Not in Access-Review Scope*, *Temp Elevation Eligible —
    Future* / *No Temp Elevation*, and a standing *UI-Gated Today* badge.
  - **Last Activity** — carried through from the directory data (`lastActiveAt`), with the truthful fallback
    **“Last activity not recorded”** when absent (e.g. invited-but-never-active members, or members added in-session).
- Member role purposes surface as hover tooltips; nothing is fabricated.

**Role Catalog — Governance (Roles tab)**
- A new read-only **“Platform Role Catalog — Governance”** section shows the five **current** platform roles
  (System Owner, Support Admin, Billing Admin, Operations Admin, Security/Audit Admin) with purpose, governance category,
  risk posture, review cadence, access-review inclusion, temporary-elevation eligibility, the system-protected badge, the
  catalog notes/warnings, and a *UI-Gated Today · Server Enforcement Future* footnote.
- A clearly separated **“Future / Deferred Role Concepts”** area renders `FUTURE_ROLE_CONCEPTS` (Read-only Auditor,
  Platform Admin) as **documented concepts only** — explicitly not active roles, not assignable, not wired anywhere.
- The pre-existing custom-role grid, **Create Role** flow, and **Manage Permissions** behavior are preserved unchanged
  below the new section.

**Global Permissions Matrix (Permissions tab)**
- The matrix structure, level selects, thresholds, sensitive badges, dependency indicators, reconciliation notice, and
  the resolver-driven enabled/blocked/disabled states are **preserved exactly**.
- The matrix truth banner gained one additional **advisory** line clarifying that sensitive flags and risk/cadence/
  enforcement-tier guidance are display labels only and never change a level, threshold, or decision.

**Effective Access Preview (Permissions tab)**
- When a platform role is previewed, an **advisory governance summary** (risk, governance category, review cadence,
  system-protected, temporary-elevation eligibility) renders above the per-feature grid, with an explicit note that the
  labels do not change the access decision below.
- The grid itself is still produced **solely** by the unchanged resolver (`explainAccessDecision`,
  `getPlatformFeatureLevel`, `getPlatformSubPermissionLevel`).

**Truthful governance notice**
- A new, non-alarming notice in the Team Management header states: *“Current platform access controls are UI/client-gated
  in this phase. Server-side enforcement, automated access review, and temporary access workflows are future/deferred.”*
  It is accompanied by the model's standing status line (`PLATFORM_GOVERNANCE_MODEL_STATUS`).

## 2. The UI consumes advisory governance labels only

Every governance value rendered comes from the Milestone 1 module's pure helpers/catalog
(`getRoleGovernanceSummary`, `PLATFORM_ROLE_CATALOG`, `FUTURE_ROLE_CONCEPTS`, `isPlatformRoleId`,
`PLATFORM_GOVERNANCE_MODEL_STATUS`). None of these are used to allow or block any action — they drive **labels, badges,
summaries, and helper text** exclusively.

## 3. No permission behavior changed

`platformPermissionMeets`, `explainAccessDecision`, `hasPlatformPermission`/`hasEffectiveFeatureAccess`,
`hasSectionAccess`/`hasActionAccess`, `AccessContext.canAccess`, platform role defaults, platform permission thresholds,
the dependency auto-sync, and `accessConfig.ts` are all **unchanged**. The matrix still reads/writes the same
`platform_permissions_v1` session override store via the same handlers; System Owner remains locked at Full Access.

## 4. No PIM / access-review / temporary-access workflow is active

No workflow, persistence, scheduler, reason prompt, approval flow, or automatic expiration was added. Temporary-elevation
eligibility and access-review inclusion are shown strictly as **advisory planning labels**.

## 5. No server-side enforcement was added

`server/index.ts`, Firestore rules, routes, and server middleware were not touched. Server-side enforcement remains
future/deferred and is labeled as such in the UI.

## 6. Current platform gating remains UI/client-gated only

Reaffirmed in the new header notice, the matrix banner, the directory badges (*UI-Gated Today*), and the role catalog
footnotes (*Server Enforcement Future*).

## 7. Role assignment is unchanged

The existing **Edit Platform Member** flow (which can change a member's role/status and already emits audit rows) and the
**Create Role** flow are **preserved as-is**. Milestone 2 added **no** new role-mutation workflow, **no** reason prompt,
**no** PIM, and **no** access-review step — only advisory context around the existing behavior.

## 8. Additive data carry-through (no new stores)

`lastActiveAt` / `invitedAt` are now carried through from the existing `platformTeamMembers` mock into the in-memory
directory state as **optional display fields**. No new localStorage/sessionStorage governance store was introduced;
members added in-session simply fall back to truthful “not recorded” copy.

## 9. Empty / missing-data handling

- Unknown / custom (non-catalog) role → *“Custom / non-catalog role — no governance metadata”* (still shows *UI-Gated Today*).
- Missing last activity → *“Last activity not recorded”*.
- Missing governance catalog entry → governance category shown as *“Governance category not catalogued”*.
- All fallbacks are truthful; no placeholder is fabricated and nothing crashes.

## 10. What remains for later milestones

- **Milestone 3 — Temporary Access / PIM foundation:** a real store + UI for `TemporaryAccessGrant` with reason capture
  and audit (still derived expiry until a scheduler exists).
- **Milestone 4 — Access Review + sensitive-action reason capture:** `AccessReviewRecord` workflow, stale-access
  flagging, and reason prompts for privileged actions from `PRIVILEGED_ACTION_CATALOG`.
- **Milestone 5 — Command Center / Audit integration:** surfacing privileged-action signals using the catalog +
  `getFutureServerEnforcementRecommendation`.
- **Future phases:** actual server-side RBAC/PIM/PAM enforcement reusing (never forking) the resolver model.

## 11. Truthful labels reaffirmed

advisory · future/deferred · UI/client-gated only · no active workflow · no server-side enforcement · no scheduler ·
no persistence. System Owner remains system-protected and is not downgradeable through this milestone.

## 12. Non-regression confirmation

No permission, resolver, threshold, default, reconciliation, route, model, server, or Firestore-rule behavior changed.
The only code change is additive, display-only UI in `src/owner/TeamManagementPage.tsx` consuming the existing Milestone 1
module. `tsc --noEmit` remains at the pre-existing baseline (12 errors, all pre-existing and unrelated; none in the files
touched by this milestone — see the milestone reply for the exact result).
