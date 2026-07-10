# Phase 3.0 M1 — Controlled Backend Actions Planning + Safety Model + Pilot Selection Gate

**Milestone:** Phase 3.0 M1
**Type:** Docs-only planning + safety-model + pilot-selection gate (no implementation, no action execution)
**Pre-change checkpoint (HEAD == origin/main):** `a7f9988ba6238e4455f224b61692a30f7723766a`
**Most recent committed milestone:** Phase 2.0 M58 — close out backend control panel real socket evidence
**Scope authority:** DEV-only, read-only Backend Control Panel (BCP) is now closed (Phase 2.0). Phase 3.0 introduces *controlled* backend actions **only behind a strict, code-grounded safety model.** Firebase authoritative; Supabase dormant/shadow/readiness-only; no cutover.

---

## 1. Executive Summary

M1 is a **docs-only planning gate** that defines how a controlled backend action can exist **without weakening the Phase 2.0 posture**. Fresh code inspection this turn confirms the platform already ships a **mature safety substrate to reuse** rather than rebuild:

- **Protected-action *pattern*** — `server/platform-identity/protectedAction.ts` (`withProtectedAction`, `RequiredPermission`, `ProtectedHandler`, `isDevDiagnosticsEnabled`) composes DEV gate → permission → advisory audit → handler. **Reused as a PATTERN only** (not as the pilot wrapper): its permission axis is `permissionDecision.ts` and it reads **dev-asserted request-body actor data**, which does not match the BCP "no request field is authority" posture. The pilot composes the BCP guard + the permission catalog itself with a **server-derived synthetic principal**.
- **Sanitized audit substrate** — `auditEventContract.ts` (`DurableAuditEventV1`, `AUDIT_METADATA_ALLOWLIST`, `AUDIT_FORBIDDEN_FIELDS`) + `auditEventWriter.ts` (`sanitizeAuditMetadata`, `validateAuditEventInput`). These are **pure/DB-free builders + sanitizers** — reusable for the pilot's **metadata**. Note: `buildAuthorizationDecisionAuditEvent` **builds** an event (it does not emit) and stamps `evidenceLevel: 'durable_compliance_event'`; `writeAuditEvent` is **DB-backed**. The pilot therefore uses the **advisory, DB-free, correctly-labeled** `buildAuditEnvelope` (`auditEnvelope.ts`, `dev_sidecar_log_advisory` / "NOT compliance evidence") — **never** the durable builder and **never** `writeAuditEvent`.
- **RBAC** — the BCP guard's `BcpVisibilityClass` (8 non-`none` classes across 7 ranks: `overview_viewer`=1 … `system_owner`=6; reads use the `overview_viewer` floor) plus `permissionCatalog.ts` **platform** ordering (`none<view<create<edit<approve<manage<full`, where `manage` outranks `approve`) with **read-only capping** (`capPlatformLevelForReadOnly`) that forces levels above `view` down under read-only/overdue plan states.

**Selected pilot:** **"Acknowledge Backend CP Readiness Review"** — a DEV-only, button-triggered (route-first), permission-gated (`system_owner` visibility floor **+** platform `manage` via `meetsPlatformPermissionLevel`), confirmation- and reason-captured controlled action whose **only** side effect is emitting **one advisory, sanitized, DEV-only audit marker to an injectable sink** (no DB write). It mutates **no** business data, needs **no** live provider, **no** live DB/Supabase dependency, **no** customer exposure — while exercising the full guardrail chain end-to-end.

**Decision: A — PHASE 3 CONTROLLED ACTION SAFETY MODEL LOCKED; PILOT IMPLEMENTATION PACKAGE READY.**

**Baselines (re-run fresh this turn):** BCP corpus **42/42 files, 1351/1351 assertions**; typecheck **12 total / 0 BCP-surface**; static scope scan clean. **No source/test/package/config change** in M1.

---

## 2. Preflight Result (Section A)

| # | Check | Result |
|---|-------|--------|
| 1 | Branch `main` | ✅ |
| 2 | HEAD & origin/main both `a7f9988…` | ✅ |
| 3 | ahead/behind 0/0 | ✅ |
| 4 | status only ` M .replit` + `?? goose…` | ✅ |
| 5 | `package.json` clean | ✅ |
| 6 | `package-lock.json` clean | ✅ |
| 7 | Nothing staged | ✅ |
| 8 | `.gitattributes` absent | ✅ |
| 9 | M58 commit present (`a7f9988`) | ✅ |
| 10 | HEAD == origin/main ⇒ pre-change checkpoint | ✅ |
| 11 | No implementation change during M1 | ✅ Held |
| 12 | Only the M1 doc may be created | ✅ Held |
| 13 | No commit/push/backup during M1 | ✅ Held |

Preflight **PASS**.

---

## 3. Files Created
- `docs/phase-3.0-controlled-backend-actions-m1-planning-safety-model-pilot-gate.md` (this document — the single allowed artifact).

## 4. Files Modified
- **None.** No source, test, frontend, backend, route, adapter, provider/read-model, guard, audit-writer, DB/Supabase, `package.json`, or `package-lock.json` file was modified.

## 5. Files Confirmed Untouched
All Phase 2.0 BCP surfaces (C-01…C-07), the shared guard, the audit stack, `server/platform-identity/server.ts`, `screens.tsx`, `App.tsx`, the C-07 card/client, `vite.config.ts` (post-M55), all tests, `package.json`/`package-lock.json`, `.replit`, `.gitattributes` (absent), goose tarball (untracked). Inspection was **read-only**.

---

## 6. Phase 2.0 Closeout Intake (Section B)

| # | Confirmation | Result |
|---|--------------|--------|
| 1 | M58 hash `a7f9988ba6238e4455f224b61692a30f7723766a` | ✅ |
| 2 | Subject "Phase 2.0 M58 close out backend control panel real socket evidence" | ✅ |
| 3 | Phase 2.0 BCP package closed | ✅ |
| 4 | Browser evidence accepted (M56) | ✅ |
| 5 | Real-socket evidence accepted (M58) | ✅ |
| 6 | BCP remains DEV-only | ✅ |
| 7 | BCP remains read-only | ✅ |
| 8 | Controlled actions deferred to Phase 3 | ✅ (now beginning) |
| 9 | Production readiness deferred to Phase 4 | ✅ |
| 10 | Firebase authoritative | ✅ |
| 11 | Supabase dormant/shadow/readiness-only | ✅ |
| 12 | No Firebase→Supabase cutover | ✅ |
| 13 | No live DB/Supabase/live-provider dependency introduced | ✅ |
| 14 | No customer-facing exposure introduced | ✅ |
| 15 | No production authority introduced | ✅ |

---

## 7. Controlled Backend Action Definition (Section C)

**A controlled backend action is** an intentional, bounded backend operation initiated from the Backend Control Panel that is gated by **environment + feature flag + server-side authorization + permission + confirmation + reason capture (when sensitive) + audit**, is explicitly visible to the operator before execution, is safely testable, is audited before and after, and is **reversible where possible or non-destructive by design.**

**Explicitly NOT a controlled action:** read-only data display; passive readiness signal; synthetic provider self-attestation; client-only UI state change; raw script execution; direct DB mutation without guardrails; production mutation; uncontrolled background job execution.

---

## 8. Phase 3 Action Taxonomy (Section D)

| # | Category | Phase-3 classification |
|---|----------|------------------------|
| 1 | Safe acknowledgement actions (audit-only) | **Eligible for Phase-3 pilot** |
| 2 | Dry-run / preview validation actions (no write) | **Eligible for Phase-3 pilot** |
| 3 | Regenerate/recompute *synthetic* readiness (code/config only) | Eligible later with guardrails |
| 4 | Controlled cache/refresh actions | Eligible later with guardrails |
| 5 | Controlled notification / test-message actions | Deferred (touches delivery/provider) |
| 6 | Controlled diagnostic snapshot actions (bounded, sanitized) | Eligible later with guardrails |
| 7 | Tenant/store-scoped maintenance actions | Deferred (tenant-data surface) |
| 8 | Destructive / irreversible actions | **Prohibited in Phase 3** |
| 9 | Production-impacting actions | **Prohibited in Phase 3** |
| 10 | Live provider / payment / shipping / external-API actions | **Prohibited in Phase 3** |

Recommended pilot categories = **#1 (acknowledgement, audit-only)** and #2 (dry-run) — low-risk, non-destructive, DEV-only, auditable.

---

## 9. Hard Prohibitions (Section E)

Early Phase-3 **prohibits**: production mutations; customer-facing actions; payment/provider live actions; shipping-label purchases; refunds; inventory-quantity mutation; tenant deletion; user deletion; permission elevation; role assignment; DB schema changes; Supabase auth enablement; Firebase→Supabase cutover; secret/env exposure; raw SQL execution; unbounded script execution; bulk mutation; **any** action without audit; without confirmation; without reason capture when sensitive; that bypasses RBAC; or that writes to a live DB unless separately planned and explicitly approved.

**Additional hard prohibition (reconciled from review):** the DEV-only injectable audit sink must **never** fall back to `writeAuditEvent`, `getDb()`, any durable DB/Supabase audit table, or any production/provider sink. A DEV-sink event must **never** be stamped `durable_compliance_event` (use the advisory `dev_sidecar_log_advisory` label). The **reason** free-text must **never** be echoed raw into `humanReadableReason` — it must be bounded + sanitized in the handler first (see §12).

---

## 10. Controlled Action Guardrail Model (Section F)

Every controlled action MUST satisfy all 24 guardrails: (1) DEV-only gate unless later promoted; (2) feature flag (default OFF); (3) server-side authorization (guard); (4) permission check; (5) readable action title; (6) clear action scope; (7) dry-run/preview where feasible; (8) confirmation step; (9) reason capture for sensitive actions; (10) idempotency/duplicate-prevention where applicable; (11) bounded input validation; (12) bounded output DTO; (13) no raw logs/stack traces exposed; (14) safe unavailable/error states; (15) audit event before and after execution where applicable; (16) actor/principal traceability; (17) tenant/store boundary check where applicable; (18) no customer-facing route exposure; (19) no browser auto-execution; (20) button-triggered only; (21) no `useEffect` action execution; (22) no action on page load; (23) test coverage for allowed AND denied paths; (24) evidence report after implementation.

**Reuse mapping (code-grounded):** the ordered self-gate mirrors the accepted C-07 route pattern (DEV gate → flag → method → guard), extended with confirmation + bounded/sanitized reason + before/after advisory audit. The pilot **mirrors the `withProtectedAction` pattern** but does not use it as the wrapper (it reads request-body actor data; the pilot uses a server-derived synthetic principal).

**Idempotency (explicit, reconciled from review):** the acknowledgement is a **repeatable, append-only advisory audit marker with a correlation key** (actor-type + lens + confirmation), not a deduplicated write — each ack is intentionally a distinct event, so no dedupe is required; the correlation key is captured for traceability, not for suppression.

**Guardrails deferred until UI or promotion (reconciled from review):** rate-limiting and CSRF/same-origin protection are **not** required for the route-first, DEV-only, `system_owner`-only, audit-only pilot, but **must** be added before any UI (Option B) or any promotion beyond DEV.

---

## 11. Authorization / RBAC / Permission Model (Section G)

| # | Question | Plan |
|---|----------|------|
| 1 | Reuse which guard? | The BCP `authorizeBcpRead` fail-closed guard pattern (`bcpAuthorizationGuard.ts`) — server-derived verified principal only — **extended** to an action-authorization decision (a parallel `authorizeBcpAction`-style entry, NOT a mutation of the frozen read guard). |
| 2 | New controlled-action permission namespace? | **No new catalog namespace in M2** (catalog changes are excluded). The action gate maps to an **existing platform permission-level check** (`meetsPlatformPermissionLevel` at `manage`+) **combined with** the BCP `system_owner` visibility floor — so an action can never be granted implicitly by read visibility. A dedicated `bcp.action.*` catalog key, if ever wanted, is a **separate, explicitly-authorized** catalog change (not in the pilot). |
| 3 | Require manage/full (not view)? | **Yes** — actions require platform **`manage`** (or higher) via `permissionCatalog.ts` `meetsPlatformPermissionLevel`, plus the guard's **`system_owner`** visibility floor. Read floor is only `overview_viewer`; actions sit far above it. |
| 4 | Sensitive actions require reason capture? | Yes — bounded, sanitized free-text reason, validated and audit-recorded (never raw-echoed). |
| 5 | System Owner only for early pilot? | **Yes** — the pilot defaults to `system_owner` only. |
| 6 | Security/Operations Admin view-not-execute? | Yes initially — lower classes may see the action exists (DEV) but are denied execution (fail-closed 403). |
| 7 | Conservative role defaults? | Yes — default OFF everywhere; opt-in flag; `system_owner` floor; read-only capping (`capPlatformLevelForReadOnly`) forces execute/manage false under read-only/overdue plan states. |
| 8 | Represent denied attempts? | Safe closed-enum `not_authorized` / `feature_disabled` / `dev_only`, no data. |
| 9 | Audit denied attempts? | Yes — `buildAuthorizationDecisionAuditEvent` already emits a sanitized authorization-decision audit for allow AND deny. |
| 10 | Permission tests structure? | Allowed-path (system_owner+manage) + denied-path (insufficient visibility, insufficient permission, flag off, production, non-POST) as discrete cases. |

No permissions are implemented in M1.

---

## 12. Audit Model (Section H)

Reuse the existing durable audit contract; for each controlled action emit a **sanitized** event capturing safe summaries only: action key; action title; actor/principal type; authorization result; scope summary; reason (if required, bounded+sanitized); confirmation acknowledged; result classification; safe error classification if failed; timestamp (handled by existing audit infra); correlation/idempotency key if applicable.

- **Forbidden by construction — for METADATA only (corrected from review):** `AUDIT_FORBIDDEN_FIELDS` + `AUDIT_METADATA_ALLOWLIST` + `sanitizeAuditMetadata`/`validateAuditEventInput` block secrets, raw bodies, cookies, tokens, stack traces, and command output **in the `metadata` map**. They do **not** auto-sanitize the free-text **reason**: `humanReadableReason`/`reasonCode` are validated as non-empty strings only (no length cap, no redaction), and `reason` is not an allow-listed metadata key. **Binding M2 requirement:** the handler must **bound + sanitize the reason itself** (length cap + safe-label denylist, mirroring the C-07 `safeLabel` approach) and must **never** place raw reason text into `humanReadableReason`.
- **Builder vs emitter (corrected from review):** `buildAuthorizationDecisionAuditEvent` **builds** an event and stamps `evidenceLevel: 'durable_compliance_event'` — it does **not** emit, and `writeAuditEvent` is DB-backed. Routing a durable-labeled event to a non-persisted DEV sink would **mislabel** it. The pilot therefore uses the **advisory, DB-free** `buildAuditEnvelope` (`auditEnvelope.ts`, correctly labeled `dev_sidecar_log_advisory` / "NOT compliance evidence") and its own **injectable sink interface** — never the durable builder, never `writeAuditEvent`/`getDb`.
- **Append-only:** yes — the advisory marker is append-only; each ack is a distinct event.
- **Tests required:** audit-event-**shape** test (allowlisted metadata only, forbidden fields absent, reason bounded/sanitized, `dev_sidecar_log_advisory` label — NOT `durable_compliance_event`) and audit-**emitted-on-attempt** + **emitted-on-result** tests **including the denied path** (deny still emits an authorization-decision audit).
- **No-live-DB nuance (binding):** the pilot reuses the audit event *contract + metadata sanitizers* but targets a **DEV-only injectable advisory sink** (in-memory/no-op), **not** the durable Supabase/DB audit table — demonstrating the full emission chain **without a live DB/Supabase dependency**, with a hard prohibition against any fallback to `writeAuditEvent`/`getDb`. Durable audit persistence is a **separate, later, explicitly-approved** step.

---

## 13. Pilot Action Candidate Evaluation (Section I)

| Candidate | Risk | Mutation | Audit value | Reversible | Testability | Tenant/store | Prod | DB/Supabase | Live provider | Fits M2? |
|-----------|------|----------|-------------|-----------|-------------|--------------|------|-------------|---------------|----------|
| **1. Acknowledge readiness review** | **Low** | **None** (audit-only) | **High** | N/A (no state) | **High** (pure) | None | None | **None** (DEV sink) | No | **✅ Best** |
| 2. Regenerate synthetic readiness snapshot | Low | None (recompute code/config) | Medium | N/A | High | None | None | None | No | Eligible later |
| 3. Dry-run validation of a readiness check | Very low | None | Low (no state change) | N/A | High | None | None | None | No | Eligible later |
| 4. Mark a BCP signal as reviewed | Low | None (audit-only) | High | N/A | High | None | None | None (DEV sink) | No | ≈ #1 |
| 5. Create DEV-only audit marker for operator confirmation | Low | None (audit-only) | High | N/A | High | None | None | None (DEV sink) | No | = mechanism of #1 |

---

## 14. Selected Pilot Action (Section I)

**Pilot: "Acknowledge Backend CP Readiness Review."** The operator explicitly acknowledges (confirms) that a named readiness lens (e.g. C-07) was reviewed; the **only** effect is emitting one sanitized audit event to a DEV-only injectable sink.

Meets every preferred pilot property: DEV-only; non-destructive; no external provider; no live DB/Supabase dependency; button-triggered (route-first); audit-emitting; permission-gated (`system_owner` + platform `manage`); reason-captured; easy to test (pure handler); compatible with the existing BCP architecture and the `withProtectedAction`/audit substrate.

---

## 15. Pilot Implementation Package Lock (Section J)

Exact package for **M2** — additive; mirrors the accepted C-07 read-only pattern but for a bounded POST action; **all NEW files except one additive mount line.** Corrected from review: a **new action-guard file** and a **new injectable audit-sink interface** are added so the frozen read guard (`bcpAuthorizationGuard.ts`) is **never mutated** and `server.ts` remains the **only** existing-file touch.

- **NEW** `server/bcp-pilot/bcpActionAuthorizationGuard.ts` — the action-authorization decision (server-derived synthetic principal → `system_owner` visibility floor **+** platform `manage` via `meetsPlatformPermissionLevel`). A **new parallel** entry — it does **not** import-mutate or fork the frozen `bcpAuthorizationGuard.ts`; pure, fail-closed, no-throw.
- **NEW** `server/bcp-pilot/bcpActionAuditSink.ts` — the DEV-only **injectable advisory audit-sink interface** + an in-memory/no-op default. Builds via `buildAuditEnvelope` (advisory, `dev_sidecar_log_advisory`), reuses `sanitizeAuditMetadata`; **hard-prohibited** from calling `writeAuditEvent`/`getDb` or any durable/provider sink.
- **NEW** `server/bcp-pilot/bcpActionAcknowledgeReadinessReview.ts` — pure controlled-action handler (ordered gates: DEV → flag → method → action-guard/permission → confirmation → **handler-bounded+sanitized reason** → build advisory audit marker → injectable DEV sink → bounded result DTO). No I/O, no live DB, no provider.
- **NEW** `server/bcp-pilot/bcpActionAcknowledgeReadinessReviewExpressAdapter.ts` — thin `app.post` adapter (gates-first; server-supplied deps; no request field is authority).
- **NEW** `server/bcp-pilot/bcpActionAcknowledgeReadinessReview.test.ts` — handler tests (flag-off, dev-only, denied×{visibility,permission}, allowed, confirmation-required, reason-required+**handler-sanitized+capped**, bounded-input, safe-error DTO, audit-emitted attempt+result **incl. denied-path**, no-mutation, no-forbidden-fields, advisory-label-not-durable).
- **NEW** `server/bcp-pilot/bcpActionAcknowledgeReadinessReviewExpressAdapter.test.ts` — adapter tests (gates resolved before handler; no request authority; **non-POST → Express 404** at the `app.post` mount, i.e. Express rejects the method, not the adapter — adjust the assertion accordingly).
- **NEW** `server/bcp-pilot/bcpActionRouteRegistration.test.ts` — mount registration (POST mounted exactly once via constant; no wildcard/catch-all shadow; no frontend import of backend action modules; no customer/SaaS-nav registration).
- **MODIFY (1 additive line)** `server/platform-identity/server.ts` — `app.post(BCP_ACTION_ACK_ROUTE_PATH, createBcpActionAcknowledgeReadinessReviewHandler({...server-owned deps incl. injected DEV sink...}))`. This is the **one existing-file touch**; additive, follows the exact established mount pattern (mounted once, via a route-path constant, inside `createPlatformIdentityApp` before `return app`), adds no authority to existing routes, and **requires explicit M2 authorization**. Justification: minimal, boundary-preserving, no change to any existing route/handler.

**Excluded from the package (hard):** `package.json`, `package-lock.json`, any DB/Supabase file, `writeAuditEvent`/`getDb`, migrations, seeds, `.replit`, `.gitattributes`, the frozen `bcpAuthorizationGuard.ts` (extended via the new parallel file, never mutated), any frozen C-01…C-07 read surface, any frozen frontend card/client/`screens.tsx`/`App.tsx`, `permissionCatalog.ts` (no new catalog key). UI is **out of the pilot** (route-first) — deferred to keep M2 minimal and fully testable.

Exact paths are lockable now (naming + pattern verified against the existing `bcp-pilot` tree). M2 should re-confirm the mount-site adjacency before editing `server.ts`.

---

## 16. Test / Evidence Plan for M2+ (Section K)

**Required tests (allowed AND denied):** action hidden when flag off; denied when unauthorized (visibility<system_owner OR permission<manage); allowed when authorized; requires confirmation; requires reason (sensitive); validates bounded input; safe unavailable/error DTO; audit event emitted on attempt; audit event emitted on success/failure; no raw details in DTO; no mutation beyond intended bounded scope (audit-only); no auto-execution from UI; button-triggered only; production gate remains closed; no customer-facing navigation exposure.

**Evidence after implementation:** unit tests (handler); route/adapter tests; authorization/permission tests; audit tests (shape + emission); static scans; typecheck (0 new errors); **optional real-socket POST evidence** (like M58's GET evidence — flag-off → SAFE UNAVAILABLE, flag-on+authorized → SAFE SUCCESS audit-only); owner smoke **only if** UI is later added (route-first pilot needs none).

---

## 17. Combined Milestone Strategy (Section L)

**Recommended: Option A — M2 = combined implementation + tests + evidence.** The pilot qualifies: exact package is small; no DB/Supabase/live-provider changes; no package changes; no frozen-surface risk beyond the single additive `server.ts` mount line (explicitly authorized in M2); tests can fully cover the pure handler + adapter; no raw-artifact risk; implementation stays DEV-only and audit-only.

If the owner later wants a UI button, that becomes **Option B** (M2 route+tests+socket evidence; M3 UI + owner smoke). The route-first pilot keeps Option A clean.

---

## 18. Test / Typecheck / Static Scan Reconfirmation (Section M)

**Re-run fresh this turn.**

| Item | Expected | Observed | Status |
|------|----------|----------|--------|
| BCP corpus | 42/42, 1351/1351 | **42/42 files, 1351/1351 assertions, 0 fails** | ✅ RUN |
| Typecheck total | 12 | **12** | ✅ RUN (unchanged) |
| Typecheck BCP-surface | 0 | **0** | ✅ RUN |

**Static scope scan:** no change to package files, browser tooling, source/test files, C-07 card, C-07 client, `screens.tsx`, backend frozen surfaces, or `vite.config.ts` (post-M55). `git status` shows only ` M .replit`, the new M1 doc, and the untracked goose tarball.

---

## 19. Independent Review Results (Section N)

Verdicts captured and reconciled below. All families participated: a VoltAgent specialist subagent, a cross-model reviewer, and an in-context verification skill. Both external lenses **approved the direction** with precision findings; **no BLOCK**. All findings were reconciled into this doc (documentation-only) as corrections + binding M2 requirements.

| Pass | Lens | Verdict | Reconciliation |
|------|------|---------|----------------|
| 1 | Controlled-action safety / guardrail / RBAC review (independent security lens) | **CONCERNS** (approve the direction; no BLOCK) | Verified every reuse claim against code (`protectedAction.ts:82-171`, `auditEventContract.ts`, `auditEventWriter.ts`, `permissionCatalog.ts`, `bcpAuthorizationGuard.ts`); confirmed the RBAC floor is genuinely stricter, the no-live-DB pilot honest, and the pilot non-destructive. **Findings applied (docs-only):** (a) **action-guard file-home inconsistency** — §15 now adds a **new** `bcpActionAuthorizationGuard.ts` so the frozen read guard is never mutated and `server.ts` stays the only existing-file touch (§15/§22/§25#2); (b) **reason not writer-sanitized** — §12/§9 now require handler-side bound+sanitize, raw reason never in `humanReadableReason`; (c) **durable-label mislabel** — §1/§12 now use the advisory `buildAuditEnvelope` (`dev_sidecar_log_advisory`), never the durable builder/`writeAuditEvent`; (d) **platform vs tenant permission ordering** — §1/§11 now cite the platform ordering (`…approve<manage<full`); (e) `app.post`→Express-404 method-gate test note (§15); (f) rate-limit/CSRF deferred-until-UI note (§10/§25#7). |
| 2 | Pilot-selection + implementation-package + no-overclaim review (cross-model, gpt-5.5/high) | **CONCERNS** (pilot sound, Decision A directionally justified; no overclaim) | Converged with Pass 1: pilot choice sound; no production/live-data/security-certification overclaim; posture not weakened. **Findings applied:** `withProtectedAction` reused as a **pattern only** (it reads request-body actor data) → §1/§10; audit builder **builds ≠ emits**, `writeAuditEvent` DB-backed → §1/§12; `bcp.action.*` catalog namespace replaced with an **existing platform permission-level check** (no catalog change) → §11#2; **hard prohibition** on DEV-sink→`writeAuditEvent`/`getDb`/provider fallback → §9; idempotency made explicit (repeatable advisory marker + correlation key) → §10. |
| 3 | In-context verification-before-completion (named superpowers skill) — evidence-for-every-claim | **PASS** | Every reuse claim is backed by this-turn code inspection (exports grepped from the named files); baselines re-run this turn (42/42, 1351/1351; typecheck 12/0) with no code changed after; git state verified; §19 verdicts are the actual reviewer outputs (no fabrication). |

Findings that would require source/test/runtime/package changes are recorded as **binding M2 requirements** in §12/§15/§25, never applied in M1. **Net effect:** the safety model and pilot are unchanged; the package gained one new guard file and one new sink-interface file, and several claims were made precise. Both lenses' stated path to **APPROVE** is satisfied by these documentation corrections + the enumerated M2 requirements.

---

## 20. M1 Decision (Section O)

**Decision A — PHASE 3 CONTROLLED ACTION SAFETY MODEL LOCKED; PILOT IMPLEMENTATION PACKAGE READY.** The safety model, taxonomy, hard prohibitions, guardrails, RBAC/permission model, audit model, selected pilot, exact file package, test/evidence plan, and combined-milestone strategy are all locked and code-grounded.

---

## 21. Selected Next Path
**Phase 3.0 M2 — Controlled Action Pilot Implementation + Tests + Evidence** (Option A), implementing the "Acknowledge Backend CP Readiness Review" audit-only pilot per the locked package.

## 22. Allowed Files for the Next Milestone (M2)
The **seven NEW** `server/bcp-pilot/` files listed in §15 — `bcpActionAuthorizationGuard.ts`, `bcpActionAuditSink.ts`, `bcpActionAcknowledgeReadinessReview.ts`, `bcpActionAcknowledgeReadinessReviewExpressAdapter.ts`, `bcpActionAcknowledgeReadinessReview.test.ts`, `bcpActionAcknowledgeReadinessReviewExpressAdapter.test.ts`, `bcpActionRouteRegistration.test.ts` — plus the **single additive mount line** in `server/platform-identity/server.ts` (explicitly authorized; the only existing-file touch). Optionally the M2 evidence doc.

## 23. Prohibited Files for the Next Milestone
`package.json`, `package-lock.json`, dependency installs, any DB/Supabase file, migrations, seeds, browser tooling, any frozen C-01…C-07 read surface, the shared read guard (extend via a new parallel entry, do not mutate), the C-07 card/client, `screens.tsx`, `App.tsx`, SaaS navigation, `.replit`, `.gitattributes`, goose tarball; no screenshots/logs/traces/videos/HAR/raw artifacts.

---

## 24. Non-Readiness Statements (Section P)

M1 is **not**: controlled-action implementation; production readiness; customer-facing release; Phase 4 production readiness; live DB/Supabase readiness; live-provider readiness; Supabase auth enablement; Firebase→Supabase cutover; security certification. Firebase remains authoritative; Supabase remains dormant/shadow/readiness-only; BCP remains DEV-only unless separately promoted. M1 modifies no code and executes no action.

---

## 25. Risks / Accepted Residuals

1. **`server.ts` mount touch (M2)** — one additive POST line in an existing (accepted mount-site) file; additive and boundary-preserving; the **only** existing-file touch in the pilot; requires explicit M2 authorization.
2. **Action guard is a NEW file, not a guard mutation (resolved from review)** — the action-authorization decision lives in a **new** `server/bcp-pilot/bcpActionAuthorizationGuard.ts` (§15), so the frozen `bcpAuthorizationGuard.ts` is never mutated and the "single existing-file touch" claim holds. (An earlier draft omitted this file, creating an internal inconsistency; corrected.)
3. **DEV-only injectable advisory audit sink** — the pilot demonstrates emission via `buildAuditEnvelope` (advisory, `dev_sidecar_log_advisory`) to an injectable sink, with a **hard prohibition** on any fallback to `writeAuditEvent`/`getDb`; the reason is bounded+sanitized in the handler (not by the writer); durable/Supabase persistence is deferred and separately approved.
4. **No UI in the pilot** — route-first; UI + owner smoke deferred (Option B) if the owner later wants a button.
5. **Prior Phase-2 residuals unchanged** — optional exact-development tightening; low-severity non-production exposure; stale frozen-card comment; no card-render test; 12 unrelated typecheck baseline errors.
6. Phase 3 controlled actions (beyond the pilot) and Phase 4 production readiness remain deferred.
7. **Rate-limiting + CSRF/same-origin deferred** — not required for the route-first, DEV-only, `system_owner`-only, audit-only pilot, but mandatory before any UI (Option B) or promotion beyond DEV.
8. **Reason free-text sanitization is a handler responsibility** — the audit writer sanitizes metadata only; M2 must bound+sanitize the reason in the handler and keep raw reason out of `humanReadableReason`.

---

## 26. Git Status (Section Q verification)

Expected and observed working-tree state:

```
 M .replit
?? docs/phase-3.0-controlled-backend-actions-m1-planning-safety-model-pilot-gate.md
?? goose-x86_64-unknown-linux-gnu.tar.bz2
```

Verification (Section Q): only the M1 doc created; no source/test/frontend/card/`screens.tsx`/`App.tsx`/SaaS-nav/client/backend-frozen/transport-matrix/`vite.config.ts`(post-M55)/`package.json`/`package-lock.json`/DB/Supabase change; no browser tooling; no artifacts staged; `.replit` unstaged/untouched; goose untracked; `.gitattributes` absent; results reported honestly. ✅ All held.

---

## 27. No Commit / Push / Backup Confirmation
M1 performs **no commit, no push, and no backup.** Nothing is staged. The single M1 doc remains untracked pending owner review.

## 28. Acceptance Recommendation
**Recommend acceptance of M1 as Decision A.** The controlled-action safety model is strict, reuses the existing protected-action/audit/RBAC substrate, defines hard prohibitions and 24 guardrails, selects a minimal audit-only DEV pilot, locks a small additive file package, and plans full allowed/denied test coverage — with no code change, no overclaim, and baselines green.

## 29. Recommended Next Step
**Phase 3.0 M1 — Scoped Commit and Backup Authorization** (commit only this M1 doc; scoped staging; fast-forward non-force; backup report; stop for owner review). Then **Phase 3.0 M2 — Controlled Action Pilot Implementation + Tests + Evidence** (Option A).
