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

export interface ProviderFieldError {
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
  // Structured diagnostics preserved from the upstream provider so the UI can
  // surface the *actual* failure cause rather than a generic wrapper sentence.
  // For EasyPost these come from `error.code`, `error.message`, and the nested
  // `error.errors[{field, message}]` array. `httpStatus` is the raw HTTP status
  // we got back. `stage` identifies which provider call failed (e.g.
  // 'pickup_create' / 'pickup_buy' / 'pickup_cancel'). `providerCode` is the
  // upstream-defined error code (often more specific than `code`).
  httpStatus?: number;
  stage?: string;
  providerCode?: string;
  providerMessage?: string;
  fieldErrors?: ProviderFieldError[];
}

export interface ShippingProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse>;
  getRates(params: GetRatesRequest): Promise<GetRatesResponse>;
  purchaseLabel(params: PurchaseLabelRequest): Promise<PurchaseLabelResponse>;
  getTracking(params: GetTrackingRequest): Promise<GetTrackingResponse>;
  // Pickup methods are optional. Each provider declares its own honest
  // capability — adapters that cannot natively schedule pickups return
  // { success:false, error:{ code:'NOT_IMPLEMENTED' } } rather than faking it.
  createPickup?(params: CreatePickupRequest): Promise<CreatePickupResponse>;
  buyPickup?(params: BuyPickupRequest): Promise<BuyPickupResponse>;
  cancelPickup?(params: CancelPickupRequest): Promise<CancelPickupResponse>;
}

export interface CreatePickupRequest {
  pickupAddress: ShipmentAddress;
  minDatetime: string;
  maxDatetime: string;
  instructions?: string;
  // EasyPost requires the underlying shipment id (or a list) so it knows what
  // labels are being picked up. Other providers may use different references.
  providerShipmentId?: string;
  providerShipmentIds?: string[];
  carrier?: string;
  isAccountAddress?: boolean;
}

export interface PickupRate {
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
  rates?: PickupRate[];
  error?: ProviderError;
}

export interface BuyPickupRequest {
  providerPickupId: string;
  providerRateId: string;
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

export interface CancelPickupRequest {
  providerPickupId: string;
}

export interface CancelPickupResponse {
  success: boolean;
  providerPickupId?: string;
  status?: string;
  error?: ProviderError;
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
