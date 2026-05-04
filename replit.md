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

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.