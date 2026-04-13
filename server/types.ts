export interface ShippingProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
  environment?: 'test' | 'production';
}

export interface ShipmentAddress {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface ShipmentPackage {
  id: string;
  weight?: number;
  weightUnit?: 'lb' | 'kg' | 'oz';
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: 'in' | 'cm';
  declaredValue?: number;
  insuredValue?: number;
  contentsSummary?: string;
}

export interface ShippingRate {
  id: string;
  providerId: string;
  carrier: string;
  serviceName: string;
  serviceCode: string;
  rate: number;
  currency: string;
  estimatedDays?: number;
  estimatedDelivery?: string;
  isGuaranteed?: boolean;
  providerRateRef?: string;
}

export interface LabelArtifact {
  id: string;
  format: string;
  url: string;
  trackingNumber: string;
  carrier: string;
  service: string;
  purchasedAt: string;
  providerLabelRef?: string;
  providerShipmentRef?: string;
  cost: number;
}

export interface ProviderTrackingEvent {
  id: string;
  timestamp: string;
  status: string;
  statusDetail?: string;
  location?: string;
  description: string;
  source: 'provider' | 'manual';
}

export interface AddressValidationResult {
  status: 'validated' | 'corrected' | 'failed' | 'pending';
  validatedAt: string;
  originalAddress: ShipmentAddress;
  suggestedAddress?: ShipmentAddress;
  messages?: string[];
  accepted?: boolean;
  providerRef?: string;
}

export interface ProviderError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
}

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
