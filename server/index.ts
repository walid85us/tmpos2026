import express from 'express';
import {
  storeCredentials,
  removeCredentials,
  hasCredentials,
  setActiveProvider,
  getActiveProvider,
  getConfiguredProviders,
  getMaskedCredentials,
  getProviderInfo,
} from './credential-store';
import { EasyPostAdapter } from './adapters/easypost';
import { ShippoAdapter } from './adapters/shippo';
import { ShipStationAdapter } from './adapters/shipstation';
import type { ShippingProviderAdapter } from './types';

const app = express();
app.use(express.json({ limit: '1mb' }));

const adapters: Record<string, () => ShippingProviderAdapter> = {
  easypost: () => new EasyPostAdapter(),
  shippo: () => new ShippoAdapter(),
  shipstation: () => new ShipStationAdapter(),
};

function resolveProvider(providerId?: string): ShippingProviderAdapter | null {
  const id = providerId || getActiveProvider();
  if (!id) return null;
  const factory = adapters[id];
  return factory ? factory() : null;
}

app.post('/api/shipping/credentials', (req, res) => {
  const { providerId, credentials, environment } = req.body;
  if (!providerId || !credentials) {
    res.status(400).json({ error: 'providerId and credentials are required.' });
    return;
  }
  storeCredentials(providerId, credentials, environment || 'test');
  const masked = getMaskedCredentials(providerId);
  res.json({ success: true, maskedCredentials: masked });
});

app.delete('/api/shipping/credentials/:providerId', (req, res) => {
  const { providerId } = req.params;
  removeCredentials(providerId);
  res.json({ success: true });
});

app.post('/api/shipping/active-provider', (req, res) => {
  const { providerId } = req.body;
  try {
    setActiveProvider(providerId || null);
    res.json({ success: true, activeProviderId: providerId || null });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to set active provider.' });
  }
});

app.get('/api/shipping/active-provider', (_req, res) => {
  res.json({ activeProviderId: getActiveProvider() });
});

app.get('/api/shipping/providers-status', (_req, res) => {
  const configured = getConfiguredProviders();
  const activeId = getActiveProvider();
  const providers = configured
    .filter(id => hasCredentials(id))
    .map(id => ({
      providerId: id,
      isActive: id === activeId,
      ...getProviderInfo(id),
    }));
  res.json({ providers, activeProviderId: activeId });
});

app.post('/api/shipping/test-connection', async (req, res) => {
  const { providerId } = req.body;
  if (!providerId) {
    res.status(400).json({ success: false, error: { code: 'MISSING_PROVIDER', message: 'Provider ID is required.' } });
    return;
  }
  if (!hasCredentials(providerId)) {
    res.json({ success: false, error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'No credentials stored for this provider. Save credentials first.' } });
    return;
  }
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'UNKNOWN_PROVIDER', message: `Provider "${providerId}" is not supported.` } });
    return;
  }
  const testAddress = {
    name: 'Test User',
    line1: '1600 Pennsylvania Ave NW',
    city: 'Washington',
    state: 'DC',
    postalCode: '20500',
    country: 'US',
  };
  const result = await provider.validateAddress(testAddress);
  if (result.success) {
    res.json({ success: true, message: `Connection to ${provider.providerName} verified successfully.` });
  } else {
    res.json({ success: false, error: result.error });
  }
});

app.post('/api/shipping/validate-address', async (req, res) => {
  const { providerId, address } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Settings.' } });
    return;
  }
  const result = await provider.validateAddress(address);
  res.json(result);
});

app.post('/api/shipping/rates', async (req, res) => {
  const { providerId, originAddress, destinationAddress, packages } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Settings.' } });
    return;
  }
  const result = await provider.getRates({ originAddress, destinationAddress, packages });
  res.json(result);
});

app.post('/api/shipping/purchase-label', async (req, res) => {
  const { providerId, originAddress, destinationAddress, packages, selectedRateId, carrier, service, shipmentRef } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Settings.' } });
    return;
  }
  const result = await provider.purchaseLabel({ originAddress, destinationAddress, packages, selectedRateId, carrier, service, shipmentRef });
  res.json(result);
});

app.post('/api/shipping/tracking', async (req, res) => {
  const { providerId, trackingNumber, carrier, providerShipmentId } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Settings.' } });
    return;
  }
  const result = await provider.getTracking({ trackingNumber, carrier, providerShipmentId });
  res.json(result);
});

const PORT = parseInt(process.env.SHIPPING_API_PORT || '5001', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Shipping API] Server running on port ${PORT}`);
});

export default app;
