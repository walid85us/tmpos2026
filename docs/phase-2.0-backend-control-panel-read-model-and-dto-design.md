# Phase 2.0 M3 — Backend Control Panel Read Model and DTO Design

**Status:** Documentation/design-only · No DTOs, types, read models, or routes implemented
**Accepted checkpoint at authoring:** `037344cfca229267bef0d9a05209c92b2b41dd6f` (Phase 2.0 M2.1)
**Authoring milestone:** Phase 2.0 M3

> Redaction-first. No real tenant/store/customer data, raw IDs, row dumps, emails,
> domains, DB URLs, tokens, secrets, payment identifiers, permission/entitlement
> key lists, or mismatch lists. All field/value examples are safe placeholders.
> No runtime, route, auth, DB, Supabase, DTO/type, read-model, or BCP UI change.

---

## 1. Executive Summary

This is a **design-only** read-model / DTO document for the future Phase 2 BCP read-only API contracts. **No DTOs, TypeScript types, read models, routes, or mappers are implemented.** It defines server-owned read-model principles, a standard already-redacted DTO envelope, empty-state / redaction / freshness / authorization-context metadata, per-contract DTO sketches for C-01…C-09 (safe placeholders only), field classification + forbidden-payload rules, and the mapper/test requirements for a later implementation milestone. It is bound by the M2.1 reconciliation (two authority planes, corrected ordering, precise M20 posture).

## 2. Current State and Boundary

- M1 architecture plan complete; M2 contract map complete; **M2.1 reconciliation complete and controlling**.
- M3 designs **read models and DTOs only**.
- BCP is **not yet live-read-only**; still mock-only, DEV-gated, frontend-only, code-split.
- Firebase / legacy AccessContext remains current frontend/app authority; **Supabase not ready for Firebase cutover**.
- **No endpoints are implemented** (C-01…C-09 names remain proposed placeholders).

## 3. Read Model Design Principles

- **Server-owned read models**; the server composes what the UI sees.
- **No direct table passthrough; no raw row dumps; aggregation by default; redaction by default.**
- **Explicit environment scope** on every read model; **stable, versioned DTO contracts**.
- **No client-side filtering for security**; **no client-supplied UID authority**; **email never authority**.
- **`internal_user_id` remains the stable app anchor**; **provider-aware identity preserved**.
- **Tenant/store boundaries resolved server-side**.
- **DTOs must be already-redacted before reaching the UI** (the UI does zero redaction).

## 4. Authority Plane Model for DTOs

- **Frontend/app authority plane:** Firebase / legacy AccessContext remains current; **no cutover; no production auth change in M3.**
- **Server-side BCP read authorization plane:** future BCP read APIs authorize from the **server-derived authorization principal** (anchored on `internal_user_id`, provider-aware) **after parity/safety gates**. The Supabase-token path is dormant/flag-gated/shadow/readiness-gated.
- **DTOs may include safe authority *posture labels*, not raw auth identifiers.** No raw provider UIDs, emails, permission keys, entitlement keys, or identity-link rows.
- BCP read DTOs **must not assume Firebase frontend session claims are the final server authority**.
- **C-09 must not imply Supabase cutover.**

## 5. Standard DTO Envelope

Future read-only responses share one envelope (illustrative pseudo-schema; safe placeholders only):

```
{
  schemaVersion: "<semver-label>",     // allowed
  environment: "DEV",                   // allowed (DEV/STAGING only; never PROD value implying exposure)
  generatedAt: "<timestamp-placeholder>", // allowed (server time)
  data: { ... },                        // allowed — already-redacted posture payload only
  redaction: { ... },                   // allowed — see §7
  freshness: { ... },                   // allowed — see §8
  authorizationContext: { ... },        // allowed — safe posture labels only, see §9
  emptyState: { ... },                  // allowed — see §6
  warnings: [ "<safe-label>" ]          // allowed — safe operational labels only
}
```
**Allowed envelope fields:** `schemaVersion`, `environment`, `generatedAt`, `data`, `redaction`, `freshness`, `authorizationContext`, `emptyState`, `warnings`. **Minimized/masked:** `authorizationContext` carries only posture labels (never raw role/user IDs); `warnings` carry only safe labels (no stack traces/SQL). **Never in the envelope:** raw identifiers, secrets, tokens, payloads.

## 6. Empty-State DTO Design

```
emptyState: {
  isEmpty: <bool>,
  emptyReason: "no_data" | "blocked_on_schema" | "redacted_out" | "not_authorized_label",
  emptyLabel: "<safe-display-label>",
  recommendedUiState: "show_empty" | "show_blocked" | "show_review_required",
  blockedByPhase: "none" | "phase_2_schema" | "phase_3" | "phase_4",
  nextReviewGate: "<safe-gate-label>"
}
```
Rules: empty results **must not** cause UI `find() || [0]` fallbacks to unsafe assumptions; **must not** reveal whether sensitive records exist; **must avoid raw counts when counts are sensitive** (use a posture label instead); **must support Wave-2 blocked-on-schema** (`emptyReason: "blocked_on_schema"`, `blockedByPhase: "phase_2_schema"`).

## 7. Redaction Metadata Design

```
redaction: {
  redactionApplied: <bool>,
  redactionLevel: "none" | "standard" | "strict",
  omittedFields: [ "<field-category-label>" ],   // categories, never values
  maskedFieldCategories: [ "<category-label>" ],
  evidenceMode: "redacted_summary",
  reason: "<safe-reason-label>"
}
```
Only **category labels** appear — never omitted/masked *values*.

## 8. Freshness Metadata Design

```
freshness: {
  sourceFreshnessLabel: "fresh" | "delayed" | "unknown",
  generatedAt: "<timestamp-placeholder>",
  lastSuccessfulReadLabel: "<freshness-label>",
  stale: <bool>,
  staleReason: "none" | "source_delayed" | "read_blocked"
}
```
No real timestamps (placeholders only).

## 9. Authorization Context Metadata Design

```
authorizationContext: {
  viewerScopeLabel: "platform" | "tenant" | "store",
  roleClass: "<role-class-label>",          // class label, never raw role ID/key
  tenantScopeMode: "single" | "aggregated" | "blocked",
  storeScopeMode: "single" | "aggregated" | "blocked",
  sensitiveSectionAccess: "granted_label" | "withheld_label",
  crossTenantVisibilityMode: "none" | "platform_aggregated_label"
}
```
**Never exposed:** raw permission keys, entitlement keys, role IDs, user IDs, provider UIDs, emails.

## 10. Contract-to-DTO Matrix

| Contract | Proposed endpoint (placeholder) | DTO name | Primary read model | Wave | Sensitivity | Scope | Redaction level | Data-source readiness | Impl phase | Blockers |
|----------|--------------------------------|----------|--------------------|------|-------------|-------|-----------------|-----------------------|-----------|----------|
| C-01 | `GET /internal/bcp/readiness-summary` | `ReadinessSummaryDTO` | Readiness posture model | 1 | Low | Platform | standard | Posture (existing) | 2 (post-parity) | None |
| C-02 | `GET /internal/bcp/system-operations-summary` | `SystemOpsSummaryDTO` | Ops posture model | 1 | Low | Platform | standard | Posture (existing) | 2 | None |
| C-03 | `GET /internal/bcp/support-diagnostics-summary` | `SupportDiagnosticsSummaryDTO` | Diagnostics posture model | 1 | Low | Platform | standard | Posture (existing) | 2 | None |
| C-04 | `GET /internal/bcp/audit-visibility-summary` | `AuditVisibilitySummaryDTO` | **Net-new** audit aggregate | 1 | High | Platform | strict | Net-new read aggregate | 2 | Audit read layer net-new |
| C-05 | `GET /internal/bcp/configuration-posture-summary` | `ConfigurationPostureSummaryDTO` | Config posture model | 1 | Medium | Platform | standard | Posture (existing) | 2 | None |
| C-06 | `GET /internal/bcp/tenant-store-posture-summary` | `TenantStorePostureSummaryDTO` | Tenant/store posture model | 2 | High | Tenant/store or platform-agg | strict | **Blocked-on-schema** | 2 (after schema) | Tenant/store tables not migrated |
| C-07 | `GET /internal/bcp/billing-plan-posture-summary` | `BillingPlanPostureSummaryDTO` | Billing posture model | 2 | High | Tenant or platform-agg | strict | **Blocked-on-schema** | 2 (after schema) | Billing tables not migrated |
| C-08 | `GET /internal/bcp/data-governance-posture-summary` | `DataGovernancePostureSummaryDTO` | Governance posture model | 2 | Medium | Platform | standard | Posture (existing) | 2 | None |
| C-09 | `GET /internal/bcp/identity-readiness-posture-summary` | `IdentityReadinessPostureSummaryDTO` | Identity readiness posture model | 2 | High | Platform | strict | Posture (M20 dormant) | 2 | M20 paused; server-principal gated |

## 11. C-01 Readiness Summary DTO Design
`data: { devReview: "ready", liveReadOnly: "blocked", controlledActions: "blocked", production: "blocked", reviewGateLabel: "<safe-label>" }`. Safe posture labels only.

## 12. C-02 System Operations Summary DTO Design
`data: { services: { healthy: <count>, warning: <count>, blocked: <count> }, jobs: { activeLabel: "<label>" }, alerts: { openLabel: "<label>" } }`. **No** logs, traces, raw service IDs, stack traces, or live provider details. Counts allowed only where non-sensitive; else posture labels.

## 13. C-03 Support Diagnostics Summary DTO Design
`data: { runbooks: <count>, diagnostics: [ { label: "<safe-label>", severity: "low"|"medium"|"high" } ], liveInvocation: "disabled" }`. Runbook/status labels + counts only. **No customer/person data.**

## 14. C-04 Audit Visibility Summary DTO Design
`data: { categories: [ { category: "<safe-label>", status: "redacted", severity: "medium" } ], auditWrite: "disabled" }`, `redaction.redactionLevel: "strict"`. **This is a net-new server-composed redacted aggregate**; the existing audit foundation is **append/write-focused** (no read path). **No raw audit log dump, no raw actor IDs, no evidence ingestion, no audit-write capability, no raw event payloads.** Read-side redaction is distinct from and additional to the proven write-side allow-list.

## 15. C-05 Configuration Posture Summary DTO Design
`data: { items: [ { area: "<safe-label>", status: "ready"|"review_required", note: "redacted" } ] }`. **No** secrets, tokens, DB URLs, provider credentials, production config values, or unrestricted config dumps.

## 16. C-06 Tenant / Store Posture Summary DTO Design
`data: { tenants: { active: <count|label>, paused: <count|label>, reviewRequired: <count|label> }, stores: { operational: <count|label>, reviewRequired: <count|label> }, isolation: "enforced" }`. **Wave-2, blocked-on-schema** (tenant/store tables not migrated → `emptyState.emptyReason: "blocked_on_schema"` until present). Display labels + aggregated status; **no raw tenant/store/customer IDs** unless explicitly approved + masked; **no cross-tenant leakage**; **server-side tenant/store isolation required**.

## 17. C-07 Billing / Plan Posture Summary DTO Design
`data: { plans: [ { planLabel: "<safe-label>", count: <count|label> } ], subscriptions: { activeLabel: "<label>", reviewLabel: "<label>" }, billingReadiness: "blocked" }`. **Wave-2, blocked-on-schema**. Plan/entitlement/billing-readiness posture labels only. **No** payment identifiers, raw invoice details, customer billing data, provider tokens, or entitlement-key dumps.

## 18. C-08 Data Governance Posture Summary DTO Design
`data: { schema: "<posture-label>", dataQuality: "<posture-label>", rls: "protected", redactionPosture: "<label>" }`. **No** table dumps, row dumps, raw database identifiers, or unrestricted mismatch lists.

## 19. C-09 Identity Readiness Posture Summary DTO Design
`data: { frontendAppAuthority: "firebase", serverDerivedPrincipalReadiness: "gated", supabase: "dormant_shadow_readiness_only", supabaseCutover: "not_ready", identityLink: { schema: "applied_dev_schema_only", rls: "protected", rows: "not_exposed", writeExercise: "blocked", adapters: "built_tested_dormant_unwired" }, m20: "partially_built_dormant_paused" }`, `redaction.redactionLevel: "strict"`. Incorporates the M2.1 correction in full. **No** raw `identity_link` rows, **no** email authority, **no** client-supplied UID authority, **no** provider UID dumps. **Does not imply Supabase cutover.**

## 20. Blocked / Deferred DTO Areas
**jobs/workers, API traffic, logs/telemetry, backups/recovery, deployments/releases, config/secrets, identity-link details** — DTO design is **deferred/blocked**. Before each may proceed: a redacted, aggregated read model must exist with **no raw payloads/args, no request bodies/paths-with-IDs, no raw log lines/PII/stack traces, no storage locations/credentials, no infra identifiers/secrets**; **config/secrets remains permanently blocked** from any DTO; **identity-link details** remain blocked while M20 is paused (at most a redacted readiness posture, never rows).

## 21. Field Classification Rules

| Class | Examples (categories, not values) |
|-------|-----------------------------------|
| **Allowed** | status/posture labels, env label, schemaVersion, safe counts |
| **Allowed with masking** | tenant/store *display labels*, freshness labels |
| **Aggregated only** | counts of services/jobs/alerts/tenants/stores where non-sensitive |
| **Omitted by default** | anything not required by the consuming screen |
| **Blocked** | secrets, tokens, DB URLs, payment IDs, raw IDs, raw rows, permission/entitlement keys, mismatch lists, raw audit logs, raw identity-link rows |
| **Phase 3 only** | any field implying an action/mutation/approval |
| **Phase 4 only** | any field implying production exposure |

## 22. Forbidden DTO Payloads
raw secrets · DB URLs · tokens · provider credentials · payment identifiers · raw customer/person emails · raw tenant/customer/store IDs (unless approved + masked) · row dumps · raw audit logs · raw identity-link rows · permission key dumps · entitlement key dumps · mismatch lists · unrestricted stack traces · production config values.

## 23. Mapper Design Principles for Future Implementation
Mapper functions must be **pure**; receive **already-authorized server-side inputs**; **never authorize by UI assumption**; **apply redaction before DTO return**; **never pass through raw source objects**; include **blocked-field tests** and **negative tests**; produce **stable, versioned** output; and **support empty-state DTOs**.

## 24. Validation and Test Requirements
DTO schema tests · mapper unit tests · redaction tests · forbidden-field tests · tenant/store isolation tests · RBAC visibility tests · audit-summary redaction tests · stale/freshness metadata tests · empty-state tests · error payload tests · **no mutation tests in Phase 2** · **no production tests**.

## 25. Stop Conditions
Halt if a DTO: requires mutation; requires raw secrets; requires raw unmasked identifiers; requires payment/provider credentials; relies on client-side filtering for security; requires Supabase cutover; creates auth authority ambiguity; requires production exposure; leaks tenant/store boundaries; requires raw identity-link rows; requires raw audit logs; assumes a live pilot before parity; or ignores blocked-on-schema Wave-2 status.

## 26. Acceptance Criteria
Acceptable when: read-model/DTO design is documented (envelope + metadata + C-01…C-09 sketches + classification/forbidden rules + mapper/test requirements); M2.1 inputs (authority planes, corrected ordering, M20 posture) are incorporated; empty-state design is included; no code/types/read-model/route/runtime/auth/DB change occurs; and the document claims **no** DTO/read-model implementation, **no** live/production readiness, and **no** Supabase cutover readiness.

## 27. Recommended Next Milestone
**Phase 2.0 M4 — Backend Control Panel Redaction, Masking, and Evidence Rules.**
