# Overview

This project is a multi-tenant SaaS platform frontend designed to be a comprehensive business management solution. It empowers store owners and their teams to manage point-of-sale (POS), employee management, customer relationships (CRM), inventory, reporting, and marketing. The platform supports multiple tenants, each with unique configurations and data, and includes robust authentication and access control.

The business vision is to provide a scalable, customizable, and feature-rich SaaS offering for small to medium-sized businesses, streamlining operations and providing valuable insights and automation.

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

-   **Authentication & Access Control**: Leverages Firebase Authentication with platform-level and tenant-specific roles. A hierarchical permission model (7 levels: none < view < create < edit < manage < approve < full) across various domains is enforced by `AccessGuard`.
-   **Sub-Permissions System**: Administrative actions (manage employees, approve inventory, process refunds, etc.) are independently toggleable per role as sub-permissions. Defined in `SUB_PERMISSIONS` array in `accessConfig.ts` with `parentDomain`, `minModuleLevel` (view), and `defaultLevel`. Enforced via `checkSubPermission(actionId)` in `AccessContext`. N/A when module access is `none`; otherwise Granted/Denied independently. Store Owner always has all sub-permissions.
-   **Tenant Management & Provisioning**: Comprehensive workflow for tenant lifecycle, including provisioning, subscriptions, feature overrides, billing, domain management, usage tracking, and audit logging.
-   **Point of Sale (POS)**: Full-featured POS including cart management, payments (cash, card), tax calculation, discounts, customer management (inline creation, loyalty points), repair intake (with Device Name field), and held orders. Supports `autoQuickCheckIn`, `openHeldOrders`, `autoRepairItem`, `addToCart`, `resumeHeldOrderId`, and `selectedCustomer` via location state. Features quick add stock, operator switching with RBAC, refund workflows, and warranty claims with Active/Expired badges and supervisor PIN flow for expired warranty override (gated by `process_expired_warranty` sub-permission). Cash rounding options are available.
-   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
-   **CRM (Customers)**: Full CRM with enriched Customer type (tier, tags, notes, assets, custom fields, GDPR compliance, campaigner status, third-party billing). Customer list with multi-field search (name, email, phone, tags). Clean list rows without avatar placeholders — name and ID shown directly. Per-row action menu dropdown (View, Edit, Start Sale, Create Ticket) with outside-click dismiss. Edit Customer modal with all profile fields; loyalty tier/points fields gated by `manage_loyalty` sub-permission (disabled with warning when lacking permission). Loyalty management panel in profile view with progress bar and tier-to-next tracking (feature-gated by `loyalty_management` plan feature via `canAccess`; edit/adjust actions gated by `manage_loyalty` sub-permission via `checkSubPermission`). Loyalty Settings button in list header for program config (enable/disable, pointsPerDollar, tiers CRUD with privileges list per tier). Manual point adjustment with reason + history. Disabled program indicator (Program Paused badge, frozen points warning in edit modal). Tier dropdown in loyalty edit syncs with active tiers from `loyaltyConfig.tiers` dynamically. Duplicate detection on create matches phone, email, AND full name (case-insensitive, normalized whitespace); shows per-record Merge button + "Create Anyway" override. Clickable order rows in Orders tab open order detail overlay. Clickable invoice numbers in customer history open full invoice detail overlay modal. Start Sale / Create Ticket navigate to POS with customer context via location state. Customer profile header uses compact name+tier+points layout (no avatar placeholder).
-   **Invoices**: Full invoice lifecycle management connected to `StoreLocalState`. Create invoices with customer picker, dynamic line items (product/repair/service types), searchable inventory picker for product items (by name/SKU), service catalog grouped by category via optgroups, discount, auto tax (8%). Invoice detail as modal overlay (no page navigation). Invoice edit modal for unpaid invoices. Payment restricted to Cash + Card Terminal only; Card Terminal uses state machine flow (`idle → pending_terminal → confirmed/failed/cancelled`) with 3s simulated terminal confirmation and Cancel/Reject button available even after confirmation; closing payment modal resets terminal state (cancel-on-close behavior). Cash payments require explicit "Confirm Cash Received" confirmation step before applying. Invoice reopen feature: paid/cancelled invoices can be reopened (gated by `reopen_invoice` sub-permission). Professional full-page print layout with company header, alternating row shading, structured totals block, payment history, notes/terms section, and refined print-optimized CSS (`@media print` with `@page` rules, `no-print` class for action buttons, page-break-inside avoidance, print-friendly border normalization). Print/Email/SMS/Online Pay Link action modals layered on detail view. Status filter and search. Stats dashboard (outstanding, paid today, overdue, recurring). Permission-gated create/edit via `checkPermission('invoices', ...)`. Shared `renderLineItemEditor` and `renderInvoiceFormModal` helpers for create/edit.
-   **Services**: Service catalog management connected to `StoreLocalState`. Service CRUD with category, price, cost, estimated time, SKU, flag notes, status (Active/Inactive), warranty configuration (type: none/labor/parts-and-labor, period: 7d–lifetime). Category management with icon picker and service count. Bulk price editor. Dependency-aware in-app delete confirmation modals — blocks deletion when service referenced by unpaid invoices (offers Deactivate alternative). Category deletion protection (blocks if services exist). Warranty column in service list table.
-   **Reporting**: Dashboard with data visualizations using Recharts.
-   **Onboarding**: Multi-step onboarding for new tenants, including plan selection, pre-configured settings, and an activation checklist via `StoreActivationPanel`.
-   **Data Flow**: `StoreLocalState.tsx` manages shared local mock state for customers (enriched), stock items, held orders, completed orders (with `CompletedOrderItem` supporting `deviceName`, `imei`, `serialNumber` for repairs), refund records, warranty claims, POS operators, invoices, repair services, service categories, and loyalty program config (with tier privileges). Includes `findDuplicateCustomers()` helper (matches phone, email, and normalized full name). `LoyaltyTier` supports `privileges?: string[]` array. Plans/Features/AddOns data in PlansPage persists across navigation via `sessionStorage`. Seed completed orders include orders from Oct/Nov 2025 with expired warranty items for testability. `canAccess()` dynamically reads plan features from sessionStorage when available (PlansPage feature toggles propagate to runtime gating).
-   **Dashboard Quick Actions**: Includes Quick Intake (repair), Print Label, Scan QR (inventory search), Add Stock (to cart/inventory), and Held Orders (resume).
-   **Inventory Management**: Displays `approvedStockItems` and `pendingStockItems`. "Add Product" modal supports permission-aware status. Features suggestive sales and tiered stock visibility indicators.
-   **POS Orders Lookup**: Searchable order history with detailed invoice view, enabling direct refund or warranty claim actions.
-   **POS Cart Merge**: Automatically merges identical inventory items into a single cart line.
-   **POS Finalize**: Creates `CompletedOrder` records and decrements stock quantities.
-   **Stock Count Integrity**: Cart displays remaining stock with visual indicators; editing items enforces stock limits.
-   **Store Permissions Matrix**: Interactive matrix in `EmployeesPermissionsPage` for role-domain permission level configuration with nested sub-permission toggle rows (└ prefixed), linked to `accessConfig.ts`. Sub-permissions show Granted/Denied buttons when module access >= view, N/A when none.
-   **Supervisor Refund Authorization**: Allows unauthorized operators to request supervisor approval for refunds via PIN.
-   **UI Feedback**: Consistent visual feedback for successful saves (e.g., button text swap, temporary `bg-emerald-500` class).
-   **Modal Pattern**: Consistent `AnimatePresence`-based modals with fixed overlays, `backdrop-blur-md`, `motion.div` animations, and `rounded-[3rem]` styling.

## System Design Choices

-   **Routing**: React Router v7.
-   **State Management**: Context API for global state (e.g., `AccessContext`); extensive local component state.
-   **Firebase Integration**: Firebase Firestore for backend data and Firebase Authentication for user management.
-   **AI Integration**: Gemini API for AI features.
-   **Configuration**: `firebase-applet-config.json` for Firebase project config, `firebase-blueprint.json` for Firestore schema.
-   **Vite Configuration**: `vite.config.ts` includes `server.watch.ignored` to prevent reload loops.

# External Dependencies

-   **Firebase**: Firestore (database) and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai` for AI functionalities.
-   **Recharts**: For charts and data visualizations.
-   **Framer Motion**: Integrated via `motion.react` for UI animations.