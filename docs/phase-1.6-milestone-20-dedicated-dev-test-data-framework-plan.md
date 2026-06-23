# Phase 1.6 M20.19-OptionC — Dedicated DEV Test-Data Framework Plan

## 1. Title

Phase 1.6 Milestone 20.19-OptionC — Dedicated DEV Test-Data Framework Plan (documentation-only).

## 2. Purpose

This document is a documentation-only plan for a future dedicated DEV test-data framework that could later support safe, clearly-marked synthetic platform_identity fixtures — including a future Controlled Pair A — without ever touching real customer data, exposing secrets, or making the server authorization authoritative. Its single purpose is to define objectives, boundaries, controls, lifecycle, options, and approval paths. It does not create the framework, create any fixture, connect to any database, run any statement, mutate any table, insert any row, create any route, modify any runtime wiring, or modify any UI. It produces only this planning document and the accompanying final report.

## 3. Current Accepted Checkpoint

Accepted checkpoint immediately preceding this milestone: 36a4a1c505e45bb456d5056b3fa0293a9eedbb68. Most recent accepted outcome: Phase 1.6 M20.19 — ACCEPTED / COMPLETE / BACKED UP, with decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. No checkpoint advancement occurs within this milestone; any commit/backup is deferred to a separate Scoped Commit and Backup Authorization step.

## 4. Scope

In scope for M20.19-OptionC:

- Create exactly one new documentation-only file: this dedicated DEV test-data framework plan.
- Define the objectives, boundary, DEV-only enforcement, production-blocked requirements, synthetic data and synthetic identity fixture classification, future Controlled Pair A support requirements, platform_identity fixture support requirements, internal anchor and provider reference requirements, the email-not-authority and client-UID-not-authority rules, a test-data registry concept, lifecycle states, ownership/approvals, operator/reviewer separation, secret-handling/redaction policy, allowed and blocked future scope, required future preconditions, safe and forbidden evidence, stop conditions, rollback/cleanup/disable requirements, audit requirements, atomicity requirements, future implementation options, a recommended implementation sequence, the future fixture provisioning path, the future M20.17C re-attempt path, risks/mitigations, forbidden conclusions, a final recommendation, and the recommended next milestone.

## 5. Non-Goals

Not goals of M20.19-OptionC:

- Implementing the framework or any part of it.
- Creating a synthetic anchor, synthetic provider reference, or any fixture.
- Connecting to any database; running any statement, schema change, or migration.
- Inserting any platform_identity, identity_link, or audit_event row.
- Calling the repository adapter against a real database or the audit adapter against a real durable writer.
- Creating or modifying routes, API endpoints, startup/server wiring, frontend UI, or Backend Control Plane UI.
- Exposing any test-data tool, fixture, or identity-link capability through UI or API.
- Wiring any server-side authorization, identity-link, harness, feed, token-bridge, or comparison capability into runtime.
- Making server authorization authoritative or having the frontend consume server authorization.
- Committing, pushing, or backing up (handled by a separate authorization step).

## 6. Source-of-Truth Artifacts

This plan relies only on previously accepted artifacts and findings:

- M20.19 synthetic DEV identity fixture provisioning authorization gate (NOT AUTHORIZED).
- M20.18 synthetic DEV identity fixture provisioning plan.
- M20.17B-Repair re-attempt authorization correction record.
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

All references are conceptual; no raw contents, values, or identifiers from those artifacts are reproduced. No expansion beyond accepted architecture is introduced.

## 7. M20.19 NOT AUTHORIZED Summary

The M20.19 authorization gate recorded decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. All required owner-approval and safety signals were absent on safe presence-only checks. As a result, Option B synthetic fixture execution (M20.20) is not authorized, and M20.17C remains blocked. The accepted context captured there: Firebase candidate count 1; Supabase candidate count 2; shared-anchor candidate pair count 0; eligible Controlled Pair A exists: no. The conservative forward path recorded was the Option C dedicated DEV test-data framework planning path, which this document provides at the planning level only.

## 8. Option C Rationale

Option C exists because a direct synthetic fixture write cannot be safely authorized without a reliable, repeatable mechanism to (a) confirm a DEV target without handling protected connection material, (b) generate clearly-marked synthetic identifiers that respect uniqueness, (c) track fixtures through a known lifecycle with a registry, and (d) cleanly roll back or disable fixtures. A dedicated DEV test-data framework, planned first and implemented later under separate approval, would provide those controls before any fixture write is requested, reducing the risk of touching real data, ambiguous targets, uniqueness collisions, or irreversible changes.

## 9. Problem Statement

There is presently no eligible Controlled Pair A (no Firebase-and-Supabase pair sharing one internal anchor), and no confirmed safe mechanism to distinguish DEV from production or to provision clearly-synthetic fixtures with rollback. Existing provider references are prior pilot identities, not a designated synthetic fixture, and cannot be confirmed synthetic without reading raw values, which is forbidden. A controlled DB exercise of identity linking therefore cannot proceed. A dedicated DEV test-data framework is the conservative prerequisite that would make safe synthetic fixtures — and a future Controlled Pair A — possible.

## 10. Dedicated DEV Test-Data Framework Objectives

The future framework must aim to: support DEV-only synthetic test data; require explicit owner approval before any write; operate only when production is blocked; classify test data and synthetic identity fixtures distinctly; track fixtures through defined lifecycle states; maintain a registry of synthetic fixtures; never use real customer data; never treat email or client-supplied UID as identity authority; support provider-aware identity records mapped to a shared internal anchor; produce aggregate-only, redacted evidence; provide safe cleanup/disable and rollback; enforce an audit policy; define stop conditions; enforce separation of duties; and provide future support for a Controlled Pair A, a future fixture provisioning authorization path, and a future identity_link DEV exercise authorization path.

## 11. Framework Boundary

The framework boundary is strictly DEV-only, server-side, default-OFF, owner-gated, and isolated from runtime. It must never be exposed through any route, API endpoint, frontend UI, or Backend Control Plane UI. It must never make server authorization authoritative, never wire prior authorization/identity-link/harness/feed/token-bridge/comparison capabilities into runtime, and never act against production. Its only legitimate effect, if and when implemented and separately approved, would be to create clearly-marked synthetic DEV-only platform_identity fixtures.

## 12. DEV-Only Enforcement Requirements

The framework must enforce DEV-only operation via a safe environment signal that confirms a DEV target without handling or printing protected connection material. It must refuse to operate if the target cannot be confirmed DEV by a safe signal. It must default to OFF and require an explicit enabling signal plus explicit owner approval. It must treat any ambiguity about target environment as a hard stop.

## 13. Production-Blocked Requirements

The framework must keep production blocked at all times. It must never run against a production target, never accept production connection material, and never produce production side effects. Production-blocked status must be a precondition checked by a safe signal before any operation, independent of any other approval.

## 14. Synthetic Data Classification

All data the framework produces must be classified as synthetic and clearly marked as such. Synthetic data must be distinguishable from real data by a designated marking convention (conceptual; not real values). Synthetic data must never originate from, mirror, or embed real customer, tenant, store, user, domain, IP, or request data.

## 15. Synthetic Identity Fixture Classification

A synthetic identity fixture is a specifically classified subset of synthetic data: a clearly-marked synthetic DEV-only internal anchor together with clearly-marked synthetic provider-side references. Synthetic identity fixtures must be registered, lifecycle-tracked, owner-approved, and cleanly removable. They must never be confused with prior pilot identities or any real identity.

## 16. Controlled Pair A Future Support Requirements

To support a future Controlled Pair A, the framework must be able to produce one clearly-marked synthetic internal anchor mapped to exactly one clearly-marked synthetic Firebase-side reference and exactly one clearly-marked synthetic Supabase-side reference, such that a later read-only aggregate check could show a shared-anchor pair count delta of one. This support is a capability requirement only; it does not authorize creating such a pair, which remains gated behind separate approvals.

## 17. platform_identity Fixture Support Requirements

Fixture support must respect the existing platform_identity schema and its uniqueness constraints. Fixtures must use the application-owned internal anchor as the stable key, must set provider provider-reference fields in a way that does not collide with existing active uniqueness constraints, and must keep email nullable and non-authoritative. No schema change is proposed here; any schema dependency must be confirmed before implementation.

## 18. Internal Anchor Requirements

The internal anchor must remain the application-owned, stable identity key. Synthetic anchors must be clearly marked synthetic, generated by a safe deterministic or controlled mechanism that respects uniqueness, and never derived from email or client-supplied UID. The anchor, not any provider value, is the join point for provider references.

## 19. Provider Reference Requirements

Provider references must be provider-aware (Firebase-side and Supabase-side as distinct provider categories), clearly marked synthetic, and mapped to a shared synthetic internal anchor. They must respect active-only uniqueness, must never reuse real provider identifiers, and must never be treated as the identity authority themselves.

## 20. Email-Not-Authority Rule

Email must never be the identity authority. Synthetic fixtures must keep email optional and non-authoritative. The framework must never resolve, link, or key identity on email. This rule is absolute and applies to all synthetic and future real flows.

## 21. Client-UID-Not-Authority Rule

A client-supplied UID must never be the identity authority. The application-owned internal anchor remains authoritative. Synthetic provider references model provider-supplied values but must never be allowed to override or become the anchor. This rule is absolute.

## 22. Test Data Registry Concept

The framework must include a registry concept that records, conceptually, each synthetic fixture: a synthetic identifier reference (not a raw value), its classification, its lifecycle state, its owner/approver, its creation and disable/cleanup status, and a safe reason code. The registry must store only safe, redacted references and aggregate metadata — never raw provider/internal identifiers, emails, secrets, or payloads.

## 23. Test Data Lifecycle States

Fixtures must move through defined lifecycle states: planned, approved, provisioned, active, disabled, cleaned, and blocked. Each transition must require the appropriate approval and must be recorded with a safe reason code. A fixture may only be provisioned after approval; may be disabled or cleaned without deletion ambiguity; and may be marked blocked if any stop condition triggers.

## 24. Test Data Ownership and Approvals

Every fixture must have a named owner and an explicit approver. No write may occur without explicit owner approval recorded as a safe signal. Approvals must be specific to the fixture and to the operation (provision, disable, clean). Standing or implicit approval is not sufficient.

## 25. Operator / Reviewer Separation-of-Duties

The operator who performs a fixture operation must be separate from the reviewer who approves it. The framework must require and record this separation as a safe signal before any write. A single party performing both roles is a hard stop.

## 26. Secret-Handling and Redaction Policy

The framework must never print, persist, or embed secrets, DB URLs, service-role keys, anon keys, tokens, Authorization headers, request/response bodies, or any raw identifiers. All checks must be presence-only (booleans/counts). All reporting must be redaction-first: aggregate counts, booleans, and safe reason codes only. Any need to read or print a raw value to proceed is a hard stop.

## 27. Allowed Future Framework Scope

If and only if separately approved through a future implementation authorization gate, allowed future framework scope is limited to: a DEV-only, server-side, default-OFF, owner-gated test-data capability; a synthetic fixture registry; provisioning of clearly-marked synthetic DEV-only platform_identity anchors and provider references; lifecycle management; safe disable/cleanup and rollback; and aggregate-only, redacted evidence. Nothing in this plan itself authorizes implementation.

## 28. Blocked Future Framework Scope

The following remain blocked and are not authorized by this plan: identity_link creation; audit_event creation for identity_link; conflict, missing-platform_identity, or constraint-conflict forced scenarios; revoke lifecycle exercises; audit-writer failure simulation; bulk linking; UI exposure; API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise; making server authorization authoritative; frontend consumption of server authorization; self-service identity linking; and treating email or client-supplied UID as identity authority.

## 29. Required Future Framework Preconditions

Before any future framework implementation may be requested, all of the following must be present and accepted: explicit owner approval for the chosen implementation option; a safe DEV-target confirmation mechanism; production-blocked confirmation; schema support confirmation; a uniqueness strategy; a rollback/cleanup/disable strategy; redacted evidence acceptance; an audit policy; no-identity_link-rows-during-provisioning acceptance; no-runtime/UI/API-exposure acceptance; stop-condition acceptance; and operator/reviewer separation acceptance. If any precondition is absent, the future request remains NOT AUTHORIZED.

## 30. Safe Evidence Requirements

Allowed future evidence is aggregate-only and redacted: DEV-only confirmation; production-blocked confirmation; fixture registry status; lifecycle status category; synthetic fixture count delta; synthetic internal-anchor count delta; synthetic Firebase-side platform_identity count delta; synthetic Supabase-side platform_identity count delta; shared-anchor pair count delta; no-identity_link-row-inserted confirmation; no-audit_event-row-inserted confirmation unless separately approved; raw values printed: no; secrets printed: no; DB URL printed: no; email used as authority: no; client UID used as authority: no; UI/API/runtime wiring: no; safe reason codes only; aggregate counts only.

## 31. Forbidden Evidence

Future evidence must never include: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; tokens; Authorization headers; request bodies; response bodies; DB URL; service-role key; anon key; secrets; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; real customer/tenant/store names; real domains; real IPs; or real request IDs.

## 32. Stop Conditions

The framework must stop immediately on any of: inability to confirm a DEV target via a safe signal; any indication of a production target; a uniqueness conflict; any need to read, print, or parse a raw value to proceed; a missing required approval or separation-of-duties signal; an ambiguous or unclassifiable fixture; any attempt to expose a capability through UI/API/runtime; or any unexpected mutation surface. A stop condition marks the affected fixture blocked and halts the operation.

## 33. Rollback / Cleanup / Disable Requirements

Every fixture-producing operation must have an accepted rollback/cleanup/disable strategy before it runs. Disable must make a fixture inactive without ambiguity; cleanup must remove a synthetic fixture cleanly; rollback must restore the prior aggregate state. Rollback/cleanup/disable evidence must be aggregate-only and redacted. No rollback may be claimed as tested live in this plan.

## 34. Audit Requirements

The framework must define an audit policy: fixture provisioning itself must not create identity_link audit events; any audit_event creation for identity_link remains separately gated. Where the framework records its own operational audit, it must use safe reason codes and aggregate metadata only, with actor handling consistent with accepted policy and no raw payloads or metadata dumps.

## 35. Atomicity Requirements

Fixture-producing operations must be atomic at the operation level: a single provision either fully succeeds (anchor plus its provider references consistently recorded) or leaves no partial fixture. Atomicity must be designed so that a failure does not leave dangling synthetic anchors or orphan provider references. This plan does not claim atomicity is implemented globally; it states the requirement only.

## 36. Future Framework Implementation Options

The plan evaluates three future implementation options. Each is contingent on a separate implementation authorization gate.

Option C1 — Documentation-only registry and manual owner-approved DEV fixture process.
- Description: A registry document plus a manual, owner-approved, redaction-first process for any future synthetic fixture, with no code capability built.
- Benefits: Lowest risk; no new runtime/code surface; immediate governance value; reinforces separation of duties and redaction.
- Risks: Manual steps depend on operator discipline; slower; no automated uniqueness/rollback enforcement.
- Approval requirements: Owner approval to adopt the registry/process; operator/reviewer separation.
- Evidence requirements: Registry status and aggregate counts only; no raw values.
- Rollback / cleanup requirements: Manual disable/cleanup with aggregate-only evidence.
- Stop conditions: Any raw-value need; any target ambiguity; any missing approval.
- Recommendation: Adopt first as the baseline governance control.

Option C2 — Server-only DEV test-data service / harness, default OFF, owner-gated, no UI/API exposure.
- Description: A server-only, default-OFF, dependency-injected DEV test-data capability that can provision clearly-marked synthetic fixtures under explicit owner approval, with safe DEV-target confirmation, uniqueness handling, lifecycle, and rollback — never exposed through UI/API/runtime.
- Benefits: Repeatable, automatable uniqueness and rollback; consistent redaction; aligns with the existing server-only, default-OFF, DI precedent.
- Risks: New code surface; requires careful isolation to avoid runtime wiring; requires schema confirmation.
- Approval requirements: A separate implementation authorization gate; all preconditions in Section 29.
- Evidence requirements: Aggregate-only, redacted; DEV/production-blocked confirmations; count deltas; no-identity_link/no-audit_event confirmations.
- Rollback / cleanup requirements: Built-in disable/cleanup and rollback with aggregate-only evidence.
- Stop conditions: As in Section 32.
- Recommendation: Pursue only after C1 and only after a separate implementation authorization gate.

Option C3 — Dedicated migration/seed-like DEV-only fixture path.
- Description: A migration/seed-like path dedicated to DEV-only fixtures.
- Benefits: Familiar mechanism; potentially reproducible.
- Risks: High; migration/seed mechanisms are closer to schema and to production-shaped tooling; higher chance of ambiguous targets, accidental persistence, or coupling; harder to keep strictly DEV-only and reversible.
- Approval requirements: Stronger safeguards than C1/C2; explicit confirmation that schema and rollback controls are fully approved; all preconditions in Section 29 plus migration-specific safeguards.
- Evidence requirements: Aggregate-only, redacted.
- Rollback / cleanup requirements: Fully approved schema and rollback controls before any use.
- Stop conditions: As in Section 32, plus any migration/seed coupling risk.
- Recommendation: Do not recommend unless stronger safeguards exist; not preferred.

## 37. Recommended Implementation Sequence

Recommended conservative sequence: first adopt Option C1 (documentation-only registry and manual owner-approved process) as the baseline governance control; then, only after a separate implementation authorization gate and all Section 29 preconditions, consider Option C2 (server-only, default-OFF, owner-gated DEV test-data capability); do not pursue Option C3 unless stronger safeguards exist. No implementation is authorized by this plan.

## 38. Future Fixture Provisioning Path

Once a framework control is in place (C1, and later C2 if approved) and all Section 29 preconditions are present and accepted, a future fixture provisioning execution may be requested through a fresh authorization gate (the role M20.19 played, re-run with signals present), leading — only on a future Decision A — to a fixture provisioning execution milestone limited to one synthetic anchor and two synthetic provider references mapped to it, with aggregate-only redacted evidence and rollback/cleanup. Nothing here authorizes that execution.

## 39. Future M20.17C Re-Attempt Path

Only after a synthetic fixture is provisioned and a future read-only aggregate check shows an eligible Controlled Pair A exists, and only after the M20.17B re-attempt authorization gates pass, may a future M20.17C controlled DB exercise be requested. M20.17C remains blocked until those conditions are met. This plan does not authorize M20.17C.

## 40. Risks and Mitigations

- Risk: touching real or pilot identities. Mitigation: strict synthetic classification and marking; Option A alignment not used; registry tracking.
- Risk: DEV-vs-production target ambiguity. Mitigation: safe DEV-target confirmation signal required; production blocked by policy; hard stop on ambiguity.
- Risk: uniqueness collision. Mitigation: accepted uniqueness strategy required before any write.
- Risk: raw value exposure. Mitigation: redaction-first, aggregate-only evidence; forbidden-evidence list; presence-only checks.
- Risk: scope creep into linking/audit/runtime/UI/API. Mitigation: explicit blocked-scope list; separate gates; no exposure.
- Risk: irreversible changes. Mitigation: required rollback/cleanup/disable strategy and evidence.
- Risk: separation-of-duties lapse. Mitigation: required operator/reviewer separation signal.
- Risk: over-automation before controls exist. Mitigation: sequence C1 before C2; C3 not preferred; implementation gated separately.

## 41. Forbidden Conclusions

This document does not claim, and future work must not claim without separate authorization, that: the framework was implemented; a fixture was created; platform_identity rows were inserted; identity_link rows were inserted; audit_event rows were inserted; Controlled Pair A now exists; M20.20 is authorized; M20.17C is authorized; the repository adapter is wired to runtime; the audit adapter is wired to runtime; the Backend Control Plane can create identity links; an API can create identity links; production is ready; server authorization is authoritative; the frontend should consume server authorization; self-service identity linking is approved; email is identity authority; client UID is identity authority; mutation/audit atomicity is implemented globally; or rollback was tested live.

This document clearly states: M20.19-OptionC is planning-only; no DB connection occurred; no statement was run; no rows were inserted; no runtime behavior changed; future framework implementation requires separate approval; future fixture provisioning requires separate approval; M20.17C remains blocked until a valid Controlled Pair A exists and re-attempt gates pass; production remains blocked; identity-link runtime wiring remains absent; and the Backend Control Plane remains read-only/mock-only.

## 42. Final Recommendation

Adopt this plan as the Option C baseline. Recommend Option C1 first (documentation-only registry and manual owner-approved DEV fixture process), then Option C2 only after a separate implementation authorization gate and all Section 29 preconditions; do not pursue Option C3 unless stronger safeguards exist. M20.19-OptionC is planning-only: no DB connection occurred, no statement was run, no rows were inserted, and no runtime behavior changed. M20.20 and M20.17C remain blocked. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.

## 43. Recommended Next Milestone

Recommended next milestone: Phase 1.6 M20.19-OptionC — Scoped Commit and Backup Authorization (to commit and back up this planning document). After that backup, a possible next milestone is a dedicated framework implementation authorization gate for Option C1 (and later, separately, Option C2). Any framework implementation or fixture provisioning execution remains a separate, later, owner-approved milestone.
