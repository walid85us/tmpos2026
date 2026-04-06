# Overview

This project is a multi-tenant SaaS platform frontend providing a comprehensive business management solution. It enables store owners to manage point-of-sale (POS), employee management, customer relationships (CRM), inventory, reporting, and marketing. The platform supports unique configurations and data for each tenant, with robust authentication and access control. The business vision is to offer a scalable, customizable, and feature-rich SaaS for small to medium-sized businesses, streamlining operations, and delivering valuable insights and automation.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# System Architecture

## Frontend

The frontend is built with React 19, TypeScript, Vite 6, and Tailwind CSS v4, focusing on a modern, responsive, and interactive user experience.

## UI/UX Decisions

-   **Design System**: Consistent design language with `rounded-[2.5rem]` or `rounded-[3rem]` cards, `bg-white/80 backdrop-blur-xl` glass effect, and a primary color theme with a `ghost-border` utility.
-   **Typography**: Uses `font-black uppercase tracking-widest` for labels.
-   **Animations**: Integrates `motion/react` (Framer Motion) for smooth UI transitions.
-   **Notifications**: Utilizes toast notifications for user feedback.
-   **Accessibility**: Semantic accessibility for form inputs, keyboard-navigable table rows, and modal dialogs.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Leverages Firebase Authentication with platform-level and tenant-specific roles, enforcing a hierarchical permission model (7 levels) and sub-permissions for granular administrative actions.
-   **Tenant Management & Provisioning**: Comprehensive workflow for tenant lifecycle, including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Point of Sale (POS)**: Full-featured POS including cart management, payments, tax calculation, discounts, customer management, repair intake, held orders, quick add stock, operator switching with RBAC, refund workflows, and warranty claims with supervisor PIN flow.
-   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
-   **CRM (Customers)**: Full CRM with enriched Customer type, multi-field search, per-row action menus, edit modals, loyalty management (tiering, points, manual adjustments) with plan and sub-permission gating, duplicate detection, and integrated order/invoice history.
-   **Invoices**: Full invoice lifecycle management, including creation with dynamic line items, searchable inventory, service catalog, discount, and auto tax. Invoice detail as modal overlay, edit functionality for unpaid invoices, payment processing (Cash, Card Terminal with state machine), and a reopen feature with supervisor PIN authorization. Print modal with Full Page/Receipt modes: uses saved `documentTemplates` content rendered via `renderTemplate()` from `templateBuilder.ts` — both the off-screen `#print-surface` and modal preview use `dangerouslySetInnerHTML` with the rendered template. Primary "Print" action uses controlled `window.print()` with artifact-free `#print-surface` CSS. Store branding (logo + placement) prepended to rendered HTML. Status history tracks all transitions.
-   **Services**: Service catalog management with CRUD operations for services and categories, including warranty configuration. Features bulk price editor and dependency-aware delete confirmations.
-   **Repairs Module**: Full repair ticket lifecycle management with status workflow (Pending → Diagnosed → In Progress → Awaiting Parts → Ready for Pickup → Completed → Delivered | Cancelled). Features include: structured device intake form with customer lookup, device info (brand/model/category/IMEI/serial/passcode/network), service line items linked from service catalog, parts tracking from inventory, pre/post repair condition checklists, technician assignment from POS operators (gated by `assign_technician` sub-permission), storage location tracking, internal/customer-facing notes with comment system, complete activity timeline with auto-generated history entries, financial summary (services + parts totals), CSV export, and permission-gated CRUD. **Technician auto-assignment**: when a user with `effectiveRole === 'technician'` creates a ticket, their identity (from `posOperator` or `session.user`) is auto-populated as `technicianId`/`technicianName`, with an "(auto)" note in history. **Operator identity tracking**: all history entries and comments use `currentOperatorName` (resolved from `posOperator?.name` → `session?.user?.name` → `'Current User'` fallback) instead of hardcoded placeholder text. Warranty repair tickets from WarrantyManagement integrate seamlessly into the unified ticket view. On ticket completion, an invoice is auto-generated from service line items and parts, linked via `linkedInvoiceId`. A "Send to POS" button navigates to the POS with repair items and customer pre-loaded for payment collection. Customer profiles in Customers.tsx include a "Repairs" tab showing all repair tickets for that customer with clickable rows — completed tickets with a linked invoice open the invoice detail modal, others navigate to Repairs. Interaction History UX is simplified: invoice rows and ticket rows are the primary click targets for viewing details; "Send to POS" buttons appear only for unpaid/payable invoices (inline in Invoices and Repairs tabs, and in the invoice detail modal footer). All POS routing uses a canonical `buildInvoicePosPayload()` helper that maps ALL invoice line items to POS cart items (via `invoiceItems` array in navigation state), ensuring POS displays the exact same items, quantities, and prices shown in the invoice detail. POS consumes `invoiceItems` (preferred) or falls back to single `autoRepairItem`. On finalization with a `linkedInvoiceId`, POS marks the linked invoice as Paid (balance=0, paymentHistory updated). State managed via `repairTickets` in StoreLocalState with SEED data.
-   **Reporting**: Dashboard with data visualizations using Recharts.
-   **Onboarding**: Multi-step onboarding for new tenants, including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: Full template editor in Settings for 5 document types (Invoice, Repair Ticket, Inventory Label, Sales Receipt, Price Estimate). Uses a **structured template builder** (`src/utils/templateBuilder.ts`) with deterministic HTML generation from `enabledTags`. Tags are position-stable slots in defined regions (header/billing/body/totals/footer) — toggling a tag regenerates the template, never corrupts it. `enabledTags: string[]` stored in `DocumentTemplate` alongside `content`. Reset to Default restores canonical `enabledTags`, rebuilds content, and resets branding. Branding panel for logo management (upload, placement). Source mode for direct HTML editing. Visual preview with sample data and conditional blocks.
-   **Data Flow**: `StoreLocalState.tsx` manages shared local mock state for various entities including customers, stock, orders, invoices, services, loyalty config, document templates (with `enabledTags`), store branding, suppliers, stock movements, purchase orders, GRNs, RMAs, inventory transfers, inventory counts, trade-ins, and refurbishment jobs. Uses `buildTemplateHtml()` and `getDefaultEnabledTags()` from `src/utils/templateBuilder.ts` for deterministic template generation and reset. Includes helpers for duplicate customer detection. Plans/Features/AddOns data persists via `sessionStorage`.
-   **Feature Gating & Navigation Derivation**: `canAccess()` uses a merge-based strategy for plan feature resolution, combining static `planFeatures` with dynamic `features_data` from `sessionStorage`. Supports both `featureMatrix` and legacy `planEntry` formats. Plan-only features (e.g., `loyalty_management`) are gated independently of RBAC sub-permissions.
-   **Dashboard Quick Actions**: Includes Quick Intake (repair), Print Label, Scan QR (inventory search), Add Stock, and Held Orders.
-   **Inventory Management**: Comprehensive inventory system with enriched `StockItem` types (`serialized`, `non-serialized`, `handset`), `isRepairPart` and `isHiddenOnPOS` flags, UPC/manufacturer/location fields, min/max stock levels, cost price, and serial number tracking. Features: summary cards (total items, value, low stock, out of stock), advanced filter bar (category, type, repair-part, low-stock, hidden-POS toggles), item detail modal with info/movements/edit tabs, stock adjustment with reason tracking (creates `StockMovement` records), global movements log tab, inventory transfer lifecycle (Draft → Sent → In Transit → Received → Cancelled with movement creation), stock count with discrepancy resolution (creates adjustment movements), trade-in CRUD with customer lookup and evaluate→stock/refurbishment flows, refurbishment job CRUD with parts tracking and completion→inventory conversion. **Stock Movement Tracking**: Every stock change (adjustment, sale, transfer, receiving, repair consumption/return, trade-in conversion, refurbishment, RMA) creates a traceable `StockMovement` record with previous/new quantities, performer, and reference linking. **Repair-Parts Integration**: Parts added to repair tickets auto-deduct stock with `repair_consumption` movement; parts removed restore stock with `repair_return` movement. **POS Sale Movements**: Each POS sale creates `sale` movement records per sold item. Sub-permissions: `adjust_stock`, `manage_transfers`, `approve_inventory`.
-   **Supply Chain Management**: Full supply chain module using shared state from StoreLocalState. **Supplier Management**: CRUD for suppliers with contact details, payment terms, and status tracking. **Purchase Orders**: PO creation with inventory item picker and supplier selection, full lifecycle (Draft → Ordered → Partially Received → Received → Cancelled), line items with cost/qty. **Goods Received Notes (GRN)**: Create from PO, enter received quantities, auto-increment stock levels with `receiving` movement records. **Return Merchandise Authorization (RMA)**: Create linked to PO/supplier, lifecycle (Pending → Shipped → Refunded/Replaced) with `rma_return` movement tracking. Sub-permission: `manage_purchase_orders`.
-   **POS Orders Lookup**: Searchable order history with detailed invoice view for direct refund or warranty claim actions.
-   **POS Cart Merge**: Automatically merges identical inventory items into a single cart line.
-   **POS Finalize**: Creates `CompletedOrder` records and decrements stock quantities.
-   **Stock Count Integrity**: Cart displays remaining stock with visual indicators, enforcing stock limits during editing.
-   **Store Permissions Matrix**: Interactive matrix in `EmployeesPermissionsPage` for role-domain permission level configuration with nested sub-permission toggle rows.
-   **Supervisor Refund Authorization**: Allows unauthorized operators to request supervisor approval for refunds via PIN.
-   **UI Feedback**: Consistent visual feedback for successful saves (e.g., button text swap, temporary background change).
-   **Modal Pattern**: Consistent `AnimatePresence`-based modals with fixed overlays, `backdrop-blur-md`, `motion.div` animations, and `rounded-[3rem]` styling.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Context API for global state; extensive local component state.
-   **Firebase Integration**: Firebase Firestore for backend data and Firebase Authentication for user management.
-   **AI Integration**: Gemini API for AI features.
-   **Configuration**: `firebase-applet-config.json` for Firebase project config, `firebase-blueprint.json` for Firestore schema.
-   **Vite Configuration**: `vite.config.ts` includes `server.watch.ignored` to prevent reload loops.

# External Dependencies

-   **Firebase**: Firestore (database) and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai` for AI functionalities.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: For UI animations.
