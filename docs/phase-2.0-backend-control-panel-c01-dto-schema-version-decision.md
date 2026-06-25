# Phase 2.0 M7N — Backend Control Panel C-01 DTO / Schema Version Decision

**Status:** Decision/documentation-only · Decides how C-01 should evolve from the harness-owned `v0-synthetic` envelope to an honest code/config DTO contract (no code change)
**Accepted checkpoint at authoring:** `8e49ee9f049229ee29c1526f9e382cf235be8ce4` (Phase 2.0 M7M)
**Authoring milestone:** Phase 2.0 M7N

> Redaction-first. No real tenant/store/customer data, raw IDs, emails, domains,
> DB URLs, tokens, secrets, payment identifiers, permission/entitlement key lists,
> mismatch lists, raw auth claims, raw provider UIDs, or raw `identity_link` rows.
> All DTO values shown are **synthetic placeholders only**. This milestone implements
> **nothing**: no DTO/schema change, no read-model/UI/client change, no route change,
> no DB/SQL/Supabase access. Nothing is staged, committed, pushed, or backed up.

---

## 1. Executive Summary

C-01 DTO/schema evolution **is ready to request** as a tightly-scoped, backend-only, additive change. The mismatch the M7M QA flagged is real but cosmetic: the code/config read model still ships under the harness-owned `bcp.c01.readiness.v0-synthetic` schemaVersion + `synthetic` warning, while the true source mode is conveyed only in-band as `synthetic_live_boundary_posture: code_config_only`. The decisive enabler is that **the existing UI parser is already version-agnostic** — it recognizes the envelope by `typeof schemaVersion === 'string' && 'data' present` and derives the source mode from a category, so a new `v1-code-config` schemaVersion + a first-class `sourceMode` field + a `code_config` warning can be introduced **additively without breaking the card**. The change touches only `server/bcp-pilot/**` (harness + handler + adapter), requires **no** route-registration change, **no** UI-breaking change, **no** DB/Supabase/provider access, **no** mutation, and **no** production exposure. Decision: **Decision A — READY TO REQUEST ADDITIVE C-01 DTO / SCHEMA VERSION IMPLEMENTATION** (recommended contract = Option 4 + Option 3: additive v1 with a version-tolerant parser and a clearer source/warning vocabulary, with the synthetic test path retained on `v0-synthetic`).

## 2. Current State and Boundary

- Route (unchanged): `GET /dev/bcp/readiness-summary` on the isolated platform-identity API; default-off (`ENABLE_BCP_DEV_READONLY_PILOT`); production-disabled; DEV-only; GET-only for success; code/config posture source only.
- Frontend: DEV-only, read-only, button-triggered C-01 Live Preview card in the Backend CP Readiness Gate screen; same-origin dev proxy `/__identity/dev/bcp/readiness-summary`.
- No DB/Supabase/provider/live source; no C-02; no backend action/mutation; no production exposure.
- Global constraints unchanged: Firebase/legacy AccessContext remains current authority; Supabase dormant/readiness-only, not ready for cutover; controlled actions Phase 3; production readiness Phase 4.

## 3. Decision

**Decision A — READY TO REQUEST ADDITIVE C-01 DTO / SCHEMA VERSION IMPLEMENTATION.**

Justification (conservative):

- **Safely implementable additively.** The DTO *shape* (M3 envelope) is unchanged; the change is (a) a new schemaVersion value on the code/config path, (b) a first-class `sourceMode` field, and (c) a clearer warning/freshness vocabulary — all additive, all backend-only.
- **No UI breakage.** The parser (`classifyC01Response`, `bcpC01Client.ts:119`) is version-agnostic: it accepts any string `schemaVersion` with `data` present and reads `sourceMode` from the `synthetic_live_boundary_posture` category. A new version + a new top-level `sourceMode` field is forward-compatible; the card keeps rendering safe labels.
- **No route/registration/DB/Supabase/mutation/production change.** The change is confined to `server/bcp-pilot/**` (harness + pure handler + thin adapter); `server/platform-identity/server.ts` and route registration stay untouched.
- **Why not Decision B:** compatibility (version-agnostic parser — verified), naming (concrete recommendations below), warning vocabulary (`code_config`), and migration risk (additive, low) are all resolved — manufacturing more design would be unjustified caution.
- **Why not Decision C:** the current state is safe (M7M PASS); there is no exposure, unsafe rendering, compatibility breakage, or misleading-QA *defect* — only a labeling-honesty improvement. Nothing to repair.

## 4. Current DTO Review

| Aspect | Current behavior | Source |
|---|---|---|
| schemaVersion | `bcp.c01.readiness.v0-synthetic` (constant, shared by synthetic + code/config paths) | `bcpReadinessSummaryHarness.ts:23` |
| warning vocabulary | `warnings: ['synthetic']` (both empty/blocked and success paths) | harness `:187,:237` |
| source-mode indication | in-band only: category `synthetic_live_boundary_posture` = `code_config_only` | `bcpC01CodeConfigReadModel.ts:69` |
| freshness label | `lastSuccessfulReadLabel: 'synthetic-no-live-read'` | harness `:172` |
| categories | safe `{category,status,severity}` posture labels (S-1…S-6/S-9) | read model |
| UI rendering assumption | envelope recognized by `schemaVersion` string + `data` present; `sourceMode` derived from the category | `bcpC01Client.ts:119,129` |
| redaction behavior | harness strips forbidden keys + content-validates labels; client re-validates (charset + denylist + id-shape) | harness + client |
| backward compatibility | parser is **version-agnostic** — any schemaVersion string renders; unknown/odd → safe states | `bcpC01Client.ts:116-146` |

## 5. Problem Statement

The code/config read model is a *real* read of current DEV server posture (flag/route/env/redaction/source-mode), yet the envelope it returns is still labeled with the **synthetic-era** vocabulary: `schemaVersion: …v0-synthetic`, `warnings: ['synthetic']`, freshness `synthetic-no-live-read`. The true source mode is only discoverable in-band (`code_config_only` category). This is **safe** (no data/exposure issue — confirmed by M7M QA) but **semantically misleading** for future QA/readiness packages and machine consumers that key off `schemaVersion`/`warnings`. The goal is an honest, additive contract that names the code/config source at the envelope level without breaking the existing card or touching the route.

## 6. Proposed DTO / Schema Options

**Option 1 — Keep current `v0-synthetic` envelope for now.**
- *Pros:* zero change; zero risk. *Cons:* preserves the misleading labels; defers the M7M follow-up indefinitely. *Risk:* none. *Compat:* full. *Test impact:* none. *Verdict:* **Not recommended** (does not resolve the follow-up).

**Option 2 — Add a new code/config `schemaVersion`, preserve the shape.**
- *Pros:* honest version label; shape unchanged; UI already version-agnostic. *Cons:* alone, leaves `warnings: ['synthetic']` still misleading. *Risk:* low. *Compat:* full (parser tolerant). *Test impact:* add v1-accept test. *Verdict:* **Recommended as part of the contract** (combine with Option 3).

**Option 3 — Add new `sourceMode`/warning vocabulary, keep schemaVersion stable.**
- *Pros:* fixes the `synthetic` warning honesty; a first-class `sourceMode` field is cleaner than the in-band category. *Cons:* alone, leaves the schemaVersion saying `v0-synthetic`. *Risk:* low. *Compat:* full (additive field; client can fall back to the category). *Test impact:* add sourceMode/warning tests. *Verdict:* **Recommended as part of the contract** (combine with Option 2).

**Option 4 — Additive v1 DTO with a backward-compatible UI parser.**
- *Pros:* the complete, honest contract (new schemaVersion + `sourceMode` + `code_config` warning + freshness label), shape-additive, parser stays tolerant of both v0 and v1. *Cons:* touches the harness + handler + adapter (still backend-only, no route change). *Risk:* low, well-bounded. *Compat:* full; v0 (synthetic test path) and v1 (code/config path) coexist. *Test impact:* v0-still-accepted + v1-accepted + unknown-version-safe tests. *Verdict:* **RECOMMENDED** — this is the target (it *is* Option 2 + Option 3 delivered together with a documented compatibility contract).

## 7. Recommended DTO Contract

Target envelope for the **code/config path** (synthetic test path keeps the v0 values). Synthetic placeholders only — **not** an implemented response:

```jsonc
{
  "schemaVersion": "bcp.c01.readiness.v1-code-config",  // NEW value on the code/config path; synthetic path stays v0-synthetic
  "sourceMode": "code_config",                          // NEW first-class field (mirrors the in-band category)
  "environment": "DEV",
  "generatedAt": "<server-time-iso>",                   // server-side only, ISO-validated
  "data": { "categories": [ { "category": "feature_flag_posture", "status": "enabled", "severity": "low" } ] },
  "redaction": { "redactionApplied": true, "redactionLevel": "standard", "omittedCategories": [], "maskedCategories": [] },
  "freshness": { "generatedAt": "<server-time-iso>", "lastSuccessfulReadLabel": "code-config-no-live-read" },
  "authorizationContext": { "visibilityClass": "overview_viewer", "scopeType": "platform", "environment": "DEV", "parityState": "ready" },
  "emptyState": { "isEmpty": false, "reason": "none" },
  "warnings": ["code_config"]                           // was ['synthetic']; clearer source label
}
```

- **schemaVersion:** `bcp.c01.readiness.v1-code-config` (code/config path). Parameterize the harness so the synthetic test path keeps `bcp.c01.readiness.v0-synthetic`.
- **sourceMode:** new top-level `code_config` (also retain the `synthetic_live_boundary_posture` category for back-compat).
- **generatedAt / environment / categories / redaction / freshness / authorizationContext / emptyState:** unchanged shape; `freshness.lastSuccessfulReadLabel` → `code-config-no-live-read` on the code/config path.
- **warnings:** `['code_config']` on the code/config path; `['synthetic']` retained on the synthetic test path.
- **safe error/blocked states:** unchanged (generic `{status:'error'}`; non-allow guard ⇒ safe empty envelope).
- **forbidden fields:** unchanged binding list (see §9) — no new field may carry sensitive data; `sourceMode` is a bounded label only.

## 8. Backward Compatibility Plan

| Input | Required handling |
|---|---|
| Current v0 response (`v0-synthetic`, `['synthetic']`, no top-level `sourceMode`) | Still accepted/rendered; `sourceMode` derived from the `synthetic_live_boundary_posture` category (current fallback) |
| Proposed v1 response (`v1-code-config`, `sourceMode: code_config`, `['code_config']`) | Accepted/rendered; prefer the top-level `sourceMode` |
| Unknown/future schemaVersion (string) | Still rendered as success (parser keys on string + `data`); **must not** fail-closed to error on an unrecognized version (preserves forward-compat) |
| Missing `sourceMode` | Fall back to the in-band category; if absent too, show `unknown` (safe label), never raw |
| Unexpected categories | Ignored unless `{category,status}`-shaped; values content-validated → unsafe ⇒ `redacted` |
| Malformed warnings | Each warning `safeLabel`-sanitized; `redacted` entries filtered out |
| Disabled/unavailable/error states | Unchanged (`feature_disabled`/`dev_only`/`unauthorized`/`parity_blocked`/`unavailable`/`error`) |

Binding rule: the parser stays **version-tolerant** — new versions render; only a genuinely unrecognizable shape (no string `schemaVersion` / no `data`) maps to the safe `unexpected` state.

## 9. Redaction and Safety Plan

The future DTO must **never** expose: raw IDs · `internal_user_id` · provider UIDs · raw auth claims · `identity_link` rows · audit rows · permission keys · entitlement keys · mismatch lists · secrets · tokens · DB URLs · emails · domains · payment identifiers · tenant/store/customer rows. `sourceMode` and all labels remain safe bounded values; the harness forbidden-key strip + label content-validation and the client charset/denylist/id-shape guards both remain in force. `generatedAt` stays server-side ISO-only.

## 10. UI Impact Review

- **`C01ReadinessCard.tsx`:** no *required* change (the card renders client-provided safe labels). Optional cosmetic: surface the new top-level `sourceMode`.
- **`bcpC01Client.ts`:** optional hardening — read top-level `sourceMode` when present, else fall back to the `synthetic_live_boundary_posture` category (keeps v0 working). Add v1 classification tests.
- **Tests:** add v1-accept + unknown-version-safe + sourceMode/warning tests (the existing 12 client tests stay green).
- **Safe-labels-only:** unchanged — the UI continues to render only redacted posture labels.
- **Old responses:** remain supported (version-tolerant parser).

## 11. Backend Impact Review

| File | Expected change |
|---|---|
| `server/bcp-pilot/bcpReadinessSummaryHarness.ts` | **Changes** — parameterize `schemaVersion`, `warnings`, `freshness.lastSuccessfulReadLabel`, and add an optional top-level `sourceMode` (all with v0-synthetic **defaults**, so existing callers/tests are unaffected) |
| `server/bcp-pilot/bcpReadOnlyRoute.ts` | **Minor change** — thread the new optional fields from request input into `buildReadinessSummaryEnvelope` (defaults preserve current behavior) |
| `server/bcp-pilot/bcpReadOnlyExpressAdapter.ts` | **Minor change** — pass the code/config `schemaVersion`/`sourceMode`/`warnings` values |
| `server/bcp-pilot/bcpC01CodeConfigReadModel.ts` | **Optional** — may continue to emit the `synthetic_live_boundary_posture` category for back-compat; no required change |
| route registration / `server/platform-identity/server.ts` | **No change** (preferred) |

**Preferred future implementation avoids route-registration changes** — confirmed feasible: the version/source vocabulary is envelope metadata set inside the existing handler/harness, not at registration.

## 12. Test Plan for Future Implementation

- Current v0 response still accepted (synthetic test path renders unchanged).
- v1 response accepted (new schemaVersion + `sourceMode` + `code_config` warning render).
- Unknown schemaVersion → safe (renders, not error).
- `sourceMode` displayed safely (top-level preferred; category fallback).
- Warnings sanitized; malformed values redacted; forbidden fields stripped.
- C-01 UI still renders only safe labels.
- Backend tests remain passing (existing 77).
- No DB/Supabase/provider imports (static scan).
- No route behavior change; no production exposure; no normal SaaS navigation exposure; no mutation.
- Typecheck: 0 new errors in touched files (12 baseline preserved).

## 13. Evidence Requirements

Future implementation must produce: exact files touched; the exact `schemaVersion`/`sourceMode`/warning values; DTO examples with synthetic/redacted placeholders only; tests passed (full count); typecheck result; import scan (no DB/Supabase/provider); leak scan; no-production-exposure proof; no-UI-exposure proof; no-mutation proof; `git status`.

## 14. Explicitly Excluded Scope

Excluded from M7N: implementation; DB connection; SQL/migration; Supabase access; live provider access; C-02 integration; Backend CP destructive UI; frontend navigation exposure; customer-facing exposure; production exposure; live session auth; Supabase auth; Firebase→Supabase cutover; backend actions; mutation; audit writes; `identity_link` writes; raw data exposure.

## 15. Risk Register

| ID | Risk | Severity | Mitigation | Blocks next milestone? |
|---|---|---|---|---|
| R-1 | schemaVersion drift (multiple versions confusing consumers) | Low | Documented contract; parameterized harness; v0 retained only for the synthetic test path | No |
| R-2 | UI parser breakage on new version | Medium | Parser is version-agnostic (verified); add v1 + unknown-version tests before accept | No |
| R-3 | Misleading warning vocabulary persists | Low | The whole point of v1: `['code_config']` replaces `['synthetic']` on the code/config path | No |
| R-4 | `sourceMode` ambiguity | Low | First-class bounded label + retained in-band category; documented values | No |
| R-5 | Backward-compatibility gap (v0 stops rendering) | Medium | Defaults keep v0 working; explicit v0-still-accepted test | No |
| R-6 | Unsafe unknown-version handling | Medium | Unknown version renders (never raw); only non-envelope shape → safe `unexpected` | No |
| R-7 | Future C-02 coupling | Medium | C-02 out of scope; the contract is C-01-specific; reuse pattern, not shared mutable state | No |
| R-8 | Accidental raw-field exposure via new `sourceMode` | High | `sourceMode` is a bounded label; harness strip + client denylist/id-shape guards remain | No |
| R-9 | Route behavior change during DTO work | High | Boundary forbids route/registration change; static scan; envelope metadata only | No |
| R-10 | Production exposure drift | Medium | Production-disabled + DEV gate unchanged; covered by tests | No |
| R-11 | Typecheck baseline confusion | Low | Assert 12 baseline + 0 in touched files (established convention) | No |

No risk blocks the next milestone; high-severity items are implementation constraints/tests, not present defects.

## 16. Stop Conditions

Halt and reassess (escalate toward Decision C) if the DTO change ever: requires DB/Supabase/provider access; requires a route-registration change; requires production exposure; requires normal SaaS navigation exposure; breaks the C-01 UI parser; renders raw objects/errors; exposes raw IDs/secrets/tokens/DB URLs/emails/domains; exposes tenant/store/customer rows; implies live session auth / Supabase auth / cutover; or adds mutation/backend actions.

## 17. Acceptance Criteria

M7N is acceptable when: the single decision doc exists under `docs/` and is redaction-safe; it records an honest decision (A/B/C) with rationale; it reviews the current DTO, states the problem, compares ≥4 options, defines the recommended contract + backward-compatibility + redaction/safety + UI-impact + backend-impact plans, a future test plan, evidence requirements, excluded scope, a risk register, and stop conditions; it preserves all M1–M7M assumptions; it claims no C-02/live-session-auth/Supabase-auth/production/cutover readiness; and no code/runtime/route/auth/DB/Supabase/UI change was made (nothing staged/committed/pushed/backed up).

## 18. Recommended Next Milestone

**Phase 2.0 M7O — Additive C-01 DTO / Schema Version Implementation** (per Decision A). The **required M7O scope is strictly backend-only**: parameterize the harness for `schemaVersion`/`sourceMode`/`warnings`/freshness label (v0-synthetic defaults retained for the synthetic test path) and thread the code/config values through the handler + adapter — with **no** route-registration change, **no** DB/Supabase/provider access, **no** UI/client change, **no** production exposure, and **no** mutation. Because the UI parser is already version-tolerant, **no client change is needed for v1 to render**. The client `sourceMode`-from-top-level hardening (§10) is an **explicitly optional, separable add-on** that is **out of the required backend-only M7O scope** — it should be undertaken only if the owner explicitly authorizes expanding that milestone (or as its own follow-up). *(If a test-first step is preferred, "Phase 2.0 M7O — C-01 DTO Compatibility Test Plan" is an acceptable more-conservative substitute; a C-02 Planning Gate remains a separate later track.)*
