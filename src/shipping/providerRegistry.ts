import type { ShippingProviderAdapter } from './types';
import { EasyPostAdapter } from './adapters/easypost';

const adapters: Record<string, () => ShippingProviderAdapter> = {
  easypost: () => new EasyPostAdapter(),
};

export function getProvider(providerId: string): ShippingProviderAdapter | null {
  const factory = adapters[providerId];
  return factory ? factory() : null;
}

export function getAvailableProviders(): { id: string; name: string }[] {
  return [
    { id: 'easypost', name: 'EasyPost' },
  ];
}

export function getDefaultProviderId(): string {
  return 'easypost';
}
