# Phase 2.0 — Backend Control Panel — M36: C‑07 Authorization Entry / Server Mount / Registration Planning Gate

**Status:** DOCS‑ONLY planning gate. No source, test, route, adapter, registration, guard, server‑mount, client, UI, package, or runtime change is made by M36.
**Milestone:** Phase 2.0 M36.
**Pre‑change accepted checkpoint:** `13f9c8ae98243f7af992eae42991fe70f68da474` (subject: *Phase 2.0 M35 add backend control panel C07 route adapter*).
**Purpose:** Decide whether the next milestone should unlock the deferred C‑07 authorized `200` success path by authorizing a tightly‑scoped **additive** guard entry, a **narrow** server mount, and an **isolated** route registration test — and lock the exact safe file package, tests, and stop conditions **before** any frozen surface is touched.

> This gate implements nothing. It reads the accepted C‑07 baseline (M33 core + M35 route/adapter), the frozen C‑01..C‑06 guard/mount/registration patterns, and the current git/test/typecheck state, then locks the smallest safe next plan. The authorization entry, server mount, and registration are **not** created in M36.

---

## Section A — Preflight Result

All preflight conditions **PASS**. This is the pre‑change backup checkpoint; no extra backup is created.

| # | Condition | Result |
|---|-----------|--------|
| 1 | Branch is `main` | PASS |
| 2 | Local `HEAD` == `origin/main` == `13f9c8ae98243f7af992eae42991fe70f68da474` (confirmed via `rev-parse` **and** `ls-remote origin main`) | PASS |
| 3 | ahead/behind is `0/0` | PASS |
| 4 | `git status` shows only ` M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | PASS |
| 5 | Nothing staged | PASS |
| 6 | `.gitattributes` absent | PASS |
| 7 | M35 commit present (`13f9c8a Phase 2.0 M35 add backend control panel C07 route adapter`) | PASS |
| 8 | Since `HEAD == origin/main`, this is the pre‑change backup checkpoint | PASS — no extra backup |
| 9 | No source/test/backend/frontend/route/adapter/registration/UI/package/migration/DB/Supabase/auth/runtime change occurs in M36 | PASS (docs‑only) |
| 10 | No commit, push, or backup occurs in M36 | PASS |

---

## Section B — M35 Backup and Route / Adapter Baseline Review

The M35 route/adapter baseline is safely committed and backed up.

| # | Confirmation | Result |
|---|--------------|--------|
| 1 | M35 commit hash | `13f9c8ae98243f7af992eae42991fe70f68da474` |
| 2 | M35 commit subject | `Phase 2.0 M35 add backend control panel C07 route adapter` |
| 3 | `origin/main` matches local `HEAD` | PASS |
| 4 | Push was fast‑forward and non‑force | PASS (remote `main` == local `HEAD`, `0/0`) |
| 5 | Exactly four M35 files were committed | PASS (route + adapter + their two tests) |
| 6 | No docs file was committed at M35 | PASS |
| 7 | No existing file was modified at M35 | PASS |
| 8 | No provider/read‑model file was modified | PASS (M33 core untouched) |
| 9 | No route registration was created | PASS |
| 10 | No server mount was created | PASS |
| 11 | No `bcpAuthorizationGuard.ts` change | PASS (still C‑01..C‑06 only) |
| 12 | No `bcpTransportMatrix.test.ts` change | PASS (still exactly 6 lenses) |
| 13 | No client / UI / screen integration | PASS |
| 14 | No package / lockfile change | PASS |
| 15 | No DB / Supabase / live provider access | PASS |
| 16 | New M35 tests | 56/56 (route 30/30 + adapter 26/26) |
| 17 | Full BCP corpus | 1237/1237 |
| 18 | Typecheck | 12 unrelated baseline errors; 0 BCP‑surface errors |
| 19 | Static scan | clean |
| 20 | C‑07 `200` success remains guard‑gated and deferred | PASS (fail‑closes to 403) |
| 21 | M35 residuals accepted | PASS |

---

## Section C — C‑07 Readiness for Authorization / Mount / Registration

C‑07 is **ready** for the next authorization/mount/registration milestone. Every readiness condition holds.

| # | Readiness check | Result |
|---|-----------------|--------|
| 1 | M33 provider/read‑model core is pure and deterministic | PASS |
| 2 | M33 provider/read‑model tests green | PASS (provider 43/43, read‑model 41/41) |
| 3 | M35 route handler is isolated, unmounted, safe | PASS |
| 4 | M35 Express adapter is isolated, unmounted, safe | PASS |
| 5 | Route/adapter tests green | PASS (30/30, 26/26) |
| 6 | Route/adapter introduce no DB/SQL/Supabase/live provider | PASS |
| 7 | Route/adapter introduce no runtime env‑value exposure (the only env reads are the two boolean gates) | PASS |
| 8 | Route/adapter introduce no diagnostics or command output | PASS |
| 9 | Route/adapter introduce no action/mutation behavior | PASS (GET/HEAD/OPTIONS only) |
| 10 | Route/adapter ready for additive guard‑entry planning | PASS |
| 11 | Route/adapter ready for server‑mount planning | PASS |
| 12 | Route/adapter ready for registration‑test planning | PASS |
| 13 | C‑07 authorized success path can only become active after guard entry **and** server mount are implemented | PASS (structurally present, unreachable today) |
| 14 | C‑07 must remain DEV‑only, production‑disabled, default‑off, read‑only after any future mount | LOCKED (see Sections E–H) |
| 15 | No client/UI/screen integration is needed for M37 unless separately selected | CONFIRMED — deferred (Section J) |

**Guard‑gap (confirmed by inspection).** `bcpAuthorizationGuard.ts` `CONTRACT_MIN_VISIBILITY` maps `C‑01..C‑06` only (each `'overview_viewer'`). With the pinned `'C‑07'` contract, `authorizeBcpRead` reaches step 6 (`if (!required) return deny('unknown_contract')`) and the route/adapter fail‑close to `403 not_authorized` on an otherwise‑authorized GET/HEAD. The M35 route handler **never** modifies, injects, or bypasses the guard, and reads `items` **only** on the (currently unreachable) success branch — so a denied/disabled request never consumes provider/read‑model items. C‑07 is therefore ready for an **additive** entry.

---

## Section D — Authorization / Mount / Registration Options

| Option | Description | Risk | Verdict |
|--------|-------------|------|---------|
| **A** | M37: additive guard entry **+** server mount **+** registration test **+** route/adapter test updates (flip deferred 403 → real 200 where appropriate) | Medium (modifies 2 frozen runtime surfaces — guard + `server.ts` — updates 2 accepted C‑07 test files in place, and adds 1 new registration test) | **SELECTED** |
| B | M37: guard entry only | Medium‑low | Rejected — does not mount; C‑07 stays unreachable through the identity API; registration remains deferred; low net value |
| C | M37: server mount + registration only (no guard entry) | — | Rejected — C‑07 remains fail‑closed (`unknown_contract`); mounting without the entry unlocks no useful behavior |
| D | M37: full authorization + mount + registration **+** transport matrix row | Medium‑high (touches 3 frozen surfaces) | Rejected — larger blast radius; matrix can safely follow in M38 |
| E | Another docs‑only planning gate | Low | Rejected — guard/mount/registration behavior is exact and unambiguous (patterns proven by C‑02..C‑06); no further planning needed |

**Rationale for A.** The guard entry is a single additive map row; the mount mirrors the frozen C‑02..C‑06 `app.all(ROUTE_PATH, createHandler({ … }))` pattern exactly; the registration test mirrors the frozen C‑06 static/import‑level test exactly; and the route/adapter test updates are a bounded flip of the guard‑gap `403` assertions to `200` on the authorized path while **all** denied/disabled/405/OPTIONS/HEAD/error/hostile tests are preserved. This is the smallest package that unlocks the deferred `200` path while preserving C‑07's DEV‑only / read‑only / production‑disabled posture. The transport matrix (Option D's extra surface) is deferred to M38 (Section I).

---

## Section E — Additive Guard Entry Contract Lock

**File:** `server/bcp-pilot/bcpAuthorizationGuard.ts`
**Change (M37):** add exactly one map row to `CONTRACT_MIN_VISIBILITY`, immediately after the existing `'C‑06'` row:

```
'C-07': 'overview_viewer',
```

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | Add only the `C‑07` mapping | ✔ |
| 2 | Do not alter `C‑01..C‑06` mappings | ✔ |
| 3 | Do not alter default‑deny behavior | ✔ |
| 4 | Do not alter `unknown_contract` behavior except that `C‑07` becomes known | ✔ |
| 5 | Do not add live session authorization | ✔ |
| 6 | Do not add DB/Supabase reads | ✔ |
| 7 | Do not add request‑supplied authority | ✔ |
| 8 | Do not trust body/query/header/cookie identity | ✔ |
| 9 | Preserve server‑sourced authority only | ✔ |
| 10 | Preserve disabled/denied/error safe envelopes | ✔ |
| 11 | Tests must prove unknown contracts still deny | ✔ (Section L §1) |
| 12 | Tests must prove `C‑01..C‑06` behavior unchanged | ✔ (Section L §1) |
| 13 | Tests must prove `C‑07` now maps **only** to `overview_viewer` | ✔ (Section L §1) |
| 14 | If adding `C‑07` requires a broader guard refactor → **STOP** | Stop condition #1 (see *Stop conditions for M37*) |

The `overview_viewer` floor (rank 1) is the same read‑only floor every other lens uses; it introduces no write/manage/approve/mutate visibility. With the entry present, `authorizeBcpRead({ contractId: 'C-07', … })` for the M35 synthetic principal (`source: server_derived`, `verified: true`, `internalUserId: 'iu_synthetic_dev'`, `parityState: 'ready'`, `visibilityClass: 'overview_viewer'`) resolves to `allow`, unlocking the route handler's already‑present `200` branch. No other guard logic changes.

**Stale range comment (optional hygiene).** The guard file carries a range comment above `CONTRACT_MIN_VISIBILITY` that currently reads *C‑01..C‑05* — already stale relative to the present `C‑06` row. M37 **may** optionally refresh it to *C‑01..C‑07* as part of the same additive, comment‑only touch to this already‑allowed file (this is explicitly permitted by stop condition #1 and is **not** scope creep). It is optional hygiene, not required; the only binding change remains the single additive map row, and any comment refresh must never alter guard logic.

---

## Section F — Server Mount Contract Lock

**File:** `server/platform-identity/server.ts`
**Change (M37):** mirror the frozen C‑05/C‑06 mount exactly — add the two import lines and one `app.all(...)` registration:

```
import { createBcpC07DataSourceBoundaryReadinessHandler, BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH } from '../bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter';
import { getBcpC07DataSourceBoundaryItems } from '../bcp-pilot/bcpC07DataSourceBoundaryProvider';
…
app.all(
  BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH,
  createBcpC07DataSourceBoundaryReadinessHandler({ getDataSourceBoundaryItems: getBcpC07DataSourceBoundaryItems }),
);
```

**Route path (LOCKED):** `/dev/bcp/data-source-boundary-readiness` (via the exported constant; never an inline string literal).

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | Mount only the C‑07 read‑only adapter route | ✔ |
| 2 | Use the same isolated identity‑API / Backend‑CP pattern as C‑02..C‑06 (`app.all(ROUTE_PATH, createHandler({ … }))`) | ✔ |
| 3 | Do not change existing C‑01..C‑06 mounts | ✔ |
| 4 | Do not change global middleware behavior | ✔ |
| 5 | Do not change auth/session behavior | ✔ (no live session resolver; adapter supplies a fixed synthetic principal) |
| 6 | Do not add a customer‑facing route | ✔ (isolated `/dev/bcp/*` on the platform‑identity API) |
| 7 | Do not add a normal SaaS‑navigation route | ✔ |
| 8 | Do not add a frontend proxy/client/UI | ✔ (deferred) |
| 9 | Preserve the frozen DEV‑gate (production‑disabled): `isDevEnvironment` defaults to `NODE_ENV !== 'production'` — the **same resolver** as C‑01..C‑06 (verified). See the DEV‑gate precision note below | ✔ |
| 10 | Preserve default‑off feature‑flag behavior | ✔ (`ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS`, default OFF) |
| 11 | Preserve production‑disabled behavior | ✔ |
| 12 | Preserve GET/HEAD/OPTIONS/405 behavior | ✔ |
| 13 | Preserve safe error envelope | ✔ |
| 14 | Do not add DB/Supabase/live provider | ✔ |
| 15 | Do not add action/mutation behavior | ✔ |
| 16 | Do not start a new server/listener/socket | ✔ (registers on the existing `app`) |
| 17 | If mounting requires a broader server refactor → **STOP** | Stop condition #2 (see *Stop conditions for M37*) |

**Provider wiring note (binding for M37).** The mount **imports** `getBcpC07DataSourceBoundaryItems` from the frozen `bcpC07DataSourceBoundaryProvider.ts` and passes it as the `getDataSourceBoundaryItems` dependency — mirroring how C‑05/C‑06 wire their server‑owned providers. Importing the provider's exported function is **not** a modification of the provider file; `bcpC07DataSourceBoundaryProvider.ts` remains on the M37 prohibited‑files list and is not edited. The provider is a deterministic, code/config‑only, server‑owned registry (no live read).

**Mount placement (binding for M37).** The `app.all(BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH, …)` registration MUST be inserted **within the existing isolated Backend‑CP mount block, immediately adjacent to the C‑06 registration**, on the same `app` and behind the same surrounding middleware. "Registered exactly once" (regex presence) is necessary but not sufficient: a route placed after a terminal/catch‑all/error handler, or behind different middleware, could be shadowed or wrongly exposed. M37 must NOT reorder or alter any existing C‑01..C‑06 mount or middleware; and the registration test (Section G) must **additionally assert placement** — that the C‑07 mount appears inside the BCP block (adjacent to C‑06) and is not positioned after any terminal/catch‑all/error handler.

**DEV‑gate precision + accepted residual.** "DEV‑only" here means the **frozen** resolver `isDevEnvironment = (NODE_ENV !== 'production')` — verified identical across C‑01..C‑06 and C‑07. This is *production‑disabled*, not *exact‑`development`‑only*: `test`, `staging`, empty, or unset `NODE_ENV` also resolve to dev (and would serve the `200` path when the default‑off flag is on). Tightening the gate to exact `development` is a **cross‑lens** decision that would edit the frozen adapter source (prohibited in M37) and break parity with C‑01..C‑06; it is therefore an **accepted residual, explicitly deferred** to a separate cross‑cutting hardening milestone and is **out of M37 scope**. M37 preserves the frozen resolver; M37 tests MAY (test‑only, no source change) document the actual behavior for non‑`production` `NODE_ENV` values, but MUST NOT claim exact‑`development` semantics. The default‑off feature flag remains the primary gate in every non‑production environment.

---

## Section G — Registration Test Contract Lock

**New file (M37):** `server/bcp-pilot/bcpC07RouteRegistration.test.ts` — mirrors the frozen `bcpC06RouteRegistration.test.ts` static/import‑level harness (statically reads `../platform-identity/server.ts` via `fs.readFileSync`; asserts by regex; starts no server, opens no socket/port, performs no network I/O).

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | Confirm the C‑07 route is registered in the same identity‑API pattern as C‑02..C‑06, **within the BCP mount block adjacent to C‑06** and not after any terminal/catch‑all/error handler | ✔ (`app.all(BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH, …)` exactly once, placement‑asserted) |
| 2 | Confirm the path is exactly `/dev/bcp/data-source-boundary-readiness` | ✔ (asserted via the constant; no inline literal) |
| 3 | Confirm method behavior is consistent with frozen BCP routes | ✔ (single `app.all`; no `app.post/put/patch/delete` for C‑07) |
| 4 | Confirm the C‑07 adapter is referenced by the server mount | ✔ (imports `createBcpC07DataSourceBoundaryReadinessHandler`) |
| 5 | Confirm no client/UI route is created | ✔ |
| 6 | Confirm no normal SaaS‑navigation route is created | ✔ |
| 7 | Confirm no package/lockfile change | ✔ |
| 8 | Confirm no DB/Supabase/live‑provider import | ✔ |
| 9 | Confirm C‑01..C‑06 registrations remain unchanged (one each) | ✔ |
| 10 | Confirm no raw diagnostics or production‑readiness claim | ✔ (safe summary predicates only) |
| 11 | Use static/import‑level safe assertions only | ✔ |
| 12 | Do not start a server | ✔ |
| 13 | Do not open sockets/listeners/ports | ✔ |
| 14 | Do not use outbound network | ✔ |

Recommended assertions (mirroring C‑06 registration test, 1:1): route registered exactly once via the constant; adapter factory + route‑path constant imported from `bcpC07DataSourceBoundaryReadOnlyExpressAdapter`; `getBcpC07DataSourceBoundaryItems` imported from the provider; the factory is wired with **only** the server‑owned `getDataSourceBoundaryItems` provider (no `req.`/`body`/`query`/`headers`/`cookies`/`principal`/`schemaVersion`); no `src/`/`mockData`/sensitive‑row import in `server.ts`; no env‑enumeration/log/package read in the C‑07 path files; no runtime scanner/router introspection; no `createClient`/`@supabase`/`getDb`; no mutation/customer‑facing/SaaS‑nav registration; C‑01..C‑06 registrations intact (one each); guard carries the additive `'C‑07': 'overview_viewer'` entry with `C‑01..C‑06` unchanged and no write/manage visibility introduced; no `src/` file imports the backend C‑07 modules; the C‑07 handler is registered (`app.*`) **only** in the isolated `server.ts`; and the C‑07 `app.all(…)` registration appears within the Backend‑CP mount block (adjacent to the C‑06 registration) and is **not** positioned after any terminal/catch‑all/error handler.

---

## Section H — Route / Adapter Test Update Contract Lock

**Files (M37, updated in place):**
`server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` and
`server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`.

Once the additive `'C‑07'` guard entry exists, the currently‑deferred success path becomes reachable. The updates **flip every valid‑principal assertion** from the guard‑gap `403` to the authorized `200`, and **preserve** all null/insufficient‑principal denials, the disabled/production/method gates, and the safe‑error paths. The exact per‑assertion flip‑vs‑preserve list is enumerated under "Specific flips" below — it is the gate's core deliverable and an implementer must follow it precisely, because at least one current assertion (`assertSafeDeniedBody(handle(base()).body)`) will **hard‑fail** if left unchanged once `base()` becomes an authorized `200` envelope.

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | Replace/supplement the guard‑gated deferral tests with real authorized `200` success tests (after the guard entry exists) | ✔ |
| 2 | Preserve fail‑closed behavior for **unknown** contracts (separate guard test) | ✔ |
| 3 | Preserve guard `403` tests for missing/insufficient access | ✔ |
| 4 | Preserve guard `409` (`parity_blocked`) tests where applicable | ✔ |
| 5 | Preserve feature‑disabled (`404`) tests | ✔ |
| 6 | Preserve production‑disabled (`404 dev_only`) tests | ✔ |
| 7 | Preserve HEAD bodyless tests (now HEAD‑authorized `200` bodyless) | ✔ |
| 8 | Preserve OPTIONS `204` + `Allow: GET` tests | ✔ |
| 9 | Preserve `405` mutation tests | ✔ |
| 10 | Preserve the hostile‑fields‑ignored **property** (authority never taken from the request); note the resulting **status** flips `403 → 200` for a **valid** principal (see "Specific flips"). Only null/insufficient‑principal cases keep `403` | ✔ |
| 11 | Preserve denied‑paths‑do‑not‑consume‑items tests where applicable | ✔ |
| 12 | Add: success consumes provider/read‑model items **only after** the guard passes | ✔ |
| 13 | Confirm schema remains `bcp.c07.data-source-boundary-readiness.v1-code-config` | ✔ |
| 14 | Confirm `generatedAt` remains excluded | ✔ |
| 15 | Confirm `selfAttestation` remains `design_time_code_config` | ✔ |
| 16 | Confirm no raw errors, diagnostics, or production‑readiness claim | ✔ |
| 17 | Do not fake authorization | ✔ (200 arises only from the real additive guard entry) |
| 18 | Do not bypass guard semantics | ✔ |

**Specific flips — route test (`bcpC07DataSourceBoundaryReadOnlyRoute.test.ts`).** Every assertion that drives a **fully‑valid** principal (dev + enabled + the fixed synthetic `ready`/`overview_viewer` principal, contract pinned server‑side to `C‑07`) currently expects the guard‑gap `403`; **each of these flips to the authorized `200`**:

- *authorized GET (dev+enabled) ⇒ 403 not_authorized* → **200 success envelope**;
- *authorized HEAD ⇒ 403 bodyless* → **200 bodyless**;
- *authorized GET does NOT emit an envelope* (asserts `schemaVersion === undefined`) → **now emits the envelope** (assert `schemaVersion === 'bcp.c07.data-source-boundary-readiness.v1-code-config'`);
- *hostile hints WITH a valid principal still 403* → **200** (the hints are still ignored — authority is never taken from the request — but the result is now `200`, not `403`);
- the `assertSafeDeniedBody(handle(base()).body)` entry inside the *"every reachable state produces a SAFE denied/disabled body"* aggregate: once the guard entry lands, `base()` (a valid principal) returns a `200` **envelope**, which `assertSafeDeniedBody` forbids (no `schemaVersion` allowed) and would **hard‑fail**. M37 MUST remove `base()` from that denied‑body aggregate and instead assert its success envelope via the C‑07 success fitness functions.

The success‑envelope contract assertions (schema / `selfAttestation` / no‑`generatedAt`, plus `assertBcpC07OutputKeyAllowList` / `ValueContentSafety` / `ProductionReadinessClaimBan` / `SelfAttestationFraming`) are re‑pointed at the handler's real `success` result rather than a direct builder call. **Preserved unchanged** (still their current status): null‑principal / untrusted‑hints‑only / unverified / null‑`internalUserId` denials (`403`), non‑ready / blocked parity (`409 parity_blocked`), feature‑disabled and production/dev‑off (`404`), OPTIONS `204`, mutation `405`, HEAD‑bodyless‑on‑error `500`, and the no‑raw‑error scans.

**Add a direct `unknown_contract` proof.** The C‑07 route pins `PINNED_CONTRACT_ID = 'C‑07'` and its request type carries no `contractId`, so the handler cannot exercise an arbitrary unmapped id, and the static registration test only regex‑checks source — neither can prove this indirectly. The fail‑closed property must therefore be proven by a **separate** assertion that calls `authorizeBcpRead({ contractId: 'C-99', featureEnabled: true, principal: <the valid synthetic principal> })` **directly** (both the route and adapter test files already import from `bcpAuthorizationGuard`) and asserts `deny('unknown_contract')` — proving M37 widened the map by exactly one row, not the default.

**Specific flips — adapter test (`bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`).** The valid‑principal cases flip the same way: `GUARD-GAP: GET (dev+enabled) ⇒ 403` → **200 JSON envelope**; `GUARD-GAP: HEAD ⇒ 403 bodyless` → **200 bodyless `end`**; `provider resolved when dev+enabled (items unused on the guard‑gap 403 path)` → **200, items now consumed**; `reads ONLY req.method … ⇒ 403` → **200** (still only `req.method` read); `hostile extra fields ignored (still 403)` → **200** (fields still ignored). The single `server.ts`‑does‑**NOT**‑mount static assertion (adapter test line 79) is the **only** one inverted to a **does‑mount** assertion (or relocated to the new registration test). The adapter‑**file** self‑inertness assertions — no `express()`/`Router`/`app.*` in the adapter source, and the adapter source does not import `platform-identity/server` — MUST be **preserved**, because the adapter file stays inert and the mount lives only in `server.ts`. OPTIONS `204` / `Allow: GET`, mutation `405`, feature‑disabled / production `404`, default‑off resolver, gates‑first not‑resolved‑when‑off, safe `500`, and no‑raw‑error remain unchanged.

---

## Section I — Transport Matrix Decision

**Decision: DEFER matrix extension to M38.**

`bcpTransportMatrix.test.ts` is a consolidated cross‑lens harness that asserts the single uniform transport contract for **exactly the six frozen lenses C‑01..C‑06**, enforced by a hard `assert.equal(LENSES.length, 6, 'expected exactly 6 lenses (C-01..C-06)')`. Extending it to C‑07 requires editing that frozen assertion (6 → 7), adding a C‑07 `LENSES` entry, and importing the C‑07 handler/adapter — a third frozen‑test‑surface edit.

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| 1 — Defer to M38 | Keeps M37 focused on guard/mount/registration; avoids touching a third frozen test surface; smaller blast radius | C‑07 mounted route is not in the boundary matrix until M38 | **SELECTED** |
| 2 — Include in M37 | Immediate matrix coverage after mount | Touches `bcpTransportMatrix.test.ts` in the same milestone as guard + mount; larger blast radius | Rejected |

M37 must **not** modify `bcpTransportMatrix.test.ts` (it stays 106/106, exactly 6 lenses). The likely next step after M37 is **M38 — C‑07 Transport Matrix Extension** (planning or implementation gate).

---

## Section J — Client / UI Decision

**Decision: NO client/UI in M37.**

Client/UI remains deferred until after: (1) the guard entry is accepted; (2) the server mount is accepted; (3) the registration test is accepted; (4) the route/adapter authorized‑success path is green; and (5) the transport‑matrix decision (M38) is resolved. Client/UI is out of scope for M37 and is not a stop condition — it is simply a later, separately‑selected milestone (M39+). Browser evidence remains waived for Phase 2.0 only and must reopen before any production/customer‑facing release.

---

## Section K — Next Implementation File Package Lock (M37)

**Recommended next milestone:** **Phase 2.0 M37 — C‑07 Authorization Entry / Server Mount / Registration Implementation.**

**Allowed files — exactly five:**

| # | File | Action |
|---|------|--------|
| 1 | `server/bcp-pilot/bcpAuthorizationGuard.ts` | MODIFY — add one additive `'C-07': 'overview_viewer'` map row |
| 2 | `server/platform-identity/server.ts` | MODIFY — add C‑07 imports + one `app.all(...)` mount (mirror C‑05/C‑06) |
| 3 | `server/bcp-pilot/bcpC07RouteRegistration.test.ts` | CREATE — static registration‑safety test (mirror C‑06) |
| 4 | `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyRoute.test.ts` | MODIFY — flip authorized path 403 → 200; preserve all other cases |
| 5 | `server/bcp-pilot/bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts` | MODIFY — flip authorized path 403 → 200; invert the does‑NOT‑mount assertion |

These five are the **only** files that may be created or modified in M37.

---

## Section L — Test Requirements for M37

**1. Guard tests** (`bcpAuthorizationGuard` behavior): `C‑07` maps to `overview_viewer`; an **unknown** contract id still denies — proven by a **direct** `authorizeBcpRead({ contractId: 'C-99', … })` call placed in the route or adapter test file (the C‑07 handler pins its contract id and cannot exercise an arbitrary unmapped id, and the static registration test only regex‑checks source, so neither proves this indirectly); `C‑01..C‑06` mappings unchanged; a denied principal remains denied; an insufficient‑capability principal remains denied; no request body/query/header/cookie authority; no DB/Supabase/live‑provider auth lookup; no live session authorization introduced.

**2. Server mount / registration tests** (`bcpC07RouteRegistration.test.ts`): route mounted at `/dev/bcp/data-source-boundary-readiness` (exactly once, via the constant); adapter referenced by the isolated identity‑API pattern; C‑01..C‑06 mounts unchanged; no customer‑facing route; no SaaS‑nav route; no frontend proxy/client/UI route; no DB/Supabase/live‑provider import; no server/listener/socket startup.

**3. Route test updates** (`bcpC07DataSourceBoundaryReadOnlyRoute.test.ts`): authorized GET ⇒ `200` success envelope after the guard entry; authorized HEAD ⇒ `200` bodyless; denied access still `403`; blocked access still `409` where applicable; unknown contract still fail‑closes (separate guard test); feature‑disabled still safe (`404`); production‑disabled still safe (`404 dev_only`); `500` safe error remains safe (HEAD stays bodyless on error); `generatedAt` remains excluded; `selfAttestation` remains `design_time_code_config`; success path consumes provider/read‑model items only **after** the guard passes.

**4. Adapter test updates** (`bcpC07DataSourceBoundaryReadOnlyExpressAdapter.test.ts`): authorized GET ⇒ `200` (JSON envelope); authorized HEAD ⇒ `200` bodyless (`end`); OPTIONS `204`; `Allow: GET`; mutation methods `405`; feature‑disabled behavior; production‑disabled behavior; safe `500` envelope (`{ status: 'error' }`); hostile request ignored (only `req.method` consulted; for a valid principal the result is now `200`, hostile fields still ignored); no raw body/header dumps; no diagnostics or stack trace; the M35 does‑NOT‑mount static assertion is inverted to a does‑mount assertion (or relocated to the registration test) so it does not contradict the new mount.

**5. Regression:** C‑01..C‑06 tests remain green; M33 provider/read‑model tests remain green; M35 route/adapter tests remain green with updated success expectations; M27 transport matrix remains green **and unmodified** (matrix extension deferred to M38); full BCP corpus remains green.

---

## Section M — Static Scan / Typecheck Requirements for M37

**Static scans must confirm M37 introduces none of:** package/lockfile changes; dependency installs; browser tooling; server‑startup changes outside the existing server‑file pattern; new sockets/listeners/ports outside the existing server baseline; outbound network I/O; child/background processes; filesystem scanning; filesystem writes; DB/Supabase access; SQL; Supabase MCP; live‑provider calls; production/customer‑facing exposure; normal SaaS‑navigation exposure; mutation/action behavior; raw logs; raw command output; raw transport output; raw response dumps; raw header dumps; stack‑trace exposure; raw error exposure; runtime diagnostics exposure; package/dependency/version exposure; file‑path inventory exposure; process detail exposure; PID/port/timing exposure; `process.env` enumeration; environment‑value exposure; value‑oracle behavior; production‑readiness claims; unintended frozen‑source drift.

**Typecheck posture (M37):** 12 unrelated baseline errors unchanged if still visible; **0** errors in the M37‑touched files; **0** in C‑07 files; **0** in `server/bcp-pilot`; **0** in `src/backend-control-plane`. Do **not** fix unrelated baseline errors.

---

## Section N — Transport / Browser Posture for M37

**Transport.** M37 may mount the route but must not claim real‑socket evidence unless separately authorized. Matrix extension is deferred, so `bcpTransportMatrix.test.ts` is not modified in M37; the follow‑on is **M38 — C‑07 Transport Matrix Extension**. No new live‑server smoke unless separately authorized; no outbound network; no child/background process. Real‑socket live transport remains deferred.

**Browser.** No client/UI in M37; no browser tooling; no package/lockfile change; no browser evidence required. Browser evidence remains **waived for Phase 2.0 only** and must reopen before production readiness, Phase 3, Phase 4, or any customer‑facing release.

---

## Section O — Baseline Reconfirmation (run at M36)

| Evidence | Expected | Observed at M36 |
|----------|----------|-----------------|
| Route tests | 30/30 | 30/30 |
| Adapter tests | 26/26 | 26/26 |
| New M35 tests | 56/56 | 56/56 |
| C‑07 provider | 43/43 | 43/43 |
| C‑07 read‑model | 41/41 | 41/41 |
| Full BCP corpus | 1237/1237 | 1237/1237 (40/40 files green) |
| Total files | 40/40 green | 40/40 green |
| M27 transport matrix | 106/106 | 106/106 (exactly 6 lenses) |
| C‑01..C‑06 | unchanged and green | unchanged and green |
| Typecheck | 12 baseline; 0 in `server/bcp-pilot`; 0 in `src/backend-control-plane`; 0 across C‑01..C‑07 | 12 baseline; 0 BCP‑scoped |
| Static scans | no package/lockfile change; no DB/Supabase/live exposure; no production/customer‑facing exposure; no raw env‑value/value‑oracle/log/diagnostics/package‑detail/command‑output/raw‑evidence/file‑path/production‑claim surface in C‑01..C‑07 lenses; no unauthorized mount/registration/client/UI/matrix change before M36 | all confirmed |

All accepted evidence was re‑run at M36 and matches the accepted baseline exactly. Nothing is marked NOT RUN.

---

## Section P — Independent Review Results

Four independent review passes ran (≥2 required); all findings were documentation‑only and are reconciled into this gate — none required a source/test/runtime change, so none was a blocker.

1. **Security / exposure / authorization‑mount review** — VERDICT: APPROVE‑WITH‑NITS. Verified every load‑bearing claim against source (guard gap, additive‑row safety, genuinely‑guarded `200`, mount pattern, locked values). Reconciled: added the gate‑integrity stop condition (#5); scoped the adapter‑test inversion to the single `server.ts`‑mount assertion (preserving adapter‑file self‑inertness); noted the optional stale‑guard‑comment refresh.
2. **Planning / split‑package / test‑matrix architecture review** — VERDICT: NEEDS‑REVISION (resolved). Confirmed the 5‑file package is exact/sufficient, the import‑only provider wiring, and the matrix‑defer rationale; found the `403 → 200` flip contract incomplete and locally contradictory (incl. `assertSafeDeniedBody(base())` hard‑failing). Reconciled: Section H rewritten with the full per‑assertion flip‑vs‑preserve enumeration and the direct `authorizeBcpRead` unknown_contract proof; Section L.1 corrected; Section D risk note corrected.
3. **Cross‑model governance / safety review (independent model)** — VERDICT: NEEDS‑REVISION (resolved). Raised mount‑placement/ordering hardening and DEV‑gate wording precision. Reconciled: Sections F/G now require adjacent‑to‑C‑06 placement with a static placement assertion; the DEV‑gate is stated precisely (`NODE_ENV !== 'production'`, verified identical across C‑01..C‑07) with the exact‑`development` tightening recorded as an explicitly‑deferred cross‑lens accepted residual. *(An initial cross‑model invocation misfired on transport and produced no verdict; it was re‑run correctly and the verdict above is the actual produced result — no verdict was fabricated for the failed attempt.)*
4. **Normative‑voice / terminology / consistency pass** — corrected dangling `Section 29` cross‑references to the doc's own stop‑conditions section, and verified the route / flag / schema / self‑attestation values are internally consistent (single value each).

After reconciliation, no residual finding requires any change outside this documentation gate.

---

## Section Q — M36 Decision

**Decision A — C‑07 AUTHORIZATION / MOUNT / REGISTRATION PLAN LOCKED; PROCEED TO SCOPED IMPLEMENTATION.**

Justification: the M35 baseline is safe and backed up; the guard entry can be additive and exact (one map row); the server mount can be narrow and exact (mirror C‑05/C‑06); the registration test can be isolated and exact (mirror C‑06); the route/adapter test updates are a bounded, honest flip of the guard‑gap assertions; the next implementation is limited to the five‑file package (Section K); the transport matrix remains deferred (M38); and client/UI remains deferred. No broader refactor is required.

---

## Section R — Next Governed Step Selection

**Candidate 1 — Phase 2.0 M37 — C‑07 Authorization Entry / Server Mount / Registration Implementation.** SELECTED (Decision A). Adds the additive `C‑07` guard entry, the server mount, the registration test, and the route/adapter test updates.

Candidates 2 (guard entry only), 3 (another docs‑only pass), and 4 (defer authorization/mount) are not selected.

---

## Section S — Non‑Readiness Statements

Phase 2.0 remains: **not** production readiness; **not** customer‑facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live‑provider reads; **not** Supabase auth enablement; **not** Firebase‑to‑Supabase cutover; **not** browser‑evidence completion for production/customer‑facing release.

Firebase remains authoritative. Supabase remains dormant/shadow/readiness‑only. Backend CP remains DEV‑only and read‑only in Phase 2.0. C‑07 authorization/mount/registration is **not** implemented during M36.

---

## Section T — Verification Before Final Report

Verified: only the M36 documentation file was created; no source/test/frontend/backend/provider/read‑model/route/adapter/registration/client/UI/screen file changed; `server/platform-identity/server.ts`, `bcpAuthorizationGuard.ts`, and `bcpTransportMatrix.test.ts` unchanged; `src/App.tsx` and main SaaS navigation unchanged; no package/lockfile/migration/seed/`shared/**`/auth/DB/Supabase change; `.replit` remains unstaged and untouched; the goose tarball remains untracked; `.gitattributes` remains absent; tests/scans/typecheck/planning findings reported honestly; nothing incorrectly marked NOT RUN; independent‑review verdict capture is explicit and honest.

Expected post‑M36 `git status`:

```
 M .replit
?? docs/phase-2.0-backend-control-panel-m36-c07-authorization-entry-server-mount-registration-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

---

## Locked reference values (for M37)

| Item | Value |
|------|-------|
| Route path | `/dev/bcp/data-source-boundary-readiness` |
| Frontend proxy label (reserved, client milestone only) | `/__identity/dev/bcp/data-source-boundary-readiness` |
| Feature flag (default OFF) | `ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS` |
| Guard entry (additive) | `'C-07': 'overview_viewer'` |
| Schema version | `bcp.c07.data-source-boundary-readiness.v1-code-config` |
| Self‑attestation | `design_time_code_config` |
| `generatedAt` | permanently excluded |
| Adapter factory | `createBcpC07DataSourceBoundaryReadinessHandler` |
| Server‑owned provider (imported, not modified) | `getBcpC07DataSourceBoundaryItems` |
| Deferred (M38) | transport matrix extension |
| Deferred (M39+) | client + UI card + screen integration |

---

## Stop conditions for M37 (binding)

1. Any change to `bcpAuthorizationGuard.ts` beyond the single additive `'C-07': 'overview_viewer'` row (any broader guard refactor) → **STOP**. *(A comment‑only refresh of the stale range comment within the same already‑allowed file is permitted and is not a stop condition.)*
2. Any server mount that requires a broader `server.ts` refactor, new middleware, changed global/auth/session behavior, or a new server/listener/socket → **STOP**.
3. Any change outside the five allowed files → **STOP and report a blocker**.
4. Any faking, bypassing, or silent authorization of the C‑07 success path (a `200` not arising from the real additive guard entry) → **STOP**.
5. Any change that makes C‑07 default‑on or production‑enabled, or that weakens/removes the DEV‑only (`NODE_ENV`) gate or the default‑off feature flag → **STOP**.
6. Any DB/SQL/Supabase/Supabase‑MCP/live‑provider/action/mutation introduction → **STOP**.
7. Any raw log/command/transport/response/header/env‑value/diagnostics/stack‑trace/production‑readiness/value‑oracle exposure → **STOP**.
8. Any modification of `bcpTransportMatrix.test.ts` (matrix deferred to M38) → **STOP**.
9. Any client/UI/screen/`src/App.tsx`/SaaS‑nav/package/lockfile/migration/seed/`shared/**`/auth/DB change → **STOP**.
10. Any touch of `.replit`, `.gitattributes`, or the goose tarball → **STOP**.
