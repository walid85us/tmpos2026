# Redacted Evidence Checklist (Template)

This is a blank, documentation-only checklist. All evidence must be aggregate-only and redacted. It creates no fixture and no database row.

## Allowed Evidence Categories

- template created: [yes/no]
- registry entry template completed: [yes/no]
- owner approval present: [yes/no]
- reviewer approval present: [yes/no]
- DEV-only confirmed: [yes/no]
- production-blocked confirmed: [yes/no]
- synthetic classification confirmed: [yes/no]
- provider coverage category captured: [yes/no]
- internal-anchor coverage category captured: [yes/no]
- cleanup / disable status captured: [yes/no]
- raw values printed: [no]
- secrets printed: [no]
- DB URL printed: [no]
- DB connection: [no]
- SQL executed: [no]
- rows inserted: [no]
- runtime / UI / API changed: [no]

## Aggregate-Only Count Categories (Optional)

- synthetic fixture count delta: [count]
- synthetic internal-anchor count delta: [count]
- synthetic Firebase-side platform_identity count delta: [count]
- synthetic Supabase-side platform_identity count delta: [count]
- shared-anchor pair count delta: [count]

These count categories are aggregate-only and must never be accompanied by any raw value.

## Outcome

- redacted evidence status: [redacted-evidence-status]
- evidence reason code: [safe-reason-code]

## Notice

This checklist is documentation-only. The count categories describe the only safe, aggregate-only evidence form for any future provisioning; recording them here creates no fixture, no database row, and no runtime change. No raw value, secret, DB URL, email, or payload may ever appear in evidence.
