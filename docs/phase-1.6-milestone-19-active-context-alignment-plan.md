# Phase 1.6 — Milestone 19: Active-Context Alignment Plan

## 1. Title

Phase 1.6 Milestone 19 — Active-Context Alignment Plan (documentation-only; investigation findings +
safe future alignment plan; non-authoritative).

## 2. Purpose

Record, in a repository-durable and redaction-safe form, the M19 investigation finding that the frontend
active context and the server-derived authorization context are **not aligned**, and define the safe,
layered prerequisites and future contract concept required before any context hint, advisory-beyond-
presence-only, shadow-at-scale, or authoritative use. This is a planning artifact only: it changes no
runtime behavior, wires nothing, and moves no authority boundary.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `e5ed7aba5f4fb7a993b00a6856226799bf1dba61`
- Commit subject at base: "Phase 1.6 M18.3 document advisory adoption plan"
- This M19.1 document is additive and documentation-only; it modifies no existing file.

## 4. Scope and Non-Goals

**In scope:** a written record of frontend vs. server context models, the alignment gaps, server-side
validation requirements, a safe future context-hint contract concept, and the prerequisite milestone
ladder.

**Non-goals (explicit):** no runtime change; no context-hint wiring; no enabling/running of live
authorization; no route/harness/feed/token/comparison invocation; no DB connection or SQL; no change to
AccessContext / Login / AccessGuard / App routing / `src/main.tsx` / `src/pilot/**`; no production work;
no commit/push/backup as part of authoring. Authoritative use remains out of scope.

## 5. M19 Investigation Summary

Read-only inspection of the frontend active-context modules and the server authorization modules found
that the two systems do not share an aligned identity, tenant, store, scope model, plan/entitlement
source, or role vocabulary. The gap is broader than the platform-first-default-context observation from
M18: it begins at the identity layer. No code was changed; no route/DB call was made.

## 6. Current Frontend Active-Context Model

- **Active user:** derived from Firebase authentication and the Firestore user document (role, name,
  email). Login is Firebase-based.
- **Tenant context:** currently hardcoded/mock for tenant users; platform users may have a null tenant;
  tenant users receive a fixed mock tenant object (a source-level placeholder, e.g. a `tenant-1`-style
  id with a `growth`-style plan).
- **Store context:** not clearly represented as a distinct active-store selector; there is no store
  switcher or persisted active-store id in the inspected source.
- **Role:** derived from the Firestore user role, with an optional POS-operator override (`effectiveRole`).
- **Plan / entitlement behavior:** comes from the mock tenant plan, plan feature configuration, an
  optional sessionStorage feature matrix, and in-memory role configuration.
- **Canonical context object:** none; context is spread across session, tenant, effective role, and the
  POS-operator override.
- **AccessContext exposure:** exposes session and tenant, but not a server-aligned tenant/store UUID
  context.
- **AccessGuard:** uses legacy userType / role / feature access, not durable tenant/store membership
  context.
- **App routing:** depends on userType and feature gating, not tenant/store UUID context.

## 7. Current Server Authorization Context Model

- **Identity:** the Supabase auth-provider UID mapped to a durable internal user id.
- **Authority input:** the current route ignores the request body for authority; only the bearer token
  identifies the actor.
- **Context selection:** derived from active membership rows; default selection is platform-first, then
  tenant, then store.
- **Entitlements:** platform context carries no tenant entitlements; tenant/store context loads the
  tenant's feature-entitlement rows.
- **Alignment:** server authorization and frontend legacy authorization do not currently share a single
  aligned context source.

## 8. Identity Alignment Gap

The frontend authoritative identity (Firebase) and the server authorization identity (Supabase →
durable internal user id) are **not guaranteed to represent the same principal**. There is no established
mapping between the Firebase user and the Supabase user. This is the **first** prerequisite: without an
identity mapping (or a single provider), nothing downstream can be meaningfully aligned.

## 9. Tenant Alignment Gap

The frontend tenant is a hardcoded/mock placeholder; the server tenant is a durable UUID derived from
membership rows. There is **no shared tenant identifier** between them.

## 10. Store Alignment Gap

The frontend has **no distinct active-store selector** today; the server supports store-scoped
memberships. The frontend therefore cannot currently express a store context to align against.

## 11. Scope Model Alignment Gap

The frontend uses a binary `platform | tenant` user-type model plus a single mock context; the server
uses a `platform / tenant / store` membership scope model. The shapes differ, and the server's
platform-first default need not match the client's working scope.

## 12. Plan / Entitlement Alignment Gap

Frontend plan gating (mock plan + plan feature config + sessionStorage feature matrix) differs in source
and possibly vocabulary from the server's tenant feature-entitlement rows. Entitlement evidence is only
available under a tenant/store scope.

## 13. Role / Permission Alignment Gap

The frontend role vocabulary (in-memory, mutable role configuration) and the durable server resolver's
role mapping are **not yet proven equivalent**. A mapping specification is required before any parity
statement is meaningful.

## 14. M17 Context Interpretation

M17 most likely resolved a **platform** context (the authenticated principal had an active platform
membership, selected first by the platform-first default). This is consistent with the recorded counts
(a permission/sub-permission subset and zero entitlements; no server-only unknown keys).

## 15. Entitlement Zero Interpretation

`entitlement serverCount = 0` is consistent with platform scope (platform context carries no tenant
entitlements) and is **not automatically a defect**. It must **not** be surfaced as a user-facing
advisory signal until tenant/store-scoped entitlement evidence exists.

## 16. Active-Context Alignment Gap Table

| Dimension | Frontend (authoritative) | Server authorization | Aligned? |
|---|---|---|---|
| Identity | Firebase user + Firestore doc | Supabase uid → durable internal user id | No (no mapping) |
| Tenant | Hardcoded/mock placeholder | Durable tenant UUID via membership | No (no shared id) |
| Store | No distinct selector | Store-scoped membership (UUID) | No (not expressible) |
| Scope model | `platform \| tenant` + single mock | platform / tenant / store memberships | No (different shape) |
| Plan / entitlement | Mock plan + sessionStorage matrix | Tenant feature-entitlement rows | No (different source) |
| Role | In-memory mutable role config | Durable resolver from memberships | No (unproven mapping) |

## 17. Spoofing and Server-Side Validation Requirements

- Any future client-provided context value may be a **selector only**, never authority.
- The server must **validate** any requested tenant/store selector against the authenticated user's
  durable active memberships, and resolve only within a context the user already belongs to.
- The server must **reject or ignore** unauthorized/spoofed selectors and fall back to a safe default or
  deny — never honor a claimed scope.
- The client must **never** send role claims, permission claims, plan claims, entitlement claims, the
  internal user id, grant decisions, or any authority assertion.
- The current "ignore the request body for authority" stance is the correct default and must be
  preserved.

## 18. Safe Future Context-Hint Contract Concept

A future, separately-approved design could add an **optional** context-hint (a tenant/store **selector**
only) that the server validates against durable memberships before resolving authorization. It must be:
additive; **default-OFF**; DEV-only initially; non-authoritative; and implemented as a new **dormant
diagnostic route** or a strictly additive session-resolve extension that does not change the route's
existing authority semantics. **Not implemented now.**

## 19. Required Prerequisites Before Context Hints

1. An established identity mapping (Firebase ↔ Supabase) or a single identity provider.
2. Real (non-mock) tenant/store context available on the frontend.
3. A defined, server-validated selector contract (per §17/§18).

## 20. Required Prerequisites Before Advisory Beyond Presence-Only

- All of §19, plus tenant/store-scoped evidence (so counts/parity/entitlements are meaningful), plus
  careful non-misleading framing. Until then, advisory must remain **presence-only** (authorization
  availability + safe label).

## 21. Required Prerequisites Before Shadow-at-Scale

- Active-context alignment (§19); a **non-audited or separately-budgeted** read path (so repeated
  comparisons do not append audit rows); multi-user/multi-context coverage; defined drift metrics.

## 22. Required Prerequisites Before Authoritative Use

- Outcome-equivalent parity for the user's active context; deny/forced-deny correctness; exhaustive
  role/plan/entitlement mapping; RLS/security posture; production gating/rollback/monitoring; multi-tenant
  isolation proof; separate explicit approval. **Out of scope.**

## 23. Audit Volume Considerations

Each live authorization that reaches the durable writer appends one append-only audit row. Repeated
context-alignment live checks would grow the audit table unboundedly; alignment evidence-gathering must
use a non-audited or separately-budgeted read path, not repeated use of the audit-writing live route.

## 24. RLS / Schema Considerations

The server path connects as the database owner role and bypasses RLS; the identity table is
RLS-enabled-with-no-policies (clients get nothing). No client-path authorization tables have been
exercised. Before any client-path or authoritative use, confirm RLS/policy posture for any table backing
authorization reads via a non-owner path and confirm membership/entitlement schema stability. No
schema/migration work is in scope for this plan.

## 25. Recommended Alignment Milestone Ladder

1. **Identity mapping** (Firebase ↔ Supabase, or single provider) — the first prerequisite.
2. **Real frontend tenant/store context** (replace mock tenant; introduce a store selector if applicable).
3. **Server-validated context-hint contract** (dormant diagnostic route / additive, default-OFF).
4. **Presence-first advisory surface** (DEV-only, owner/admin-only, non-authoritative).
5. **Non-audited shadow read path** + drift detection at scale.
6. **Authoritative use** — deferred; separate later phase.

No rung may be skipped; each remains DEV-only, default-OFF, and authority-path-free until its criteria are
met and separately approved.

## 26. Options Deferred or Rejected

- **Static context-map diagnostic** — deferred (findings already documented here).
- **Dormant client context-hint helper** — deferred (meaningless before identity mapping + real context).
- **Server route context-hint contract** — deferred (design only after identity/membership alignment).
- **Read-only DB readiness investigation** — owner-gated; not run.
- **Wire alignment now / advisory beyond presence-only / authoritative / production** — rejected.

## 27. Security / Redaction Boundary Confirmation

This document records only safe architecture descriptions, source-level mock placeholder labels, and
planning language. It contains no raw authorization DTO, raw harness/feed/comparison output, permission /
sub-permission / entitlement key names, key arrays, mismatch lists, permission levels, real role
names/IDs, real tenant IDs, real store IDs, real plan IDs, real user IDs, provider UID, email, token,
Authorization header, request headers, request or response body, DB URL, service-role key, anon-key
value, the owner confirmation phrase value, request IDs, actor UUIDs, audit metadata, or any audit row
dump.

## 28. Explicitly Forbidden Conclusions

This document does **not** claim: that active-context alignment is solved; that Firebase and Supabase
identities are mapped; that the frontend tenant equals the server tenant; that a frontend store context
exists; that entitlement behavior is ready; that role/permission mapping is proven; that client hints are
safe without validation; that server authorization is advisory-ready beyond presence-only; that server
authorization is authoritative; that the frontend should consume server authorization now; that
AccessContext should change now; that Firebase session authority is replaced; that production enablement
is ready; or that M14/M15/M17.1 should be wired into runtime.

It affirms: Firebase/legacy AccessContext remain authoritative; server-derived authorization remains
observational/comparable only; active-context alignment is **not** solved; identity mapping is a
prerequisite; real tenant/store context is a prerequisite; context hints must be validated server-side;
the M11→M15 + M17.1 path remains dormant; and production remains blocked.

## 29. Recommended Next Milestones

- `Phase 1.6 M19.1 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20 — Identity Mapping Investigation (Firebase ↔ Supabase)` — the first prerequisite on the
  alignment ladder; documentation/investigation-only. Subsequent rungs (real frontend context, validated
  context-hint contract, presence-first advisory, non-audited shadow) follow in order.
