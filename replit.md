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
-   **Tenant Features Tab — Add-on-Derived Row Visibility Rule (locked)**:
    -   **Row-level visibility gate.** When a feature is linked to a catalog Add-on AND that feature is NOT included in the tenant's plan baseline, the entire row is hidden from the Tenant Features tab unless the linked Add-on is BOTH `governanceStatus === 'active'` AND has the tenant's current plan in `compatiblePlans`. Hidden rows show no `Not in Plan`, no `Add-on`, no Trial / Paid Override actions, no upsell text. Features that are included in the tenant's plan baseline are always shown (regardless of any add-on linkage). Features that have no catalog Add-on linkage are always shown (normal core/plan behavior preserved).
    -   **Visible add-on row label.** When a row is shown via the eligible-add-on path, the primary state pill reads **`Not in Plan`** and a single secondary pill reads **`Add-on`** (emerald next to Not-in-Plan rows; violet next to Paid Override / Pending Payment rows). The labels **`Add-on available`** and **`Plan upgrade required`** are no longer used anywhere on the Tenant Features tab.
    -   **Compatible Plans edits take effect immediately.** Removing a tenant's plan from an Add-on's `compatiblePlans` hides every add-on-derived row for that tenant on the next render. Adding a plan immediately surfaces the row with `Not in Plan` + `Add-on` and `Trial` / `Paid Override` actions where eligible.
    -   **Historical state handling.** Existing trial / pending payment / paid override / revoked records on a feature whose linked Add-on is no longer eligible for the tenant are hidden from the active Tenant Features list along with the row. The historical record itself is preserved in the SaaS Subscription Invoices section of the Billing tab and in the Commercial Audit log.
    -   **Disabled or archived catalog Add-ons** are treated as ineligible — their derived rows do not surface as available on any tenant.
    -   **Resolver-side enforcement.** `resolveTenantFeature` strips Add-on attribution (`addOn`, `defaultPrice`) for plan-incompat tenants on `trial_active`, `paid_active`, `pending_payment`, and `disabled_by_plan` branches; `type === 'addon'` overrides downgrade to `enabled_by_paid_override` so no row's primary pill ever reads "Add-on" when the Add-on is plan-incompatible. Grant handlers (`handleEnableTrial`, `handleEnablePaidOverride`) only persist `addOnId` on the override + invoice + audit when the Add-on is currently eligible for the tenant.
    -   **Trial / Paid Override actions** remain visible on every eligible normal-implemented Not-in-Plan row regardless of Add-on linkage; they only pre-populate add-on price/cadence when the linked Add-on is currently eligible.
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