# Phase 1.6 — Milestone 18: Server Authorization Advisory Adoption Plan

## 1. Title

Phase 1.6 Milestone 18 — Server-Derived Authorization Advisory Adoption Plan (documentation-only;
future-facing; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, **how** server-derived authorization could
eventually become visible in the product in a **safe, non-authoritative, advisory-only** manner — and the
evidence and guardrails required before each step. This is a planning artifact only: it specifies an
adoption ladder, safe vs. unsafe signals, gating requirements, and acceptance criteria. It changes no
runtime behavior, wires nothing, and does not move any authority boundary.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `fed38f3f41a6daac43a97f8b625a2a88c1963648`
- Commit subject at base: "Phase 1.6 M18.1 document M17 live authz evidence"
- This M18.3 document is additive and documentation-only; it modifies no existing file.

## 4. Scope and Non-Goals

**In scope:** a written advisory adoption plan — adoption ladder, safe/unsafe signal catalogs, context and
entitlement requirements, audit-volume strategy, RLS/production considerations, developer guardrails, and
per-stage acceptance criteria.

**Non-goals (explicit):** no runtime change; no wiring of the redacted summary; no enabling/running of live
authorization; no route/harness/feed/token/comparison invocation; no DB/SQL; no change to AccessContext /
Login / AccessGuard / App routing / `src/main.tsx` / `src/pilot/**`; no production work; no commit/push/
backup as part of authoring. Authoritative use is **explicitly deferred**.

## 5. Evidence Baseline from M17 and M18.1

From the committed M17 evidence record (counts/booleans only):
- One DEV-only live one-shot executed exactly once; route/feed transport `200`.
- Redacted summary: `summaryPhase = summarized`, `phase = compared`, `comparisonPhase = compared`,
  `serverAuthzPresent = true`, `safeReasonCode = server_authz_summarized`.
- Parity booleans: overall/permission/sub-permission/entitlement all `false`.
- Per-key-space counts: permission 32/11/11/21/0; sub-permission 153/78/78/75/0; entitlement 31/0/0/31/0
  (frontend/server/matched/missing/unknown). `unknownCount = 0` in every key-space.
- Durable `audit_event` 5 → 6 (+1); `platform_identity` 3 → 3 (unchanged).
- M17.4 returned the system to the dormant baseline (live-authz window closed).

Key interpretation baseline (carried into this plan):
- The run resolved a **platform-first default context**, which by design carries **no entitlements**
  (entitlements are tenant-scoped). The `entitlement serverCount = 0` is therefore a **scope artifact**,
  not a defect.
- `parity = false` reflects the expected **subset** relationship for a scoped actor and is **not** a
  failure.
- `unknownCount = 0` is a **positive** vocabulary-alignment signal (no server→frontend key drift).

## 6. Current Authority Boundary

- **Firebase and the legacy AccessContext remain the sole authoritative session/authorization engine.**
- **Server-derived authorization remains observational / comparable only.**
- **The M11 → M15 + M17.1 path remains dormant** and tree-shaken from production.
- **The redacted summary is not wired anywhere.**
- **Production remains blocked** (live authorization is hard-excluded in production and gated behind
  multiple default-OFF flags).

## 7. Adoption Level Definitions

1. **Diagnostic-only** — manual, owner-triggered, DEV-only; no app state; no user-facing UI; no access
   decisions; output is engineering evidence only.
2. **Advisory-only** — a safe, redacted, **non-authoritative** indicator; visible only to
   developer/owner/admin in DEV; never controls routing, permissions, buttons, menus, data access, or
   tenant/store selection; cannot override Firebase/AccessContext; should start **presence-only**.
3. **Shadow-only** — server authz computed alongside legacy authorization; safe, summarized
   drift/comparison output; no user-facing effect; requires an audit-volume strategy and active-context
   alignment.
4. **Authoritative** — server authz actually controls access; **explicitly deferred** to a separate later
   phase.

## 8. Recommended Adoption Ladder

Progress strictly in order, each rung gated by the acceptance criteria in §21:

`Diagnostic-only (achieved in M17.3)` → `Advisory-only (presence-first)` → `Shadow-only (with audit-volume
strategy + context alignment)` → `Authoritative (deferred)`.

No rung may be skipped. Each rung must remain DEV-only, default-OFF, and authority-path-free until its
acceptance criteria are met and separately approved.

## 9. Diagnostic-Only Stage

**Status: achieved (M17.3).** Manual, owner-triggered, DEV-only one-shot that produces a redacted
summary used only as engineering evidence. No app state, no UI, no access decisions. This stage remains
the only currently-exercised capability and stays owner-gated and dormant between runs.

## 10. Advisory-Only Stage

**Status: future planning.** A safe, redacted, non-authoritative indicator visible only to
developer/owner/admin in DEV.

- **Must start presence-only:** `serverAuthzPresent` boolean plus a safe summary/phase label. No counts,
  no parity, no key data.
- **Must not** control routing, permissions, buttons, menus, data access, or tenant/store selection, and
  **cannot** override Firebase/AccessContext.
- **Location:** a standalone DEV-only, default-OFF, owner/admin-only surface (or backend-only report)
  that imports nothing from the authority path and is tree-shaken from production. No existing frontend
  page, AccessContext, Login, AccessGuard, or App routing may be modified.
- Counts/parity are deferred to a developer-only diagnostic context **after** active-context alignment and
  careful framing (they are redaction-safe but easy to misread; see §13/§14).

## 11. Shadow-Only Stage

**Status: future planning.** The system may compute server authz alongside legacy authorization and emit
safe, summarized drift/comparison output, with **no user-facing effect**. Prerequisites:

- **Active-context alignment** (§15): compare for the client's active tenant/store context, not the
  platform-first default.
- **Audit-volume strategy** (§17): a non-audited or separately-budgeted read path so repeated comparisons
  do not append a durable `audit_event` per check.
- Drift metrics over time (e.g., monitor `unknownCount` rising above 0 as a vocabulary-drift alarm; the
  current baseline is 0).

## 12. Authoritative Stage — Deferred

**Status: explicitly deferred / out of scope.** Server-derived authorization controlling access requires
a separate later phase and is **not** planned here. It is contingent on active-context alignment,
entitlement resolution, deny/forced-deny correctness, multi-user/multi-context behavior, RLS/security
posture, and production readiness all being proven.

## 13. Safe Advisory Signal Catalog

Redaction-safe signals (counts/booleans/safe labels only):

- `serverAuthzPresent` boolean.
- Safe summary phase label (e.g., `summarized` / `unavailable` / `malformed`).
- Safe route/feed status label (allow-listed transport/phase strings only).
- Authorization-availability label (high-level, fixed wording).
- `unknownCount` as a **future vocabulary-drift metric** — only after active-context alignment.
- Redacted counts / parity booleans — **only** in developer-only diagnostic contexts, after careful
  framing.

**First advisory candidate must be:** presence-only; non-authoritative; DEV-only; visible to
owner/admin/developer only; not connected to any access decision.

## 14. Unsafe Advisory Signal Catalog

Never surface: raw authorization object; raw comparison; raw feed; raw harness output; permission /
sub-permission / entitlement key names; key arrays; mismatch lists; permission levels; tenant / store /
identity / role / plan values; user / provider / email values; token / header / body / session values;
request IDs; actor UUIDs; audit metadata; the confirmation phrase value. Also unsafe **as framing**:
parity displayed as pass/fail; entitlement count shown without context explanation; any advisory indicator
that looks authoritative.

## 15. Context Alignment Requirement

The server selects a **platform-first default context**, which may not match the client's **active**
tenant/store/role context. Until authorization can be resolved for the client's active context (or an
explicit decision is made that advisory remains presence-only), richer advisory signals (counts/parity/
entitlements) would be **misleading**. Active-context alignment is the **primary blocker** for any
advisory signal beyond presence-only and for all of shadow-only.

## 16. Entitlement Readiness Requirement

`entitlement serverCount = 0` in M17 is the expected result of the platform-first default context
(entitlements are tenant-scoped). Therefore:
- Entitlement counts/parity must **not** be surfaced as a user-facing or advisory signal until resolved
  under a **tenant/store** context.
- Follow-up is required to gather entitlement evidence under a tenant/store-scoped context before any
  entitlement-related advisory signal is considered.

## 17. Audit Volume and Evidence Strategy

- Every live authorization that reaches the durable writer appends one **append-only** `audit_event` row
  (rows cannot be pruned via update/delete). Repeated or standing live checks would cause **unbounded**
  audit growth.
- Therefore, repeated live checks must **not** reuse the current audit-writing live path without an
  audit-volume strategy.
- Any future shadow-at-scale design needs a **non-audited or separately-budgeted read path**, plus a
  retention/volume policy and proof that each intentional live check writes exactly one row.

## 18. RLS / Schema Readiness Considerations

- The server path connects as the database owner role and **bypasses RLS**; `platform_identity` has RLS
  enabled with no policies (clients get nothing). No client-path authorization tables have been exercised.
- Before any client-path or authoritative use: confirm RLS/policy posture for any table backing
  authorization reads via a non-owner path, and confirm schema stability for memberships/entitlements at
  scale. No schema/migration work is in scope for this plan.

## 19. Production Readiness Considerations

Production remains **hard-blocked**: live authorization is excluded in production and gated behind multiple
default-OFF flags. Production enablement is **not** planned here and requires its own later phase
(gating, rollback, monitoring, multi-tenant isolation proof).

## 20. Developer Guardrails for Future Artifacts

Any future advisory artifact (helper, panel, or procedure) **must** be:
- DEV-only and **default-OFF** (explicit flag);
- dormant / tree-shaken from production;
- **authority-path-free** — imports nothing from AccessContext / Login / AccessGuard / App routing /
  `src/main.tsx` / `src/pilot/**`, and does not import the dormant harness/feed/token modules into the app
  runtime;
- **redaction-by-construction** — emits counts/booleans/safe labels only, no raw passthrough;
- non-influencing — never controls routing, permissions, UI controls, data access, or tenant/store
  selection;
- non-leaking — never exposes keys, IDs, tokens, levels, or context;
- never writes the DB; never runs in production;
- owner/admin/developer-visible only.

## 21. Acceptance Criteria by Adoption Stage

- **Diagnostic-only (met):** manual owner-triggered DEV run produces a redacted summary; no app state; no
  access decisions; dormant between runs.
- **Advisory-only (presence-first):** a DEV-only, default-OFF, owner/admin-only surface shows
  `serverAuthzPresent` + a safe label; provably no influence on routing/permissions/UI/data; no raw
  content; redaction scan clean; authority path unchanged.
- **Shadow-only:** active-context alignment proven; non-audited/separately-budgeted read path in place;
  safe drift/comparison summaries; multi-user/multi-context coverage; no user-facing effect; defined
  drift alarms.
- **Authoritative (deferred):** outcome-equivalent parity for the active context; deny/forced-deny
  correctness; exhaustive role/plan/entitlement mapping; RLS/security posture; production gating/rollback/
  monitoring; multi-tenant isolation proof; separate explicit approval.

## 22. Risks and Mitigations

1. **Context alignment** — server default vs client active context → start presence-only; defer richer
   signals until alignment is resolved.
2. **Entitlement readiness** — `serverCount=0` is scope-driven → do not surface entitlement signals until
   tenant/store-scoped evidence exists.
3. **Parity interpretation** — `parity=false` is expected → never display as pass/fail; frame as
   comparable-only.
4. **Audit volume** — append-only `audit_event` growth → no standing live checks on the audit-writing
   path; use a non-audited read path for shadow.
5. **Raw-output** — keep redaction-by-construction; forbidden-term scan on any artifact.
6. **Runtime coupling** — never import dormant harness/feed/token/comparison modules into app runtime.
7. **User confusion** — restrict to DEV owner/admin; label non-authoritative; prefer presence-only.
8. **Security** — never leak keys/IDs/tokens/levels/context.
9. **Production** — remains blocked; non-prod only.
10. **Replit artifacts** — `.replit` and the goose tarball remain out of scope; never staged/committed.

## 23. Recommended Next Milestones

- `Phase 1.6 M19 — Active-Context Alignment Investigation (planning/evidence)`: determine how to resolve
  authorization for the client's active tenant/store context and gather tenant-scoped entitlement and
  deny/forced-deny evidence — the primary blocker for advisory beyond presence-only and for shadow-only.
- Subsequently, only after alignment evidence: `Dev-Only Presence-First Advisory Surface Planning`, then a
  `Non-Audited Shadow Read-Path Design`. A dev-only advisory helper/panel and any repeatable live-evidence
  procedure remain deferred until these are defined.

## 24. Explicitly Forbidden Conclusions

This document does **not** claim, and the evidence does **not** support, any of:
- that server authorization is now authoritative;
- that the frontend should consume server authorization now;
- that advisory UI is ready now;
- that the grants are correct;
- that `parity = false` is a failure;
- that entitlement behavior is ready;
- that tenant/store/role/plan alignment is proven;
- that RLS is production-ready;
- that production enablement is ready;
- that AccessContext should change;
- that Firebase session authority is replaced;
- that M14 / M15 / M17.1 should be wired into runtime.

It affirms: Firebase/legacy AccessContext remain authoritative; server-derived authorization remains
observational/comparable only; the M11→M15 + M17.1 path remains dormant; the redacted summary is not
wired anywhere; advisory adoption is future planning only; production remains blocked.

## 25. Security / Redaction Boundary Confirmation

This document records only counts, booleans, safe phase labels, safe high-level conclusions, and planning
language. It contains no raw authorization DTO, raw harness/feed output, raw comparison object,
permission / sub-permission / entitlement key names, key arrays, mismatch lists, permission levels, role
names or IDs, tenant IDs, store IDs, plan IDs, user IDs, provider UID, email, token, Authorization header,
request headers, request or response body, DB URL, service-role key, anon-key value, the owner
confirmation phrase value, request IDs, actor UUIDs, audit metadata, or any audit row dump.
