# 10 — Architecture Decision Records

Concise ADRs for the major structural choices in this package. Each: **Context → Decision → Consequences**. Status is **Proposed** (M1 is planning; decisions are ratified as their milestone executes).

---

## ADR-01 — Server-authoritative authorization; demote client role to render-only
**Context:** Live authorization is 100% client-side — `role` comes from a client-read Firestore field, entitlements/permissions from client `sessionStorage`; there is no server re-check ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-01/12).
**Decision:** The server derives the effective authorization context from canonical Postgres on every request (deny-by-default). The client role/entitlement/status becomes render-only and is never an authorization input.
**Consequences:** Requires the deployed API (M3) + canonical IAM (M5). Closes G-CLIENTAUTH/G-IAM. The SPA can still be statically hosted but must call an authorized API rather than assume authority.

## ADR-02 — Separate Backend Control Plane login & session boundary
**Context:** No server session exists; the DEV Backend CP entry gate is a bare boolean ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-02). The Backend CP governs the whole platform.
**Decision:** A distinct admin login exchange (Firebase ID token verified server-side once) issues a **separate** HttpOnly/Secure/SameSite admin session cookie with CSRF, MFA, and step-up; it never reuses the tenant session ([03](./03-backend-control-plane-login-session-blueprint.md)).
**Consequences:** Two auth boundaries and two cookies; a dedicated admin origin/subdomain preferred. Closes G-CPLOGIN. Delivered M4.

## ADR-03 — Postgres canonical; Firebase for authentication only; Supabase dormant
**Context:** Firebase is the authoritative auth provider; Postgres holds identity/authz/audit; Supabase is dormant with an unwired `identity_link`.
**Decision:** Postgres is the canonical source of truth for identity, authorization, entitlements, audit, and (via M7) business data. Firebase is used for **authentication only**, verified at the server login exchange. **Supabase stays dormant; no cutover in Phase 4.**
**Consequences:** No provider migration risk in this phase. `identity_link` remains unwired until a separately-authorized future decision.

## ADR-04 — Unify the permission-level ordering into one catalog
**Context:** Tenant code orders `manage < approve`; platform code orders `approve < manage` and says *"Do not unify them"* ([04](./04-canonical-iam-and-four-user-migration.md) §3, GAP-11).
**Decision:** Adopt one canonical ordering `none → view → create → edit → approve → manage → full` (approve below manage) in a single shared catalog; migrate the tenant comparator.
**Consequences:** Eliminates a correctness hazard where the same level names sort differently — but the flip is **not** grant-neutral: under the new order every tenant `manage`-holder now satisfies `approve` thresholds it previously did not (e.g. `manager` gains `refunds:approve` / `returns:approve_return`). Therefore the migration **requires** re-pinning affected `approve`-gated money actions to `≥ manage`/explicit grant, a before/after grant-diff report, explicit owner approval, deny-by-default on unknowns, dual-read shadow evaluation, and per-action regression tests ([04 §3](./04-canonical-iam-and-four-user-migration.md)). Delivered in M5 (phase i).

## ADR-05 — Move entitlements & permissions off `sessionStorage` into server storage
**Context:** Plan/feature entitlements and platform permissions are client `sessionStorage` and forgeable; the System Owner can reshape entitlements with no server write ([01](./01-current-state-inventory-and-gap-matrix.md) §C, GAP-12).
**Decision:** Materialize entitlements into `tenant_feature_entitlement` (source ∈ plan/default/manual) and move platform permission overrides to server-owned storage; the client keeps only a read-only projection.
**Consequences:** Closes G-ENTITLE. Delivered M5 (with M7f for the plan/feature catalog).

## ADR-06 — Durable append-only audit as the single audit source
**Context:** `auditEventWriter` is built but unwired; the owner "audit log" is forgeable `sessionStorage`; the system produces zero durable audit ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-07).
**Decision:** Wire the append-only `audit_event` writer into every authorization/mutation path; the immutability trigger (rejects UPDATE/DELETE for all roles) is the integrity guarantee. The forgeable client "audit log" is replaced by reads over `audit_event`.
**Consequences:** Closes G-AUDIT. Until wired (M6) the platform has no compliance trail — a hard gate before authoritative authorization goes live.

## ADR-07 — Single provider egress boundary (SSRF elimination, secret encryption, webhook verification)
**Context:** `GET /api/shipping/label-proxy?url=` fetches arbitrary URLs; the Shipping API is unauthenticated and holds live keys in process memory; webhooks are unverified ([01](./01-current-state-inventory-and-gap-matrix.md) §E, GAP-03/04/06/14).
**Decision:** All external provider egress goes through one boundary with **host allowlists** (no request-controlled URL), **encrypted stored credentials**, and **webhook signature verification**; provider calls run via the outbox/workers.
**Consequences:** Closes G-SSRF/G-SECRETS/G-WEBHOOK/G-PROVIDER. Delivered M7e/M8 (design M3).

## ADR-08 — Deployable backend runtime, migration runner, scoped app role + RLS
**Context:** Production is a static SPA with no backend; migrations are applied manually; the DB connection is the owner role bypassing RLS ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-16/17).
**Decision:** Stand up a deployed server runtime with environments (local/test/staging/prod), a migration runner, a secrets store, and **connection-role separation** — a scoped app role (RLS-bound) for tenant paths, a separate privileged role for migrations/admin, with tenant/store RLS policies.
**Consequences:** Closes G-MIGRATE/G-DBROLE and enables every server-authoritative gate. Delivered M3.

## ADR-09 — M7 vertical-slice migration order (Customers/Employees first, governance last)
**Context:** All business domains are in-memory mock; they have reference dependencies (sales→customers, repairs→inventory, shipping→orders, governance→everything).
**Decision:** Migrate in dependency order — **M7a** Customers/Employees first; **M7b** POS/Sales/Invoices/Payments; **M7c** Inventory/Supply Chain; **M7d** Repairs/Services/Warranty/Returns; **M7e** Shipping; **M7f** Billing/Plans/Entitlements; **M7g** Settings/Domains/Integrations; **M7h** Command Center/Support/Audit read-models **last** ([06](./06-module-migration-map-m7.md)). The owner-fixed labels put POS (M7b) before Inventory (M7c), yet POS decrements stock; this is resolved by **shipping M7b POS with authoritative stock-decrement deferred until M7c** rather than relabelling.
**Consequences:** Respects FK dependencies; each sub-slice is **independently releasable with its own rollback gate** and a data backfill/cutover + "no mock path remains" check ([06 §1](./06-module-migration-map-m7.md)); ships with its own tests, scoping, transactions, idempotency, and audit. Closes G-PERSIST incrementally.

## ADR-10 — Firestore emulator semantic evidence is a mandatory pre-deploy gate
**Context:** M0 shipped a **static** rules guard only (21/21); the emulator semantic suite is unexecuted because Java was unavailable (GAP-18, G-EMU).
**Decision:** Stand up a Java-enabled environment in M2; the emulator semantic suite becomes a **repeatable CI gate** that must pass before any Firestore-rules deployment or go-live. The static guard is retained as a fast pre-check.
**Consequences:** Closes G-EMU as a gate (not a one-off). No rules deploy without a green emulator run.

## ADR-11 — Integrated payment capability is in scope (DECIDED)
**Context:** This is a POS with `order`/`payment`/`refund`; the owner has decided the payment model ([01](./01-current-state-inventory-and-gap-matrix.md) GAP-26, gate G-PCI).
**Decision:** TM POS2026 supports **cash + external-terminal/manual-reference + integrated card-present via a PCI-certified semi-integrated terminal/provider + hosted/tokenized CNP**. Card data is collected only by provider-hosted/certified components; TM POS2026 stores only **opaque payment-method tokens** and **never** receives/stores/logs/exposes PAN/CVV/track/PIN/unencrypted CHD or processor credentials in browser storage. The payment contract ([05 §5](./05-canonical-data-ownership-and-api-db-contracts.md)) covers auth/capture/settlement/void/refund/dispute/reconciliation, verified webhooks, idempotency + duplicate-charge prevention, credential encryption/rotation, provider-outage behavior, and terminal/device→tenant/store scope. The specific provider is selected **in M7b** by documented criteria (not a hidden future milestone).
**Consequences:** G-PCI remains a production BLOCKER until provider selection + integration + evidence + PCI-category validation pass; but the architectural direction is DECIDED. **No SAQ category (SAQ A / P2PE / other) is claimed until the final integration architecture establishes eligibility** — confirmed with the provider/acquirer/QSA.

## ADR-13 — Privacy & DSAR foundation is in scope (DECIDED — implement, not exclude)
**Context:** A multi-tenant SaaS holding customer/employee PII needs a data-rights foundation; the owner has decided to implement it (gate G-PRIVACY).
**Decision:** Build a production privacy/DSAR foundation ([05 §6](./05-canonical-data-ownership-and-api-db-contracts.md)) — data inventory/classification, tenant-controller/platform-processor split, identity verification, tenant approval + platform escalation, cross-domain discovery, export/correction/deletion-anonymization (where legally permitted), retention/legal-hold/restriction/portability, provider propagation, immutable audit, deadline/status, failure/partial handling, backup limitations — distributed across **M1 (contracts) → M5 (authz) → M6 (audit/workflow/retention) → M7a–h (domain behavior) → M8 (ops) → M9 (evidence + legal sign-off)**, with **no new milestone**.
**Consequences:** G-PRIVACY remains a production gate until implementation + evidence + legal-owner sign-off pass. **No universal-compliance claim is made**; final policy and jurisdictional obligations require owner/legal review.

## ADR-14 — M7b→M7c inventory obligation (outbox) prevents silent divergence
**Context:** The owner-fixed order runs POS (M7b) before Inventory (M7c), yet POS decrements stock; a "deferred decrement" must not let a sale silently diverge from inventory (gate G-INVENTORY-CONSISTENCY).
**Decision:** At sale completion, **M7b writes a durable, transactional, idempotent `inventory_obligation` (outbox)** rather than claiming a decrement; inventory-tracked production sale completion is **feature-disabled / non-inventory mode** until **M7c consumes the obligation and reconciliation passes**, at which point the block lifts. Invariant: **no production sale may claim inventory was decremented unless a durable, transactional, idempotent inventory mutation OR obligation exists and reconciliation passes.**
**Consequences:** Resolves the inventory→POS dependency without reordering the owner-fixed M7b/M7c labels and without silent divergence; adds a blocking M7b→M7c dependency gate.

## ADR-15 — G-HIST is a historical evidence limitation with an M8 investigation + M9 acceptance path
**Context:** M0 could not disprove pre-fix Firestore exploitation; leaving it an undefined blocker risks an unprovable gate.
**Decision:** Reframe G-HIST as a **historical evidence limitation, not a waivable active vulnerability**. **M8** performs a bounded **read-only** attempt to retrieve existing authorized historical evidence **without enabling new retroactive collection**; if present, classify it. **M9** — if no reconstructing evidence exists — records an explicit **owner risk acknowledgement** (exposure window existed; current state showed no privileged mismatch; Firestore `auditEvents` empty; historical non-exploitation unprovable; fail-closed rules active; compensating controls + monitoring established).
**Consequences:** Gives an unprovable historical question a defined, bounded, honest disposition instead of an open-ended blocker; the current fail-closed posture and compensating controls carry the risk forward transparently.

## ADR-12 — Two server sessions in M4; minimal audit before M5; M5 runs in internal phases
**Context:** The tenant app also needs server-side identity/session (not only the Backend CP), M5 performs audited provisioning while durable audit was scheduled for M6, and M5 bundles the entire IAM system as the hard dependency for all of M7.
**Decision:** M4 delivers **two separate server session boundaries** (tenant + admin) sharing one canonical catalog/status model ([03 §1a](./03-backend-control-plane-login-session-blueprint.md)); a **minimal durable audit writer** lands in M3/M4 so M5's provisioning/grant changes are audited before the full audit machinery in M6; and M5 executes in **three ordered internal phases: (i) authz service + ordering unification → (ii) entitlement/permission storage move → (iii) status/parity + four-user migration + isolation** — execution phasing within M5, not new milestones.
**Consequences:** Removes the "Firebase-auth-only re-trusts the client" hole, the M5↔M6 audit-ordering contradiction, and the single-giant-M5 blast radius, without adding milestones outside M0–M9.

## ADR-16 — Store-owned payment gateway connections with a platform-governed connector catalog (DECIDED)
**Context:** The existing Shipping provider pattern configures provider credentials in an **unauthenticated, global, in-memory credential store keyed by provider id only** (no tenant/store scope) — a pattern that must not be repeated for payments. The owner has directed that payment-gateway connections are configured at the **store** level, not by the System Owner.
**Decision:** Payment-gateway connections are **owned and configured by the store** (Store Owner, or another store user with an explicit canonical `manage_payment_gateway_connections` permission, [04 §2.1](./04-canonical-iam-and-four-user-migration.md)), under **Store Settings → Payments** — never supplied, retrieved, or normally viewed by the System Owner. The **System Owner Backend CP governs only the connector catalog + security policy** (available providers, env/region availability, minimum versions, bounded health, global incident disablement, plan eligibility, audited break-glass) — [03 §8](./03-backend-control-plane-login-session-blueprint.md). Every connection is scoped to `(tenant_id, store_id, provider_key, environment)`; OAuth/provider-hosted onboarding is preferred (no browser secret); any unavoidable secret is envelope-encrypted server-side with only a reference stored ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)). The initial connector catalog targets **Stripe / Square / Adyen** (M7b-verified for launch market/hardware/PCI). Two model invariants are pinned ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)): **OAuth callback binding** (`state`/PKCE/exact-redirect-URI-allowlist/account→initiating-session) and **connector-catalog endpoint integrity** (endpoints/OAuth-URLs/webhook-hosts are code-shipped/reviewed/egress-allowlisted, not admin-free-form; catalog mutation is a step-up + reason + durable-audit action) — closing connection-CSRF/auth-code-injection and the compromised-catalog route back to platform-scale credential theft.
**Consequences:** Reuses the Shipping *interaction model* (UX pattern only — credential routes, webhook handling, audit, and permission checks use the M6 standard, **not** the Shipping code path; the Shipping M7e remediation is parallel cleanup, not a prerequisite for payment security) (Settings tab, active-provider summary, provider cards, expandable connection panel, test/prod choice, **server-proxied Test Connection**) while explicitly rejecting its unsafe traits (unauth routes, global RAM secret store, no store scope, SSRF, env-gated webhook-verification bypass, generic role gating, no audit). Shipping is upgraded to the same credential/security standard in **M7e** — no new milestone. G-PCI's acceptance criteria now include store-owned config + canonical permission + credential/multi-store isolation.

---

**Reconciliation note:** the legacy Backend Control Plane numbering (phase-1.6 M21+ / phase-2.0 M24–M58) is **superseded** by the M0–M9 roadmap; the read-only CP is absorbed into M4+M8 and controlled write actions into M7 verticals ([09](./09-roadmap-m0-m9.md) §3).
