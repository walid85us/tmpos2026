// FedEx Locations adapter scaffolding.
// Live endpoint (when wired): https://apis.fedex.com/location/v1/locations/search/results
// Auth: OAuth2 client credentials (FEDEX_CLIENT_ID + FEDEX_CLIENT_SECRET).
// Returns FedEx Office, FedEx Ship Centers, Authorized ShipCenters, Drop Boxes.
import type { LocatorAdapter, LocatorQuery, LocatorResult } from './types';

export const fedexLocator: LocatorAdapter = {
  carrierId: 'fedex',
  carrierLabel: 'FedEx Locations',
  isConfigured() {
    return false;
  },
  async findServicePoints(_query: LocatorQuery): Promise<LocatorResult> {
    return {
      ok: false,
      unavailable: true,
      reason: 'FedEx Locations adapter is not yet wired. No live carrier credentials configured.',
      configHint: 'Set FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET. Configure under Shipping Center → Settings → Carrier Locators.',
    };
  },
};
