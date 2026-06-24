# Phase 2.0 M2 — Backend Control Panel Read-Only API Contract Map

**Status:** Documentation/design-only · No endpoints implemented
**Accepted checkpoint at authoring:** `09bb80debdd049c944fceb8040be699b958d484e` (Phase 2.0 M1)
**Authoring milestone:** Phase 2.0 M2

> Redaction-first document. All endpoint names are **proposed placeholders, not
> implemented routes**. Contains no real tenant/store/customer data, raw IDs, row
> dumps, emails, domains, DB URLs, tokens, secrets, payment identifiers,
> permission/entitlement key lists, or mismatch lists. This milestone makes no
> runtime, route, auth, DB, Supabase, or Backend Control Panel (BCP) UI change.

---

## 1. Executive Summary

This is a **design-only contract map** for future Backend Control Panel live read-only integration. **No endpoint is implemented**, no route is created, no DB/Supabase connection is made, and no UI is changed. The map defines which BCP screens would receive future read-only contracts, sequences them into Wave 1/2/3, sketches high-level DTO shapes using safe placeholder values only, and specifies the authorization, tenant/store isolation, RBAC, audit, redaction, error, environment, and testing requirements that any future implementation must satisfy. Every endpoint name below is a **proposed placeholder**.

## 2. Current State and Boundary

Phase 2 boundary (restated):
- **Live-read-only planning only.**
- **No APIs yet** (names are proposals).
- **No DB yet.**
- **No Supabase cutover** (Firebase / legacy AccessContext remains authoritative; Supabase dormant/shadow/readiness-only).
- **No actions** (controlled actions are Phase 3).
- **No production exposure** (production is Phase 4).
- BCP remains DEV-gated at `/dev/backend-control-plane`, frontend-only, read-only, mock-only, code-split. M20 identity-link / DEV test-data registry stream remains paused.

## 3. Contract Waves

**Wave 1 — DEV-only low-risk posture contracts:** readiness/status summary, system operations summary, support diagnostics summary, redacted audit summary, safe configuration metadata.

**Wave 2 — governed business/platform visibility contracts:** tenant/store posture summary, billing/plan posture summary, data governance posture summary, identity readiness posture summary.

**Wave 3 — higher-risk / deferred contracts:** jobs/workers, API traffic, logs/telemetry, backups/recovery, deployments/releases, config/secrets, identity-link details, any raw identifier or sensitive security detail.

## 4. Proposed Contract Inventory Table

> **All endpoint names below are PROPOSED placeholders only — not implemented routes.** "Phase Boundary" = the phase that gates the contract.

| Contract ID | BCP Area | Candidate Endpoint Name (proposed) | Wave | Readiness Status | Intended Consumer Screen | Data Classification | Required Authorization | Tenant/Store Scope | Redaction Rule | Phase Boundary |
|-------------|----------|-----------------------------------|------|------------------|--------------------------|---------------------|------------------------|--------------------|----------------|----------------|
| C-01 | Readiness Gate | `GET /internal/bcp/readiness-summary` | 1 | DEV-pilot candidate | Readiness Gate | Internal-safe posture | BCP access | Platform-level (no tenant data) | Status labels only | Phase 2 |
| C-02 | System Operations | `GET /internal/bcp/system-operations-summary` | 1 | DEV-pilot candidate | System Operations Overview | Internal-safe posture | BCP access | Platform-level | Counts + status labels | Phase 2 |
| C-03 | Support & Diagnostics | `GET /internal/bcp/support-diagnostics-summary` | 1 | DEV-pilot candidate | Support & Diagnostics Overview | Internal-safe posture | BCP access | Platform-level | Labels only; no raw diagnostics | Phase 2 |
| C-04 | Audit Governance | `GET /internal/bcp/audit-visibility-summary` | 1 | DEV-pilot candidate | Audit Governance Overview | Restricted → redacted summary | BCP access + sensitive-view | Platform-level | Aggregated; no raw events/actors | Phase 2 |
| C-05 | Configuration Posture | `GET /internal/bcp/configuration-posture-summary` | 1 | DEV-pilot candidate | Data Governance / Settings posture | Internal-safe metadata | BCP access | Platform-level | Safe metadata; no secrets | Phase 2 |
| C-06 | Tenant & Store | `GET /internal/bcp/tenant-store-posture-summary` | 2 | Governed candidate | Tenant & Store Operations Lens | Sensitive → aggregated/redacted | BCP access + cross-tenant permission | Tenant/store-scoped or platform-aggregated | Display labels only; no real names/IDs | Phase 2 |
| C-07 | Billing & Plan | `GET /internal/bcp/billing-plan-posture-summary` | 2 | Governed candidate | Billing & Plan Operations Lens | Sensitive → aggregated/redacted | BCP access + sensitive-view | Tenant-scoped or platform-aggregated | No payment IDs; posture labels only | Phase 2 |
| C-08 | Data Governance | `GET /internal/bcp/data-governance-posture-summary` | 2 | Governed candidate | Data Governance Overview | Internal-safe posture | BCP access | Platform-level | Posture metadata; no connection data | Phase 2 |
| C-09 | Identity Readiness | `GET /internal/bcp/identity-readiness-posture-summary` | 2 | Governed candidate | Identity Readiness Overview | Restricted → redacted summary | BCP access + sensitive-view | Platform-level | No raw provider/internal IDs; status only | Phase 2 |
| — | Jobs/Workers, API Traffic, Logs/Telemetry, Backups/Recovery, Deployments/Releases, Config/Secrets, Identity-Link Details | *(no proposed endpoint yet)* | 3 | **Deferred / blocked** | Respective placeholder screens | Sensitive / restricted / blocked | TBD (stronger gates) | TBD | TBD (see §8) | Phase 2 (deferred) → Phase 3/4 as noted |

## 5. DTO Design Principles

- **Summarized posture objects** — not row collections.
- **Counts and status labels over raw rows.**
- **No raw table passthrough.**
- **No secrets**, no payment identifiers.
- **No real emails/domains** unless explicitly approved and masked.
- **No permission-key list dumps**; **no entitlement-key list dumps**; **no mismatch lists**.
- **Stable, versioned response shape** (additive evolution).
- **Explicit `environment` label** in every response.
- **`generatedAt` timestamp allowed** (server time).
- **Redaction metadata allowed** (e.g. a flag indicating fields were redacted).
- **Source freshness metadata allowed** (e.g. a freshness label).
- **No client-side filtering for security** (filtering is presentation, never an authorization boundary).

## 6. Wave 1 Contract Sketches

> Safe placeholder values only. No real data. Pseudo-schema is illustrative, not implemented.

**C-01 Readiness summary** — `{ environment: "DEV", generatedAt: <timestamp>, devReview: "ready", liveReadOnly: "blocked", controlledActions: "blocked", production: "blocked", redacted: true }`

**C-02 System operations summary** — `{ environment: "DEV", generatedAt: <timestamp>, services: { healthy: <count>, warning: <count>, blocked: <count> }, jobs: { active: <count> }, alerts: { open: <count> }, freshnessLabel: "redacted" }`

**C-03 Support diagnostics summary** — `{ environment: "DEV", generatedAt: <timestamp>, runbooks: <count>, diagnostics: [{ label: "<safe-label>", severity: "low" }], liveInvocation: "disabled" }`

**C-04 Audit visibility summary** — `{ environment: "DEV", generatedAt: <timestamp>, categories: [{ category: "<safe-label>", status: "redacted", severity: "medium" }], auditWrite: "disabled", rawEvents: "blocked", redacted: true }`

**C-05 Configuration posture summary** — `{ environment: "DEV", generatedAt: <timestamp>, items: [{ area: "<safe-label>", status: "ready", note: "redacted" }], secrets: "blocked" }`

Placeholder vocabularies: `status`: `"ready" | "blocked" | "review_required"`; `severity`: `"low" | "medium" | "high"`; `environment`: `"DEV"`; `count`: number; `lastUpdatedLabel`: `"redacted"`.

## 7. Wave 2 Contract Sketches

> All aggregated/redacted. Safe placeholder values only.

**C-06 Tenant/store posture summary** — `{ environment: "DEV", generatedAt: <timestamp>, tenants: { active: <count>, paused: <count>, reviewRequired: <count> }, stores: { operational: <count>, reviewRequired: <count> }, isolation: "enforced", labelsOnly: true }` *(display labels only; never real tenant/store/customer names or IDs)*

**C-07 Billing/plan posture summary** — `{ environment: "DEV", generatedAt: <timestamp>, plans: [{ planLabel: "<safe-label>", count: <count> }], subscriptions: { active: <count>, review: <count> }, paymentIdentifiers: "blocked", productionBilling: "blocked" }`

**C-08 Data governance posture summary** — `{ environment: "DEV", generatedAt: <timestamp>, schema: "posture-label", migration: "posture-label", rls: "protected", connectionData: "blocked" }`

**C-09 Identity readiness posture summary** — `{ environment: "DEV", generatedAt: <timestamp>, platformIdentity: "readiness-label", identityLink: "blocked", sessionAuthority: "firebase", rawIdentifiers: "blocked", m20Stream: "paused" }`

## 8. Wave 3 Deferred Contract Notes

Each Wave 3 area is deferred because it tends to require raw identifiers, sensitive operational detail, or live invocation. Required before any can become live-read-only:
- **Jobs/workers** — needs aggregated job/queue posture without raw payloads/arguments; isolation + redaction gates.
- **API traffic** — needs aggregated counts/rates without request bodies, paths with IDs, or tokens.
- **Logs/telemetry** — needs strict redaction (no raw log lines, PII, stack traces); likely log-pipeline redaction first.
- **Backups/recovery** — needs posture labels without storage locations/credentials.
- **Deployments/releases** — needs status labels without infra identifiers/secrets.
- **Config/secrets** — **remains blocked**; secrets must never reach the UI.
- **Identity-link details** — blocked while the M20 stream is paused; requires identity-link safety review (Phase 2.0 M7+) and remains read-only-redacted at most.

## 9. Authorization Requirements

- **BCP access permission** required for any contract.
- **Platform role visibility** — role determines which sections are visible.
- **Sensitive section visibility** — stronger permission for C-04, C-06, C-07, C-09.
- **Tenant/store scope resolution server-side** from the authenticated principal.
- **No client-supplied UID authority.**
- **No email authority.**
- **`internal_user_id` anchor** retained.
- **Provider-aware identity model preserved** (provider identity ≠ authority alone).

## 10. Tenant / Store Isolation Requirements

- **Tenant scope required** for tenant-scoped contracts.
- **Store scope required** for store-scoped contracts.
- **Platform-level cross-tenant summaries require explicit platform permission.**
- **No UI-only isolation.**
- **Negative isolation tests required** (cross-tenant/store attempts fail closed).
- **Redacted evidence required** for sign-off (no raw rows in evidence).

## 11. RBAC Visibility Requirements

- **View-only roles** for general posture.
- **Sensitive read-only sections** gated behind stronger permission.
- **No action permission implied** by any visibility grant.
- **No Phase 3 approval/action capability.**
- **No mutation by contract design** (read-only verbs only).

## 12. Audit and Evidence Rules

- **Read-only audit visibility allowed only in redacted summary form.**
- **Audit writer unchanged.**
- **No evidence ingestion.**
- **No raw audit event dump.**
- **No actor raw IDs** unless explicitly approved and masked.
- **Audit read tracking is optional/future** and must itself be redaction-safe.

## 13. Redaction and Masking Rules by Field Category

| Category | Rule |
|----------|------|
| Safe status labels | Allowed (e.g. `ready`/`blocked`/`review_required`). |
| Counts and aggregates | Allowed. |
| Timestamps / freshness labels | Allowed (`generatedAt`, freshness label). |
| Tenant/store display labels | Allowed only as safe display labels — never real names/IDs. |
| Sensitive identifiers | Blocked unless explicitly approved + masked. |
| Secrets and tokens | Blocked. |
| Payment / provider identifiers | Blocked. |
| Auth / security identifiers | Blocked unless approved + masked. |
| Permission / entitlement keys | Blocked (no key-list dumps). |

## 14. Blocked Fields and Forbidden Payloads

Forbidden in any response payload:
- Raw secrets · DB URLs · tokens · provider credentials · payment identifiers
- Raw customer/person emails · raw tenant/customer/store IDs (unless explicitly approved)
- Row dumps · raw audit logs · raw identity-link rows
- Permission key dumps · entitlement key dumps · mismatch lists
- Unrestricted stack traces · production config values

## 15. Error Response Contract Principles

- **Safe error codes** (stable, non-revealing).
- **No stack traces** in responses.
- **No SQL errors** in responses.
- **No secrets** in errors.
- **Generic access-denied messages** (no enumeration of why).
- **Correlation reference allowed only if safe and non-sensitive** (opaque, no embedded identifiers).

## 16. Environment and Feature Flag Requirements

- **DEV first.**
- **STAGING after approval.**
- **Production blocked.**
- **Feature flag required** for any live read-only wiring.
- **Kill switch required** (instant revert to mock/no-data).
- **No normal SaaS navigation exposure.**
- **`environment` label required in every response.**

## 17. Testing Requirements for Future Implementation

Planned (none run in this milestone): contract unit tests; DTO mapper tests; authorization tests; tenant/store isolation tests; redaction tests; error response tests; negative tests; **no mutation tests in Phase 2**; **no production tests**.

## 18. Contract Acceptance Criteria

Before any future implementation: approved contract map; approved DTOs; approved redaction rules; approved authorization gates; approved isolation test plan; approved feature flag strategy; approved DEV-only pilot scope.

## 19. Stop Conditions

Halt and reassess if a contract: requires mutation; requires raw secrets; requires unredacted raw identifiers; exposes payment/provider credentials; relies on client-side filtering for security; requires Supabase cutover; creates auth authority ambiguity; requires production exposure; or leaks tenant/store boundaries.

## 20. Recommended Next Milestone

**Phase 2.0 M3 — Backend Control Panel Read Model and DTO Design.**
