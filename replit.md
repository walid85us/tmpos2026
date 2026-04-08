# Overview

This project is a multi-tenant SaaS platform frontend designed for small to medium-sized businesses, offering a comprehensive solution for business management. It integrates Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform emphasizes scalability, customization, and feature richness to streamline operations and provide valuable insights and automation.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# System Architecture

## Frontend

The frontend is built using React 19, TypeScript, Vite 6, and Tailwind CSS v4 to deliver a modern, responsive, and interactive user experience.

## UI/UX Decisions

-   **Design System**: Features a consistent design language with `rounded-[2.5rem]` or `rounded-[3rem]` cards, `bg-white/80 backdrop-blur-xl` glass effect, and a primary color theme with a `ghost-border` utility.
-   **Typography**: Employs `font-black uppercase tracking-widest` for labels.
-   **Animations**: Utilizes `motion/react` (Framer Motion) for smooth UI transitions and consistent modal patterns with `AnimatePresence`.
-   **Notifications**: Implements toast notifications for user feedback.
-   **Accessibility**: Focuses on semantic accessibility for form inputs, keyboard-navigable table rows, and modal dialogs.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Leverages Firebase Authentication for platform and tenant-specific roles, supporting a 7-level hierarchical permission model with granular sub-permissions.
-   **Tenant Management**: Manages the full tenant lifecycle, including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Point of Sale (POS)**: Comprehensive POS system covering cart management, diverse payment options, tax and discount calculations, customer management, repair intake, held orders, quick add stock, operator switching with RBAC, refund workflows, and warranty claims with supervisor PIN authorization.
-   **Employee Management**: Features employee, role, time tracking, and payroll management with granular permissions.
-   **CRM (Customers)**: Offers an enriched CRM with multi-field search, loyalty management (tiering, points), duplicate detection, and integrated order/invoice history.
-   **Invoices**: Full invoice lifecycle management with dynamic line items, searchable inventory/service catalog, payment processing (Cash, Card Terminal), supervisor PIN-authorized reopen feature, and print functionality using configurable document templates with branding.
-   **Services**: Manages a service catalog with CRUD operations, warranty configuration, bulk price editing, and dependency-aware delete confirmations.
-   **Repairs Module**: Provides full repair ticket lifecycle management with a structured workflow, device intake, parts tracking, technician assignment, activity timeline, financial summary, and integration with POS for payment collection.
-   **Reporting**: Features a dashboard with data visualizations powered by Recharts.
-   **Onboarding**: Multi-step onboarding process for new tenants, including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured template builder in Settings for 5 document types, allowing deterministic HTML generation from `enabledTags`, branding management, and visual preview.
-   **Data Flow**: Utilizes `StoreLocalState.tsx` for managing shared local mock state across various entities like customers, stock, orders, invoices, services, loyalty configurations, and supply chain components.
-   **Feature Gating & Navigation Derivation**: Employs a merge-based strategy for plan feature resolution, combining static `planFeatures` with dynamic `features_data` from `sessionStorage`, supporting both `featureMatrix` and legacy `planEntry` formats.
-   **Dashboard Quick Actions**: Includes Quick Intake (repair), Print Label, Scan QR (inventory search), Add Stock, and Held Orders. Features dynamic low-stock alerts with in-dashboard modals for viewing details and adjusting stock (permission-gated).
-   **Inventory Management**: Comprehensive system for managing `StockItem` types (serialized, non-serialized, handset) with flags like `isRepairPart` and `isHiddenOnPOS`, UPC/manufacturer/location fields, min/max stock levels, cost price, and serial number tracking. Features advanced filtering, stock adjustment with reason tracking, global movements log, inventory transfer lifecycle, stock count closure, trade-in management with ID photo capture and refurbishment flows, and detailed stock movement tracking for all inventory changes. Integrates repair parts and POS sales movements with RBAC gating for various actions.
-   **Supply Chain Management**: Manages suppliers, purchase orders (PO) with multi-item creation and lifecycle (Draft → Ordered → Partially Received → Received), Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking, resolution, and financial recording (SupplierRefundEntry). All modules are RBAC-gated.
-   **POS Orders Lookup**: Searchable order history with detailed invoice view for actions.
-   **POS Cart Merge**: Automatically merges identical inventory items in the cart.
-   **POS Finalize**: Creates `CompletedOrder` records and decrements stock.
-   **Stock Count Integrity**: Cart displays remaining stock with visual indicators.
-   **Store Permissions Matrix**: Interactive matrix in `EmployeesPermissionsPage` for role-domain permission configuration.
-   **Supervisor Refund Authorization**: Allows supervisor approval for refunds via PIN.
-   **UI Feedback**: Provides consistent visual feedback for successful saves.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Primarily uses React Context API for global state and extensive local component state.
-   **Firebase Integration**: Leverages Firebase Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Utilizes the Gemini API for incorporating AI functionalities.
-   **Configuration**: `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore (database) and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai` for AI features.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: For UI animations and transitions.