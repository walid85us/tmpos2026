import type { ShipmentAddress, ShipmentPackage, ShippingRate, AddressValidationResult, LabelArtifact, ProviderTrackingEvent } from '../types';

interface ProviderError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
}

interface AddressValidationResponse {
  success: boolean;
  result?: AddressValidationResult;
  error?: ProviderError;
}

interface GetRatesResponse {
  success: boolean;
  rates?: ShippingRate[];
  error?: ProviderError;
}

interface PurchaseLabelResponse {
  success: boolean;
  label?: LabelArtifact;
  providerShipmentId?: string;
  error?: ProviderError;
}

interface GetTrackingResponse {
  success: boolean;
  status?: string;
  estimatedDelivery?: string;
  events?: ProviderTrackingEvent[];
  error?: ProviderError;
}

interface TestConnectionResponse {
  success: boolean;
  message?: string;
  error?: ProviderError;
}

interface ProvidersStatusResponse {
  providers: {
    providerId: string;
    isActive: boolean;
    environment?: string;
    configuredAt?: string;
    updatedAt?: string;
    maskedCredentials?: Record<string, string>;
    lastTestedAt?: string | null;
    lastTestResult?: 'success' | 'failed' | null;
  }[];
  activeProviderId: string | null;
}

async function apiCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error || errorData?.message || `Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: 'DELETE' });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error || errorData?.message || `Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function storeProviderCredentials(
  providerId: string,
  credentials: { apiKey?: string; apiSecret?: string; accountId?: string },
  environment: 'test' | 'production'
): Promise<{ success: boolean; maskedCredentials?: Record<string, string> }> {
  return apiCall('/api/shipping/credentials', { providerId, credentials, environment });
}

export async function removeProviderCredentials(providerId: string): Promise<{ success: boolean }> {
  return apiDelete(`/api/shipping/credentials/${providerId}`);
}

export async function setActiveProvider(providerId: string | null): Promise<{ success: boolean; activeProviderId?: string | null }> {
  return apiCall('/api/shipping/active-provider', { providerId });
}

export async function getActiveProvider(): Promise<{ activeProviderId: string | null; environment?: 'test' | 'production' | null }> {
  return apiCall('/api/shipping/active-provider');
}

export async function getProvidersStatus(): Promise<ProvidersStatusResponse> {
  return apiCall('/api/shipping/providers-status');
}

export async function testConnection(providerId: string): Promise<TestConnectionResponse> {
  return apiCall('/api/shipping/test-connection', { providerId });
}

export async function validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse> {
  return apiCall('/api/shipping/validate-address', { address });
}

export async function getRates(
  originAddress: ShipmentAddress,
  destinationAddress: ShipmentAddress,
  packages: ShipmentPackage[]
): Promise<GetRatesResponse> {
  return apiCall('/api/shipping/rates', { originAddress, destinationAddress, packages });
}

export async function purchaseLabel(
  originAddress: ShipmentAddress,
  destinationAddress: ShipmentAddress,
  packages: ShipmentPackage[],
  selectedRateId: string,
  carrier: string,
  service: string,
  shipmentRef?: string
): Promise<PurchaseLabelResponse> {
  return apiCall('/api/shipping/purchase-label', {
    originAddress, destinationAddress, packages, selectedRateId, carrier, service, shipmentRef,
  });
}

// ---------------------------------------------------------------------------
// Pickup booking — provider-specific. Backed by /api/shipping/pickup/* which
// route to the active provider's adapter. EasyPost is wired live (real
// /v2/pickups + /buy + /cancel). Shippo and ShipStation return NOT_IMPLEMENTED
// so the UI can honestly distinguish live booking vs capability-gated.
// ---------------------------------------------------------------------------
export interface PickupRateDTO {
  id: string;
  providerRateId: string;
  carrier: string;
  service: string;
  rate: number;
  currency: string;
}
export interface CreatePickupResponse {
  success: boolean;
  providerPickupId?: string;
  status?: string;
  rates?: PickupRateDTO[];
  error?: ProviderError;
}
export interface BuyPickupResponse {
  success: boolean;
  providerPickupId?: string;
  confirmationNumber?: string;
  status?: string;
  cost?: number;
  currency?: string;
  error?: ProviderError;
}
export interface CancelPickupResponse {
  success: boolean;
  providerPickupId?: string;
  status?: string;
  error?: ProviderError;
}
export async function createProviderPickup(params: {
  pickupAddress: ShipmentAddress;
  minDatetime: string;
  maxDatetime: string;
  instructions?: string;
  providerShipmentId?: string;
  carrier?: string;
  isAccountAddress?: boolean;
}): Promise<CreatePickupResponse> {
  return apiCall('/api/shipping/pickup/create', params);
}
export async function buyProviderPickup(providerPickupId: string, providerRateId: string): Promise<BuyPickupResponse> {
  return apiCall('/api/shipping/pickup/buy', { providerPickupId, providerRateId });
}
export async function cancelProviderPickup(providerPickupId: string): Promise<CancelPickupResponse> {
  return apiCall('/api/shipping/pickup/cancel', { providerPickupId });
}

// Service-point locator entry point. Routes to carrier-specific adapters in
// src/shipping/locators/. Provider aggregators (EasyPost / Shippo / ShipStation)
// do not expose a unified locator API, so this dispatcher bypasses them entirely
// and talks directly to USPS / UPS / FedEx adapters when their credentials are set.
export { findServicePoints, isAnyLocatorConfigured, getConfiguredCarriers } from './locators';
export type { LocatorQuery, LocatorResult, DispatcherQuery } from './locators';

export async function syncTracking(
  trackingNumber: string,
  carrier: string,
  providerShipmentId?: string
): Promise<GetTrackingResponse> {
  return apiCall('/api/shipping/tracking', { trackingNumber, carrier, providerShipmentId });
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

export interface BulkSyncResponse {
  success: boolean;
  results?: BulkSyncResult[];
  summary?: {
    total: number;
    updated: number;
    unchanged: number;
    failed: number;
    testLimitation: number;
  };
  error?: { code: string; message: string };
}

export async function bulkSyncTracking(
  shipments: BulkSyncShipmentInput[],
  batchSize?: number,
  delayMs?: number
): Promise<BulkSyncResponse> {
  return apiCall('/api/shipping/bulk-sync', { shipments, batchSize, delayMs });
}

export async function simulateTrackingEvent(
  trackingNumber: string,
  carrier: string
): Promise<GetTrackingResponse & { isSimulated?: boolean }> {
  return apiCall('/api/shipping/simulate-tracking-event', { trackingNumber, carrier });
}

export interface WebhookLogResponse {
  events: WebhookEventSummary[];
  total: number;
}

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

export async function getWebhookLog(filters?: {
  providerId?: string;
  trackingNumber?: string;
  processingResult?: string;
  limit?: number;
}): Promise<WebhookLogResponse> {
  const params = new URLSearchParams();
  if (filters?.providerId) params.set('providerId', filters.providerId);
  if (filters?.trackingNumber) params.set('trackingNumber', filters.trackingNumber);
  if (filters?.processingResult) params.set('processingResult', filters.processingResult);
  if (filters?.limit) params.set('limit', filters.limit.toString());
  return apiCall(`/api/shipping/webhook-log?${params.toString()}`);
}

export async function replayWebhookEvent(webhookEventId: string): Promise<{
  success: boolean;
  replayEventId?: string;
  originalEventId?: string;
  processingResult?: string;
  error?: ProviderError;
}> {
  return apiCall('/api/shipping/replay-event', { webhookEventId });
}
