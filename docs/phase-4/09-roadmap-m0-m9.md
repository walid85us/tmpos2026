# 09 — Authoritative Roadmap M0–M9 & Deferred-Work Reconciliation

**Scope:** the single authoritative Phase 4 milestone spine. No milestone exists outside M0–M9 (with M7 subdivided into M7a–M7h). There is no M10, M11, Phase 4.1, or "post-Phase-4" milestone in this roadmap. Any activity not assigned to M0–M9 is explicitly classified as out-of-product-scope, post-production enhancement, owner-declined, or superseded.

**Deployment / go-live is not a milestone.** It is a separate explicit owner authorization that may only be requested after M9 completes.

---

## 1. Milestone spine

| Milestone | Title | Goal | Hard entry dependency |
|---|---|---|---|
| **M0** | Emergency Firebase exposure assessment & containment | Fail-closed Firestore rules; current-state integrity assessed | — (done: `79509c18`) |
| **M1** | Production architecture & canonical data contracts | This package: architecture, IAM, data/API contracts, roadmap, gates | M0 |
| **M2** | Quality baseline, test architecture, build integrity, emulator/CI foundation | Repeatable test pyramid + **Java-enabled Firestore emulator gate** + CI | M1 |
| **M3** | Deployable backend runtime & infrastructure foundation | A real deployed server runtime, environments, migration runner, secrets store | M1 (design), M2 (CI) |
| **M4** | Separate Backend Control Plane login, session & admin shell | Server-issued admin session, distinct login boundary, admin shell wired to server | M3 |
| **M5** | Canonical IAM, tenant, store, permission & entitlement governance | Server-derived authorization is the source of truth; client role subordinated | M3, M4 |
| **M6** | Shared durability foundation | Durable audit, idempotency, events/outbox, credential storage, transaction standards | M3 |
| **M7** | Vertical module migrations (M7a–M7h) | Move each business domain to durable, server-authoritative persistence | M3, M5, M6 |
| **M8** | Observability, security hardening, backup, recovery, operational readiness | Monitoring, alerting, SSRF/webhook/credential hardening, backup/restore | M3–M7 |
| **M9** | Integrated UAT, migration rehearsal, production-readiness review, go-live package | End-to-end validation + rehearsal + the go-live decision package | M2–M8 |

### M7 subdivisions (subdivisions of M7, not top-level milestones)

| Sub | Domains | Primary durable entities introduced |
|---|---|---|
| **M7a** | Customers, Employees, Prospects | customer, employee/team-member, prospect |
| **M7b** | POS/Sales, Invoices, Payments | order/sale, invoice, payment (+event/token/terminal/dispute), refund, **inventory_obligation (outbox)** |
| **M7c** | Inventory, Supply Chain | inventory_item, stock_movement, supplier, purchase_order, grn (consumes M7b's inventory_obligation) |
| **M7d** | Repairs, Services, Warranty, Returns | repair_ticket, service, warranty_claim, return/rma |
| **M7e** | Shipping | shipment, tracking_event, pickup, shipping_provider_config |
| **M7f** | Billing, Subscriptions, Plans, Features, **Entitlements**, Add-ons | plan, feature_catalog, subscription, add_on, entitlement, invoice(billing) |
| **M7g** | Platform Settings, Domains, Integrations, Widgets | platform_setting, tenant_domain, integration, widget |
| **M7h** | Command Center, Support Tools, Audit, Security, Approvals, Access Reviews, Temporary/PIM Access | support_case, security_note, approval_request, access_review, temporary_access_grant (read models **and** operations) |

M7 ordering rationale is in [06 Module Migration Map](./06-module-migration-map-m7.md).

---

## 2. Milestone detail

### M0 — Emergency Firebase exposure assessment & containment *(complete)*
Fail-closed `firestore.rules` committed (`79509c18`), static regression guard 21/21. Current-state integrity assessed: one canonical Firebase `system_owner`; four ordinary users hold noncanonical client-presentation roles only. Firestore `/auditEvents` empty. **Open residuals carried as production gates:** emulator semantic evidence (G-EMU), historical exploitation limitation (G-HIST), four-user migration (G-4USER).

### M1 — Production architecture & canonical data contracts *(this package)*
Deliverables: current-state inventory & gap matrix, target architecture, Backend CP login/session blueprint, canonical IAM & four-user migration contract, canonical data ownership & API/DB contracts (incl. the **payment contract** and the **privacy/DSAR data-rights contract**, [05 §5–§6](./05-canonical-data-ownership-and-api-db-contracts.md)), module migration map, quality/test strategy, production-gate register, this roadmap, ADRs. **Owner decisions resolved:** G-PCI (integrated payments in scope), G-PRIVACY (DSAR foundation in scope).

### M2 — Quality baseline, test architecture, build integrity, emulator/CI foundation
Establish the mandatory test pyramid ([07](./07-quality-and-test-strategy.md)); stand up a **Java-enabled environment** so the Firestore emulator semantic suite runs (clears M0 G-EMU as a repeatable gate, not a one-off); wire CI to run unit/authz/contract/emulator suites and block merges on red; stand up **application-security scanning — dependency-audit/SCA + SAST on every PR, DAST against staging (G-APPSEC)** — restoring the static-analysis control the disabled Semgrep hook dropped; formalize the typecheck baseline as a ratchet (never regress; drive toward zero). No production runtime yet.

### M3 — Deployable backend runtime & infrastructure foundation
Choose and stand up the server runtime and environments (local/test/staging/production) per [02](./02-target-production-architecture.md); deliver a **migration runner** (today migrations are file-only, applied manually — see §3); a **secrets store** (no secrets in memory, no unauthenticated credential endpoints); connection-role separation (an app role that does **not** own tables / does not bypass RLS for tenant paths). M3 also performs **early remediation that must not wait for M8**: **eliminate or firewall the DEV Express sidecars** so no unauthenticated route (Shipping API, the open `label-proxy` SSRF, the unauthenticated `/identity/resolve` Postgres write) is reachable in any deployed environment; establish **shared enforced middleware** (auth/CSRF/rate-limit/security-headers) so protection is uniform, not per-route. It lays the **tenant-isolation foundation** — tenant context, server-side membership resolution, the RLS policy shape, and cross-tenant/cross-store test fixtures — and wires a **minimal durable `audit_event` writer** so audited operations in M4/M5 are covered before full audit lands in M6.

### M4 — Separate Backend Control Plane login, session & admin shell
Deliver **two separate server session boundaries** ([03](./03-backend-control-plane-login-session-blueprint.md)): a **tenant/store** session (for `/api/v1/*`) and a **distinct administrative** session (for `/admin/v1/*`) — each via Firebase ID-token verification at its own server login exchange, a server-issued HttpOnly/Secure/`__Host-`/SameSite cookie backed by a durable session store, CSRF, login rate-limiting, and (for admin) MFA/step-up + a mandatory distinct admin origin. Both share one canonical IAM catalog and one status model. The admin shell is wired to server endpoints; between M4 and M5 admin endpoints enforce only the **narrow pilot guard** (`system_owner` exact-eq) until M5 generalizes authorization. Absorbs the read-only Backend Control Plane already drafted in DEV (see §3 reconciliation).

### M5 — Canonical IAM, tenant, store, permission & entitlement governance
Make **server-derived authorization the source of truth** ([04](./04-canonical-iam-and-four-user-migration.md)). M5 is large and is the hard dependency for all of M7, so it executes in **three ordered internal phases (execution phasing within M5 — not new milestones):** **(i)** authorization service + permission-ordering unification (+ tenant-grant re-derivation) + server-derived context (resolves the always-null authorization field); **(ii)** move plan/feature entitlements and platform permissions off client `sessionStorage` into server-owned storage; **(iii)** enforce suspended/inactive/parity/cap fail-closed + execute the four-user migration contract + tenant/store isolation enforcement. **M5 depends on M3, M4, and the minimal audit writer (M3/M4)** so that its provisioning/grant changes are durably audited. M5 also delivers the **DSAR requester/tenant/platform authorization** boundary (identity verification, tenant approval + platform escalation) per the [05 §6](./05-canonical-data-ownership-and-api-db-contracts.md) privacy contract, and the **store-scoped payment-gateway permissions** + platform delegated-support elevation model ([04 §2.1](./04-canonical-iam-and-four-user-migration.md), [03 §8](./03-backend-control-plane-login-session-blueprint.md)).

### M6 — Shared durability foundation
Expand the durable audit writer (seeded minimally in M3/M4) to **every** authorization/mutation path, and deliver durable idempotency, event/outbox, credential encryption + rotation, and transaction standards ([05](./05-canonical-data-ownership-and-api-db-contracts.md)). The **minimal** audit writer lands in M3/M4 (so M5's provisioning is audited); M6 completes coverage and adds the outbox/idempotency/rotation machinery. M6 depends only on M3, so it may run before or alongside M5. M6 also lays the **DSAR audit, request workflow, event, and retention/legal-hold foundations** ([05 §6](./05-canonical-data-ownership-and-api-db-contracts.md)).

### M7 — Vertical module migrations (M7a–M7h)
Migrate each business domain from in-memory mock state to durable, server-authoritative persistence with tenant/store scoping, transactions, idempotency, and audit ([06](./06-module-migration-map-m7.md)). Notable: **M7b** builds the **integrated payment capability** (G-PCI, DECIDED — semi-integrated/tokenized, no cardholder data in TM POS2026, PCI category validated before production) with **STORE-owned gateway configuration** (Store Settings → Payments; initial **Stripe/Square/Adyen** connector catalog; OAuth/hosted merchant connection; store-scoped permissions) — the System Owner governs only the connector catalog ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md), [03 §8](./03-backend-control-plane-login-session-blueprint.md)) — and emits the durable **`inventory_obligation`** consumed by **M7c** under the **G-INVENTORY-CONSISTENCY** invariant (no sale claims a decrement without a durable/transactional/idempotent mutation-or-obligation + reconciliation). Each PII-holding slice implements its **domain-specific DSAR** export/correction/deletion behavior ([05 §6](./05-canonical-data-ownership-and-api-db-contracts.md)).

### M8 — Observability, security hardening, backup, recovery, operational readiness
Monitoring/alerting/SLOs; **security hardening** — webhook signature verification, web/transport hardening (CSP, security headers, HSTS, clickjacking/XSS), secret rotation/key management, the provider egress boundary, and **payment-connector monitoring + global incident-disablement + credential-rotation operations + PCI/security evidence** — plus backup & restore, incident response (elevated for a payment/PII platform), **operational privacy/DSAR workflow + monitoring + incident integration (G-PRIVACY)**, and performance & accessibility passes. M8 also runs the **G-HIST bounded read-only investigation**: attempt to retrieve existing authorized historical evidence (Cloud Audit Logs / version history) **without enabling new retroactive collection**; classify it if present. **Note:** the *unconditional* remediations (open SSRF `label-proxy`, unauthenticated Shipping API, unauthenticated identity write, in-memory secrets) are pulled **earlier into M3** and are not deferred here; and any M8 gate a specific domain needs sooner (e.g. secret encryption/rotation for shipping in M7e) **attaches to the earliest milestone that needs it** rather than waiting for M8.

### M9 — Integrated UAT, migration rehearsal, production-readiness review, go-live package
End-to-end UAT, a full **migration rehearsal**, a production-readiness review against the [08 gate register](./08-production-gate-and-risk-register.md), and the go-live decision package. M9 also captures **payment provider certification / commercial readiness, PCI classification confirmation, and store-owner acceptance** (G-PCI), **DSAR production evidence + policy/legal-owner sign-off** (G-PRIVACY), and the **G-HIST disposition**: if the M8 investigation found no evidence able to reconstruct the historical exposure window, M9 records an explicit **owner risk acknowledgement** (exposure window existed; current state showed no privileged mismatch; Firestore `auditEvents` empty; historical non-exploitation unprovable; fail-closed rules active; compensating controls + future monitoring established). Go-live authorization is requested **after** M9, separately.

---

## 3. Deferred / future / planned work reconciliation

Repository-wide keyword reconciliation (`planned/deferred/future/follow-up/TODO/FIXME/production/backend/database/auth/migration`) over `src/ server/ tests/ scripts/ docs/ *.md *.json`. Result: **no code-level TODO/FIXME debt** (0 FIXME anywhere; all TODO occurrences are in docs/config). The high `future/deferred` counts are GSD planning-doc vocabulary (intentional scope-fencing), not rot. Every material deferral maps into M0–M9:

| Deferred item (source) | Maps to | Note |
|---|---|---|
| Plan/feature catalog stays in code; entitlement materialization deferred (`migrations/002` comments) | **M5** | catalog → server-owned |
| Three role/permission catalogs to unify into ONE shared catalog — "declared, NOT built" (`authorizationConstants.ts`) | **M5** | reconcile with permission-ordering conflict |
| Server-derived authorization field ALWAYS null — deferred (`authorizationContract.ts`) | **M5** | gated by M4 session |
| Durable audit writer built but NOT wired (`auditEventWriter.ts`) | **M6** | zero durable audit until M6 |
| `/auth/session/resolve` runtime authorization wiring deferred (`phase-1.5-m11.1`) | **M5** | needs M4 session |
| Migrations "NOT applied by any runtime"; manual owner step (`scripts/supabase-migrate.ts`) | **M3** | migration runner |
| Deployment topology & production DB decisions (records, not built) (`phase-1.4-decision-records`) | **M3** | |
| Backend CP read-only adapters deliberately NOT wired (`bcp-pilot/*`) | **M4** | absorbed by M4 |
| Read-only Backend CP shell/lens/transport planning (`phase-1.6 M21+`, `phase-2.0 M24–M58`) | **M4** (+ **M8** hardening) | parallel legacy taxonomy — see below |
| Controlled backend WRITE actions (`phase-3.0` docs, `mockData.ts:286` support actions) | **M7** verticals | beyond read-only M4 |
| `identity_link` implementation/runtime integration deferred (`mig 004`, `phase-1.6 M20`) | **M5** | gated by M4 |
| RBAC/PIM/PAM enforcement out of scope, "planned for later" (`platformPermissionsConfig.ts`) | **M5** | |
| Reason-capture/SoD/"future role concepts documented only" (`platformTeamGovernance.ts`) | **M5** / **M6** | |

### Classified OUT of the M0–M9 roadmap (not auto-authorized)

| Item | Classification |
|---|---|
| Frontend Firebase-era shipping enhancements with no durable home (carrier scorecards per-store setting, paid-override redesign) | post-production enhancement |
| Semgrep hook temporarily disabled (no token) | **reinstated → M2 (G-APPSEC)** — SAST/SCA is a real production gate, not out-of-scope; the disabled hook must be restored |
| `.replit` local change + goose tarball | out-of-product-scope (never touched) |
| Legacy platform roles `platform_admin` / `platform_readonly` not auto-mapped | superseded (canonical vocab replaces; migration 003 fails loud on survivors) |
| DEV bootstrap seed / production bootstrap | owner-declined / DEV-only by design |

### Roadmap-conflict flags (resolved here)

1. **Legacy CP numbering (M21–M58 in phase-1.6 / phase-2.0 docs) is a parallel taxonomy, NOT this roadmap.** The read-only Backend Control Plane already drafted in DEV is **absorbed into M4** (login/session + admin shell) and **M8** (hardening). Its numbering is superseded by M0–M9.
2. **Controlled WRITE actions (phase-3.0 pilot) land in M7 verticals**, explicitly beyond the read-only M4 Backend CP — so write-action work has a clean milestone home and does not leak into M4.
3. **No production-critical item is without a milestone home.** The only truly homeless items are frontend enhancements (post-production) and tooling (out-of-scope).
