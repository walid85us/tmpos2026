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
-   **Automation Backfill — Event vs Current-State Distinction**: Manual, confirmed, itemized, duplicate-safe action that lets an authorized operator apply an existing automation rule to existing matching shipments. The default future-only event behavior is unchanged. Backfill eligibility is decided by `getRuleBackfillEligibility(rule)` in `src/shipping/automationEngine.ts` and falls into one of three states: `current_state_backfillable`, `event_only`, or `unsupported_backfill`. **Critical semantics:** backfill is only valid for rules whose trigger describes *current shipment state*, not for rules whose trigger describes a *moment-in-time event*. Current shipment data cannot truthfully tell us "this event fired in the past"; replaying an event-only rule now would either fabricate the event or replay history blindly. Concretely, `label_purchased` is event-only and **not** backfillable: a shipment currently having a carrier label is *not* evidence that "a carrier label is purchased" event should fire against it now. The correct path for "apply this observational action to all existing labeled shipments" is a future current-state rule keyed on a current-state condition such as "shipment currently has a carrier label", not an event-trigger backfill. The full event-only set is `shipment_created`, `shipment_updated`, `status_changed`, `label_purchased`, `pickup_requested`, `pickup_confirmed`, `pickup_cancelled`, `tracking_synced`, `return_shipment_created`, `sla_resumed`, `pre_label_purchase`, `packing_started`, `packing_completed`, and `packing_exception_created`. Each is hidden from the "Apply to Existing" button on its rule card and surfaces a small disabled "Backfill N/A" hint instead. Rules whose actions list contains zero engine-safe actions (only guardrail purposes like `require_approval` / `block_unless_approved` / `require_review_before_action`) are classified as `unsupported_backfill` and surface a "No Safe Actions" hint. The only currently-shipping `current_state_backfillable` family is the existing **SLA Automation Backfill** — `sla_at_risk`, `sla_overdue`, `sla_missed`, `sla_paused`, `sla_delay_reason_added` (with `sla_resumed` deliberately excluded as a transient transition). SLA backfill matches via the live `evaluateRule` engine path with a synthesized per-shipment `AutomationTriggerContext` derived from the current `slaSummary`, executes via `runAutomation` so the engine's safe-action whitelist (`add_flag`, `add_internal_note`, `mark_review_needed`, `mark_ready_for_batch`, `set_priority`) remains the single source of truth, and dedups via a stable backfill key `${ruleId}|${slaTargetType ?? '__any__'}` recorded on the shipment in `slaAutomationBackfillKeys`. The framework plumbing — `evaluateNonSlaBackfillCandidate`, the `non_sla` `triggerKind`, the namespace-distinct `${ruleId}|nonsla:${triggerType}` dedup key prefix (so future non-SLA backfill keys cannot shadow SLA keys on the same shipment), and the per-`triggerKind` plan gating in the orchestrator — is retained so a genuinely current-state non-SLA trigger can be added later by appending it to `CURRENT_STATE_NON_SLA_TRIGGERS` and supplying its current-state precondition; today that constant is empty. Defense-in-depth at execute time: the canonical rule is re-resolved by id, `getRuleBackfillEligibility` is re-evaluated, the SLA feature gate is conditionally enforced (only when the canonical rule's `triggerKind` is `sla`), the trigger-changed guard prevents stale candidate contexts from being applied if the rule's trigger was edited between scan and run, and any candidates that fail the re-check are itemized as `failed` with a clear reason rather than silently skipped. Audit: every applied shipment writes a global `automationLogs` entry tagged `triggeredBy: 'backfill'` with a shared `backfillRunId`; the rule stores up to the last 10 `backfillRuns` for a "last backfill" line on the card; an internal note "Automation backfill applied: <ruleName> by <user>" is appended to each affected shipment. Plan + permission gating: the action requires the `run_shipping_automation_backfill` sub-permission, the `shipping_automation_rules` plan feature, writes not blocked, and (for SLA-trigger rules only) the `shipping_sla_optimization` plan feature. **Out of scope:** historical-event replay, scheduled / recurring backfills, retroactive purchase or status mutations, Carrier Scorecards, Customs / HS code automation, Insurance recommendations.

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