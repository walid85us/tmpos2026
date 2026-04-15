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
  getProviderEnvironment,
  setTestResult,
} from './credential-store';
import { EasyPostAdapter } from './adapters/easypost';
import { ShippoAdapter } from './adapters/shippo';
import { ShipStationAdapter } from './adapters/shipstation';
import type { ShippingProviderAdapter } from './types';
import {
  recordWebhookEvent,
  getWebhookLog,
  getWebhookEventById,
  getWebhookLogStats,
  parseEasyPostWebhook,
  parseShippoWebhook,
  parseShipStationWebhook,
  mapProviderStatus,
  type WebhookEventRecord,
} from './event-processor';

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
  const id = getActiveProvider();
  const environment = id ? getProviderEnvironment(id) : null;
  res.json({ activeProviderId: id, environment });
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
    setTestResult(providerId, 'success');
    res.json({ success: true, message: `Connection to ${provider.providerName} verified successfully.` });
  } else {
    setTestResult(providerId, 'failed');
    res.json({ success: false, error: result.error });
  }
});

app.post('/api/shipping/validate-address', async (req, res) => {
  const { providerId, address } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Shipping Center.' } });
    return;
  }
  const result = await provider.validateAddress(address);
  res.json(result);
});

app.post('/api/shipping/rates', async (req, res) => {
  const { providerId, originAddress, destinationAddress, packages } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Shipping Center.' } });
    return;
  }
  const result = await provider.getRates({ originAddress, destinationAddress, packages });
  res.json(result);
});

app.get('/api/shipping/label-proxy', async (req, res) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: 'Missing url parameter' }); return; }
  try {
    const response = await fetch(url);
    if (!response.ok) { res.status(502).json({ error: `Upstream returned ${response.status}` }); return; }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch label from provider' });
  }
});

app.post('/api/shipping/purchase-label', async (req, res) => {
  const { providerId, originAddress, destinationAddress, packages, selectedRateId, carrier, service, shipmentRef } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Shipping Center.' } });
    return;
  }
  const result = await provider.purchaseLabel({ originAddress, destinationAddress, packages, selectedRateId, carrier, service, shipmentRef });
  res.json(result);
});

app.post('/api/shipping/tracking', async (req, res) => {
  const { providerId, trackingNumber, carrier, providerShipmentId } = req.body;
  const provider = resolveProvider(providerId);
  if (!provider) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active shipping provider. Configure a provider in Shipping Center.' } });
    return;
  }
  const result = await provider.getTracking({ trackingNumber, carrier, providerShipmentId });
  res.json(result);
});

app.post('/api/shipping/simulate-tracking-event', (req, res) => {
  const activeId = getActiveProvider();
  if (!activeId) {
    res.json({ success: false, error: { code: 'NO_PROVIDER', message: 'No active provider configured.' } });
    return;
  }
  const env = getProviderEnvironment(activeId);
  if (env !== 'test') {
    res.json({ success: false, error: { code: 'NOT_TEST_MODE', message: 'Simulated events are only available in test mode. Switch your provider to test credentials first.' } });
    return;
  }
  const { trackingNumber, carrier } = req.body;
  if (!trackingNumber) {
    res.status(400).json({ success: false, error: { code: 'MISSING_TRACKING', message: 'Tracking number is required.' } });
    return;
  }

  const testStatuses = [
    { status: 'pre_transit', description: 'Shipping label created, package not yet received by carrier' },
    { status: 'accepted', description: 'Package accepted by carrier facility' },
    { status: 'in_transit', description: 'Package in transit to destination' },
    { status: 'out_for_delivery', description: 'Package out for delivery' },
    { status: 'delivered', description: 'Package delivered to recipient' },
  ];
  const now = new Date();
  const events = testStatuses.map((s, i) => ({
    id: `test-evt-${Date.now()}-${i}`,
    providerEventRef: `test-sim-${trackingNumber}-${s.status}`,
    timestamp: new Date(now.getTime() - (testStatuses.length - 1 - i) * 3600000).toISOString(),
    status: s.status,
    description: `[TEST] ${s.description}`,
    location: ['Origin Facility', 'Regional Hub', 'Distribution Center', 'Local Post Office', 'Destination'][i],
    source: 'test_provider' as const,
  }));

  res.json({
    success: true,
    events,
    status: 'delivered',
    estimatedDelivery: new Date(now.getTime() + 86400000).toISOString(),
    carrier: carrier || 'TestCarrier',
    isSimulated: true,
  });
});

app.post('/api/shipping/webhook/:providerId', (req, res) => {
  const { providerId } = req.params;
  const knownProviders = ['easypost', 'shippo', 'shipstation'];
  if (!knownProviders.includes(providerId)) {
    res.status(400).json({ error: 'Unknown provider.' });
    return;
  }
  if (!hasCredentials(providerId)) {
    res.status(403).json({ error: 'Provider not configured.' });
    return;
  }

  const webhookSecret = process.env[`SHIPPING_WEBHOOK_SECRET_${providerId.toUpperCase()}`];
  let signatureVerified = false;
  if (webhookSecret) {
    const signatureHeader = (req.headers['x-webhook-signature'] || req.headers['x-shippo-signature'] || req.headers['x-easypost-signature'] || '') as string;
    if (!signatureHeader) {
      console.warn(`[Shipping API] Webhook from ${providerId} rejected: missing signature header.`);
      res.status(401).json({ error: 'Missing webhook signature.' });
      return;
    }
    const crypto = require('crypto');
    const expectedSig = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(req.body)).digest('hex');
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8'),
      Buffer.from(expectedSig, 'utf8')
    );
    if (!isValid) {
      console.warn(`[Shipping API] Webhook from ${providerId} rejected: invalid signature.`);
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }
    signatureVerified = true;
  }

  const env = getProviderEnvironment(providerId);
  const isTestMode = env === 'test';
  const receivedAt = new Date().toISOString();

  let parsed;
  try {
    if (providerId === 'easypost') parsed = parseEasyPostWebhook(req.body);
    else if (providerId === 'shippo') parsed = parseShippoWebhook(req.body);
    else parsed = parseShipStationWebhook(req.body);
  } catch (err) {
    const record: WebhookEventRecord = {
      id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      providerId,
      eventType: 'parse_error',
      rawPayload: req.body,
      receivedAt,
      processedAt: receivedAt,
      processingResult: 'failed',
      processingError: err instanceof Error ? err.message : 'Failed to parse webhook payload',
      source: 'webhook',
      isTestMode,
      signatureVerified,
      retryCount: 0,
    };
    recordWebhookEvent(record);
    res.json({ received: true, processingResult: 'failed' });
    return;
  }

  const record: WebhookEventRecord = {
    id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    providerId,
    providerEventId: parsed.providerEventId,
    eventType: parsed.eventType,
    trackingNumber: parsed.trackingNumber,
    rawPayload: req.body,
    receivedAt,
    processedAt: receivedAt,
    processingResult: parsed.events.length > 0 ? 'processed' : 'ignored',
    mappedStatus: parsed.overallStatus ? mapProviderStatus(parsed.overallStatus) : undefined,
    source: 'webhook',
    isTestMode,
    signatureVerified,
    retryCount: 0,
  };
  recordWebhookEvent(record);

  console.log(`[Shipping API] Webhook from ${providerId}: type=${parsed.eventType}, tracking=${parsed.trackingNumber || 'n/a'}, events=${parsed.events.length}, result=${record.processingResult}`);

  res.json({
    received: true,
    providerId,
    timestamp: receivedAt,
    processingResult: record.processingResult,
    eventsProcessed: parsed.events.length,
    webhookEventId: record.id,
  });
});

app.get('/api/shipping/webhook-log/stats', (_req, res) => {
  res.json(getWebhookLogStats());
});

app.get('/api/shipping/webhook-log', (_req, res) => {
  const providerId = _req.query.providerId as string | undefined;
  const trackingNumber = _req.query.trackingNumber as string | undefined;
  const processingResult = _req.query.processingResult as string | undefined;
  const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 100;
  const log = getWebhookLog({ providerId, trackingNumber, processingResult, limit });
  const redacted = log.map(({ rawPayload, ...rest }) => rest);
  res.json({
    events: redacted,
    total: redacted.length,
    filters: { providerId, trackingNumber, processingResult, limit },
  });
});

app.get('/api/shipping/webhook-log/:eventId', (req, res) => {
  const found = getWebhookEventById(req.params.eventId);
  if (!found) {
    res.status(404).json({ error: 'Webhook event not found.' });
    return;
  }
  const { rawPayload, ...event } = found;
  res.json({ event });
});

app.post('/api/shipping/replay-event', (req, res) => {
  const { webhookEventId } = req.body;
  if (!webhookEventId) {
    res.status(400).json({ success: false, error: { code: 'MISSING_ID', message: 'webhookEventId is required.' } });
    return;
  }
  const original = getWebhookEventById(webhookEventId);
  if (!original) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Original webhook event not found.' } });
    return;
  }

  let replayParsed;
  let replayResult: 'processed' | 'failed' = 'processed';
  let replayError: string | undefined;
  let replayMappedStatus: string | undefined;
  let eventsCount = 0;

  try {
    if (original.providerId === 'easypost') replayParsed = parseEasyPostWebhook(original.rawPayload);
    else if (original.providerId === 'shippo') replayParsed = parseShippoWebhook(original.rawPayload);
    else replayParsed = parseShipStationWebhook(original.rawPayload);

    eventsCount = replayParsed.events.length;
    replayMappedStatus = replayParsed.overallStatus ? mapProviderStatus(replayParsed.overallStatus) : original.mappedStatus;
  } catch (err) {
    replayResult = 'failed';
    replayError = err instanceof Error ? err.message : 'Replay parsing failed';
  }

  const replayRecord: WebhookEventRecord = {
    id: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    providerId: original.providerId,
    providerEventId: original.providerEventId,
    eventType: `replay:${original.eventType}`,
    trackingNumber: original.trackingNumber,
    shipmentRef: original.shipmentRef,
    rawPayload: original.rawPayload,
    receivedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    processingResult: replayResult,
    processingError: replayError,
    mappedStatus: replayMappedStatus,
    source: 'replay',
    isTestMode: original.isTestMode,
    signatureVerified: false,
    retryCount: original.retryCount + 1,
  };
  recordWebhookEvent(replayRecord);

  res.json({
    success: replayResult === 'processed',
    replayEventId: replayRecord.id,
    originalEventId: webhookEventId,
    processingResult: replayRecord.processingResult,
    eventsProcessed: eventsCount,
    ...(replayError ? { error: { code: 'REPLAY_FAILED', message: replayError } } : {}),
  });
});

app.get('/api/shipping/event-processor/status-map', (_req, res) => {
  const { getProviderStatusMap, getStatusProgressionOrder } = require('./event-processor') as typeof import('./event-processor');
  res.json({
    providerToInternal: getProviderStatusMap(),
    progressionOrder: getStatusProgressionOrder(),
  });
});

const PORT = parseInt(process.env.SHIPPING_API_PORT || '5001', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Shipping API] Server running on port ${PORT}`);
});

export default app;
