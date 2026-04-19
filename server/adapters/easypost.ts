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
  ProviderFieldError,
} from '../types';
import { getCredentials } from '../credential-store';

// EasyPost API error responses look like:
//   { error: { code: "PICKUP.INVALID", message: "...", errors: [{ field, message }] } }
// The top-level `message` is often a generic wrapper ("The request was
// well-formed but was unable to be followed due to semantic errors.") while
// the *actual* validation failures live in the nested `errors[]` array. We
// extract both so the operator sees the real cause instead of the wrapper.
function extractEasyPostError(
  errorData: unknown,
  httpStatus: number,
  stage: string,
  fallbackCode: string,
): ProviderError {
  const root = (errorData as { error?: Record<string, unknown> } | undefined)?.error;
  const providerCode = (root?.code as string | undefined) || undefined;
  const providerMessage = (root?.message as string | undefined) || undefined;
  const nested = Array.isArray(root?.errors) ? (root!.errors as unknown[]) : [];
  const fieldErrors: ProviderFieldError[] = [];
  for (const e of nested) {
    const obj = e as Record<string, unknown>;
    const field = (obj.field as string | undefined) || undefined;
    const message = (obj.message as string | undefined) || (obj.error as string | undefined) || '';
    const code = (obj.code as string | undefined) || undefined;
    const suggestion = (obj.suggestion as string | undefined) || undefined;
    if (!message && !field) continue;
    fieldErrors.push({ field, message: message || `Invalid ${field || 'value'}`, code, suggestion });
  }

  // Build the operator-facing summary line. Prefer the most specific signal:
  // 1. The first field-level error if present (most actionable)
  // 2. The provider's top-level message
  // 3. A generic HTTP fallback
  let summary: string;
  if (fieldErrors.length > 0) {
    const first = fieldErrors[0];
    summary = first.field ? `${first.field}: ${first.message}` : first.message;
    if (fieldErrors.length > 1) summary += ` (+${fieldErrors.length - 1} more)`;
  } else if (providerMessage) {
    summary = providerMessage;
  } else {
    summary = `${stage} failed (HTTP ${httpStatus})`;
  }

  // Compact human-readable details bundle (newline-separated) so the UI can
  // show a "Show details" toggle without having to render JSON.
  const detailLines: string[] = [];
  if (providerCode) detailLines.push(`EasyPost code: ${providerCode}`);
  if (providerMessage && providerMessage !== summary) detailLines.push(`EasyPost message: ${providerMessage}`);
  for (const fe of fieldErrors) {
    detailLines.push(`• ${fe.field ? fe.field + ': ' : ''}${fe.message}`);
  }
  detailLines.push(`HTTP ${httpStatus} · stage=${stage}`);

  console.warn(`[EasyPost ${stage}] HTTP ${httpStatus} providerCode=${providerCode || '(none)'} providerMessage=${JSON.stringify(providerMessage)} fieldErrors=${fieldErrors.length}`);
  if (fieldErrors.length > 0) console.warn(`[EasyPost ${stage}] field errors:`, fieldErrors);

  return {
    code: providerCode || fallbackCode,
    message: summary,
    details: detailLines.join('\n'),
    retryable: httpStatus >= 500,
    httpStatus,
    stage,
    providerCode,
    providerMessage,
    fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
  };
}

const NO_CREDENTIALS_ERROR: ProviderError = {
  code: 'PROVIDER_NOT_CONFIGURED',
  message: 'EasyPost API key is not configured. Configure your shipping provider in Shipping Center.',
  retryable: false,
};

function getApiKey(): string | null {
  const creds = getCredentials('easypost');
  return creds?.apiKey || null;
}

// Phase 2.6.1 — phone normalization is digits-only and STRIPS a leading
// US country code, never prepends one. Previously this function prepended
// a "1" to a 10-digit US number, mutating the operator-entered phone into
// an 11-digit value. EasyPost echoed the mutated value back in the
// address-verify response and the client merged it into the form, leaving
// the operator with an invalid-looking phone that some downstream USPS
// schema validations rejected. The honest behavior is to canonicalize to
// the 10-digit national format for US numbers and pass through anything
// else the operator typed.
function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return undefined;
  // 11-digit US E.164-without-plus → strip the country code and return the
  // 10-digit national number.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  // 10-digit US national number → return as-is. Do NOT prepend "1".
  if (digits.length === 10) return digits;
  // Longer (likely international) → pass through untouched. We do not
  // assume a country code.
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

// Phase 2.6.1 — only address-shape fields are echoed back from the
// verification response. Contact fields (name, company, phone, email) are
// intentionally OMITTED here because the verify endpoint round-trips
// whatever we sent (including the server-normalized phone) and the client
// would otherwise overwrite the operator-entered values when accepting a
// "corrected" address. Contact fields stay under operator control on the
// client side; address normalization is the only legitimate output of
// this function.
function mapEasyPostToAddress(ep: Record<string, string>): ShipmentAddress {
  return {
    name: '',
    line1: ep.street1 || '',
    line2: ep.street2 || undefined,
    city: ep.city || '',
    state: ep.state || '',
    postalCode: ep.zip || '',
    country: ep.country || 'US',
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
      const deliverySuccess = verifications?.success === true;
      // EasyPost can return delivery success === true while STILL flagging
      // warnings (DPV codes for missing secondary info, etc.) in
      // verifications.delivery.errors. Those addresses are deliverable but
      // are NOT acceptable for USPS pickup_create — the carrier rejects
      // them with code 1007. We must not present them as fully verified.
      const errors: { code?: string; message: string; field?: string }[] = (verifications?.errors || []).map((e: { code?: string; message?: string; field?: string }) => ({
        code: e.code,
        message: e.message || 'Carrier returned an unspecified address warning.',
        field: e.field,
      }));
      const hasWarnings = errors.length > 0;
      const details: Record<string, unknown> = (verifications?.details && typeof verifications.details === 'object') ? verifications.details : {};
      // Strict pickup-readiness gate: USPS DPV match code must be 'Y' for the
      // address to be reliably acceptable for pickup_create. D / S / N (or any
      // other code) means a secondary unit is missing or the address could
      // not be fully confirmed — pickup_create will reject it. We only treat
      // 'Y' (and missing-but-success-with-no-warnings as best-effort) as
      // pickup-ready.
      const dpvMatch = typeof details.dpv_match_code === 'string' ? details.dpv_match_code : undefined;
      const dpvProblematic = dpvMatch != null && dpvMatch !== 'Y';
      const suggested = data.address ? mapEasyPostToAddress(data.address) : undefined;
      const addressChanged = !!suggested && (
        (suggested.line1 || '').trim().toUpperCase() !== (address.line1 || '').trim().toUpperCase() ||
        (suggested.line2 || '').trim().toUpperCase() !== (address.line2 || '').trim().toUpperCase() ||
        (suggested.city || '').trim().toUpperCase() !== (address.city || '').trim().toUpperCase() ||
        (suggested.state || '').trim().toUpperCase() !== (address.state || '').trim().toUpperCase() ||
        (suggested.postalCode || '').trim() !== (address.postalCode || '').trim()
      );
      // Status logic — truthful for pickup readiness, not just delivery:
      //   failed:   delivery itself failed                     -> not deliverable, definitely not pickup-ready
      //   failed:   delivery success BUT DPV warnings present  -> deliverable but pickup_create will reject
      //   corrected: delivery success, no warnings, but EasyPost normalized the address
      //   validated: delivery success, no warnings, no normalization difference -> pickup-ready
      let status: 'validated' | 'corrected' | 'failed';
      if (!deliverySuccess) status = 'failed';
      else if (hasWarnings || dpvProblematic) status = 'failed';
      else if (addressChanged) status = 'corrected';
      else status = 'validated';
      // Compose operator-facing messages. On failed-with-warnings we surface
      // the verbatim carrier messages plus a precise pickup-specific hint so
      // the operator knows why a "deliverable" address still won't book.
      const messages: string[] = errors.map(e => e.message);
      if (deliverySuccess && (hasWarnings || dpvProblematic)) {
        if (dpvMatch === 'D') messages.push('USPS DPV: address requires a secondary unit number (apartment / suite / unit). Add it to line 2 and re-verify.');
        else if (dpvMatch === 'S') messages.push('USPS DPV: secondary unit number is present but could not be confirmed. Verify the apartment/suite is correct and re-verify.');
        else if (dpvMatch === 'N') messages.push('USPS DPV: address could not be confirmed. The street number/name may be incorrect for this ZIP. Re-check and re-verify.');
        else if (dpvMatch && dpvMatch !== 'Y') messages.push(`USPS DPV match code "${dpvMatch}" — address is deliverable but not pickup-eligible. Re-check the address and re-verify.`);
        else messages.push('Carrier returned address warnings. Address is deliverable but pickup may be rejected. Resolve warnings before booking.');
      }
      return {
        success: true,
        result: {
          status,
          validatedAt: new Date().toISOString(),
          originalAddress: address,
          suggestedAddress: addressChanged ? suggested : undefined,
          messages,
          providerRef: data.address?.id,
          details,
          warnings: errors,
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
    // Phase 2.6 — is_account_address default flipped to FALSE.
    // Previously this defaulted to true, which told USPS "validate this
    // pickup address against my saved shipper-of-record list". For the
    // overwhelmingly common case (a normal store address that is NOT
    // registered with USPS as a shipper-of-record under this EasyPost
    // account) USPS rejects with code 1007 / Invalid address entered even
    // when the address passes DPV deliverability. The honest default is
    // FALSE: USPS validates the pickup address freshly. Operators with
    // a truly registered shipper-of-record address can opt in via the
    // per-store credential setting `uspsOriginIsShipperOfRecord` or by
    // explicitly passing isAccountAddress=true on the request.
    const creds = getCredentials('easypost');
    const accountAddrDefault = creds?.uspsOriginIsShipperOfRecord === true;
    const isAccountAddress = params.isAccountAddress ?? accountAddrDefault;
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
            is_account_address: isAccountAddress,
          },
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: extractEasyPostError(errorData, response.status, 'pickup_create', 'PICKUP_CREATE_FAILED') };
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
        return { success: false, error: extractEasyPostError(errorData, pickupResp.status, 'pickup_lookup', 'PICKUP_LOOKUP_FAILED') };
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
        return { success: false, error: extractEasyPostError(errorData, buyResp.status, 'pickup_buy', 'PICKUP_BUY_FAILED') };
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
        return { success: false, error: extractEasyPostError(errorData, response.status, 'pickup_cancel', 'PICKUP_CANCEL_FAILED') };
      }
      const data = await response.json();
      return { success: true, providerPickupId: data.id, status: data.status };
    } catch (err) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: `Failed to connect to EasyPost: ${err instanceof Error ? err.message : 'Unknown error'}`, retryable: true } };
    }
  }
}
