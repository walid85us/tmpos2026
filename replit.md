# Overview

This project is a multi-tenant SaaS frontend platform designed for small to medium-sized businesses. It provides a comprehensive suite of tools including Point-of-Sale (POS), employee and customer relationship management (CRM), inventory control, reporting, and marketing functionalities. The platform aims to streamline business operations, offer actionable insights, and automate processes through a scalable, customizable, and feature-rich architecture.

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

-   **Design System**: Employs rounded cards, a glass effect, a consistent primary color theme, and a `ghost-border` utility.
-   **Typography**: Uses `font-black uppercase tracking-widest` for labels.
-   **Animations**: Utilizes Framer Motion for smooth UI transitions and consistent modal patterns.
-   **Notifications**: Implements toast notifications for user feedback.
-   **Accessibility**: Prioritizes semantic accessibility for forms, tables, and modals.

## Technical Implementations & Feature Specifications

-   **Authentication & Access Control**: Implemented with Firebase Authentication and a 7-level hierarchical permission model.
-   **Tenant Management**: Full lifecycle management, including provisioning, subscriptions, feature overrides, billing, and audit logging.
-   **Business Management Modules**:
    -   **Point of Sale (POS)**: Comprehensive cart management, diverse payment options, tax/discount calculations, customer management, repair intake, and robust refund/warranty workflows.
    -   **Employee Management**: Manages employees, roles, time tracking, and payroll with granular permissions.
    -   **CRM (Customers)**: Enhanced CRM with multi-field search, loyalty programs, duplicate detection, and integrated order/invoice history.
    -   **Invoices**: Supports full invoice lifecycle with dynamic line items, searchable catalog, payment processing, and configurable document templates.
    -   **Services**: Manages a service catalog with CRUD operations, warranty configuration, and bulk price editing.
    -   **Repairs Module**: Manages the full repair ticket lifecycle, including structured workflow, parts tracking, technician assignment, and financial summaries.
    -   **Inventory Management**: Comprehensive system for managing various `StockItem` types, including UPC/manufacturer/location tracking, min/max stock levels, serial number tracking, stock adjustments, inventory transfers, and trade-in management, all integrated with RBAC.
    -   **Supply Chain Management**: Manages suppliers, purchase orders, Goods Received Notes (GRN), and Return Merchandise Authorization (RMA) with detailed tracking and financial recording, gated by RBAC.
    -   **Shipping Center**: A centralized fulfillment module for managing shipments across all source documents, supporting various shipment types, status transitions, tracking event timelines, carrier configuration, cost tracking, and a provider adapter layer.
    -   **Returns Portal / Reverse Logistics**: A module for managing returns with a structured lifecycle, reasons, resolutions, item disposition, intake/inspection, and integration with return shipments.
-   **Reporting**: Features a dashboard with data visualizations.
-   **Onboarding**: A multi-step process for new tenants, covering plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured editor for 5 document types, offering deterministic HTML generation, branding, and visual preview.
-   **Carrier Analytics Foundation**: Provides deterministic shipping metrics within the Shipping Center, including mode derivation, status-to-bucket mapping, and provider-connected analytics.
-   **Carrier Locators / Shipping Provider Configuration**: Manages plan and permission-gated configuration for shipping providers and carrier locators.
-   **Shipping Automation Rules**: Implements a pure automation engine with definable rules (conditions and actions) that can flag, add notes, mark for review, set priority, or queue for batch processing, supporting observational and guardrail rule types. Includes a general backfill framework for applying rules to existing shipments.
-   **Batch Labels**: Allows processing batches of labels by iterating per-shipment.
-   **Packing Workflows**: Provides an explicit, auditable packing lifecycle within the Shipping Center, including item and package verification, exception handling, and completion workflows, integrated with shipment status transitions.
-   **SLA Optimization Foundation**: Establishes a deterministic, auditable, permission-aware SLA visibility surface, calculating targets based on lifecycle timestamps and tenant-editable policies. Includes SLA automation linkage to the shipping automation rules engine.
-   **Automation Backfill**: Manual, confirmed, itemized, duplicate-safe action that lets an authorized operator apply an existing automation rule to existing matching shipments. Backfill eligibility is decided by `getRuleBackfillEligibility(rule)` and falls into one of three states: `current_state_backfillable`, `event_only`, or `unsupported_backfill`. Gated by the **Run Automation Backfill** sub-permission (internal key `run_shipping_automation_backfill`) — the user-facing label is intentionally generic ("Run Automation Backfill", not "Run SLA Automation Backfill") so the permission can grow with the framework as new current-state trigger families become backfillable, while the description makes clear that only eligible rules can be backfilled and that event-only triggers (e.g. `label_purchased`) and pre-action triggers (`pre_label_purchase`, `pre_pickup_request`, `pre_shipment_dispatch`, `pre_batch_label_purchase`) remain not backfillable regardless of permission. Plan gating is unchanged: the permission appears only when the **Shipping Automation Rules** plan feature is live, and additionally requires the **SLA Optimization** plan feature while the SLA trigger family remains the primary backfillable set. Existing role assignments are preserved because the internal permission key did not change — only the displayed label and description were generalized.
-   **Carrier Scorecards Foundation**: A truthful, deterministic, data-quality-aware per-carrier / per-service / per-provider performance comparison surface inside Shipping Center, rendered as a separate **Scorecards** tab placed immediately after **Analytics**. Built directly on top of the existing Carrier Analytics, SLA Optimization, and Pickup Requests foundations — no new event sources, no invented data. The pure derivation engine lives in `src/shipping/carrierScorecards.ts` and exposes `computeCarrierScorecards(shipments, filters, slaPolicy?, nowMs)`, which groups shipments by `(provider, carrier, serviceLevel)` and returns per-card metric groups: `usage`, `cost`, `sla`, `transit`, `pickup`, `exception`, plus a `coverage` strip (cost-data %, provider-events %, delivery-timestamp %, SLA-applicable %, pickup-request split). Sample-size aware via `MIN_SAMPLE_SIZE = 5` — cohorts below the threshold are tagged "Limited data" and the surface keeps the per-card ratios visible but with the caveat (small samples are not a confident signal). Transit averages additionally require ≥ 3 valid timestamp pairs (`MIN_TIMING_SAMPLES = 3`) and otherwise render as "—" rather than a fabricated number. Mode and provider helpers (`deriveMode`, `resolveProviderLabel`, `deriveLabelCreatedAt/Dispatched/DeliveredAt`) are kept consistent with the same rules used by `CarrierAnalytics.tsx` so the two surfaces cannot drift. SLA metrics reuse the canonical `summarizeShipmentSla` engine — no SLA logic is reimplemented; per-card aggregates roll up worst-status (missed / overdue / at-risk / paused / all-met / unknown) and per-target met/missed counts. Pickup execution preserves the provider-truthfulness invariant: only `live_provider`-source confirmed/completed pickups count as **provider-confirmed**; everything else is reported as **local-only** so a manual intent never inflates a carrier's pickup-confirmation rate. **No combined numeric grade** is produced in this foundation — operators compare metric scorecards directly. Plan + permission gating: the new `carrier_scorecards` plan feature (default-on for the Growth and Advanced plans, alongside `carrier_analytics`) and the new `view_carrier_scorecards` sub-permission (parentDomain `shipping`, minModuleLevel `view`, defaultLevel `view`, registered in `FEATURE_PERMISSION_DEPENDENCIES.carrier_scorecards`) are independent of Carrier Analytics — a tenant can have analytics without scorecards or vice versa. Cost rows additionally require `view_shipping_costs` and SLA rows additionally require both the SLA Optimization plan feature and `view_shipping_sla`; when either sub-gate fails the surface renders an explicit "not available" caveat for that section instead of hiding the card or showing zeros. **Out of scope for this foundation**: AI carrier optimization, predictive ranking, automatic carrier switching, claims / refunds workflows, customs documents, insurance scoring, external carrier benchmarking, and an editable scorecard-definitions UI — definitions are fixed in this pass and documented inline in the surface footer.

## System Design Choices

-   **Routing**: Utilizes React Router v7.
-   **State Management**: Primarily relies on React Context API and local component state.
-   **Firebase Integration**: Leverages Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Integrates with the Gemini API for AI functionalities.
-   **Server-Side Shipping API**: An Express server handles all shipping provider operations with secure credential storage.
-   **Configuration**: Uses `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.