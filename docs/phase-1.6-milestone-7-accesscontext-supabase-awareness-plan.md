# Phase 1.6 M7 — AccessContext Supabase Awareness Helper (Dormant, DEV-Flag-Gated) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No current app behavior changed. **AccessContext is byte-for-byte
unchanged**; Firebase remains the **sole active / default / authoritative** session source.
No DB connection, migration, seed, SQL, audit write, Supabase MCP, live route call, package
change, backend change, or production change occurred.

**Accepted base checkpoint:** `1918b7e21c4bf5d4203f8ea8bc48d1905193a5b0`
(Phase 1.6 M6 — add dormant Supabase session bootstrap).

> **Superseded by M8 (wiring):** Phase 1.6 M8 wired this helper into `src/context/AccessContext.tsx`
> as a private, DEV+flag-gated, one-shot dynamic-import observer (the "AccessContext is byte-for-byte
> unchanged" statement below describes the M7 state only). See
> [`docs/phase-1.6-milestone-8-accesscontext-one-shot-supabase-observer-plan.md`](phase-1.6-milestone-8-accesscontext-one-shot-supabase-observer-plan.md).

**Design choice:** **Option C** from the accepted M7 planning pass — a clean, standalone,
**dormant** awareness helper that imports the M6 bootstrap but is wired into nothing, with
**one** owner-approved controlled update (bootstrap dormancy `check 10b`). AccessContext is
**not** touched; the M6 AccessContext-authority diagnostic stays unchanged and green.

---

## 1. Scope

M7 is **Stage-3b groundwork only**. It builds and proves — in isolation — the one-shot,
cancellation-safe, no-throw **awareness observation lifecycle** that a FUTURE AccessContext
wiring pass (M8) will call. In M7 nothing imports or calls the helper.

**In scope (added):**

- `src/auth/supabaseAccessAwareness.ts` — dormant helper; imports the M6 bootstrap only.
- `src/auth/supabaseAccessAwarenessTypes.ts` — pure types (no imports; no token fields).
- `scripts/diagnostics-accesscontext-supabase-awareness-observational-check.ts` — 53-check proof.
- This document.

**In scope (controlled modifications):**

- `scripts/diagnostics-supabase-session-bootstrap-dormant-check.ts` — **only `check 10b`**: the bootstrap may now be imported by exactly `src/auth/supabaseAccessAwareness.ts`. `10a` (entrypoints) and all token/mutation/secret/session-resolve/server-authz checks unchanged.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — additive `2c` only (helper identifiers absent from bundle); no existing check weakened.
- `replit.md` — one M7 pointer line; `docs/phase-1.6-milestone-6-…-plan.md` — one pointer line.

**Explicitly NOT touched:** **`src/context/AccessContext.tsx`**, `firebase.ts`, `Login.tsx`,
`NotProvisioned.tsx`, `accessConfig.ts`, `platformPermissionsConfig.ts`, `appSession.ts`,
`mapWhoamiToAppSession.ts`, **`supabaseAuthFoundation.ts` / `supabaseAuthFoundationTypes.ts`**,
**`supabaseSessionBootstrap.ts` / `supabaseSessionBootstrapTypes.ts`**, `AccessGuard.tsx`,
`App.tsx`, `main.tsx`, **all `src/pilot/**`**, the **M6 AccessContext-authority diagnostic**,
`package.json`, `package-lock.json`, migrations, seeds, `server/**`, `.replit`. No new
dependency. No `src/auth/index.ts` barrel.

---

## 2. Dormant awareness helper design

`src/auth/supabaseAccessAwareness.ts` has **no import-time side effects** and **no top-level
await**. Safety derives from **non-importation**: no active entrypoint imports it, so the
bundler **tree-shakes it (and, through it, the bootstrap + foundation) out of production**
(verified — §8).

- **Imports the M6 bootstrap only** (`readSupabaseSessionSnapshot`, `isSupabaseSessionBootstrapEnabled`) + safe types. **No** `@supabase/supabase-js`, **no** React, **no** Firebase, **no** AccessContext, **no** M5 foundation direct import.
- **One-shot, cancellation-safe, no-throw runner** `runAccessContextSupabaseAwarenessObservation({ signal? })`: checks cancellation before and after a single `await readSupabaseSessionSnapshot()`, catches errors into a safe record, and resolves a **non-secret** awareness record in every branch. No subscription, no polling, no interval. **No call site in M7.**
- **Gated**: enabled only when DEV **and** the awareness flag is `'true'` **and** the M6 bootstrap is enabled.

---

## 3. DEV-only flag strategy

- **`VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS`** — DEV-only, **default OFF**; enablement = `DEV === true && flag === 'true' && isSupabaseSessionBootstrapEnabled()`.
- Separate from the foundation/bootstrap/pilot/shadow flags (the helper source does not repeat those names, preserving the M4–M6 "dormant flag" invariants).
- **Absent ⇒** no awareness, Firebase-only path, no observer, no mutation, no behavior change. Nothing imports the helper, so the flag changes nothing in M7.

---

## 4. Observer lifecycle & cancellation strategy

**One-shot, not subscribe** (lowest risk; subscription deferred). The runner accepts an
optional `AbortSignal`; it returns a `cancelled` record if aborted before or after the read,
so a future AccessContext `useEffect` cleanup (and React StrictMode double-invoke) is handled
cleanly. It performs **no** state writes — a future caller decides what to do with the record.

---

## 5. Awareness record / token safety

The record is **non-secret**: `{ enabled, cancelled, hasSession, status, email, source, message }`.
It **never** contains or references an `access_token`, `refresh_token`, raw JWT, provider
token, authorization payload, permissions, subPermissions, role, tenant, or plan. `email` is
the bootstrap's already-**redacted** reference hint. No logging of tokens/session.

---

## 6. AccessContext non-change & Firebase authority

AccessContext is **byte-for-byte unchanged**: it still subscribes to Firebase
`onAuthStateChanged` + Firestore `users/{uid}`, owns the legacy permission engine, and does
**not** import the helper, bootstrap, foundation, or Supabase SDK. The binding transition
semantics are unchanged: **`authorization: null` means fall back to the legacy client engine**
during the transition — never fail-open, blanket-deny, or blank-permissions. Firebase remains
default/authoritative. The M6 AccessContext-authority diagnostic stays unchanged and green.

---

## 7. Frontend secret-safety + bundle scan

Source: M4 readiness scan + the new observational diagnostic (no service-role/DB-URL, no token
references, no mutation). Emitted bundle: the M5/M6 bundle scan (extended with an additive
helper-absence check) confirms no privileged Supabase/DB secret and that the **foundation,
bootstrap, and awareness helper identifiers are all absent** (tree-shaken). `npm run build`
is offline/esbuild; `dist/` is git-ignored and not committed. If a build cannot run, the scan
defers cleanly (exit 0) and source-level guarantees still hold.

---

## 8. Tree-shaking / dormancy verification

A fresh production build’s bundle scan confirms `supabaseAccessAwareness` /
`VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS`, the bootstrap, and the foundation identifiers
do **not** appear in any emitted artifact — because nothing imports the helper, the whole
chain is dead-code-eliminated and cannot activate in production.

---

## 9. QA (this pass — offline / non-live only)

| Command | Result |
| --- | --- |
| `diagnostics-accesscontext-supabase-awareness-observational-check` | 53/53 pass |
| `diagnostics-supabase-session-bootstrap-dormant-check` (updated `10b`) | 44/44 pass |
| `diagnostics-accesscontext-firebase-authority-check` (unchanged) | 23/23 pass |
| foundation-dormancy / inventory / readiness | 37/37, 21/21, 20/20 |
| Full M1–M6 regression | all green |
| `npm run build` (offline) + bundle scan | succeeds; foundation + bootstrap + helper absent |
| `npx tsc --noEmit` | 12 pre-existing unrelated errors; **0 new; 0 in any M7 file** |

No live / DB-backed / audit-writer / session-resolve-live / M11.2–M11.5 route diagnostic was
run; no DB connection, SQL, Supabase MCP, or `audit_event` write occurred; no existing
protected `src/**` file was modified (only the two new `src/auth/` helper files were added).

---

## 10. Rollback plan

No DB/audit rollback required (no migration/seed/SQL/schema/RLS/Auth change or DB/audit write;
`dist/` git-ignored). Code rollback:

1. Delete `src/auth/supabaseAccessAwareness.ts` and `src/auth/supabaseAccessAwarenessTypes.ts`.
2. Delete `scripts/diagnostics-accesscontext-supabase-awareness-observational-check.ts`.
3. Delete this doc.
4. Revert the controlled `10b` update in `diagnostics-supabase-session-bootstrap-dormant-check.ts`.
5. Revert the additive `2c` helper-absence check in `diagnostics-frontend-bundle-secret-scan-check.ts`.
6. Revert the `replit.md` M7 pointer line and the M6-doc pointer line.

Equivalently `git checkout 1918b7e -- <touched existing files>` and remove the untracked new
files. No existing `src/**` runtime file was changed.

---

## 11. Deferred M8 AccessContext wiring plan (Option E — separately approved)

When M8 wires the helper into AccessContext, it must:

- Call `runAccessContextSupabaseAwarenessObservation()` from a **DEV-gated** `useEffect` that runs **after** the Firebase init path, via a **dynamic `import()` inside the statically-false DEV branch** so the helper/bootstrap/foundation are provably excluded from the production bundle (assert via the bundle scan).
- Store the record in a **private ref only** (or a diagnostic-only state), **not** exposed through the context provider value.
- **Never** use the record for session, tenant, role, plan, permissions, subPermissions, `hasPermission`, `checkSubPermission`, `canAccess`, AccessGuard, loading, or routing.
- Be cancellation-safe on cleanup (StrictMode double-invoke) and never call `setLoading`.

---

## 12. Deferred stages (unchanged, restated)

AccessContext actual one-shot observer wiring (M8) · session-resolve integration into the main
app (Stage 4) · pilot `authorization: null` pin update (Stage 4) · AccessContext read-only
adapter (Stage 5) · shadow/observational server authorization behind the future server-authz
shadow flag (Stage 5) · server-derived enforcement switch (Stage 6) · Firebase retirement ·
Login migration · protected business API enforcement · Backend Control Plane · Database
Operations Console / direct DB control · production migration 003 apply. None begins in M7.
