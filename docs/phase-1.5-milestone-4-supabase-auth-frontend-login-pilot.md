# Phase 1.5 M4 — Supabase Auth Frontend Login Pilot

**Status:** IMPLEMENTED, pending review / manual QA. **Not committed, not pushed, not backed up.**

**Branch:** `main` · **Checkpoint at start:** `aef57ee5e1dfcb20ea3b2184550f86da3208c0fa` (unchanged — no commit made).

---

## 1. Scope

M4 introduces an **isolated, dev-only, feature-flagged Supabase Auth frontend pilot** that proves, in the browser:

1. Supabase **email/password** sign-in and sign-out.
2. A **safe** view of session state (no raw token).
3. An **optional** round-trip of the Supabase access token to the **existing, unchanged** M3 backend diagnostic (`POST /diagnostics/supabase-whoami`) using only `Authorization: Bearer <token>`.

It does **not** replace Firebase login, does **not** touch `AccessContext` / `AccessGuard` / `Login.tsx` / routing for normal users / Firestore provisioning / Dev Session / any business module, and changes **no** backend identity-API code, schema, or RLS.

**Identity vs authorization:** the pilot proves **identity only**. The Supabase user/session is never treated as app authorization; no client-asserted role/tenant/store/permission is sent or trusted. Authorization remains server-derived and is out of scope.

## 2. Files changed

**Added (`src/pilot/**`):**
- `src/pilot/pilotEnv.ts` — single audit point for the pilot's **public** Vite env vars + the route gate.
- `src/pilot/supabaseClient.ts` — isolated Supabase **browser** client built from public anon key + URL; renders a safe "not configured" state if either is missing (never throws).
- `src/pilot/identityDiagnosticClient.ts` — thin client for the unchanged M3 whoami endpoint; sends **only** the Bearer token + empty body.
- `src/pilot/SupabaseAuthPilot.tsx` — the dev-only pilot screen.

**Modified (allowed scope only):**
- `src/App.tsx` — **one additive** lazy import + a conditional spread that registers `/dev/supabase-pilot` only when `PILOT_ROUTE_ENABLED`. No existing route changed.
- `vite.config.ts` — **one additive** dev proxy `'/__identity' → http://localhost:5002` (prefix stripped). No other change.
- `package.json` / `package-lock.json` — add `@supabase/supabase-js@^2.108.1` (frontend only).

**Documentation:** this file (+ one concise `replit.md` milestone line).

## 3. Environment variables

**Frontend, public, client-safe (new `VITE_` vars — set by the owner, not committed):**

| Var | Purpose | Client-safe? |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | ✅ public |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/publishable key (RLS is the real guard) | ✅ public by design |
| `VITE_ENABLE_SUPABASE_PILOT` | `'true'` to surface the dev route | ✅ public |
| `VITE_IDENTITY_API_BASE` | Identity API base; default `/__identity` (dev proxy) | ✅ public |

Recommended dev values: `VITE_ENABLE_SUPABASE_PILOT=true`, `VITE_IDENTITY_API_BASE=/__identity`.

**Forbidden in the frontend / forbidden as `VITE_` vars (server-only):**
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_TEST_PASSWORD`, `SUPABASE_TEST_ACCESS_TOKEN`, any DB URL / service-role / JWT secret / raw access token. M4 source reads **none** of these (verified by scan).

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, the pilot renders a safe disabled state and does not throw.

## 4. Public vs server-only boundary

Every pilot env read goes through `src/pilot/pilotEnv.ts`, which reads **only** `VITE_`-prefixed values. Vite only exposes `VITE_`-prefixed vars to the bundle, so server-only secrets cannot reach the browser through the pilot. Bundle + source scans confirm zero server-only secret values in the built output.

## 5. Route / UI behavior

- Route: `/dev/supabase-pilot`, registered **only** when `import.meta.env.DEV` **and** `VITE_ENABLE_SUPABASE_PILOT === 'true'` (`PILOT_ROUTE_ENABLED`). Default OFF.
- Registered **outside** the `/` and `/owner` guarded trees and **not** wrapped by `AccessGuard`.
- Because the gate includes `import.meta.env.DEV`, a **production build never activates the route** (mirrors the project's existing `DevSessionSwitcher` dev-gating pattern). The pilot is additionally **code-split** into its own lazy chunk (`SupabaseAuthPilot-*.js`), so it is never in the main bundle and is fetched only if the route is visited in dev.
- The screen shows a clear banner: *"Diagnostic pilot only — proves Supabase identity, not app authorization."*

## 6. Supabase sign-in / session behavior

- Email/password sign-in via `supabase.auth.signInWithPassword`; sign-out via `supabase.auth.signOut`; session tracked via `getSession` + `onAuthStateChange`.
- **Safe session panel** shows only: provider (`supabase`), **redacted** user id, email (if present), display name (if present), **access-token-present boolean**, token **expiry** timestamp, session active state.
- The raw access token and full JWT payload are **never** rendered, logged, persisted by the pilot, or written to a file. The password is cleared from state after submit.
- The pilot does **not** import Firebase or `AccessContext`, does **not** create Firestore docs, and does **not** navigate into the app after sign-in.

## 7. Whoami diagnostic behavior

- Manual **"Run whoami diagnostic"** button only.
- Calls `${VITE_IDENTITY_API_BASE || '/__identity'}/diagnostics/supabase-whoami` with **only** `Authorization: Bearer <token>` + empty JSON body. Sends no user object / role / tenant / store / permission / client claim.
- Renders only safe fields: HTTP status, `requestId`, `authState`, `internalUserId` (redacted), `decision`, `reasonCode`, `sourceOfTruth`, error code/note.
- A non-200 is shown as a **diagnostic failure**, explicitly not an app authorization decision.

## 8. Vite dev proxy strategy

To avoid any backend CORS change (the M3 identity API is on the do-not-touch list), the pilot calls a **same-origin** path `/__identity/...` that the Vite dev server proxies to `http://localhost:5002`, stripping the `/__identity` prefix. The backend (`server/platform-identity/server.ts`) is unchanged. Verified end-to-end: `POST /__identity/diagnostics/supabase-whoami` (no token) via the dev server reached `:5002` and returned `401 denied_unauthenticated`.

## 9. QA evidence (Claude-run)

| Check | Result |
|---|---|
| M3 hermetic harness (`scripts/diagnostics-supabase-whoami-check.ts`) | **23/23 PASS** (I1 live skipped, as designed) |
| M2 regression (`scripts/diagnostics-protected-action-check.ts`) | **8/8 PASS** |
| `tsc --noEmit` | **12 errors total = baseline** (all pre-existing/unrelated); **0 errors in M4 files** |
| Build, pilot disabled (`vite build`) | success; route not registered at runtime; pilot is a separate lazy chunk |
| Build, pilot enabled (placeholder `VITE_*`) | success; placeholder URL injected (env wiring confirmed) |
| Bundle secret scan | **CLEAN** — no service-role key, DB URL, server `SUPABASE_URL`/`SUPABASE_ANON_KEY`, JWT secret, or raw JWT pattern in `dist/` |
| Source scan | M4 reads no server-only env; no forbidden `VITE_`-server var; no secret literal |
| Whoami contract probe | flags ON + no token → **401 `denied_unauthenticated`**; flags OFF → **404 `FEATURE_DISABLED`** |
| Vite proxy round-trip | `/__identity` → `:5002`, prefix stripped → **401 `denied_unauthenticated`** |
| Forbidden-file diff | unchanged: `firebase.ts`, `Login.tsx`, `AccessContext.tsx`, `AccessGuard.tsx`, `NotProvisioned.tsx`, `DevSessionSwitcher.tsx`, `accessConfig.ts`, `platformPermissionsConfig.ts`, `server/index.ts`, `server/platform-identity/**`, `server/adapters/**`, `firestore.rules`, `.replit` |

**Baseline `tsc` errors (pre-existing, unrelated to M4):** `server/adapters/easypost.ts`, `server/event-processor.ts` (×2), `src/components/DashboardOverview.tsx` (×2), `src/components/Login.tsx`, `src/components/POS.tsx`, `src/components/ShippingCenter.tsx`, `src/components/TemplateEditor.tsx`, `src/layouts/OwnerLayout.tsx`, `src/layouts/TenantLayout.tsx`, `src/owner/BillingPage.tsx`. The project does not wire `vite/client` types, so several pre-existing `import.meta.env` errors are baseline; M4 routes all env reads through a cast in `pilotEnv.ts` and adds none.

> Note: during the whoami probe, the Replit environment auto-registered the temporary test ports into `.replit`; this was reverted so `.replit` is unchanged.

## 9a. Post-QA correction pass (2026-06-14)

Owner UI QA passed on every check **except** "Run whoami diagnostic", which returned **HTTP 500**. Triage root-caused this as an **operational setup issue, not an M4 code bug**: the isolated identity API (`npm run identity:api` → `server/platform-identity/server.ts` on `:5002`) was **not running** during QA, so the dev Vite proxy `/__identity → :5002` failed to connect and the dev server answered the browser with **HTTP 500 + an empty body**. Direct/proxy probes confirmed correct behavior once the API is up (no token → **401 `denied_unauthenticated`**; flags off → **404 `FEATURE_DISABLED`**); the M3 endpoint, proxy wiring, env flags, and the pilot request contract are all correct. Two narrow corrections were made (no backend, schema, RLS, Firebase, AccessContext/Guard, `server/**`, or proxy change):

- **`.replit` reverted to HEAD.** The pending M4 diff had auto-registered temporary test ports into `.replit`; that diff was unauthorized and is now removed — `.replit` has **no diff**.
- **Diagnostic clarity message (pilot only).** `src/pilot/identityDiagnosticClient.ts` now emits a clear, actionable note when the whoami call gets a proxy/upstream **500/502/503/504 with an empty or non-JSON body** (the "identity API not running" case): *"Diagnostic API is unreachable through the dev proxy. Start `npm run identity:api` with the required M3 flags, then retry. (Diagnostic runtime issue — not app authorization.)"* It renders in the existing "Note" row. The `Authorization: Bearer`-only request contract, sign-in/out behavior, and token-never-rendered guarantees are unchanged; the note contains no token, JWT, Supabase URL, anon/service-role key, DB URL, or secret.

## 10. Owner UI QA (manual, required)

See the implementation report. In short: visit `/dev/supabase-pilot` (dev + flag on), sign in/out with the dev pilot user, confirm the safe panel shows no raw token, run the whoami diagnostic, and confirm Firebase login + Dev Session + normal navigation are unchanged and the pilot is invisible to normal users.

## 11. Rollback

Delete `src/pilot/`, revert the additive `src/App.tsx` route block + lazy import, revert the `vite.config.ts` proxy block, remove `@supabase/supabase-js` from `package.json`/lockfile, and unset the `VITE_*` pilot vars. No schema/RLS/migration/backend change to undo. Nothing was committed, so `git restore` discards everything.

## 12. Explicitly deferred (after M4)

- AccessContext migration to a provider-agnostic session source; Firebase Auth retirement/cutover.
- OAuth/Google/magic-link + Supabase redirect URL / Site URL / allowed-domain config.
- Real protected business API enforcement; tenant/store roles, scopes, RLS policies.
- Production enablement of the identity API / verified diagnostics; any backend CORS hardening for non-dev origins.
- Documenting the M3.1 live smoke result into the M3 doc / `replit.md`.

**Not committed / not pushed / not backed up — pending review.**
