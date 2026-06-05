# Phase 1.3 — Milestone 0: Current Access Inventory & Server-Side Enforcement Classification

> **Status:** Documentation / inventory only. **No code, behavior, permission, resolver, route, model, mock-data, UI, or server changes were made in this milestone.** This artifact establishes the authoritative picture of the current platform permission / RBAC model and classifies future server-side enforcement needs *before* any Phase 1.3 governance implementation (Milestones 1–5) begins.
>
> **Truthful enforcement reality (today):** Current enforcement state is **UI/client-gated only**. Server-side platform RBAC enforcement is **not implemented**. There is **no scheduler**, **no backend enforcement currently active**, **no PIM/PAM**, **no SSO/SCIM**, and **no compliance-evidence automation**. Every "future" item below is a recommendation, not an existing capability.

Cross-referenced from [`replit.md`](../replit.md) and [`docs/platform-operations-security-history.md`](platform-operations-security-history.md).

---

## 1. Current Platform Permission Architecture

- **`src/owner/platformPermissionsConfig.ts`** is the single **platform** permission source of truth (feature groups, sub-permissions, thresholds, sensitive flags, dependency map, role defaults, resolver).
- **`src/context/accessConfig.ts`** is the separate **tenant/store** permission source of truth (`Role` union, `PERMISSION_HIERARCHY`, Store Permissions Matrix).
- **Platform permissions and tenant/store permissions are two separate systems.** Tenant-side roles (`store_owner`, `manager`, `technician`, `sales_staff`) have **no** platform access by default (`ALL_NONE`).
- **Ranked platform levels (low → high):** `none / view / create / edit / approve / manage / full`.
- **`platformPermissionMeets(actual, threshold)`** performs spec-aligned rank comparison (e.g. a `manage` actual satisfies an `approve` threshold).
- **Override storage:** `sessionStorage` key `platform_permissions_v1` (`PLATFORM_PERMISSIONS_STORAGE_KEY`), shape `{ [roleId]: { features: {...}, subs: {...} } }`. Session-scoped only — **not durable backend state**.

---

## 2. Current Platform Feature Groups

11 feature groups (`PLATFORM_FEATURE_GROUPS`). All are **UI/client-gated only** today.

| # | Key | Label | Purpose | Contains sensitive sub-perms? | Future server-enforcement recommendation |
|---|-----|-------|---------|:---:|---|
| 1 | `command_center` | Command Center | Platform pulse, NBA recommendations, Tenant 360 quick access | No | Tier 0–1 (read/nav; one action-through) |
| 2 | `audit_security` | Audit & Security | Audit log viewer, security notes, audit-driven case creation | Yes | Tier 1–2 (data exposure, destructive note delete, restricted detail) |
| 3 | `support_tools` | Support Tools | Support cases, escalation lifecycle, impersonation links | Yes | Tier 1–2 (lifecycle + escalation overrides) |
| 4 | `tenant_management` | Tenant Management | Tenant directory, profile, status, lifecycle | Yes | Tier 1–3 (tenant-state mutation) |
| 5 | `billing_subscriptions` | Billing & Subscriptions | Plans, subscriptions, invoices, dunning, refunds | Yes | Tier 1–2 (financial approval) |
| 6 | `platform_settings` | Platform Settings | Branding, regional, feature flags, system toggles | Yes | Tier 3 (platform-wide config) |
| 7 | `domains` | Tenant Web Address | Tenant platform URLs, customer-facing links, redirect guidance | Yes | Tier 0–2 (web-address lifecycle) |
| 8 | `team_management` | Team Management | Platform team directory, roles, Global Permissions Matrix | Yes | Tier 3 (RBAC + team mutation) |
| 9 | `provisioning` | Provisioning | New tenant provisioning, environment seeding | Yes | Tier 1–3 (privileged provisioning) |
| 10 | `feature_matrix` | Feature Matrix / Plans | Plan catalog and feature-to-plan matrix | Yes | Tier 0–3 (commercial governance) |
| 11 | `addon_governance` | Commercial Controls / Add-on Governance | Add-on catalog, commercial overrides, paid-add-on controls | Yes | Tier 0–3 (paid override governance) |

---

## 3. Current Platform Sub-Permissions

**71 sub-permissions total; 22 flagged `sensitive`.** All are **UI/client-gated only** today (current enforcement state column omitted for brevity — it is uniformly "UI/client-gated only").

Future enforcement tiers:
- **Tier 0** — UI-only acceptable for now (read / navigation / non-mutating).
- **Tier 1** — future server validation *recommended* (low-risk writes, notes, data reads worth authorizing).
- **Tier 2** — future server validation *strongly required before production* (lifecycle / financial / destructive / restricted-data / cross-platform mutations).
- **Tier 3** — future *privileged / PIM-controlled* server action (RBAC mutations, platform-wide config, role/team management, provisioning, commercial overrides).

### 3.1 Command Center (`command_center`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_command_center` | view | — | read/nav | 0 |
| `view_operational_pulse` | view | — | read | 0 |
| `view_needs_attention` | view | — | read | 0 |
| `view_tenant_360` | view | — | read (tenant summary) | 0 |
| `use_command_quick_actions` | view | — | navigation | 0 |
| `view_next_best_actions` | view | — | read | 0 |
| `act_on_nba_recommendations` | edit | — | action-through | 1 |

### 3.2 Audit & Security (`audit_security`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_audit_security` | view | — | read/nav | 0 |
| `view_audit_logs` | view | — | sensitive-data read | 1 |
| `view_actor_profile` | view | — | sensitive-data read | 1 |
| `view_related_event_timeline` | view | — | sensitive-data read | 1 |
| `export_audit_csv` | approve | ✅ | data export / exfiltration | 2 |
| `add_security_note` | create | — | write (note) | 1 |
| `delete_security_note` | approve | ✅ | destructive write | 2 |
| `create_support_case_from_audit` | create | — | write | 1 |
| `view_restricted_audit_details` | approve | — | restricted-data read | 2 |
| `view_escalation_lifecycle_audit` | view | — | read | 1 |

### 3.3 Support Tools (`support_tools`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_support_tools` | view | — | read/nav | 0 |
| `view_escalation_history` | view | — | read | 0 |
| `create_support_case` | create | — | write | 1 |
| `change_support_status` | edit | — | lifecycle write | 1 |
| `change_support_severity` | edit | — | write | 1 |
| `assign_support_case` | edit | — | write | 1 |
| `close_support_case` | manage | ✅ | lifecycle (sensitive) | 2 |
| `escalate_assigned_case` | edit | — | escalation write | 1 |
| `escalate_any_case` | manage | — | cross-platform escalation | 2 |
| `acknowledge_escalation` | edit | — | escalation write | 1 |
| `assign_escalation_owner_team` | manage | ✅ | escalation ownership (sensitive) | 2 |
| `change_escalation_level` | approve | ✅ | escalation promote/demote (sensitive) | 2 |
| `deescalate_support_case` | edit | — | escalation write | 1 |
| `resolve_escalation` | approve | ✅ | escalation resolution (sensitive) | 2 |
| `close_with_active_escalation` | manage | ✅ | override-close (sensitive) | 2 |
| `view_support_sla` | view | — | read | 0 |
| `view_support_tenant_health` | view | — | read | 0 |
| `view_support_related_entities` | view | — | read | 0 |
| `add_internal_support_note` | create | — | write (note) | 1 |
| `use_support_macro` | create | — | write (template insert) | 1 |
| `manage_support_macros` | manage | ✅ | shared-template management (sensitive) | 2 |
| `edit_support_case` | edit | — | write | 1 |
| `reopen_support_case` | edit | — | lifecycle write | 1 |

### 3.4 Tenant Management (`tenant_management`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_tenants` | view | — | tenant-data read | 1 |
| `edit_tenant_profile` | edit | — | tenant write | 2 |
| `change_tenant_status` | manage | ✅ | tenant-state lifecycle (suspend/reactivate) | 3 |

### 3.5 Billing & Subscriptions (`billing_subscriptions`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_billing` | view | — | financial-data read | 1 |
| `edit_subscriptions` | edit | — | plan/cycle write | 2 |
| `approve_billing_actions` | approve | ✅ | financial approval (refund/credit/write-off) | 2 |

### 3.6 Platform Settings (`platform_settings`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_platform_settings` | view | — | read/nav | 0 |
| `edit_platform_settings` | manage | ✅ | platform-wide config write | 3 |

### 3.7 Tenant Web Address (`domains`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_domains` | view | — | read/nav | 0 |
| `manage_domain_lifecycle` | manage | ✅ | web-address lifecycle (sensitive) | 2 |

### 3.8 Team Management (`team_management`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_team` | view | — | read/nav | 1 |
| `manage_team_members` | manage | ✅ | platform-staff lifecycle (sensitive) | 3 |
| `manage_platform_roles` | full | ✅ | **RBAC mutation** — roles + Global Permissions Matrix (sensitive) | 3 |

### 3.9 Provisioning (`provisioning`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_provisioning` | view | — | read/nav | 1 |
| `run_provisioning` | manage | ✅ | privileged provisioning/seed (sensitive) | 3 |

### 3.10 Feature Matrix / Plans (`feature_matrix`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_feature_matrix` | view | — | read/nav | 0 |
| `create_plan` | create | — | catalog write | 2 |
| `edit_plan` | edit | — | catalog write | 2 |
| `archive_plan` | manage | ✅ | catalog lifecycle (sensitive) | 2 |
| `edit_feature_matrix` | manage | ✅ | commercial mapping (sensitive, platform-wide) | 3 |

### 3.11 Commercial Controls / Add-on Governance (`addon_governance`)
| Sub-permission | Threshold | Sensitive | Likely category | Future tier |
|---|---|:---:|---|:---:|
| `view_addon_governance` | view | — | catalog read | 1 |
| `create_addon` | create | — | catalog write | 2 |
| `edit_addon` | edit | — | catalog write | 2 |
| `archive_delete_addon` | manage | ✅ | catalog destructive (sensitive) | 2 |
| `manage_addon_compatible_plans` | edit | — | catalog write | 2 |
| `manage_addon_readiness` | edit | — | readiness write | 1 |
| `generate_addon_implementation_brief` | view | — | document generation (read) | 0 |
| `grant_trial` | approve | ✅ | commercial override (sensitive) | 2 |
| `grant_paid_override` | approve | ✅ | **paid commercial override** (sensitive; ties to locked paid-override invoice workflow) | 3 |
| `revoke_addon_override` | approve | ✅ | commercial override revoke (sensitive) | 2 |
| `edit_addon_overrides` | approve | ✅ | commercial override grant/revoke (sensitive) | 3 |

---

## 4. Current Platform Roles

Five platform roles exist in `accessConfig.ts` + `platformPermissionsConfig.ts` (`DEFAULT_PLATFORM_FEATURE_LEVELS`). **Role behavior is documented here, not changed.** Defaults below are *feature-group* levels (sub-permission thresholds still apply on top).

| Role | Display label | Default posture (high level) | Future temp-elevation eligible? | Include in future access review? | Protect from accidental downgrade? |
|---|---|---|:---:|:---:|:---:|
| `system_owner` | System Owner | **Locked Full Access** on every group; exempt from reconciliation; resolver short-circuits to allow | No (already full; must never be silently elevated/downgraded) | Yes (highest-privilege account — review for existence/ownership) | **Yes — strongest. Never downgrade or reconcile.** |
| `support_admin` | Support Admin | Support-led: `support_tools` full, `command_center` manage; mostly `view` elsewhere; `audit_security` view | Yes (candidate for time-boxed escalate/manage bumps) | Yes | Yes |
| `billing_admin` | Billing Admin | `billing_subscriptions` full, `feature_matrix`/`addon_governance` manage; `domains` none, `provisioning` none | Yes (temp manage for commercial actions) | Yes | Yes |
| `operations_admin` | Operations Admin | Broad ops: `tenant_management` full, `provisioning` full, `domains` full, `command_center`/`support_tools`/`feature_matrix` manage, `platform_settings` edit | Yes (temp full for provisioning/tenant actions) | Yes | Yes |
| `security_admin` | Security/Audit Admin | `audit_security` full, `team_management` manage, `platform_settings` manage, `command_center` manage, `support_tools` approve | Yes (temp full for audit/security investigations) | Yes | Yes |

> **System Owner protection note:** `system_owner` is the only role that bypasses `reconcileSubPermissionChange` / `reconcileFeatureLevelChange` and is hard-coded to `full` in `getPlatformFeatureLevel` and the resolver. Any future PIM/review work must treat downgrading or temporarily impersonating System Owner as an explicitly disallowed/guarded path.

---

## 5. Current Resolver Model (conceptual — unchanged)

`explainAccessDecision` resolves a `(role, sub-permission)` request in this order, returning a structured `AccessDecision` with a `source`:

1. **System-owner allow** — `system_owner` short-circuits to allowed/`full` (`source = 'system_owner'`).
2. **Explicit sub-permission override** — a session override on the specific sub-permission wins next.
3. **Explicit feature override** — a session override on the parent feature group.
4. **Role default** — `DEFAULT_PLATFORM_FEATURE_LEVELS[role][feature]` compared against the sub-permission `threshold` via `platformPermissionMeets`.
5. **Transitive prerequisite check** — `PLATFORM_PERMISSION_DEPENDENCIES` is followed transitively (with a cycle guard); if any prerequisite resolves denied, the dependent is denied with **`source = 'denied_prerequisite'`** and a reason naming the missing prerequisite.

**Wrappers:** `hasPlatformPermission` (→ `{allowed, reason, level, threshold}`), `hasEffectiveFeatureAccess` (sidebar/page visibility — parent level > none OR any child sub-permission > none), `hasSectionAccess` / `hasActionAccess` (UI widgets + mutation handlers), and `AccessContext.canAccess` (maps nav features → platform keys via `NAV_FEATURE_TO_PLATFORM_KEY`).

**Dependency auto-sync** (`reconcileSubPermissionChange` / `reconcileFeatureLevelChange`) is **write-time, direction-aware, least-privilege-preserving**: raising a dependent auto-raises denied prerequisites to the minimum satisfying level; lowering a prerequisite auto-caps (`none`) dependents that would otherwise be `denied_prerequisite`; lowering a dependent never lowers its prerequisite; System Owner is never reconciled.

> **Do not alter the resolver, thresholds, dependency map, or reconcile logic in Milestone 0.** This section is descriptive only.

---

## 6. Current UI-Only / Client-Side Gating Finding

- **Current enforcement state: UI/client-gated only.** Future server-side enforcement is recommended before production-grade privileged operations.
- Server-side platform RBAC enforcement is **not implemented**.
- `server/index.ts` currently enforces only shipping-provider configuration (credentials must be present) and environment constraints (some actions only in `test` mode). It **does not** check platform session roles or sub-permissions.
- All platform gating is therefore **bypassable outside the React UI** (direct API/datastore access is not authorized by the resolver).
- **Architectural constraint for future work:** any future backend enforcement must **reuse the resolver model** (same levels, thresholds, dependency map) and **must not fork permission logic** away from `platformPermissionsConfig.ts`.

---

## 7. Future Server-Side Enforcement Classification

For each privileged category: current state, risk, future enforcement need, recommended tier, and the phase where implementation is deferred. **None of this is implemented today.**

| Category | Current state | Risk if left UI-only | Future enforcement need | Recommended tier | Deferred to |
|---|---|---|---|:---:|---|
| Platform RBAC-mutating writes | UI/client-gated only | Critical — anyone bypassing UI can grant themselves access | Server must authorize every matrix/override write against the resolver | **Tier 3** | Phase 1.3+ (server RBAC) |
| Platform role changes | UI/client-gated only | Critical — privilege escalation | Server-validated, audited, PIM-guarded; System Owner protected | **Tier 3** | Phase 1.3+ |
| Sub-permission overrides | UI/client-gated only | High — silent escalation | Server-validated write reusing reconcile rules | **Tier 3** | Phase 1.3+ |
| Temporary access grants (future) | **Not implemented; no scheduler exists** | High — silent/standing elevation | Server-issued, time-boxed, reason-required, audited; **derived expiry** until a scheduler exists | **Tier 3** | Phase 1.3 (M3, foundation only) / Phase 1.4+ (automation) |
| Access review records (future) | **Not implemented** | Medium — stale access undetected | Server-recorded reviewer + timestamp; rule-based stale flag | **Tier 2** | Phase 1.3 (M4) |
| Privileged audit actions | UI/client-gated only (append-only overlay) | High — tampering / unauthorized export | Server-side authorization + integrity guarantees | **Tier 2** | Phase 1.3+ / Phase 3 (evidence) |
| Tenant management mutations | UI/client-gated only | High — unauthorized tenant suspend/edit | Server-validated, audited | **Tier 2–3** | Phase 1.3+ |
| Billing / subscription mutations | UI/client-gated only | High — financial impact | Server-validated, audited approval | **Tier 2** | Phase 1.3+ |
| Add-on governance mutations | UI/client-gated only | High — commercial/financial override abuse | Server-validated; paid override tied to locked invoice workflow | **Tier 2–3** | Phase 1.3+ |
| Platform settings mutations | UI/client-gated only | High — platform-wide config drift | Server-validated, audited | **Tier 3** | Phase 1.3+ |
| Provisioning lifecycle changes | UI/client-gated only | High — unauthorized tenant creation/seed | Server-validated, privileged | **Tier 3** | Phase 1.3+ |
| Support / admin intervention actions | UI/client-gated only | Medium–High — escalation/impersonation abuse | Server-validated, audited | **Tier 1–2** | Phase 1.3+ |
| Sensitive audit / security actions | UI/client-gated only | High — restricted-data exposure / destructive notes | Server-validated read/write authorization | **Tier 2** | Phase 1.3+ / Phase 3 |

**Truthful labels reaffirmed:** future backend enforcement · future server validation recommended/strongly required · future privileged/PIM-controlled · deferred · not implemented · no scheduler exists · no backend enforcement currently active. No implication that backend enforcement, automated expiration, PAM, SSO/SCIM, or compliance automation is active.

---

## 8. Non-Regression Guardrails (for Milestones 1–5)

Future Phase 1.3 milestones must protect (no behavior regression):

- Tenant Web Address
- Platform Settings Control Center
- Command Center Intelligence
- Audit Investigation Center
- Support Queue / SLA / Macro
- Escalation operating model
- Permission dependency auto-sync (`reconcileSubPermissionChange` / `reconcileFeatureLevelChange`)
- Add-on Governance
- Shipping
- Store Permissions Matrix
- Tenant provisioning
- Paid override invoice workflow
- Server PII logging

Additional standing constraints: keep platform and tenant/store permission systems separate; keep `explainAccessDecision` the single source of truth (future server checks reuse it, never fork it); keep System Owner locked/exempt; all new governance work additive with truthful labels.

---

## 9. Milestone 0 Acceptance Criteria

- [x] All current feature groups inventoried (11).
- [x] All platform sub-permissions inventoried (71).
- [x] Sensitive flags captured (22 sensitive).
- [x] Role defaults summarized without changing them (5 platform roles).
- [x] Current UI-only enforcement truthfully stated.
- [x] Future server-side enforcement tiers classified (Tier 0–3 + category table).
- [x] No code behavior changed.
- [x] No route / model / permission / UI changes made.
- [x] Project typechecks (no new errors vs. the pre-existing baseline) — see validation in the milestone reply.

> **Deferred (not started):** Milestones 1–5 (governance model, directory/role-matrix UI, temporary access/PIM, access review + reason capture, Command Center/Audit integration). No new roles, stores, UI cards, reason prompts, approval flows, server middleware, Firestore rules, or fake enforcement were introduced.
