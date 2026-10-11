# TM POS2026 — Phase 4.0 Production Architecture & Migration Blueprint (M1)

**Status:** M1 architecture & documentation only. **No application code, routes, sessions, schemas, migrations, providers, or UI are created or modified by this milestone.** Actual production deployment / go-live remains a **separate explicit owner authorization after M9**.

**Baseline at authoring:** branch `main` at `79509c18…` (M0 fail-closed Firestore rules checkpoint). This package is documentation-only under `docs/phase-4/`.

## What this package establishes

TM POS2026 is today a **client-authoritative React SPA** whose production artifact is a **static `vite build` bundle**; **M6-ENTRY-P1 adds a deployable backend entry in code (serving the administrative boundary only), not yet deployed**. **M5-ADMIN-STEPUP-P1 adds, in code only, the recent-sign-in (step-up) journey for the console's tenant lifecycle actions — a same-principal reauthentication mode of the existing admin login route, with no new route and no new migration ([ADR-28](./10-architecture-decision-records.md)) — not deployed**. Live authorization is 100% in the browser, business data is in-memory mock state lost on reload, and the legacy Express servers are **DEV-only sidecars unreachable in production**; the production entry (`server/entry/productionEntry.ts`) is not one of them — it is a deployable server over the durable Postgres backend, code-only and not deployed. This blueprint defines how the platform moves to a **deployable, server-authoritative, multi-tenant SaaS** with a **separate Backend Control Plane login**, canonical IAM, durable business persistence, and a complete production-gate roadmap.

## Documents

| # | Document | Covers |
|---|---|---|
| — | [README.md](./README.md) | This index |
| 01 | [Current-State Inventory & Gap Matrix](./01-current-state-inventory-and-gap-matrix.md) | Every platform/tenant surface: state source, auth, authz, persistence, isolation, gating, defects, target milestone |
| 02 | [Target Production Architecture](./02-target-production-architecture.md) | Target system, trust boundaries, data flows, sources of truth, prohibited authorities |
| 03 | [Backend Control Plane Login & Session Blueprint](./03-backend-control-plane-login-session-blueprint.md) | Separate admin login/session boundary + Backend CP responsibilities & controlled-action contract |
| 04 | [Canonical IAM & Four-User Migration](./04-canonical-iam-and-four-user-migration.md) | Identity hierarchy, permission model reconciliation, tenant/store governance, four-user migration contract |
| 05 | [Canonical Data Ownership & API/DB Contracts](./05-canonical-data-ownership-and-api-db-contracts.md) | Per-domain data ownership, API/error contract, database & multi-tenant contract |
| 06 | [Module Migration Map (M7a–M7h)](./06-module-migration-map-m7.md) | Vertical module migration ordering & dependencies |
| 07 | [Quality & Test Strategy](./07-quality-and-test-strategy.md) | Mandatory test pyramid, emulator/CI foundation, coverage gates |
| 08 | [Production Gate & Risk Register](./08-production-gate-and-risk-register.md) | Single authoritative gate register (owner, milestone, evidence, pass/fail, severity) |
| 09 | [Roadmap M0–M9](./09-roadmap-m0-m9.md) | Authoritative milestone roadmap + deferred/future reconciliation |
| 10 | [Architecture Decision Records](./10-architecture-decision-records.md) | ADRs for the major structural choices |
| 11 | [Invoice Draft Discard — Decision Pack](./11-m7b-invoice-draft-discard-decision-pack.md) | **PROPOSED / UNADOPTED** (M7B-INVOICES-D1-P1): owner decisions, route contract and planned tests for discarding a saved store invoice draft; nothing implemented |

## Reading order

1. **[09 Roadmap](./09-roadmap-m0-m9.md)** — the M0–M9 spine every other doc references.
2. **[01 Inventory](./01-current-state-inventory-and-gap-matrix.md)** — what exists today and its gaps.
3. **[02 Target Architecture](./02-target-production-architecture.md)** — where it goes.
4. **[03](./03-backend-control-plane-login-session-blueprint.md)–[06](./06-module-migration-map-m7.md)** — the design contracts (Backend CP, IAM, data/API, module migration).
5. **[07](./07-quality-and-test-strategy.md)–[08](./08-production-gate-and-risk-register.md)** — quality strategy and the gate register that governs go-live.
6. **[10 ADRs](./10-architecture-decision-records.md)** — rationale for the major decisions.

## Carried-forward M0 production gates (not closed by M1)

These remain **open production gates**, tracked in [08](./08-production-gate-and-risk-register.md):

- **G-EMU** — Firestore emulator semantic suite **PASSES locally (41/41)** via ephemeral Nix JDK21 (**M2**); static guard retained (21/21). CI evidence pending committed workflow; must stay green before any rules deployment or go-live.
- **G-HIST** — historical (pre-fix) Firestore exploitation cannot be disproven; a **historical evidence limitation, not a waivable active vulnerability**. **M8** bounded read-only investigation → **M9** owner risk-acknowledgement disposition.
- **G-4USER** — four noncanonical Firebase users (`store_owner`/`manager`/`technician`/`sales_staff`) hold client-presentation roles only; canonically migrated in **M5** via owner-approved, audited provisioning (no silent auto-provisioning).

**Owner architecture decisions are RESOLVED (no open M1 owner decision remains):** **G-PCI** — integrated payment capability is in scope (semi-integrated/tokenized; no cardholder data in TM POS2026); the **payment gateway is STORE-owned** (Store Owner / explicitly-permissioned store user configures it under Store Settings → Payments; initial catalog Stripe/Square/Adyen; the System Owner governs only the connector catalog & security policy — [ADR-16](./10-architecture-decision-records.md), [05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)). **G-PRIVACY** — privacy & DSAR foundation is in scope (implement, not exclude). Both remain evidence-based production gates until their evidence passes.

## Non-goals of M1

No implementation, no deployment, no provider calls, no database writes, no live business-document reads, no repository code/config/schema changes. This is a planning artifact set. See each document's own scope note.
