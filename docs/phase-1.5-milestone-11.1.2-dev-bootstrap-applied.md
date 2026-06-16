# Phase 1.5 M11.1.2 — DEV Bootstrap Seed Applied

**Status:** `APPLIED TO DEV / VERIFIED / PRODUCTION UNTOUCHED`

This is an applied-state documentation record. It records evidence from the
M11.1.2 owner-run DEV bootstrap seed apply. It does **not** itself connect to any
database, run SQL, apply migrations, or seed data.

---

## 1. Git Checkpoint Before Seed

- Branch: `main`
- HEAD: `25ee2e63f553c967348f13500488ca9048ec8f49`
- Commit subject: `Phase 1.5 M11.1.1 document DEV 003 apply`
- Working tree: clean (no source files modified by the seed apply)

---

## 2. Target

Supabase DEV project `tmpos2026-dev`. Production was untouched.

---

## 3. Apply Method

Owner-run Supabase SQL Editor (DEV project only).

---

## 4. Explicit Method Notes

- Replit/Claude did **not** run the seed (no shell/DB-URL execution).
- Supabase MCP was **not** used.
- No source files were modified by the seed apply.
- No seed values, UID, email, token, password, service-role key, DB URL, or JWT
  are recorded in this document.

---

## 5. Pre-Check Evidence (owner-run, read-only, redacted)

| Check | Result |
|---|---|
| `constraint_has_system_owner` | `true` |
| `constraint_has_no_platform_owner` | `true` |
| `identity_match_count` | `1` |
| `selected_internal_user_id_present` | `true` |
| `seed_tenant_exists` | `0` |
| `seed_store_exists` | `0` |
| `app_user_rows` | `0` |
| `tenant_rows` | `0` |
| `store_rows` | `0` |
| `user_membership_rows` | `0` |
| `tenant_feature_entitlement_rows` | `0` |
| `audit_event_rows` | `0` |

Pre-check PASS: canonical role CHECK active, exactly one identity match, durable
tables row-empty, deterministic seed UUIDs absent, `audit_event` baseline 0.

---

## 6. Seed Apply Evidence

- Initial seed apply (owner-run in SQL Editor) **succeeded**.
- Initial post-seed verification:
  - `active_app_user_rows = 1`
  - `active_tenant_rows = 1`
  - `active_store_rows = 1`
  - `platform_system_owner_memberships = 1`
  - `manual_entitlement_rows = 2`
  - `audit_event_rows = 0`
  - `tenant_store_owner_memberships = 0`
  - `store_store_owner_memberships = 0`

---

## 7. Corrective Insert Evidence

- The initial seed created the platform membership but **not** the tenant/store
  memberships (template blocks 4b/4c were not active in the first run).
- The owner ran an **idempotent corrective insert** in the SQL Editor for the
  tenant and store `store_owner` memberships.
- The corrective insert returned: `Success. No rows returned`.
- Rollback was **not** run.

---

## 8. Final Post-Apply Verification Evidence (owner-run, read-only, redacted)

| Check | Result |
|---|---|
| `selected_identity_rows` | `1` |
| `active_app_user_rows` | `1` |
| `active_tenant_rows` | `1` |
| `active_store_rows` | `1` |
| `platform_system_owner_memberships` | `1` |
| `tenant_store_owner_memberships` | `1` |
| `store_store_owner_memberships` | `1` |
| `manual_entitlement_rows` | `2` |
| `audit_event_rows` | `0` |

All final checks match the recommended seed choices.

---

## 9. Current DEV Database State After Seed

- `app_user`: 1 active row for the selected identity.
- `tenant`: 1 active seeded tenant.
- `store`: 1 active seeded store belonging to the seeded tenant.
- `user_membership`: 3 active memberships:
  - platform `system_owner`
  - tenant `store_owner`
  - store `store_owner`
- `tenant_feature_entitlement`: 2 manual enabled rows:
  - `shipping_provider_configuration`
  - `pickup_requests`
- `audit_event`: 0

---

## 10. Explicit Non-Actions

- No production touch.
- No rollback seed run.
- No migrations run.
- No 003 down run.
- No Supabase MCP.
- No frontend/runtime changes.
- `/auth/session/resolve` unchanged and still `authorization: null`.
- No durable audit writer.
- No repository live DB diagnostic.
- No Backend Control Plane.
- No commit/push/backup during seed apply.

---

## 11. Rollback / Failure Note

- The rollback seed (`dev_bootstrap_rollback.example.sql`) exists but must **not**
  be run without explicit owner approval.
- Rollback is DEV-only.
- Rollback must **never** delete `audit_event`.
- `audit_event` remains 0.

---

## 12. Deferred Items

- Applied-state doc commit/backup.
- M11.2 read-only repository/query layer.
- M11.2 live authorization diagnostic.
- Durable audit writer.
- `/auth/session/resolve` runtime wiring.
- Permission/sub-permission materialization.
- Backend Control Plane.
- Production apply.

---

## 13. Recommended Next Step

1. Commit this applied-state documentation record.
2. Backup to GitHub.
3. Then start M11.2 planning for the read-only repository / live authorization
   diagnostic.
