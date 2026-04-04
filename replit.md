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
-   **Repairs Module**: Full repair ticket lifecycle management with status workflow (Pending → Diagnosed → In Progress → Awaiting Parts → Ready for Pickup → Completed → Delivered | Cancelled). Features include: structured device intake form with customer lookup, device info (brand/model/category/IMEI/serial/passcode/network), service line items linked from service catalog, parts tracking from inventory, pre/post repair condition checklists, technician assignment from POS operators (gated by `assign_technician` sub-permission), storage location tracking, internal/customer-facing notes with comment system, complete activity timeline with auto-generated history entries, financial summary (services + parts totals), CSV export, and permission-gated CRUD. **Technician auto-assignment**: when a user with `effectiveRole === 'technician'` creates a ticket, their identity (from `posOperator` or `session.user`) is auto-populated as `technicianId`/`technicianName`, with an "(auto)" note in history. **Operator identity tracking**: all history entries and comments use `currentOperatorName` (resolved from `posOperator?.name` → `session?.user?.name` → `'Current User'` fallback) instead of hardcoded placeholder text. Warranty repair tickets from WarrantyManagement integrate seamlessly into the unified ticket view. On ticket completion, an invoice is auto-generated from service line items and parts, linked via `linkedInvoiceId`. A "Send to POS" button navigates to the POS with repair items and customer pre-loaded for payment collection. Customer profiles in Customers.tsx include a "Repairs" tab showing all repair tickets for that customer; the invoice detail modal also shows a "Send to POS" button for unpaid repair invoices, routing to `/sales` with pre-loaded items and customer data. State managed via `repairTickets` in StoreLocalState with SEED data.
-   **Reporting**: Dashboard with data visualizations using Recharts.
-   **Onboarding**: Multi-step onboarding for new tenants, including plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: Full template editor in Settings for 5 document types (Invoice, Repair Ticket, Inventory Label, Sales Receipt, Price Estimate). Uses a **structured template builder** (`src/utils/templateBuilder.ts`) with deterministic HTML generation from `enabledTags`. Tags are position-stable slots in defined regions (header/billing/body/totals/footer) — toggling a tag regenerates the template, never corrupts it. `enabledTags: string[]` stored in `DocumentTemplate` alongside `content`. Reset to Default restores canonical `enabledTags`, rebuilds content, and resets branding. Branding panel for logo management (upload, placement). Source mode for direct HTML editing. Visual preview with sample data and conditional blocks.
-   **Data Flow**: `StoreLocalState.tsx` manages shared local mock state for various entities including customers, stock, orders, invoices, services, loyalty config, document templates (with `enabledTags`), and store branding. Uses `buildTemplateHtml()` and `getDefaultEnabledTags()` from `src/utils/templateBuilder.ts` for deterministic template generation and reset. Includes helpers for duplicate customer detection. Plans/Features/AddOns data persists via `sessionStorage`.
-   **Feature Gating & Navigation Derivation**: `canAccess()` uses a merge-based strategy for plan feature resolution, combining static `planFeatures` with dynamic `features_data` from `sessionStorage`. Supports both `featureMatrix` and legacy `planEntry` formats. Plan-only features (e.g., `loyalty_management`) are gated independently of RBAC sub-permissions.
-   **Dashboard Quick Actions**: Includes Quick Intake (repair), Print Label, Scan QR (inventory search), Add Stock, and Held Orders.
-   **Inventory Management**: Displays approved and pending stock items with permission-aware status, suggestive sales, and tiered stock visibility.
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
