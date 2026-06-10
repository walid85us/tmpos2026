# Overview

This project is a multi-tenant SaaS frontend platform designed to provide small to medium-sized businesses with a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing. Its primary purpose is to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture. The platform aims to enhance efficiency and decision-making for businesses.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# Current Project State

-   **Current accepted checkpoint**: **Phase 1.2 is finalized/accepted.** Phase 1.2F **Tenant Web Address** — the strategic replacement of the user-facing "Domains" module — is **accepted** (including its final minimal-table correction and Manage-drawer product-language cleanup), and the **Platform Settings Control Center is accepted as-is for now**.
-   **What "Tenant Web Address" is**: the System Owner module is repositioned away from a registrar/DNS "Domains" control panel toward honestly **managing each tenant's platform web address** (`{tenant.subdomain}.repairplatform.com`). It is presentation/positioning over a new pure helper (`src/owner/tenantWebAddress.ts`) and is **non-destructive over the M0 domain object model** — the `tenant_domains_v1` store and the dormant DNS/SSL/registrar helpers (`platformOpsDomainModel.ts`/`platformOpsDomains.ts`) are retained untouched for future custom-domain work. `WEB_ADDRESS_LIVE_HOSTING=false` (Copy always allowed; Open disabled/Future). No real DNS/SSL/registrar/hosting. No-drift: one `webAddresses` array + one `matchesWebAddressFilter` predicate drive all cards/saved-view counts. Permission resolver/ids/gating, audit, the Add flow, and `?domain=`/`?status=` deep-linking are unchanged.
-   **Superseded**: the earlier Phase 1.2F domain-control-panel milestones (M0 Domain Object Model, M1 Portfolio Dashboard, M2 Overview Workspace) and the **rejected Phase 1.2E control-panel direction** were superseded by this Strategic Replacement. The M0 model itself remains in place underneath.
-   **Platform Settings**: the governance work (registry + change-review UX) is **accepted as-is for now** — truthful (nothing enforced at runtime), correctly gated, and audited. Deeper implementation (backend config service, runtime enforcement, SSO/SCIM, notifications, provider integrations, approval-workflow engine, compliance-evidence automation, server-side policy enforcement) is **deferred to future platform operations/security phases**.
-   **Current phase**: Phase 1.3 — Platform Team Governance (server-side RBAC / PIM / PAM). **Milestone 0 (Current Access Inventory), Milestone 1 (advisory governance model), Milestone 2 (Platform Team Directory + Role Matrix UI), and Milestone 3 (Temporary Access / PIM Foundation) are complete, accepted, and backed up.** **Milestone 4 (Access Review + Sensitive Action Reason Capture) is the current active workstream** — a local, advisory, non-enforcing access-review workflow (create → record-outcome; outcomes `reviewed_no_change` / `reviewed_change_required` / `escalated` / `deferred`, reason-required, derived overdue, no scheduler) plus sensitive-action reason capture around existing sensitive governance actions (access-review outcomes + the matrix Reset-to-Defaults), built on the Milestone 1 `AccessReviewRecord` types via the new `src/owner/platformAccessReview.ts` store (session-scoped, never applied to the live resolver; no permission/role change). **Milestone 5 (Command Center / Audit integration) is not started. Phase 1.3 is not complete.** Authoritative artifacts: Milestone 0 inventory [`docs/phase-1.3-platform-access-inventory.md`](docs/phase-1.3-platform-access-inventory.md), Milestone 1 model [`docs/phase-1.3-platform-team-governance-model.md`](docs/phase-1.3-platform-team-governance-model.md), Milestone 2 UI [`docs/phase-1.3-milestone-2-team-directory-role-matrix-ui.md`](docs/phase-1.3-milestone-2-team-directory-role-matrix-ui.md), Milestone 3 foundation [`docs/phase-1.3-milestone-3-temporary-access-pim-foundation.md`](docs/phase-1.3-milestone-3-temporary-access-pim-foundation.md), Milestone 4 access review + reason capture [`docs/phase-1.3-milestone-4-access-review-sensitive-action-reason-capture.md`](docs/phase-1.3-milestone-4-access-review-sensitive-action-reason-capture.md).
-   **Detailed history**: full long-form implementation notes and the complete correction sequences (including every Tenant Web Address table/drawer correction) live in [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md). `replit.md` keeps only the high-level overview, locked rules, and roadmap.
-   **GitHub backup**: after each accepted milestone/phase, run `npm run backup:github` before starting the next phase. It safe-pushes `main` to GitHub (fast-forward only; never force pushes; refuses on a dirty tree or diverged remote).

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
-   **Phase 1.2** — Domains + Platform Settings Maturity **(finalized/accepted — Tenant Web Address is the accepted replacement for Domains; Platform Settings accepted as-is for now, deeper implementation deferred)**
-   **Phase 1.2E** — Domains Control Center UX Maturity **(direction REJECTED by user — superseded by Phase 1.2F)**
-   **Phase 1.2F** — Strategic Replacement ("Domains" → "Tenant Web Address") **(accepted, incl. final minimal-table correction + Manage-drawer product-language cleanup)** — built non-destructively over the earlier (now superseded) M0/M1/M2 domain-control-panel milestones; full detail in the history doc.
-   **Phase 1.3** — Platform Team Governance (server-side RBAC / PIM / PAM) **(in progress — M0/M1/M2/M3 complete & accepted; M4 Access Review + Sensitive Action Reason Capture active; M5 not started; phase not complete)**
-   **Phase 1.4** — Automation + Alerts
-   **Phase 2** — Real Integrations
-   **Phase 3** — Compliance + Evidence
-   **Phase 4** — Predictive / AI Operations

# Documentation Links

-   [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md) — detailed long-form implementation history for all completed Platform Operations & Security phases (Phase 1.1 through 1.1.3D, Phase 1.2 — Domains + Platform Settings Maturity, Phase 1.2E, and Phase 1.2F — Tenant Web Address, including every table/drawer correction pass).

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.
