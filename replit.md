# Project Overview

This project is a multi-tenant SaaS platform frontend, built to deliver a comprehensive business management solution. It enables store owners and their teams to manage various aspects of their operations, including point-of-sale (POS), employee management, customer relationship management (CRM), inventory, reporting, and marketing. The platform supports multiple tenants, each with their own configurations and data, and incorporates robust authentication and access control mechanisms.

The business vision is to provide a scalable and customizable SaaS offering for small to medium-sized businesses, simplifying their day-to-day operations and empowering them with insights and automation. It aims to capture market share by offering a feature-rich, user-friendly, and highly configurable platform.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.

# System Architecture

## Frontend

The frontend is built with React 19, TypeScript, Vite 6, and Tailwind CSS v4, focusing on a modern, responsive, and highly interactive user experience.

## UI/UX Decisions

- **Design System**: Employs a consistent design language with `rounded-[2.5rem]` or `rounded-[3rem]` cards, a `bg-white/80 backdrop-blur-xl` glass effect, and a primary color theme with a `ghost-border` utility.
- **Typography**: Uses `font-black uppercase tracking-widest` for labels to maintain a clear and bold aesthetic.
- **Animations**: Integrates `motion/react` (Framer Motion) for smooth UI transitions and interactions.
- **Notifications**: Utilizes toast notifications for user feedback instead of disruptive `alert()` calls.
- **Accessibility**: Form inputs have `label`/`id` pairs, table rows are keyboard-navigable, and modal dialogs follow semantic accessibility guidelines.

## Technical Implementations & Feature Specifications

- **Authentication & Access Control**: Leverages Firebase Authentication. The platform supports both platform-level roles (e.g., `system_owner`, `support_admin`) and tenant-specific roles (e.g., `store_owner`, `manager`, `technician`, `sales_staff`). Access is gated by `AccessGuard` based on `allowedUserTypes` and feature checks, with a layered `canAccess()` function considering system, platform, plan, and tenant roles. Admin permissions bypass plan-gating.
- **Tenant Management & Provisioning**: Features a comprehensive workflow for tenant lifecycle management, including provisioning, subscription handling, feature overrides, billing (invoices, credits, refunds), domain management, usage tracking, and audit logging. A `DevSessionSwitcher` allows for testing various tenant scenarios (active, trial, invited, suspended, etc.).
- **Point of Sale (POS)**: A full-featured POS system including cart management, payments, repair intake, held orders (shared state), tax calculation (8.25%), discount application, customer management (inline creation, walk-in), and customer-linked loyalty points redemption (min 100pts, 1pt=$0.01, 10pts earned per $1 spent).
- **Employee Management**: Functionality for managing employees, roles, time tracking (check-in/out, breaks), and payroll. Granular permissions control employee actions and visibility of sensitive data.
- **CRM**: Customer list, profiles, and new customer creation. `Customer` interface includes `loyaltyPoints?: number`.
- **Reporting**: Dashboard with various reports utilizing Recharts for data visualization.
- **Onboarding**: A multi-step onboarding process for new tenants, including plan selection, pre-configured settings, and an activation checklist. The `StoreActivationPanel` provides a unified view of the tenant's lifecycle, domain readiness, and onboarding progress, with status-aware banners.
- **Data Flow**: `StoreLocalState.tsx` manages shared local mock state for customers, stock items, held orders, completed orders, refund records, warranty claims, and POS operators. `StockItem` has `cost`, `price`, `status`, and `isSuggestiveSale` fields. Seeded with 5 real items (all approved). Customer seeds include `loyaltyPoints`. `CompletedOrder` tracks full invoice data with line items, payments, warranty periods, and refund tracking. `RefundRecord` and `WarrantyClaimRecord` support full refund/warranty workflows. `POSOperator` supports PIN-based operator switching. Context provides CRUD methods for all entities.
- **Dashboard Quick Actions**: Quick Intake opens a repair intake modal directly on the dashboard (not navigation). Print Label uses inventory-backed search with type-aware preview. Scan QR searches inventory with exact SKU match priority + partial name fallback, navigates to POS with `addToCart` state. Add Stock has dual buttons: "Add to Cart" (navigates to POS with item) + permission-aware "Add to Inventory"/"Submit for Approval". Held Orders opens a dashboard modal listing shared held orders; selecting one navigates to POS with `resumeHeldOrderId`.
- **POS Location State**: Supports `autoQuickCheckIn`, `openHeldOrders`, `autoRepairItem`, `addToCart`, and `resumeHeldOrderId`. Repair Intake modal has visible X close button.
- **POS Quick Add Stock**: Two buttons always visible — "Add to Cart" (cart-only, no inventory entry) and permission-aware "Add to Inventory" (owner/manager) or "Submit for Approval" (staff).
- **POS Payment Flow**: Payments start empty (no ghost methods). Users add Cash or Card via "Add Method" modal. Card auto-computes exact remaining balance (derived, not state-driven, disabled input). Cash is manual entry. Finalize requires: cart not empty, payments added, remaining ≤ 0.005 tolerance. Total uses `toFixed(2)` rounding to prevent floating-point drift. Change due shown for cash overpayment.
- **Loyalty Points Flow**: Points display uses customer's actual `loyaltyPoints` (not random). Redeem Points button disabled without customer or with <100pts. Points earned preview shown in order summary. On finalize, customer points updated in shared state (earned - redeemed).
- **Inventory Page**: Uses `StoreLocalState` as its single source of truth. Displays `approvedStockItems` in the inventory table and `pendingStockItems` in a separate approval section (visible to owners/managers). "Add Product" modal writes to StoreLocalState with permission-aware status (approved for owners/managers, pending_approval for staff). No disconnected local mock data.
- **POS Catalog**: Add Item modal has repair services as base items + all products from approvedStockItems only (no hardcoded product entries). Exact SKU match prioritized. Category filter defaults to "All Categories" matching dropdown option values.
- **POS Cash Rounding**: 3-mode (Exact/Round Up/Round Down) toggle below Cash payment input. Exact mode auto-resets cash to exact owed value. Round Down applies a discount for the fractional difference. Card payments stay exact-only.
- **POS Switch User**: Operator list → PIN verification → sets `posOperator` in shared state. Current operator shown in POS header with initials badge. Operators seeded with 4 entries.
- **POS Refund Workflow**: Multi-step modal: search orders by invoice/customer/phone → select line items with qty controls → reason selection → method choice (Original/Store Credit/Cash) → creates `RefundRecord` and updates `CompletedOrder` status (Partially/Fully Refunded).
- **POS Warranty Claim**: Multi-step modal: search orders → select warranty-eligible items (those with `warrantyPeriod`) → reason + notes → generates warranty ticket via `addWarrantyClaim`.
- **POS Orders Lookup**: Searchable order history from `completedOrders`, detailed invoice view with line items/payments/totals, action buttons to initiate refund or warranty claim directly from order detail.
- **POS Cart Merge**: Adding same inventory item to cart merges into existing line (increments qty) rather than creating duplicate entries. Stock enforcement still applies.
- **POS Finalize → CompletedOrder**: On finalize, creates a `CompletedOrder` record with all line items, payments, warranty periods, operator name.
- **Inventory Suggestive Sales Tab**: New "Suggestive Sales" tab in Inventory page with toggle switches per stock item to mark as suggestive sale.
- **Save Feedback**: A consistent pattern of button text swap and a temporary `bg-emerald-500` class indicates successful saves.
- **Modal Pattern**: Modals utilize `AnimatePresence`, fixed overlays with `backdrop-blur-md`, and `motion.div` for scaling and Y-axis animations, with `rounded-[3rem]` styling.

## System Design Choices

- **Routing**: Implemented using React Router v7.
- **State Management**: Context API is used for global state such as `AccessContext` for authentication sessions, tenant resolution, and role management. Local state is used extensively within components.
- **Firebase Integration**: Firebase Firestore serves as the backend database, with security rules defined in `firestore.rules`. Firebase Authentication handles user authentication.
- **AI Integration**: The Gemini API is integrated for AI features.
- **Configuration**: `firebase-applet-config.json` stores Firebase project configuration, and `firebase-blueprint.json` defines the Firestore data model schema.
- **Vite Configuration**: `vite.config.ts` includes a critical `server.watch.ignored` setting to prevent reload loops during development.

# External Dependencies

- **Firebase**:
    - **Firestore**: Backend database for data storage.
    - **Authentication**: User authentication and authorization.
- **Google AI Studio / Gemini API**: Integrated via `@google/genai` for AI functionalities.
- **Recharts**: Used for rendering charts and data visualizations in reports.
- **Framer Motion**: Integrated via `motion/react` for animations.