# Phase 1.4 — Milestone 2: Durable Data-Shape & Domain Model Documentation

> **Status:** **Documentation / architecture only.** This milestone maps the current mock/in-memory/browser-storage system into a future PostgreSQL-ready, tenant-scoped, store-scoped, audit-aware **conceptual** domain model. **It is NOT a database implementation, NOT a migration, NOT a schema.** No runtime, source, UI, Firebase, Firestore-rules, schema, SQL, ORM, or dependency changes were made. All TypeScript-like and SQL-like fragments below are **documentation examples only**, embedded in Markdown; **nothing is wired into the app.**
>
> **Reversible** (delete the two M2 docs + revert the minimal `replit.md` status line). **Accepted / committed / backed up** at GitHub checkpoint `2b9d8b868899eef93fd3311f74cd03dd374b567d`; Phase 1.4 is consolidated and closed out in [M6](phase-1.4-milestone-6-backend-persistence-readiness-closeout.md).
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. Builds on [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) and [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md). Honors the ratified [production-database](phase-1.4-decision-record-production-database.md) (PostgreSQL) and [deployment-topology](phase-1.4-decision-record-deployment-topology.md) directions.
>
> **Compact companion:** [`phase-1.4-domain-model-index.md`](phase-1.4-domain-model-index.md) (quick-reference table).

---

## 1. Purpose and Scope

Produce a single authoritative map of **what durable data the production system will eventually need**, how each domain is persisted *today* (truthfully), and what each future durable record should look like to be **PostgreSQL-ready, provider-agnostic, tenant/store-scoped, and audit-aware** — without locking provider specifics and without implementing anything.

**Working assumptions (from the task brief):** PostgreSQL-first; Supabase default but provider-agnostic; Hostinger may host the static SPA, future server/API tier may need VPS/serverless/managed API; keep Firebase Auth for testing with a swappable design; **no card data in the app DB** (external processor); low data-loss tolerance for POS/invoice/inventory/audit; start small/medium but design IDs + audit correctly from day one.

**Out of scope:** SQL DDL, migration files, ORM models, runtime repositories, any wiring. Those are deferred to future, separately-accepted milestones.

---

## 2. Current-State Persistence Summary (verified)

Persistence classes (from M0 §6): **DUR** durable/server-written (none today) · **FS-RO** Firestore read-only · **LS** localStorage · **SS** sessionStorage (per-tab, ephemeral, advisory) · **MEM** in-memory React state (mock-seeded, lost on refresh) · **STATIC** code config · **FILE** dev-only server JSON file · **DERIVED** recomputed.

| Mechanism | What lives there today |
|---|---|
| **FS-RO** | `users/{uid}` role/name read (the only real backend data) |
| **Firebase Auth** | sign-in (Google popup + email/password only) |
| **LS** | `platform_settings_v1` (only durable-per-browser store) |
| **SS** | `audit_logs`, `platform_permissions_v1`, `platform_temporary_access_v1`, `platform_access_review_v1`, `platform_sensitive_action_reason_v1`, `audit_investigation_state_v1`, `tenant_domains_v1` (+ `tenant_dns_records_v1`, `tenant_domain_registrar_v1`, `tenant_domain_security_v1`), `plans_data`, `addons_data`, `tenant_overrides_data`, `features_data`, `commercial_invoices_data`, `sla_policy`, `sla_policy_audit_log`, SLA snapshots |
| **MEM** | All 35 tenant business domains in `StoreLocalState.tsx`; owner mock data (`owner/mockData.ts`); the mocked single tenant in `AccessContext` |
| **STATIC** | platform/tenant role definitions + permission engine (`accessConfig.ts`, `platformPermissionsConfig.ts`) |
| **FILE** | `data/webhook-audit-log.json` (dev-only shipping server) |
| **server MEM** | shipping provider credentials (`Map`, lost on restart) |

**Verified live tenant in-memory domains (35, `StoreLocalState`):** customers, stockItems, heldOrders, suggestiveSalesItems, draftCart, completedOrders, refundRecords, warrantyClaims, posOperator, repairTickets, warrantyRepairTickets, pendingReplacements, invoices, services, serviceCategories, loyaltyConfig, loyaltyAdjustments, documentTemplates, storeBranding, suppliers, stockMovements, purchaseOrders, goodsReceivedNotes, rmas, inventoryTransfers, inventoryCounts, tradeIns, refurbishmentJobs, supplierRefundEntries, shipments, shippingProviderConfig, automationRules, automationLogs, shipmentBatches, returns.

**Verified critical gap:** `src/types.ts` defines **118 business types** but **no `tenant_id` / `store_id` field exists on any of them** (only one optional `storeLocationId?` on `CustomerAsset`). Today the system is single-tenant-by-mock; tenant/store scope lives only in the mocked `AccessContext`. **Every future durable record will need scope columns added** — this is the single largest data-shape change ahead.

---

## 3. Domain Inventory

Truthful inventory. "Present?" = does the domain exist in code today (even if mock). See §4–§6 for persistence/scope and the [index](phase-1.4-domain-model-index.md) for the compact grid.

**Platform-scoped:** platform users · platform roles · platform permissions/Global Matrix · platform team governance · temporary access/PIM (advisory) · access reviews (advisory) · sensitive-action reason capture (advisory) · Command Center governance signals (derived) · Audit Investigation lens/events (advisory overlay) · platform settings · tenant provisioning · tenant web address/domains · commercial plans/feature flags/plan gating · commercial invoices/overrides · support queue/escalation/SLA/macros · provider/platform integration config.

**Tenant/store-scoped:** tenants · stores/locations · tenant users/employees · tenant roles · Store Permissions Matrix · customers · customer assets/devices · POS carts/held/completed orders & sales · invoices · payments (refs only) · refunds · repairs (tickets) · repair notes/diagnostics/timeline/attachment-metadata · services/categories · inventory items · stock levels · stock movements/adjustments/counts · trade-ins/refurbishment · purchase orders/GRN (supply chain) · inventory transfers · warranty claims · returns/RMAs · shipments · shipment packages · labels/tracking events · carrier/provider rates · provider configuration · pickup requests · service points · carrier analytics/scorecards · automation rules/logs · loyalty config/adjustments · document templates · store branding/settings · marketing/prospects.

**Cross-cutting:** audit events · employee activity logs · webhook/provider event records · files/attachment metadata · external provider references · idempotency/sync keys (partial) · notifications/alerts (**not present — placeholder**) · data import/export (**not present — placeholder**) · schema/version metadata (**not present — placeholder**, though some SS keys are `_v1`-suffixed).

**Truthful "not present / placeholder only":** notifications/alerts system; data import/export; schema-version metadata; durable audit store; real payments. These are named for future completeness, not implied to exist.

---

## 4. Persistence Classification

| Class | Domains (summary) | Durable today? |
|---|---|---|
| **FS read-only** | platform user identity/role (`users/{uid}`) | partial (single doc) |
| **localStorage** | platform settings | per-browser only |
| **sessionStorage (advisory)** | audit logs, permission overrides, all Phase 1.3 governance (PIM/review/reason/investigation), domains+DNS/registrar/security, commercial (plans/addons/overrides/features/invoices), SLA policy/audit/snapshots | **no** |
| **in-memory (mock)** | all 35 tenant business domains, owner mock data, mocked tenant | **no** |
| **static config** | platform/tenant roles, permission engine | n/a (code) |
| **dev server file / MEM** | webhook audit log; shipping provider credentials | dev-only |
| **derived** | Command Center signals, carrier analytics, reports | n/a (recomputed) |

**Rule carried from M0 §6:** sessionStorage/localStorage/in-memory records are **advisory/mock**, never "durable/server-written," and must not be presented as backend or compliance evidence.

---

## 5. Tenant / Store / Platform Scope Map

For each future durable record, scope determines isolation columns + future RLS policy.

| Scope | Meaning | Mandatory future columns | Example domains |
|---|---|---|---|
| **platform-scoped** | belongs to the platform operator, not a tenant | `id`; `actor_user_id` on writes | platform users, platform roles, Global Matrix overrides, platform settings, plans/feature catalog, governance/PIM/review/audit-investigation, provisioning, domains registry |
| **tenant-scoped** | belongs to one tenant | `tenant_id` (**required**) | tenants(self), employees, tenant roles, customers, invoices, repairs, supply chain, returns, automation, loyalty, branding |
| **store-scoped** | belongs to one store/location within a tenant | `tenant_id` + `store_id` (**required**) | stock levels, stock movements, POS sales/registers/shifts, transfers (per-store legs), service points, pickups |
| **cross-scope** | spans tenant↔store or platform↔tenant | both keys as applicable | shipments (tenant + store origin), provisioning (platform write → tenant), commercial overrides (platform → tenant) |

**Key isolation facts:**
- **Tenant isolation** ⇒ `tenant_id` mandatory on **every** tenant/store record (absent today — must be added).
- **Store isolation** ⇒ `store_id` mandatory wherever inventory/POS/cash/movement granularity is per-location. Today stores are single/implicit; multi-store needs `store_id` introduced deliberately.
- **Platform vs tenant separation** is already clean in the permission model (disjoint role sets) and must stay clean in data: platform records never carry `tenant_id` as an owner key; tenant records never store platform-owner identity as their owner.

---

## 6. Future Durable Records Map

Representative per-domain rows (`scope` · `current persistence` · `future PG group` · `key IDs` · `relationships` · `audit` · `migration difficulty` · `enforcement sensitivity`). Difficulty/sensitivity carried from M0 §5/§8. Full set in the [index](phase-1.4-domain-model-index.md).

### 6.1 Platform-scoped

| Domain | Current | Future PG group | Key IDs | Relationships | Audit | Difficulty | Sensitivity |
|---|---|---|---|---|---|---|---|
| Platform users | FS-RO + Auth | `platform_identity` | `internal_user_id`, `auth_provider_uid` | → roles | yes (login/role) | Medium | High |
| Platform roles | STATIC | `platform_rbac` | `role_id` | → permissions | yes | Easy | High |
| Global Permissions Matrix overrides | SS | `platform_rbac` | `role_id`,`feature_key`,`sub_key` | → roles | **yes (server-written later)** | Medium | **Critical** |
| Platform team governance meta | STATIC+advisory | `platform_governance` | `role_id` | → roles | advisory→durable | Medium | High |
| Temporary access / PIM | SS (advisory) | `platform_governance` | `grant_id`,`subject_user_id` | → users/roles | **append-only candidate** | Medium | High |
| Access reviews | SS (advisory) | `platform_governance` | `review_id` | → users/roles | append-only candidate | Medium | Medium |
| Sensitive-action reason capture | SS (advisory) | `platform_governance` | `capture_id`,`action_ref` | → audit | append-only candidate | Medium | High |
| Command Center signals | DERIVED | (derived view) | — | reads many | n/a | Easy | Low |
| Audit Investigation overlay | SS (advisory) | `platform_audit` | `event_id`,`note_id` | → audit events | append-only candidate | Medium | High |
| Platform settings | LS | `platform_config` | `setting_key` | — | yes | Medium | High |
| Tenant provisioning | MEM | `platform_tenancy` | `tenant_id` | → tenants | yes | Medium | High |
| Tenant web address / domains | SS | `platform_tenancy` | `domain_id`,`tenant_id` | → tenants | yes | Medium | Medium |
| Plans / feature flags / gating | SS | `commercial` | `plan_id`,`feature_id` | → tenants(overrides) | yes | Medium | High |
| Commercial invoices / overrides | SS | `commercial` | `invoice_id`,`override_id`,`tenant_id` | → tenants/plans | yes | Hard | High |
| Support queue / escalation / SLA / macros | MEM+SS | `support_ops` | `case_id`,`policy_id` | → tenants/users | yes | Hard | Medium |
| Provider/platform integration config | MEM | `platform_config` | `integration_id` | — | yes | Medium | High |

### 6.2 Tenant/store-scoped

| Domain | Current | Future PG group | Key IDs | Relationships | Audit | Difficulty | Sensitivity |
|---|---|---|---|---|---|---|---|
| Tenants | MEM (mocked) | `tenancy` | `tenant_id` | root | yes | **Not ready** (design) | High |
| Stores / locations | MEM | `tenancy` | `store_id`,`tenant_id` | → tenant | yes | Not ready (design) | High |
| Employees (tenant users) | MEM | `tenant_identity` | `employee_id`,`tenant_id` | → tenant/roles; ↔ internal_user_id? | yes | Hard | High |
| Tenant roles / Store Matrix | STATIC+MEM | `tenant_rbac` | `role_id`,`tenant_id` | → permissions | yes | Medium | High |
| Customers | MEM | `crm` | `customer_id`,`tenant_id` | → invoices/repairs | yes | Hard | High (PII) |
| Customer assets/devices | MEM | `crm` | `asset_id`,`customer_id` | → customer/repairs | maybe | Medium | Medium |
| POS sales / held / completed orders | MEM | `pos` | `order_id`,`tenant_id`,`store_id` | → customer/items/payments | **yes (financial)** | **Very Hard** | **Critical** |
| Invoices | MEM | `billing` | `invoice_id`,`tenant_id`,`store_id` | → customer/lines/payments | **yes (financial)** | **Very Hard** | **Critical** |
| Payments (refs only) | MEM | `billing` | `payment_id`,`external_ref`,`invoice_id` | → invoice/order | **yes** | Very Hard | **Critical** (no card data) |
| Refunds | MEM | `billing` | `refund_id`,`payment_id` | → payment/invoice | **yes** | Very Hard | Critical |
| Repairs (tickets) | MEM | `repairs` | `ticket_id`,`tenant_id`,`store_id` | → customer/asset/parts/tech | yes | Hard | High |
| Repair notes/timeline/attachment-meta | MEM | `repairs` | `comment_id`,`history_id`,`attachment_id` | → ticket | **append-only candidate** | Hard | Medium |
| Services / categories | MEM | `catalog` | `service_id`,`tenant_id` | → repairs/invoices | yes | Medium | Low |
| Inventory items | MEM | `inventory` | `item_id`,`tenant_id` | → movements/POs | yes | Very Hard | High |
| Stock levels | MEM | `inventory` | `item_id`,`store_id` | → item/store | yes | Very Hard | High |
| Stock movements/adjustments/counts | MEM | `inventory` | `movement_id`,`item_id`,`store_id` | → item/store/actor | **append-only candidate (ledger)** | Very Hard | High |
| Trade-ins / refurbishment | MEM | `inventory` | `tradein_id`,`job_id` | → item/customer | yes | Hard | Medium |
| Purchase orders / GRN (supply chain) | MEM | `supply_chain` | `po_id`,`grn_id`,`supplier_id` | → supplier/items | yes (financial) | Hard | High |
| Suppliers / supplier refunds | MEM | `supply_chain` | `supplier_id`,`refund_id` | → POs | yes | Medium | Medium |
| Inventory transfers | MEM | `inventory` | `transfer_id`,`from_store`,`to_store` | → items/stores | yes | Hard | High |
| Warranty claims | MEM | `repairs`/`billing` | `claim_id` | → invoice/repair/customer | yes | Medium | Medium |
| Returns / RMAs | MEM | `returns` | `return_id`,`rma_id` | → invoice/repair/shipment | yes | Hard | Medium |
| Shipments | MEM (+dev file) | `shipping` | `shipment_id`,`tenant_id`,`store_id` | → source doc/packages/labels | yes | Medium | Medium |
| Shipment packages | MEM | `shipping` | `package_id`,`shipment_id` | → shipment | maybe | Medium | Low |
| Labels / tracking events | MEM (+dev file) | `shipping` | `label_id`,`event_id`,`external_ref` | → shipment/provider | **append-only candidate** | Medium | Medium |
| Carrier/provider rates | MEM/ephemeral | (cache) | `rate_id` | → shipment/provider | no | Easy | Low |
| Provider configuration / credentials | server MEM | `shipping_config` | `provider_id` | — | yes | Medium | **High (secrets)** |
| Pickup requests | MEM | `shipping` | `pickup_id` | → provider/shipments | yes | Medium | Low |
| Service points | MEM | `shipping` | `service_point_id` | → carrier | no | Medium | Low |
| Carrier analytics / scorecards | DERIVED | (derived view) | — | reads shipments | n/a | Easy | Low |
| Automation rules / logs | MEM | `automation` | `rule_id`,`log_id` | → shipments/events | logs append-only | Hard | Medium |
| Loyalty config / adjustments | MEM | `crm` | `config`,`adjustment_id` | → customer | yes | Medium | Low |
| Document templates / branding / store settings | MEM | `tenant_config` | `template_id`,`store_id` | → tenant/store | yes | Medium | Low |
| Marketing / prospects | MEM | `crm` | `prospect_id` | → customer | maybe | Medium | Medium (PII) |

### 6.3 Cross-cutting

| Domain | Current | Future PG group | Key IDs | Audit | Notes |
|---|---|---|---|---|---|
| Audit events | SS (advisory) | `audit` | `event_id`,`actor_user_id`,`tenant_id?` | **append-only, server-written** | the durable evidence store (none today) |
| Employee activity logs | MEM | `audit`/`tenant_ops` | `log_id`,`employee_id` | append-only | tenant-scoped |
| Webhook/provider events | dev FILE/MEM | `integration_events` | `event_id`,`external_ref`,`idempotency_key` | append-only | needs idempotency |
| Files / attachment metadata | MEM | `files` | `file_id`,`owner_ref` | — | **metadata only**; blobs in object storage, not DB |
| External provider references | embedded | (columns) | `external_provider`,`external_reference` | — | on payments/shipping/integrations |
| Idempotency / sync keys | partial (dev) | (columns/table) | `idempotency_key`,`sync_status` | — | required for payments/shipping/webhooks |
| Notifications / alerts | **not present** | `notifications` (future) | — | — | placeholder |
| Data import/export | **not present** | (future) | — | — | placeholder |
| Schema/version metadata | **not present** | `schema_meta` (future) | — | — | placeholder |

---

## 7. Suggested PostgreSQL-Ready Entity Groups (conceptual)

Candidate logical groupings (future schemas/modules — **not tables, not DDL**):

- **platform_identity / platform_rbac / platform_governance / platform_audit / platform_config / platform_tenancy** — platform operator surface.
- **commercial** — plans, feature flags, entitlements, overrides, commercial invoices.
- **support_ops** — cases, escalation, SLA, macros.
- **tenancy** — tenants, stores/locations.
- **tenant_identity / tenant_rbac** — employees, tenant roles, store permission matrix.
- **crm** — customers, assets, loyalty, prospects.
- **catalog** — services, service categories, product catalog definitions.
- **inventory** — items, stock levels, movements (ledger), counts, transfers, trade-ins/refurb.
- **pos** — carts/held/completed orders, sales, registers, shifts.
- **billing** — invoices, payments (refs), refunds, warranty financials.
- **repairs** — tickets, line items, notes/timeline, attachment metadata.
- **supply_chain** — suppliers, POs, GRN, supplier refunds.
- **returns** — returns, RMAs, dispositions.
- **shipping / shipping_config** — shipments, packages, labels, tracking events, pickups, service points, provider config (secrets handled separately).
- **automation** — rules + append-only logs.
- **audit / integration_events / files / schema_meta** — cross-cutting.

```sql
-- CONCEPTUAL EXAMPLE ONLY — not a schema, not a migration, not provider-specific.
-- Illustrates the mandatory scope + audit columns every tenant record should carry.
-- DO NOT create this as a file.
-- table: invoices (group: billing)
--   id                text/uuid  PK   (stable, internal)
--   tenant_id         text/uuid  NOT NULL          -- tenant isolation (RLS key)
--   store_id          text/uuid  NULL/NOT NULL     -- store isolation where applicable
--   customer_id       text/uuid  FK -> crm.customers
--   status            enum       -- documented consistently
--   amount_total      numeric    -- money as numeric, never float
--   currency          text
--   external_ref      text       -- processor/order ref where applicable
--   created_at        timestamptz NOT NULL
--   updated_at        timestamptz NOT NULL
--   created_by        text/uuid  -- actor_user_id
--   -- card data: NONE (handled by external processor)
```

---

## 8. Relationship Map (conceptual / candidate relations)

Informal foreign keys already exist in the mock types (e.g. `customerId`, `employeeId`, `invoiceId`, `ticketId`, `supplierId`, `shipmentId`) — good raw material for normalization. Candidate relations:

- `tenant 1—* store`; `tenant 1—* employee`; `tenant 1—* customer`.
- `customer 1—* invoice`; `customer 1—* repair_ticket`; `customer 1—* asset`.
- `invoice 1—* invoice_line`; `invoice 1—* payment`; `payment 1—* refund`.
- `repair_ticket 1—* service_line`, `1—* comment`, `1—* history`, `1—* attachment_meta`.
- `inventory_item 1—* stock_movement` (ledger); `item *—* store` via `stock_level`.
- `purchase_order 1—* po_item`; `po 1—* grn`; `supplier 1—* po`.
- `shipment 1—* package`; `shipment 1—* tracking_event`; `shipment 1—1 label`; `shipment *—1 source_doc (invoice|repair|transfer|rma)`.
- `return *—1 source_doc`; `rma 1—* rma_item`.
- platform: `role 1—* permission_override`; `tenant 1—* commercial_override`; `tenant 1—* domain`.

**Nested mock structures needing normalization later:** invoice/order line-item arrays → child tables; repair ticket embedded comments/history/attachments → child tables; shipment embedded packages/events → child tables; permission overrides nested maps → row-per-(role,key); domain embedded DNS/registrar/security sub-objects → child tables/columns.

---

## 9. Identity and Stable ID Strategy (reinforces M1)

**Core rule:** the app's user identity is an **`internal_user_id`** that is *independent* of any auth provider.

```ts
// DOCUMENTATION EXAMPLE ONLY — not runtime, not wired.
// platform_identity.users (conceptual)
//   internal_user_id   PK  (stable forever; the app's identity)
//   auth_provider      enum('firebase','supabase',...)   -- external ref
//   auth_provider_uid  text                               -- Firebase uid today
//   email              text                               -- natural re-map key on swap
//   created_at, updated_at
```

- **Why not use the Firebase UID as the primary key:** it couples every FK to one auth vendor; replacing Firebase Auth (or adding Supabase Auth) would orphan or rewrite every reference. An internal id makes the auth swap a single-table re-mapping (by `email`, which is the only auth data we use — Google popup + email/password, verified).
- **Auth swap portability:** Firebase Auth today → Supabase Auth (if Supabase chosen) → or keep Firebase Auth verified server-side with Postgres (Neon/Railway path). Only the `auth_provider`/`auth_provider_uid` columns + the auth adapter change.
- **Platform users vs tenant employees — open linkage question:** today platform users are Firebase `users/{uid}`; tenant employees are local `Employee` records with their own `id`, `roleId`, `pin`, `email`. **Open question:** should a tenant employee map to an `internal_user_id` in the same identity table (one identity, multiple memberships) or remain a tenant-local record with optional linkage? Recommended future direction: **one `internal_user_id` identity table + membership rows** (`platform_membership`, `tenant_membership`) so a person can hold platform and/or tenant roles without mixing scopes — but this is a **design decision to ratify in a future milestone**, not implemented here.

---

## 10. Audit / History / Event Model Requirements (truthfulness-bound)

**Truthful current state:** the `audit_logs` store is **sessionStorage, client-written, per-tab, advisory** — **not** durable backend evidence. Phase 1.3 governance records (PIM/review/reason/investigation) are likewise **advisory**, not compliance evidence. **No compliance-evidence automation exists.**

**Future durable audit (server-written) — required fields per row:**

```ts
// DOCUMENTATION EXAMPLE ONLY.
// audit.events (append-only, server-written)
//   event_id            PK
//   at                  timestamptz
//   actor_user_id       internal id of the actor
//   actor_scope         platform | tenant | store | system
//   tenant_id, store_id  (nullable by scope)
//   action              string
//   target_ref          what was acted on
//   decision            allow | deny           -- when an enforcement decision
//   outcome             success | failure
//   reason              optional (sensitive-action capture)
//   source_surface      where it originated
//   correlation_id / idempotency_key   optional
```

- **Append-only candidates:** audit events, stock movements (ledger), repair timeline, tracking events, automation logs, governance/PIM history.
- **Only a server-written store may be labeled “durable / server-written”** (M0 §6). Until then every audit/governance surface stays labeled advisory.

---

## 11. Financial and Inventory Integrity Requirements

- **Transactional integrity (ACID) required for:** POS sales (cart→order→payment→stock decrement as one transaction), invoices + line items + payments + refunds, inventory movements (ledger must never partially apply), purchase-order receipt (GRN updates stock).
- **Money:** store as `numeric`, never floating point; always with `currency`.
- **Inventory as an append-only ledger:** stock levels are *derived* from movements; movements are immutable once written (corrections are new compensating rows).
- **No double-application:** external-facing financial/shipping actions need **idempotency keys**.
- **This is the strongest argument for PostgreSQL over Firestore** (joins, constraints, transactions) and for **low-RPO backups** before production.

---

## 12. Sensitive Data / Security Classification

| Sensitivity | Domains | Future enforcement note |
|---|---|---|
| **Critical** | Global Permissions Matrix writes, platform role changes, payments/refunds, POS/invoices, provider secrets | server-enforced + RLS + append-only audit; System-Owner-protected |
| **High (PII/financial)** | customers (PII), employees (PII/pin), inventory valuation, supply-chain costs, platform settings, domains, commercial overrides, governance/PIM | server-enforced + tenant RLS |
| **Medium** | repairs, returns/RMAs, shipments, marketing/prospects (PII), access reviews | tenant RLS; audited |
| **Low** | services catalog, branding, templates, carrier rates/analytics, derived reports | standard tenant scoping |

- **PII:** customers, prospects, employees → encryption-at-rest (managed Postgres default) + access controls; consider field-level care for employee `pin` (should become a hashed credential, never plaintext, in any durable design).
- **Secrets:** shipping provider credentials must move to a real secret store, not a DB column in plaintext.
- **Card data:** **never stored** (see §13).

---

## 13. Payments / PCI Boundary

- **No card data in the app database — ever.** Card capture/processing stays with an external processor (Stripe-like).
- **Future `payments` records store only:** `external_provider`, `external_reference` (processor token/charge id), `status`, `amount`, `currency`, `created_at`, relationships to `invoice_id`/`order_id`, and an audit trail. **No PAN, CVV, or full card data.**
- **PCI scope** stays with the processor; the app remains out of cardholder-data scope by design.
- **Future payment integration is a separately-scoped milestone** before production; not designed here beyond this boundary.

---

## 14. Migration Readiness Notes

**Favorable (keep true):** string IDs → portable to text/UUID PKs; ISO timestamps; string-literal enums; informal FKs already present; no Firestore-specific queries; no realtime/offline; Storage unused. This remains a **first-time backend build**, not a data migration — low data-loss risk, high design leverage.

**Work required later (not now):** add `tenant_id`/`store_id` to every tenant/store record; normalize nested arrays/sub-objects into child tables; convert money to `numeric`; introduce `internal_user_id` + membership model; stand up the durable append-only audit store; add idempotency keys; design RLS policies keyed on `tenant_id`.

**Risk if delayed:** the favorable posture is a **wasting asset** — any new feature that writes mock/Firestore data without scope fields raises later cost.

---

## 15. Domains to Persist First (later, when implementation is approved)

Recommended first durable slice (highest value / clearest contract / unblocks enforcement):
1. **`platform_identity` (`internal_user_id` + auth refs)** — foundation for everything.
2. **`tenancy` (tenants, stores)** — the missing backbone; unblocks tenant scoping.
3. **`platform_rbac` (roles + Global Matrix overrides, durable)** — enables the first server-enforced action (M0 §8 candidate #1) + durable audit.
4. **`audit` (append-only, server-written)** — pairs with #3.

These four make the first *real* server-side enforcement possible without touching tenant business data.

## 16. Domains to Defer (later)

- All tenant **business** domains (POS, invoices, inventory, repairs, customers, supply chain, returns, shipping) — defer until the backbone (#1–#4) + a ratified provider/topology exist; very-hard/transactional.
- **Payments** — separate PCI-scoped milestone.
- **Notifications/alerts, import/export, schema-version tooling** — not present; build when needed.
- **Derived domains** (Command Center signals, carrier analytics, reports) — stay derived; never primary persistence.

---

## 17. Risks / Open Questions

1. **Employee↔platform identity linkage** (§9) — one identity + memberships, or separate? (design decision)
2. **Multi-store timing** — introduce `store_id` now in the model even if single-store today (recommended) vs later.
3. **Provider/auth still provisional** — Supabase vs Neon/Railway/VPS; keep vs replace Firebase Auth (M1 criteria).
4. **Secret management** for provider credentials — not a DB concern; needs its own decision.
5. **Money/locale** — single vs multi-currency assumptions.
6. **Attachment storage** — object storage (Supabase Storage / S3-like) vs elsewhere; DB holds metadata only.
7. **RPO/RTO targets** — must be set before production (low tolerance assumed).
8. **Idempotency strategy** — per-domain keys for payments/shipping/webhooks.

## 18. Non-Implementation Statement

This milestone implemented **nothing**. No schema, SQL, migration, ORM, repository, wiring, Firebase change, Supabase code, dependency, or runtime/UI/source behavior. All fragments are documentation examples. The conceptual model is **provider-agnostic** and **PostgreSQL-ready** without locking provider specifics.

## 19. Validation / QA Summary

See the M2 report. Expected: only Markdown changed; no `.ts`/`.tsx`/`.sql`/schema/runtime/config files; no wiring; `tsc` baseline unchanged (no code touched).
