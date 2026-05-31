# Overview

This project is a multi-tenant SaaS frontend platform designed to provide small to medium-sized businesses with a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing. Its primary purpose is to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture. The platform aims to enhance efficiency and decision-making for businesses.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# Current Project State

-   **Current accepted checkpoint**: Phase 1.1.3B — Advanced Command Center Intelligence is **accepted**, including the **Duplicate Escalated Badge UI Correction**.
-   **Latest completed phase**: Phase 1.1.3C (Support Queue / SLA / Macro Maturity) — implemented, pending acceptance.
-   **Next planned phase**: Phase 1.1.3D — Audit Investigation Center.
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

## Non-Regression Locked Areas

Do not change behavior in these areas as a side effect of other work:

-   Shipping Module
-   Add-on Governance
-   Store Permissions Matrix
-   Tenant Features
-   Tenant provisioning
-   Paid override invoice workflow
-   Server PII logging rules

# Active Roadmap

-   **Phase 1.1.3C** — Support Queue / SLA / Macro Maturity **(done — pending acceptance)**
-   **Phase 1.1.3D** — Audit Investigation Center **(next)**
-   **Phase 1.2** — Domains + Platform Settings Maturity
-   **Phase 1.3** — Platform Team Governance (server-side RBAC / PIM / PAM)
-   **Phase 1.4** — Automation + Alerts
-   **Phase 2** — Real Integrations
-   **Phase 3** — Compliance + Evidence
-   **Phase 4** — Predictive / AI Operations

# Documentation Links

-   [`docs/platform-operations-security-history.md`](docs/platform-operations-security-history.md) — detailed long-form implementation history for all completed Platform Operations & Security phases (Phase 1.1, 1.1.1, 1.1.2, 1.1.3A, 1.1.3B) and their correction passes.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.
