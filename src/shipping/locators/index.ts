// Locator dispatcher. Routes findServicePoints({ carrier, ... }) to the right
// carrier-specific adapter. While no adapter is configured, every call returns
// { unavailable: true } and the UI falls back to manual entry.
import type { LocatorAdapter, LocatorQuery, LocatorResult } from './types';
import { uspsLocator } from './uspsLocator';
import { upsLocator } from './upsLocator';
import { fedexLocator } from './fedexLocator';

const ADAPTERS: Record<string, LocatorAdapter> = {
  USPS: uspsLocator,
  UPS: upsLocator,
  FEDEX: fedexLocator,
};

export interface DispatcherQuery extends LocatorQuery {
  carrier: string; // 'USPS' | 'UPS' | 'FedEx' (case-insensitive)
}

export async function findServicePoints(query: DispatcherQuery): Promise<LocatorResult> {
  const key = (query.carrier || '').trim().toUpperCase();
  const adapter = ADAPTERS[key];
  if (!adapter) {
    return {
      ok: false,
      unavailable: true,
      reason: `No service-point locator adapter is registered for carrier "${query.carrier}". Supported carriers: USPS, UPS, FedEx.`,
    };
  }
  if (!adapter.isConfigured()) {
    return {
      ok: false,
      unavailable: true,
      reason: `${adapter.carrierLabel} is not configured.`,
      configHint: `Configure under Shipping Center → Settings → Carrier Locators.`,
    };
  }
  return adapter.findServicePoints(query);
}

export function isAnyLocatorConfigured(): boolean {
  return Object.values(ADAPTERS).some(a => a.isConfigured());
}

export function getConfiguredCarriers(): string[] {
  return Object.entries(ADAPTERS)
    .filter(([_, a]) => a.isConfigured())
    .map(([k]) => k);
}

export type { LocatorAdapter, LocatorQuery, LocatorResult } from './types';
