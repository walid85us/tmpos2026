# Overview

This project is a multi-tenant SaaS frontend platform designed for small to medium-sized businesses. It offers a comprehensive suite of tools including Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform's core purpose is to streamline business operations, provide actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture.

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

-   **Design System**: Employs rounded cards, a glass effect (`bg-white/80 backdrop-blur-xl`), a consistent primary color theme, and a `ghost-border` utility.
-   **Typography**: Uses `font-black uppercase tracking-widest` for labels.
-   **Animations**: Utilizes Framer Motion for smooth UI transitions and consistent modal patterns.
-   **Notifications**: Implements toast notifications for user feedback.
-   **Accessibility**: Prioritizes semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Implemented with Firebase Authentication and a 7-level hierarchical permission model.
-   **Tenant Management**: Provides full lifecycle management, including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Business Management Modules**:
    -   **Point of Sale (POS)**: Features comprehensive cart management, diverse payment options, tax/discount calculations, customer management, repair intake, and robust refund/warranty workflows.
    -   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
    -   **CRM (Customers)**: Enhanced CRM with multi-field search, loyalty programs, duplicate detection, and integrated order/invoice history.
    -   **Invoices**: Supports full invoice lifecycle with dynamic line items, searchable catalog, payment processing, and configurable document templates.
    -   **Services**: Manages a service catalog with CRUD operations, warranty configuration, and bulk price editing.
    -   **Repairs Module**: Manages the full repair ticket lifecycle, including structured workflow, parts tracking, technician assignment, and financial summaries.
    -   **Inventory Management**: Comprehensive system for managing various `StockItem` types, including UPC/manufacturer/location tracking, min/max stock levels, serial number tracking, stock adjustments, inventory transfers, and trade-in management, all integrated with RBAC.
    -   **Supply Chain Management**: Manages suppliers, purchase orders, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, gated by RBAC.
    -   **Shipping Center**: A centralized fulfillment module for managing shipments across all source documents, supporting various shipment types. Includes status transition workflows, tracking event timelines, carrier/service level configuration, cost tracking, and a provider adapter layer for external shipping carriers.
    -   **Returns Portal / Reverse Logistics**: A module for managing returns with a structured lifecycle, return reasons, resolutions, item disposition, intake/inspection workflow, and integration with return shipments.
-   **Reporting**: Features a dashboard with data visualizations.
-   **Onboarding**: A multi-step process for new tenants, covering plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured editor for 5 document types, offering deterministic HTML generation, branding, and visual preview.
-   **Carrier Analytics Foundation**: Provides deterministic shipping metrics within the Shipping Center. Features mode derivation, status-to-bucket mapping, pickup analytics gating, and provider-connected analytics.
-   **Carrier Locators / Shipping Provider Configuration**: Manages plan and permission-gated configuration for shipping providers and carrier locators.
-   **Shipping Automation Rules**: Implements a pure automation engine with definable rules (conditions and actions) that can flag, add notes, mark for review, set priority, or queue for batch processing. Supports both observational and guardrail rule types.
-   **Batch Labels**: Allows processing batches of labels by iterating per-shipment.
-   **Packing Workflows**: Provides an explicit, auditable packing lifecycle within the Shipping Center, including item and package verification, exception handling, and completion workflows. Integrates with shipment status transitions.
-   **SLA Optimization Foundation**: Establishes a deterministic, auditable, permission-aware SLA visibility surface, calculating targets based on existing lifecycle timestamps and tenant-editable policies.
-   **SLA Automation Linkage**: Wires the SLA Optimization surface into the existing Shipping Automation Rules engine. Adds six SLA triggers (`sla_at_risk`, `sla_overdue`, `sla_missed`, `sla_paused`, `sla_resumed`, `sla_delay_reason_added`) and six SLA-aware condition fields (`slaWorstStatus`, `slaTargetType`, `slaIsPaused`, `slaHasDelayReason`, `slaVarianceMinutes`, `isReturn`). SLA triggers are restricted to the `flag_note`, `queue_batch`, and `require_review` purposes — guardrail purposes (`approval_gate`, `block_purchase`) are explicitly disallowed because SLA events should never gate label purchase. Allowed SLA actions are limited to `add_flag`, `add_internal_note`, `mark_review_needed`, `mark_ready_for_batch`, and `set_priority`. Status-transition triggers (`sla_at_risk` / `sla_overdue` / `sla_missed`) fire deterministically by diffing a per-shipment status snapshot persisted in `sessionStorage` (`sla_automation_snapshot`) against the current `slaSummaries` — the trigger fires only when a target moves *into* the worse status, never on staying or improving. Pause / resume / delay-reason triggers source from new `slaHistory` entries since the last persisted `lastHistoryId`, so each user action fires exactly once. Per-event context (target type, from→to status, variance minutes, reason) is threaded into the engine via a typed `AutomationTriggerContext` so SLA-aware conditions evaluate against the event, not against whatever the engine recomputes later. Execution history records `slaTargetType` / `slaFromStatus` / `slaToStatus` / `slaVarianceMinutes` / `slaTriggerReason` for an auditable "why now" trail. Plan and permission gating: the entire feature requires both `shipping_automation_rules` AND `shipping_sla_optimization` plan features plus the `view_shipping_sla` sub-permission; if either is missing, no SLA triggers fire and the rule builder hides the SLA group entirely. **Out of scope:** Carrier Scorecards, Customs / HS code automation, Insurance recommendations, AI/predictive SLA forecasting, and any redesign of the automation engine itself.

## System Design Choices

-   **Routing**: Utilizes React Router v7.
-   **State Management**: Primarily relies on React Context API and local component state.
-   **Firebase Integration**: Leverages Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Integrates with the Gemini API for AI functionalities.
-   **Server-Side Shipping API**: An Express server handles all shipping provider operations with secure credential storage.
-   **Configuration**: Uses `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.