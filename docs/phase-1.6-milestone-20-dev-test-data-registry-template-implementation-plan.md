# Phase 1.6 M20.21-OptionC1 — DEV Test-Data Registry Template Implementation Plan

## 1. Title

Phase 1.6 Milestone 20.21-OptionC1 — DEV Test-Data Registry Template Implementation Plan (documentation-only).

## 2. Purpose

This document is a documentation-only implementation plan for a future, separate, documentation-only milestone that may create the Option C1 DEV test-data registry template package (templates and checklists). Its single purpose is to define exactly what that future template package should contain, how it should be reviewed and placed, and the safety constraints it must observe — so that the package can later be created safely. It does not create the templates, create any registry entry, implement the registry, create any fixture, connect to any database, run any statement, mutate any table, insert any row, create any route, modify any runtime wiring, or modify any UI. It produces only this implementation plan and the accompanying final report.

## 3. Current Accepted Checkpoint

Accepted checkpoint immediately preceding this milestone: b76681af5dd8214a0ebc7fcd4b22f125c4e3cf0b. Most recent accepted commit subject: "Phase 1.6 M20.20-OptionC1 document DEV test data registry control plan." No checkpoint advancement occurs within this milestone; any commit/backup is deferred to a separate Scoped Commit and Backup Authorization step.

## 4. Scope

In scope for M20.21-OptionC1:

- Create exactly one new documentation-only file: this DEV test-data registry template implementation plan.
- Define the template package objectives, boundary, non-implementation boundary, the proposed documentation template inventory, per-template plans (registry template document, registry entry template, owner approval checklist, reviewer checklist, lifecycle state checklist, redacted evidence checklist, cleanup/disable checklist, stop-condition checklist), the registry entry required/forbidden field models, the lifecycle state model, the synthetic fixture classification model, future Controlled Pair A template requirements, secret-handling/redaction requirements, evidence rules, forbidden evidence, the future template file naming and placement plans, the future template review process, completion criteria, backout/correction process, future C1 template implementation scope, blocked scope, the C2 path, the future fixture provisioning path, the future M20.17C re-attempt path, risks/mitigations, the authorization-gate decision, forbidden conclusions, a final recommendation, and the recommended next milestone.

## 5. Non-Goals

Not goals of M20.21-OptionC1:

- Creating any template, checklist, or registry artifact (no separate template files are created here).
- Creating any registry entry; implementing the registry.
- Creating a synthetic anchor, synthetic provider reference, or any fixture.
- Connecting to any database; running any statement, schema change, or migration.
- Inserting any platform_identity, identity_link, or audit_event row.
- Calling the repository adapter against a real database or the audit adapter against a real durable writer.
- Creating or modifying routes, API endpoints, startup/server wiring, frontend UI, or Backend Control Plane UI.
- Exposing any test-data tool, registry, fixture, or identity-link capability through UI or API.
- Wiring any server-side authorization, identity-link, harness, feed, token-bridge, or comparison capability into runtime.
- Making server authorization authoritative or having the frontend consume server authorization.
- Committing, pushing, or backing up (handled by a separate authorization step).

## 6. Source-of-Truth Artifacts

This plan relies only on previously accepted artifacts and findings:

- M20.20-OptionC1 DEV test-data registry control plan.
- M20.19-OptionC dedicated DEV test-data framework plan.
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

## 7. Prior Accepted Context

Accepted context carried into this plan: M20.17B-Discovery established Firebase candidate count 1, Supabase candidate count 2, shared-anchor pair count 0, and eligible Controlled Pair A: no. M20.19 recorded decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. M20.19-OptionC recommended C1 first, then C2 only after a separate gate, with C3 not preferred. M20.20-OptionC1 recorded Decision A: authorized to request a future documentation-only C1 registry-template milestone. M20.20 fixture-provisioning execution remains blocked. M20.17C controlled DB exercise remains blocked.

## 8. M20.20-OptionC1 Decision Summary

M20.20-OptionC1 defined the DEV test-data registry controls and recorded Decision A — authorized to request a future documentation-only C1 registry-template milestone, not implemented there. That decision established the registry objectives, boundary, non-implementation boundary, classification, lifecycle states, owner approval and separation-of-duties model, redaction policy, evidence rules, stop conditions, rollback/audit/atomicity planning, and the required/forbidden registry-entry fields. This plan turns that authorized direction into a concrete (still documentation-only) template package specification.

## 9. Template Implementation Problem Statement

The registry controls are defined, but no template package yet exists to operationalize them in a redaction-safe way. Without a defined template package, any future C1 implementation milestone would lack a concrete specification of what documents to create, what fields they contain, how they are reviewed, where they live, and how they are corrected or backed out. The problem this plan addresses is purely specification: defining the template package precisely enough that a future documentation-only milestone can create it safely, with no data, runtime, DB, secret, or UI/API surface.

## 10. Template Package Objectives

The future template package must aim to: provide a registry template document and an entry template that capture only safe conceptual fields; provide checklists for owner approval, reviewer review, lifecycle state, redacted evidence, cleanup/disable, and stop conditions; embed the redaction-first policy and forbidden-field rules directly into each template; constrain lifecycle to the accepted states; support a future Controlled Pair A record conceptually; and make every template usable without ever entering a raw identifier, secret, or payload.

## 11. Template Package Boundary

The template package boundary is documentation-only, redaction-first, and isolated from runtime and data. The templates must never be exposed through any route, API endpoint, frontend UI, or Backend Control Plane UI; never connect to a database; never hold raw identifiers, secrets, rows, or payloads; never make server authorization authoritative; and never act against production. Their only legitimate function is to structure safe, redacted governance metadata for prospective synthetic fixtures.

## 12. Template Non-Implementation Boundary

This milestone does not create the templates. No registry template, entry template, checklist, or registry entry is created here. The template package remains a specification for a future, separate, documentation-only implementation milestone, which itself must observe all boundaries in this plan.

## 13. Proposed Documentation Template Inventory

The future documentation-only template package may include only documentation templates/checklists such as: a DEV test-data registry template; a registry entry template; an owner approval checklist template; a reviewer checklist template; a lifecycle state checklist template; a redacted evidence checklist template; a cleanup/disable checklist template; and a stop-condition checklist template. The future template package must not include: executable code; executable SQL; shell commands; DB connection commands; runtime tools; API endpoints; UI components; Backend Control Plane write controls; fixture rows; registry entries with real values; raw identifiers; secrets; emails; platform_identity rows; identity_link rows; or audit_event rows.

## 14. Registry Template Document Plan

The registry template document (future) is the top-level index of prospective synthetic fixtures. It should describe its purpose, the redaction-first policy, the allowed conceptual fields, the forbidden-field rule, the lifecycle state vocabulary, and how entries reference owner/reviewer approval — all as a blank, fill-in-later structure that holds no real data. It must carry an explicit notice that no raw identifiers, secrets, rows, or payloads may ever be entered.

## 15. Registry Entry Template Plan

The registry entry template (future) is a single blank record for one prospective synthetic fixture. It should enumerate only the safe conceptual fields (Section 22), explicitly forbid the fields in Section 23, constrain its lifecycle field to the Section 24 states, include owner and reviewer approval fields with separation-of-duties, and include a safe reason-code field. It must be a blank form, never pre-filled with any real value.

## 16. Owner Approval Checklist Template Plan

The owner approval checklist template (future) should verify, as yes/no items, that an explicit owner approval exists for the specific entry and operation, that DEV-only and production-blocked status are affirmed, that synthetic classification is affirmed, and that the approval is recorded as a safe signal. It must produce only yes/no and safe reason-code outcomes.

## 17. Reviewer Checklist Template Plan

The reviewer checklist template (future) should verify, as yes/no items, that the reviewer is distinct from the operator (separation-of-duties), that all required fields are present and valid, that no forbidden field is present, that the redacted evidence approach is defined, and that the rollback/cleanup/disable approach is defined. It must produce only yes/no and safe reason-code outcomes.

## 18. Lifecycle State Checklist Template Plan

The lifecycle state checklist template (future) should confirm that the entry's lifecycle state is one of the accepted states (planned, approved, provisioned, active, disabled, cleaned, blocked), that the transition into the current state had the required approval, and that the transition is recorded with a safe reason code. It must produce only yes/no and safe reason-code outcomes.

## 19. Redacted Evidence Checklist Template Plan

The redacted evidence checklist template (future) should confirm that any evidence captured is aggregate-only and redacted (counts, count deltas, booleans, safe reason codes), that no raw value, secret, DB URL, email, or payload appears, and that the forbidden-evidence rule (Section 29) is satisfied. It must produce only yes/no and safe reason-code outcomes.

## 20. Cleanup / Disable Checklist Template Plan

The cleanup/disable checklist template (future) should confirm that a disable approach makes a future fixture inactive without ambiguity, that a cleanup approach removes a synthetic fixture cleanly, that a rollback approach restores the prior aggregate state, and that cleanup/disable/rollback evidence is aggregate-only and redacted. It must produce only yes/no and safe reason-code outcomes.

## 21. Stop-Condition Checklist Template Plan

The stop-condition checklist template (future) should enumerate the stop conditions (inability to confirm DEV target via a safe signal; any production-target indication; any need to read/print/parse a raw value; missing approval or separation-of-duties; ambiguous/unclassifiable fixture; any UI/API/runtime exposure attempt; any unexpected mutation surface) and confirm that none is triggered, marking the entry blocked if any is. It must produce only yes/no and safe reason-code outcomes.

## 22. Registry Entry Required Field Model

A future registry entry template may include only safe conceptual fields such as: registry reference label; fixture purpose category; fixture type category; lifecycle state; owner approval status; reviewer approval status; DEV-only status; production-blocked status; synthetic classification; provider coverage category; internal-anchor coverage category; redacted evidence status; cleanup/disable status; audit policy status; and stop-condition status. All fields hold categories, booleans, or safe labels only.

## 23. Registry Entry Forbidden Field Model

A future registry entry template must never contain: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; DB URL; service-role key; anon key; tokens; secrets; Authorization headers; request bodies; response bodies; real customer/tenant/store names; real domains; real IPs; actor UUIDs; request IDs; or raw payloads.

## 24. Registry Lifecycle State Model

The lifecycle state model constrains an entry's state to: planned, approved, provisioned, active, disabled, cleaned, and blocked. Transitions require the appropriate approval and a safe reason code. In this documentation-only context, "provisioned/active" describe future states a fixture could occupy; specifying them here creates no fixture.

## 25. Synthetic Fixture Classification Model

The classification model distinguishes generic synthetic test data from synthetic identity fixtures. A synthetic identity fixture is a clearly-marked synthetic DEV-only internal anchor together with clearly-marked synthetic provider-side references, carrying provider coverage and internal-anchor coverage categories. Classification must never embed or mirror real customer/tenant/store/user/domain/IP/request data, and must distinguish synthetic fixtures from prior pilot identities and any real identity.

## 26. Controlled Pair A Future Template Requirements

To support a future Controlled Pair A, the entry template must be able to represent, conceptually, one clearly-marked synthetic internal anchor mapped to exactly one clearly-marked synthetic Firebase-side reference and exactly one clearly-marked synthetic Supabase-side reference, via provider coverage and internal-anchor coverage categories, such that a later read-only aggregate check could show a shared-anchor pair count delta of one. This is a representation capability only; it does not authorize creating such a pair.

## 27. Secret-Handling and Redaction Requirements

Every template must embed the policy that nothing may print, persist, or embed secrets, DB URLs, service-role keys, anon keys, tokens, Authorization headers, request/response bodies, or any raw identifiers. All checks must be presence-only (booleans/counts). All reporting must be redaction-first: aggregate counts, booleans, and safe reason codes only. Any need to read or print a raw value to proceed is a hard stop.

## 28. Evidence Rules

Allowed future evidence is yes/no and aggregate-only: template package created yes/no; registry template created yes/no; registry entry template created yes/no; owner checklist created yes/no; reviewer checklist created yes/no; lifecycle checklist created yes/no; cleanup checklist created yes/no; redacted evidence checklist created yes/no; stop-condition checklist created yes/no; raw values printed: no; secrets printed: no; DB URL printed: no; DB connection occurred: no; SQL executed: no; rows inserted: no; runtime/UI/API changed: no.

## 29. Forbidden Evidence

Future evidence must never include: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; tokens; Authorization headers; request bodies; response bodies; DB URL; service-role key; anon key; secrets; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; real customer/tenant/store names; real domains; real IPs; or real request IDs.

## 30. Future Template File Naming Plan

The future template package should use clear, descriptive, conceptual file names that mark each artifact as a DEV test-data template or checklist (for example, names indicating "dev test-data registry template," "registry entry template," and the respective checklist names). Names must be redaction-safe and must not embed any real identifier, value, or secret. The exact names are to be finalized in the future implementation milestone; this plan specifies only the naming convention.

## 31. Future Template Placement Plan

The future template package should be placed under the project documentation area (the docs location used by prior Phase 1.6 milestones), grouped recognizably as the DEV test-data registry template package. Placement must not introduce any runtime, route, API, UI, migration, seed, or package coupling; templates are documentation only and live alongside other plan documents.

## 32. Future Template Review Process

The future template package, once created, must be reviewed using the same governance discipline as the milestones: a preflight confirming only the intended template files are added; a redaction scan confirming no raw values, secrets, code, or SQL; a confirmation that the templates contain only blank conceptual fields and embedded policy; operator/reviewer separation; and a final report. No template may be accepted if it contains any forbidden field or any real value.

## 33. Future Template Completion Criteria

The future template implementation is complete when: all inventory templates (Section 13) exist as blank, redaction-first documents; each embeds the required-field model, forbidden-field rule, lifecycle vocabulary, and redaction policy; each checklist produces only yes/no and safe reason-code outcomes; the redaction scan passes; and the review process (Section 32) passes. Completion is documentation-only; it creates no registry entry and no fixture.

## 34. Future Template Backout / Correction Process

If a future template is found to contain a defect (for example, an inadvertent forbidden field or ambiguous instruction), the correction process is: record the issue with a safe reason code; correct or remove the affected template via a scoped, documentation-only change; re-run the redaction scan and review; and, if necessary, back out the template addition entirely via a scoped revert of the documentation-only change. Backout/correction must never touch data, runtime, or secrets.

## 35. Future C1 Template Implementation Scope

A future C1 template implementation milestone must be documentation-only. It may create the inventory templates/checklists in Section 13 as blank, redaction-first documents. It must still not connect to a database, run any statement, create any fixture or platform_identity/identity_link/audit_event row, create any registry entry with real values, create runtime tools, create UI/API access, expose Backend Control Plane write controls, or authorize M20.17C.

## 36. Blocked Scope

The following remain blocked and are not authorized by this plan: template creation (until a separate documentation-only C1 template implementation milestone); registry implementation; any C2 server-only harness implementation (until a separate gate); any registry entry creation; any fixture creation; identity_link creation; audit_event creation for identity_link; conflict/missing-platform_identity/constraint-conflict forced scenarios; revoke lifecycle; audit-writer failure simulation; bulk linking; UI exposure; API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise; making server authorization authoritative; frontend consumption of server authorization; self-service identity linking; and treating email or client-supplied UID as identity authority.

## 37. Future C2 Server-Only Harness Path

Option C2 (a server-only, default-OFF, owner-gated DEV test-data capability with no UI/API exposure) remains a later, separate path. It may only be requested after the C1 template package is in place and only through a separate implementation authorization gate confirming all preconditions (safe DEV-target confirmation, production-blocked confirmation, schema support, uniqueness strategy, rollback/cleanup, redacted evidence, audit policy, no-identity_link-rows, no-runtime/UI/API-exposure, stop conditions, operator/reviewer separation). This plan does not authorize C2.

## 38. Future Fixture Provisioning Path

Once the C1 template package is in place (and, if approved, C2 implemented) and all preconditions are present and accepted, a future fixture provisioning execution may be requested through a fresh authorization gate (the role M20.19 played, re-run with signals present), leading — only on a future Decision A — to a fixture provisioning execution milestone limited to one synthetic anchor and two synthetic provider references mapped to it, with aggregate-only redacted evidence and rollback/cleanup. Nothing here authorizes that execution.

## 39. Future M20.17C Re-Attempt Path

Only after a synthetic fixture is provisioned and a future read-only aggregate check shows an eligible Controlled Pair A exists, and only after the M20.17B re-attempt authorization gates pass, may a future M20.17C controlled DB exercise be requested. M20.17C remains blocked until those conditions are met. This plan does not authorize M20.17C.

## 40. Risks and Mitigations

- Risk: a template inviting raw-value entry. Mitigation: forbidden-field model (Section 23) embedded in every template; redaction-first notices; review redaction scan.
- Risk: scope creep toward runtime/DB/UI/API. Mitigation: documentation-only boundary; non-implementation boundary; blocked-scope section.
- Risk: ambiguous template instructions. Mitigation: completion criteria and review process; backout/correction process.
- Risk: target ambiguity in future use. Mitigation: DEV-only and production-blocked checklist items.
- Risk: approval/SoD lapse in future use. Mitigation: owner and reviewer checklists with separation-of-duties.
- Risk: irreversible future changes. Mitigation: cleanup/disable checklist and rollback approach required before any provisioning.
- Risk: confusing prior pilot identities with synthetic fixtures. Mitigation: synthetic fixture classification model.

## 41. Authorization Gate Decision

Decision: A — READY TO REQUEST FUTURE C1 TEMPLATE DOCUMENTS MILESTONE — NOT IMPLEMENTED IN M20.21-OPTIONC1.

Rationale: This implementation plan is complete — it defines the template package objectives, boundary, non-implementation boundary, the full template inventory with per-template plans, the registry entry required and forbidden field models, the lifecycle state model, the synthetic fixture classification model, future Controlled Pair A template requirements, secret-handling/redaction requirements, evidence rules and forbidden evidence, the future file naming and placement plans, the future review process, completion criteria, backout/correction process, future C1 implementation scope, blocked scope, the C2 path, the fixture provisioning path, and the M20.17C re-attempt path. No raw-value exposure risk was found (templates are blank, conceptual, redaction-first), and the next step (a future C1 template documents milestone) is itself strictly documentation-only and does not connect to a database, write rows, create registry entries, wire runtime, or expose UI/API. Therefore a future C1 template documents milestone may be requested. No template, registry, entry, or fixture was created here; no DB connection occurred; no rows were inserted; M20.20 fixture-provisioning execution and M20.17C remain blocked.

## 42. Forbidden Conclusions

This document does not claim, and future work must not claim without separate authorization, that: templates were created; the registry was implemented; registry entries were created; the framework was implemented; a fixture was created; platform_identity rows were inserted; identity_link rows were inserted; audit_event rows were inserted; Controlled Pair A now exists; M20.20 execution is authorized; M20.17C is authorized; the repository adapter is wired to runtime; the audit adapter is wired to runtime; the Backend Control Plane can create identity links; an API can create identity links; production is ready; server authorization is authoritative; the frontend should consume server authorization; self-service identity linking is approved; email is identity authority; client UID is identity authority; mutation/audit atomicity is implemented globally; or rollback was tested live.

This document clearly states: M20.21-OptionC1 is planning / authorization-gate only; no templates were created; no registry entries were created; no DB connection occurred; no statement was run; no rows were inserted; no runtime behavior changed; future C1 template document creation requires separate approval; future fixture provisioning requires separate approval; M20.17C remains blocked until a valid Controlled Pair A exists and re-attempt gates pass; production remains blocked; identity-link runtime wiring remains absent; and the Backend Control Plane remains read-only/mock-only.

## 43. Final Recommendation

Adopt this implementation plan and record Decision A. The recommended next step is a future documentation-only C1 template documents milestone that creates the inventory templates/checklists (Section 13) as blank, redaction-first documents, reviewed per Section 32 and completed per Section 33. M20.21-OptionC1 is planning/authorization-gate only: no templates were created, no registry entries were created, no DB connection occurred, no statement was run, no rows were inserted, and no runtime behavior changed. M20.20 fixture-provisioning execution and M20.17C remain blocked. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.

## 44. Recommended Next Milestone

Recommended next milestone: Phase 1.6 M20.21-OptionC1 — Scoped Commit and Backup Authorization (to commit and back up this implementation plan). After that backup, a possible next milestone is a future documentation-only C1 template documents implementation milestone (creating the blank templates and checklists). Any C2 server-only harness, fixture provisioning, or M20.17C controlled DB exercise remains a separate, later, owner-approved milestone.
