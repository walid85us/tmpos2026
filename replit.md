# Overview

This project is a multi-tenant SaaS frontend platform designed to provide small to medium-sized businesses with a comprehensive suite of tools for Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing. Its primary purpose is to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture.

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
-   **Commercial Controls**: Implements a system for managing add-ons and feature entitlements with commercial governance, tenant overrides, pricing rules, and a detailed audit trail. This includes a robust internal invoice workflow for managing payments without external processors, activation modes for feature grants (after_payment or immediate), and clear distinctions for trial, paid override, and add-on statuses.
-   **Tenant Features Tab — Add-on Compatible Plan Availability Rule (locked)**:
    -   An add-on surfaces in a tenant's Features tab as an add-on **only when all three** of the following are true: (1) the feature is linked to a catalog Add-on, (2) the catalog Add-on's `governanceStatus === 'active'`, and (3) the tenant's current plan is included in the Add-on's `compatiblePlans`. If any of those is false, no add-on label, no add-on availability messaging, and no add-on-specific grant behavior is shown — the row simply renders as a normal feature in its truthful state (e.g. `Not in Plan`).
    -   Emerald **`Add-on available`** pill renders next to a `Not in Plan` state pill only when the linked add-on is active **and** plan-compatible.
    -   Violet **`Add-on`** pill renders next to the primary state pill on `Paid Override` / `Pending Payment` rows only when the linked add-on is active **and** plan-compatible. (Suppressed when the row's resolver reason is already `enabled_by_paid_addon`, whose own primary pill already reads "Add-on", to avoid double-badging.)
    -   The phrase **"Plan upgrade required"** does NOT appear anywhere on the Tenant Features tab. An incompatible add-on is not surfaced as an add-on at all; there is no upsell tail.
    -   When the System Owner edits an Add-on's Compatible Plans: removing a tenant's plan immediately hides the Add-on labeling and add-on-specific grant behavior on that tenant's Features tab; adding a tenant's plan immediately surfaces the Add-on label with `Trial` and `Paid Override` actions where eligible.
    -   Disabled or archived catalog add-ons MUST NOT surface either pill on any tenant — the linked feature row falls through to its truthful state without add-on labeling.
    -   Features that are not linked to any catalog add-on never render either add-on pill.
    -   `Trial` and `Paid Override` action buttons remain visible on every eligible normal-implemented row regardless of add-on linkage (non-add-on tenant-level overrides preserve existing behavior). The Paid Override modal will only pre-populate add-on price/cadence/billing fields when the linked add-on is active **and** plan-compatible — an incompatible add-on is never presented as available through Trial or Paid Override.
    -   The `Custom Price` pill (rendered separately below the price line) is independent of the add-on label and only appears when the tenant-specific price diverges from the catalog price.
    -   The Tenant Features tab is a commercial-entitlement surface only — it must NOT render permission chips, locked sub-permission badges, or any "Permissions Impact" block. Role-permission detail lives exclusively in the Store Permissions Matrix.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.