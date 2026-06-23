# Lifecycle State Checklist (Template)

This is a blank, documentation-only checklist describing the lifecycle state model for a prospective entry. It creates no fixture and no database row.

## planned

- definition: a prospective synthetic fixture has been described but not approved.
- required evidence category: [planned-evidence-category]
- allowed transition: to approved (with owner and reviewer approval) or to blocked (on a stop condition).
- blocked transition: directly to provisioned or active.
- required approval category: [planned-approval-category]

## approved

- definition: owner and reviewer have approved the prospective fixture; no write has occurred.
- required evidence category: [approved-evidence-category]
- allowed transition: to provisioned (only under a separate execution authorization) or to blocked.
- blocked transition: to active without provisioning.
- required approval category: [approved-approval-category]

## provisioned

- definition: a future state describing that a clearly-marked synthetic fixture has been created under separate execution authorization.
- required evidence category: [provisioned-evidence-category]
- allowed transition: to active, disabled, or blocked.
- blocked transition: back to planned.
- required approval category: [provisioned-approval-category]

## active

- definition: a future state describing that a provisioned synthetic fixture is in use for a DEV exercise.
- required evidence category: [active-evidence-category]
- allowed transition: to disabled or blocked.
- blocked transition: to cleaned without first disabling.
- required approval category: [active-approval-category]

## disabled

- definition: a future state describing that a synthetic fixture has been made inactive without ambiguity.
- required evidence category: [disabled-evidence-category]
- allowed transition: to cleaned or blocked.
- blocked transition: back to active without approval.
- required approval category: [disabled-approval-category]

## cleaned

- definition: a future state describing that a synthetic fixture has been removed cleanly and the prior aggregate state restored.
- required evidence category: [cleaned-evidence-category]
- allowed transition: terminal (no further transition expected).
- blocked transition: to active or provisioned.
- required approval category: [cleaned-approval-category]

## blocked

- definition: a prospective entry halted due to a triggered stop condition.
- required evidence category: [blocked-evidence-category]
- allowed transition: to planned only after the stop condition is resolved and re-approved.
- blocked transition: to provisioned or active.
- required approval category: [blocked-approval-category]

## Notice

This checklist is documentation-only. Recording any state here creates no fixture, no database row, and no runtime change. The provisioned and active states describe only future possibilities under separate authorization.
