# Phase 1.4 — Milestone 4: Provider / Auth Decision Criteria Resolution

> **Status:** **Documentation / architecture only.** This milestone **resolves and records decision criteria** for the remaining backend provider and auth-provider questions so future work has a clearer direction. **It implements nothing.** No Supabase/Neon/Railway/VPS/PostgreSQL implementation, no Firebase Auth change, no schema, no `.sql`, no ORM files, no middleware, no server guards, no dependency installs, no runtime wiring. Every code-like fragment below is a **documentation example only**; nothing is imported or wired into the app.
>
> **Reversible** (delete this doc + revert the minimal decision-record cross-references and the `replit.md` status line). **Accepted / committed / backed up** at GitHub checkpoint `ab8cbdecfaec21f3603798ef89279e84e7125970`; Phase 1.4 is consolidated and closed out in [M6](phase-1.4-milestone-6-backend-persistence-readiness-closeout.md).
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. Builds on and consolidates the open *decision criteria* recorded in M0–M3 and the two decision records. See:
> - [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) (enforcement boundary + persistence inventory)
> - [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md) (provider-agnostic auth/repository boundary)
> - [`phase-1.4-milestone-2-durable-data-shape-domain-model.md`](phase-1.4-milestone-2-durable-data-shape-domain-model.md) (durable data shapes + identity strategy)
> - [`phase-1.4-milestone-3-request-context-protected-action-contract.md`](phase-1.4-milestone-3-request-context-protected-action-contract.md) (enforcement contract)
> - [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md)
> - [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md)

---

## 1. Purpose and Scope

**Purpose.** M0–M3 ratified two *directions* (PostgreSQL; a future server/API enforcement tier) but deliberately left the **specific database provider** and the **final auth provider** PROVISIONAL, with a list of open decision criteria scattered across the two decision records. M4 **gathers those criteria into one place, evaluates each candidate against them, and records a recommended working decision** — distinguishing clearly what is safe to ratify now from what must stay provisional until the product owner supplies the last inputs (cost ceiling, region, RPO/RTO, scale).

**In scope (docs only):**
- Consolidated, comparable evaluation of the four PostgreSQL candidates (Supabase, Neon, Railway, Hostinger VPS) plus the "continue Firestore" baseline.
- Auth-provider evaluation (keep Firebase Auth for testing / keep long-term with Postgres / replace with Supabase Auth / custom auth).
- Qualitative assumptions for cost, region/residency/latency, backup/RPO/RTO, payments/PCI, local dev/test, schema tooling, and scale.
- A **recommended working decision** and an explicit ratified-vs-provisional split.
- Cross-references the two decision records (which already hold the canonical status lines).

**Out of scope (unchanged from M1–M3):** any implementation — no provider SDKs, no PostgreSQL, no schema/DDL/`.sql`, no ORM (Prisma/Drizzle) files, no migrations, no middleware/guards/server enforcement, no Firebase Auth replacement or logic change, no Firestore-rules change, no UI/routing/source change, no dependency install, no `.replit`/`package.json`/lockfile change. Those remain future, separately-accepted milestones.

**Method note on cost.** No exact pricing is asserted. The repo/docs contain no negotiated pricing, so all cost statements below are **qualitative categories** (lower / moderate / higher / variable) and an explicit "re-price before go-live" gate. Where a number would be needed (e.g. the tenant count at which a managed tier flips price band), it is flagged as a product-owner input, not guessed.

---

## 2. Current Ratified Decisions (inherited — not re-opened by M4)

| # | Ratified decision | Source record |
|---|---|---|
| R1 | **PostgreSQL is the working production database direction.** | [DB decision record](phase-1.4-decision-record-production-database.md) |
| R2 | **A future server/API tier (managed API layer, serverless/edge, or VPS) — or equivalent backend enforcement layer — is required for any real server-side enforcement.** | [Topology decision record](phase-1.4-decision-record-deployment-topology.md) |
| R3 | **Continuing Firestore as the primary production database is *not recommended*** (weak fit for joins, ad-hoc aggregation, relational constraints, and this project's permission model). Firestore/Firebase **remains fine for testing**. | DB record §"Options considered" |
| R4 | **The auth + repository boundary stays provider-agnostic** (M1): vendor names live only in adapters; `internal_user_id` is decoupled from the auth-provider UID. | [M1](phase-1.4-milestone-1-auth-repository-boundary-plan.md) |
| R5 | **No card data in the application database**; payments via an external processor; app stores references/status/amount/currency/timestamps/links/audit only. | [M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md) §payments |

M4 does **not** re-litigate R1–R5. It builds on them.

---

## 3. Current Provisional Decisions (the questions M4 addresses)

| # | Provisional question | M4 disposition (summary; detail in §19–§21) |
|---|---|---|
| P1 | Which PostgreSQL provider — Supabase / Neon / Railway / Hostinger VPS? | **Supabase = ratified *default working* candidate (preferred); final provider stays provisional** pending cost/region/RPO-RTO/scale inputs. |
| P2 | Keep Firebase Auth, or plan a Supabase Auth replacement? | **Keep Firebase Auth for testing now.** **If Supabase is the final provider, plan Supabase Auth migration before real production users.** If Neon/Railway/VPS is final, Firebase Auth may remain viable. Final auth stays provisional. |
| P3 | The supporting assumptions (cost, region, RPO/RTO, payments/PCI, local dev/test, schema tooling, scale). | Recorded qualitatively in §6–§12; several require one-line product-owner inputs before final ratification. |

**Framing that keeps this honest:** "ratify Supabase as the **default working option**" ≠ "lock Supabase as the final provider." The former is already true in the DB record ("default managed target (provisional)") and M4 *confirms* it as the **preferred** candidate so design and the future first adapter target a single coherent destination. The latter (irreversible vendor lock) waits for the remaining inputs.

---

## 4. Provider Decision Criteria

The criteria below are the union of the open items in the two decision records, applied uniformly to every candidate in §13–§16. Each candidate is scored qualitatively against them.

| Criterion | What "good" looks like for this project |
|---|---|
| Multi-tenant SaaS suitability | Native support for `tenant_id` isolation; a credible path to **database-level** isolation (RLS). |
| POS/invoice/inventory transactional fit | ACID, foreign keys, uniqueness constraints, joins, ledger/append-only patterns. |
| RBAC + future RLS / server enforcement fit | Postgres RLS available and pairs with an API tier; 7-level hierarchy + dependency sync expressible via app/RLS, not vendor rules. |
| Reporting / analytics fit | Ad-hoc SQL joins/aggregations without forced denormalization. |
| Backup / restore maturity | Managed, automated, point-in-time-ish restore; low-effort recovery. |
| Operational burden | Who patches, backs up, scales, monitors — app team or provider. |
| Cost risk (qualitative) | Predictable; clear free→paid transition; no surprise egress/compute spikes. |
| Region / latency / residency | Region selectable near tenants + app host; supports any future legal residency need. |
| Local dev / test story | A realistic way to run the same engine locally or in a cheap cloud dev project. |
| Auth integration | Either a bundled auth (Supabase) or a clean way to keep Firebase Auth with token verification. |
| Storage / file-attachment path | A place for blobs (object storage) so the DB stores only attachment metadata (M2). |
| Vendor lock-in risk | How much is portable SQL vs proprietary surface (auth, edge, realtime, RLS-as-product). |
| Migration complexity | Effort to adopt now + effort to leave later. |
| Hostinger compatibility | Works cleanly with the likely Hostinger app host (managed DB off-host preferred). |

**Recommended-status vocabulary** (used in §13–§17): **preferred** · **acceptable fallback** · **testing only** · **not recommended**.

---

## 5. Auth Provider Decision Criteria

| Criterion | Why it matters |
|---|---|
| Current coupling | Today: **4 Firebase files** (`firebase.ts`, `AccessContext.tsx`, `Login.tsx`, `NotProvisioned.tsx`), **Google popup + email/password only**, **one Firestore read, zero writes** (verified, M0/M1). Small surface = cheap swap *if done before users accrue*. |
| Migration cost now vs later | ~Free today (no real users). Cost rises with every real user added (password/identity re-mapping). |
| Compatibility with `internal_user_id` strategy | App identity must be the stable `internal_user_id`; the provider UID is an external reference (M1/M2). |
| Compatibility with Supabase / Neon / Railway / VPS | Supabase Auth co-locates with Supabase DB; Neon/Railway/VPS have no bundled auth → Firebase Auth (or custom) + server-side token verification. |
| Server-side token verification path | Later, the API tier verifies the token (Firebase Admin SDK *or* Supabase JWT) → resolves `internal_user_id`. |
| Role/permission resolution path | Role/permissions resolve from app data via the pure engine (`platformPermissionsConfig.ts`/`accessConfig.ts`), **never** from the auth provider. |
| Tenant/store membership model | Membership lives in app tables (M2), keyed by `internal_user_id`, not by provider UID. |
| Impact on preview/demo mode | Preview/demo must not depend on a specific auth vendor; the boundary (M1) + request-context (M3) already abstract this. |
| Risk of locking records to an external UID | **Highest-leverage rule:** never use a Firebase/Supabase UID as a primary key on app records. |

---

## 6. Cost Model Assumptions

> Qualitative only. No exact pricing is claimed; re-price before go-live.

1. **Free/dev tiers are acceptable for testing only**, never for production business records.
2. **Production assumes a paid managed database tier** (or a paid managed backend tier), budgeted before go-live.
3. **Self-hosting the DB on a VPS may lower subscription cost but raises operational cost/risk** (backups, patching, HA, monitoring become the app team's job) — a real cost, just not a line item.
4. **Managed PostgreSQL is preferred** for backup/restore, reliability, and reduced maintenance — operational savings usually outweigh the subscription delta for financial/POS data.
5. **Costs must be reviewed again before go-live**, against the then-known scale envelope (§12).
6. **The expected scale envelope should drive the managed-tier choice** (small → entry tier; growth → reserved/compute tiers). Picking a tier now would be premature.
7. **Watch variable costs**, not just the headline tier: egress, connection/compute autoscaling, storage growth (attachments → object storage, not the DB), and edge/function invocations.

**Product-owner inputs still needed:** rough monthly budget band; the tenant/transaction count at which an entry tier is expected to be outgrown (§12).

---

## 7. Region / Latency / Data Residency Assumptions

1. **Expected tenant geography is not finalized.** Region cannot be locked until it is.
2. **Region choice must jointly consider** tenant locations, the Hostinger app-host region, the database-provider region, and external provider (payments/shipping) API regions.
3. **Latency matters for POS**, but **correctness and durability matter more** — never trade integrity for round-trip speed.
4. **Data residency / legal requirements are not finalized** and **must be checked before go-live** (some jurisdictions constrain where customer PII / financial records may live).
5. **A provider must support an acceptable region** (near tenants and the app host) **before it can be finally ratified.** All four candidates offer multi-region selection at the managed/VPS level; the binding constraint is the (still-open) tenant geography.

---

## 8. Backup / Restore / RPO / RTO Assumptions

1. **POS, invoice, inventory, and audit data have low tolerance for loss** — these are financial and evidentiary records.
2. **Managed, automated backup/restore is preferred** over manually maintained VPS backups (this is the single strongest argument against self-hosting the DB).
3. **Final provider selection must require a written backup/restore plan** (frequency, retention, restore drill, point-in-time capability).
4. **RPO/RTO targets are not yet finalized** but **must be set before production.** Working placeholder to be confirmed by the owner: a **short RPO** (minutes, not hours) and a **same-day RTO** for financial data — to be ratified, not assumed.
5. **Local/session/browser storage is not acceptable for production business records** (reaffirms M0 §6 truthfulness labels: `sessionStorage`/`localStorage` mirrors are *advisory*, never durable evidence).

---

## 9. Payments / PCI Assumptions

1. **No card data is stored in the application database** (reaffirms R5 / M2).
2. **An external payment processor handles card data**; the app never sees or persists PAN/CVV/track data.
3. **The app DB stores only**: payment **references**, **status**, **amount**, **currency**, **timestamps**, **invoice/order links**, and **audit metadata** (+ `external_provider`/`external_reference`/`idempotency_key` per the M2 mandatory-columns recap).
4. **PCI-sensitive scope is minimized** by design — keeping card data out of scope keeps the app out of the heaviest PCI obligations (final scope to be confirmed with the chosen processor).
5. **Payment implementation remains future/deferred** — M4 records the boundary, not an integration.

---

## 10. Local Dev / Test Strategy Assumptions

> No local database is set up in M4. This records the *future* options only.

| Future strategy | When it fits | Notes |
|---|---|---|
| **Firebase-only testing** | Now, while the app is a prototype | Untouched in M4; current path; no DB needed. |
| **Supabase local CLI** | Later, **if Supabase is selected** | Runs Postgres + Auth + Storage locally; matches prod surface closely. |
| **Docker / local PostgreSQL** | Later, **if Neon / Railway / VPS-style provider is selected** | Plain Postgres locally; auth handled separately (Firebase/custom). |
| **Cloud dev project** (a separate cheap managed instance) | Later, if local setup is too heavy for the team | No local engine; isolate from prod data. |

**Statement:** no local database setup, container, or CLI is implemented or installed in M4.

---

## 11. Schema Migration Tooling Expectations

> Expectations only — **no schema files, no migrations, no ORM files are created in M4.**

1. **SQL migration files will eventually be needed**, but not in M4.
2. **ORM choice is not decided.**
3. **Options to weigh later** (non-exhaustive): Supabase migrations, SQL-first migrations (hand-written + a runner), **Prisma**, **Drizzle**, or another tool.
4. **Sequencing rule:** the schema-tooling decision should be made **after** the provider/auth strategy is clear and the durable data model (M2) is finalized, and **before** any real schema implementation.
5. **No schema/DDL/`.sql`/ORM file is created now.**

---

## 12. Scale Envelope Assumptions

> Qualitative; any number below is a clearly-labeled working assumption, not a measured value.

1. **Early production = a small number of tenants/stores/users/transactions** (working assumption: order-of-magnitude "tens," not "thousands," at launch — to be confirmed).
2. **The design must not block later growth** to a substantially larger tenant base.
3. **Growth-ready primitives are already mandated by M2:** stable `internal_user_id`; `tenant_id`/`store_id` on every scoped record; append-only/partition-ready audit and ledger tables; deliberate indexes.
4. **Exact expected tenant count is still open** — a product-owner input that, together with the budget band (§6), selects the managed tier.

---

## 13. Supabase Evaluation

| Criterion | Assessment |
|---|---|
| Multi-tenant SaaS | **Strong** — Postgres + native RLS for DB-level tenant isolation. |
| POS/invoice/inventory fit | **Strong** — full Postgres (FKs, constraints, joins, ledgers). |
| RBAC + RLS / server enforcement | **Strong** — RLS first-class; pairs with Edge Functions or an external API tier. |
| Reporting / analytics | **Strong** — ad-hoc SQL. |
| Backup / restore maturity | **Good (managed)** — automated backups on paid tiers; confirm PITR + retention before ratifying (§8). |
| Operational burden | **Low** — managed. |
| Cost risk | **Moderate / predictable** — clear free→paid path; watch storage/egress/edge invocations (§6). |
| Region / latency / residency | **Good** — multi-region selection; bind once tenant geography is set (§7). |
| Local dev / test | **Strong** — Supabase CLI runs the stack locally. |
| Auth integration | **Best-in-class for this case** — bundled Supabase Auth co-locates with the DB. |
| Storage / attachments | **Built-in** — Supabase Storage for blobs; DB keeps metadata only. |
| Vendor lock-in | **Moderate** — core is portable Postgres; Auth/Storage/Edge/Realtime are the proprietary surface (mitigated by the M1 boundary). |
| Migration complexity | **Low to adopt**; leaving later = standard Postgres dump/restore for data, plus re-homing Auth/Storage. |
| Hostinger compatibility | **Good** — managed DB off the Hostinger host; SPA on Hostinger, API/Edge elsewhere or as Edge Functions. |
| **Recommended status** | **PREFERRED (ratified default working candidate; final provider provisional).** |

**Why preferred:** one managed platform covering Postgres + Auth (the Firebase-Auth successor) + RLS + Storage + auto REST/Realtime → the most coherent single destination for *both* the auth swap and the data layer, with the lowest operational burden.

---

## 14. Neon Evaluation

| Criterion | Assessment |
|---|---|
| Multi-tenant SaaS | **Strong** — Postgres + RLS. |
| POS/invoice/inventory fit | **Strong** — full Postgres. |
| RBAC + RLS / server enforcement | **Strong** — RLS; requires you to own the API + auth-verification tier. |
| Reporting / analytics | **Strong** — ad-hoc SQL (serverless Postgres; branching is a dev nicety). |
| Backup / restore maturity | **Good (managed)** — confirm retention/PITR on the chosen tier (§8). |
| Operational burden | **Low** — managed Postgres. |
| Cost risk | **Moderate / predictable**; watch compute autoscaling/branch usage. |
| Region / latency / residency | **Good** — region selection. |
| Local dev / test | **Docker/local Postgres** (no bundled CLI stack like Supabase). |
| Auth integration | **None bundled** — keep Firebase Auth (or custom) + server token verification. |
| Storage / attachments | **External object storage** needed (no bundled storage). |
| Vendor lock-in | **Low** — essentially portable Postgres. |
| Migration complexity | **Low**; minimal proprietary surface to leave. |
| Hostinger compatibility | **Good** — managed DB off-host. |
| **Recommended status** | **ACCEPTABLE FALLBACK** — preferred path *if* a more provider-neutral DB (low lock-in) and **retaining Firebase Auth** are preferred over Supabase's bundling. |

---

## 15. Railway PostgreSQL Evaluation

| Criterion | Assessment |
|---|---|
| Multi-tenant SaaS | **Strong** — Postgres + RLS. |
| POS/invoice/inventory fit | **Strong** — full Postgres. |
| RBAC + RLS / server enforcement | **Strong** — RLS; you own the API + auth verification. |
| Reporting / analytics | **Strong** — ad-hoc SQL. |
| Backup / restore maturity | **Good (managed), verify** — confirm automated backup/PITR posture on the plan before ratifying (§8). |
| Operational burden | **Low–moderate** — managed Postgres; also a convenient host for the API tier/sidecar. |
| Cost risk | **Variable** — usage/compute-based; watch always-on vs sleep behavior and egress. |
| Region / latency / residency | **Moderate–good** — fewer region options than the largest providers; confirm against tenant geography. |
| Local dev / test | **Docker/local Postgres.** |
| Auth integration | **None bundled** — Firebase Auth (or custom) + token verification. |
| Storage / attachments | **External object storage** needed. |
| Vendor lock-in | **Low** for the DB (portable Postgres); platform conveniences are optional. |
| Migration complexity | **Low** for data. |
| Hostinger compatibility | **Good** — managed DB off-host; can also co-host the API tier. |
| **Recommended status** | **ACCEPTABLE FALLBACK** — like Neon (provider-neutral + keep Firebase Auth), with the bonus of also hosting the API tier; verify backup maturity and region fit before relying on it for financial data. |

---

## 16. Hostinger VPS PostgreSQL Evaluation

| Criterion | Assessment |
|---|---|
| Multi-tenant SaaS | **Capable** — full Postgres + RLS (engine identical). |
| POS/invoice/inventory fit | **Capable** — full Postgres. |
| RBAC + RLS / server enforcement | **Capable** — RLS; co-locates naturally with a VPS-hosted API tier. |
| Reporting / analytics | **Strong** — ad-hoc SQL. |
| Backup / restore maturity | **You own it** — **the weakest point**: backups/PITR/HA are manual and must be *proven* before trusting financial data (§8). |
| Operational burden | **High** — patching, backups, monitoring, HA, security hardening are the app team's job. |
| Cost risk | **Lower subscription, higher operational/risk cost** — cheap box, expensive incident if backups are immature. |
| Region / latency / residency | **Depends on Hostinger regions**; can co-locate with the app host (low app↔DB latency). |
| Local dev / test | **Docker/local Postgres.** |
| Auth integration | **None bundled** — Firebase Auth (or custom) + token verification. |
| Storage / attachments | **External object storage** (or self-hosted, adding more ops). |
| Vendor lock-in | **Lowest** — pure self-managed Postgres. |
| Migration complexity | **Low for data; high for operations.** |
| Hostinger compatibility | **Native** — same host as the app. |
| **Recommended status** | **ACCEPTABLE-WITH-CAVEATS / NOT PREFERRED for financial/POS data** — viable only if cost/control dominates **and** backup/restore operations are demonstrably mature. Not recommended as the default for POS/invoice/audit data. |

---

### 16a. Baseline: Continuing Firebase / Firestore for production

| Criterion | Assessment |
|---|---|
| Multi-tenant SaaS | Weak fit for relational tenant isolation; the 7-level permission model is **not practically expressible** in Firestore rules. |
| POS/invoice/inventory fit | Weak — no joins, no relational constraints, forced denormalization for reporting. |
| Reporting / analytics | Weak — cannot join/aggregate ad-hoc. |
| Operational burden | Low (managed), but mismatched to the workload. |
| **Recommended status** | **TESTING ONLY / NOT RECOMMENDED for production** (reaffirms R3). **Firebase Auth + the single `users/{uid}` read remain in place for testing, untouched by M4.** |

---

## 17. Firebase Auth Keep / Replace Evaluation

| Option | Assessment | Recommended status |
|---|---|---|
| **Firebase Auth retained for testing (now)** | Zero migration cost; small surface (4 files; Google + password; one read, zero writes). Untouched in M4. | **KEEP (now).** |
| **Firebase Auth retained long-term with PostgreSQL** (Neon/Railway/VPS path) | **Viable** if a future API tier verifies Firebase tokens (Admin SDK) and maps `auth_provider_uid` → `internal_user_id`. No bundled DB auth needed. | **ACCEPTABLE** if final provider is Neon/Railway/VPS *and* token verification + user mapping are designed correctly. |
| **Supabase Auth replacement (later)** | Co-locates auth with the DB if Supabase is final; email is the natural re-mapping key (Google + password only today). **Cheapest before real users exist.** | **PLAN IT** before production users **if Supabase is the final provider.** |
| **Custom / self-managed auth (later)** | Maximum control, but highest build + security-maintenance burden (password storage, reset, MFA, session, breach response). | **NOT RECOMMENDED** unless a hard requirement forces it. |

**Cross-cutting identity rules (binding, from M1/M2 — reaffirmed):**
- `internal_user_id` **remains the stable application identity** (primary key on app records).
- `auth_provider` and `auth_provider_uid` **remain external references**, not primary keys.
- **Future records must not use a Firebase UID or Supabase UID as the primary app user ID.**
- **If Supabase is the final provider, strongly consider Supabase Auth before any production users exist** (migration only gets costlier).
- **If Neon/Railway/VPS is final, Firebase Auth can remain** provided server-side token verification + user mapping are designed correctly.
- **For testing, Firebase Auth remains untouched.**

---

## 18. Supabase Auth Evaluation

| Criterion | Assessment |
|---|---|
| Coupling created | Replaces 4 Firebase sites behind the same `IAuthProvider` (M1); only the adapter changes. |
| Migration cost | Lowest **before** real users (today). Re-map by email (Google + password only). Rises per real user later. |
| `internal_user_id` compatibility | Compatible — Supabase UID becomes `auth_provider_uid`; `internal_user_id` stays primary. |
| Provider fit | Native fit **only if Supabase is the DB**; pointless lock-in if the DB is Neon/Railway/VPS. |
| Server token verification | Supabase issues JWTs the API tier verifies — clean path. |
| Role/permission resolution | Still resolved by the pure engine from app data, **not** from Supabase Auth. |
| Preview/demo | Unaffected — abstracted by the M1 boundary + M3 request context. |
| **Recommended status** | **PLAN (conditional)** — adopt **only if** Supabase is ratified as the final provider, and **before** production users. Otherwise defer/skip. |

---

## 19. Recommended Working Decision

1. **Confirm Supabase as the PREFERRED, default *working* provider** (not the locked final provider). Design and the future *first* Postgres adapter target Supabase so there is one coherent destination, while the M1 boundary keeps Neon/Railway/VPS drop-in.
2. **Keep Firebase Auth for testing now; change nothing about it in M4.**
3. **Tie the auth-final decision to the provider-final decision:** if Supabase wins → plan Supabase Auth before production users; if Neon/Railway/VPS wins → Firebase Auth may remain with a token-verification + user-mapping design.
4. **Keep PostgreSQL (R1) and the server/API-tier requirement (R2) ratified.**
5. **Hold the final provider + final auth as PROVISIONAL** until the product owner supplies: budget band (§6), tenant geography/residency (§7), RPO/RTO targets (§8), and a rough scale envelope (§12) — plus a backup/restore plan from the chosen provider.
6. **Treat Hostinger-VPS Postgres as acceptable-with-caveats / not preferred** for financial data; **Firestore stays testing-only.**

---

## 20. What Is Ratified Now

- **PostgreSQL** = ratified working production-database direction (R1, unchanged).
- **A future server/API enforcement tier** = ratified requirement (R2, unchanged).
- **Supabase** = **ratified as the PREFERRED default working provider candidate** (design target), **without** locking it as the final provider.
- **Firebase Auth** = ratified to **remain for testing**, untouched.
- **Identity strategy** = ratified: `internal_user_id` primary; `auth_provider`/`auth_provider_uid` external references; no app PK on a vendor UID.
- **Payments/PCI boundary** = ratified: no card data in the app DB; external processor; references/metadata only.
- **Provider-neutrality via the M1 boundary** = ratified: vendor names only in adapters.

## 21. What Remains Provisional

- **Final database provider** (Supabase vs Neon vs Railway vs Hostinger-VPS) — pending §6/§7/§8/§12 inputs + a backup/restore plan.
- **Final auth provider** (keep Firebase Auth vs adopt Supabase Auth vs custom) — conditioned on the final provider choice and the "before real users" timing.
- **Region / data residency** — pending tenant geography + legal review.
- **RPO/RTO targets** — placeholders in §8 to be confirmed.
- **Cost tier / budget band** — re-price before go-live.
- **Local dev/test mechanism**, **schema-migration tooling/ORM**, and **server runtime (VPS vs serverless/edge)** — all deferred to post-ratification.

---

## 22. Impact on M5 and Later

- **M5 is not started by M4.** A natural M5 (still docs/architecture) would be a **provider-finalization gate**: a short checklist that collects the four product-owner inputs (budget, region/residency, RPO/RTO, scale) + a provider backup/restore plan, and flips the final-provider/final-auth status from provisional to ratified **before** any adapter code.
- **The first behavior-changing milestone remains step E of the M1 adoption order** (server/API + Postgres adapters), gated on the topology + provider ratifications and the durable data model — out of Phase 1.4.
- **If Supabase is finalized:** schedule the **Supabase Auth migration before real production users** (cheapest window).
- Nothing in M4 advances or unblocks implementation; it only sharpens the target.

---

## 23. Risks / Open Questions

- **Premature lock-in:** treating "preferred default" as "final" would couple design to Supabase specifics and erode the Neon/Firebase-Auth fallback. *Mitigation:* the M1 boundary; final status held provisional (§21).
- **Auth-migration drift:** every real user added before an auth swap raises migration cost. *Mitigation:* decide the auth-final question *before* onboarding production users.
- **VPS backup immaturity:** the dominant risk if Hostinger-VPS Postgres is chosen for financial data. *Mitigation:* require a proven backup/restore plan first; not preferred by default.
- **Unset RPO/RTO and residency:** cannot finally ratify a provider/region without them. *Open — product-owner inputs.*
- **Cost surprises** (egress/compute/edge invocations/storage growth): *Mitigation:* re-price before go-live against the real scale envelope.
- **Open questions:** tenant geography? budget band? RPO/RTO targets? expected tenant count? confirmed external payment processor? confirmed Hostinger as app host + region?

---

## 24. Non-Implementation Statement

M4 **changes no runtime, source, UI, schema, config, or dependency.** It does **not** implement Supabase, Neon, Railway, Hostinger-VPS Postgres, or PostgreSQL; does **not** replace or modify Firebase Auth; creates **no** schema, SQL migration, or ORM file; installs **no** dependency; implements **no** middleware, server guard, repository runtime, or server/API runtime. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. All code-like fragments are documentation examples. The milestone is **reversible** (delete this doc + revert the decision-record cross-references and the `replit.md` status line). **Accepted / committed / backed up** at GitHub checkpoint `ab8cbdecfaec21f3603798ef89279e84e7125970`.

---

## 25. Validation / QA Summary

- **Docs/architecture only** — no behavioral QA applies; review is the gate.
- **M4 changed only Markdown** under `docs/` (this file + cross-references) and one factual `replit.md` status line. No `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package.json`/lockfile changes; nothing imported or wired.
- **TypeScript/lint:** M4 touches no TypeScript; any pre-existing baseline errors are unchanged and none are introduced by M4 (validation command output recorded in the M4 report).
- **Exit criteria:** provider + auth criteria consolidated and evaluated (§4–§18); recommended working decision recorded (§19); ratified-vs-provisional split explicit (§20–§21); decision records cross-referenced (§26); honest about what stays provisional.

---

## 26. Relationship to the Decision Records

The two decision records remain the **canonical status holders**; M4 is the consolidated *criteria + evaluation* that informs them.
- [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md) — PostgreSQL ratified; Supabase preferred default (provisional final); criteria table cross-references M4.
- [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md) — server/API tier ratified; specific runtime provisional; auth-verification path cross-references M4.

No status in those records is *escalated* by M4 (Supabase is **not** promoted from preferred to final). M4 only records the reasoning and the remaining gates.
</content>
</invoke>
