# Phase 1.6 — Milestone 20: Identity Link Audit Event Plan (Design-Only)

## 1. Title

Phase 1.6 Milestone 20 — `identity_link` Audit Event Kind / Taxonomy / Redacted-Payload Plan (design-only;
no audit code; no rows inserted; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, the **future** audit-event model for
identity-link lifecycle actions: the event kind/category strategy, the lifecycle taxonomy, redacted
payload principles, validation-failure logging boundaries, and audit acceptance criteria. This milestone
(M20.9) is design/planning only: it implements no audit code, inserts no rows, writes no DB, and wires
nothing.

## 3. Repository Checkpoint

- Repository checkpoint at record time: `c8e3d24552a535c8cbadea416d15e04e56cc00f1`
- Commit subject at base: "Phase 1.6 M20.8 document identity link creation flow plan"
- This M20.9 plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written design for the future identity-link audit event taxonomy and redacted payload —
event kinds, per-flow audit coverage (create / validation-failure / conflict / disable / revoke /
idempotent / approval-SoD / self-service-deferred), safe payload fields, forbidden payload content, and
volume/retention/reconciliation considerations.

**Non-goals (explicit):** no audit code implemented; no change to the audit writer, identity repository,
schemas, or migrations; no `audit_event` or `identity_link` row inserted; no DDL/SQL; no DB connection or
write; no migration apply; no change to source, runtime, `platform_identity`, Firebase auth, Supabase
auth, session-resolve, or AccessContext; no runtime wiring; no Supabase MCP; no production; no
commit/push/backup as part of authoring. Audit-event implementation, admin-provisioning, and self-service
linking are **not** approved or implemented here.

## 5. M20.6 / M20.7 / M20.8 Carry-Forward

- `identity_link` exists in DEV; it is **empty**; RLS enabled; client-facing policies **0**; client-role
  grants **0**; **no identity links inserted**.
- `platform_identity` count remains **3** (provider distribution `supabase = 2`, `firebase = 1`);
  `audit_event` count remained **6** after the M20.6 apply.
- Identity mapping remains **inactive and unwired**; Firebase/AccessContext remain authoritative;
  server-derived authorization remains observational/comparable only; production remains blocked.
- Controlled admin provisioning is planned as the safest first creation path; self-service linking is
  deferred.

## 6. Current Audit Capability Context

A durable, append-only audit capability already exists (the append-only `audit_event` table plus the
server-only append-only writer with allow-listed, scalar-only, redacted metadata and forbidden-key
guards). The identity-link audit design **reuses** this existing capability conceptually; it proposes a
new event kind/category and safe payload shape — it does **not** modify the writer here.

## 7. Identity-Link Audit Objective

Make every future identity-link lifecycle decision (create, validation failure, conflict, disable,
revoke, idempotent outcome) **auditable for security review and reconciliation** without exposing any
provider identifier, internal identity value, email, token, or secret — keeping volume low and never
making identity mapping active by itself.

## 8. Audit Event Kind / Category Strategy

Introduce a dedicated identity-link **action category** (a stable, non-secret label namespace, e.g.
`identity_link.*`) recorded through the existing audit writer's allow-listed fields. The category
distinguishes identity-link actions from other audit actions and supports filtered security review. Event
kinds are **planning labels only** (see §9); none are implemented.

## 9. Proposed Identity-Link Audit Event Taxonomy

Conceptual future event kinds/categories (planning labels only — not implemented, no rows inserted):
- `identity_link.create.requested`
- `identity_link.create.validated`
- `identity_link.create.approved`
- `identity_link.create.succeeded`
- `identity_link.create.rejected`
- `identity_link.create.conflict`
- `identity_link.create.idempotent_existing`
- `identity_link.disable.requested`
- `identity_link.disable.succeeded`
- `identity_link.revoke.requested`
- `identity_link.revoke.succeeded`
- `identity_link.validation.failed`
- `identity_link.self_service.deferred`

## 10. Create-Link Audit Flow — Future Only

A future create flow should emit, conceptually, `requested → validated → approved → succeeded`, each as a
redacted event carrying only safe action category, outcome, source flow, verification-method label,
lifecycle state, and policy decision. A `succeeded` event marks the new active link; no provider
identifiers or anchor values are stored.

## 11. Validation-Failure Audit Flow — Future Only

A failed guard should emit `identity_link.validation.failed` (or `create.rejected`) with a **safe reason
code category only** (e.g., verification-incomplete, invalid-anchor) — never the offending identifier,
email, or raw value.

## 12. Conflict / Duplicate Audit Flow — Future Only

A blocked link due to an existing active link on either side should emit `identity_link.create.conflict`
with a **safe conflict category only** (e.g., firebase-side-already-linked, supabase-side-already-linked,
duplicate-active-pair) — never the conflicting identifiers.

## 13. Disable / Revoke Audit Flow — Future Only

Disable and revoke should emit `identity_link.disable.*` / `identity_link.revoke.*` recording a **safe
lifecycle transition** (active→disabled / active→revoked) with provenance, preserving history (no delete).

## 14. Idempotency Audit Flow — Future Only

A retried creation for an already-active verified pair should emit
`identity_link.create.idempotent_existing` (a safe idempotent outcome) and must **not** create a second
link or a duplicate `succeeded` event for the same link. Failed-validation retries create nothing.

## 15. Approval and Separation-of-Duties Audit Flow

Approval should be auditable via `identity_link.create.approved`, recording that an **approval boundary
was satisfied** (and, where applicable, that requester and approver were distinct) using app-owned actor
provenance — **without** exposing actor identities in any report or surfacing actor UUIDs.

## 16. Redacted Audit Payload Principles

The audit payload must **never** store: raw Firebase UID; raw Supabase UID; raw provider UID; raw
`internal_user_id`; email value; tokens, headers, request bodies, or raw provider claims; real
tenant/store/role/plan values; raw authorization objects or mismatch lists. It should carry only a safe
action category, outcome, reason-code category, source flow, verification-method label, lifecycle state,
policy decision, and aggregate-safe context — using **boolean indicators** where possible and an **opaque
internal correlation** only if it exposes no actor UUID or provider identifier. The payload must remain
useful for investigation **without becoming a sensitive identity dump**.

## 17. Forbidden Audit Payload Content

Never include in any future identity-link audit payload: DB connection strings, env values, secrets,
service-role/anon keys, tokens, Authorization/request headers, request/response bodies, raw identity or
audit rows, real Firebase/Supabase/provider UIDs, real `internal_user_id` values, real emails, real
tenant/store/role/plan values, actor UUIDs, request IDs, audit metadata dumps, permission/entitlement key
names, mismatch lists, or raw authorization objects. (These also align with the existing writer's
forbidden-key guards.)

## 18. Safe Audit Payload Fields — Conceptual Only

Conceptually safe fields: action category (the `identity_link.*` label), outcome (succeeded / rejected /
conflict / idempotent_existing / failed), reason-code category, source flow (admin_provisioning, etc.),
verification-method label (unverified / verified_both_sides / admin_provisioned), lifecycle state
(active / disabled / revoked), policy/approval decision (boolean), and aggregate-safe context. All are
non-secret labels/booleans; none are real identifiers.

## 19. Audit Volume and Retention Considerations

- Link creation is **rare and controlled**; audit volume should remain **low**.
- Retention should follow the existing audit retention posture (append-only, durable evidence).
- Audit should **not** be generated by read-only readiness probes.
- Audit should **not** be generated by documentation/planning milestones (including this one).

## 20. Audit Reconciliation and Evidence Review

The taxonomy should let a reviewer reconstruct each link's lifecycle (requested → validated → approved →
succeeded, or rejected/conflict/idempotent; later disable/revoke) from safe categories and booleans
alone, supporting security review and the future reconciliation of the existing shared-email
correspondence — without ever exposing identifiers.

## 21. Runtime Integration Boundary

This plan wires nothing and implements nothing. Even after a future audit implementation, AccessContext
and session-resolve authority remain unchanged until a separately-approved integration milestone. The
dormant M11→M15 + M17.1 chain remains dormant. Emitting identity-link audit events does not make server
authorization authoritative.

## 22. Security / Redaction Boundary

This document records only table names, conceptual audit event labels, lifecycle state names, safe
reason-code categories, booleans, prior-accepted aggregate counts, and safe high-level statements. It
contains no DB connection string, env values, secrets, service-role/anon keys, tokens, headers/body, raw
identity/audit rows, real Firebase/Supabase/provider UIDs, `internal_user_id` values, emails,
tenant/store/role/plan values, actor UUIDs, request IDs, audit metadata dumps, raw authorization output,
executable SQL, or shell/runner commands.

## 23. Explicitly Forbidden Conclusions

This document does **not** claim: that audit event kinds are implemented; that audit rows have been
inserted; that identity links have been created; that identity mapping is implemented; that Firebase and
Supabase identities are now mapped; that email is safe as identity authority; that a client-supplied UID
is safe as authority; that the M17 Supabase pilot user equals the Firebase app user; that active-context
alignment is solved; that context hints are safe now; that server authorization is advisory-ready beyond
presence-only; that server authorization is authoritative; that the frontend should consume server
authorization now; that AccessContext or session-resolve should change now; that Firebase session
authority is replaced; that production enablement is ready; that M14/M15/M17.1 should be wired into
runtime; that admin provisioning is implemented; that self-service linking is approved; or that
audit-event implementation is approved.

It affirms: this is audit-event planning only; no audit code is implemented; no `audit_event` rows are
inserted; no identity links are inserted; the DEV table remains empty; identity mapping remains inactive
and unwired; Firebase/legacy AccessContext remain authoritative; server-derived authorization remains
observational/comparable only; email must not be identity authority; client-asserted UID must not be
authority; `internal_user_id` remains the app-owned stable anchor; any future audit implementation must be
separately approved, implemented, tested, and reviewed; self-service linking is deferred; the M11→M15 +
M17.1 path remains dormant; and production remains blocked.

## 24. Implementation Prerequisites

1. This audit-event plan (M20.9).
2. A future controlled admin-provisioning implementation that emits these redacted audit events
   (DEV-only, default-OFF, authority-path-free), reusing the existing append-only writer.
3. Test coverage (synthetic, non-real references) asserting redaction (no identifiers in payloads) across
   create / validation-failure / conflict / disable / revoke / idempotent outcomes.
4. A security review of the emitted audit categories before any runtime use.
5. Only later, and separately approved: any runtime integration (DEV-only, authority-path-free until
   approved). Self-service linking remains deferred.

## 25. Recommended Next Milestones

- `Phase 1.6 M20.9 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20.10 — Identity Link Admin Provisioning Implementation Planning` (design-only) — define the
  concrete server-only, DEV-only, default-OFF admin-provisioning implementation that applies the M20.8
  creation flow and emits the M20.9 audit taxonomy, with verified-both-sides evidence and tests. Audit and
  provisioning implementation, and any runtime integration, remain separate, later, owner-approved
  milestones.
