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
-   **Shipping Center**: Centralized fulfillment-ready module for managing shipments across all source documents. Features include a shipment list with filters (full tracking number visibility — never truncated, with copy-to-clipboard and `select-all break-all` styling), a 3-tab detail view, create/edit modals with package management, a status transition workflow, tracking event timeline, carrier/service level configuration, and cost tracking. Supports various shipment types and source documents, with integration for pre-populating data from source modules and manual source reference resolution. Shipments are fully editable only in `Draft` and `Ready` statuses, becoming edit-locked from `Label Created` status onward. It incorporates a runtime mode architecture for write guards based on `isPreviewModeEnabled` and RBAC for granular permissions. The system includes a provider adapter layer for integrating with external shipping carriers, an extended shipment data model, and a provider UI within the detail view for actions like address validation, rate fetching, label purchasing, and tracking synchronization, all permission-gated and respecting lifecycle locks. **Shipping > Settings ownership**: Provider management lives at `/shipping/settings` as a native child route of Shipping Center. The main view tab bar shows Shipments | Settings. The inline Provider & Operations panel links to "Shipping Settings — Providers". The legacy `/settings/shipping-providers` path now redirects to `/shipping/settings` — there is no competing provider management screen. The Settings page "Manage Providers" button also routes to `/shipping/settings`. Provider settings are RBAC-gated behind `manage_shipping_settings`. **Packed-only-after-label-purchase gating**: The Packed status is only available from `Label Created` (after successful label purchase). From `Ready` status, only `Cancelled` is available — Packed cannot be reached without purchasing a label first. This enforces the operational rule: Ready → (label purchase) → Label Created → Packed → Dispatched. **PDF-only primary label handling**: EasyPost explicitly requests PDF via `label_format: PDF` and hard-sets format to `pdf`. The UI detects the actual label format from URL patterns and format field via `getLabelActualFormat()`. If the label is PDF, the button shows "Open PDF Label" with the pdf icon. If the provider returned a non-PDF format (e.g., PNG in test mode), the button shows the honest format with an amber warning style and a "Non-PDF format" indicator with tooltip explaining this may occur with test credentials. **Post-dispatch lifecycle governance**: After Dispatched, manual status transitions (In Transit, Delivered, Exception) are completely blocked — these statuses are provider-driven only, updated via Sync Tracking. The UI shows a post-dispatch control banner explaining the rule. **Hard cancellation blocking after carrier acceptance/progression**: `hasCarrierAcceptance()` checks ALL provider tracking events (including simulated test events) for acceptance/progression statuses (accepted, in_transit, out_for_delivery, delivered, available_for_pickup). Once ANY provider event shows such status, cancellation is blocked. There is no test-mode bypass. Defense-in-depth guard in `handleStatusTransition()`. **Rejected by Carrier / Returned controlled outcomes**: Two new terminal statuses with mandatory reason capture. Rejected is available from Dispatched, In Transit, and Exception. Returned is available from Delivered and Exception. Each requires selecting a predefined reason from a curated list (7 rejection reasons, 7 return reasons) with optional notes. The reason is recorded in the shipment timeline event. These statuses are terminal — no further transitions are available. Gated behind `canDispatch` permission. Predefined rejection reasons: invalid address, package refused, carrier restrictions, hazardous contents, customs failure, service disruption, other. Return reasons: delivery failed, customer refused, incomplete address, damaged in transit, unclaimed/expired, customs rejection, other. **Destination address autocomplete with suggestion dropdown**: City field shows a real suggestion dropdown as the user types, powered by a local database of 500+ US zip codes covering 40+ major cities. Selecting a suggestion auto-fills city, state, and postal code. Postal code field also triggers suggestions for matching zips and auto-fills city/state on 5-digit match. The architecture uses an `AddressSuggestion` interface and `searchAddressSuggestions()` adapter function, ready for external autocomplete providers (Google Places, Smarty Streets, etc.) without UX redesign. When no external provider is configured, the local database is used honestly with a footer note. Unknown zips show an info message. Green checkmark on successful zip match. **Three-tier event sourcing**: Provider (sky-blue), Test Provider (amber), Manual (grey) badges on tracking timeline. Simulate Provider Events button in test mode. **RepairDesk-inspired**: Ticket-to-shipment source resolution, carrier rejection/return handling, provider-owned settings surface, label-as-commitment gateway, address friction reduction. Future: carrier markup, customer self-serve tracking portal, return label workflow, full street-level autocomplete, email notifications on tracking ID, webhook retry/replay, dispatch batch workflows, packing-station enhancements, delivery exception resolution workflows, shipment manifest/scan forms, carrier void/refund flow.
-   **Shipping Provider Configuration**: Centralized configuration system accessible from Shipping Center (`/shipping/settings`) — the sole primary provider management surface. The Settings page "Manage Providers" button and the legacy `/settings/shipping-providers` path both redirect to `/shipping/settings`. When accessed from the Shipping Center, shows a "Back to Shipping Center" breadcrumb with "Shipping > Settings > Providers" path label. Supports EasyPost, Shippo, and ShipStation with credential configuration (masked display), environment selection, connection testing, and active provider selection. **All shipping provider API calls and credentials are managed server-side** via an Express API on port 5001 (`server/index.ts`), with Vite proxying `/api/shipping/*` requests. Credentials are stored in a secure server-side in-memory store (`server/credential-store.ts`) — raw credentials never reach the browser. The client communicates via `src/shipping/shippingApiClient.ts`. All configuration actions are gated by `manage_shipping_settings` sub-permission and respect preview mode.
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