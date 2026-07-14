# 02 — Target Production Architecture

**Scope:** the target production system, its trust boundaries and data flows, and the explicit sources of truth vs prohibited authorities. Design-only; no implementation. Rationale for the major choices is in [10 ADRs](./10-architecture-decision-records.md).

## 1. Core principle

Authority moves from the browser to the server. Today the browser holds the role and `sessionStorage` holds entitlements/permissions; both must become **server-derived and server-enforced**. The client becomes a rendering layer that *displays* what a server-issued, canonical authorization context permits — it never *establishes* it.

## 2. Target components

| # | Component | Responsibility | Trust |
|---|---|---|---|
| 1 | **Tenant/Store SPA** (frontend) | Store operations UI. Sends session cookie; renders server-authorized data. | Untrusted input source |
| 2 | **Backend Control Plane SPA** (separate surface) | Platform/admin UI. Distinct login + admin session. Sends admin cookie. | Untrusted input source |
| 3 | **Public/Tenant API runtime** | Server-authoritative tenant/store business API. Verifies session, derives authorization, enforces tenant/store scope. | Server-trusted |
| 4 | **Administrative API runtime** | Backend CP API. Separate auth boundary, admin session, canonical platform authorization, controlled actions. | Server-trusted, higher-privilege |
| 5 | **Canonical Postgres data layer** | Source of truth for identity, authorization, entitlements, audit, and (via M7) all business domains. | Authoritative store |
| 6 | **Firebase Auth (identity provider)** | Authentication only. ID-token verification at the **server** login exchange. | Trusted for *authentication*, never *authorization* |
| 7 | **Server session manager** | Issues/rotates/revokes HttpOnly session cookies (tenant + admin, separate). | Server-trusted |
| 8 | **Canonical authorization service** | Resolves the effective authorization context from Postgres (identity → membership → role → permission → entitlement → status). Deny-by-default. | Authoritative |
| 9 | **Durable audit** | Append-only `audit_event` writer wired into every authorization/mutation path. | Authoritative, immutable |
| 10 | **Job/event processing (outbox)** | Transactional outbox → async workers (provider sync, webhooks, notifications). | Server-trusted |
| 11 | **Provider integration boundary** | The only egress to external carriers/**payment providers**/integrations. Allowlisted hosts, verified webhooks, no request-controlled URLs. **Card data is collected only by provider-hosted/certified components — never proxied through TM POS2026** ([05 §5](./05-canonical-data-ownership-and-api-db-contracts.md)). | Egress control point |
| 12 | **Secret & credential storage** | Encrypted secrets/provider credentials. No secrets in process memory or unauthenticated endpoints. | Authoritative, encrypted |
| 13 | **Idempotency & rate limiting** | Durable, shared-store idempotency keys + distributed rate limits. | Server-trusted |
| 14 | **Observability & alerting** | Metrics, logs (redacted), traces, SLOs, alerts. | Operational |
| 15 | **Backup & DR** | Backups, restore rehearsal, PITR. | Operational |

## 3. Trust boundaries

```
                          UNTRUSTED (browser)
  ┌────────────────────┐            ┌──────────────────────────────┐
  │  Tenant/Store SPA  │            │  Backend Control Plane SPA   │
  │  (tenant cookie)   │            │  (admin cookie, separate)    │
  └─────────┬──────────┘            └───────────────┬──────────────┘
   ─────────┼───────────── TRUST BOUNDARY ──────────┼───────────────
            ▼                                        ▼
  ┌────────────────────┐            ┌──────────────────────────────┐
  │  Public/Tenant API │            │      Administrative API      │
  │  session verify →  │            │  admin session verify →      │
  │  canonical authz → │            │  canonical platform authz →  │
  │  tenant/store scope│            │  controlled actions          │
  └─────────┬──────────┘            └───────────────┬──────────────┘
            └───────────────┬────────────────────────┘
                            ▼
        ┌───────────────────────────────────────────┐
        │  Canonical authz svc · Durable audit ·     │
        │  Idempotency · Outbox                      │
        └───────────────────┬───────────────────────┘
                            ▼
        ┌───────────────────────────────────────────┐
        │  Canonical Postgres (RLS + scoped app role)│
        └───────────────────────────────────────────┘

  Firebase Auth ──(ID token verified at server login exchange ONLY)──► Session manager
  Provider egress ──(allowlisted hosts, verified webhooks)──► External carriers
```

Key boundaries:
- **Browser ↔ API:** every browser input is untrusted. The API verifies the session cookie server-side and derives authorization from Postgres. A client-supplied `role`, `tenantId`, `storeId`, plan, or permission is **request context at most**, never authority.
- **Tenant API ↔ Admin API:** distinct auth boundaries and session cookies. A tenant session can never reach admin endpoints; an admin session is not the tenant session ([03](./03-backend-control-plane-login-session-blueprint.md)).
- **API ↔ Postgres:** the API connects as a **scoped application role** (not the table owner) so RLS is enforceable for tenant/store paths; privileged migrations/admin use a separate role. (Today the sidecar connects as owner and bypasses RLS — see [01](./01-current-state-inventory-and-gap-matrix.md) GAP-17.)
- **API ↔ Providers:** a single egress boundary with host allowlists and webhook signature verification. No endpoint fetches a request-controlled URL (closes GAP-03 SSRF).

## 4. Data flows

**Login (both surfaces, separate):** SPA obtains a Firebase ID token → POSTs it to the *server* login exchange → server `verifyIdToken(token, checkRevoked=true)` → looks up canonical identity + membership + status → issues an HttpOnly/Secure/SameSite session cookie → returns a sanitized session/whoami. The token is never stored in `localStorage`/`sessionStorage` and never appears in a URL.

**Authorized read/write:** SPA calls the API with the session cookie → server verifies session → resolves the **canonical authorization context** from Postgres → enforces tenant/store scope + permission threshold + entitlement + status (deny-by-default) → executes inside a transaction → writes an append-only audit event → returns a bounded response envelope.

**Provider action (e.g., buy label):** tenant API authorizes → enqueues via the outbox → a worker calls the provider through the egress boundary (allowlisted host, stored encrypted credential) → records the result + audit. No browser-supplied URL is ever fetched.

## 5. Sources of truth vs prohibited authorities

| Concern | Canonical source of truth (target) | Prohibited as authority |
|---|---|---|
| Authentication | Firebase ID token verified at server login exchange | client-asserted identity |
| Identity / membership / role | Postgres `platform_identity` / `app_user` / `user_membership` | Firestore `users/{uid}.role` as an authorization input |
| Permission level | Server canonical authorization service (unified catalog, [04](./04-canonical-iam-and-four-user-migration.md)) | client `sessionStorage('platform_permissions_v1')` |
| Plan / feature entitlement | Postgres `tenant_feature_entitlement` (server-materialized) | client `sessionStorage('features_data')` / `tenant_overrides_data` |
| Account status | Postgres `app_user.status` / membership status | hardcoded `status:'active'` |
| Tenant / store scope | Server-derived from membership | client-supplied `tenantId`/`storeId` (context only) |
| Business data | Postgres domain tables (M7) | in-memory `SEED_*` / `mockData` |
| Audit | Postgres append-only `audit_event` | client `sessionStorage('audit_logs')` (forgeable) |
| Session | Server-issued HttpOnly cookie | client-held Firebase session as the app session |
| Card data | provider-hosted collection; TM POS2026 holds only opaque payment-method tokens | raw PAN/CVV/track/PIN in the app, storage, logs, or browser |
| Data-subject requests (DSAR) | server-authorized, identity-verified, cross-domain, audited ([05 §6](./05-canonical-data-ownership-and-api-db-contracts.md)) | client-asserted request identity/scope |
| Payment gateway connection | **store-owned**, scoped `(tenant_id, store_id, provider_key, environment)` from the canonical session; platform governs only the connector catalog ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)) | provider account identifier as authority; client-supplied `storeId`; a System-Owner-supplied store credential |

## 6. Environments

| Env | Purpose | Data | Notes |
|---|---|---|---|
| **local** | developer inner loop | seed/fixtures | emulators (Firestore, DB); no live providers |
| **test/CI** | automated pyramid ([07](./07-quality-and-test-strategy.md)) | ephemeral | Java-enabled Firestore emulator gate; DB per run |
| **staging** | pre-prod parity | anonymized/synthetic | full topology; provider sandboxes; migration rehearsal |
| **production** | live | real | separate secrets; least-privilege; monitored |

Promotion is gated by CI + the [08 production-gate register](./08-production-gate-and-risk-register.md). Deployment/go-live is a separate owner authorization after M9.

## 7. What this architecture deliberately keeps

- **Firebase remains the authoritative authentication provider.** Supabase remains dormant; the `identity_link` table exists but is unwired — no cutover is proposed by M1.
- **Static-hosting option for the SPAs is preserved**, but the SPAs now talk to a **deployed API** (M3) instead of assuming client authority. The Backend CP is a **separate surface/host** ([03](./03-backend-control-plane-login-session-blueprint.md)).
- **The existing durable schema** (identity/authz/audit) is the seed of the canonical layer; business tables are added per-domain in M7 ([05](./05-canonical-data-ownership-and-api-db-contracts.md), [06](./06-module-migration-map-m7.md)).

## 8. Scalability, capacity & web hardening

The package is security/correctness-first; the following are named so they are not omitted (detailed sizing is M3/M8):

- **Session & idempotency backing store:** a shared in-memory store (e.g. Redis) backs server sessions, the revocation list, durable idempotency keys, and distributed rate limits (component 13). The current in-memory/process-local stores do not survive restart or scale across instances (GAP-15) and are replaced here.
- **Data tier scaling:** connection pooling for the API app role; read replicas for read-heavy governance/reporting (M7h) surfaces; a caching layer for hot read-models with explicit invalidation. Concrete latency/throughput targets are set in gate **G-PERF** (M8).
- **Web/transport hardening (both SPAs, admin especially):** Content-Security-Policy, `frame-ancestors`/X-Frame-Options (clickjacking), HSTS, and output-encoding/DOM-XSS controls. An HttpOnly session cookie is **not** sufficient on its own: a same-origin XSS can still ride the cookie, and CSRF double-submit does not defend against same-origin XSS — so XSS controls are part of the trust model, gated by **G-WEBHARDEN** ([03 §2 req 20](./03-backend-control-plane-login-session-blueprint.md)).
- **Sidecar elimination:** the DEV Express sidecars (with the open `label-proxy` SSRF and the unauthenticated identity write) are eliminated/firewalled in **M3**, not deferred to M8 — no unauthenticated route is reachable in any deployed environment.
