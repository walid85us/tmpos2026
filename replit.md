# Overview

This project is a multi-tenant SaaS frontend platform offering a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing for small to medium-sized businesses. Its core purpose is to streamline operations, provide actionable insights, and automate business processes through a scalable, customizable, and feature-rich architecture.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# System Architecture

## Frontend

The frontend is built using React 19, TypeScript, Vite 6, and Tailwind CSS v4.

## UI/UX Decisions

-   **Design System**: Employs rounded cards, a glass effect, a consistent primary color theme, and a `ghost-border` utility. Typography uses `font-black uppercase tracking-widest` for labels.
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
    -   **Inventory Management**: Comprehensive system for managing various `StockItem` types, including UPC/manufacturer/location tracking, min/max stock levels, serial number tracking, stock adjustments, inventory transfers, and trade-in management, all integrated with RBAC.
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
-   **Commercial Controls**: Implements a system for managing add-ons and feature entitlements with governance, tenant overrides, pricing rules, and a detailed audit trail. This includes an internal invoice workflow and activation modes for feature grants.
-   **Add-on Governance**: Features three governance states (`active`, `disabled`, `archived`) and a separate PM `lifecycle`. Add-ons can be linked to existing features or registered as standalone capabilities. Archive and delete operations are blocked by dependencies.
-   **Add-on Implementation Readiness**: Each add-on has a `readinessStatus` (`runtime_backed`, `partially_backed`, `parent_feature_linked`, `implementation_required`, `commercial_placeholder`) and a runtime backing checklist. This gates tenant grants and provides an implementation brief generator for non-`runtime_backed` add-ons.
-   **Production Logging & PII Redaction**: Server-side logs are restricted to operational metadata only, with sensitive customer and credential data strictly redacted using `server/safe-log.ts` and `sanitizeError(err)`.
-   **Platform Operations & Security**: A suite of System Owner surfaces (Audit & Security, Support Tools, Platform Settings, Domains, Team Management) for governance and operational control. These features include mock data for local development, a platform audit helper, and truth labels indicating manual verification where automated systems are not yet implemented.
-   **Command Center**: A central dashboard providing a platform health overview, needs attention queue, tenant risk summary, and workflow health summary, with live updates.
-   **Audit & Security Upgrade**: Includes saved views, CSV export, high-risk flags, linked case badges, and detailed drawers for event analysis, related events, actor profiles, and the ability to create support cases from audit events.
-   **Support Tools Upgrade**: Features SLA timers, saved views, escalation mechanisms, tenant health mini-cards, a note composer with macro inserter, and related entities panels.
-   **Risk Scoring (`deriveTenantRisk`)**: Calculates a per-tenant risk score based on open critical audits, escalated cases, overdue/at-risk SLA cases, and domain verification statuses.
-   **SLA Timer Logic (`deriveSlaStatus`)**: Determines the status of support cases (overdue, at_risk, paused, met) based on predefined deadlines and case status.
-   **High-Risk Audit Flag Logic (`deriveHighRiskFlag`)**: Identifies critical, sensitive, or burst audit events.
-   **Command Center — Escalated Cases in Needs Attention**: Active escalated support cases (`escalated === true` and status not in `resolved`/`closed`) are included in the Command Center "Needs Attention" queue with a deep link to `/owner/support-tools?caseId=<id>`. Resolved or closed cases are excluded. The same case is never queued more than once when it is also urgent or overdue. Command Center additionally listens for a `support_cases:changed` window event (dispatched by Support Tools whenever cases are persisted) so escalations reflect live without a full app reload.
-   **Phase 1.1 QA Patch**: Additive bug-fix on top of the locked Phase 1.1. Fixes the Support Tools case-detail crash (drawer was reading the non-existent `tenantRiskForSelected.reasons` instead of `signals`, and wrong `TenantDomainRecord` field names); wires `?caseId=` deep links from Command Center "Needs Attention" rows and Audit & Security "linked case" badges so they open the matching case drawer (with an in-app "Case not found" empty-state for stale ids); adds `data-testid` attributes on saved-view chips, support-case rows, and attention rows for e2e coverage; replaces the browser `confirm()` for security-note delete with an in-app confirmation modal; and verifies that every support-case mutation writes exactly one audit event (no duplicates) and that the `security_note_deleted` audit fires only on confirm. No public type, audit action id, route, AccessGuard rule, `feature` key, or Domains/Settings/Team/Shipping/Billing/PII surface was changed; the patch only edits `SupportToolsPage.tsx`, `CommandCenterPage.tsx`, and `AuditSecurityPage.tsx`.
-   **Phase 1.1.1 — Interactive Mission Control & Operational Polish**: Strictly additive on top of locked Phase 1.1. Replaces the basic Command Center header with a Mission Control panel that shows an overall platform state (`deriveOverallPlatformState` → Healthy/Watch/At Risk/Critical), a one-line summary, active signal list, last-refreshed badge with refresh button, time-range chips (Today/7d/30d/All) and focus-mode chips (Normal/Watch/Incident Review). Adds a 7-metric Operational Pulse strip (`deriveOperationalPulse`: open cases, overdue SLA, escalated, high-risk audits, domain issues, tenants at risk, pending actions) and an 8-widget operational grid: 5 distribution widgets (Cases by Severity, SLA Pressure, Tenant Risk Distribution, Audit by Severity, Domain Snapshot) computed by `deriveWidgetDistributions`, plus 3 list widgets (High-Risk Stream, Escalated Cases, Add-on/Commercial Attention). Adds a Next Best Actions panel powered by `deriveNextBestActions` (deterministic rule-based — explicitly NOT AI: ranks overdue urgent cases, escalated cases, critical/high-risk audits, failed domains, SLA-at-risk cases, at-risk/critical tenants, and unresolved security notes by fixed priority order, each with an in-app deep-link). Adds a Tenant 360 read-only drawer (`deriveTenant360`) opened by clicking a tenant name in either the Needs Attention table or the Tenant Risk Summary; the drawer shows derived risk, open cases with SLA + escalation badges, recent audit events with high-risk flags, domain issues, and a link to the full tenant page. Time-range filtering uses a shared `filterByTimeRange` helper applied to audits and cases (domains/notes are point-in-time and unfiltered). Focus mode uses `filterByFocusMode` applied to the Needs Attention queue (Normal=all, Watch=non-low, Incident=critical+high). Audit & Security gains an informational Severity Summary Strip (info/notice/warning/critical bars + counts; does not mutate filters) and stronger active saved-view chip styling. Support Tools gains a top-of-drawer red Escalated banner, matching saved-view chip emphasis, and native browser tooltips that preview macro bodies on hover before insert. Four new audit action ids are registered in `platformOpsAudit.ts` and fire only on meaningful operator actions: `command_center_refreshed`, `command_center_time_range_changed`, `command_center_focus_mode_changed`, `command_center_tenant360_opened` (no spam on hover, scroll, or filter changes). All values are derived from in-session `support_cases_v1` / `audit_logs` / `tenant_domains_v1` / `platform_security_notes` snapshots — there is no real DNS/SSL/SSO/notifications/AI/uptime monitoring and no external network call. Existing surfaces (Domains, Platform Settings, Team Management, Shipping, Add-on Governance, Plans, Tenant Features, Store Permissions, POS, PII rules) and existing public types/routes/AccessGuard rules/`feature` keys are unchanged. The benchmark direction (Datadog status banners, PagerDuty incident review modes, Zendesk SLA emphasis, Atlassian Jira Service Management Tenant 360 drawers) is documented from prior knowledge — no live external browsing was performed during this build.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.