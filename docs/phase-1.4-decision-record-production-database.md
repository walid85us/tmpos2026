# Decision Record — Production Database Direction

> **Status:** **RATIFIED — WORKING DIRECTION (PostgreSQL).** The *direction* (PostgreSQL as the production database) is accepted as the working direction. The **specific managed provider** (Supabase vs Neon / Railway / Hostinger-VPS PostgreSQL) and the **final auth-provider choice** remain **PROVISIONAL** pending the decision criteria in §"Decision criteria" below. **This record still triggers no migration, creates no schema, and changes no code.** It documents the working direction so subsequent readiness work (auth/repository boundary, data-shape modeling) targets a coherent destination.
>
> **Ratified:** 2026-06-12 (Phase 1.4 Decision Ratification Review). **Supersedes** the earlier "RECOMMENDED / PROVISIONAL" status for the PostgreSQL direction only; provider + auth remain provisional.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness, Milestone 0 (record) / Milestone 1 (this ratification + criteria) / **Milestone 4 (decision-criteria resolution — see [`phase-1.4-milestone-4-provider-auth-decision-criteria.md`](phase-1.4-milestone-4-provider-auth-decision-criteria.md))**. See also [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) and [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md).
>
> **M4 update (2026-06-12, accepted/backed up):** The criteria in §"Decision criteria" are now evaluated against every candidate in [M4](phase-1.4-milestone-4-provider-auth-decision-criteria.md). **Supabase is confirmed as the PREFERRED default *working* provider candidate (design target), but is NOT promoted to the final provider** — final provider + final auth stay **PROVISIONAL** pending product-owner inputs (budget band, region/residency, RPO/RTO, scale envelope) and a provider backup/restore plan. No status here is escalated.
>
> **M5 update (2026-06-12, pending review):** [M5 — Provider Finalization Gate](phase-1.4-milestone-5-provider-finalization-gate.md) defines the **decision gate** that must be satisfied before this status may be escalated. **The final provider and final auth remain PROVISIONAL until the M5 gate is satisfied:** the product-owner input checklist (M5 §5) must be answered, a written backup/restore plan must meet a ratified RPO/RTO, region/residency + budget band + scale envelope must be accepted, and the matching per-provider go/no-go criteria (M5 §17–§23) must pass. **Supabase remains the preferred working candidate, not the final provider.** **No backend implementation may begin before the M5 gate inputs are answered** (M5 §24–§26). To finalize later, record the M5 §27 intake template here and follow M5 §28; do not escalate this status by assumption.

---

## Context

- The app is a **multi-tenant repair/POS/CRM/inventory/shipping SaaS**.
- Today it has **no production database**: Firebase is used only for Auth + a single `users/{uid}` read; all other data is mock/in-memory/browser storage (verified — see M0 §3–§4).
- Future deployment may target **Hostinger**, and the production database is explicitly **undecided** (candidates: continue Firebase/Firestore, PostgreSQL, MySQL, Supabase, Neon, Railway, Hostinger-VPS DB).
- This is therefore closer to a **first-time backend build** than a migration — low data-migration risk, high design leverage.

## Decision

**Adopt PostgreSQL as the production database direction (ratified working direction), with Supabase as the default managed target (provisional).** Design the future data-access boundary so that **Neon / Railway / Hostinger-VPS PostgreSQL remain drop-in alternatives** (same SQL dialect, same repository interfaces).

## Rationale

| Workload need | Why PostgreSQL fits |
|---|---|
| Invoices / POS orders / refunds | Foreign keys, uniqueness constraints, and joins for relational financial records. *(Note: Firestore does support multi-document transactions up to a per-transaction limit; the real gap is the lack of joins, relational constraints, and ad-hoc aggregation — not transactions per se.)* |
| Inventory movements | Append-only ledger + serial tracking → relational integrity. |
| Reporting / analytics | Ad-hoc SQL **joins/aggregations**; Firestore forces denormalization and cannot join. |
| Multi-tenancy + RBAC | `tenant_id` columns + **Row-Level Security (RLS)** give *database-level* tenant isolation — the natural "database rule enforcement" layer for relational data. This project's permission model (7-level hierarchy, dependency auto-sync, plan-envelope checks) is **not practically expressible in Firestore security rules**. |
| Audit logs | Append-only tables, partitioning, retention. |
| Server-side enforcement | Pairs with an API/RPC tier + RLS for defense in depth. |
| Hostinger compatibility | App on Hostinger + **managed Postgres (Supabase/Neon)** = no DB ops burden on the host. |

**Why Supabase as the default managed target:** Postgres + Auth (can replace Firebase Auth) + RLS + auto REST/Realtime + Storage in one managed platform — a coherent destination for both the auth-provider swap and the data layer.

## Options considered

| Option | Verdict | Notes |
|---|---|---|
| **Continue Firestore into production** | Not recommended | Weak fit for joins, ad-hoc aggregation, and relational constraints; this project's complex permission model is not practically expressible in Firestore security rules. **Fine to keep for testing.** |
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

## Decision criteria (resolve before the provider + auth choices are finalized)

The PostgreSQL *direction* is ratified. The *provider* (Supabase vs Neon/Railway/VPS) and *auth provider* (keep Firebase Auth vs adopt Supabase Auth) stay provisional until the following are recorded. Most are one-line answers from the product owner, not research tasks.

| # | Criterion | Why it matters | Status |
|---|---|---|---|
| 1 | **Cost model** | Free-tier limits vs expected usage; at what tenant count pricing flips; VPS cost vs managed. Drives Supabase/Neon/Railway/VPS choice. | Open |
| 2 | **Region / data residency** | Tenant/store locations; latency from the app host's region to the DB region; any legal residency requirement. | Open |
| 3 | **Backup & restore / RPO / RTO** | A POS/invoice system must state tolerable data-loss window + recovery time. Strongest argument against self-hosting the DB on a VPS. | Open |
| 4 | **Firebase Auth user-migration path** | Auth swap is ~free today (Google popup + email/password only; no real users) and gets costlier with every real user added. Decide keep-vs-replace before a user base accrues. | Open |
| 5 | **Payments / PCI posture** | POS implies card payments eventually; assume an external processor (keeps card data out of the DB) — but record the assumption, as it shapes schema + compliance scope. | Open |
| 6 | **Local dev / test story** | How developers run the stack: Supabase CLI local, Docker Postgres, or a cloud dev project. | Open |
| 7 | **Schema-migration tooling expectation** | SQL migration files vs an ORM/migration framework. Deferrable, but set the expectation so later milestones don't improvise. | Open |
| 8 | **Expected scale envelope** | Even an order-of-magnitude guess (≈10 vs ≈1,000 tenants) to sanity-check the managed-tier choice. | Open |
| 9 | **Secret-management approach** | Where shipping/provider credentials live in production (currently in-memory, dev-only). | Open |

**Confirm also:** Hostinger as the app host and whether a server/API tier (VPS/serverless) is in scope — see the [deployment-topology decision record](phase-1.4-decision-record-deployment-topology.md).

**Status of these criteria after M4:** all are now **evaluated qualitatively** against Supabase / Neon / Railway / Hostinger-VPS in [M4 §13–§18](phase-1.4-milestone-4-provider-auth-decision-criteria.md#13-supabase-evaluation). Criteria #1 (cost band), #2 (region/residency), #3 (RPO/RTO targets), and #8 (scale envelope) remain **Open — product-owner inputs** required before the final provider/auth ratification. M4 records the recommended working decision (Supabase preferred; Firebase Auth for testing; auth-final tied to provider-final) without locking the final choice.
