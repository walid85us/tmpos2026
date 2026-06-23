# Phase 1.6 M20.20-OptionC1 — DEV Test-Data Registry Control Plan / Authorization Gate

## 1. Title

Phase 1.6 Milestone 20.20-OptionC1 — DEV Test-Data Registry Control Plan / Authorization Gate (documentation-only).

## 2. Purpose

This document is a documentation-only control plan and authorization-gate record for Option C1: a documentation-only DEV test-data registry and a manual, owner-approved DEV fixture process. Its single purpose is to define how a future documentation-only DEV test-data registry should be controlled before any registry implementation, fixture implementation, or fixture write is allowed, and to record an authorization-gate decision about whether a future documentation-only C1 registry-template milestone may be requested. It does not implement the registry, create any registry entry, create any fixture, connect to any database, run any statement, mutate any table, insert any row, create any route, modify any runtime wiring, or modify any UI. It produces only this control plan and the accompanying final report.

## 3. Current Accepted Checkpoint

Accepted checkpoint immediately preceding this milestone: 16015c89502356f8a65c618272b697de51c595b7. Most recent accepted commit subject: "Phase 1.6 M20.19-OptionC document DEV test data framework plan." No checkpoint advancement occurs within this milestone; any commit/backup is deferred to a separate Scoped Commit and Backup Authorization step.

## 4. Scope

In scope for M20.20-OptionC1:

- Create exactly one new documentation-only file: this DEV test-data registry control plan.
- Define registry objectives, boundary, non-implementation boundary, DEV-only enforcement, production-blocked requirements, synthetic test-data and synthetic identity fixture classification, future Controlled Pair A registry requirements, the registry entry concept and its required/forbidden fields, lifecycle states, owner approval model, operator/reviewer separation, the manual owner-approved fixture process, secret-handling/redaction policy, evidence rules, forbidden evidence, stop conditions, rollback/cleanup/disable planning, audit planning, atomicity planning, future C1 registry implementation scope, blocked scope, future C1 registry entry template and review checklist requirements, the future C2 server-only harness path, the future fixture provisioning path, the future M20.17C re-attempt path, risks/mitigations, the authorization-gate decision, forbidden conclusions, a final recommendation, and the recommended next milestone.

## 5. Non-Goals

Not goals of M20.20-OptionC1:

- Implementing the registry or any registry tooling.
- Creating any registry entry, template, or checklist artifact.
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

Accepted context carried into this gate: M20.17B-Discovery established Firebase candidate count 1, Supabase candidate count 2, shared-anchor pair count 0, and eligible Controlled Pair A: no. M20.19 recorded decision B — NOT AUTHORIZED — OWNER APPROVAL SIGNALS MISSING. M20.19-OptionC recommended the conservative sequence: C1 first, then C2 only after a separate gate, with C3 not preferred. M20.20 fixture-provisioning execution remains blocked. M20.17C controlled DB exercise remains blocked.

## 8. Option C1 Rationale

Option C1 is the lowest-risk baseline governance control: a documentation-only registry plus a manual, owner-approved, redaction-first process for any future synthetic fixture, with no code, runtime, DB, or UI/API surface introduced. It provides immediate governance value — classification, lifecycle tracking, separation of duties, owner approval, and redaction discipline — before any server-only capability (C2) is even considered, and long before any fixture write. It makes later steps safer by establishing the records and checklists that any future provisioning would have to satisfy.

## 9. Registry-Control Problem Statement

There is presently no eligible Controlled Pair A and no governance record that would track a future synthetic fixture through approval, provisioning, and cleanup. Without such a control, any future fixture work would lack a documented owner-approval trail, lifecycle state, and redaction-safe evidence record. The problem this plan addresses is purely a control-and-governance gap: how to define a documentation-only registry and a manual owner-approved process so that, if and when fixture work is ever authorized, it is tracked safely and reversibly — without itself touching any data, runtime, or secret.

## 10. Registry Objectives

The future registry must aim to: record, in documentation only, each prospective synthetic fixture using safe conceptual fields; track each through defined lifecycle states; require explicit owner approval and reviewer approval before any future write; confirm DEV-only and production-blocked status as preconditions; classify synthetic test data and synthetic identity fixtures distinctly; capture redacted evidence status, cleanup/disable status, audit policy status, and stop-condition status; and support a future Controlled Pair A record. It must never hold real data, secrets, or raw identifiers.

## 11. Registry Boundary

The registry boundary is documentation-only, redaction-first, and isolated from runtime and data. It must never be exposed through any route, API endpoint, frontend UI, or Backend Control Plane UI; never connect to a database; never hold raw identifiers, secrets, or payloads; never make server authorization authoritative; and never act against production. Its only legitimate effect is to record safe, redacted governance metadata for prospective synthetic fixtures.

## 12. Registry Non-Implementation Boundary

This milestone does not implement the registry. No registry document, template, checklist, entry, or tooling is created here. The registry remains a concept defined for a future, separate, documentation-only implementation milestone, which itself must observe all boundaries in this plan.

## 13. DEV-Only Enforcement Requirements

The registry and any future manual process must record DEV-only status as a precondition, confirmed by a safe signal that never handles or prints protected connection material. Any prospective fixture whose target cannot be confirmed DEV by a safe signal must be marked blocked and may not advance. DEV-only status is a required registry field for every prospective fixture.

## 14. Production-Blocked Requirements

Production must remain blocked at all times. The registry must record production-blocked status as a required precondition field, independent of any other approval. No prospective fixture may advance toward provisioning unless production-blocked status is affirmed by a safe signal. The registry and process must never target production.

## 15. Synthetic Test-Data Classification

All prospective data recorded in the registry must be classified as synthetic and clearly marked as such using a designated conceptual marking convention. Synthetic test data must never originate from, mirror, or embed real customer, tenant, store, user, domain, IP, or request data. Classification is a required registry field.

## 16. Synthetic Identity Fixture Classification

A synthetic identity fixture is a specifically classified registry category: a clearly-marked synthetic DEV-only internal anchor together with clearly-marked synthetic provider-side references. The registry must distinguish this category from generic synthetic test data and from prior pilot identities and any real identity. Synthetic identity fixtures must carry provider coverage and internal-anchor coverage categories.

## 17. Controlled Pair A Future Registry Requirements

To support a future Controlled Pair A, the registry must be able to record, conceptually, one clearly-marked synthetic internal anchor mapped to exactly one clearly-marked synthetic Firebase-side reference and exactly one clearly-marked synthetic Supabase-side reference, such that a later read-only aggregate check could show a shared-anchor pair count delta of one. This is a recording capability only; it does not authorize creating such a pair, which remains gated behind separate approvals.

## 18. Registry Entry Concept

A future registry entry is a documentation-only record describing one prospective synthetic fixture using safe conceptual fields only. It is a governance artifact, not data: it never holds raw identifiers, secrets, rows, or payloads. Entries are created only in a future, separately approved documentation-only implementation; none are created here.

## 19. Registry Entry Required Fields

A future registry entry may include only safe conceptual fields such as: registry reference label; fixture purpose category; fixture type category; lifecycle state; owner approval status; reviewer approval status; DEV-only status; production-blocked status; synthetic classification; provider coverage category; internal-anchor coverage category; redacted evidence status; cleanup/disable status; audit policy status; and stop-condition status. All fields hold categories, booleans, or safe labels only.

## 20. Registry Entry Forbidden Fields

A future registry entry must never contain: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; DB URL; service-role key; anon key; tokens; secrets; Authorization headers; request bodies; response bodies; real customer/tenant/store names; real domains; real IPs; actor UUIDs; request IDs; or raw payloads.

## 21. Registry Lifecycle States

Registry entries must move through defined lifecycle states: planned, approved, provisioned, active, disabled, cleaned, and blocked. Each transition must require the appropriate approval and must be recorded with a safe reason code. An entry may only reach provisioned after approval; may be disabled or cleaned without ambiguity; and may be marked blocked if any stop condition triggers. In this documentation-only context, "provisioned/active" describe future states a fixture could occupy; recording them here does not create any fixture.

## 22. Owner Approval Model

Every prospective fixture entry must record an explicit owner and an explicit approver. No future write may occur without explicit owner approval captured as a safe signal and recorded in the entry. Approvals must be specific to the entry and to the operation (provision, disable, clean). Standing or implicit approval is insufficient.

## 23. Operator / Reviewer Separation-of-Duties

The operator who would perform a future fixture operation must be separate from the reviewer who approves it. The registry must require and record this separation as a safe signal before any future write. A single party performing both roles is a hard stop and must mark the entry blocked.

## 24. Manual Owner-Approved Fixture Process

The manual process (documentation-only) describes, conceptually, the steps a future owner-approved fixture would follow: record a planned entry; obtain owner and reviewer approval with separation of duties; confirm DEV-only and production-blocked status via safe signals; confirm synthetic classification and uniqueness strategy conceptually; only then (in a separately authorized execution milestone) provision; capture aggregate-only redacted evidence; and disable/clean with evidence. The process itself performs no write here; it is the checklist a future execution would have to satisfy.

## 25. Secret-Handling and Redaction Policy

The registry and process must never print, persist, or embed secrets, DB URLs, service-role keys, anon keys, tokens, Authorization headers, request/response bodies, or any raw identifiers. All checks must be presence-only (booleans/counts). All reporting must be redaction-first: aggregate counts, booleans, and safe reason codes only. Any need to read or print a raw value to proceed is a hard stop.

## 26. Evidence Rules

Allowed future evidence is yes/no and aggregate-only: registry template created yes/no; registry entry template created yes/no; review checklist created yes/no; lifecycle checklist created yes/no; owner approval checklist created yes/no; cleanup checklist created yes/no; redacted evidence checklist created yes/no; raw values printed: no; secrets printed: no; DB URL printed: no; DB connection occurred: no; SQL executed: no; rows inserted: no; runtime/UI/API changed: no.

## 27. Forbidden Evidence

Future evidence must never include: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; tokens; Authorization headers; request bodies; response bodies; DB URL; service-role key; anon key; secrets; actor UUID; permission key list; entitlement key list; mismatch list; raw payload; real customer/tenant/store names; real domains; real IPs; or real request IDs.

## 28. Stop Conditions

The registry process must stop immediately on any of: inability to confirm a DEV target via a safe signal; any indication of a production target; any need to read, print, or parse a raw value to proceed; a missing required approval or separation-of-duties signal; an ambiguous or unclassifiable prospective fixture; any attempt to expose a capability through UI/API/runtime; or any unexpected mutation surface. A stop condition marks the affected entry blocked and halts the operation.

## 29. Rollback / Cleanup / Disable Planning

Every prospective fixture entry must reference an accepted rollback/cleanup/disable approach before any future provisioning. Disable must make a future fixture inactive without ambiguity; cleanup must remove a synthetic fixture cleanly; rollback must restore the prior aggregate state. Rollback/cleanup/disable evidence must be aggregate-only and redacted. No rollback may be claimed as tested live in this plan.

## 30. Audit Planning

The registry must define an audit policy: fixture provisioning itself must not create identity_link audit events; any audit_event creation for identity_link remains separately gated. Where the registry records governance audit, it must use safe reason codes and aggregate metadata only, with no raw payloads or metadata dumps. This plan creates no audit records.

## 31. Atomicity Planning

A future fixture-producing operation must be atomic at the operation level: a single provision either fully succeeds (anchor plus its provider references consistently recorded) or leaves no partial fixture. The registry should record an entry's atomicity expectation. This plan does not claim atomicity is implemented globally; it states the requirement only.

## 32. Future C1 Registry Implementation Scope

A future C1 implementation milestone must be documentation-only. It may create documentation templates only, such as: a registry template document; a registry entry template; a review checklist template; a redacted evidence checklist; a lifecycle state checklist; an owner approval checklist; and a cleanup/disable checklist. It must still not connect to a database, run any statement, create any fixture or platform_identity/identity_link/audit_event row, create runtime tools, create UI/API access, expose Backend Control Plane write controls, or authorize M20.17C.

## 33. Blocked Scope

The following remain blocked and are not authorized by this plan: registry implementation (until a separate documentation-only C1 implementation milestone); any C2 server-only harness implementation (until a separate gate); any fixture creation; identity_link creation; audit_event creation for identity_link; conflict/missing-platform_identity/constraint-conflict forced scenarios; revoke lifecycle; audit-writer failure simulation; bulk linking; UI exposure; API exposure; Backend Control Plane write controls; runtime authorization integration; production exercise; making server authorization authoritative; frontend consumption of server authorization; self-service identity linking; and treating email or client-supplied UID as identity authority.

## 34. Future C1 Registry Entry Template Requirements

A future registry entry template must contain only the safe conceptual fields enumerated in Section 19, must explicitly forbid the fields enumerated in Section 20, must include a lifecycle state field constrained to the Section 21 states, must include owner and reviewer approval fields with separation-of-duties, and must include a safe reason code field. The template must be redaction-first and must carry an explicit notice that no raw identifiers, secrets, rows, or payloads may ever be entered.

## 35. Future C1 Review Checklist Requirements

A future review checklist must verify, for any prospective entry: DEV-only status affirmed; production-blocked status affirmed; synthetic classification affirmed; provider and internal-anchor coverage categorized; owner and reviewer approvals present with separation-of-duties; redacted evidence approach defined; rollback/cleanup/disable approach defined; audit policy affirmed; stop conditions acknowledged; and no forbidden field present. The checklist must produce only yes/no and safe reason-code outcomes.

## 36. Future C2 Server-Only Harness Path

Option C2 (a server-only, default-OFF, owner-gated DEV test-data capability with no UI/API exposure) remains a later, separate path. It may only be requested after C1 is in place and only through a separate implementation authorization gate that confirms all preconditions (safe DEV-target confirmation, production-blocked confirmation, schema support, uniqueness strategy, rollback/cleanup, redacted evidence, audit policy, no-identity_link-rows, no-runtime/UI/API-exposure, stop conditions, operator/reviewer separation). This plan does not authorize C2.

## 37. Future Fixture Provisioning Path

Once C1 is in place (and, if approved, C2 implemented) and all preconditions are present and accepted, a future fixture provisioning execution may be requested through a fresh authorization gate (the role M20.19 played, re-run with signals present), leading — only on a future Decision A — to a fixture provisioning execution milestone limited to one synthetic anchor and two synthetic provider references mapped to it, with aggregate-only redacted evidence and rollback/cleanup. Nothing here authorizes that execution.

## 38. Future M20.17C Re-Attempt Path

Only after a synthetic fixture is provisioned and a future read-only aggregate check shows an eligible Controlled Pair A exists, and only after the M20.17B re-attempt authorization gates pass, may a future M20.17C controlled DB exercise be requested. M20.17C remains blocked until those conditions are met. This plan does not authorize M20.17C.

## 39. Risks and Mitigations

- Risk: registry holding real or raw data. Mitigation: forbidden-field list (Section 20); redaction-first; presence-only checks.
- Risk: target ambiguity. Mitigation: DEV-only and production-blocked status as required fields; hard stop on ambiguity.
- Risk: approval/SoD lapse. Mitigation: required owner and reviewer approval fields with separation-of-duties.
- Risk: scope creep toward DB writes/runtime/UI/API. Mitigation: explicit non-implementation and blocked-scope sections; documentation-only future C1.
- Risk: irreversible future changes. Mitigation: required rollback/cleanup/disable references before any provisioning.
- Risk: premature automation. Mitigation: C1 documentation-only first; C2 gated separately; C3 not preferred.
- Risk: confusing prior pilot identities with synthetic fixtures. Mitigation: distinct synthetic identity fixture classification.

## 40. Authorization Gate Decision

Decision: A — AUTHORIZED TO REQUEST FUTURE C1 DOCUMENTATION-ONLY REGISTRY TEMPLATE MILESTONE — NOT IMPLEMENTED IN M20.20-OPTIONC1.

Rationale: This control plan is complete — it defines the registry objectives, boundary, non-implementation boundary, DEV-only/production-blocked requirements, classification, Controlled Pair A recording capability, the registry entry concept with required and forbidden fields, lifecycle states, owner approval model, separation-of-duties, manual process, redaction policy, evidence rules and forbidden evidence, stop conditions, rollback/cleanup/disable planning, audit planning, atomicity planning, future C1 implementation scope and templates/checklists, blocked scope, the C2 path, the fixture provisioning path, and the M20.17C re-attempt path. No safety blocker, raw-value exposure risk, or proximity-to-DB-write risk was found: the next step (a future C1 implementation milestone) is itself strictly documentation-only and does not connect to a database, write rows, wire runtime, or expose UI/API. Therefore a future documentation-only C1 registry-template milestone may be requested. No registry, template, entry, or fixture was implemented or created here; no DB connection occurred; no rows were inserted; M20.20 fixture-provisioning execution and M20.17C remain blocked.

## 41. Forbidden Conclusions

This document does not claim, and future work must not claim without separate authorization, that: the registry was implemented; registry entries were created; the framework was implemented; a fixture was created; platform_identity rows were inserted; identity_link rows were inserted; audit_event rows were inserted; Controlled Pair A now exists; M20.20 is authorized; M20.17C is authorized; the repository adapter is wired to runtime; the audit adapter is wired to runtime; the Backend Control Plane can create identity links; an API can create identity links; production is ready; server authorization is authoritative; the frontend should consume server authorization; self-service identity linking is approved; email is identity authority; client UID is identity authority; mutation/audit atomicity is implemented globally; or rollback was tested live.

This document clearly states: M20.20-OptionC1 is planning / authorization-gate only; no DB connection occurred; no statement was run; no rows were inserted; no runtime behavior changed; future C1 implementation requires separate approval; future fixture provisioning requires separate approval; M20.17C remains blocked until a valid Controlled Pair A exists and re-attempt gates pass; production remains blocked; identity-link runtime wiring remains absent; and the Backend Control Plane remains read-only/mock-only.

## 42. Final Recommendation

Adopt this control plan and record Decision A. The recommended next step is a future documentation-only C1 registry-template milestone (templates and checklists only), followed — only after a separate gate — by consideration of C2; C3 is not preferred. M20.20-OptionC1 is planning/authorization-gate only: no DB connection occurred, no statement was run, no rows were inserted, and no runtime behavior changed. M20.20 fixture-provisioning execution and M20.17C remain blocked. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.

## 43. Recommended Next Milestone

Recommended next milestone: Phase 1.6 M20.20-OptionC1 — Scoped Commit and Backup Authorization (to commit and back up this control plan). After that backup, a possible next milestone is a future documentation-only C1 registry-template implementation milestone (templates and checklists only). Any server-only harness (C2), fixture provisioning, or controlled DB exercise (M20.17C) remains a separate, later, owner-approved milestone.
