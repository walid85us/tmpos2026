# Phase 1.6 — Milestone 20.18: Synthetic DEV Identity Fixture Provisioning Plan / Authorization Gate (Planning-Only)

## 1. Title

Phase 1.6 Milestone 20.18 — Synthetic DEV Identity Fixture Provisioning Plan / Authorization Gate (planning-only; no DB connection; no SQL; no rows inserted; non-authoritative). Defines how a future, separately-approved milestone may create a synthetic DEV-only `platform_identity` fixture that yields a valid Controlled Pair A for the later identity-link DEV DB exercise (M20.17C).

## 2. Purpose

Define, in a redaction-safe form, the future required synthetic DEV identity fixture, its requirements, evaluated provisioning options, gates, evidence/redaction rules, rollback, and the post-fixture re-attempt path. This milestone (M20.18) is **planning only**: it opens no DB connection, runs no SQL, mutates no `platform_identity`, inserts no `identity_link`/`audit_event` rows, wires nothing, and changes no runtime behavior. It does **not** create the fixture.

## 3. Current Accepted Checkpoint

- Accepted checkpoint at authoring time: `cecfd727c712c941328a05af3d9c912b42aaf3f3`.
- Most recent commit subject at base: "Phase 1.6 M20.17B-Repair record identity link DEV correction incomplete".
- Accepted status carried forward: M20.11–M20.16 ACCEPTED; M20.17 BLOCKED BEFORE MUTATION; M20.17A ACCEPTED; M20.17B NOT READY; M20.17B-Repair NOT READY / CORRECTION INCOMPLETE; M20.17B-Discovery read-only discovery complete; M21, M22A, M22B, M22C ACCEPTED.
- This plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope

A written plan: read-only discovery summary; problem statement; the required fixture outcome; synthetic DEV-only, Controlled Pair A, `platform_identity` fixture, internal anchor, and provider reference requirements; email-not-authority and client-UID-not-authority rules; owner approvals and separation-of-duties; DEV/production boundaries; secret-handling/redaction policy; an evaluation of provisioning options (A/B/C); allowed/blocked future scope; preconditions; safe/forbidden evidence; stop conditions; rollback/cleanup; audit and atomicity requirements; future fixture-provisioning report requirements; and the post-fixture re-attempt path.

## 5. Non-Goals

No DB connection; no SQL/DDL; no migration apply; no `platform_identity`/`identity_link`/`audit_event` row write; no call of the adapters against a real DB or real writer; no Supabase MCP; no route/API/UI/BCP change; no startup/runtime wiring; no change to AccessContext/Login/AccessGuard/App/main/pilot, the M20.11/M20.13/M20.14 source/tests, prior M20.x docs, the audit writer, the identity repository, the 001/004 or other migrations, package files, or seeds; no commit/push/backup as part of authoring. M20.18 does **not** create the fixture.

## 6. Source-of-Truth Artifacts

Derived only from accepted artifacts: the M20.17B-Repair correction record; the M20.17B NOT-READY record; the M20.17A blocker-resolution plan; the M20.17 blocked evidence; the M20.16 gate; the M20.15 runbook; the M20.8/M20.9/M20.10/M20.12 plans; the M20.11 service + test; the M20.13 adapters + test; the M20.14 hardening; the 001 `platform_identity` and 004 `identity_link` migrations; the M20.6/M20.7 DEV apply + evidence document; the M21/M22A docs; and the M20.17B-Discovery read-only result.

## 7. Read-Only Discovery Summary

The accepted M20.17B-Discovery read-only result (counts/booleans only; no raw values; no writes): Firebase candidate count = 1; Supabase candidate count = 2; shared-anchor candidate pair count = 0; synthetic DEV-only confirmation = unknown; no-customer-impact confirmation = unknown; eligible Controlled Pair A exists = no; raw values printed = no; DB URL printed = no; secret printed = no; SQL shown = no; DB write = no; `identity_link` inserted = no; `audit_event` inserted = no.

## 8. Problem Statement

No eligible Controlled Pair A currently exists: the present Firebase-side (1) and Supabase-side (2) `platform_identity` references do not form a controlled, clearly-synthetic, non-customer-impacting set with a designated anchor, and none could be confirmed synthetic without reading raw values (forbidden). Because `platform_identity` keys each row by an internal anchor with exactly one provider reference, a Controlled Pair A is composed of a Firebase-side reference, a Supabase-side reference, and a designated internal anchor — all of which must be clearly synthetic and DEV-only for the exercise. The existing references are the prior pilot identities, not designated synthetic controlled fixtures, so M20.17C cannot proceed until a valid synthetic fixture exists.

## 9. Required Fixture Outcome

The future fixture must result in (conceptual; no raw values): one synthetic DEV-only internal anchor category; one synthetic DEV-only Firebase-side `platform_identity` reference; one synthetic DEV-only Supabase-side `platform_identity` reference; both provider references associated with the same designated synthetic internal anchor; no real customer-impacting identity; no email used as identity authority; no client-supplied UID used as identity authority; no `identity_link` row created during fixture provisioning (unless separately authorized later); no `audit_event` row created (unless fixture-provisioning audit is explicitly approved); no UI/API/runtime wiring; and redacted aggregate-only evidence.

## 10. Synthetic DEV-Only Requirements

- The fixture is DEV-only; production is excluded.
- All fixture references are clearly synthetic and recognizable as test fixtures (e.g., a reserved synthetic namespace category), never resembling real customer identities.
- The fixture introduces no real personal data; any email-shaped field, if present at all, uses a clearly non-deliverable reserved category and is never an authority.
- The fixture is isolated and cleanly identifiable for later cleanup.

## 11. Controlled Pair A Requirements

Controlled Pair A = a synthetic Firebase-side reference + a synthetic Supabase-side reference + a designated synthetic internal anchor, all DEV-only, verified-both-sides-capable, and clearly non-customer-impacting. Provider references are opaque and never printed; email is never authority; client-supplied UID is never authority. The pair must satisfy the M20.11 service guards and the M20.13 repository read paths (anchor eligibility + provider-reference existence) using only safe presence checks.

## 12. platform_identity Fixture Requirements

- The fixture rows must conform to the existing `platform_identity` schema (001 migration) without any schema change: a provider-aware reference keyed by `(auth_provider, auth_provider_uid)`, with the app-owned internal anchor.
- Existing uniqueness constraints must be respected (no duplicate `(auth_provider, auth_provider_uid)`).
- No `ALTER`/DDL/migration; only data rows conforming to the current schema, and only if a write option is separately approved.
- No modification of existing non-fixture `platform_identity` rows.

## 13. Internal Anchor Requirements

The internal anchor is the app-owned stable identifier referenced by both provider sides for the link. For the fixture, a single designated synthetic anchor category must be associated with both the synthetic Firebase-side and Supabase-side references so the future link resolves all three FK targets. The anchor must be a valid `platform_identity` internal anchor (DEV-only synthetic) and never a provider UID.

## 14. Provider Reference Requirements

- One synthetic Firebase-side reference (`auth_provider = firebase`, synthetic opaque uid category).
- One synthetic Supabase-side reference (`auth_provider = supabase`, synthetic opaque uid category).
- Both must exist in `platform_identity` (so the M20.13 repository existence checks pass) and map to the designated synthetic anchor for the future link.
- References are opaque, never printed, and clearly synthetic.

## 15. Email-Not-Authority Rule

Email is never an identity authority for the fixture or the future link. `identity_link` does not store or reference email. Any email-shaped fixture field uses a clearly non-deliverable reserved category and carries no authority.

## 16. Client-UID-Not-Authority Rule

A client-supplied UID is never an authority. The synthetic provider references are server-owned fixtures; they are never asserted by a client. The M20.11 guards (`email_as_authority_forbidden`, `client_uid_authority_forbidden`) remain in force.

## 17. Owner Approval Requirements

The future fixture milestone requires **explicit, separate owner approval** distinct from accepting this plan, covering: the DEV-only target; the chosen option (A/B/C); the synthetic reference categories (provided securely, not printed); the write authorization (if Option B); the rollback/cleanup plan; the evidence format; and the stop conditions. A final owner go/no-go is required before and a review after.

## 18. Operator / Reviewer Separation-of-Duties

- **Owner / authorizer:** approves and reviews.
- **Fixture operator:** performs the approved, server-only, owner-gated fixture provisioning in DEV; collects redacted aggregate evidence.
- **Reviewer:** distinct from the requester; confirms synthetic-only, redaction, and aggregate-only evidence.
Roles are conceptual; no real actor identities appear in any document or evidence.

## 19. DEV Target and Production Blockers

DEV-only via the server-side owner-role path; production is hard-blocked. The repository production fail-closed guard remains in force; an executor-confirmable DEV signal (decoupled from the connection secret) must be present before any future write. No production target, connection, or action is in scope.

## 20. Secret-Handling and Redaction Policy

No DB URL, host, credential, key, token, or connection string is ever printed, parsed, logged, committed, or pasted externally. Synthetic references are handled by reference (secure local mechanism), never printed. Evidence is redacted and aggregate-only (counts/categories/booleans). No raw row, identifier, or secret appears anywhere.

## 21. Future Fixture-Provisioning Options

### Option A — Align existing synthetic provider identities (if architecture permits)
- **Description:** identify whether any existing `platform_identity` references are already clearly synthetic and DEV-only, and designate a Controlled Pair A from them (no new rows).
- **Benefits:** no new writes; minimal footprint.
- **Risks:** the existing references are prior pilot identities, not designated synthetic; synthetic/non-customer-impact cannot be confirmed without reading raw values (forbidden); high ambiguity/customer-impact risk.
- **Required approvals:** owner confirmation that specific references are synthetic DEV-only (via secure mechanism, not printed).
- **Allowed evidence:** presence/category booleans; aggregate counts.
- **Forbidden evidence:** any raw reference/identifier/email/secret.
- **Stop conditions:** synthetic status unconfirmable; any raw-value exposure required.
- **Recommendation:** **not preferred** (cannot safely confirm synthetic without exposure).

### Option B — Create a new synthetic DEV-only anchor + two synthetic provider rows
- **Description:** under explicit owner approval, insert a clearly-synthetic DEV-only internal anchor and two synthetic provider-aware `platform_identity` rows (one Firebase-side, one Supabase-side) conforming to the existing schema, respecting uniqueness.
- **Benefits:** clearly synthetic, controlled, isolated, cleanly identifiable and removable; unambiguous non-customer-impact.
- **Risks:** requires a `platform_identity` write (no approved write path exists today); must respect uniqueness; rollback/cleanup of synthetic rows must be documented; must avoid touching non-fixture rows.
- **Required approvals:** explicit owner approval of a DEV-only synthetic fixture write; schema-support confirmation; uniqueness respected; documented rollback; redacted evidence.
- **Allowed evidence:** fixture status category; synthetic-anchor / Firebase-side / Supabase-side count deltas; shared-anchor pair count delta; DEV-only and production-blocked confirmations; no-`identity_link`/no-`audit_event` confirmations.
- **Forbidden evidence:** any raw reference/identifier/email/row/secret.
- **Stop conditions:** any production signal; any raw-value exposure; uniqueness violation; modification of non-fixture rows; cleanup not confirmable.
- **Recommendation:** **preferred ONLY if** the owner explicitly approves a DEV-only synthetic fixture write, the schema supports it, uniqueness is respected, rollback/cleanup is documented, and evidence remains redacted.

### Option C — Block fixture provisioning until a dedicated test-data framework exists
- **Description:** defer fixture creation; first plan/build a dedicated DEV-only synthetic test-data framework (reserved synthetic namespace, isolation, cleanup, redacted evidence) before any fixture write.
- **Benefits:** strongest isolation/repeatability; lowest risk.
- **Risks:** more milestones before M20.17C.
- **Required approvals:** owner approval to invest in a test-data framework plan.
- **Allowed/forbidden evidence:** as above (planning-only meanwhile).
- **Stop conditions:** n/a (no writes).
- **Recommendation:** **fallback** if Option B is not approved.

## 22. Allowed Future Fixture-Provisioning Scope

If approved (Option B), the future milestone may, in DEV only and under explicit owner approval: insert one synthetic anchor and two synthetic provider-aware `platform_identity` rows conforming to the existing schema; read aggregate counts before/after; verify (presence-only) that a Controlled Pair A now exists; and produce one redacted evidence document. No `identity_link` or `audit_event` row is created during fixture provisioning unless separately authorized.

## 23. Blocked Future Fixture-Provisioning Scope

Blocked unless separately approved: any `identity_link` creation; any `audit_event` write during fixture provisioning; any schema change/DDL/migration; any modification of existing non-fixture rows; any production target; any UI/API/BCP/runtime exposure of fixture provisioning; any real (non-synthetic) identity use; bulk fixtures; self-service linking.

## 24. Required Future Fixture-Provisioning Preconditions

Before any future fixture write: explicit owner approval of the option and DEV-only target; an executor-confirmable DEV signal decoupled from the connection secret; production-blocked signal; synthetic reference categories provided securely (not printed); schema-support and uniqueness confirmation; a documented rollback/cleanup plan; an accepted redacted-evidence format; and accepted stop conditions. A pre-provisioning review confirms all gates.

## 25. Safe Evidence Requirements

Allowed future evidence: fixture provisioning status category; DEV-only confirmation; production-blocked confirmation; synthetic-internal-anchor count delta; Firebase-side synthetic `platform_identity` count delta; Supabase-side synthetic `platform_identity` count delta; shared-anchor pair (Controlled Pair A) count delta; no-`identity_link`-row-inserted confirmation; no-`audit_event`-row-inserted confirmation (unless separately approved); raw values printed = no; secrets printed = no; DB URL printed = no; email-as-authority = no; client-UID-as-authority = no; UI/API/runtime wiring = no; safe reason codes; aggregate counts only.

## 26. Forbidden Evidence

Never include: raw Firebase/Supabase/provider UID; raw `internal_user_id`; raw `platform_identity`/`identity_link`/`audit_event` rows; emails; tokens; Authorization headers; request/response bodies; DB URL; service-role key; anon key; secrets; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; real customer/tenant/store names; real domains; real IPs; real request IDs.

## 27. Stop Conditions

The future fixture milestone stops immediately if: any production signal appears; any raw identifier/secret would be printed/persisted; the DEV target cannot be confirmed without exposing secret material; synthetic status cannot be guaranteed; a uniqueness violation occurs; a non-fixture row would be modified; cleanup/rollback cannot be confirmed; unexpected count deltas occur; or owner approval is unclear or withdrawn.

## 28. Rollback / Cleanup / Disable Requirements

- Fixture cleanup affects **only** the synthetic fixture rows (clearly identified); non-fixture rows are never modified or deleted.
- The owner chooses, at approval time, whether synthetic fixture rows are retained as labeled DEV fixtures or removed after the exercise; either path is documented with redacted aggregate evidence.
- Any later `identity_link` lifecycle cleanup remains **disable-only** (never delete), per the accepted runbook; the 004 down migration is not invoked by routine cleanup.
- A backup/known-good DEV baseline is in place before any write.

## 29. Audit Requirements

Fixture provisioning is a `platform_identity` data action, distinct from identity-link audit. No `audit_event` row is written during fixture provisioning unless a fixture-provisioning audit is explicitly approved; if approved, it uses redacted safe categories only (no identifiers). The identity-link audit taxonomy (M20.9) applies only to the later, separately-approved link exercise.

## 30. Atomicity Requirements

If Option B is approved, the synthetic anchor and the two provider rows should be created under a single transaction (all-or-nothing) so a partial fixture cannot persist; on any failure, the transaction aborts leaving no partial state, and the operation fails closed with a safe category. (The later identity-link create + success audit atomicity remains a separate M20.17C precondition.)

## 31. Future Fixture-Provisioning Report Requirements

The future report must include (no executable commands or raw output): the base checkpoint; DEV-only confirmation (signal-based); owner-approval confirmation; the chosen option; before/after aggregate counts (synthetic anchor, Firebase-side, Supabase-side, shared-anchor pair) and deltas; no-`identity_link`/no-`audit_event` confirmations (unless audit separately approved); `redaction_applied` and `production_blocked` confirmations; a no-secrets/no-raw-IDs/no-rows-printed confirmation; stop conditions encountered or not; rollback/cleanup decision and result; final state category; a no-UI/API/runtime-wiring confirmation; a no-production-action confirmation; and a final recommendation.

## 32. Post-Fixture Re-Attempt Path

After a valid synthetic Controlled Pair A exists and is securely provided (presence-only), the path returns to the re-attempt authorization gate (M20.17B-Repair-2 or a corrected re-attempt authorization), then — only if all gates pass — to M20.17C execution. Production remains blocked throughout; runtime wiring remains absent; the Backend Control Plane remains read-only/mock-only.

## 33. Risks and Mitigations

- **Risk: customer-impact ambiguity (Option A).** Mitigation: prefer Option B (clearly synthetic) or Option C (framework first).
- **Risk: raw identifier/secret exposure.** Mitigation: presence-only checks; secure reference handling; redaction policy; no printing.
- **Risk: wrong/production target.** Mitigation: DEV signal decoupled from secret; production-blocked signal; fail-closed guard.
- **Risk: partial fixture / uniqueness violation.** Mitigation: single-transaction atomicity; uniqueness respected; fail-closed.
- **Risk: touching non-fixture data.** Mitigation: synthetic-only writes; never modify existing rows; documented cleanup limited to fixtures.
- **Risk: scope creep into identity-link writes.** Mitigation: blocked scope; no `identity_link` row during fixture provisioning.

## 34. Forbidden Conclusions

This document does **not** claim: that a fixture was created; that `platform_identity`/`identity_link`/`audit_event` rows were inserted; that a Controlled Pair A now exists; that M20.17C is authorized; that the repository or audit adapter is wired to runtime; that the Backend Control Plane or an API can create identity links; that production is ready; that server authorization is authoritative; that the frontend should consume server authorization; that self-service identity linking is approved; that email is an identity authority; that a client-supplied UID is an authority; that mutation/audit atomicity is implemented globally; or that rollback was tested live.

It affirms: **M20.18 is synthetic fixture planning only**; no DB connection occurred; no SQL was run; no rows were inserted; no runtime behavior changed; future fixture provisioning requires separate explicit owner approval; M20.17C remains blocked until a valid Controlled Pair A exists and authorization gates pass; production remains blocked; identity-link runtime wiring remains absent; the Backend Control Plane remains read-only/mock-only; email is not identity authority; client-supplied UID is not identity authority; `internal_user_id` remains the app-owned stable anchor.

## 35. Final Recommendation

**Recommend ACCEPT this plan.** It defines the required synthetic fixture and conservatively evaluates the options: **prefer Option B (create a clearly-synthetic DEV-only fixture) only with explicit owner approval, schema support, respected uniqueness, documented rollback, and redacted evidence; otherwise Option C (block and plan a dedicated DEV test-data framework first).** Option A is not preferred (cannot confirm synthetic without exposure). No DB connection, write, or secret exposure occurred. M20.17C remains blocked until a valid Controlled Pair A exists.

## 36. Recommended Next Milestone

- `Phase 1.6 M20.18 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- After backup: `Phase 1.6 M20.19 — Synthetic DEV Identity Fixture Provisioning Authorization Gate` (the separate owner-approval gate that selects an option and authorizes any future fixture provisioning). Any actual fixture write remains a separate, later, owner-approved milestone.

No commit, push, or backup is performed by this milestone. Stop for owner review.
