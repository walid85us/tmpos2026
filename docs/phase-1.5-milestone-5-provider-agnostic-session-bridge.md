# Phase 1.5 — Milestone 5: Inert Provider-Agnostic Session Model Foundation

**Status:** Implemented — not committed / not pushed / not backed up; pending review.
**Option:** B — inert provider-agnostic session model foundation (no runtime adoption).
**Checkpoint:** built on `3c0651676d996b2f0bcfdbd72f6b6fedc98aa798` (M4 Supabase Auth frontend pilot).

## Scope

M5 (Option B) adds **inert** foundations only:

1. Provider-neutral session **types** (`src/auth/appSession.ts`).
2. A **pure mapper** from the existing M3/M4 whoami diagnostic response shape to a
   future `AppSession` (`src/auth/mapWhoamiToAppSession.ts`).
3. A **unit/diagnostic check** proving mapper behavior
   (`scripts/diagnostics-appsession-map-check.ts`).
4. This document.

There is **no runtime adoption**: no UI change, no route change, no AccessContext
integration, no business API protection, no schema/RLS/MCP/deployment change, and
no new dependency.

## Why this is inert

- The type module contains **types only** — no runtime values or side effects.
- The mapper is a **pure function** — no network, no env reads, no token reads, no
  browser storage, and no Firebase/Supabase/AccessContext imports.
- The new modules are imported by **nothing at runtime** — only by the M5
  diagnostic script and by each other. The live app (`AccessContext`,
  `AccessGuard`, `Login`, `App` routing, the M4 pilot, business modules, and all
  server code) does not reference them.
- Removing the four files restores the exact pre-M5 state (see Rollback).

## Identity vs authorization boundary

- **Identity** is proven **server-side only**: a cryptographically verified token
  mapped to an app-owned `internal_user_id` (M1/M3, fail-closed). A frontend
  provider session never, on its own, grants app authorization.
- **Authorization** (`userType` / `role` / `scope` / plan / permissions) is
  **server-derived**. In this inert slice the mapper **always** emits
  `authorization: null` — no authorization is produced. Client-asserted
  role/tenant/store/permission fields and provider `user_metadata` are **never**
  trusted; the mapper does not even read them.

## AppSession concept

`AppSession` is a provider-neutral shape derived from a server whoami result:

- `identity: AppIdentity | null` — server-verified identity (or null).
- `authorization: AppAuthorization | null` — server-derived authz (always null here).
- `authState: 'authenticated' | 'token-verified' | 'unauthenticated'` — mirrors the
  backend's honest states (omitting the server-only dev-asserted state).
- `sourceOfTruth`, `requestId`, `reasonCode` — safe diagnostic aids (never secrets).

### internal_user_id as the app-owned bridge key

`internal_user_id` is the durable, app-owned key produced by M1/M3 from a verified
token. It is the bridge between any auth provider and app identity. The mapper
emits `authState: 'authenticated'` **only** when the server says `authenticated`
**and** a non-empty `internalUserId` is present; otherwise it degrades to
`unauthenticated` (fail-closed) and never fabricates an identity.

### Why authorization remains `null` in this slice

Authorization is still client-derived today (Firestore-driven in `AccessContext`).
Moving it to server-derivation is a later, separately-approved milestone. Emitting
`null` here keeps the contract honest and prevents any accidental trust of
client-asserted authority.

## Why M3 whoami remains diagnostic-only

`POST /diagnostics/supabase-whoami` is double feature-gated and never served in
production. It proves identity; it is not a production session source. M5 consumes
only its **safe response shape** and does not change it.

## Why future `/auth/session/resolve` is deferred

A production-safe session endpoint (enforced auth, no diagnostic flags, returning
server-derived authorization) is the right long-term source for `AppSession`. It is
**named and deferred** — building it depends on authorization moving server-side and
is out of scope for Option B.

## Why AccessContext is not touched

`AccessContext` is the single live session source of truth (Firebase Auth +
Firestore roles). Changing it carries risk to plan gating, sub-permissions, POS
operator behavior, and supervisor auth — for zero current benefit (no production
users, no real tenant persistence). Adoption is deferred to a flagged, reversible
milestone.

## Why Firebase remains active/default

Firebase Auth is the current/testing login and stays the active/default provider
until a reviewed migration. M5 does not modify `src/firebase.ts`, `Login.tsx`,
`NotProvisioned.tsx`, or the Firebase path in `AccessContext`.

## Why the M4 pilot remains isolated

The Supabase pilot under `src/pilot/**` stays dev+flag gated and isolated; M5 does
not modify it and does not wire it into the app.

## Files added

- `src/auth/appSession.ts` — inert provider-agnostic types.
- `src/auth/mapWhoamiToAppSession.ts` — pure whoami → AppSession mapper.
- `scripts/diagnostics-appsession-map-check.ts` — offline unit/diagnostic check.
- `docs/phase-1.5-milestone-5-provider-agnostic-session-bridge.md` — this document.

## Files modified

- None.

## QA evidence

Recorded in the implementation pass report (Claude-run). Summary of checks:

- `npx tsx scripts/diagnostics-appsession-map-check.ts` — all cases PASS.
- `npx tsx scripts/diagnostics-supabase-whoami-check.ts` — existing PASS count.
- `npx tsx scripts/diagnostics-protected-action-check.ts` — existing PASS count.
- `npx tsc --noEmit` — 0 errors in M5 files (baseline noted).
- `npm run build` — success / known baseline.
- Runtime isolation grep — M5 modules imported by nothing in app/auth/pilot/server.
- Secret-safety scan — no token/JWT/secret/DB-URL; no env reads in M5 modules.
- Forbidden-file diff — none changed.

## Rollback plan

Delete the four added files (or `git checkout -- .` / revert the slice). Because no
runtime code imports them, removal cannot affect app behavior.

## Deferred items

- Building `/auth/session/resolve` (production-safe session endpoint).
- Moving authorization (role/tenant/plan/permissions) to server-derived / Postgres + RLS.
- Wiring `AppSession` into `AccessContext` behind a default-OFF flag with rollback.
- Adding a Firebase token verifier behind the backend `AuthAdapter` seam.
- Firebase retirement / real-user migration.
- OAuth/redirect/CORS, deployment, and any schema/RLS expansion.

---

**Not committed / not pushed / not backed up; pending review.**
