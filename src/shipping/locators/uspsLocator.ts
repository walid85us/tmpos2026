// USPS Locations adapter scaffolding.
// Live endpoint (when wired): https://api.usps.com/locations/v3/locations
// Auth: USPS_USER_ID + OAuth2 client credentials.
// Returns post offices, contract postal units, and gopost parcel lockers.
import type { LocatorAdapter, LocatorQuery, LocatorResult } from './types';

export const uspsLocator: LocatorAdapter = {
  carrierId: 'usps',
  carrierLabel: 'USPS Locations',
  isConfigured() {
    return false;
  },
  async findServicePoints(_query: LocatorQuery): Promise<LocatorResult> {
    return {
      ok: false,
      unavailable: true,
      reason: 'USPS Locations adapter is not yet wired. No live carrier credentials configured.',
      configHint: 'Set USPS_USER_ID and grant the Locations API scope. Configure under Shipping Center → Settings → Carrier Locators.',
    };
  },
};
