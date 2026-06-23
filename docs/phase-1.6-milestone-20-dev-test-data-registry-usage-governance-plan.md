# Phase 1.6 M20.23-OptionC1 — DEV Test-Data Registry Usage Governance Plan

## 1. Title

Phase 1.6 Milestone 20.23-OptionC1 — DEV Test-Data Registry Usage Governance Plan (documentation-only).

## 2. Purpose

This document is a documentation-only usage governance plan for the existing DEV test-data registry template package (the nine blank templates and checklists created in M20.22-OptionC1). Its single purpose is to define how future operators may use those templates and checklists safely — under owner approval, reviewer review, and separation-of-duties — before any real registry entry, fixture, database write, or M20.17C re-attempt is ever allowed. It does not create any registry entry, complete any template with real or example values, create any fixture, connect to any database, run any statement, mutate any table, insert any row, create any route, modify any runtime wiring, or modify any UI. It produces only this usage governance plan and the accompanying final report.

## 3. Current Accepted Checkpoint

Accepted checkpoint immediately preceding this milestone: f37a3a05677968c21b756d55be0595580b7766e0. Most recent accepted commit subject: "Phase 1.6 M20.22-OptionC1 add DEV registry templates." No checkpoint advancement occurs within this milestone; any commit/backup is deferred to a separate Scoped Commit and Backup Authorization step.

## 4. Scope

In scope for M20.23-OptionC1:

- Create exactly one new documentation-only file: this usage governance plan.
- Define usage objectives, the template usage boundary, prohibited usage, roles and responsibilities, owner/reviewer/operator governance, separation-of-duties, per-template and per-checklist usage rules, allowed and forbidden placeholder usage, evidence/redaction/lifecycle/cleanup/stop-condition governance rules, change-control requirements, the review-and-acceptance workflow, the correction/backout workflow, the future registry-entry and fixture-provisioning authorization paths, the C2 path, the future M20.17C re-attempt path, blocked scope, risks/mitigations, the authorization-gate decision, forbidden conclusions, a final recommendation, and the recommended next milestone.

## 5. Non-Goals

Not goals of M20.23-OptionC1:

- Creating any registry entry; completing any template with real or example values.
- Creating any examples directory, sample data, or fixture record.
- Creating a synthetic anchor, synthetic provider reference, or any fixture.
- Connecting to any database; running any statement, schema change, or migration.
- Inserting any platform_identity, identity_link, or audit_event row.
- Calling the repository adapter against a real database or the audit adapter against a real durable writer.
- Creating or modifying routes, API endpoints, startup/server wiring, frontend UI, or Backend Control Plane UI.
- Modifying the nine existing template/checklist files.
- Wiring any server-side capability into runtime, or making server authorization authoritative.
- Committing, pushing, or backing up (handled by a separate authorization step).

## 6. Source-of-Truth Artifacts

This plan relies only on previously accepted artifacts and findings:

- The nine M20.22-OptionC1 template/checklist files (README; registry template; registry entry template; owner approval, reviewer, lifecycle state, redacted evidence, cleanup/disable, and stop-condition checklists).
- M20.21-OptionC1 template implementation plan.
- M20.20-OptionC1 registry control plan.
- M20.19-OptionC dedicated DEV test-data framework plan.
- M20.19 synthetic DEV identity fixture provisioning authorization gate (NOT AUTHORIZED).
- M20.18 synthetic DEV identity fixture provisioning plan.
- M20.17B-Repair / M20.17B / M20.17A / M20.17 / M20.16 / M20.15 identity-link DEV exercise records and gates.
- M20.8 creation-flow plan; M20.9 audit-event plan; admin provisioning implementation plan; M20.12 repository/audit adapter plan.
- Server-only identity-link admin provisioning, DEV repository, audit adapter modules and their tests.
- Migration set for identity_link (up/down) and the platform_identity migration set.
- DEV identity-link apply evidence record.
- M21 Backend Control Plane charter plan and M22A read-only shell UI foundation plan.

All references are conceptual; no raw contents, values, or identifiers from those artifacts are reproduced. No expansion beyond accepted architecture is introduced.

## 7. Prior Accepted Context

Accepted context carried into this plan: M20.17B-Discovery established Firebase candidate count 1, Supabase candidate count 2, shared-anchor pair count 0, and eligible Controlled Pair A: no. M20.19 recorded decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. M20.19-OptionC recommended C1 first, then C2 only after a separate gate, with C3 not preferred. M20.20-OptionC1 and M20.21-OptionC1 recorded Decision A at their respective gates. M20.22-OptionC1 created blank documentation templates/checklists only. M20.20 fixture-provisioning execution remains blocked. M20.17C controlled DB exercise remains blocked.

## 8. Existing Template Package Summary

The existing template package is documentation-only and redaction-first. It comprises: a README describing purpose, boundary, prohibited use, and the gated future path; a registry template (index structure with lifecycle vocabulary and safe aggregate-only summary fields); a registry entry template (15 safe conceptual fields plus explicit forbidden fields); and six checklists (owner approval, reviewer, lifecycle state, redacted evidence, cleanup/disable, stop-condition). None of these hold real data; all use placeholders and conceptual labels. This plan governs how they may be used; it does not alter them.

## 9. Usage Governance Problem Statement

The template package exists, but there is no governance defining who may use the templates, under what approvals, with what placeholders, and with what review and correction workflow — before any real registry-entry documentation, fixture, or DB write is allowed. Without usage governance, a future operator could complete a template ambiguously, risk entering a raw value, or move toward provisioning without separation-of-duties. The problem this plan addresses is purely governance: defining safe usage rules so that any future documentation-only use is owner-approved, reviewed, redaction-safe, and reversible.

## 10. Usage Governance Objectives

The usage governance must aim to: ensure templates are used only to produce documentation artifacts after separate approval; ensure any future completed registry-entry document holds only conceptual labels, status categories, yes/no evidence, and aggregate-only counts; require owner approval before a completed registry-entry document is drafted; require reviewer approval before any such document is used as fixture evidence; enforce operator/reviewer separation; require DEV-only and production-blocked confirmation, synthetic classification, lifecycle-state assignment, a cleanup/disable plan, a stop-condition review, and a redacted-evidence review; and ensure no fixture provisioning, DB/runtime/UI/API scope, or M20.17C re-attempt occurs without separate approval and (for M20.17C) a valid Controlled Pair A and passing re-attempt gates.

## 11. Template Usage Boundary

Template usage is documentation-only, redaction-first, and isolated from runtime and data. Using the templates must never connect to a database, run any statement, create any fixture, wire any runtime, or expose any UI/API. A completed template is a governance document holding only safe conceptual labels; it is never data and never a fixture. All usage produces only documentation artifacts under separate approval.

## 12. Prohibited Template Usage

Templates must never be used to: record any raw identifier, secret, DB URL, email, token, key, Authorization header, request/response body, raw row, real customer/tenant/store name, real domain, real IP, actor UUID, request ID, or raw payload; create any real registry entry that implies a real identity; create sample data or example entries with realistic-looking values that could be mistaken for real data; perform or trigger any database write; or be wired into runtime, routes, API, or UI. Any usage that would require a prohibited value must stop and mark the affected draft blocked.

## 13. Roles and Responsibilities

Three roles govern usage: the Owner (approves whether a prospective fixture may be described and later, separately, provisioned); the Reviewer (independently verifies redaction, completeness, lifecycle validity, and stop conditions); and the Operator (drafts documentation artifacts using the templates). The Operator and Reviewer must be distinct parties. No role may bypass the others. Owner approval is a prerequisite for drafting a completed registry-entry document; reviewer approval is a prerequisite for using any such document as fixture evidence.

## 14. Owner Approval Governance

Owner approval must be explicit, specific to the prospective fixture and operation, and recorded as a safe signal via the owner approval checklist. The owner must affirm DEV-only status, production-blocked status, synthetic classification, no real customer impact, that email is never identity authority, that client-supplied UID is never identity authority, and that no DB/runtime/UI/API scope is included unless separately authorized. Standing or implicit owner approval is insufficient.

## 15. Reviewer Governance

The reviewer must be independent of the operator and must complete the reviewer checklist: confirming separation-of-duties, redaction (no raw values), absence of forbidden fields/evidence, lifecycle-state validity, cleanup/disable definition, audit policy, stop-condition review, and that nothing requires reading or printing a raw value. The reviewer must withhold approval if any item fails, marking the draft blocked with a safe reason code.

## 16. Operator Governance

The operator drafts documentation artifacts using only the allowed placeholders and conceptual fields, never entering a prohibited value. The operator must assign a lifecycle state, capture only aggregate-only/yes-no evidence, define a cleanup/disable plan, and run the stop-condition checklist. The operator must stop immediately on any stop condition and must never advance a draft toward provisioning without separate owner approval and reviewer sign-off.

## 17. Separation-of-Duties Requirements

The operator who drafts a documentation artifact must be distinct from the reviewer who approves it, and both are subordinate to explicit owner approval for the prospective fixture. A single party performing operator and reviewer roles is a hard stop and marks the draft blocked. Separation-of-duties must be recorded as a safe signal before any draft is accepted as fixture evidence.

## 18. Registry Template Usage Rules

The registry template may be used only to maintain a documentation-only index of prospective entries using its safe aggregate-only summary fields and the lifecycle vocabulary. It must never be populated with raw values or real entries. Any summary count is aggregate-only and must never be accompanied by a raw value. Updates to the index require owner-approved entries and reviewer confirmation.

## 19. Registry Entry Template Usage Rules

The registry entry template may be used only to draft a single prospective entry using its 15 safe conceptual fields. The operator must leave every forbidden field empty and must mark the draft blocked if any forbidden value would be required. The draft must include approval, evidence, lifecycle, cleanup, and stop-condition notes, all as conceptual labels, categories, booleans, or aggregate counts. A completed entry remains a governance document and creates no fixture or row.

## 20. Owner Approval Checklist Usage Rules

The owner approval checklist must be completed by the owner (or recorded on the owner's explicit instruction) before a completed registry-entry document is drafted. Every item is yes/no or a safe category. A missing or negative required approval blocks the draft. The checklist authorizes only documentation drafting; it never authorizes a fixture write or DB action.

## 21. Reviewer Checklist Usage Rules

The reviewer checklist must be completed by an independent reviewer before any completed registry-entry document is used as fixture evidence. Every item is yes/no or a safe reason code. Any failed item blocks the draft. The reviewer must not be the operator. The checklist authorizes only documentation acceptance; it never authorizes a fixture write or DB action.

## 22. Lifecycle State Checklist Usage Rules

The lifecycle state checklist must be used to assign and validate the entry's state from the accepted vocabulary (planned, approved, provisioned, active, disabled, cleaned, blocked) and to confirm that the transition into the current state had the required approval and a safe reason code. In documentation-only use, an entry may be drafted as planned or approved; provisioned and active describe only future states under separate execution authorization.

## 23. Redacted Evidence Checklist Usage Rules

The redacted evidence checklist must be used to confirm that any evidence captured is aggregate-only and redacted (yes/no items plus the fixed "no" safety items and optional aggregate count deltas). The operator must confirm raw values printed: no; secrets printed: no; DB URL printed: no; DB connection: no; SQL executed: no; rows inserted: no; runtime/UI/API changed: no. Any deviation blocks the draft.

## 24. Cleanup / Disable Checklist Usage Rules

The cleanup/disable checklist must be used to define cleanup, disable, and rollback approaches conceptually before any prospective entry advances. If a cleanup, disable, or rollback approach cannot be safely described in aggregate-only, redaction-first terms, the operator must stop and mark the entry blocked. The checklist defines plans only; it performs no cleanup and no database action.

## 25. Stop-Condition Checklist Usage Rules

The stop-condition checklist must be run before accepting any draft. If any stop condition is triggered (raw value exposure risk, unclear DEV target, production risk, missing owner/reviewer approval, missing redaction confirmation, unclear lifecycle state, unclear cleanup/disable plan, schema uncertainty, uniqueness uncertainty, runtime/UI/API exposure risk, DB-write scope creep, identity_link creation attempt, audit_event creation attempt unless separately authorized, real customer impact risk), the operator must halt and mark the entry blocked with a safe reason code.

## 26. Allowed Placeholder Usage

Allowed placeholders are the conceptual placeholders defined in the templates, such as: registry-reference-label; fixture-purpose-category; fixture-type-category; lifecycle-state; owner-approval-status; reviewer-approval-status; dev-only-status; production-blocked-status; synthetic-classification; provider-coverage-category; internal-anchor-coverage-category; redacted-evidence-status; cleanup-disable-status; audit-policy-status; stop-condition-status; and safe reason codes. Placeholders may be replaced only with safe categories, booleans, counts, or safe labels.

## 27. Forbidden Placeholder Usage

No placeholder may be replaced with a raw value. Specifically forbidden are any values for raw Firebase UID, raw Supabase UID, raw provider UID, raw internal_user_id, raw platform_identity/identity_link/audit_event rows, emails, DB URL, service-role key, anon key, tokens, secrets, Authorization headers, request bodies, response bodies, real customer/tenant/store names, real domains, real IPs, actor UUIDs, request IDs, or raw payloads. Templates must never be extended with placeholders that invite such values.

## 28. Evidence Governance Rules

All evidence from template usage must be aggregate-only and redacted: yes/no confirmations, safe categories, safe reason codes, and aggregate count deltas only. The allowed evidence set includes: usage governance plan created yes/no; template package exists yes/no; registry entry controlled-draft approved yes/no; owner approval present yes/no; reviewer approval present yes/no; DEV-only confirmed yes/no; production-blocked confirmed yes/no; synthetic classification confirmed yes/no; lifecycle state assigned yes/no; cleanup/disable plan present yes/no; stop-condition review passed yes/no; and the fixed "no" safety items (raw values printed: no; secrets printed: no; DB URL printed: no; DB connection occurred: no; SQL executed: no; rows inserted: no; runtime/UI/API changed: no).

## 29. Redaction Governance Rules

Redaction is mandatory and verified at draft and review. No raw identifier, secret, DB URL, email, token, key, header, body, row, or payload may appear in any artifact. All checks are presence-only (booleans/counts). Any need to read or print a raw value to proceed is a hard stop. The reviewer must independently confirm redaction before acceptance.

## 30. Lifecycle Governance Rules

Each prospective entry occupies exactly one lifecycle state and transitions only with the required approval and a safe reason code. In documentation-only governance, entries may be planned or approved; provisioned, active, disabled, and cleaned describe future states reachable only under separate execution authorization; blocked applies whenever a stop condition triggers. Lifecycle transitions are recorded as governance metadata, never as data changes.

## 31. Cleanup / Disable Governance Rules

Before any prospective entry may advance toward future provisioning, a cleanup/disable/rollback approach must be defined and reviewer-confirmed. Disable makes a future fixture inactive without ambiguity; cleanup removes a future synthetic fixture cleanly; rollback restores the prior aggregate state. All such evidence is aggregate-only and redacted. No rollback may be claimed as tested live. Inability to safely describe cleanup blocks the entry.

## 32. Stop-Condition Governance Rules

Stop conditions are enforced at every step. Any triggered stop condition halts the work and marks the affected entry blocked with a safe reason code. Resolution requires removing the condition and re-obtaining owner and reviewer approval. Stop conditions explicitly include any movement toward a DB write, identity_link creation, unauthorized audit_event creation, runtime/UI/API exposure, or real customer impact.

## 33. Change-Control Requirements

Any change to the template package or to this governance plan must be a scoped, documentation-only change, preflighted to confirm only the intended files change, scanned for redaction, reviewed with operator/reviewer separation, and reported. The nine template/checklist files must not be modified except through an explicitly approved, scoped change-control milestone. No change may add a forbidden field, a runtime/DB/UI/API surface, or a real value.

## 34. Review and Acceptance Workflow

The review and acceptance workflow for any future documentation artifact is: the operator drafts using allowed placeholders; the operator runs the redacted-evidence and stop-condition checklists; the owner completes the owner approval checklist; an independent reviewer completes the reviewer checklist (confirming separation-of-duties and redaction); and only when all checklists pass is the artifact accepted as a documentation-only governance record. Acceptance authorizes nothing beyond documentation; provisioning remains separately gated.

## 35. Correction / Backout Workflow

If an accepted artifact is later found defective (for example, an inadvertent forbidden value or ambiguous instruction), the correction workflow is: record the issue with a safe reason code; mark the affected entry blocked; correct or remove the artifact via a scoped, documentation-only change; re-run the redaction scan and review; and, if necessary, back out the artifact entirely via a scoped revert of the documentation-only change. Correction/backout must never touch data, runtime, or secrets.

## 36. Future Registry Entry Authorization Path

A future documentation-only registry-entry controlled-draft milestone may be requested to produce one or more completed registry-entry documents using the templates under this governance, with owner approval, reviewer sign-off, and separation-of-duties. Such a milestone remains strictly documentation-only: it creates no fixture, no row, and no runtime change. It is the next step authorized in principle by this plan, subject to a separate request and approval.

## 37. Future Fixture Provisioning Authorization Path

Only after one or more approved registry-entry controlled-draft documents exist, and only after a fresh fixture-provisioning authorization gate (the role M20.19 played, re-run with all required approval and safety signals present) records a future Decision A, may a separate fixture provisioning execution milestone be requested — limited to one synthetic anchor and two synthetic provider references mapped to it, with aggregate-only redacted evidence and rollback/cleanup. Nothing here authorizes that execution.

## 38. Future C2 Server-Only Harness Path

Option C2 (a server-only, default-OFF, owner-gated DEV test-data capability with no UI/API exposure) remains a later, separate path, requestable only after the C1 governance and registry-draft practice are established and only through a separate implementation authorization gate confirming all preconditions. This plan does not authorize C2.

## 39. Future M20.17C Re-Attempt Path

Only after a synthetic fixture is provisioned and a future read-only aggregate check shows an eligible Controlled Pair A exists, and only after the M20.17B re-attempt authorization gates pass, may a future M20.17C controlled DB exercise be requested. M20.17C remains blocked until those conditions are met. This plan does not authorize M20.17C.

## 40. Blocked Scope

The following remain blocked and are not authorized by this plan: real registry entry creation; template completion with real or example values; registry implementation; any C2 server-only harness implementation; any fixture creation; identity_link creation; audit_event creation for identity_link; conflict/missing-platform_identity/constraint-conflict forced scenarios; revoke lifecycle; audit-writer failure simulation; bulk linking; UI exposure; API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise; making server authorization authoritative; frontend consumption of server authorization; self-service identity linking; and treating email or client-supplied UID as identity authority.

## 41. Risks and Mitigations

- Risk: an operator entering a raw value. Mitigation: forbidden-placeholder rules; redaction governance; reviewer redaction confirmation; stop condition on raw-value exposure.
- Risk: separation-of-duties lapse. Mitigation: distinct operator and reviewer required and recorded; owner approval prerequisite.
- Risk: scope creep toward DB/runtime/UI/API. Mitigation: usage boundary; blocked-scope section; stop conditions for DB-write scope creep and exposure.
- Risk: ambiguous lifecycle or cleanup. Mitigation: lifecycle and cleanup/disable governance; review-and-acceptance workflow.
- Risk: undetected defects in accepted artifacts. Mitigation: correction/backout workflow; change-control requirements.
- Risk: premature provisioning. Mitigation: separate fixture-provisioning authorization gate required; M20.17C remains blocked.
- Risk: confusing prior pilot identities with synthetic drafts. Mitigation: synthetic classification and prohibited-usage rules.

## 42. Authorization Gate Decision

Decision: A — READY TO REQUEST FUTURE DOCUMENTATION-ONLY REGISTRY ENTRY CONTROLLED-DRAFT MILESTONE — NOT EXECUTED IN M20.23-OPTIONC1.

Rationale: This usage governance plan is complete — it defines the usage objectives, boundary, prohibited usage, roles and responsibilities, owner/reviewer/operator governance, separation-of-duties, per-template and per-checklist usage rules, allowed and forbidden placeholder usage, evidence/redaction/lifecycle/cleanup/stop-condition governance rules, change-control requirements, the review-and-acceptance workflow, the correction/backout workflow, the future registry-entry and fixture-provisioning authorization paths, the C2 path, the future M20.17C re-attempt path, and blocked scope. No raw-value exposure risk was found (the governance is redaction-first and presence-only), and the next step (a future documentation-only registry-entry controlled-draft milestone) is itself strictly documentation-only and does not connect to a database, write rows, create real registry entries, wire runtime, or expose UI/API. Therefore a future documentation-only registry-entry controlled-draft milestone may be requested. No registry entry was created here; no template was completed with real values; no fixture was created; no DB connection occurred; no rows were inserted; M20.20 fixture-provisioning execution and M20.17C remain blocked.

## 43. Forbidden Conclusions

This document does not claim, and future work must not claim without separate authorization, that: a registry entry was created; a template was completed with real values; the registry was implemented; the framework was implemented; a fixture was created; platform_identity rows were inserted; identity_link rows were inserted; audit_event rows were inserted; Controlled Pair A now exists; M20.20 execution is authorized; M20.17C is authorized; the repository adapter is wired to runtime; the audit adapter is wired to runtime; the Backend Control Plane can create identity links; an API can create identity links; production is ready; server authorization is authoritative; the frontend should consume server authorization; self-service identity linking is approved; email is identity authority; client UID is identity authority; mutation/audit atomicity is implemented globally; or rollback was tested live.

This document clearly states: M20.23-OptionC1 is planning / authorization-gate only; no registry entries were created; no templates were completed with real values; no fixture was created; no DB connection occurred; no statement was run; no rows were inserted; no runtime behavior changed; future completed registry-entry controlled draft requires separate approval; future fixture provisioning requires separate approval; M20.17C remains blocked until a valid Controlled Pair A exists and re-attempt gates pass; production remains blocked; identity-link runtime wiring remains absent; and the Backend Control Plane remains read-only/mock-only.

## 44. Final Recommendation

Adopt this usage governance plan and record Decision A. The recommended next step is a future documentation-only registry-entry controlled-draft milestone that produces completed registry-entry documents using the templates under this governance, with owner approval, reviewer sign-off, and separation-of-duties. M20.23-OptionC1 is planning/authorization-gate only: no registry entries were created, no templates were completed with real values, no fixture was created, no DB connection occurred, no statement was run, no rows were inserted, and no runtime behavior changed. M20.20 fixture-provisioning execution and M20.17C remain blocked. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.

## 45. Recommended Next Milestone

Recommended next milestone: Phase 1.6 M20.23-OptionC1 — Scoped Commit and Backup Authorization (to commit and back up this usage governance plan). After that backup, a possible next milestone is a future documentation-only registry-entry controlled-draft milestone (governed completion of registry-entry documents using only conceptual labels). Any C2 server-only harness, fixture provisioning, or M20.17C controlled DB exercise remains a separate, later, owner-approved milestone.
