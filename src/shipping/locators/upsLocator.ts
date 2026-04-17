// UPS Locator adapter scaffolding.
// Live endpoint (when wired): https://onlinetools.ups.com/api/locations/v2/search/availabilities/{Locale}
// Auth: OAuth2 client credentials (UPS_CLIENT_ID + UPS_CLIENT_SECRET).
// Returns UPS Access Points, UPS Stores, drop boxes, customer counters.
import type { LocatorAdapter, LocatorQuery, LocatorResult } from './types';

export const upsLocator: LocatorAdapter = {
  carrierId: 'ups',
  carrierLabel: 'UPS Locator',
  isConfigured() {
    return false;
  },
  async findServicePoints(_query: LocatorQuery): Promise<LocatorResult> {
    return {
      ok: false,
      unavailable: true,
      reason: 'UPS Locator adapter is not yet wired. No live carrier credentials configured.',
      configHint: 'Set UPS_CLIENT_ID and UPS_CLIENT_SECRET. Configure under Shipping Center → Settings → Carrier Locators.',
    };
  },
};
