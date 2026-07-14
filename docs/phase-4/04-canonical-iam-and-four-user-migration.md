# 04 — Canonical IAM, Authorization, Tenant/Store & Four-User Migration

**Scope:** the production identity/authorization model (server-authoritative), the reconciliation of the two conflicting permission-level orderings, tenant/store governance rules, and a non-executing migration contract for the four existing noncanonical users. Design-only; **no migration is executed and those users are not read again by M1.** Delivered by **M5** (gated by **M4** session).

## 1. Production identity hierarchy

| Layer | Canonical home | Notes |
|---|---|---|
| Authentication identity | Firebase (verified at server login exchange) | authentication only |
| `platform_identity` | Postgres (PK `internal_user_id`; UNIQUE `(auth_provider, auth_provider_uid)`) | stable app-owned identity |
| `app_user` | Postgres (1:1; `status` ∈ active/trialing/overdue/suspended/read_only/pending_activation) | account lifecycle |
| Platform membership | `user_membership` scope=`platform`, `role_id` ∈ canonical platform vocab | platform staff |
| Tenant membership | `user_membership` scope=`tenant` (tenant set, store null) | tenant grant |
| Store assignment | `user_membership` scope=`store` (tenant+store set) | store grant |
| Role | `user_membership.role_id` (server-owned; mirrors code catalog) | see §2 |
| Permission level | canonical authorization service (unified catalog, §3) | server-derived |
| Feature entitlement | `tenant_feature_entitlement` (server-materialized) | replaces `sessionStorage` |
| Plan restriction | `tenant.plan_key` (starter/growth/advanced) | plan envelope |
| Status & suspension | `app_user.status` + membership status | fail-closed |
| Temporary / PIM access | governed, time-boxed grant (advisory today → enforced M5) | audited |
| Access review | periodic recertification | audited |
| Step-up requirement | recent-login for sensitive actions ([03](./03-backend-control-plane-login-session-blueprint.md)) | |
| Effective authorization context | resolved per request, deny-by-default | the only authority |

The `user_membership` table already encodes the target: `scope_consistency` CHECK (platform ⇒ both null; tenant ⇒ tenant set/store null; store ⇒ both set), `role_scope` CHECK (platform ⇒ platform vocab; tenant/store ⇒ `store_owner|manager|technician|sales_staff`), and a `UNIQUE NULLS NOT DISTINCT` grant key. Migration 003 pinned the canonical platform vocabulary.

## 2. Roles

**Platform roles (5):** `system_owner` (locked Full, never overridable), `support_admin`, `billing_admin`, `operations_admin`, `security_admin`. Per-role default platform feature levels are already defined (`platformPermissionsConfig.ts` `DEFAULT_PLATFORM_FEATURE_LEVELS`) across 11 feature groups (~90 sub-permissions with a prerequisite/auto-reconcile graph).

**Tenant/store roles (4):** `store_owner` (blanket `full`), `manager`, `technician`, `sales_staff`, over 21 permission domains + ~70 sub-permissions (`accessConfig.ts`).

**Invariants to enforce server-side (M5):**
- `system_owner` remains locked Full.
- Platform roles are disjoint from tenant/store roles; tenant/store roles get **all-none** for platform.
- **Tenant permissions can never escalate to platform authority.**
- **Store roles cannot escape their store** (scope enforced from membership, not request).
- Plan gating **and** permission gating combine (role can never resurrect a plan-disabled feature — the client already models this in `checkSubPermission`; M5 makes it server-authoritative).
- Suspended/inactive/missing-mapping ⇒ **deny (fail closed)**.
- Parity/cap restrictions (e.g., cannot assign a role higher than your own) enforced server-side.
- Temporary/PIM access expires; sensitive actions require reason + audit.

## 2.1 Store-scoped payment-gateway permissions (store-owned config — OWNER CORRECTION)

Payment-gateway configuration is authorized by **explicit canonical store-scoped permissions — not a generic role check**. New sub-permissions (parent domain `payments`, levels `none → view → create → edit → approve → manage → full`):

| Permission | Purpose |
|---|---|
| `view_payment_gateway_settings` | view the Store Settings → Payments area + sanitized connection status |
| `manage_payment_gateway_connections` | connect/authorize/replace a store's gateway connection |
| `activate_payment_gateway` | make a connection active (production) |
| `disconnect_payment_gateway` | disconnect a connection |
| `manage_payment_terminals` | pair/manage card-present terminals |

**Rules (all server-enforced, M5):**
- The **Store Owner** receives the required permission by canonical **role policy**.
- **Other store users receive access only through explicit canonical permission assignment** — a generic `manager` role does **not** automatically gain credential-management authority unless its **effective permission** grants it.
- **Suspended/inactive** users denied; **missing canonical mapping** denied; **tenant-only or other-store** membership denied; **store scope enforced server-side** (never from client-supplied `storeId`).
- **Production activation, replacement, and disconnection require recent-authentication/step-up.** Sensitive changes require **reason capture + durable audit**. **Optional dual approval** may be required by tenant policy.

**Separation of duties — payment *operation* permissions are distinct from provider *configuration* permissions:** `accept/process_payment`, `void_payment`, `refund_payment`, `approve_high_value_refund`, `view_reconciliation` are separate from `manage_payment_gateway_connections` (a cashier who can take payments cannot reconfigure the gateway, and vice-versa).

**Named-grant-only (prevents silent SoD collapse):** `activate_payment_gateway`, `disconnect_payment_gateway`, `manage_payment_gateway_connections`, and `manage_payment_terminals` are satisfiable **only by their specific named grant** — they are **NOT** auto-conferred by a broad `payments`-domain `manage`/`full` level (nor by the Store Owner's blanket `full` except via the explicit role-policy grant). Otherwise the unified ordering (`full ⊇ manage ⊇ approve`, [§3](#3-permission-level-reconciliation-required--gap-11)) would let any `payments: full` holder silently satisfy both the config and operation sub-permissions, collapsing the SoD and the "generic manager not auto-authorized" guarantee. These sub-permissions are included in the **[§3](#3-permission-level-reconciliation-required--gap-11) re-pin + grant-diff safeguard** ([ADR-04](./10-architecture-decision-records.md)).

## 3. Permission-level reconciliation (**required — GAP-11**)

There are **two conflicting orderings** in the codebase today:

| Source | Ordering | Ranks |
|---|---|---|
| Tenant side — `accessConfig.ts` `PERMISSION_HIERARCHY` | `none, view, create, edit, **manage, approve**, full` | manage(4) < approve(5) |
| Platform side — `platformPermissionsConfig.ts` `LEVEL_RANK` | `none, view, create, edit, **approve, manage**, full` | approve(4) < manage(5) |

The platform module explicitly says *"Do not unify them"* and ships its own `platformPermissionMeets`. This is a **correctness hazard**: the same two level names sort differently on the two sides, so a threshold check's meaning depends on which comparator runs.

**Canonical decision (M5, phase i):** adopt **one** ordering — `none → view → create → edit → approve → manage → full` (approve below manage), matching the platform ordering and the intended semantics ("manage" ⊇ "approve"). A single **shared permission catalog** (the "declared, NOT built" `SHARED_PERMISSION_CATALOG_TARGET`) becomes the one source of truth for levels, domains, and sub-permissions.

**This migration is NOT risk-free — it changes effective grants by construction.** Under the old tenant order `manage < approve`, a `manage`-holder did **not** satisfy an `approve` threshold; under the unified order `approve < manage`, **every `manage`-holder now satisfies every `approve`-gated action** — including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`). So the tenant `manager` role, which holds `refunds: approve` and `returns` at `manage`, would silently gain approval capability it did not have. Required safeguards (all in M5 phase (i), none optional):

1. **Re-pin, don't infer:** for each affected `approve`-gated sub-permission, set the explicit required level (re-pin `approve`-gated money actions to require `≥ manage` **or** an explicit per-role grant) so the ordering flip does not auto-expand it.
2. **Grant-diff report:** produce a before/after effective-grant diff for every (role × domain × action); no silent change ships.
3. **Owner approval:** the diff is reviewed and explicitly owner-approved before cutover.
4. **Deny-by-default on unknowns:** any level/action not in the unified catalog denies.
5. **Dual-read shadow evaluation:** run old-order and new-order comparators in parallel and log divergences before switching authority to the new order.
6. **Regression tests per permissioned action:** the authorization-matrix suite ([07](./07-quality-and-test-strategy.md)) asserts the intended allow/deny for every affected pair.

(All six safeguards execute in M5 phase (i); "phase" here is execution ordering within M5, not a new milestone.)

**Preserved levels:** `none, view, create, edit, approve, manage, full` (7). Preserved platform feature groups (11) and their sensitive sub-permissions carry over unchanged except for the comparator unification.

**Single catalog, single status model (anti split-brain):** even though the tenant and admin sessions differ ([03](./03-backend-control-plane-login-session-blueprint.md)), there is exactly **one** canonical permission catalog and **one** status/suspension model shared by both surfaces, so admin and tenant authorization can never disagree about a user's role, level, or status.

## 4. Entitlement & permission storage move (**GAP-12**)

Both plan/feature entitlements (`features_data`, `plans_data`, `addons_data`, `tenant_overrides_data`) and platform permissions (`platform_permissions_v1`) are **client `sessionStorage` today** and forgeable. M5 moves them server-side: entitlements materialized into `tenant_feature_entitlement` (source ∈ plan/default/manual), platform permission overrides into a server-owned store, both resolved by the canonical authorization service. The client may cache a **read-only projection** for rendering only.

## 5. Effective-authorization resolution (target request path)

```
verify session cookie
  → load platform_identity + app_user (status)
  → load memberships (platform / tenant / store)
  → if status ∈ {suspended, read_only(for writes), inactive} → DENY (fail closed)
  → resolve role(s) for the requested scope (from membership, NOT request)
  → resolve permission level for (domain, action) from unified catalog
  → apply plan envelope + entitlement (tenant_feature_entitlement)
  → apply parity/cap + temporary-access expiry
  → decision = allow | deny | deferred  (deny-by-default)
  → append durable audit_event (actor, scope, action, required_permission, decision, reason)
```

The server-derived authorization field that is **always null today** (`authorizationContract.ts`) is populated here; `/auth/session/resolve` gains real runtime authorization (deferred wiring, [09](./09-roadmap-m0-m9.md)).

## 6. Four-user migration contract (non-executing)

**Established (do not re-read these users in M1):** four ordinary Firebase users hold noncanonical **client-presentation** roles only — `store_owner`, `manager`, `technician`, `sales_staff` — with **no canonical principal, no server authority, no direct tenant/admin Firestore authority** (own `/users` doc `get` only). They must be canonically mapped/migrated **before production**, via an owner-approved provisioning process — **never silently auto-provisioned**.

For **each** of the four roles, the migration blueprint defines:

| Step | Requirement |
|---|---|
| Identity mapping | create/attach `platform_identity` for the Firebase UID (verified), 1:1 `app_user` |
| `app_user` status | explicit (default `pending_activation` → `active` only on approval) |
| Tenant membership | `user_membership` scope=`tenant`, real `tenant_id` (replaces hardcoded `tenant-1`) |
| Store assignment | scope=`store` where the role is store-scoped (technician/sales_staff/manager/store_owner as applicable) |
| Canonical role | `role_id` = the canonical tenant/store role |
| Permission profile | derived from the unified catalog (§3), not the client role |
| Plan/feature constraints | subject to the tenant's plan envelope + entitlements |
| Migration preconditions | canonical schema live (M3), **minimal durable `audit_event` writer live (M3/M4)** so provisioning is audited, unified catalog live (M5 phase i), owner approval |
| Collision checks | UNIQUE grant key (`user_membership_unique_grant`); no duplicate active membership |
| Ambiguity checks | one unambiguous canonical role per user; ambiguous → hold for owner decision |
| Owner approval boundary | provisioning is an owner-authorized controlled action ([03](./03-backend-control-plane-login-session-blueprint.md) §5) |
| Transactional provisioning | single serializable transaction per user (identity + app_user + membership + audit) |
| Durable audit | append-only provisioning `audit_event` (actor = the provisioning admin) |
| Rollback | compensating transaction (suspend membership + compensation audit) on failure |
| Post-migration verification | resolve effective authorization; confirm allow/deny matches intent |
| Browser/session cutover | user re-authenticates → server issues session → server-derived authorization replaces client role |
| Identifier confidentiality | never print UID/email/identifiers in reports (aggregate/enum only) |

**No auto-provisioning.** Missing mapping ⇒ deny. Execution is a later, separately-authorized step (M5), not M1.

## 7. DSAR authorization boundary (M5)

Data-subject requests (the privacy/DSAR contract, [05 §6](./05-canonical-data-ownership-and-api-db-contracts.md)) are authorized through the same canonical authorization service:
- **Requester identity is verified** before any data is disclosed or erased (server-side; never client-asserted).
- **Tenant is controller, platform is processor:** a tenant may raise/approve DSAR only within its own data; a tenant can never export or erase another tenant's data (tenant/store scope from membership, not request).
- **Platform escalation** handles cross-tenant/platform-operator cases and disputes, as a controlled Backend CP action ([03 §5](./03-backend-control-plane-login-session-blueprint.md)) with reason capture + durable audit.
- **Deny-by-default:** an unverified requester or an out-of-scope request is denied. Every DSAR authorization decision writes a durable `audit_event`.
