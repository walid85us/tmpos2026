import type {
  ShipmentAddress,
  ShipmentPackage,
  ShippingRate,
  AddressValidationResult,
  LabelArtifact,
  ProviderTrackingEvent,
} from '../types';

export interface ShippingProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;

  validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse>;

  getRates(params: GetRatesRequest): Promise<GetRatesResponse>;

  purchaseLabel(params: PurchaseLabelRequest): Promise<PurchaseLabelResponse>;

  getTracking(params: GetTrackingRequest): Promise<GetTrackingResponse>;
}

export interface AddressValidationResponse {
  success: boolean;
  result?: AddressValidationResult;
  error?: ProviderError;
}

export interface GetRatesRequest {
  originAddress: ShipmentAddress;
  destinationAddress: ShipmentAddress;
  packages: ShipmentPackage[];
  shipmentType?: string;
}

export interface GetRatesResponse {
  success: boolean;
  rates?: ShippingRate[];
  error?: ProviderError;
}

export interface PurchaseLabelRequest {
  originAddress: ShipmentAddress;
  destinationAddress: ShipmentAddress;
  packages: ShipmentPackage[];
  selectedRateId: string;
  carrier: string;
  service: string;
  shipmentRef?: string;
}

export interface PurchaseLabelResponse {
  success: boolean;
  label?: LabelArtifact;
  providerShipmentId?: string;
  error?: ProviderError;
}

export interface GetTrackingRequest {
  trackingNumber: string;
  carrier: string;
  providerShipmentId?: string;
}

export interface GetTrackingResponse {
  success: boolean;
  status?: string;
  estimatedDelivery?: string;
  events?: ProviderTrackingEvent[];
  error?: ProviderError;
}

export interface ProviderError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
}

export type ProviderCredentialStatus = 'missing' | 'present' | 'valid' | 'invalid';
