# Phase 1.6 — Milestone 20: Identity Link DEV Repository & Audit Adapter Plan (Design-Only)

## 1. Title

Phase 1.6 Milestone 20 — DEV `identity_link` Repository Adapter & Audit Adapter Plan (design-only; no
adapter code; no rows inserted; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, the **future** DEV-only repository adapter and
audit adapter that would connect the M20.11 admin provisioning service to (1) the DEV `identity_link`
table, (2) the existing `platform_identity` table (read-only), and (3) the existing durable append-only
audit writer. This milestone (M20.12) is planning only: it implements no adapter code, inserts no rows,
writes no DB, and wires nothing.

## 3. Repository Checkpoint

- Repository checkpoint at record time: `18c8e88d41b7a9a9a38abe3c1d22ad0e44262a93`
- Commit subject at base: "Phase 1.6 M20.11 add identity link admin provisioning service"
- This M20.12 plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written design for the future DEV repository adapter (implementing the M20.11
`IdentityLinkRepository` contract) and audit adapter (implementing the M20.11 `IdentityLinkAuditSink`
contract via the existing durable writer) — boundaries, conceptual method mappings, transaction/atomicity,
validation/mutation/idempotency/conflict/disable/revoke persistence, error mapping, redaction, and
future test/QA.

**Non-goals (explicit):** no adapter code implemented; no change to the M20.11 service, audit writer,
identity repository, schemas, or migrations; no `identity_link`/`audit_event` row inserted; no DDL/SQL; no
DB connection or write; no migration apply; no change to source, runtime, `platform_identity`, Firebase
auth, Supabase auth, session-resolve, or AccessContext; no runtime wiring; no Supabase MCP; no production;
no commit/push/backup as part of authoring. Implementation is **not** approved here.

## 5. M20.6 Through M20.11 Carry-Forward

- `identity_link` exists in DEV; **empty**; RLS enabled; client-facing policies **0**; client-role grants
  **0**; **no identity links inserted**.
- `platform_identity` count remains **3** (`supabase = 2`, `firebase = 1`); `audit_event` count remained
  **6** after the M20.6 apply.
- Identity mapping remains **inactive and unwired**; Firebase/AccessContext remain authoritative;
  server-derived authorization remains observational/comparable only; production remains blocked.
- Controlled admin provisioning is planned as the safest first creation path; self-service linking is
  deferred; the audit taxonomy is planned but **not implemented**.
- The M20.11 service is **server-only, default-OFF, dependency-injected, mock-tested, imported only by its
  own test**, and inserted **no** `identity_link`/`audit_event` rows.

## 6. Current DEV Identity-Link State

The DEV `identity_link` table holds the M20.4 schema (link PK; `internal_user_id` anchor FK to
`platform_identity`; Firebase/Supabase provider-reference columns with composite FKs to
`platform_identity`; lifecycle status; verification/provenance; lifecycle timestamps; optional app-owned
actor-provenance columns; active-only partial-unique constraints; lookup indexes; RLS-no-policy). It is
empty and unwired.

## 7. Current Admin Provisioning Service State

The M20.11 service exposes `provisionLink`, `validateProvision`, `disableLink`, `revokeLink` and depends
on injected `IdentityLinkRepository`, `IdentityLinkAuditSink`, and optional `Clock`. It is pure (no DB, no
SDK), returns safe reason codes only, and emits the M20.9 redacted audit taxonomy through the injected
sink. The adapters below would satisfy those two injected contracts for a future DEV wiring.

## 8. Adapter Planning Objective

Provide future DEV-only adapters that let the M20.11 service read `platform_identity` to verify
references/anchor eligibility, write `identity_link` only when the service guards pass, transition
lifecycle (disable/revoke) preserving history, and emit redacted audit events via the existing durable
writer — without exposing provider identifiers, without writing `platform_identity`, and without changing
any authority path.

## 9. Proposed DEV Repository Adapter Boundary

A future `IdentityLinkRepository` adapter would be: **DEV-only first**; **server-side only**; read
`platform_identity` **read-only** (verify provider references + anchor eligibility); write `identity_link`
only (never `platform_identity`, never other tables); connect via the existing server-side owner-role
direct-Postgres helper (which bypasses RLS) — never the anon/client path; and be invoked only by an
owner-gated, default-OFF path. It would map DB constraint conflicts to safe reason codes and never expose
provider identifiers to clients.

## 10. Proposed Audit Adapter Boundary

A future `IdentityLinkAuditSink` adapter would implement `emit(event)` by mapping the M20.11 redacted
`IdentityLinkAuditEvent` onto the existing durable append-only audit writer (reusing its allow-listed,
scalar-only, forbidden-key-guarded metadata), emitting the M20.9 taxonomy. It would store only safe
fields and never raw identifiers/emails/tokens/claims.

## 11. Repository Method Mapping — Conceptual Only

Conceptual mapping of the M20.11 repository contract to DEV reads/writes (no SQL here):
- `getAnchorEligibility` → read-only existence/eligibility check against `platform_identity` for the
  anchor.
- `providerReferenceExists('firebase'|'supabase', ref)` → read-only existence check against
  `platform_identity` `(auth_provider, auth_provider_uid)`.
- `findActiveLinkByPair` / `findActiveLinkByFirebaseRef` / `findActiveLinkBySupabaseRef` → read-only
  `identity_link` lookups filtered to active status.
- `findHistoricalPair` → read-only `identity_link` lookup for a disabled/revoked exact pair.
- `createActiveLink` → single append of one active `identity_link` row (anchor + both provider references
  + verification method + provenance), relying on the active-only partial-unique constraints as a
  backstop.
- `findActiveLinkForLifecycle` → read-only lookup of the active link for a selector.
- `setLifecycleState` → update only the lifecycle status/timestamps/actor-provenance of one
  `identity_link` row (disable/revoke); never delete.

## 12. Audit Sink Method Mapping — Conceptual Only

`emit(event)` → build a redacted durable audit record (the M20.9 kind/category + safe fields) and append
it via the existing writer. No identifiers are mapped; the event type carries none. Read-only validation
probes would not emit audit unless explicitly approved.

## 13. Transaction / Atomicity Strategy — Future Only

Link creation and its success audit should be **atomic or compensating-safe**: ideally one logical
transaction (mutation + durable audit), mirroring the existing fail-closed "an allow must be durably
audited" posture. If the audit cannot be written, the mutation should **not** be committed (fail closed)
unless a separately-approved failure policy exists. Disable/revoke should likewise pair the lifecycle
update with its redacted audit atomically or compensating-safe.

## 14. Validation Query Strategy — Future Only

All pre-mutation checks (anchor eligibility; provider-reference existence; active-pair idempotency;
per-side active-link conflict; historical-pair) are **read-only** queries. They return only booleans/opaque
link references to the service, never identifiers to any client surface.

## 15. Mutation Strategy — Future Only

`createActiveLink` appends exactly one active row when service guards pass; `setLifecycleState` updates
exactly one row's status. No `platform_identity` write; no other-table write; no delete. The active-only
partial-unique constraints are the DB backstop against duplicate active links.

## 16. Disable / Revoke Persistence Strategy — Future Only

Disable/revoke set the lifecycle status (`active→disabled` / `active→revoked`) plus timestamp and actor
provenance, **preserving history** (no destructive delete), freeing the active-only uniqueness so a
corrected link may later be created. Each emits the corresponding redacted lifecycle audit event.

## 17. Idempotency and Conflict Persistence Strategy

- Exact active pair already present → idempotent success (no second insert), confirmed by a read-only
  re-check.
- A DB uniqueness conflict on insert (race) → map to a safe **conflict** or **idempotent** outcome after a
  safe re-check (never surface the raw constraint/identifier).
- Either side already actively linked → safe conflict reason.
- Disabled/revoked historical pair → not silently reactivated (safe reason requiring explicit future
  reactivation policy).

## 18. Error Mapping and Safe Reason Codes

DB/constraint/connection errors are mapped to the M20.11 safe reason-code vocabulary (e.g.,
`firebase_already_linked`, `supabase_already_linked`, `idempotent_existing`, `anchor_not_found`,
`internal_error`) — **never** raising raw DB errors, host names, constraint text, or identifiers. Unknown
errors map to `internal_error`.

## 19. Redaction and Sensitive-Data Boundary

Adapters must never return, log, or persist (in audit) raw provider UIDs, raw `internal_user_id` values,
emails, tokens, request headers, raw request bodies, raw provider claims, raw authorization objects, or
mismatch lists. Audit records carry only safe action category, outcome, reason code, source flow,
verification method, lifecycle state, policy decision, and boolean validation flags.

## 20. Test Strategy — Future Only

Keep the M20.11 unit tests (mocks). Add adapter-level tests with **isolated test doubles** (or, only when
owner-approved, a safe DEV-only read/write plan) including **no-real-ID / no-email / no-secret redaction
tests**; assert the service remains default-OFF and unwired; assert constraint-conflict→safe-reason
mapping; assert disable/revoke preserve history.

## 21. Manual QA Strategy — Future Only

Owner-gated DEV-only QA would confirm: no runtime route imports or calls the adapter; no production
target; and `identity_link` row count changes **only** in a separately-approved, owner-gated DEV test
milestone (with redacted evidence and expected audit delta). Not performed here.

## 22. Runtime Integration Boundary

This plan wires/implements nothing. Even after future adapters exist, AccessContext and session-resolve
authority remain unchanged until a separately-approved integration milestone. The dormant M11→M15 + M17.1
chain remains dormant. Wiring adapters does not make server authorization advisory or authoritative.

## 23. Default-OFF / Owner-Gated Boundary

Any future adapter wiring would remain **default-OFF** (the M20.11 flag helper + a non-production guard)
and owner-gated; it would be server-only and authority-path-free, invoked only by a controlled
admin-provisioning path — never by a client request, route, startup, seed, scheduler, or migration runner.

## 24. Rollback and Recovery Strategy

- Link recovery is via disable/revoke (status change), not deletion, preserving an auditable trail.
- The 004 down migration remains the **schema-level** rollback (DEV only) and must **not** be invoked by
  the adapter.
- A failed mutation returns a safe reason code and leaves no partial state (atomic/compensating-safe).

## 25. Production Blockers

Production remains hard-blocked: the adapters would be DEV-only and default-OFF; live authorization stays
excluded in production; no production target is in scope. Production enablement requires its own later,
separately-approved phase (gating, RLS for any non-owner path, monitoring, rollback).

## 26. Explicitly Forbidden Conclusions

This document does **not** claim: that the repository adapter or audit adapter is implemented; that admin
provisioning is wired to the DB; that audit event kinds are implemented; that audit rows have been
inserted; that identity links have been created; that identity mapping is implemented; that Firebase and
Supabase identities are now mapped; that email is safe as identity authority; that a client-supplied UID
is safe as authority; that the M17 Supabase pilot user equals the Firebase app user; that active-context
alignment is solved; that context hints are safe now; that server authorization is advisory-ready beyond
presence-only; that server authorization is authoritative; that the frontend should consume server
authorization now; that AccessContext, session-resolve, or the identity repository should change now; that
Firebase session authority is replaced; that production enablement is ready; that M14/M15/M17.1 should be
wired into runtime; or that self-service linking is approved.

It affirms: this is DEV repository and audit adapter planning only; no adapter code is implemented; no
audit code is implemented; no `audit_event` rows are inserted; no identity links are inserted; the DEV
table remains empty; identity mapping remains inactive and unwired; Firebase/legacy AccessContext remain
authoritative; server-derived authorization remains observational/comparable only; email must not be
identity authority; client-asserted UID must not be authority; `internal_user_id` remains the app-owned
stable anchor; future adapter implementation must be separately approved, implemented, tested, reviewed,
and backed up; self-service linking remains deferred; the M11→M15 + M17.1 path remains dormant; and
production remains blocked.

## 27. Implementation Prerequisites

1. This adapter plan (M20.12).
2. A future, separately-approved implementation milestone that adds the DEV-only repository adapter
   (reads `platform_identity` read-only; writes `identity_link` only via the server owner-role helper) and
   the audit adapter (reusing the existing append-only writer; emitting the M20.9 taxonomy), satisfying
   the M20.11 injected contracts.
3. Adapter-level tests (test doubles) + redaction tests + default-OFF/unwired assertions.
4. A security review (RLS posture, atomicity/fail-closed, redaction) before any runtime use.
5. Owner-approved DEV manual QA (the first milestone in which an `identity_link` row count may change).
6. Only later, and separately approved: any runtime integration (DEV-only, authority-path-free until
   approved). Self-service linking remains deferred.

## 28. Recommended Next Milestones

- `Phase 1.6 M20.12 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20.13 — Identity Link DEV Repository & Audit Adapter Implementation (DEV-only,
  owner-approved)` — a future, separately-approved milestone implementing the two adapters per this plan
  with test doubles and redaction tests, default-OFF and unwired. An owner-gated DEV manual QA (first
  milestone allowing an `identity_link` row change) and any runtime integration remain separate later
  milestones.
