# Phase 1.6 M6 — Dual-Provider Session Bootstrap (Dormant, DEV-Flag-Gated) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No current app behavior changed. Firebase remains the **sole active /
default / authoritative** session source. AccessContext is untouched. No DB connection,
migration, seed, SQL, audit write, Supabase MCP, live route call, package change, backend
change, or production change occurred.

**Accepted base checkpoint:** `2624403fdb81beb3b7833f303f78d88061a5aba2`
(Phase 1.6 M5 — add dormant Supabase auth foundation).

**Follow-on:** Stage 3b (the dormant AccessContext awareness helper that imports this
bootstrap) is implemented in **Phase 1.6 M7** — see
[`docs/phase-1.6-milestone-7-accesscontext-supabase-awareness-plan.md`](phase-1.6-milestone-7-accesscontext-supabase-awareness-plan.md).

**Design choice:** **Option C** from the accepted M6 planning pass — a clean, app-level,
**dormant** Supabase session-bootstrap module that imports the M5 foundation but is wired
into nothing, with two **owner-approved, controlled** allowlist updates to the M5
dormancy + inventory diagnostics (the foundation may now be imported by exactly the one
bootstrap file).

---

## 1. Scope

M6 is **Stage-3 groundwork only**. It adds a **dormant** Supabase session-bootstrap that,
*when explicitly invoked*, reads a **non-secret, observational** snapshot of Supabase
session presence **through** the M5 foundation. In M6 it is invoked by nothing.

**In scope (added):**

- `src/auth/supabaseSessionBootstrap.ts` — the dormant bootstrap (lazy async reader; imports the M5 foundation only).
- `src/auth/supabaseSessionBootstrapTypes.ts` — pure types (no imports; no token fields).
- `scripts/diagnostics-supabase-session-bootstrap-dormant-check.ts` — bootstrap dormancy/token/mutation proof.
- `scripts/diagnostics-accesscontext-firebase-authority-check.ts` — locks AccessContext as Firebase-authoritative.
- This document.

**In scope (controlled modifications):**

- `scripts/diagnostics-supabase-auth-foundation-dormant-check.ts` — **only `check 8b`**: foundation may now be imported by exactly `src/auth/supabaseSessionBootstrap.ts`. `8a` (entrypoints) and all secret-safety checks unchanged.
- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **only `check 2g`**: same single-file allowlist. `2f` (entrypoints), the SDK allowlist (`2a`), and pilot isolation (`2b`/`2c`) unchanged.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — additive `2b` only (bootstrap identifiers absent from bundle); no existing check weakened.
- `replit.md` — one M6 pointer line.
- `docs/phase-1.6-milestone-5-…-foundation-plan.md` — one pointer line.

**Explicitly NOT in scope / NOT touched:** `src/firebase.ts`, `Login.tsx`,
`NotProvisioned.tsx`, **`AccessContext.tsx`**, `accessConfig.ts`,
`platformPermissionsConfig.ts`, `appSession.ts`, `mapWhoamiToAppSession.ts`,
**`supabaseAuthFoundation.ts` / `supabaseAuthFoundationTypes.ts`** (M5 foundation — only
imported by the new bootstrap), `AccessGuard.tsx`, `App.tsx`, `main.tsx`, **all
`src/pilot/**`**, `package.json`, `package-lock.json`, migrations, seeds, `server/**`,
`.replit`. No new dependency. No `src/auth/index.ts` barrel.

---

## 2. Dormant bootstrap design

`src/auth/supabaseSessionBootstrap.ts` is a library module with **no import-time side
effects** and **no top-level await**. Safety derives from **non-importation**: no active
entrypoint imports it, so the bundler **tree-shakes it (and, through it, the foundation)
out of production** (verified — §8).

- **Imports the M5 foundation only** (`getSupabaseAuthFoundation`), plus safe local/foundation types. It does **not** import `@supabase/supabase-js` directly — the direct SDK import stays confined to the foundation + `src/pilot/**`. It reads the session via a **minimal structural cast** of the foundation's `client` handle.
- **Lazy async reader** `readSupabaseSessionSnapshot()`: constructs nothing at import; reads a session only when explicitly called (no call site in M6). No-throw in every branch.
- **Gated**: returns a disabled/unavailable snapshot unless DEV **and** the bootstrap flag is `'true'` **and** the foundation is `'ready'` **and** a session exists.

---

## 3. DEV-only flag strategy

- **`VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP`** — DEV-only, **default OFF**; enablement = `DEV === true && flag === 'true'`.
- Intentionally **separate** from the foundation flag, the dev pilot's flag, and the future server-authz shadow flag (the bootstrap source does not repeat those names, preserving the M4/M5 diagnostics' "dormant flag" invariants).
- **Absent ⇒** bootstrap disabled, Firebase-only active path, no Supabase session observation, no state mutation. Because nothing imports the bootstrap, the flag changes nothing in M6 — it only gates a future, separately-approved AccessContext-awareness stage.

---

## 4. Why each authority/area is unchanged

- **Firebase remains authoritative.** `AccessContext` still subscribes to Firebase `onAuthStateChanged` + Firestore `users/{uid}` and is the only session source; it does **not** import the foundation or bootstrap. Locked by `diagnostics-accesscontext-firebase-authority-check.ts`.
- **AccessContext untouched** — no observational change, no dual-provider read inside it. That is deferred to a later, separately-approved stage.
- **Login untouched** — Firebase `signInWith…` / `signOut(auth)` only.
- **AccessGuard untouched** — still reads `useAccess()`.
- **App routing untouched** — no new route/provider; the bootstrap is not imported by `App.tsx`. Pilot route gating unchanged.
- **`src/pilot/**` untouched**; the pilot `authorization: null` pin is **not** modified.

---

## 5. Session snapshot / token safety

The snapshot is **non-secret and observational**: `{ enabled, hasSession, status, email, message }`. It **never** contains or references an `access_token`, `refresh_token`, raw JWT, provider token, authorization payload, permissions, subPermissions, role, tenant, or plan. The structural cast exposes only session **presence** and an optional **redacted** reference email (e.g. `a***@example.com`) — reference-only, never a credential. The bootstrap performs **no logging** of tokens/session payloads and **no state mutation** (no React, no setters, no AccessContext).

---

## 6. Firebase default / fallback strategy

AccessContext (Firebase `onAuthStateChanged`) remains the only session source. The binding
transition semantics are unchanged: **`authorization: null` means fall back to the legacy
client engine** during the transition — it does **not** mean fail-open, blanket deny, or
blank permissions. The browser never authorizes itself; the legacy engine is the safety net
until server-derived enforcement is proven. Firebase stays default/fallback until the
Supabase session bootstrap (and later stages) are proven.

---

## 7. Frontend secret-safety + bundle scan

- Source: M4 readiness scan over `src/**` + the new bootstrap dormancy diagnostic (no service-role/DB-URL; no token references; no mutation).
- Emitted bundle: the M5 bundle scan (extended with an additive bootstrap-absence check) confirms no privileged Supabase/DB secret and that **both** the foundation and bootstrap identifiers are **absent** from the production bundle (tree-shaken). `npm run build` is offline/esbuild (not gated by `tsc`); `dist/` is git-ignored and not committed. If a build cannot run, the scan defers cleanly (exit 0) and source-level guarantees still hold.

---

## 8. Tree-shaking / dormancy verification

A fresh production build’s bundle scan confirms `supabaseSessionBootstrap` /
`VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP` and the foundation identifiers do **not** appear
in any emitted artifact — because nothing imports the bootstrap, it is dead-code-eliminated
and cannot activate in production.

---

## 9. QA (this pass — offline / non-live only)

| Command | Result |
| --- | --- |
| `diagnostics-supabase-session-bootstrap-dormant-check` | 44/44 pass |
| `diagnostics-accesscontext-firebase-authority-check` | 23/23 pass |
| `diagnostics-supabase-auth-foundation-dormant-check` (updated `8b`) | 37/37 pass |
| `diagnostics-frontend-auth-provider-inventory-check` (updated `2g`) | 21/21 pass |
| `diagnostics-frontend-supabase-auth-readiness-check` | 20/20 pass |
| Full M1/M2/M3/M4/M5 regression | all green |
| `npm run build` (offline) + bundle scan | succeeds; foundation + bootstrap absent |
| `npx tsc --noEmit` | 12 pre-existing unrelated errors; **0 new; 0 in any M6 file** |

No live / DB-backed / audit-writer / session-resolve-live / M11.2–M11.5 route diagnostic
was run; no DB connection, SQL, Supabase MCP, or `audit_event` write occurred; no existing
protected `src/**` file was modified (only the two new `src/auth/` bootstrap files were added).

---

## 10. Rollback plan

No DB/audit rollback required (no migration/seed/SQL/schema/RLS/Auth change or DB/audit
write; `dist/` git-ignored). Code rollback:

1. Delete `src/auth/supabaseSessionBootstrap.ts` and `src/auth/supabaseSessionBootstrapTypes.ts`.
2. Delete `scripts/diagnostics-supabase-session-bootstrap-dormant-check.ts`.
3. Delete `scripts/diagnostics-accesscontext-firebase-authority-check.ts`.
4. Delete this doc.
5. Revert the controlled `8b` update in `diagnostics-supabase-auth-foundation-dormant-check.ts`.
6. Revert the controlled `2g` update in `diagnostics-frontend-auth-provider-inventory-check.ts`.
7. Revert the additive `2b` bootstrap-absence check in `diagnostics-frontend-bundle-secret-scan-check.ts`.
8. Revert the `replit.md` M6 pointer line and the M5-doc pointer line.

Equivalently `git checkout 2624403 -- <touched existing files>` and remove the untracked
new files. No existing `src/**` runtime file was changed.

---

## 11. Deferred stages (unchanged, restated)

AccessContext awareness of a Supabase session (Stage 3b) · session-resolve integration into
the main app (Stage 4) · pilot `authorization: null` pin update (Stage 4) · AccessContext
read-only adapter (Stage 5) · shadow/observational mode behind the future server-authz
shadow flag (Stage 5) · server-derived enforcement switch (Stage 6) · Firebase retirement ·
Login migration · protected business API enforcement · Backend Control Plane · Database
Operations Console / direct DB control · production migration 003 apply. None begins in M6.
