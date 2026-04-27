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
    -   **Shipping Center**: A centralized fulfillment module for managing shipments across all source documents, supporting various shipment types, status transitions, tracking event timelines, carrier configuration, cost tracking, and a provider adapter layer. **Shipping Module Phases 1, 2, and 3 are completed and accepted — see the Shipping Module Closure Record below.**
    -   **Returns Portal / Reverse Logistics**: A module for managing returns with a structured lifecycle, reasons, resolutions, item disposition, intake/inspection, and integration with return shipments. Part of Shipping Phase 2 — completed and accepted.
-   **Reporting**: Features a dashboard with data visualizations.
-   **Onboarding**: A multi-step process for new tenants, covering plan selection, pre-configured settings, and an activation checklist.
-   **Document Template Editor**: A structured editor for 5 document types, offering deterministic HTML generation, branding, and visual preview.

## System Design Choices

-   **Routing**: Utilizes React Router v7.
-   **State Management**: Primarily relies on React Context API and local component state.
-   **Firebase Integration**: Leverages Firestore for backend data persistence and Firebase Authentication for user management.
-   **AI Integration**: Integrates with the Gemini API for AI functionalities.
-   **Server-Side Shipping API**: An Express server handles all shipping provider operations with secure credential storage.
-   **Configuration**: Uses `firebase-applet-config.json` for Firebase project configuration and `firebase-blueprint.json` for Firestore schema definition.

# Shipping Module Closure Record

The Shipping Module is **completed and accepted** across Phases 1, 2, and 3. Customs Docs and Insurance Rules are deferred future improvements (see the Deferred Future Shipping Roadmap below). All sub-features listed in this section are implemented, plan-and-permission-gated, and documented as the source-of-truth for downstream work.

## Shipping Module Completion Status

| Phase | Status | Scope |
| --- | --- | --- |
| Phase 1 | **Completed and accepted** | Core shipping architecture, provider adapter foundation, address validation, rates, labels, tracking, source-document linkage, print-label readiness, provider/manual split, auditability, truthful provider state. |
| Phase 2 | **Completed and accepted** | Returns Portal / Reverse Logistics, Service Points / Carrier Locators, Pickup Requests + forecast + fee transparency + exact pickup-rate selection, two-stage address readiness, pickup cancellation / orphan recovery / truthful provider-state handling, Carrier Analytics foundation, plan-to-permission propagation, Shipping Provider hard-disable + configuration clearing, Settings tab vs subsection scoping, dynamic sub-permission counts. |
| Phase 3 | **Completed and accepted** | Automation Rules + Batch Labels foundation, purpose-driven rule builder, approval / review / guardrail workflow, pre-action guardrails (label purchase / pickup request / dispatch / batch label purchase), SLA Optimization foundation, SLA Automation Linkage, SLA Automation Backfill, General Automation Backfill Framework, Packing Workflows + Rate Gating, Dispatch eligibility after label purchase / valid manual handoff, Carrier Scorecards foundation. |
| Customs Docs | **Deferred** | See Deferred Future Shipping Roadmap. |
| Insurance Rules | **Deferred** | See Deferred Future Shipping Roadmap. |

## Final Accepted Shipping Sub-Features (Plan-Gated)

Each sub-feature has its own plan-feature flag and at least one sub-permission. Plan determines whether the capability exists; role determines who can use it. Linked permissions disappear from the Store Permissions Matrix when the parent plan feature is disabled.

-   **Shipping Center** — central fulfillment module across invoices, repairs, transfers, and RMAs.
-   **Shipping Provider Configuration** — aggregator credentials and provider selection (EasyPost / Shippo / ShipStation). Scoped to its subsection inside the Settings tab.
-   **Carrier Locators / Service Points** — per-store live-lookup adapters (USPS / FedEx / UPS / DHL / GLS).
-   **Pickup Requests** (and **Pickup Analytics** sub-permission where applicable) — provider-confirmed vs local-only intent kept distinct end-to-end.
-   **Carrier Analytics** — deterministic, read-only Shipping Center analytics surface (separate from Scorecards).
-   **Shipping Automation Rules** — purpose-driven rule builder + execution engine + history.
-   **Batch Labels** — per-shipment iteration over an operator-curated batch.
-   **Packing Workflows** — explicit, auditable packing lifecycle with item / package verification and exception handling.
-   **SLA Optimization** — deterministic SLA targets, status, pause/resume, delay reasons, exception resolution, and SLA automation linkage.
-   **Carrier Scorecards** — truthful per-carrier / service / provider comparison surface; no combined numeric grade in the foundation.

## Final Accepted Shipping Lifecycle Rules

1.  **Packing before rates.** Provider-backed Get Rates requires packing completed (`Packed`) or packing `Not Required`. Package weight and dimensions must be complete where required, and package verification must be current.
2.  **Packed status.** Completing packing marks the shipment as `Packed`. `Packed` means rate / label readiness, **not** dispatch readiness. Packing may be reopened before label purchase; reopening clears or invalidates the selected rate where applicable.
3.  **Label purchase.** Requires valid provider readiness, a selected rate, package readiness, and guardrail clearance where applicable. After label purchase, packing and package details are locked.
4.  **Dispatch.** A provider shipment cannot be marked `Dispatched` before label purchase. A manual shipment requires valid manual handoff requirements. **`Dispatched` remains distinct from `In Transit`** in every surface (status counts, analytics, scorecards).
5.  **Tracking.** `In Transit` and `Delivered` must be based on truthful tracking / provider / lifecycle data. `Dispatched` must not be silently absorbed into `In Transit`.
6.  **Pickup.** Provider-confirmed pickup remains distinct from local-only pickup intent (only `source === 'live_provider'` with status `confirmed` / `completed` counts as provider-confirmed). A confirmed pickup dependency prevents inconsistent shipment cancellation; pickup orphan / local-dismiss recovery behavior remains accepted.
7.  **Returns.** Reverse logistics flow is part of Shipping Center. Return shipments preserve truthful lifecycle and provider-state logic identically to outbound shipments.

## Final Accepted Plan / Permission Rules

-   **Plan vs role separation.** Plan determines whether a capability exists. Role determines who can use it. Role permissions cannot resurrect a plan-disabled feature.
-   **Permission visibility.** Linked permissions disappear from the Store Permissions Matrix when the parent feature is plan-disabled. Dynamic sub-permission counts must reflect the actual visible permissions.
-   **Settings tab scoping.** The Shipping Settings tab is a container for multiple subsections. Visibility of the tab is **not** gated on a single subsection's plan/permission state; each subsection (Shipping Provider Configuration, Carrier Locators, general shipping settings) is independently gated inside.
-   **Provider hard-disable.** Disabling Shipping Provider at the plan level deactivates provider-backed operations and clears / deactivates configuration as accepted.
-   **Action gating.** Action buttons remain permission-gated even when status visibility is allowed (visibility ≠ action).

## Final Accepted Automation Rules

-   **Purpose-driven builder.** The five purposes are **Flag / Note**, **Queue for Batch**, **Require Review**, **Require Approval**, and **Block Action**.
-   **Queue for Batch** includes `Packing Completed`.
-   **Pre-action triggers only for Require Approval / Block Action.** The accepted real pre-action triggers are: carrier label about to be purchased, pickup about to be requested, shipment about to be dispatched, batch label purchase about to run. Pre-action hooks must stop the risky action before completion.
-   **Choose Another Rate** applies only to label-purchase guardrails.
-   **Workflow surfaces.** Requester sees `Pending Review` / `Pending Approval`; approver sees `Review Request` / `Approval Request` / `Review Approval` where appropriate.
-   **Duplicate approval requests are blocked.** Approval clears the loop for the approved context. Requester note is visible to approver. Dismiss / cancel request requires a Request Note.
-   **Auditability.** Execution history remains truthful and clickable. Automation outcomes and normal packing history must remain separate (Phase 3 correction).

## Final Accepted Backfill Rules

-   **Default automation is future-only.** No silent retroactive automation.
-   **SLA backfill is explicit and manual.** The General Automation Backfill Framework is accepted.
-   **Permission label** is **Run Automation Backfill** (internal key `run_shipping_automation_backfill`). Label is intentionally generic so the framework can grow as new current-state trigger families become backfillable.
-   **Backfill requires in-app confirmation.** Results are itemized. Duplicate / re-run safety is enforced. Audit / history records are preserved. Resolved backfill outcomes remain in Execution History.
-   **Not backfillable, regardless of permission:** event-only triggers (e.g. `label_purchased`) and pre-action triggers (`pre_label_purchase`, `pre_pickup_request`, `pre_shipment_dispatch`, `pre_batch_label_purchase`).
-   **Eligibility states** are decided by `getRuleBackfillEligibility(rule)` and fall into `current_state_backfillable`, `event_only`, or `unsupported_backfill`. Current-state non-SLA backfill framework may remain future scaffolding if not actively used.

## Final Accepted SLA Rules

-   **SLA status uses real lifecycle timestamps.** Missing timestamp data shows `unknown` / `insufficient-data` — never a fabricated value.
-   **Target alignment**: `Pack By` aligns with packing completion, `Label By` aligns with label purchase, `Dispatch By` aligns with `Dispatched` status, `Deliver By` does not fake delivery data.
-   **Operator workflow.** Delay reasons, pause / resume, and exception resolution are auditable.
-   **Linkage.** SLA automation linkage to the Shipping Automation Rules engine and SLA Automation Backfill are both accepted.

## Final Accepted Carrier Scorecards Rules

-   **Truthful, deterministic, data-quality-aware** per-carrier / per-service / per-provider performance comparison surface inside Shipping Center, rendered as the **Scorecards** tab placed immediately after **Analytics**. Built directly on top of the existing Carrier Analytics, SLA Optimization, and Pickup Requests foundations — no new event sources, no invented data.
-   **Engine** (`src/shipping/carrierScorecards.ts`): `computeCarrierScorecards(shipments, filters, slaPolicy?, nowMs)` groups shipments by `(provider, carrier, serviceLevel)` and returns per-card metric groups: `usage`, `cost`, `sla`, `transit`, `pickup`, `exception`, plus a `coverage` strip (cost-data %, provider-events %, delivery-timestamp %, SLA-applicable %, pickup-request split).
-   **Sample-size handling.** `MIN_SAMPLE_SIZE = 5` — cohorts below the threshold are tagged "Limited data" and the surface keeps per-card ratios visible but with the caveat. Transit averages additionally require ≥ 3 valid timestamp pairs (`MIN_TIMING_SAMPLES = 3`) and otherwise render as "—".
-   **Consistency with Analytics.** Mode and provider helpers (`deriveMode`, `resolveProviderLabel`, `deriveLabelCreatedAt/Dispatched/DeliveredAt`) match `CarrierAnalytics.tsx` so the two surfaces cannot drift.
-   **SLA reuse.** SLA metrics reuse the canonical `summarizeShipmentSla` engine — no SLA logic is reimplemented. Per-card aggregates roll up worst-status (missed / overdue / at-risk / paused / all-met / unknown) and per-target met / missed counts.
-   **Manual vs provider-backed not silently conflated.** Mode is recorded per shipment and surfaced in card headers and filters.
-   **Pickup truthfulness invariant.** Only `live_provider`-source confirmed/completed pickups count as **provider-confirmed**; everything else is reported as **local-only** so a manual intent never inflates a carrier's pickup-confirmation rate.
-   **No combined numeric grade** is produced in this foundation — operators compare metric scorecards directly.
-   **Out of scope** in the Scorecards foundation: AI carrier optimization, predictive ranking, automatic carrier switching, claims / refunds workflows, customs documents, insurance scoring, external carrier benchmarking, and an editable scorecard-definitions UI.
-   **Plan + permission**. Plan feature `carrier_scorecards` (default-on for Growth and Advanced, alongside `carrier_analytics`); sub-permission `view_carrier_scorecards` (parentDomain `shipping`, `view`-level), registered in `FEATURE_PERMISSION_DEPENDENCIES.carrier_scorecards`. Cost rows additionally require `view_shipping_costs`; SLA rows additionally require both the SLA Optimization plan feature and `view_shipping_sla` — when either sub-gate fails the surface renders an explicit "not available" caveat for that section instead of zeros.

## Other Accepted Phase 3 Foundations (Implementation Notes)

-   **Shipping Automation Rules**: Pure automation engine with definable rules (conditions and actions) that can flag, add notes, mark for review, set priority, or queue for batch processing. Supports observational and guardrail rule types.
-   **Batch Labels**: Processes batches of labels by iterating per-shipment.
-   **Packing Workflows**: Explicit, auditable packing lifecycle within the Shipping Center, including item and package verification, exception handling, and completion workflows, integrated with shipment status transitions.
-   **SLA Optimization Foundation**: Deterministic, auditable, permission-aware SLA visibility surface, calculating targets based on lifecycle timestamps and tenant-editable policies.
-   **Automation Backfill**: Manual, confirmed, itemized, duplicate-safe action that lets an authorized operator apply an existing automation rule to existing matching shipments, gated by **Run Automation Backfill** (`run_shipping_automation_backfill`). Plan gating: requires the **Shipping Automation Rules** plan feature, and additionally the **SLA Optimization** plan feature while the SLA trigger family remains the primary backfillable set. Existing role assignments are preserved because the internal permission key did not change.
-   **Carrier Analytics Foundation**: Deterministic shipping metrics within the Shipping Center, including mode derivation, status-to-bucket mapping, and provider-connected analytics.
-   **Carrier Locators / Shipping Provider Configuration**: Plan-and-permission-gated configuration for shipping providers and carrier locators.

## Deferred Future Shipping Improvements

These are roadmap items only — **not implemented** in the current Shipping Module record. They are catalogued here so future work has a clear starting point and so this closure pass cannot be misread as having dropped them silently.

1.  **Customs Docs foundation** — international shipment customs declarations, HS codes, EEI / AES filing readiness.
2.  **Insurance Rules foundation** — declared-value rules, per-carrier insurance offering, insurance cost capture.
3.  **Carrier manifests / end-of-day closeout** — manifest generation and provider close-out flows.
4.  **Barcode scanning / warehouse-style packing verification** — scanner-driven SKU/serial verification during packing.
5.  **Carrier claims / refund workflow** — operator-initiated claims and refund tracking.
6.  **Automatic carrier switching / recommendation engine** — rule- or model-driven carrier substitution.
7.  **Predictive delivery or predictive SLA optimization** — forecasted delivery windows, predictive miss alerts.
8.  **External carrier benchmarking** — comparing tenant performance to external aggregate data.
9.  **Scheduled recurring automation backfill** — currently backfill is one-shot manual only.
10. **Historical-event replay backfill** — replay past events through the rules engine.
11. **Carrier Scorecards export / configurable weighting** — CSV export and a tenant-editable combined score with defensible weights.
12. **More advanced current-state non-SLA backfill triggers** — extend `current_state_backfillable` beyond the SLA trigger family if desired later.

## Next Recommended Workstream

The next recommended non-shipping workstream is **System Owner Commercial Controls + Add-on Governance**.

# External Dependencies

-   **Firebase**: Firestore and Authentication.
-   **Google AI Studio / Gemini API**: Integrated via `@google/genai`.
-   **Recharts**: Used for charts and data visualizations.
-   **Framer Motion**: Employed for UI animations and transitions.
-   **EasyPost**: Shipping API for label generation and tracking.
-   **Shippo**: Shipping API for label generation and tracking.
-   **ShipStation**: Shipping API for label generation and tracking.
