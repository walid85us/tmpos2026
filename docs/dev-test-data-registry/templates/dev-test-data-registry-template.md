# DEV Test-Data Registry (Template)

This is a blank, documentation-only template. It is not a registry and contains no real entries.

## Registry Purpose

Provide a redaction-first, documentation-only index of prospective, clearly-marked synthetic DEV-only test-data fixtures (including prospective synthetic identity fixtures), tracked through a defined lifecycle, so that any future fixture work is governed, reviewed, and reversible. The registry holds only safe conceptual labels, categories, booleans, and counts — never real data.

## Registry Scope

- In scope: documentation-only governance metadata for prospective synthetic DEV-only fixtures.
- Out of scope: any real customer data; any raw identifier; any secret; any database write; any runtime, route, API, or UI exposure; any fixture creation; any identity_link or audit_event creation.

## Lifecycle State Model

Each prospective entry occupies exactly one lifecycle state at a time, from this vocabulary: planned, approved, provisioned, active, disabled, cleaned, blocked. Transitions require the appropriate approval and a safe reason code. In this documentation-only context, "provisioned" and "active" describe future states a fixture could occupy; recording them here creates no fixture.

## Safe Aggregate-Only Registry Summary Fields

The registry summary may record only safe, aggregate-only fields, such as:

- total prospective entries count: [count]
- entries in planned state count: [count]
- entries in approved state count: [count]
- entries in provisioned state count: [count]
- entries in active state count: [count]
- entries in disabled state count: [count]
- entries in cleaned state count: [count]
- entries in blocked state count: [count]
- entries with owner approval present count: [count]
- entries with reviewer approval present count: [count]
- DEV-only confirmed count: [count]
- production-blocked confirmed count: [count]

No field may hold a raw identifier, secret, value, or row.

## Governance Notes

- Every entry must have an owner and an independent reviewer (separation-of-duties).
- DEV-only status and production-blocked status are required preconditions for any prospective entry.
- All evidence is aggregate-only and redacted.
- Any stop condition marks the affected entry blocked.

## Forbidden Content

This registry must never contain: executable code; executable SQL; shell/psql/CLI/migration-runner/DB-connection commands; DB URLs; environment variable values; service-role keys; anon keys; tokens; Authorization headers; request/response bodies; raw identity rows; raw audit rows; raw Firebase/Supabase/provider UID; raw internal_user_id; emails; real tenant/store/customer names; real domains; real IPs; real request IDs; actor UUIDs; audit metadata dumps; raw authorization objects; permission/entitlement key lists; mismatch lists; or raw payloads.

## Review Status

- registry template reviewed: [yes/no]
- redaction scan passed: [yes/no]
- separation-of-duties confirmed: [yes/no]
- review reason code: [safe-reason-code]

## No Real Entries

This template holds no real entries. It is a structure to be filled in only with safe conceptual labels under a future, separately approved process. Completing this template creates no fixture, no database row, and no runtime change.
