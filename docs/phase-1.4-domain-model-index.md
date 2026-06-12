# Phase 1.4 — Domain Model Index (Quick Reference)

> **Documentation only.** Compact companion to [`phase-1.4-milestone-2-durable-data-shape-domain-model.md`](phase-1.4-milestone-2-durable-data-shape-domain-model.md). Not a schema, not a migration, provider-agnostic. Legend: **Scope** P=platform / T=tenant / S=store / X=cross-scope. **Now** = current persistence (FS-RO Firestore-read / SS sessionStorage(advisory) / LS localStorage / MEM in-memory mock / STATIC config / DERIVED / dev-FILE / server-MEM). **Diff** = future migration difficulty. **Sens** = enforcement sensitivity. **Audit** = future audit requirement. ✱ = append-only candidate. **Order** = persist-first(1) / defer(D) per M2 §15–16.

## Platform-scoped

| Domain | Scope | Now | Future PG group | Audit | Diff | Sens | Order |
|---|---|---|---|---|---|---|---|
| Platform users | P | FS-RO+Auth | platform_identity | yes | Med | High | **1** |
| Platform roles | P | STATIC | platform_rbac | yes | Easy | High | **1** |
| Global Permissions Matrix overrides | P | SS | platform_rbac | yes✱ | Med | **Crit** | **1** |
| Team governance meta | P | STATIC/adv | platform_governance | adv→dur | Med | High | D |
| Temporary access / PIM | P | SS adv | platform_governance | ✱ | Med | High | D |
| Access reviews | P | SS adv | platform_governance | ✱ | Med | Med | D |
| Sensitive-action reason capture | P | SS adv | platform_governance | ✱ | Med | High | D |
| Command Center signals | P | DERIVED | (view) | n/a | Easy | Low | D |
| Audit Investigation overlay | P | SS adv | platform_audit | ✱ | Med | High | D |
| Platform settings | P | LS | platform_config | yes | Med | High | D |
| Tenant provisioning | X | MEM | platform_tenancy | yes | Med | High | 1→tenancy |
| Tenant web address / domains | P | SS | platform_tenancy | yes | Med | Med | D |
| Plans / feature flags / gating | P | SS | commercial | yes | Med | High | D |
| Commercial invoices / overrides | X | SS | commercial | yes | Hard | High | D |
| Support / escalation / SLA / macros | P | MEM+SS | support_ops | yes | Hard | Med | D |
| Provider/integration config | P | MEM | platform_config | yes | Med | High | D |

## Tenant / store-scoped

| Domain | Scope | Now | Future PG group | Audit | Diff | Sens | Order |
|---|---|---|---|---|---|---|---|
| Tenants | T | MEM(mock) | tenancy | yes | NotReady | High | **1** |
| Stores / locations | S | MEM | tenancy | yes | NotReady | High | **1** |
| Employees (tenant users) | T | MEM | tenant_identity | yes | Hard | High | D |
| Tenant roles / Store Matrix | T | STATIC+MEM | tenant_rbac | yes | Med | High | D |
| Customers | T | MEM | crm | yes | Hard | High(PII) | D |
| Customer assets / devices | T | MEM | crm | maybe | Med | Med | D |
| POS sales / held / completed orders | S | MEM | pos | yes(fin) | VeryHard | **Crit** | D |
| Invoices | S | MEM | billing | yes(fin) | VeryHard | **Crit** | D |
| Payments (refs only, no card data) | S | MEM | billing | yes | VeryHard | **Crit** | D |
| Refunds | S | MEM | billing | yes | VeryHard | Crit | D |
| Repairs (tickets) | S | MEM | repairs | yes | Hard | High | D |
| Repair notes/timeline/attachment-meta | S | MEM | repairs | ✱ | Hard | Med | D |
| Services / categories | T | MEM | catalog | yes | Med | Low | D |
| Inventory items | T | MEM | inventory | yes | VeryHard | High | D |
| Stock levels | S | MEM | inventory | yes | VeryHard | High | D |
| Stock movements / adjustments / counts | S | MEM | inventory | ✱(ledger) | VeryHard | High | D |
| Trade-ins / refurbishment | T | MEM | inventory | yes | Hard | Med | D |
| Purchase orders / GRN | T | MEM | supply_chain | yes(fin) | Hard | High | D |
| Suppliers / supplier refunds | T | MEM | supply_chain | yes | Med | Med | D |
| Inventory transfers | X(S↔S) | MEM | inventory | yes | Hard | High | D |
| Warranty claims | T | MEM | repairs/billing | yes | Med | Med | D |
| Returns / RMAs | T | MEM | returns | yes | Hard | Med | D |
| Shipments | X(T+S) | MEM+devFILE | shipping | yes | Med | Med | D |
| Shipment packages | T | MEM | shipping | maybe | Med | Low | D |
| Labels / tracking events | T | MEM+devFILE | shipping | ✱ | Med | Med | D |
| Carrier / provider rates | T | MEM/ephem | (cache) | no | Easy | Low | D |
| Provider config / credentials | T | server-MEM | shipping_config | yes | Med | High(secret) | D |
| Pickup requests | T | MEM | shipping | yes | Med | Low | D |
| Service points | T | MEM | shipping | no | Med | Low | D |
| Carrier analytics / scorecards | T | DERIVED | (view) | n/a | Easy | Low | D |
| Automation rules / logs | T | MEM | automation | logs✱ | Hard | Med | D |
| Loyalty config / adjustments | T | MEM | crm | yes | Med | Low | D |
| Document templates / branding / store settings | T/S | MEM | tenant_config | yes | Med | Low | D |
| Marketing / prospects | T | MEM | crm | maybe | Med | Med(PII) | D |

## Cross-cutting

| Domain | Scope | Now | Future PG group | Audit | Notes |
|---|---|---|---|---|---|
| Audit events | X | SS adv | audit | ✱ server-written | durable evidence store (none today) |
| Employee activity logs | T | MEM | audit/tenant_ops | ✱ | — |
| Webhook / provider events | T | devFILE/MEM | integration_events | ✱ | needs idempotency_key |
| Files / attachment metadata | T | MEM | files | — | metadata only; blobs in object storage |
| External provider references | — | embedded | (columns) | — | payments/shipping/integrations |
| Idempotency / sync keys | — | partial | (columns) | — | payments/shipping/webhooks |
| Notifications / alerts | — | **not present** | notifications(future) | — | placeholder |
| Data import / export | — | **not present** | (future) | — | placeholder |
| Schema / version metadata | — | **not present** | schema_meta(future) | — | placeholder |

**Mandatory future columns recap:** `tenant_id` on every T/S record · `store_id` where store isolation matters · `actor_user_id` on auditable writes · `created_at`/`updated_at` · documented status enums · `external_provider`/`external_reference` + `idempotency_key` on external actions · money as `numeric`+`currency` · **no card data** · `internal_user_id` decoupled from `auth_provider_uid`.
