# Phase 1.6 M13 — Dormant Server-Authz Shadow COMPARISON Helper (DEV-Flag-Gated, Synthetic-Input-Only, Imported-by-Nothing, Invoked-by-Nothing) — Plan & Closeout

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed, not backed
up. No current app behavior changed. **Firebase remains the sole active / default / authoritative
session source.** No DB connection, route call, migration, seed, SQL, audit write, Supabase MCP,
live route call, package change, backend change, or production change occurred. **The helper was
authored but NEVER invoked; `/auth/session/resolve` was NOT called; no live `authorization` was
read.**

**Accepted base checkpoint:** `ce8c7677b6e1c1c23f1d6afa1bf1d879a086a92e`
(Phase 1.6 M12 — add dormant session resolve shadow client).

**Selected design:** **Option D** from the accepted M13 planning pass — a dormant, DEV-flag-gated,
**synthetic-input-only** server-authz shadow COMPARISON helper that structurally compares a
caller-provided (synthetic) server-derived authorization DTO against the FRONTEND permission
vocabulary on **key-spaces only**, returns a NON-SECRET structural result, and is imported by
nothing active / invoked by nothing.

---

## 1. Why this milestone exists (synthetic-input comparison helper)

M12 proved the *shape* of a route-call (Bearer header + `{}` body, non-secret status classification)
is safe and dormant — but M12 deliberately did **not** read the server-derived `authorization`
field. M13 is the next still-dormant layer: the *shape of the comparison* that would, in a future
separately-approved step, check whether the server's authorization key-space agrees structurally
with the frontend permission vocabulary.

M13 authors that comparison against **synthetic / caller-provided input ONLY** — never a live
response. This lets the comparison contract (which key-spaces, how parity is computed, what is safe
to surface) be reviewed and locked *before* any live `authorization` is ever read, and before any
enforcement is contemplated. The helper changes no behavior, reads nothing live, and is called by
nothing.

## 2. Scope

**In scope (added):**
- `src/auth/serverAuthzShadowComparison.ts` — dormant, pure/synchronous/no-throw comparison helper;
  imports the FRONTEND permission vocabulary (`../context/accessConfig`,
  `../owner/platformPermissionsConfig`) + its own types only.
- `src/auth/serverAuthzShadowComparisonTypes.ts` — pure TYPES only (no imports; no
  token/authz-value/identity fields; non-secret result shape).
- `scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts` — 94-assertion dormancy +
  synthetic-input + structural-only + result-safety proof (labels 1–83e; static/offline; reads
  `src/**` as TEXT).
- This document.

**In scope (controlled modifications):**
- `scripts/diagnostics-frontend-bundle-secret-scan-check.ts` — **additive check 2g only**
  (`serverAuthzShadowComparison` / `compareServerAuthzShadow` / `VITE_ENABLE_SERVER_AUTHZ_SHADOW`
  absent from `dist/**`). No existing check weakened; deliberately NOT a blanket ban on
  `authorization` / `permissions` / `subPermissions` / permission-key / entitlement-key names (they
  legitimately appear elsewhere in the app).
- `scripts/diagnostics-frontend-auth-provider-inventory-check.ts` — **check 4e only** (controlled
  single-file exception): the flag may appear in EXACTLY `src/auth/serverAuthzShadowComparison.ts`;
  still FAILS for any other `src/**` reference.
- `scripts/diagnostics-frontend-supabase-auth-readiness-check.ts` — **check 5a only** (identical
  single-file exception). Checks 5b/5c (M4-doc fallback semantics + flag documented) unchanged.
- `scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts` — **check 42 only**
  (identical single-file exception; still FAILS for AccessContext or any other reference).
- `replit.md` — one M13 pointer line.

> **Note on the controlled exceptions (4e/5a/42):** these three checks previously asserted
> `VITE_ENABLE_SERVER_AUTHZ_SHADOW` was **absent from all of `src/**`** (the flag was "future-only").
> M13 wires it into exactly one file. Each exception is scoped to `src/auth/serverAuthzShadowComparison.ts`
> ONLY — the check still FAILS if any other `src/**` file references the flag. No other diagnostic is
> weakened. The helper's dormancy + structural-only / result-safety are independently proven by the
> M13 diagnostic.

**Explicitly NOT touched:** `src/context/AccessContext.tsx` (M8 observer wiring), the M9
private-surface lock, the M11 token bridge files, the M12 shadow-client files, Login, AccessGuard,
App routing, `src/main.tsx`, `src/pilot/**`, `src/firebase.ts`, `accessConfig`/`platformPermissionsConfig`
(read-only import), M5 foundation files, M6 bootstrap files, M7 helper files, all `server/**`,
migrations, seeds, `package.json`, `package-lock.json`, `.replit`, secrets, Supabase/Firebase config.

## 3. Comparison helper API

```ts
compareServerAuthzShadow(
  input: ServerDerivedAuthorizationLike | null,
): ServerAuthzShadowComparisonResult

isServerAuthzShadowEnabled(): boolean   // optional; DEV && flag === 'true'
```

`ServerDerivedAuthorizationLike` (synthetic; declared locally, NOT imported from the server
contract): `{ permissions?, subPermissions?, entitlements? }` — three optional key-maps whose
**KEYS only** are ever read (values/levels/booleans are never read).

`ServerAuthzShadowComparisonResult` (non-secret): `{ phase, serverAuthzPresent, overallParity,
permissionKeyParity, subPermissionKeyParity, entitlementKeyParity, permissionKeySpace,
subPermissionKeySpace, entitlementKeySpace, counts, message }`. Each `*KeySpace` is a
`KeySpaceComparison` carrying only `{ parity, frontendKeyCount, serverKeyCount, matchedKeyCount,
missingFromServerKeys[], unknownToFrontendKeys[] }` (safe KEY NAMES + counts). `phase` ∈
`disabled | server_authz_unavailable | compared`. Messages are PHASE-DERIVED (never echo server
content).

## 4. Why dormant / imported by nothing active / invoked by nothing

The helper is imported by **nothing active** (not AccessContext / Login / AccessGuard / App / main /
pilot) and by no other `src/**` file, so the bundler tree-shakes it (and the frontend vocabulary it
reaches) out of production. It has **no import-time side effects** and **no top-level await**: it
builds three frozen vocabulary key-sets at module load from plain-data config exports, and performs
a comparison ONLY when `compareServerAuthzShadow()` is explicitly called — and **M13 adds no call
site**. Proven by the M13 dormancy diagnostic (checks 73–81) + the bundle scan (check 2g).

## 5. Why no live route call occurs / why no live authorization is read

The helper takes **synthetic / caller-provided input only**. It NEVER calls `/auth/session/resolve`,
never fetches/XHRs/sendBeacons, never uses a token, and never reads a live `authorization` response.
A live read is deferred for the same reason M12 deferred the live call: the route is **not
side-effect-free** when backend flags are enabled (identity upsert + advisory/durable audit). M13
locks the comparison contract against synthetic data so the live read can be designed later, with
its own guardrails (§14), without coupling that risk to this milestone.

## 6. Why the M11 token bridge and M12 shadow client are NOT imported

A live `authorization` would arrive via the M12 shadow client (which uses the M11 token bridge).
M13 imports **neither**, because M13 reads nothing live: importing them would (a) create a path that
could fetch/use a token, defeating the synthetic-input boundary, and (b) couple the comparison
contract to the route-call layer prematurely. The comparison helper depends ONLY on the frontend
permission vocabulary + its own types. (Diagnostic checks 17–18 enforce no M12/M11 import; checks
29/31 enforce no `runSessionResolveShadowCheck` / `withSupabaseAccessToken` call.)

## 7. Why the comparison is STRUCTURAL (key-space) only

M13 answers exactly one question safely: *does the server's authorization vocabulary structurally
cover the frontend's permission vocabulary?* It compares **only the KEY NAMES** of three key-spaces
(permissions / subPermissions / entitlements), reporting per-space parity, counts, and safe mismatch
key names. Reading values would require comparing authorization *decisions*, which is a separate,
higher-risk concern (enforcement-adjacent) that must not ride along on a structural-coverage check.
Unknown server keys are ALWAYS reported as a mismatch and NEVER fail open.

## 8. Why permission-LEVEL comparison is deferred

Permission *levels* (e.g. `view`/`edit`/`manage`/`full`) are authority semantics. Comparing them
implies a level-hierarchy mapping between server and client and edges toward decision logic. M13
reads no levels and contains no level-hierarchy helper — level reconciliation is a separate future
milestone.

## 9. Why behavioral allow/deny comparison is deferred

Allow/deny is the actual access *decision*. Comparing decisions is one step from enforcement and
would require live, authoritative inputs. M13 reads no `.decision`/`.allowed`/`allow`/`deny` and
never computes a decision — only key-space coverage.

## 10. Why AccessContext function comparison is deferred

`hasPermission` / `checkSubPermission` / `canAccess` / `getPermissionLevel` / `isStoreActivated` /
`resolveLandingRoute` are the live client authority. Invoking them would (a) pull React/context into
a pure helper, (b) read real session/tenant/role state, and (c) blur the line between "compare
vocabularies" and "compare decisions". M13 invokes **none** of them (diagnostic check 57) and never
imports AccessContext (checks 6, 74).

## 11. Null authorization strategy

`authorization === null` (or `undefined`) ⇒ phase **`server_authz_unavailable`**: server
authorization is **UNAVAILABLE / NOT EVALUATED**. The legacy client engine remains authoritative.
This is **NOT** a deny, **NOT** fail-open, **NOT** enforceable — it is "nothing to compare". The
result reports `serverAuthzPresent: false`, `overallParity: false` (nothing was compared), and a
phase-derived message. This mirrors the binding `authorization: null` = fall-back-to-legacy-engine
semantics documented since M3/M4.

## 12. Non-null authorization strategy

A non-null synthetic DTO ⇒ phase **`compared`**: the three key-spaces are structurally compared. The
result is **COMPARABLE ONLY** — explicitly **not authoritative, not enforceable, not a replacement
for AccessContext**. It is an observational structural-coverage signal, nothing more.

## 13. Key-space comparison strategy

Three frozen FRONTEND vocabulary key-sets are derived ONCE at module load from plain-data config:
- **permissions** = tenant module domains (`PERMISSION_DOMAINS[].id`) ∪ platform feature keys
  (`PLATFORM_FEATURE_GROUPS[].key`).
- **subPermissions** = tenant sub-permission ids (`SUB_PERMISSIONS[].id`) ∪ platform sub-permission
  ids ∪ platform sub-permission alias keys (`PLATFORM_SUB_PERMISSION_ALIASES`).
- **entitlements** = union of every plan's feature keys (`planFeatures`), alias-normalized.

This mirrors the four key-spaces proven bidirectionally total by the M3 adoption-readiness
diagnostic (tenant domains + platform features; tenant subs + platform subs), so a future adapter
mapping is total and the frontend needs no server import. Each key-space comparison reports
`missingFromServerKeys` (frontend keys the DTO omitted) and `unknownToFrontendKeys` (DTO keys the
frontend does not recognize — ALWAYS a mismatch, NEVER fail-open). Parity holds only when both
directions are empty.

## 14. Entitlement alias normalization (`supply_chain` → `supply-chain`)

The frontend ENTITLEMENT vocabulary (`planFeatures`) uses the dashed `supply-chain`, while a
server-derived entitlement map may emit the underscore `supply_chain`. `normalizeEntitlementKey()`
canonicalizes `supply_chain` → `supply-chain` (idempotent for already-canonical keys) and is applied
to BOTH the frontend entitlement key-set and the synthetic DTO's entitlement keys before comparison,
so the alias never registers as a spurious mismatch. **Permission-space** module ids stay
`supply_chain` (underscore) on both sides (per `PERMISSION_DOMAINS`), so they need no normalization —
the alias is entitlement-space only.

## 15. Result safety

The result type carries ONLY: `phase`, `serverAuthzPresent`, parity booleans, per-key-space
comparisons (safe KEY NAMES + counts), aggregate counts, and a phase-derived message. It NEVER
carries a token / `access_token` / `refresh_token` / JWT / provider token, `internalUserId` /
`authProvider` / `authProviderUid` / `email` / `displayName` / identity, `tenantId` / `storeId`,
role values, plan values, permission-LEVEL values, or the raw authorization DTO / raw entitlement
payload. Enforced statically by M13 diagnostic checks 61–63 (forbidden-field scan over the types
file) and the comparison-boundary checks 50–57.

## 16. Controlled diagnostic exceptions (4e / 5a / 42)

The flag `VITE_ENABLE_SERVER_AUTHZ_SHADOW` was previously banned from all of `src/**` by:
inventory **4e**, readiness **5a**, and observer private-surface **42**. M13 wires it into exactly
one file. Each check now excepts EXACTLY `src/auth/serverAuthzShadowComparison.ts` and still FAILS
for any other `src/**` reference (including AccessContext, enforced by check 42). No other diagnostic
and no other check in these three files is weakened. These were the only authorized exceptions.

## 17. Production bundle exclusion strategy (required)

Because M13 adds a frontend helper, an offline `npm run build` + bundle secret scan are required.
The scan (additive **check 2g**) asserts the comparison-helper module name + exported function +
flag (`serverAuthzShadowComparison` / `compareServerAuthzShadow` / `VITE_ENABLE_SERVER_AUTHZ_SHADOW`)
are absent from `dist/**`, alongside the existing foundation/bootstrap/awareness/observer/token-bridge/
shadow-client identifiers and all privileged Supabase/DB patterns. The helper is DEV-gated and
imported by nothing active, so Vite folds `import.meta.env.DEV` to `false` (and tree-shakes the
unimported module), excluding it from production.

## 18. Diagnostic strategy

`scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts` (static/offline, reads `src/**`
as TEXT only — no app/server import, no env read, no network/DB/SQL/child-process/write) proves, via
94 assertions (labels 1–83e): existence; import allowlist (frontend vocabulary + own types only; no AccessContext /
Login / AccessGuard / App / main / pilot / server / server-catalog / SDK / React / Firebase / M5–M7 /
M11 bridge / M12 shadow client); pure/synchronous/no-throw; no import-time call; no top-level await;
synthetic-input only (no fetch/XHR/sendBeacon, no `/auth/session/resolve`, no
`runSessionResolveShadowCheck`, no `withSupabaseAccessToken`, no token identifiers); DEV+flag gating
(default OFF) + flag hygiene (no M11/M12/route-helper flag; single new flag); frontend-vocabulary
derivation + three frozen key-sets; key-space-only comparison (`Object.keys`, never values); alias
normalization; the strict comparison boundary (no level/role/tenant/store/plan/identity/allow-deny
read; no AccessContext function call); null/non-null/disabled phases; result safety (forbidden-field
scan over the types file); no UI/context/provider/window/DOM-event/console/persistence/network/secret;
dormancy (imported by nothing active, no call site); no barrel; self-inertness.

## 19. QA plan (non-live, offline only)

`tsc --noEmit` (0 new errors, no M13 file in the list); the new M13 diagnostic; the updated
inventory (4e) + readiness (5a) + observer private-surface (42) diagnostics; the M3 adoption-readiness
diagnostic; the M11 token-bridge + M12 shadow-client dormancy diagnostics; the full M1–M12 offline
regression suite (DB-free only); and an offline `npm run build` + bundle secret scan (check 2g). No
live route diagnostics, DB-backed diagnostics, audit-writer diagnostics, session-resolve live route
checks, SQL, migrations, seeds, or Supabase MCP.

## 20. Rollback plan

1. Delete `src/auth/serverAuthzShadowComparison.ts`, `src/auth/serverAuthzShadowComparisonTypes.ts`,
   `scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts`, and this doc.
2. Revert the additive bundle-scan check `2g`.
3. Revert the controlled inventory (4e), readiness (5a), and observer private-surface (42) single-file
   exceptions back to their "flag absent from all `src/**`" forms.
4. Revert the `replit.md` M13 pointer line.
5. No DB/audit rollback (no route call, migration, seed, SQL, schema/RLS/Auth change, or DB write
   occurred). Runtime is already neutralized by the flag being absent/false (the default) and the
   helper being unimported.

`git revert` (or reset to `ce8c767`) fully restores M12 state.

## 21. Required future live-call identity/audit guardrails (NOT run in M13)

Any future live invocation that would feed a *real* `authorization` into this comparison requires,
separately and explicitly: (1) owner approval naming the live test; (2) confirmation backend route
flags are DEV-only; (3) confirmation production is not targeted; (4) confirmation of whether identity
upsert may occur; (5) pre/post identity-row or safe identity-delta check *only if* DB access is
separately approved; (6) pre/post `audit_event` count or audit-delta check *only if* the live-authz
flag is on AND DB access is separately approved; (7) the expectation that advisory audit logs may
occur; (8) a one-time bounded test only; (9) no token printed; (10) no sensitive response body
printed; (11) no route call if DB/audit guardrails are not approved; (12) immediate stop on any
unexpected side effect. **M13 implementation performs none of these.**

## 22. M14 hand-off options (deferred)

Candidate next steps, each its own separately-approved milestone:
- **D1 — Live shadow read (read-only):** wire the M12 shadow client → feed a *real* `authorization`
  into `compareServerAuthzShadow`, behind the existing flags, with the §21 guardrails; surface only a
  private, non-authoritative structural result.
- **D2 — Permission-LEVEL shadow comparison:** add a synthetic level-hierarchy reconciliation layer
  (still observational, no enforcement).
- **D3 — Decision (allow/deny) shadow comparison:** compare server decision vs legacy client
  decision on synthetic inputs (still observational).
- **D4 — AccessContext shadow wiring:** a private, write-only ref (mirroring the M8/M9 observer
  pattern) that records the structural result without surfacing it.

Recommended M14 direction: **D1** (live read-only shadow) under full §21 guardrails — it is the
smallest next increment that produces real signal while staying non-authoritative and non-enforcing.

## 23. Explicitly deferred stages (post-M13)

Live `/auth/session/resolve` invocation; identity/audit delta guardrails; permission-LEVEL / decision
shadow comparison; AccessContext shadow wiring; pilot `authorization: null` pin update; enforcement;
Login migration; protected business APIs; **Backend Control Plane**; **Backend UI Control Panel**;
**Database Operations Console / direct DB control**; production migration. Each requires its own
explicit, separately-approved milestone.
