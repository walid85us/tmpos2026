# Phase 1.6 — Milestone 17.1: Safe Live Authorization Output Redaction

**Status:** Implemented (dormant, DEV-only) — pending owner review / manual QA. Not committed, pushed, or backed up.

**Accepted base checkpoint:** `fca7d725d7e6644493fa4fe7fb36147a906acb78` — *"Phase 1.6 M16.2 add safe shadow feed error instrumentation"*.

---

## 1. M16 Closure Carry-Forward

M16 (ACCEPTED / COMPLETE): the owner-approved one-shot fired exactly once. `/auth/session/resolve`
returned `200 / authenticated` via the verified Supabase path with `authorizationPresent=false`; the
feed phase was `server_authz_unavailable` (`serverAuthzPresent=false`); `ENABLE_LIVE_SESSION_AUTHORIZATION`
remained OFF; the durable `audit_event` delta was `0`; and the `platform_identity` presence delta was
`0`. The M16 null-authz output was safe because, with `authorization` null, the embedded comparison
was the inert "server_authz_unavailable" result (server key count `0`; no server keys disclosed).

## 2. M17 Planning Conclusion

M17 planning (ACCEPTED / COMPLETE) concluded: **do not run live authorization yet.** The single blocker
is output shape, not the route or the gating. When `ENABLE_LIVE_SESSION_AUTHORIZATION=true` and the
server returns a **non-null** `authorization`, the existing M14 feed result embeds the M13 structural
comparison, whose per-key-space `missingFromServerKeys` / `unknownToFrontendKeys` arrays would surface
in the browser. For a real authenticated user those arrays effectively disclose that user's *granted*
permission / sub-permission / entitlement **key names** (by set complement) plus any server-only key
names. They do **not** leak tokens, permission levels, or role/tenant/store/plan/identity values — but
they exceed the safe target for a first attributable live result.

## 3. Why the Current M14/M15 Output Is Too Detailed for Non-Null Authz

- `serverAuthzShadowFeed.ts` returns `comparison: ServerAuthzShadowComparisonResult | null`.
- On a non-null authorization (`compared` phase), that comparison carries
  `permissionKeySpace` / `subPermissionKeySpace` / `entitlementKeySpace`, each a `KeySpaceComparison`
  with `missingFromServerKeys: string[]` and `unknownToFrontendKeys: string[]`.
- `serverAuthzShadowLiveHarness.ts` forwards the feed result verbatim in its `feed` field.
- Therefore a live (non-null) run would carry key-name lists to the browser/console.

## 4. Why Redaction Is Required *Before* Live Authorization Execution

A controlled, attributable first live result should reveal only that authorization was produced and how
it structurally compares — **not** the user's effective key-set. The redaction projection makes the
browser-safe surface carry only counts + booleans, so the M17.2 live one-shot can be run later without
disclosing key names.

## 5. What Was Built (Additive, Dormant, DEV-only)

A pure, synchronous, no-throw projection that converts an M14-style feed result into a
counts-and-booleans-only summary. It is **dormant** (imported by nothing, invoked by nothing),
tree-shaken from production, and does not modify any existing M11–M16 module.

**Files added:**

| File | Purpose |
|---|---|
| `src/auth/serverAuthzLiveRedactedSummaryTypes.ts` | Types only: structural input mirror + the redacted output shape. |
| `src/auth/serverAuthzLiveRedactedSummary.ts` | The pure projection + a DEV-only enablement helper. |
| `scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts` | Offline dormancy + output-redaction-safety diagnostic (static checks + guarded runtime self-tests). |
| `docs/phase-1.6-milestone-17.1-safe-live-authz-output-redaction-plan.md` | This document. |

**Exports:** `projectServerAuthzLiveRedactedSummary(feedResult)`, `isServerAuthzLiveRedactedSummaryEnabled()`, `isDevBuild()`.

## 6. Redacted Output Shape

```
ServerAuthzLiveRedactedSummary {
  summaryPhase: 'summarized' | 'unavailable' | 'malformed'
  ok: boolean
  status: number                       // HTTP transport status (0 ⇒ unknown)
  phase: string | null                 // allow-listed safe feed/route phase
  comparisonPhase: string | null       // allow-listed safe comparison phase
  serverAuthzPresent: boolean
  safeReasonCode: string               // fixed high-level label
  overallParity: boolean | null
  permissionParity: boolean | null
  subPermissionParity: boolean | null
  entitlementParity: boolean | null
  permission:    RedactedKeySpaceSummary | null
  subPermission: RedactedKeySpaceSummary | null
  entitlement:   RedactedKeySpaceSummary | null
  message: string                      // fixed, phase-derived
}

RedactedKeySpaceSummary {
  hasComparison: boolean
  frontendCount: number
  serverCount: number
  matchedCount: number
  missingCount: number                 // LENGTH of dropped array (names absent)
  unknownCount: number                 // LENGTH of dropped array (names absent)
  isExactMatch: boolean
}
```

Behavior:
- **null / non-object input** → `summaryPhase: 'malformed'` (fail closed; empty safe summary).
- **serverAuthzPresent=false / no comparison / non-200** → `summaryPhase: 'unavailable'` (safe status + phase only).
- **serverAuthzPresent=true + comparison** → `summaryPhase: 'summarized'` (counts + parity booleans; all key arrays dropped).
- Unknown/arbitrary phase strings are allow-listed to `null` (never echoed). The input `message` is never read or echoed.

## 7. Forbidden Output Fields (never present)

raw `authorization` object · raw route body · raw comparison object · `missingFromServerKeys` ·
`unknownToFrontendKeys` · permission key names · sub-permission key names · entitlement key names ·
mismatch key lists · permission LEVEL values · role names/ids · tenant ids · store ids · plan ids ·
user ids · provider uid · email · tokens · headers · request/response bodies · the M15 confirmation
phrase value.

## 8. Dormant / No-Live Boundary

The module imports only its own types (`import type`, erased). It performs no fetch, no route call, no
token acquisition, no DB/SQL, no Supabase client, no `window`/storage/DOM/event/console access, and has
no import-time side effects. The public env is read only inside the enablement helper. It is imported by
nothing (not AccessContext/Login/AccessGuard/App/main/pilot, not the M14 feed, not the M15 harness), so
the production bundle tree-shakes it out. No existing M11–M16 module was modified. It is **not wired**
into any runtime path in M17.1.

## 9. Static Diagnostic Strategy

`scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts` reads `src/**` as text and
verifies: files exist; the module imports only its own types; it is pure/synchronous/no-throw; it
contains no fetch/route/token/feed/harness/comparison/createClient/window/storage/console; it is
DEV+flag-gated (default OFF) with a single new flag; the **output** types declare no array/raw/identity/
tenant/store/role/plan/level fields; the module drops the mismatch arrays to counts; it is imported by
nothing and has no call site; and (when `dist/**` exists) its identifiers/flag are absent from the
emitted bundle. It then runs **guarded runtime self-tests** by dynamically importing only the pure
subject-under-test and asserting on synthetic input that the projected output has no arrays, no
`missingFromServerKeys`/`unknownToFrontendKeys`, no raw authorization, preserves counts + parity
booleans, is JSON-safe, and does not mutate its input. (The diagnostic's static top-level imports stay
confined to node `fs`/`path`; the single runtime `import()` targets only the pure module, which the
same diagnostic proves imports no live behavior.)

## 10. QA Plan (offline / non-live only)

1. `npx tsx scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts`
2. Existing dormancy/static diagnostics: server-authz shadow live-harness, shadow-feed, shadow-comparison,
   supabase token-bridge, session-resolve shadow-client, session-resolve error-classification.
3. `npm run build` then `npx tsx scripts/diagnostics-frontend-bundle-secret-scan-check.ts`.
4. `npx tsc --noEmit` — confirm 0 new M17.1 errors and no M17.1 file in the error list.

No live route, harness, feed, token-bridge, DB, SQL, migration, seed, Supabase MCP, or production run.

## 11. Rollback Plan

1. Delete `src/auth/serverAuthzLiveRedactedSummary.ts`.
2. Delete `src/auth/serverAuthzLiveRedactedSummaryTypes.ts`.
3. Delete `scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts`.
4. Delete `docs/phase-1.6-milestone-17.1-safe-live-authz-output-redaction-plan.md`.
5. No `replit.md` pointer was added (nothing to revert).
6. No DB rollback (no DB connection/write occurred). No audit rollback (no route call occurred).
7. The pre-existing `.replit` local change and the goose tarball remain out of scope and untouched.

## 12. Next Milestone — M17.2

`Phase 1.6 M17.2 — Owner-Approved Live Authorization One-Shot` (DEV-only): with the redaction layer in
place, a future owner-approved pass would enable `ENABLE_LIVE_SESSION_AUTHORIZATION` in DEV, capture
read-only before/after `audit_event` / `platform_identity` baselines (expect `audit_event` `+1`,
`platform_identity` count unchanged), run the M15 one-shot once, and surface **only** the redacted
summary — no key lists, no raw authorization object.

## 13. Scope Reminders

- **Production remains blocked.** Live authorization is hard-excluded in production
  (`NODE_ENV!=='production'`) and gated behind multiple default-OFF flags.
- **Backend Control Plane / Backend UI remain deferred.** M17.1 adds no UI and wires nothing into any
  runtime path; it is a dormant redaction utility only.
