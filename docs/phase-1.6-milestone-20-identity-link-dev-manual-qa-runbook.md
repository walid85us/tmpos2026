# Phase 1.6 — Milestone 20.15: Identity Link DEV Manual QA Runbook for First Controlled DB Exercise (Runbook-Only)

## 1. Title

Phase 1.6 Milestone 20.15 — Identity Link DEV Manual QA Runbook for the **future** first controlled DEV DB exercise of the M20.13 repository adapter + audit adapter path (runbook/documentation-only; no DB connection; no SQL; no rows inserted; non-authoritative).

## 2. Purpose

Define, in a repository-durable and redaction-safe form, **how a future, separately-approved milestone may perform the first controlled DEV DB exercise** that lets the M20.11 admin-provisioning service drive the M20.13 DEV repository adapter against the DEV `identity_link` table and the M20.13 audit adapter against the durable append-only audit writer. This M20.15 milestone is **runbook-only**: it documents preconditions, approved scenarios, atomicity requirements, safe evidence, stop conditions, and cleanup. It executes nothing — it opens no DB connection, runs no SQL, inserts no rows, wires nothing, and changes no runtime behavior.

## 3. Current Accepted Checkpoint

- Accepted checkpoint at authoring time: `6891db409a7b6fe1c3ddd8dda822fa1c758799fb`.
- Most recent commit subject at base: "Phase 1.6 M20.14 harden identity link DEV adapters".
- Accepted status carried forward: M20.11, M20.12, M20.13, M20.14, M21, M22A, M22B, M22C all ACCEPTED/COMPLETE/BACKED UP.
- This runbook is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written runbook for the future controlled DEV DB exercise — owner-approval requirements, environment/production boundaries, preconditions, identity-evidence requirements, approved and blocked scenarios, repository/audit adapter exercise plans, the transaction/atomicity requirement, safe before/after aggregate evidence, redaction rules, expected outcomes per scenario, stop conditions, rollback/cleanup, retention, a manual QA checklist, and risks.

**Non-goals (explicit):** no DB connection; no SQL/DDL; no migration apply; no `identity_link`/`audit_event` row insert; no call of the adapters against a real DB or real writer; no Supabase MCP; no route/API/UI/BCP change; no startup/runtime wiring; no change to AccessContext/Login/AccessGuard/App/main/pilot, the M20.11/M20.13/M20.14 source/tests, the audit writer, the identity repository, the 004 or `platform_identity` migrations, package files, or seeds; no commit/push/backup as part of authoring. The exercise itself is **not** approved or executed here.

## 5. Source-of-Truth Artifacts

This runbook derives only from accepted artifacts and does not expand beyond them:
- M20.8 identity-link creation-flow plan.
- M20.9 identity-link audit-event plan (taxonomy + redaction).
- M20.10 admin-provisioning implementation plan.
- M20.11 admin-provisioning service + its test.
- M20.12 DEV repository/audit adapter plan.
- M20.13 DEV repository adapter, audit adapter, and adapter test.
- M20.14 hardening (repository defensive guards + tests).
- 004 `identity_link` up/down migration files.
- M20.6/M20.7 DEV apply + evidence document.
- M21 Backend Control Plane charter and M22A read-only shell plan.

## 6. Current System State

Captured from accepted prior-milestone evidence (cited as accepted evidence where it cannot be re-verified without DB access, which this milestone must not use):

- The `identity_link` table **exists in DEV** (M20.4 schema applied in M20.6).
- The `identity_link` table is **empty** as of the M20.6/M20.7 evidence; **no** `identity_link` rows have been inserted by the M20 track.
- **RLS is enabled** on `identity_link`; **zero** client-facing policies; **zero** client-role grants (server-side owner-role direct-Postgres path only).
- `platform_identity` exists; provider-aware references exist; a shared-email correspondence group exists, which is **why email is not an identity authority**.
- The M20.11 admin-provisioning service exists: **server-only, default-OFF, dependency-injected, unwired** (imported only by its own test).
- The M20.13 DEV repository adapter and audit adapter exist: **server-only, default-OFF, dependency-injected, unwired** (imported only by their own test; type-only between each other); **no** global DB client; **no** auto-connect; production fail-closed.
- M20.14 **hardened** the repository adapter (defensive non-array/malformed/null handling, fail-closed safe codes) and added tests; the audit adapter was reviewed and unchanged.
- The Backend Control Plane is **read-only / mock-only** (M22B/M22C), DEV-gated, default-OFF, and **not** connected to identity-link writes.
- **No** runtime identity-link wiring exists; **no** API for identity-link creation; **no** UI for real identity-link creation.
- **No** `audit_event` rows have been inserted by M20.11–M20.14.
- Production remains **blocked**.

## 7. Future Exercise Summary

A future, separately-approved milestone (provisionally "M20.16 — First Controlled DB Exercise Planning / Authorization Gate", then a later execution milestone) would, in DEV only and under a tight owner-approved window, wire the M20.11 service to the M20.13 adapters with a **real owner-role DEV executor** and the **real durable writer**, and exercise a small, controlled set of scenarios using owner-approved controlled identity references — validating create / idempotency / conflict / disable / (optionally) revoke / safe-failure / redaction behavior, capturing **only** redacted aggregate evidence, then cleaning up via disable/revoke (never destructive delete). This runbook defines that exercise; it does not run it.

## 8. Required Owner Approval

The future exercise requires **explicit, separate owner approval** distinct from accepting this runbook. Approval must cover: the DEV target, the time window, the controlled test actors/identity references, the specific scenario set, the atomicity strategy, the evidence format, and the cleanup plan. A final owner review is required **before** the exercise begins and **after** it completes. No part of the exercise may proceed on the authority of this runbook alone.

## 9. Environment Boundary

- **DEV only.** The exercise targets the Supabase DEV project exclusively, via the server-side owner-role direct-Postgres path (which bypasses RLS) — never the anon/client path.
- **STAGING:** out of scope for the first exercise.
- **PRODUCTION:** blocked (see §10).
- The repository adapter's production fail-closed guard must remain in force; the exercise must run with a non-production environment indicator.

## 10. Production Blockers

- No production target, connection, or credentials are in scope.
- Production identity-link writes are forbidden; production enablement requires its own separate, later phase (gating, RLS for any non-owner path, monitoring, rollback).
- The exercise must abort if any signal indicates a non-DEV target (the adapter's production guard fail-closes; the operator must also confirm DEV out-of-band).

## 11. Required Preconditions

1. Separate owner approval obtained (§8).
2. DEV environment confirmed; production excluded.
3. Owner-approved time window with no concurrent DEV schema changes.
4. M20.11 service + M20.13 adapters at the accepted checkpoint, unmodified.
5. Adapter tests green (M20.13/M20.14 suites + M20.11 regression) immediately before the exercise.
6. The atomicity strategy (§20) reviewed and approved.
7. A cleanup/disable/revoke plan (§31) approved.
8. Evidence format (redacted, aggregate-only) agreed (§21–§23).
9. Stop conditions (§30) agreed.
10. No UI/API/runtime wiring introduced for the exercise beyond a controlled, server-only, owner-gated invocation harness that is removed or left default-OFF afterward.

## 12. Required DEV Data Preconditions

- Controlled `platform_identity` references for both provider sides must already exist in DEV (the exercise must not create real customer identities). If controlled references are needed, they must be owner-approved, clearly synthetic, and DEV-only.
- The `identity_link` table state (empty or known) must be captured as a **before** aggregate count.
- No reliance on real customer identities; no email used as an authority.

## 13. Identity Evidence Requirements

- **Verified-both-sides** evidence is required for any create: both the Firebase-side and Supabase-side provider references must be server-verified, and the verification method must be `verified_both_sides` or `admin_provisioned`.
- The app-owned stable anchor (`internal_user_id`) must reference a real `platform_identity` row.
- Approval provenance (distinct requester/approver) must satisfy separation of duties.
- Provider references are treated as **opaque**; they are never displayed, logged, or placed in evidence.

## 14. Prohibited Identity Authorities

- **Email must never be an identity authority** (a shared-email group exists; email is not stored or referenced by `identity_link`).
- **Client-supplied UID must never be an authority.**
- A create attempt implying email-as-authority or client-UID-as-authority must be **rejected** by the service guards (safe reason codes `email_as_authority_forbidden` / `client_uid_authority_forbidden`).

## 15. Approved Exercise Scenarios

Twelve scenarios are defined below (§ scenario blocks). Each is conceptual; none includes executable SQL or commands. Inputs are owner-approved controlled identity references described only by safe labels (e.g., "Controlled Reference A/B", "Controlled Anchor").

### 15.1 Scenario 1 — Preflight / Dry Readiness Review
- **Purpose:** confirm preconditions, tests-green, atomicity + cleanup approved, evidence format agreed.
- **Preconditions:** §11 satisfied.
- **Allowed inputs:** none (review only).
- **Forbidden inputs:** any mutation.
- **Expected repository result:** none (no calls).
- **Expected audit behavior:** none.
- **Safe evidence:** checklist completion; before `identity_link` aggregate count.
- **Stop condition:** any precondition unmet → stop.
- **Cleanup:** n/a.

### 15.2 Scenario 2 — Controlled Create Success
- **Purpose:** validate verified-both-sides create through service → repository append + redacted success audit.
- **Preconditions:** controlled references + anchor exist; no active link for either side; approval with distinct actors.
- **Allowed inputs:** verified-both-sides proofs; valid anchor; approval.
- **Forbidden inputs:** unverified proofs; email/client-UID authority; non-dev indicator.
- **Expected repository result:** one active link appended (`lifecycleState: active`).
- **Expected audit behavior:** `create.requested → validated → approved → succeeded` (redacted).
- **Safe evidence:** `identity_link` count delta +1; audit category deltas; lifecycle `active`; reason `provisioned`.
- **Stop condition:** unexpected outcome or any leak → stop.
- **Cleanup:** disable/revoke the created link in the cleanup phase (§31).

### 15.3 Scenario 3 — Idempotent Exact-Pair Repeat
- **Purpose:** confirm a repeat of the exact verified pair yields idempotent success with **no** second insert.
- **Preconditions:** the Scenario 2 active pair exists.
- **Allowed inputs:** identical verified-both-sides pair.
- **Forbidden inputs:** any altered side.
- **Expected repository result:** exact active pair found; no append.
- **Expected audit behavior:** `create.idempotent_existing` (redacted).
- **Safe evidence:** count delta 0; outcome `idempotent_existing`.
- **Stop condition:** any duplicate insert → stop.
- **Cleanup:** none additional.

### 15.4 Scenario 4 — Firebase-Side Already-Linked Conflict
- **Purpose:** confirm a different pair sharing the firebase side is blocked.
- **Preconditions:** an active link exists on the firebase side.
- **Allowed inputs:** verified pair reusing the firebase side with a different supabase side.
- **Forbidden inputs:** none beyond standard.
- **Expected repository result:** firebase-side active link found; no append.
- **Expected audit behavior:** `create.conflict` (redacted), reason `firebase_already_linked`.
- **Safe evidence:** count delta 0; outcome `conflict`.
- **Stop condition:** any insert on conflict → stop.
- **Cleanup:** none additional.

### 15.5 Scenario 5 — Supabase-Side Already-Linked Conflict
- **Purpose:** confirm a different pair sharing the supabase side is blocked.
- **Preconditions:** an active link exists on the supabase side.
- **Allowed inputs:** verified pair reusing the supabase side with a different firebase side.
- **Expected repository result:** supabase-side active link found; no append.
- **Expected audit behavior:** `create.conflict`, reason `supabase_already_linked`.
- **Safe evidence:** count delta 0; outcome `conflict`.
- **Stop condition:** any insert on conflict → stop.
- **Cleanup:** none additional.

### 15.6 Scenario 6 — Missing platform_identity
- **Purpose:** confirm a reference not backed by a real `platform_identity` is blocked safely.
- **Preconditions:** a controlled reference deliberately absent from `platform_identity`.
- **Allowed inputs:** verified-shaped proof with a non-existent reference.
- **Expected repository result:** provider-reference existence check false (service reject), or, on append race, FK violation mapped to safe `missing_platform_identity`.
- **Expected audit behavior:** `validation.failed` / `create.rejected` with a safe reason code.
- **Safe evidence:** count delta 0; safe reason category.
- **Stop condition:** any raw FK/identifier leak → stop.
- **Cleanup:** none.

### 15.7 Scenario 7 — Constraint-Conflict Safety
- **Purpose:** confirm an active-uniqueness race maps to a safe code without raw detail.
- **Preconditions:** a contrived race where the active partial-unique index would fire.
- **Allowed inputs:** verified pair under a simulated race.
- **Expected repository result:** unique violation mapped to safe `constraint_conflict`.
- **Expected audit behavior:** safe failure/conflict category; no raw constraint text.
- **Safe evidence:** count delta 0 or +1 with a single row (no duplicate); safe code only.
- **Stop condition:** any raw constraint/identifier leak, or a duplicate active row → stop.
- **Cleanup:** disable/revoke any created link.

### 15.8 Scenario 8 — Disable Lifecycle
- **Purpose:** confirm disable transitions active→disabled, preserving history (no delete).
- **Preconditions:** an active link exists; approval with distinct actors.
- **Allowed inputs:** disable request with a valid selector + approval.
- **Expected repository result:** status update to `disabled` (one row), history preserved.
- **Expected audit behavior:** `disable.requested → disable.succeeded` (redacted).
- **Safe evidence:** active-count delta −1; disabled-count delta +1; total row count unchanged (no delete).
- **Stop condition:** any row deletion, or count total decreasing → stop.
- **Cleanup:** this is a cleanup action.

### 15.9 Scenario 9 — Revoke Lifecycle (only if separately approved)
- **Purpose:** confirm revoke transitions active→revoked, preserving history.
- **Preconditions:** **separate explicit approval** for revoke; an active link exists.
- **Allowed inputs:** revoke request with valid selector + approval.
- **Expected repository result:** status update to `revoked` (one row), history preserved.
- **Expected audit behavior:** `revoke.requested → revoke.succeeded` (redacted).
- **Safe evidence:** active-count delta −1; revoked-count delta +1; total row count unchanged.
- **Stop condition:** missing revoke approval, any deletion, or total count decreasing → stop.
- **Cleanup:** this is a cleanup action.

### 15.10 Scenario 10 — Audit Writer Failure / Fail-Closed
- **Purpose:** confirm that if the audit write fails, the operation fails closed and surfaces a safe error (no raw detail).
- **Preconditions:** a contrived audit-write failure (DEV-only injected failure).
- **Allowed inputs:** an otherwise-valid request with a forced audit failure.
- **Expected repository/audit behavior:** the audit adapter surfaces `SafeAuditError`; the operation fails closed; any mutation is handled per the atomicity strategy (§20) — ideally rolled back in the shared transaction.
- **Safe evidence:** no un-audited successful mutation persists; safe error category.
- **Stop condition:** an un-audited committed mutation → stop and follow compensation (§31).
- **Cleanup:** disable/revoke any link left active without a success audit.

### 15.11 Scenario 11 — Redaction Verification
- **Purpose:** confirm that no raw identifier/secret appears in any result, audit row category, or evidence.
- **Preconditions:** outputs from prior scenarios available as redacted aggregates.
- **Allowed inputs:** review of safe outputs only.
- **Expected behavior:** all evidence is redacted/aggregate; actor stays null in audit; no provider reference/internal anchor/email/token.
- **Safe evidence:** redaction checklist passed; `redaction_applied = true`.
- **Stop condition:** any raw identifier/secret observed → stop immediately.
- **Cleanup:** n/a.

### 15.12 Scenario 12 — Final Cleanup / Disable / Revoke Confirmation
- **Purpose:** ensure the DEV table is returned to an owner-approved end state (all exercise links disabled/revoked; no orphan active links).
- **Preconditions:** all prior scenarios complete.
- **Allowed inputs:** disable/revoke for each exercise-created link.
- **Expected repository result:** no active exercise links remain; history rows retained.
- **Expected audit behavior:** disable/revoke audits for each.
- **Safe evidence:** final active-count for exercise links = 0; total history count consistent.
- **Stop condition:** any active exercise link remaining → continue cleanup; if cleanup fails, escalate to owner.
- **Cleanup:** this is the cleanup phase.

## 16. Blocked / Deferred Scenarios

The following are **blocked or future-only** and must NOT be part of the first exercise:
- Self-service identity linking (deferred/forbidden).
- Any UI- or API-exposed creation (no UI/API exists; none to be added).
- Any production target or production write.
- Making server authorization authoritative or having the frontend consume it.
- Reactivation of a disabled/revoked historical pair (requires a separately-approved reactivation policy).
- Bulk linking or migration of existing identities.
- Wiring M11/M15/M17.1 or M20.11/M20.13 into runtime.

## 17. Adapter Invocation Boundary

The exercise may invoke the adapters **only** through a controlled, server-only, owner-gated harness (not a route, not a UI, not startup). The harness must: be DEV-only and default-OFF; inject the owner-role DEV executor into the repository adapter and the durable writer into the audit adapter; never expose an endpoint; and be removed or left default-OFF after the exercise. No client request, route, startup, seed, scheduler, or migration runner may invoke the adapters.

## 18. Repository Adapter Exercise Plan

- Inject a real owner-role DEV executor (server-side direct Postgres) into `createIdentityLinkDevRepository`.
- Exercise the read paths first (anchor eligibility, provider-reference existence, active/historical lookups) to validate read-only behavior with no mutation.
- Exercise `createActiveLink` only within the approved create scenario, relying on the active-only partial-unique constraints as the duplicate backstop.
- Exercise `setLifecycleState` for disable (and revoke if approved), confirming status-only updates that preserve history.
- Confirm all failures surface as safe codes (no raw DB error/identifier), per M20.13/M20.14.

## 19. Audit Adapter Exercise Plan

- Inject the real durable append-only writer into `createIdentityLinkAuditAdapter`.
- Confirm each lifecycle step emits the M20.9 taxonomy `kind` via the writer with actor null, safe reason code, safe human-readable summary, and `durable_compliance_event` evidence level.
- Confirm the writer's allow-listed/scalar-only/forbidden-key redaction is applied (defense-in-depth on top of the adapter's own allow-list).
- Confirm an injected audit-write failure surfaces `SafeAuditError` (fail-closed) with no raw detail.

## 20. Transaction / Atomicity Requirement

- The first controlled DEV DB exercise **must not** perform the repository mutation and the success audit as unrelated operations without an accepted atomicity strategy.
- **Preferred strategy:** a shared transaction/executor context so the `createActiveLink` mutation and the `create.succeeded` audit write commit/abort together (the writer accepts an injected executor/tx handle; the repository accepts the same).
- **Alternative:** a compensating-safe sequence (mutation then audit, with a documented compensating disable/revoke if the audit fails) — only if separately approved and documented.
- If the audit write fails after a mutation, the future execution **fails closed** and follows the documented cleanup/disable/revoke/compensation path (§31).
- The atomicity strategy must be **reviewed and approved before any real `identity_link` row insertion.**
- This M20.15 runbook **does not implement** atomicity; it only requires it.

## 21. Safe Evidence Collection Plan

Evidence is **redacted and aggregate-only**. The operator records, per scenario: before/after `identity_link` aggregate counts and the delta; `audit_event` count deltas by safe category; lifecycle-state categories; safe reason codes; environment category (DEV); and the boolean posture flags (`approval_required`, `production_blocked`, `redaction_applied`). No raw row, identifier, or secret is recorded.

## 22. Before/After Aggregate Evidence Plan

- Capture a **before** aggregate snapshot: total `identity_link` count (and by status category), and `audit_event` count.
- Capture an **after** aggregate snapshot after each scenario (or scenario group).
- Report **deltas only** (e.g., active +1, disabled +1, total unchanged on disable), never row contents.
- The first create scenario is the **first milestone in which an `identity_link` row count may change**; the change must be a deliberate +1 with redacted evidence and the expected audit delta.

## 23. Redaction Requirements

All outputs, audit categories, and evidence must contain only safe categories/booleans. The exercise must never display, log, or persist (in evidence) a raw Firebase/Supabase/provider UID, a raw `internal_user_id`, an email, a token, an Authorization/request header, a request/response body, a raw provider claim, a raw `identity_link`/`audit_event`/`platform_identity` row, an actor UUID, a DB URL, a service-role key, a secret, a permission/entitlement key list, a mismatch list, or a raw payload.

## 24. Audit Taxonomy Expectations

The exercise expects only the M20.9 taxonomy kinds, conceptually: `identity_link.create.requested / validated / approved / succeeded / rejected / conflict / idempotent_existing`, `identity_link.disable.requested / succeeded`, `identity_link.revoke.requested / succeeded`, and `identity_link.validation.failed`. Read-only validation probes do not emit audit unless explicitly approved.

## 25. Expected Success Outcomes

A controlled create yields: service outcome `succeeded`, reason `provisioned`, lifecycle `active`, mutated true; `identity_link` total +1; audit deltas for requested/validated/approved/succeeded; all evidence redacted.

## 26. Expected Idempotency Outcomes

A repeat of the exact verified active pair yields: outcome `idempotent_existing`, mutated false; `identity_link` count delta 0; a single `create.idempotent_existing` audit; no duplicate row.

## 27. Expected Conflict Outcomes

A pair reusing one already-active side yields: outcome `conflict`, reason `firebase_already_linked` or `supabase_already_linked`, mutated false; count delta 0; a `create.conflict` audit. A historical disabled/revoked exact pair yields a safe reason requiring explicit future reactivation (not silently reactivated).

## 28. Expected Disable / Revoke Outcomes

Disable: active→disabled, one-row status update, history preserved, `disable.succeeded` audit. Revoke (if approved): active→revoked, one-row status update, history preserved, `revoke.succeeded` audit. In both, the **total** `identity_link` row count is unchanged (no delete).

## 29. Expected Failure Outcomes

Validation failures (unverified proofs, missing anchor, email/client-UID authority, missing approval, separation-of-duties violation) yield safe rejections with safe reason codes and a `validation.failed`/`create.rejected` audit. DB/constraint/connection errors map to safe codes (`constraint_conflict`, `missing_platform_identity`, `write_failed`, `unexpected_error`) with no raw detail. An audit-write failure surfaces `SafeAuditError` and fails closed.

## 30. Stop Conditions

The exercise must **stop immediately** if any of the following occur: a raw identifier/secret/row appears anywhere; an un-audited committed mutation is detected; a duplicate active link is created; a row is deleted (any total-count decrease); a non-DEV/production target is suspected; the production guard does not fail-closed as expected; counts deviate from the expected deltas; the atomicity strategy cannot be honored; or owner approval is withdrawn. On stop, follow §31.

## 31. Rollback / Cleanup / Disable Plan

- Cleanup is via **disable/revoke** (status change), never destructive delete, preserving an auditable trail.
- After the exercise, all exercise-created links must be disabled or revoked (no orphan active exercise links).
- If a mutation committed without its success audit (Scenario 10), the compensating path disables/revokes that link and records the compensation in audit.
- The 004 down migration is the **schema-level** rollback (DEV only) and must **not** be invoked by the adapters or as part of routine cleanup; schema rollback is a separate, owner-approved action.
- A backup/rollback strategy (snapshot or known-good DEV baseline) must be in place before the exercise; rollback is exercised only if owner-approved.

## 32. Data Retention and Evidence Rules

- Retain only redacted aggregate evidence (counts, deltas, safe categories, booleans).
- Do not retain raw rows, identifiers, or secrets in any artifact, screenshot, or report.
- Audit evidence remains append-only and durable per the existing posture.
- Evidence is stored in the repository docs only in redaction-safe form (as in the M20.6/M20.7 evidence document precedent).

## 33. Forbidden Data in Reports

Reports from the future exercise must never include: raw Firebase/Supabase/provider UID; raw `internal_user_id`; raw `platform_identity`/`identity_link`/`audit_event` rows; raw email; raw token; raw Authorization header; raw request/response body; DB URL; service-role key; secret; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; or real customer/tenant/store names. Only conceptual labels, safe categories, booleans, and aggregate counts/deltas are permitted.

## 34. Manual QA Checklist

For the future exercise (not performed here):
1. Separate owner approval obtained; DEV confirmed; production excluded.
2. Adapter + service tests green immediately beforehand.
3. Atomicity strategy approved; shared executor/tx wired for create + success audit.
4. Before aggregate counts captured.
5. Create success → +1, expected audit deltas, redacted.
6. Idempotent repeat → delta 0, idempotent audit.
7. Firebase-side conflict → delta 0, conflict audit.
8. Supabase-side conflict → delta 0, conflict audit.
9. Missing platform_identity → safe reject, delta 0.
10. Constraint-conflict race → safe code, no duplicate, no leak.
11. Disable → active−1/disabled+1, total unchanged, history preserved.
12. Revoke (if approved) → active−1/revoked+1, total unchanged.
13. Audit-write failure → SafeAuditError, fail closed, no un-audited mutation.
14. Redaction verified everywhere; actor null; `redaction_applied = true`.
15. Final cleanup: no orphan active exercise links.
16. After aggregate counts captured; deltas match expectations.
17. No raw identifier/secret in any evidence.
18. No UI/API/route/startup wiring introduced or left active.
19. Harness removed or default-OFF; adapters remain unwired.
20. Final owner review completed; production remains blocked.

## 35. Future Execution Milestone Boundary

The exercise is executed only by a **separate, later, owner-approved milestone** (provisionally M20.16 planning/authorization gate, then an execution milestone). That milestone must: obtain approval; wire only a controlled server-only harness; honor the atomicity strategy; collect redacted aggregate evidence; clean up via disable/revoke; and leave the adapters unwired and default-OFF afterward. Runtime integration (any authority-path use) remains a separate, later, owner-approved decision; self-service linking remains deferred.

## 36. Risks and Mitigations

- **Risk: raw identifier leak.** Mitigation: adapter redaction + writer redaction + redacted aggregate-only evidence + Scenario 11 + stop condition.
- **Risk: un-audited mutation.** Mitigation: shared-transaction atomicity (§20); fail-closed; compensation path.
- **Risk: duplicate active link.** Mitigation: active-only partial-unique constraints; conflict scenarios; stop condition.
- **Risk: accidental production target.** Mitigation: production fail-closed guard + out-of-band DEV confirmation + production blockers.
- **Risk: scope creep into UI/API/runtime.** Mitigation: server-only owner-gated harness; no route/UI; harness removed/default-OFF afterward.
- **Risk: schema rollback misuse.** Mitigation: 004 down migration excluded from routine cleanup; schema rollback is a separate owner-approved action.
- **Risk: evidence over-collection.** Mitigation: aggregate-only retention rules (§32–§33).

## 37. Explicitly Forbidden Conclusions

This document does **not** claim: that the DEV DB exercise was performed; that `identity_link` rows were inserted; that `audit_event` rows were inserted; that the repository adapter is wired to runtime; that the audit adapter is wired to runtime; that the Backend Control Plane can create identity links; that an API can create identity links; that production is ready; that server authorization is authoritative; that the frontend should consume server authorization; that self-service identity linking is approved; that email is an identity authority; that a client-supplied UID is an authority; that mutation/audit atomicity is already implemented; or that rollback was tested live.

It affirms: **M20.15 is runbook-only**; no DB connection occurred; no SQL was run; no rows were inserted; no runtime behavior changed; the future DB exercise requires separate owner approval; production remains blocked; identity-link runtime wiring remains absent; the Backend Control Plane remains read-only/mock-only; the M20.11 service and M20.13 adapters remain server-only/default-OFF/dependency-injected/unwired; email must not be identity authority; client-asserted UID must not be authority; and `internal_user_id` remains the app-owned stable anchor.

## 38. Recommended Next Milestones

- `Phase 1.6 M20.15 — Scoped Commit and Backup Authorization` (commit/back up this runbook, owner-gated).
- After backup: `Phase 1.6 M20.16 — Identity Link DEV First Controlled DB Exercise Planning / Authorization Gate` (the separate owner-approval gate that precedes any real DEV DB exercise). The execution milestone itself remains separate, later, and owner-approved.

No commit, push, or backup is performed by this milestone. Stop for owner review.
