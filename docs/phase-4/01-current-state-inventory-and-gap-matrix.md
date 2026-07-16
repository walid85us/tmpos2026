# 01 — Current-State Inventory & Gap Matrix

**Scope:** every material platform surface, traced to source (read-only). Persistence is traced to whether data survives a page reload. All facts below are current-state; the target is in [02](./02-target-production-architecture.md).

## Legend

- **Persist:** `mem` = in-memory `useState` seeded from `SEED_*`/`mockData` (lost on reload); `ss` = `sessionStorage` (survives reload, lost on tab close); `ls` = `localStorage` (survives browser sessions); `none` = display-only; `pg` = Postgres (durable).
- **Authz source:** the `AccessGuard feature="…"` value + any `checkSubPermission`/platform-matrix gate. **All are client-only** unless a row says otherwise.
- **Prod-ready:** `none` / `mock` / `partial`.

---

## A. Platform-wide invariants (apply to every surface unless noted)

| Invariant | Finding |
|---|---|
| **Production topology** | `build = vite build` → static SPA bundle. **No backend is deployed.** `src/` imports nothing from `server/`. Every Express route is a DEV-only `tsx` sidecar, unreachable in the production artifact. |
| **Authentication** | Firebase Auth (real). `onAuthStateChanged` → `getDoc(users/{uid})` → `role` (`src/context/AccessContext.tsx:132–183`). |
| **Authorization (live app)** | **100% client-side.** `role` → `isPlatformRole` → `userType` → shell; gated by `AccessGuard` (`<Navigate>` redirects) + `canAccess`/`checkPermission`/`checkSubPermission`. No server re-check exists at runtime. |
| **Tenant identity** | **Hardcoded.** Every non-platform user gets mock `{ id:'tenant-1', plan:'growth', status:'active' }` (`AccessContext.tsx:153–159`). No real multi-tenancy; `SEED_*` are global constants with no `tenantId` filtering. |
| **Session status** | Hardcoded `status:'active'` (`AccessContext.tsx:147`). Suspended/inactive is **not** enforced client-side. `isWriteBlocked = isPreviewModeEnabled` only — past-due/suspended accounts are not write-blocked. |
| **Plan/feature gating** | Reads client-controlled `sessionStorage('features_data')` (`AccessContext.tsx:332`). Tamperable; cleared on tab close. A UI convenience, not a control. |
| **Platform permissions** | `platformPermissionsConfig.ts` is "single source of truth" but self-describes *"does NOT introduce server-side RBAC… all gating is UI-enforced"*; overrides persist to `sessionStorage('platform_permissions_v1')`. |
| **Business persistence** | `src/context/StoreLocalState.tsx` = `useState` seeded from `SEED_*`. **Every business write is lost on reload.** No DB/API/localStorage write-back for domain data. |
| **Audit (business + platform)** | "Audit" = human-readable notes appended into the same in-memory/`sessionStorage` record arrays. Not append-only, not server-side. The owner "Audit & Security" log is user-writable `sessionStorage` — **zero integrity**. |
| **Durable backend** | Postgres schema (`server/platform-identity/migrations/001–004`) is **identity/authz/audit only** — 8 tables, no business tables. Reachable only via the DEV-only `:5002` sidecar. See [05](./05-canonical-data-ownership-and-api-db-contracts.md). |
| **Test coverage** | `src/components/**` and `src/owner/**`: **0** tests. `src/backend-control-plane/**`: 8 client-classifier tests. `server/bcp-pilot/**` + `server/platform-identity/**`: substantial (the BCP corpus + platform-identity suites). Business/UI: unverified. |

---

## B. Tenant / store surfaces (`src/components/`, `src/tenant/`)

| Surface | Component | State / Persist | Authz (`feature=`) | API dep | DB | Isolation | Write / Audit | Prod-ready | Primary defect | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard | `DashboardOverview` | store + local / `mem` | none on route (parent `tenant`) | none | none | none | in-mem / none | mock | aggregates stale seed; not KPI-trustworthy | M7b (read-model) |
| POS / Sales | `POS` | store (`completedOrders`,`refundRecords`) / `mem` | `sales` + subperms, `posOperatorRole`, supervisor-refund | none | none | none | in-mem / none | mock | sales & refunds vanish on reload; no payment/ledger; refund PIN `1234` client-only | M7b |
| Repairs | `RepairTickets` | store (`repairTickets`) / `mem` | `repairs` | none | none | none | in-mem / status-note | mock | ticket lifecycle lost on reload | M7d |
| Inventory | `Inventory` | store (`stockItems`,`movements`) / `mem` | `inventory` | none | none | none | in-mem / "audit trail" is cosmetic | mock | stock lost on reload; advertised audit is UI copy | M7c |
| Customers | `Customers` | store (`customers`,`loyalty`) / `mem` | `customers` | none | none | none | in-mem / none | mock | customer PII in-mem, lost on reload | M7a |
| Employees | `Employees` | `useAccess` roles + local / `mem` | `employees` + subperms | none | none | none | role edits → in-mem AccessContext | mock | role/permission edits non-durable, no server enforcement | M7a |
| Employees subpages | `EmployeesInvite/Roles/PermissionsPage`, `SettingsUsersAccessPage` | stubs / `mem` | **unrouted (dead code)** | none | none | none | none | none | imported in `App.tsx`, no route renders them | M7a |
| Warranties | `WarrantyManagement` | store (`warrantyClaims`) / `mem` | `warranties` | none | none | none | in-mem / status-note | mock | claims lost on reload | M7d |
| Invoices | `Invoices` | store (`invoices`) / `mem` | `invoices` | none | none | none | in-mem / none | mock | no durable invoices; no numbering integrity | M7b |
| Services | `Services` | store (`services`) / `mem` | `services` | none | none | none | in-mem / none | mock | service catalog lost on reload | M7d |
| Supply Chain | `SupplyChain` | store (`suppliers`,`purchaseOrders`,`grns`) / `mem` | `supply-chain`→`supply_chain` | none | none | none | in-mem / none | mock | PO/GRN workflow non-durable | M7c |
| Shipping Center | `ShippingCenter` | store (`shipments`) + `utils/sla.ts` / `mem`+`ss` | `shipping` + subperms | `/api/shipping/label-proxy` (dev-only) | none | none | in-mem; SLA policy in `ss` / packing notes | partial | label-proxy 404s in static prod; shipments in-mem | M7e |
| Shipping Providers | `ShippingProvidersPage` (+ `ShippingCenter` settings tab, `src/shipping/providerRegistry.ts`) | local / `mem` | `shipping` (standalone page mis-gates on `manage_shipping_settings`, not `configure_shipping_provider` + plan) | `/api/shipping/*` (dev-only, **unauth**) | none | none | **credentials in an unauthenticated global in-memory `Map` keyed by providerId only** (`server/credential-store.ts`); env-gated webhook-verify bypass; no audit | mock | credential pattern is the **anti-pattern the store-owned payment gateway must NOT copy** (unauth routes, global RAM secrets, no store scope, SSRF, opt-in webhook verify); Shipping upgraded to the payment credential/security standard in **M7e** ([06](./06-module-migration-map-m7.md)) | M7e |
| Returns | `ReturnsPortal` | store (`returns`,`rmas`) / `mem` | `returns` + `isWriteBlocked` + subperms | none | none | none | in-mem / status-note | mock | RMA/return flow lost on reload | M7d |
| Marketing | `Marketing` | static/local / `mem` | `marketing` (route only) | none | none | none | none | mock | purely static mock UI; no data model | *out-of-scope: post-production enhancement* |
| Reports | `Reports` | static/local / `mem` | `reports` (route only) | none | none | none | none | mock | mock charts; does NOT read live store data | M7h (cross-module read-model) |
| Settings | `Settings` | store (`documentTemplates`,`storeBranding`) / `mem` | `settings` | none | none | none | in-mem / none | mock | branding/templates lost on reload | M7g |
| Support | `Support` | static / `none` | `support` (route only) | none | none | none | none | mock | static page; no ticketing backend | M7h |
| Prospects | `Prospects` | static/local / `mem` | `prospects` (route only) | none | none | none | in-mem / none | mock | mock CRM; no persistence | M7a |
| Integrations | `Integrations` | static/local / `mem` | `integrations` (route only) | none | none | none | toggles in-mem / none | mock | fake toggles; no OAuth/persistence | M7g |
| Widgets | `Widgets` | static/local / `mem` | `widgets` (route only) | none | none | none | in-mem / none | mock | mock widget config | M7g |
| App Store / Mail-In / Ledger | inline JSX in `App.tsx` (orphan `AppStore/MailInRepairs/Ledger.tsx`) | none | `app-store`/`mail-in`/`ledger` | none | none | none | none | none | "Coming Soon" placeholders; unrouted orphans | M7g/M7d/M7f |

**Tenant cluster cross-cutting defects:** (1) all business writes volatile; (2) no server persistence in prod (`/api/shipping/*` 404s in static build); (3) authz 100% client-side & bypassable; (4) plan gating `sessionStorage`-authoritative; (5) zero tenant scoping (`tenant-1`); (6) audit trails cosmetic; (7) Reports/Dashboard disconnected mock analytics; (8) dead/orphan code; (9) zero test coverage; (10) `isWriteBlocked` reflects preview mode only.

---

## C. Platform / Owner surfaces (`src/owner/`, `/owner` tree)

All owner data originates in `src/owner/mockData.ts` (SEED) with a **`sessionStorage` overlay acting as a mutable de-facto database**. `canAccess` is client-side; no owner page performs a network write.

| Surface | Component | State / Persist | Authz (`feature=`) | Data authority | Write behavior | Prod-ready | Primary defect | Milestone |
|---|---|---|---|---|---|---|---|---|
| Dashboard | `DashboardPage` | mockData / `none` | **none on route** (parent `platform` only) | mock view | read-only | mock | route not feature-gated; stale mock | M7h |
| Command Center | `CommandCenterPage` | mockData + reads other keys; writes `cc_intel_snapshot_v1` (`ls`) | `command_center` | mock view | snapshot persists across browser sessions | mock | cross-reads other pages' `ss` as "truth" | M7h |
| Tenants | `TenantsPage` | mockData / `none` | `tenants` | mock view | read-only | mock | tenant list is static seed | M5 |
| Tenant Detail | `TenantDetailPage` | mockData; writes `tenant_overrides_data` (`ss`) | `tenants` | mutable overlay | per-tenant entitlement overrides forgeable | mock | client-only entitlement overrides | M5 |
| Plans & Features | `PlansPage` | writes `plans_data`,`features_data`,`addons_data` (`ss`) | `plans` | **de-facto DB** | owner reshapes plan→feature availability client-side | mock | **drives real tenant gating with no server write** | M7f |
| Feature Matrix / Add-Ons | `FeatureMatrixPage` / `AddOnsPage` | redirect → `/owner/plans` | `plans` | n/a | thin alias | n/a | alias only | M7f |
| Subscriptions | `SubscriptionsPage` | mockData / `none` | `subscriptions` | mock view | read-only | mock | no real subscription state | M7f |
| Billing | `BillingPage` | mockData (txns, invoices) / `none` | `billing` | mock view | local edits lost on reload | mock | billing actions are ephemeral illusions; no ledger | M7f |
| Provisioning | `ProvisioningPage` | mockData + `setTimeout` sim / `none` | `provisioning` | mock view | **fakes tenant creation; no server call** | mock | provisioning wizard is simulated | M7h |
| Domains | `DomainsPage` | writes `tenant_domains_v1` (`ss`) | `domains` | mutable overlay | DNS/SSL status fabricated | mock | no verifier; fabricated status | M7g |
| Usage | `UsagePage` | mockData / `none` | `usage` | mock view | read-only | mock | static usage numbers | M7f |
| Support Tools | `SupportToolsPage` | writes `support_cases_v1`,`support_macros_v1` (`ss`) | `support_tools` | mutable overlay | cases/macros in `ss` | mock | shared `ss` with Audit/CommandCenter; no server | M7h |
| Platform Settings | `PlatformSettingsPage` | writes `platform_settings_v1` (`ss`) | `platform_settings` | mutable overlay | global config editable client-side | mock | non-authoritative global config | M7g |
| Audit & Security | `AuditSecurityPage` | writes `platform_security_notes`,`audit_logs` (`ss`) | `audit_security` | mutable overlay | **"audit log" is user-writable/forgeable** | mock | integrity void | M7h |
| Team Management | `TeamManagementPage` | roles in-mem + matrix overrides `platform_permissions_v1` (`ss`) | `team_management` | mutable overlay | **split-brain IAM**: role defs in-mem (lost on reload), matrix overrides persist | mock | client-side IAM; two surfaces disagree after reload | M5 |
| Roles / Permissions | `RolesPage` / `PermissionsPage` | `accessMockData` / `none` | **unrouted (dead code)** | mock view | read-only | none | orphaned static views; real RBAC in Team Mgmt | M5 |

### `sessionStorage`/`localStorage` keys = the de-facto platform database

| Key | Store | Writer → Reader | Governs |
|---|---|---|---|
| `features_data` | ss | PlansPage → AccessContext (tenant gating), TenantDetail | **plan→feature availability** |
| `plans_data` / `addons_data` | ss | PlansPage → PlansPage / TenantDetail | plan & add-on catalog |
| `tenant_overrides_data` | ss | TenantDetail → PlansPage, TenantDetail | per-tenant entitlement overrides |
| `platform_permissions_v1` | ss | TeamMgmt matrix → AccessContext (`hasEffectiveFeatureAccess`) | **platform staff permissions** |
| `platform_settings_v1` | ss | PlatformSettings | global platform config |
| `tenant_domains_v1` | ss | DomainsPage → CommandCenter, SupportTools | tenant domains/DNS |
| `support_cases_v1` / `support_macros_v1` | ss | SupportTools, AuditSecurity → CommandCenter | support cases/macros |
| `platform_security_notes` / `audit_logs` / `commercial_audit` | ss | AuditSecurity, commercialAudit | **forgeable "audit trail"** |
| `commercial_invoices_data` | ss | commercialInvoices → Billing/Tenant | invoices |
| `cc_intel_snapshot_v1` | **ls** | CommandCenter | what-changed baseline (persists across sessions) |

**Owner cluster cross-cutting defects:** all owner authz client-side & forgeable; `sessionStorage` is the de-facto platform DB; owner reshapes entitlements with no server write; audit log has zero integrity; hidden cross-page coupling via shared keys; inconsistent/misleading persistence (mix of `ss`/`ls`/none); split-brain IAM; orphaned RBAC UI; zero owner test coverage.

---

## D. DEV-only Backend Control Plane & Pilot (`src/backend-control-plane/`, `src/pilot/`)

| Item | Finding |
|---|---|
| **BCP gating** | `BCP_ROUTE_ENABLED = import.meta.env.DEV && VITE_ENABLE_BACKEND_CONTROL_PLANE==='true'`. Default OFF; route `/dev/backend-control-plane` excluded from production build. Entry gate is a single local `entered` boolean — **no auth**. |
| **BCP wiring** | Mostly static mock (`mockData.ts`, dangerous buttons disabled). But `bcpC01–C07Client` **GET** live readiness lenses via the DEV proxy `/__identity/dev/bcp/*` (no creds), and `bcpAcknowledgeReadinessReviewClient` **POSTs** (Firebase Bearer + `X-BCP-Action-Intent`) to `/__identity/dev/bcp/actions/acknowledge-readiness-review` — server-authoritative. **No production backend wired.** |
| **Pilot** | `PILOT_ROUTE_ENABLED = import.meta.env.DEV && VITE_ENABLE_SUPABASE_PILOT==='true'`; route `/dev/supabase-pilot`; default OFF; identity proof only (Supabase sign-in → whoami diagnostic), never app authorization; imports no Firebase/AccessContext/business modules. |
| **Tests** | BCP: 8 client-classifier tests. Pilot: 0. |

---

## E. Server / API surfaces (all DEV-only sidecars, none in production build)

### Shipping API — `server/index.ts` (:5001, started by `npm run dev`) — **unauthenticated**
23 routes, **no auth/session/CSRF anywhere**; state is an in-memory `Map`. Highlights:
- **`GET /api/shipping/label-proxy?url=` → `fetch(url)` verbatim, streamed back → OPEN SSRF** (no scheme/host allowlist).
- `POST /api/shipping/credentials` stores **live carrier API keys in process memory**, unauthenticated; the same open port both sets and uses them.
- `POST /api/shipping/webhook/:providerId` + `/replay-event` ingest/replay **unauthenticated, no provider-signature verify**.
- Provider adapters (`easypost/shippo/shipstation.ts`) egress to **hardcoded** carrier hosts (not the SSRF surface).

### Identity API — `server/platform-identity/server.ts` (:5002, `npm run identity:api` only) — DEV-only, master-gated
Master flag `ENABLE_SUPABASE_PLATFORM_IDENTITY` (default OFF ⇒ only `/health`+`/readiness`).
- `POST /identity/resolve` — **NONE (caller auth deferred)** — **upserts `platform_identity`** with caller-supplied, unverified `authProviderUid` ⇒ **unauthenticated DB write / identity spoof**, gated only by a flag.
- `POST /auth/session/resolve` — verifies Bearer Supabase token, returns a JSON DTO — **issues NO cookie**; `RUNTIME_SESSION_RESOLVE_AUTHORIZATION = null` (server-derived authorization deferred).
- Diagnostics endpoints (`echo-decision` dev-asserted actor; `supabase-whoami` verified) — dev-only.
- `db.ts` connects as the **DB-owner role → bypasses RLS** (`platform_identity` RLS-enabled, zero policies).

### Firebase Admin — sole importer `firebaseAdminAuthAdapter.ts`
`verifyIdToken(token, /*checkRevoked*/ true)` (rejects revoked + disabled). Service account env `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` (name only; never logged/persisted). Fails closed to `authentication_unavailable`. Never writes to Firebase. Used by the BCP action live-principal resolver.

### Controlled-action pilot — `server/bcp-pilot/bcpAction*` (DEV-only, `:5002` only)
Fail-closed chain: **method/dev/flag → request-security guard (403) → global rate (429) → verify Bearer (401) → read-only identity (403 unmapped) → per-principal rate → authz guard (final) → pure handler**. Authz guard floors: visibility `system_owner` (exact eq), permission `manage`, read-only/overdue caps to `view`. Idempotency store + rate limiter are **in-memory, process-local** (die with process). Audit sink is `dev_sidecar_log_advisory` — **prohibited from durable writes** (no `writeAuditEvent`/DB/Firebase/fs/network). C01–C07 lenses are read-only, each behind its own default-OFF flag.

### Session/auth mechanics (repo-wide)
- **No server-issued session cookie exists** (`res.cookie`/`Set-Cookie` absent in non-test server files).
- **No CSRF scheme** beyond the BCP action guard's Origin + `Sec-Fetch-Site` + custom-intent-header defense.
- **No admin/server session store.** Auth = client Firebase session + client-held role.
- Two independent Express apps, **zero shared middleware** — each route re-implements (or omits) protection.

---

## F. Gap register (defects & architecture risks)

Severity: **C** critical (blocks production / security), **H** high, **M** medium. Each maps to a target milestone and (where applicable) a gate in [08](./08-production-gate-and-risk-register.md).

| ID | Sev | Gap | Milestone | Gate |
|---|---|---|---|---|
| GAP-01 | C | Live authorization is 100% client-side; browser role/`sessionStorage` establishes authority; no server re-check. | M5 | G-CLIENTAUTH |
| GAP-02 | C | No server-issued admin session / no separate Backend CP login boundary; no cookie, no CSRF, no MFA. | M4 | G-CPLOGIN |
| GAP-03 | C | Open SSRF — `GET /api/shipping/label-proxy?url=` fetches arbitrary URLs unauthenticated. | M8 (design M3) | G-SSRF |
| GAP-04 | C | Entire Shipping API unauthenticated (23 routes), incl. live-label purchase, pickups, webhook ingest/replay. | M3/M8 | G-UNAUTH |
| GAP-05 | C | Unauthenticated Postgres write — `/identity/resolve` upserts identity with unverified caller UID. | M3/M5 | G-UNAUTH |
| GAP-06 | C | Unauthenticated in-memory secret store — `POST /credentials` holds live carrier keys in RAM. | M3/M8 | G-SECRETS |
| GAP-07 | C | No durable audit — `auditEventWriter` built but unwired; zero compliance trail; owner "audit log" is forgeable `sessionStorage`. | M6 | G-AUDIT |
| GAP-08 | C | No durable business persistence — all POS/inventory/invoice/repair/customer/etc. writes lost on reload. | M7a–e | G-PERSIST |
| GAP-09 | C | No tenant/store isolation — `tenant-1` hardcoded; global seed; no `tenantId` scoping in the app. | M5/M7 | G-ISOLATION |
| GAP-10 | C | Four noncanonical Firebase users hold client-presentation roles only; no canonical principal. | M5 | G-4USER |
| GAP-11 | H | Two conflicting permission-level orderings (`manage↔approve` swapped) across tenant vs platform code. | M5 | G-IAMUNIFY |
| GAP-12 | H | Plan/feature entitlements & platform permissions are `sessionStorage`-authoritative and forgeable. | M5/M7f | G-ENTITLE |
| GAP-13 | H | Suspended/inactive/read-only/overdue status not enforced client-side; `isWriteBlocked` = preview mode only. | M5 | G-STATUS |
| GAP-14 | H | Webhook ingest/replay has no provider-signature verification. | M8 | G-WEBHOOK |
| GAP-15 | H | Idempotency store + rate limiter are in-memory/process-local; not production-grade or multi-instance. | M6 | G-IDEMPOT |
| GAP-16 | H | Migrations never auto-applied (manual owner step); no migration runner; schema-drift risk. | M3 | G-MIGRATE |
| GAP-17 | H | DB connects as owner role, bypassing RLS; app layer is the only access control (absent on `/identity/resolve`). | M3/M5 | G-DBROLE |
| GAP-18 | H | Firestore emulator semantic suite now EXECUTED locally — **41/41 PASS** via ephemeral Nix JDK21 (`demo-` project, no creds); static guard retained (21/21). CI re-run pending committed workflow. | M2 | G-EMU |
| GAP-19 | H | Hardcoded credential: PIN `1234` in **multiple** authorization paths (`AccessContext.tsx:420` refund-supervisor, `POS.tsx:617`) plus mock operator PINs — client-side. | M5/M7b | G-HARDCRED |
| GAP-26 | C | POS has order/payment/refund but no payment-processor / tokenization / PCI-DSS architecture. **Direction DECIDED: integrated capability in scope (semi-integrated/tokenized; no cardholder data in-system); STORE-owned gateway config (Store Settings → Payments; Stripe/Square/Adyen); System Owner governs connector catalog only; provider + PCI-category validated in M7b.** | M7b | G-PCI |
| GAP-20 | M | Reports/Dashboard are disconnected mock analytics; KPIs not trustworthy. | M7 (read-models) | — |
| GAP-21 | M | Dead/orphan code: `Employees{Invite,Roles,Permissions}Page`, `SettingsUsersAccessPage`, `Roles/PermissionsPage`, `AppStore/MailInRepairs/Ledger`. | M7a/M7g | — |
| GAP-22 | M | Zero test coverage on all tenant/owner UI surfaces (heavy stateful logic unverified). | M2/M7 | G-COVERAGE |
| GAP-23 | M | Hidden cross-page coupling via shared `sessionStorage` keys (no schema/versioning owner). | M7f/M7g/M7h | — |
| GAP-24 | M | Historical (pre-M0-fix) Firestore exploitation cannot be disproven with available evidence (historical evidence limitation, not an active vuln). | M8→M9 | G-HIST |
| GAP-25 | M | Two independent Express apps, zero shared middleware — protection re-implemented/omitted per route. | M3 | G-UNAUTH (shared middleware) |

**Inventory totals:** 23 tenant surfaces · 18 owner surfaces (incl. 2 unrouted) · 1 DEV BCP shell + 1 pilot · 2 Express apps (Shipping 23 routes; Identity ~8 endpoints + C01–C07 lenses) · 8 durable tables (identity/authz/audit only) · **26 gaps (11 Critical, 9 High, 6 Medium)**.

> **Note on severity semantics:** a gap's defect severity here may differ from its go-live *gate* severity in [08](./08-production-gate-and-risk-register.md) — a gate can be more blocking than its source defect (e.g. GAP-18 defect *High* → gate G-EMU *BLOCKER*; GAP-24 defect *Medium* → gate G-HIST *HIGH*). This is intentional.
