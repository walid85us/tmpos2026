# Phase 2.0 M7J — Backend Control Panel C-01 Source Inventory and Schema Readiness Review

**Status:** Review/documentation-only · Inventories and classifies candidate sources for a future live C-01 Readiness Summary read model (no implementation)
**Accepted checkpoint at authoring:** `ccb00e88c747a0f3cd9ff55db265b15042de2f63` (Phase 2.0 M7I)
**Authoring milestone:** Phase 2.0 M7J

> Redaction-first. No real tenant/store/customer data, raw IDs, emails, domains,
> DB URLs, tokens, secrets, payment identifiers, permission/entitlement key lists,
> mismatch lists, raw auth claims, raw provider UIDs, or raw `identity_link` rows.
> All DTO/posture values shown are **synthetic placeholders only**. This milestone
> implements **nothing**: no live read model, no DTO/mapper/test code, no route
> change, no DB/SQL/Supabase access, no auth/runtime/route/UI change. Nothing is
> staged, committed, pushed, or backed up.

---

## 1. Executive Summary

C-01 source readiness is **ready for a strictly code/config-only DEV read model implementation, under a tight boundary** (no DB/Supabase/provider, no real-principal wiring, no route-registration/UI change). The inventory proves — from files only — that the natural content of C-01 is **self-referential system posture** sourced entirely from code and configuration, with **no** DB, Supabase, or provider dependency. A static import scan of the non-test C-01 surface (`server/bcp-pilot/**`) returns **zero** DB/Supabase/provider/`fetch` imports; the flag helper reads only `process.env`; there are **zero** `src/**` references (no UI exposure); the only importer of the route adapter is the isolated `server/platform-identity/server.ts`; and the existing suite is green (**61/61**) with **0** typecheck errors in the C-01 surface. Sources S-1…S-5 are proven DB-free code/config sources; S-6/S-9 are safe documentation/constant labels; S-7/S-8 are evidence-only (must not be live runtime reads); S-10 parity posture can be represented as a static/config label (or deferred); S-11 remains blocked pending separate schema review; S-12 remains out of scope. On that evidence the decision is **Decision A — READY TO REQUEST A DEV-ONLY CODE/CONFIG C-01 READ MODEL IMPLEMENTATION**, bound to a tight code/config-only boundary (no DB/Supabase/provider, no real-principal wiring, no route-registration/UI change). The existing inert route is **not modified** by this milestone.

## 2. Current State and Boundary

- The M7G/M7H route is **accepted-safe**: `GET /dev/bcp/readiness-summary`, registered via `app.all(BCP_READINESS_ROUTE_PATH, …)` on the **isolated** platform-identity API only (own port `5002`, started only via `npm run identity:api`); default-off (`ENABLE_BCP_DEV_READONLY_PILOT`); production-disabled; DEV-only; GET-only for success; synthetic-only; fail-closed.
- **M7I selected Decision B** (request this source inventory before implementation).
- **C-01 remains synthetic-only today** — a fixed, server-constructed synthetic source object and synthetic principal; no live session resolver wired.
- **No live C-01 read model exists.** No C-02 integration; no DB/Supabase/provider access; no backend actions; no mutation path.
- **This milestone inventories sources only** — it changes nothing.

Global constraints unchanged: Firebase/legacy AccessContext remains current frontend/app authority; future BCP live read APIs require a server-derived principal after parity/safety gates; Supabase remains dormant/readiness-only and not ready for cutover; no live C-01 read model authorized yet; controlled actions remain Phase 3; production readiness remains Phase 4.

## 3. Review Decision

**Decision A — READY TO REQUEST A DEV-ONLY CODE/CONFIG C-01 READ MODEL IMPLEMENTATION.**

This decision is taken only because **every** Decision-A precondition is met and evidenced:

- **S-1…S-5 are proven DB-free code/config sources** — the import scan of non-test `server/bcp-pilot/**` returns zero DB/Supabase/provider/`fetch` imports; `isBcpDevReadonlyPilotEnabled()` reads only `process.env` (`bcpPilotConfig.ts:22-24`); route/redaction/source-mode posture derive from in-repo constants and module state.
- **S-10 parity posture is safely representable as a static/config label** — the first implementation keeps a fixed (synthetic-style) principal, so `parityState` is a fixed config value, **not** a live identity computation. A live parity check remains deferred/blocked.
- **S-11 and S-12 remain excluded** — no DB/Supabase counts and no tenant/store/`identity_link`/audit content enter C-01.
- **No source needs DB/Supabase/provider access** — the C-01 content is self-referential posture only.

Conservatism is preserved by *constraining the implementation*, not by manufacturing doubt the evidence does not support: parity stays static/deferred, S-11 stays blocked, S-12 stays out of scope, and the implementation is bound to a code/config-only boundary with no real-principal wiring, no route-registration change, and no UI. Why not **Decision B** — no important source/authority/isolation/redaction/evidence question remains unresolved; the boundary is proven, so requiring more design would be unjustified caution. Why not **Decision C** — no source requires DB/Supabase/provider access, raw rows/IDs, tenant/store leakage, client authority, live session auth, mutation, or cutover; there is no defect to repair.

*(Note for the owner: if a plan-first step is preferred over direct implementation, an intervening "M7K — C-01 Read Model Implementation Plan" is an acceptable more-conservative substitute. The source boundary itself is proven either way.)*

## 4. Inventory Method

Performed entirely from files and safe local commands — **no** DB/SQL/Supabase/MCP/live-API/`fetch`/network calls and **no** runtime changes:

- **Files read:** `server/bcp-pilot/bcpPilotConfig.ts`, `bcpAuthorizationGuard.ts`, `bcpReadinessSummaryHarness.ts`, `bcpReadOnlyRoute.ts`, `bcpReadOnlyExpressAdapter.ts`; `server/platform-identity/server.ts`; the three `server/bcp-pilot/*.test.ts` files; and the M2–M7I planning docs.
- **Static searches run (read-only `grep`):**
  - DB/Supabase/provider/`fetch` imports in non-test `server/bcp-pilot/**` → **NONE**.
  - `identity_link`/`audit` references in `server/bcp-pilot/**` → only the harness forbidden-key list (`identityLinkRow`, `rawAuditEvent`), a header comment, the `audit_viewer` visibility-class label, and test-strip inputs — **no live reads**.
  - `src/**` references to the route/adapter/handler/path → **NONE** (no UI/client exposure).
  - Importers of `server/bcp-pilot/**` outside the directory → only `server/platform-identity/server.ts` (single isolated-API registration surface).
- **Tests run:** `npx tsx` on the three suites → **28/28 + 26/26 + 7/7 = 61/61** (`ALL_TESTS_PASSED`).
- **Typecheck run:** `npx tsc --noEmit` → **12 total errors = pre-existing baseline**, **0** in `server/bcp-pilot/**` or `server/platform-identity/server.ts`.

## 5. Source Inventory Table

Dependency columns use: **DB?** (DB/Supabase/provider dependency), **Authz?** (authorization dependency), **Iso?** (isolation dependency), **Redact?** (redaction dependency). All "allowed contributions" are **labels only**.

| ID | Name | Location / evidence | Type | Owner surface | Sensitivity | Allowed C-01 contribution | Forbidden content | DB? | Authz? | Iso? | Redact? | Readiness | Decision | Next action |
|----|------|---------------------|------|---------------|-------------|---------------------------|-------------------|-----|--------|------|---------|-----------|----------|-------------|
| S-1 | Feature-flag posture | `bcpPilotConfig.ts:13,22-24` | Code/config | BCP pilot config | Low | `enabled`/`disabled` label | Raw env values, secrets | No | No | No | Label-only | Ready | **Impl candidate** | Read via existing helper (boolean only) |
| S-2 | Route-registration posture | `bcpReadOnlyExpressAdapter.ts:26`; `server.ts:32,177` | Code | Isolated platform API | Low | `route_foundation: ready` label | Internal paths beyond known route label | No | No | No | Label-only | Ready | **Impl candidate** | Derive from imported path **constant** (no live router introspection) |
| S-3 | Production/env posture | `bcpPilotConfig.ts:23`; adapter `NODE_ENV` gate | Code/config | BCP pilot config | Low | `production: blocked` / `dev_only` label | Raw `NODE_ENV`/host values | No | No | No | Label-only | Ready | **Impl candidate** | Read `NODE_ENV` → label only |
| S-4 | Redaction posture | `bcpReadinessSummaryHarness.ts` (allow-list + strip) | Code | BCP harness | Low | `redaction: active` label | The forbidden-key list contents | No | No | No | Label-only | Ready | **Impl candidate** | Represent as static "redaction-active" boolean |
| S-5 | Synthetic/live-boundary posture | `bcpReadOnlyExpressAdapter.ts:41-43` | Code | BCP adapter | Low | `source_mode: synthetic`/`code_config` label | None | No | No | No | Label-only | Ready | **Impl candidate** | Source-mode label makes boundary explicit/testable |
| S-6 | Phase-boundary constants | M2 contract map §6 | Doc constant | Governance docs | Low | `liveReadOnly/controlledActions/production: blocked` labels | None | No | No | No | Label-only | Ready | **Doc/evidence** | Hardcode safe governance constants |
| S-7 | Test posture | 61/61 (this review) | Doc/CI evidence | CI/evidence | Low | `tests: passing` label | Raw logs, stack traces | No | No | No | Label-only | Evidence-only | **Doc/evidence** | Keep manual/evidence; **not** a live runtime read |
| S-8 | Typecheck posture | 12 baseline / 0 new (this review) | Doc/CI evidence | CI/evidence | Low | `typecheck: baseline-clean` label | Raw compiler output | No | No | No | Label-only | Evidence-only | **Doc/evidence** | Keep manual/evidence; **not** a live runtime read |
| S-9 | Isolation posture | M5 isolation/RBAC test plan | Doc | Governance docs | Low | `isolation: defined` label | Tenant/store specifics | No | No | Must not reveal tenant/store existence | Label-only | Ready | **Doc/evidence** | Adopt as static label |
| S-10 | Parity posture | M6 parity review; guard `parityState` | Config/Doc | Server-derived principal (synthetic today) | Medium | `parity: ready`/`unresolved` static label | Identity rows, raw claims, provider UIDs, `identity_link`, mismatch lists | No (static) | Indirect | No | Label-only | Conditionally ready | **Deferred / static-label** | Use static/config label; **never** compute by reading identity; live parity deferred |
| S-11 | DB/Supabase counts | (none implemented) | DB/Supabase | Data layer | High | **None for C-01** | Raw rows/IDs, connection data | **Yes** | Yes | Full server-side if ever used | N/A | Blocked | **Blocked** | Keep excluded; separate schema-review gate if ever needed |
| S-12 | Tenant/store/`identity_link`/audit content | (other contracts) | DB/provider | Data/identity/audit | High/Restricted | **None for C-01** | All raw business/identity/audit data | **Yes** | Yes | N/A | N/A | Out of scope | **Out of scope** | Belongs to C-04/C-06/C-07/C-09; keep excluded |

## 6. Source Classification Summary

- **Implementation-ready code/config candidates:** S-1, S-2, S-3, S-4, S-5.
- **Documentation/evidence-only candidates:** S-6, S-7, S-8, S-9 (S-7/S-8 must remain evidence labels, never live runtime reads).
- **Deferred candidates:** S-10 (parity posture — static/config label now; live parity deferred).
- **Blocked candidates:** S-11 (DB/Supabase counts — pending separate schema review).
- **Out-of-scope candidates:** S-12 (tenant/store/`identity_link`/audit content — belongs to later contracts).

## 7. S-1 through S-5 Code/Config Readiness Review

- **S-1 Feature-flag posture** — *Evidence:* `bcpPilotConfig.ts:13,22-24`. *DB-free read?* Yes — `process.env` only. *Allowed output:* `enabled`/`disabled` label. *Forbidden:* raw env values/secrets. *Redaction:* emit label only. *Readiness:* ready. *Blocker:* none.
- **S-2 Route-registration posture** — *Evidence:* adapter path constant `bcpReadOnlyExpressAdapter.ts:26`; registration `server.ts:32,177`. *DB-free read?* Yes. *Allowed output:* `route_foundation: ready` label. *Forbidden:* internal paths beyond the known route label. *Redaction:* label only. *Readiness:* ready. *Blocker:* **design constraint** — derive from the imported path **constant**, do **not** live-introspect the Express router (avoids coupling the response to runtime router state).
- **S-3 Production/env posture** — *Evidence:* `bcpPilotConfig.ts:23`; adapter `isDevEnvironment = process.env.NODE_ENV !== 'production'`. *DB-free read?* Yes. *Allowed output:* `production: blocked`/`dev_only` label. *Forbidden:* raw `NODE_ENV`/host values. *Redaction:* label only. *Readiness:* ready. *Blocker:* none.
- **S-4 Redaction posture** — *Evidence:* `bcpReadinessSummaryHarness.ts` allow-list + forbidden-field strip. *DB-free read?* Yes. *Allowed output:* `redaction: active` label. *Forbidden:* the forbidden-key list contents. *Redaction:* label only. *Readiness:* ready. *Blocker:* none.
- **S-5 Synthetic/live-boundary posture** — *Evidence:* `bcpReadOnlyExpressAdapter.ts:41-43` (`SYNTHETIC_SOURCE`). *DB-free read?* Yes. *Allowed output:* `source_mode: synthetic`/`code_config` label. *Forbidden:* none. *Redaction:* label only. *Readiness:* ready. *Blocker:* none — the source-mode label makes the synthetic↔code/config boundary explicit and testable.

All five are confirmed strictly code/config-derived and DB/Supabase/provider-free (static import scan = NONE).

## 8. S-6 through S-9 Documentation/Evidence Source Review

- **S-6 Phase-boundary constants** — *Evidence:* M2 contract map §6 governance constants. *Type:* documentation/constant. *Safe contribution:* `liveReadOnly`/`controlledActions`/`production` = `blocked` labels. *Include in first implementation?* Yes — as hardcoded safe constants. *Manual/evidence-only?* Constants, not a live read — and they must stay visibly tied to the governance docs/tests so the posture labels cannot go stale.
- **S-7 Test posture** — *Evidence:* 61/61 this review. *Type:* CI/evidence. *Safe contribution:* a `tests: passing` **label** only. *Include in first implementation?* **No** as a live read — a request handler must never run the suite. *Manual/evidence-only?* Yes — keep as evidence/manual label.
- **S-8 Typecheck posture** — *Evidence:* 12 baseline / 0 new this review. *Type:* CI/evidence. *Safe contribution:* a `typecheck: baseline-clean` **label** only. *Include in first implementation?* **No** as a live read. *Manual/evidence-only?* Yes.
- **S-9 Isolation posture** — *Evidence:* M5 isolation/RBAC test plan. *Type:* documentation. *Safe contribution:* `isolation: defined` label. *Include in first implementation?* Optional — as a static label. *Manual/evidence-only?* Static label; must never reveal tenant/store existence.

## 9. S-10 Parity Posture Review

**Resolution: static/config label only (live parity deferred/blocked).** Parity posture may be represented as a **static or config-derived label** (e.g. `parity: ready`/`unresolved`) reflecting the M6 readiness state, and/or **derived from the existing synthetic readiness state** (the fixed principal's `parityState`). It **must not**:

- read identity rows, `identity_link` rows, raw auth claims, provider UIDs, or mismatch lists to compute the label;
- perform any live Firebase/Supabase parity check.

A **live** parity computation (reading real server-authorization parity) is **deferred until real server-authorization parity is separately approved**. Because the first C-01 implementation keeps a fixed/synthetic-style principal, `parityState` is a fixed config value — safe, and consistent with the guard's `parityState === 'ready'` gate.

## 10. S-11 DB/Supabase Counts Review

**Remains blocked.** No DB/Supabase count source is authorized now; it is **excluded from the first C-01 implementation** and remains **blocked pending a separate schema review**. The static scan confirms no DB/Supabase/provider import exists in the current C-01 surface, so excluding S-11 requires *no* code removal — only that the implementation introduce none.

## 11. S-12 Tenant / Store / identity_link / Audit Content Review

**Remains out of scope for C-01.** This content belongs to later contracts (tenant/store posture C-06, billing C-07, identity readiness C-09, audit visibility C-04, and operational lenses) — never C-01. **No raw rows or raw IDs** are allowed. The `identity_link`/`audit` tokens found in `server/bcp-pilot/**` are exclusively the harness *forbidden-key list*, a header comment, the `audit_viewer` visibility-class label, and test inputs proving stripping — **no** live access exists or is planned for C-01.

## 12. Schema Readiness Assessment

- **DB schema required for first C-01 implementation?** **No.** The content is code/config/doc posture.
- **File/config-derived schema sufficient?** **Yes** — flag/env/route/redaction/source-mode reads plus governance constants.
- **DTO schema?** Reuse the **existing M7C/M7E envelope** (`schemaVersion`, `environment`, `generatedAt`, `data.categories`, `redaction`, `freshness`, `authorizationContext`, `emptyState`, `warnings`). No new envelope shape is needed.
- **New TypeScript DTOs needed later?** Only if a future contract adds fields; not for C-01's first implementation.
- **schemaVersion handling clear?** Yes — today's synthetic version is `bcp.c01.readiness.v0-synthetic`; a code/config live version would adopt a new explicit label (e.g. a proposed `bcp.c01.readiness.v1`), decided at implementation. Not yet created.
- **generatedAt server-side only?** **Yes, binding** — ISO-validated, server-constructed, never echoed from a request.

## 13. Authorization Readiness Assessment

- **Server-derived principal requirement:** unchanged — authority only from a `source: 'server_derived'`, verified principal with a durable `internalUserId`.
- **Current synthetic principal limitation:** the first implementation keeps a **fixed** server-constructed principal (no live session resolver) — acceptable for a DEV-only code/config posture read.
- **Real principal wiring needed for first implementation?** **No** — and it must **not** be added here; real-principal wiring is a later, separately authorized milestone.
- **parityState:** stays **static/config/deferred** (see §9).
- **RBAC visibility:** represented safely via the existing visibility-class model (`overview_viewer` minimum for C-01); no raw permission/entitlement keys.
- **Fail-closed (binding):** missing/invalid principal ⇒ deny; unresolved parity ⇒ blocked; unknown contract/visibility ⇒ deny; denials collapse to one uniform shape. `internalUserId` stays server-internal and never appears in the DTO.

## 14. Isolation Readiness Assessment

- **Tenant/store scope:** none — C-01 is **platform-level**.
- **Can C-01 remain platform-level?** **Yes** — its sources are self-referential system posture.
- **Avoiding tenant/store existence leakage:** emit no counts/labels that imply which tenants/stores exist.
- **Safe empty states:** empty indistinguishable from hidden/redacted.
- **Cross-tenant fail-closed:** any cross-scope attempt fails closed.
- **Store scope rules if ever introduced:** would require server-side enforcement — not anticipated for C-01.

## 15. Redaction Readiness Assessment

- **Forbidden fields:** raw rows/IDs/`internal_user_id`/provider UIDs, raw audit logs, `identity_link` rows, raw auth claims, permission/entitlement key dumps, mismatch lists, secrets/tokens/DB URLs, billing/payment identifiers.
- **Label-only outputs:** all `category`/`status`/posture values are safe bounded labels (existing `safeLabel` allow-list).
- **Redaction metadata:** `redactionApplied`/`redactionLevel`/`omittedCategories`/`maskedCategories`, omissions reported as **generic categories** only.
- **Freshness metadata:** `generatedAt` (server-side) + freshness label.
- **Safe warnings:** safe labels only.
- **No raw source passthrough:** copy only allow-listed fields; never spread a raw source object.
- **Leak scan requirements:** implementation evidence must include a leak scan (no `postgres://`/`service_role`/`Bearer`/JWT/`@`-emails/raw IDs).
- **DTO sample rules:** synthetic placeholders only.

Synthetic/redacted DTO illustration (placeholder values only — **not** an implemented response):

```jsonc
{
  "schemaVersion": "bcp.c01.readiness.v1",            // PROPOSED future label — NOT implemented; today's synthetic version is bcp.c01.readiness.v0-synthetic
  "environment": "DEV",
  "generatedAt": "<server-time-iso>",                  // server-side only, ISO-validated
  "data": {
    "categories": [
      { "category": "route_foundation", "status": "ready",   "severity": "low" },
      { "category": "feature_flag",     "status": "ready",   "severity": "low" },
      { "category": "source_mode",      "status": "synthetic","severity": "low" },
      { "category": "redaction",        "status": "active",  "severity": "low" },
      { "category": "live_read_only",   "status": "blocked", "severity": "low" },
      { "category": "production",       "status": "blocked", "severity": "low" }
    ]
  },
  "redaction": { "redactionApplied": true, "redactionLevel": "standard", "omittedCategories": [], "maskedCategories": [] },
  "freshness": { "generatedAt": "<server-time-iso>", "lastSuccessfulReadLabel": "redacted" },
  "authorizationContext": { "visibilityClass": "overview_viewer", "scopeType": "platform", "environment": "DEV", "parityState": "ready" }, // parityState is a STATIC/config label here — NOT a live parity verification (see §9)
  "emptyState": { "isEmpty": false, "reason": "none" },
  "warnings": []
}
```

## 16. Implementation Boundary Recommendation

Implementation **is** recommended (Decision A), bound to this boundary:

**Likely files allowed later (DEV-only code/config implementation):**
- A new server-side **code/config posture reader** module under `server/bcp-pilot/**` (reads flag/env/route-constant/redaction/source-mode → safe labels; builds the source object the existing harness already consumes).
- The existing `bcpReadOnlyExpressAdapter.ts` adapted to supply the code/config source **in place of** the fixed `SYNTHETIC_SOURCE` (still server-constructed; still a fixed/synthetic-style principal).
- A new co-located test file mirroring the existing `*.test.ts` convention.

**Forbidden later (binding):**
- **No** DB/Supabase/provider calls · **no** `fetch`/network.
- **No** real-principal/live-session-resolver wiring.
- **No** route-registration change (the route, path, flag, gates, and isolated-API mounting stay as-is).
- **No** Backend CP UI adapter · **no** frontend fetch · **no** SaaS navigation exposure · **no** production exposure.
- **No** backend actions · **no** mutation · **no** audit/`identity_link` writes.
- **No** live-router introspection for S-2 (use the imported path constant).
- **No** live test/typecheck execution at request time for S-7/S-8 (evidence labels only).

The route stays **default-off, production-disabled, DEV-only, GET-only, isolated-API-only**; the change is solely swapping the fixed synthetic source object for a code/config posture reader feeding the same redacted envelope.

## 17. Future Test Plan

Required before accepting any implementation (none written here):

- Source inventory mapping tests (each emitted category maps to its declared S-1…S-6/S-9 source).
- Code/config source read tests (flag/env/route-constant/redaction/source-mode → expected labels).
- Source disabled/fallback tests (missing/odd config ⇒ safe label, no leak).
- Flag-gated route behavior preserved (default-off ⇒ unavailable).
- Production-disabled behavior preserved (production ⇒ unavailable, no existence disclosure).
- No client UID/email/body/query authority (hints proven ignored).
- Parity blocked/deferred/static-label tests (`parityState !== 'ready'` ⇒ blocked; static label path).
- Forbidden fields stripped (reported as generic categories).
- Safe empty state (empty indistinguishable from hidden).
- No DB/Supabase/provider imports (static import-scan assertion).
- No raw rows · no mutation · no audit/`identity_link` writes.
- No UI/frontend exposure (0 `src/**` refs; 0 fetch refs).
- The existing **61** tests remain passing.
- Typecheck: **0** new errors in touched files (baseline preserved).

## 18. Evidence Requirements

Future implementation must produce: exact files touched; exact sources used (per §5) + sensitivity classification; a no-DB/Supabase/provider import scan; a leak scan; a DTO sample with synthetic/redacted values only; tests passed (full count); typecheck result; no-mutation proof; no-production-exposure proof; no-UI-exposure proof; `git status`.

## 19. Explicitly Excluded Scope

Excluded from M7J: implementation; live read model code; API/route behavior change; DB connection; SQL/migration; Supabase access; live provider access; C-02 integration; Backend CP UI adapter; frontend fetch; SaaS navigation exposure; production exposure; live session auth; Supabase auth; Firebase→Supabase cutover; backend actions; mutation; audit/`identity_link` writes; raw `identity_link` rows; raw audit logs; raw auth claims; real tenant/store/customer details; billing/payment identifiers.

## 20. Risk Register

| ID | Risk | Severity | Mitigation | Blocks next milestone? |
|----|------|----------|------------|------------------------|
| R-1 | Source scope creep (posture grows into business data) | Medium | C-01 pinned to self-referential posture labels (§4 of M7I, §5 here); inventory fixes the source set | No |
| R-2 | Source ownership unclear | Low | §5 records owner surface + evidence location per source | No |
| R-3 | Source sensitivity underestimated | Medium | §5 forces sensitivity + forbidden-content per source; all S-1…S-9 are Low | No |
| R-4 | Accidental DB dependency | High | Import-scan assertion in tests; static scan today = NONE; boundary forbids DB imports | No |
| R-5 | Accidental Supabase dependency | High | Same import-scan assertion; Supabase stays dormant | No |
| R-6 | Parity source leakage | High | S-10 static/config label only; never reads identity (§9) | No |
| R-7 | Tenant/store leakage | High | C-01 platform-level; S-12 out of scope; no tenant/store sources | No |
| R-8 | Redaction gap | Medium | Reuse proven M7C/M7E strip+allow-list; redaction tests required | No |
| R-9 | DTO schema drift | Low | Reuse existing envelope; schemaVersion handling explicit (§12) | No |
| R-10 | Route becomes live too early | High | No route-registration change; synthetic→code/config source swap only; route stays default-off | No |
| R-11 | UI fetch added too early | Medium | No UI/fetch in implementation unless separately authorized; static scan (0 `src/**`) | No |
| R-12 | Real principal wiring too early | High | Fixed/synthetic-style principal retained; no live session resolver | No |
| R-13 | Production exposure drift | Medium | Production-disabled flag + DEV gate; preserved by tests | No |
| R-14 | Mutation leakage | High | GET-only handler; no write methods/helpers; no-mutation tests | No |

No risk blocks the recommended next milestone; the high-severity items are implementation **constraints/tests**, not present defects.

## 21. Stop Conditions

Halt and reassess (escalate toward Decision C) if any C-01 source ever: requires unreviewed DB access · requires Supabase MCP · requires SQL/migration · requires raw rows/IDs · reveals tenant/store existence · requires client UID/email authority · requires UI-side security filtering · requires a live session resolver change · requires Supabase auth/cutover · requires backend actions/mutation · or requires raw secrets/tokens/DB URLs/payment identifiers/key dumps/mismatch lists/auth claims/provider UIDs/`identity_link` rows.

## 22. Acceptance Criteria

M7J is acceptable when: the single review doc exists under `docs/` and is redaction-safe; it records an honest, evidence-grounded decision (A/B/C); it inventories and classifies S-1…S-12 (plus the inventory method, source table, and classification summary); it provides the S-1…S-5 code/config, S-6…S-9 documentation/evidence, S-10 parity, S-11 DB/Supabase, and S-12 tenant/store reviews, plus schema/authorization/isolation/redaction readiness assessments, an implementation-boundary recommendation, a future test plan, evidence requirements, excluded scope, a risk register, and stop conditions; it preserves all M1–M7I assumptions; it claims **no** live C-01 integration, **no** live session/Supabase auth, **no** production/cutover readiness; and **no** code/runtime/route/auth/DB/Supabase/UI change was made (nothing staged/committed/pushed/backed up).

## 23. Recommended Next Milestone

**Phase 2.0 M7K — DEV-only Code/Config C-01 Read Model Implementation** (per Decision A): implement a tightly-scoped, code/config-only C-01 read model on the existing inert route — replacing the fixed synthetic source object with a server-side code/config posture reader feeding the existing redacted envelope — with **no** DB/Supabase/provider access, **no** real-principal wiring, **no** route-registration change, **no** UI/frontend exposure, and **no** mutation. Parity stays a static/config label; S-11 stays blocked; S-12 stays out of scope. *(If the owner prefers a plan-first step, "Phase 2.0 M7K — C-01 Read Model Implementation Plan" is an acceptable more-conservative substitute.)*
