# 05 — Canonical Data Ownership & API / Database Contracts

**Scope:** per-domain canonical data ownership, the production API/error contract, and the database & multi-tenant contract. Design-only. Existing durable schema is identity/authz/audit only; business tables are introduced per-domain in M7 ([06](./06-module-migration-map-m7.md)).

## 1. Existing durable schema (the canonical seed)

8 tables (`server/platform-identity/migrations/001–004`), **identity/authz/audit only**:

| Table | Role | Key constraints |
|---|---|---|
| `platform_identity` | app-owned identity | PK `internal_user_id`; UNIQUE `(auth_provider, auth_provider_uid)`; `email` deliberately NOT unique |
| `app_user` | account (1:1) | PK+FK → identity CASCADE; `status` CHECK (6 values); `idx_app_user_status` |
| `tenant` | tenant | PK; `plan_key` CHECK (starter/growth/advanced); `status` CHECK |
| `store` | store (child) | PK; FK → tenant CASCADE; `idx_store_tenant_id` |
| `user_membership` | grant (user×scope×role) | FKs → app_user/tenant/store; `scope_type` CHECK; `role_scope`/`scope_consistency` CHECKs; UNIQUE NULLS NOT DISTINCT grant key |
| `tenant_feature_entitlement` | entitlement | FK → tenant; UNIQUE `(tenant_id, feature_key)`; `source` CHECK (plan/default/manual); **no rows seeded** |
| `audit_event` | durable audit | PK; **no FKs (by design)**; rich CHECKs; forbidden-key guard; append-only trigger |
| `identity_link` | Firebase↔Supabase link | composite FKs; partial UNIQUE WHERE active; **unwired** |

- **`audit_event` is append-only**: `reject_audit_event_mutation()` + `trg_audit_event_reject_mutation` (BEFORE UPDATE OR DELETE) raise `restrict_violation` for **all roles including the table owner**. Metadata is guarded (`audit_metadata_is_flat`, forbidden-key list: access/refresh tokens, raw JWT/JWKS, service-role key, DB URL, connection string, password, PAN, card number, provider secret). **Forward-hardening (M6/M7b):** when payments land, extend this guard + log/error redaction to **CVV/CVC, track1/2, and PIN block** so the enforced key-list matches the documented no-CHD boundary (§5), and make the [07](./07-quality-and-test-strategy.md) "no PAN/CVV/track/PIN" assertion check that guard. `evidence_level` ∈ `dev_sidecar_log_advisory | durable_compliance_event`.
- **RLS enabled on all 8 tables, zero policies**; 7/8 `REVOKE ALL … FROM public/anon/authenticated`. Effect: PostgREST/anon/authenticated get deny-all; the owner-role connection bypasses RLS and is the only path (GAP-17: an app role that does not bypass RLS is an M3 target).

## 2. Canonical data ownership per business domain (introduced in M7)

For each domain: canonical tables, aggregate root, tenant/store ownership, lifecycle, and the migration source (all currently in-memory mock — [01](./01-current-state-inventory-and-gap-matrix.md)).

| Domain | Aggregate root | Canonical entities | Owner scope | Lifecycle / status | Migration source (mock) |
|---|---|---|---|---|---|
| Customers | `customer` | customer, loyalty_account | tenant (store-visible) | active/archived | `StoreLocalState.customers` |
| Prospects | `prospect` | prospect | tenant | new/qualified/converted/lost | `Prospects` (mock) |
| Employees/Team | `employee` | employee, employee_role_assignment | tenant/store | invited/active/suspended | `Employees` + `AccessContext` roles |
| POS/Sales | `order` | order, order_line, payment, refund | store | draft/held/completed/refunded | `POS.completedOrders/heldOrders/refundRecords` |
| Invoices | `invoice` | invoice, invoice_line | store | open/paid/void/reopened | `Invoices.invoices` |
| Payments | `payment` | payment, payment_event, payment_method_token, terminal_device, dispute, **payment_provider_connection, payment_webhook_registration, payment_provider_health, payment_provider_event** | store | initiated→authorized→captured→settled / voided / refunded / disputed / failed | (embedded in POS/Invoices mock) — **DECIDED integrated capability (G-PCI): cash + external-terminal + semi-integrated card-present + hosted/tokenized CNP; TM POS2026 stores only opaque tokens — never PAN/CVV/track/PIN/unencrypted CHD**; **gateway connection is STORE-owned** (per §5.1) |
| Inventory | `inventory_item` | inventory_item, stock_movement, transfer, count, trade_in | store | in-stock/adjusted | `Inventory.stockItems/movements` |
| Supply Chain | `purchase_order` | supplier, purchase_order, grn, rma | tenant/store | draft/sent/received | `SupplyChain.suppliers/purchaseOrders/grns` |
| Repairs | `repair_ticket` | repair_ticket, repair_event | store | intake→diagnose→repair→done | `RepairTickets.repairTickets` |
| Services | `service` | service, service_category | tenant | active/archived | `Services.services` |
| Warranty | `warranty_claim` | warranty_claim, claim_event | store | open→resolved | `WarrantyManagement.warrantyClaims` |
| Returns | `return` | return, rma, return_shipment | store | requested→received→inspected→disposed | `ReturnsPortal.returns/rmas` |
| Shipping | `shipment` | shipment, tracking_event, pickup, provider_config, sla_policy | store | created→packed→dispatched→delivered | `ShippingCenter.shipments` + `utils/sla` (ss) |
| Billing | `billing_invoice` | subscription, billing_invoice, credit_note, transaction | tenant | trialing/active/overdue/suspended | `owner/mockData` + `commercialInvoices` (ss) |
| Plans/Features/Add-ons | `plan` | plan, feature_catalog, add_on, feature_entitlement | platform→tenant | draft/active/archived | `PlansPage` (`plans_data`/`features_data`/`addons_data` ss) |
| Platform Settings | `platform_setting` | platform_setting | platform | — | `PlatformSettingsPage` (ss) |
| Domains | `tenant_domain` | tenant_domain, dns_record | tenant | pending→verified→active | `DomainsPage` (`tenant_domains_v1` ss) |
| Integrations | `integration` | integration, integration_credential | tenant | connected/disconnected | `Integrations` (mock) |
| Widgets | `widget` | widget, widget_config | tenant | enabled/disabled | `Widgets` (mock) |
| Support | `support_case` | support_case, escalation, macro, note | platform | open→resolved | `SupportTools` (`support_cases_v1` ss) |
| Audit/Security | `audit_event` (exists) + `security_note` | security_note | platform | — | `AuditSecurity` (`audit_logs` ss, forgeable) |

**Per-domain contract (applies to each):** aggregate root + FK boundaries within the tenant/store subtree; explicit lifecycle/status model; separate read API and write API; a transaction boundary per mutation; optimistic-concurrency version field; idempotency requirement for externally-triggered/retryable writes; audit requirement (append-only `audit_event`); event/outbox where cross-domain or provider effects occur; retention/deletion rule (soft-delete + purge policy); sensitive-data classification (PII in customers/employees; payment data in payments; provider credentials in payments/integrations/shipping — encrypted, never in audit metadata); external-provider relationship (shipping/integrations only, via egress boundary).

**All current UI-only models lack a durable backend** — every domain above is a migration target; none has a table today.

## 3. API & error contract (production standard)

| Aspect | Standard |
|---|---|
| Versioned paths | `/api/v1/...` (tenant), `/admin/v1/...` (Backend CP) |
| Request/response schemas | typed, validated at the boundary; reject unknown fields on writes |
| Pagination/filtering/sorting | cursor pagination; explicit allowlisted filter/sort fields |
| Concurrency | `version`/`updated_at` optimistic concurrency; conflicting write → 409 |
| Idempotency | `Idempotency-Key` header for retryable/mutating requests; durable key store |
| Correlation | server-generated `request_id`/`trace_id`; **no sensitive identifier** in correlation values |
| Error envelope | bounded `{ error: { code, message, correlationId } }`; **no stack traces, no raw DB/provider errors** |
| Auth errors | 401 (unauthenticated), sanitized |
| Authz errors | 403 (authenticated but not permitted), sanitized reason code |
| Validation | 422 with field-level codes (no echoed secrets) |
| Conflicts | 409 (version/idempotency conflict) |
| Rate limits | 429 + `Retry-After` |
| Unavailable/degraded | 503 with retry guidance; provider failure surfaces as a bounded upstream-unavailable code, never the raw provider error |

## 4. Database & multi-tenant contract

| Rule | Detail |
|---|---|
| Schema ownership | migrations own DDL; a migration runner applies them (M3) — no manual-only application (GAP-16) |
| Tenant/store keys | every business table carries `tenant_id` (and `store_id` where store-scoped), NOT NULL, FK into the tenant/store subtree |
| Required FKs | domain rows reference their aggregate root and tenant/store; cascade/restrict per lifecycle |
| Uniqueness | natural keys unique **within tenant** (e.g., invoice number per tenant/store) |
| Indexes | tenant/store + status + time indexes mirroring the `audit_event` pattern |
| Immutable identifiers | UUID PKs; never reuse |
| Soft-delete/suspension | soft-delete + status; hard purge is a governed retention job |
| Append-only audit | `audit_event` remains immutable (trigger already enforces for all roles) |
| Outbox/events | transactional outbox table per bounded context for async/provider effects |
| RLS strategy | enable RLS with **tenant/store-scoped policies**; the API connects as a **scoped app role** (not owner) so RLS is enforced; privileged migration/admin uses a separate role |
| Server-side scope enforcement | scope derived from the session/membership; **client-provided `tenantId`/`storeId` is request context only and never independently establishes authority** |
| Connection-role separation | app role (RLS-bound) vs migration/owner role (privileged) |
| Migration discipline | forward + rollback (`up`/`down` already the convention); reviewed; applied by the runner |
| Seed/bootstrap separation | bootstrap seeds are DEV-only and separate from migrations |
| Backup/restore | scheduled backups + PITR; restore rehearsal (M8/M9) |
| Data validation/reconciliation | migration-time validation + post-migration reconciliation counts (M7/M9) |

## 5. Payment contract (G-PCI — DECIDED: integrated capability in scope)

TM POS2026 supports **cash**, **external-terminal/manual-reference**, **integrated card-present via a PCI-certified semi-integrated terminal/provider**, and **hosted/tokenized CNP** flows. Direction is **DECIDED**; the specific provider is selected in **M7b** by documented criteria (and must not become a hidden future milestone).

**Hard data boundary (never in TM POS2026 — not received, stored, persisted, logged, or exposed):** raw PAN, CVV/CVC, magnetic-stripe/track data, PIN/PIN block, unencrypted cardholder data, processor credentials in browser storage. Card data is collected only by **provider-hosted/provider-certified components**; TM POS2026 holds only **opaque payment-method tokens**.

| Aspect | Contract |
|---|---|
| Aggregate root | `payment` (per order/invoice), with `payment_event` (append-only state log), `payment_method_token` (opaque), `terminal_device`, `dispute` |
| Lifecycle | initiated → authorized → captured → settled; plus void, refund, dispute, failed — each an appended `payment_event` |
| Idempotency | `Idempotency-Key` on every payment mutation + **duplicate-charge prevention** (a retried authorize/capture never double-charges) |
| Webhooks | provider webhooks **signature-verified** at the egress boundary before processing; replay-safe |
| Reconciliation | periodic reconciliation of provider settlement vs local `payment` state; discrepancies flagged |
| Refunds / voids / disputes | modeled explicitly; refunds idempotent; disputes tracked to resolution |
| Credentials | processor credentials **encrypted at rest + rotated** (G-SECRETS); never in browser storage |
| Provider outage | defined degraded behavior (queue/deny with safe classification; never a silent success) |
| Terminal/device | `terminal_device` assignment scoped to **tenant/store**; a device cannot act outside its store |
| PCI validation | applicable PCI validation category (SAQ A / P2PE / other) **confirmed with the selected provider/acquirer or QSA before production** — **not claimed** until the final integration architecture establishes eligibility. As a multi-tenant orchestrator holding provider credentials, terminal assignments, and tokens, the platform's own **PCI service-provider scope (TPSP / Payment-Facilitator, responsibility matrix, per-tenant AoC)** is validated alongside the merchant category |
| Audit | every payment state transition writes a durable append-only `audit_event` |
| CHD containment (all surfaces) | **no raw PAN/CVV/track/PIN or processor secret in ANY operational, observability (logs/metrics/traces), evidence, export/BI, receipt, or support surface** — reconciliation, refunds, disputes, webhook payloads, receipts, and support tools handle only opaque tokens + masked/last-4; redaction enforced and tested (G-PCI evidence, [07](./07-quality-and-test-strategy.md)) |

### 5.1 Store-owned payment gateway connection model

**Ownership (OWNER CORRECTION):** payment-gateway connections are configured at the **STORE** level — by the **Store Owner**, or another active store user holding an **explicit canonical permission** to manage gateway connections ([04 §2.1](./04-canonical-iam-and-four-user-migration.md)). They are **not** supplied, configured, retrieved, or normally viewed by the System Owner. The store-facing location is **Store Settings → Payments / Payment Gateway** (not the System Owner Backend Control Plane). Cash and external-terminal methods remain available **independently** of any integrated gateway.

**Platform vs store split:** the **System Owner Backend CP governs the connector catalog and security policy** (which providers exist, availability by environment/region, minimum versions/security requirements, bounded connector health, global connector disablement during an incident, feature/plan eligibility, aggregate failure review, audited break-glass) — see the boundary in [03 §9](./03-backend-control-plane-login-session-blueprint.md). The **store owns its own merchant connection** (selection, authorization, activation, replacement, disconnection).

**Connection flow (store-initiated):**
```
platform connector catalog → store selects provider → canonical store-scoped permission check
  → recent-authentication / step-up → server-generated OAuth or provider-hosted onboarding
  → provider authorization → encrypted store-scoped connection reference
  → server-side connection validation → webhook registration + verification
  → terminal pairing (if applicable) → store makes connection active → durable audit
```
**OAuth / provider-hosted onboarding is preferred.** **No raw secret/API-key entry in the browser** when the provider offers a secure OAuth/onboarding flow.

**Credential handling (when a provider unavoidably requires a secret):** collect through a **dedicated protected server exchange**; never hold longer than necessary in React state; **never** in `localStorage`/`sessionStorage`; **never returned after acceptance**; **envelope-encrypted through the approved credential service** (§4 + M6); store **only a credential reference** in ordinary application tables; **redacted** from logs/traces/errors/audit/support/exports/backups; **rotation + revocation** supported. **OAuth access/refresh tokens are long-lived secrets and use this same envelope-encrypted / reference-only / rotation-revocation model.**

**OAuth callback binding (model invariant, not just a test):** the OAuth flow MUST use an unguessable **`state`** parameter (CSRF), **PKCE**, an **exact redirect-URI allowlist**, and a callback that **binds the returned provider account to the initiating store's authenticated session** — so authorization-code injection / connection-CSRF cannot link a victim store to an attacker's merchant account, and a returned account cannot be bound to any store other than the one that initiated the flow.

**Connector-catalog integrity (model invariant):** each connector's definition (OAuth URLs, API endpoints, **webhook hosts**) is **code-shipped, reviewed, and integrity-protected, subject to the provider egress allowlist ([ADR-07](./10-architecture-decision-records.md)) — NOT free-form admin-entered.** Any catalog mutation is a **step-up + reason + durable-audit** controlled action. (This closes the indirect path by which a compromised System Owner could repoint a connector at an attacker host and harvest every connecting store's credentials.)

### 5.2 Multi-store isolation & durable entities

Every connection is owned by exactly **(`tenant_id`, `store_id`, `provider_key`, `environment`)**. Conceptual durable entities (schemas NOT implemented in M1): `payment_provider_connection`, `payment_terminal`, `payment_webhook_registration`, `payment_provider_health`, `payment_provider_event`.

**Isolation invariants:** one store cannot query/use another store's connection; webhook events correlate to the correct provider account + tenant + store + environment; **sandbox credentials cannot process production payments**; production and test credentials are isolated; a terminal is assigned to one authorized store/environment (pairing relies on provider-attested device identity / P2PE-certified hardware; connection/credential-reference tables carry tenant/store RLS like other business tables — [03 §7](./03-backend-control-plane-login-session-blueprint.md), G-DBROLE); **credential references cannot be reassigned by client input**; **provider account identifiers are never accepted as authority**; the server derives tenant/store scope from the canonical session + authorization context; **a `provider_account_id` is uniquely and provider-verifiably bound to exactly one connection** (established via the OAuth callback binding above) so webhook correlation cannot be hijacked or made ambiguous by a second store claiming the same account id.

### 5.3 Active-provider & switching rules

**One active integrated provider per store/payment channel** for the initial design (multiple only if the architecture explicitly supports safe channel routing); cash/external-terminal remain independent. **Provider replacement must check** pending authorizations, unsettled transactions, refunds/disputes, active terminals, webhook backlog, and reconciliation status — **unsafe switching is blocked**. Old credentials are revoked or retained only for **bounded reconciliation/refund obligations**. Activation/disconnection is **idempotent and audited**; **no duplicate charge can result from failover or retries**. The replacement/disconnect safety checks read a **server-owned source of truth** for pending authorizations, unsettled funds, disputes, active terminals, webhook backlog, and reconciliation locks (never client-asserted). A **verified** webhook (dispute/chargeback/late refund) arriving **after** the bounded retention window is not silently dropped — it is captured and routed to the dispute/compliance path so no financial/compliance event is lost.

### 5.4 Initial connector catalog (M7b — Stripe / Square / Adyen)

The initial M7b connector catalog targets **three provider families** (initial supported options — not three simultaneously-required live integrations), subject to current official API/country/hardware verification during M7b:

| Provider | Connection model | Card-present | CNP |
|---|---|---|---|
| **Stripe** | Stripe Connect / platform connection | Stripe Terminal | hosted/tokenized where applicable |
| **Square** | OAuth merchant connection (Payments API) | Terminal/device APIs where supported | hosted where applicable |
| **Adyen** | platform/account-holder integration where applicable | in-person/terminal | enterprise/multi-region |

**M7b verification (each candidate):** supported merchant countries; supported transaction currencies; **Morocco/US and intended launch-market availability**; card-present hardware; OAuth/platform-account model; API maturity/versioning; webhook support; refunds/voids/disputes/reconciliation; sandbox/test capability; pricing/commercial onboarding; PCI scope; marketplace/platform restrictions; account portability; provider-outage behavior; support model. If a provider cannot support the launch market or the store-owned connection model, **M7b may replace it only via a documented ADR + owner approval — with no new milestone**.

## 6. Privacy & data-rights (DSAR) contract (G-PRIVACY — DECIDED: implement, not exclude)

A production privacy foundation is **in scope**, distributed across milestones (no new milestone). **No universal-compliance claim is made** — final policy and jurisdictional obligations require owner/legal review.

**Roles:** the **tenant is the data controller** for its store/customer/employee data; the **platform is the processor** (plus controller for platform-operator data). DSAR requests are authorized through tenant approval with platform escalation.

| Capability | Contract |
|---|---|
| Data inventory & classification | every domain table tags PII / sensitive-data class (customer/employee PII, tokens, etc.) — the classification is the discovery index |
| Request identity verification | a data-subject request verifies requester identity before any data is disclosed or erased |
| Authorization boundary | tenant approval + platform escalation ([04](./04-canonical-iam-and-four-user-migration.md)); a tenant cannot export/erase another tenant's data |
| Cross-domain discovery | a request fans out across all M7 domains holding the subject's data (customers, employees, orders, invoices, payments-tokens, repairs, returns, shipping, support) |
| Access / export | structured, machine-readable export of the subject's data (portability where applicable) |
| Correction | correct inaccurate PII with audit |
| Deletion / anonymization | delete or anonymize **where legally permitted**; where deletion is barred (legal hold, financial-record retention), record the restriction reason |
| Retention & legal hold | per-domain retention policy; legal hold suspends deletion; restriction where applicable |
| Lawful basis & consent | **per-purpose lawful-basis record** (GDPR Art 6) and, where consent is the basis, a **consent capture/withdrawal ledger** (Art 7 — withdrawal as easy as granting) backing the rights to object/restrict; notice linkage |
| Request intake & SLA | DSAR **intake channel**, statutory **SLA/deadline timers**, requester communications, and legal-hold **exemption** handling (workflow lands in M6) |
| Breach notification | **statutory breach-notification workflow** (GDPR Art 33/34 — 72-hour supervisory-authority + data-subject notice; US state breach laws): assessment record, regulator + subject notice, wired into G-INCIDENT; the G-HIST M8 investigation triggers this branch if actual PII/CHD exposure is found |
| Processor contracts & transfers | **Art 28 DPAs** with tenant-controllers, a **sub-processor register** (payment provider, shipping, integrations), and **cross-border transfer mechanisms** (SCCs / adequacy / transfer-impact assessment) — legal-sign-off evidence at M9 |
| Provider propagation | erasure/correction propagates to third parties/providers holding the data (payment tokens, shipping, integrations) |
| Deadline / status | each request tracks statutory deadline + status; overdue surfaced |
| Failure / partial completion | partial completion is explicit and audited — never reported as fully complete when a domain/provider failed |
| Backup limitations | backups and their deletion limitations are documented (erasure from live systems + a documented backup-expiry policy) |
| Immutable audit | every DSAR action writes a durable append-only `audit_event` |
| Jurisdiction boundary | documented jurisdiction/legal-review boundaries; owner/legal sign-off at M9 |

**Milestone distribution:** **M1** these contracts + processor-obligation framing; **M5** requester/tenant/platform authorization + identity verification; **M6** audit, request-intake/SLA-timer/consent-ledger **workflow**, event, and retention/legal-hold foundations; **M7a–M7h** domain-specific export/correction/deletion behavior; **M8** operational privacy workflow, monitoring, and **breach-notification/incident integration**; **M9** UAT, evidence, DPA/sub-processor-register/cross-border-transfer evidence, and policy/legal-owner sign-off. **No new milestone.**
