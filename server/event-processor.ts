import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ProviderTrackingEvent } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebhookEventRecord {
  id: string;
  providerId: string;
  providerEventId?: string;
  eventType: string;
  trackingNumber?: string;
  shipmentRef?: string;
  rawPayload: unknown;
  receivedAt: string;
  processedAt?: string;
  processingResult: 'processed' | 'ignored' | 'duplicate' | 'failed' | 'pending';
  processingError?: string;
  mappedStatus?: string;
  source: 'webhook' | 'sync' | 'replay' | 'simulation';
  isTestMode: boolean;
  signatureVerified: boolean;
  retryCount: number;
}

export interface ProcessedEventResult {
  event: ProviderTrackingEvent;
  processingResult: 'processed' | 'ignored' | 'duplicate';
  mappedInternalStatus?: string;
  isDuplicate: boolean;
  isOutOfOrder: boolean;
}

export interface EventProcessingContext {
  providerId: string;
  trackingNumber: string;
  shipmentRef?: string;
  existingEvents: ProviderTrackingEvent[];
  currentShipmentStatus: string;
  source: 'webhook' | 'sync' | 'replay' | 'simulation';
  isTestMode: boolean;
}

const PROVIDER_TO_INTERNAL_STATUS: Record<string, string> = {
  'pre_transit': 'Label Created',
  'accepted': 'Dispatched',
  'in_transit': 'In Transit',
  'out_for_delivery': 'In Transit',
  'delivered': 'Delivered',
  'failure': 'Exception',
  'return_to_sender': 'Exception',
  'returned': 'Returned',
  'error': 'Exception',
  'cancelled': 'Cancelled',
  'available_for_pickup': 'In Transit',
};

const STATUS_PROGRESSION_ORDER = [
  'Draft', 'Ready', 'Label Created', 'Packed', 'Dispatched',
  'In Transit', 'Delivered', 'Exception', 'Rejected', 'Returned', 'Cancelled',
];

const WEBHOOK_LOG_FILE = path.join(__dirname, '..', 'data', 'webhook-audit-log.json');
const MAX_LOG_SIZE = 500;
let webhookLog: WebhookEventRecord[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDataDir(): void {
  const dir = path.dirname(WEBHOOK_LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadWebhookLogFromDisk(): void {
  try {
    if (fs.existsSync(WEBHOOK_LOG_FILE)) {
      const raw = fs.readFileSync(WEBHOOK_LOG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        webhookLog = parsed.slice(0, MAX_LOG_SIZE);
        console.log(`[Event Processor] Loaded ${webhookLog.length} webhook event(s) from durable storage.`);
      }
    }
  } catch (err) {
    console.warn(`[Event Processor] Failed to load webhook log from disk, starting fresh:`, err instanceof Error ? err.message : err);
    webhookLog = [];
  }
}

function persistWebhookLogToDisk(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      ensureDataDir();
      fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify(webhookLog, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[Event Processor] Failed to persist webhook log:`, err instanceof Error ? err.message : err);
    }
  }, 200);
}

ensureDataDir();
loadWebhookLogFromDisk();

export function mapProviderStatus(providerStatus: string): string | undefined {
  return PROVIDER_TO_INTERNAL_STATUS[providerStatus.toLowerCase()];
}

export function isStatusProgression(currentStatus: string, newStatus: string): boolean {
  const currentIdx = STATUS_PROGRESSION_ORDER.indexOf(currentStatus);
  const newIdx = STATUS_PROGRESSION_ORDER.indexOf(newStatus);
  if (currentIdx === -1 || newIdx === -1) return false;
  if (newStatus === 'Exception') return currentIdx >= STATUS_PROGRESSION_ORDER.indexOf('Dispatched');
  if (newStatus === 'Returned') return currentIdx >= STATUS_PROGRESSION_ORDER.indexOf('Dispatched');
  return newIdx > currentIdx;
}

export function isDuplicateEvent(
  newEvent: { providerEventRef?: string; timestamp: string; status: string },
  existingEvents: ProviderTrackingEvent[]
): boolean {
  if (newEvent.providerEventRef) {
    return existingEvents.some(e => e.providerEventRef === newEvent.providerEventRef);
  }
  return existingEvents.some(
    e => e.timestamp === newEvent.timestamp && e.status === newEvent.status
  );
}

export function isDuplicateWebhookEvent(record: WebhookEventRecord): boolean {
  if (record.providerEventId) {
    return webhookLog.some(
      r => r.providerEventId === record.providerEventId
        && r.providerId === record.providerId
        && r.source === 'webhook'
    );
  }
  return false;
}

export function processProviderEvents(
  incomingEvents: ProviderTrackingEvent[],
  context: EventProcessingContext
): ProcessedEventResult[] {
  const results: ProcessedEventResult[] = [];

  for (const event of incomingEvents) {
    const duplicate = isDuplicateEvent(event, context.existingEvents);

    if (duplicate) {
      results.push({
        event,
        processingResult: 'duplicate',
        isDuplicate: true,
        isOutOfOrder: false,
      });
      continue;
    }

    const mappedStatus = mapProviderStatus(event.status);
    const isProgression = mappedStatus
      ? isStatusProgression(context.currentShipmentStatus, mappedStatus)
      : false;

    const isOutOfOrder = mappedStatus
      ? !isProgression && STATUS_PROGRESSION_ORDER.indexOf(mappedStatus) < STATUS_PROGRESSION_ORDER.indexOf(context.currentShipmentStatus)
      : false;

    results.push({
      event,
      processingResult: 'processed',
      mappedInternalStatus: isProgression ? mappedStatus : undefined,
      isDuplicate: false,
      isOutOfOrder,
    });

    context.existingEvents = [...context.existingEvents, event];
  }

  return results;
}

export function recordWebhookEvent(record: WebhookEventRecord): void {
  if (isDuplicateWebhookEvent(record)) {
    record.processingResult = 'duplicate';
  }
  webhookLog.unshift(record);
  if (webhookLog.length > MAX_LOG_SIZE) {
    webhookLog.length = MAX_LOG_SIZE;
  }
  persistWebhookLogToDisk();
}

export function getWebhookLog(filters?: {
  providerId?: string;
  trackingNumber?: string;
  processingResult?: string;
  limit?: number;
}): WebhookEventRecord[] {
  let results = [...webhookLog];
  if (filters?.providerId) results = results.filter(r => r.providerId === filters.providerId);
  if (filters?.trackingNumber) results = results.filter(r => r.trackingNumber === filters.trackingNumber);
  if (filters?.processingResult) results = results.filter(r => r.processingResult === filters.processingResult);
  const limit = filters?.limit || 100;
  return results.slice(0, limit);
}

export function getWebhookEventById(id: string): WebhookEventRecord | undefined {
  return webhookLog.find(r => r.id === id);
}

export function getWebhookLogStats(): {
  total: number;
  byResult: Record<string, number>;
  byProvider: Record<string, number>;
  oldestEvent?: string;
  newestEvent?: string;
} {
  const byResult: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  for (const r of webhookLog) {
    byResult[r.processingResult] = (byResult[r.processingResult] || 0) + 1;
    byProvider[r.providerId] = (byProvider[r.providerId] || 0) + 1;
  }
  return {
    total: webhookLog.length,
    byResult,
    byProvider,
    oldestEvent: webhookLog.length > 0 ? webhookLog[webhookLog.length - 1].receivedAt : undefined,
    newestEvent: webhookLog.length > 0 ? webhookLog[0].receivedAt : undefined,
  };
}

export function parseEasyPostWebhook(payload: any): {
  eventType: string;
  providerEventId?: string;
  trackingNumber?: string;
  events: ProviderTrackingEvent[];
  overallStatus?: string;
} {
  const eventType = payload?.description || payload?.object || 'unknown';
  const providerEventId = payload?.id;
  const result = payload?.result || payload?.previous_attributes || {};
  const trackingNumber = result?.tracking_code || result?.tracking_number;

  const trackingDetails = result?.tracking_details || [];
  const events: ProviderTrackingEvent[] = trackingDetails.map((td: any, i: number) => ({
    id: `ep-wh-${Date.now()}-${i}`,
    timestamp: td.datetime || new Date().toISOString(),
    status: td.status || 'unknown',
    statusDetail: td.message || td.description,
    location: td.tracking_location
      ? `${td.tracking_location.city || ''}, ${td.tracking_location.state || ''}`.trim()
      : undefined,
    description: td.message || td.description || `Event: ${td.status}`,
    source: 'provider' as const,
    providerEventRef: td.object_id || `ep-${td.datetime}-${td.status}`,
  }));

  return {
    eventType,
    providerEventId,
    trackingNumber,
    events,
    overallStatus: result?.status,
  };
}

export function parseShippoWebhook(payload: any): {
  eventType: string;
  providerEventId?: string;
  trackingNumber?: string;
  events: ProviderTrackingEvent[];
  overallStatus?: string;
} {
  const eventType = payload?.event || payload?.test || 'unknown';
  const providerEventId = payload?.metadata;
  const data = payload?.data || {};
  const trackingNumber = data?.tracking_number;

  const trackingHistory = data?.tracking_history || [];
  const events: ProviderTrackingEvent[] = trackingHistory.map((th: any, i: number) => ({
    id: `sp-wh-${Date.now()}-${i}`,
    timestamp: th.status_date || new Date().toISOString(),
    status: th.status || 'unknown',
    statusDetail: th.substatus || th.status_details,
    location: th.location?.city
      ? `${th.location.city}, ${th.location.state || ''}`.trim()
      : undefined,
    description: th.status_details || `Event: ${th.status}`,
    source: 'provider' as const,
    providerEventRef: `sp-${th.status_date}-${th.status}`,
  }));

  return {
    eventType,
    providerEventId,
    trackingNumber,
    events,
    overallStatus: data?.tracking_status?.status,
  };
}

export function parseShipStationWebhook(payload: any): {
  eventType: string;
  providerEventId?: string;
  trackingNumber?: string;
  events: ProviderTrackingEvent[];
  overallStatus?: string;
} {
  const eventType = payload?.resource_type || 'unknown';
  const providerEventId = payload?.message_id;
  const trackingNumber = payload?.tracking_number;

  const events: ProviderTrackingEvent[] = [];
  if (payload?.status) {
    events.push({
      id: `ss-wh-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: payload.status,
      description: `ShipStation event: ${eventType}`,
      source: 'provider' as const,
      providerEventRef: providerEventId || `ss-${Date.now()}`,
    });
  }

  return {
    eventType,
    providerEventId,
    trackingNumber,
    events,
    overallStatus: payload?.status,
  };
}

export function getStatusProgressionOrder(): string[] {
  return [...STATUS_PROGRESSION_ORDER];
}

export function getProviderStatusMap(): Record<string, string> {
  return { ...PROVIDER_TO_INTERNAL_STATUS };
}
