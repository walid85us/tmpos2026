# Phase 1.6 — Milestone 20: Identity Link Creation Flow Plan (Design-Only)

## 1. Title

Phase 1.6 Milestone 20 — `identity_link` Creation / Audit / Approval / Conflict / Rollback Flow Plan
(design-only; no rows inserted; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, the **future** flow by which a verified
Firebase↔Supabase `identity_link` would be created, approved, audited, conflict-checked, and
disabled/revoked — anchored on the existing app-owned `internal_user_id`. This milestone (M20.8) is
design/planning only: it inserts no rows, writes no DB, runs no SQL, and wires nothing.

## 3. Repository Checkpoint

- Repository checkpoint at record time: `f75086918115343bd2db24b57ba661d69f79fcd0`
- Commit subject at base: "Phase 1.6 M20.7 document DEV identity link apply evidence"
- This M20.8 plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written design for the future identity-link creation flow — verified-both-sides
requirement, approved evidence sources, controlled admin provisioning, lifecycle states, validation
guards, conflict/idempotency rules, audit strategy, approval/separation-of-duties, disable/revoke,
rollback/recovery, and reconciliation.

**Non-goals (explicit):** no identity-link rows inserted; no create/update/disable/revoke/delete of any
link; no DDL/SQL; no DB connection or write; no migration apply; no change to migration files, source,
runtime, `platform_identity`, Firebase auth, Supabase auth, session-resolve, identity repository, or
AccessContext; no runtime wiring; no Supabase MCP; no production; no commit/push/backup as part of
authoring. Admin-provisioning, self-service linking, and audit-event implementation are **not** approved
or implemented here.

## 5. M20.6 / M20.7 Carry-Forward

- `identity_link` exists in DEV; it is **empty**; RLS enabled; client-facing policies **0**; client-role
  grants **0**; **no identity links inserted**.
- `platform_identity` count remains **3** (provider distribution `supabase = 2`, `firebase = 1`);
  `audit_event` count remained **6** after the apply.
- Identity mapping remains **inactive and unwired**; Firebase/AccessContext remain authoritative;
  server-derived authorization remains observational/comparable only; production remains blocked.

## 6. Current DEV Schema State

The DEV `identity_link` table provides: an app-owned link primary key; a stable `internal_user_id`
anchor (FK to `platform_identity`); Firebase and Supabase provider-reference columns (each with a
composite FK to `platform_identity`); a lifecycle status; verification/provenance metadata; lifecycle
timestamps; optional app-owned actor-provenance columns; active-only partial-unique constraints (one
active link per provider reference; no duplicate active pair); and lookup indexes — all server-only under
RLS-no-policy. The creation flow below operates within this existing schema; no schema change is proposed.

## 7. Identity Link Creation Objective

Establish, only with server-verified evidence on **both** provider sides, a single active link that
records that a Firebase provider reference and a Supabase provider reference correspond to the same
app-owned `internal_user_id` anchor — auditable, reversible, idempotent, and conflict-safe — without
exposing provider identifiers to clients and without changing any authority path.

## 8. Verified-Both-Sides Requirement

A link may reach `active` only when **both** provider references are verified from server-owned or
controlled evidence (see §10). A single verified side, or any unverified side, is insufficient. Email is
never the basis for a link.

## 9. Forbidden Linking Authorities

- **Email** must never be a linking authority (corroborating context only).
- A **client-supplied Firebase UID** must never be trusted as authority.
- A **client-supplied Supabase UID** must never be trusted as authority.
- No stored client state, no client-asserted role/tenant/store/permission, and no provider
  `user_metadata` may serve as linking authority.

## 10. Approved Evidence Sources — Conceptual Only

Conceptually acceptable evidence (design-level, no secrets stored): a server-verified provider credential
for each side (e.g., a verified provider token validated server-side), or controlled, server-verified
**admin provisioning** that carries verified evidence for both accounts. The link record stores only a
non-secret `verification_method`/provenance label — never a token, credential, or raw provider value.

## 11. Controlled Admin Provisioning Flow

The safest **first** creation path (given the tiny current volume): a server-owned, owner/admin-approved
provisioning action that, conceptually:
1. accepts a target app-owned anchor plus a Firebase reference and a Supabase reference;
2. requires **verified evidence for both** provider accounts;
3. requires **explicit owner/admin approval**;
4. checks neither provider reference is already actively linked to another anchor;
5. checks the target anchor is a valid existing identity;
6. creates **one** active link for the verified pair;
7. records `verification_method`/provenance **without** storing secrets;
8. writes a future identity-link audit event;
9. supports disable/revoke for mistakes.
Email is never used as authority in any step.

## 12. Future Self-Service Linking Flow — Deferred

Self-service linking is **deferred**. It would require a separate verified token-exchange or dual-session
proof design, must not rely on stored client state, and must not be introduced before admin provisioning
and audit behavior are proven. Not approved here.

## 13. Proposed Link Lifecycle States

Using the existing status field: `active` (verified, in effect), `disabled` (temporarily inactive, e.g.,
correcting a mistake), `revoked` (permanently retired). Active-only uniqueness applies to `active`
records; `disabled`/`revoked` rows are retained as history.

## 14. Proposed Validation Guards

Before creating an active link: both sides verified; target anchor valid; neither provider reference
already actively linked elsewhere; no existing duplicate active pair; provenance/verification recorded;
approval present. Any failed guard blocks creation (no partial/forced link).

## 15. Conflict and Duplicate Handling

- Firebase reference already actively linked → **block**.
- Supabase reference already actively linked → **block**.
- Exact active pair already exists → **idempotent success** (conceptually; no duplicate created).
- Pair exists but `disabled`/`revoked` → require an explicit **reactivation** decision or a
  create-new-link policy, designed in a later milestone (not auto-reactivated).
- Verification incomplete → **block**.
- Target anchor invalid → **block**.

## 16. Idempotency and Retry Rules

A retried creation for an already-active verified pair returns idempotent success without creating a
second link (enforced conceptually and backed by the active-only partial-unique constraints). Retries
must not produce duplicate active links or duplicate audit "created" events for the same successful link;
failed-validation retries are safe to repeat (they create nothing).

## 17. Audit Event Strategy

- Plan a **future identity-link audit event kind/category** via the existing append-only writer.
- Record a **safe action category** only; never store raw provider UIDs, emails, tokens, or secrets.
- Distinguish outcomes: `create`, `disable`, `revoke`, `conflict`, and `failed validation`.
- Expected **low** volume (linking is rare and controlled).

## 18. Approval and Separation-of-Duties Strategy

Link creation should require explicit owner/admin approval, with provenance recorded in the app-owned
actor columns (created_by / approved_by). A separation-of-duties posture (the approver distinct from the
requester where feasible) should be considered in the implementation milestone. Approval evidence is
provenance metadata, not a secret.

## 19. Disable / Revoke Flow

A mistaken or superseded link can be moved to `disabled` or `revoked` (status + lifecycle timestamp +
actor provenance), freeing the active-only uniqueness so a corrected link may be created. Disable/revoke
must be audited and never deletes history.

## 20. Rollback and Recovery Strategy

- A wrong link is a cross-account access defect; prevention via verified-both-sides + guards is primary.
- Recovery is via `disable`/`revoke` (status change), not row deletion, preserving an auditable trail.
- The 004 down migration remains available as the schema-level rollback (DEV only), independent of link
  data.

## 21. Reconciliation for Existing Aggregate Evidence

From prior accepted evidence (aggregates only; planning context, **not** linking authority): total
`platform_identity` rows 3; `supabase = 2`; `firebase = 1`; one shared descriptive-email correspondence
(group size 2). That single correspondence is a **candidate** for a future verified link via controlled
admin provisioning — created only with server-verified evidence on both sides, never from email alone,
and fully audited/reversible. Reconciliation is a future, controlled step — not performed here.

## 22. Runtime Integration Boundary

This plan wires nothing. Even after a future creation flow exists, AccessContext and session-resolve
authority remain unchanged until a separately-approved integration milestone. The dormant M11→M15 +
M17.1 chain remains dormant. Creating links does not make server authorization authoritative.

## 23. Security / Redaction Boundary

This document records only table names, conceptual field/state names, booleans, prior-accepted aggregate
counts, and safe high-level statements. It contains no DB connection string, env values, secrets,
service-role/anon keys, tokens, headers/body, raw identity/audit rows, real Firebase/Supabase/provider
UIDs, `internal_user_id` values, emails, tenant/store/role/plan values, actor UUIDs, request IDs, audit
metadata, permission/entitlement key names, mismatch lists, raw authorization output, executable SQL, or
shell/runner commands.

## 24. Explicitly Forbidden Conclusions

This document does **not** claim: that identity links have been created; that identity mapping is
implemented; that Firebase and Supabase identities are now mapped; that email is safe as identity
authority; that a client-supplied UID is safe as authority; that the M17 Supabase pilot user equals the
Firebase app user; that active-context alignment is solved; that context hints are safe now; that server
authorization is advisory-ready beyond presence-only; that server authorization is authoritative; that
the frontend should consume server authorization now; that AccessContext or session-resolve should change
now; that Firebase session authority is replaced; that production enablement is ready; that M14/M15/M17.1
should be wired into runtime; that admin provisioning is implemented; that self-service linking is
approved; or that audit-event implementation is approved.

It affirms: this is creation-flow planning only; no identity links are inserted; the DEV table remains
empty; identity mapping remains inactive and unwired; Firebase/legacy AccessContext remain authoritative;
server-derived authorization remains observational/comparable only; email must not be identity authority;
client-asserted UID must not be authority; `internal_user_id` remains the app-owned stable anchor; any
future identity-link creation implementation must be separately approved, audited, verified, and tested;
self-service linking is deferred; the M11→M15 + M17.1 path remains dormant; and production remains
blocked.

## 25. Implementation Prerequisites

1. This creation-flow plan (M20.8).
2. A future identity-link **audit event kind** design.
3. A future controlled **admin provisioning** implementation (DEV-only, default-OFF, authority-path-free)
   with verified-both-sides evidence, approval, guards, conflict/idempotency handling, and audit.
4. Test coverage (synthetic, non-real references) for create/conflict/disable/revoke/idempotency.
5. Only later, and separately approved: any runtime integration (which remains DEV-only and
   authority-path-free until approved). Self-service linking remains deferred.

## 26. Recommended Next Milestones

- `Phase 1.6 M20.8 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20.9 — Identity Link Audit Event Kind Planning` (design-only) — define the safe,
  redacted identity-link audit event category before any creation implementation. Controlled admin
  provisioning implementation, tests, and any runtime integration follow as separate, later,
  owner-approved milestones.
