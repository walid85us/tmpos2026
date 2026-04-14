# Overview

This project is a multi-tenant SaaS frontend platform designed for small to medium-sized businesses. It offers a comprehensive solution for business management, integrating Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform aims to streamline operations, provide valuable insights, and automate tasks through scalability, customization, and a rich feature set.

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

-   **Authentication & Access Control**: Firebase Authentication with a 7-level hierarchical permission model.
-   **Tenant Management**: Full lifecycle management including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Point of Sale (POS)**: Comprehensive system covering cart management, diverse payment options, tax/discount calculations, customer management, repair intake, held orders, quick add stock, operator switching with RBAC, refund workflows, and warranty claims.
-   **Employee Management**: Features employee, role, time tracking, and payroll management with granular permissions.
-   **CRM (Customers)**: Enriched CRM with multi-field search, loyalty management, duplicate detection, and integrated order/invoice history.
-   **Invoices**: Full invoice lifecycle management with dynamic line items, searchable catalog, payment processing, supervisor PIN-authorized reopen, and configurable document templates.
-   **Services**: Manages a service catalog with CRUD, warranty configuration, bulk price editing, and dependency-aware delete confirmations.
-   **Repairs Module**: Full repair ticket lifecycle management with structured workflow, parts tracking, technician assignment, activity timeline, and financial summary.
-   **Reporting**: Dashboard with data visualizations.
-   **Onboarding**: Multi-step process for new tenants including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: Structured template builder for 5 document types with deterministic HTML generation, branding, and visual preview.
-   **Inventory Management**: Comprehensive system for managing `StockItem` types (serialized, non-serialized, handset) with flags, UPC/manufacturer/location, min/max stock, cost price, serial number tracking, advanced filtering, stock adjustment, global movements log, inventory transfer lifecycle, stock count, and trade-in management. Integrates repair parts and POS sales movements with RBAC.
-   **Supply Chain Management**: Manages suppliers, purchase orders (PO) lifecycle, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, all RBAC-gated.
-   **Shipping Center**: Centralized fulfillment-ready module for managing shipments across all source documents, supporting various shipment types and source documents. Features include a shipment list with filters, a 3-tab detail view, create/edit modals with package management, status transition workflow, tracking event timeline, carrier/service level configuration, cost tracking, and integration for pre-populating data from source modules. Includes a provider adapter layer for external shipping carriers and a runtime mode architecture for write guards.
    -   **PDF-Only Primary Label**: The label artifact pipeline ensures the primary label action always results in a real PDF. The server requests `label_format: 'PDF'` from EasyPost. If the provider returns PNG (common in test mode), a server-side label proxy (`/api/shipping/label-proxy`) bypasses CORS, and client-side Canvas→JPEG→DCTDecode PDF construction produces a real PDF blob. Fallback: if client-side conversion fails, the proxied image URL is used directly. Label metadata honestly records `originalFormat` when conversion occurred.
    -   **Shipment Mode Split (Provider vs Manual)**: Mode is purely computed, not stored as a field. Rule: if `selectedRate` exists → provider mode; if `carrier && serviceLevel` without `selectedRate` → manual mode; otherwise provider (default). Manual carrier/service entry in the edit modal automatically forces manual mode. Clearing carrier/service reverts to provider mode. In manual mode: all provider-backed actions (Validate Address, Get Rates, Purchase Label, Sync Tracking, Simulate Provider Events) are hidden. The manual mode banner explains why provider actions are disabled and instructs user to clear carrier/service to restore provider features. In provider mode: full workflow (address validation → Get Rates → rate selection → Purchase Label → tracking sync). Provider prerequisites (address validation, packages, provider configured) recalculate on every render from live shipment state.
    -   **Address Editability**: Origin and destination addresses are editable in the edit modal for statuses Draft, Ready, Label Created, and Packed (i.e., before Dispatched). Changing the destination address clears any previous address validation to force re-validation. The edit modal includes full address form fields (name, line1, city, state, postal code) for both origin and destination.
    -   **Post-dispatch lifecycle**: Robust governance with carrier acceptance tracking, Rejected/Returned with reasons, Dispatched→Packed rollback (with required reason) when carrier has not yet accepted the package, and provider-driven progression in provider mode.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Primarily React Context API and extensive local component state.
-   **Firebase Integration**: Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Gemini API for AI functionalities.
-   **Server-Side Shipping API**: Express server (`server/index.ts`) on port 5001 handles all shipping provider operations. Credentials are stored securely server-side. Vite proxies `/api/shipping/*` requests in development.
-   **Configuration**: `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: For UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.