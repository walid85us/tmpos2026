# Phase 1.6 M8 — AccessContext One-Shot Supabase Observer Wiring (DEV-Flag-Gated, Private, Non-Authoritative) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No current app behavior changed. **Firebase remains the sole active / default /
authoritative session source.** No DB connection, migration, seed, SQL, audit write, Supabase
MCP, live route call, package change, backend change, or production change occurred.

**Accepted base checkpoint:** `8b7fd211d2c4773b73c819807e8283654c03183d`
(Phase 1.6 M7 — add dormant AccessContext awareness helper).

> **Locked by M9:** Phase 1.6 M9 added an offline private-surface diagnostic that permanently
> proves this observer stays private, write-only, and non-authoritative — never surfaced via the
> context value, a `useAccess` getter, UI, a `window` hook, a DOM event, a console log, storage,
> or the network. See
> [`docs/phase-1.6-milestone-9-observer-diagnostic-surfacing-plan.md`](phase-1.6-milestone-9-observer-diagnostic-surfacing-plan.md).

**Selected design:** **Option E** from the accepted M8 planning pass — modify
`src/context/AccessContext.tsx` in the smallest possible way so it calls the proven M7 helper
behind DEV-only flags, strictly as a **private, non-authoritative, one-shot OBSERVER**, via a
**dynamic import** that the production build dead-code-eliminates. Selection was conditional on
the **hard build + bundle-scan proof**, which passed (see §13).

---

## 1. Scope

M8 is **Stage 3c** — the first milestone permitted to modify the live authority component.
It wires the M7 awareness helper into AccessContext as an observer and proves the observer is
private, gated, one-shot, cancellation-safe, non-authoritative, and **production-excluded**.

**In scope (modified — exactly the approved boundaries):**

- `src/context/AccessContext.tsx` — one **type-only** import, one private `useRef`, one
  isolated `useEffect`. Nothing else changed; the provider `value` object is byte-for-byte
  unchanged.

**In scope (controlled diagnostic updates):**

- `scripts/diagnostics-accesscontext-supabase-awareness-observational-check.ts` — section 10
  now allows EXACTLY ONE dynamic importer (`src/context/AccessContext.tsx`), asserts there is
  no static helper import and that the dynamic import is DEV + awareness-flag gated, and keeps
  Login/AccessGuard/App/main clean; section 12a allows the dynamic helper import while still
  forbidding the Supabase SDK / M5 foundation / M6 bootstrap inside AccessContext. All
  helper-internal token/secret/mutation/session-resolve/server-authz/one-shot/cancellation
  checks are unchanged (the helper file is not modified).
- `scripts/diagnostics-accesscontext-firebase-authority-check.ts` — preserves all Firebase
  authority / listener / legacy-engine / Login / AccessGuard / App-routing /
  `authorization:null` checks **and** the literal guarantee "AccessContext does NOT import the
  M6 bootstrap"; adds a new section 8 that locks the observer down (dynamic-only, type-only
  record import, DEV+flag-gated, private write-only ref, not in provider value, AbortController
  cleanup, no session-resolve / server-authz / shadow flag / token read).
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — `2c` label reworded from
  "dormant" to "DEV-only dynamic; production-excluded"; the assertion (awareness identifiers
  absent from `dist/**`) is unchanged, and no privileged-secret check is weakened.

**In scope (added):**

- `scripts/diagnostics-accesscontext-supabase-observer-wiring-check.ts` — new offline,
  text-only, self-inert observer-wiring proof (45 checks).
- This document.
- `replit.md` — one M8 pointer line.
- `docs/phase-1.6-milestone-7-…-plan.md` — one concise pointer line (M8 implemented the wiring).

**Explicitly NOT touched:** `src/components/Login.tsx`, `src/components/AccessGuard.tsx`,
`src/App.tsx`, `src/main.tsx`, `src/pilot/**`, `src/firebase.ts`, `src/context/accessConfig.ts`,
`src/owner/platformPermissionsConfig.ts`, **`src/auth/supabaseAuthFoundation.ts` /
`…FoundationTypes.ts` (M5)**, **`src/auth/supabaseSessionBootstrap.ts` / `…BootstrapTypes.ts`
(M6)**, **`src/auth/supabaseAccessAwareness.ts` / `…AwarenessTypes.ts` (M7)**, all `server/**`,
migrations, seeds, `package.json`, `package-lock.json`, secrets, Supabase/Firebase config,
`.replit`. The pilot `authorization: null` pin is untouched.

---

## 2. Exact AccessContext change

Three additions to `AccessProvider`, and nothing else:

1. **Type-only import** (erased at runtime — pulls no module into the bundle):
   ```ts
   import type { AccessAwarenessRecord } from '../auth/supabaseAccessAwarenessTypes';
   ```
2. **Private ref** (NOT React state, NOT in the provider value):
   ```ts
   const supabaseAwarenessRef = useRef<AccessAwarenessRecord | null>(null);
   ```
3. **One isolated effect**, separate from the Firebase `onAuthStateChanged` effect:
   ```ts
   useEffect(() => {
     if ((import.meta as unknown as { env: { DEV?: boolean } }).env.DEV !== true) return;
     if ((import.meta as unknown as { env: { VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS?: string } })
           .env.VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS !== 'true') return;
     if (loading) return;                          // run only AFTER Firebase init; never writes loading
     const controller = new AbortController();
     void (async () => {
       try {
         const mod = await import('../auth/supabaseAccessAwareness');
         const record = await mod.runAccessContextSupabaseAwarenessObservation({ signal: controller.signal });
         if (!controller.signal.aborted) supabaseAwarenessRef.current = record;
       } catch { /* no-op: never surface awareness detail; Firebase remains authoritative */ }
     })();
     return () => controller.abort();
   }, [loading]);
   ```

The existing Firebase listener effect (deps `[platformRolesState]`), the `loading` state, the
derived `session`/`tenant`/`effectiveRole`, every permission function, and the provider `value`
are all unchanged.

---

## 3. Dynamic import strategy & production exclusion

The dynamic specifier is a **static string literal** (`'../auth/supabaseAccessAwareness'`).
The DEV guard is the **first** statement in the effect. The DEV/flag reads use a narrow cast,
but after TypeScript erasure the JS is the EXACT `import.meta.env.DEV` / `import.meta.env.VITE_…`
member access. In a production `vite build`, Vite statically folds `import.meta.env.DEV` to
`false`, so the guarded branch becomes `if (false !== true) return;` → constant-`true` early
return → Rollup tree-shakes the unreachable dynamic `import()`, and therefore the helper (plus
the M6 bootstrap and M5 foundation it reaches) and the awareness flag name never enter the
emitted bundle. This is the **hard M8 gate**, re-proven by build + bundle scan (§13), and
independently grep-verified at **0 occurrences** of every identifier in `dist/**`.

**Why the cast (not bare `import.meta.env.DEV`):** this repo ships no `vite/client` env types,
so bare `import.meta.env` access is a pre-existing TypeScript gap (12 baseline errors, incl. 5
`Property 'env' does not exist on type 'ImportMeta'`). Writing bare access in AccessContext would
add a NEW error and place AccessContext on the error list. The cast — the same convention used
by the M5/M6/M7 files and the pilot — yields zero new errors while preserving the foldable
member expression.

---

## 4. DEV + flag gating

- Gated by `import.meta.env.DEV` **and** `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS === 'true'`
  (the M7 flag — DEV-only, default OFF, separate from the foundation/bootstrap/pilot/shadow flags).
- The M6 bootstrap requirement is enforced **transitively** by the helper
  (`isAccessContextSupabaseAwarenessEnabled()` already requires `isSupabaseSessionBootstrapEnabled()`),
  so AccessContext reads neither the bootstrap nor the foundation flag directly — preserving flag
  separation and the "AccessContext does NOT import the M6 bootstrap" guarantee.
- **Flag absent / false (the default, and every production build):** no dynamic import, no helper
  call, no observation, no state change, no behavior change — Firebase-only path.

---

## 5. Private ref only — no public context API / no React state / no value change

The result is stored only in `supabaseAwarenessRef` (a `useRef`, which never triggers a render).
It is **not** added to `AccessContextType`, **not** added to the provider `value`, and **not**
exposed by any getter. No `useState` is introduced for the observation. The ref is **write-only**:
the diagnostics prove `supabaseAwarenessRef.current` only ever appears as an assignment target
(zero reads), and the identifier appears nowhere after the observer effect (where all derivations,
permission functions, and the provider value are defined).

---

## 6. Why Firebase remains authoritative

The observer mutates no app/session state, writes no `loading`, and its result is consumed by
nothing. The Firebase `onAuthStateChanged` listener and the `users/{uid}` role read remain the
exclusive producers of `session`/`tenant`/`authError`. `authorization: null` legacy-fallback
semantics are untouched.

## 7. Why loading / permissions / AccessGuard / Login / App routing remain unchanged

- **Loading:** the observer only *reads* `loading` (gates on `loading === false`); it never calls
  `setLoading`. First paint, route-guard timing, and the loading gate are identical.
- **Permissions:** the legacy engine (`accessConfig` + `platformPermissionsConfig`) and all of
  `getPermissionLevel`/`checkPermission`/`checkSubPermission`/`canAccess`/`hasPermission` are
  byte-for-byte unchanged and never read the ref.
- **AccessGuard / Login / App routing / `main.tsx`:** not modified; they import no awareness/
  foundation/bootstrap/SDK; AccessGuard still reads `useAccess()`; Login stays Firebase-based;
  routing keeps the PILOT-gated pilot route and the Firebase-only providers; `main.tsx` keeps
  StrictMode.

## 8. Why the M5 / M6 / M7 helper files remain unchanged

M8 adds exactly one importer (AccessContext, dynamic) above the M7 helper. The linear chain
**foundation → bootstrap → awareness helper** is intact; each layer is still the only permitted
importer of the layer below. No helper file needed modification; their dormancy/secret/token
diagnostics stay strict and green.

---

## 9. StrictMode / cancellation safety

`src/main.tsx` runs under React StrictMode (effects double-invoke in dev: mount → cleanup →
remount). Each effect run creates its own `AbortController`; cleanup aborts it. The M7 helper is
cancellation-safe and no-throw, so the aborted first run resolves to a discarded `cancelled`
record; the assignment is additionally guarded by `if (!controller.signal.aborted)` so an aborted
run can never clobber a good one. There is **no** synchronous once-guard that would suppress the
StrictMode remount.

## 10. Token / secret safety

The M7 record is token-free by construction. AccessContext never logs the ref or any field, never
reads `access_token`/`refresh_token`/JWT/provider tokens, and the cast types name only `DEV` and
the public `VITE_` flag. No privileged Supabase/DB identifier is added anywhere; the bundle scan
proves none reach production.

## 11. Deferred — session-resolve / server-derived authorization / shadow / enforcement

These remain deferred because the observer is **observational only** and Firebase is still
authoritative. Live `/auth/session/resolve`, a server-derived-authorization adapter, shadow mode
(`VITE_ENABLE_SERVER_AUTHZ_SHADOW`), and any enforcement would change real authorization behavior
and must wait for their own separately-approved stages (after a stable token/session flow and a
ratified backend contract). M8 reads no server authorization, calls no resolve route, wires no
shadow flag, and adds no enforcement or protected business APIs.

---

## 12. Bundle-exclusion proof requirement (HARD GATE)

Because M8 modifies AccessContext, an offline production build + bundle secret scan are
**required** (not optional). The scan asserts `supabaseAccessAwareness`,
`VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS`, `supabaseSessionBootstrap`,
`VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP`, `supabaseAuthFoundation`, and all privileged
Supabase/DB patterns are absent from `dist/**`, printing only labels/counts/filenames (never
content). If the build cannot run, M8 must stop and recommend fallback Option B.

## 13. QA results (non-live, offline only)

- `tsc --noEmit`: **12 pre-existing errors, 0 new, 0 in any M8 file** (baseline preserved).
- `diagnostics-accesscontext-supabase-observer-wiring-check` (new): **45/45**.
- `diagnostics-accesscontext-firebase-authority-check` (hardened): **36/36**.
- `diagnostics-accesscontext-supabase-awareness-observational-check` (updated): **55/55**.
- `diagnostics-accesscontext-adoption-readiness-check`: **22/22**.
- `diagnostics-supabase-auth-foundation-dormant-check`: **37/37**;
  `…-session-bootstrap-dormant-check`: **44/44**;
  `…-frontend-auth-provider-inventory-check`: **21/21**;
  `…-frontend-supabase-auth-readiness-check`: **20/20**.
- Full M1–M7 regression: permission-catalog **48/48**, authz-materialization **43/43**,
  authz-resolver **27/27**, platform-role-vocabulary **21/21**, feature-key-canonicalization
  **21/21**, authorization-contract **12/12**, session-resolve-contract **15/15**,
  session-authz-service-static **30/30**, session-resolve-live-authz-static **28/28**,
  session-derived-authz-contract **23/23** — all green.
- `diagnostics-protected-action-check` (run with Supabase DB/secret env unset to recreate its
  documented DB-free precondition; loopback in-process, dev-asserted snapshots): **8/8** —
  **no DB connection, no audit write**.
- **HARD GATE:** offline `npm run build` (`vite build`) succeeded; bundle secret-scan **9/9**;
  independent `grep` of `dist/**` → **0 occurrences** of helper/bootstrap/foundation/flag/runner
  identifiers; only `index.*` and the dev-gated `SupabaseAuthPilot` lazy chunk are emitted.

## 14. Rollback plan

1. Revert the minimal AccessContext observer change (type-only import + ref + one effect).
2. Remove `scripts/diagnostics-accesscontext-supabase-observer-wiring-check.ts`.
3. Revert the controlled updates to the observational, authority, and bundle-scan diagnostics.
4. Remove this doc and the `replit.md` M8 pointer line; revert the M7 doc pointer line.
5. No DB rollback (no migration/seed/SQL/schema/RLS/Auth/DB write occurred); no audit rollback
   (static diagnostics write zero rows). Runtime is already neutralized by leaving
   `VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS` absent/false (the default).

A single additive commit; `git revert` (or reset to `8b7fd21`) fully restores M7 state.

## 15. Explicitly deferred stages (post-M8)

Supabase login migration; token-to-session-resolve; live `/auth/session/resolve`; pilot
`authorization: null` pin update; server-derived authorization adapter; shadow mode
(`VITE_ENABLE_SERVER_AUTHZ_SHADOW`); enforcement; protected business APIs; Backend Control Plane;
Database Operations Console / direct DB control; production migration 003. Each requires its own
explicit, separately-approved milestone.
