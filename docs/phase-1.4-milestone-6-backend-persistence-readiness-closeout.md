# Phase 1.4 — Milestone 6: Backend & Persistence Readiness Closeout Package

> **Status:** **Documentation / architecture only — phase closeout.** This is the official **Phase 1.4 closeout package**: a single authoritative handoff that consolidates M0–M5 into one readiness document. It **implements nothing**, finalizes nothing by assumption, and changes no runtime, source, UI, schema, config, or dependency. Every table and checklist below is a **documentation artifact only**; nothing is imported or wired into the app.
>
> **It does NOT** implement Supabase / Neon / Railway / Hostinger-VPS PostgreSQL / PostgreSQL; does **not** replace or modify Firebase Auth; creates **no** schema, `.sql`, migration, ORM, RLS policy, repository runtime, middleware, server guard, or API runtime; installs **no** dependency; does **not** touch `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles.
>
> **Reversible** (delete this doc + revert the minimal index/decision-record cross-references and the `replit.md` status line). **Not committed / not pushed / not backed up; awaiting review.**
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. M6 is the **final, closeout milestone**: it does not add new architecture, it consolidates and hands off. Authoritative source artifacts:
> - [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) — enforcement boundary + persistence inventory + Firebase coupling + truthfulness labels
> - [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md) — provider-agnostic auth/repository boundary + adoption order
> - [`phase-1.4-milestone-2-durable-data-shape-domain-model.md`](phase-1.4-milestone-2-durable-data-shape-domain-model.md) — conceptual PostgreSQL-ready domain model + identity strategy
> - [`phase-1.4-domain-model-index.md`](phase-1.4-domain-model-index.md) — compact domain reference
> - [`phase-1.4-milestone-3-request-context-protected-action-contract.md`](phase-1.4-milestone-3-request-context-protected-action-contract.md) — future enforcement contract
> - [`phase-1.4-milestone-4-provider-auth-decision-criteria.md`](phase-1.4-milestone-4-provider-auth-decision-criteria.md) — consolidated criteria + evaluation + recommended working decision
> - [`phase-1.4-milestone-5-provider-finalization-gate.md`](phase-1.4-milestone-5-provider-finalization-gate.md) — provider/auth finalization gate + product-owner inputs
> - [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md) · [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md) — canonical status holders

---

## 1. Purpose and Scope

**Purpose.** Phase 1.4 (Backend & Persistence Readiness) ran as a **documentation/architecture-only readiness phase** across six milestones. M0–M5 established the current truth, the migration boundary, the durable data model, the enforcement contract, the provider/auth criteria, and the finalization gate — **without changing any runtime behavior**. M6 closes the phase: it provides **one authoritative handoff** that summarizes every artifact, restates all ratified and provisional decisions, lists what remains blocked, restates the M5 minimum-evidence package, and names the recommended next path (**Product Owner Input Collection**) before any implementation.

**In scope (docs only):**
- A per-milestone artifact summary (M0–M5).
- Consolidated ratified decisions, provisional decisions, and blocked work.
- The current application truthfulness statement and per-area readiness summaries (persistence, auth, server/API enforcement, audit/evidence).
- The provider decision status and the product-owner input gate summary.
- The M5 minimum-evidence package, restated.
- A copy-ready handoff section for a future session.

**Out of scope (unchanged across all of Phase 1.4):** any implementation — no provider SDKs, no PostgreSQL, no schema/DDL/`.sql`, no ORM (Prisma/Drizzle) files, no migrations, no middleware/guards/server enforcement, no Firebase Auth replacement or logic change, no Firestore-rules change, no UI/routing/source change, no dependency install, no `.replit`/`package.json`/lockfile change. **M6 does not start Product Owner Input Collection and does not start M7.** It only prepares the closeout and handoff.

**Honesty rule (binding):** M6 invents no inputs. Where a product-owner answer (budget, region, RPO/RTO, scale, payment processor, auth direction) does not already exist in the repo/docs, it stays **Open** and the corresponding final decision stays **Provisional**. Supabase remains the **preferred working candidate**, not the final provider.

---

## 2. Phase 1.4 Closeout Status

| Milestone | Title | Status | Checkpoint |
|---|---|---|---|
| M0 | Backend & Persistence Readiness Inventory | COMPLETE / ACCEPTED / BACKED UP | `bb8a735` |
| M1 | Auth / Repository Boundary Plan | COMPLETE / ACCEPTED / BACKED UP | `af3c6ec` |
| M2 | Durable Data-Shape & Domain Model Documentation | COMPLETE / ACCEPTED / BACKED UP | `2b9d8b8` |
| M3 | Request Context + Protected Action Contract + Audit Decision Boundary | COMPLETE / ACCEPTED / BACKED UP | `ed86283` |
| M4 | Provider / Auth Decision Criteria Resolution | COMPLETE / ACCEPTED / BACKED UP | `ab8cbde` |
| M5 | Provider Finalization Gate + Production Readiness Inputs | COMPLETE / ACCEPTED / BACKED UP | `cdd1c03` |
| **M6** | **Backend & Persistence Readiness Closeout Package** | **ACTIVE / PENDING REVIEW** (this doc; not committed/pushed/backed up) | — |

**Latest backed-up checkpoint at the start of M6:** `cdd1c03aae19eebb7a857b62ee2ca4adc5c42c59`.

**Phase verdict:** Phase 1.4 delivered a complete, internally-consistent **readiness package**. It is ready to hand off. **No implementation phase has started; no source/runtime/UI behavior has changed.**

---

## 3. What Phase 1.4 Was Re-Scoped To

Phase 1.4 was **re-scoped** from its earlier "Real Integrations / Automation + Alerts" framing to **Backend & Persistence Readiness** (the integrations work was re-sequenced to Phase 2). The re-scoped phase deliberately produced **only documentation/architecture** — no backend was built. Its job was to make a future backend build **safe, coherent, and unambiguous**: know the current truth (M0), contain the one Firebase coupling and define the migration order (M1), model the durable data shapes (M2), define the future enforcement contract (M3), evaluate providers/auth against decision criteria (M4), and define the finalization gate + product-owner inputs that must precede implementation (M5). M6 closes it out.

---

## 4. Why Runtime Enforcement Was Deferred

1. **No server runtime exists to host it.** The production artifact is a **static SPA** (`.replit` → `deploymentTarget = "static"`). The only server today is a **dev-only Express shipping sidecar** (`server/index.ts`, port 5001, `/api/shipping/*`) with **no user/tenant/auth context** and no Firebase. A custom server-side enforcement tier cannot run where there is no server (topology decision record).
2. **The chosen direction requires a server/API tier (R2).** Real enforcement for this product's permission model needs PostgreSQL RLS behind an API tier — which requires a runtime that does not yet exist. Firestore-rules-from-a-static-SPA is explicitly rejected because this project's 7-level hierarchy + dependency auto-sync + plan-envelope checks are not practically expressible in Firestore rules.
3. **The irreversible inputs are unanswered.** Finalizing a provider/auth and connecting a database is expensive to undo once data and users exist (auth-migration cost rises per real user). The M5 gate holds that commitment until the product owner supplies budget, region/residency, RPO/RTO, and scale.
4. **Correctness over speed.** Building enforcement before the durable data model, the enforcement contract, and the provider/auth gate were settled would have produced rework or confidently-wrong lock-in. Deferring kept the design portable (the M1 boundary).

---

## 5. M0 Artifact Summary — Backend & Persistence Readiness Inventory

- **Authoritative current-truth inventory.** Established the verified picture of today's backend/persistence reality **before** any implementation.
- **Firebase coupling inventory:** the entire Firebase surface is **4 files** (`firebase.ts`, `AccessContext.tsx`, `Login.tsx`, `NotProvisioned.tsx`); **Auth = Google popup + email/password only**; **Firestore = a single `users/{uid}` read, zero writes**; no other collections.
- **Data-domain persistence map:** application data is **mock / in-memory / browser storage** (sessionStorage/localStorage) — **no production database**.
- **DB portability / migration map** and **audit-truthfulness labels** (which "records" are advisory session/browser state vs durable evidence — today, none are durable evidence).
- **Request-context contract + protected-action catalog** seeded (expanded in M3).
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`bb8a735`). No source/runtime/UI change.

## 6. M1 Artifact Summary — Auth / Repository Boundary Plan

- **Provider-agnostic boundary plan.** Defines the interfaces and **adoption order** for a future auth/data-access boundary so the single Firebase coupling is contained and the PostgreSQL direction is reachable **without a big-bang rewrite**.
- **Key rules:** vendor names live **only in adapters**; `internal_user_id` is **decoupled** from the auth-provider UID; Firebase keeps working for testing.
- **Adoption order** culminates (step E) in the first behavior-changing milestone (server/API + Postgres adapters) — explicitly **out of Phase 1.4**.
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`af3c6ec`). No runtime wiring, no new runtime files.

## 7. M2 Artifact Summary — Durable Data-Shape & Domain Model Documentation

- **Conceptual, PostgreSQL-ready, tenant/store/platform-scoped, audit-aware domain model** mapping today's mock/in-memory/browser-storage system into future durable shapes. **Not a schema, not a migration.**
- **Mandatory future columns:** `tenant_id` on every tenant/store record; `store_id` where store isolation matters; `actor_user_id` on auditable writes; `created_at`/`updated_at`; documented status enums; `external_provider`/`external_reference` + `idempotency_key` on external actions; money as `numeric` + `currency`; **no card data**; `internal_user_id` decoupled from `auth_provider_uid`.
- **Companion:** [`phase-1.4-domain-model-index.md`](phase-1.4-domain-model-index.md) — compact per-domain reference (scope, current persistence, future PG group, audit/sensitivity/difficulty, persist-first vs defer order).
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`2b9d8b8`). All SQL-like/TS-like fragments are documentation examples only.

## 8. M3 Artifact Summary — Request Context + Protected Action Contract + Audit Decision Boundary

- **Future, provider-agnostic enforcement contract:** request context shape, protected-action catalog, authorization-decision shape, audit-decision boundary, outcome labels, **preview/demo rules**, and evidence-truthfulness rules.
- **Explicitly NOT** server enforcement, middleware, or authorization logic — a contract documents *what* a future server tier must enforce, not code that enforces it.
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`ed86283`). Nothing wired into the app.

## 9. M4 Artifact Summary — Provider / Auth Decision Criteria Resolution

- **Consolidated, comparable evaluation** of the four PostgreSQL candidates (Supabase / Neon / Railway / Hostinger-VPS) + the Firestore baseline, plus the auth keep/replace/custom options, against cost / region / RPO-RTO / payments-PCI / local-dev / schema-tooling / scale criteria.
- **Recommended working decision:** **Supabase = PREFERRED default working provider candidate (design target)**; **Firebase Auth retained for testing, untouched**; auth-final tied to provider-final.
- **Explicit ratified-vs-provisional split** (final provider + final auth held **provisional** pending product-owner inputs + a backup/restore plan).
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`ab8cbde`). No implementation; all code-like fragments are documentation examples.

## 10. M5 Artifact Summary — Provider Finalization Gate + Production Readiness Inputs

- **The decision gate** that must be satisfied before any backend/provider/auth implementation begins. Defines: the **product-owner input checklist** (24 inputs, I1–I24, all Open); per-dimension gates (backup/RPO-RTO, region/residency, cost, scale, payments/PCI, local-dev, schema-tooling, security/secrets, preview/demo, Hostinger/deployment); per-provider go/no-go (Supabase / Neon / Railway / Hostinger-VPS); per-auth go/no-go (Firebase retained / Supabase Auth replacement / custom); **minimum evidence package**; **start conditions**; **blocked-work list**; a **decision-intake template**; and decision-record update instructions.
- **Finalizes nothing by assumption.** Any missing blocking input keeps provider/auth provisional; Supabase stays preferred-not-final.
- **Status:** COMPLETE / ACCEPTED / BACKED UP (`cdd1c03`). Docs only.

---

## 11. Consolidated Ratified Decisions

| # | Ratified decision | Primary source |
|---|---|---|
| R1 | **PostgreSQL is the working production database direction.** | [DB record](phase-1.4-decision-record-production-database.md) |
| R2 | **A future server/API tier (managed API layer, serverless/edge, or VPS) — or equivalent managed backend enforcement layer — is required for any real server-side enforcement.** | [Topology record](phase-1.4-decision-record-deployment-topology.md) |
| R3 | **A Firestore-only production path is NOT recommended** for this product's future relational / POS / RBAC / reporting needs (weak fit for joins, ad-hoc aggregation, relational constraints; the 7-level permission model is not practically expressible in Firestore rules). **Firestore/Firebase remains fine for testing.** | DB record §"Options considered" |
| R4 | **The M1 provider-agnostic auth/repository boundary remains the migration strategy** — vendor names live only in adapters; no big-bang rewrite. | [M1](phase-1.4-milestone-1-auth-repository-boundary-plan.md) |
| R5 | **`internal_user_id` is the stable, app-owned user identity** (primary key on app records). | [M1](phase-1.4-milestone-1-auth-repository-boundary-plan.md)/[M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md) |
| R6 | **External auth UIDs must remain external references, never primary app user IDs** (`auth_provider`/`auth_provider_uid` are reference columns). | [M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md)/[M4](phase-1.4-milestone-4-provider-auth-decision-criteria.md) |
| R7 | **No card data is stored in the app database.** | [M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md) §payments |
| R8 | **An external payment processor handles card data**; the app stores only references/status/amount/currency/timestamps/links/audit metadata. | [M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md)/[M4 §9](phase-1.4-milestone-4-provider-auth-decision-criteria.md) |
| R9 | **Browser / session / local storage is NOT acceptable for production business records** — these are advisory mirrors, never durable evidence. | [M0](phase-1.4-milestone-0-backend-persistence-readiness.md)/[M3](phase-1.4-milestone-3-request-context-protected-action-contract.md) |
| R10 | **Current audit/governance records are advisory only** unless and until persisted by a trusted server/backend path. | [M0](phase-1.4-milestone-0-backend-persistence-readiness.md)/[M3](phase-1.4-milestone-3-request-context-protected-action-contract.md) |
| R11 | **Supabase is the PREFERRED working candidate / design target — but NOT the final, locked provider.** | [M4 §19–§20](phase-1.4-milestone-4-provider-auth-decision-criteria.md) |

M6 does not re-open or escalate any of R1–R11.

---

## 12. Consolidated Provisional Decisions

| # | Provisional decision | Resolved by |
|---|---|---|
| P1 | **Final database / provider selection** (Supabase vs Neon vs Railway vs Hostinger-VPS) | M5 gate §17–§20 + inputs |
| P2 | **Final auth provider** (keep Firebase vs Supabase Auth vs custom) | M5 gate §22–§23 |
| P3 | **Supabase Auth replacement timing** (before production users, if Supabase is final) | M5 §23 |
| P4 | **Firebase Auth long-term retention vs replacement** | M5 §22 |
| P5 | **Exact backend / API runtime** (VPS vs serverless/edge) | Topology record criteria |
| P6 | **Hostinger role** — static-only vs also backend/API (input I18) | M5 §16; topology record |
| P7 | **Production database region** | M5 §8 (input I3) |
| P8 | **Legal / data-residency requirements** | M5 §8 (input I4) |
| P9 | **Budget band + acceptable monthly infrastructure range** | M5 §9 (inputs I5/I6) |
| P10 | **RPO / RTO + backup retention** | M5 §7 (inputs I12/I13/I14) |
| P11 | **Local dev / test strategy** | M5 §11 (input I22) |
| P12 | **Schema migration tooling / ORM choice** | M5 §12 (input I23) |
| P13 | **Payment processor** | M5 §12-payments (input I16) |
| P14 | **Production scale envelope** (tenants/stores/users/transactions/attachments) | M5 §10 (inputs I7–I11) |
| P15 | **Secrets / rotation / monitoring details** | M5 §13 |
| P16 | **First implementation slice** | M5 §24–§25 |

**All P1–P16 remain Open/Provisional.** No product-owner input answering them exists in the repo/docs as of this closeout.

---

## 13. Consolidated Blocked Work

The following remain **BLOCKED** until the M5 gate / Product Owner Input Collection is complete and accepted, **and** a behavior-changing milestone is explicitly authorized:

- [ ] Provider SDK installation (Supabase/Neon/Railway/Postgres client libs)
- [ ] Schema creation
- [ ] SQL migrations
- [ ] ORM setup (Prisma/Drizzle/etc.)
- [ ] Production DB connection
- [ ] Supabase / Auth migration
- [ ] Firebase Auth replacement
- [ ] Server enforcement (middleware, guards, RLS-as-enforcement)
- [ ] Repository runtime implementation
- [ ] Middleware / guards
- [ ] RLS policies
- [ ] Real audit persistence (durable audit writes)
- [ ] Provider secret persistence (durable secret storage)
- [ ] Payment integration
- [ ] **Any behavior-changing backend / provider / auth implementation**

M6 starts none of these and unblocks none of them.

---

## 14. Current Application Truthfulness Statement

- Phase 1.4 is a **readiness / architecture / documentation phase, not an implementation phase**.
- **No source / runtime / UI behavior changed in M0–M5** (or in M6).
- **No production backend was created.**
- **No server-side authorization was implemented.**
- **No PostgreSQL database was connected.**
- **No provider SDK was installed.**
- **No Supabase / Neon / Railway / Hostinger-VPS database was implemented.**
- **No Firebase Auth replacement was implemented**; Firebase Auth logic is untouched.
- **No schema, SQL migration, ORM, RLS policy, repository runtime, middleware, server guard, or API runtime was implemented.**
- The **current app remains a front-end / static SPA prototype** with the existing dev-sidecar limitations already documented (dev-only Express shipping server, in-memory ephemeral provider credentials, no auth/tenant context).
- **Current advisory / session / browser-state governance and audit is NOT production compliance evidence.**
- **Future production evidence requires durable, server-written records.**
- **Preview / demo mode must remain separate from production records** (M3/M5).
- **Product Owner Input Collection must happen before any provider/auth implementation.**

---

## 15. Persistence Readiness Summary

- **Today:** no production database. Application data is mock / in-memory / browser storage; the only Firestore use is a single `users/{uid}` read. Browser/session/local storage is advisory, never durable evidence (R9).
- **Ready:** a conceptual, PostgreSQL-ready, tenant/store/platform-scoped domain model (M2) with mandatory columns and a per-domain index; a portability/migration map and persist-first vs defer ordering (M0/M2).
- **Not done:** no schema, no migration, no connection, no ORM. Blocked until the gate (§13).

## 16. Auth Readiness Summary

- **Today:** Firebase Auth (Google popup + email/password), one Firestore read, zero writes; **untouched** through Phase 1.4. Small surface (4 files) → cheap swap **if done before real users accrue**.
- **Ready:** provider-agnostic auth boundary (M1); identity strategy (`internal_user_id` primary; vendor UID external reference — R5/R6); per-auth go/no-go criteria (M5 §22–§23).
- **Provisional:** keep Firebase vs adopt Supabase Auth vs custom (P2–P4), tied to the final provider and the "before production users" timing.

## 17. Server / API Enforcement Readiness Summary

- **Today:** static-SPA production artifact; dev-only shipping sidecar with no auth/tenant context. **No server-side enforcement possible** in the current topology.
- **Ratified:** a future server/API tier (managed API / serverless/edge / VPS) is required (R2).
- **Ready:** the future enforcement contract — request context, protected-action catalog, authorization-decision shape (M3).
- **Provisional:** the specific runtime (P5) and Hostinger's role (P6). **Blocked:** middleware, guards, RLS policies, repository runtime (§13).

## 18. Audit / Evidence Readiness Summary

- **Today:** audit/governance signals are derived from current app/session state and stored as **advisory** session/browser overlays — explicitly **not** compliance evidence, immutable, or legal-grade (R10; M0/M3 truthfulness labels; replit.md locked rules).
- **Ready:** the audit-decision boundary, outcome labels, evidence-truthfulness rules, and append-only audit shape (M2/M3).
- **Required for production:** durable, server-written audit records behind the future API tier. **Blocked** until the gate (§13).

---

## 19. Provider Decision Status

| Candidate | M4 status | Gate disposition |
|---|---|---|
| **Supabase** | **PREFERRED** default working candidate / design target | Final only after M5 §17 go-criteria met + inputs answered + backup/restore plan; **not finalized** |
| **Neon** | Acceptable fallback (provider-neutral + retain Firebase Auth) | Per M5 §18 go/no-go |
| **Railway** | Acceptable fallback (combined app/API + Postgres) | Per M5 §19 go/no-go |
| **Hostinger-VPS PostgreSQL** | Acceptable-with-caveats / **not preferred** for financial data | Per M5 §20; immediate no-go if managed backups required |
| **Firestore (continue)** | **Testing only / not recommended** for production | Reaffirmed (R3) |

**Auth:** Firebase Auth retained (now, for testing) — long-term retention vs Supabase Auth replacement vs custom all **provisional** (P2–P4), tied to the final provider.

**Bottom line:** the final provider and final auth are **PROVISIONAL until the M5 gate inputs are answered and accepted.** Supabase remains preferred-not-final.

---

## 20. Product Owner Input Gate Summary

The M5 §5 checklist (24 inputs, **all Open**) groups as:

| Group | Inputs (M5 IDs) |
|---|---|
| Launch & rollout expectations | I1 |
| Tenant geography & data residency | I2, I4 |
| Region / latency preference | I3 |
| Budget / cost band | I5, I6 |
| Expected scale envelope | I7, I8, I9, I10, I11 |
| RPO / RTO / backup retention | I12, I13, I14 |
| Managed backup requirement | I15 |
| Payment processor & no-card-data confirmation | I16, I17 |
| Hostinger / Replit deployment role | I18, I19 |
| Auth direction: Firebase retained vs Supabase Auth replacement | I20, I21 |
| Local dev / test preference | I22 |
| Schema migration / tooling preference | I23 |
| Compliance / audit retention expectation | I24 |

**Statements:**
- **These inputs are NOT answered in M6.**
- **M6 only prepares the closeout and handoff.**
- **Product Owner Input Collection (the recommended next step) should collect these inputs next**, recorded via the M5 §27 decision-intake template.

---

## 21. Minimum Evidence Package Before Implementation

Restated from M5 §24–§25. A backend implementation milestone may begin **only when all of the following exist and are recorded**:

- [ ] Final provider decision record updated
- [ ] Final auth decision recorded (in, or alongside, the provider record)
- [ ] M5 input checklist (§5) answered — no blocking input left Open
- [ ] Backup / restore plan documented (frequency, retention, restore drill, PITR, ownership, monitoring, export path)
- [ ] RPO / RTO accepted
- [ ] Region / residency accepted
- [ ] Budget band accepted
- [ ] Payment / no-card-data boundary accepted
- [ ] Local dev / test approach chosen
- [ ] Schema migration tooling chosen or scheduled before schema
- [ ] Security / secrets approach documented
- [ ] Preview / demo handling documented
- [ ] First implementation slice selected
- [ ] Allowed / forbidden file scope documented
- [ ] Rollback / migration plan documented
- [ ] Manual QA plan documented
- [ ] Behavior-changing risk explicitly accepted

Until every box is checked, Phase 1.4 readiness holds and implementation may not begin.

---

## 22. Recommended Next Step: Product Owner Input Collection

**Recommended path: Product Owner Input Collection (a documentation step), before any implementation.**

1. Collect the M5 §5 inputs (the §20 groups above) from the product owner.
2. Record them using the **M5 §27 decision-intake template** in the [DB decision record](phase-1.4-decision-record-production-database.md) (and the topology record where the runtime/Hostinger role is decided).
3. Run the per-provider and per-auth go/no-go (M5 §17–§23) against the collected inputs.
4. Only if a provider's go-criteria are met with no no-go tripped, **and** a backup/restore plan meets the ratified RPO/RTO, update the decision-record status from "preferred working candidate / provisional" to the ratified choice (M5 §28). **Do not escalate by assumption.**
5. Assemble the §21 minimum-evidence package and select the first implementation slice.
6. **Only then** may a new, separately-accepted, behavior-changing implementation milestone begin.

**M6 does not perform step 1.** It hands off to it.

---

## 23. Explicit Non-Implementation Statement

M6 **changes no runtime, source, UI, schema, config, or dependency.** It does **not** implement Supabase, Neon, Railway, Hostinger-VPS Postgres, or PostgreSQL; does **not** replace or modify Firebase Auth; creates **no** schema, SQL migration, ORM, RLS policy, repository runtime, middleware, server guard, or API runtime; installs **no** dependency; persists **no** audit or secret; integrates **no** payment. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. It does **not** start Product Owner Input Collection and does **not** start M7. All tables and checklists are documentation artifacts. The milestone is **reversible** (delete this doc + revert the minimal index/decision-record cross-references and the `replit.md` status line). **Not committed / not pushed / not backed up; awaiting review.**

---

## 24. Future Implementation Preconditions

Before the first behavior-changing backend milestone (out of Phase 1.4):

1. **M5 gate satisfied** (§13/§21) — inputs answered, plan documented, go/no-go passed.
2. **First implementation slice selected** — single, smallest behavior-changing increment (typically M1 adoption-order step E: server/API + first Postgres adapter).
3. **Allowed/forbidden file scope documented** for that slice.
4. **Migration / rollback plan documented.**
5. **Clean backup checkpoint** on `main` as the rollback point.
6. **Manual QA plan documented** (the behavior change is observable and checkable).
7. **Behavior-changing risk explicitly accepted** by the product owner.

---

## 25. Handoff Summary for Future Session

> **Copy-ready.** Paste this into a new chat to resume with full context.

```
PROJECT: tmpos2026 — multi-tenant repair/POS/CRM/inventory/shipping SaaS (React 19 + Vite static SPA;
         Firebase Auth + single users/{uid} read; dev-only Express shipping sidecar; no production DB).

PHASE 1.4 — Backend & Persistence Readiness: CLOSED OUT (docs/architecture only; no runtime change).

LATEST BACKED-UP CHECKPOINT (start of M6): cdd1c03aae19eebb7a857b62ee2ca4adc5c42c59
COMPLETED & BACKED UP:
  M0 bb8a735  Readiness Inventory (current truth, Firebase coupling, persistence map, truthfulness labels)
  M1 af3c6ec  Auth/Repository Boundary Plan (provider-agnostic; adoption order)
  M2 2b9d8b8  Durable Data-Shape & Domain Model (conceptual PG-ready; + domain-model-index)
  M3 ed86283  Request Context + Protected Action Contract + Audit Decision Boundary
  M4 ab8cbde  Provider/Auth Decision Criteria Resolution (Supabase preferred; Firebase Auth for testing)
  M5 cdd1c03  Provider Finalization Gate + Production Readiness Inputs (24-input checklist; go/no-go)
  M6 (this)   Backend & Persistence Readiness Closeout Package — ACTIVE/PENDING REVIEW

RATIFIED: PostgreSQL = working DB direction; future server/API tier required for real enforcement;
  Firestore-only production not recommended (testing OK); M1 provider-agnostic boundary = migration
  strategy; internal_user_id = stable app identity; auth UIDs stay external references; no card data in
  app DB; external payment processor; browser/session storage not acceptable for prod records; current
  audit/governance advisory-only until server-persisted; Supabase = PREFERRED working candidate (NOT final).

PROVISIONAL (all Open): final provider; final auth; Supabase-Auth timing; Firebase retain vs replace;
  backend/API runtime; Hostinger static-only vs +API; DB region; data residency; budget band/monthly range;
  RPO/RTO + retention; local dev/test; schema tooling/ORM; payment processor; scale envelope; secrets/
  rotation/monitoring; first implementation slice.

BLOCKED until M5 gate + Product Owner Input Collection accepted: provider SDK install, schema, SQL
  migrations, ORM, prod DB connection, Supabase/Auth migration, Firebase Auth replacement, server
  enforcement, repository runtime, middleware/guards, RLS, real audit persistence, secret persistence,
  payment integration, ANY behavior-changing backend/provider/auth work.

NEXT RECOMMENDED STEP: Product Owner Input Collection (docs step) — collect M5 §5 inputs, record via the
  M5 §27 intake template, run go/no-go, assemble §21 evidence package, then select first implementation slice.

WARNING: DO NOT begin any backend/provider/auth implementation until the M5 gate inputs are answered AND
  accepted, the minimum-evidence package exists, and a behavior-changing milestone is explicitly authorized.
  Final provider/auth must NOT be escalated by assumption; Supabase stays preferred-not-final.
```

---

## 26. Validation / QA Summary

- **Docs/architecture only** — no behavioral QA applies; review is the gate.
- **M6 changed only Markdown** under `docs/` (this closeout file + minimal cross-references) and one factual `replit.md` status block. No `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package.json`/lockfile changes; nothing imported or wired.
- **TypeScript / lint:** M6 touches no TypeScript; any pre-existing baseline errors are unchanged and none are introduced by M6 (validation command output recorded in the M6 report).
- **Exit criteria:** M0–M5 summarized (§5–§10); ratified + provisional + blocked consolidated (§11–§13); current truthfulness statement (§14); per-area readiness (§15–§18); provider decision status (§19); product-owner input gate (§20); minimum-evidence package (§21); recommended next step = Product Owner Input Collection (§22); explicit non-implementation (§23); future preconditions (§24); copy-ready handoff (§25). Final provider/auth kept honestly provisional; Supabase preferred-not-final.
</content>
