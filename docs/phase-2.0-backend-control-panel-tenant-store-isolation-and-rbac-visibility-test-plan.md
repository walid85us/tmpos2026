# Phase 2.0 M5 — Backend Control Panel Tenant / Store Isolation and RBAC Visibility Test Plan

**Status:** Documentation-only · Isolation / RBAC visibility test plan (no tests, APIs, DTOs, read models, mappers, routes, or live data implemented)
**Accepted checkpoint at authoring:** `929b069a7a697f091ce56eabcd4dd45fcfda108a` (Phase 2.0 M4)
**Authoring milestone:** Phase 2.0 M5

> Redaction-first document. Contains no real tenant/store/customer data, raw IDs,
> row dumps, emails, domains, DB URLs, tokens, secrets, payment identifiers,
> provider credentials, permission/entitlement key lists, or mismatch lists. This
> milestone makes no runtime, route, auth, DB, Supabase, DTO, type, read-model,
> mapper, test, fixture, or Backend Control Panel (BCP) UI change. Nothing is
> staged, committed, pushed, or backed up by this milestone.

---

## 1. Executive Summary

This is a **documentation/design-only** milestone. It defines the test plan that future Backend Control Panel (BCP) live read-only integration **must** satisfy for tenant isolation, store isolation, cross-tenant platform visibility, and role-based (RBAC) read-only visibility.

No tests, APIs, DTOs, read models, mappers, routes, DB access, Supabase calls, fixtures, or live data are implemented here. This plan describes *what* must be proven and *how coverage is structured* before any live read-only pilot — it does not implement or run anything. The controlling rule remains **fail closed and enforce isolation server-side**: visibility is never assumed, never client-trusted, and any unproven scope denies access.

## 2. Current State and Boundary

- **Phase 2.0 M1** (Live Read-Only Architecture & Safety Gates Plan) — complete.
- **Phase 2.0 M2** (Read-Only API Contract Map; 9 proposed contracts C-01..C-09; endpoint names are proposed placeholders only; no endpoints implemented) — complete.
- **Phase 2.0 M2.1** (Pre-M3 Design Reconciliation; two authority planes, corrected Phase 2 ordering, precise M20 / `identity_link` posture) — complete.
- **Phase 2.0 M3** (Read Model and DTO Design; standard already-redacted DTO envelope, empty-state design, contract-to-DTO matrix, C-01..C-09 DTO sketches, mapper/test principles; no DTO code/types/read models/mappers implemented) — complete.
- **Phase 2.0 M4** (Redaction, Masking, and Evidence Rules; server-side redaction by default, evidence mode levels, contract-specific redaction matrix, future mapper/test requirements; no code implemented) — complete.

Boundary restated:

- The BCP is **not yet live-read-only**; it is still mock-only and DEV-gated at `/dev/backend-control-plane`.
- The BCP remains **frontend-only, read-only, mock-only, and code-split**.
- **Firebase / legacy AccessContext remains the current frontend/app authority.**
- Future BCP live read APIs must authorize from the **server-derived authorization principal** after parity/safety gates.
- **Supabase remains dormant / shadow / readiness-only and is not ready for a Firebase cutover.**
- **Phase 2 ordering requires the Firebase vs Supabase parity review (M6) before any live read-only pilot (M7).**
- **No endpoints, tests, or read models are implemented.** M5 defines **test strategy only.**
- Controlled backend actions remain **Phase 3**; production readiness remains **Phase 4**.

## 3. Isolation and RBAC Principles

- **Server-side isolation only.** Tenant/store scope is resolved and enforced on the server from the authenticated principal.
- **No UI-side enforcement as a security boundary.** Client filtering is a presentation concern and is never an authorization boundary.
- **Fail closed.** Any unresolved scope, unknown role, or classification error denies access rather than exposing data.
- **Least privilege.** A principal sees only what its role and scope explicitly permit; nothing is visible by default.
- **Explicit platform permission for cross-tenant visibility.** Cross-tenant views require a distinct, stronger platform permission — BCP access alone never implies them.
- **Store-scoped users must not see other stores.**
- **Tenant-scoped users must not see other tenants.**
- **Sensitive sections require stronger visibility permission** than general posture sections.
- **Read-only visibility does not imply Phase 3 action permission.** Viewing a posture never grants the right to act on it.

## 4. Authority Plane Test Implications

- **Firebase frontend/app authority remains current** for the application; tests must not treat it as the final server authorization authority for BCP read APIs.
- Future BCP read APIs must be tested against the **server-derived authorization principal** (anchored on `internal_user_id`, provider-aware) **after parity/safety gates pass**.
- **No test may treat a client-supplied UID, email, or frontend-only claim as final authority.** These are inputs, never authorities.
- **Provider-aware identity mapping must be preserved** in all authorization tests.
- **Parity review (M6) is required before any live pilot (M7).** No test plan step may assume a validated server-derived principal in a live pilot before parity is reviewed; pre-parity tests run only against synthetic/DEV scaffolding, not a live pilot.

## 5. RBAC Visibility Model

Proposed read-only visibility classes (conceptual; **not yet implemented**, mapped onto the existing server-derived permission catalog rather than invented as new code):

| Visibility class | Intended read-only scope |
|---|---|
| No BCP access | Cannot reach any BCP read surface; all contracts deny. |
| BCP overview viewer | Low-sensitivity posture only (e.g. readiness, system ops summary). |
| BCP tenant/store viewer | Scoped tenant/store posture within the principal's own scope. |
| BCP billing/plan viewer | Billing/plan posture (sensitive); no payment data. |
| BCP identity readiness viewer | Identity readiness posture labels only; no raw identity data. |
| BCP audit visibility viewer | Redacted audit aggregate only. |
| BCP security/sensitive viewer | Sensitive/restricted posture sections, still redacted. |
| BCP cross-tenant platform viewer | Aggregated cross-tenant posture, explicit platform permission required. |
| BCP system owner / full read-only viewer | Broadest read-only posture; still redacted, still no actions. |

These classes are **conceptual proposals**. They are mapped to the existing permission catalog only in principle. **No claim is made that these permissions exist** until they are implemented in a later, separately authorized milestone. No new permission code, key, or catalog entry is created here.

## 6. Sensitive Section Classification

| Area | Sensitivity | Rationale |
|---|---|---|
| C-01 Readiness summary | Low | Aggregated posture labels. |
| C-02 System operations summary | Low / Moderate | Aggregated operational metrics. |
| C-03 Support diagnostics summary | Moderate | Diagnostic posture; no raw payloads. |
| C-04 Audit visibility | Sensitive | Redacted audit aggregate; actor/event detail is sensitive. |
| C-05 Configuration posture | Restricted / blocked | Config/secrets adjacency; screen deferred/blocked. |
| C-06 Tenant / store posture | Sensitive | Tenant/store scope; cross-tenant leakage risk. |
| C-07 Billing / plan posture | Sensitive | Plan/billing adjacency to payment data. |
| C-08 Data governance posture | Moderate / Sensitive | Schema/quality posture; mismatch detail is sensitive. |
| C-09 Identity readiness posture | Sensitive | Identity/auth posture; raw identity data restricted. |
| Wave 3 — jobs/workers, API traffic, logs/telemetry, backups/recovery, deployments/releases, config/secrets, identity-link details | Restricted / blocked | May contain secrets, raw IDs, payloads; deferred. |

## 7. Tenant Isolation Test Matrix

Future tests (planned here; none run in this milestone) must prove:

- **Tenant A cannot see tenant B** across every tenant-scoped contract.
- **Tenant B cannot see tenant A** (symmetry asserted in both directions).
- **An unauthorized tenant returns a safe empty/denied state** indistinguishable from "no records."
- **Cross-tenant summaries require explicit platform permission** and are denied without it.
- **Redacted evidence proves no tenant leakage** without exposing raw tenant IDs (aggregate/redacted evidence only).
- **No client-side tenant filtering** — isolation must hold even if the client requests another tenant's scope.

## 8. Store Isolation Test Matrix

Future tests must prove:

- **Store A cannot see store B** across every store-scoped contract.
- **Users scoped to one store cannot see other-store posture.**
- **Tenant-level users may see multiple stores only within their allowed scope**, never beyond it.
- **An unauthorized store returns a safe empty/denied state.**
- **Redacted evidence proves no store leakage** without exposing raw store IDs.
- **No client-side store filtering** — store isolation holds server-side regardless of client requests.

## 9. Cross-Tenant Platform Visibility Tests

Future tests for platform-level views must prove:

- **A platform viewer sees aggregated cross-tenant posture only if explicitly permitted**; absent that permission, the view denies.
- **Cross-tenant responses must be aggregate/redacted** — no per-tenant raw detail.
- **No raw tenant/customer/store IDs** appear in cross-tenant responses.
- **No tenant-specific sensitive data** is exposed unless explicitly approved and masked.
- **No drilldown without stronger permission** — moving from aggregate to any narrower view requires an additional, stronger permission and is denied otherwise.

## 10. Contract-Specific Isolation / RBAC Matrix

Endpoint/contract names are proposed placeholders only; nothing below is implemented.

| Contract | DTO / read model | Tenant scope required? | Store scope required? | Cross-tenant permission required? | Sensitive permission required? | Negative tests required | Empty-state behavior | Evidence mode | Blocking condition |
|---|---|---|---|---|---|---|---|---|---|
| C-01 Readiness summary | Posture DTO | No (platform posture) | No | Only for cross-tenant aggregate | No | Yes | `no_visible_records` / `blocked_by_phase` | `safe_summary` | — |
| C-02 System operations summary | Ops summary DTO | No | No | Only for cross-tenant aggregate | No | Yes | `no_visible_records` | `safe_summary` / `aggregate_only` | — |
| C-03 Support diagnostics summary | Diagnostic posture DTO | Conditional | Conditional | Only for cross-tenant aggregate | Moderate | Yes | `no_visible_records` | `safe_summary` | — |
| C-04 Audit visibility | Audit aggregate DTO | Yes (scoped) | Conditional | Yes (cross-tenant aggregate) | **Yes** | Yes | `no_visible_records` | `aggregate_only` | — |
| C-05 Configuration posture | Config posture DTO | No | No | No | **Yes** | Yes | `blocked_by_phase` | `blocked` / `safe_summary` | Config/secrets deferred/blocked |
| C-06 Tenant / store posture | Tenant/store posture DTO | **Yes** | **Yes** | Yes (for cross-tenant) | Yes | Yes | `blocked_by_schema` / `not_authorized` | `safe_summary` / `aggregate_only` | Blocked-on-schema |
| C-07 Billing / plan posture | Billing posture DTO | Yes | Conditional | Yes (for cross-tenant) | **Yes** | Yes | `blocked_by_schema` | `safe_summary` / `aggregate_only` | Blocked-on-schema |
| C-08 Data governance posture | Governance posture DTO | Conditional | Conditional | Yes (for cross-tenant) | Sensitive | Yes | `no_visible_records` / `redacted` | `aggregate_only` | — |
| C-09 Identity readiness posture | Identity readiness DTO | No (posture) | No | No | **Yes** | Yes | `blocked_by_phase` / `redacted` | `safe_summary` | M20 write/control blocked; no Supabase cutover |

## 11. C-01 Readiness Summary Test Plan

- **Authorization:** deny when the principal lacks BCP overview visibility; allow read-only posture otherwise.
- **Isolation:** readiness is platform posture; any cross-tenant aggregation requires explicit platform permission.
- **Negative:** unauthorized principal returns a safe denied/empty state; no readiness detail leaks.
- **Evidence:** `safe_summary` posture labels only; no raw gated values.

## 12. C-02 System Operations Summary Test Plan

- **Authorization:** overview viewer or higher; deny otherwise.
- **Isolation:** aggregated operational metrics only; cross-tenant aggregation gated by platform permission.
- **Negative:** unauthorized access denied; over-privilege attempts fail closed.
- **Evidence:** `safe_summary` / `aggregate_only`; no raw IDs.

## 13. C-03 Support Diagnostics Summary Test Plan

- **Authorization:** moderate visibility; deny lower roles.
- **Isolation:** diagnostics scoped to the principal's tenant/store where applicable; no cross-scope bleed.
- **Negative:** cross-scope and unauthorized requests denied; no raw diagnostics/logs/payloads exposed.
- **Evidence:** `safe_summary`; redacted diagnostic posture only.

## 14. C-04 Audit Visibility Summary Test Plan

- **Authorization:** **sensitive permission required** (BCP audit visibility viewer or higher).
- **Isolation:** scoped audit aggregate; cross-tenant aggregate requires platform permission.
- **Must include:** no raw audit logs; no raw actor IDs; no raw event payloads; redacted evidence only; **no audit-write capability** is added or tested as available.
- **Negative:** insufficient permission denied; attempts to retrieve raw events fail closed.
- **Evidence:** `aggregate_only`; safe actor labels (e.g. "Actor Redacted" / role-class) and bucketed timing.

## 15. C-05 Configuration Posture Summary Test Plan

- **Authorization:** **sensitive permission required**; the config/secrets screen remains **blocked/deferred**.
- **Isolation:** posture labels only; no tenant/store-specific config values.
- **Must include:** no secrets; no tokens; no DB URLs; no provider credentials; no production config values.
- **Negative:** any attempt to retrieve config values, env vars, or secrets fails closed and returns `blocked_by_phase`.
- **Evidence:** `blocked` / `safe_summary` posture labels only.

## 16. C-06 Tenant / Store Posture Summary Test Plan

- **Authorization:** tenant/store viewer scoped to the principal's own tenant and store.
- **Isolation:** **tenant scope and store scope both required and resolved server-side**; cross-tenant requires explicit platform permission.
- **Must include:** blocked-on-schema/read-model readiness; correct tenant/store scope resolution; no raw tenant/store/customer IDs; no cross-tenant leakage; safe empty states.
- **Negative:** tenant A → tenant B and store A → store B both denied; unauthorized tenant/store returns `not_authorized` / `blocked_by_schema` indistinguishable from empty.
- **Evidence:** `safe_summary` / `aggregate_only`; safe display labels only.

## 17. C-07 Billing / Plan Posture Summary Test Plan

- **Authorization:** **sensitive permission required** (billing/plan viewer or higher).
- **Isolation:** scoped billing/plan posture; cross-tenant requires platform permission; blocked-on-schema/read-model readiness.
- **Must include:** no payment identifiers; no raw invoice/customer billing data; no provider tokens; no entitlement key dumps.
- **Negative:** insufficient permission denied; attempts to read payment/invoice/entitlement detail fail closed.
- **Evidence:** `safe_summary` / `aggregate_only`; plan posture and billing readiness labels only.

## 18. C-08 Data Governance Posture Summary Test Plan

- **Authorization:** moderate/sensitive visibility per the section classification.
- **Isolation:** governance posture scoped appropriately; cross-tenant aggregate gated by platform permission.
- **Must include:** no row/table dumps; no raw DB identifiers unless approved and masked; no unrestricted mismatch lists; redacted evidence only.
- **Negative:** attempts to retrieve rows, tables, or mismatch lists fail closed.
- **Evidence:** `aggregate_only`; data quality / schema readiness / redaction posture labels.

## 19. C-09 Identity Readiness Posture Summary Test Plan

- **Authorization:** **sensitive permission required** (identity readiness viewer or higher).
- **Isolation:** posture labels only; not tenant/store-scoped data.
- **Must include:** Firebase frontend/app authority reported as a **label only**; server-derived principal readiness as a **label only**; **Supabase not ready for cutover**; no raw `identity_link` rows; no provider UID dumps; no email authority; no client UID authority; **M20 posture only, no write/control**.
- **Negative:** attempts to read raw identity rows, provider UIDs, or to assert UID/email authority fail closed; no write/control path is exposed.
- **Evidence:** `safe_summary`; identity readiness posture labels only.

## 20. Wave 3 Deferred / Blocked Test Notes

Before any Wave 3 area advances to live read-only, it requires its own dedicated isolation/RBAC and redaction test design, because each may carry secrets, raw IDs, or payloads:

- **Jobs / workers** — may expose provider payloads or internal IDs.
- **API traffic** — may expose request/response payloads.
- **Logs / telemetry** — may contain secrets, raw IDs, stack traces, tenant/customer detail.
- **Backups / recovery** — may reference sensitive locations/identifiers.
- **Deployments / releases** — may expose infra/config detail.
- **Config / secrets** — blocked/deferred; secrets must never be exposed.
- **Identity-link details** — `identity_link` rows are not exposed; write/control remains blocked/paused.

These remain **deferred/blocked** in M5; no Wave 3 test is authorized here.

## 21. Empty-State and Denied-State Test Rules

Bounded states future tests must assert and verify as safe: `not_authorized`, `no_visible_records`, `blocked_by_phase`, `blocked_by_schema`, `redacted`, `unavailable`.

Rules:

- A state **must not reveal hidden-record existence** — "empty" and "exists-but-hidden" are indistinguishable.
- A state **must not expose sensitive counts** — use a safe status instead of a revealing number.
- A state **must not rely on UI fallback selection** — the UI renders the safe status as-is and assumes nothing.
- States **must be safe for all of C-01 through C-09** and consistent with the M4 empty-state rules.

## 22. Redacted Evidence Requirements

- Evidence must be one of `safe_summary`, `aggregate_only`, `redacted_snapshot`, or `blocked` (per M4 evidence modes).
- Evidence **must not include raw IDs.**
- Evidence **must not include secrets.**
- Evidence **must not include raw audit logs.**
- Evidence **must not include raw `identity_link` rows.**
- Evidence **must prove negative isolation** (that cross-tenant/store access was denied) **without leaking what was blocked** — it confirms the denial, never the blocked subject.

## 23. Test Data Strategy

- **Synthetic/redacted test fixtures only.**
- **No production data.**
- **No real tenant/customer/billing/auth data.**
- **No real emails or domains.**
- **No raw provider identifiers.**
- **No payment data.**
- Fixtures must include **both positive and negative isolation scenarios** (allowed-in-scope and denied-cross-scope).
- **Any controlled DB fixture path requires separate authorization and is not part of M5** (no fixtures, seeds, or DB writes are created here).

## 24. Future Test Categories

Future tests (planned here; none run in this milestone):

- **Authorization tests** — allowed vs denied per role/scope.
- **Tenant isolation tests.**
- **Store isolation tests.**
- **Cross-tenant visibility tests.**
- **Sensitive-section visibility tests.**
- **Redaction tests.**
- **Empty-state tests.**
- **Denied-state tests.**
- **Evidence safety tests.**
- **No-mutation tests** (assert no mutation path exists).
- **No-production tests** (assert no production exposure).

## 25. Stop Conditions

Halt and reassess before proceeding if any of the following arise:

- A test would require **production data**.
- A test would require **raw secrets**.
- A test would require **raw `identity_link` rows**.
- A test would require **raw audit logs**.
- A test would require **payment identifiers**.
- A test would require **unredacted tenant/store/customer IDs**.
- A test would rely on **client-side filtering for security**.
- A test would require a **Supabase cutover**.
- A test would **assume a live pilot before parity** review.
- A test would create **auth authority ambiguity**.
- A test would require **mutation**.
- A test would require **production exposure**.

## 26. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It defines isolation and RBAC principles (§3) and authority-plane test implications (§4).
- It defines the RBAC visibility model (§5) and sensitive-section classification (§6).
- It provides tenant (§7), store (§8), and cross-tenant platform (§9) test matrices.
- It provides the contract-specific isolation/RBAC matrix (§10) and per-contract test plans for C-01..C-09 (§11–§19).
- It defines Wave 3 deferral notes (§20), empty/denied-state rules (§21), redacted evidence requirements (§22), test data strategy (§23), future test categories (§24), and stop conditions (§25).
- It preserves the M2.1 two-authority-plane assumptions, the M3 already-redacted DTO envelope and empty-state assumptions, and the M4 redaction/evidence rules.
- It claims **no** test implementation in code, **no** live readiness, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, or fixture change was made; nothing was staged, committed, pushed, or backed up.

## 27. Recommended Next Milestone

**Phase 2.0 M6 — Firebase vs Supabase Auth / Session Parity Review** — *after* M5 is committed and backed up. Do not start M6 here.
