# Phase 1.4 — Milestone 3: Request Context + Protected Action Contract + Audit Decision Boundary

> **Status:** **Documentation / architecture only.** This milestone defines a **future, provider-agnostic enforcement contract** — request context, protected-action catalog, authorization-decision shape, audit-decision boundary, outcome labels, preview/demo rules, and evidence-truthfulness rules. **It is NOT server enforcement, NOT middleware, NOT authorization logic, NOT a runtime file.** All TypeScript-like and JSON-like fragments below are **documentation examples only**, embedded in Markdown; **nothing is wired into the app.**
>
> **Reversible** (delete this doc + revert the minimal `replit.md` status line). Not committed/pushed/backed up; awaiting review.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. Builds on [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) (§7 request-context seed, §8 protected-action seed, §6 truthfulness labels), [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md) (identity/auth boundary), and [`phase-1.4-milestone-2-durable-data-shape-domain-model.md`](phase-1.4-milestone-2-durable-data-shape-domain-model.md) (scopes, audit model, identity strategy). Honors the ratified [PostgreSQL](phase-1.4-decision-record-production-database.md) + [server/API-tier](phase-1.4-decision-record-deployment-topology.md) directions.

---

## 1. Purpose and Scope

Define the **contract** a future server/API enforcement tier would honor — so that when implementation is eventually approved, the *shape* of "who is acting, on what, in which scope, with what permission, and with what audited decision" is already agreed, provider-agnostic, and truthful about what is/isn't evidence.

**In scope (docs only):** request-context shape; actor/scope model; preview/demo handling; protected-action catalog; permission mapping; authorization-decision shape; deny/allow/advisory/deferred labels; reason capture; audit-decision boundary + truthfulness labels; first enforcement candidate; deferred set; provider-agnostic notes; future manual-QA requirements.

**Out of scope:** any implementation — middleware, guards, authorization logic, repositories, SQL/RLS, Supabase/Postgres/Firebase code, schema, routing, UI. Those are future, separately-accepted milestones.

---

## 2. Current Non-Implementation Boundary (truthful)

Verified across M0–M2 and re-confirmed here:
- **No server-side actor/scope resolution exists.** The dev-only Express server (`server/index.ts`) has only `/api/shipping/*` routes, no user/tenant/auth context (webhook HMAC + provider keys are its only "auth").
- **Identity is client-side:** Firebase Auth + a single `users/{uid}` read; the tenant object is **mocked** in `AccessContext`.
- **The permission engine is pure/client-side** (`platformPermissionsConfig.ts` / `accessConfig.ts`); it resolves against **static config + sessionStorage overrides**, not a durable server-authoritative source.
- **All audit/governance rows are sessionStorage/in-memory advisory** — **none is production evidence.**
- **Therefore every contract below is a future target.** Nothing here is active. Preview identities are **not** production-authenticated identities.

---

## 3. Request Context Contract (conceptual — not implemented)

The object a future server tier would build **after** verifying an auth token and resolving durable scope, then attach to every request before any authorization check.

```ts
// DOCUMENTATION EXAMPLE ONLY — not runtime, not wired, not implemented today.
interface RequestContext {
  request_id: string;            // unique per request
  correlation_id?: string;       // ties related requests/events together

  actor: {
    internal_user_id: string | null;   // stable app id (M1/M2); null if unauthenticated
    auth_provider: 'firebase' | 'supabase' | 'other' | null;
    auth_provider_uid: string | null;  // Firebase uid today
    email: string | null;
    actor_type: 'platform_user' | 'tenant_user' | 'service_account' | 'preview_user';
  };

  scope: {
    scope_type: 'platform' | 'tenant' | 'store' | 'cross_scope' | 'preview';
    tenant_id: string | null;    // REQUIRED for tenant/store actions
    store_id: string | null;     // REQUIRED for store-scoped actions
    platform_scope: boolean;     // true for platform-owner-scoped requests
  };

  role_context: {
    platform_role_id: string | null;
    tenant_role_id: string | null;
    store_role_id: string | null;
    permission_snapshot_ref: string | null; // ref to the resolved permission set used
  };

  auth_state: 'authenticated' | 'unauthenticated' | 'preview' | 'service';

  source: 'ui' | 'api' | 'webhook' | 'scheduled_job' | 'integration' | 'preview';
  environment: 'dev' | 'preview' | 'production';

  metadata?: {
    ip?: string;                 // captured later, where appropriate + lawful
    user_agent?: string;
    idempotency_key?: string;    // for external/payment/shipping actions
  };
}
```

**Hard rules the contract encodes:**
- **Deny by default.** Absence of a resolvable actor+scope ⇒ deny (never "assume allow").
- **Explicit actor + scope on every enforced action.** No implicit tenant.
- **Platform vs tenant scope never mixed** (disjoint, per the existing permission model).
- **Preview is its own `actor_type`/`scope_type`/`auth_state`** — never conflated with `authenticated` production identity (see §6).

---

## 4. Actor Identity Model

Reinforces M1/M2. The actor's durable identity is **`internal_user_id`**, decoupled from any auth provider (`auth_provider` + `auth_provider_uid`), with `email` as the swap re-map key.

| actor_type | Who | Identity source (future) | Notes |
|---|---|---|---|
| `platform_user` | System Owner / platform admins | `internal_user_id` + platform membership/role | today: Firebase `users/{uid}` |
| `tenant_user` | tenant employees | `internal_user_id` (or tenant-local employee id) + tenant/store membership | linkage is an open M2 question |
| `service_account` | scheduled jobs / internal services | non-human credential | for future automation/webhooks |
| `preview_user` | demo/dev switcher identities | **synthetic, non-authoritative** | must never authorize production data |

**Open linkage question (from M2 §9):** whether a tenant employee maps into the same `internal_user_id` identity table (one identity + membership rows) or stays tenant-local. To be ratified in a future milestone; the contract works either way because authorization keys on **scope + role**, not on a single identity table shape.

---

## 5. Tenant / Store / Platform Scope Contract

| scope_type | Required keys | RLS/enforcement intent (future) |
|---|---|---|
| `platform` | `platform_scope = true` | platform-role permission; no `tenant_id` ownership |
| `tenant` | `tenant_id` (required) | tenant-role permission + tenant RLS |
| `store` | `tenant_id` + `store_id` (required) | store-role permission + tenant/store RLS |
| `cross_scope` | both as applicable | e.g. platform→tenant provisioning, tenant+store shipment; each leg checked in its own scope |
| `preview` | none authoritative | sandboxed; no production data |

- A tenant/store request **without** a resolvable `tenant_id` ⇒ deny.
- Platform actions must not be authorizable by tenant roles and vice-versa.
- `cross_scope` actions evaluate **each** scope's permission independently (no scope's grant satisfies another's).

---

## 6. Preview / Demo Context Handling

Preview/demo today is entirely client-side (`DevSessionSwitcher` synthetic sessions/tenants; `isPreviewModeEnabled` ⇒ `isWriteBlocked`). The contract requires:

- **`actor_type = preview_user`, `scope_type = preview`, `auth_state = preview`, `environment = preview`.**
- **Preview identities are never production-authenticated** — a future guard must reject any attempt to use a preview identity against production data/services.
- **Preview is a first-class allowed sandbox**, not an enforcement bypass for production: future strict enforcement must keep preview usable by routing it to mock/sandbox repositories, **not** by granting it real privileges.
- **No preview action writes durable/server audit evidence** — preview decisions are advisory by definition.
- Future guards must be **preview-aware from day one** (build the policy before the first guard, per M1/M0).

---

## 7. Protected Action Catalog (conceptual)

Action id convention: `scope.domain.verb`. Columns: **Scope** (platform/tenant/store/cross/external) · **Sens** (low/med/high/critical) · **Perm source** · **Audit req** (none/basic/sensitive/append-only) · **Current state** · **Future readiness**.

Readiness legend: **R1** ready after request-context exists · **R2** ready after durable persistence (users/roles/audit) · **RP** future phase (own milestone) · **NR** not ready (design gap).

### 7.1 Platform protected actions

| Action | Scope | Sens | Perm source | Audit req | Current state | Readiness |
|---|---|---|---|---|---|---|
| `platform.permission_matrix.update` | platform | **critical** | platform perm (`manage` team_management) | **append-only** | UI-only; SS override | **R2 (first candidate)** |
| `platform.role.assign` | platform | critical | platform perm | append-only | UI-only | R2 |
| `platform.role.create` | platform | critical | platform perm | append-only | UI-only/STATIC | R2 |
| `platform.role.update` | platform | critical | platform perm | append-only | UI-only/STATIC | R2 |
| `platform.role.delete` | platform | critical | platform perm | append-only | UI-only/STATIC | R2 |
| `platform.system_owner.protected_change` | platform | **critical** | System-Owner-protected (locked) | append-only | UI-only (engine-locked) | R2 (must stay protected) |
| `platform.temporary_access.request` | platform | high | platform perm | append-only | SS advisory | RP (PIM) |
| `platform.temporary_access.approve` | platform | high | platform perm | append-only | SS advisory | RP (PIM) |
| `platform.temporary_access.revoke` | platform | high | platform perm | append-only | SS advisory | RP (PIM/scheduler) |
| `platform.access_review.create` | platform | medium | platform perm | sensitive | SS advisory | RP |
| `platform.access_review.record_outcome` | platform | medium | platform perm | sensitive | SS advisory | RP |
| `platform.sensitive_reason.capture` | platform | high | platform perm | sensitive | SS advisory | RP |
| `platform.tenant.provision` | cross (P→T) | high | platform perm | sensitive | MEM/mock | R2 |
| `platform.tenant.status_change` | cross (P→T) | high | platform perm | sensitive | MEM/mock | R2 |
| `platform.domain.update` | platform | medium | platform perm | basic | SS | RP |
| `platform.settings.update` | platform | high | platform perm (`edit_platform_settings`) | sensitive | LS | RP |
| `platform.provider_config.update` | platform | high | platform perm | sensitive | MEM | RP |
| `platform.audit.read` | platform | medium | platform perm (`view_audit_logs`) | basic | SS advisory | R1 |
| `platform.audit.export` | platform | **high** | platform perm | sensitive | not implemented | RP (evidence) |
| `platform.command_center.read` | platform | low | platform perm | none/basic | DERIVED | R1 |

### 7.2 Tenant / store protected actions

| Action | Scope | Sens | Perm source | Audit req | Current state | Readiness |
|---|---|---|---|---|---|---|
| `tenant.permission_matrix.update` | tenant | high | tenant/store perm | append-only | STATIC/MEM | RP (tenant scope not durable) |
| `tenant.employee.create` | tenant | high | tenant perm | sensitive | MEM | RP |
| `tenant.employee.update_role` | tenant | high | tenant perm | sensitive | MEM | RP |
| `tenant.employee.disable` | tenant | high | tenant perm | sensitive | MEM | RP |
| `tenant.store.create` | tenant | high | tenant perm | sensitive | MEM | RP (needs tenancy) |
| `tenant.store.update` | tenant | medium | tenant perm | basic | MEM | RP |
| `tenant.customer.create` | store | medium | tenant/store perm | basic | MEM | RP |
| `tenant.customer.update` | store | medium | tenant/store perm | basic | MEM | RP |
| `tenant.invoice.create` | store | **critical** | tenant/store perm | append-only (financial) | MEM | RP |
| `tenant.invoice.refund` | store | **critical** | tenant/store perm + approval | append-only (financial) | MEM | RP |
| `tenant.pos.sale.create` | store | **critical** | tenant/store perm | append-only (financial) | MEM | RP |
| `tenant.pos.discount.override` | store | high | tenant/store perm (supervisor) | sensitive | MEM | RP |
| `tenant.inventory.adjust` | store | high | tenant/store perm | append-only (ledger) | MEM | RP |
| `tenant.inventory.transfer` | cross (S↔S) | high | tenant/store perm | append-only | MEM | RP |
| `tenant.repair.create` | store | medium | tenant/store perm | basic | MEM | RP |
| `tenant.repair.complete` | store | medium | tenant/store perm | sensitive | MEM | RP |
| `tenant.shipping.label_purchase` | store | high | tenant/store perm + provider | append-only + idempotent | MEM + dev server | RP |
| `tenant.provider_config.update` | tenant | high | tenant perm | sensitive | server MEM (secrets) | RP |
| `tenant.report.export` | tenant | medium | tenant perm | basic | DERIVED | RP |

### 7.3 External / integration actions

| Action | Scope | Sens | Perm source | Audit req | Current state | Readiness |
|---|---|---|---|---|---|---|
| `provider.rate_shop` | external | low | service account / provider key | basic | dev server | RP |
| `provider.label_purchase` | external | high | service account + idempotency | append-only + idempotent | dev server | RP |
| `provider.tracking_sync` | external | low | service account | basic | dev server | RP |
| `provider.webhook_receive` | external | medium | **provider signature (HMAC)** | append-only (events) | dev server (HMAC today) | RP |
| `payment.intent_create` | external | **critical** | service account + processor | append-only (no card data) | not implemented | RP (PCI milestone) |
| `payment.refund` | external | **critical** | tenant perm + processor | append-only | not implemented | RP (PCI milestone) |
| `integration.sync` | external | medium | service account | basic | not implemented | RP |
| `import.start` | platform/tenant | high | scope perm | sensitive | not implemented | RP |
| `export.start` | platform/tenant | high | scope perm | sensitive | not implemented | RP |

---

## 8. Required Permission Mapping

The contract **reuses the existing pure permission engine** (`platformPermissionsConfig.ts` / `accessConfig.ts`) as the source of truth — **it does not fork or re-implement permission logic.** Mapping principles:

- **Platform actions** → platform feature/sub-permission keys (e.g. `team_management` + `manage`-level for matrix writes; `edit_platform_settings`; `view_audit_logs`). System-Owner short-circuit + locked-from-reconciliation behavior must be preserved.
- **Tenant/store actions** → tenant/store permission domains + sub-permissions, evaluated within the tenant's plan envelope (existing `checkSubPermission` / `isSubPermissionPlanAvailable` semantics).
- **External actions** → service-account credential or **provider signature** (HMAC), not a user permission.
- **Evaluation moves server-side later** by calling the *same* pure functions against a **durable, server-authoritative** permission snapshot — not by changing resolver behavior. (M1: reuse, never fork.)

---

## 9. Authorization Decision Shape (conceptual)

```ts
// DOCUMENTATION EXAMPLE ONLY — not runtime, not implemented.
interface AuthorizationDecision {
  decision_id: string;
  request_id: string;
  correlation_id?: string;

  action: string;                 // e.g. 'platform.permission_matrix.update'
  actor_id: string | null;        // internal_user_id
  scope: { scope_type: string; tenant_id: string | null; store_id: string | null };

  required_permission: string;    // engine key(s) checked
  decision: 'allow' | 'deny' | 'advisory_only' | 'deferred' | 'not_applicable';
  reason_code: string;            // machine code, e.g. 'denied_missing_permission'
  human_readable_reason: string;  // safe, non-leaking explanation

  evaluated_at: string;           // ISO timestamp
  evaluated_by: string;           // future guard name, e.g. 'platform_rbac_guard@v1'
  source_of_truth: string;        // e.g. 'durable_platform_permissions'

  audit_requirement: 'none' | 'basic' | 'sensitive' | 'append_only';
  evidence_level: string;         // see §12 audit labels
  preview_handling: 'sandboxed' | 'blocked' | 'n_a';
}
```

```json
// CONCEPTUAL EXAMPLE of a future decision (illustrative only).
{
  "decision_id": "dec_demo",
  "action": "platform.permission_matrix.update",
  "actor_id": "usr_internal_123",
  "scope": { "scope_type": "platform", "tenant_id": null, "store_id": null },
  "required_permission": "team_management:manage",
  "decision": "deny",
  "reason_code": "denied_missing_permission",
  "human_readable_reason": "Actor lacks manage permission on team_management.",
  "evidence_level": "server_written_durable",
  "preview_handling": "n_a"
}
```

**Truthful statements:** current Phase 1.3/1.4 docs and surfaces create **no real decisions**; future durable decisions must be **server-written**; client/session "decisions" are **not** production evidence.

---

## 10. Deny / Allow / Advisory / Deferred Outcome Labels

| decision | Meaning | When used |
|---|---|---|
| `allow` | actor authorized; action proceeds | server-verified permission satisfied |
| `deny` | actor not authorized; action blocked | **default** when permission/scope/identity missing |
| `advisory_only` | no enforcement; informational signal | today's client/session governance signals (non-binding) |
| `deferred` | enforcement intended but not yet implemented | action is RP/NR in §7; recorded as not-yet-enforced |
| `not_applicable` | no permission decision applies | e.g. pure reads with no gate, or preview sandbox |

- **Deny is the default.** Uncertainty resolves to deny, never allow.
- **`advisory_only`** is the honest label for everything Phase 1.3/1.4 produces today.

---

## 11. Reason Capture Requirements

- **Sensitive/critical actions require a captured reason** (`reason_code` + `human_readable_reason`) on both allow and deny where applicable (e.g. refund override, role change, sensitive-action capture).
- Reasons must be **non-leaking**: human-readable text must not expose secrets, other tenants' data, or internal implementation detail.
- The existing Phase 1.3 **sensitive-action reason capture** is **advisory/sessionStorage today**; the future contract upgrades it to a **server-written field on durable audit rows** — it is not evidence until then.
- Deny reasons shown to UI should be **safe and generic** (see §14); full reason detail lives only in the durable server audit row.

---

## 12. Audit Decision Boundary (truthfulness labels)

Every audit/decision record carries exactly one **evidence label**. Definitions and permitted use:

| Label | Meaning | May be used when |
|---|---|---|
| `browser_session_advisory` | written to `sessionStorage`, per-tab, client-authored | **today's** `audit_logs` + Phase 1.3 governance rows |
| `local_storage_advisory` | written to `localStorage`, per-browser, client-authored | today's `platform_settings_v1` |
| `mock_in_memory` | React state, lost on refresh | today's tenant business records |
| `dev_sidecar_file` | dev-only server JSON file | today's `webhook-audit-log.json` |
| `server_written_durable` | written by a trusted server to a durable store | **future only**, once the server tier exists |
| `database_enforced` | a DB constraint enforced it | future (FKs/uniqueness/transactions) |
| `database_rls_enforced` | Postgres RLS enforced tenant isolation | future (RLS policies) |
| `external_provider_verified` | provider signature verified before trust | future; **requires HMAC/signature check** (webhooks today verify HMAC but are dev-only/advisory) |
| `compliance_evidence_candidate` | a durable server record *designed* to serve as evidence | future, only on `server_written_durable` rows |
| `compliance_evidence_not_available` | explicit truthful "no evidence" | **today** — the correct global label |

**Hard truths:**
- **Today, essentially all audit/governance rows are `browser_session_advisory` / `local_storage_advisory` / `mock_in_memory`.** None is production compliance evidence; the honest system-wide label is **`compliance_evidence_not_available`**.
- **Future server enforcement must write durable audit rows** with: actor, action, target, scope, decision, reason, timestamp, correlation_id (+ idempotency where relevant).
- **`external_provider_verified`** may be applied **only after** signature verification.
- **`compliance_evidence_candidate`** may never be claimed from UI/sessionStorage/in-memory.

---

## 13. Evidence Truthfulness Rules

1. No surface (UI, doc, log) may imply more durability/enforcement than the record's evidence label permits.
2. Advisory ≠ evidence. Phase 1.3 governance + Phase 1.4 contracts are advisory/design, not enforcement.
3. "Enforced" may be claimed only when a server decision actually blocked/allowed the action.
4. "Compliance evidence" requires durable, server-written records — never client/session.
5. Provider events are untrusted until their signature is verified.
6. When in doubt, label down (more-advisory), not up.

---

## 14. Error / No-Access Response Principles

- **Deny by default**, with a **safe, generic** user-facing message (no leakage of existence, other-tenant data, or internals).
- **Distinguish unauthenticated (401-like) from unauthorized (403-like)** conceptually; never reveal *why* in a way that aids enumeration.
- **Full reason detail** lives only in the durable server audit row, not in the client response.
- **Preview** gets a clear "sandbox — not enforced / not persisted" affordance, never a fake "success" implying durable effect.
- **Idempotent external actions** must return the prior result on key replay, not double-apply.

---

## 15. First Future Enforcement Candidate

**`platform.permission_matrix.update`** (with `platform.role.update` / `platform.role.assign` as close seconds). Re-confirmed from M0 §8 / M2 §15. **Not implemented here.**

**Why it's the safest first:** highest value; clear single actor (platform user); clear target (a role's permission); small blast radius (platform-only, no tenant business data); reuses the **mature, pure platform permission engine**; System-Owner protection is well understood and engine-locked; pairs naturally with the first durable audit row.

**Prerequisites (all required before it can be enforced):**
1. a production server/API tier or managed backend path (topology decision);
2. durable **platform users** (`internal_user_id`);
3. durable **platform roles/permissions** (matrix overrides moved off sessionStorage);
4. the **`internal_user_id`** identity model (M1/M2);
5. a **request context** (this doc) resolved server-side;
6. **server-side permission evaluation** reusing the pure engine (not forked);
7. a **durable, append-only audit store**;
8. a **preview/demo policy** (§6) honored by the guard.

Until all eight exist, the action stays `advisory_only` / `deferred`.

---

## 16. Deferred Enforcement Candidates

| Deferred | Why |
|---|---|
| Tenant/store POS, invoice, inventory, repair enforcement | tenant/store scope is mocked + not durable; transactional/financial; very-hard |
| Tenant provisioning enforcement | no durable tenant records yet |
| Firestore rules / Postgres RLS implementation | conditional on provider ratification + durable model |
| Real PAM/PIM | Phase 1.3 records are advisory/sessionStorage only; no scheduler |
| SSO/SCIM | no IdP integration; out of current scope |
| Scheduler-based revocation | no scheduler exists (temporary access is derived/advisory) |
| Compliance-evidence automation | requires durable server-written audit first |
| Provider secrets persistence | needs a real secret store, not a DB column; own decision |
| Payment processing | PCI-scoped; no card data in app DB; separate milestone |
| Anything based only on Phase 1.3 advisory/sessionStorage records | not durable; would be fake enforcement |

---

## 17. Provider-Agnostic Notes

This contract holds regardless of final provider — **Supabase / Neon / Railway / Hostinger-VPS PostgreSQL**, and **Firebase Auth retained** or **Supabase Auth adopted**. No field, action, decision, or label names a vendor. Vendor specifics live only in future *adapters* (M1): the request-context builder's token verifier, the durable repositories, and the RLS/rules layer. Swapping providers changes adapters + composition root, not this contract.

---

## 18. Manual QA Requirements for Future Behavior-Changing Enforcement

When (later) the first enforced action is implemented, **before** commit/backup the following manual QA is mandatory (none applies to M3, which changes nothing):
- Authorized actor: action **allowed** + durable audit row with correct actor/scope/decision.
- Unauthorized actor: action **denied** + safe message + durable deny audit row.
- **System Owner** remains allowed/protected; cannot be locked out or reconciled away.
- **Preview/demo** session: sandboxed, not enforced against production, no durable evidence written; demo remains usable.
- Scope isolation: a tenant actor cannot perform a platform action and vice-versa.
- Idempotent external actions: key replay returns prior result, no double-apply.
- No regression to existing UI/permission behavior.

---

## 19. Risks / Open Questions

1. **Identity unification** (platform users ↔ tenant employees) — one identity + memberships, or separate (M2 §9). Affects `actor` resolution.
2. **Permission snapshot freshness** — how `permission_snapshot_ref` stays consistent between client and server evaluation.
3. **Provider/auth still provisional** — request-context token verifier depends on the auth choice (M1 criteria).
4. **Reason-leakage discipline** — ensuring human-readable reasons never leak across tenants.
5. **Idempotency key strategy** — per external domain (payments/shipping/webhooks).
6. **Correlation model** — how `correlation_id` threads UI→API→provider→webhook.
7. **Preview sandbox data source** — where sandbox repositories read/write.

## 20. Non-Implementation Statement

This milestone implemented **nothing**: no middleware, guard, authorization logic, repository, runtime file, wiring, schema, SQL, Supabase/Postgres/Firebase code, dependency, or runtime/UI/source behavior change. All fragments are documentation examples. The contract is provider-agnostic and reuses (does not fork) the existing permission engine.

## 21. Validation / QA Summary

See the M3 report. Expected: only Markdown changed; no `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package*` files; no wiring; `tsc` baseline unchanged (no code touched).
