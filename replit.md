# Overview

This project is a multi-tenant SaaS frontend platform designed to provide small to medium-sized businesses with a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing. Its primary purpose is to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture. The platform aims to enhance efficiency and decision-making for businesses.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# Current Project State

-   **Current accepted checkpoint**: Phase 1.1.3D (Audit Investigation Center) is **accepted**.
-   **Latest work**: Phase 1.2F **Domain Control Panel Architecture Reset — Milestone 0 (Domain Object Model Foundation)**. The 1.2E control-panel direction was rejected; 1.2F resets the architecture starting with a richer LOCAL/MANUAL domain object model so future screens are not shallow tabs. **Model/helper/storage/seed only — NO UI, NO Platform Settings, NO real integrations/automation.** Added `DnsRecord` (intended-state zone mirror), `DomainRegistrarInfo`, and a manual SSL/security overlay (`DomainSecurityRecord`) to `src/owner/mockData.ts` with mixed-state seed data; added deterministic helpers + sibling sessionStorage stores (`tenant_dns_records_v1`, `tenant_domain_registrar_v1`, `tenant_domain_security_v1`) in `src/owner/platformOpsDomainModel.ts` (DNS zone, Email DNS, SSL view, registrar/security/portfolio/overview/troubleshooting/audit-summary). Base `tenant_domains_v1` store NOT migrated; existing derivations reused (no drift); no new permission keys; future audit-action constants defined but NOT emitted. Typecheck stable at the 12 pre-existing baseline errors. **Phase 1.2 / 1.2E remain PASS/HOLD — not accepted; Phase 1.3 not started; Milestone 1 (UI) not started.**
-   **Prior work**: Phase 1.2E **Domains Control Center UX Maturity — Milestone 5 (Documentation + Final Non-Regression Verification)** — closes out Phase 1.2E. **Documentation/verification only — no code or behavior changes.** Consolidated the M1–M5 implementation history in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md), and verified no regressions across the Domains split-pane control panel, Domains DNS/SSL/Security workspaces, Platform Settings Control Center, Default Baseline Manager, Change Review Center, Command Center Intelligence, Support Queue/SLA/Macro, Audit Investigation Center, escalation operating model, permission dependency auto-sync, Add-on Governance, Shipping, Store Permissions Matrix, tenant provisioning, paid override invoice workflow, and server PII logging. Typecheck stable at the 12 pre-existing baseline errors (owner Platform Settings/Domains files clean). **Phase 1.2E done — pending acceptance; next is Phase 1.3.**
-   **Prior milestone**: Phase 1.2E **Milestone 4 (Default Baseline Manager + Change Review Center Polish)** — Customized Defaults card (saved-baseline vs registry-default diff with high-risk-customized flagging), a consolidated **Change Review Center** modal (every unsaved change across all groups, derived from the unfiltered change sets so filters can never hide a pending change, still saving per group through the existing review/save handlers), and a read-only **Recent Configuration Changes** card (mirrored audit rows + deep-link to Audit & Security). Pure presentation/navigation; storage keys, audit, reset, high-risk ack, and `edit_platform_settings` gating unchanged. **Accepted.**
-   **Prior milestone**: Phase 1.2E **Milestone 3 (Platform Settings Control Center Layout)** — replaced the 2-way `mode` toggle with a 3-way `workspace` (**Overview / Settings Registry / Default Baseline**) plus a registry **Grouped vs Table** view; read-only Overview with clickable metric tiles and by-group/by-enforcement/unsaved breakdowns that deep-link into the registry with visible filter chips, a scannable governance table, and risk/enforcement/modified/customized lens filters. Pure presentation/navigation; no save/default/audit/review/reset/permission change. **Accepted.**
-   **Prior milestone**: Phase 1.2E **Milestone 2 (DNS / SSL / Security Workspaces)** — tabs the right-pane `DomainControlPanel` into **Overview / DNS / SSL/TLS / Security / Help** workspaces; **all mutations stay in Overview** (single mutation surface), other tabs informational only; new in-component, truth-labeled DNS/SSL/troubleshooting derivations leave posture/list/no-drift untouched. **Accepted.**
-   **Prior milestone**: Phase 1.2E **Milestone 1 (Split-Pane Control Panel)** — presentation/layout refactor of the System Owner Domains page into a split-pane control panel (left = grouped Domain Portfolio with nested subdomains + safety-net groups + "Context" rows, no count drift; right = persistent `DomainControlPanel` reused in the mobile slide-over). No new derivations, permission keys, persistence, audit, real DNS/SSL/registrar, or Platform Settings changes. **Accepted.**
-   **Prior correction**: Phase 1.2 **Domain Control Panel + Default Baseline UX Correction** — presentation-layer pass: domain drawer reads as an operator control panel (derived DNS readiness distinct from SSL; SSL live + DNSSEC/domain-lock/transfer-protection as future registrar-level placeholders; registrar-vs-app explanation; root/subdomain-specific framing with inherited-relationship note; a read-only manual action checklist) plus a concise Default Baseline explanation card. No phase reopen, no new permission keys, no real DNS/SSL/DNSSEC/registrar/provider/notifications; all rule-based over `tenant_domains_v1`. Detail in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md).
-   **Prior correction**: Phase 1.2 **Focused Acceptance Correction** — six scoped QA HOLD fixes (lifecycle/posture clickability affordance; three-mode Add-Domain flow; root/subdomain distinction in list+drawer; editable Platform Settings Default Baseline override store with review/audit; Command Center per-domain deep-linking with `?domain`/`?status` handling).
-   **Latest completed phase**: Phase 1.2 (Domains + Platform Settings Maturity) — a deterministic, rule-based maturity pass over the System Owner Domains and Platform Settings surfaces. Domains: a derived lifecycle/readiness model (`platformOpsDomains.ts`) over the shared `tenant_domains_v1` store, with explicit confirmed-and-audited lifecycle actions and manual DNS/SSL guidance (no real DNS/SSL). Platform Settings: a pure governance registry (`platformOpsSettings.ts`, one entry per default field carrying enforcement/risk/owner/impact/truth) and a change-review UX — review-before-save diff, impact preview, high-risk acknowledgment, reset-to-default, search/group nav, and unsaved guard — with one audit row per group save and nothing enforced at runtime. M5 verified Command Center domain signals and Audit coverage remain accurate. NO real DNS/SSL/provisioning/SSO/SCIM/notifications/server-RBAC/realtime/enforcement. **Pending acceptance.**
-   **Next planned phase**: Phase 1.3 — Platform Team Governance (server-side RBAC / PIM / PAM).
-   **Detailed history**: Full long-form implementation notes and correction sequences for all completed Platform Operations & Security phases live in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md). `replit.md` keeps only the high-level overview, locked rules, and roadmap.

# System Architecture

## Frontend

The frontend is built using React 19, TypeScript, Vite 6, and Tailwind CSS v4.

## UI/UX Decisions

-   **Design System**: Features rounded cards, a glass effect, a consistent primary color theme, and a `ghost-border` utility. Typography uses `font-black uppercase tracking-widest` for labels.
-   **Animations**: Utilizes Framer Motion for smooth UI transitions and consistent modal patterns.
-   **Notifications**: Implements toast notifications for user feedback.
-   **Accessibility**: Prioritizes semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Implemented with Firebase Authentication and a 7-level hierarchical permission model.
-   **Tenant Management**: Full lifecycle management including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Business Management Modules**:
    -   **Point of Sale (POS)**: Cart management, diverse payment options, tax/discount calculations, customer management, repair intake, and robust refund/warranty workflows.
    -   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
    -   **CRM (Customers)**: Enhanced CRM with multi-field search, loyalty programs, duplicate detection, and integrated order/invoice history.
    -   **Invoices**: Supports full invoice lifecycle with dynamic line items, searchable catalog, payment processing, and configurable document templates.
    -   **Services**: Manages a service catalog with CRUD operations and warranty configuration.
    -   **Repairs Module**: Manages repair ticket lifecycle, parts tracking, technician assignment, and financial summaries.
    -   **Inventory Management**: Comprehensive system for managing various `StockItem` types, including UPC/manufacturer/location tracking, min/max stock levels, serial number tracking, stock adjustments, inventory transfers, and trade-in management, integrated with RBAC.
    -   **Supply Chain Management**: Manages suppliers, purchase orders, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with tracking and financial recording, gated by RBAC.
    -   **Shipping Center**: Centralized fulfillment module for managing shipments across all source documents, supporting various types, status transitions, tracking, carrier configuration, cost tracking, and a provider adapter layer.
    -   **Returns Portal / Reverse Logistics**: Manages returns with a structured lifecycle, reasons, resolutions, item disposition, intake/inspection, and integration with return shipments.
-   **Reporting**: Features a dashboard with data visualizations.
-   **Onboarding**: A multi-step process for new tenants covering plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured editor for 5 document types, offering deterministic HTML generation, branding, and visual preview.

## System Design Choices

-   **Routing**: Utilizes React Router v7.
-   **State Management**: Primarily relies on React Context API and local component state.
-   **Firebase Integration**: Leverages Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Integrates with the Gemini API for AI functionalities.
-   **Server-Side Shipping API**: An Express server handles all shipping provider operations with secure credential storage.
-   **Commercial Controls**: Implements a system for managing add-ons and feature entitlements with governance, tenant overrides, pricing rules, and a detailed audit trail, including an internal invoice workflow and activation modes for feature grants.
-   **Add-on Governance**: Features three governance states (`active`, `disabled`, `archived`) and a separate PM `lifecycle`. Each add-on has a `readinessStatus` and runtime backing checklist to gate tenant grants and provide an implementation brief generator.
-   **Production Logging & PII Redaction**: Server-side logs are restricted to operational metadata, with sensitive data redacted using `server/safe-log.ts` and `sanitizeError(err)`.
-   **Platform Operations & Security**: A suite of System Owner surfaces (Command Center, Audit & Security, Support Tools, Platform Settings, Domains, Team Management) for governance and operational control, including a deterministic rule-based intelligence layer. Full implementation detail in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md).

# Locked Product Rules

These are accepted, no-regression rules. Do not change behavior without explicit instruction. Deep detail for each lives in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md).

## Platform Permissions

-   The **Global Permissions Matrix** (`platformPermissionsConfig.ts`) is the single **platform** source of truth for sidebar visibility, page access, and action gating.
-   The **Store Permissions Matrix** remains **tenant/store-only** and is separate from platform permissions.
-   Permission levels are fixed and rank-ordered: **None / View Only / Create / Edit / Approve / Manage / Full Access**.
-   **Parent/child behavior**: sidebar/page visibility uses effective access (parent level OR any child sub-permission >= view); section/action gating uses the exact child sub-permission.
-   **Explicit child None** denies that child even when the parent grants access.
-   **Parent View + child Full Access** allows the child's action (child grant is honored independently of parent default).
-   **Permission dependency auto-sync** (write-time, direction-aware, least-privilege preserving):
    -   Granting/raising a dependent action auto-raises each denied prerequisite to the minimum level that satisfies its own threshold (never beyond).
    -   Lowering a prerequisite auto-caps (writes explicit `none` on) any dependent that would otherwise resolve to `denied_prerequisite`.
    -   Lowering a dependent action never lowers its prerequisite.
    -   System Owner is locked and never reconciled.
-   Permission enforcement is **UI-only** this phase. Server-side RBAC/PIM/PAM is future Phase 1.3.

## Escalation Operating Model

-   **Assignment, escalation, acknowledgement, escalation resolution, and case closure are distinct lifecycle actions** — each gated and audited independently.
-   **Request De-escalation pending-review lifecycle**: front-line operators who cannot de-escalate but can add notes may submit a request; it persists a pending status, posts an internal note, and writes an audit row without mutating escalation state.
-   **No duplicate active request** per case (blocked at handler level).
-   **Reviewer approval/rejection**: approvers de-escalate through the standard confirmation modal (with confirm-time re-check); rejection requires a reason and never mutates escalation status.
-   **Auditability**: every escalation lifecycle transition and de-escalation request action emits an audit row.
-   **Active escalation badge consistency**: `isActiveEscalation` (wrapping `effectiveEscalationStatus(c).active`) is the single truth source for every escalation count, list, banner, and badge. A case shows exactly **one** active-escalation badge — never duplicated, never missing on an active case, never present on terminal (`deescalated` / `resolved`) cases.

## Command Center Intelligence

-   **Deterministic, rule-based intelligence only** — no AI/ML.
-   **No fake AI**, **no live infrastructure/uptime**, **no real DNS/SSL/SSO/SCIM**, **no external notifications**, **no Firestore realtime** claims. Operational signals refresh from current app/session state; live-backend listeners are future work.
-   **Drilldowns must show the records behind every count** — count and list are derived from one source and cannot drift.
-   **No invisible filters** — any active filter must show a visible chip, the matching items, or a truthful empty state.
-   **Source / confidence / truth labels are required** on every intelligence surface.

## Audit Investigation Center

-   **Deterministic, rule-based only** — no AI/ML, SIEM, realtime listeners, prediction, immutable/legal-grade/compliance-certified claims, external notification, or server-side RBAC/PIM/PAM. Derivations live in `platformOpsInvestigation.ts` (separate from the locked `platformOpsDerive.ts`) and reuse `deriveHighRiskFlag`.
-   **Audit rows are never mutated.** Review status (`needs_review`/`reviewed`/`dismissed`) and investigation notes are an append-only session **overlay** keyed by event id, separate from both audit rows and global `SecurityNote`s.
-   **No new permission keys** — review-status + note-add reuse `add_security_note`; note-delete reuses `delete_security_note`. `view_restricted_audit_details` still gates restricted detail (redacted with an explicit placeholder, never silently dropped).
-   **No drift / no invisible filters** — lens counts and the visible list derive from one predicate over one event set; every active filter and the active lens render as visible, clearable chips with truthful empty states.
-   **Date-granular truth** — audit rows have no sub-day timestamp, recorded actor role, or recorded source surface; correlation windows are whole-day, and `sourceSurface` is labeled derived.
-   **No audit spam** — only real review-status transitions emit an audit row; handlers read fresh persisted state before writing. Create-case-from-audit is duplicate-safe (fresh storage read + re-entrancy lock).
-   The **evidence summary is internal, copy-only**, and explicitly not legal/compliance-certified.

## Domains

-   **Deterministic, rule-based only** — no real DNS lookups, SSL issuance/automation, or provider/registrar integrations. DNS/SSL readiness is derived guidance with manual operator verification, clearly truth-labeled.
-   Domain derivations live in `platformOpsDomains.ts` (separate from `platformOpsDerive.ts`). The raw `status`/`ssl`/`kind` fields on `TenantDomainRecord` are the source of truth; `DomainLifecycleStatus` is a **derived presentation layer** and must not replace them.
-   **Single domain store** — Domains page, Command Center, Support Tools, and Dashboard all read `tenant_domains_v1`; counts/signals cannot diverge.
-   Lifecycle actions (create / status change / SSL state / disable / re-enable / delete) are **explicit, confirmed, and audited** (`domain_*` actions, category `domains`). Destructive transitions never go through a silent `<select>`. Page visibility uses `view_domains`; mutation uses `manage_domain_lifecycle`.

## Platform Settings

-   **Registry is the single source of truth** — `platformOpsSettings.ts` (`SETTINGS_REGISTRY`, one entry per `platformDefaults` field) drives every label, default, risk, enforcement, owner, impact, and truth label; posture cards, rows, review diffs, and the audit note all derive from it (no drift).
-   **Nothing is enforced at runtime** — the `enforced` enforcement value exists in the type for future use but is assigned to nothing today (branding/support `display_only`, maintenance `advisory`, security `documentation_only`). Standing truth labels say so.
-   **Review before save** — per-group "Review & Save" shows the old→new diff, impact, and risk for the **unfiltered** change set (search/filters can never hide a pending change). High-risk batches require an acknowledgment checkbox, re-checked inside the save handler. Reset-to-default stages the default into the draft and flows through the same review/save path (no separate reset audit row).
-   **Persistence + audit unchanged** — `platform_settings_v1` localStorage key; exactly one `platform_setting_updated` row (category `configuration`) per confirmed group save (severity `warning` if any high-risk, else `notice`). Page visibility uses `hasEffectiveFeatureAccess('platform_settings')`; editing uses `edit_platform_settings`. All mutation entrypoints self-gate on `canEdit`.

## Non-Regression Locked Areas

Do not change behavior in these areas as a side effect of other work:

-   Shipping Module
-   Add-on Governance
-   Store Permissions Matrix
-   Tenant Features
-   Tenant provisioning
-   Paid override invoice workflow
-   Server PII logging rules
-   Domains (lifecycle model + shared store)
-   Platform Settings (governance registry + change-review UX)

# Active Roadmap

-   **Phase 1.1.3C** — Support Queue / SLA / Macro Maturity **(accepted)**
-   **Phase 1.1.3D** — Audit Investigation Center **(accepted)**
-   **Phase 1.2** — Domains + Platform Settings Maturity **(done — pending acceptance)**
-   **Phase 1.2E** — Domains Control Center UX Maturity **(direction REJECTED by user — superseded by Phase 1.2F)** — M1 Split-Pane · M2 DNS/SSL/Security Workspaces · M3 Platform Settings Control Center Layout · M4 Default Baseline Manager + Change Review Center Polish · M5 Documentation (each previously accepted/done, but the overall control-panel direction was rejected)
-   **Phase 1.2F** — Domain Control Panel Architecture Reset **(in progress)** — M0 Domain Object Model Foundation **(done — pending acceptance; model/helper/storage/seed only, no UI)** · M1+ control-panel UI **(not started)**
-   **Phase 1.3** — Platform Team Governance (server-side RBAC / PIM / PAM) **(after Phase 1.2F)**
-   **Phase 1.4** — Automation + Alerts
-   **Phase 2** — Real Integrations
-   **Phase 3** — Compliance + Evidence
-   **Phase 4** — Predictive / AI Operations

# Documentation Links

-   [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md) — detailed long-form implementation history for all completed Platform Operations & Security phases (Phase 1.1 through 1.1.3D, and Phase 1.2 — Domains + Platform Settings Maturity) and their correction passes.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.
