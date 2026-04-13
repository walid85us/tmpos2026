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

export async function getActiveProvider(): Promise<{ activeProviderId: string | null }> {
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

export async function syncTracking(
  trackingNumber: string,
  carrier: string,
  providerShipmentId?: string
): Promise<GetTrackingResponse> {
  return apiCall('/api/shipping/tracking', { trackingNumber, carrier, providerShipmentId });
}
