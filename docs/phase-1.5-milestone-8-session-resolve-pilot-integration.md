# Phase 1.5 — Milestone 8: Session-Resolve Pilot Integration (Option C)

Status: **Implemented locally — NOT committed, NOT pushed, NOT backed up. Pending owner UI QA.**

Checkpoint before M8: `70fb6cdf00a87cb50d4af01978280c88c2f24316` ("Phase 1.5 M7 session resolve prototype").

---

## 1. Scope

M8 adds an **optional, dev-only, manual-trigger** "Resolve App Session" action inside
the existing M4 Supabase Auth pilot (`/dev/supabase-pilot`). Clicking it round-trips the
current Supabase access token to the **existing, unchanged** M7 prototype endpoint
`POST /auth/session/resolve` through the existing dev Vite proxy, and renders a **safe,
redacted** result card.

This is **diagnostic validation only**: it proves the browser can reach the M7
session-resolution path and that the server-derived identity contract behaves as designed.
It is **NOT** app authorization, and it does not alter any production authentication path.

### In scope

- `src/pilot/sessionResolvePilotClient.ts` (new) — thin, safe client for the M7 route.
- `src/pilot/SupabaseAuthPilot.tsx` (modified) — optional button + safe result card.
- `scripts/diagnostics-session-resolve-pilot-check.ts` (new) — static, offline contract check.
- This doc (new).

### Explicitly out of scope (NOT touched)

- M7 backend handler, contract, server routing (`server/platform-identity/**`, `server/index.ts`).
- Firebase, Firestore, `firestore.rules`.
- `AccessContext`, `AccessGuard`, `Login`, `App` routing, `NotProvisioned`, `DevSessionSwitcher`.
- `appSession.ts`, `mapWhoamiToAppSession.ts`, `accessConfig.ts`, `platformPermissionsConfig.ts`.
- Supabase config / Auth settings / schema / RLS / migrations.
- `package.json`, `package-lock.json`, `vite.config.ts`, `.replit`, secrets/env, MCP config.
- Business modules (POS / invoice / inventory / repairs / shipping / customers).
- The future Backend Control Plane (see §11).

---

## 2. Why Option C was selected

The M8 planning accepted **Option C — optional pilot UI action only**. Rationale:

- **Lowest blast radius.** The proof lives entirely inside the already-isolated dev pilot.
  Nothing in the real app imports the new code, and the production app authentication
  (Firebase + AccessContext) is provably untouched.
- **No backend change.** M7 already shipped the endpoint; M8 only demonstrates a safe
  client round-trip. No new route, flag, schema, or RLS change.
- **Honest separation of identity vs authorization.** The result card surfaces only
  server-derived identity fields and explicitly shows `authorization: null`, reinforcing
  that authorization remains deferred and server-derived — never client-asserted.
- **Reversible.** Rollback is deleting two files and reverting one (see §15).

Rejected alternatives: wiring resolve into AccessContext (couples a prototype into the
real auth path), or building any control-plane tooling (out of scope; see §11).

---

## 3. Files added / modified

**Added**

- `src/pilot/sessionResolvePilotClient.ts`
- `scripts/diagnostics-session-resolve-pilot-check.ts`
- `docs/phase-1.5-milestone-8-session-resolve-pilot-integration.md` (this file)

**Modified**

- `src/pilot/SupabaseAuthPilot.tsx`

---

## 4. Request contract

The pilot client (`runSessionResolve(accessToken)`):

- `POST ${IDENTITY_API_BASE}/auth/session/resolve` (default base `/__identity` → dev Vite proxy).
- Headers:
  - `content-type: application/json`
  - `authorization: Bearer <in-memory access token>`
- Body: **exactly** `'{}'` (an empty JSON object).

The access token is read fresh at click time via `client.auth.getSession()`, passed
**directly** to the client as the Bearer value, and never stored in React state, rendered,
or logged.

**Never sent** (no client-asserted authority): user object, `user_metadata`, `role`,
`userType`, `tenantId`, `storeId`, `permissions`, `subPermissions`, `internalUserId`,
provider claims, or any other authority field. Identity is proven **server-side**; this
call proves identity, not authorization. The server reads no body field for authority.

---

## 5. Display / redaction rules

The result card header reads: **"Session resolve (M7) — dev diagnostic, not app authorization"**.

Safe fields displayed:

- HTTP status
- `authState`
- `decision`
- `reasonCode`
- `sourceOfTruth`
- `internalUserId` — **redacted** via the existing `redactId()` helper
- `authProviderUid` — **redacted** via `redactId()`
- `authProvider`
- email — shows the already-visible signed-in email; otherwise presence (`present` / `—`)
- `displayName` (if present)
- `error.code` / `error.message` (if present)
- `requestId`
- `authorization: null` — shown explicitly with the copy
  **"authorization: null — server-derived authorization is deferred."**

Required copy on the card: dev-only; diagnostic validation only; not app authorization;
Firebase login and AccessContext are unchanged.

**Never displayed:** access token, refresh token, raw JWT, JWT payload, JWKS,
service-role key, database URL, or connection string.

---

## 6. Error / disabled-state behavior

| Condition | UX |
|---|---|
| Not signed in | "No active Supabase session — sign in first." |
| Identity API unreachable (network / proxy 500/502/503/504, empty body) | "Session resolve API unreachable through the dev proxy. Start `npm run identity:api` with the M7 flags, then retry." |
| Flags off / feature disabled (404 `FEATURE_DISABLED`) | "Session resolve is disabled. Enable ENABLE_SUPABASE_PLATFORM_IDENTITY=true and ENABLE_SESSION_RESOLVE=true on the identity API." |
| Token verification failure (401 family) | Safe `reasonCode` + the server's safe `error.message` only. |
| Identity resolution failure (503 `identity_resolution_error`) | `authState: token-verified`, `decision: deferred`, reason `identity_resolution_error`, with the note **"Token proven, app identity not resolved — fail-closed."** |

All non-200 results render the standing note "This is a diagnostic failure, not an app
authorization decision."

---

## 7. Security / secret-safety rules

- The client mirrors `identityDiagnosticClient.ts` discipline exactly.
- The raw access token is used only as the Bearer header value — never returned, stored,
  logged, or rendered.
- The client never returns/echoes a token, refresh token, raw JWT, JWT payload, JWKS,
  service-role key, database URL, or connection string.
- No `console.*` calls anywhere in the client.
- `IDENTITY_API_BASE` comes from `pilotEnv.ts`, which reads only `VITE_`-prefixed,
  client-safe public values. No server-only secret is read or bundled.
- Production-build verification: `/auth/session/resolve` appears **only** in the
  code-split pilot chunk (zero occurrences in the main app chunk); no
  `SERVICE_ROLE` / `service_role` / `DATABASE_URL` / `connectionString` / `JWT_SECRET` /
  `SUPABASE_TEST_` pattern appears in any built bundle.

---

## 8. Firebase coexistence / AccessContext unchanged

- The pilot does not import Firebase, AccessContext, AccessGuard, Login, App routing, or any
  business module — verified by import grep (§13 of the QA evidence).
- The new client is imported **only** by `src/pilot/SupabaseAuthPilot.tsx` (and referenced
  statically by the offline diagnostic script). Nothing in the real app imports it.
- The real app's Firebase login and AccessContext-driven authorization are untouched and
  continue to govern all non-pilot routes.

---

## 9. M7 backend unchanged

No file under `server/platform-identity/**` or `server/index.ts` was modified. M8 only
calls the existing M7 endpoint. The backend regression suite was re-run unchanged (see QA).

---

## 10. Schema / RLS untouched

No migration, schema, RLS, `firestore.rules`, or Supabase config change. M8 is frontend +
docs + one offline static script only.

---

## 11. Backend Control Plane roadmap note

- The **Backend Control Plane remains a planned, future, parallel workstream**.
- It is **NOT implemented in M8**. **No control-plane tool is connected.**
- `/auth/session/resolve` is a **future prerequisite / access contract** for that control
  plane: it is the seam through which a verified provider token maps to an app-owned
  `internal_user_id` with server-derived authorization (currently always `null`/deferred).
- When built, the future control plane **must** be: API-only, fully audited, least-privilege,
  and **must not** use the service-role key or direct Postgres access from any tool runtime.

---

## 12. Claude QA evidence

All commands run locally at the M8 working tree (no commit/push/backup).

1. **M8 static diagnostic** — `npx tsx scripts/diagnostics-session-resolve-pilot-check.ts`
   → **13/13 PASS**.
2. **TypeScript** — `npx tsc --noEmit` → 12 **pre-existing baseline** errors in unrelated
   files (`server/adapters/easypost.ts`, `server/event-processor.ts`,
   `src/components/DashboardOverview.tsx`, `src/components/Login.tsx`, `src/components/POS.tsx`,
   `src/components/ShippingCenter.tsx`, `src/components/TemplateEditor.tsx`,
   `src/layouts/OwnerLayout.tsx`, `src/layouts/TenantLayout.tsx`, `src/owner/BillingPage.tsx`).
   **0 errors in M8 files.**
3. **Build** — `npm run build` → **success**. Pilot is code-split into its own chunk
   (`SupabaseAuthPilot-*.js`); `/auth/session/resolve` is present only in that chunk and
   absent from the main chunk; no server-only secret pattern in any bundle.
4. **Static safety grep** — request path `/auth/session/resolve`, body `'{}'`, Bearer-only
   authority, no rendered token/JWT/refresh token, no token `console.log`, redaction applied
   to `internalUserId`/`authProviderUid`, `authorization: null` displayed, no server-only
   secret import — all confirmed (and codified in the diagnostic).
5. **Backend regression** —
   - `diagnostics-session-resolve-check.ts` → **M7 19/19 PASS**
   - `diagnostics-session-resolve-contract-check.ts` → **M6 15/15 PASS**
   - `diagnostics-appsession-map-check.ts` → **M5 7/7 PASS**
   - `diagnostics-supabase-whoami-check.ts` → **M3 23/23 PASS** (live mapping I1 skipped — no test token, hermetic mode)
   - `diagnostics-protected-action-check.ts` → **M2 8/8 PASS**
6. **Backend disabled-path smoke (no test credentials)** —
   - Flags ON, POST with **no token** → **401 `denied_unauthenticated`** (`authorization: null`).
   - `ENABLE_SESSION_RESOLVE` absent → **404 `FEATURE_DISABLED`**.
   - Identity API stopped afterward; ports clear.
7. **Runtime isolation grep** — new client imported only by `SupabaseAuthPilot.tsx`
   (+ static script); no import from AccessContext / AccessGuard / Login / App / business /
   server.
8. **Forbidden-file diff** — no diff in any forbidden file (§14 list).

---

## 13. Owner UI QA checklist

M8 adds visible pilot UI, so owner UI QA is required before commit.

1. Open `/dev/supabase-pilot`.
2. Confirm the pilot still shows the dev-only diagnostic warning banner.
3. Sign in with the **owner's own** Supabase credentials manually (do **not** use
   `SUPABASE_TEST_EMAIL`; do not add test secrets).
4. Confirm the existing "Run whoami diagnostic" still works.
5. Click **"Resolve App Session"**.
6. Confirm the result card appears.
7. Confirm expected success display: HTTP 200; `authState: authenticated`; `decision: allow`;
   `reasonCode: verified_supabase`; `sourceOfTruth: supabase_verified_token`; redacted
   `internalUserId`; redacted `authProviderUid`; `authProvider: supabase`; `authorization: null`.
8. Confirm **no token / JWT / refresh token** appears anywhere on screen.
9. Confirm the copy says dev diagnostic / not app authorization.
10. Stop the identity API, click again → confirm the API-unreachable message.
11. Restart the identity API **without** `ENABLE_SESSION_RESOLVE`, click again → confirm the
    disabled/flags-off message.
12. Sign out → confirm the resolve action is gated/cleared.
13. Confirm Firebase login and the main app routes remain unaffected.

Do not commit until owner UI QA passes.

---

## 14. Forbidden files (must show no diff)

`.replit`, `package.json`, `package-lock.json`, `vite.config.ts`, `src/firebase.ts`,
`src/components/Login.tsx`, `src/context/AccessContext.tsx`, `src/components/AccessGuard.tsx`,
`src/components/NotProvisioned.tsx`, `src/components/DevSessionSwitcher.tsx`, `src/App.tsx`,
`src/context/accessConfig.ts`, `src/owner/platformPermissionsConfig.ts`,
`src/auth/appSession.ts`, `src/auth/mapWhoamiToAppSession.ts`, `server/platform-identity/**`,
`server/index.ts`, shipping sidecar files, migrations/schema/RLS, `firestore.rules`,
Supabase config files, MCP config files, secrets/env files.

---

## 15. Rollback plan

M8 is fully reversible with no migration or config impact:

1. Delete `src/pilot/sessionResolvePilotClient.ts`.
2. Delete `scripts/diagnostics-session-resolve-pilot-check.ts`.
3. Delete `docs/phase-1.5-milestone-8-session-resolve-pilot-integration.md`.
4. Revert `src/pilot/SupabaseAuthPilot.tsx` to checkpoint
   `70fb6cdf00a87cb50d4af01978280c88c2f24316`.

Equivalent: `git checkout 70fb6cdf -- src/pilot/SupabaseAuthPilot.tsx` then remove the three
added files. No backend, schema, RLS, Supabase, or Firebase rollback is needed (none changed).

---

## 16. Final status

- **Resumed and implemented** within the accepted Option C scope.
- **Not committed. Not pushed. Not backed up.**
- **Pending owner UI QA.**
- Working tree contains **only** the allowed uncommitted M8 changes.
