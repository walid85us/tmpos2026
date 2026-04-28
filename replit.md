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
-   **Add-on Plan Inclusion Source-of-Truth Rule (locked)**:
    -   **Plans & Features Matrix is the source of truth for included-by-plan access.** Every Add-on Catalog item that is linked to a feature must use the existing `linkedFeatureId` of a feature row in `featureMatrix`. No duplicate feature rows are created when an add-on is registered. The Add-on Catalog cannot contradict the Plans & Features Matrix.
    -   **Compatible Plans locking (Add-on Catalog editor).** In the Add-on edit modal, plans where the linked feature is included by plan are rendered as **locked** (lock icon, emerald background, disabled, helper text: "Locked plans include the linked feature in the Plans & Features Matrix. To change inclusion for those plans, edit the Plans & Features Matrix."). Locked plans cannot be unchecked from the Add-on Catalog. On save, locked plans are auto-merged into `compatiblePlans` so the persisted record can never opt out of an included plan. Non-included plans remain freely toggleable as optional add-on availability.
    -   **Tenant Features tab label rules.**
        -   **Plan includes the linked feature** → primary pill `Included by Plan`, secondary emerald pill `Add-on` (when the catalog Add-on is `governanceStatus === 'active'`), and **no** Trial / Paid Override actions (the feature is already included).
        -   **Plan does not include the linked feature, tenant's plan IS in `compatiblePlans`** → primary pill `Not in Plan`, secondary emerald pill `Add-on`, with `Trial` and `Paid Override` actions enabled.
        -   **Plan does not include the linked feature, tenant's plan is NOT in `compatiblePlans`** → the entire row is hidden. No `Not in Plan`, no `Add-on`, no Trial / Paid Override, no `Add-on available`, no `Plan upgrade required`.
        -   **Disabled or archived catalog Add-ons** are treated as ineligible: derived rows do not surface as available on any tenant, and an in-plan feature whose linked Add-on is disabled/archived shows `Included by Plan` only (no active "Add-on" badge).
    -   **Compatible Plans edits take effect immediately.** Removing a tenant's plan from an Add-on's `compatiblePlans` (where allowed — i.e. the plan is not locked) hides every add-on-derived row for that tenant on the next render. Adding a plan immediately surfaces the row with `Not in Plan` + `Add-on` and `Trial` / `Paid Override` actions where eligible.
    -   **Historical state handling.** Existing trial / pending payment / paid override / revoked records on a feature whose linked Add-on is no longer eligible for the tenant are hidden from the active Tenant Features list (both the active grid and the Override History list). The historical record itself is preserved in the SaaS Subscription Invoices section of the Billing tab and in the Commercial Audit log.
    -   **Resolver-side enforcement.** `resolveTenantFeature` strips Add-on attribution (`addOn`, `defaultPrice`) for plan-incompat tenants on `trial_active`, `paid_active`, `pending_payment`, and `disabled_by_plan` branches; `type === 'addon'` overrides downgrade to `enabled_by_paid_override` so no row's primary pill ever reads "Add-on" when the Add-on is plan-incompatible. Grant handlers (`handleEnableTrial`, `handleEnablePaidOverride`) only persist `addOnId` on the override + invoice + audit when the Add-on is currently eligible for the tenant.
    -   **The labels `Add-on available` and `Plan upgrade required` are not used anywhere** on the Tenant Features tab. The only allowed label set is: `Included by Plan`, `Add-on`, `Not in Plan`, `Trial`, `Paid Override`, `Pending Payment`, `Revoked`, `Trial Expired`, `Not Available`, `In Development`, plus `Custom Price` where applicable.
    -   The `Custom Price` pill (rendered separately below the price line) is independent of the add-on label and only appears when the tenant-specific price diverges from the catalog price.
    -   The Tenant Features tab is a commercial-entitlement surface only — it must NOT render permission chips, locked sub-permission badges, or any "Permissions Impact" block. Role-permission detail lives exclusively in the Store Permissions Matrix, which follows resolved entitlement (in-plan / active trial / active paid override expose linked permissions; pending payment / cancelled-before-activation / incompatible / disabled / archived do not).

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.