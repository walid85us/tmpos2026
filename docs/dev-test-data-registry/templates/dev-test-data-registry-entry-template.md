# DEV Test-Data Registry Entry (Template)

This is a blank, documentation-only entry template for one prospective synthetic DEV-only fixture. It contains no real values and creates no fixture or database row.

## Allowed Conceptual Fields

- registry reference label: [registry-reference-label]
- fixture purpose category: [fixture-purpose-category]
- fixture type category: [fixture-type-category]
- lifecycle state: [lifecycle-state]
- owner approval status: [owner-approval-status]
- reviewer approval status: [reviewer-approval-status]
- DEV-only status: [dev-only-status]
- production-blocked status: [production-blocked-status]
- synthetic classification: [synthetic-classification]
- provider coverage category: [provider-coverage-category]
- internal-anchor coverage category: [internal-anchor-coverage-category]
- redacted evidence status: [redacted-evidence-status]
- cleanup / disable status: [cleanup-disable-status]
- audit policy status: [audit-policy-status]
- stop-condition status: [stop-condition-status]

Each field holds only a safe category, a boolean, a count, or a safe label.

## Forbidden Fields

This entry must never contain: raw Firebase UID; raw Supabase UID; raw provider UID; raw internal_user_id; raw platform_identity rows; raw identity_link rows; raw audit_event rows; emails; DB URL; service-role key; anon key; tokens; secrets; Authorization headers; request bodies; response bodies; real customer/tenant/store names; real domains; real IPs; actor UUIDs; request IDs; or raw payloads. If any such value would be required, stop and mark the entry blocked.

## Approval Summary

- owner approval present: [yes/no]
- reviewer approval present: [yes/no]
- operator and reviewer are distinct (separation-of-duties): [yes/no]
- approval reason code: [safe-reason-code]

## Evidence Summary

- evidence is aggregate-only and redacted: [yes/no]
- raw values present: [no]
- secrets present: [no]
- DB URL present: [no]
- DB connection occurred: [no]
- SQL executed: [no]
- rows inserted: [no]
- runtime / UI / API changed: [no]

## Lifecycle Notes

- current lifecycle state: [lifecycle-state]
- prior lifecycle state: [lifecycle-state]
- transition approval present: [yes/no]
- transition reason code: [safe-reason-code]

## Cleanup Notes

- cleanup strategy category: [cleanup-strategy-category]
- disable strategy category: [disable-strategy-category]
- rollback category: [rollback-category]
- cleanup / disable status: [cleanup-disable-status]

## Stop-Condition Notes

- stop-condition status: [stop-condition-status]
- triggered stop condition category (if any): [stop-condition-category]
- entry marked blocked due to stop condition: [yes/no]

## Notice

Completing this entry creates no fixture, no platform_identity row, no identity_link row, no audit_event row, and no runtime change. It is a documentation-only governance record. Future fixture provisioning requires separate approval.
