# Overview

This project is a multi-tenant SaaS frontend platform designed to provide small to medium-sized businesses with a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing. Its primary purpose is to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture. The platform aims to enhance efficiency and decision-making for businesses.

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
-   **Platform Operations & Security**: A suite of System Owner surfaces (Audit & Security, Support Tools, Platform Settings, Domains, Team Management) for governance and operational control. Includes mock data, a platform audit helper, and truth labels for manual verification.
-   **Command Center**: A central dashboard providing platform health overview, needs attention queue, tenant risk summary, and workflow health summary, with live updates.
-   **Audit & Security Upgrade**: Includes saved views, CSV export, high-risk flags, linked case badges, and detailed drawers for event analysis, related events, actor profiles, and support case creation from audit events.
-   **Support Tools Upgrade**: Features SLA timers, saved views, escalation mechanisms, tenant health mini-cards, a note composer with macro inserter, and related entities panels.
-   **Risk Scoring (`deriveTenantRisk`)**: Calculates a per-tenant risk score based on critical audits, escalated cases, overdue/at-risk SLA cases, and domain verification statuses.
-   **SLA Timer Logic (`deriveSlaStatus`)**: Determines the status of support cases (overdue, at_risk, paused, met) based on predefined deadlines and case status.
-   **High-Risk Audit Flag Logic (`deriveHighRiskFlag`)**: Identifies critical, sensitive, or burst audit events.
-   **Operating Model + Permission-Aware Escalation**: Introduces an advisory operating model with `PlatformOpsRole` unions, structured `EscalationStatus`, `EscalationLevel`, `EscalationReasonCode`, and `EscalationTargetTeam`. Includes a `can(role, action, ctx)` helper for UX guarding of escalation lifecycle actions.
-   **IAM/RBAC Role Stack (project knowledge)**: Platform permission work is approached through the lenses of: IAM Specialist, Access Analyst, Senior RBAC Architect, Platform Team Governance Leader, Senior Platform Operations Architect, Senior Support Tools / Audit & Security Engineer, Senior React/TypeScript Engineer, QA Gatekeeper, and Side Auditor. Responsibilities span role mapping, least-privilege enforcement, effective-access validation, lifecycle audit, and inheritance/explicit-deny troubleshooting. Subjects = Dev Session role + platform roles + future team members. Objects = sidebar modules / pages / sections / widgets / action buttons / support cases / escalation actions / audit logs / commercial controls. Permissions = None / View Only / Create / Edit / Approve / Manage / Full Access (rank-ordered).
-   **Four-Level Effective Access Model**: Every gate decision is evaluated at one of four levels — (1) **sidebar visibility** uses `hasEffectiveFeatureAccess` (parent OR any child >= view), (2) **page/route access** uses the same effective check with `NAV_FEATURE_SECONDARY_KEYS` mapping, (3) **section/widget visibility** uses `hasSectionAccess(role, subKey)` against the EXACT child sub-permission (independent of parent so explicit child grants reveal only that section), (4) **action/handler authorization** uses `hasActionAccess(role, subKey)` and is re-checked inside every mutation handler so stale UI / dropdowns cannot bypass the gate. `explainAccessDecision` returns `{allowed, effectiveLevel, source, reason, threshold}` where `source ∈ {system_owner, explicit_child, explicit_parent, default_parent, denied_explicit_child, denied_no_access}` (sub-permissions inherit the parent default, so there is no separate `default_child`) for full explainability.
-   **Section-Level Gating in Command Center**: Mission Control hero, Operational Widgets, Workflow Health, How-Risk-Derived legend, and the Quick Actions bar are wrapped in `viewPageGate.allowed`/`useQuickActionsGate.allowed` so when only `view_needs_attention=View Only` is granted (parent None), only the Needs Attention section renders — Mission Control, widgets, NBA, pulse, and quick actions stay hidden.
-   **Handler-Level Gating in Support Tools**: `changeStatus`, `changeSeverity`, and `changeAssignee` re-check `change_support_status` / `change_support_severity` / `assign_support_case` at the top of the handler and abort with a toast if denied. Status and severity selects render disabled (with reason tooltip) when the matching permission is missing.
-   **De-escalate Confirmation Flow**: The de-escalate banner button is hidden when `deescalate_support_case` is denied; when granted, it opens the confirmation modal (it never calls `deescalateCase` directly). The modal requires a non-empty reason — Confirm is disabled until one is provided.
-   **Pre-QA Blocker Correction (Effective Permission Resolver Hardening)**: A focused correction pass closed 9 verifier-flagged blockers without expanding scope. Catalog gained 8 new Support Tools sub-permissions (`view_support_sla`, `view_support_tenant_health`, `view_support_related_entities`, `add_internal_support_note`, `use_support_macro`, `manage_support_macros`, `edit_support_case`, `reopen_support_case`); the NBA key was renamed to its canonical form `view_next_best_actions` and the legacy `view_nba_recommendations` is preserved as an alias via `PLATFORM_SUB_PERMISSION_ALIASES` so existing callsites still resolve. SupportToolsPage wires all 9 new sub-perms (handler-level checks in `addNote` / `closeCase` / `reopenCase` / `insertMacro`; section-level gates around the SLA pill, Tenant Health card, Related Entities panel, NoteComposer, macro picker, Reopen button; and an Assignee input now disables with a tooltip when `assign_support_case` is denied). The Resolve Escalation modal mirrors the close-warn confirm-time re-check pattern so a stale UI state cannot bypass `resolve_escalation`. AuditSecurityPage wires 4 sub-perms: `view_actor_profile` gates the Actor drawer tab, `view_related_event_timeline` gates the Related drawer tab (separate keys per spec), `view_escalation_lifecycle_audit` gates the escalation transition card, and `view_restricted_audit_details` redacts the free-form Note body and "Why flagged" reasons for high-risk events. TenantDetailPage End-Trial now requires BOTH `grant_trial` AND `revoke_addon_override` (ending an active trial is jointly a trial-lifecycle action and an override revocation). CommandCenter Tenant Risk Summary becomes the minimal Tenant 360 surface: it now renders when the operator holds either parent Command Center access OR the explicit `view_tenant_360` child grant. De-escalate visibility deferral remains as previously documented (button hidden when `deescalate_support_case` is denied; modal still required for confirmation when allowed).
-   **Global Permissions Matrix as Source of Truth**: The `platformPermissionsConfig.ts` matrix is the single authority for sidebar visibility, page access, and action gating across all platform pages. Key design:
    -   `hasEffectiveFeatureAccess(role, featureKey)` resolves visibility by checking the parent level OR any child sub-permission >= view, enabling child-granted sidebar access even when the parent is None.
    -   `canAccess()` in `AccessContext.tsx` uses effective access with secondary key mapping (e.g. `plans` → `addon_governance`) for nav items that span multiple feature groups.
    -   `gatedCan()` in SupportToolsPage returns the matrix result directly without falling through to old `can()` logic, so matrix-granted actions are never blocked by legacy role checks.
    -   CommandCenter gates Operational Pulse, NBA, and Needs Attention sections with `view_operational_pulse`, `view_next_best_actions`, `view_needs_attention` sub-permissions. NBA action buttons gated by `act_on_nba_recommendations`.
    -   AuditSecurityPage gates the audit log table with `view_audit_logs`.
    -   TenantDetailPage gates Trial/Paid Override/Revoke/End Trial/Re-trial/Re-grant Paid buttons with `grant_trial`, `grant_paid_override`, `revoke_addon_override`.
    -   PlansPage hides the Add-ons tab when `addon_governance` effective access is denied.
    -   TeamManagementPage shows a confirmation modal before resetting all permission overrides to defaults.
    -   The Effective Access Preview panel highlights child-granted visibility (amber) and System Owner locked status.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.