# Phase 1.6 — Milestone 21: Backend Control Plane Charter, Governance, Information Architecture, and Visual Architecture Plan (Planning-Only)

## 1. Title

Phase 1.6 Milestone 21 — Backend Control Plane (Backend UI Control Panel) Charter, Governance Model, Information Architecture, Access Model, Module Model, Visual Architecture Direction, and Phased Roadmap (planning-only; no UI; no routes; no API; no backend or frontend runtime change; no database connection; non-authoritative).

## 2. Purpose

Define, in a single repository-durable and redaction-safe planning document, the **future** Backend Control Plane (BCP): its product charter, its governance and safety model, its information architecture, its module inventory and responsibilities, its access/RBAC and owner-granted scoped-access model, its approval and separation-of-duties model, its redacted audit-evidence model, its future database-per-tenant / database-per-store architecture, its visual direction (synthesized from the reviewed design references), its screen-by-screen UX blueprint, and a phased, read-only-first implementation roadmap.

This milestone (M21) is **planning/architecture only**. It implements no UI, no React components, no routes, no API endpoints; it changes no backend runtime, no frontend runtime, and no database code; it opens no database connection; it runs no SQL; it inserts no rows; it changes no current authorization behavior; it wires no identity-link functionality; and it performs no commit, push, or backup.

## 3. Repository Checkpoint

- Accepted checkpoint at authoring time: `e03049a606ffc58a1d3c5dd3396042204f434e2c`.
- Most recent commit subject at base: "Phase 1.6 M20.12 document identity link DEV adapter plan".
- Accepted status carried forward: M20.10 ACCEPTED/COMPLETE/BACKED UP; M20.11 ACCEPTED/COMPLETE/BACKED UP; M20.12 ACCEPTED/COMPLETE/BACKED UP.
- This M21 plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written charter, governance model, information architecture, module model, access model, action-safety model, future database isolation model, visual architecture direction, screen-by-screen blueprint, and phased roadmap for the Backend Control Plane.

**Non-goals (explicit):** no UI built; no React components created; no routes added; no API endpoints added; no backend runtime modified; no frontend runtime modified; no database code modified; no database connection opened; no SQL executed; no rows inserted; no migration applied or modified; no seeds changed; no package files changed; no current authorization behavior changed; no identity-link functionality wired; no `audit_event` or `identity_link` row written; no Supabase MCP used; no production target touched; no commit/push/backup as part of authoring. The Backend Control Plane is **not** implemented by this document.

## 5. Current Project Carry-Forward

The following accepted boundaries remain true and are preserved by this milestone:

- Firebase / legacy AccessContext remains **authoritative** in the current app.
- Server-derived authorization remains **observational / comparable only**.
- Identity mapping remains **inactive and unwired**.
- M11 through M15 and M17.1 remain **dormant**.
- The M20.11 identity-link admin provisioning service remains **server-only, default-OFF, dependency-injected, and imported only by its own test** (no runtime wiring).
- The M20.12 repository/audit adapter plan is **planning only**; no adapter is implemented.
- **No** real `identity_link` rows have been inserted.
- **No** real `audit_event` rows have been inserted from this track.
- DEV `identity_link` remains **empty, RLS-protected, zero client policies, zero client-role grants**.
- Self-service identity linking remains **deferred**.
- Production remains **blocked**.
- Email must **never** be identity authority.
- Client-asserted UID must **never** be authority.
- `internal_user_id` remains the **app-owned stable anchor**.

## 6. Design Reference Summary

The owner reviewed multiple Google Stitch and AI Studio design prototypes. All such output is treated as **reference-only**: no generated code is imported, no prototype code is copied, no prototype dependency is added, and no unsafe sample data is preserved.

Reference sets considered (by owner-provided names, conceptual only):

1. Backend-CP-Stitch-Version-1
2. Backend-CP-AI-Studio-Version-1
3. Backend-CP-Stitch-Version-2-Original
4. Backend-CP-AI-Studio-Version-2-Original
5. stitch_nexus_backend_control_plane

Owner-accepted evaluation summary:

- The latest Stitch version is the strongest **visual** foundation.
- The AI Studio versions are stronger for **module coverage** and **interaction patterns**.
- Stitch Version 2 Original is strong for **operational realism**.
- The final direction **combines all references** and copies none directly.

Visual foundation to carry forward: a premium dark command-center shell; a separate secure access gate; an "Obsidian / Nexus / Guardian Core" atmosphere; role-profile access cards; an environment switcher with a production lock; a read-only / elevated mode indicator; a tenant/store/database topology map; database registry and database orchestration screens; an approval queue with a separation-of-duties model; an immutable audit timeline; RLS-Protected / Masked-Connection / Isolated-DB badges; a jobs/workers operations view; backend service health panels; and a bottom safety footer (separate secure workspace / RLS protected / masked connection).

Structural ideas to carry forward (from the broader AI Studio coverage): command palette; environment banner; database explorer/registry; services monitor; jobs and queues; operations console; API monitor; centralized logs; tenant isolation debugger; deployments and releases; environments and infrastructure; backups and recovery; security control; configuration and secrets posture; migration viewer; policies and guardrails; support/operator tools; control plane settings.

Note: at authoring time these references are summarized direction; no prototype archive content is reproduced in this document, and no sample data from any prototype is preserved.

## 7. Backend Control Plane Definition

The Backend Control Plane (BCP) is **both**:

1. A backend **governance / control layer** — the policy, approval, separation-of-duties, environment-guardrail, and audit-evidence model that governs sensitive backend operations; and
2. A trusted backend **operations UI** — a separate operator console through which authorized, scoped operators observe and (only later, where approved) request/execute governed actions.

The BCP eventually controls and monitors: database lifecycle; tenant database provisioning; store database provisioning; schema and migrations; backend services; jobs and workers; API traffic; logs and telemetry; identity and access; identity links; audit and approvals; configuration and secrets posture; deployments and releases; environments and infrastructure; backups and recovery; policies and guardrails; safe support/operator tools; and control-plane settings.

The BCP is **not** implemented today. This document defines it; it does not build it.

## 8. Separation From Owner Platform

The BCP must be **separate** from the current Owner Platform UI. It is **not** a normal owner/admin page inside the existing platform. Separation requirements:

- **Separate secure access gate** — its own authentication/authorization entry, distinct from the app's normal login.
- **Separate visual shell** — its own command-center shell, not embedded in the Owner Platform layout.
- **Separate navigation** — its own information architecture and module nav.
- **Separate RBAC** — its own role model, distinct from app roles/entitlements.
- **Owner-granted scoped access** — access is explicitly granted, scoped, and time-bounded.
- **Approval and separation-of-duties workflow** — sensitive actions require request → approval by a distinct actor.
- **Immutable, redacted audit-evidence model** — every governed decision is auditable without exposing identifiers or secrets.
- **Environment guardrails and production blockers** — dangerous and production actions are blocked by default.
- **Read-only-first implementation strategy** — the first build observes only.
- **Current / planned / future module-state model** — every capability is labeled by maturity.

Critically: standing up the BCP must **not** change the current app's authority model. Firebase / AccessContext stays authoritative; server-derived authorization stays observational; the dormant chain stays dormant.

## 9. Product Principles

1. **Separate, secure, and explicit.** A distinct workspace with a distinct gate; access is granted, never assumed.
2. **Read-only first.** Observe before acting; the first capability set is non-mutating.
3. **Least privilege and scoped access.** Access is scoped by environment, tenant, store, module, action type, duration, and approval requirement.
4. **Approval and separation of duties for sensitive actions.** A requester and a distinct approver; no self-approval for dangerous actions.
5. **Production blocked by default.** Dangerous and production-affecting actions are blocked until separately approved through governed workflow.
6. **Immutable, redacted audit evidence.** Append-only evidence with safe categories and booleans; never identifiers, secrets, or raw payloads.
7. **No secrets on screen.** Secret values are never displayed; only posture/status is shown.
8. **Identifiers are opaque.** Provider UIDs, internal anchors, and emails are never shown raw; only opaque references and redacted evidence.
9. **Non-authoritative.** The BCP never makes server-derived authorization authoritative and never wires the dormant chain into runtime.
10. **Reversible and recoverable.** Governed actions are designed around approval, audit, rollback, and recovery.
11. **Environment-aware everywhere.** Every screen and action is environment-scoped with a visible environment indicator.
12. **Honest state labeling.** Current / Planned / Future / Dormant / Read-Only-First / Production-Blocked are displayed truthfully.

## 10. Current / Planned / Future / Blocked State Model

Every capability, module, screen, and action carries one of these state labels:

- **Current** — exists today and is directly supported by existing code (e.g., the append-only audit capability; the DEV `identity_link` table that exists and is empty; the M20.11 server-only default-OFF service unwired except by its test).
- **Planned** — designed and intended as the next safe step (e.g., a read-only BCP shell; redacted observational panels).
- **Future** — intended longer-term, not yet designed in detail or dependent on prerequisites (e.g., database-per-tenant provisioning; write-capable orchestration).
- **Dormant** — built but intentionally inactive and unwired (e.g., M11–M15 + M17.1; the M20.11 service in runtime terms).
- **Read-Only-First** — the maturity gate that any module must pass through (observe-only) before any write capability is considered.
- **Production-Blocked** — explicitly disallowed in production until separately approved through governed workflow.

This model is the backbone of the BCP: no capability is presented as more mature than it is.

## 11. Global Application Shell

A premium dark command-center shell, separate from the Owner Platform, composed of:

- **Top environment banner** — current environment (DEV / STAGING / PRODUCTION), a production lock indicator, and a read-only vs elevated mode indicator.
- **Left navigation rail** — module groups (Overview, Tenancy & Data, Platform Operations, Identity & Security, Governance, Delivery, Settings).
- **Command palette** — keyboard-driven navigation and action search; in read-only-first builds it navigates and filters only.
- **Main content region** — high-density enterprise cards, tables, topology diagrams, and panels per module.
- **Right context drawer** — selection details, redacted evidence, and (future) request/approval affordances.
- **Bottom safety footer** — persistent indicators: "Separate Secure Workspace", "RLS Protected", "Masked Connection".

Shell-level invariants: the environment indicator is always visible; the mode (read-only vs elevated) is always visible; the production lock is always visible; and no secret or raw identifier is ever rendered.

## 12. Separate Access Gate

The BCP has its own access gate, distinct from the app login:

- A dedicated entry that establishes a BCP session separate from the app session.
- Strong-authentication posture expectation (e.g., second-factor posture) — described as a requirement, not implemented here.
- Owner-granted, scoped, time-bounded access only; no implicit access from app roles.
- An explicit read-only vs elevated session mode selection, with elevated mode requiring stronger gating and producing audit evidence.
- The gate establishes scope (environment / tenant / store / module / action type / duration) for the session.
- No secrets, tokens, or raw identifiers are ever displayed at the gate; the gate shows only safe posture and the operator's granted scope summary (opaque).

This gate is **Planned/Future**; it does not exist today and is not built here.

## 13. Navigation and Information Architecture

Top-level navigation groups and their modules:

- **Overview** — Command Center; Operations Console.
- **Tenancy & Data** — Tenants; Stores; Tenant Isolation Debugger; Database Registry; Database Control; Schema & Migrations; Backups & Recovery.
- **Platform Operations** — Services; Jobs & Workers; API Traffic; Logs & Telemetry.
- **Identity & Security** — Identity & Access; Identity Links; Configuration & Secrets Posture.
- **Governance** — Audit & Approvals; Policies & Guardrails.
- **Delivery** — Deployments & Releases; Environments & Infrastructure.
- **Operator** — Support / Operator Tools.
- **Settings** — Control Plane Settings.

IA principles: environment scope is global (selected in the banner, applied everywhere); every module defaults to its read-only view; write/approval affordances appear only for modules and roles where they are designed, and even then are gated by state labels and environment.

## 14. Module Inventory

The BCP module inventory (minimum set):

1. Command Center
2. Operations Console
3. Tenants
4. Stores
5. Tenant Isolation Debugger
6. Database Registry
7. Database Control
8. Schema & Migrations
9. Services
10. Jobs & Workers
11. API Traffic
12. Logs & Telemetry
13. Identity & Access
14. Identity Links
15. Configuration & Secrets Posture
16. Audit & Approvals
17. Policies & Guardrails
18. Deployments & Releases
19. Environments & Infrastructure
20. Backups & Recovery
21. Support / Operator Tools
22. Control Plane Settings

## 15. Module-by-Module Responsibilities

For each module: purpose; primary users; current state; future state; read-only capabilities; write-capable capabilities; approval requirements; audit requirements; environment restrictions; production blockers; implementation priority. (Capabilities are conceptual; nothing here is implemented.)

### 15.1 Command Center
- **Purpose:** at-a-glance health, posture, and governance status across environments.
- **Primary users:** BCP Owner; Platform Administrator; Read-Only Auditor.
- **Current state:** Planned (no UI today).
- **Future state:** aggregated, environment-scoped status surface.
- **Read-only:** posture tiles, environment status, pending-approvals count, recent audit summary (redacted).
- **Write-capable:** none by design.
- **Approval:** n/a (observational).
- **Audit:** view access auditable in elevated mode.
- **Environment restrictions:** environment-scoped view.
- **Production blockers:** no actions, so none beyond view-scope.
- **Priority:** P1 (first read-only screen).

### 15.2 Operations Console
- **Purpose:** unified operational overview (services, jobs, API, logs summaries) for triage.
- **Primary users:** Operations Administrator; BCP Owner; Read-Only Auditor.
- **Current state:** Planned.
- **Future state:** cross-domain triage with drill-through.
- **Read-only:** health summaries, recent incidents (redacted), queue depths (aggregate).
- **Write-capable:** none initially; future request-only triage actions.
- **Approval:** any future action request-only / approval-required.
- **Audit:** all future actions audited.
- **Environment restrictions:** environment-scoped; production triage view read-only.
- **Production blockers:** no execution in production.
- **Priority:** P2.

### 15.3 Tenants
- **Purpose:** observe tenant inventory, isolation posture, and database mapping (redacted/opaque).
- **Primary users:** Platform Administrator; Database Administrator; Read-Only Auditor.
- **Current state:** Planned (uses safe aggregate facts only).
- **Future state:** governance entry point for tenant DB provisioning.
- **Read-only:** tenant list by opaque reference, isolation posture, DB-mapping status (no real names).
- **Write-capable:** future tenant DB provisioning request (approval-required).
- **Approval:** provisioning request → owner approval → separation-of-duties.
- **Audit:** provisioning lifecycle audited with safe categories.
- **Environment restrictions:** DEV-first; production-blocked.
- **Production blockers:** no tenant DB creation in production from BCP until separately approved.
- **Priority:** P3 (read-only), provisioning Future.

### 15.4 Stores
- **Purpose:** observe store inventory and store-scoped isolation posture (redacted/opaque).
- **Primary users:** Platform Administrator; Database Administrator.
- **Current state:** Planned.
- **Future state:** governance entry point for store DB / store-scoped isolation unit provisioning.
- **Read-only:** store list by opaque reference, isolation unit posture, DB-mapping status.
- **Write-capable:** future store DB provisioning request (approval-required).
- **Approval:** request → approval → separation-of-duties.
- **Audit:** lifecycle audited (safe categories).
- **Environment restrictions:** DEV-first; production-blocked.
- **Production blockers:** no store DB creation in production from BCP until separately approved.
- **Priority:** P3 (read-only), provisioning Future.

### 15.5 Tenant Isolation Debugger
- **Purpose:** verify and visualize tenant/store isolation posture (RLS posture, masked-connection posture, isolation boundaries).
- **Primary users:** Security Administrator; Database Administrator; Read-Only Auditor.
- **Current state:** Planned.
- **Future state:** isolation assertion and drift detection (observational).
- **Read-only:** isolation map, RLS-posture badges, boundary checks (pass/fail booleans).
- **Write-capable:** none; isolation is not mutated here.
- **Approval:** n/a.
- **Audit:** elevated views audited.
- **Environment restrictions:** all environments read-only.
- **Production blockers:** no mutation anywhere.
- **Priority:** P2.

### 15.6 Database Registry
- **Purpose:** catalog of databases by environment / tenant / store with posture metadata (no connection strings).
- **Primary users:** Database Administrator; BCP Owner; Read-Only Auditor.
- **Current state:** Planned.
- **Future state:** authoritative registry feeding provisioning, backups, migrations.
- **Read-only:** registry list, isolation posture, schema-version label, RLS posture, backup-status label, locked/unlocked state, masked-connection posture (no secrets).
- **Write-capable:** future register/lock/unlock (approval-required).
- **Approval:** lock/unlock and registration approval-required + separation-of-duties.
- **Audit:** all registry changes audited.
- **Environment restrictions:** DEV-first write; production read-only/blocked.
- **Production blockers:** no production registry mutation until separately approved.
- **Priority:** P2 (read-only).

### 15.7 Database Control
- **Purpose:** governed database orchestration (provisioning, lock state, recovery linkage) — future, heavily gated.
- **Primary users:** Database Administrator; BCP Owner (approver).
- **Current state:** Future (design only).
- **Future state:** governed provisioning pipeline and lifecycle control.
- **Read-only:** orchestration status, pipeline state, guardrail evaluation results (booleans).
- **Write-capable:** future provisioning/lock — approval-required, separation-of-duties, DEV-first.
- **Approval:** mandatory owner approval + distinct approver.
- **Audit:** full lifecycle audit (requested/validated/approved/succeeded/rejected categories).
- **Environment restrictions:** DEV-only initially; production-blocked.
- **Production blockers:** destructive/production orchestration forbidden until separately approved.
- **Priority:** Future.

### 15.8 Schema & Migrations
- **Purpose:** observe schema versions and migration state; govern migration application (future).
- **Primary users:** Database Administrator; Security Administrator (reviewer).
- **Current state:** Planned (read-only viewer).
- **Future state:** governed, approval-gated migration application (never destructive in production).
- **Read-only:** migration inventory, applied/pending state, schema-version labels.
- **Write-capable:** future apply (DEV-first, approval-required); destructive changes forbidden.
- **Approval:** apply requires approval + separation-of-duties.
- **Audit:** apply lifecycle audited.
- **Environment restrictions:** DEV-first; production-blocked.
- **Production blockers:** destructive schema changes forbidden; no production apply from BCP until separately approved.
- **Priority:** P3 (viewer), apply Future.

### 15.9 Services
- **Purpose:** backend service health panels and status.
- **Primary users:** Operations Administrator; Read-Only Auditor.
- **Current state:** Planned.
- **Future state:** governed restart/scale request (approval-required).
- **Read-only:** health, status, recent events (redacted).
- **Write-capable:** future restart/scale — request-only / approval-required.
- **Approval:** any control action approval-required.
- **Audit:** control actions audited.
- **Environment restrictions:** DEV-first control; production read-only.
- **Production blockers:** no service restart in production from BCP until separately approved.
- **Priority:** P2 (read-only).

### 15.10 Jobs & Workers
- **Purpose:** observe jobs/queues/workers; govern job control (future).
- **Primary users:** Operations Administrator.
- **Current state:** Planned.
- **Future state:** governed pause/retry/cancel (approval-required).
- **Read-only:** queue depths, worker status, job outcomes (aggregate/redacted).
- **Write-capable:** future pause/retry/cancel — request-only / approval-required.
- **Approval:** control actions approval-required.
- **Audit:** control actions audited.
- **Environment restrictions:** DEV-first control; production read-only.
- **Production blockers:** no worker control in production from BCP until separately approved.
- **Priority:** P2 (read-only).

### 15.11 API Traffic
- **Purpose:** observe API traffic health and rates (aggregate; no raw headers/bodies).
- **Primary users:** Operations Administrator; Security Administrator.
- **Current state:** Planned.
- **Future state:** rate/posture observation and alerting (observational).
- **Read-only:** request-rate aggregates, error-rate aggregates, endpoint health (no raw payloads, no headers, no bodies).
- **Write-capable:** none.
- **Approval:** n/a.
- **Audit:** elevated views audited.
- **Environment restrictions:** all environments read-only.
- **Production blockers:** no raw request/response inspection ever.
- **Priority:** P3.

### 15.12 Logs & Telemetry
- **Purpose:** centralized, redacted logs and telemetry views.
- **Primary users:** Operations Administrator; Security Administrator; Read-Only Auditor.
- **Current state:** Planned.
- **Future state:** governed, redacted log search.
- **Read-only:** redacted log streams, telemetry aggregates, posture indicators (no secrets, no raw identifiers).
- **Write-capable:** none.
- **Approval:** n/a.
- **Audit:** elevated log views audited.
- **Environment restrictions:** all environments read-only.
- **Production blockers:** no raw secret/identifier exposure ever.
- **Priority:** P3.

### 15.13 Identity & Access
- **Purpose:** govern BCP roles, scoped grants, and access posture (not app authority).
- **Primary users:** BCP Owner; Security Administrator.
- **Current state:** Planned.
- **Future state:** owner-granted scoped access administration.
- **Read-only:** role inventory, active scoped grants (opaque actor references), access posture.
- **Write-capable:** future grant/revoke of scoped access — approval-required, separation-of-duties.
- **Approval:** grant/revoke approval-required.
- **Audit:** grant/revoke lifecycle audited (no actor UUIDs surfaced).
- **Environment restrictions:** governed in all environments; production grants stricter.
- **Production blockers:** no privilege escalation bypassing approval; never makes app/server authorization authoritative.
- **Priority:** P2.

### 15.14 Identity Links
- **Purpose:** govern the future identity-link lifecycle (admin-provisioned, DEV-only, approval-required) — aligned with M20.11 / M20.12.
- **Primary users:** BCP Owner (approver); Security Administrator.
- **Current state:** Future-controlled and currently **dormant**.
- **Future state:** governed admin provisioning (create/disable/revoke) with redacted audit.
- **Read-only:** link lifecycle status by opaque reference, redacted audit timeline, conflict/idempotency categories (booleans), counts (aggregate). DEV table exists and remains empty.
- **Write-capable:** future create/disable/revoke — DEV-only, default-OFF, approval-required, separation-of-duties.
- **Approval:** mandatory; requester ≠ approver.
- **Audit:** redacted taxonomy (requested/validated/approved/succeeded/rejected/conflict/idempotent/disable/revoke/validation.failed) with safe categories and booleans only.
- **Environment restrictions:** DEV-only; production-blocked.
- **Production blockers:** no identity-link writes in production; no self-service linking; raw Firebase/Supabase/provider UID and raw `internal_user_id` never shown; email never authority; client-supplied UID never authority.
- **Priority:** Future (governed); read-only status surface can be Planned.

### 15.15 Configuration & Secrets Posture
- **Purpose:** show configuration and secrets **posture** (presence/rotation/age status) — never values.
- **Primary users:** Security Administrator; BCP Owner.
- **Current state:** Planned.
- **Future state:** posture monitoring and rotation governance.
- **Read-only:** posture indicators (set/unset, rotation status, last-rotated category) — no secret values, no env values, no connection strings.
- **Write-capable:** future rotation request — approval-required, separation-of-duties.
- **Approval:** rotation request approval-required.
- **Audit:** rotation lifecycle audited (no secret material in evidence).
- **Environment restrictions:** DEV-first; production stricter.
- **Production blockers:** secret values never displayed in any environment; no production rotation from BCP until separately approved.
- **Priority:** P3.

### 15.16 Audit & Approvals
- **Purpose:** immutable, redacted audit timeline plus the approval queue.
- **Primary users:** Read-Only Auditor; Approval Reviewer; BCP Owner.
- **Current state:** Current capability conceptually (append-only audit exists); BCP surface Planned.
- **Future state:** governed approval queue feeding all sensitive modules.
- **Read-only:** audit timeline (safe categories/booleans), approval queue status.
- **Write-capable:** approve/reject within separation-of-duties (future).
- **Approval:** this **is** the approval surface; approvers must be distinct from requesters.
- **Audit:** approvals/rejections are themselves audited; audit is append-only and never bypassable.
- **Environment restrictions:** governed in all environments.
- **Production blockers:** audit can never be bypassed or edited; no deletion of evidence.
- **Priority:** P1 (read-only timeline), approvals Future.

### 15.17 Policies & Guardrails
- **Purpose:** registry of guardrail policies and their evaluation outcomes.
- **Primary users:** Security Administrator; BCP Owner.
- **Current state:** Planned.
- **Future state:** policy registry that gates governed actions.
- **Read-only:** policy inventory, guardrail evaluation outcomes (pass/fail booleans).
- **Write-capable:** future policy edits — approval-required, separation-of-duties.
- **Approval:** policy changes approval-required.
- **Audit:** policy changes audited.
- **Environment restrictions:** DEV-first; production stricter.
- **Production blockers:** no weakening of guardrails in production from BCP until separately approved.
- **Priority:** P2.

### 15.18 Deployments & Releases
- **Purpose:** observe deployment/release state; govern promotions (future).
- **Primary users:** Operations Administrator; BCP Owner (approver).
- **Current state:** Planned (read-only).
- **Future state:** governed, approval-gated promotion.
- **Read-only:** release inventory, deployment status, environment promotion state.
- **Write-capable:** future promote/rollback — approval-required, separation-of-duties.
- **Approval:** promotion approval-required.
- **Audit:** promotions/rollbacks audited.
- **Environment restrictions:** DEV-first; production-blocked.
- **Production blockers:** no production promotion from BCP until separately approved.
- **Priority:** P3.

### 15.19 Environments & Infrastructure
- **Purpose:** observe environment groups (DEV/STAGING/PRODUCTION) and infrastructure posture.
- **Primary users:** Operations Administrator; Database Administrator; BCP Owner.
- **Current state:** Planned.
- **Future state:** governed environment/infrastructure controls.
- **Read-only:** environment group inventory, infra posture, production-lock status.
- **Write-capable:** future infra controls — approval-required.
- **Approval:** infra changes approval-required.
- **Audit:** infra changes audited.
- **Environment restrictions:** production controls blocked.
- **Production blockers:** production infra changes forbidden from BCP until separately approved.
- **Priority:** P3.

### 15.20 Backups & Recovery
- **Purpose:** observe backup status and recovery points by tenant/store/environment; govern recovery (future).
- **Primary users:** Database Administrator; BCP Owner (approver).
- **Current state:** Planned (read-only).
- **Future state:** governed restore with strict approval and separation-of-duties.
- **Read-only:** backup status, recovery-point availability, retention posture.
- **Write-capable:** future restore — approval-required, separation-of-duties, DEV-first.
- **Approval:** restore mandatory approval + distinct approver.
- **Audit:** restore lifecycle audited.
- **Environment restrictions:** DEV-first; production-blocked.
- **Production blockers:** no production restore from BCP until separately approved.
- **Priority:** P3 (read-only), restore Future.

### 15.21 Support / Operator Tools
- **Purpose:** safe, bounded operator helpers (lookups by opaque reference, redacted diagnostics).
- **Primary users:** Support Operator; Operations Administrator.
- **Current state:** Planned (read-only, heavily bounded).
- **Future state:** bounded, audited support actions.
- **Read-only:** redacted lookups by opaque reference, safe diagnostics (no PII, no raw identifiers).
- **Write-capable:** future bounded actions — request-only / approval-required.
- **Approval:** any mutating support action approval-required.
- **Audit:** all support actions audited.
- **Environment restrictions:** DEV-first; production read-only/blocked.
- **Production blockers:** no raw identity/secret access; no impersonation; no authority bypass.
- **Priority:** P3.

### 15.22 Control Plane Settings
- **Purpose:** BCP configuration (display preferences, governance configuration that is itself governed).
- **Primary users:** BCP Owner; Security Administrator.
- **Current state:** Planned.
- **Future state:** governed configuration of the BCP itself.
- **Read-only:** current settings, governance configuration posture.
- **Write-capable:** future settings changes — approval-required where they affect safety.
- **Approval:** safety-relevant settings approval-required.
- **Audit:** settings changes audited.
- **Environment restrictions:** governed in all environments.
- **Production blockers:** no setting may disable audit, approval, production lock, or redaction.
- **Priority:** P3.

## 16. Read-Only vs Write-Capable vs Approval-Required Actions (Action Safety Model)

All actions are classified into ten categories. Each is illustrated with conceptual examples only (nothing implemented):

1. **Read-only** — non-mutating observation. Examples: viewing health tiles; viewing the redacted audit timeline; viewing registry posture; viewing isolation maps; viewing aggregate API rates.
2. **Request-only** — an operator may request but not execute; the request enters a queue. Examples: requesting a service restart; requesting a job retry; requesting a tenant DB provisioning.
3. **Approval-required** — execution requires explicit approval. Examples: applying a DEV migration; locking/unlocking a registry entry; rotating a secret (posture-governed).
4. **Separation-of-duties-required** — requester and approver must be distinct actors. Examples: identity-link create/disable/revoke; database provisioning; backup restore; scoped-access grant.
5. **DEV-only** — permitted only in DEV. Examples: identity-link writes; DEV schema apply; DEV provisioning.
6. **Staging-limited** — permitted in STAGING under approval, more restricted than DEV. Examples: staging migration apply; staging promotion rehearsal.
7. **Production-blocked** — disallowed in production until separately approved. Examples: production DB writes; production migration apply; production provisioning; production restore.
8. **Future-only** — designed but not yet built; not executable now. Examples: governed provisioning pipeline; governed restore; governed promotion.
9. **Emergency-only** — reserved for an Emergency Operator under heightened audit and post-hoc review. Examples: emergency containment of a runaway job (still audited, still bounded).
10. **Forbidden** — never allowed from the BCP. Examples: a general raw-SQL console; displaying secret values; bypassing audit; bypassing approval; raw token/header/body inspection; making server authorization authoritative; wiring M11/M15/M17.1 into runtime; self-service identity linking; direct mutation of provider identity mappings outside the controlled workflow.

## 17. DEV / STAGING / PRODUCTION Environment Model

- **DEV** — the only environment where governed write capabilities (still approval-required and separation-of-duties where dangerous) may first exist; identity-link writes, when ever built, are DEV-only.
- **STAGING** — a more restricted rehearsal environment; approval-required for any write; production-shaped guardrails apply.
- **PRODUCTION** — read-only-first and production-blocked for dangerous actions; production write/control actions are blocked until separately approved through governed workflow; a visible production lock is always present.

Environment scope is global (selected in the banner) and applied to every module, screen, and action. The environment indicator and production lock are always visible.

## 18. Production Blockers and Dangerous Action Rules

- Production-affecting writes, schema changes, provisioning, restores, promotions, service/worker control, and identity-link writes are **blocked in production** until separately approved through governed workflow.
- **Destructive** schema changes are forbidden (any environment) from the BCP.
- A **general raw-SQL console** is forbidden for all roles.
- **Secret values** are never displayed; only posture.
- **Direct production DB writes** are forbidden from the BCP.
- **Identity-link writes in production** are forbidden.
- **Self-service identity linking** is forbidden.
- **Bypassing audit** or **bypassing approval** is forbidden.
- **Raw token/header/body** inspection is forbidden.
- **Direct mutation of provider identity mappings** outside the controlled workflow is forbidden.
- Making **server authorization authoritative** from the BCP is forbidden.
- **Wiring M11/M15/M17.1** into runtime from the BCP is forbidden.
- The production lock can only be lifted for a specific, approved, time-bounded, audited action — never globally, never by a single actor.

## 19. RBAC and Role Model

Ten BCP roles. For each: view / request / approve / execute / cannot do / production access / emergency actions / audit. (All conceptual; no role is provisioned by this document.)

### 19.1 Backend Control Plane Owner
- **View:** all modules. **Request:** all. **Approve:** all (subject to separation-of-duties — cannot approve own request). **Execute:** governed actions post-approval where designed. **Cannot:** bypass audit, bypass separation-of-duties, display secrets, make server auth authoritative. **Production:** governed access; production actions still require separate approval. **Emergency:** may authorize emergency operations (audited). **Audit:** all owner actions audited.

### 19.2 Platform Administrator
- **View:** most operational and tenancy modules. **Request:** operational and provisioning actions. **Approve:** limited (not own requests; not security-critical without Security Admin). **Execute:** approved operational actions (DEV-first). **Cannot:** approve own requests; access secrets values; production-block bypass. **Production:** read-only by default. **Emergency:** no. **Audit:** all actions audited.

### 19.3 Database Administrator
- **View:** database, schema, migration, backup, isolation modules. **Request:** provisioning, migration apply, restore (DEV-first). **Approve:** no (separation-of-duties — execution requires distinct approver). **Execute:** approved DB actions (DEV-first). **Cannot:** destructive schema changes; production writes; raw SQL console; secret display. **Production:** read-only by default. **Emergency:** no. **Audit:** all actions audited.

### 19.4 Security Administrator
- **View:** identity, access, secrets posture, policies, audit, isolation. **Request:** policy/guardrail and access governance changes. **Approve:** security-relevant requests (not own). **Execute:** approved security configuration. **Cannot:** display secret values; weaken audit/approval/redaction; make server auth authoritative. **Production:** governed, stricter. **Emergency:** may co-authorize emergency containment. **Audit:** all actions audited.

### 19.5 Operations Administrator
- **View:** services, jobs, API, logs, deployments, environments. **Request:** service/job control, promotions. **Approve:** limited operational approvals (not own). **Execute:** approved operational actions (DEV-first). **Cannot:** DB/schema/identity writes; production control without separate approval. **Production:** read-only by default. **Emergency:** may request emergency containment. **Audit:** all actions audited.

### 19.6 Support Operator
- **View:** bounded support tools, redacted lookups. **Request:** bounded support actions. **Approve:** no. **Execute:** only after approval (future bounded actions). **Cannot:** access raw identifiers/PII/secrets; impersonate; mutate identity mappings; production actions. **Production:** read-only/blocked. **Emergency:** no. **Audit:** all actions audited.

### 19.7 Read-Only Auditor
- **View:** read-only across modules including audit timeline. **Request:** no. **Approve:** no. **Execute:** no. **Cannot:** any mutation; see secrets/raw identifiers. **Production:** read-only. **Emergency:** no. **Audit:** elevated views audited.

### 19.8 Approval Reviewer
- **View:** approval queue and the context needed to decide (redacted). **Request:** no. **Approve:** yes, within separation-of-duties (cannot approve own requests; cannot approve outside scope). **Execute:** no (approval ≠ execution). **Cannot:** initiate actions; see secrets/raw identifiers. **Production:** approve only within governed, separately-approved production workflow. **Emergency:** may approve emergency actions if authorized. **Audit:** all approvals/rejections audited.

### 19.9 Emergency Operator
- **View:** scoped to the emergency. **Request:** emergency actions. **Approve:** no (still needs distinct authorization). **Execute:** bounded emergency actions under heightened audit and mandatory post-hoc review. **Cannot:** destructive/forbidden actions; bypass audit; persist elevated access. **Production:** only the specific approved emergency action; time-bounded. **Emergency:** yes (the defining capability), bounded and audited. **Audit:** maximal audit; mandatory post-incident review.

### 19.10 Scoped Contributor
- **View:** only granted modules/scope. **Request:** only granted action types. **Approve:** no. **Execute:** only granted, approved actions within scope and duration. **Cannot:** anything outside granted scope; secrets; production unless explicitly granted and separately approved. **Production:** only if explicitly granted and separately approved. **Emergency:** no. **Audit:** all actions audited.

## 20. Owner-Granted Scoped Access Model

Access is **granted by the owner** and scoped along these axes:

- **By environment** — DEV / STAGING / PRODUCTION (production grants are stricter and separately approved).
- **By tenant** — limited to specified tenants (by opaque reference).
- **By store** — limited to specified stores (by opaque reference).
- **By module** — limited to specified BCP modules.
- **By action type** — read-only / request-only / approval / execute (within category limits).
- **By duration** — time-bounded; grants expire and must be renewed.
- **By approval requirement** — whether the granted actions require approval and separation-of-duties (dangerous ones always do).

Grants are themselves auditable; granting/revoking access is approval-required and separation-of-duties-governed; no grant may exceed the role's category limits; no grant may enable a Forbidden action.

## 21. Permission Matrix Model

A conceptual matrix maps roles (rows) to action categories (columns). Cells use safe labels: View (V), Request (R), Approve (A), Execute-after-approval (E), or blank (—). Dangerous columns additionally require separation-of-duties (S) and may be DEV-only (D) or Production-blocked (PB).

| Role | Read-only | Request-only | Approval-required | SoD-required | DEV-only writes | Production |
|---|---|---|---|---|---|---|
| BCP Owner | V | R | A (not own) | A/E (S) | E (D) | governed, separate approval |
| Platform Admin | V | R | A (limited, not own) | — | E (D) | read-only |
| Database Admin | V | R | — | E (S) | E (D) | read-only |
| Security Admin | V | R | A (not own) | A (S) | E (D) | governed, stricter |
| Operations Admin | V | R | A (limited, not own) | — | E (D) | read-only |
| Support Operator | V (bounded) | R (bounded) | — | — | E (post-approval) | read-only/blocked |
| Read-Only Auditor | V | — | — | — | — | read-only |
| Approval Reviewer | V (queue) | — | A (not own) | A (S) | — | approve within governed prod workflow |
| Emergency Operator | V (scoped) | R (emergency) | — | E (S, bounded) | E (bounded) | only approved emergency action |
| Scoped Contributor | V (scoped) | R (scoped) | — | E (if granted, S) | E (if granted) | only if granted + separate approval |

This matrix is a **model**, not an implemented authorization system; it does not change the app's current authority.

## 22. Approval Workflow Model

- **Request** — an authorized requester submits a governed action with safe parameters (opaque references; no secrets; no raw identifiers).
- **Validation** — guardrails/policies evaluate the request; results are recorded as booleans/categories.
- **Approval** — a **distinct** approver (separation-of-duties) approves or rejects; the decision is audited.
- **Execution** — only after approval, and only within environment/scope/duration limits; production execution requires separate approval.
- **Evidence** — the lifecycle (requested → validated → approved → succeeded, or rejected/conflict/idempotent) is recorded as redacted audit evidence.
- **Expiry** — approvals are time-bounded and single-use for the specific action.

## 23. Separation-of-Duties Model

- The **requester** and the **approver** of any dangerous action must be **distinct actors**.
- No actor may approve their own request.
- Security-critical actions may require **two distinct approvers** (e.g., production-affecting or identity-link actions).
- Emergency actions require a distinct authorization and mandatory post-hoc review.
- Separation-of-duties is enforced conceptually via the role/permission/approval model; this document does not implement enforcement.

## 24. Audit and Redacted Evidence Model

- The BCP reuses the existing **append-only** audit capability conceptually; audit is **immutable** (no update/delete) and **never bypassable**.
- Evidence carries only **safe categories and booleans**: action category, outcome (succeeded/rejected/conflict/idempotent/failed), reason-code category, source flow, verification-method label, lifecycle state, policy/approval decision (boolean), environment label, and aggregate-safe context.
- Evidence **never** contains: connection strings, env values, secrets, service-role/anon keys, tokens, Authorization/request headers, request/response bodies, raw identity or audit rows, real Firebase/Supabase/provider UIDs, real `internal_user_id` values, real emails, real tenant/store/customer names, real domains, real IPs, real request IDs, actor UUIDs, audit metadata dumps, permission/entitlement key lists, mismatch lists, or raw authorization objects.
- The audit timeline is presented as a redacted, immutable evidence view; approvals/rejections are themselves audited.

## 25. Database-Per-Tenant and Database-Per-Store Architecture (Future)

The long-term direction is **database-level isolation**. This document **discusses** but does **not implement** it. The future model:

- Each **tenant** may have its own isolated database.
- Each **store** may have its own isolated database **or** a store-scoped isolation unit.
- **Shared reference/control metadata** may exist where needed (e.g., the control registry).
- **Audit evidence** is **centrally governed** (not per-tenant scattered).
- **Backups and recovery** can be tracked **by tenant and by store**.
- **Environment-specific database groups** exist for DEV / STAGING / PRODUCTION.

State labeling is mandatory: database-per-tenant and database-per-store are **Future** and **not implemented**; the document must not claim otherwise. Today's reality (Current) is the DEV `identity_link` table existing and empty, RLS-protected, with zero client policies and zero client-role grants, and the existing append-only audit capability.

## 26. Tenant and Store Provisioning Governance

Provisioning is **Future** and governed end-to-end by approval, separation-of-duties, environment restriction (DEV-first), and audit. The conceptual provisioning wizard (planning only, not implemented):

1. Select scope: tenant or store.
2. Select the tenant/store (by opaque reference).
3. Select the isolation policy.
4. Select the schema template.
5. Validate guardrails (results recorded as booleans/categories).
6. Owner approval (separation-of-duties; distinct approver).
7. Provision the database (DEV-first; production-blocked).
8. Write redacted audit evidence (lifecycle categories).
9. Verify the backup policy.
10. Confirm monitoring registration.

No step of this wizard is implemented here; it is a governance blueprint only.

## 27. Database Registry and Database Control UX

The registry/control surfaces (read-only first) present:

- **Tenant database registry** and **store database registry** (by opaque reference).
- **Database isolation map** (topology of environment → tenant → store).
- **Database health**, **schema version**, **migration state** (labels).
- **RLS posture**, **backup status**, **masked-connection posture** (badges; never connection strings).
- **Locked/unlocked state** of registry entries.
- **Provisioning pipeline** state (Future).
- **Approval requirements** and **audit evidence** links.
- **Rollback/recovery relationship** (linkage to Backups & Recovery).

Badges to standardize: "RLS Protected", "Masked Connection", "Isolated DB", "Locked", "DEV-Only", "Production-Blocked". No secret or connection material is ever shown.

## 28. Schema and Migration Governance

- A **migration viewer** (read-only) shows inventory, applied/pending state, and schema-version labels.
- Future **migration application** is DEV-first, approval-required, separation-of-duties-governed, and never destructive; production apply is blocked until separately approved.
- Migration evidence is redacted (categories/booleans), aligning with the existing append-only audit posture.
- The 004 `identity_link` migration is **Current** (exists; applied to DEV as additive schema; table empty) and is **not modified** by this document.

## 29. Services / Jobs / Workers / API / Logs / Telemetry Model

- **Services:** health panels (read-only first); future restart/scale is request-only / approval-required, DEV-first, production-blocked.
- **Jobs & Workers:** queue/worker observation (read-only first); future pause/retry/cancel is request-only / approval-required.
- **API Traffic:** aggregate rates and error rates only; no raw headers, bodies, or payloads ever.
- **Logs & Telemetry:** redacted streams and aggregates; no secrets or raw identifiers ever.
- All control actions are audited; production control is blocked until separately approved.

## 30. Identity and Access Governance

- The BCP governs **its own** roles and owner-granted scoped access; it does **not** govern or replace the app's authority model.
- The app's Firebase / AccessContext authority is unchanged; server-derived authorization remains observational.
- Grants/revocations are approval-required and separation-of-duties-governed; actor identities are never surfaced (opaque references only).
- The BCP must never make server authorization authoritative and never wire the dormant chain.

## 31. Identity Link Governance

Aligned with M20.11 and M20.12, the planning record states:

- The **Identity Links** module is **future-controlled and currently dormant**.
- The DEV `identity_link` table **exists and remains empty**.
- **RLS is enabled.**
- **Zero client policies.**
- **Zero client-role grants.**
- The admin provisioning service is **server-only, default-OFF, and unwired** (imported only by its own test).
- Future repository/audit adapters are **planned but not implemented**.
- All write actions remain **DEV-only, approval-required, default-OFF, and production-blocked**.
- **Raw Firebase UID** must not be shown.
- **Raw Supabase UID** must not be shown.
- **Raw provider UID** must not be shown.
- **Raw `internal_user_id`** must not be shown.
- **Email** must not be identity authority.
- **Client-supplied UID** must not be authority.
- Only **opaque references and redacted evidence** are surfaced.
- **Self-service identity linking** remains deferred and forbidden from the BCP.

## 32. Configuration and Secrets Posture

- The BCP shows **posture only**: whether configuration is set, rotation status, and a last-rotated category — never values.
- Secret values, env values, connection strings, service-role/anon keys, and tokens are **never displayed** in any environment.
- Future rotation is approval-required and separation-of-duties-governed; production rotation is blocked until separately approved.
- Rotation evidence contains no secret material.

## 33. Deployments and Releases Governance

- Read-only observation of release/deployment/promotion state first.
- Future promote/rollback is approval-required, separation-of-duties-governed, DEV-first; production promotion is blocked until separately approved.
- Promotions/rollbacks are audited with safe categories.

## 34. Environments and Infrastructure Governance

- Read-only observation of environment groups (DEV/STAGING/PRODUCTION) and infrastructure posture, with a visible production lock.
- Future infra controls are approval-required; production infra changes are blocked until separately approved.
- A setting may never disable audit, approval, the production lock, or redaction.

## 35. Backups and Recovery Governance

- Read-only observation of backup status and recovery points by tenant/store/environment first.
- Future restore is approval-required, separation-of-duties-governed (often two approvers), DEV-first; production restore is blocked until separately approved.
- Restore lifecycle is audited with safe categories; recovery relationships link to the Database Registry.

## 36. Policies and Guardrails Registry

- A registry of guardrail policies and their evaluation outcomes (pass/fail booleans).
- Policies gate governed actions (e.g., provisioning, migration apply, identity-link writes).
- Policy edits are approval-required and separation-of-duties-governed; no weakening of guardrails in production from the BCP until separately approved.
- Guardrails may never be set to bypass audit, approval, redaction, or the production lock.

## 37. Support / Operator Tools Boundary

- Support tools are **read-only first** and heavily bounded: redacted lookups by opaque reference and safe diagnostics only.
- No raw identifiers, PII, secrets, tokens, headers, or bodies; no impersonation; no identity-mapping mutation; no authority bypass.
- Future bounded support actions are request-only / approval-required and fully audited.

## 38. Control Plane Settings

- BCP configuration is itself governed: safety-relevant settings are approval-required.
- No setting may disable audit, approval, the production lock, redaction, or separation-of-duties.
- Settings changes are audited.

## 39. Visual Architecture Direction

Synthesized from the reviewed references: the **latest Stitch** design is the **visual baseline**; **AI Studio** designs inform **module completeness and interactions**; **Stitch Version 2 Original** informs **operational realism**. The final direction combines all and copies none.

Visual direction:

- Premium **dark command-center shell**.
- **Separate secure access gate** with its own atmosphere ("Obsidian / Nexus / Guardian Core").
- **Infrastructure topology diagrams** (environment → tenant → store → database).
- **High-density enterprise cards and tables**; polished dark panels.
- **Subtle neon status indicators** for health/posture.
- **Guarded action buttons** (visibly distinct; disabled/blocked states clear).
- **Environment badges** and a persistent **production lock**.
- **Read-only / elevated mode** indicator, always visible.
- **Approval queue** surface and an **immutable audit timeline**.
- **Tenant/store/database isolation map**.
- A serious, **operator-console** aesthetic.
- A **bottom safety footer**: "Separate Secure Workspace", "RLS Protected", "Masked Connection".

State chips standardized across the UI: **Current**, **Planned**, **Future**, **Dormant**, **Read-Only-First**, **Production-Blocked**. These chips make capability maturity unmistakable on every screen.

## 40. Screen-by-Screen UX Blueprint

For each screen: purpose; main layout; key panels; key tables/cards; primary badges; allowed actions; blocked actions; audit requirements; implementation phase. (Conceptual; nothing implemented.)

### 40.1 Separate Access Gate
- **Purpose:** establish a scoped BCP session distinct from the app.
- **Layout:** centered secure gate over dark atmosphere.
- **Panels:** authentication posture; granted-scope summary (opaque); mode selection (read-only vs elevated).
- **Cards:** role-profile access cards (conceptual).
- **Badges:** environment, production lock, mode.
- **Allowed:** authenticate; select read-only/elevated mode within grant.
- **Blocked:** any secret/identifier display; access beyond grant.
- **Audit:** elevated-mode session establishment audited.
- **Phase:** Planned/Future (Phase 2+).

### 40.2 Command Center
- **Purpose:** at-a-glance posture and governance status.
- **Layout:** grid of posture tiles + recent-activity timeline.
- **Panels:** environment status; pending approvals; recent audit summary (redacted).
- **Cards:** health tiles; posture tiles.
- **Badges:** environment, production lock, state chips.
- **Allowed:** view; navigate.
- **Blocked:** any mutation.
- **Audit:** elevated views audited.
- **Phase:** P1 (first read-only screen).

### 40.3 Operations Console
- **Purpose:** cross-domain triage overview.
- **Layout:** multi-pane (services / jobs / API / logs summaries).
- **Panels:** health summaries; queue depths (aggregate); recent incidents (redacted).
- **Cards:** domain status cards.
- **Badges:** environment; severity; state chips.
- **Allowed:** view; drill-through (read-only).
- **Blocked:** control actions (until Future, request-only).
- **Audit:** elevated views audited.
- **Phase:** P2.

### 40.4 Tenants
- **Purpose:** observe tenant inventory and isolation posture.
- **Layout:** table + detail drawer.
- **Panels:** tenant list (opaque); isolation posture; DB-mapping status.
- **Cards:** tenant posture cards.
- **Badges:** RLS Protected; Isolated DB; environment; state chips.
- **Allowed:** view.
- **Blocked:** provisioning (Future, approval-required).
- **Audit:** provisioning lifecycle (Future) audited.
- **Phase:** P3 (read-only).

### 40.5 Stores
- **Purpose:** observe store inventory and store-scoped isolation.
- **Layout:** table + detail drawer.
- **Panels:** store list (opaque); isolation unit posture; DB-mapping status.
- **Cards:** store posture cards.
- **Badges:** RLS Protected; Isolated DB; environment; state chips.
- **Allowed:** view.
- **Blocked:** provisioning (Future).
- **Audit:** provisioning lifecycle (Future) audited.
- **Phase:** P3 (read-only).

### 40.6 Tenant Isolation Debugger
- **Purpose:** verify/visualize isolation posture.
- **Layout:** isolation map + checks panel.
- **Panels:** isolation map; RLS-posture checks (booleans); boundary checks.
- **Cards:** check-result cards.
- **Badges:** RLS Protected; Masked Connection; pass/fail.
- **Allowed:** view.
- **Blocked:** any mutation.
- **Audit:** elevated views audited.
- **Phase:** P2.

### 40.7 Database Registry
- **Purpose:** catalog databases with posture metadata.
- **Layout:** registry table + detail drawer + topology map.
- **Panels:** registry list; posture detail; isolation map.
- **Cards:** database posture cards.
- **Badges:** RLS Protected; Masked Connection; Isolated DB; Locked; DEV-Only; Production-Blocked.
- **Allowed:** view.
- **Blocked:** lock/unlock/register (Future, approval-required); any connection-string display (always).
- **Audit:** registry changes (Future) audited.
- **Phase:** P2 (read-only).

### 40.8 Database Control
- **Purpose:** governed orchestration (Future).
- **Layout:** pipeline view + guardrail panel + approval drawer.
- **Panels:** orchestration status; guardrail evaluation (booleans); approval status.
- **Cards:** pipeline-stage cards.
- **Badges:** DEV-Only; Production-Blocked; Future; approval state.
- **Allowed:** view (now); request/approve/execute (Future, governed).
- **Blocked:** any execution now; destructive/production orchestration (always until separately approved).
- **Audit:** full lifecycle (Future) audited.
- **Phase:** Future.

### 40.9 Schema & Migrations
- **Purpose:** observe schema/migration state; govern apply (Future).
- **Layout:** migration table + detail.
- **Panels:** migration inventory; applied/pending; schema-version labels.
- **Cards:** migration-state cards.
- **Badges:** applied/pending; DEV-Only; Production-Blocked.
- **Allowed:** view.
- **Blocked:** apply now; destructive changes (always); production apply (until separately approved).
- **Audit:** apply lifecycle (Future) audited.
- **Phase:** P3 (viewer).

### 40.10 Services
- **Purpose:** service health.
- **Layout:** health panels grid.
- **Panels:** service health; recent events (redacted).
- **Cards:** service health cards.
- **Badges:** health; environment; state chips.
- **Allowed:** view.
- **Blocked:** restart/scale now (Future, request-only/approval-required); production control (until separately approved).
- **Audit:** control actions (Future) audited.
- **Phase:** P2 (read-only).

### 40.11 Jobs & Workers
- **Purpose:** observe jobs/queues/workers.
- **Layout:** queue table + worker panel.
- **Panels:** queue depths; worker status; job outcomes (aggregate).
- **Cards:** worker status cards.
- **Badges:** health; environment; state chips.
- **Allowed:** view.
- **Blocked:** pause/retry/cancel now (Future); production control (until separately approved).
- **Audit:** control actions (Future) audited.
- **Phase:** P2 (read-only).

### 40.12 API Traffic
- **Purpose:** observe aggregate API health.
- **Layout:** rate charts + endpoint table.
- **Panels:** request-rate aggregates; error-rate aggregates; endpoint health.
- **Cards:** endpoint health cards.
- **Badges:** health; environment.
- **Allowed:** view aggregates.
- **Blocked:** any raw header/body/payload inspection (always).
- **Audit:** elevated views audited.
- **Phase:** P3.

### 40.13 Logs & Telemetry
- **Purpose:** redacted logs/telemetry.
- **Layout:** stream view + filters.
- **Panels:** redacted log streams; telemetry aggregates.
- **Cards:** telemetry summary cards.
- **Badges:** environment; severity.
- **Allowed:** view redacted streams.
- **Blocked:** any secret/raw-identifier exposure (always).
- **Audit:** elevated log views audited.
- **Phase:** P3.

### 40.14 Identity & Access
- **Purpose:** govern BCP roles and scoped grants.
- **Layout:** role table + grant drawer.
- **Panels:** role inventory; active scoped grants (opaque); access posture.
- **Cards:** role/grant cards.
- **Badges:** scope; duration; environment; state chips.
- **Allowed:** view.
- **Blocked:** grant/revoke now (Future, approval-required); surfacing actor identities (always).
- **Audit:** grant/revoke lifecycle (Future) audited.
- **Phase:** P2.

### 40.15 Identity Links
- **Purpose:** govern future identity-link lifecycle (dormant).
- **Layout:** link status table (opaque) + redacted audit timeline.
- **Panels:** link lifecycle status; redacted audit timeline; conflict/idempotency categories (booleans); aggregate counts.
- **Cards:** lifecycle-state cards.
- **Badges:** Dormant; DEV-Only; Production-Blocked; approval state.
- **Allowed:** view redacted status (DEV table empty).
- **Blocked:** create/disable/revoke now (Future, DEV-only, approval-required, separation-of-duties); raw Firebase/Supabase/provider UID and raw `internal_user_id` display (always); self-service linking (always); production writes (always).
- **Audit:** redacted taxonomy (Future) audited.
- **Phase:** Future (governed); read-only status surface Planned.

### 40.16 Configuration & Secrets Posture
- **Purpose:** posture-only configuration/secrets view.
- **Layout:** posture table.
- **Panels:** posture indicators (set/unset, rotation status, last-rotated category).
- **Cards:** posture cards.
- **Badges:** posture; environment; state chips.
- **Allowed:** view posture.
- **Blocked:** any value display (always); rotation now (Future, approval-required); production rotation (until separately approved).
- **Audit:** rotation lifecycle (Future) audited.
- **Phase:** P3.

### 40.17 Audit & Approvals
- **Purpose:** immutable redacted audit timeline + approval queue.
- **Layout:** timeline + approval queue panel.
- **Panels:** audit timeline (safe categories/booleans); approval queue.
- **Cards:** approval request cards (redacted).
- **Badges:** outcome category; approval state; environment.
- **Allowed:** view timeline; approve/reject (Future, separation-of-duties).
- **Blocked:** editing/deleting evidence (always); approving own request (always); bypassing audit/approval (always).
- **Audit:** approvals/rejections themselves audited; append-only.
- **Phase:** P1 (timeline), approvals Future.

### 40.18 Policies & Guardrails
- **Purpose:** guardrail registry and outcomes.
- **Layout:** policy table + evaluation panel.
- **Panels:** policy inventory; guardrail outcomes (booleans).
- **Cards:** policy cards.
- **Badges:** pass/fail; environment; state chips.
- **Allowed:** view.
- **Blocked:** policy edits now (Future, approval-required); weakening guardrails in production (until separately approved); disabling audit/approval/redaction/production-lock (always).
- **Audit:** policy changes (Future) audited.
- **Phase:** P2.

### 40.19 Deployments & Releases
- **Purpose:** observe release/deployment state.
- **Layout:** release table + promotion panel.
- **Panels:** release inventory; deployment status; promotion state.
- **Cards:** release cards.
- **Badges:** environment; promotion state; state chips.
- **Allowed:** view.
- **Blocked:** promote/rollback now (Future, approval-required); production promotion (until separately approved).
- **Audit:** promotions/rollbacks (Future) audited.
- **Phase:** P3.

### 40.20 Environments & Infrastructure
- **Purpose:** observe environment groups and infra posture.
- **Layout:** environment grid + infra panel.
- **Panels:** environment group inventory; infra posture; production lock.
- **Cards:** environment cards.
- **Badges:** environment; production lock; state chips.
- **Allowed:** view.
- **Blocked:** infra controls now (Future, approval-required); production infra changes (until separately approved).
- **Audit:** infra changes (Future) audited.
- **Phase:** P3.

### 40.21 Backups & Recovery
- **Purpose:** observe backup/recovery state; govern restore (Future).
- **Layout:** backup table + recovery panel.
- **Panels:** backup status; recovery-point availability; retention posture.
- **Cards:** backup/recovery cards.
- **Badges:** backup status; DEV-Only; Production-Blocked.
- **Allowed:** view.
- **Blocked:** restore now (Future, approval-required, separation-of-duties); production restore (until separately approved).
- **Audit:** restore lifecycle (Future) audited.
- **Phase:** P3 (read-only).

### 40.22 Support / Operator Tools
- **Purpose:** bounded, redacted operator helpers.
- **Layout:** lookup panel + diagnostics panel.
- **Panels:** redacted lookups (opaque); safe diagnostics.
- **Cards:** result cards (redacted).
- **Badges:** bounded; environment; state chips.
- **Allowed:** view redacted lookups/diagnostics.
- **Blocked:** raw identifier/PII/secret access (always); impersonation (always); identity-mapping mutation (always); mutating actions now (Future, approval-required).
- **Audit:** all support actions (Future) audited.
- **Phase:** P3.

### 40.23 Control Plane Settings
- **Purpose:** governed BCP configuration.
- **Layout:** settings panel.
- **Panels:** current settings; governance configuration posture.
- **Cards:** settings cards.
- **Badges:** safety-relevant; state chips.
- **Allowed:** view.
- **Blocked:** safety-relevant changes now (Future, approval-required); disabling audit/approval/production-lock/redaction/separation-of-duties (always).
- **Audit:** settings changes (Future) audited.
- **Phase:** P3.

## 41. Current Safe First Implementation Boundary

The recommended first implementation milestone after this planning document is:

**Backend Control Plane — Read-Only Shell / UI Foundation.**

The first build must be:

- **UI-only or mock-data-only.**
- A **separate route/shell** (only if separately approved later).
- **No DB writes.**
- **No real backend actions.**
- **No identity-link writes.**
- **No migration execution.**
- **No production controls.**
- **No secrets display.**
- **No raw SQL console.**
- **No service restart.**
- **No worker restart.**
- **No backup restore.**
- **No tenant/store DB creation.**
- **No change to the existing Owner Platform UI.**
- **No change to current authorization behavior.**
- **No runtime identity mapping.**

In other words: the first build renders the shell, navigation, environment banner, safety footer, command palette (navigation/filter only), and a small set of read-only screens (Command Center; Audit & Approvals timeline) using safe mock data only — and nothing else.

## 42. Future Implementation Roadmap

- **Phase 0 (this milestone, M21):** charter, governance, IA, module model, access model, visual direction, blueprint, roadmap — planning only.
- **Phase 1 — Read-Only Shell / UI Foundation:** UI-only/mock-only shell + first read-only screens (Command Center; Audit timeline); separate route only if approved; no backend, no DB, no writes.
- **Phase 2 — Read-Only Observability:** add read-only Operations Console, Tenant Isolation Debugger, Database Registry (posture-only), Services/Jobs/API/Logs read-only — still mock/redacted; no writes.
- **Phase 3 — Governance Surfaces (read-only + request-only):** Approval queue surface, Policies & Guardrails registry, Identity & Access read-only, request-only intake (no execution).
- **Phase 4 — Governed DEV Writes (approval + separation-of-duties):** DEV-only, approval-required, separation-of-duties-governed writes for the safest domains first (e.g., governed identity-link admin provisioning DEV-only), each its own owner-approved milestone with tests and security review.
- **Phase 5 — Governed Provisioning & Recovery (DEV-first):** tenant/store provisioning wizard and restore workflows, DEV-first, approval-gated, production-blocked.
- **Phase 6 — STAGING extension and production-blocked posture hardening:** staging rehearsal under approval; production remains blocked until separately approved.
- **Production:** remains blocked across all phases until separately approved through governed workflow.

Each phase is a separate, owner-approved milestone; nothing advances automatically.

## 43. Manual QA and Evidence Requirements

For any future implementation phase (not this one):

- Verify the BCP is a **separate** workspace with a **separate** gate; it does not appear inside the Owner Platform UI.
- Verify the environment indicator, mode indicator, production lock, and safety footer are always present.
- Verify all first-phase screens are **read-only** with **mock/redacted** data only.
- Verify **no** secret value, connection string, token, raw header/body, or raw identifier is ever rendered.
- Verify state chips (Current/Planned/Future/Dormant/Read-Only-First/Production-Blocked) are accurate per screen.
- Verify the current app's authority model is unchanged and the dormant chain stays dormant.
- Capture redaction-safe evidence only (counts/booleans/categories); never raw identifiers or secrets.

## 44. Risks and Open Decisions

- **Separation discipline:** the BCP must not drift into the Owner Platform; route/shell separation must be enforced when built.
- **State-label honesty:** capability maturity chips must never overstate readiness.
- **Redaction discipline:** posture-only surfaces must never leak values or identifiers; this is the highest-risk area.
- **Approval/SoD enforcement:** the conceptual model must be implemented as real enforcement before any write capability ships.
- **Scope creep:** the read-only-first boundary must hold; write capabilities must each be separately approved.
- **Open decisions (for owner):** whether the BCP shares any infrastructure with the app or is fully isolated; the exact authentication posture for the gate; whether STAGING exists yet; the precise first read-only screen set; and whether Phase 1 uses a separate route at all (default: not until separately approved).

## 45. Explicitly Forbidden Conclusions

This document does **not** claim, and explicitly denies, any of the following:

- That the Backend Control Plane is implemented.
- That a Backend Control Plane route exists.
- That a Backend Control Plane UI exists in the app.
- That the Owner Platform has been changed.
- That database-per-tenant is implemented.
- That database-per-store is implemented.
- That database control actions are live.
- That the repository adapter is implemented.
- That the audit adapter is implemented.
- That identity links have been created.
- That identity mapping is active.
- That server authorization is authoritative.
- That the frontend should consume server authorization now.
- That production actions are ready.
- That a raw SQL console is approved.
- That secrets can be displayed.
- That direct DB writes are approved.
- That M11/M15/M17.1 should be wired.
- That self-service identity linking is approved.
- That email is safe as identity authority.
- That a client-supplied UID is safe as authority.

This document affirms: this is **planning only**; **no UI** has been implemented; **no backend action** has been implemented; **no database action** has been implemented; **no DB connection** occurred; **no rows** were inserted; **no runtime behavior** changed; the Backend Control Plane must be **separate** from the Owner Platform; the **first implementation** should be **read-only / mock-only**; dangerous actions remain **blocked, dormant, or future-only**; and **production remains blocked** until separately approved.

## 46. Recommended Next Milestones

- **Phase 1.6 M21 — Scoped Commit and Backup Authorization** (commit/back up this plan, owner-gated). Recommended immediately if M21 is accepted.

After M21 is backed up, the next planning/build decision should be one of:

- **Option A:** Backend Control Plane — Read-Only Shell / UI Foundation **Planning**.
- **Option B:** Backend Control Plane — Read-Only Shell / UI Foundation **Implementation**.
- **Option C:** Return to **M20.13 Identity Link DEV Repository & Audit Adapter Implementation**.

No commit, push, or backup is performed by this milestone. Stop for owner review.
