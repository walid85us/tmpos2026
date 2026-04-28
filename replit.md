# Overview

This project is a multi-tenant SaaS frontend platform designed for small to medium-sized businesses. It provides a comprehensive suite of tools including Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform aims to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture.

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

-   **Design System**: Employs rounded cards, a glass effect, a consistent primary color theme, and a `ghost-border` utility.
-   **Typography**: Uses `font-black uppercase tracking-widest` for labels.
-   **Animations**: Utilizes Framer Motion for smooth UI transitions and consistent modal patterns.
-   **Notifications**: Implements toast notifications for user feedback.
-   **Accessibility**: Prioritizes semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Implemented with Firebase Authentication and a 7-level hierarchical permission model.
-   **Tenant Management**: Full lifecycle management, including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Business Management Modules**:
    -   **Point of Sale (POS)**: Comprehensive cart management, diverse payment options, tax/discount calculations, customer management, repair intake, and robust refund/warranty workflows.
    -   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
    -   **CRM (Customers)**: Enhanced CRM with multi-field search, loyalty programs, duplicate detection, and integrated order/invoice history.
    -   **Invoices**: Supports full invoice lifecycle with dynamic line items, searchable catalog, payment processing, and configurable document templates.
    -   **Services**: Manages a service catalog with CRUD operations, warranty configuration, and bulk price editing.
    -   **Repairs Module**: Manages the full repair ticket lifecycle, including structured workflow, parts tracking, technician assignment, and financial summaries.
    -   **Inventory Management**: Comprehensive system for managing various `StockItem` types, including UPC/manufacturer/location tracking, min/max stock levels, serial number tracking, stock adjustments, inventory transfers, and trade-in management, all integrated with RBAC.
    -   **Supply Chain Management**: Manages suppliers, purchase orders, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, gated by RBAC.
    -   **Shipping Center**: A centralized fulfillment module for managing shipments across all source documents, supporting various shipment types, status transitions, tracking event timelines, carrier configuration, cost tracking, and a provider adapter layer.
    -   **Returns Portal / Reverse Logistics**: A module for managing returns with a structured lifecycle, reasons, resolutions, item disposition, intake/inspection, and integration with return shipments.
-   **Reporting**: Features a dashboard with data visualizations.
-   **Onboarding**: A multi-step process for new tenants, covering plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured editor for 5 document types, offering deterministic HTML generation, branding, and visual preview.

## System Design Choices

-   **Routing**: Utilizes React Router v7.
-   **State Management**: Primarily relies on React Context API and local component state.
-   **Firebase Integration**: Leverages Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Integrates with the Gemini API for AI functionalities.
-   **Server-Side Shipping API**: An Express server handles all shipping provider operations with secure credential storage.
-   **Configuration**: Uses `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.
-   **Commercial Controls**: Implements a system for managing add-ons and feature entitlements with commercial governance, tenant overrides, pricing rules, and a detailed audit trail.
    -   **Add-on Catalog Lifecycle Label**: Each catalog card shows exactly one lifecycle status chip — `Active`, `Disabled`, or `Archived` — sourced from `governanceStatus`. The internal product `lifecycle` field is not rendered on the card to avoid duplicate chips.
    -   **Tenant Features Tab**: Per-feature row shows a single status chip (`Included by Plan`, `Not in Plan`, `Trial`, `Paid Override`, `Add-on`, `Disabled by Owner`, `Trial Expired`, `Revoked`, `Add-on Disabled`, `Add-on Archived`, `Pending Payment`, `Not Available`) plus a secondary `Add-on Available` pill when the feature is not in plan AND the linked add-on catalog entry is `Active`. Action buttons (`Trial`, `Paid Override`, `End Trial`, `Revoke`, `Re-trial`, `Re-grant Paid`, `Approve`, `Cancel`) are separate from status chips and are only shown when the entitlement state allows them.
    -   **Trial / Paid Override are tenant-level entitlement overrides**: They appear for ANY implemented feature that is currently not entitled and does not already have an active override row, regardless of whether a linked add-on catalog item exists or is `active`. The presence of an active linked add-on only contributes a default price (used as the modal pre-fill) and the secondary `Add-on Available` pill; it does not gate the buttons.
    -   **Add-on Availability Rule**: An add-on is "available" (and both the `Add-on Available` pill renders AND the Paid Override modal pre-fills the catalog default price + cadence) only when `governanceStatus === 'active'` AND its `compatiblePlans` include the tenant's current plan AND the linked feature is not already included in plan. A `Disabled` / `Archived` catalog entry OR a plan-incompatible add-on suppresses both the `Add-on Available` pill and the modal pre-fill, but does NOT suppress the tenant-level `Trial` / `Paid Override` grant buttons themselves for the underlying implemented feature.
    -   **Trial / Override / Add-on Distinction**: `Trial` is a time-bound grant with `trialEnd`; `Paid Override` is a tenant-specific paid grant whose price defaults from the linked add-on (when present + active) but may be customized OR entered manually when no linked active add-on exists; `Add-on` denotes the linked catalog item that contributed the default price. The Custom Price pill renders only when the saved override price differs from the catalog default.
    -   **Paid Override Pricing**: When a linked active add-on exists the modal pre-fills the catalog default price and cadence; with no linked active add-on the System Owner enters the price manually. In both cases the tenant-specific price is stored on the override row and never mutates the global catalog price.
    -   **Permissions Matrix**: Add-on-driven sub-permissions only appear when the linked feature is currently entitled (plan inclusion OR a non-revoked, non-expired override) AND the linked add-on is `governanceStatus === 'active'`.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.