# TM POS2026 — Teal Metrics

[![CI](https://github.com/walid85us/tmpos2026/actions/workflows/ci.yml/badge.svg)](https://github.com/walid85us/tmpos2026/actions/workflows/ci.yml)

<!-- ![TM POS2026 screenshot](docs/assets/screenshot.png) -->

> Screenshot placeholder. Save a screenshot or GIF of the running app as `docs/assets/screenshot.png`, then uncomment the image line above this note.

## Description

TM POS2026 (Teal Metrics) is a multi-tenant point-of-sale and shop-management platform for repair shops and small retailers. It covers the shop's daily work (sales, repair tickets, inventory, customers, staff) and gives the operator who runs the service a separate console for tenants, plans and billing.

Small shops often run their counter, their repair queue, their stock and their customer records in separate tools. TM POS2026 puts that work in one tenant-scoped app with role- and plan-based access. The backend underneath is being moved to server-side authorization, with every protected command checked and audited on the server.

> **Status: in active development, not deployed.**
> - The tenant app and the `/owner` operator console run in the browser on seeded demo data. Some of it persists in the browser's `localStorage` or `sessionStorage`. Firestore is read for one thing only: the signed-in user's `users/{uid}` profile.
> - The server-authoritative backend is being built milestone by milestone in [`docs/phase-4/`](docs/phase-4/README.md). It consists of the API runtime, PostgreSQL identity and authorization, durable sessions and audited commands.
> - No production backend is deployed yet.

## Core Features

**Shop (tenant) app**

- Point of sale and checkout (`/sales`).
- Repair ticket management (`/repairs`).
- Inventory, service catalog and supply-chain purchase orders (`/inventory`, `/services`, `/supply-chain`).
- Customers, prospects and marketing (`/customers`, `/prospects`, `/marketing`).
- Invoices, warranties and a returns portal (`/invoices`, `/warranties`, `/returns`).
- Shipping center with per-provider settings (`/shipping`, `/shipping/settings`).
- Employees with tenant roles and per-domain permissions (`/employees`).
- Reports and dashboard charts, integrations, widgets, settings and support pages.
- Per-tenant plan gating: each module page sits behind a feature check (`AccessGuard`).
- App Store, Mail-In Repairs and General Ledger pages exist as "Coming Soon" placeholders.

**Platform operator console (`/owner`)**

- Tenants and tenant detail.
- Plans, feature matrix, add-ons, subscriptions, billing and usage.
- Provisioning, domains and support tools.
- Audit and security, platform team, roles and permissions, and a Command Center dashboard.
- Everything here runs on demo data today.

**Administration console (a separate surface under `/admin`)**

- Firebase sign-in with TOTP multi-factor authentication, exchanged for a server-side administrative session (`/admin/v1/session`).
- A read-only Command Center summary.
- Tenant Management: list tenants, rename a tenant, and suspend or reactivate one. The server authorizes each command, keys it for idempotency and records it in an audit log.
- In production the console loads only on the origins listed in `VITE_ADMIN_CONSOLE_ORIGINS`. The tenant app and the console never share a page.
- Status: the server side of the console is implemented and covered by integration tests: the session, admission and command routes, over PostgreSQL. No runnable entry point composes it yet, though, so sign-in cannot complete outside the test suites.

**Security foundation**

- Fail-closed Firestore rules: a client may only read its own `users/{uid}` document.
- PostgreSQL migrations `001`–`014`:
  - separate database principals;
  - row-level security;
  - `SECURITY DEFINER` command routines;
  - an append-only audit trail;
  - durable tenant and administrator admission;
  - a shared rate-limit store that every server instance counts requests in (migration `014`).
- API runtime with:
  - a per-route policy for authentication, request body and idempotency;
  - rate limits on every route except `/health` and `/readiness`, counted in the shared PostgreSQL store. If the store cannot answer, the request gets a 503; it is never let through unlimited;
  - CSRF and origin checks;
  - bounded request handling;
  - structured logs that never contain secret values.
- CI gates: type checking, unit and database integration tests, Firestore rules tests, build-integrity checks, Semgrep, gitleaks and a dependency audit.

## Architecture & Tech Stack

```text
Browser ── Vite dev server :5000 ──► React SPA (src/)
                                     ├─ tenant app (src/App.tsx)      "/", "/owner/*"
                                     └─ admin console (src/backend-control-plane/console)  "/admin"
             /__identity/* proxy ──► Identity API :5002   (server/platform-identity, optional)
             /api/v1, /admin/v1  ──► bounded JSON 404 on the dev server (by design)

API runtime (server/runtime → dist-server/server.js)   GET /health, GET /readiness
PostgreSQL 16 ◄── server/persistence adapters ◄── server/composition (not yet wired into npm start)
Firebase Auth + Firestore (users/{uid} only)
```

| Layer | Technology (resolved version) |
| --- | --- |
| Language | TypeScript 5.8.3 |
| Frontend | React 19.2.4, React Router 7.18.3, Vite 6.4.3, Tailwind CSS 4.2.2, motion 12.38.0, lucide-react 0.546.0, Recharts 3.8.0 |
| Auth | Firebase JS SDK 12.11.0 (Auth and Firestore) in the browser; `firebase-admin` 13.10.0 on the server; `jose` 6.2.3 |
| Server | Node.js 20, Express 4.22.1 (API runtime and identity API) |
| Database | PostgreSQL 16 through the `postgres` 3.4.9 driver; SQL migrations in `server/platform-identity/migrations/`. PostgreSQL also holds the shared rate-limit counters (migration `014`); there is no Redis or other cache |
| Supabase | `@supabase/supabase-js` 2.108.1, used only by development-only, default-off pilot and shadow modules |
| Testing | Vitest 4.1.10 with Testing Library and jsdom (frontend); `node:test` through `tsx` (server, database, rules); a Chromium CDP browser test |
| CI and security | GitHub Actions, Semgrep, gitleaks, `npm audit`, Firebase emulator (Java 21) |

Repository layout:

- `src/` — React SPA: `components/` (tenant pages), `owner/` (operator console), `backend-control-plane/` (administration console and its API clients), `context/` (access and session state), `tenant/`, `shipping/`, `auth/` and `pilot/` (development-only Supabase work).
- `server/runtime/` — provider-independent API runtime: routes, sessions, CSRF, rate-limit and idempotency ports. `npm run build:server` compiles it to `dist-server/`.
- `server/composition/` — production composition roots that bind adapters to the runtime ports.
- `server/persistence/` — PostgreSQL adapters: sessions, admission, the transactional store, the tenant directory and the rate limiter.
- `server/platform-identity/` — identity API, migrations `001`–`014`, and the authorization and audit foundation.
- `server/bcp-pilot/` — read-only readiness endpoints for the development-only Backend Control Plane shell.
- `scripts/` — test runners, CI gate scripts, the migration CLI and diagnostics.
- `tests/` — `browser/`, `db/` (PostgreSQL integration), `firestore/` (rules) and `quality/` (architecture contracts).
- `docs/` — design records. `docs/phase-4/` is the current production blueprint and risk register.

## Getting Started

**Prerequisites**

- Node.js 20 and npm (the version CI and the Replit environment use).
- Git.
- Optional, for PostgreSQL integration tests: PostgreSQL 16 with `initdb`, `pg_ctl`, `createdb`, `psql` and `pg_isready` on your `PATH`.
- Optional, for the Firestore emulator tests: Nix, which `npm run test:firestore:emulator` uses to provide Java 21. Without Nix, install Java 21 and run the emulator command yourself (see Troubleshooting).
- Optional, for the security scans: Docker.
- Optional, for the browser test: Chromium.

**1. Clone the repository**

```bash
git clone https://github.com/walid85us/tmpos2026.git
cd tmpos2026
```

**2. Check the lockfile, then install exact dependencies**

Run the lockfile check first. It needs no installed packages, and it fails if `package-lock.json` points at any host other than `registry.npmjs.org`.

```bash
npm run lockfile:check
npm ci
```

**3. Start the development server**

```bash
npm run dev
```

Open <http://localhost:5000>. No environment variables are needed: the Firebase web config is read from `firebase-applet-config.json`.

**4. Sign in**

`/login` offers Google and email/password sign-in against the configured Firebase project. The account needs a Firestore document at `users/{uid}` with a `role` and a `name`:

- A platform role (`system_owner`, `support_admin`, `billing_admin`, `operations_admin` or `security_admin`) opens `/owner`.
- Any other role opens the tenant app at `/`.

Client writes to `users/*` are denied by the Firestore rules. Create the document with the Firebase console or the Admin SDK.

**5. Optional: build and run the API runtime**

```bash
npm run build:server
NODE_ENV=development PORT=8080 npm start
```

**6. Optional: run the identity API**

This separate process listens on port 5002. In development, Vite proxies `/__identity/*` to it.

```bash
npm run identity:api
```

With no environment set, only `/health` and `/readiness` respond. See [Environment Variables](#environment-variables) to enable its routes.

## Environment Variables

- The repository has no `.env.example`, and nothing loads `dotenv`.
- Variables come from the shell or CI. The only file-based loading is Vite's `loadEnv`, which reads `.env`, `.env.local`, `.env.[mode]` and `.env.[mode].local` from the repository root for the dev server and the build.
- Never commit real values. Keep secrets in your host's secret store (for example, Replit Secrets or GitHub Actions secrets).

**Frontend (read by Vite at dev or build time)**

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_ADMIN_CONSOLE_ORIGINS` | Required for a production administration console | Comma-separated exact `https://` origins that may serve the console. No wildcards, paths or duplicates. If it is missing or malformed, `/admin` renders a refusal on every host. It is not used by the dev server, which serves the console at `/admin`. |
| `VITE_ENABLE_BACKEND_CONTROL_PLANE` | Optional | `true` shows the development-only Backend Control Plane shell at `/dev/backend-control-plane` (dev server only). |
| `VITE_ENABLE_SUPABASE_PILOT` | Optional | `true` shows the development-only Supabase sign-in pilot at `/dev/supabase-pilot` (dev server only). |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Optional | Supabase project URL and publishable (anon) key for the pilot and shadow modules. Both are designed to be safe in client code. |
| `VITE_IDENTITY_API_BASE` | Optional | Base path for identity API calls. Default: `/__identity`, the dev proxy. |
| `VITE_ENABLE_SUPABASE_AUTH_FOUNDATION`, `VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP`, `VITE_ENABLE_SUPABASE_TOKEN_BRIDGE`, `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS`, `VITE_ENABLE_SESSION_RESOLVE_SHADOW`, `VITE_ENABLE_SERVER_AUTHZ_SHADOW`, `VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED`, `VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT`, `VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT`, `VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY` | Optional | Development-only diagnostic and shadow switches. All are off by default and have no effect in a production build. |
| `DISABLE_HMR` | Optional | `true` turns off hot module reload on the dev server. |
| `GEMINI_API_KEY` | Not used | `vite.config.ts` still injects it (left over from the original template), but no source file reads it, and `@google/genai` is never imported. |

**API runtime (`npm start`)**

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | **Required** | One of `test`, `development`, `staging` or `production`. |
| `PORT` | **Required** | Listening port, a whole number from 1 to 65535. |
| `ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW` | Must be unset in production | With `NODE_ENV=production`, any value other than empty or `false` stops startup with `production_dev_flag_conflict`. |

**Production composition (`server/composition/`, not yet wired into `npm start`)**

These are the configuration contract for the future production entry point. Composition is all or nothing: any missing or malformed value is reported as a named blocker, and nothing starts until none remain.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_TENANT_ORIGINS` | **Required** | Comma-separated exact `https://` origins of the tenant app. |
| `SESSION_ADMIN_ORIGINS` | **Required** | Comma-separated exact `https://` origins of the administration console. They must be on a dedicated host that no tenant origin shares. |
| `TRUSTED_PROXY_CIDRS` | **Required** | Exact CIDR ranges of the proxies whose `X-Forwarded-For` header is trusted, comma-separated, at most 32. `none` (clients connect directly) is accepted only outside `NODE_ENV=production`. |
| `RATE_LIMIT_KEY` | **Secret**; required | Keyed-hash secret for rate-limiter keys: unpadded base64url of 32–64 random bytes. It must be identical on every instance. The first instance to use the database registers a fingerprint of it there (an HMAC of the key, never the key). An instance started with a different key finds its rate limiter unavailable: every protected request gets a 503 and `/readiness` answers 503. |
| `IDEMPOTENCY_KEY` | **Secret**; required (the production routes include idempotent commands) | Separate keyed-hash secret for idempotency records, in the same format. It must differ from `RATE_LIMIT_KEY`. |
| `APP_DATABASE_URL` | **Secret**; required (the production routes include idempotent commands) | Tenant-runtime database URL. It must be a direct or session-pooler endpoint on port 5432; a transaction pooler is refused. |
| `NODE_ENV` | **Required** | Set to `production` in production. Only then is `TRUSTED_PROXY_CIDRS=none` refused. |
| `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`, `DATABASE_CA_CERT` | Required | As described for the identity API below. |
| `PGSSL` | Must be unset | As described for the identity API below. |

**Identity API (`npm run identity:api`)**

| Variable | Required | Purpose |
| --- | --- | --- |
| `ENABLE_SUPABASE_PLATFORM_IDENTITY` | Optional | `true` enables the identity routes. When it is off, and every development-only flag below is also off, only `/health` and `/readiness` respond and no database connection opens. The Backend Control Plane endpoints are gated separately by their own `ENABLE_BCP_DEV_*` flags, and the action endpoint reads the identity database. |
| `PLATFORM_IDENTITY_API_PORT` | Optional | Listening port. Default: `5002`. |
| `SUPABASE_DATABASE_URL` | **Secret**; required once the routes are enabled | PostgreSQL URL for the admin/migration principal. |
| `APP_DATABASE_URL` | **Secret**; required once the routes are enabled | PostgreSQL URL for the tenant-runtime principal, which row-level security constrains. `/readiness` probes both database connections, so without it the API reports not-ready. It deliberately never falls back to `SUPABASE_DATABASE_URL`. |
| `DATABASE_CA_CERT` | Required for any database connection | PEM certificate block(s) that the database server's TLS certificate must chain to. |
| `PGSSL` | Must be unset | Any value stops every connection. This repository chooses the TLS settings itself. |
| `SUPABASE_URL` | Required once the routes are enabled | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret**; required once the routes are enabled | Supabase service-role key. |
| `SUPABASE_ANON_KEY` | Optional | Supabase publishable key. The server only checks whether it is present. |
| `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` | **Secret**; required for Firebase token verification | Full Firebase Admin service-account JSON. |
| `NODE_ENV` | **Required in production** | Set to `production` to force every development-only flag below off. Any other value, including unset, lets those flags take effect. |
| `PLATFORM_IDENTITY_DEV_DIAGNOSTICS`, `PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS`, `ENABLE_SESSION_RESOLVE`, `ENABLE_LIVE_SESSION_AUTHORIZATION`, `ENABLE_IDENTITY_LINK_ADMIN_PROVISIONING` | Optional | Development-only diagnostic and prototype routes. All are off by default. |
| `ENABLE_BCP_DEV_READONLY_PILOT`, `ENABLE_BCP_DEV_C02_REGISTRY_READINESS`, `ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS`, `ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS`, `ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS`, `ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS`, `ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS`, `ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW` | Optional | Development-only Backend Control Plane endpoints. All are off by default. |
| `REPLIT_DEV_DOMAIN` | Optional | Trusted origin host for the two Backend Control Plane action endpoints. |

**Tests and CI**

| Variable | Required | Purpose |
| --- | --- | --- |
| `TM_POS_TEST_DATABASE_URL` | Optional locally | A disposable PostgreSQL URL on a loopback host or Unix socket; other targets are refused. If unset, each database suite starts its own throwaway cluster with `initdb`/`pg_ctl`. CI sets it to its own PostgreSQL service. |
| `CHROMIUM_PATH` | Optional | Chromium binary for `npm run test:browser:admin`. Fallbacks: `/repl/tools/bin/chromium`, then `chromium` on `PATH`. |
| `M4UI_EVIDENCE` / `M4UI_EVIDENCE_DIR` | Optional | Where the browser test writes its evidence. The default is a machine-specific temporary path, so set it on other machines. |
| `SEMGREP_RESULTS`, `GITLEAKS_CURRENT`, `GITLEAKS_HISTORY`, `AUDIT_JSON`, `AUDIT_FULL_JSON`, `AUDIT_EXIT`, `GATE_MANIFEST` | CI | Scanner and audit result paths for `security:gates` and the dependency-audit check. Without them, `security:gates` checks only the manifest's structure. |

**Maintenance scripts (`scripts/`, run by hand)**

- The migration CLI and the provisioning and diagnostic scripts target development databases and refuse to run with `NODE_ENV=production`.
- They read `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `DATABASE_CA_CERT` and `SUPABASE_SERVICE_ROLE_KEY`.
- Each one also requires an explicit opt-in before it acts: `ALLOW_SUPABASE_MIGRATION_APPLY=1` or `ALLOW_OWNER_ACL_PROVISION=1`, or an `ALLOW_LIVE_*=true` switch.
- Most also require `CONFIRM_SUPABASE_TARGET`, which must exactly match the target label hard-coded in that script.
- The live checks also read `AUTHZ_CHECK_AUTH_PROVIDER`, `AUTHZ_CHECK_AUTH_PROVIDER_UID` and, optionally, `EXPECTED_DEV_PROJECT_REF`.
- Read each script's header before running it.

## Usage

Start the app and open the surface you need:

```bash
npm run dev
# Tenant app:            http://localhost:5000/
# Operator console:      http://localhost:5000/owner
# Administration console (dev server only): http://localhost:5000/admin
```

Build and probe the API runtime:

```bash
npm run build:server
NODE_ENV=development PORT=8080 npm start
```

```bash
curl -s http://localhost:8080/health      # {"status":"alive"}
curl -s http://localhost:8080/readiness   # {"status":"ready"}
```

Common commands:

```bash
npm test                      # server/unit suites, then frontend (Vitest) suites
npm run typecheck             # tsc --noEmit over the whole project
npm run test:db               # three core PostgreSQL suites (migration engine, RLS isolation, audit atomicity); CI runs every other tests/db suite, the rate-limiter ones included, one by one with npx tsx --test
npm run test:firestore:static # Firestore rules source checks
npm run test:browser:admin    # administration console in headless Chromium
npm run build                 # production frontend bundle in dist/
npm run build:check           # build-integrity gate (no source maps, no server code or secrets in the bundle, size ceiling)
npm run forbidden:check       # fails if forbidden artifacts are tracked
```

## Troubleshooting & FAQ

**`npm start` exits immediately with `startup_config_invalid`**

The runtime validates its environment before it binds a port. For example, `{"event":"startup_config_invalid","reason":"NODE_ENV:env_missing,PORT:port_missing"}` means both variables are missing. Set `NODE_ENV` to `test`, `development`, `staging` or `production`, and set `PORT` to a number from 1 to 65535. `production_dev_flag_conflict` means a development-only flag is set while `NODE_ENV=production`.

**`npm start` only answers `/health` and `/readiness`; `/api/v1/*` and `/admin/v1/*` return 404**

This is expected today. The compiled entry serves only the operational probes. The production composition roots (`server/composition/`) are not wired into it; the entry that composes them is the next piece of work (see `docs/phase-4/08-production-gate-and-risk-register.md`).

**A composition refusal names `rate_limit_store_unavailable`**

The sessions root was not handed the rate-limiter binding that the transaction root builds over its database connection, or `RATE_LIMIT_KEY` is missing or malformed. In the second case `rate_limit_key_missing` or `rate_limit_key_invalid` is named too; fix the key. A database outage or a key mismatch never shows up here: those appear at run time as 503 responses and a failing `/readiness`.

**`/readiness` answers 503 after `RATE_LIMIT_KEY` was set or changed**

The database keeps the fingerprint of the first `RATE_LIMIT_KEY` that reached it and refuses every other key. The instance's rate limiter is then unavailable, so every protected request also gets a 503.

- If this instance has the wrong key, put the registered key back.
- If a wrongly keyed instance reached the database first after migration 014 was applied, its key is the registered one, and every correctly keyed instance is locked out. Recovery is a manual operator procedure:
  1. Stop every wrongly keyed instance.
  2. Confirm the intended key's fingerprint: HMAC-SHA256 of the text `tmpos-rate-limit-key-fingerprint:v1` under the key's bytes.
  3. In a maintenance window, as the database owner, delete the one row of `tmpos_rate_limit.key_fingerprint`.
  4. Let a correctly keyed instance register it on its next consume or readiness check.

  No routine does this, and nothing does it automatically.
- To prevent a wrong first registration: right after applying migration 014 (or re-applying it after a rollback), have a correctly keyed instance reach the database (its `/readiness` check registers the key) before anything else holding the runtime database credential connects, or have the owner confirm that the registered fingerprint equals HMAC-SHA256 of the text `tmpos-rate-limit-key-fingerprint:v1` keyed with the bytes `RATE_LIMIT_KEY` decodes to (base64url-decode it first; the text itself is not the key). Anyone holding that credential can register a fingerprint of their choosing first, even without the key, and lock every instance out.
- Changing the key for a running deployment needs a coordinated rotation procedure, which does not exist yet; nothing resets the fingerprint, by design.
- On a disposable test database, start again from a freshly created database.

`/readiness` also answers 503 when the database session is read-only or the server is a standby: the rate limiter cannot write there.

**Rolling back migration 014 fails with `migration 014 rollback refused: N rate-limit bucket(s) are still inside their window`**

The rollback never discards a live limit, because that would hand those clients a fresh allowance. Stop the traffic the limiter serves, wait for the longest window to close (the longest built-in window is 5 minutes), then roll back again. The rollback runs only in a READ COMMITTED transaction (the migration executor's plain `BEGIN`, unless the database's default isolation says otherwise) and otherwise refuses with `migration 014 rollback refused: it runs only at READ COMMITTED…`; at a stricter level it could miss a window opened while it waited for its lock. The rollback also removes the registered `RATE_LIMIT_KEY` fingerprint. Until 014 is applied again, every protected request gets a 503 and `/readiness` fails; the next application registers whichever key reaches it first.

**Port 5000 (or 5002) is already in use**

- `npm run dev` is not pinned to its port. When 5000 is taken, Vite prints `Port 5000 is in use, trying another one...` and moves to the next free port, which the Replit port mapping (5000 → 80) does not expose.
- The API runtime logs `startup_listen_failed` and exits.
- Find the process holding the port and stop it, or choose another port (`PORT`, `PLATFORM_IDENTITY_API_PORT`):

```bash
lsof -i :5000
```

**The dev server crashes with `ENOSPC: System limit for number of file watchers reached`**

`vite.config.ts` excludes tooling and asset trees from the file watcher for this reason. If you add a large directory to the workspace, add it to `server.watch.ignored` in `vite.config.ts`, or raise the Linux `fs.inotify.max_user_watches` limit.

**`npm run lockfile:check` fails, or `npm ci` installs an incomplete tree**

The lockfile must resolve every package from `registry.npmjs.org`, because a lockfile resolved through a private mirror can make `npm ci` silently skip optional packages. The repository `.npmrc` forces the public registry. Regenerate the lockfile with it in effect, then re-run the check:

```bash
npm install --package-lock-only
npm run lockfile:check
```

**`npm run typecheck:contract` fails**

The contract makes sure `tsc` uses this repository's `tsconfig.json` and that `@types/react` and `@types/react-dom` are installed, so that `npm run typecheck` cannot pass while checking nothing. Re-install with `npm ci` and run it from the repository root.

**`npm run test:db` throws `S1b INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl`**

Install PostgreSQL 16 so that `initdb`, `pg_ctl`, `createdb`, `psql` and `pg_isready` are on your `PATH`; the suites then create and remove their own cluster. Alternatively, set `TM_POS_TEST_DATABASE_URL` to a disposable database on `127.0.0.1` or a Unix socket. Remote and managed databases are refused on purpose, and Docker is not used. Point each run at a freshly created database: a database that already holds migrations from an earlier run can fail a suite's preconditions.

**Identity API database calls fail with `refusing to open a database connection: …`**

- `DATABASE_CA_CERT is not configured, and no default trust store may stand in for it`: set `DATABASE_CA_CERT` to the PEM certificate(s) your database's TLS certificate chains to.
- `PGSSL must not select transport security — this repository owns that decision`: unset `PGSSL`.
- A missing URL fails with `SUPABASE_DATABASE_URL is not configured (server-side secret missing).` or `APP_DATABASE_URL is not configured (runtime-principal secret missing).`

**Sign-in says "Your account has not been provisioned. Please contact your administrator."**

The signed-in user has no `users/{uid}` document in Firestore. Create one with a `role` and a `name` (see Getting Started, step 4). Any other Firestore read or write from the browser returns `permission-denied` by design, because the rules are fail-closed.

**Requests to `/api/v1/*` or `/admin/v1/*` on the dev server return a JSON 404**

This is intentional. The dev and preview servers answer API paths with a bounded JSON 404, never the SPA page. The administration console at `/admin` therefore cannot complete its server sign-in against the dev server alone.

**`ERR_UNKNOWN_FILE_EXTENSION ".ts"` when running a script or test**

A TypeScript file was run with plain `node`. Use `tsx`, as the npm scripts do:

```bash
npx tsx --test tests/db/tenantDirectory.integration.test.mjs
```

**`npm run test:browser:admin` skips its tests**

No Chromium binary was found. Install Chromium or set `CHROMIUM_PATH`.

**`npm run test:firestore:emulator` fails with `nix: command not found`**

The script uses Nix to provide Java 21. Without Nix, install Java 21 and run the same emulator suite that CI runs:

```bash
npx --no-install firebase emulators:exec --only firestore --project demo-tmpos-rules 'node --test tests/firestore/firestore.rules.emulator.test.mjs'
```

**`npm run security:semgrep` or `npm run security:secrets` fails**

Both run pinned Docker images, so Docker must be installed and running.

**Do I need a Gemini API key?**

No. `GEMINI_API_KEY` and `@google/genai` are left over from the original template, and no code uses them.

## License

**Proprietary — All Rights Reserved.**

Copyright © 2026. All rights reserved.

TM POS2026 (Teal Metrics) is private, commercial software. This software, including its source code, documentation and related assets, is the confidential and proprietary property of its owner. It is not open source. Access to this repository does not grant any license or right, express or implied.

Without a written license agreement with the owner, or the owner's prior written permission, you may not:

- copy or reproduce the software, in whole or in part;
- distribute, publish, sublicense, sell, rent or otherwise make the software available to any third party;
- modify, adapt, translate or create derivative works based on the software;
- reverse engineer, decompile or disassemble the software.

Third-party components, such as open-source dependencies, remain licensed under their own terms.
