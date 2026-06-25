# Phase 2.0 M7R — C-01 Client `sourceMode` QA and Exposure Review

**Status:** Review / documentation only. No code, tests, UI, route, or backend behavior was changed by this milestone. This document records a QA, compatibility, safety, and exposure review of the already-accepted Phase 2.0 M7Q client `sourceMode` hardening.

**Accepted checkpoint reviewed:** `73edd990782a12591e2ef5d27a796e1a673a1c82`
**Milestone under review:** Phase 2.0 M7Q — harden backend control panel C01 `sourceMode` client.

---

## 1. Executive Summary

The M7Q optional, DEV-only C-01 client `sourceMode` hardening is **accepted-safe**. The client now reads an additive top-level `sourceMode` when present, prefers it over the in-band category when it is a safe bounded label, falls back to the existing in-band `synthetic_live_boundary_posture` category when the key is absent, and neutralizes any present-but-unsafe / empty / whitespace-only / malformed / hostile value to the literal `redacted_label` without falling through to the category. The added `safeLabel` whitespace-only guard closes a charset-valid `'  '` gap and introduces no regression. Fetch behavior is unchanged (GET-only, bodyless, `credentials: 'omit'`, no `Authorization`, no identity fields, same dev-proxy path, no auto-fetch). The preview card, Backend CP screens, App routing, `main.tsx`, all of `server/**`, and `server/platform-identity/server.ts` are unchanged. No DB / SQL / Supabase / Supabase MCP / live-provider access, no production / navigation / customer-facing exposure, and no backend action or mutation capability were introduced. All **106/106** tests pass; typecheck holds at the **12-error pre-existing baseline** with **0 errors in M7Q touched files**.

This review records one **non-blocking** follow-up: before any C-02 expansion, a consolidated C-01 readiness QA package is preferred. Accordingly the QA decision is **Decision B — PASS WITH FOLLOW-UP**.

## 2. Current State and Boundary

M7Q changed exactly two files:

- `src/backend-control-plane/bcpC01Client.ts` — added `deriveSourceMode()`; wired it into `classifyC01Response`; added an empty/whitespace-only guard to `safeLabel`.
- `src/backend-control-plane/bcpC01Client.test.ts` — added eight `sourceMode` test cases.

Safety boundaries (unchanged by M7Q, re-confirmed here):

- The client is **DEV-only**, reached through the same-origin dev Vite proxy (`/__identity` → isolated platform-identity API on :5002), and is imported only by the DEV-gated Backend Control Plane shell.
- It is **read-only**: the only network effect is a single `GET` triggered by an explicit button click.
- It renders **only safe bounded posture labels**. Every payload-derived label flows through `safeLabel` (charset allow-list + forbidden-substring denylist + id-shape guard + empty/whitespace guard).
- The two authority planes are unchanged: Firebase / legacy AccessContext remains the current frontend authority; the server-derived principal remains future BCP authz; Supabase remains dormant / readiness-only with no cutover. Controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. QA Decision

**Decision B — PASS WITH FOLLOW-UP: ACCEPTED-SAFE BUT NEEDS FUTURE QA PACKAGE OR C-02 PLANNING.**

No compatibility, exposure, fetch, data, auth, backend, DB, Supabase, production, or mutation risk was found. The M7Q hardening is safe to remain part of the DEV-only C-01 preview. The single non-blocking follow-up is to assemble a consolidated C-01 readiness QA package before broadening scope to C-02.

## 4. Client `sourceMode` Review

Confirmed against `bcpC01Client.ts`:

- **Top-level `sourceMode` is read when present.** `deriveSourceMode(b, categoryFallback)` checks `'sourceMode' in b` and that it is not `undefined`.
- **Top-level takes precedence over fallback when safe.** When the key is present and safe, `safeLabel(b.sourceMode)` returns the value verbatim and it is used instead of the category.
- **`sourceMode` is bounded by `safeLabel`.** Every present value passes through `safeLabel` before being surfaced; there is no path from `b.sourceMode` to the rendered field that skips it.
- **Present-but-unsafe does not fall through to fallback.** The unsafe branch returns the literal `redacted_label` and never reads the category — a hostile value cannot re-route to the in-band path.
- **`redacted_label` is used safely.** It is a hardcoded constant carrying no payload; it mirrors the M7O backend sanitization convention.
- **`code_config` is accepted** as a safe bounded label (charset-valid, not id-shaped, no forbidden substring).
- **`code_config_only` fallback remains supported** as the in-band `synthetic_live_boundary_posture` status when the top-level key is absent.
- **`synthetic` remains supported** where applicable (v0 synthetic warning/label path is unchanged).

## 5. v1 DTO Compatibility Review

- v1 response with top-level `sourceMode: code_config` is accepted and surfaced as `code_config`.
- v1 response with the in-band `code_config_only` category remains accepted; the category row is still rendered.
- `schemaVersion: bcp.c01.readiness.v1-code-config` remains safe: classification keys off `typeof schemaVersion === 'string' && 'data' in b`, so the v1 string is recognized without special-casing.
- `sourceMode` is surfaced as a safe normalized label only.
- v1 rendering exposes no raw payload — only `category`/`status`/derived labels are read.

## 6. v0 DTO Backward Compatibility Review

- v0 response with no `sourceMode` key remains accepted; `deriveSourceMode` returns the category fallback, identical to pre-M7Q behavior.
- v0 fallback behavior is stable (`code_config_only` / category status preserved).
- v0 synthetic behavior remains safe (`v0-synthetic` schema, `synthetic` warning, synthetic freshness label all unchanged).
- The original v0 success-shape test continues to pass unchanged, alongside an added explicit v0 test.

## 7. Unknown / Malformed Value Review

Confirmed safe handling (each maps to a safe label, never a raw value, never a fall-through):

- **Unknown `schemaVersion`** — still classifies success when the envelope shape is present; a safe top-level `sourceMode` is still read.
- **Missing `sourceMode`** — category fallback.
- **Empty `''`** — rejected (trim-empty guard and length bound) → `redacted_label`.
- **Whitespace-only `'  '`** — rejected by the new trim-empty guard (the regex alone would admit it) → `redacted_label`.
- **Tab / non-printable** — rejected by the charset regex → `redacted_label`.
- **Non-string** (`number`, `object`, `array`, `null`, `boolean`) — rejected by the `typeof` guard → `redacted_label` (an explicit `null` is treated as malformed, not absent).
- **Over-length** (> 64 chars) — rejected by the charset length bound → `redacted_label`.

## 8. Redaction and Leak Review

`safeLabel` redacts the following classes; `deriveSourceMode` then maps the `redacted` result to `redacted_label` for the `sourceMode` field, so no raw value is serialized:

- forbidden substrings (denylist, lowercased compare);
- service-role-like strings;
- bearer / token-like strings;
- JWT-like strings;
- secret-like strings;
- id-shaped strings (long digit runs);
- UUID-like strings;
- email-like strings (`@`);
- domain-like / URL-like / DB-URL-like strings (`://`);
- raw internal identifiers.

The existing malicious-payload tests (status-injection and full-envelope injection) continue to pass, and the new hostile-`sourceMode` test asserts no forbidden token appears in the serialized result.

## 9. `safeLabel` Guard Review

- Whitespace-only values (`''`, `'  '`, and other all-whitespace inputs) are rejected to `redacted`.
- Existing legitimate bounded labels (e.g. `feature_flag_posture`, `code_config`, `static_config`, `production_disabled`) still pass.
- Labels containing **internal** spaces still pass (the trim guard rejects only all-whitespace; the space character remains in the allow-list).
- No parser regression: the guard runs before the charset regex and only short-circuits all-whitespace input.
- The guard does **not** transform an unsafe string into a safe one — it returns the `redacted` sentinel; it never trims/normalizes a value into passing. (Note: a valid value with insignificant leading/trailing spaces is returned verbatim, which is harmless and pre-existing — out of M7Q scope.)

## 10. Fetch Behavior Review

Confirmed unchanged in `fetchC01Readiness` (M7Q touched only response handling):

- GET-only (`method: 'GET'`).
- No request body (no `body` key).
- `credentials: 'omit'`.
- No `Authorization` header (`headers: { accept: 'application/json' }` only).
- No UID / email / tenant / store / identity fields sent.
- Same-origin dev-proxy path (`{VITE_IDENTITY_API_BASE | '/__identity'}/dev/bcp/readiness-summary`).
- No query authority / no query params.
- No production endpoint.
- No auto-fetch (the card fetches only inside a button `onClick` callback; there is no `useEffect`-driven fetch).

## 11. UI Behavior Review

- `C01ReadinessCard.tsx` unchanged (diff-clean vs HEAD).
- `screens.tsx` unchanged.
- No new panel, route, navigation, or destructive control.
- The card renders `result.sourceMode` as a bounded label only; `code_config`, `code_config_only`, and `redacted_label` render identically.
- No raw object / raw error rendering; every non-success state maps to a fixed, safe note. No stack traces.

## 12. Backend / Route Preservation Review

- `server/**` unchanged.
- `server/bcp-pilot/**` unchanged.
- `server/platform-identity/server.ts` unchanged.
- Route path unchanged (`/dev/bcp/readiness-summary`).
- Route registration unchanged (`app.all(BCP_READINESS_ROUTE_PATH, …)`).
- Route behavior unchanged.
- No backend actions; no mutation capability.

## 13. No DB / Supabase / Provider Review

- No DB connection, no SQL, no DDL / migration.
- No Supabase access; no Supabase MCP.
- No live provider calls.
- No tenant / store / customer live reads.
- The client imports no DB / Supabase / provider modules; tests inject a fake `fetch` and perform no network I/O.

## 14. No Production / Navigation Exposure Review

- No production route exposure.
- No normal SaaS navigation exposure.
- No customer-facing route exposure.
- No App routing change; no `main.tsx` change.
- No public endpoint exposure (route remains DEV-only and default-off behind its flag).

## 15. No Mutation / Backend Action Review

- No POST / PUT / PATCH / DELETE success path (client is GET-only).
- No backend actions; no destructive controls.
- No audit writes; no identity_link writes; no DB writes.

## 16. Test Review

Suites run (read-only, network-free):

| Suite | Result |
|---|---|
| `src/backend-control-plane/bcpC01Client.test.ts` | 20/20 |
| `server/bcp-pilot/bcpPilot.test.ts` | 33/33 |
| `server/bcp-pilot/bcpReadOnlyRoute.test.ts` | 28/28 |
| `server/bcp-pilot/bcpReadOnlyExpressAdapter.test.ts` | 10/10 |
| `server/bcp-pilot/bcpC01CodeConfigReadModel.test.ts` | 15/15 |
| **Total** | **106/106** |

All suites printed `ALL_TESTS_PASSED`.

## 17. Typecheck Review

`npx tsc --noEmit` reports **12** errors total. This equals the known pre-existing baseline; the affected files are pre-existing and unrelated (server adapters/event-processor and several `import.meta.env` / component typing notes outside the BCP C-01 area). **0** errors reference the M7Q touched files (`bcpC01Client.ts` / `bcpC01Client.test.ts`).

## 18. Static Scan Review

- **`sourceMode` references** — declared on the success result type; read once in `classifyC01Response` via `deriveSourceMode`; rendered once in the card. No other writers.
- **`deriveSourceMode` references** — defined once; called once (the success path). No external export.
- **`safeLabel` references** — single definition; used for `category`, `status`, `warnings`, `environment`, and (via `deriveSourceMode`) `sourceMode`.
- **`bcpC01Client` fetch behavior** — GET / `omit` / accept-only header / no body / no query (see §10).
- **`C01ReadinessCard.tsx`** — diff-clean (unchanged).
- **`screens.tsx`** — diff-clean (unchanged).
- **`src/App.tsx`** — diff-clean (unchanged).
- **`src/main.tsx`** — diff-clean (unchanged).
- **`server/**`** — diff-clean (unchanged); M7Q commit contains only the two client files.
- **DB / Supabase / provider imports** — none in the client (the only `internal_user_id` / DB-URL string occurrences are inside safety **comments**, not runtime code).
- **Production route exposure** — none.
- **Normal SaaS navigation references** — none added.
- **Customer-facing route references** — none added.
- **Mutation method changes** — none (no POST/PUT/PATCH/DELETE).
- **identity_link / audit references** — none in runtime code.
- **Secrets / token / DB-URL patterns** — present only as denylist literals and safety comments; never emitted.
- **Raw ID pattern rendering** — none; id-shaped values are redacted.

## 19. Manual Preview Guidance (safe, optional)

For an owner/dev who wishes to visually confirm (no DB required):

1. Start the dev app with `VITE_ENABLE_BACKEND_CONTROL_PLANE=true`.
2. Optionally start the isolated identity API with `ENABLE_BCP_DEV_READONLY_PILOT=true` (`npm run identity:api`).
3. Open `/dev/backend-control-plane`.
4. Go to **Readiness Gate → C-01 Live Preview**.
5. Click **Load C-01 Readiness**.
6. Verify the card renders safe source/readiness labels (e.g. `source: code_config`).
7. Verify no raw `sourceMode`, IDs, secrets, or row dumps appear.
8. Verify no destructive controls appear.
9. If the identity API is not running or the flag is off, verify a safe `unavailable` / `feature_disabled` state renders (no stack trace, no raw error).

## 20. Risk Register

| # | Risk | Severity | Mitigation | Blocks next milestone? |
|---|---|---|---|---|
| 1 | `sourceMode` precedence confusion (top-level vs in-band) | Low | Explicit precedence in `deriveSourceMode`; tests assert top-level wins with distinct values; documented in §4 | No |
| 2 | Present-but-unsafe value falling through to category | Low | Unsafe branch returns `redacted_label` and never reads the category; covered by neutralization + hostile tests | No |
| 3 | `safeLabel` whitespace guard regression | Low | Guard rejects only all-whitespace; internal spaces preserved; 106/106 tests green | No |
| 4 | Unknown `schemaVersion` handling drift | Low | Classification is shape-based, not version-pinned; unknown-version test asserts safe success | No |
| 5 | Future C-02 coupling | Medium | C-02 not implemented; client parser is version-agnostic; recommend a C-01 readiness QA package before C-02 | No (advisory) |
| 6 | Accidental route/backend change | Low | M7Q commit contains only the two client files; `server/**` diff-clean | No |
| 7 | Production exposure drift | Low | Route remains DEV-only + default-off; no production endpoint; no App routing change | No |
| 8 | Raw value serialization | Low | All labels bounded by `safeLabel`; `redacted_label` sentinel; leak assertions in tests | No |
| 9 | Fetch behavior drift | Low | Fetch unchanged in M7Q; GET/omit/no-auth/no-body re-verified by test + static scan | No |
| 10 | Typecheck baseline confusion | Low | 12 errors are pre-existing/unrelated; 0 in touched files; documented in §17 | No |

## 21. Stop Conditions (none triggered)

None of the following blockers were found:

- unsafe `sourceMode` value falling through to the category fallback;
- v1 response breaking the current UI/client;
- v0 response breaking;
- unknown `schemaVersion` becoming unsafe;
- fetch sending credentials / auth / body / identity fields;
- route/backend changing unexpectedly;
- production exposure;
- normal SaaS navigation exposure;
- customer-facing exposure;
- DB / Supabase / provider / fetch access added beyond the existing injected test-safe behavior;
- raw IDs / secrets / tokens / DB URLs / emails / domains rendering;
- tenant / store / customer rows rendering;
- backend actions / mutation added;
- live session auth / Supabase auth / cutover implied.

## 22. Acceptance Criteria for M7R

M7R is accepted when: (a) all twenty-nine primary-goal checks in §§4–18 hold; (b) 106/106 tests pass and typecheck shows 0 errors in touched files; (c) only the single docs file is created and no other file changes; (d) no DB/Supabase/provider/live access, no production/navigation/customer-facing exposure, no backend action/mutation, and no real/sensitive data appear in the document. All criteria are met.

## 23. Recommended Next Milestone

**Phase 2.0 M7QA — Backend CP Phase 2.0 C-01 Readiness QA Package.** Conservatively, consolidate the C-01 readiness story (synthetic harness, code/config read model, v1 DTO, client hardening) into a single readiness QA package before opening a C-02 planning gate. (If accepted, the immediate procedural next step is **Phase 2.0 M7R — Scoped Commit and Backup Authorization** for this document.)

---

*Review/documentation only. No code, tests, UI, route, or backend behavior was changed. No DB / SQL / Supabase / Supabase MCP / live-provider access, no commit/push/backup performed in this milestone. This document does not implement code, does not modify route behavior, does not claim C-02 is implemented, does not claim live session auth or Supabase auth is enabled, does not claim the Backend Control Plane is production-ready, and does not claim Supabase is ready for a Firebase cutover. No real tenant/store/customer data, raw IDs, secrets, tokens, DB URLs, emails, domains, payment identifiers, permission/entitlement key lists, mismatch lists, raw auth claims, provider UIDs, identity_link rows, or audit rows appear herein.*
