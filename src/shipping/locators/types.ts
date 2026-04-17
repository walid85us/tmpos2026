// Locator adapter contract. Each carrier exposes its own service-point locator API
// with a wildly different shape; adapters normalize them to the app's ServicePoint.
//
// IMPORTANT: This is a scaffolding file. No adapter is wired to a live API yet.
// All adapters in this directory return { unavailable: true } until credentials
// are configured under Settings → Carrier Locators.
import type { ServicePoint } from '../../types';

export interface LocatorQuery {
  postalCode: string;
  countryCode?: string;          // defaults to 'US'
  serviceCode?: string;          // optional carrier service filter (e.g. 'Ground')
  weightLb?: number;             // optional weight filter (some locators reject if too heavy)
  dimensionsIn?: { length?: number; width?: number; height?: number };
  radiusKm?: number;             // optional search radius
  limit?: number;                // optional cap on results
}

export type LocatorResult =
  | { ok: true; servicePoints: ServicePoint[]; cachedAt: string; ttlSeconds: number }
  | { ok: false; unavailable: true; reason: string; configHint?: string }
  | { ok: false; unavailable: false; reason: string; retryable?: boolean };

export interface LocatorAdapter {
  carrierId: 'usps' | 'ups' | 'fedex';
  carrierLabel: string;
  isConfigured(): boolean;
  findServicePoints(query: LocatorQuery): Promise<LocatorResult>;
}
