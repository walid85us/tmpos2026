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
-   **Tenant Features Tab — Add-on Label Visibility Rule (locked)**:
    -   Emerald **`Add-on available`** pill renders next to a `Not in Plan` state pill when, and only when, the feature is linked to a catalog add-on whose `governanceStatus === 'active'`. Plan-compatibility is intentionally NOT required for visibility — when the add-on requires a higher plan than the tenant currently holds, an `· Plan upgrade required` tail is appended so the operator can tell at a glance.
    -   Violet **`Add-on`** pill renders next to the primary state pill on `Paid Override` and `Pending Payment` rows when, and only when, the underlying override is linked to a catalog add-on whose `governanceStatus === 'active'`. This applies to both `enabled_by_paid_override` and `enabled_by_paid_addon` resolver outcomes.
    -   Catalog add-ons whose `governanceStatus` is `disabled` or `archived` MUST NOT surface either pill — the linked feature row falls through to the truthful state (`Not in Plan`, `Add-on disabled`, `Add-on archived`, etc.) without an add-on label.
    -   Features that are not linked to any catalog add-on never render either add-on pill.
    -   `Trial` and `Paid Override` action buttons remain visible on every eligible Not-in-Plan implemented row regardless of add-on linkage.
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