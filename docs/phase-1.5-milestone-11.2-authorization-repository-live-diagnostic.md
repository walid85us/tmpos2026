# Phase 1.5 M11.2 — Read-Only Authorization Repository + Live DEV Diagnostic

**Status:** `IMPLEMENTED / REVIEW-GATED / NOT WIRED`
**Owner UI QA:** not required (no visible UI change). The owner only supplies the DEV UID as an environment variable for the live diagnostic; it is never printed or committed.

Checkpoint before M11.2: `a0dc847afea111535ddbe991744aaea8539e6d44` ("Phase 1.5 M11.1.2 document DEV bootstrap apply").

---

## 1. Scope

M11.2 adds a **server-side, read-only** repository/query layer plus a **DEV-gated live diagnostic** that reads the real seeded DEV durable authorization rows, assembles the exact snapshot the **pure M11 resolver** already consumes, runs `resolveAuthorization()`, and reports a safe, redacted result while **proving zero mutation**.

Explicitly, M11.2:

- **No runtime wiring.** `/auth/session/resolve` is untouched and still returns `authorization: null`.
- **No frontend / AccessContext change.**
- **No durable audit writer.** No protected business API.
- **No migration / seed / rollback applied.** No schema/RLS change. No Supabase MCP.
- **Read-only.** SELECT-only repository; the live diagnostic writes nothing and wraps reads in a `READ ONLY` transaction.

---

## 2. Current prerequisite state (DEV, as accepted at M11.1.2)

- Migration `003_platform_role_vocabulary_alignment` applied to Supabase DEV `tmpos2026-dev` (canonical platform role CHECK active).
- DEV bootstrap seed applied and verified:
  - `app_user`: 1 active
  - `tenant`: 1 active (`plan_key='starter'`)
  - `store`: 1 active (child of the tenant)
  - `user_membership`: 3 active — platform `system_owner`, tenant `store_owner`, store `store_owner`
  - `tenant_feature_entitlement`: 2 manual enabled (`shipping_provider_configuration`, `pickup_requests`)
  - `audit_event`: 0
- Production untouched. 003 down not run. Rollback seed not run.

Note: because 003 is applied, the platform membership `role_id` is the **canonical** `system_owner`, which the resolver maps **directly** via `PLATFORM_ROLE_IDS` — the provisional `PLATFORM_ROLE_COMPAT_MAP` legacy shim is not exercised in DEV.

---

## 3. Files added

1. `server/platform-identity/authorizationRepository.ts` — read-only repository + snapshot assembler.
2. `scripts/diagnostics-authorization-repository-live-check.ts` — DEV-gated live diagnostic.
3. `scripts/diagnostics-authorization-repository-static-check.ts` — DB-free static safety check.
4. `docs/phase-1.5-milestone-11.2-authorization-repository-live-diagnostic.md` — this record.

**Files modified:** none. No `package.json` / `package-lock.json` / dependency change. Diagnostics run via `npx tsx …`.

---

## 4. Repository design

`authorizationRepository.ts` is **server-only, SELECT-only**, using the existing `getDb()` helper and parameterized tagged-template SQL (no `sql.unsafe`, no dynamic/concatenated SQL, no mutation). It returns **RAW rows** (statuses preserved, roles not collapsed) and performs **no authorization logic** — the resolver owns every decision.

Exported read-only functions (each accepts an optional `SqlExecutor` so a read-only transaction handle can be passed):

- `getIdentityByProviderUid(authProvider, authProviderUid, executor?)` — selects from `platform_identity` by the unique `(auth_provider, auth_provider_uid)` key; at most one row; logs nothing.
- `getAppUser(internalUserId, executor?)` — `app_user` row or null.
- `getMembershipsForUser(internalUserId, executor?)` — ALL membership rows, every scope/status (raw).
- `getTenant(tenantId, executor?)` — `tenant` row or null.
- `getStore(storeId, executor?)` — `store` row or null.
- `getEntitlementsForTenant(tenantId, executor?)` — ALL entitlement rows for the tenant (raw; resolver filters enabled/in-scope).
- `countDurableAuthorizationRows(executor?)` — diagnostic-only `count(*)` over a **fixed, hardcoded** allow-list (`app_user`, `tenant`, `store`, `user_membership`, `tenant_feature_entitlement`, `audit_event`); no caller-supplied table names.
- `buildResolverInputForContext(identityKey, requestedContext, executor?)` — assembles the exact `AuthorizationResolverInput`; returns `null` only when the identity is not found. Per scope: platform ⇒ `tenant=null, store=null, entitlements=[]`; tenant ⇒ tenant + its entitlements; store ⇒ tenant + store + the tenant's entitlements.

Types are imported (`import type`) from the unchanged resolver/constants; the M11 resolver was **not modified**.

---

## 5. Safety flags (live diagnostic)

The live diagnostic refuses unless ALL hold (checked before any DB connection):

```
NODE_ENV=development                      # production hard-blocked
ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK=true
CONFIRM_SUPABASE_TARGET=tmpos2026-dev
SUPABASE_DATABASE_URL                     # present
AUTHZ_CHECK_AUTH_PROVIDER=supabase
AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED>   # owner-supplied; never printed/committed
# optional defense-in-depth:
EXPECTED_DEV_PROJECT_REF=<ref>            # boolean match only; ref never printed
```

It does **not** use `SUPABASE_TEST_EMAIL` / `SUPABASE_TEST_PASSWORD`, verifies no token, and trusts no `user_metadata`.

---

## 6. Redaction strategy

Allowed output only: PASS/FAIL counts, booleans, decision names, reason codes, role ids, and the entitlement key list. The diagnostic **never** prints the UID, email, DB URL, project ref, service-role key, anon key, tokens, JWTs, raw SQL, raw rows, or raw DB errors — DB errors are reduced to their error **name** only. Identity presence is reported as a boolean (`resolved` / `NOT FOUND`).

---

## 7. No-mutation proof

Layered guarantees:

1. **Code-level:** repository is SELECT-only; static check asserts no `insert/update/delete/upsert/on conflict/alter/drop/truncate/.unsafe` in comment-stripped executable code.
2. **DB-level:** the live diagnostic runs every read inside one transaction that first issues `set transaction read only`.
3. **Evidence-level:** `count(*)` for all six durable tables is captured **before** and **after**; equality is asserted, and `audit_event` is asserted to remain `0`.

---

## 8. Expected live diagnostic outcomes

- **G1–G6** identity resolved; `app_user` active; the three seeded memberships present and active.
- **P1** platform scope → `allow`, `userType='platform'`, `roles.platformRoleId='system_owner'`.
- **T1** tenant scope → `allow`, `roles.tenantRoleId='store_owner'`; **T2** entitlement count `= 2`; **T3** keys `shipping_provider_configuration` + `pickup_requests` present.
- **S1** store scope → `allow`, `roles.tenantRoleId='store_owner'`; **S2** entitlement count `= 2`.
- **N1** negative control (unseeded all-zero tenant id) → `deny` (`denied_tenant_missing` / `denied_scope_context_invalid`).
- **M1** all durable row counts unchanged (before == after); **M2** `audit_event` remains `0`.

---

## 9. Explicit non-actions

- No `/auth/session/resolve` wiring (unchanged; `authorization: null`).
- No frontend / AccessContext / Login / AccessGuard / routing change.
- No durable audit writer. No protected business API. No runtime authorization output.
- No migration / seed / rollback applied. No schema/RLS change.
- No Supabase MCP. No token verification. No production touch.
- M11 resolver, M9 contracts, `db.ts`, `identityRepository.ts`, M10.2 runner: unchanged.

---

## 10. How to run the static checks (DB-free)

```
npx tsx scripts/diagnostics-authorization-repository-static-check.ts
```

Also re-run the existing suite (all DB-free): resolver, role-vocabulary, migrate-runner, authorization-contract, audit-event-contract, authorization-schema, audit-schema; plus `npx tsc --noEmit` and `npm run build`.

---

## 11. How to run the live check (DEV only)

The owner supplies the DEV UID via env (never printed/committed):

```
NODE_ENV=development ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK=true \
CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
AUTHZ_CHECK_AUTH_PROVIDER=supabase AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED> \
npx tsx scripts/diagnostics-authorization-repository-live-check.ts
```

Until this runs and passes, M11.2 is implemented and review-gated but **not yet fully live-verified**.

---

## 12. Deferred items

- Durable audit writer (fail-closed).
- `/auth/session/resolve` runtime resolver wiring + tenant/store context input.
- Permission / sub-permission materialization + shared permission-catalog unification.
- AccessContext adoption; protected business APIs.
- Backend Control Plane (API-only, audited, least-privilege, approval-gated; never service-role/direct-Postgres from tool runtime).
- Any production bootstrap/migration.

---

## 13. Next recommended step after acceptance

1. Commit and back up M11.2.
2. Then plan the durable audit writer or the resolver wiring strategy (depending on review rating) — both remain prerequisites before any runtime authorization output or control-plane work.

---

**Not committed / not pushed / not backed up. No DB connection made by Replit/Claude during implementation; no SQL run; no seed/bootstrap/migration applied; Supabase MCP not used; `/auth/session/resolve` not modified and still `authorization: null`; frontend unchanged; production untouched. Pending review.**
