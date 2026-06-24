# Phase 2.0 M7M — Backend Control Panel C-01 UI Preview QA and Exposure Review

**Status:** Review/documentation-only · QA + safety/exposure review of the M7L DEV-only C-01 UI preview card (no code change)
**Accepted checkpoint at authoring:** `dad3f95e6b84fff4aba357103112c0626f55fd83` (Phase 2.0 M7L)
**Authoring milestone:** Phase 2.0 M7M

> Redaction-first. No real tenant/store/customer data, raw IDs, emails, domains,
> DB URLs, tokens, secrets, payment identifiers, permission/entitlement key lists,
> mismatch lists, raw auth claims, raw provider UIDs, or raw `identity_link` rows.
> This milestone makes no code/runtime/route/auth/DB/Supabase/UI change; nothing is
> staged, committed, pushed, or backed up.

---

## 1. Executive Summary

QA result: **the M7L DEV-only C-01 UI preview card is accepted-safe**, with one non-blocking follow-up to plan. Static review, exposure scans, the full unit-test suite (89/89), and a typecheck all confirm the card renders **only** inside the DEV-gated Backend Control Panel, is **not** in normal SaaS navigation or any customer-facing/production route, is **read-only and button-triggered** (no auto-fetch), uses a **GET-only** client with **no body / no credentials / no Authorization / no identity fields**, renders **only safe posture labels** (redacting unsafe/id-shaped/forbidden values even from a malicious payload), and makes **no** backend/route/DB/Supabase/mutation change. No blocker found. **Decision B — PASS WITH FOLLOW-UP**: the one non-blocking item is that the live code/config content still ships under the harness's `…v0-synthetic` schemaVersion + `synthetic` warning (a DTO/schema-version decision), and component **rendering** relies on manual QA (the repo has no React/DOM test framework; the data boundary itself is fully unit-tested).

> Preflight note: this milestone's preflight initially failed because an external Replit-Agent auto-checkpoint commit (`af8833d`) had committed a forbidden `.gitattributes`, the goose tarball, and a `.replit` change on top of `dad3f95`. With owner authorization the local-only commit was reset away (never pushed; `origin/main` was always clean at `dad3f95`), `.gitattributes` was removed, and preflight was re-confirmed before this review began.

## 2. Current State and Boundary

- **M7L UI:** a "C-01 Live Preview" tab inside the DEV Backend CP **Readiness Gate** screen (`BackendCpReadinessGate`), rendering `C01ReadinessCard`. Card is DEV-only, read-only, button-triggered.
- **Client:** `bcpC01Client.ts` calls the same-origin dev proxy `/__identity/dev/bcp/readiness-summary` (proxied to the isolated platform-identity API on `:5002`; no CORS/backend change), GET only.
- **Backend route (unchanged):** `GET /dev/bcp/readiness-summary` on the isolated platform API; default-off (`ENABLE_BCP_DEV_READONLY_PILOT`); production-disabled; DEV-only; GET-only for success; code/config posture source only; no live C-01 DB/source integration; no C-02; no backend actions; no mutation path.
- Global constraints unchanged: Firebase/legacy AccessContext remains current frontend/app authority; Supabase dormant/readiness-only, not ready for cutover; controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. QA Decision

**Decision B — PASS WITH FOLLOW-UP: ACCEPTED-SAFE BUT NEEDS A LATER DTO / SCHEMA-VERSION DECISION.** All QA checks pass and no exposure/data/auth/mutation/route risk was found, so the card is accepted-safe to keep and to show in DEV. The single non-blocking follow-up: the live code/config content is served under the harness's `bcp.c01.readiness.v0-synthetic` schemaVersion and a `synthetic` warning (the DTO shape is unchanged from M7C/M7E), which is mildly inaccurate now that the source is code/config posture. The card surfaces the true source mode in-band (`synthetic_live_boundary_posture: code_config_only`), so this is cosmetic/honesty-of-labeling, not a safety issue — best resolved by a dedicated DTO/schema-version decision milestone. Decision A would also be defensible (no blocker), but B is the more honest record given this planned follow-up.

## 4. UI Location Review

| Check | Result |
|---|---|
| Card component | `src/backend-control-plane/C01ReadinessCard.tsx` |
| Mounted in | `BackendCpReadinessGate` screen (`screens.tsx`), new "C-01 Live Preview" section tab |
| Referenced only from | `screens.tsx` (import + one render site) — confirmed by scan |
| DEV Backend CP area only | ✓ (route `/dev/backend-control-plane`) |
| Normal SaaS navigation | ✗ none (0 refs in `src/components`/`src/App.tsx` beyond the DEV shell) |
| Customer-facing screens | ✗ none |
| POS/repairs/customer/invoice/service/store-dashboard exposure | ✗ none |
| Production-facing route | ✗ none |

## 5. DEV Gating Review

- BCP shell is registered in `App.tsx` **only when `BCP_ROUTE_ENABLED`** = `IS_DEV && BCP_FLAG_ON` (`bcpEnv.ts`): Vite **DEV build** AND `VITE_ENABLE_BACKEND_CONTROL_PLANE === 'true'`. Default OFF.
- Route path for the preview area: `/dev/backend-control-plane` (isolated, outside the guarded `/` and `/owner` trees).
- Production build exclusion: `IS_DEV` is `import.meta.env.DEV`, false in production builds, so the lazy-loaded shell (and the card) are excluded from production. ✓
- No public route exposure; the card is reachable only by opening the DEV shell and the Readiness Gate → C-01 tab.

## 6. Frontend Client Review

| Check | Result |
|---|---|
| URL | `/__identity/dev/bcp/readiness-summary` (same-origin dev proxy → `:5002`) |
| Method | **GET only** |
| Request body | **none** (test asserts `'body' in init === false`) |
| Credentials | `credentials: 'omit'` |
| Authorization header | **none** |
| Client identity fields (UID/email/tenant/store) | **none** (no body, no query params) |
| Query params / tenant-store authority | **none** (static URL, no `?`) |
| Hardcoded secrets / DB URLs / production endpoint | **none** (reuses client-safe `VITE_IDENTITY_API_BASE`, default `/__identity`) |
| No-throw | ✓ every transport/shape failure maps to a safe state |

## 7. UI State Handling Review

All states render safely; no stack traces / raw error objects:

| State | Handling |
|---|---|
| idle | Explainer + "Load C-01 Readiness" button (no auto-fetch) ✓ |
| loading | "Loading C-01 readiness posture…" ✓ |
| success | Safe posture rows + source/parity/env/generatedAt + warnings ✓ |
| feature_disabled | Safe note: enable the flag on the DEV identity API ✓ |
| dev_only | Safe note: DEV-only ✓ |
| unauthorized | Safe note: server-derived principal not authorized ✓ |
| parity_blocked | Safe note: parity not ready (fail-closed) ✓ |
| unavailable | Safe note: start `npm run identity:api` ✓ |
| unexpected | Safe note: shape not recognized; nothing rendered (fail-safe) ✓ |
| error | Safe note: safe error, no details exposed ✓ |

## 8. Rendered Data Boundary Review

- Renders **only** safe bounded labels (status/posture/readiness). ✓
- No raw object dumps; no raw error object; no stack traces. ✓
- Reads **only** `category`/`status` from each posture entry (`toSafeReadinessRows`) — every other field is ignored, so an injected `internalUserId`/`tenantId`/etc. can never reach the DOM. ✓
- No raw IDs · no tenant/store/customer rows · no secrets/tokens/DB URLs · no emails/domains · no permission/entitlement key dumps · no mismatch lists · no raw auth claims/provider UIDs · no `identity_link`/audit rows. ✓

## 9. Redaction and Malicious Payload Review

The pure client logic is unit-tested (12/12) against hostile inputs, proving:

- A malicious `status` like `postgres://u:p@host/db` → `'redacted'` (charset reject). ✓
- Charset-valid-but-secret values (`service_role_key`, `Bearer eyJ…`, `iu_…`) → `'redacted'` via the forbidden-substring denylist. ✓
- **Id-shaped** values (UUIDs, ≥6-digit runs) → `'redacted'` via the id-shape guard. ✓
- An injected raw-id field on a category is never read (only `category`/`status`). ✓
- A full malicious envelope never serializes any forbidden token; `generatedAt` is ISO-validated (bad value dropped); warnings are sanitized + redaction-filtered. ✓
- Defense-in-depth note: the server-side fixed principal carries an `iu_`-prefixed placeholder id, which is **server-internal only** — the client reads only `category`/`status` (never the principal), and even if such a value ever reached a label, the `iu_` denylist + id-shape guard would redact it. ✓

## 10. Backend Route Preservation Review

`git diff dad3f95 -- server` is **empty** — `server/**` is unchanged. Confirmed:

- route path `GET /dev/bcp/readiness-summary` unchanged ✓
- route registration (`app.all` in `server/platform-identity/server.ts`) unchanged ✓
- default-off unchanged ✓ · production-disabled unchanged ✓ · DEV-only unchanged ✓ · GET-only-for-success unchanged ✓
- code/config-only source unchanged ✓ · no backend action/mutation ✓

## 11. No-Mutation / No-Action UI Review

- No execute/provision/restart/delete/approve controls — the only interactive control is the read-only "Load C-01 Readiness" button. ✓
- No write request; client method is GET only; no POST/PUT/PATCH/DELETE anywhere. ✓
- No backend action invocation. ✓
- (Static-scan note: the words "disabled" in the file are state names like `feature_disabled` and the button's `disabled={loading}` attribute — not mutation controls.)

## 12. Production and Navigation Exposure Review

- No normal SaaS navigation link · no customer-facing app link · no production route · no public API docs. ✓
- No `App.tsx`/`main.tsx` change (`git diff dad3f95` empty) beyond the pre-existing DEV-gated BCP shell registration. ✓
- No server-side production exposure (route remains production-disabled + isolated API). ✓

## 13. Test Review

- `npx tsx src/backend-control-plane/bcpC01Client.test.ts` → **12/12** (`ALL_TESTS_PASSED`).
- `npx tsx server/bcp-pilot/bcpPilot.test.ts` → **28/28**.
- `npx tsx server/bcp-pilot/bcpReadOnlyRoute.test.ts` → **26/26**.
- `npx tsx server/bcp-pilot/bcpReadOnlyExpressAdapter.test.ts` → **9/9**.
- `npx tsx server/bcp-pilot/bcpC01CodeConfigReadModel.test.ts` → **14/14**.
- **Backend total: 77/77. Grand total: 89/89.** ✓

## 14. Typecheck Review

- `npx tsc --noEmit` → **12 total errors = pre-existing baseline** (unrelated UI files: `TemplateEditor.tsx`, `OwnerLayout.tsx`, `TenantLayout.tsx`, `BillingPage.tsx`, etc.).
- **0 errors in M7L touched files** (`bcpC01Client.ts`, `C01ReadinessCard.tsx`, `backend-control-plane/screens.tsx`). ✓
- The `react`/`react/jsx-runtime` notes are the project-wide no-`@types/react` pattern (present in every `.tsx`), not counted in the baseline.

## 15. Static Scan Review

| Scan | Result |
|---|---|
| `C01ReadinessCard` references | only `screens.tsx` (import + render) |
| `bcpC01Client` references | only the card + its test |
| `fetch` in `src/backend-control-plane` | only `bcpC01Client.ts`, **GET only** |
| Mutation methods in client | none (POST/PUT/PATCH/DELETE absent; `body:` hits are param names) |
| `src/App.tsx` / `src/main.tsx` changes since `dad3f95` | **none** |
| `server/**` changes since `dad3f95` | **none** |
| Normal SaaS-nav / customer-facing refs to the preview | **none** |
| DB/Supabase/provider imports in new files | **none** |
| Secrets / token / DB-URL patterns | **CLEAN** |
| `identity_link` / audit references in new files | **none** |
| Mutation/action labels in card | none (read/load only) |

## 16. Manual Preview Checklist

For an owner/dev preview (no DB connection required):

1. Ensure a DEV environment (`vite dev`).
2. Run the app preview.
3. (Optional, for the success path) run the isolated identity API: `npm run identity:api`.
4. (Optional, for the success path) set `ENABLE_BCP_DEV_READONLY_PILOT=true` on the identity API.
5. Set `VITE_ENABLE_BACKEND_CONTROL_PLANE=true` and open `/dev/backend-control-plane`.
6. Go to the **Backend CP Readiness Gate** module.
7. Open the **C-01 Live Preview** tab.
8. Verify the **idle** state (explainer + Load button; nothing fetched yet).
9. Click **Load C-01 Readiness**.
10. With the identity API **not** running → verify the safe **unavailable** state ("start `npm run identity:api`").
11. With the flag **off** → verify the safe **feature-disabled** state.
12. With the identity API running **and** the flag `true` → verify the **success** state (posture labels).
13. Verify **no raw data** is visible (only labels like `feature_flag_posture: enabled`).
14. Verify **no tenant/customer data** is visible.
15. Verify **no destructive controls** exist (only the Load button).

## 17. Risk Register

| ID | Risk | Severity | Mitigation | Blocks next milestone? |
|---|---|---|---|---|
| R-1 | UI accidentally exposed outside DEV | High | `BCP_ROUTE_ENABLED` = Vite DEV + flag; production builds exclude the shell | No |
| R-2 | Frontend fetch becomes customer-facing | Medium | Card referenced only from the DEV shell; 0 SaaS-nav/customer refs (scanned) | No |
| R-3 | Production build accidentally includes shell | Medium | `IS_DEV` (`import.meta.env.DEV`) false in prod; lazy import gated | No |
| R-4 | Unsafe payload rendering | High | `safeLabel` charset + denylist + id-shape guard; reads only category/status; tested vs malicious payloads | No |
| R-5 | Raw error rendering | Medium | Fixed safe `STATE_NOTE` per kind; no raw error/stack rendered | No |
| R-6 | Endpoint-unavailable confusion | Low | Explicit safe "unavailable / start identity API" state | No |
| R-7 | Dev-proxy dependency | Low | Reuses accepted `/__identity` proxy; failure → safe unavailable state | No |
| R-8 | Future C-02 expansion risk | Medium | C-02 remains out of scope; separate planning gate required | No |
| R-9 | Future real-principal / auth wiring risk | Medium | No live session resolver; fixed server-side synthetic principal; later gated milestone | No |
| R-10 | Future backend-action UI risk | High | No action controls now; controlled actions remain Phase 3 | No |
| R-11 | DTO/schemaVersion mismatch (live content under `v0-synthetic`) | Low | Source mode shown in-band (`code_config_only`); plan a DTO/schema-version decision (the Decision-B follow-up) | No |
| R-12 | Reliance on manual rendering QA | Low | Data boundary fully unit-tested in the pure client; component renders only sanitized values; no React/DOM test runner in repo | No |

No risk blocks the next milestone.

## 18. Stop Conditions

This QA would flag a blocker (Decision C) if any were found: the preview in normal SaaS navigation or a customer-facing route; the client sending credentials/auth/identity fields or a request body; a mutation method; an unexpected backend route modification; production exposure; DB/Supabase/provider access added; raw IDs/secrets/tokens/DB URLs/emails/domains rendering; tenant/store/customer rows rendering; backend actions/destructive controls; or any live session auth / Supabase auth / cutover implication. **None were found.**

## 19. Acceptance Criteria

M7M is acceptable when: the single QA doc exists under `docs/` and is redaction-safe; it records an honest QA decision (A/B/C) with evidence; it reports the UI-location, DEV-gating, client, state-handling, data-boundary, redaction/malicious-payload, backend-route-preservation, no-mutation, exposure, test, typecheck, and static-scan reviews plus a manual checklist, risk register, and stop conditions; it preserves all M1–M7L assumptions; it claims no C-02 integration, no live session/Supabase auth, no production/cutover readiness; and no code/runtime/route/auth/DB/Supabase/UI change was made (nothing staged/committed/pushed/backed up).

## 20. Recommended Next Milestone

**Phase 2.0 M7N — C-01 DTO / Schema Version Decision** (the Decision-B follow-up): decide whether the live code/config C-01 read model should adopt an explicit non-`synthetic` schemaVersion + warning vocabulary (and how to evolve the DTO additively), now that the route serves code/config posture rather than a synthetic stub. This is a planning/decision step, not implementation. *(Alternatives at the owner's discretion: a Manual Dev Verification Package, or a C-02 Planning Gate — but the DTO/schema-version honesty item is the most concrete follow-up surfaced by this QA.)*
