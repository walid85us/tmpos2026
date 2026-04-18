import type {
  ShippingProviderAdapter,
  AddressValidationResponse,
  GetRatesRequest,
  GetRatesResponse,
  PurchaseLabelRequest,
  PurchaseLabelResponse,
  GetTrackingRequest,
  GetTrackingResponse,
  CreatePickupRequest,
  CreatePickupResponse,
  BuyPickupRequest,
  BuyPickupResponse,
  CancelPickupRequest,
  CancelPickupResponse,
  ShipmentAddress,
  ShippingRate,
  LabelArtifact,
  ProviderTrackingEvent,
  ProviderError,
} from '../types';
import { getCredentials } from '../credential-store';

const NO_CREDENTIALS_ERROR: ProviderError = {
  code: 'PROVIDER_NOT_CONFIGURED',
  message: 'Shippo API token is not configured. Configure your shipping provider in Shipping Center.',
  retryable: false,
};

function getApiToken(): string | null {
  const creds = getCredentials('shippo');
  return creds?.apiKey || null;
}

function normalizePhone(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return '';
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  if (digits.length === 10) return '1' + digits;
  return digits;
}

function mapAddressToShippo(addr: ShipmentAddress) {
  return {
    name: addr.name,
    company: addr.company || '',
    street1: addr.line1,
    street2: addr.line2 || '',
    city: addr.city,
    state: addr.state,
    zip: addr.postalCode,
    country: addr.country,
    phone: normalizePhone(addr.phone),
    email: addr.email || '',
  };
}

function mapShippoToAddress(sp: Record<string, string>): ShipmentAddress {
  return {
    name: sp.name || '',
    company: sp.company || undefined,
    line1: sp.street1 || '',
    line2: sp.street2 || undefined,
    city: sp.city || '',
    state: sp.state || '',
    postalCode: sp.zip || '',
    country: sp.country || 'US',
    phone: sp.phone || undefined,
    email: sp.email || undefined,
  };
}

export class ShippoAdapter implements ShippingProviderAdapter {
  readonly providerId = 'shippo';
  readonly providerName = 'Shippo';

  async validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse> {
    const token = getApiToken();
    if (!token) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch('https://api.goshippo.com/addresses/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...mapAddressToShippo(address), validate: true }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: errorData?.detail || `Address validation failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const isValid = data.validation_results?.is_valid === true;
      const messages = data.validation_results?.messages?.map((m: { text: string }) => m.text) || [];

      return {
        success: true,
        result: {
          status: isValid ? 'validated' : 'failed',
          validatedAt: new Date().toISOString(),
          originalAddress: address,
          suggestedAddress: isValid ? mapShippoToAddress(data) : undefined,
          messages,
          providerRef: data.object_id,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to Shippo: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getRates(params: GetRatesRequest): Promise<GetRatesResponse> {
    const token = getApiToken();
    if (!token) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const response = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address_from: mapAddressToShippo(params.originAddress),
          address_to: mapAddressToShippo(params.destinationAddress),
          parcels: [{
            length: String(parcel?.length || 10),
            width: String(parcel?.width || 8),
            height: String(parcel?.height || 4),
            distance_unit: parcel?.dimensionUnit === 'cm' ? 'cm' : 'in',
            weight: String(parcel?.weight || 1),
            mass_unit: parcel?.weightUnit === 'kg' ? 'kg' : 'lb',
          }],
          async: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'RATES_FAILED',
            message: errorData?.detail || `Rate retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const rates: ShippingRate[] = (data.rates || []).map((r: Record<string, unknown>, idx: number) => ({
        id: `rate-${idx}-${Date.now()}`,
        providerId: 'shippo',
        carrier: (r.provider as string) || 'Unknown',
        serviceName: (r.servicelevel as Record<string, string>)?.name || 'Standard',
        serviceCode: (r.servicelevel as Record<string, string>)?.token || '',
        rate: parseFloat(r.amount as string) || 0,
        currency: (r.currency as string) || 'USD',
        estimatedDays: r.estimated_days as number | undefined,
        estimatedDelivery: r.arrives_by as string | undefined,
        providerRateRef: r.object_id as string,
      }));

      return { success: true, rates };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to Shippo: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async purchaseLabel(params: PurchaseLabelRequest): Promise<PurchaseLabelResponse> {
    const token = getApiToken();
    if (!token) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const shipResponse = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address_from: mapAddressToShippo(params.originAddress),
          address_to: mapAddressToShippo(params.destinationAddress),
          parcels: [{
            length: String(parcel?.length || 10),
            width: String(parcel?.width || 8),
            height: String(parcel?.height || 4),
            distance_unit: parcel?.dimensionUnit === 'cm' ? 'cm' : 'in',
            weight: String(parcel?.weight || 1),
            mass_unit: parcel?.weightUnit === 'kg' ? 'kg' : 'lb',
          }],
          async: false,
        }),
      });

      if (!shipResponse.ok) {
        const errorData = await shipResponse.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'SHIPMENT_CREATE_FAILED',
            message: errorData?.detail || `Shipment creation failed (HTTP ${shipResponse.status})`,
            retryable: shipResponse.status >= 500,
          },
        };
      }

      const shipData = await shipResponse.json();
      const targetRate = shipData.rates?.find(
        (r: Record<string, unknown>) =>
          (r.provider as string) === params.carrier &&
          ((r.servicelevel as Record<string, string>)?.name === params.service ||
           (r.servicelevel as Record<string, string>)?.token === params.service)
      );

      if (!targetRate) {
        return {
          success: false,
          error: {
            code: 'RATE_NOT_FOUND',
            message: `Selected rate (${params.carrier} ${params.service}) not available.`,
            retryable: false,
          },
        };
      }

      const txnResponse = await fetch('https://api.goshippo.com/transactions/', {
        method: 'POST',
        headers: {
          'Authorization': `ShippoToken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rate: targetRate.object_id,
          label_file_type: 'PDF',
          async: false,
        }),
      });

      if (!txnResponse.ok) {
        const errorData = await txnResponse.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'LABEL_PURCHASE_FAILED',
            message: errorData?.detail || `Label purchase failed (HTTP ${txnResponse.status})`,
            retryable: txnResponse.status >= 500,
          },
        };
      }

      const txnData = await txnResponse.json();
      const label: LabelArtifact = {
        id: `lbl-${Date.now()}`,
        format: 'pdf',
        url: txnData.label_url || '',
        trackingNumber: txnData.tracking_number || '',
        carrier: params.carrier,
        service: params.service,
        purchasedAt: new Date().toISOString(),
        providerLabelRef: txnData.object_id,
        providerShipmentRef: shipData.object_id,
        cost: parseFloat(targetRate.amount || '0'),
      };

      return { success: true, label, providerShipmentId: shipData.object_id };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to Shippo: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getTracking(params: GetTrackingRequest): Promise<GetTrackingResponse> {
    const token = getApiToken();
    if (!token) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch(
        `https://api.goshippo.com/tracks/${params.carrier}/${params.trackingNumber}`,
        {
          headers: { 'Authorization': `ShippoToken ${token}` },
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'TRACKING_FAILED',
            message: errorData?.detail || `Tracking retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const events: ProviderTrackingEvent[] = (data.tracking_history || []).map(
        (td: Record<string, unknown>, idx: number) => ({
          id: `pte-${idx}-${Date.now()}`,
          timestamp: (td.status_date as string) || new Date().toISOString(),
          status: (td.status as string) || 'unknown',
          statusDetail: td.substatus as string | undefined,
          location: td.location
            ? `${(td.location as Record<string, string>).city || ''}, ${(td.location as Record<string, string>).state || ''}`
            : undefined,
          description: (td.status_details as string) || '',
          source: 'provider' as const,
        })
      );

      return {
        success: true,
        status: data.tracking_status?.status || undefined,
        estimatedDelivery: data.eta || undefined,
        events,
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to Shippo: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Pickup booking — capability-gated. Shippo exposes /pickups (different shape
  // from EasyPost: no separate /buy step, single-shot create returns a
  // confirmation_code). Live wiring is not yet implemented in this app, so we
  // fail honestly with NOT_IMPLEMENTED rather than fabricate a confirmation.
  // ---------------------------------------------------------------------------
  async createPickup(_params: CreatePickupRequest): Promise<CreatePickupResponse> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Shippo pickup booking is capability-gated. Shippo /pickups is supported by Shippo but the adapter call is not yet wired in this app. Use a local pickup record or switch to EasyPost for live booking.', retryable: false } };
  }
  async buyPickup(_params: BuyPickupRequest): Promise<BuyPickupResponse> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Shippo pickups do not use a separate buy step (single-shot create). buyPickup is not applicable for this provider.', retryable: false } };
  }
  async cancelPickup(_params: CancelPickupRequest): Promise<CancelPickupResponse> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Shippo pickup cancellation adapter is not yet wired in this app.', retryable: false } };
  }
}
