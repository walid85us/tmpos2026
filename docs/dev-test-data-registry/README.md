# DEV Test-Data Registry Template Package

## Purpose

This package contains blank, documentation-only templates and checklists for a future DEV test-data registry. It exists to structure safe, redacted governance metadata for prospective, clearly-marked synthetic DEV-only platform_identity fixtures — including a future Controlled Pair A — without ever holding real data, secrets, or raw identifiers. These are templates only: they are not a registry, not registry entries, and not a fixture.

## C1 Documentation-Only Boundary

This package is part of the Option C1 path (documentation-only registry and manual owner-approved DEV fixture process). It is strictly documentation. It introduces no executable code, no SQL, no database connection, no runtime tool, no route, no API endpoint, no UI component, and no Backend Control Plane write control. It creates no real registry entry and no fixture.

## What Each Template / Checklist Is For

- `templates/dev-test-data-registry-template.md` — the top-level registry index structure: purpose, scope, lifecycle vocabulary, safe aggregate-only summary fields, governance notes, and forbidden-content rule.
- `templates/dev-test-data-registry-entry-template.md` — a single blank record for one prospective synthetic fixture, using only safe conceptual fields, with explicit forbidden fields.
- `checklists/owner-approval-checklist-template.md` — owner approval items for a prospective fixture.
- `checklists/reviewer-checklist-template.md` — independent reviewer items, including separation-of-duties and redaction review.
- `checklists/lifecycle-state-checklist-template.md` — the lifecycle state model and per-state requirements.
- `checklists/redacted-evidence-checklist-template.md` — aggregate-only, redacted evidence items (yes/no).
- `checklists/cleanup-disable-checklist-template.md` — cleanup, disable, and rollback planning items.
- `checklists/stop-condition-checklist-template.md` — stop conditions that halt any prospective work.

## Prohibited Use

These templates must never be used to record raw Firebase UID, raw Supabase UID, raw provider UID, raw internal_user_id, emails, tokens, keys, secrets, DB URLs, request/response bodies, raw rows, real customer/tenant/store names, real domains, real IPs, actor UUIDs, request IDs, or raw payloads. They must never be wired into runtime, routes, API, or UI. They must never be used to perform a database write.

## No DB / No SQL / No Runtime / No UI/API

Using or completing these templates performs no database connection, no SQL, no DDL, no migration, no runtime change, and no UI/API change. The templates are inert documentation.

## No Fixture / No Registry Entry

This package creates no fixture and no real registry entry. A completed entry remains a documentation-only governance record; it does not itself create a synthetic anchor, a provider reference, or any database row.

## Future Path

The intended forward sequence is strictly gated, one approved step at a time:

1. C1 template use (documentation-only): a prospective fixture is described using the entry template and reviewed via the checklists.
2. Future fixture authorization: a separate owner-approved authorization gate (re-running the role the fixture provisioning authorization gate played, with all required approval and safety signals present) decides whether a future fixture may be provisioned.
3. Future fixture execution: only on a future authorization decision, a separate execution milestone may provision one clearly-marked synthetic DEV-only internal anchor and two synthetic provider references mapped to it, with aggregate-only redacted evidence and rollback/cleanup.
4. Future M20.17C re-attempt: only after a synthetic fixture exists and a future read-only aggregate check shows an eligible Controlled Pair A, and only after the re-attempt authorization gates pass, may a controlled DB exercise be requested.

## Status Notes

M20.22-OptionC1 creates blank documentation templates/checklists only. No real registry entries were created. No fixture was created. No DB connection occurred. No SQL was run. No rows were inserted. No runtime behavior changed. Future fixture provisioning requires separate approval. M20.17C remains blocked until a valid Controlled Pair A exists and re-attempt gates pass. Production remains blocked. Identity-link runtime wiring remains absent. The Backend Control Plane remains read-only/mock-only.
