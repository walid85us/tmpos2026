# Decision Record — Production Database Direction

> **Status:** **RECOMMENDED / PROVISIONAL** — pending explicit ratification. **This record triggers no migration, creates no schema, and changes no code.** It documents a preferred direction so that subsequent readiness work (auth/repository boundary, data-shape modeling) targets a coherent destination. It may be overridden by a later decision record.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness, Milestone 0. See [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md).

---

## Context

- The app is a **multi-tenant repair/POS/CRM/inventory/shipping SaaS**.
- Today it has **no production database**: Firebase is used only for Auth + a single `users/{uid}` read; all other data is mock/in-memory/browser storage (verified — see M0 §3–§4).
- Future deployment may target **Hostinger**, and the production database is explicitly **undecided** (candidates: continue Firebase/Firestore, PostgreSQL, MySQL, Supabase, Neon, Railway, Hostinger-VPS DB).
- This is therefore closer to a **first-time backend build** than a migration — low data-migration risk, high design leverage.

## Decision (provisional)

**Adopt PostgreSQL as the production database direction, with Supabase as the default managed target.** Design the future data-access boundary so that **Neon / Railway / Hostinger-VPS PostgreSQL remain drop-in alternatives** (same SQL dialect, same repository interfaces).

## Rationale

| Workload need | Why PostgreSQL fits |
|---|---|
| Invoices / POS orders / refunds | Multi-row **ACID transactions** + foreign keys; Firestore cannot transactionally span many entities cleanly. |
| Inventory movements | Append-only ledger + serial tracking → relational integrity. |
| Reporting / analytics | Ad-hoc SQL **joins/aggregations**; Firestore forces denormalization and cannot join. |
| Multi-tenancy + RBAC | `tenant_id` columns + **Row-Level Security (RLS)** give *database-level* tenant isolation — the natural "database rule enforcement" layer for relational data. |
| Audit logs | Append-only tables, partitioning, retention. |
| Server-side enforcement | Pairs with an API/RPC tier + RLS for defense in depth. |
| Hostinger compatibility | App on Hostinger + **managed Postgres (Supabase/Neon)** = no DB ops burden on the host. |

**Why Supabase as the default managed target:** Postgres + Auth (can replace Firebase Auth) + RLS + auto REST/Realtime + Storage in one managed platform — a coherent destination for both the auth-provider swap and the data layer.

## Options considered

| Option | Verdict | Notes |
|---|---|---|
| **Continue Firestore into production** | Not recommended | Weak for relational reporting + cross-entity invoice/inventory transactions; rules awkward for relational access. **Fine to keep for testing.** |
| **PostgreSQL — Supabase (managed)** | **Recommended default** | Postgres + Auth + RLS + Storage; managed; coherent migration target. |
| **PostgreSQL — Neon / Railway (managed)** | Strong alternative | Pure managed Postgres; choose if owning the API/auth layer is preferred. |
| **PostgreSQL/MySQL on Hostinger VPS** | Viable, higher burden | Max control; you own backups/patching/HA. Only if cost/control demands. |
| **MySQL (any host)** | Viable, weaker fit | Postgres has better JSON, RLS, and analytics for this workload. |

## Consequences / what this enables later (not now)

- The future **auth boundary** can target Firebase Auth today and Supabase Auth later behind one interface.
- The future **repository boundary** targets SQL; every durable record carries a mandatory `tenant_id`.
- **DB-rule enforcement** = Postgres RLS (not Firestore rules) if this direction is ratified.
- Internal `user_id` must be **decoupled** from the auth-provider UID to keep the auth swap cheap.

## Explicit non-actions

- **No migration, no schema/DDL, no `.sql` files, no Firebase removal, no Firestore-rules change** are performed or implied by this record.
- Firebase/Firestore **remains in place for testing** until a ratified cutover plan exists.

## Open questions before ratification

1. Confirm Hostinger as the app host and whether a server/API tier (VPS/serverless) is in scope (see topology decision record).
2. Confirm managed (Supabase/Neon) vs self-hosted (VPS) Postgres.
3. Confirm whether Firebase Auth is replaced by the DB-platform auth or retained.
4. Confirm secret-management approach for shipping/provider credentials.
