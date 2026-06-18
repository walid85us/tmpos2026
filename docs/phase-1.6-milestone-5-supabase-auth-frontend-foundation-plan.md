# Phase 1.6 M5 — Supabase Auth Frontend Foundation (Dormant, DEV-Flag-Gated) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No current app behavior changed. Firebase remains the sole active/default
production session authority. No DB connection, migration, seed, SQL, audit write,
Supabase MCP, live route call, package change, backend change, or production change occurred.

**Accepted base checkpoint:** `b621b39cab2010367a01ceaa8a4d1a23f143fbaf`
(Phase 1.6 M4 — document Supabase auth migration readiness).

**Follow-on:** Stage 3 (the dormant dual-provider session bootstrap that imports this
foundation) is implemented in **Phase 1.6 M6** — see
[`docs/phase-1.6-milestone-6-dual-provider-session-bootstrap-plan.md`](phase-1.6-milestone-6-dual-provider-session-bootstrap-plan.md).

**Design choice:** **Option C / Design A** from the accepted M5 planning pass — a clean,
app-level, dormant-by-default Supabase auth foundation with a **static** Supabase SDK
import, and a **transparent, controlled** update to the M4 inventory diagnostic's SDK
allowlist (rather than hiding the import behind a dynamic import).

---

## 1. Scope

M5 is the first Phase 1.6 milestone that **adds new `src/**` files**. It introduces a
**dormant** Supabase browser-auth foundation that adapts the proven `src/pilot/**`
patterns into a real app-level module — **without importing, promoting, or modifying the
pilot**, and **without wiring the foundation into anything**.

**In scope (added):**

- `src/auth/supabaseAuthFoundation.ts` — the dormant foundation (lazy factory; anon-only).
- `src/auth/supabaseAuthFoundationTypes.ts` — pure types (no SDK import, no runtime).
- `scripts/diagnostics-supabase-auth-foundation-dormant-check.ts` — dormancy proof.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — emitted-bundle secret scan.
- This document.

**In scope (controlled modifications):**

- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **only** `check 2a`
  (SDK allowlist now = `src/pilot/**` **+** the one foundation file) plus new compensating
  dormancy assertions `2e`/`2f`/`2g`. No other check weakened.
- `replit.md` — one M5 pointer line.
- `docs/phase-1.6-milestone-4-supabase-auth-frontend-migration-plan.md` — one pointer line.

**Explicitly NOT in scope / NOT touched:** `src/firebase.ts`, `src/components/Login.tsx`,
`src/components/NotProvisioned.tsx`, `src/context/AccessContext.tsx`,
`src/context/accessConfig.ts`, `src/owner/platformPermissionsConfig.ts`,
`src/auth/appSession.ts`, `src/auth/mapWhoamiToAppSession.ts`,
`src/components/AccessGuard.tsx`, `src/App.tsx`, `src/main.tsx`, **all of `src/pilot/**`**,
`package.json`, `package-lock.json`, migrations, seeds, `server/**`, `.replit`. No new
package dependency (`@supabase/supabase-js@^2.108.1` already installed). No
`src/auth/index.ts` barrel.

---

## 2. Dormant foundation design

`src/auth/supabaseAuthFoundation.ts` is a **library module with no import-time side
effects**. Its safety derives from **non-importation**, not merely from runtime guards:
because no active entrypoint imports it, the bundler **tree-shakes it out of the
production bundle entirely** (verified — see §8).

- **Public env boundary only.** Reads exclusively the public, client-safe `VITE_`-prefixed
  values `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and the new DEV-only flag
  `VITE_ENABLE_SUPABASE_AUTH_FOUNDATION`, through a single narrow `import.meta` cast (so it
  adds **no** new `Property 'env' does not exist on type 'ImportMeta'` baseline error).
- **No client at import.** `createClient` is called **only** inside the lazy factory
  `getSupabaseAuthFoundation()`, which is **invoked by nothing** in M5. A module-scope
  `memoizedClient` is initialized to `null` — no eager construction.
- **No-throw state.** `getSupabaseAuthFoundationState()` returns a render-safe, non-secret
  status in every branch: `dormant_not_dev` → `dormant_flag_off` → `unconfigured_env` →
  `ready`. It never throws and never builds anything.
- **Trustless boundary.** Never reads a service-role key, DB URL / connection string, raw
  JWT secret, or any server-only Supabase env name. Never connects to the database. Never
  authorizes anything itself. Does **not** call the backend session-resolve route, any
  protected business API, any backend control API, or any database-control API. Imports no
  Firebase, no AccessContext, no Login, no AccessGuard, no App routing, no `src/main.tsx`,
  no server module, and no pilot module.

`supabaseAuthFoundationTypes.ts` is **types only** and deliberately imports **nothing** —
in particular it does **not** import `@supabase/supabase-js`, so the controlled SDK import
stays confined to the single foundation file (matching the inventory allowlist).

---

## 3. DEV-only flag strategy

- **`VITE_ENABLE_SUPABASE_AUTH_FOUNDATION`** — DEV-only, **default OFF**. Enablement is
  `isDevBuild() && flag === 'true'`; a production build (`import.meta.env.DEV === false`) is
  **always** off.
- **Separate from the dev pilot flag** and **separate from the future Stage-5 server-authz
  shadow flag** — the foundation's source intentionally does **not** repeat those exact env
  names, so the M4 frontend diagnostics' "dormant flag" invariants stay precise.
- **Absent ⇒ dormant + Firebase-only.** Even when the flag is `'true'`, M5 wires the module
  to **nothing** (no route, no provider switch, no call site). The flag exists only to gate
  **future** activation (Stage 3: dual-provider bootstrap).

---

## 4. Why each authority/area is unchanged

- **Firebase remains default.** `AccessContext` still subscribes to Firebase
  `onAuthStateChanged` and resolves the Firestore role doc; it is the **only** session
  source. The foundation is not imported into it, so Firebase is structurally the only
  reachable auth path.
- **Login unchanged.** No Supabase login, no logout migration, no session-lifecycle change;
  Firebase `signInWith…` / `signOut(auth)` remain the only login path.
- **AccessGuard unchanged.** No new guard logic, no Supabase/foundation import.
- **App routing unchanged.** No new route, no new provider; the foundation is **not**
  imported by `src/App.tsx`. Pilot route gating is byte-for-byte unchanged.
- **`src/pilot/**` unchanged.** The pilot stays isolated; the foundation copies its
  *patterns*, not its *files*. The pilot's `authorization: null` pin is **not** touched.
- **Server-derived authorization deferred.** No session-resolve integration, no adapter, no
  shadow mode, no enforcement — all later, separately-approved stages.

---

## 5. Frontend secret-safety boundary

- The anon key **may be public** (RLS is the real guard); the **service-role key and DB URL
  must never** reach the browser. The foundation references **only** public `VITE_` names.
- **Source-level** safety is locked by the M4 readiness diagnostic (forbidden-secret scan
  over `src/**`) and the new dormancy diagnostic (foundation-scoped secret + isolation
  assertions).
- **Emitted-bundle** safety is locked by the new bundle secret-scan diagnostic (§6).

---

## 6. Bundle secret-scan strategy

`scripts/diagnostics-frontend-bundle-secret-scan-check.ts` is offline and **never builds**;
it inspects an **existing** `dist/**` and prints **only** labels, counts, and filenames —
**never** matched content. It asserts the emitted bundle contains no
`SUPABASE_SERVICE_ROLE_KEY` / service-role identifier / `SUPABASE_DATABASE_URL` /
`DATABASE_URL` / connection string / `postgres(ql)://` / server-only (non-`VITE_`) Supabase
env name, and that the **dormant foundation identifiers are absent** (tree-shaken). It
treats the pre-existing `GEMINI_API_KEY` Vite `define` as **out-of-scope** and reports it as
a **note** only. If `dist/**` is absent it reports the scan **DEFERRED** (exit 0) — a
missing build is not an M5 failure; the source-level guarantees still hold.

`npm run build` is `vite build` (esbuild — **not** gated by `tsc`, so the 12 pre-existing
baseline type errors do not block it) and is offline/safe. `dist/` is git-ignored and is
**not** committed.

---

## 7. QA (this pass — offline / non-live only)

| Command | Result |
| --- | --- |
| `npx tsx scripts/diagnostics-supabase-auth-foundation-dormant-check.ts` | **37/37** pass |
| `npx tsx scripts/diagnostics-frontend-auth-provider-inventory-check.ts` | **21/21** pass |
| `npx tsx scripts/diagnostics-frontend-supabase-auth-readiness-check.ts` | **20/20** pass |
| Full M1/M2/M3/M4 regression (12 diagnostics) | all green |
| `npm run build` (offline) | succeeds (18s) |
| `npx tsx scripts/diagnostics-frontend-bundle-secret-scan-check.ts` | **7/7** pass |
| `npx tsc --noEmit` | 12 pre-existing unrelated errors; **0 new; 0 in any M5 file** |

No live / DB-backed / audit-writer / session-resolve-live / M11.2–M11.5 route diagnostic was
run; no DB connection, SQL, Supabase MCP, or `audit_event` write occurred; no existing
`src/**` file was modified (only the two new `src/auth/` files were added).

---

## 8. Tree-shaking / dormancy verification

A fresh production build emits the main `index-*.js` chunk, the CSS chunk, and the existing
lazy `SupabaseAuthPilot-*.js` pilot chunk (whose **route** stays unregistered in production
because `IS_DEV` is false). The bundle scan confirms the **foundation identifiers
(`supabaseAuthFoundation` / `getSupabaseAuthFoundation`) do not appear in any emitted
artifact** — because nothing imports the foundation, it is dead-code-eliminated. It cannot
activate in production even by accident.

---

## 9. Acceptance criteria (met)

Dormant foundation exists; DEV-flag-gated; default OFF; public `VITE_` names only; no
service-role/DB-URL reference; no Firebase/server/pilot import; no session-resolve / protected
API call; no import-time side effects; not imported by Login/AccessContext/AccessGuard/App/
`main`; Firebase remains the only active session authority; M4 diagnostics green after the
controlled allowlist update; dormancy + secret-safety + bundle-scan diagnostics pass; M1–M4
regression green; focused TS validation passes; 0 new TS errors; no package/backend/migration/
seed/SQL/DB/MCP/production/audit/`​.replit`/secret change.

---

## 10. Rollback plan

No DB/audit rollback required (no migration, seed, SQL, schema/RLS/Auth change, or DB/audit
write occurred; static diagnostics write zero audit rows; `dist/` is git-ignored). Code
rollback:

1. Delete `src/auth/supabaseAuthFoundation.ts` and `src/auth/supabaseAuthFoundationTypes.ts`.
2. Delete `scripts/diagnostics-supabase-auth-foundation-dormant-check.ts`.
3. Delete `scripts/diagnostics-frontend-bundle-secret-scan-check.ts`.
4. Delete this doc.
5. Revert the controlled `check 2a` + `2e`/`2f`/`2g` update in
   `scripts/diagnostics-frontend-auth-provider-inventory-check.ts`.
6. Revert the `replit.md` M5 pointer line.
7. Revert the M4 doc pointer line.

Equivalently: `git checkout b621b39 -- scripts/diagnostics-frontend-auth-provider-inventory-check.ts replit.md docs/phase-1.6-milestone-4-supabase-auth-frontend-migration-plan.md` and remove the untracked new files. No existing `src/**` runtime file was changed.

---

## 11. Deferred stages (unchanged, restated)

Dual-provider session bootstrap (Stage 3) · session-resolve integration into the main app
(Stage 4) · pilot `authorization: null` pin update (Stage 4) · AccessContext read-only adapter
(Stage 5) · shadow/observational mode behind the future server-authz shadow flag (Stage 5) ·
server-derived enforcement switch (Stage 6) · Firebase retirement · protected business API
enforcement · Backend Control Plane · Database Operations Console / direct DB control ·
production migration 003 apply. None of these begins in M5.
