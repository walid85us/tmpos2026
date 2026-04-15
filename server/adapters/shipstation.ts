import type {
  ShippingProviderAdapter,
  AddressValidationResponse,
  GetRatesRequest,
  GetRatesResponse,
  PurchaseLabelRequest,
  PurchaseLabelResponse,
  GetTrackingRequest,
  GetTrackingResponse,
  ShipmentAddress,
  ShippingRate,
  LabelArtifact,
  ProviderTrackingEvent,
  ProviderError,
} from '../types';
import { getCredentials } from '../credential-store';

const NO_CREDENTIALS_ERROR: ProviderError = {
  code: 'PROVIDER_NOT_CONFIGURED',
  message: 'ShipStation API credentials are not configured. Configure your shipping provider in Shipping Center.',
  retryable: false,
};

function getAuthHeader(): string | null {
  const creds = getCredentials('shipstation');
  if (!creds?.apiKey || !creds?.apiSecret) return null;
  return 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
}

function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  if (digits.length === 10) return '1' + digits;
  return digits;
}

function mapAddressToShipStation(addr: ShipmentAddress) {
  return {
    name: addr.name,
    company: addr.company || null,
    street1: addr.line1,
    street2: addr.line2 || null,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: addr.country,
    phone: normalizePhone(addr.phone),
  };
}

export class ShipStationAdapter implements ShippingProviderAdapter {
  readonly providerId = 'shipstation';
  readonly providerName = 'ShipStation';

  async validateAddress(address: ShipmentAddress): Promise<AddressValidationResponse> {
    const auth = getAuthHeader();
    if (!auth) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch('https://ssapi.shipstation.com/addresses/validate', {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mapAddressToShipStation(address)),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: errorData?.ExceptionMessage || `Address validation failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const results = Array.isArray(data) ? data : [data];
      const match = results[0];
      const isValid = match && !match.errors?.length;
      const messages = match?.errors?.map((e: { message: string }) => e.message) || [];

      return {
        success: true,
        result: {
          status: isValid ? 'validated' : 'failed',
          validatedAt: new Date().toISOString(),
          originalAddress: address,
          messages,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to ShipStation: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getRates(params: GetRatesRequest): Promise<GetRatesResponse> {
    const auth = getAuthHeader();
    if (!auth) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const response = await fetch('https://ssapi.shipstation.com/shipments/getrates', {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          carrierCode: '',
          fromPostalCode: params.originAddress.postalCode,
          toState: params.destinationAddress.state,
          toCountry: params.destinationAddress.country,
          toPostalCode: params.destinationAddress.postalCode,
          toCity: params.destinationAddress.city,
          weight: {
            value: parcel?.weight || 1,
            units: parcel?.weightUnit === 'kg' ? 'kilograms' : 'pounds',
          },
          dimensions: {
            length: parcel?.length || 10,
            width: parcel?.width || 8,
            height: parcel?.height || 4,
            units: parcel?.dimensionUnit === 'cm' ? 'centimetres' : 'inches',
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'RATES_FAILED',
            message: errorData?.ExceptionMessage || `Rate retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const ratesArray = Array.isArray(data) ? data : [];
      const rates: ShippingRate[] = ratesArray.map((r: Record<string, unknown>, idx: number) => ({
        id: `rate-${idx}-${Date.now()}`,
        providerId: 'shipstation',
        carrier: (r.carrierCode as string) || 'Unknown',
        serviceName: (r.serviceName as string) || 'Standard',
        serviceCode: (r.serviceCode as string) || '',
        rate: typeof r.shipmentCost === 'number' ? r.shipmentCost : parseFloat(r.shipmentCost as string) || 0,
        currency: 'USD',
        estimatedDays: undefined,
        providerRateRef: `${r.carrierCode}-${r.serviceCode}`,
      }));

      return { success: true, rates };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to ShipStation: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async purchaseLabel(params: PurchaseLabelRequest): Promise<PurchaseLabelResponse> {
    const auth = getAuthHeader();
    if (!auth) return { success: false, error: NO_CREDENTIALS_ERROR };

    const parcel = params.packages[0];
    try {
      const response = await fetch('https://ssapi.shipstation.com/orders/createlabelfororder', {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          carrierCode: params.carrier,
          serviceCode: params.service,
          packageCode: 'package',
          shipFrom: mapAddressToShipStation(params.originAddress),
          shipTo: mapAddressToShipStation(params.destinationAddress),
          weight: {
            value: parcel?.weight || 1,
            units: parcel?.weightUnit === 'kg' ? 'kilograms' : 'pounds',
          },
          dimensions: {
            length: parcel?.length || 10,
            width: parcel?.width || 8,
            height: parcel?.height || 4,
            units: parcel?.dimensionUnit === 'cm' ? 'centimetres' : 'inches',
          },
          testLabel: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'LABEL_PURCHASE_FAILED',
            message: errorData?.ExceptionMessage || `Label purchase failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const label: LabelArtifact = {
        id: `lbl-${Date.now()}`,
        format: 'pdf',
        url: data.labelData ? `data:application/pdf;base64,${data.labelData}` : '',
        trackingNumber: data.trackingNumber || '',
        carrier: params.carrier,
        service: params.service,
        purchasedAt: new Date().toISOString(),
        providerLabelRef: String(data.labelId || ''),
        providerShipmentRef: String(data.shipmentId || ''),
        cost: typeof data.shipmentCost === 'number' ? data.shipmentCost : parseFloat(data.shipmentCost || '0'),
      };

      return { success: true, label, providerShipmentId: String(data.shipmentId || '') };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to ShipStation: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }

  async getTracking(params: GetTrackingRequest): Promise<GetTrackingResponse> {
    const auth = getAuthHeader();
    if (!auth) return { success: false, error: NO_CREDENTIALS_ERROR };

    try {
      const response = await fetch(
        `https://ssapi.shipstation.com/shipments?trackingNumber=${encodeURIComponent(params.trackingNumber)}`,
        {
          headers: { 'Authorization': auth },
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: 'TRACKING_FAILED',
            message: errorData?.ExceptionMessage || `Tracking retrieval failed (HTTP ${response.status})`,
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json();
      const shipment = data.shipments?.[0];

      if (!shipment) {
        return {
          success: false,
          error: {
            code: 'TRACKING_NOT_FOUND',
            message: `No shipment found for tracking number "${params.trackingNumber}".`,
            retryable: false,
          },
        };
      }

      const events: ProviderTrackingEvent[] = [];
      if (shipment.shipDate) {
        events.push({
          id: `pte-shipped-${Date.now()}`,
          timestamp: shipment.shipDate,
          status: 'shipped',
          description: 'Shipment created',
          source: 'provider' as const,
        });
      }
      if (shipment.voided) {
        events.push({
          id: `pte-voided-${Date.now()}`,
          timestamp: shipment.voidDate || new Date().toISOString(),
          status: 'voided',
          description: 'Label voided',
          source: 'provider' as const,
        });
      }

      return {
        success: true,
        status: shipment.voided ? 'voided' : 'in_transit',
        events,
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Failed to connect to ShipStation: ${err instanceof Error ? err.message : 'Unknown error'}`,
          retryable: true,
        },
      };
    }
  }
}
