# Phase 1.6 — Milestone 20.16: Identity Link DEV First Controlled DB Exercise — Authorization Gate (Planning-Only)

## 1. Title

Phase 1.6 Milestone 20.16 — Identity Link DEV First Controlled DB Exercise **Authorization Gate** (authorization-planning-only; no DB connection; no SQL; no rows inserted; non-authoritative). Defines the approval gate that must be passed before a future execution milestone (M20.17) may perform the first controlled DEV DB exercise.

## 2. Purpose

Determine and document whether the project is ready to **request** owner authorization for a first controlled DEV DB exercise of the identity-link path, and define the exact gate conditions, allowed-only-in-execution actions, still-blocked actions, safe evidence, stop/rollback/cleanup conditions, and the M20.17 authorization checklist. This milestone (M20.16) is **authorization-planning only**: it opens no DB connection, runs no SQL, inserts no rows, calls no adapter against a real DB/writer, wires nothing, and changes no runtime behavior.

## 3. Current Accepted Checkpoint

- Accepted checkpoint at authoring time: `230c372d933c2af7cc8bf4af7ad18ac78503132f`.
- Most recent commit subject at base: "Phase 1.6 M20.15 document identity link DEV manual QA runbook".
- Accepted status carried forward: M20.11–M20.15, M21, M22A, M22B, M22C all ACCEPTED/COMPLETE/BACKED UP.
- This document is additive documentation only; it modifies no existing file and inserts no data.

## 4. Gate Scope

**In scope:** a readiness decision and a formal authorization gate — accepted-state summary, a readiness matrix, required owner approvals and operator roles, the DEV-only/production boundary, the future-execution (M20.17) boundary, DEV data-selection criteria, identity-evidence requirements, the atomicity/transaction/audit gates, the rollback/cleanup gate, the evidence/redaction gates, a scenario authorization matrix, stop/success/failure criteria, post-exercise review requirements, the M20.17 owner authorization checklist, and the M20.17 execution-report requirements.

## 5. Non-Goals

No DB connection; no SQL/DDL; no migration apply; no `identity_link`/`audit_event` row insert; no call of the adapters against a real DB or real writer; no Supabase MCP; no route/API/UI/BCP change; no startup/runtime wiring; no change to AccessContext/Login/AccessGuard/App/main/pilot, the M20.11/M20.13/M20.14 source/tests, the M20.15 runbook, the audit writer, the identity repository, the 004 or `platform_identity` migrations, package files, or seeds; no commit/push/backup as part of authoring. M20.16 does **not** execute M20.17.

## 6. Source-of-Truth Artifacts

Derived only from accepted artifacts (no expansion beyond accepted architecture): the M20.15 runbook; the M20.8 creation-flow plan; the M20.9 audit-event plan; the M20.10 admin-provisioning implementation plan; the M20.12 DEV repository/audit adapter plan; the M20.11 service + test; the M20.13 repository adapter, audit adapter, and adapter test; the M20.14 hardening; the 004 up/down migrations; the M20.6/M20.7 DEV apply + evidence document; and the M21/M22A docs.

## 7. Accepted Current State Summary

Captured from accepted prior-milestone evidence (cited as accepted evidence where it cannot be re-verified without DB access, which this milestone must not use):

- The `identity_link` table **exists in DEV** (M20.4 schema; applied in M20.6) and was **empty** as of the M20.6/M20.7 evidence; **no** `identity_link` rows inserted by the M20 track.
- **RLS enabled** on `identity_link`; **zero** client policies; **zero** client-role grants (server-side owner-role direct-Postgres path only).
- `platform_identity` exists; provider-aware references exist; a shared-email correspondence group exists → **email is not an identity authority**.
- The M20.11 admin-provisioning service: **server-only, default-OFF, dependency-injected, unwired**.
- The M20.13 DEV repository + audit adapters: **server-only, default-OFF, dependency-injected, unwired**; no global DB client; no auto-connect; production fail-closed.
- M20.14 **hardened** the repository adapter (defensive guards, fail-closed safe codes) and tests; audit adapter unchanged.
- The M20.15 runbook exists.
- The Backend Control Plane is **read-only / mock-only**, DEV-gated, default-OFF, and **not** connected to identity-link writes.
- **No** runtime identity-link wiring; **no** API; **no** UI for real identity-link creation.
- **No** `audit_event` rows inserted by M20.11–M20.15.
- Production remains **blocked**.

## 8. Readiness Decision

**CONDITIONALLY READY FOR OWNER AUTHORIZATION — NOT READY TO EXECUTE WITHOUT SEPARATE APPROVAL.**

The technical foundation is ready for an authorization **request** because: the M20.11 service exists and is tested; the M20.13 repository/audit adapters exist and are tested; the M20.14 hardening exists and is tested; the M20.15 manual QA runbook exists; the `identity_link` migration/evidence exists from prior milestones; and the Backend Control Plane remains read-only/mock-only and not connected to writes.

Execution remains **blocked** until ALL of the following hold: the owner approves M20.17 explicitly; the DEV-only target is confirmed; controlled test identity references are approved; the atomicity strategy is approved; the rollback/cleanup strategy is approved; the safe evidence format is approved; and the stop conditions are accepted.

## 9. Readiness Matrix

| # | Item | Status | Evidence Source | Gate Decision | Notes |
|---|---|---|---|---|---|
| 1 | M20.11 service contract | Ready | M20.11 service | Pass | Server-only, DI, safe codes |
| 2 | M20.11 service tests | Ready | M20.11 test (23/23) | Pass | Mock-only, DB-free |
| 3 | M20.13 repository adapter | Ready | M20.13 repository | Pass | DI executor; no auto-connect |
| 4 | M20.13 audit adapter | Ready | M20.13 audit adapter | Pass | DI writer; redaction core |
| 5 | M20.13 adapter tests | Ready | M20.13/M20.14 test (42/42) | Pass | DB-free fakes |
| 6 | M20.14 hardening | Ready | M20.14 changes/tests | Pass | Malformed/null fail-closed |
| 7 | M20.15 runbook | Ready | M20.15 runbook | Pass | Scenarios + atomicity + cleanup |
| 8 | identity_link table existence | Ready | M20.6/M20.7 evidence | Pass | DEV only |
| 9 | identity_link RLS | Ready | 004 migration + evidence | Pass | Enabled, no policies |
| 10 | zero client policies | Ready | 004 migration + evidence | Pass | Defense-in-depth |
| 11 | zero client grants | Ready | 004 migration + evidence | Pass | REVOKE all to anon/auth |
| 12 | platform_identity provider references | Ready | accepted prior evidence | Pass | Read-only reference checks |
| 13 | duplicate-email risk acknowledged | Ready | M20 investigation evidence | Pass | Drives email-not-authority |
| 14 | email-not-authority rule | Ready | M20.11 guards | Pass | `email_as_authority_forbidden` |
| 15 | client-UID-not-authority rule | Ready | M20.11 guards | Pass | `client_uid_authority_forbidden` |
| 16 | atomicity strategy | Not yet approved | M20.15 §20 (required) | Blocked until approved | Shared tx preferred |
| 17 | rollback/cleanup plan | Not yet approved | M20.15 §31 (required) | Blocked until approved | Disable/revoke, never delete |
| 18 | safe evidence template | Defined, not approved | M20.15 §21–§23 | Blocked until approved | Aggregate/redacted only |
| 19 | production blockers | Ready | accepted boundaries | Pass | Production hard-blocked |
| 20 | owner approval | Not yet granted | M20.17 checklist (§34) | Blocked until granted | Separate explicit approval |
| 21 | Backend Control Plane separation | Ready | M22B/M22C | Pass | Read-only/mock-only |
| 22 | API/UI exposure blocked | Ready | accepted boundaries | Pass | None exists; none to add |

**Gate summary:** all *technical foundation* rows are Pass; the remaining gates (16–18, 20) are owner-decision/approval gates that must be satisfied before M20.17.

## 10. Required Owner Approvals

The owner must explicitly approve, before M20.17: the DEV-only controlled exercise; the exact execution scope; the controlled identity references; the atomicity strategy; the rollback/cleanup strategy; the evidence format and redaction rules; and the stop conditions. A final owner go/no-go is required immediately before M20.17 begins and an owner review immediately after it completes.

## 11. Required Operator Roles

- **Owner / authorizer:** grants the explicit M20.17 approval; performs the before/after review.
- **Exercise operator:** runs the controlled, server-only, owner-gated harness in DEV; collects redacted aggregate evidence; honors stop conditions.
- **Reviewer (separation of duties):** distinct from the requester for any approval-gated action; confirms redaction and aggregate-only evidence.
These roles are conceptual; no real actor identities appear in this document or in evidence.

## 12. Required DEV-Only Boundary

M20.17 targets the Supabase DEV project exclusively, via the server-side owner-role direct-Postgres path (never the anon/client path). The repository adapter's production fail-closed guard must be in force, and the operator must confirm DEV out-of-band. STAGING is out of scope for the first exercise.

## 13. Production Blockers

No production target, connection, or credentials are in scope at any point. Production identity-link writes are forbidden; production enablement is a separate, later phase (gating, RLS for any non-owner path, monitoring, rollback). M20.17 must abort if any non-DEV signal appears.

## 14. Future Execution Milestone Boundary

The exercise is executed only by **Phase 1.6 M20.17 — Identity Link DEV First Controlled DB Exercise Execution**, a separate, later, owner-approved milestone. M20.17 may: obtain approval; wire only a controlled server-only harness; honor the atomicity strategy; collect redacted aggregate evidence; clean up via disable/revoke; and leave the adapters unwired/default-OFF afterward. M20.16 must not execute M20.17. Runtime integration and self-service linking remain separate, later, owner-approved decisions (self-service deferred).

## 15. Required DEV Data Selection Criteria

- Controlled `platform_identity` references for both provider sides must already exist in DEV (the exercise must not create real customer identities). Any needed references must be owner-approved, clearly synthetic, and DEV-only.
- A **before** aggregate snapshot of `identity_link` state (total and by status) must be captured.
- No reliance on real customer identities; no email used as authority.
- References are described only by safe labels (e.g., "Controlled Reference A/B", "Controlled Anchor").

## 16. Identity Evidence Requirements

- **Verified-both-sides** evidence for any create (both provider references server-verified; verification method `verified_both_sides` or `admin_provisioned`).
- The app-owned stable anchor (`internal_user_id`) must reference a real `platform_identity` row.
- Approval provenance with distinct requester/approver (separation of duties).
- Provider references are opaque and never displayed, logged, or placed in evidence.

## 17. Prohibited Identity Authorities

- **Email must never be an identity authority** (shared-email groups exist; email is not stored/referenced by `identity_link`).
- **Client-supplied UID must never be an authority.**
- Attempts implying either must be **rejected** by the service guards (`email_as_authority_forbidden` / `client_uid_authority_forbidden`).

## 18. Atomicity Gate

M20.17 may not proceed to any real insert until an atomicity strategy is approved. The mutation and its success audit must not be unrelated operations. This gate is **open only after** the owner approves the chosen strategy (see §19) and the operator confirms the harness implements it.

## 19. Transaction Strategy Requirement

- **Preferred:** a shared transaction/executor context so `createActiveLink` and the `create.succeeded` audit write commit/abort together (both the repository and the writer accept an injected executor/tx handle).
- **Alternative:** a compensating-safe sequence (mutation then audit with a documented compensating disable/revoke on audit failure) — only if separately approved.
- If the audit write fails after a mutation, M20.17 fails closed and follows the cleanup/compensation path (§21).
- This document does not implement atomicity; M20.17 must implement and demonstrate it before any real insert.

## 20. Audit Strategy Requirement

M20.17 must inject the real durable append-only writer into the audit adapter; confirm each lifecycle step emits the M20.9 taxonomy `kind` with actor null, safe reason code, safe summary, and `durable_compliance_event` evidence level; confirm allow-listed/scalar-only/forbidden-key redaction; and confirm an injected audit failure surfaces `SafeAuditError` (fail-closed). Read-only validation probes must not emit audit unless explicitly approved.

## 21. Rollback / Cleanup Gate

M20.17 may not proceed until a rollback/cleanup plan is approved: cleanup via **disable/revoke** (status change), never destructive delete; all exercise-created links disabled/revoked afterward (no orphan active links); a compensating disable/revoke for any mutation committed without its success audit; the 004 down migration excluded from routine cleanup (schema rollback is a separate owner-approved action); and a backup/known-good DEV baseline in place before the exercise.

## 22. Evidence Collection Gate

M20.17 evidence must be **redacted and aggregate-only**: before/after `identity_link` counts and deltas; `audit_event` count deltas by safe category; lifecycle-state categories; safe reason codes; environment category (DEV); and posture booleans (`approval_required`, `production_blocked`, `redaction_applied`). No raw row, identifier, or secret may be recorded. The first create scenario is the first point at which an `identity_link` count may change — a deliberate +1 with redacted evidence and the expected audit delta.

## 23. Redaction Gate

All M20.17 outputs, audit categories, and evidence must contain only safe categories/booleans. The exercise must never display, log, or persist a raw Firebase/Supabase/provider UID, raw `internal_user_id`, email, token, Authorization/request header, request/response body, raw provider claim, raw `identity_link`/`audit_event`/`platform_identity` row, actor UUID, DB URL, service-role key, secret, permission/entitlement key list, mismatch list, or raw payload. Any violation is an immediate stop condition.

## 24. Scenario Authorization Matrix

| # | Scenario | Classification |
|---|---|---|
| 1 | Preflight / dry readiness review | Approved for M20.17 if owner authorizes |
| 2 | Controlled create success | Approved for M20.17 if owner authorizes |
| 3 | Idempotent exact-pair repeat | Approved for M20.17 if owner authorizes |
| 4 | Firebase-side already-linked conflict | Approved for M20.17 if owner authorizes |
| 5 | Supabase-side already-linked conflict | Approved for M20.17 if owner authorizes |
| 6 | Missing platform_identity | Approved for M20.17 if owner authorizes |
| 7 | Constraint-conflict safety | Approved for M20.17 if owner authorizes |
| 8 | Disable lifecycle | Approved for M20.17 if owner authorizes |
| 9 | Revoke lifecycle | Conditional / requires additional approval |
| 10 | Audit writer failure / fail-closed | Approved for M20.17 if owner authorizes |
| 11 | Redaction verification | Approved for M20.17 if owner authorizes |
| 12 | Final cleanup / disable / revoke confirmation | Approved for M20.17 if owner authorizes |
| 13 | Self-service linking | Blocked |
| 14 | UI-driven linking | Blocked |
| 15 | API-driven linking | Blocked |
| 16 | Production linking | Blocked |
| 17 | Bulk linking | Blocked |
| 18 | Runtime authorization integration | Future only |
| 19 | Backend Control Plane write controls | Future only |
| 20 | Historical reactivation / relinking | Future only (requires separate reactivation policy) |

## 25. Approved Future Execution Scenarios

If the owner authorizes M20.17, scenarios 1–8, 10–12 (per §24) are approved for execution in DEV per the M20.15 runbook (each with its preconditions, allowed/forbidden inputs, expected repository result, expected audit behavior, safe evidence, stop condition, and cleanup). Scenario 9 (revoke) requires an **additional** explicit approval beyond the base M20.17 authorization.

## 26. Blocked Future Scenarios

Scenarios 13–17 are **blocked** (self-service, UI-driven, API-driven, production, bulk). Scenarios 18–20 are **future-only** (runtime authorization integration, Backend Control Plane write controls, historical reactivation/relinking) and require their own separate, later, owner-approved milestones.

## 27. Required Stop Conditions

M20.17 must stop immediately if: any raw identifier/secret/row appears; an un-audited committed mutation is detected; a duplicate active link is created; any row is deleted (any total-count decrease); a non-DEV/production target is suspected; the production guard does not fail-closed as expected; counts deviate from expected deltas; the atomicity strategy cannot be honored; or owner approval is withdrawn. On stop, follow the rollback/cleanup plan (§21).

## 28. Required Success Criteria

M20.17 succeeds only if: every executed scenario produces its expected safe outcome and redacted evidence; create yields a deliberate +1 with the expected audit deltas; idempotency yields delta 0; conflicts yield delta 0 with safe reasons; disable/revoke change status without changing total count (no delete); the audit-failure scenario fails closed with no un-audited mutation; redaction holds everywhere (actor null; `redaction_applied = true`); cleanup leaves no orphan active exercise links; and the adapters remain unwired/default-OFF afterward.

## 29. Required Failure Handling Criteria

On any failure: surface only safe codes/categories (no raw detail); fail closed (no un-audited successful mutation persists); execute the compensating disable/revoke where applicable; record the failure as a safe category in evidence; and escalate to the owner. A failure must never be resolved by exposing raw data or by widening scope.

## 30. Required Post-Exercise Review

After M20.17: the owner reviews the redacted aggregate evidence, confirms cleanup, confirms no UI/API/runtime wiring was introduced or left active, confirms the harness is removed or default-OFF, confirms the adapters remain unwired, and confirms production remains blocked. The review records a go/no-go for any subsequent identity-link milestone.

## 31. Forbidden Evidence

M20.17 evidence must never include: raw Firebase/Supabase/provider UID; raw `internal_user_id`; raw `platform_identity`/`identity_link`/`audit_event` rows; raw email; raw token; raw Authorization header; raw request/response body; DB URL; service-role key; secret; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; or real customer/tenant/store names. Only conceptual labels, safe categories, booleans, and aggregate counts/deltas are permitted.

## 32. Forbidden Runtime Changes

M20.17 must not: create routes or API endpoints; modify startup/server wiring; modify frontend or Backend Control Plane UI; expose identity-link creation through UI or API; make server authorization authoritative; modify AccessContext/Login/AccessGuard/App/main/pilot; wire M11/M15/M17.1 or M20.11/M20.13 into runtime; or modify migrations, package files, or seeds. The only permitted invocation is the controlled, server-only, owner-gated harness, removed or left default-OFF afterward.

## 33. Forbidden Conclusions

This document does **not** claim: that the DEV DB exercise was performed; that `identity_link`/`audit_event` rows were inserted; that the repository or audit adapter is wired to runtime; that the Backend Control Plane can create identity links; that an API can create identity links; that production is ready; that server authorization is authoritative; that the frontend should consume server authorization; that self-service identity linking is approved; that email is an identity authority; that a client-supplied UID is an authority; that mutation/audit atomicity is already implemented; or that rollback was tested live.

It affirms: **M20.16 is authorization-gate documentation only**; no DB connection occurred; no SQL was run; no rows were inserted; no runtime behavior changed; M20.17 requires separate explicit owner approval; production remains blocked; identity-link runtime wiring remains absent; the Backend Control Plane remains read-only/mock-only; email must not be identity authority; client-asserted UID must not be authority; and `internal_user_id` remains the app-owned stable anchor.

## 34. M20.17 Authorization Checklist

The owner must explicitly accept ALL of the following before M20.17 proceeds:
1. I approve a DEV-only controlled DB exercise.
2. I approve the exact future execution scope.
3. I approve the selected controlled identity references.
4. I confirm no real customer-impacting data is used.
5. I confirm no production target is allowed.
6. I approve the atomicity strategy.
7. I approve the rollback/cleanup strategy.
8. I approve the evidence format.
9. I approve the redaction rules.
10. I approve the stop conditions.
11. I understand the `identity_link` row count may increase during M20.17 only.
12. I understand the `audit_event` row count may increase during M20.17 only.
13. I understand no UI/API/runtime wiring is allowed.
14. I understand the Backend Control Plane remains read-only/mock-only.
15. I understand success does not mean production readiness.
16. I understand success does not make server authorization authoritative.
17. I understand self-service linking remains blocked.
18. I understand email is not identity authority.
19. I understand client-supplied UID is not identity authority.
20. I approve proceeding to M20.17 only after this checklist is accepted.

## 35. M20.17 Execution Report Requirements

The future M20.17 report must include (no executable commands or raw output): the commit/base checkpoint used; DEV-only confirmation; owner-approval confirmation; the exact scenario(s) performed; the atomicity strategy used; before/after aggregate `identity_link` counts; before/after aggregate `audit_event` counts by safe category; count deltas only; safe reason codes only; lifecycle category only; `redaction_applied` confirmation; `production_blocked` confirmation; a no-secrets/no-raw-IDs/no-emails/no-tokens/no-headers/no-rows confirmation; stop conditions encountered or not; cleanup/disable/revoke result; final row-count category; a no-UI/API/runtime-wiring confirmation; a no-production-action confirmation; and a final recommendation.

## 36. Risks and Mitigations

- **Risk: premature execution.** Mitigation: this gate + the §34 checklist; execution only in M20.17 after explicit approval.
- **Risk: raw identifier leak.** Mitigation: adapter + writer redaction; aggregate-only evidence; redaction gate (§23); stop condition.
- **Risk: un-audited mutation.** Mitigation: atomicity gate (§18–§19); fail-closed; compensation path.
- **Risk: duplicate active link.** Mitigation: active-only partial-unique constraints; conflict scenarios; stop condition.
- **Risk: accidental production target.** Mitigation: production fail-closed guard + out-of-band DEV confirmation + production blockers.
- **Risk: scope creep into UI/API/runtime.** Mitigation: server-only owner-gated harness; forbidden runtime changes (§32); post-exercise review.
- **Risk: over-collection of evidence.** Mitigation: forbidden-evidence list (§31); aggregate-only retention.

## 37. Final Go / No-Go Statement

**GO for owner authorization request; NO-GO for execution without separate explicit owner approval.** The technical foundation (M20.11/M20.13/M20.14 + tests, M20.15 runbook, identity_link table/RLS evidence, BCP separation) supports requesting authorization. Execution (M20.17) is **NO-GO** until the §34 checklist is accepted and the atomicity, rollback/cleanup, evidence, and stop-condition gates are approved. Production remains blocked regardless.

## 38. Recommended Next Milestone

- `Phase 1.6 M20.16 — Scoped Commit and Backup Authorization` (commit/back up this authorization-gate document, owner-gated).
- After backup, and only if the owner accepts the §34 checklist and the gates: `Phase 1.6 M20.17 — Identity Link DEV First Controlled DB Exercise Execution` (separate, later, owner-approved).

No commit, push, or backup is performed by this milestone. Stop for owner review.
