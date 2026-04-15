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