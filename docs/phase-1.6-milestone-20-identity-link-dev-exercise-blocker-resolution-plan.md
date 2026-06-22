# Phase 1.6 — Milestone 20.17A: Identity Link DEV Exercise Blocker Resolution Plan (Planning-Only)

## 1. Title

Phase 1.6 Milestone 20.17A — Identity Link DEV Controlled DB Exercise **Blocker Resolution Plan** (planning-only; no DB connection; no SQL; no rows inserted; non-authoritative). Defines how a future, separately-approved re-attempt can safely resolve the two blockers recorded in M20.17.

## 2. Purpose

Document a safe resolution path for the two blockers that prevented M20.17 from executing: (1) Controlled Pair A was not available through a secure local mechanism, and (2) the executor could not independently confirm the DEV-vs-production target without handling the connection secret. This milestone (M20.17A) is **blocker-resolution planning only**: it opens no DB connection, runs no SQL, inserts no rows, calls no adapter against a real DB/writer, wires nothing, and changes no runtime behavior. It does **not** execute a re-attempt.

## 3. Current Accepted Checkpoint

- Accepted checkpoint at authoring time: `a3cdad9693cdabe1570d006a4d7a3081e1328f2e`.
- Most recent commit subject at base: "Phase 1.6 M20.17 record blocked identity link DEV exercise evidence".
- Accepted status carried forward: M20.11–M20.16 ACCEPTED; M20.17 ACCEPTED as BLOCKED BEFORE MUTATION; M21, M22A, M22B, M22C ACCEPTED.
- This plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope

A written resolution plan: the M20.17 blocked-outcome summary; per-blocker resolution; resolution principles; the Controlled Pair A provisioning / secret-handling / redaction / validation policies; the DEV-target confirmation / secret-handling / safety-signal policies; owner approvals and operator/separation-of-duties roles; the future re-attempt gate checklist, allowed scope, and blocked scope; the required redacted evidence format and forbidden evidence; stop conditions; rollback/cleanup, atomicity, and audit preconditions; the pre-re-attempt review; the future re-attempt report requirements; and risks.

## 5. Non-Goals

No DB connection; no SQL/DDL; no migration apply; no `identity_link`/`audit_event` row insert; no call of the adapters against a real DB or real writer; no Supabase MCP; no route/API/UI/BCP change; no startup/runtime wiring; no change to AccessContext/Login/AccessGuard/App/main/pilot, the M20.11/M20.13/M20.14 source/tests, the M20.15 runbook, the M20.16 gate, the M20.17 evidence, the audit writer, the identity repository, the 004 or `platform_identity` migrations, package files, or seeds; no commit/push/backup as part of authoring. M20.17A does **not** execute the re-attempt.

## 6. Source-of-Truth Artifacts

Derived only from accepted artifacts (no expansion beyond accepted architecture): the M20.17 blocked evidence; the M20.16 authorization gate; the M20.15 runbook; the M20.8 creation-flow plan; the M20.9 audit-event plan; the M20.10 admin-provisioning plan; the M20.12 adapter plan; the M20.11 service + test; the M20.13 repository adapter, audit adapter, and adapter test; the M20.14 hardening; the 004 up/down migrations; the M20.6/M20.7 DEV apply + evidence document; and the M21/M22A docs.

## 7. M20.17 Blocked Outcome Summary

M20.17 was correctly stopped **before any DB connection or mutation**. No DB connection, SQL, DDL, migration, or row write occurred; no adapter was called against a real DB/writer; no runtime behavior changed; the DEV `identity_link` table remains empty (per cited M20.6/M20.7 evidence) and no `audit_event` rows were added. Two blockers were recorded (see §8, §9).

## 8. Blocker 1 — Controlled Pair A Not Available

No secure local mechanism supplied Controlled Pair A (a clearly-synthetic, DEV-only identity pair: a Firebase-side provider reference, a Supabase-side provider reference, and an app-owned anchor, all already present in DEV `platform_identity`). Obtaining a pair would have required either reading raw identifiers (forbidden to print; not clearly-synthetic controlled data) or inserting synthetic `platform_identity` rows (forbidden — not an approved operation; the create flow's FK requires references to pre-exist). Resolution must let the owner provide Controlled Pair A through a secure local mechanism the executor can use **without printing values** (see §11–§14).

## 9. Blocker 2 — DEV Target Not Independently Confirmable

The executor could not independently confirm the connection targets the DEV project (not production) without inspecting/parsing the `SUPABASE_DATABASE_URL` secret, which must never be printed or parsed. Non-production process status (`NODE_ENV` not 'production') is necessary but not sufficient to confirm the **target identity**. Resolution must provide an executor-confirmable DEV signal that is **separate from the DB-URL secret** (see §15–§17).

## 10. Required Resolution Principles

1. **Secrets stay secret.** No DB URL, key, token, or connection string is ever printed, parsed, logged, committed, or pasted externally.
2. **Identifiers stay opaque.** Controlled Pair A values are never printed, documented, or stored; only presence/shape/counts are observed.
3. **Synthetic, DEV-only, controlled.** Controlled Pair A must be clearly synthetic and not customer-impacting.
4. **Executor-confirmable DEV signal.** DEV-vs-production is confirmed via a non-secret signal, not by inspecting the connection secret.
5. **Fail-closed.** If either blocker cannot be resolved safely, the future re-attempt stops before mutation again.
6. **No scope creep.** No UI/API/runtime wiring; BCP stays read-only/mock-only; production stays blocked; self-service stays deferred.
7. **Separation of duties + owner approval** before any DB connection.

## 11. Controlled Pair A Provisioning Policy

The owner may securely provide Controlled Pair A for a future milestone, subject to:
1. Controlled Pair A must be synthetic or controlled DEV-only.
2. Controlled Pair A must not represent a real customer-impacting identity.
3. Controlled Pair A must have verified Firebase-side evidence.
4. Controlled Pair A must have verified Supabase-side evidence.
5. Controlled Pair A must map to valid `platform_identity` references.
6. Controlled Pair A must not rely on email as authority.
7. Controlled Pair A must not rely on client-supplied UID as authority.
8. Raw identifiers must not be committed, printed, pasted into any external tool, included in reports, or stored in docs.
9. Raw identifiers may only be provided through a secure local mechanism available to the executor.
10. The executor may verify presence/shape/counts but must not print values.
11. Any local secret/variable names may be documented **conceptually**, but values must never be shown.
12. If Controlled Pair A cannot be provided without raw exposure, the future re-attempt must stop before mutation again.

Conceptual secure-slot labels (names only, never values): `CONTROLLED_PAIR_A_FIREBASE_REF_PRESENT`, `CONTROLLED_PAIR_A_SUPABASE_REF_PRESENT`, `CONTROLLED_PAIR_A_INTERNAL_ANCHOR_PRESENT`, `CONTROLLED_PAIR_A_PROVIDER_PAIR_PRESENT`.

## 12. Controlled Pair A Secret-Handling Policy

- Controlled Pair A references are supplied only via a secure local mechanism (e.g., owner-provisioned local environment slots) that the executor reads **by reference**, never printing the value.
- The executor passes the references through the M20.11 service / M20.13 repository path without echoing them to logs, reports, or evidence.
- No Controlled Pair A value is ever written to any file, including the evidence document; only the presence booleans above are recorded.
- If a step would require printing or persisting a Controlled Pair A value, the step is forbidden and the re-attempt stops.

## 13. Controlled Pair A Redaction Policy

- Evidence and logs record only: presence booleans, shape/format validity booleans, and aggregate counts/deltas.
- The audit adapter's existing redaction (actor null; allow-listed/scalar-only/forbidden-key payload) and the repository's safe-code mapping remain the runtime redaction guards.
- No raw provider reference, internal anchor, email, token, header, body, claim, secret, or raw row appears anywhere.

## 14. Controlled Pair A Validation Gate

Before any mutation in the future re-attempt, the executor must confirm (booleans only):
1. `CONTROLLED_PAIR_A_FIREBASE_REF_PRESENT` = yes.
2. `CONTROLLED_PAIR_A_SUPABASE_REF_PRESENT` = yes.
3. `CONTROLLED_PAIR_A_INTERNAL_ANCHOR_PRESENT` = yes.
4. `CONTROLLED_PAIR_A_PROVIDER_PAIR_PRESENT` = yes.
5. Eligibility verifiable safely via the read-only repository/service path (anchor eligibility + provider-reference existence return booleans only).
6. Verified-both-sides evidence present; verification method is a verified category.
7. No value was printed during validation.
If any check fails, stop before mutation and record a blocked outcome.

## 15. DEV Target Confirmation Policy

The future executor confirms DEV-only target using an **executor-confirmable DEV signal separate from the DB-URL secret**, such as: an owner-approved local `DEV_TARGET_CONFIRMATION` flag, an approved DEV environment label, an approved safe configuration indicator, or an approved non-secret local marker. The DB URL itself is never printed or parsed for this confirmation.

## 16. DEV Target Secret-Handling Policy

The future executor may print only:
- DEV target signal present: yes/no
- production blocked: yes/no
- non-production process: yes/no
- DB URL value printed: no
- secret value printed: no

The future executor must **not** print: DB URL; host; username; password; port; sensitive database name; service-role key; anon key; token; connection string; or any environment variable value.

If the DEV target cannot be confirmed without exposing secret material, the future re-attempt stops before mutation.

## 17. DEV Target Safety Signal Requirements

- A non-secret, owner-approved DEV signal must be present and readable by the executor without exposing the connection secret.
- A production-blocked signal must be present (the repository production fail-closed guard remains in force; `NODE_ENV` non-production confirmed).
- The DEV signal and the connection secret must be decoupled so confirming DEV never requires handling the secret.

## 18. Owner Approval Requirements

Before the future re-attempt: the owner must explicitly approve the re-attempt; confirm Controlled Pair A is synthetic/controlled DEV-only and provided securely; approve the DEV-target signal mechanism; approve the atomicity, rollback/cleanup, audit, evidence, and redaction strategies; and accept the stop conditions. A final owner go/no-go is required immediately before, and an owner review immediately after.

## 19. Operator Role / Separation-of-Duties Requirements

- **Owner / authorizer:** approves and performs before/after review.
- **Exercise operator:** runs the controlled, server-only, owner-gated harness in DEV; collects redacted aggregate evidence.
- **Reviewer:** distinct from the requester for any approval-gated action; confirms redaction and aggregate-only evidence.
Roles are conceptual; no real actor identities appear in any document or evidence.

## 20. Future Re-Attempt Gate Checklist

1. Owner explicitly approves re-attempt.
2. Controlled Pair A has been provided securely.
3. Controlled Pair A is synthetic/controlled DEV-only.
4. Controlled Pair A values are not printed or documented.
5. Controlled Pair A presence checks pass.
6. Controlled Pair A `platform_identity` eligibility can be verified safely.
7. DEV target safe signal is present.
8. Production blocked signal is present.
9. DB URL value is not printed.
10. No secrets are printed.
11. Atomicity strategy is accepted.
12. Cleanup/disable strategy is accepted.
13. Audit writer strategy is accepted.
14. Evidence format is accepted.
15. Stop conditions are accepted.
16. No UI/API/runtime wiring is allowed.
17. Backend Control Plane remains read-only/mock-only.
18. Self-service linking remains blocked.
19. Email is not identity authority.
20. Client UID is not identity authority.

## 21. Future Re-Attempt Allowed Scope

For the future re-attempt only, allowed **if all gates pass**: a DEV aggregate count read; Controlled Pair A validation through the accepted repository/service path; the Controlled Pair A create success scenario; the Controlled Pair A idempotent repeat scenario; redaction verification; the disable cleanup scenario; final active-state confirmation; and one redacted evidence document.

## 22. Future Re-Attempt Blocked Scope

Blocked unless separately approved: conflict scenarios; missing platform_identity scenario; constraint-conflict forced scenario; revoke scenario; audit writer failure scenario; bulk linking; UI/API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise.

## 23. Required Evidence Format

Redacted and aggregate-only. Allowed: presence booleans; safe labels; safe categories; aggregate counts; count deltas; safe reason codes; lifecycle category; DEV-only confirmation; production-blocked confirmation; `redaction_applied` confirmation; "no raw value printed" confirmation.

## 24. Forbidden Evidence

Never include: raw Firebase/Supabase/provider UID; raw `internal_user_id`; raw `platform_identity`/`identity_link`/`audit_event` row; email; token; Authorization header; request/response body; DB URL; service-role key; anon key; secret; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; real customer/tenant/store names; real domains; real IPs; real request IDs.

## 25. Stop Conditions

The future re-attempt stops immediately if: Controlled Pair A is unavailable or not securely provided; any Controlled Pair A presence/eligibility check fails; the DEV target signal is absent or DEV cannot be confirmed without exposing the secret; any production signal appears; any raw identifier or secret would be printed/persisted; the atomicity strategy cannot be honored; the cleanup/disable path cannot be confirmed; an unexpected count delta, duplicate active link, or missing/failed audit occurs; any delete is attempted; any UI/API/runtime wiring is needed; Supabase MCP is required; or owner approval is unclear or withdrawn.

## 26. Rollback / Cleanup Preconditions

Before any mutation in the future re-attempt: confirm cleanup uses disable lifecycle (never delete); revoke is excluded unless separately authorized; no row deletion will occur; active-state cleanup is checkable via aggregate count categories only; a compensating disable path exists if a mutation succeeds but a later step fails; and if cleanup cannot be safely performed, stop and report.

## 27. Atomicity Preconditions

Before any mutation: confirm the repository mutation and the success audit run under an accepted atomicity strategy — preferably a shared transaction/executor context (one transaction-scoped executor injected into both the repository adapter and the audit writer so create + success audit commit/abort together). If a shared transaction is not feasible without source changes, stop unless a compensating-safe sequence was explicitly approved and can be performed safely. Never run create-success mutation and success-audit as unrelated operations.

## 28. Audit Preconditions

Before any mutation: confirm the real durable append-only writer is injected into the audit adapter; the M20.9 taxonomy is emitted with actor null and safe categories; allow-listed/scalar-only/forbidden-key redaction holds; and an audit-write failure surfaces a safe error (fail-closed). Read-only validation probes do not emit audit unless explicitly approved.

## 29. Required Pre-Reattempt Review

Immediately before the re-attempt, the owner and reviewer confirm: the gate checklist (§20) is fully satisfied; Controlled Pair A is securely provided and synthetic DEV-only; the DEV signal is present and decoupled from the secret; atomicity/cleanup/audit/evidence/redaction strategies are accepted; and stop conditions are accepted. No re-attempt proceeds on the authority of this plan alone.

## 30. Future Re-Attempt Report Requirements

The future re-attempt report must include (no executable commands or raw output): the base checkpoint; DEV-only confirmation (signal-based); owner-approval confirmation; Controlled Pair A presence/validation booleans (no values); the exact scenarios performed; the atomicity strategy used; before/after aggregate `identity_link` counts and deltas; before/after aggregate `audit_event` counts by safe category; safe reason codes; lifecycle categories; `redaction_applied` and `production_blocked` confirmations; a no-secrets/no-raw-IDs/no-rows confirmation; stop conditions encountered or not; cleanup/disable result; final state category; no-UI/API/runtime-wiring confirmation; no-production-action confirmation; and a final recommendation.

## 31. Risks and Mitigations

- **Risk: raw identifier or secret exposure during provisioning.** Mitigation: secure local mechanism; presence-only checks; redaction policy; stop condition.
- **Risk: DEV signal spoofing / wrong target.** Mitigation: owner-approved non-secret DEV signal decoupled from the secret; production-blocked signal; fail-closed guard; stop condition.
- **Risk: non-synthetic identity used.** Mitigation: synthetic/controlled DEV-only requirement; owner attestation; no reading of real identities.
- **Risk: un-audited mutation.** Mitigation: atomicity preconditions (shared transaction); fail-closed; compensation path.
- **Risk: scope creep into UI/API/runtime.** Mitigation: server-only owner-gated harness; blocked scope; post-review.
- **Risk: proceeding on this plan alone.** Mitigation: explicit separate owner approval + pre-re-attempt review required.

## 32. Forbidden Conclusions

This document does **not** claim: that the blockers are already resolved; that Controlled Pair A has already been provided; that the DEV target is already confirmed; that the DEV DB exercise was performed; that `identity_link`/`audit_event` rows were inserted; that the repository or audit adapter is wired to runtime; that the Backend Control Plane or an API can create identity links; that production is ready; that server authorization is authoritative; that the frontend should consume server authorization; that self-service identity linking is approved; that email is an identity authority; that a client-supplied UID is an authority; that mutation/audit atomicity is already implemented; or that rollback was tested live.

It affirms: **M20.17A is blocker-resolution planning only**; no DB connection occurred; no SQL was run; no rows were inserted; no runtime behavior changed; a future re-attempt requires separate explicit owner approval; production remains blocked; identity-link runtime wiring remains absent; the Backend Control Plane remains read-only/mock-only; self-service linking remains blocked; email is not identity authority; client-supplied UID is not identity authority; and `internal_user_id` remains the app-owned stable anchor.

## 33. Final Recommendation

**Recommend ACCEPT as the blocker-resolution plan.** It defines a safe, secret-free, redaction-safe path for a future re-attempt: a secure Controlled Pair A provisioning/secret-handling/validation policy and an executor-confirmable DEV-target signal decoupled from the connection secret, plus the gate checklist, allowed/blocked scope, evidence/redaction rules, stop conditions, and atomicity/cleanup/audit preconditions. Execution remains blocked until the owner provisions Controlled Pair A and the DEV signal and explicitly approves the re-attempt.

## 34. Recommended Next Milestone

- `Phase 1.6 M20.17A — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- After backup, and only after the owner provisions Controlled Pair A + the DEV signal and approves: `Phase 1.6 M20.17B — Identity Link DEV Controlled DB Exercise Re-Attempt Authorization` (re-attempt authorization gate), preceding any actual re-execution.

No commit, push, or backup is performed by this milestone. Stop for owner review.
