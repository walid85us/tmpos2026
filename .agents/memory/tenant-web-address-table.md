---
name: Tenant Web Address table — no-drift + grouping invariants
description: Invariants to preserve when editing the System Owner Tenant Web Address (formerly Domains) table/overview in src/owner/DomainsPage.tsx
---

# Tenant Web Address module invariants

The System Owner "Tenant Web Address" page (`src/owner/DomainsPage.tsx`, helper
`src/owner/tenantWebAddress.ts`) has gone through many presentation-only
"simplification" corrections. Two invariants keep breaking and must be protected
on every future edit:

## 1. No-drift: counts come from the flat array, not the table
- Dashboard summary cards and saved-view counts MUST derive from the flat
  `webAddresses` array + the single `matchesWebAddressFilter` predicate
  (`countWith` / `countView`).
- The table's row grouping (`tableRows` memo: one row per tenant/platform web
  address, externals collapsed into the tenant's row, external-only tenants as
  their own row) is **presentation-only**. Never let grouping feed counts, or
  cards and table will disagree.

## 2. Removing a column must not orphan grouped records
**Why:** A correction removed the table's "External Website" column, which was the
only path to open a tenant's collapsed sibling external/redirect records — they
became unreachable (architect FAIL).
**How to apply:** Before deleting any table column that opens a record, confirm
every record still has a reachable Manage/open path. The fix here: the selected
overview (`WebAddressOverview`) receives `selectedSiblingExternals` (flat
`webAddresses`, same tenant, `kind==='external'`, excluding the selected id) plus
an `onOpenWebAddress` callback, and renders each sibling with a Manage button in
the "External website / redirect guidance" section.

## Other standing constraints
- Presentation-only corrections: no changes to the `tenant_domains_v1` store,
  permission keys/resolver, or audit behavior.
- No real DNS/SSL/registrar/hosting language — it is truth-labeled as
  future/support-assisted, `WEB_ADDRESS_LIVE_HOSTING=false`.
- Deep-linking via `?domain=` / `?status=` and the mutation handlers/audit rows
  must survive UI refactors.
