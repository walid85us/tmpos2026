# Reviewer Checklist (Template)

This is a blank, documentation-only checklist for an independent reviewer. The reviewer must be distinct from the operator (separation-of-duties).

## Reviewer Items

- independent review status: [independent-review-status]
- separation-of-duties confirmation (reviewer is not the operator): [yes/no]
- redaction review (no raw values, secrets, DB URL, emails, or payloads present): [yes/no]
- forbidden evidence review (no forbidden field or forbidden evidence present): [yes/no]
- lifecycle-state review (state is valid and transition had required approval): [yes/no]
- cleanup / disable review (cleanup, disable, and rollback approaches are defined): [yes/no]
- audit policy review (fixture provisioning does not create identity_link audit events; any audit_event for identity_link is separately gated): [yes/no]
- stop-condition review (no stop condition is triggered): [yes/no]
- no raw-value exposure review (nothing requires reading or printing a raw value): [yes/no]

## Reviewer Outcome

- reviewer approval status: [reviewer-approval-status]
- reviewer reason code: [safe-reason-code]

## Notice

This checklist is documentation-only. It creates no fixture, no registry, no database row, and no runtime change. A passing review does not by itself authorize any database write or fixture provisioning; future fixture provisioning requires a separate authorization gate.
