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
    -   **PDF-Only Primary Label**: The label artifact pipeline ensures the primary label action always results in a real PDF. The server requests `label_format: 'PDF'` from EasyPost. If the provider returns PNG (common in test mode), a server-side label proxy (`/api/shipping/label-proxy`) bypasses CORS, and client-side Canvas→JPEG→DCTDecode PDF construction produces a real PDF blob. Fallback: if client-side conversion fails, the proxied image URL is used directly. Label metadata internally records `originalFormat` for audit purposes but this is never shown to the operator — the operator UI presents a clean "Print PDF Label" / "View" flow without conversion noise.
    -   **Shipment Mode Split (Provider vs Manual)**: Mode is purely computed, not stored as a field. Rule: if `selectedRate` exists → provider mode; if `carrier && serviceLevel` without `selectedRate` → manual mode; otherwise provider (default). Manual carrier/service entry in the edit modal automatically forces manual mode. Clearing carrier/service reverts to provider mode. In manual mode: all provider-backed actions (Validate Address, Get Rates, Purchase Label, Sync Tracking, Simulate Provider Events) are hidden. The manual mode banner explains why provider actions are disabled and instructs user to clear carrier/service to restore provider features. In provider mode: full workflow (address validation → Get Rates → rate selection → Purchase Label → tracking sync). Provider prerequisites (address validation, packages, provider configured) recalculate on every render from live shipment state.
    -   **Address Editability**: Origin and destination addresses are editable in the edit modal for statuses Draft, Ready, Label Created, and Packed (i.e., before Dispatched). Changing the destination address clears any previous address validation to force re-validation. The edit modal includes full address form fields (name, line1, city, state, postal code) for both origin and destination.
    -   **Unified Provider Status Source of Truth**: Provider status (configured, active, verified/tested, environment) is powered by a single state source — `providerStatuses` array loaded eagerly on component mount and refreshed after every provider operation (test, activate, configure). The provider header summary badge, provider settings panel badges, and action prerequisite gating all derive from this same array. After a successful Test Connection, the provider is auto-activated if no active provider exists. The header displays Verified/Failed badges inline with the provider name and environment.
    -   **Provider Prerequisite Recalculation**: `getRatePrerequisites` and `getLabelPrerequisites` compute from live state on every render. Messages differentiate between "Configure a shipping provider" (no providers have credentials) vs "Set an active shipping provider" (providers configured but none activated). Prerequisites clear immediately after provider activation, address validation, package changes.
    -   **Post-Label Action Cleanup**: After label purchase, Validate Address is hidden (gated by `!selectedShip.label`). The address is considered committed once a label is purchased. Validate Address only reappears if the shipment is rolled back to a pre-label state and the address is changed. Address fields in the edit modal are also locked after label purchase.
    -   **Post-dispatch lifecycle**: Robust governance with carrier acceptance tracking, Rejected/Returned with reasons, Dispatched→Packed rollback (with required reason) when carrier has not yet accepted the package, and provider-driven progression in provider mode.
    -   **Webhook/Event Processing Pipeline**: `server/event-processor.ts` provides a unified event processing pipeline for all shipping provider webhooks and tracking syncs.
        -   **Idempotency**: Deduplication via `providerEventRef` matching (or timestamp+status fallback). Client-side tracking sync also deduplicates events before merging.
        -   **Status Mapping**: Centralized `PROVIDER_TO_INTERNAL_STATUS` map converts provider-specific statuses (pre_transit, accepted, in_transit, etc.) to internal statuses. Used by both webhook processing and client-side sync.
        -   **Status Progression Awareness**: `isStatusProgression()` prevents out-of-order status regression. Exception/Returned statuses only apply if shipment is already Dispatched+.
        -   **Provider Parsers**: EasyPost, Shippo, ShipStation webhook payloads are normalized by provider-specific parsers into a common `ProviderTrackingEvent[]` format.
        -   **Webhook Audit Log (Durable)**: File-backed ring buffer (`data/webhook-audit-log.json`, 500 entries max) records every webhook event with full metadata (providerId, eventType, trackingNumber, processingResult, signatureVerified, isTestMode, retryCount, source). Loaded from disk on server startup, persisted asynchronously (200ms debounce) on every write. Survives server restarts — the first durable audit trail in the system. Duplicate webhook detection at audit level via `providerEventId` matching.
        -   **Recovery Tooling**: Webhook log viewer (admin, permission-gated via `manage_shipping_settings`) with filtering by result type. Event replay endpoint re-parses original raw payload through the provider-specific parser. Sync failure counter tracks consecutive failures per shipment with `syncFailureCount` and `lastSyncError`.
        -   **Enhanced Timeline**: Tracking events display source badges (Provider, Webhook, Replay, Test Provider, Manual) with color-coded dots and per-source colored timeline nodes. Processing metadata (result, received timestamp) visible on non-standard events.
        -   **Security**: HMAC-SHA256 signature verification (timing-safe comparison) when `SHIPPING_WEBHOOK_SECRET_<PROVIDER>` env var is set. Raw payloads redacted from all webhook-log GET responses. Admin endpoints (webhook-log, replay) gated client-side by `manage_shipping_settings` sub-permission + `isWriteBlocked` guard on replay.
    -   **Phase 2 Forward-Compatible Fields**: Shipment type includes extension fields for customs declarations (`customsInfo`), insurance (`insuranceInfo`), return management (`returnInfo`). These are typed and optional, ready for Phase 2 international/returns features without schema migration.
    -   **Phase 3 Forward-Compatible Fields**: Shipment type includes extension fields for pickup scheduling (`pickupInfo`), SLA tracking (`slaInfo`), and batch processing (`batchId`). These are typed and optional, ready for Phase 3 operations/logistics features.
    -   **Unified Status Mapping**: Shared `PROVIDER_STATUS_TO_SHIPMENT` map and `applyTrackingStatusToShipment()` function used by all tracking event sources (sync, simulate, replay). Ensures shipment header status and timeline always agree. Status progression guards prevent backward regression.
    -   **Duplicate-Event Safety (QA-Verifiable)**: Clicking "Simulate Provider Events" a second time deduplicates incoming events against existing timeline events via `providerEventRef` and `timestamp|status` matching. The success message reports how many duplicates were safely skipped. Webhook log also displays `duplicate` result entries with amber styling. Both paths are permission-gated and safe for QA verification.
    -   **API Endpoints (Event/Webhook)**:
        -   `POST /api/shipping/webhook/:providerId` — Receives provider webhooks, parses payload, records to durable audit log, returns processing result. Signature verified when secret configured.
        -   `GET /api/shipping/webhook-log` — Admin endpoint returning filtered webhook event log (rawPayload redacted).
        -   `GET /api/shipping/webhook-log/stats` — Aggregate stats (total, by result, by provider, time range).
        -   `GET /api/shipping/webhook-log/:eventId` — Single webhook event detail (rawPayload redacted).
        -   `POST /api/shipping/replay-event` — Re-parses original raw payload through provider parser pipeline, records new audit entry with source='replay'.
        -   `GET /api/shipping/event-processor/status-map` — Returns the provider→internal status mapping and progression order.

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

# Phase 2 Forward-Readiness

The following capabilities are structurally prepared in the current codebase (typed fields on `Shipment` in `src/types.ts`, no UI yet). No schema migration needed when Phase 2 activates.

-   **Returns Portal**: `returnInfo` field — `isReturn`, `originalShipmentId`, `returnReason`, `returnRequestedAt`, `returnLabelUrl`. Ready for return label generation, return-to-original-shipment linking, and return reason tracking.
-   **Service Points**: `pickupInfo.servicePointId` field. Ready for carrier service point / drop-off location selection during shipment creation.
-   **Customs Documents**: `customsInfo` field — `contentsType`, `contentsExplanation`, `declaredValue`, `currency`, `hsCode`, `originCountry`. Ready for international shipment customs declarations and commercial invoices.
-   **Pickup Requests**: `pickupInfo` field — `pickupRequested`, `pickupScheduledAt`, `pickupConfirmationNumber`. Ready for carrier pickup scheduling and confirmation tracking.
-   **Insurance Rules**: `insuranceInfo` field — `insured`, `insuredValue`, `currency`, `provider`. Ready for shipment insurance enrollment and value declaration.
-   **Carrier Analytics**: `lastWebhookEventAt`, `webhookEventsCount` on Shipment. Status progression tracking via `applyTrackingStatusToShipment()`. Ready for carrier performance dashboards, delivery time analysis, and exception rate reporting.

# Phase 3 Forward-Readiness

The following capabilities are structurally prepared for Phase 3 (typed fields on `Shipment` in `src/types.ts`, no UI yet).

-   **Automation Rules**: Webhook/event processing pipeline (`server/event-processor.ts`) provides the ingestion and parsing foundation. Provider-specific parsers normalize all inbound events. Status mapping and progression guards are centralized. Ready for rule-based automation (e.g., auto-notify customer on delivery, auto-flag exceptions).
-   **Batch Labels**: `batchId` field on Shipment. Ready for grouping shipments into fulfillment batches and purchasing labels in bulk via a single provider API call.
-   **Packing Workflows**: Shipment lifecycle includes Packed status with explicit Pack/Unpack transitions. Package array with dimensions/weight already tracked per shipment. Ready for barcode-driven packing station workflows.
-   **SLA Optimization**: `slaInfo` field — `targetDeliveryAt`, `slaType` (standard/express/overnight/economy), `slaMet`, `transitBusinessDays`. Ready for SLA commitment tracking, breach alerting, and carrier selection optimization based on SLA requirements.
-   **Carrier Scorecards**: Webhook audit log (`data/webhook-audit-log.json`) with per-provider stats endpoint (`/api/shipping/webhook-log/stats`). Combined with `slaInfo.slaMet` and exception tracking, ready for carrier reliability scoring, on-time delivery rates, and cost-per-delivery analysis.

# Recommended Future Enhancements

-   **Main-Page Shipment Sync / Reconciliation**: Add a "Sync Shipment Statuses" or "Re-sync Eligible Shipments" action on the main shipment list page. This would iterate over all in-flight shipments (Dispatched, In Transit) and trigger provider tracking sync for each, updating statuses in bulk. Useful as a daily operational reconciliation tool or after extended downtime. The per-shipment `handleSyncTracking` and `applyTrackingStatusToShipment()` functions already provide the building blocks — the main-page feature would be a batch orchestrator with rate-limiting and progress feedback. Not implemented in current phase — webhook-driven updates are the primary status update mechanism.