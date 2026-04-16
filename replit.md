# Overview

This project is a multi-tenant SaaS frontend platform for small to medium-sized businesses. It provides a unified solution for business management, including Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform's core purpose is to streamline operations, offer actionable insights, and automate tasks through its scalable, customizable, and feature-rich design.

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

-   **Design System**: Consistent design language featuring rounded cards, a glass effect (`bg-white/80 backdrop-blur-xl`), and a primary color theme with a `ghost-border` utility.
-   **Typography**: `font-black uppercase tracking-widest` for labels.
-   **Animations**: Framer Motion for smooth UI transitions and consistent modal patterns.
-   **Notifications**: Toast notifications for user feedback.
-   **Accessibility**: Focus on semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Firebase Authentication with a 7-level hierarchical permission model.
-   **Tenant Management**: Full lifecycle management including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Point of Sale (POS)**: Comprehensive system for cart management, diverse payment options, tax/discount calculations, customer management, repair intake, held orders, quick add stock, operator switching with RBAC, refund workflows, and warranty claims.
-   **Employee Management**: Features employee, role, time tracking, and payroll management with granular permissions.
-   **CRM (Customers)**: Enriched CRM with multi-field search, loyalty management, duplicate detection, and integrated order/invoice history.
-   **Invoices**: Full invoice lifecycle management with dynamic line items, searchable catalog, payment processing, supervisor PIN-authorized reopen, and configurable document templates.
-   **Services**: Manages a service catalog with CRUD, warranty configuration, bulk price editing, and dependency-aware delete confirmations.
-   **Repairs Module**: Full repair ticket lifecycle management with structured workflow, parts tracking, technician assignment, activity timeline, and financial summary.
-   **Reporting**: Dashboard with data visualizations.
-   **Onboarding**: Multi-step process for new tenants including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: Structured template builder for 5 document types with deterministic HTML generation, branding, and visual preview.
-   **Inventory Management**: Comprehensive system for managing various `StockItem` types (serialized, non-serialized, handset) with features like UPC/manufacturer/location tracking, min/max stock, serial number tracking, advanced filtering, stock adjustments, global movements log, inventory transfer lifecycle, stock counts, and trade-in management, all integrated with RBAC.
-   **Supply Chain Management**: Manages suppliers, purchase orders, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, gated by RBAC.
-   **Shipping Center**: Centralized fulfillment module for managing shipments across all source documents, supporting various shipment types. Features include shipment listing with filters, detailed views, create/edit modals with package management, status transition workflows, tracking event timelines, carrier/service level configuration, cost tracking, and integration for data pre-population. Includes a provider adapter layer for external shipping carriers and a runtime mode architecture. Key features include:
    -   **PDF-Only Primary Label**: Ensures primary label generation always results in a PDF, handling conversions if necessary.
    -   **Shipment Mode Split (Provider vs Manual)**: Dynamically computes shipment mode based on rate selection, enabling or disabling provider-backed actions accordingly.
    -   **Address Editability**: Allows editing of origin and destination addresses for specific shipment statuses.
    -   **Unified Provider Status Source of Truth**: Manages and displays shipping provider statuses consistently across the UI.
    -   **Webhook/Event Processing Pipeline**: A unified pipeline for all shipping provider webhooks and tracking syncs, featuring idempotency, status mapping, status progression awareness, provider-specific parsers, a durable webhook audit log, and security measures (HMAC-SHA256 signature verification).
    -   **Bulk Sync / Reconciliation**: A secondary recovery tool for bulk tracking synchronization of eligible provider-mode shipments, featuring eligibility scoping, batch processing, and detailed result reporting.
    -   **Phone Prerequisites & Normalization**: `getLabelPrerequisites()` checks for phone on **both origin (shipper) and destination (recipient)** for UPS/FedEx. FedEx requires both — missing either triggers `PHONENUMBER.EMPTY`. Validation requires ≥10 digits. All three adapters (EasyPost, Shippo, ShipStation) normalize phones at the adapter boundary: strip non-digits, reject <10, prepend country code 1 for 10-digit US numbers. Phone source-of-truth flows: UI state → shipment object → `handlePurchaseLabel` → server → adapter `normalizePhone()` → provider API. Server-side `[purchase-label]` and `[EasyPost]` logs trace phone values at each boundary. Seed data and `STORE_ADDRESS` use proper 10-digit phones.

-   **Returns Portal / Reverse Logistics (Phase 2)**: First-class returns management module with its own dedicated route (`/returns`), sidebar entry, and permission domain (`returns`). Key architecture:
    -   **Return Domain Model**: `Return` interface with full source linkage (invoice, repair, shipment, RMA, walk-in), customer linkage, item-level detail with condition tracking, and audit trail via `statusHistory`. Forward-compatible fields for service points (`servicePointId`), customs docs (`customsInfo`), pickup requests (`pickupRequestId`), and insurance (`insuranceClaimId`).
    -   **Return Lifecycle**: Draft → Requested → Approved → Label Created → In Transit → Received → Inspecting → Completed. Also supports Rejected and Cancelled terminal states. Each transition is recorded in `statusHistory` with timestamp, performer, and notes.
    -   **Return Reasons**: Structured selection — defective, wrong_item, not_as_described, damaged_in_transit, customer_changed_mind, warranty_claim, repair_return, exchange_request, missing_parts, other.
    -   **Requested Resolution / Final Resolution**: refund, exchange, repair, store_credit, inspection_only, send_back, dispose. Requested resolution captured at creation; final resolution captured at disposition — allows divergence.
    -   **Item Disposition**: restock, refurbish, dispose, return_to_vendor, send_back_to_customer, warranty_replacement. Per-item disposition supported via `ReturnItem.disposition`.
    -   **Intake & Inspection**: Structured intake workflow — received timestamp/person, item-level condition assessment, inspection notes, inspection completion timestamp/person. Moves return through Received → Inspecting states.
    -   **Disposition Completion**: Final resolution, disposition, financial amounts (refund, store credit, restocking fee), disposition notes. Completes the return lifecycle.
    -   **Source Reference Number Resolution**: Return creation modal (`CreateReturnModal`) supports first-class source reference resolution. Operator selects source type (invoice, repair, shipment, RMA) and enters a reference number, then clicks "Resolve" to auto-populate customer, items, source linkage, and original shipment ID from the source record. Same UX pattern as ShippingCenter's source resolution. Eligible statuses: Invoice (Paid/Partially Paid), Repair (Completed/Delivered/Ready for Pickup), Shipment (Delivered outbound only), RMA (any). Walk-in source type skips resolution. Source reference number is prominently displayed in return detail view (font-mono teal text) and in the returns list table.
    -   **Source Entry Points**: Returns can be initiated from invoices (Paid status, `Invoices.tsx`), repair tickets (Completed/Delivered status, `RepairTickets.tsx`), and shipments (Delivered status, `ShippingCenter.tsx`). Each entry point uses `navigate('/returns', { state: { openCreate: true, prefill } })` with a `ReturnPrefill` object that pre-populates customer, source, items, and reason. Walk-in and RMA source types also supported via direct creation.
    -   **Shipment Integration**: Full return shipment creation flow via `CreateReturnShipmentModal` in `ReturnsPortal.tsx`. Creates a `Shipment` with `returnInfo.isReturn = true`, source linked to the return. Origin = customer address (editable), destination = store warehouse. Return shipments visible in Shipping Center with a teal "Return" badge. `originalShipmentId` links to the outbound shipment; `returnShipmentId` links to the return shipment. Provider/manual mode rules preserved — return shipments follow the same Shipping Center discipline as outbound shipments (rates, label purchase, tracking sync all work from the Shipping Center after creation).
    -   **Return/Shipment Lifecycle Synchronization**: Return status does NOT advance to "Label Created" on return shipment creation (shipment starts as Draft). A `useEffect` auto-sync watches the linked shipment's status and advances the return status accordingly: Shipment "Label Created"/"Packed" → Return "Label Created"; Shipment "Dispatched"/"In Transit" → Return "In Transit". Auto-sync only advances forward (never regresses). When the shipment is still Draft, the return detail shows an amber notice directing the operator to the Shipping Center for label purchase.
    -   **Received Gating**: The "Received" transition is blocked until the linked return shipment reaches "Delivered" status. The detail modal shows a contextual notice: "Received will be available once shipment shows Delivered" when the shipment is in transit, and "Shipment delivered — you can now mark this return as Received" when ready. The `Approved` status no longer offers a direct path to `Received` — the return must go through the full shipping lifecycle (Label Created → In Transit → Received).
    -   **Return Label Delivery to Customer**: `LabelDeliveryModal` provides an operator path to send the return label to the customer. Available when the linked shipment has a label, tracking number, or label URL. Two delivery options: (1) "Copy Instructions" — copies formatted customer instructions (return authorization, carrier, tracking, label link, step-by-step instructions, items list) to clipboard; (2) "Email Customer" — opens the default mail client with pre-populated subject and body addressed to the customer's email. Accessible via "Send Label to Customer" button in the return detail's shipment section.
    -   **Permissions**: `returns` permission domain with sub-permissions: create_return, approve_return, receive_return, inspect_return, complete_return_disposition, cancel_return, create_return_shipment. Plan-gated to Growth and Advanced tiers.
    -   **Preview Mode**: All write actions gated by `isWriteBlocked`. Preview mode shows disabled state with "Preview Mode — Actions Disabled" indicator.
    -   **RepairDesk Article Insights Adapted**: Shipping from tickets/invoices entry points, label printing status triggers, inbound/outbound label distinction, two-way tracking sync readiness. Flat rate not adopted (not relevant to returns). ShipStation UX not copied (our architecture is provider-agnostic).
    -   **Phase 2 Forward-Compatibility**: Return model includes placeholder fields for service points (servicePointId), customs docs (customsInfo object), pickup requests (pickupRequestId), insurance claims (insuranceClaimId). These are not implemented but architecturally ready.
    -   **Phase 3 Forward-Compatibility**: Return lifecycle and statusHistory are automation-friendly (structured status transitions). Status timestamps stored for future SLA optimization and carrier scorecards. Return events compatible with future automation rules and batch processing.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Primarily React Context API and local component state.
-   **Firebase Integration**: Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Gemini API for AI functionalities.
-   **Server-Side Shipping API**: Express server on port 5001 handles all shipping provider operations, with credentials stored securely server-side.
-   **Configuration**: `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: For UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.