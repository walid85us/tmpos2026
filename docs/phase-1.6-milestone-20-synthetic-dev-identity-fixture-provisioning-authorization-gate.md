# Phase 1.6 M20.19 — Synthetic DEV Identity Fixture Provisioning Authorization Gate

## 1. Title

Phase 1.6 Milestone 20.19 — Synthetic DEV Identity Fixture Provisioning Authorization Gate (documentation-only authorization record).

## 2. Purpose

This document is a documentation-only authorization gate. Its single purpose is to decide whether a future, separate execution milestone (M20.20) may be requested to provision a synthetic DEV-only identity fixture, or whether that future provisioning must remain blocked. This milestone selects/authorizes or blocks the future provisioning option. It does not create any fixture, connect to any database, run any statement, mutate any table, insert any row, create any route, modify any runtime wiring, or modify any UI. It produces only this authorization-gate record and the accompanying final report.

## 3. Current Accepted Checkpoint

Accepted checkpoint immediately preceding this milestone: ded83f710c017fc8ebda91a73bf294429da68dd2. Most recent accepted commit subject: "Phase 1.6 M20.18 document synthetic DEV identity fixture plan." No checkpoint advancement occurs within this milestone; any commit/backup is deferred to a separate Scoped Commit and Backup Authorization step.

## 4. Scope

In scope for M20.19:

- Create exactly one new documentation-only file: this authorization-gate record.
- Evaluate, using safe presence-only signals, whether the owner-approval and safety conditions required to permit a future Option B synthetic fixture provisioning execution are present and accepted.
- Record a single authorization decision drawn from the allowed decision set.
- Capture the source-of-truth artifacts, the M20.18 fixture plan summary, the accepted read-only discovery result, the option review, the per-gate status, the authorized/blocked future scope, the required future preconditions, the required future evidence format, the forbidden evidence/runtime/conclusions, the future execution checklist, the post-fixture path to M20.17C, and the risks and mitigations.

## 5. Non-Goals

Not goals of M20.19:

- Creating a synthetic anchor, synthetic provider reference, or any fixture.
- Connecting to any database; running any statement, schema change, or migration.
- Inserting any platform_identity, identity_link, or audit_event row.
- Calling the repository adapter against a real database or the audit adapter against a real durable writer.
- Creating or modifying routes, API endpoints, startup/server wiring, frontend UI, or Backend Control Plane UI.
- Wiring any server-side authorization, identity-link, harness, feed, token-bridge, or comparison capability into runtime.
- Making server authorization authoritative or having the frontend consume server authorization.
- Committing, pushing, or backing up (handled by a separate authorization step).

## 6. Source-of-Truth Artifacts

This gate relies only on previously accepted artifacts and findings:

- M20.18 synthetic DEV identity fixture provisioning plan.
- M20.17B-Repair re-attempt authorization correction record (NOT READY / correction incomplete).
- M20.17B re-attempt authorization record (NOT READY).
- M20.17A exercise blocker resolution plan.
- M20.17 first controlled DB exercise evidence (BLOCKED BEFORE MUTATION).
- M20.16 controlled DB exercise authorization gate.
- M20.15 identity-link DEV manual QA runbook.
- M20.8 identity-link creation-flow plan.
- M20.9 identity-link audit-event plan.
- Identity-link admin provisioning implementation plan.
- M20.12 identity-link DEV repository / audit adapter plan.
- Server-only identity-link admin provisioning module and its test.
- Server-only identity-link DEV repository module.
- Server-only identity-link audit adapter module.
- Server-only identity-link DEV adapters test.
- Migration set for identity_link (up/down) and the platform_identity migration set.
- DEV identity-link apply evidence record.
- M21 Backend Control Plane charter plan and M22A read-only shell UI foundation plan.

No expansion beyond accepted architecture is introduced here. All references are conceptual; no raw contents, values, or identifiers from those artifacts are reproduced.

## 7. M20.18 Fixture Plan Summary

The accepted M20.18 plan established, at a conceptual level, that no eligible Controlled Pair A currently exists, defined the required synthetic DEV fixture outcome (one synthetic DEV-only internal anchor mapped to one synthetic Firebase-side provider reference and one synthetic Supabase-side provider reference), evaluated three provisioning options (A align existing, B create synthetic, C block and build a dedicated DEV test-data framework first), and conservatively recommended Option B only with explicit owner approval plus schema support plus a uniqueness strategy plus a rollback/cleanup strategy plus redacted evidence, and otherwise recommended Option C. The plan created no fixture, connected to no database, and changed no runtime behavior.

## 8. Read-Only Discovery Summary

Accepted read-only discovery result (aggregate counts/booleans only; no values):

- Firebase candidate count: 1.
- Supabase candidate count: 2.
- Shared-anchor candidate pair count: 0.
- Eligible Controlled Pair A exists: no.
- DB write occurred: no.
- identity_link row inserted: no.
- audit_event row inserted: no.

This confirms there is presently no Firebase-and-Supabase pair sharing one internal anchor, so a controlled DB exercise of identity linking cannot proceed without first provisioning a synthetic fixture.

## 9. Authorization Problem Statement

The first controlled DB exercise (M20.17 and re-attempts) cannot proceed because there is no eligible Controlled Pair A and because there is no confirmed secure mechanism to distinguish a DEV target from a production target without handling protected connection material. The existing provider references are prior pilot identities, not a designated synthetic fixture, and cannot be confirmed synthetic without reading raw values, which is forbidden. Therefore a synthetic DEV-only fixture is a prerequisite. M20.19 must decide whether a future execution milestone to create that fixture may be requested, strictly subject to owner approval and safety signals being present and accepted.

## 10. Option Selection Review

Three provisioning options are reviewed below. The decision criteria are: explicit owner approval present and accepted; DEV target and production-blocked confirmations present; schema support, uniqueness, rollback/cleanup, redacted-evidence, audit-policy, no-identity_link-rows, no-runtime/UI/API-exposure, stop-condition, and operator/reviewer separation acceptances present. Any missing required signal forces a NOT AUTHORIZED outcome.

## 11. Option A Authorization Decision

- Decision: NOT AUTHORIZED / not preferred.
- Reason: Aligning existing provider references would require proving they are genuinely synthetic and that a shared-anchor alignment is safe, which cannot be done without reading raw values; raw value exposure is forbidden, and the references are prior pilot identities rather than a designated synthetic fixture.
- Required approvals (for any future reconsideration): explicit owner approval that specific references are synthetic and safe to align; operator/reviewer separation; DEV target and production-blocked confirmations.
- Risk level: high (risk of touching non-synthetic identities; risk of raw value handling).
- Future allowed evidence: aggregate counts/booleans only; no raw identifiers.
- Stop conditions: any need to read, print, or parse a raw identifier; any ambiguity about whether a reference is synthetic; any inability to confirm DEV target safely.

## 12. Option B Authorization Decision

- Decision: NOT AUTHORIZED at this time (preferred path only if all approval and safety gates pass; gates do not currently pass).
- Reason: The required owner-approval and safety signals are not present/accepted (see Sections 14–25). Option B is the preferred future path, but it may only be requested as a future execution milestone (M20.20) once all required signals are present and accepted.
- Required approvals: explicit Option B owner approval; DEV target confirmation; production-blocked confirmation; schema support confirmation; uniqueness strategy acceptance; rollback/cleanup strategy acceptance; redacted evidence acceptance; audit policy acceptance; no-identity_link-rows-during-provisioning acceptance; no-runtime/UI/API-exposure acceptance; stop-condition acceptance; operator/reviewer separation acceptance.
- Risk level: medium (controlled, synthetic-only, single anchor plus two provider references), contingent on all gates passing; otherwise elevated.
- Future allowed evidence: aggregate-only counts and booleans (for example, candidate-count deltas and pair-count delta), redacted; explicit confirmations that no identity_link and no unauthorized audit_event rows were inserted; rollback/cleanup evidence.
- Stop conditions: any missing approval/safety signal; any inability to confirm DEV target without protected material exposure; any uniqueness conflict; any need to print raw values; any unexpected mutation surface.

## 13. Option C Authorization Decision

- Decision: AUTHORIZED as the fallback planning path (no execution within M20.19).
- Reason: If a direct Option B fixture cannot be safely authorized, the conservative path is to first plan a dedicated DEV test-data framework that provides a safe DEV-target confirmation mechanism, deterministic synthetic identifiers, and safe rollback, before any fixture write is requested.
- Required approvals: owner direction to pursue a dedicated DEV test-data framework planning milestone.
- Risk level: low (planning-only; no DB; no rows; no runtime change).
- Future allowed evidence: planning documentation only; no DB connection, no rows, no runtime change.
- Stop conditions: any attempt to connect to a database, run a statement, or insert a row under the guise of planning.

## 14. Owner Approval Signal Status

Owner-approval signals were checked using safe presence-only booleans; no values were read into this document. Result: the Option B owner-approval signal is missing, and the operator/reviewer separation approval signal is missing. Aggregate result: no owner-approval signal is present. Status: MISSING.

## 15. DEV Target Signal Status

DEV target confirmation signal checked by safe presence only. Result: missing. There is no confirmed secure mechanism present to distinguish a DEV target from a production target without handling protected connection material. Status: MISSING.

## 16. Production-Blocked Signal Status

Production-blocked confirmation signal checked by safe presence only. Result: missing as an explicit accepted signal. Independent of this signal, production remains blocked by standing project policy; no production action is taken or authorized here. Status: MISSING (explicit signal) / production remains blocked by policy.

## 17. Schema Support Gate

Schema support confirmation signal checked by safe presence only. Result: missing. Whether the platform_identity schema supports a clearly-marked synthetic DEV-only anchor and provider references in a way that respects uniqueness has not been confirmed as an accepted signal. Status: MISSING.

## 18. Uniqueness Strategy Gate

Uniqueness strategy acceptance signal checked by safe presence only. Result: missing. A strategy that guarantees the synthetic provider references do not collide with existing active uniqueness constraints has not been accepted. Status: MISSING.

## 19. Rollback / Cleanup Strategy Gate

Rollback/cleanup strategy acceptance signal checked by safe presence only. Result: missing. A documented rollback/cleanup/disable strategy for the synthetic fixture has not been accepted as a signal. Status: MISSING.

## 20. Redacted Evidence Gate

Redacted evidence acceptance signal checked by safe presence only. Result: missing. Acceptance that future evidence will be aggregate-only and redacted has not been recorded as a signal. Status: MISSING.

## 21. Audit Policy Gate

Audit policy acceptance signal checked by safe presence only. Result: missing. Acceptance of the audit policy for fixture provisioning (including that fixture provisioning does not itself create identity_link audit events unless separately authorized) has not been recorded as a signal. Status: MISSING.

## 22. No identity_link Rows During Fixture Provisioning Gate

Acceptance that no identity_link rows are inserted during fixture provisioning checked by safe presence only. Result: missing as an explicit signal. The standing requirement that fixture provisioning creates only platform_identity anchor/provider references and no identity_link rows remains in force regardless. Status: MISSING (explicit signal) / requirement remains in force.

## 23. No Runtime / UI / API Exposure Gate

Acceptance that no runtime, UI, or API exposure is introduced by fixture provisioning checked by safe presence only. Result: missing as an explicit signal. The standing requirement that no route, endpoint, UI control, or runtime wiring is created remains in force regardless. Status: MISSING (explicit signal) / requirement remains in force.

## 24. Stop-Condition Gate

Stop-condition acceptance signal checked by safe presence only. Result: missing. Acceptance of the stop conditions that must halt a future provisioning execution (for example, inability to confirm DEV target safely, uniqueness conflict, any raw-value exposure need) has not been recorded as a signal. Status: MISSING.

## 25. Operator / Reviewer Separation Gate

Operator/reviewer separation acceptance signal checked by safe presence only. Result: missing. Acceptance that a future provisioning execution will observe separation between the operator performing it and the reviewer approving it has not been recorded as a signal. Status: MISSING.

## 26. Authorization Decision

Decision: B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING.

Rationale: The Option B owner-approval signal and the operator/reviewer separation approval signal are both missing (Sections 14 and 25), which by the decision rules requires a NOT AUTHORIZED outcome. Independently, the DEV target and production-blocked explicit signals are missing (Sections 15–16, satisfying the conditions of Decision C), and the schema support, uniqueness, rollback/cleanup, and stop-condition signals are missing (Sections 17–19, 24, satisfying the conditions of Decision D). Because multiple independent required signals are missing, no path to Decision A exists at this time. The leading and governing decision is B. As a forward path, if the owner does not intend to provision the explicit per-signal approvals, the conservative fallback recorded here is the Option C dedicated DEV test-data framework planning path (consistent with Decision F intent and the M20.18 recommendation). No future fixture provisioning execution (M20.20) may be requested until the missing signals are present and accepted.

No fixture was created. No platform_identity, identity_link, or audit_event row was inserted. Controlled Pair A does not now exist. M20.17C is not authorized. M20.20 was not executed.

## 27. Authorized Future Fixture-Provisioning Scope

Authorized future scope is contingent and conditional only: should all required owner-approval and safety signals later become present and accepted (yielding a future Decision A), the only execution milestone that may then be requested is M20.20 — Synthetic DEV Identity Fixture Provisioning Execution, strictly limited to: a single synthetic DEV-only internal anchor; a single synthetic DEV-only Firebase-side platform_identity reference; a single synthetic DEV-only Supabase-side platform_identity reference; mapping both provider references to the same synthetic internal anchor; aggregate-only delta validation; explicit confirmation of no identity_link rows and no unauthorized audit_event rows; redacted aggregate-only evidence; and a rollback/cleanup or disable plan with evidence. Nothing in M20.19 itself authorizes any execution.

## 28. Blocked Future Scope

The following remain blocked and are not authorized by this gate: identity_link creation; audit_event creation for identity_link; conflict scenarios; missing-platform_identity forced scenarios; constraint-conflict forced scenarios; revoke lifecycle exercises; audit-writer failure simulation; bulk linking; UI exposure; API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise; making server authorization authoritative; frontend consumption of server authorization; self-service identity linking; treating email or client-supplied UID as identity authority.

## 29. Required Future Fixture-Provisioning Preconditions

Before any future M20.20 execution may be requested, all of the following must be present and accepted: explicit Option B owner approval; operator/reviewer separation acceptance; DEV target confirmation via a safe signal; production-blocked confirmation; schema support confirmation; uniqueness strategy acceptance; rollback/cleanup strategy acceptance; redacted evidence acceptance; audit policy acceptance; no-identity_link-rows-during-provisioning acceptance; no-runtime/UI/API-exposure acceptance; and stop-condition acceptance. If any precondition is absent, the future request remains NOT AUTHORIZED.

## 30. Required Future Evidence Format

Any future provisioning evidence must be aggregate-only and redacted: counts, count deltas, and booleans only (for example, candidate-count change and shared-anchor pair-count delta), plus explicit boolean confirmations that no identity_link rows and no unauthorized audit_event rows were inserted, plus rollback/cleanup status. No raw identifiers, values, rows, connection material, or payloads may appear in any evidence.

## 31. Forbidden Evidence

Future evidence must never include: executable code; executable statements; shell, psql, CLI, migration-runner, or DB-connection commands; database URLs; environment variable values; service-role keys; anon key values; tokens; Authorization headers; request headers; request bodies; raw responses; raw identity rows; raw audit rows; real Firebase UID; real Supabase UID; real provider UID; real internal_user_id; real emails; real tenant/store/customer names; real domains; real IPs; real request IDs; actor UUIDs; audit metadata dumps; raw authorization objects; raw harness/feed/comparison output; permission key lists; entitlement key lists; mismatch lists; or raw payloads.

## 32. Forbidden Runtime Changes

No future fixture-provisioning work may: create routes or API endpoints; modify startup or server wiring; modify frontend UI or Backend Control Plane UI; expose identity-link creation or fixture provisioning through UI or API; wire the repository or audit adapter into runtime; wire prior authorization, harness, feed, token-bridge, or comparison capabilities into runtime; modify AccessContext, Login, AccessGuard, App, main, or pilot; modify migrations, seeds, or package files; make server authorization authoritative; or perform any production action.

## 33. Forbidden Conclusions

This document does not claim, and future work must not claim without separate authorization, that: a fixture was created; platform_identity rows were inserted; identity_link rows were inserted; audit_event rows were inserted; Controlled Pair A now exists; M20.17C is authorized; M20.20 was executed; the repository adapter is wired to runtime; the audit adapter is wired to runtime; the Backend Control Plane can create identity links; an API can create identity links; production is ready; server authorization is authoritative; the frontend should consume server authorization; self-service identity linking is approved; email is identity authority; client UID is identity authority; mutation/audit atomicity is implemented globally; or rollback was tested live.

## 34. Future Fixture-Provisioning Execution Checklist

For a future M20.20 execution, only after a Decision A is recorded: confirm all preconditions present and accepted; confirm DEV target via safe signal; confirm production blocked; confirm schema supports a clearly-marked synthetic DEV-only anchor and provider references; apply the accepted uniqueness strategy; create exactly one synthetic anchor and exactly two synthetic provider references mapped to that anchor; validate the shared-anchor pair-count delta as aggregate-only; confirm no identity_link rows inserted; confirm no unauthorized audit_event rows inserted; produce redacted aggregate-only evidence; produce rollback/cleanup or disable evidence; stop immediately on any stop-condition.

## 35. Post-Fixture Path to M20.17C

Only after a synthetic fixture is provisioned (future M20.20) and an eligible Controlled Pair A is shown to exist via a future read-only aggregate check, and only after the M20.17B re-attempt authorization gates pass, may a future M20.17C controlled DB exercise be requested. M20.17C remains blocked until those conditions are met. This gate does not authorize M20.17C.

## 36. Risks and Mitigations

- Risk: provisioning could touch non-synthetic identities. Mitigation: synthetic-only, clearly-marked anchor and references; Option A not preferred; no raw value handling.
- Risk: DEV-vs-production target ambiguity. Mitigation: require a safe DEV-target confirmation signal; absent it, remain NOT AUTHORIZED; production blocked by policy.
- Risk: uniqueness collision. Mitigation: require an accepted uniqueness strategy before any write.
- Risk: raw value exposure in evidence. Mitigation: aggregate-only, redacted evidence; forbidden-evidence list enforced.
- Risk: scope creep into linking/audit/runtime/UI/API. Mitigation: explicit blocked-scope list; separate approvals required.
- Risk: irreversible changes. Mitigation: require an accepted rollback/cleanup/disable strategy and evidence.
- Risk: separation-of-duties lapse. Mitigation: require operator/reviewer separation acceptance.

## 37. Final Recommendation

Record Decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. No future synthetic DEV identity fixture provisioning execution (M20.20) may be requested at this time. To unblock a future Option B execution, the owner must provision the explicit approval and safety signals listed in Section 29 and re-run this gate; alternatively, pursue the Option C dedicated DEV test-data framework planning path. M20.19 is authorization-gate only: no DB connection occurred, no statement was run, no rows were inserted, and no runtime behavior changed. M20.17C remains blocked until a valid Controlled Pair A exists and the re-attempt gates pass. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.

## 38. Recommended Next Milestone

Recommended next milestone: Phase 1.6 M20.19 — Scoped Commit and Backup Authorization (to commit and back up this authorization-gate record). Because the authorization decision is NOT AUTHORIZED, after the M20.19 backup, fixture work pauses until the owner provisions the required approval and safety signals (Section 29) or directs the Option C dedicated DEV test-data framework planning path. A future M20.20 — Synthetic DEV Identity Fixture Provisioning Execution may only be requested after a future Decision A is recorded.
