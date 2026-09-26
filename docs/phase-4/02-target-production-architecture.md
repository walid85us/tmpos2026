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

## 2.1. Deployable production entry

**Stage M6-ENTRY-P1 (code-only, not deployed).** The deployable runtime entry (`server/entry/productionEntry.ts`) assembles the two production composition roots (the session/identity boundary and the transaction kernel), checks every startup precondition read-only except step 8, which registers the rate-limit key's fingerprint when none exists ([08](./08-production-gate-and-risk-register.md) DA-53, DA-57), and only then binds the listener. The entry serves the administrative boundary only:

**Shipping routes (8 routes + bounded 404):**
- `GET /health` — public operational probe (untimed)
- `GET /readiness` — public readiness probe (503 if any dependency it probes is unavailable — see Health and readiness below; does not terminate the process)
- `POST /admin/v1/session/login` — exchange Firebase ID token for admin session cookie. *M5-ADMIN-STEPUP-P1:* sent with `X-TMPOS-Reauthenticate: 1` it is a reauthentication, which after every ordinary login step rotates the session only if the presented cookie authenticates as a valid (unexpired, unrevoked) session of the same principal whose security version equals this login's admission version, and otherwise answers the generic 401 — those checks run after the ordinary login steps and create and revoke nothing, while an admission denial at the ordinary step still ends every session of that principal ([03 §2a](./03-backend-control-plane-login-session-blueprint.md), [ADR-28](./10-architecture-decision-records.md)); the route inventory is unchanged
- `GET /admin/v1/session` — current admin session (no tenant session reaches this)
- `POST /admin/v1/session/logout` — invalidate admin session
- `GET /admin/v1/tenants` — read admin directory under `view_tenants` permission
- `PATCH /admin/v1/tenants/display-name` — update tenant name under `edit_tenant_profile` permission, requires idempotency key
- `PATCH /admin/v1/tenants/status` — change tenant status (active ↔ suspended) under `change_tenant_status` permission, requires recent admin authentication and idempotency key
- Anything else → bounded 404. A request whose Host is missing or not the admin host is refused before the rate limiter (no bucket spent); an unknown path on the admin host spends its request limit first, then gets the same 404

**Startup order (10 bounded steps, deadline 15 s per step):**
1. Configuration validation (`validateEntryConfig`) — required env vars (NODE_ENV, PORT, DATABASE_CA_CERT, APP_DATABASE_URL, RATE_LIMIT_KEY, IDEMPOTENCY_KEY, TRUSTED_PROXY_CIDRS, SESSION_ADMIN_ORIGINS, FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON), bounds checked, no values logged
2. Database client creation — TLS verified against DATABASE_CA_CERT; nothing connects yet
3. Database connectivity probe — one SELECT 1 on the app login; fails if TLS cannot verify, endpoint unreachable, credential refused
4. Runtime login validation (preflight) — app login's role attributes (not superuser, NOBYPASSRLS, NOCREATEROLE, etc.), memberships (tmpos_app, tmpos_audit_writer), owned objects, and the one direct privilege (SELECT on public.schema_migrations — new G-DBROLE requirement)
5. Migration ledger validation (preflight) — public.schema_migrations must be exactly 001–015 in order (015 since M5-ADMIN-REVOKE-P1), all finished, no dirty rows, every checksum pinned; nothing is applied, rolled back or repaired
6. Sessions and transactions composition — admin boundary only (SESSION_TENANT_ORIGINS not read); served route inventory validated against SHIPPING_ROUTES exactly; any missing or extra route refuses
7. Dependency probes — the idempotency store and the command-transaction port answer their read-only probes
8. Rate-limit key fingerprint registration and validation — migration 014 registers the fingerprint atomically when none exists, rejects mismatches, refuses if store is read-only or unreachable; registration happens before any request can spend an allowance
9. Readiness checks — the session store answers a read of a random key that names no session (this one startup read is its only probe: `/readiness` does not ask it), the admin admission probe answers, and the composed rate limiter is ready
10. Listener binding — only after all above; once bound, readiness turns ready and the startup is logged `startup_ready`

**Required configuration (environment variable names only; values not read at startup display or logs):**
- `NODE_ENV` (must equal `"production"`)
- `PORT` (unsigned integer)
- `APP_DATABASE_URL` (classified as a direct Postgres endpoint or session pooler on port 5432 at `db.*.supabase.co` or `*.pooler.supabase.com`)
- `DATABASE_CA_CERT` (PEM-encoded root certificate)
- `RATE_LIMIT_KEY` (base64url-encoded 32–64 bytes)
- `IDEMPOTENCY_KEY` (base64url-encoded 32–64 bytes, distinct from `RATE_LIMIT_KEY` — the same key is refused, `idempotency_key_shared`)
- `TRUSTED_PROXY_CIDRS` (a non-empty comma-separated CIDR list; absent or `none` is refused, `trusted_proxies_missing` — production always sits behind the edge's proxies)
- `SESSION_ADMIN_ORIGINS` (exactly one canonical `https://` origin matching the admin hostname; its host must be a DNS name the runtime can serve — an IP literal is refused here, `session_admin_origin_invalid`, not at composition)
- `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` (valid Firebase Admin SDK service account JSON: `type: "service_account"`, `project_id`, `client_email`, RSA PKCS8 `private_key`)

**Refused when set (switches and credentials read past every check above; each refusal names the field and its code, never the value):**
- `PGSSL` → `driver_tls_override_forbidden` (the driver's environment fallback for its TLS option; the client's explicit verified TLS already outranks it, and the refusal makes that conflict visible)
- `ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW`, when armed (any value but empty or `false`) → `production_dev_flag_conflict` (a DEV action flag is never armed in production)
- `FIREBASE_AUTH_EMULATOR_HOST` → `identity_emulator_forbidden` (the Firebase Admin SDK would accept unsigned tokens)
- `NODE_TLS_REJECT_UNAUTHORIZED` → `tls_verification_override_forbidden` (Node would stop verifying the provider's certificates)
- `NODE_EXTRA_CA_CERTS`, or `NODE_OPTIONS` carrying `--use-openssl-ca` → `tls_trust_store_override_forbidden` (either widens the trust store the provider's certificates are verified against; the database client passes its own `ca` and is unaffected)
- `SUPABASE_DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` → `owner_credential_forbidden` (the process holds the runtime login alone; the owner/migration principal and the provider's service-role key never sit beside it — [08](./08-production-gate-and-risk-register.md) DA-58)

**Database login privilege requirements (G-DBROLE runtime provisioning):**
The app login (`APP_DATABASE_URL`'s user) must hold:
- Role attributes: `LOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `NOBYPASSRLS`
- Memberships: `tmpos_app` (inherited), `tmpos_audit_writer` (inherited) — no ADMIN OPTION
- Direct privilege: `SELECT` on `public.schema_migrations` (no grant option) — this single direct privilege is new and must be provisioned by G-DBROLE; no migration grants it
- Owns nothing; no CREATE or TEMPORARY on the database; no CREATE on any schema

**Admin host boundary (real-edge requirement, not proven here):**
Every request but `/health` and `/readiness` must carry a `Host` header exactly matching the entry's allowlist (derived from SESSION_ADMIN_ORIGINS; e.g., `admin.m6ep.test`). Case-insensitive comparison; `X-Forwarded-Host` is never read. A request with no Host or a mismatched Host gets a bounded 404 before the rate limiter is consulted. A malformed or empty Host list is not a request outcome: it refuses startup (`host_invalid`), and an admin origin whose host could not be served is already refused in configuration. This requires the real edge (a proxy or load balancer in front of the runtime) to route only the admin hostname to this entry and pass the Host header unaltered, or to reject any other hostname — not proven at this stage (G-UNAUTH dependency). The listener pins Node's strict HTTP parser (`insecureHTTPParser: false`, `server/runtime/app.ts`), so a process-wide `--insecure-http-parser` does not loosen it.

**Health and readiness behavior:**
- `/health`: always 200 OK, untimed. Like every response, probes included, it gets one bounded info `request` log line. Does not gate shutdown; the process stays alive on any dependency outage.
- `/readiness`: 200 OK when the rate limiter, the idempotency store, the command-transaction port and the administrative admission answer their probes; 503 Service Unavailable otherwise. The session store is not probed by `/readiness`: it is read once, at startup (step 9). Used by orchestrators to remove the instance from rotation. A 503 readiness never stops the process: a dependency outage leaves it running, answering 503 while any probed dependency is unavailable. The causality runs the other way only at shutdown — a shutdown signal turns readiness unavailable first, then drains.

**Graceful shutdown sequence (signal handling, max 10 s total):**
1. On SIGTERM or SIGINT, readiness turns unavailable immediately (removes instance from rotation)
2. Startup is aborted if still in progress: the step in flight is abandoned and no listener remains open — a socket that binds after the signal (a late bind) is closed at once
3. Server stops accepting new connections; in-flight requests drain (each bounded by its own deadline, typically 3 s)
4. Transaction kernel ends within RETIRED_POOL_GRACE_S (5 s fixed)
5. Process exits with code 0
6. If any operation takes longer than SHUTDOWN_FORCE_TIMEOUT_MS (10 s), the process exits with code 1 and logs `shutdown_forced`
7. Repeated signals are coalesced into one shutdown sequence

**Startup failure categories (never reachable, no listener left open):**
- `config_invalid` — configuration field(s) missing or invalid; each field carries a bounded code (e.g., `port_invalid`)
- `database_tls_invalid` — client TLS setup failed (bad cert, wrong format)
- `database_unavailable` — endpoint unreachable or unresponsive; step 3, 4, or 5 cannot complete
- `database_login_unsafe` — app login violates the approved runtime boundary (superuser, BYPASSRLS, etc.); step 4 found violations. Its codes include `role_membership_unexpected` (a privilege role itself holds a membership), `foreign_database_dependency` (another database of the cluster names the login or a privilege role) and `public_privilege_unexpected` (PUBLIC holds a relation or column privilege, can execute a SECURITY DEFINER routine, or is named by a policy in the application's schemas, `public` and `tmpos_*`)
- `migration_state_invalid` — ledger missing, dirty, mismatched checksum, or out of order; step 5 found violations. `migration_ledger_malformed` covers a row of the wrong shape and a second row for one version
- `composition_refused` — session or transaction root refused to compose (missing adapters, invalid key, etc.)
- `route_inventory_mismatch` — runtime's served routes differ from SHIPPING_ROUTES
- `dependency_unready` — a probe at step 7 or 9 did not answer ready; its codes name each one: `idempotency_store`, `command_transactions`, `session_store`, `admin_admission`, `rate_limiter` (step 8 never yields it)
- `rate_limit_key_mismatch` — registered fingerprint mismatches; step 8
- `rate_limit_store_read_only` — step 8 cannot write the fingerprint
- `rate_limit_store_unavailable` — step 8 cannot reach the store
- `rate_limit_probe_malformed` — step 8 probe returned invalid data
- `listen_failed` — step 10 socket binding failed, or its step deadline passed (`listen_timeout`; a socket that binds after that is closed at once)
- `startup_failed` — unexpected uncaught exception during startup

**No automatic migration policy:**
The entry verifies the migration ledger; it never applies, rolls back or repairs migrations. Management of migrations is a separate provisioning step executed only by authorized operators using the migration runner.

**Construction boundary:**
The entry is composed only through the production constructor in `server/entry/main.ts` when executed directly. The configuration is the process environment. The construction passed is `PRODUCTION_CONSTRUCTION`, which builds: the verified-TLS database client from the classified APP_DATABASE_URL endpoint, the Firebase Admin SDK behind the Firebase adapter for identity verification, and the configured PORT on every interface. A disposable-database harness substitutes the database client (connecting to an ephemeral Postgres), the token verifier (synthetic), and the listen port (loopback). No testkit, mock or fake is reachable from `server/entry/productionEntry.ts` itself; testing uses separate test files with their own harnesses.

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
| Permission level | Server canonical authorization service (family-aware permission contract, [04](./04-canonical-iam-and-four-user-migration.md)) | client `sessionStorage('platform_permissions_v1')` |
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

- **Session, rate-limit and idempotency backing stores:** distributed rate limits (component 13) are counted in PostgreSQL first (migration 014, [ADR-26](./10-architecture-decision-records.md)); a shared cache such as Redis stays a possible later replacement behind the same port, only if measured traffic or latency justifies it. Server sessions and their revocation are PostgreSQL state too (migration 011, M5-GIAM-D1-P2-R1). Durable idempotency records and the transactional outbox are PostgreSQL state committed in the business transaction ([ADR-17](./10-architecture-decision-records.md)) — a cache is never their sole authority. The current in-memory/process-local stores do not survive restart or scale across instances (GAP-15) and are replaced here.
- **Data tier scaling:** connection pooling for the API app role; read replicas for read-heavy governance/reporting (M7h) surfaces; a caching layer for hot read-models with explicit invalidation. Concrete latency/throughput targets are set in gate **G-PERF** (M8).
- **Web/transport hardening (both SPAs, admin especially):** Content-Security-Policy, `frame-ancestors`/X-Frame-Options (clickjacking), HSTS, and output-encoding/DOM-XSS controls. An HttpOnly session cookie is **not** sufficient on its own: a same-origin XSS can still ride the cookie, and CSRF double-submit does not defend against same-origin XSS — so XSS controls are part of the trust model, gated by **G-WEBHARDEN** ([03 §2 req 20](./03-backend-control-plane-login-session-blueprint.md)).
- **Sidecar elimination:** the DEV Express sidecars (with the open `label-proxy` SSRF and the unauthenticated identity write) are eliminated/firewalled in **M3**, not deferred to M8 — no unauthenticated route is reachable in any deployed environment.
