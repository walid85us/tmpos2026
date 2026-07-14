# 06 — Module Migration Map (M7a–M7h)

**Scope:** the vertical module migrations that move each business domain from in-memory mock state to durable, server-authoritative persistence. M7a–M7h are **subdivisions of M7**, not top-level milestones. Entry dependency for all of M7: **M3** (deployable runtime + migration runner + secrets), **M5** (canonical authorization is the source of truth), **M6** (durable audit, idempotency, outbox, transactions).

## 1. Migration pattern (identical for every module)

1. Define canonical tables + `tenant_id`/`store_id` scoping ([05](./05-canonical-data-ownership-and-api-db-contracts.md)).
2. Write forward+rollback migrations; apply via the runner.
3. Build read API + write API behind canonical authorization (deny-by-default, scope from membership).
4. Wrap mutations in transactions; add optimistic concurrency; add idempotency where retryable.
5. Emit append-only `audit_event`; emit outbox events for cross-domain/provider effects.
6. Replace the module's `SEED_*`/`sessionStorage` reads/writes with API calls; client keeps a read-only projection for rendering.
7. **Data cutover:** define explicit seed/backfill/import rules, ownership mapping, and post-cutover **reconciliation counts**; assert a **"no mock path remains"** check (the module reads/writes only the API — no residual `SEED_*`/`sessionStorage` authority).
8. Tests per [07](./07-quality-and-test-strategy.md): unit + authz-matrix + repository + API-contract + tenant-isolation + failure/rollback/idempotency.

**Each M7 sub-slice is independently releasable with its own rollback gate.** Although M7 is one owner-fixed milestone with 8 sub-slices (not 8 top-level milestones), each sub-slice ships behind its own schema/RLS/API/audit/idempotency/tests/backfill/cutover/**rollback** gate so blast radius and critical-path risk stay bounded and any slice can be rolled back independently.

## 2. Sub-milestones, contents, and ordering

| Sub | Domains | Key durable entities | Depends on | Rationale |
|---|---|---|---|---|
| **M7a** | Customers, Employees, Prospects | customer, loyalty_account, employee, employee_role_assignment, prospect | M5 | **Customers/Employees are foundational** — most other domains reference customer and actor/employee. Employee↔role assignment aligns with canonical IAM (M5). Do first. |
| **M7b** | POS/Sales, Invoices, Payments | order, order_line, payment, payment_event, payment_method_token, terminal_device, dispute, refund, invoice, invoice_line, **inventory_obligation (outbox)** | M7a | Sales reference **customers** (M7a) and drive invoices/payments; refund authorization removes the hardcoded PIN (GAP-19). Highest transactional integrity (money). **Payments (G-PCI — DECIDED, integrated capability):** semi-integrated card-present + hosted/tokenized CNP + cash + external-terminal; TM POS2026 holds only opaque tokens (no PAN/CVV/track/PIN); auth/capture/settlement/void/refund/dispute/reconciliation + verified webhooks + idempotency + credential encryption/rotation ([05 §5](./05-canonical-data-ownership-and-api-db-contracts.md)); **PCI category validated before production.** **Gateway config is STORE-owned** ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)): builds the **Store Settings → Payments UI**, the **initial Stripe/Square/Adyen connector catalog** (each verified for launch-market/hardware/PCI during M7b), **OAuth/provider-hosted merchant connection** (no browser secret), terminal pairing, transactions, webhooks, refunds, and reconciliation — authorized by the store-scoped gateway permissions ([04 §2.1](./04-canonical-iam-and-four-user-migration.md)). **Entry criterion:** the **M6** encrypted credential-service + audit + idempotency + events must exist before M7b payment onboarding/activation/terminals/webhooks. M7b covers **technical candidate verification + selection**; **provider certification, commercial readiness, and PCI-classification confirmation are M9 evidence** (not claimed in M7b). Rate-limit the connect/Test-Connection/activate endpoints (anti-automation). **Inventory-safe transition (G-INVENTORY-CONSISTENCY):** owner-fixed order runs POS (M7b) before Inventory (M7c) though POS decrements stock, so at sale completion **M7b writes a durable `inventory_obligation` (outbox) in the SAME transaction as the sale, keyed by a unique sale/idempotency key, with durable states (pending/applied/failed)** — never claiming a decrement itself; inventory-tracked production sale completion is **feature-disabled / non-inventory mode** and **no decrement is exposed to the user** until M7c consumes+reconciles (replay-safe) and unresolved-obligation alerting is clean. |
| **M7c** | Inventory, Supply Chain | inventory_item, stock_movement, transfer, count, supplier, purchase_order, grn, rma | M7a | Durable inventory + supply chain; **consumes the M7b `inventory_obligation` outbox and reconciles** it (idempotently) to apply stock decrements, then lifts the inventory-tracked-POS block — resolving the inventory→POS dependency without reordering the owner-fixed M7b/M7c labels; supply chain feeds inventory. |
| **M7d** | Repairs, Services, Warranty, Returns | repair_ticket, service, warranty_claim, return, rma, return_shipment | M7a, M7b, M7c | Repairs consume **parts (inventory, M7c)** and reference **customers (M7a)**; returns/warranty reference **orders/invoices (M7b)** and inventory (M7c). |
| **M7e** | Shipping | shipment, tracking_event, pickup, provider_config, sla_policy | M7b, M7d | Shipping ships **orders/returns**; requires the **provider egress boundary + encrypted credentials** (closes SSRF/secret gaps, GAP-03/06) and webhook signature verification (GAP-14). **Consistency dependency:** the Shipping provider credential handling (today an unauthenticated in-memory global credential store) is upgraded to the **same encrypted credential-service + store-scoped isolation + verified-webhook standard as payments** ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)) — no new milestone. |
| **M7f** | Billing, Subscriptions, Plans, Features, **Entitlements**, Add-ons | plan, feature_catalog, add_on, subscription, billing_invoice, credit_note, entitlement | M5 | **Entitlements move off `sessionStorage`** into `tenant_feature_entitlement` (GAP-12). Plan/feature catalog + subscriptions become server-owned; must land with or before the domains it gates, but its **authority** depends on M5. |
| **M7g** | Platform Settings, Domains, Integrations, Widgets | platform_setting, tenant_domain, dns_record, integration, integration_credential, widget, widget_config | M5, M6 | Platform config + tenant domains (real DNS/SSL verification replaces fabricated status) + integrations (encrypted credentials via M6) + widgets. |
| **M7h** | Command Center, Support Tools, Audit, Security, Approvals, **Access Reviews, Temporary/PIM Access** (read models **and** operations) | support_case, escalation, macro, security_note, approval_request, access_review, temporary_access_grant | M7a–M7g | **Read-heavy governance surfaces + their controlled operations** built **last** — they aggregate over durable data from every prior domain. The forgeable `sessionStorage` "audit log" is replaced by reads over the durable `audit_event`. Access-review and temporary/PIM-access grants become durable + audited (advisory-only today). **All system-owner and tenant/store operational controls run through Backend CP typed services with canonical authorization + durable audit — never direct/arbitrary database mutation** ([03 §5/§7](./03-backend-control-plane-login-session-blueprint.md)). |

## 3. Ordering constraints (dependency respect)

- **M7a before everything** (customers/employees are referenced widely; employee↔role ties to M5).
- **M7b before M7c per the owner-fixed labels, with a blocking inventory-consistency dependency (G-INVENTORY-CONSISTENCY).** Invariant: **no production sale may claim inventory was decremented unless a durable, transactional, idempotent inventory mutation OR obligation exists and reconciliation passes.** M7b emits a durable `inventory_obligation` (outbox) and keeps inventory-tracked sale completion feature-disabled/non-inventory-mode; M7c consumes + reconciles it and only then lifts the block — resolving inventory→POS without relabelling and without silent divergence.
- **M7d after M7b+M7c** (repairs/returns/warranty reference orders, inventory, customers).
- **M7e after M7b+M7d** (shipping ships orders/returns; needs the egress boundary).
- **M7f gated by M5** (entitlement authority is server-side; catalog server-owned).
- **M7h last** (governance/read-models aggregate all prior durable data).

## 4. Cross-cutting per-module requirements

Every sub-milestone must deliver, for its domains: tenant/store scoping enforced server-side; transactions on all writes; idempotency on retryable/provider-triggered writes; append-only audit; outbox for provider/cross-domain effects; the full test set ([07](./07-quality-and-test-strategy.md)); removal of the corresponding `SEED_*`/`sessionStorage` authority; and elimination of the module's orphan/dead code ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-21) where it belongs to that domain.

## 5. Controlled-write actions

Backend-CP controlled **write** actions beyond the read-only pilot (phase-3.0 lineage) land in the relevant M7 vertical (e.g., an admin tenant-status change in M7f/M7h), each using the controlled-action contract in [03 §5](./03-backend-control-plane-login-session-blueprint.md). They are **not** part of the read-only M4 Backend CP.

## 6. Module-assignment clarifications (each assigned exactly once)

| Item | Single home | Note |
|---|---|---|
| Prospects | **M7a** | with Customers/Employees |
| Payments | **M7b** | with POS/Sales/Invoices |
| Widgets | **M7g** | with Settings/Integrations |
| Provider settings | **per-domain provider foundation** | shipping providers → **M7e**; **payment gateway → M7b, STORE-owned under Store Settings → Payments** (System Owner governs the connector catalog only, [03 §8](./03-backend-control-plane-login-session-blueprint.md)); integration providers → **M7g** (no generic duplicate — each provider config lives in its own domain slice) |
| Subscriptions | **M7f** | explicitly within Billing/Plans/Entitlements |
| Security · Approvals · Access Reviews · Temporary/PIM access | **M7h** | read models **and** controlled operations |
| Domain-specific DSAR behavior | **each relevant M7 slice** | every PII-holding domain implements its own export/correction/deletion/anonymization per the [05 §6](./05-canonical-data-ownership-and-api-db-contracts.md) DSAR contract |
| System-owner + tenant/store operational controls | **Backend CP typed services** | canonical authz + durable audit; **never direct/arbitrary DB mutation** |
