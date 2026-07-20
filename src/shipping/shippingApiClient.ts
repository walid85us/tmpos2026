import type { ShipmentAddress, ShipmentPackage, ShippingRate, AddressValidationResult, LabelArtifact, ProviderTrackingEvent } from '../types';

interface ProviderFieldError {
  field?: string;
  message: string;
  code?: string;
  suggestion?: string;
}
export interface ProviderError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
  httpStatus?: number;
  stage?: string;
  providerCode?: string;
  providerMessage?: string;
  fieldErrors?: ProviderFieldError[];
}

// ---------------------------------------------------------------------------
// Phase 4.0 M3 — the REQUIRED discriminated result contract.
//
// Every operation used to return `{ success: boolean; data?: …; error?: ProviderError }`,
// and three of them made `success` OPTIONAL. That shape had two holes, and this milestone
// spent its time hand-patching instances of both:
//
//   1. Success-only payload was readable WITHOUT proving success. `(await getRates(…)).rates`
//      compiled fine, so "service unavailable" and "genuinely empty" were the same value to
//      the type system — which is exactly how an outage came to be rendered as "no provider
//      configured", "no webhook events recorded yet", and an empty rate list.
//   2. An ABSENT `success` was neither success nor failure. `if (r.success === false)` fails
//      OPEN on `undefined` while `if (!r.success)` fails CLOSED, and both spellings existed
//      in this codebase — so one condition produced two behaviours depending on call site.
//
// The union below closes both by construction. `success` is the discriminant and is never
// optional, so an unnarrowed read of payload no longer compiles; the failure branch carries
// no success data, and the success branch carries no error for the caller to interpret.
// Narrowing is therefore total: after `if (!r.success) return;` the remainder IS the success
// shape, with no third state left to reason about.
// ---------------------------------------------------------------------------

/** The only failure shape. `error` is present, never optional. */
export interface ShippingFailure {
  success: false;
  error: ProviderError;
}

/**
 * A Shipping operation result: the success payload `T` tagged `success: true`, or the
 * bounded failure. Callers must narrow on `success` before touching anything else.
 *
 * NARROWING PATTERN — use `if (result.success === false) { …handle…; return; }`.
 *
 * Not a style preference. This project does not enable `strictNullChecks`, and without it
 * TypeScript declines to narrow a discriminated union through NEGATED TRUTHINESS: `if
 * (!result.success)` leaves the value un-narrowed, so `result.error` does not compile.
 * `=== false`, `=== true`, plain `if (result.success)`, and early-return all narrow
 * correctly — verified against this repository's own tsconfig.
 *
 * `=== false` was the FAIL-OPEN spelling under the previous `success?: boolean` contract,
 * because `undefined === false` is false and an absent flag sailed through as success. It
 * is fail-closed here: `success` is a required literal `true | false`, so there is no third
 * value for the comparison to miss. tests/quality/shipping-client-type-contract.test.mjs
 * asserts that requirement for all 17 operations, which is what keeps this safe.
 */
export type ShippingResult<T> = ({ success: true } & T) | ShippingFailure;

export type AddressValidationResponse = ShippingResult<{ result: AddressValidationResult }>;

export type GetRatesResponse = ShippingResult<{ rates: ShippingRate[] }>;

export type PurchaseLabelResponse = ShippingResult<{
  label: LabelArtifact;
  providerShipmentId?: string;
}>;

export type GetTrackingResponse = ShippingResult<{
  status?: string;
  estimatedDelivery?: string;
  events?: ProviderTrackingEvent[];
}>;

/**
 * Tracking simulation. Spelled as its own `ShippingResult` rather than
 * `GetTrackingResponse & { isSimulated?: boolean }`: intersecting a union distributes over
 * BOTH branches, which would have re-attached success-only data to the failure branch.
 */
export type SimulateTrackingResponse = ShippingResult<{
  status?: string;
  estimatedDelivery?: string;
  events?: ProviderTrackingEvent[];
  isSimulated?: boolean;
}>;

export type TestConnectionResponse = ShippingResult<{ message?: string }>;

export interface ProviderStatusEntry {
  providerId: string;
  isActive: boolean;
  environment?: string;
  configuredAt?: string;
  updatedAt?: string;
  maskedCredentials?: Record<string, string>;
  lastTestedAt?: string | null;
  lastTestResult?: 'success' | 'failed' | null;
}

export type ProvidersStatusResponse = ShippingResult<{
  providers: ProviderStatusEntry[];
  activeProviderId: string | null;
}>;

export type StoreCredentialsResponse = ShippingResult<{
  maskedCredentials?: Record<string, string>;
}>;

/** No payload beyond the tag: the removal either happened or it did not. */
export type RemoveCredentialsResponse = ShippingResult<{ removed?: true }>;

export type SetActiveProviderResponse = ShippingResult<{ activeProviderId: string | null }>;

export type GetActiveProviderResponse = ShippingResult<{
  activeProviderId: string | null;
  environment?: 'test' | 'production' | null;
}>;

export type ReplayWebhookResponse = ShippingResult<{
  replayEventId?: string;
  originalEventId?: string;
  processingResult?: string;
}>;

// ---------------------------------------------------------------------------
// Phase 4.0 M3 — migration containment.
//
// The DEV Shipping sidecar that backed every operation below was ELIMINATED: it
// exposed 22 unauthenticated routes, including an arbitrary-URL label proxy
// (full-read SSRF), unauthenticated carrier-credential create/read/delete,
// active-provider mutation, and real provider calls that spend money.
//
// This module keeps its exported surface so callers still compile and render,
// but performs NO network call. Every operation resolves — never rejects — to a
// bounded, non-retryable SHIPPING_UNAVAILABLE envelope. Two rules drive that
// shape: callers must never be shown a fabricated rate, label, tracking event,
// or configured-provider state; and four call sites in ShippingCenter have no
// try/catch, so a rejection would strand them in a permanent loading state.
//
// Provider connectivity returns in M7e, store-owned and server-authoritative,
// on the M6 encrypted-credential/audit/idempotency foundation.
// ---------------------------------------------------------------------------

/** Bounded, non-retryable code every Shipping operation now returns. */
export const SHIPPING_UNAVAILABLE_CODE = 'SHIPPING_UNAVAILABLE';

/** Customer-facing wording: states the fact, promises no retry, leaks nothing. */
const SHIPPING_UNAVAILABLE_MESSAGE =
  'Shipping provider services are unavailable while the shipping backend is being rebuilt.';

/** A fresh envelope per call — never a shared object a caller could mutate. */
function unavailable(): ShippingFailure {
  return {
    success: false,
    error: { code: SHIPPING_UNAVAILABLE_CODE, message: SHIPPING_UNAVAILABLE_MESSAGE, retryable: false },
  };
}

export async function storeProviderCredentials(
  _providerId: string,
  _credentials: { apiKey?: string; apiSecret?: string; accountId?: string },
  _environment: 'test' | 'production'
): Promise<StoreCredentialsResponse> {
  // Credentials are never transmitted, stored, echoed, or logged here.
  return unavailable();
}

export async function removeProviderCredentials(_providerId: string): Promise<RemoveCredentialsResponse> {
  return unavailable();
}

export async function setActiveProvider(_providerId: string | null): Promise<SetActiveProviderResponse> {
  return unavailable();
}

export async function getActiveProvider(): Promise<GetActiveProviderResponse> {
  // The failure branch carries NO `activeProviderId` at all. Previously this returned
  // `{ …unavailable(), activeProviderId: null }`, and a caller that skipped the check
  // read that null as "no provider configured" — an outage asserting a fact about the
  // store. Absent beats null: there is now nothing to misread.
  return unavailable();
}

export async function getProvidersStatus(): Promise<ProvidersStatusResponse> {
  // Same rule: no empty `providers` array on the failure branch. An empty list is
  // indistinguishable from a genuinely unconfigured store, so it is not offered.
  return unavailable();
}

export async function testConnection(_providerId: string): Promise<TestConnectionResponse> {
  return unavailable();
}

export async function validateAddress(_address: ShipmentAddress): Promise<AddressValidationResponse> {
  return unavailable();
}

export async function getRates(
  _originAddress: ShipmentAddress,
  _destinationAddress: ShipmentAddress,
  _packages: ShipmentPackage[]
): Promise<GetRatesResponse> {
  return unavailable();
}

export async function purchaseLabel(
  _originAddress: ShipmentAddress,
  _destinationAddress: ShipmentAddress,
  _packages: ShipmentPackage[],
  _selectedRateId: string,
  _carrier: string,
  _service: string,
  _shipmentRef?: string
): Promise<PurchaseLabelResponse> {
  // No label is purchased and none is fabricated — nothing is charged.
  return unavailable();
}

// ---------------------------------------------------------------------------
// Pickup booking — formerly routed to the active provider's adapter through the
// DEV sidecar. That backend is eliminated, so no pickup is created, bought, or
// cancelled: every call resolves to the bounded unavailable envelope. Booking
// returns in M7e.
// ---------------------------------------------------------------------------
export interface PickupRateDTO {
  id: string;
  providerRateId: string;
  carrier: string;
  service: string;
  rate: number;
  currency: string;
}
export type CreatePickupResponse = ShippingResult<{
  providerPickupId?: string;
  status?: string;
  rates?: PickupRateDTO[];
}>;
export type BuyPickupResponse = ShippingResult<{
  providerPickupId?: string;
  confirmationNumber?: string;
  status?: string;
  cost?: number;
  currency?: string;
}>;
export type CancelPickupResponse = ShippingResult<{
  providerPickupId?: string;
  status?: string;
}>;
export async function createProviderPickup(_params: {
  providerId?: string;
  pickupAddress: ShipmentAddress;
  minDatetime: string;
  maxDatetime: string;
  instructions?: string;
  providerShipmentId?: string;
  carrier?: string;
  isAccountAddress?: boolean;
}): Promise<CreatePickupResponse> {
  return unavailable();
}
export async function buyProviderPickup(_providerPickupId: string, _providerRateId: string, _providerId?: string): Promise<BuyPickupResponse> {
  // No pickup is booked and none is fabricated — nothing is charged.
  return unavailable();
}
export async function cancelProviderPickup(_providerPickupId: string, _providerId?: string): Promise<CancelPickupResponse> {
  return unavailable();
}

// Service-point locator entry point. Routes to carrier-specific adapters in
// src/shipping/locators/. Provider aggregators (EasyPost / Shippo / ShipStation)
// do not expose a unified locator API, so this dispatcher bypasses them entirely
// and talks directly to USPS / UPS / FedEx adapters when their credentials are set.
export { findServicePoints, isAnyLocatorConfigured, getConfiguredCarriers } from './locators';
export type { LocatorQuery, LocatorResult, DispatcherQuery } from './locators';

export async function syncTracking(
  _trackingNumber: string,
  _carrier: string,
  _providerShipmentId?: string
): Promise<GetTrackingResponse> {
  return unavailable();
}

export interface BulkSyncShipmentInput {
  shipmentId: string;
  trackingNumber: string;
  carrier?: string;
  providerShipmentId?: string;
}

export interface BulkSyncResult {
  shipmentId: string;
  trackingNumber: string;
  result: 'updated' | 'unchanged' | 'failed' | 'test_limitation';
  events?: ProviderTrackingEvent[];
  status?: string;
  estimatedDelivery?: string;
  error?: { code: string; message: string };
  newEventCount?: number;
}

export type BulkSyncResponse = ShippingResult<{
  results: BulkSyncResult[];
  summary: {
    total: number;
    updated: number;
    unchanged: number;
    failed: number;
    testLimitation: number;
  };
}>;

export async function bulkSyncTracking(
  _shipments: BulkSyncShipmentInput[],
  _batchSize?: number,
  _delayMs?: number
): Promise<BulkSyncResponse> {
  return unavailable();
}

export async function simulateTrackingEvent(
  _trackingNumber: string,
  _carrier: string
): Promise<SimulateTrackingResponse> {
  return unavailable();
}

export type WebhookLogResponse = ShippingResult<{
  events: WebhookEventSummary[];
  total: number;
}>;

export interface WebhookEventSummary {
  id: string;
  providerId: string;
  providerEventId?: string;
  eventType: string;
  trackingNumber?: string;
  shipmentRef?: string;
  receivedAt: string;
  processedAt?: string;
  processingResult: 'processed' | 'ignored' | 'duplicate' | 'failed' | 'pending';
  processingError?: string;
  mappedStatus?: string;
  source: 'webhook' | 'sync' | 'replay' | 'simulation';
  isTestMode: boolean;
  signatureVerified: boolean;
  retryCount: number;
}

export async function getWebhookLog(_filters?: {
  providerId?: string;
  trackingNumber?: string;
  processingResult?: string;
  limit?: number;
}): Promise<WebhookLogResponse> {
  // No empty `events` array on the failure branch: "none arrived" and "nothing is
  // ingesting" are different facts, and only the second one is true.
  return unavailable();
}

export async function replayWebhookEvent(_webhookEventId: string): Promise<ReplayWebhookResponse> {
  return unavailable();
}
