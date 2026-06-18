# Phase 1.6 M4 — Supabase Auth Frontend Migration Readiness (Plan & Closeout)

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No frontend runtime change, no `src/**` change, no DB connection,
migration, seed, SQL, audit write, Supabase MCP, live route call, package change, or
production change occurred.

**Accepted base checkpoint:** `cb9c9b73c3c9adebfc69ae270d2e113493ee3cb5`
(Phase 1.6 M3 — harden session authorization contract).

---

## 1. Scope

M4 is a **documentation + offline static-diagnostics** slice (Option B from the
accepted M4 planning pass). It codifies the readiness path for migrating the
frontend from its current **Firebase-derived** session model toward a future
**Supabase-token-compatible** session model that can consume server-derived
authorization — and it locks the frontend secret-safety boundary with machine
checks. **It implements no migration and changes no runtime behavior.**

**In scope:** this doc; two offline static diagnostics
(`diagnostics-frontend-auth-provider-inventory-check.ts`,
`diagnostics-frontend-supabase-auth-readiness-check.ts`); one `replit.md` pointer.

**Explicitly NOT in scope:** any `src/**` change (incl. `firebase.ts`, `Login.tsx`,
`NotProvisioned.tsx`, `AccessContext.tsx`, `accessConfig.ts`,
`platformPermissionsConfig.ts`, `mapWhoamiToAppSession.ts`, `appSession.ts`,
`src/pilot/**`, AccessGuard, App routing); no new Supabase client; no package change
(`@supabase/supabase-js` is already installed); no backend route behavior change; no
protected APIs; no Backend Control Plane; no Database Operations Console; no direct
DB control; no migration/seed/SQL/DB/Supabase-MCP; no production.

---

## 2. Current frontend session authority — Firebase-derived

- `src/firebase.ts` initializes the Firebase app/auth/firestore client.
- `src/components/Login.tsx` signs in via Firebase (`signInWithPopup` Google /
  `signInWithEmailAndPassword`) and out via `signOut(auth)`.
- `src/context/AccessContext.tsx` subscribes via `onAuthStateChanged(auth, …)`,
  reads the Firestore `users/{uid}` doc → `role`, builds a `Session` (`userType`,
  `role`, `status:'active'`) and a **hardcoded** tenant (`tenant-1`, plan `growth`).
  Permissions are computed **client-side** (`hasPermission` / `checkSubPermission`)
  from `accessConfig` / `platformPermissionsConfig`.
- `src/components/NotProvisioned.tsx` handles the no-Firestore-doc case.

Firebase is today the **source of truth** for the production session, role, and
provisioning state.

---

## 3. Current server authorization authority — Supabase-token-derived

`/auth/session/resolve` (dev-only, three-gate, default OFF — see M3) verifies a
**Supabase** bearer token, resolves the durable `internal_user_id`, and — only under
the M11.5 live gates + resolver `allow` + durable audit — returns server-derived
`authorization`. Authority input is the `Authorization: Bearer <token>` header only;
the request body is never read for authority. Server authorization is reachable
**only** by a caller holding a valid Supabase access token.

---

## 4. Provider mismatch blocker

The production session is **Firebase**-derived; server authorization trusts
**Supabase** tokens. The main app holds no Supabase session, so it cannot present the
token `/auth/session/resolve` requires. This provider mismatch — **not** key-space or
contract shape (both proven aligned in M3) — is the sole structural blocker to
AccessContext adoption of server-derived authorization.

---

## 5. Existing Supabase auth pilot status (already present, isolated, dev-only)

A complete, secret-safe Supabase auth path already exists under `src/pilot/**`
(Phase 1.5 M4/M8), gated by `VITE_ENABLE_SUPABASE_PILOT='true'` + Vite DEV, mounted at
`/dev/supabase-pilot` outside the `/` and `/owner` trees, **not** wrapped by
`AccessGuard`, code-split so production builds exclude it:

- `pilotEnv.ts` — client-safe `VITE_` env boundary (anon key + URL only).
- `supabaseClient.ts` — browser client from anon key + URL only (`persistSession`,
  `autoRefreshToken`); never reads a service-role key, DB URL, or JWT secret.
- `identityDiagnosticClient.ts` — whoami round-trip.
- `sessionResolvePilotClient.ts` — Bearer→`/auth/session/resolve` round-trip;
  returns safe fields only; currently pins `authorization: null` (written pre-M11.5).
- `SupabaseAuthPilot.tsx` — the pilot UI.

**The main app imports none of the pilot.** `@supabase/supabase-js@^2.108.1` is
already installed, and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are present
(names only — values never read here). Therefore M4 needs **no new client and no
package change**.

---

## 6. Target auth architecture

A single, server-authoritative model: the browser holds a **Supabase** session
(public anon client), presents its access token to `/auth/session/resolve`, and the
**backend** derives authorization from durable state. The frontend `AccessContext`
eventually **displays/uses** effective authorization but is **never** the source of
truth for backend enforcement. The legacy client permission engine
(`accessConfig` / `platformPermissionsConfig`) remains the **fallback** throughout
the transition.

---

## 7. Migration stages

1. **M4 (this slice):** docs + static diagnostics. No runtime change.
2. **Supabase-auth frontend foundation:** promote the pilot's client/session pattern
   into a real app auth module, **flag-gated and dormant-by-default**; Firebase
   remains the default/fallback.
3. **Dual-provider session bootstrap:** AccessContext can read a Supabase session
   when the flag is on, else Firebase.
4. **Session-resolve integration:** feed the Supabase token to
   `/auth/session/resolve`; read the **structured** `authorization` field (update the
   pilot client's `authorization: null` pin).
5. **AccessContext adapter — shadow/observational mode:** map server
   `permissions`/`subPermissions` onto the `hasPermission`/`checkSubPermission`
   surface; compare against the legacy engine and **log mismatches**; the **legacy
   engine stays authoritative**.
6. **Server-derived enforcement switch:** server-derived becomes authoritative, with
   the legacy engine as fallback on `authorization: null`.
7. **Firebase retirement:** only after the above is stable.

---

## 8. Environment variable strategy

Client-side reads **only** `VITE_`-prefixed public values:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ENABLE_SUPABASE_PILOT`,
`VITE_IDENTITY_API_BASE`, and the **future** DEV-only flag
`VITE_ENABLE_SERVER_AUTHZ_SHADOW` (documented here, not yet wired). Server-only
secrets (`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`, the server
`SUPABASE_URL`/`SUPABASE_ANON_KEY` copies) stay non-`VITE_` and never enter the
bundle. Diagnostics assert env **names** only — never values.

---

## 9. Forbidden frontend secrets

The browser must **never** hold or reference: `SUPABASE_SERVICE_ROLE_KEY`, any
service-role key, `SUPABASE_DATABASE_URL` / any database URL / connection string, or
a privileged credential. The **anon key may be public** (RLS is the real guard). The
browser must **never** connect directly to the database. The readiness diagnostic
scans `src/**` for the identifier forms of these secrets and fails if any appears.

---

## 10. Token-handling rules

The raw Supabase access token is consumed **only** as the `Authorization: Bearer`
header to `/auth/session/resolve`. It is never rendered, logged, persisted by app
code, or placed in the DOM (the pilot already enforces this). Refresh is handled by
the Supabase SDK (`autoRefreshToken`); logout clears the SDK session. The frontend
never parses JWT claims for authority — identity and authorization are server-derived.

---

## 11. Session-resolve integration sequence

(Stage 4.) Acquire a Supabase session → obtain the access token via the SDK → call
`/auth/session/resolve` with the Bearer header and an empty body → read the safe wire
DTO, including the **structured `authorization`** field (M3 made it conditionally
non-null). The current pilot `sessionResolvePilotClient` pins `authorization: null`
and must be updated to read the structured field as part of this stage.

---

## 12. AccessContext adapter sequence

(Stage 5.) A thin **read-only** adapter maps `authorization.permissions[domain]` →
level and `authorization.subPermissions[id]` → boolean, exposing the same
`hasPermission` / `checkSubPermission` surface AccessContext already provides. M3
proved an **exact bidirectional key-space parity**, so the mapping is total. The
frontend imports **no** server module — it consumes the wire DTO only.

---

## 13. Shadow / observational authorization sequence

(Stage 5, behind `VITE_ENABLE_SERVER_AUTHZ_SHADOW`, default OFF.) Compute both the
legacy client result and the server-derived result, **log mismatches**, and keep the
**legacy engine authoritative**. Shadow must precede any enforcement switch; mismatch
parity must be proven before flipping authority.

---

## 14. Fallback / null semantics (binding for the future)

`authorization: null` (default/disabled path, deny, fail-closed, forced-deny, or a
live-resolve failure) means **fall back to the legacy client engine** during the
transition. Specifically, `authorization: null`:

- does **not** mean fail-open;
- does **not** mean blanket deny;
- does **not** mean blank permissions.

The browser is **never fail-open** and never authorizes itself; the legacy engine
is the safety net until server-derived enforcement is fully proven.

---

## 15. Security principles (preserved)

1. The Supabase anon key may be public if used correctly.
2. The Supabase service-role key must **never** be exposed to the frontend.
3. The database URL must **never** be exposed to the frontend.
4. The browser must **never** connect directly with privileged credentials.
5. The frontend must **never** authorize itself.
6. Server-derived authorization is produced by the **backend only**.
7. AccessContext may later display/use effective authorization but must **not** be
   the source of truth for backend enforcement.
8. `authorization: null` means fall back to the legacy client engine — not fail-open.
9. Any future live `/auth/session/resolve` authorization call may write audit rows
   only when explicitly approved (**audit-delta warning** below).
10. Production must remain disabled by default.
11. Shadow/observational mode must precede enforcement.
12. Protected business API enforcement must wait until the auth/session/token flow is
    stable.

**Audit-delta warning:** when the DEV-only `ENABLE_LIVE_SESSION_AUTHORIZATION` flag is
enabled, each `/auth/session/resolve` resolution writes one durable `audit_event`
row (the M11.4 service audits every decision; an unaudited allow fails closed). Any
future live exercise is DEV-only, owner-approved, with a documented audit delta. M4
enables nothing and writes zero audit rows.

---

## 16. Diagnostics added

- **`scripts/diagnostics-frontend-auth-provider-inventory-check.ts`** — inventories
  Firebase vs Supabase usage; proves `@supabase/supabase-js` is pilot-scoped, the
  main app does not import the pilot auth client, the session-resolve reference is
  pilot-scoped, both deps are declared, and the four public `VITE_` names are present
  while the future shadow flag is absent.
- **`scripts/diagnostics-frontend-supabase-auth-readiness-check.ts`** — locks the
  secret-safety boundary: no `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DATABASE_URL` /
  service-role / DB-URL / connection-string identifier in `src/**`; only `VITE_`
  names read client-side (anon key only); the pilot client + session-resolve path
  exist and are isolated; AccessContext / Login / AccessGuard / App routing remain
  un-migrated (Firebase-derived); future adoption is flag-gateable; this doc's
  fallback semantics are present.

Both are offline (`npx tsx`), read `src/**` as TEXT only, import no frontend module,
require no `package.json` change, and write zero audit rows.

---

## 17. Deferrals (restated)

- Real Login migration; the dormant→active Supabase app auth module; dual-provider
  session bootstrap; session-resolve integration into the main app; the AccessContext
  adapter + shadow mode (`VITE_ENABLE_SERVER_AUTHZ_SHADOW`); the enforcement switch;
  Firebase retirement.
- Protected business API enforcement — deferred.
- Backend Control Plane — remains planned; does not start here.
- Database Operations Console / direct DB control — remains planned; when built must
  be backend-API-gated, audited, approval-gated, system_owner only, DEV/staging
  first, production disabled by default, never browser-to-database, never exposing
  service-role keys or DB URLs to the frontend.
- Production migration 003 apply — separate owner-approved pass; keep the legacy
  `PLATFORM_ROLE_COMPAT_MAP` until all environments are confirmed on 003.

---

## 18. QA plan (this pass — offline / non-live only)

| Command | Result |
| --- | --- |
| `npx tsx scripts/diagnostics-frontend-auth-provider-inventory-check.ts` | pass |
| `npx tsx scripts/diagnostics-frontend-supabase-auth-readiness-check.ts` | pass |
| Full M1/M2/M3 regression suite (12 diagnostics) | green |
| `npx tsc --noEmit` (focused on M4 files) | 12 pre-existing unrelated errors; **0 in any M4 file** |

No live / DB-backed / audit-writer / session-resolve-live / M11.2–M11.5 route
diagnostic is run; no DB connection, SQL, Supabase MCP, or `audit_event` write
occurs; no `src/**` file is modified.

---

## 19. Rollback plan

No DB/audit rollback required (no migration, seed, SQL, schema/RLS/Auth change, or
DB/audit write occurred; static diagnostics write zero audit rows). Code rollback:

1. Delete the two new diagnostics.
2. Delete this doc.
3. Revert the `replit.md` M4 pointer line.
4. Revert any optional pointer added to the M3 doc / M1 strategy doc.

Equivalently, `git checkout cb9c9b7 -- <paths>` and remove the untracked new files.
No `src/**` file was changed.
