# Phase 1.6 — Milestone 20: Identity Link Admin Provisioning Implementation Plan (Design-Only)

## 1. Title

Phase 1.6 Milestone 20 — DEV-Only `identity_link` Admin Provisioning Implementation Plan (design-only; no
code; no rows inserted; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, the **future** DEV-only, server-only admin
provisioning service/helper that would create, validate, audit, disable, and revoke identity links under
strict owner/admin control — applying the M20.8 creation flow and emitting the M20.9 audit taxonomy. This
milestone (M20.10) is implementation planning only: it implements no code, creates no helper/service/
repository file, inserts no rows, writes no DB, and wires nothing.

## 3. Repository Checkpoint

- Repository checkpoint at record time: `12f28176897d0e5492f406b10af1798715e70bd7`
- Commit subject at base: "Phase 1.6 M20.9 document identity link audit event plan"
- This M20.10 plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written implementation plan for the future admin provisioning capability — objective,
implementation boundary, conceptual service/input/output contracts, validation guards, verified-both-sides
evidence model, conflict/idempotency handling, approval/separation-of-duties, audit integration,
disable/revoke, rollback, placement options, and future test/QA plans.

**Non-goals (explicit):** no code implemented; no helper/service/repository file created; no change to the
audit writer, identity repository, schemas, or migrations; no `identity_link` or `audit_event` row
inserted; no DDL/SQL; no DB connection or write; no migration apply; no change to source, runtime,
`platform_identity`, Firebase auth, Supabase auth, session-resolve, or AccessContext; no runtime wiring;
no Supabase MCP; no production; no commit/push/backup as part of authoring. Implementation, admin
provisioning, audit-event code, and self-service linking are **not** approved or implemented here.

## 5. M20.6 / M20.7 / M20.8 / M20.9 Carry-Forward

- `identity_link` exists in DEV; it is **empty**; RLS enabled; client-facing policies **0**; client-role
  grants **0**; **no identity links inserted**.
- `platform_identity` count remains **3** (provider distribution `supabase = 2`, `firebase = 1`);
  `audit_event` count remained **6** after the M20.6 apply.
- Identity mapping remains **inactive and unwired**; Firebase/AccessContext remain authoritative;
  server-derived authorization remains observational/comparable only; production remains blocked.
- Controlled admin provisioning is planned as the safest first creation path (M20.8); self-service linking
  is deferred; the identity-link audit taxonomy is planned but **not implemented** (M20.9).

## 6. Current DEV Identity-Link State

The DEV `identity_link` table provides the schema from the M20.4 migration (app-owned link primary key;
stable `internal_user_id` anchor with FK to `platform_identity`; Firebase and Supabase provider-reference
columns with composite FKs to `platform_identity`; lifecycle status; verification/provenance metadata;
lifecycle timestamps; optional app-owned actor-provenance columns; active-only partial-unique constraints;
lookup indexes; RLS-no-policy). It is empty and unwired. This plan designs a service that would operate
within this existing schema; no schema change is proposed.

## 7. Admin Provisioning Objective

Provide a future controlled, server-only, owner/admin-approved capability to establish a single active
identity link — only with verified evidence on both provider sides — that is auditable, idempotent,
conflict-safe, and reversible (disable/revoke), without exposing provider identifiers to clients and
without changing any authority path.

## 8. Proposed Future Implementation Boundary

A future implementation would be: **DEV-only first**; **server-side only**; **default-OFF** behind an
explicit flag; **authority-path-free** (it would not be imported by AccessContext, Login, AccessGuard,
App routing, `src/main.tsx`, the pilot, or the live session-resolve authority path); and it would **reuse**
the existing append-only audit writer and read identities via the existing repository **without modifying
either**. It would make server authorization neither advisory nor authoritative.

## 9. Proposed Admin Provisioning Service Contract — Conceptual Only

Conceptually, a single controlled server-side function/helper (no code here) that accepts an operation
type and a validated request, performs the validation guards (§12), and — on success — performs the link
mutation and emits the redacted audit event(s). It returns a non-secret result. It is invoked only by an
owner/admin-controlled, DEV-only path; never by a client request.

## 10. Proposed Input Contract — Conceptual Only

Conceptual inputs (labels only; **no real values**): the app-owned **anchor reference**; the **Firebase
provider-reference proof** and the **Supabase provider-reference proof** (verified server-side); a
**verification-method label**; an **approval context** (who approved; provenance, not exposed in reports);
and an **operation type** (create / disable / revoke). No email-as-authority; no client-supplied UID as
authority; no tokens or secrets stored.

## 11. Proposed Output Contract — Conceptual Only

Conceptual outputs (labels/booleans only): a **success/failure state**, a **safe reason-code category**, a
**lifecycle status** (active / disabled / revoked), and an **audit outcome** (which redacted audit
event(s) were emitted). No identifiers, tokens, or secrets in the output.

## 12. Required Validation Guards

Before a create reaches `active` (each failure returns a **safe reason code only**):
- target anchor exists and is eligible;
- the Firebase provider reference exists in `platform_identity`;
- the Supabase provider reference exists in `platform_identity`;
- both sides correspond to approved verified evidence;
- neither side is already actively linked elsewhere;
- exact active pair → idempotent (no second link);
- approval boundary satisfied;
- operation is DEV-only initially;
- no client authority is used;
- the audit event can be written before/with the link mutation (future implementation).

## 13. Verified-Both-Sides Evidence Model

A link reaches `active` only when **both** provider references are verified from server-owned or
controlled evidence carried by the admin request (a non-secret verification-method label is stored; the
underlying proof/credential is never persisted). A single verified side, or any unverified side, is
insufficient.

## 14. Forbidden Linking Authorities

Email is never a linking authority (corroborating context only). A client-supplied Firebase or Supabase
UID is never trusted as authority. No stored client state, client-asserted role/tenant/store/permission,
or provider `user_metadata` may serve as linking authority.

## 15. Conflict and Duplicate Handling

- Firebase reference already actively linked → block (`create.conflict`, safe category).
- Supabase reference already actively linked → block (`create.conflict`, safe category).
- Exact active pair already exists → idempotent success (`create.idempotent_existing`).
- Pair exists but disabled/revoked → explicit reactivation/create-new policy in a later milestone (not
  auto-reactivated).
- Incomplete verification or invalid anchor → block (`validation.failed`/`create.rejected`).
These align with the active-only partial-unique constraints already present in the schema.

## 16. Idempotency and Retry Behavior

A retried create for an already-active verified pair returns idempotent success without creating a second
link or a duplicate `create.succeeded` audit event. Failed-validation retries create nothing and are safe
to repeat. The DB active-only partial-unique constraints provide a backstop against duplicate active
links.

## 17. Approval and Separation-of-Duties Controls

A create requires explicit owner/admin approval, recorded via app-owned actor provenance
(created_by / approved_by). Where practical, the approver should be distinct from the requester
(separation of duties). Approval evidence is provenance metadata, not a secret, and actor identities are
never exposed in reports.

## 18. Audit Event Integration Plan

The service would emit the M20.9 redacted audit taxonomy via the existing append-only writer (no writer
change): create (`requested → validated → approved → succeeded` or `rejected`/`conflict`/
`idempotent_existing`), `validation.failed`, and `disable.*`/`revoke.*`. Payloads carry only safe action
category, outcome, reason-code category, source flow, verification-method label, lifecycle state, and
policy decision — **never** identifiers, emails, tokens, or secrets.

## 19. Disable / Revoke Implementation Plan

Disable and revoke would be controlled operations that set the lifecycle status (active→disabled /
active→revoked) plus a lifecycle timestamp and actor provenance, freeing the active-only uniqueness so a
corrected link can be created. They preserve history (no destructive delete) and emit the corresponding
redacted audit events.

## 20. Rollback and Recovery Behavior

- A wrong link is a cross-account access defect, prevented by verified-both-sides + the guards.
- Recovery is via disable/revoke (status change), not row deletion, preserving an auditable trail.
- The 004 down migration remains the schema-level rollback (DEV only), independent of link data.

## 21. Repository / Helper Placement Options — Conceptual Only

Conceptual placement (no files created): a new **server-only** module under the platform-identity server
area (sibling to existing server-side modules), reusing the existing repository for reads and the existing
append-only writer for audit — never imported by `src/` (the client bundle) and never by the live
authority path. The exact filename/location would be decided at implementation time and remain DEV-only,
default-OFF, and authority-path-free.

## 22. Testing Plan — Future Only

For a future, separately-approved implementation milestone (not now): unit/integration tests using
**synthetic, non-real** references asserting — create success path; each validation-guard failure returns
the correct safe reason code; conflict on each side blocks; idempotent existing-active-pair returns
idempotent success without a duplicate; disable/revoke transitions preserve history; and **every** emitted
audit payload is redacted (no identifiers). No route/runtime wiring in tests.

## 23. Manual QA Plan — Future Only

For a future implementation: a controlled DEV-only manual exercise (owner-approved) that provisions one
link from verified evidence on both sides, then verifies (read-only) the active link exists, the audit
events were emitted redacted, and baseline counts changed only as expected (one `identity_link` row; the
expected audit delta) — with no identifiers printed. Not performed in this milestone.

## 24. Runtime Integration Boundary

This plan wires/implements nothing. Even after a future admin provisioning implementation, AccessContext
and session-resolve authority remain unchanged until a separately-approved integration milestone. The
dormant M11→M15 + M17.1 chain remains dormant. Provisioning a link does not make server authorization
advisory or authoritative.

## 25. Security / Redaction Boundary

This document records only table names, conceptual contract/field names, lifecycle state names, safe
reason-code categories, booleans, prior-accepted aggregate counts, and safe high-level statements. It
contains no executable code, executable SQL, shell/runner commands, DB connection string, env values,
secrets, service-role/anon keys, tokens, headers/body, raw identity/audit rows, real
Firebase/Supabase/provider UIDs, `internal_user_id` values, emails, tenant/store/role/plan values, actor
UUIDs, request IDs, audit metadata dumps, or raw authorization output.

## 26. Explicitly Forbidden Conclusions

This document does **not** claim: that admin provisioning is implemented; that audit event kinds are
implemented; that audit rows have been inserted; that identity links have been created; that identity
mapping is implemented; that Firebase and Supabase identities are now mapped; that email is safe as
identity authority; that a client-supplied UID is safe as authority; that the M17 Supabase pilot user
equals the Firebase app user; that active-context alignment is solved; that context hints are safe now;
that server authorization is advisory-ready beyond presence-only; that server authorization is
authoritative; that the frontend should consume server authorization now; that AccessContext,
session-resolve, or the identity repository should change now; that Firebase session authority is
replaced; that production enablement is ready; that M14/M15/M17.1 should be wired into runtime; or that
self-service linking is approved.

It affirms: this is admin provisioning implementation planning only; no admin provisioning code is
implemented; no audit code is implemented; no `audit_event` rows are inserted; no identity links are
inserted; the DEV table remains empty; identity mapping remains inactive and unwired; Firebase/legacy
AccessContext remain authoritative; server-derived authorization remains observational/comparable only;
email must not be identity authority; client-asserted UID must not be authority; `internal_user_id`
remains the app-owned stable anchor; future implementation must be separately approved, implemented,
tested, reviewed, and backed up; self-service linking remains deferred; the M11→M15 + M17.1 path remains
dormant; and production remains blocked.

## 27. Implementation Prerequisites

1. This implementation plan (M20.10).
2. A future, separately-approved implementation milestone that creates the server-only, DEV-only,
   default-OFF admin provisioning module (reusing the existing repository for reads and the existing
   append-only writer for audit, with no modification to either), applying the M20.8 flow and emitting the
   M20.9 audit taxonomy.
3. Test coverage (synthetic, non-real references) per §22.
4. A security review of the implementation and emitted audit categories.
5. Owner-approved DEV manual QA per §23.
6. Only later, and separately approved: any runtime integration (DEV-only, authority-path-free until
   approved). Self-service linking remains deferred.

## 28. Recommended Next Milestones

- `Phase 1.6 M20.10 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20.11 — Identity Link Admin Provisioning Implementation (DEV-only, owner-approved)` — a
  future, separately-approved milestone that implements the server-only, default-OFF module per this plan
  with tests, emitting the M20.9 audit taxonomy, with no runtime wiring. Manual QA, security review, and
  any runtime integration remain separate, later, owner-approved milestones.
