# Phase 1.5 — Milestone 1: Thin Server/API + Platform Identity Foundation

> **Status:** **IMPLEMENTED — PENDING REVIEW / MANUAL QA.** First behavior-changing backend slice. **Default behavior is unchanged:** the new path is behind a feature flag (`ENABLE_SUPABASE_PLATFORM_IDENTITY`) that is **OFF by default**, and the isolated API is **not** started by `npm run dev`. **Firebase Auth is untouched.** No tenant/business data. **Not committed / not pushed / not backed up; awaiting review.**
>
> **Built per** [`phase-1.5-milestone-0-implementation-kickoff-evidence-pack.md`](phase-1.5-milestone-0-implementation-kickoff-evidence-pack.md) §21. **Migration application is owner-driven** (the implementation shell cannot see the Supabase secrets; see §8).

---

## 1. Purpose

Establish the smallest safe Supabase-backed backend foundation: an **isolated server/API boundary** and a single durable domain — **`platform_identity`** — that maps the current external auth UID (Firebase) to a stable, **app-owned `internal_user_id`**. This is the keystone for all future durable records and for the eventual Firebase → Supabase Auth migration, without changing any current behavior.

## 2. What changed (files)

| File | Type | Purpose |
|---|---|---|
| `server/platform-identity/config.ts` | new | Feature flag + secret **presence** helpers (booleans only, never values) |
| `server/platform-identity/db.ts` | new | Server-side-only lazy Postgres connection (SSL; bypasses RLS as owner role) |
| `server/platform-identity/identityRepository.ts` | new | `findByProviderUid` + `upsertIdentity`; returns safe public fields only |
| `server/platform-identity/server.ts` | new | **Isolated** express app (own port 5002): `/health`, `/readiness`, flag-gated `/identity/resolve`, `/identity/by-uid` |
| `server/platform-identity/migrations/001_platform_identity.up.sql` | new | Creates `platform_identity` (+ trigger, RLS-enabled no-policy) |
| `server/platform-identity/migrations/001_platform_identity.down.sql` | new | Rollback: drops only M1 objects |
| `scripts/supabase-migrate.ts` | new | Owner-run migration runner (UP/`--down`) |
| `scripts/supabase-identity-validate.ts` | new | Owner-run diagnostics (presence / `--connect` / `--check-table` / `--smoke`) |
| `package.json` | edit | Added `postgres` dep + `identity:api` / `identity:validate` / `identity:migrate` scripts (`dev` unchanged) |
| `package-lock.json` | edit | Lockfile for `postgres@^3.4.9` |
| `docs/phase-1.5-milestone-1-thin-api-platform-identity.md` | new | This doc |
| `replit.md` | edit | Status update |

**Not touched:** `src/firebase.ts`, `src/context/AccessContext.tsx`, `accessConfig.ts`, `platformPermissionsConfig.ts`, tenant/store permission code, routing, UI, `firestore.rules`, and the shipping sidecar `server/index.ts` (verified: zero diff).

## 3. Feature flag

- Name: **`ENABLE_SUPABASE_PLATFORM_IDENTITY`**. Enabled only when set to exactly `"true"`; **everything else (unset/''/`false`/`1`) is OFF.**
- **Flag OFF (default):** isolated API serves only `/health` (presence booleans) and `/readiness` (returns `feature_flag_off`); identity endpoints return `404 FEATURE_DISABLED`; **no DB connection is opened.**
- **Flag ON (dev only):** identity endpoints active.
- The flag does **not** affect the main app or login in any state, because nothing in `src/` imports this boundary.

## 4. Schema (`platform_identity`)

```
internal_user_id  uuid PK default gen_random_uuid()   -- stable, app-owned
auth_provider     text not null                        -- 'firebase' (reference only)
auth_provider_uid text not null                        -- Firebase UID (reference only)
email             text                                 -- nullable
display_name      text                                 -- nullable
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()   -- maintained by trigger
unique (auth_provider, auth_provider_uid)
```
- **No `unique(email)`** (email nullable / reusable across test accounts).
- **RLS enabled with NO policies** → anon/authenticated roles get no access via the Supabase REST API; the server-side direct-Postgres owner connection bypasses RLS.
- No `tenant_id`/`store_id`; no POS/invoice/inventory/repairs/shipping columns; no production-audit claim.

## 5. Server/API boundary

- A **separate express app** from the shipping sidecar — own file, own port (`PLATFORM_IDENTITY_API_PORT`, default **5002**), no shared state. The shipping sidecar is unchanged.
- Started **only** via `npm run identity:api` (kept out of `npm run dev` so default behavior is identical to today).
- Endpoints: `GET /health`, `GET /readiness`, `POST /identity/resolve` (flag-gated), `GET /identity/by-uid` (flag-gated).

## 6. Auth sequencing

- Firebase Auth **untouched**; login unchanged. M1 maps the Firebase uid as `auth_provider='firebase'`, `auth_provider_uid=<uid>`; `internal_user_id` is app-owned/stable. **Supabase Auth migration is a later, explicit milestone.** Preview/demo users remain separate from production identity.

## 7. Security / secret handling

- Secrets read from `process.env` only; **never** printed/logged/returned/committed. Health/readiness expose **presence booleans only**.
- `SUPABASE_SERVICE_ROLE_KEY` is server-side only; never imported by `src/` (verified — `server/` is not in the Vite client bundle).
- DB connection uses `SUPABASE_DATABASE_URL` directly (Supabase Postgres). `SUPABASE_URL`/service-role key presence is validated for completeness but not used for DB access in M1.
- Errors are passed through `server/safe-log.ts` `sanitizeError` before logging.

## 8. Migration application (owner-driven)

The implementation environment **cannot see the Supabase secrets** (they are injected into the Replit workflow process, not the agent shell). So **the owner applies the migration** from the Replit shell, where the secrets exist:

```bash
npm run identity:validate                  # 1) confirm secret presence (no values shown)
npm run identity:migrate                   # 2) apply UP (create platform_identity)
npm run identity:validate -- --check-table # 3) confirm table exists
ENABLE_SUPABASE_PLATFORM_IDENTITY=true npm run identity:validate -- --smoke   # 4) optional: fake upsert + cleanup
# rollback if needed:
npm run identity:migrate -- --down
```
Alternatively paste `001_platform_identity.up.sql` into the Supabase SQL editor. **No success is faked here** — the table is created only when the owner runs the migration.

## 9. Manual QA (required before acceptance)

App starts; Firebase/Google/email-password login work; preview/demo works; tenant/store mock works; UI modules load; POS/invoices/inventory/repairs/shipping unchanged; shipping sidecar works; no secrets in browser/logs; flag OFF = unchanged; (after migration) flag ON identity resolve/lookup works in dev; rollback verified.

## 10. Rollback

Disable the flag (instant runtime revert) → run `npm run identity:migrate -- --down` (drops only M1 objects) → revert the M1 commit if needed. No production data exists (dev-only); no tenant/business data changed.

## 11. Deferred (still blocked)

Supabase Auth migration; Firebase replacement; production auth/authorization on the identity endpoint; RLS client policies; tenant/business persistence (POS/invoices/inventory/repairs/shipping); payments (Stripe/Square); file storage; production audit evidence; ORM; mock-data migration; UI changes.
