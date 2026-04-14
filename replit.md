# Overview

This project is a multi-tenant SaaS platform frontend designed for small to medium-sized businesses. It offers a comprehensive solution for business management, integrating Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform aims to streamline operations, provide valuable insights, and automate tasks through scalability, customization, and a rich feature set.

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

-   **Design System**: Consistent design language with `rounded-[2.5rem]` or `rounded-[3rem]` cards, `bg-white/80 backdrop-blur-xl` glass effect, and a primary color theme with a `ghost-border` utility.
-   **Typography**: `font-black uppercase tracking-widest` for labels.
-   **Animations**: Framer Motion (`motion/react`) for smooth UI transitions and consistent modal patterns with `AnimatePresence`.
-   **Notifications**: Toast notifications for user feedback.
-   **Accessibility**: Focus on semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Firebase Authentication with a 7-level hierarchical permission model for platform and tenant roles.
-   **Tenant Management**: Full lifecycle management including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Point of Sale (POS)**: Comprehensive system covering cart management, diverse payment options, tax/discount calculations, customer management, repair intake, held orders, quick add stock, operator switching with RBAC, refund workflows, and warranty claims.
-   **Employee Management**: Features employee, role, time tracking, and payroll management with granular permissions.
-   **CRM (Customers)**: Enriched CRM with multi-field search, loyalty management, duplicate detection, and integrated order/invoice history.
-   **Invoices**: Full invoice lifecycle management with dynamic line items, searchable catalog, payment processing, supervisor PIN-authorized reopen, and configurable document templates.
-   **Services**: Manages a service catalog with CRUD, warranty configuration, bulk price editing, and dependency-aware delete confirmations.
-   **Repairs Module**: Full repair ticket lifecycle management with structured workflow, parts tracking, technician assignment, activity timeline, and financial summary.
-   **Reporting**: Dashboard with data visualizations powered by Recharts.
-   **Onboarding**: Multi-step process for new tenants including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: Structured template builder for 5 document types with deterministic HTML generation, branding, and visual preview.
-   **Data Flow**: `StoreLocalState.tsx` for managing shared local mock state across entities.
-   **Feature Gating & Navigation Derivation**: Merge-based strategy for plan feature resolution, combining static `planFeatures` with dynamic `features_data` from `sessionStorage`.
-   **Dashboard Quick Actions**: Quick Intake, Print Label, Scan QR, Add Stock, and Held Orders with dynamic low-stock alerts and inventory details.
-   **Inventory Management**: Comprehensive system for managing `StockItem` types (serialized, non-serialized, handset) with flags, UPC/manufacturer/location, min/max stock, cost price, serial number tracking, advanced filtering, stock adjustment, global movements log, inventory transfer lifecycle, stock count, and trade-in management. Integrates repair parts and POS sales movements with RBAC.
-   **Supply Chain Management**: Manages suppliers, purchase orders (PO) lifecycle, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, all RBAC-gated.
-   **Shipping Center**: Centralized fulfillment-ready module for managing shipments across all source documents. Features include a shipment list with filters (full tracking number visibility — never truncated, with copy-to-clipboard and `select-all break-all` styling), a 3-tab detail view, create/edit modals with package management, a status transition workflow, tracking event timeline, carrier/service level configuration, and cost tracking. Supports various shipment types and source documents, with integration for pre-populating data from source modules and manual source reference resolution. Shipments are fully editable only in `Draft` and `Ready` statuses, becoming edit-locked from `Label Created` status onward. It incorporates a runtime mode architecture for write guards based on `isPreviewModeEnabled` and RBAC for granular permissions. The system includes a provider adapter layer for integrating with external shipping carriers, an extended shipment data model, and a provider UI within the detail view for actions like address validation, rate fetching, label purchasing, and tracking synchronization, all permission-gated and respecting lifecycle locks. **Shipping > Settings ownership**: Provider management lives at `/shipping/settings` as a native child route of Shipping Center. The main view tab bar shows Shipments | Settings. The inline Provider & Operations panel links to "Shipping Settings — Providers". The `/settings/shipping-providers` legacy path remains functional. Provider settings are RBAC-gated behind `manage_shipping_settings`. **Packed-only-after-label-purchase gating**: The Packed status is only available from `Label Created` (after successful label purchase). From `Ready` status, only `Cancelled` is available — Packed cannot be reached without purchasing a label first. This enforces the operational rule: Ready → (label purchase) → Label Created → Packed → Dispatched. **PDF-only primary label handling**: EasyPost explicitly requests PDF via `label_format: PDF` and hard-sets format to `pdf`. The UI detects the actual label format from URL patterns and format field via `getLabelActualFormat()`. If the label is PDF, the button shows "Open PDF Label" with the pdf icon. If the provider returned a non-PDF format (e.g., PNG in test mode), the button shows the honest format with an amber warning style and a "Non-PDF format" indicator with tooltip explaining this may occur with test credentials. **Post-dispatch lifecycle governance**: After Dispatched, manual status transitions (In Transit, Delivered, Exception) are completely blocked — these statuses are provider-driven only, updated via Sync Tracking. The UI shows a post-dispatch control banner explaining the rule. **Hard cancellation blocking after carrier acceptance/progression**: `hasCarrierAcceptance()` checks ALL provider tracking events (including simulated test events) for acceptance/progression statuses (accepted, in_transit, out_for_delivery, delivered, available_for_pickup). Once ANY provider event shows such status, cancellation is blocked. There is no test-mode bypass — this ensures cancellation is blocked even after simulated delivery events. Defense-in-depth: `handleStatusTransition()` also enforces these rules at execution time, not just at button rendering. **Destination address autocomplete**: Built-in US zip code → city/state auto-fill for the destination address in the create shipment form. When a 5-digit zip code is entered, city and state fields are automatically populated from a local database covering 400+ zip codes across 40+ major US cities. A green checkmark indicates a successful lookup. If the zip code is not in the local database, an info message tells the user to enter city/state manually and notes that full address autocomplete is available with provider integration (future). Architecture-ready for external autocomplete providers (Google Maps, Smarty Streets, etc.). **Three-tier event sourcing**: Provider (sky-blue), Test Provider (amber), Manual (grey) badges on tracking timeline. Simulate Provider Events button in test mode. Carrier-scan-not-yet-received messaging post-dispatch. **RepairDesk-inspired**: Ticket-to-shipment source resolution, carrier markup (future), customer self-serve tracking portal (future), return label workflow (future), address autocomplete (partial now, full later), email notifications on tracking ID (future).
-   **Shipping Provider Configuration**: Centralized configuration system accessible from Shipping Center (`/shipping/settings`), from inline provider panel in shipment detail, and via legacy path Settings (`/settings/shipping-providers`). When accessed from the Shipping Center, shows a "Back to Shipping Center" breadcrumb with "Shipping > Settings > Providers" path label. Supports EasyPost, Shippo, and ShipStation with credential configuration (masked display), environment selection, connection testing, and active provider selection. **All shipping provider API calls and credentials are managed server-side** via an Express API on port 5001 (`server/index.ts`), with Vite proxying `/api/shipping/*` requests. Credentials are stored in a secure server-side in-memory store (`server/credential-store.ts`) — raw credentials never reach the browser. The client communicates via `src/shipping/shippingApiClient.ts`. All configuration actions are gated by `manage_shipping_settings` sub-permission and respect preview mode.
-   **POS Orders Lookup**: Searchable order history with detailed invoice view.
-   **POS Cart Merge**: Automatically merges identical inventory items in the cart.
-   **POS Finalize**: Creates `CompletedOrder` records and decrements stock.
-   **Stock Count Integrity**: Cart displays remaining stock with visual indicators.
-   **Store Permissions Matrix**: Interactive matrix in `EmployeesPermissionsPage` for role-domain permission configuration.
-   **Supervisor Refund Authorization**: Allows supervisor approval for refunds via PIN.
-   **UI Feedback**: Consistent visual feedback for successful saves.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Primarily React Context API and extensive local component state.
-   **Firebase Integration**: Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Gemini API for AI functionalities.
-   **Server-Side Shipping API**: Express server (`server/index.ts`) on port 5001 handles all shipping provider operations. Server-side adapters in `server/adapters/` call EasyPost/Shippo/ShipStation APIs with credentials from `server/credential-store.ts`. Vite proxies `/api/shipping/*` to the Express server in development. The client uses `src/shipping/shippingApiClient.ts` — a thin fetch-based client that never touches raw credentials.
-   **Configuration**: `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: For UI animations and transitions.