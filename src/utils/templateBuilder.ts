import type { TemplateType } from '../types';

export interface TemplateSlot {
  tag: string;
  label: string;
  category: string;
  region: 'header' | 'billing' | 'body' | 'totals' | 'footer';
  order: number;
}

const INVOICE_SLOTS: TemplateSlot[] = [
  { tag: '{{storeName}}', label: 'Store Name', category: 'Store', region: 'header', order: 0 },
  { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store', region: 'header', order: 1 },
  { tag: '{{invoiceNumber}}', label: 'Invoice Number', category: 'Document', region: 'header', order: 2 },
  { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer', region: 'billing', order: 0 },
  { tag: '{{customerEmail}}', label: 'Customer Email', category: 'Customer', region: 'billing', order: 1 },
  { tag: '{{customerPhone}}', label: 'Customer Phone', category: 'Customer', region: 'billing', order: 2 },
  { tag: '{{createdAt}}', label: 'Issue Date', category: 'Document', region: 'billing', order: 3 },
  { tag: '{{dueDate}}', label: 'Due Date', category: 'Document', region: 'billing', order: 4 },
  { tag: '{{status}}', label: 'Status', category: 'Document', region: 'billing', order: 5 },
  { tag: '{{lineItems}}', label: 'Line Items Table', category: 'Items', region: 'body', order: 0 },
  { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals', region: 'totals', order: 0 },
  { tag: '{{discount}}', label: 'Discount', category: 'Totals', region: 'totals', order: 1 },
  { tag: '{{tax}}', label: 'Tax', category: 'Totals', region: 'totals', order: 2 },
  { tag: '{{total}}', label: 'Total', category: 'Totals', region: 'totals', order: 3 },
  { tag: '{{notes}}', label: 'Notes', category: 'Extra', region: 'footer', order: 0 },
  { tag: '{{terms}}', label: 'Terms', category: 'Extra', region: 'footer', order: 1 },
];

const TICKET_SLOTS: TemplateSlot[] = [
  { tag: '{{storeName}}', label: 'Store Name', category: 'Store', region: 'header', order: 0 },
  { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store', region: 'header', order: 1 },
  { tag: '{{ticketNumber}}', label: 'Ticket Number', category: 'Document', region: 'header', order: 2 },
  { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer', region: 'billing', order: 0 },
  { tag: '{{customerPhone}}', label: 'Customer Phone', category: 'Customer', region: 'billing', order: 1 },
  { tag: '{{deviceName}}', label: 'Device Name', category: 'Device', region: 'billing', order: 2 },
  { tag: '{{imei}}', label: 'IMEI/Serial', category: 'Device', region: 'billing', order: 3 },
  { tag: '{{issueDescription}}', label: 'Issue Description', category: 'Repair', region: 'body', order: 0 },
  { tag: '{{priority}}', label: 'Priority', category: 'Repair', region: 'body', order: 1 },
  { tag: '{{estimatedTime}}', label: 'Est. Time', category: 'Repair', region: 'body', order: 2 },
  { tag: '{{technicianName}}', label: 'Technician', category: 'Repair', region: 'body', order: 3 },
];

const LABEL_SLOTS: TemplateSlot[] = [
  { tag: '{{storeName}}', label: 'Store Name', category: 'Store', region: 'header', order: 0 },
  { tag: '{{itemName}}', label: 'Item Name', category: 'Item', region: 'body', order: 0 },
  { tag: '{{sku}}', label: 'SKU', category: 'Item', region: 'body', order: 1 },
  { tag: '{{price}}', label: 'Price', category: 'Item', region: 'body', order: 2 },
  { tag: '{{category}}', label: 'Category', category: 'Item', region: 'body', order: 3 },
  { tag: '{{barcode}}', label: 'Barcode', category: 'Item', region: 'body', order: 4 },
];

const RECEIPT_SLOTS: TemplateSlot[] = [
  { tag: '{{storeName}}', label: 'Store Name', category: 'Store', region: 'header', order: 0 },
  { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store', region: 'header', order: 1 },
  { tag: '{{receiptNumber}}', label: 'Receipt Number', category: 'Document', region: 'billing', order: 0 },
  { tag: '{{date}}', label: 'Date', category: 'Document', region: 'billing', order: 1 },
  { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer', region: 'billing', order: 2 },
  { tag: '{{lineItems}}', label: 'Line Items', category: 'Items', region: 'body', order: 0 },
  { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals', region: 'totals', order: 0 },
  { tag: '{{tax}}', label: 'Tax', category: 'Totals', region: 'totals', order: 1 },
  { tag: '{{total}}', label: 'Total', category: 'Totals', region: 'totals', order: 2 },
  { tag: '{{amountPaid}}', label: 'Amount Paid', category: 'Totals', region: 'totals', order: 3 },
];

const ESTIMATE_SLOTS: TemplateSlot[] = [
  { tag: '{{storeName}}', label: 'Store Name', category: 'Store', region: 'header', order: 0 },
  { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store', region: 'header', order: 1 },
  { tag: '{{estimateNumber}}', label: 'Estimate Number', category: 'Document', region: 'header', order: 2 },
  { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer', region: 'billing', order: 0 },
  { tag: '{{customerEmail}}', label: 'Customer Email', category: 'Customer', region: 'billing', order: 1 },
  { tag: '{{lineItems}}', label: 'Line Items', category: 'Items', region: 'body', order: 0 },
  { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals', region: 'totals', order: 0 },
  { tag: '{{tax}}', label: 'Est. Tax', category: 'Totals', region: 'totals', order: 1 },
  { tag: '{{total}}', label: 'Est. Total', category: 'Totals', region: 'totals', order: 2 },
];

const TEMPLATE_SLOTS: Record<TemplateType, TemplateSlot[]> = {
  invoice: INVOICE_SLOTS,
  ticket: TICKET_SLOTS,
  label: LABEL_SLOTS,
  receipt: RECEIPT_SLOTS,
  estimate: ESTIMATE_SLOTS,
};

export function getSlots(type: TemplateType): TemplateSlot[] {
  return TEMPLATE_SLOTS[type] || [];
}

export function getDefaultEnabledTags(type: TemplateType): string[] {
  return getSlots(type).map(s => s.tag);
}

function has(tags: Set<string>, tag: string): boolean {
  return tags.has(tag);
}

function buildInvoiceHtml(tags: Set<string>): string {
  const parts: string[] = [];
  parts.push('<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">');

  parts.push('<div style="display: flex; justify-content: space-between; border-bottom: 2px solid {{brandColor}}; padding-bottom: 16px; margin-bottom: 24px;">');
  parts.push('<div><h1 style="color: {{brandColor}}; margin: 0;">INVOICE</h1>');
  if (has(tags, '{{invoiceNumber}}')) parts.push('<p style="color: #94a3b8;">{{invoiceNumber}}</p>');
  parts.push('</div>');
  parts.push('<div style="text-align: right;">');
  if (has(tags, '{{storeName}}')) parts.push('<h2 style="color: {{brandColor}}; margin: 0;">{{storeName}}</h2>');
  if (has(tags, '{{storeTagline}}')) parts.push('<p style="color: #94a3b8;">{{storeTagline}}</p>');
  parts.push('</div></div>');

  const hasBilling = has(tags, '{{customerName}}') || has(tags, '{{customerEmail}}') || has(tags, '{{customerPhone}}') ||
                     has(tags, '{{createdAt}}') || has(tags, '{{dueDate}}') || has(tags, '{{status}}');
  if (hasBilling) {
    parts.push('<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px;">');
    const hasBillTo = has(tags, '{{customerName}}') || has(tags, '{{customerEmail}}') || has(tags, '{{customerPhone}}');
    if (hasBillTo) {
      parts.push('<div style="background: #f8fafc; padding: 16px; border: 1px solid #e2e8f0;">');
      parts.push('<p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Bill To</p>');
      if (has(tags, '{{customerName}}')) parts.push('<p style="font-weight: 700;">{{customerName}}</p>');
      if (has(tags, '{{customerEmail}}')) parts.push('<p style="color: #64748b;">{{customerEmail}}</p>');
      if (has(tags, '{{customerPhone}}')) parts.push('<p style="color: #64748b;">{{customerPhone}}</p>');
      parts.push('</div>');
    }
    const hasDetails = has(tags, '{{createdAt}}') || has(tags, '{{dueDate}}') || has(tags, '{{status}}');
    if (hasDetails) {
      parts.push('<div style="background: #f8fafc; padding: 16px; border: 1px solid #e2e8f0; text-align: right;">');
      parts.push('<p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Details</p>');
      if (has(tags, '{{createdAt}}')) parts.push('<p>Issue: {{createdAt}}</p>');
      if (has(tags, '{{dueDate}}')) parts.push('<p>Due: {{dueDate}}</p>');
      if (has(tags, '{{status}}')) parts.push('<p style="font-weight: 700; color: {{brandColor}};">Status: {{status}}</p>');
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (has(tags, '{{lineItems}}')) parts.push('{{lineItems}}');

  const hasTotals = has(tags, '{{subtotal}}') || has(tags, '{{discount}}') || has(tags, '{{tax}}') || has(tags, '{{total}}');
  if (hasTotals) {
    parts.push('<div style="display: flex; justify-content: flex-end;"><div style="width: 280px;">');
    if (has(tags, '{{subtotal}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 4px 0;"><span>Subtotal</span><span>{{subtotal}}</span></div>');
    if (has(tags, '{{discount}}')) parts.push('{{#if discount}}<div style="display: flex; justify-content: space-between; padding: 4px 0;"><span>Discount</span><span>-{{discount}}</span></div>{{/if}}');
    if (has(tags, '{{tax}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 4px 0;"><span>Tax</span><span>{{tax}}</span></div>');
    if (has(tags, '{{total}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 2px solid {{brandColor}}; font-weight: 900; font-size: 14pt;"><span>Total</span><span>{{total}}</span></div>');
    parts.push('</div></div>');
  }

  if (has(tags, '{{notes}}')) parts.push('{{#if notes}}<div style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;"><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Notes</p><p>{{notes}}</p></div>{{/if}}');
  if (has(tags, '{{terms}}')) parts.push('{{#if terms}}<div style="margin-top: 12px;"><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Terms</p><p>{{terms}}</p></div>{{/if}}');

  parts.push('<div style="text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #f1f5f9; color: #cbd5e1; font-size: 10px;">Thank you for your business</div>');
  parts.push('</div>');
  return parts.join('\n');
}

function buildTicketHtml(tags: Set<string>): string {
  const parts: string[] = [];
  parts.push('<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">');

  parts.push('<div style="background: {{brandColor}}; color: white; padding: 16px 24px; display: flex; justify-content: space-between;">');
  parts.push('<div><h1 style="margin: 0; font-size: 18pt;">REPAIR TICKET</h1>');
  if (has(tags, '{{ticketNumber}}')) parts.push('<p style="margin: 4px 0 0; opacity: 0.8;">{{ticketNumber}}</p>');
  parts.push('</div>');
  parts.push('<div style="text-align: right;">');
  if (has(tags, '{{storeName}}')) parts.push('<h2 style="margin: 0;">{{storeName}}</h2>');
  if (has(tags, '{{storeTagline}}')) parts.push('<p style="margin: 4px 0 0; opacity: 0.8;">{{storeTagline}}</p>');
  parts.push('</div></div>');

  parts.push('<div style="padding: 24px;">');

  const hasCustDev = has(tags, '{{customerName}}') || has(tags, '{{customerPhone}}') || has(tags, '{{deviceName}}') || has(tags, '{{imei}}');
  if (hasCustDev) {
    parts.push('<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px;">');
    if (has(tags, '{{customerName}}') || has(tags, '{{customerPhone}}')) {
      parts.push('<div><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Customer</p>');
      if (has(tags, '{{customerName}}')) parts.push('<p style="font-weight: 700;">{{customerName}}</p>');
      if (has(tags, '{{customerPhone}}')) parts.push('<p style="color: #64748b;">{{customerPhone}}</p>');
      parts.push('</div>');
    }
    if (has(tags, '{{deviceName}}') || has(tags, '{{imei}}')) {
      parts.push('<div><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Device</p>');
      if (has(tags, '{{deviceName}}')) parts.push('<p style="font-weight: 700;">{{deviceName}}</p>');
      if (has(tags, '{{imei}}')) parts.push('<p style="color: #64748b;">IMEI: {{imei}}</p>');
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (has(tags, '{{issueDescription}}')) {
    parts.push('<div style="background: #f8fafc; padding: 16px; border: 1px solid #e2e8f0; margin-bottom: 16px;"><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Issue Description</p><p>{{issueDescription}}</p></div>');
  }

  const hasRepairDetails = has(tags, '{{priority}}') || has(tags, '{{estimatedTime}}') || has(tags, '{{technicianName}}');
  if (hasRepairDetails) {
    parts.push('<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">');
    if (has(tags, '{{priority}}')) parts.push('<div><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Priority</p><p style="font-weight: 700;">{{priority}}</p></div>');
    if (has(tags, '{{estimatedTime}}')) parts.push('<div><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Est. Time</p><p style="font-weight: 700;">{{estimatedTime}}</p></div>');
    if (has(tags, '{{technicianName}}')) parts.push('<div><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Technician</p><p style="font-weight: 700;">{{technicianName}}</p></div>');
    parts.push('</div>');
  }

  parts.push('</div></div>');
  return parts.join('\n');
}

function buildLabelHtml(tags: Set<string>): string {
  const parts: string[] = [];
  parts.push('<div style="font-family: monospace; width: 60mm; padding: 4mm; border: 1px solid #333;">');
  if (has(tags, '{{storeName}}')) {
    parts.push('<div style="text-align: center; border-bottom: 1px dashed #333; padding-bottom: 4px; margin-bottom: 4px;">');
    parts.push('<p style="font-weight: 900; font-size: 10pt; margin: 0;">{{storeName}}</p>');
    parts.push('</div>');
  }
  if (has(tags, '{{itemName}}')) parts.push('<p style="font-weight: 700; font-size: 9pt; margin: 4px 0;">{{itemName}}</p>');
  if (has(tags, '{{sku}}')) parts.push('<p style="font-size: 8pt; color: #666; margin: 2px 0;">SKU: {{sku}}</p>');
  if (has(tags, '{{price}}')) parts.push('<p style="font-weight: 900; font-size: 14pt; margin: 6px 0;">{{price}}</p>');
  if (has(tags, '{{category}}')) parts.push('<p style="font-size: 7pt; color: #999; margin: 2px 0;">Category: {{category}}</p>');
  if (has(tags, '{{barcode}}')) parts.push('<p style="font-size: 7pt; color: #999; margin: 2px 0;">{{barcode}}</p>');
  parts.push('</div>');
  return parts.join('\n');
}

function buildReceiptHtml(tags: Set<string>): string {
  const parts: string[] = [];
  parts.push('<div style="font-family: monospace; width: 80mm; padding: 4mm;">');

  parts.push('<div style="text-align: center; border-bottom: 1px dashed #333; padding-bottom: 8px; margin-bottom: 8px;">');
  if (has(tags, '{{storeName}}')) parts.push('<h2 style="font-size: 14pt; font-weight: 900; margin: 0; color: {{brandColor}};">{{storeName}}</h2>');
  if (has(tags, '{{storeTagline}}')) parts.push('<p style="font-size: 8pt; margin: 2px 0 0; color: #666;">{{storeTagline}}</p>');
  parts.push('</div>');

  const hasBilling = has(tags, '{{receiptNumber}}') || has(tags, '{{date}}') || has(tags, '{{customerName}}');
  if (hasBilling) {
    parts.push('<div style="font-size: 8pt; margin-bottom: 6px;">');
    if (has(tags, '{{receiptNumber}}')) parts.push('<p style="font-weight: 700; margin: 0;">{{receiptNumber}}</p>');
    if (has(tags, '{{date}}')) parts.push('<p style="margin: 2px 0; color: #666;">Date: {{date}}</p>');
    if (has(tags, '{{customerName}}')) parts.push('<p style="margin: 2px 0; font-weight: 700;">{{customerName}}</p>');
    parts.push('</div>');
  }

  if (has(tags, '{{lineItems}}')) parts.push('{{lineItems}}');

  const hasTotals = has(tags, '{{subtotal}}') || has(tags, '{{tax}}') || has(tags, '{{total}}') || has(tags, '{{amountPaid}}');
  if (hasTotals) {
    parts.push('<div style="font-size: 8pt;">');
    if (has(tags, '{{subtotal}}')) parts.push('<div style="display: flex; justify-content: space-between;"><span>Subtotal</span><span>{{subtotal}}</span></div>');
    if (has(tags, '{{tax}}')) parts.push('<div style="display: flex; justify-content: space-between;"><span>Tax</span><span>{{tax}}</span></div>');
    if (has(tags, '{{total}}')) parts.push('<div style="display: flex; justify-content: space-between; border-top: 1px solid #333; font-weight: 900; font-size: 10pt; padding-top: 4px;"><span>TOTAL</span><span>{{total}}</span></div>');
    if (has(tags, '{{amountPaid}}')) parts.push('<div style="display: flex; justify-content: space-between; padding-top: 2px;"><span>Paid</span><span>{{amountPaid}}</span></div>');
    parts.push('</div>');
  }

  parts.push('<div style="text-align: center; margin-top: 10px; border-top: 1px dashed #333; padding-top: 6px; font-size: 7pt; color: #999;">Thank you for your business</div>');
  parts.push('</div>');
  return parts.join('\n');
}

function buildEstimateHtml(tags: Set<string>): string {
  const parts: string[] = [];
  parts.push('<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">');

  parts.push('<div style="display: flex; justify-content: space-between; border-bottom: 2px solid {{brandColor}}; padding-bottom: 16px; margin-bottom: 24px;">');
  parts.push('<div><h1 style="color: {{brandColor}}; margin: 0;">ESTIMATE</h1>');
  if (has(tags, '{{estimateNumber}}')) parts.push('<p style="color: #94a3b8;">{{estimateNumber}}</p>');
  parts.push('</div>');
  parts.push('<div style="text-align: right;">');
  if (has(tags, '{{storeName}}')) parts.push('<h2 style="color: {{brandColor}}; margin: 0;">{{storeName}}</h2>');
  if (has(tags, '{{storeTagline}}')) parts.push('<p style="color: #94a3b8;">{{storeTagline}}</p>');
  parts.push('</div></div>');

  if (has(tags, '{{customerName}}') || has(tags, '{{customerEmail}}')) {
    parts.push('<div style="margin-bottom: 24px;"><p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">Prepared For</p>');
    if (has(tags, '{{customerName}}')) parts.push('<p style="font-weight: 700;">{{customerName}}</p>');
    if (has(tags, '{{customerEmail}}')) parts.push('<p style="color: #64748b;">{{customerEmail}}</p>');
    parts.push('</div>');
  }

  parts.push('<div style="background: #fffbeb; border: 1px solid #fcd34d; padding: 12px; margin-bottom: 24px; font-size: 10pt; color: #92400e;">This estimate is valid for 30 days from the date of issue.</div>');

  if (has(tags, '{{lineItems}}')) parts.push('{{lineItems}}');

  const hasTotals = has(tags, '{{subtotal}}') || has(tags, '{{tax}}') || has(tags, '{{total}}');
  if (hasTotals) {
    parts.push('<div style="display: flex; justify-content: flex-end;"><div style="width: 280px;">');
    if (has(tags, '{{subtotal}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 4px 0;"><span>Subtotal</span><span>{{subtotal}}</span></div>');
    if (has(tags, '{{tax}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 4px 0;"><span>Est. Tax</span><span>{{tax}}</span></div>');
    if (has(tags, '{{total}}')) parts.push('<div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 2px solid {{brandColor}}; font-weight: 900; font-size: 14pt;"><span>Est. Total</span><span>{{total}}</span></div>');
    parts.push('</div></div>');
  }

  parts.push('<div style="text-align: center; margin-top: 32px; color: #cbd5e1; font-size: 10px;">This is an estimate only. Final pricing may vary.</div>');
  parts.push('</div>');
  return parts.join('\n');
}

const BUILDERS: Record<TemplateType, (tags: Set<string>) => string> = {
  invoice: buildInvoiceHtml,
  ticket: buildTicketHtml,
  label: buildLabelHtml,
  receipt: buildReceiptHtml,
  estimate: buildEstimateHtml,
};

export function buildTemplateHtml(type: TemplateType, enabledTags: string[]): string {
  const builder = BUILDERS[type];
  if (!builder) return '';
  return builder(new Set(enabledTags));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TRUSTED_TAGS = new Set(['{{lineItems}}', '{{brandColor}}']);

export function renderTemplate(content: string, data: Record<string, string>): string {
  let html = content;
  html = html.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, inner) => {
    const val = data[`{{${key}}}`];
    return val && val.trim() !== '' && val !== '$0.00' ? inner : '';
  });
  Object.entries(data).forEach(([tag, val]) => {
    const safe = TRUSTED_TAGS.has(tag) ? val : escapeHtml(val);
    html = html.split(tag).join(safe);
  });
  return html;
}

export function buildLineItemsHtml(items: Array<{ id: string; name: string; quantity: number; price: number }>, brandColor: string): string {
  if (!items.length) return '';
  const rows = items.map((it, idx) =>
    `<tr style="border-bottom: 1px solid #e2e8f0;${idx % 2 === 0 ? ' background: #f8fafc;' : ''}"><td style="padding: 8px 4px; font-weight: 700; color: #0f172a;">${escapeHtml(it.name)}</td><td style="padding: 8px 4px; text-align: center; color: #475569;">${it.quantity}</td><td style="padding: 8px 4px; text-align: right; color: #475569;">$${it.price.toFixed(2)}</td><td style="padding: 8px 4px; text-align: right; font-weight: 700; color: #0f172a;">$${(it.quantity * it.price).toFixed(2)}</td></tr>`
  ).join('');
  return `<table style="width: 100%; font-size: 10pt; border-collapse: collapse; margin-bottom: 16px;"><thead><tr style="border-bottom: 2px solid ${brandColor};"><th style="padding: 8px 4px; text-align: left; font-size: 8pt; text-transform: uppercase; font-weight: 900; color: ${brandColor};">Description</th><th style="padding: 8px 4px; text-align: center; font-size: 8pt; text-transform: uppercase; font-weight: 900; color: ${brandColor}; width: 60px;">Qty</th><th style="padding: 8px 4px; text-align: right; font-size: 8pt; text-transform: uppercase; font-weight: 900; color: ${brandColor}; width: 90px;">Price</th><th style="padding: 8px 4px; text-align: right; font-size: 8pt; text-transform: uppercase; font-weight: 900; color: ${brandColor}; width: 90px;">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function buildReceiptLineItemsHtml(items: Array<{ id: string; name: string; quantity: number; price: number }>): string {
  if (!items.length) return '';
  const rows = items.map(it =>
    `<div style="display: flex; justify-content: space-between; font-size: 8pt; padding: 2px 0;"><span>${it.quantity}x ${escapeHtml(it.name)}</span><span style="font-weight: 700;">$${(it.quantity * it.price).toFixed(2)}</span></div>`
  ).join('');
  return `<div style="border-top: 1px dashed #333; border-bottom: 1px dashed #333; padding: 4px 0; margin: 6px 0;">${rows}</div>`;
}
