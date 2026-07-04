# Phase 2.0 — Backend Control Panel — M40: C‑07 Client / UI Planning Gate

**Status:** DOCS‑ONLY planning gate. No source, test, transport‑matrix, guard, server‑mount, provider, read‑model, route, adapter, registration, client, UI, screen, package, or runtime change is made by M40.
**Milestone:** Phase 2.0 M40.
**Pre‑change accepted checkpoint:** `94080497dd56553246156f318bbd63606a5dac8f` (subject: *Phase 2.0 M39 add backend control panel C07 transport matrix*).
**Purpose:** Decide the safest next milestone after C‑07 backend/matrix completion, and lock the smallest safe client/UI plan **without implementing any client or UI code in M40**.

> This gate implements nothing. It reads the M33–M39 C‑07 decisions, the frozen C‑01..C‑06 client/sanitizer/UI‑card patterns, the `screens.tsx` registration gating, and the current git/test/typecheck state, then locks the smallest safe next plan. No client, sanitizer, UI card, or screen registration is added in M40.

---

## Section A — Preflight Result

All preflight conditions **PASS**. This is the pre‑change backup checkpoint; no extra backup is created.

| # | Condition | Result |
|---|-----------|--------|
| 1 | Branch is `main` | PASS |
| 2 | Local `HEAD` == `origin/main` == `94080497dd56553246156f318bbd63606a5dac8f` | PASS |
| 3 | ahead/behind is `0/0` | PASS |
| 4 | `git status` shows only ` M .replit` and `?? goose-x86_64-unknown-linux-gnu.tar.bz2` | PASS |
| 5 | Nothing staged | PASS |
| 6 | `.gitattributes` absent | PASS |
| 7 | M39 commit present (`9408049 Phase 2.0 M39 add backend control panel C07 transport matrix`) | PASS |
| 8 | Since `HEAD == origin/main`, this is the pre‑change backup checkpoint | PASS — no extra backup |
| 9 | No source/test/backend/frontend/client/UI/screen/package/migration/DB/Supabase/auth/runtime change occurs in M40 | PASS (docs‑only) |
| 10 | No commit, push, or backup occurs in M40 | PASS |

---

## Section B — M39 Backup and Backend / Matrix Baseline Review

The M39 transport‑matrix baseline is safely committed and backed up.

| # | Confirmation | Result |
|---|--------------|--------|
| 1 | M39 commit hash | `94080497dd56553246156f318bbd63606a5dac8f` |
| 2 | M39 commit subject | `Phase 2.0 M39 add backend control panel C07 transport matrix` |
| 3 | `origin/main` matches local `HEAD` | PASS |
| 4 | Push was fast‑forward and non‑force | PASS (`21e10d2..9408049`) |
| 5 | Exactly one M39 file committed | PASS (`server/bcp-pilot/bcpTransportMatrix.test.ts`) |
| 6 | No docs file committed at M39 | PASS |
| 7 | No source/runtime file committed | PASS |
| 8 | No guard or `server/platform-identity/server.ts` committed | PASS |
| 9 | No provider/read‑model/route/adapter/registration file committed | PASS |
| 10 | No client/UI/screen file committed | PASS |
| 11 | No package/lockfile change | PASS |
| 12 | No DB/Supabase/live provider access | PASS |
| 13 | Transport matrix | 124/124 |
| 14 | Matrix delta | +18 exactly |
| 15 | Full BCP corpus | 1282/1282 |
| 16 | Typecheck | 12 baseline; 0 BCP‑surface errors |
| 17 | Static scan | clean |
| 18 | C‑07 included in matrix evidence | PASS |
| 19 | Client/UI remains deferred | PASS |
| 20 | M39 residuals accepted | PASS |

---

## Section C — C‑07 Readiness for Client / UI

C‑07 is **ready** for frontend client planning. Every readiness condition holds and was reverified at M40.

| # | Readiness check | Result |
|---|-----------------|--------|
| 1 | C‑07 provider/read‑model implemented and green | PASS (provider 43/43, read‑model 41/41) |
| 2 | C‑07 route/adapter implemented and green | PASS (route 39/39, adapter 26/26) |
| 3 | C‑07 guard entry implemented and green | PASS (`'C-07':'overview_viewer'`) |
| 4 | C‑07 server mount implemented and green | PASS (`/dev/bcp/data-source-boundary-readiness`) |
| 5 | C‑07 registration test green | PASS (18/18) |
| 6 | C‑07 transport matrix coverage green | PASS (124/124) |
| 7 | C‑07 authorized `200` path live and guard‑gated | PASS |
| 8 | Remains DEV‑only, default‑off, production‑disabled, read‑only | PASS |
| 9 | Exposes safe C‑07 envelope only | PASS |
| 10 | `generatedAt` remains **excluded** | PASS (permanently excluded) |
| 11 | `selfAttestation` remains `design_time_code_config` | PASS |
| 12 | No DB/SQL/Supabase/live‑provider/raw‑evidence/diagnostics/value‑oracle/prod‑readiness claim | PASS |
| 13 | Client can be planned using same‑origin Backend CP proxy pattern only | PASS (`/__identity` dev proxy) |
| 14 | UI can be planned without normal SaaS navigation or customer‑facing exposure | PASS (Backend CP internal only) |
| 15 | Browser evidence still waived in Phase 2.0 unless explicitly reopened | PASS |

C‑07 is ready. No readiness blocker exists.

---

## Section D — Client / UI Implementation Options

| Option | Description | Risk | Verdict |
|--------|-------------|------|---------|
| **A** | M41: C‑07 frontend **client + sanitizer tests only** (`bcpC07Client.ts` + `bcpC07Client.test.ts`) | Low | **SELECTED** |
| B | M41: client + sanitizer + **UI card** (`C07DataSourceBoundaryReadinessCard.tsx`), not registered in `screens.tsx` | Medium | Rejected as next step — larger frontend surface before the client sanitizer boundary is independently accepted |
| C | M41: client + card + **screen registration** (`screens.tsx`) | Medium‑high | Rejected — touches the gated `screens.tsx` surface; premature |
| D | Residual‑hardening planning gate before client/UI | Low (docs‑only) | Rejected as next step — residuals are documented and non‑blocking (Section I); may be scheduled later |
| E | Another docs‑only client/UI planning pass | Low | Rejected — the client/sanitizer contract is exact against the frozen C‑01..C‑06 pattern (Sections E–F) |

**Rationale for A.** The frozen C‑01..C‑06 clients establish a proven same‑origin, GET‑only, no‑credentials, no‑throw, allow‑list‑sanitized boundary with a discriminated safe view model. C‑07 slots into that pattern exactly (Section E), changing only the URL suffix, the schema/self‑attestation validated, and the per‑item allow‑list (derived from the frozen C‑07 read‑model). Implementing the client + sanitizer **first**, with no UI card and no `screens.tsx` change, establishes the redaction boundary and its hostile‑payload test coverage before any rendering surface exists — the smallest safe step, no browser tooling, no package change.

---

## Section E — Client Boundary Contract Lock

If Option A is selected (it is), the M41 C‑07 client boundary is locked as follows, mirroring the frozen C‑06 client (`src/backend-control-plane/bcpC06Client.ts`).

**Future client file:** `src/backend-control-plane/bcpC07Client.ts`
**Future client test file:** `src/backend-control-plane/bcpC07Client.test.ts`

**Same‑origin proxy base and URL:**
- Base: `(import.meta.env.VITE_IDENTITY_API_BASE || '/__identity')` with trailing slashes stripped — identical to C‑06.
- C‑07 URL: `${BASE}/dev/bcp/data-source-boundary-readiness`.
- Default full path: **`/__identity/dev/bcp/data-source-boundary-readiness`** (matches the frozen adapter’s `BCP_C07_DATA_SOURCE_BOUNDARY_PROXY_PATH`).

**Locked client requirements:**

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | same‑origin only (relative URL from the `/__identity` proxy base) | ✔ |
| 2 | relative URL only; **no** absolute URL | ✔ |
| 3 | **no** production endpoint | ✔ |
| 4 | GET only | ✔ |
| 5 | `credentials: 'omit'` | ✔ |
| 6 | **no** `Authorization` header (only `accept: application/json`) | ✔ |
| 7 | **no** cookies intentionally sent by fetch config | ✔ (`credentials: 'omit'`) |
| 8 | **no** request body | ✔ |
| 9 | **no** query authority / query params | ✔ |
| 10 | **no** client‑supplied tenant/store/customer/user identity | ✔ |
| 11 | **no** role/capability authority from client | ✔ |
| 12 | **no** mutation/action method | ✔ |
| 13 | **no** retry storm; single request per invocation | ✔ |
| 14 | **no** background polling (button‑triggered load only, per Section G) | ✔ |
| 15 | safe timeout/abort via `AbortController` (default 4000 ms) — reuses the existing C‑06 pattern, no package change | ✔ |
| 16 | **no** package/lockfile change | ✔ |
| 17 | **no** browser tooling | ✔ |
| 18 | **no** `localStorage`/`sessionStorage` authority | ✔ |
| 19 | **no** `window`/env value exposure | ✔ |
| 20 | **no** raw errors/stack traces/diagnostics/raw response dumps to the caller | ✔ (no‑throw → safe discriminated states) |

**Locked discriminated result (mirrors `C06Result`), adapted for C‑07:** `success` (with `schemaVersion`, `selfAttestation`, bounded `summaryCounts`, bounded `items`, `emptyState`, bounded `warnings`, and the C‑07 posture labels) plus the safe non‑success kinds `feature_disabled | dev_only | unauthorized | parity_blocked | method_not_allowed | error | unavailable | unexpected`. **`generatedAt` is NOT surfaced** by the C‑07 client (permanently excluded for C‑07). The `classifyC07Response(status, body)` mapping mirrors C‑06: `200` + valid `schemaVersion` → `success`; `404 feature_disabled|dev_only|(other→unavailable)`; `403→unauthorized`; `409→parity_blocked`; `405→method_not_allowed`; `>=500→error` (a `>=500` response with an unparseable body normalizes to `unavailable` in the no‑throw wrapper before classification — both are safe render‑ready states); `0→unavailable`; else `unexpected`.

---

## Section F — Client Sanitizer Contract Lock

The M41 C‑07 sanitizer is locked to the frozen C‑06 defense‑in‑depth model (`safeLabel` / `safeCategory` / `safeCount` + closed allow‑lists), adapted to the C‑07 schema. **No `safeTimestamp` helper is included** — C‑07 permanently excludes all timestamps (see #7), so the client neither validates nor surfaces any timestamp field (unlike the frozen C‑06 client, which optionally maps `generatedAt`).

| # | Requirement | Locked |
|---|-------------|--------|
| 1 | accepts unknown JSON (reads only known fields) | ✔ |
| 2 | validates schema `bcp.c07.data-source-boundary-readiness.v1-code-config` | ✔ |
| 3 | validates `selfAttestation` = `design_time_code_config` | ✔ |
| 4 | wrong schema ⇒ safe fallback (`unexpected`) | ✔ |
| 5 | malformed payload ⇒ safe fallback | ✔ |
| 6 | non‑object payload ⇒ safe fallback | ✔ |
| 7 | `generatedAt` must remain **absent** (never surfaced) | ✔ |
| 8 | raw‑evidence fields must not pass | ✔ (allow‑list + forbidden‑substring denylist) |
| 9 | diagnostics fields must not pass | ✔ |
| 10 | stack‑trace fields must not pass | ✔ |
| 11 | env‑value fields must not pass | ✔ |
| 12 | SQL/DB/Supabase/live‑provider fields must not pass | ✔ (denylist incl. `supabase`, `postgres`, `mysql`, `mongodb`) |
| 13 | package/file‑path inventory fields must not pass | ✔ (`PATH_RE`, `DOMAIN_RE`) |
| 14 | production‑readiness claims must not pass | ✔ (`READINESS_CLAIM_RE`, incl. ship‑class phrases) |
| 15 | value‑oracle fields must not pass | ✔ (labels/enums only; no verifier/oracle output) |
| 16 | unknown fields dropped; only known safe labels preserved | ✔ (`toSafeItem` reads only known fields) |
| 17 | strings bounded (`SAFE_LABEL_RE`, ≤64 chars) | ✔ |
| 18 | arrays bounded (item cap, e.g. `.slice(0, N)`) | ✔ |
| 19 | warning lists bounded | ✔ |
| 20 | item lists bounded | ✔ |
| 21 | summary counts finite/bounded/safe (`safeCount`, 0..100000) | ✔ |
| 22 | client output uses a safe closed view model | ✔ (discriminated `C07Result`) |
| 23 | disabled/error/empty states normalize safely | ✔ |
| 24 | fetch/network errors normalize safely | ✔ (no‑throw) |
| 25 | sanitizer tests include hostile payloads with synthetic forbidden markers | ✔ (see Section K) |

**Per‑field allow‑list source (binding).** The exact C‑07 item field names and the closed category/label allow‑lists must be **derived at M41 from the frozen C‑07 read‑model** (`bcpC07DataSourceBoundaryReadModel.ts`) — the client allow‑list is intentionally independent from and no wider than the server’s closed vocabulary. M41 must not invent fields the read‑model does not emit.

**Closed allow‑list is the PRIMARY gate on posture enums (binding).** For the C‑07 posture‑enum values, the **closed allow‑list — not the generic forbidden‑substring denylist — must be the primary gate.** A legitimate read‑model value such as `no_customer_exposure` contains the denylist substring `customer_`; if the substring denylist were applied as the primary gate it would over‑redact a valid value (fail‑safe — it drops to `redacted`, never a leak — but wrong). This mirrors exactly how the frozen C‑06 client resolves the identical `customer_` / `no_customer_facing_exposure` collision via its `SAFE_EVIDENCE_LABELS` allow‑list rather than the denylist. The substring denylist remains a defense‑in‑depth secondary check on free‑text label fields, not the gate on closed enums.

---

## Section G — UI Card Contract Lock (deferred; documented only)

The UI card is **deferred**. Its future contract is locked here without implementation, mirroring the frozen C‑06 card (`C06QualityGatesEvidenceReadinessCard.tsx`).

**Future UI card candidate:** `src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`

| # | Future requirement | Locked |
|---|--------------------|--------|
| 1 | read‑only card | ✔ |
| 2 | Backend CP internal only | ✔ |
| 3–5 | no mutation controls / action buttons / approval/override controls | ✔ |
| 6 | no raw JSON display (no `JSON.stringify` in JSX) | ✔ |
| 7–12 | no raw error / diagnostics / command output / DB‑Supabase‑live‑provider detail / env‑token‑secret‑credential / package‑file‑path display | ✔ |
| 13 | no production‑readiness claim | ✔ |
| 14 | must display the self‑attestation disclaimer clearly | ✔ |
| 15 | must state declared `code_config` posture, **not** live verification | ✔ |
| 16–18 | safe summary counts / safe boundary labels / safe warnings only | ✔ |
| 19 | safe loading/disabled/error/empty states | ✔ |
| 20 | no client‑supplied authority | ✔ |
| 21 | no normal SaaS navigation exposure | ✔ |
| 22 | **not** registered in `screens.tsx` unless separately authorized | ✔ |
| — | button‑triggered load only (no auto‑fetch, no `useEffect` fetch); no `dangerouslySetInnerHTML` | ✔ (frozen C‑06 card behavior) |

---

## Section H — Screen Registration Decision

**Decision: do NOT register the C‑07 UI in `screens.tsx` in the next milestone.**

`screens.tsx` remains a gated surface. In the frozen pattern, C‑01..C‑06 cards are directly imported at the top of `screens.tsx` and rendered in the readiness section; adding C‑07 there would modify that gated surface. Screen registration should be considered only after: (1) the C‑07 client sanitizer is implemented and accepted; (2) the C‑07 UI card is implemented and accepted; (3) screen registration is separately planned; (4) browser‑evidence posture is reopened or explicitly deferred with owner approval; and (5) no raw exposure or unsafe UI state exists.

---

## Section I — Residual Hardening Decision

Accepted residuals were reviewed for client/UI exposure risk:

| Residual | Client/UI exposure risk? | Decision |
|----------|--------------------------|----------|
| Stale M35‑era C‑07 route/adapter comments | None (comments only; behavior correct) | Non‑blocking; defer |
| Pre‑existing guard‑hardening edge | None (guard is server‑side; client sends no authority) | Non‑blocking; defer |
| DEV‑gate exact‑`development` tightening | None (gate is server‑side; client is DEV‑shell‑gated) | Non‑blocking; defer |
| Real‑socket live transport deferred | None (client uses same‑origin mocked‑fetch evidence) | Deferred by design |
| Browser evidence waived | None in Phase 2.0 | Waived Phase 2.0 only |
| 12 unrelated typecheck baseline errors | None (outside Backend CP scope) | Do not fix |

**Decision: proceed with client‑only planning (Option A).** No residual creates a client/UI exposure risk; all are documented and non‑blocking. Residual hardening (guard/DEV‑gate/frozen‑comment cleanup) may be scheduled as a separate gate if the owner prioritizes hygiene first, but it is **not** a prerequisite for M41.

---

## Section J — Next Implementation File Package Lock (M41)

**Recommended next milestone:** **Phase 2.0 M41 — C‑07 Frontend Client / Sanitizer Implementation.**

**Allowed files — exactly two:**
1. `src/backend-control-plane/bcpC07Client.ts` (CREATE)
2. `src/backend-control-plane/bcpC07Client.test.ts` (CREATE)

**Prohibited files (M41):** `src/backend-control-plane/C07DataSourceBoundaryReadinessCard.tsx`; `src/backend-control-plane/screens.tsx`; `src/App.tsx`; SaaS navigation; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `server/platform-identity/server.ts`; `server/bcp-pilot/bcpTransportMatrix.test.ts`; `bcpC07RouteRegistration.test.ts`; `bcpC07DataSourceBoundaryReadOnlyRoute.ts` (+test); `bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts` (+test); `bcpC07DataSourceBoundaryProvider.ts` (+test); `bcpC07DataSourceBoundaryReadModel.ts` (+test); `package.json`/`package-lock.json`; migrations; seeds; `shared/**`; auth/audit/identity/session; DB/Supabase; browser tooling; generated artifacts; `.replit`; `.gitattributes`; goose tarball.

---

## Section K — Test Requirements for M41

**Client/sanitizer tests** (`bcpC07Client.test.ts`) must cover, mirroring the frozen 45‑case C‑06 client test:

1. same‑origin relative path only; path exactly `/__identity/dev/bcp/data-source-boundary-readiness`.
2. GET only; `credentials: 'omit'`; `accept: application/json`; **no** `Authorization`; **no** body; **no** query authority; **no** absolute/production URL; **no** `localStorage`/`sessionStorage` authority.
3. safe success normalization; correct schema accepted; wrong/malformed/non‑object payload ⇒ safe fallback.
4. `selfAttestation` = `design_time_code_config` validated; **`generatedAt` dropped/never surfaced**.
5. hostile‑payload redaction: raw‑evidence / diagnostics / stack‑trace / env‑value / SQL‑DB‑Supabase / package‑file‑path / production‑readiness‑claim / value‑oracle markers dropped or redacted.
6. unknown fields dropped; item cap enforced; warning cap enforced; summary counts bounded.
7. disabled / error / empty / network‑failure states safe; no raw error leak; no client authority escalation; no mutation/action request.
8. all status mappings: `404 feature_disabled`, `404 dev_only`, `404 other→unavailable`, `403→unauthorized`, `409→parity_blocked`, `405→method_not_allowed`, `>=500→error`, `0→unavailable`, `200`‑without‑schema→`unexpected`.

**Regression:** C‑07 backend tests remain green; transport matrix remains 124/124; full BCP corpus remains green (expected **1282 + N** where N = the new C‑07 client test count, mirroring the C‑06 client’s 45 — the exact delta is confirmed at M41); typecheck remains 12 baseline / 0 BCP‑surface.

---

## Section L — Static Scan / Typecheck Requirements for M41

**Static scans must confirm M41 introduces none of:** package/lockfile changes; dependency installs; browser tooling; backend runtime changes; server‑startup changes; sockets/listeners/ports; outbound network **outside the single same‑origin client fetch**; absolute/production URL; `Authorization` header; `credentials: include`/`same-origin`; request body; query authority; `localStorage`/`sessionStorage` authority; client‑supplied tenant/store/customer/user authority; DB/Supabase access; SQL; Supabase MCP; live‑provider calls; production/customer‑facing exposure; normal SaaS‑navigation exposure; mutation/action behavior; raw logs/command output/transport output/response dumps/header dumps; stack‑trace/raw‑error/runtime‑diagnostics exposure; package/dependency/version exposure; file‑path inventory exposure; process/PID/port/timing exposure; `process.env` enumeration / environment‑value exposure; value‑oracle behavior; production‑readiness claims; unintended frozen‑source drift.

**Typecheck posture (M41):** 12 unrelated baseline errors unchanged if still visible; **0** errors in `bcpC07Client.ts`/`bcpC07Client.test.ts`; **0** in C‑07 files; **0** in `server/bcp-pilot`; **0** in `src/backend-control-plane`. Do **not** fix unrelated baseline errors.

---

## Section M — Transport / Browser Posture for M41

**Transport.** M41 (client‑only) tests fetch configuration through **mocked fetch** (injectable `fetchImpl`, as in the frozen C‑06 client). It must not claim real‑socket, live‑server, live‑transport‑smoke, browser, or customer‑facing evidence. Unit‑level mocked‑fetch evidence only.

**Browser.** M41 must not add browser tooling and must not require package/lockfile changes. Browser evidence remains **waived for Phase 2.0 only** and must reopen before production readiness, Phase 3, Phase 4, or any customer‑facing release.

---

## Section N — Baseline Reconfirmation (run at M40)

| Evidence | Expected | Observed at M40 |
|----------|----------|-----------------|
| Full BCP corpus | 1282/1282 | 1282/1282 (41/41 files green) |
| Transport matrix | 124/124 | 124/124 |
| C‑07 provider | 43/43 | 43/43 |
| C‑07 read‑model | 41/41 | 41/41 |
| C‑07 route | 39/39 | 39/39 |
| C‑07 adapter | 26/26 | 26/26 |
| C‑07 registration | 18/18 | 18/18 |
| C‑01..C‑06 | unchanged and green | unchanged and green |
| Typecheck | 12 baseline; 0 `server/bcp-pilot`; 0 `src/backend-control-plane`; 0 across C‑01..C‑07 | 12 baseline; 0 BCP‑scoped |
| Static scans | no package/lockfile change; no DB/Supabase/live exposure; no production/customer‑facing exposure; no raw env‑value/value‑oracle/log/diagnostics/package‑detail/command‑output/raw‑evidence/file‑path/production‑claim surface in C‑01..C‑07 lenses; no unauthorized client/UI change | all confirmed |

Nothing is marked NOT RUN. (The per‑lens C‑07 backend counts are the accepted M39 figures, unchanged; the corpus and matrix were re‑run at M40 and match exactly.)

---

## Section O — Independent Review Results

Three independent review passes ran (≥2 required); all findings were documentation‑only and are reconciled into this gate — none required a source/test/runtime change, so none was a blocker.

1. **Security / exposure / client‑boundary planning review** — VERDICT: **APPROVE‑WITH‑NITS.** Verified against the frozen C‑06 client and the C‑07 read‑model that the locked client contract carries no authority/leak/exposure hole and the sanitizer contract is complete and no weaker than the frozen defense‑in‑depth model. Reconciled NITs: (a) the closed allow‑list must be the primary gate on posture enums because the legitimate read‑model value `no_customer_exposure` collides with the `customer_` denylist substring (Section F binding note strengthened accordingly; fail‑safe either way); (b) the `>=500`‑with‑unparseable‑body → `unavailable` refinement (Section E status map annotated).
2. **Planning / client‑sanitizer / UI‑split review** — VERDICT: **APPROVE‑WITH‑NITS.** Confirmed Option A is the smallest safe step, the two‑file package is exact and both files are absent on disk, the prohibited list is complete, and the client/sanitizer contract is faithful to the frozen C‑06 pattern with the correct C‑07 tightenings (schema + `selfAttestation` gate, `generatedAt` exclusion). Reconciled NIT: removed the `safeTimestamp` helper mention (C‑07 excludes timestamps, so it would be dead code — Section F). Non‑change NIT: the route/adapter per‑lens counts (39/39, 26/26) are the carried‑forward M39 figures, already disclosed as such in Section N.
3. **Cross‑model governance / safety review** — VERDICT: **APPROVE** (no findings).

After reconciliation, no residual finding requires any change outside this documentation gate.

---

## Section P — M40 Decision

**Decision A — C‑07 CLIENT BOUNDARY PLAN LOCKED; PROCEED TO CLIENT / SANITIZER IMPLEMENTATION.**

Justification: the M39 baseline is safe and backed up; C‑07 backend/matrix evidence is complete enough for client planning (Section C); the next implementation is limited to the two client files (Section J); the UI card can remain deferred (Section G); screen registration can remain deferred (Section H); browser evidence can remain waived (Section M); and residual hardening is documented and non‑blocking (Section I).

---

## Section Q — Next Governed Step Selection

**Candidate 1 — Phase 2.0 M41 — C‑07 Frontend Client / Sanitizer Implementation.** SELECTED (Decision A). Creates only `bcpC07Client.ts` + `bcpC07Client.test.ts`.

Candidates 2 (client + UI card), 3 (residual‑hardening planning gate), and 4 (another docs‑only pass) are not selected.

---

## Section R — Non‑Readiness Statements

Phase 2.0 remains: **not** production readiness; **not** customer‑facing release; **not** Phase 3 controlled actions; **not** Phase 4 production readiness; **not** live DB/Supabase reads; **not** live‑provider reads; **not** Supabase auth enablement; **not** Firebase‑to‑Supabase cutover; **not** browser‑evidence completion for production/customer‑facing release.

Firebase remains authoritative. Supabase remains dormant/shadow/readiness‑only. Backend CP remains DEV‑only and read‑only in Phase 2.0. C‑07 client/UI is **not** implemented during M40.

---

## Stop conditions for M41 (binding)

1. Any change to a file other than `src/backend-control-plane/bcpC07Client.ts` and `src/backend-control-plane/bcpC07Client.test.ts` → **STOP and report a blocker**.
2. Any UI card, `screens.tsx`, `src/App.tsx`, or SaaS‑navigation change → **STOP**.
3. Any backend/source/runtime/guard/server/route/adapter/provider/read‑model/registration/transport‑matrix change → **STOP** (the client must consume the frozen backend as‑is).
4. Any package.json/package‑lock.json change, dependency install, or browser tooling → **STOP**.
5. Any absolute/production URL, `Authorization` header, `credentials` other than `omit`, request body, or query authority in the client → **STOP**.
6. Any `localStorage`/`sessionStorage`/`window`/env‑value authority or exposure → **STOP**.
7. Any client‑supplied tenant/store/customer/user/role authority → **STOP**.
8. Any surfacing of `generatedAt`, raw evidence, diagnostics, stack traces, raw errors, DB/SQL/Supabase/live‑provider detail, package/file‑path inventory, value‑oracle output, or production‑readiness claim → **STOP**.
9. Any real‑socket / live‑server / live‑network / child‑process test, or any claim of real‑socket/live/browser/customer‑facing evidence → **STOP**.
10. Any client field not emitted by the frozen C‑07 read‑model (inventing a field) → **STOP and reconcile** against the read‑model.
11. Any matrix/corpus regression, any new BCP‑scoped typecheck error, or any prohibited static‑scan finding → **STOP and reconcile** before claiming acceptance.
12. Any touch of `.replit`, `.gitattributes`, or the goose tarball → **STOP**.
