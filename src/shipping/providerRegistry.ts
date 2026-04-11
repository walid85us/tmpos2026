import type { ShippingProviderAdapter } from './types';
import { EasyPostAdapter } from './adapters/easypost';
import { ShippoAdapter } from './adapters/shippo';
import { ShipStationAdapter } from './adapters/shipstation';

const adapters: Record<string, () => ShippingProviderAdapter> = {
  easypost: () => new EasyPostAdapter(),
  shippo: () => new ShippoAdapter(),
  shipstation: () => new ShipStationAdapter(),
};

export function getProvider(providerId: string): ShippingProviderAdapter | null {
  const factory = adapters[providerId];
  return factory ? factory() : null;
}

export function getAvailableProviders(): { id: string; name: string; description: string; requiredFields: { key: string; label: string; type: 'text' | 'password'; placeholder: string }[] }[] {
  return [
    {
      id: 'easypost',
      name: 'EasyPost',
      description: 'Multi-carrier shipping API for address verification, rating, and label generation.',
      requiredFields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Enter your EasyPost API key' },
      ],
    },
    {
      id: 'shippo',
      name: 'Shippo',
      description: 'Shipping API for real-time rates, labels, and tracking across 85+ carriers.',
      requiredFields: [
        { key: 'apiKey', label: 'API Token', type: 'password', placeholder: 'Enter your Shippo API token' },
      ],
    },
    {
      id: 'shipstation',
      name: 'ShipStation',
      description: 'Multi-channel shipping platform for order management, labels, and carrier integrations.',
      requiredFields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Enter your ShipStation API key' },
        { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'Enter your ShipStation API secret' },
      ],
    },
  ];
}

export function getActiveProviderId(): string | null {
  try {
    const state = sessionStorage.getItem('shipping_providers_state');
    if (!state) return null;
    return JSON.parse(state).activeProviderId || null;
  } catch {
    return null;
  }
}
