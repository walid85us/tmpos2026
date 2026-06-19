# Phase 1.6 M9 — AccessContext Supabase Observer Private-Surface Lock (Docs + Diagnostics Only) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. **No `src/**` runtime change.** No current app behavior changed. **Firebase
remains the sole active / default / authoritative session source.** No DB connection,
migration, seed, SQL, audit write, Supabase MCP, live route call, package change, backend
change, or production change occurred.

**Accepted base checkpoint:** `09c0be1871f198db399a6b14f6aaeb461ff18d3b`
(Phase 1.6 M8 — wire private Supabase awareness observer).

**Selected design:** **Option B** from the accepted M9 planning pass — **docs + diagnostics
only**. M9 adds a permanent, offline, static regression guard that LOCKS the M8 observer as
private/write-only/non-authoritative and proves it is NEVER surfaced through any channel. M9
implements **no runtime surfacing** of the observer record.

---

## 1. Scope

M9 is **Stage 3d** consideration resolved as a **no-surfacing lock**. It does not expose the
M8 observer record; it makes the M8 private boundary permanently enforceable in CI/diagnostics
and documents the (deferred) future surfacing contract should a need ever arise.

**In scope (added):**

- `scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts` — offline,
  text-only, self-inert (46 checks).
- This document.

**In scope (modified):**

- `replit.md` — one M9 pointer line.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive** check `2d` only
  (reserved diagnostic-surface flag + `__TM_POS_SUPABASE_AWARENESS__` window hook must be
  absent from the emitted bundle). No existing check weakened; no matched content printed.
- `docs/phase-1.6-milestone-8-…-plan.md` — one concise pointer line.

**Explicitly NOT touched:** **`src/context/AccessContext.tsx`** and the M8 observer wiring,
Login, AccessGuard, App routing, `src/main.tsx`, `src/pilot/**`, `src/firebase.ts`,
`accessConfig.ts`, `platformPermissionsConfig.ts`, **M5 foundation files**, **M6 bootstrap
files**, **M7 helper files**, all `server/**`, migrations, seeds, `package.json`,
`package-lock.json`, secrets, Supabase/Firebase config, `.replit`. No `src/**` runtime file
changed at all.

---

## 2. M8 private observer inventory (what M9 locks)

In `src/context/AccessContext.tsx` (unchanged by M9):
- a TYPE-ONLY `AccessAwarenessRecord` import (erased at runtime),
- a private `const supabaseAwarenessRef = useRef<AccessAwarenessRecord | null>(null)`,
- one isolated `useEffect` (deps `[loading]`): DEV guard → `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS`
  guard → `if (loading) return` → `AbortController` → dynamic `import('../auth/supabaseAccessAwareness')`
  → `runAccessContextSupabaseAwarenessObservation({ signal })` → assign to the ref only if not
  aborted → cleanup aborts.

The ref is **write-only** and consumed by nothing.

## 3. Observer data classification

`AccessAwarenessRecord` = `{ enabled, cancelled, hasSession, status, email, source, message }`:
booleans + a status enum + non-secret label strings; `email` is a **redacted** reference hint
(`a***@example.com`) or `null`. It contains **no** access/refresh/provider token, raw JWT,
authorization payload, role, tenant, plan, permissions, or subPermissions. It is **not**
authorization, identity authority, or permission authority. The redacted `email` is still
session-adjacent, which is an additional reason not to broadcast the record via
`window`/events/logs.

## 4. Why diagnostic surfacing is risky

Surfacing private data can accidentally create a dependency: a `window` hook or DOM event
becomes an **undocumented API** that scripts/extensions/support tooling can read; a provider
value field or `useAccess` getter becomes a **public context API** consumers can depend on; a
dev panel becomes a **support tool**; a console log persists session-adjacent data into dev
consoles and screen-shares. Any of these converts a deliberately private, non-authoritative
observation into a maintained contract or an authority-adjacent input. The only concrete need —
engineers verifying the observer behaves — is fully met by **static** verification (the M7
observational, M8 wiring, and this new private-surface diagnostic), which has zero runtime
footprint.

## 5. Why runtime surfacing is rejected/deferred (and Option B selected)

There is **no demonstrated runtime diagnostic need**. Static diagnostics already prove the
observer's shape and behavior deterministically and offline. Runtime surfacing adds risk for
marginal benefit, so M9 selects **Option B**: lock the private boundary and document the future
contract. Specifically M9 adds **no**:

- public context API field / `AccessContextType` field / provider value field — *would create a
  consumable context API and break the M8 private-ref boundary*;
- `useAccess` getter — *same: public API surface*;
- UI / dev panel / route / component / badge — *render + support dependency*;
- `window.__TM_POS_SUPABASE_AWARENESS__` or any `window`/`globalThis` hook — *undocumented global API; hard to remove later*;
- DOM `CustomEvent` / `dispatchEvent` — *leaks data to arbitrary listeners; creates an event-shape contract*;
- `console` log of the record — *no logging of session-adjacent data, even redacted*;
- `localStorage`/`sessionStorage`/IndexedDB persistence — *durable leakage*;
- `fetch`/`XHR`/`sendBeacon` transmission — *network exfiltration of session-adjacent data*;
- `/auth/session/resolve` call, server-derived authorization read, shadow mode, or enforcement — *out of scope; later separately-approved stages*.

## 6. Private-surface diagnostic strategy

`scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts` (offline,
text-only, self-inert) asserts (46 checks): the ref exists, is a private `useRef`, is not
exported, and is **write-only** (zero reads); the ref appears nowhere after the observer effect
(so no session/tenant/role/plan/permissions/subPermissions/`hasPermission`/`checkSubPermission`/
`canAccess`/`getPermissionLevel`/`isStoreActivated`/`resolveLandingRoute`/loading/routing/authError
reads it); it is not in the provider value or `AccessContextType`; there is no getter and
`useAccess` exposes no observer data; the ref is confined to AccessContext and the record type is
referenced only by approved files (helper, types, AccessContext type-only import); no
`window`/`globalThis` hook, DOM event, console log, storage, or network surfaces the record (the
observer block — the only code touching the record — contains none of these sinks, and the ref is
never passed to any sink anywhere); no `/auth/session/resolve`, no server-authz read, no
`VITE_ENABLE_SERVER_AUTHZ_SHADOW`, no `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_DIAGNOSTIC_SURFACE` in
`src/**`; the M7 helper is imported only by AccessContext via the approved DEV+flag-gated dynamic
import (no static import); no token/role/tenant/plan/permission fields are surfaced; no direct
Supabase SDK / browser→DB access and no privileged Supabase/DB env name in `src/**`. The
diagnostic itself is non-circular (imports only `fs`/`path`, read-only fs, no `process.env`, no
child process / network / DB).

## 7. Future surfacing contract (deferred — documented only)

If runtime inspection is ever genuinely needed, it must be a **separately-approved** milestone
gated by a new flag **`VITE_ENABLE_ACCESSCONTEXT_SUPABASE_DIAGNOSTIC_SURFACE`** that is:
- **DEV-only** and **default OFF**;
- separate from the awareness / bootstrap / foundation / shadow / pilot flags;
- additionally requires `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS === 'true'`;
- **excluded from the production bundle** (DEV-gated dynamic path, dead-code-eliminated), **proven**
  by `npm run build` + the bundle secret scan (which already asserts the flag + any
  `__TM_POS_SUPABASE_AWARENESS__` hook are absent from `dist/**`);
- read-only, token-safe, non-authoritative, clearly labeled diagnostic-only, and removable with
  zero app-behavior impact.

The name is **reserved** here; M9 wires nothing.

## 8. Why M10 should move to token-to-session-resolve / server-authz shadow planning

Surfacing the observer is not on the critical path to server-derived authorization. The next
meaningful step is a **planning pass** for the token → `/auth/session/resolve` flow and an
**observational server-authz shadow** (default OFF, no enforcement, audit only when explicitly
approved). That work does not require surfacing the M8 observer and is where real progress toward
materialized permissions lives.

## 9. QA plan / results (non-live, offline only)

- `tsc --noEmit`: **12 pre-existing errors, 0 new, 0 in any M9 file** (baseline preserved).
- New private-surface diagnostic: **46/46**.
- M8 wiring **45/45**, hardened authority **36/36**, M7 observational **55/55**,
  adoption-readiness **22/22**.
- M5/M6/M7 frontend safety: foundation-dormant **37/37**, bootstrap-dormant **44/44**,
  provider-inventory **21/21**, supabase-readiness **20/20**.
- Full M1–M8 regression green (permission-catalog 48/48, authz-materialization 43/43,
  authz-resolver 27/27, platform-role-vocab 21/21, feature-key-canon 21/21,
  authorization-contract 12/12, session-resolve-contract 15/15, session-authz-service-static
  30/30, session-resolve-live-authz-static 28/28, session-derived-authz-contract 23/23).
- protected-action (DB-free, loopback, dev-asserted snapshots, Supabase DB env unset): **8/8**.
- Optional offline `npm run build` + bundle secret-scan: **10/10** (added `2d` reserved-flag /
  window-hook absence check).

## 10. Rollback plan

1. Delete `scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts`.
2. Delete this doc.
3. Revert the `replit.md` M9 pointer line.
4. Revert the additive bundle-scan `2d` check and the M8-doc pointer line.
5. No `src/**` rollback (no runtime source changed). No DB/audit rollback (no migration, seed,
   SQL, schema/RLS/Auth change, or DB write occurred). `git revert` (or reset to `09c0be1`)
   fully restores M8 state.

## 11. Explicitly deferred stages (post-M9)

Runtime observer surfacing (any form); token-to-session-resolve; live `/auth/session/resolve`;
pilot `authorization: null` pin update; server-derived authorization adapter; shadow mode
(`VITE_ENABLE_SERVER_AUTHZ_SHADOW`); enforcement; Login migration; protected business APIs;
Backend Control Plane; Database Operations Console / direct DB control; production migration 003.
Each requires its own explicit, separately-approved milestone.
