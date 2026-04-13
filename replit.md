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
-   **Shipping Center**: Centralized fulfillment-ready module for managing shipments across all source documents. Features include a shipment list with filters (full tracking number visibility — never truncated, with copy-to-clipboard), a 3-tab detail view, create/edit modals with package management, a status transition workflow, tracking event timeline, carrier/service level configuration, and cost tracking. Supports various shipment types and source documents, with integration for pre-populating data from source modules and manual source reference resolution. Shipments are fully editable only in `Draft` and `Ready` statuses, becoming edit-locked from `Label Created` status onward. It incorporates a runtime mode architecture for write guards based on `isPreviewModeEnabled` and RBAC for granular permissions. The system includes a provider adapter layer for integrating with external shipping carriers, an extended shipment data model, and a provider UI within the detail view for actions like address validation, rate fetching, label purchasing, and tracking synchronization, all permission-gated and respecting lifecycle locks. **Shipping Center-native Provider Settings**: The Provider & Operations section includes an inline expandable provider settings panel showing all configured providers with status, environment badges (Test/Live), active indicator, connection test button, and a link to full provider settings — the primary entry path for provider management within the shipping workflow. Provider errors are translated to user-friendly messages while preserving honesty. **Fulfillment prerequisites are enforced**: Get Rates requires validated/accepted address + packages + configured provider; Purchase Label requires same + selected rate or manual carrier/service. Both buttons show disabled state with hover tooltips listing unmet prerequisites. **PDF-first label output**: EasyPost explicitly requests PDF format (`label_format: PDF`) and the label artifact format is hard-set to `pdf` (not URL-inferred). Shippo uses `label_file_type: PDF`. ShipStation returns base64 PDF. Label display shows format badge (PDF in red, PNG in grey). **Provider-fed tracking/event display**: The Tracking tab merges manual events and provider-synced events in a unified timeline with three-tier source badges: Provider (sky-blue, real carrier data), Test Provider (amber, simulated test data), and Manual (grey, user-entered). In test mode, a Simulate Provider Events button generates realistic test tracking events to verify timeline display without real carrier data. Events clearly labeled as test data. **Test-mode vs live-mode messaging**: Test Mode banner in Provider & Operations explains limitations. Tracking tab shows Test Mode badge on sync timestamps. Simulated events carry [TEST] prefix in descriptions and Test Provider source badge. A webhook endpoint (POST /api/shipping/webhook/:providerId) with provider/credential/signature validation is available as a foundation for automatic tracking updates from providers. **RepairDesk-inspired enhancements**: Ticket-to-shipment source resolution, return label workflow readiness, customer self-serve tracking (future), carrier markup (future), address autocomplete (future).
-   **Shipping Provider Configuration**: Centralized configuration system accessible from Settings → Shipping and directly from the Shipping Center's Provider & Operations section. Supports EasyPost, Shippo, and ShipStation with credential configuration (masked display), environment selection, connection testing, and active provider selection. **All shipping provider API calls and credentials are managed server-side** via an Express API on port 5001 (`server/index.ts`), with Vite proxying `/api/shipping/*` requests. Credentials are stored in a secure server-side in-memory store (`server/credential-store.ts`) — raw credentials never reach the browser. The client communicates via `src/shipping/shippingApiClient.ts`. All configuration actions are gated by `manage_shipping_settings` sub-permission and respect preview mode.
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