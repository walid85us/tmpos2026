# Phase 2.0 M9 — Planning Gate for the Next Consolidated Backend CP Read-Only Lens

**Status:** Documentation / planning only. No source, test, route, UI, backend, frontend, DB, auth, package, migration, or configuration change was made. This gate selects the next Backend Control Panel read-only workstream after frozen C-01 and C-02, with a consolidated implementation package and a stop/go decision.

**Accepted checkpoint:** `84b70f95f32103558bc9ae012c5680915c6b52f9`
**Most recent committed milestone:** Phase 2.0 M8G — C-02 DEV QA baseline freeze.

---

## 1. Executive Summary

The recommended next step is **Candidate A — Safe Server-Owned C-02 Module Registry Provider**, packaged as **Phase 2.0 M10**. It is the lowest-new-risk, highest-marginal-value move: it makes the frozen C-02 lens genuinely useful (showing **configured** module-registry posture instead of the empty default — a server-owned code/config mirror, not live/authoritative production data) **without** creating a new exposure family and **without** introducing DB/Supabase/live/action/mutation/production risk. The provider is a **new backend-owned code/config file** that declares its own `{id, name, status}` list (a server-side mirror of the conceptual Backend CP modules) — it does **not** import the frontend `mockData.ts` and uses no sensitive row shapes. It plugs into the existing, already-accepted adapter `getModules` injection point and the single isolated `server.ts` registration line; the C-02 route handler, adapter logic, client, and UI are unchanged (regression only). Decision: **Decision A — SELECT NEXT CONSOLIDATED READ-ONLY WORKSTREAM (Candidate A).** Candidates B–F are deferred (B/C/D are reasonable future C-03 families but each requires a full new chain and a new exposure boundary; E/F are high-risk and Phase-boundary-sensitive).

## 2. Preflight Result

PASS — branch `main`; HEAD == origin/main == `84b70f95f32103558bc9ae012c5680915c6b52f9`; ahead/behind `0/0`; `git status` only ` M .replit` + `?? goose-…tar.bz2`; nothing staged; `.gitattributes` ABSENT; M8G commit `84b70f9` present. HEAD == origin/main ⇒ pre-change backup checkpoint (no extra backup). No source/test/runtime change; no commit/push/backup during M9.

## 3. Files Created

- `docs/phase-2.0-backend-control-panel-next-read-only-lens-planning-gate.md` (this file).

## 4. Files Modified

None (planning only). ` M .replit` is the pre-existing untouched change.

## 5. Files Confirmed Untouched

All C-01 and C-02 source/test files, `server/platform-identity/server.ts`, `src/App.tsx`, main SaaS navigation, package files, migrations, seeds, `shared/**`, auth/M20/audit-writer/identity-repository/sessionResolve. `git diff` (tracked) touches only `.replit`.

## 6. Planning Decision

**Decision A — SELECT NEXT CONSOLIDATED READ-ONLY WORKSTREAM: Candidate A (Phase 2.0 M10).**

## 7. Current Baseline Summary

Two frozen Phase 2.0 DEV QA baselines exist: **C-01** (readiness summary; `/dev/bcp/readiness-summary`) and **C-02** (registry readiness lens; `/dev/bcp/registry-readiness`). Both are DEV-only, default-off, production-disabled, read-only, code/config-only, server-sourced-authority, with no DB/Supabase/provider/live/action/mutation/production/customer-facing exposure. Combined test suite: 202/202; typecheck 12 baseline errors unchanged, 0 in C-01/C-02 files. Global constraints unchanged: Firebase authoritative; Supabase dormant/shadow/readiness-only; no cutover; Phase 3 (controlled actions) and Phase 4 (production) not started.

## 8. C-01 Freeze Status

C-01 remains frozen and safe (M7QC). No C-02 milestone modified any C-01 file; C-01 regression is green (106/106). The next step must not break C-01.

## 9. C-02 Freeze Status

C-02 remains frozen and safe (M8G). It currently uses the adapter's safe **empty default registry** (`getModules → []`), so the live lens returns `emptyState: no_modules`. This is the single accepted-residual that Candidate A addresses. The C-02 route is registered once on the isolated identity API (`server.ts:192`) with `createBcpC02RegistryReadinessHandler()` (no args); the adapter already exposes a `getModules` dependency for a future server-owned provider.

## 10. Consolidation Strategy Going Forward

Per the speed-up rule, combine work that stays inside one safety boundary (planning+inventory+contract; read model+DTO+tests; route+adapter+tests when unregistered; registration+transport; client+UI+internal screen integration; QA+exposure+freeze). Do **not** combine across crucial boundaries (backend registration + new frontend exposure unless already proven; live DB/Supabase/provider; tenant/store/customer data; backend actions; mutations; production; customer-facing; auth/Supabase/Firebase cutover). Candidate A fits one boundary (backend-owned code/config provider feeding the already-frozen C-02 chain) and is safely consolidatable into a single M10.

## 11. Candidate Evaluation Summary

| Candidate | New family? | Route work | UI work | New exposure boundary | Live data / DB / auth | Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| **A — Server-owned C-02 registry provider** | No (reuses C-02) | No (reuse registration) | No (regression only) | No | No / No / No | Low–Med | **SELECT NOW** |
| B — Feature flag / env posture lens | Yes (C-03) | Yes (new chain) | Yes (new card) | Yes | No / No / No | Medium | Defer |
| C — Route inventory / exposure lens | Yes (C-03) | Yes | Yes | Yes | No / No / No | Medium | Defer |
| D — UI coverage / screen readiness lens | Yes (C-03) | Yes | Yes | Yes | No / No / No | Low–Med | Defer |
| E — Audit / security posture lens | Yes (C-03) | Yes | Yes | Yes (sensitive) | Yes / Yes / No (would need audit rows + DB) | High | Defer (Phase-sensitive) |
| F — Identity / session posture lens | Yes (C-03) | Yes | Yes | Yes (sensitive) | Yes / Yes / Yes (would need identity/auth) | High | Defer (Phase-sensitive) |

*(The "Live data / DB / auth" column for E and F shows the sensitive dependencies their meaningful versions would require — precisely why they are high-risk and deferred. A–D need none of these in their code/config-only form.)*

## 12. Candidate A — Safe Server-Owned C-02 Module Registry Provider

1. **Purpose:** replace C-02's empty default registry with a safe, backend-owned code/config provider so the lens shows **configured** (code/config, not live/authoritative) module posture.
2. **Source set:** a NEW backend-owned constant list of `{id, name, status}` declared in the provider file (server-side mirror of the conceptual ~33 Backend CP modules); the read model sanitizes each. **No** import of `src/.../mockData.ts`. **Naming constraint (important):** the provider must declare `safeLabel`-passing `id`/`name` values — i.e. avoid `&`, `/`, the substring `secret`, 4+ digit runs, dots, and file extensions, since the frontend `mockData.ts` names (e.g. "Jobs & Workers", "Configuration & Secrets Posture", "Support / Operator Tools", id `config-secrets`) would otherwise redact to `redacted_label`. Use redaction-safe aliases (e.g. `config-secrets` → `configuration-secrets-posture` with name "Configuration and Secrets Posture") so the lens shows real configured labels rather than redactions.
3. **Output DTO:** unchanged C-02 envelope (`bcp.c02.registry-readiness.v1-code-config`), now with populated `registryItems[]` + non-empty `summaryCounts` and `emptyState:{isEmpty:false,reason:'none'}`.
4. **Risk:** Low–Medium (code/config-only, backend-owned, no new family).
5. **Safety boundaries:** DEV-only, default-off, production-disabled, read-only, code/config-only; no DB/Supabase/live; no frontend mockData import; no sensitive rows.
6. **Data classification:** safe operational labels (module key/name/status) only — the provider declares already-safe labels **and** the read model independently sanitizes each via `safeLabel`/`normalizeStatus` (defense-in-depth: a single read-model sanitization pass on top of a safe-by-construction provider, not two redaction passes).
7. **Combinable safely:** Yes (provider + tests + one-line server.ts wiring + regression + transport, one milestone).
8. **Route work:** none beyond passing the provider into the existing registration call (no new route/path/method).
9. **Frontend UI work:** none (client/UI unchanged; regression only — they already render non-empty registries).
10. **Runtime transport evidence:** yes (re-verify the live envelope now returns populated, still-safe items).
11. **New exposure boundary:** No (reuses the frozen C-02 route/client/UI).
12. **Live data:** No. **DB/Supabase:** No. **Auth/cutover:** No. **Backend action/mutation:** No.
13. **Recommendation:** **Select now.**

## 13. Candidate B — Feature Flag / Environment Posture Lens

Purpose: read-only bounded feature-flag/environment posture labels. Source: env/flag presence booleans + posture categories (never raw values). Output: a new C-03 envelope. Risk: Medium (env values are sensitive — must emit presence/posture labels only, never raw values/secrets/URLs/keys/domains). Requires a full new chain (read model → route → client → UI) and a new exposure boundary; needs transport + UI evidence; no live data/DB/auth. **Recommendation: Defer** (strong future candidate; overlaps C-01's existing `feature_flag_posture`/`production_disabled_posture` categories — best done after A, and scoped to avoid duplicating C-01).

## 14. Candidate C — Route Inventory / Route Exposure Posture Lens

Purpose: read-only summary of safe route-exposure posture across Backend CP DEV routes. Source: static route-path constants + bounded route categories. Output: new C-03 envelope. Risk: Medium (route internals can leak if careless — only bounded categories/safe labels, no raw internals, no customer-facing enumeration). Requires a full new chain + new exposure boundary + transport/UI evidence; no live data/DB/auth. **Recommendation: Defer** (good security value; do after A).

## 15. Candidate D — Backend CP UI Coverage / Screen Readiness Lens

Purpose: read-only Backend CP screen-readiness/placeholder/preview-coverage posture. Source: a safe internal screen/module registry (server-owned, code/config). Output: new C-03 envelope. Risk: Low–Medium. Requires a full new chain + new exposure boundary + transport/UI evidence; no live data/DB/auth. **Recommendation: Defer** (useful rollout planning; overlaps Candidate A's registry data — consider folding into A's data model later).

## 16. Candidate E — Audit / Security Posture Lens

Purpose: read-only audit/security status. Risk: **High** (audit_event/identity_link rows, real security logs, raw actor IDs must never appear). Requires aggregation + very strong redaction; Phase-boundary-sensitive. **Recommendation: Defer** (not next; only after B/C/D-class foundations and a dedicated source-inventory + redaction gate).

## 17. Candidate F — Identity / Session Posture Lens

Purpose: read-only identity/session readiness. Risk: **High** (auth claims, provider UIDs, internal_user_id, email authority; must not enable Supabase auth or Firebase cutover). **Recommendation: Defer** (highest risk; only after E-class foundations are proven; not next).

## 18. Selected Candidate

**Candidate A — Safe Server-Owned C-02 Module Registry Provider**, packaged as **Phase 2.0 M10**.

## 19. Selection Rationale

A is the safest practical next step: it stays entirely within the frozen C-02 read-only model, introduces **no new exposure family**, requires **no new route or UI**, and removes the only meaningful C-02 residual (the empty registry) by adding a backend-owned, code/config-only provider. It avoids opening a brand-new C-03 exposure boundary too soon and reuses the already-proven, already-accepted adapter `getModules` seam and the single isolated registration point. B/C/D are reasonable subsequent C-03 lenses but each is a full new chain with a new boundary; E/F are high-risk and Phase-sensitive. Doing A first maximizes value per unit of new risk.

## 20. Selected Candidate Safety Contract

M10 must remain: DEV-only; default-off (`ENABLE_BCP_DEV_C02_REGISTRY_READINESS`); production-disabled; read-only; code/config-only; no DB/SQL/Supabase/Supabase-MCP/live provider; no frontend mockData import; no sensitive mock rows; no route behavior expansion beyond the accepted C-02 route; no new route/method; no customer-facing exposure; no production exposure; no backend action; no mutation; no live session auth; no Supabase auth; no Firebase-to-Supabase cutover. Authority stays server-sourced; the provider is server-owned and injected via the existing `getModules` dependency.

## 21. Selected Candidate Source Inventory

- **Provider data (new, backend-owned):** a constant array of `{ id, name, status }` declared in `server/bcp-pilot/bcpC02RegistryProvider.ts`, mirroring the conceptual Backend CP module set (server-side; **not** imported from `src/.../mockData.ts`). Each value is a safe operational label; the M8C read model independently sanitizes them.
- **Consumed by:** the existing M8C `buildC02RegistryReadinessEnvelope(modules, …)` (unchanged) via the M8D adapter's `getModules` dep (unchanged) at the M8E `server.ts` registration line (changed from no-arg to `{ getModules: <provider> }`).
- **Excluded:** `src/backend-control-plane/mockData.ts` (frontend), all sensitive row types (TenantRow/StoreRow/AuditRow/DatabaseRow/PermissionRow), DB/Supabase, anything beyond `id/name/status`.

## 22. Selected Candidate DTO / Output Contract

Unchanged C-02 envelope: `bcp.c02.registry-readiness.v1-code-config` / `sourceMode: code_config` / `freshness: code-config-no-live-read`. With the provider populated, `registryItems[]` is non-empty, `summaryCounts` reflect the configured (code/config) bucket totals, and `emptyState` becomes `{isEmpty:false, reason:'none'}`. No new fields; no schema-version bump required (still v1 code/config). Every field remains a bounded label/enum/boolean/count.

## 23. Selected Candidate Exposure Boundaries

No new route, no new method, no new UI, no new App route, no SaaS-nav/customer-facing/production exposure. The only reachable surface remains the isolated DEV `/dev/bcp/registry-readiness` (and its `/__identity` proxy) behind the default-off flag. The provider runs only when DEV + flag-on (gates-first, already enforced by the adapter).

## 24. Selected Candidate Testing Strategy

- New provider unit tests (`bcpC02RegistryProvider.test.ts`): deterministic; only `{id,name,status}`; **every provider id/name passes the read model's `safeLabel` (assert ZERO `redacted_label`/`unknown` outputs through the read model)** so the lens shows real configured labels; counts derive correctly; no `src/` import; no sensitive shapes.
- Integration: read model + adapter with the provider injected → populated safe envelope; emptyState false.
- Regression: all C-01 + C-02 suites remain green (target 202/202 + the new provider tests).
- Re-run transport verification: DEV+on now returns populated items (still safe), DEV+off 404, prod+on 404, mutations 405, hostile no-leak.

## 25. Selected Candidate Static Scan Strategy

Confirm the provider and the server.ts change introduce no `createClient`/`@supabase`/`getDb`/`process.env.DATABASE`/`SUPABASE`/DB-strings/`identity_link`/`audit_event`/`src/` import/sensitive-row types; no new route/method; no mutation; no frontend coupling. Confirm `server.ts` C-02 registration still maps no request data into the provider/principal/modules/mode.

## 26. Selected Candidate Typecheck Strategy

`tsc --noEmit`: baseline must remain 12; 0 errors in the new provider file and the modified `server.ts`; 0 in `server/bcp-pilot/**`; C-01/C-02 unaffected.

## 27. Selected Candidate Runtime / UI Evidence Strategy

Live transport verification via the isolated identity API (DB-free boot) showing the populated, still-safe envelope across the standard states. Browser pixel-level visual remains an accepted NOT-RUN residual (no display), covered by static review + tests + transport, per precedent. Frontend client/UI unchanged (regression only).

## 28. Recommended Consolidated Next Milestone

**Phase 2.0 M10 — C-02 Safe Server-Owned Module Registry Provider** (single consolidated milestone): backend-owned provider + provider tests + the minimal `server.ts` dependency wiring (provider import + passing it via `getModules`) + C-02/C-01 regression + static scans + typecheck + live transport evidence + (optional) doc note. Paired with a **Phase 2.0 M10 — Scoped Commit and Backup Authorization**.

## 29. Allowed Files for Next Milestone (M10)

- **Create:** `server/bcp-pilot/bcpC02RegistryProvider.ts`, `server/bcp-pilot/bcpC02RegistryProvider.test.ts`.
- **Modify (minimal):** `server/platform-identity/server.ts` — add the provider import and pass the server-owned provider via `getModules` into `createBcpC02RegistryReadinessHandler({ getModules: … })` (an import line + the registration argument; no other change).
- (Optional) the adapter `bcpC02ReadOnlyExpressAdapter.ts` only if a **type-only / non-behavioral** export is genuinely required — preferably unchanged (it already accepts `getModules`); any adapter edit must be type-only (no behavior change) and reported first. This resolves the apparent tension with the Prohibited-files list (which forbids adapter *behavior* change): a type-only export is not a behavior change.
- **M8G transport snapshot note:** M10 intentionally flips the live C-02 output from `emptyState:no_modules` to a populated registry. The M8G transport evidence (which captured the empty state) is therefore **intentionally superseded/re-frozen** by M10 — the changed live output is expected, not a regression. (The 202/202 suite stays green because the registration test asserts gating not body content, the client test uses fixtures, and read-model/adapter tests inject their own arrays.)

## 30. Prohibited Files for Next Milestone (M10)

`src/backend-control-plane/mockData.ts` (no import), all sensitive row types, the C-02 read model/route/adapter behavior (reuse unchanged — provider injection only), `src/App.tsx`, main SaaS navigation, package files, migrations, seeds, `shared/**`, auth/M20/audit-writer/identity-repository/sessionResolve, any DB/Supabase/migration file, any customer-facing/production file. The frontend C-02 client/card must not need changes (regression only).

## 31. Stop Conditions for Next Milestone (M10)

Stop and report if: any DB/Supabase/live/external-provider access appears (the selected backend-owned **code/config** provider is the only allowed provider — any live/external data source is a stop); any `src/`/mockData import or sensitive row shape is needed; the read model/route/adapter behavior must change (beyond injecting the provider); a new route/method/exposure surface is required; request data would map into the provider/authority; tests fail or typecheck gains touched-file errors; the provider emits anything beyond bounded `{id,name,status}` labels; any production/customer-facing/nav exposure; any backend action/mutation/auth/cutover implication.

## 32. Non-Readiness Statements

- The next step is **not** production readiness, **not** Phase 3 controlled actions, **not** Phase 4 production release.
- Firebase remains authoritative; Supabase remains dormant/shadow/readiness-only; no Firebase-to-Supabase cutover is authorized.
- Backend Control Panel remains DEV-only and read-only in Phase 2.0.
- C-01 and C-02 remain frozen DEV QA baselines (not production-ready).
- No Supabase auth, no live session authorization, no backend actions, no mutation capability.

## 33. Risks / Accepted Residuals

- **Server-side data duplication:** the provider duplicates the conceptual module list server-side rather than importing the frontend `mockData.ts` — this is intentional (preserves the server↔client boundary) and accepted; the two lists may drift, which is acceptable for a DEV-only code/config posture lens (a future milestone could unify via a shared, non-sensitive constant if justified).
- **Browser pixel-level visual / Vite-proxy e2e:** remain accepted NOT-RUN residuals (no display), covered by static review + tests + live backend transport.
- **`VITE_IDENTITY_API_BASE` trust:** unchanged from frozen C-01/C-02 (DEV-only operator config).

## 34. Git Status

```
 M .replit
?? docs/phase-2.0-backend-control-panel-next-read-only-lens-planning-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```
Branch `main`, HEAD `84b70f9`, ahead/behind `0/0`, nothing staged, `.gitattributes` absent.

## 35. No Commit / Push / Backup Confirmation

No `git add`/stage, no commit, no push, no backup performed during M9. No source/test/runtime change occurred.

## 36. Recommended Next Step

**Phase 2.0 M9 — Scoped Commit and Backup Authorization** (commit this planning gate), then **Phase 2.0 M10 — C-02 Safe Server-Owned Module Registry Provider** (the selected consolidated implementation milestone).

---

*Documentation/planning only. No source, test, frontend, backend, route, UI, package, migration, DB, Supabase, Supabase MCP, live provider, or production change occurred; no commit/push/backup was performed. This gate does not implement code, does not authorize implementation (it recommends the next milestone), does not claim production readiness, and does not approve any Supabase-auth/live-session/Firebase-cutover step. No real tenant/store/customer data, raw IDs, internal_user_id, provider UIDs, raw auth claims, identity_link rows, audit rows, permission/entitlement key lists, mismatch lists, secrets, tokens, DB URLs, emails, domains, or payment identifiers appear herein.*
