import type { ShippingProviderCredentials } from './types';

interface ProviderState {
  credentials: ShippingProviderCredentials;
  environment: 'test' | 'production';
  configuredAt: string;
  updatedAt: string;
  lastTestedAt?: string;
  lastTestResult?: 'success' | 'failed';
}

const providerStore = new Map<string, ProviderState>();
let activeProviderId: string | null = null;

export function storeCredentials(
  providerId: string,
  credentials: ShippingProviderCredentials,
  environment: 'test' | 'production'
): void {
  const existing = providerStore.get(providerId);
  const mergedCredentials: ShippingProviderCredentials = existing
    ? { ...existing.credentials }
    : {};
  if (credentials.apiKey) mergedCredentials.apiKey = credentials.apiKey;
  if (credentials.apiSecret) mergedCredentials.apiSecret = credentials.apiSecret;
  if (credentials.accountId) mergedCredentials.accountId = credentials.accountId;
  if (typeof credentials.uspsOriginIsShipperOfRecord === 'boolean') {
    mergedCredentials.uspsOriginIsShipperOfRecord = credentials.uspsOriginIsShipperOfRecord;
  }
  providerStore.set(providerId, {
    credentials: mergedCredentials,
    environment,
    configuredAt: existing?.configuredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export function getCredentials(providerId: string): ShippingProviderCredentials | null {
  const state = providerStore.get(providerId);
  return state?.credentials || null;
}

export function getProviderEnvironment(providerId: string): 'test' | 'production' | null {
  const state = providerStore.get(providerId);
  return state?.environment || null;
}

export function removeCredentials(providerId: string): void {
  providerStore.delete(providerId);
  if (activeProviderId === providerId) {
    activeProviderId = null;
  }
}

export function hasCredentials(providerId: string): boolean {
  const state = providerStore.get(providerId);
  if (!state) return false;
  const creds = state.credentials;
  return !!(creds.apiKey || creds.apiSecret || creds.accountId);
}

export function setActiveProvider(providerId: string | null): void {
  if (providerId && !providerStore.has(providerId)) {
    throw new Error(`Provider "${providerId}" has no stored credentials.`);
  }
  activeProviderId = providerId;
}

export function getActiveProvider(): string | null {
  return activeProviderId;
}

export function getConfiguredProviders(): string[] {
  return Array.from(providerStore.keys());
}

export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

export function getMaskedCredentials(providerId: string): Record<string, string> | null {
  const state = providerStore.get(providerId);
  if (!state) return null;
  const c = state.credentials;
  return {
    apiKey: maskSecret(c.apiKey),
    apiSecret: maskSecret(c.apiSecret),
    accountId: maskSecret(c.accountId),
  };
}

export function setTestResult(providerId: string, result: 'success' | 'failed'): void {
  const state = providerStore.get(providerId);
  if (state) {
    state.lastTestedAt = new Date().toISOString();
    state.lastTestResult = result;
  }
}

export function getProviderInfo(providerId: string) {
  const state = providerStore.get(providerId);
  if (!state) return null;
  return {
    environment: state.environment,
    configuredAt: state.configuredAt,
    updatedAt: state.updatedAt,
    lastTestedAt: state.lastTestedAt || null,
    lastTestResult: state.lastTestResult || null,
    maskedCredentials: getMaskedCredentials(providerId),
  };
}
