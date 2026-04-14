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
-   **Shipping Center**: Centralized fulfillment-ready module for managing shipments across all source documents. Features include a shipment list with filters (full tracking number visibility — never truncated, with copy-to-clipboard and `select-all break-all` styling), a 3-tab detail view, create/edit modals with package management, a status transition workflow, tracking event timeline, carrier/service level configuration, and cost tracking. Full shipment lifecycle: Draft → Ready → (label purchase) → Label Created → Packed → Dispatched → [In Transit → Delivered] (provider-driven) | [Rejected / Returned] (controlled outcomes). Terminal statuses: Cancelled, Rejected, Returned. Supports various shipment types and source documents, with integration for pre-populating data from source modules and manual source reference resolution. Shipments are fully editable only in `Draft` and `Ready` statuses, becoming edit-locked from `Label Created` status onward. It incorporates a runtime mode architecture for write guards based on `isPreviewModeEnabled` and RBAC for granular permissions. The system includes a provider adapter layer for integrating with external shipping carriers, an extended shipment data model, and a provider UI within the detail view for actions like address validation, rate fetching, label purchasing, and tracking synchronization, all permission-gated and respecting lifecycle locks. **Shipping > Settings ownership (sole primary)**: Provider management lives exclusively at `/shipping/settings` as a native child route of Shipping Center. The main view tab bar shows Shipments | Settings. The legacy `/settings/shipping-providers` path redirects to `/shipping/settings`. The Settings page Shipping section shows a "moved" notice with a redirect button — it is NOT a provider management surface. There is exactly one live provider-management screen in the entire app, and it is inside Shipping Center. **Packed-only-after-label-purchase gating**: The Packed status is only available from `Label Created` (after successful label purchase). From `Ready` status, only `Cancelled` is available — Packed cannot be reached without purchasing a label first. **PDF-only primary label with print-ready workflow**: EasyPost requests PDF via `label_format: PDF`. When the label IS PDF, the primary action is "Print PDF Label" which opens the PDF and triggers the browser print dialog for immediate printing. A secondary "View" button opens the PDF in a new tab. When the provider returns a non-PDF format (e.g., PNG in test mode), the UI honestly states "Not PDF — provider returned [FORMAT]" with amber warning styling. No fake PDF labels. **Post-dispatch lifecycle governance**: After Dispatched, manual status transitions (In Transit, Delivered, Exception) are blocked — these are provider-driven only via Sync Tracking. Post-dispatch control banner explains the rule per status. **Hard cancellation blocking after carrier acceptance**: `hasCarrierAcceptance()` checks ALL provider tracking events for acceptance/progression statuses. No test-mode bypass. Defense-in-depth guard in `handleStatusTransition()`. **Rejected by Carrier / Returned controlled outcomes**: Two terminal statuses with mandatory reason capture. Rejected available from Dispatched, In Transit, Exception. Returned available from Delivered, Exception. Each requires selecting a predefined reason (7 rejection reasons, 7 return reasons) with optional notes. Reason recorded in timeline event. Gated behind `canDispatch` permission. Rejection reasons: invalid address, package refused, carrier restrictions, hazardous contents, customs failure, service disruption, other. Return reasons: delivery failed, customer refused, incomplete address, damaged in transit, unclaimed/expired, customs rejection, other. **Destination address autocomplete with suggestion dropdown**: Primary search field is the address line 1 input (Google Places-style search icon + placeholder). Typing triggers city/state suggestions from local US database (500+ zip codes, 40+ cities). Suggestions show location pin icon with city, state, and zip. Selecting a suggestion fills city, state, and postal code. City field also has its own suggestion dropdown. Architecture uses `AddressSuggestion` interface with `source: local|provider` and `searchAddressSuggestions()` adapter — ready for external providers (Google Places, Smarty Streets) without UX redesign. Footer notes honestly state local database limitations. **Three-tier event sourcing**: Provider (sky-blue), Test Provider (amber), Manual (grey) badges on tracking timeline.
-   **Shipping Provider Configuration**: Centralized configuration system. The sole primary provider management surface is at `/shipping/settings` inside Shipping Center. The Settings page shows only a "moved" notice redirecting users to Shipping Center. The legacy `/settings/shipping-providers` URL automatically redirects to `/shipping/settings`. When inside Shipping Center, shows "Back to Shipping Center" breadcrumb with "Shipping > Settings > Providers" path. Supports EasyPost, Shippo, and ShipStation with credential configuration (masked display), environment selection, connection testing, and active provider selection. **All shipping provider API calls and credentials are managed server-side** via an Express API on port 5001 (`server/index.ts`), with Vite proxying `/api/shipping/*` requests. Credentials are stored in a secure server-side in-memory store (`server/credential-store.ts`) — raw credentials never reach the browser. The client communicates via `src/shipping/shippingApiClient.ts`. All configuration actions are gated by `manage_shipping_settings` sub-permission and respect preview mode.
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