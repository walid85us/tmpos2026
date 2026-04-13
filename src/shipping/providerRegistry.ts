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

export async function getActiveProviderId(): Promise<string | null> {
  try {
    const response = await fetch('/api/shipping/active-provider');
    const data = await response.json();
    return data.activeProviderId || null;
  } catch {
    return null;
  }
}
