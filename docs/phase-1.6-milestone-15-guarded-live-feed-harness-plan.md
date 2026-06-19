# Phase 1.6 M15 — Dormant Guarded Live One-Shot Server-Authz Shadow Feed HARNESS (DEV-Flag-Gated + Owner-Confirmation-Gated, Imported-by-Nothing, Invoked-by-Nothing, No Live Call) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed, not backed up.
No current app behavior changed. **Firebase remains the sole active / default / authoritative session
source.** No DB connection, route call, migration, seed, SQL, audit write, Supabase MCP, live route
call, package change, backend change, or production change occurred. **The harness was authored but
NEVER invoked; the M14 feed was NOT called; `/auth/session/resolve` was NOT reached; no token was
acquired; no live `authorization` was read; the M11 token bridge, M12 shadow client, M13 comparison
helper, and M14 feed helper were NOT invoked.**

**Accepted base checkpoint:** `a7b8922da71b09745178dd62141ee8b473ce451f`
(Phase 1.6 M14 — add dormant server authz shadow feed).

**Selected design:** **Option C — add a guarded, DEV-only, dormant app-side live one-shot harness, but
do NOT run it.** The actual live one-shot run is deferred to a separate, explicitly owner-approved
**M16** execution pass.

---

## 1. Why this milestone exists

M14 authored the dormant route→comparison link (`runServerAuthzShadowFeed()`): acquire a Supabase
token via the M11 bridge, SHADOW-call the backend session-resolve route, extract ONLY the response
`authorization` object, pass it transiently to the M13 comparison, and return a NON-SECRET result. The
one remaining gap to *real* signal is a **live one-shot invocation**. M15 builds the single auditable
**execution path** for that invocation — a guarded, DEV-only, owner-confirmation-gated harness — and
locks it dormant so the owner can inspect every guardrail **before** any live call. M15 runs nothing.

## 2. Why M15 does NOT run the harness / why live execution is deferred to M16

A live feed run reaches the backend session-resolve route, which is **not side-effect-free** when
backend flags are enabled (§3). Implementation and execution are therefore strictly separated:
**M15** authors the harness + diagnostic + doc and runs only offline checks; **M16** is a separate
owner-approved pass that flips flags, supplies the exact confirmation phrase, runs the one-shot once,
and reports the non-secret result + DB/audit deltas. M15 adds NO call site and invokes nothing.

## 3. Backend route side-effect facts (binding cautions)

A live `/auth/session/resolve` call may, with backend flags enabled: verify the Supabase token; upsert
a durable identity row (when server config is complete — and the four `SUPABASE_*` secrets are
currently present in the environment); emit advisory audit-envelope logs; and — only with
`ENABLE_LIVE_SESSION_AUTHORIZATION=true` (non-production, resolver `allow`, durable audit success) —
write a durable `audit_event` row (and only then is `authorization` non-null). With the backend gates
off (default — `ENABLE_SUPABASE_PLATFORM_IDENTITY` / `ENABLE_SESSION_RESOLVE` /
`ENABLE_LIVE_SESSION_AUTHORIZATION` are all absent), a call returns 404 with no side effects. **M15
calls nothing.**

## 4. Token discipline (inherited, unchanged)

The harness reads NO raw token. The only token handling lives in the M14 feed (and, beneath it, the
M11 bridge): the raw token is obtained ONLY inside the M11 bridge's immediate-use callback and used
ONLY as the outgoing `Authorization: Bearer` header value — never sent in the body, placed in the
URL/query, logged, persisted, stored, returned, or included in any result/message. The harness only
forwards an optional `AbortSignal` to the feed.

## 5. Result safety (inherited, unchanged)

The harness result carries ONLY: `ok`, an honest `phase`, `armed`, `alreadyRan`, two confirmation
BOOLEANS (`confirmationPresent` + `confirmationMatches` — never the phrase value), a phase-derived
`message`, and (only on a FUTURE 'completed' run) the M14 NON-SECRET feed result. It NEVER carries a
token / JWT / provider token, the raw response body, the raw `authorization` DTO, identity fields,
`tenantId` / `storeId`, role values, plan values, permission-LEVEL values, or the owner confirmation
phrase value.

## 6. Scope

**In scope (added):**
- `src/auth/serverAuthzShadowLiveHarness.ts` — dormant harness; imports the M14 feed + own/shared
  types only; exports `runServerAuthzShadowLiveOneShot({ signal? })` and
  `isServerAuthzShadowLiveOneShotArmed()`.
- `src/auth/serverAuthzShadowLiveHarnessTypes.ts` — pure types (imports ONE type: the M14 non-secret
  feed result, re-used as the harness result's `feed` field).
- `scripts/diagnostics-server-authz-shadow-live-harness-dormant-check.ts` — 82-check dormancy / gating
  / one-shot / result-safety proof (static/offline; reads `src/**` as TEXT).
- This document.

**In scope (controlled modifications):**
- `scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts` — **checks 31/32 allowlist** (allow
  the harness as the sole dormant feed importer + caller) **+ new 31b–31d** (assert the harness is
  itself imported by nothing active). No feed token / route / authorization-extraction / result-safety
  check weakened.
- `scripts/diagnostics-supabase-token-bridge-dormant-check.ts` — **check 49h allowlist** (allow the
  harness as the feed's sole importer) **+ new 49i–49k** (harness dormancy). **Owner-authorized
  controlled additive allowlist** required by the accepted M15 harness architecture (the harness
  statically imports the feed, which the M14-planted compensating check `49h` previously asserted had
  zero importers). No token-safety / storage / logging / route / foundation-importer / bundle check
  weakened.
- `scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts` — **check 80b allowlist**
  (allow the harness as the feed's sole importer) **+ new 80c–80e** (harness dormancy). **Owner-
  authorized controlled additive allowlist** required by the accepted M15 harness architecture (same
  reason as 49h). No comparison-boundary / result-safety / dormancy check weakened.
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive check 2i only** (harness
  identifiers + both flags + confirmation phrase absent from `dist/**`). No existing check weakened.
- `replit.md` — one M15 pointer line.

> **Note on the two locked-diagnostic edits (49h, 80b):** these were NOT in the original M15
> allowed-modify list. During implementation it surfaced that M14 planted compensating
> "feed-imported-by-nothing" assertions (`feedImporters.length === 0`) in the M11 token-bridge and M13
> comparison diagnostics. Because the M15 harness must statically import the feed, those two checks
> would have gone red. The owner **explicitly authorized** extending the same M14-style additive
> single-file allowlist (scoped exactly to `src/auth/serverAuthzShadowLiveHarness.ts`) to both, with
> the harness still asserted imported-by-nothing-active and no diagnostic broadly weakened.

**Explicitly NOT touched:** M14 feed helper/types source, M13 comparison helper/types source, M12
shadow client/types source, M11 token bridge/types source, M5/M6/M7/M8/M9 source, AccessContext,
Login, AccessGuard, App routing, `src/main.tsx`, `src/pilot/**`, `src/firebase.ts`, accessConfig,
platformPermissionsConfig, all `server/**`, migrations, seeds, `package.json`, `package-lock.json`,
`.replit`, secrets, Supabase/Firebase config. The route guards (inventory 2c / readiness 3c) and the
`VITE_ENABLE_SERVER_AUTHZ_SHADOW` flag guards (inventory 4e / readiness 5a / observer 42) were
**deliberately NOT modified** — the harness contains no route literal and no `…SHADOW` flag literal,
so all three stay green unchanged.

## 7. Harness API

```ts
runServerAuthzShadowLiveOneShot(options?: { signal?: AbortSignal }): Promise<ServerAuthzShadowLiveOneShotResult>
isServerAuthzShadowLiveOneShotArmed(): boolean
```

`ServerAuthzShadowLiveOneShotResult` (non-secret): `{ ok, phase, armed, alreadyRan, confirmationPresent,
confirmationMatches, message, feed }`. `feed` is the M14 `ServerAuthzShadowFeedResult | null`. `phase`
∈ `production_blocked | feed_not_enabled | disabled | confirmation_missing | confirmation_mismatch |
ready | already_ran | cancelled | completed`. Messages are PHASE-DERIVED.

## 8. Harness gating strategy

Armed (`isServerAuthzShadowLiveOneShotArmed()` true) ONLY when ALL hold (DEV-only, default OFF; no
single condition arms):
1. `import.meta.env.DEV === true` (production is ALWAYS blocked), AND
2. `isServerAuthzShadowFeedEnabled()` (the upstream M11–M14 enablement chain), AND
3. `VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT === 'true'` (NEW DEV-only arming flag), AND
4. `VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT` EXACTLY equals
   `I_APPROVE_M15_ONE_SHOT_SERVER_AUTHZ_SHADOW_FEED_DEV_ONLY` (NEW owner confirmation).

The confirmation value is compared by exact equality and is **NEVER printed, logged, returned, or
echoed** — only `confirmationPresent` / `confirmationMatches` booleans are surfaced. The harness
re-derives conditions 1–2 via the imported `isServerAuthzShadowFeedEnabled()` (no duplicated `…SHADOW`
flag literals) and adds only the two new flags. **No other new flag is introduced.**

## 9. One-shot in-memory guard

A single module-scoped `let hasRun = false`, latched to `true` BEFORE awaiting the feed so a concurrent
re-entry sees `already_ran`. **No persisted marker** — no localStorage / sessionStorage / IndexedDB /
cookie / file / DB / window/global. A second armed invocation in the same runtime instance returns an
`already_ran` result and does NOT call the feed again. No retry loop, no batch mode, no automatic
invocation.

## 10. Why dormant / imported by nothing active / invoked by nothing

The harness is imported by **nothing active** (not AccessContext / Login / AccessGuard / App / main /
pilot) and by no other `src/**` file, so the bundler tree-shakes it — and, through it, the M14 feed +
M11 bridge/foundation + M13 helper — out of production. It has **no import-time side effects** and **no
top-level await**: the feed is invoked ONLY when `runServerAuthzShadowLiveOneShot()` is explicitly
called — and **M15 adds no call site**. Proven by the M15 harness dormancy diagnostic + the bundle scan
(check 2i) + the compensating harness-dormancy assertions in the feed (31b–31d), token-bridge (49i–49k),
and comparison (80c–80e) diagnostics.

## 11. AccessContext authority preservation

M15 touches no AccessContext / Login / AccessGuard / App / main / pilot; adds no provider value,
context API, getter, hook, window object, DOM event, persistence, console logging, or enforcement;
Firebase remains the sole authoritative session source; the harness result feeds nothing into any
decision / route / loading / authError path. No phase implies authorization is authoritative or
enforceable.

## 12. Bundle exclusion strategy

Additive **check 2i** asserts `serverAuthzShadowLiveHarness` / `runServerAuthzShadowLiveOneShot` /
`VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT` / `VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT` / the confirmation
phrase are absent from `dist/**` (the harness is dormant → tree-shaken). Build + bundle scan are
required for M15 acceptance. No broad ban for route/`Authorization`/`Bearer`/`authorization`/permission/
entitlement key names was added (they legitimately appear in pilot/M12/M13/M14/frontend vocabulary).

## 13. Diagnostic strategy

`scripts/diagnostics-server-authz-shadow-live-harness-dormant-check.ts` (static/offline, reads `src/**`
as TEXT only — no app/server import, no env read, no network/DB/SQL/child-process/write) proves, via 82
assertions: existence; import allowlist (M14 feed + own/shared types only; no M11/M12/M13 direct / SDK /
React / Firebase / server / AccessContext / Login / AccessGuard / App / main / pilot); lazy (no
import-time call, no top-level await); no-throw; dormancy (imported by nothing active, no call site);
DEV + feed-enabled + arming-flag + exact-confirmation gating + flag hygiene (two M15 flags only);
owner-confirmation safety (exact phrase present, used only for declaration + equality, never logged/
returned, booleans only); in-memory one-shot guard (no persisted/cookie/file/DB/global marker);
feed-invocation confinement (feed called exactly once, only inside the lazy one-shot fn; no self-invoke);
no raw token / route / response / identity read; result safety (forbidden-field + phrase scan over the
types file); no UI / context / window / event / persistence / enforcement / secret / DB; no barrel;
self-inertness.

## 14. QA plan (non-live, offline only) — RESULTS

- `tsc --noEmit`: **12 pre-existing baseline errors / 0 new / 0 in any M15 file**.
- M15 harness dormancy diagnostic: **82/82**.
- Updated M14 feed diagnostic: **92/92**.
- M11 token-bridge diagnostic (updated): **84/84**.
- M13 comparison diagnostic (updated): **98/98**.
- M12 shadow-client diagnostic (unchanged): **92/92**.
- Inventory (2c/4e): **21/21**; readiness (3c/5a): **20/20**; observer private-surface (42): **46/46**
  — all unchanged and green (harness contains no route or `…SHADOW` flag literal).
- Adoption **22/22**; foundation **37/37**; bootstrap **44/44**; awareness **55/55**; observer-wiring
  **45/45**; firebase-authority **36/36**.
- Offline contract/schema/map regression: audit-schema **15/15**, authorization-schema **20/20**,
  pilot **13/13**, appsession-map **7/7**, audit-event-contract **10/10**, authorization-contract
  **12/12**, session-derived-authz-contract **23/23**, session-resolve-contract **15/15**,
  feature-key-canonicalization **21/21**.
- Offline `npm run build` (`vite build`) OK + bundle secret scan **15/15** (harness + flags + phrase
  absent from `dist/**`).
- **NOT run (boundary compliance):** every DB/route/live diagnostic (`*-live-check`, the live-route
  check, `supabase-whoami`, `session-resolve-check`, and any diagnostic that opens `./db` / `postgres`
  / binds a port / runs `child_process`). None read any file changed by M15, so none can regress.

## 15. QA plan for the future M16 live execution (separate owner approval)

Confirm branch + commit; DEV-only local target; production NOT targeted; all four frontend flags +
arming flag + exact confirmation phrase (presence/boolean only); backend
`ENABLE_SUPABASE_PLATFORM_IDENTITY` + `ENABLE_SESSION_RESOLVE` on and `NODE_ENV !== 'production'`, with
`ENABLE_LIVE_SESSION_AUTHORIZATION` **OFF** for the null-authz first run; state null-vs-non-null
expectation (null for M16); acknowledge identity upsert + advisory audit envelope may occur; pre/post
identity delta + `audit_event` delta (=0 expected for M16) **iff DB read access is separately
approved**, else explicit waiver + UNVERIFIED note; run **once** (no retry/batch); capture only the
non-secret result; assert no token / body / DTO / identity / confirmation value printed; immediate stop
on any unexpected side effect.

## 16. Identity delta / audit_event delta / DB-read approval vs waiver

- **Identity delta:** an identity upsert is an expected, acknowledged side effect even in the M16
  null-authz test; check pre/post **iff** DB read access is separately approved.
- **`audit_event` delta:** expected **0** for M16 (live-authz OFF); a non-zero delta for M17 (live-authz
  ON). Check **iff** DB read access approved.
- **Waiver path:** if DB read access is NOT approved, the owner must explicitly waive delta checks, and
  the M16 report must state in bold that **side-effect counts are UNVERIFIED**.

## 17. Rollback plan

1. Delete `src/auth/serverAuthzShadowLiveHarness.ts`, `src/auth/serverAuthzShadowLiveHarnessTypes.ts`,
   `scripts/diagnostics-server-authz-shadow-live-harness-dormant-check.ts`, and this doc.
2. Revert the feed-diagnostic `31/32` allowlist + `31b–31d`.
3. Revert the token-bridge `49h` allowlist + `49i–49k`.
4. Revert the comparison `80b` allowlist + `80c–80e`.
5. Revert the additive bundle-scan check `2i`.
6. Revert the `replit.md` M15 pointer line.
7. No DB/audit rollback (no route call, migration, seed, SQL, schema/RLS/Auth change, or DB write
   occurred). Runtime is already neutralized by the flags being absent/false (the default) and the
   harness being unimported.

`git revert` (or reset to `a7b8922`) fully restores M14 state.

## 18. M16 / M17 strategy (deferred)

- **M16 — Owner-approved live one-shot execution (null-authz first):** run `runServerAuthzShadowLiveOneShot()`
  exactly once in a DEV browser runtime under the full §15 guardrails; expect phase `completed` with
  the feed phase `server_authz_unavailable` (`authorization: null`); verify identity delta (iff DB read
  approved) and assert zero `audit_event` delta.
- **M17 — Non-null authorization live one-shot:** enable `ENABLE_LIVE_SESSION_AUTHORIZATION`; expect the
  feed phase `compared`; mandatory pre/post `audit_event` delta check.

## 19. Explicitly deferred stages (post-M15)

Live `/auth/session/resolve` invocation; non-null authorization read; permission-LEVEL comparison;
behavioral allow/deny comparison; AccessContext shadow wiring; pilot `authorization: null` read/pin
update; enforcement; Login migration; protected business APIs; **Backend Control Plane**; **Backend UI
Control Panel**; **Database Operations Console / direct DB control**; production migration. Each
requires its own explicit, separately-approved milestone.
