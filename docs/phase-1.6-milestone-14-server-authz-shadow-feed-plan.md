# Phase 1.6 M14 — Dormant Server-Authz Shadow FEED Helper (DEV-Flag-Gated, Synthetic-of-Nothing, Imported-by-Nothing, Invoked-by-Nothing, No Live Read) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed, not backed
up. No current app behavior changed. **Firebase remains the sole active / default / authoritative
session source.** No DB connection, route call, migration, seed, SQL, audit write, Supabase MCP,
live route call, package change, backend change, or production change occurred. **The helper was
authored but NEVER invoked; `/auth/session/resolve` was NOT called; no live `authorization` was
read; the M11 token bridge, M12 shadow client, and M13 comparison helper were NOT invoked.**

**Accepted base checkpoint:** `f6bcf8f4deb419c939d58b438427cb5a65c19b7e`
(Phase 1.6 M13 — add dormant server authz shadow comparison).

**Selected design:** **Option C — dormant server-authz shadow feed helper, no invocation**, via
**Approach X** from the accepted M14 plan: a new dormant helper that imports the **M11 token bridge**
+ the **M13 comparison helper** (+ M13/own types) and contains the future route→comparison logic, but
is imported by nothing active and invoked by nothing in M14.

---

## 1. Why this milestone exists

M11 made a Supabase token safely available (immediate-use callback). M12 made a dormant route-call
to `/auth/session/resolve` that classifies status but **deliberately discards `authorization`**. M13
made a dormant, synthetic-input structural comparison of an authorization DTO against the frontend
vocabulary. The one missing link to *real* signal is a component that reads the *real*
`authorization` object from the route and passes it to `compareServerAuthzShadow(...)`. M14 authors
exactly that link — **dormant** — so the route→comparison contract can be reviewed and locked before
any live invocation.

## 2. The M12 authorization gap (why M12 is NOT imported)

M12's `runSessionResolveShadowCheck` reads ONLY safe shape fields (`requestId/authState/decision/
reasonCode/sourceOfTruth`) and **never reads or returns `authorization`** — that is M12's binding
response-safety boundary. So a feed cannot simply chain M12→M13: M12 has no authorization to feed.
**Approach X**: the feed performs its OWN authorization-extracting route read (mirroring M12's exact
token/route discipline) and does **NOT** import or modify M12. Extending M12 to surface
`authorization` (the rejected Option E) would blur its proven boundary; Approach X keeps M12
byte-for-byte unchanged and its dormancy diagnostic fully strict.

## 3. Scope

**In scope (added):**
- `src/auth/serverAuthzShadowFeed.ts` — dormant feed helper; imports the M11 bridge + M13 helper +
  M13/own types only.
- `src/auth/serverAuthzShadowFeedTypes.ts` — pure types (imports ONE type: the M13 non-secret
  comparison result, re-used as the feed result's `comparison` field).
- `scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts` — 89-check dormancy + route/token/
  authorization/result-safety proof (static/offline; reads `src/**` as TEXT).
- This document.

**In scope (controlled modifications):**
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive check 2h only** (feed
  identifiers + flag absent from `dist/**`). No existing check weakened; deliberately NOT a blanket
  `/auth/session/resolve` / `Authorization` / `Bearer` / `authorization` / permission-key / entitlement-key ban.
- `scripts/diagnostics-supabase-token-bridge-dormant-check.ts` — **check 49b allowlist** (allow the
  feed as a 2nd dormant bridge importer) **+ new 49f–49h** (assert the feed is itself imported by
  nothing active). No token-safety / route / foundation-importer / bundle check weakened.
- `scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts` — **checks 80/81 allowlist**
  (allow the feed as the sole M13 importer/caller) **+ new 80b** (assert the feed is itself imported
  by nothing active). No comparison-boundary / result-safety check weakened.
- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **check 2c** (route single-file
  allowlist: feed) **and check 4e** (flag single-file allowlist: feed).
- `scripts/diagnostics-frontend-supabase-auth-readiness-check.ts` — **check 3c** (route) **and 5a** (flag).
- `scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts` — **check 42** (flag).
- `replit.md` — one M14 pointer line.

> **Controlled exceptions, surfaced:**
> - **Route guards (2c/3c):** the feed file contains the explicit `/auth/session/resolve` literal (its
>   future read; route literal kept auditable, not obfuscated). This trips the same route guards that
>   already except the M12 shadow client. Per the M14 implementation prompt's controlled-update rule,
>   adding the feed as a single-file route exception is **clearly equivalent to that authorized M12
>   pattern**; the guards still FAIL for any other non-pilot reference.
> - **Flag guards (4e/5a/42):** the feed's dedicated flag `VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED`
>   contains `VITE_ENABLE_SERVER_AUTHZ_SHADOW` as a prefix, and the feed's documentation prose names
>   the flag — so the substring-matching guards flag the feed. The feed does **NOT** use the M13 flag
>   in CODE (it gates via the imported `isServerAuthzShadowEnabled`), independently proven by the feed
>   diagnostic. A single-file allowlist (feed) keeps each guard confining the exact M13 flag to the
>   M13 helper; the guards still FAIL for any other reference (incl. AccessContext).

**Explicitly NOT touched:** `src/auth/sessionResolveShadowClient.ts` (M12) + types, M13 comparison
helper/types source logic, M11 token bridge source, M5/M6/M7/M8/M9 source, AccessContext, Login,
AccessGuard, App routing, `src/main.tsx`, `src/pilot/**`, `src/firebase.ts`, accessConfig,
platformPermissionsConfig, all `server/**`, migrations, seeds, `package.json`, `package-lock.json`,
`.replit`, secrets, Supabase/Firebase config.

## 4. Feed helper API

```ts
runServerAuthzShadowFeed(options?: { signal?: AbortSignal }): Promise<ServerAuthzShadowFeedResult>
isServerAuthzShadowFeedEnabled(): boolean
```

`ServerAuthzShadowFeedResult` (non-secret): `{ ok, status, phase, serverAuthzPresent, comparison,
message }`. `status` is the HTTP TRANSPORT status (0 ⇒ route never reached) — not a body field.
`comparison` is the M13 `ServerAuthzShadowComparisonResult | null` (non-secret structural result, or
null when no comparison ran). `phase` ∈ `disabled | token_bridge_disabled | no_session | no_token |
cancelled | route_disabled | denied | unreachable | server_error | malformed |
server_authz_unavailable | compared`. Messages are PHASE-DERIVED.

## 5. Why dormant / imported by nothing active / invoked by nothing

The feed is imported by **nothing active** (not AccessContext / Login / AccessGuard / App / main /
pilot) and by no other `src/**` file, so the bundler tree-shakes it — and, through it, the M11 bridge
+ foundation and the M13 helper — out of production. It has **no import-time side effects** and **no
top-level await**: the token bridge is invoked, the route is called, and the comparison runs ONLY
when `runServerAuthzShadowFeed()` is explicitly called — and **M14 adds no call site**. Proven by the
M14 feed dormancy diagnostic (checks 24–32) + the bundle scan (check 2h) + the compensating
feed-dormancy assertions in the M11 (49f–49h) and M13 (80b) diagnostics.

## 6. Why no live route call occurs in M14 / why deferred to M15

There is no active caller and no QA invocation, so `/auth/session/resolve` is never called and no
live `authorization` is read. A live call is deferred because, when backend flags are enabled, the
route is **not side-effect-free** (§7). M14 locks the route→comparison contract dormantly; the live
one-shot invocation is a separately-approved M15-style milestone (§16).

## 7. Backend route side-effect facts (binding cautions)

A live `/auth/session/resolve` call may, with backend flags enabled: verify the Supabase token;
upsert a durable `platform_identity` row; emit advisory audit-envelope logs; and — only with
`ENABLE_LIVE_SESSION_AUTHORIZATION=true` (non-production, resolver allow, durable audit success) —
write a durable `audit_event` row (and only then is `authorization` non-null). With the route's
backend flags off (default), a call returns 404 with no side effects. **M14 calls nothing.**

## 8. Token discipline

The raw token is obtained ONLY inside the M11 bridge's immediate-use callback and used ONLY as the
outgoing `Authorization: Bearer <token>` header value. Body is EXACTLY `{}`; content-type
`application/json`; base URL from `VITE_IDENTITY_API_BASE` (`/__identity` default). The token is
never sent in the body, placed in the URL/query, logged, persisted, stored, returned, or included in
the result/message.

## 9. Authorization extraction strategy

On a 200 response, the feed reads ONLY the body's `authorization` object — never the raw body,
identity (`internalUserId`/`authProvider`/`authProviderUid`/`email`/`displayName`/`identity`),
`scope`/`tenantId`/`storeId`, `roles`, `status`, or `userType`. The `authorization` object (typed
loosely as `ServerDerivedAuthorizationLike | null`) is passed TRANSIENTLY into
`compareServerAuthzShadow(...)` and is **not retained, returned, or logged**.

## 10. Why identity / scope / roles / status / userType are not extracted; why raw authz is not returned

Those are identity/role/tenant/store/status values — outside the structural-coverage question M13
answers, and identity-sensitive. The feed reads only the `authorization` map and surfaces only the
M13 NON-SECRET structural comparison (safe key names + counts), never the raw DTO or raw response
body. This keeps the feed result safe to surface for diagnostics without exposing identity/authority.

## 11. Result safety

The result carries ONLY: transport `status`, `phase`, `serverAuthzPresent`, the M13 `comparison`
result (or null), and a phase-derived `message`. It NEVER carries a token / JWT / provider token, the
raw response body, the raw `authorization` DTO, identity fields, `tenantId`/`storeId`, role values,
plan values, or permission-LEVEL values. Enforced statically by the feed diagnostic (checks 66–68)
and the extraction-boundary checks (53–62).

## 12. Null / non-null authorization strategy

`authorization: null` (the default, and the only outcome with backend flags off) ⇒ phase
`server_authz_unavailable`: server authorization unavailable / not evaluated; the legacy client
engine remains authoritative; **not deny, not fail-open, not enforceable**. Non-null ⇒ phase
`compared`: **comparable only, not authoritative, not enforceable, not a replacement for
AccessContext**.

## 13. AccessContext authority preservation

M14 touches no AccessContext/Login/AccessGuard/App/main/pilot; adds no provider value, context API,
getter, hook, window object, DOM event, persistence, console logging, or enforcement; Firebase
remains the sole authoritative session source; the feed result feeds nothing into any
decision/route/loading/authError path.

## 14. Flag strategy

Enablement = **DEV** ∧ `isSupabaseTokenBridgeEnabled()` (M11: DEV + `VITE_ENABLE_SUPABASE_TOKEN_BRIDGE`
+ foundation) ∧ `VITE_ENABLE_SESSION_RESOLVE_SHADOW === 'true'` (M12 flag, read directly because M12
is not imported) ∧ `isServerAuthzShadowEnabled()` (M13: DEV + `VITE_ENABLE_SERVER_AUTHZ_SHADOW`) ∧
**new** `VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED === 'true'`. All DEV-only, default OFF. **No single flag
implies route/feed behavior**; the M11/M13 flags arrive via imported enable-checks (not duplicated
literals), and the dedicated feed flag is the master switch. No other new flag introduced.

## 15. Controlled importer / route / flag allowlists & bundle exclusion

See §3. The bundle exclusion (additive **check 2h**) asserts `serverAuthzShadowFeed` /
`runServerAuthzShadowFeed` / `VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED` are absent from `dist/**` (the
feed is dormant → tree-shaken). Build + bundle scan are required for M14 acceptance.

## 16. Diagnostic strategy

`scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts` (static/offline, reads `src/**` as
TEXT only — no app/server import, no env read, no network/DB/SQL/child-process/write) proves, via 89
assertions: existence; import allowlist (M11 bridge + M13 helper + M13/own types only; no M12 / SDK /
React / Firebase / foundation-direct / AccessContext / Login / AccessGuard / App / main / pilot /
server); lazy (no import-time call, no top-level await); no-throw; dormancy (imported by nothing
active, no call site); four-flag DEV gating + flag hygiene (no duplicated M11/M13 flag literal in
code; single new flag); token discipline (Bearer-only, `{}` body, content-type, base URL; never
body/URL/log/store/return); authorization-extraction-only (reads ONLY `.authorization`; no identity/
scope/roles/status/userType; no level/allow-deny; no AccessContext function call); null/non-null/
disabled phases; result safety (forbidden-field scan over the types file); no UI/context/window/
event/persistence/secret/DB; no barrel; self-inertness.

## 17. QA plan (non-live, offline only)

`tsc --noEmit` (0 new errors, no M14 file in the list); the new M14 feed diagnostic; the updated M11
+ M13 dormancy diagnostics; the (unchanged) M12 dormancy diagnostic; the inventory (2c/4e) + readiness
(3c/5a) + observer (42) diagnostics; M3 adoption + foundation/bootstrap/awareness/observer-wiring/
firebase-authority; the full M1–M13 offline regression suite (DB-free only); and an offline
`npm run build` + bundle secret scan (check 2h). No live route / DB-backed / audit-writer /
session-resolve-live / SQL / migration / seed / Supabase MCP / production checks.

## 18. Rollback plan

1. Delete `src/auth/serverAuthzShadowFeed.ts`, `src/auth/serverAuthzShadowFeedTypes.ts`,
   `scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts`, and this doc.
2. Revert the additive bundle-scan check `2h`.
3. Revert the M11 token-bridge `49b` allowlist + `49f–49h`.
4. Revert the M13 comparison `80/81` allowlist + `80b`.
5. Revert the inventory `2c`/`4e`, readiness `3c`/`5a`, and observer `42` single-file allowlists.
6. Revert the `replit.md` M14 pointer line.
7. No DB/audit rollback (no route call, migration, seed, SQL, schema/RLS/Auth change, or DB write
   occurred). Runtime is already neutralized by the flags being absent/false (the default) and the
   feed being unimported.

`git revert` (or reset to `f6bcf8f`) fully restores M13 state.

## 19. Future live-call identity/audit guardrails (NOT run in M14 — for M15)

Any future live invocation requires, separately and explicitly: (1) owner approval naming the
one-shot test; (2) DEV-only confirmed; (3) production not targeted; (4) exact frontend flags listed
(`VITE_ENABLE_SUPABASE_TOKEN_BRIDGE`, `VITE_ENABLE_SESSION_RESOLVE_SHADOW`,
`VITE_ENABLE_SERVER_AUTHZ_SHADOW`, `VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED`); (5) exact backend flags
listed (`ENABLE_SUPABASE_PLATFORM_IDENTITY`, `ENABLE_SESSION_RESOLVE`,
`ENABLE_LIVE_SESSION_AUTHORIZATION`); (6) null-vs-non-null expectation stated; (7) identity-upsert
possibility confirmed; (8) advisory-audit-log possibility acknowledged; (9) durable `audit_event`
possibility acknowledged; (10) pre/post identity-link delta check **iff** DB access separately
approved; (11) pre/post `audit_event` delta check **iff** live-authz on AND DB access approved; (12)
no live call if deltas can't be checked and owner doesn't waive; (13) one-shot bounded; (14) no token
printed; (15) no body printed; (16) no raw authorization logged; (17) immediate stop on unexpected
side effect; (18) explicit rollback/reporting; (19) no enforcement regardless of result. **M14
performs none of these.**

## 20. M15 hand-off (deferred)

Owner-approved guarded **live one-shot feed invocation** using `runServerAuthzShadowFeed()` under the
full §19 guardrails: read-only, non-authoritative, private, surfacing only the non-secret feed/
comparison result. Alternatives: private app-runtime diagnostic invocation (outside AccessContext);
pilot-only authorization read.

## 21. Explicitly deferred stages (post-M14)

Live `/auth/session/resolve` invocation; identity/audit delta procedures; permission-LEVEL comparison;
behavioral allow/deny comparison; AccessContext shadow wiring; pilot `authorization: null` pin update;
enforcement; Login migration; protected business APIs; **Backend Control Plane**; **Backend UI
Control Panel**; **Database Operations Console / direct DB control**; production migration. Each
requires its own explicit, separately-approved milestone.
