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
  message: 'EasyPost API key is not configured. Configure your shipping provider in Shipping Center.',
  retryable: false,
};

function getApiKey(): string | null {
  const creds = getCredentials('easypost');
  return creds?.apiKey || null;
}

function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return undefined;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  if (digits.length === 10) return '1' + digits;
  return digits;
}

function mapAddressToEasyPost(addr: ShipmentAddress) {
  return {
    name: addr.name,
    company: addr.company || undefined,
    street1: addr.line1,
    street2: addr.line2 || undefined,
    city: addr.city,
    state: addr.state,
    zip: addr.postalCode,
    country: addr.country,
    phone: normalizePhone(addr.phone),
    email: addr.email || undefined,
  };
}

function mapEasyPostToAddress(ep: Record<string, string>): ShipmentAddress {
  return {
    name: ep.name || '',
    company: ep.company || undefined,
    line1: ep.street1 || '',
    line2: ep.street2 || undefined,
    city: ep.city || '',
    state: ep.state || '',
    postalCode: ep.zip || '',
    country: ep.country || 'US',
    phone: ep.phone || undefined,
    email: ep.email || undefined,
  };
}

export class EasyPostAdapter implements ShippingProviderAdapter {
  readonly providerId = 'easypost';
  readonly providerName = 'EasyPost';

  async validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch('https://api.easypost.com/v2/addresses/create_and_verify', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: { ...mapAddressToEasyPost(address), verify: ['delivery'] } }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: errorData?.error?.message || `Address validation failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const verifications = data.address?.verifications?.delivery;
      const isValid = verifications?.success === true;
      const suggested = data.address ? mapEasyPostToAddress(data.address) : undefined;
      const addressChanged = suggested && (
        suggested.line1 !== address.line1 ||
        suggested.city !== address.city ||
        suggested.state !== address.state ||
        suggested.postalCode !== address.postalCode
      );

      return {
        success: true,
        result: {
          status: isValid ? (addressChanged ? 'corrected' : 'validated') : 'failed',
          validatedAt: new Date().toISOString(),
          originalAddress: address,
          suggestedAddress: addressChanged ? suggested : undefined,
          messages: verifications?.errors?.map((e: { message: string }) => e.message) || [],
          providerRef: data.address?.id,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getRates(params: GetRatesRequest): Promise<GetRatesResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const response = await fetch('https://api.easypost.com/v2/shipments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shipment: {
            from_address: mapAddressToEasyPost(params.originAddress),
            to_address: mapAddressToEasyPost(params.destinationAddress),
            parcel: {
              weight: (parcel?.weight || 1) * (parcel?.weightUnit === 'kg' ? 35.274 : 16),
              length: parcel?.length || 10,
              width: parcel?.width || 8,
              height: parcel?.height || 4,
            },
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'RATES_FAILED',
            message: errorData?.error?.message || `Rate retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const rates: ShippingRate[] = (data.rates || []).map((r: Record<string, unknown>, idx: number) => ({
        id: `rate-${idx}-${Date.now()}`,
        providerId: 'easypost',
        carrier: (r.carrier as string) || 'Unknown',
        serviceName: (r.service as string) || 'Standard',
        serviceCode: (r.service as string) || '',
        rate: parseFloat(r.rate as string) || 0,
        currency: (r.currency as string) || 'USD',
        estimatedDays: r.est_delivery_days as number | undefined,
        estimatedDelivery: r.delivery_date as string | undefined,
        providerRateRef: r.id as string,
      }));

      return { success: true, rates };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async purchaseLabel(params: PurchaseLabelRequest): Promise<PurchaseLabelResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const fromAddr = mapAddressToEasyPost(params.originAddress);
      const toAddr = mapAddressToEasyPost(params.destinationAddress);
      console.log(`[EasyPost] purchaseLabel from_address.phone=${JSON.stringify(fromAddr.phone)} to_address.phone=${JSON.stringify(toAddr.phone)}`);
      const createResponse = await fetch('https://api.easypost.com/v2/shipments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shipment: {
            from_address: fromAddr,
            to_address: toAddr,
            parcel: {
              weight: (parcel?.weight || 1) * (parcel?.weightUnit === 'kg' ? 35.274 : 16),
              length: parcel?.length || 10,
              width: parcel?.width || 8,
              height: parcel?.height || 4,
            },
          },
        }),
      });

      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'SHIPMENT_CREATE_FAILED',
            message: errorData?.error?.message || `Shipment creation failed (HTTP ${createResponse.status})`,
            retryable: createResponse.status >= 500,
          },
        };
      }

      const shipmentData = await createResponse.json();
      const targetRate = shipmentData.rates?.find(
        (r: Record<string, string>) => r.carrier === params.carrier && r.service === params.service
      );

      if (!targetRate) {
        return {
          success: false,
          error: {
            code: 'RATE_NOT_FOUND',
            message: `Selected rate (${params.carrier} ${params.service}) not available for this shipment.`,
            retryable: false,
          },
        };
      }

      const buyResponse = await fetch(`https://api.easypost.com/v2/shipments/${shipmentData.id}/buy`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rate: { id: targetRate.id }, label_format: 'PDF' }),
      });

      if (!buyResponse.ok) {
        const errorData = await buyResponse.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'LABEL_PURCHASE_FAILED',
            message: errorData?.error?.message || `Label purchase failed (HTTP ${buyResponse.status})`,
            retryable: buyResponse.status >= 500,
          },
        };
      }

      const buyData = await buyResponse.json();
      const pdfUrl = buyData.postage_label?.label_pdf_url;
      const fallbackUrl = buyData.postage_label?.label_url || '';
      const labelUrl = pdfUrl || fallbackUrl;
      const urlLower = labelUrl.toLowerCase();
      const detectedFormat: 'pdf' | 'png' | 'zpl' | 'epl' =
        (urlLower.includes('.pdf') || urlLower.includes('/pdf') || urlLower.includes('format=pdf')) ? 'pdf' :
        (urlLower.includes('.png') || urlLower.includes('/png') || urlLower.includes('format=png')) ? 'png' :
        pdfUrl ? 'pdf' : 'png';
      const label: LabelArtifact = {
        id: `lbl-${Date.now()}`,
        format: detectedFormat,
        url: labelUrl,
        trackingNumber: buyData.tracking_code || '',
        carrier: buyData.selected_rate?.carrier || params.carrier,
        service: buyData.selected_rate?.service || params.service,
        purchasedAt: new Date().toISOString(),
        providerLabelRef: buyData.postage_label?.id,
        providerShipmentRef: buyData.id,
        cost: parseFloat(buyData.selected_rate?.rate || '0'),
      };

      return { success: true, label, providerShipmentId: buyData.id };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getTracking(params: GetTrackingRequest): Promise<GetTrackingResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch('https://api.easypost.com/v2/trackers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tracker: {
            tracking_code: params.trackingNumber,
            carrier: params.carrier,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'TRACKING_FAILED',
            message: errorData?.error?.message || `Tracking retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const events: ProviderTrackingEvent[] = (data.tracking_details || []).map(
        (td: Record<string, unknown>, idx: number) => ({
          id: `pte-${idx}-${Date.now()}`,
          timestamp: (td.datetime as string) || new Date().toISOString(),
          status: (td.status as string) || 'unknown',
          statusDetail: td.status_detail as string | undefined,
          location: td.tracking_location
            ? `${(td.tracking_location as Record<string, string>).city || ''}, ${(td.tracking_location as Record<string, string>).state || ''}`
            : undefined,
          description: (td.message as string) || (td.description as string) || '',
          source: 'provider' as const,
        })
      );

      return {
        success: true,
        status: data.status || undefined,
        estimatedDelivery: data.est_delivery_date || undefined,
        events,
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Pickup booking — REAL EasyPost /v2/pickups + /buy + /cancel calls.
  // EasyPost requires a shipment id (since the pickup is bound to specific labels)
  // and the request returns rate options that must be purchased via /buy before
  // the carrier is actually dispatched. createPickup returns rates; the caller
  // selects one (or auto-buys the cheapest) via buyPickup.
  // ---------------------------------------------------------------------------
  async createPickup(params: CreatePickupRequest): Promise<CreatePickupResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };
    const shipmentId = params.providerShipmentId || (params.providerShipmentIds && params.providerShipmentIds[0]);
    if (!shipmentId) {
      return { success: false, error: { code: 'MISSING_SHIPMENT_REF', message: 'EasyPost pickup requires a provider shipment id (set when label was purchased).', retryable: false } };
    }
    try {
      const response = await fetch('https://api.easypost.com/v2/pickups', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup: {
            address: mapAddressToEasyPost(params.pickupAddress),
            shipment: { id: shipmentId },
            min_datetime: params.minDatetime,
            max_datetime: params.maxDatetime,
            instructions: params.instructions || undefined,
            is_account_address: params.isAccountAddress ?? true,
          },
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: { code: 'PICKUP_CREATE_FAILED', message: errorData?.error?.message || `Pickup create failed (HTTP ${response.status})`, retryable: response.status >= 500 } };
      }
      const data = await response.json();
      const rates = (data.pickup_rates || []).map((r: Record<string, unknown>, i: number) => ({
        id: `pkrate-${i}`,
        providerRateId: r.id as string,
        carrier: (r.carrier as string) || 'Unknown',
        service: (r.service as string) || 'Standard',
        rate: parseFloat(r.rate as string) || 0,
        currency: (r.currency as string) || 'USD',
      }));
      return { success: true, providerPickupId: data.id, status: data.status, rates };
    } catch (err) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`, retryable: true } };
    }
  }

  async buyPickup(params: BuyPickupRequest): Promise<BuyPickupResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };
    try {
      // EasyPost wants carrier+service from the chosen pickup_rate. We resolve
      // via a GET on the pickup, find the matching rate, then POST /buy.
      const pickupResp = await fetch(`https://api.easypost.com/v2/pickups/${params.providerPickupId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!pickupResp.ok) {
        const errorData = await pickupResp.json().catch(() => ({}));
        return { success: false, error: { code: 'PICKUP_LOOKUP_FAILED', message: errorData?.error?.message || `Pickup lookup failed (HTTP ${pickupResp.status})`, retryable: pickupResp.status >= 500 } };
      }
      const pickupData = await pickupResp.json();
      const rate = (pickupData.pickup_rates || []).find((r: Record<string, unknown>) => r.id === params.providerRateId);
      if (!rate) {
        return { success: false, error: { code: 'RATE_NOT_FOUND', message: 'Selected pickup rate not found on this pickup.', retryable: false } };
      }
      const buyResp = await fetch(`https://api.easypost.com/v2/pickups/${params.providerPickupId}/buy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrier: rate.carrier, service: rate.service }),
      });
      if (!buyResp.ok) {
        const errorData = await buyResp.json().catch(() => ({}));
        return { success: false, error: { code: 'PICKUP_BUY_FAILED', message: errorData?.error?.message || `Pickup buy failed (HTTP ${buyResp.status})`, retryable: buyResp.status >= 500 } };
      }
      const data = await buyResp.json();
      return {
        success: true,
        providerPickupId: data.id,
        confirmationNumber: data.confirmation,
        status: data.status,
        cost: parseFloat(rate.rate as string) || undefined,
        currency: (rate.currency as string) || 'USD',
      };
    } catch (err) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`, retryable: true } };
    }
  }

  async cancelPickup(params: CancelPickupRequest): Promise<CancelPickupResponse> {
    const apiKey = getApiKey();
    if (!apiKey) return { success: false, error: NO_CREDENTIALS_ERROR };
    try {
      const response = await fetch(`https://api.easypost.com/v2/pickups/${params.providerPickupId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: { code: 'PICKUP_CANCEL_FAILED', message: errorData?.error?.message || `Pickup cancel failed (HTTP ${response.status})`, retryable: response.status >= 500 } };
      }
      const data = await response.json();
      return { success: true, providerPickupId: data.id, status: data.status };
    } catch (err) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`, retryable: true } };
    }
  }
}
