import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { DocumentTemplate, TemplateType, TemplateMacro, LogoPlacement } from '../types';

const TAG_REGION_MAP: Record<string, string> = {
  'Store': 'header',
  'Document': 'header',
  'Customer': 'billing',
  'Items': 'body',
  'Device': 'body',
  'Repair': 'body',
  'Item': 'body',
  'Totals': 'totals',
  'Extra': 'footer',
};

const TEMPLATE_MACROS: Record<TemplateType, TemplateMacro[]> = {
  invoice: [
    { tag: '{{storeName}}', label: 'Store Name', category: 'Store' },
    { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store' },
    { tag: '{{brandColor}}', label: 'Brand Color', category: 'Store' },
    { tag: '{{invoiceNumber}}', label: 'Invoice Number', category: 'Document' },
    { tag: '{{createdAt}}', label: 'Issue Date', category: 'Document' },
    { tag: '{{dueDate}}', label: 'Due Date', category: 'Document' },
    { tag: '{{status}}', label: 'Status', category: 'Document' },
    { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer' },
    { tag: '{{customerEmail}}', label: 'Customer Email', category: 'Customer' },
    { tag: '{{customerPhone}}', label: 'Customer Phone', category: 'Customer' },
    { tag: '{{lineItems}}', label: 'Line Items Table', category: 'Items' },
    { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals' },
    { tag: '{{discount}}', label: 'Discount', category: 'Totals' },
    { tag: '{{tax}}', label: 'Tax', category: 'Totals' },
    { tag: '{{total}}', label: 'Total', category: 'Totals' },
    { tag: '{{notes}}', label: 'Notes', category: 'Extra' },
    { tag: '{{terms}}', label: 'Terms', category: 'Extra' },
  ],
  ticket: [
    { tag: '{{storeName}}', label: 'Store Name', category: 'Store' },
    { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store' },
    { tag: '{{brandColor}}', label: 'Brand Color', category: 'Store' },
    { tag: '{{ticketNumber}}', label: 'Ticket Number', category: 'Document' },
    { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer' },
    { tag: '{{customerPhone}}', label: 'Customer Phone', category: 'Customer' },
    { tag: '{{deviceName}}', label: 'Device Name', category: 'Device' },
    { tag: '{{imei}}', label: 'IMEI/Serial', category: 'Device' },
    { tag: '{{issueDescription}}', label: 'Issue Description', category: 'Repair' },
    { tag: '{{priority}}', label: 'Priority', category: 'Repair' },
    { tag: '{{estimatedTime}}', label: 'Est. Time', category: 'Repair' },
    { tag: '{{technicianName}}', label: 'Technician', category: 'Repair' },
  ],
  label: [
    { tag: '{{storeName}}', label: 'Store Name', category: 'Store' },
    { tag: '{{itemName}}', label: 'Item Name', category: 'Item' },
    { tag: '{{sku}}', label: 'SKU', category: 'Item' },
    { tag: '{{price}}', label: 'Price', category: 'Item' },
    { tag: '{{category}}', label: 'Category', category: 'Item' },
    { tag: '{{barcode}}', label: 'Barcode', category: 'Item' },
  ],
  receipt: [
    { tag: '{{storeName}}', label: 'Store Name', category: 'Store' },
    { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store' },
    { tag: '{{brandColor}}', label: 'Brand Color', category: 'Store' },
    { tag: '{{receiptNumber}}', label: 'Receipt Number', category: 'Document' },
    { tag: '{{date}}', label: 'Date', category: 'Document' },
    { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer' },
    { tag: '{{lineItems}}', label: 'Line Items', category: 'Items' },
    { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals' },
    { tag: '{{tax}}', label: 'Tax', category: 'Totals' },
    { tag: '{{total}}', label: 'Total', category: 'Totals' },
    { tag: '{{amountPaid}}', label: 'Amount Paid', category: 'Totals' },
  ],
  estimate: [
    { tag: '{{storeName}}', label: 'Store Name', category: 'Store' },
    { tag: '{{storeTagline}}', label: 'Store Tagline', category: 'Store' },
    { tag: '{{brandColor}}', label: 'Brand Color', category: 'Store' },
    { tag: '{{estimateNumber}}', label: 'Estimate Number', category: 'Document' },
    { tag: '{{customerName}}', label: 'Customer Name', category: 'Customer' },
    { tag: '{{customerEmail}}', label: 'Customer Email', category: 'Customer' },
    { tag: '{{lineItems}}', label: 'Line Items', category: 'Items' },
    { tag: '{{subtotal}}', label: 'Subtotal', category: 'Totals' },
    { tag: '{{tax}}', label: 'Est. Tax', category: 'Totals' },
    { tag: '{{total}}', label: 'Est. Total', category: 'Totals' },
  ],
};

const SAMPLE_DATA: Record<string, string> = {
  '{{storeName}}': 'RepairHub',
  '{{storeTagline}}': 'Professional Repair Services',
  '{{brandColor}}': '#003633',
  '{{invoiceNumber}}': 'INV-2026-001',
  '{{createdAt}}': '2026-03-28',
  '{{dueDate}}': '2026-04-04',
  '{{status}}': 'Unpaid',
  '{{customerName}}': 'Alexander Wright',
  '{{customerEmail}}': 'alex@wright.com',
  '{{customerPhone}}': '555-0123',
  '{{subtotal}}': '$198.99',
  '{{discount}}': '$10.00',
  '{{tax}}': '$15.12',
  '{{total}}': '$204.11',
  '{{amountPaid}}': '$0.00',
  '{{notes}}': 'Handle with care, customer VIP.',
  '{{terms}}': 'Net 7 days',
  '{{ticketNumber}}': 'TKT-2026-042',
  '{{deviceName}}': 'iPhone 15 Pro',
  '{{imei}}': '352789102345678',
  '{{issueDescription}}': 'Cracked screen, touch not responding on left side',
  '{{priority}}': 'High',
  '{{estimatedTime}}': '45 min',
  '{{technicianName}}': 'Sarah Johnson',
  '{{itemName}}': 'iPhone 13 Screen',
  '{{sku}}': 'IP13-SCR-001',
  '{{price}}': '$89.00',
  '{{category}}': 'Parts',
  '{{barcode}}': '||||||||||||||',
  '{{receiptNumber}}': 'RCT-2026-088',
  '{{date}}': '2026-03-28',
  '{{estimateNumber}}': 'EST-2026-015',
  '{{lineItems}}': `<table style="width: 100%; font-size: 10pt; border-collapse: collapse; margin-bottom: 16px;">
<thead><tr style="border-bottom: 2px solid #003633;"><th style="padding: 8px 4px; text-align: left; font-size: 8pt; text-transform: uppercase;">Description</th><th style="padding: 8px 4px; text-align: center; font-size: 8pt; text-transform: uppercase; width: 60px;">Qty</th><th style="padding: 8px 4px; text-align: right; font-size: 8pt; text-transform: uppercase; width: 90px;">Price</th><th style="padding: 8px 4px; text-align: right; font-size: 8pt; text-transform: uppercase; width: 90px;">Amount</th></tr></thead>
<tbody><tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 4px;">iPhone 13 Screen Repair</td><td style="padding: 8px 4px; text-align: center;">1</td><td style="padding: 8px 4px; text-align: right;">$189.00</td><td style="padding: 8px 4px; text-align: right; font-weight: 700;">$189.00</td></tr>
<tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 4px;">Tempered Glass Protector</td><td style="padding: 8px 4px; text-align: center;">1</td><td style="padding: 8px 4px; text-align: right;">$9.99</td><td style="padding: 8px 4px; text-align: right; font-weight: 700;">$9.99</td></tr></tbody></table>`,
};

interface TemplateEditorProps {
  template: DocumentTemplate;
  onSave: (content: string) => void;
  onReset: () => void;
  onClose: () => void;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  onLogoUpload: (dataUrl: string) => void;
  onLogoRemove: () => void;
  onLogoPlacementChange: (placement: LogoPlacement) => void;
}

export default function TemplateEditor({ template, onSave, onReset, onClose, logoUrl, logoPlacement, onLogoUpload, onLogoRemove, onLogoPlacementChange }: TemplateEditorProps) {
  const [content, setContent] = useState(template.content);
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [showMacros, setShowMacros] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [activePanel, setActivePanel] = useState<'tags' | 'branding'>('tags');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setContent(template.content);
    setHasChanges(false);
  }, [template.id, template.content]);

  const macros = useMemo(() => TEMPLATE_MACROS[template.type] || [], [template.type]);
  const macroCategories = useMemo(() => {
    const cats = new Map<string, TemplateMacro[]>();
    macros.forEach(m => {
      const list = cats.get(m.category) || [];
      list.push(m);
      cats.set(m.category, list);
    });
    return cats;
  }, [macros]);

  const activeTags = useMemo(() => {
    const active = new Set<string>();
    macros.forEach(m => {
      if (m.tag === '{{brandColor}}') return;
      const conditionalPattern = new RegExp(`\\{\\{#if\\s+${m.tag.replace(/[{}]/g, '').replace(/[.*+?^$|()[\]\\]/g, '\\$&')}\\}\\}`);
      if (content.includes(m.tag) || conditionalPattern.test(content)) {
        active.add(m.tag);
      }
    });
    return active;
  }, [content, macros]);

  const previewHtml = useMemo(() => {
    let html = content;
    html = html.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, inner) => {
      const val = SAMPLE_DATA[`{{${key}}}`];
      return val && val !== '$0.00' ? inner : '';
    });
    Object.entries(SAMPLE_DATA).forEach(([tag, val]) => {
      html = html.split(tag).join(val);
    });
    if (logoUrl) {
      const logoHtml = `<img src="${logoUrl}" alt="Store Logo" style="max-height: 48px; max-width: 160px; object-fit: contain;" />`;
      const justify = logoPlacement === 'top-left' ? 'flex-start' : logoPlacement === 'top-center' ? 'center' : 'flex-end';
      const logoBlock = `<div style="display: flex; justify-content: ${justify}; margin-bottom: 12px;">${logoHtml}</div>`;
      html = logoBlock + html;
    }
    return html;
  }, [content, logoUrl, logoPlacement]);

  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent);
    setHasChanges(true);
  }, []);

  const REGION_WRAPPERS: Record<string, { before: string; after: string }> = useMemo(() => ({
    header: {
      before: '<div style="margin-bottom: 8px;">',
      after: '</div>'
    },
    billing: {
      before: '<div style="margin-bottom: 8px;">',
      after: '</div>'
    },
    body: {
      before: '',
      after: ''
    },
    totals: {
      before: '<div style="display: flex; justify-content: space-between; padding: 4px 0;">',
      after: '</div>'
    },
    footer: {
      before: '<div style="margin-top: 12px; border-top: 1px solid #e2e8f0; padding-top: 12px;">',
      after: '</div>'
    },
  }), []);

  const toggleTag = useCallback((macro: TemplateMacro) => {
    if (macro.tag === '{{brandColor}}') return;

    const isActive = activeTags.has(macro.tag);

    if (isActive) {
      let newContent = content;
      const conditionalKey = macro.tag.replace(/[{}]/g, '');
      const conditionalRegex = new RegExp(`\\{\\{#if\\s+${conditionalKey.replace(/[.*+?^$|()[\]\\]/g, '\\$&')}\\}\\}[\\s\\S]*?\\{\\{\\/if\\}\\}\\n?`, 'g');
      newContent = newContent.replace(conditionalRegex, '');

      const region = TAG_REGION_MAP[macro.category] || 'body';
      const wrapper = REGION_WRAPPERS[region];
      if (wrapper.before) {
        const wrappedTag = `${wrapper.before}<span style="font-weight: 700;">${macro.label}:</span> ${macro.tag}${wrapper.after}\n`;
        newContent = newContent.replace(wrappedTag, '');
      }

      const lineRegex = new RegExp(`[^\\n]*${macro.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n?`, 'g');
      newContent = newContent.replace(lineRegex, '');

      newContent = newContent.replace(/\n{3,}/g, '\n\n');
      handleContentChange(newContent);
    } else {
      if (mode === 'source' && textareaRef.current) {
        const ta = textareaRef.current;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const region = TAG_REGION_MAP[macro.category] || 'body';
        const wrapper = REGION_WRAPPERS[region];
        let insertion: string;
        if (macro.category === 'Extra') {
          const key = macro.tag.replace(/[{}]/g, '');
          insertion = `{{#if ${key}}}${wrapper.before}<p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">${macro.label}</p><p>${macro.tag}</p>${wrapper.after}{{/if}}\n`;
        } else if (macro.tag === '{{lineItems}}') {
          insertion = `${macro.tag}\n`;
        } else {
          insertion = `${wrapper.before}<span style="font-weight: 700;">${macro.label}:</span> ${macro.tag}${wrapper.after}\n`;
        }
        const newContent = content.substring(0, start) + insertion + content.substring(end);
        handleContentChange(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(start + insertion.length, start + insertion.length);
        }, 0);
      } else {
        const region = TAG_REGION_MAP[macro.category] || 'body';
        const wrapper = REGION_WRAPPERS[region];
        let insertion: string;
        if (macro.category === 'Extra') {
          const key = macro.tag.replace(/[{}]/g, '');
          insertion = `\n{{#if ${key}}}${wrapper.before}<p style="font-weight: 700; color: #94a3b8; font-size: 10px; text-transform: uppercase;">${macro.label}</p><p>${macro.tag}</p>${wrapper.after}{{/if}}`;
        } else if (macro.tag === '{{lineItems}}') {
          insertion = `\n${macro.tag}`;
        } else {
          insertion = `\n${wrapper.before}<span style="font-weight: 700;">${macro.label}:</span> ${macro.tag}${wrapper.after}`;
        }

        const closingDivIndex = content.lastIndexOf('</div>');
        let insertionPoint = closingDivIndex;

        if (region === 'header') {
          const headerEnd = content.indexOf('</div>', content.indexOf('</div>') + 1);
          insertionPoint = headerEnd > 0 ? headerEnd : closingDivIndex;
        } else if (region === 'totals') {
          const totalsMarker = content.lastIndexOf('Total');
          if (totalsMarker > 0) {
            const nextDiv = content.indexOf('</div>', totalsMarker);
            insertionPoint = nextDiv > 0 ? nextDiv + 6 : closingDivIndex;
          }
        } else if (region === 'footer') {
          insertionPoint = closingDivIndex;
        }

        if (insertionPoint < 0) insertionPoint = content.length;

        const newContent = content.substring(0, insertionPoint) + insertion + content.substring(insertionPoint);
        handleContentChange(newContent);
      }
    }
  }, [content, activeTags, mode, handleContentChange, REGION_WRAPPERS]);

  const handleSave = useCallback(() => {
    onSave(content);
    setHasChanges(false);
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 2000);
  }, [content, onSave]);

  const handleReset = useCallback(() => {
    onReset();
    setShowResetConfirm(false);
    setHasChanges(false);
  }, [onReset]);

  const handleLogoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (dataUrl) onLogoUpload(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [onLogoUpload]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-7xl h-[90vh] bg-white rounded-[2rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
        
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h3 className="text-xl font-black text-primary tracking-tight">{template.name}</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
                {template.isDefault ? 'Default Template' : `Modified ${new Date(template.updatedAt).toLocaleDateString()}`}
              </p>
            </div>
            {hasChanges && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[8px] font-black uppercase tracking-widest rounded">Unsaved</span>}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-slate-100 rounded-xl p-0.5">
              <button onClick={() => setMode('visual')} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${mode === 'visual' ? 'bg-white text-primary shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Preview</button>
              <button onClick={() => setMode('source')} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${mode === 'source' ? 'bg-white text-primary shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Source</button>
            </div>
            <button onClick={() => setShowMacros(!showMacros)} className={`p-2 rounded-xl transition-all ${showMacros ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400 hover:text-primary'}`}>
              <span className="material-symbols-outlined text-sm">tune</span>
            </button>
            <button onClick={() => setShowResetConfirm(true)} className="px-4 py-2 bg-slate-100 text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">restart_alt</span> Reset
            </button>
            <button onClick={handleSave} disabled={!hasChanges} className={`px-6 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center gap-1.5 ${savedFeedback ? 'bg-emerald-500 text-white' : hasChanges ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}>
              <span className="material-symbols-outlined text-sm">{savedFeedback ? 'check' : 'save'}</span> {savedFeedback ? 'Saved!' : 'Save'}
            </button>
            <button onClick={onClose} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
              <span className="material-symbols-outlined text-slate-400">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto">
            {mode === 'visual' ? (
              <div className="p-8">
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                  <div className="p-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    <span className="ml-2 text-[9px] font-bold text-slate-400 uppercase tracking-widest">Preview with Sample Data</span>
                  </div>
                  <div className="p-8" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </div>
              </div>
            ) : (
              <div className="h-full p-4">
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full font-mono text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-2xl p-6 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          <AnimatePresence>
            {showMacros && (
              <motion.div initial={{ width: 0, opacity: 0 }} animate={{ width: 300, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.2 }}
                className="border-l border-slate-100 bg-slate-50/50 overflow-y-auto shrink-0 flex flex-col">
                <div className="p-3 border-b border-slate-100 flex gap-1">
                  <button onClick={() => setActivePanel('tags')}
                    className={`flex-1 py-2 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${activePanel === 'tags' ? 'bg-primary text-white' : 'text-slate-400 hover:bg-slate-100'}`}>
                    Tags
                  </button>
                  <button onClick={() => setActivePanel('branding')}
                    className={`flex-1 py-2 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${activePanel === 'branding' ? 'bg-primary text-white' : 'text-slate-400 hover:bg-slate-100'}`}>
                    Branding
                  </button>
                </div>

                {activePanel === 'tags' ? (
                  <div className="p-4 flex-1 overflow-y-auto">
                    <p className="text-[9px] font-medium text-slate-400 mb-4">Toggle tags on/off. Active tags are highlighted and appear in the template.</p>
                    {Array.from(macroCategories.entries()).map(([category, items]) => (
                      <div key={category} className="mb-4">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">{category}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {items.map(macro => {
                            const isActive = activeTags.has(macro.tag);
                            const isBrandColor = macro.tag === '{{brandColor}}';
                            return (
                              <button
                                key={macro.tag}
                                onClick={() => toggleTag(macro)}
                                disabled={isBrandColor}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                                  isBrandColor
                                    ? 'bg-slate-50 text-slate-300 border-slate-100 cursor-default'
                                    : isActive
                                    ? 'bg-primary text-white border-primary shadow-sm shadow-primary/20'
                                    : 'bg-white text-slate-500 border-slate-200 hover:border-primary/40 hover:text-primary'
                                }`}
                              >
                                {macro.label}
                                {isActive && !isBrandColor && (
                                  <span className="ml-1 opacity-70">✓</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 flex-1 overflow-y-auto space-y-6">
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3">Store Logo</p>
                      {logoUrl ? (
                        <div className="space-y-3">
                          <div className="w-full aspect-[3/1] bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-center p-3 overflow-hidden">
                            <img src={logoUrl} alt="Store logo" className="max-h-full max-w-full object-contain" />
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => fileInputRef.current?.click()} className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all">
                              Change
                            </button>
                            <button onClick={onLogoRemove} className="flex-1 py-2 bg-rose-50 text-rose-600 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-rose-100 transition-all">
                              Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => fileInputRef.current?.click()}
                          className="w-full py-8 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 hover:border-primary hover:text-primary transition-all flex flex-col items-center gap-2">
                          <span className="material-symbols-outlined text-2xl">upload</span>
                          <span className="text-[9px] font-black uppercase tracking-widest">Upload Logo</span>
                        </button>
                      )}
                      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                    </div>
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3">Logo Placement</p>
                      <div className="space-y-2">
                        {([
                          { value: 'top-left' as LogoPlacement, label: 'Top Left', icon: 'align_horizontal_left' },
                          { value: 'top-center' as LogoPlacement, label: 'Top Center', icon: 'align_horizontal_center' },
                          { value: 'top-right' as LogoPlacement, label: 'Top Right', icon: 'align_horizontal_right' },
                        ]).map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => onLogoPlacementChange(opt.value)}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                              logoPlacement === opt.value
                                ? 'bg-primary/5 border-primary/30 text-primary'
                                : 'bg-white border-slate-200 text-slate-500 hover:border-primary/20'
                            }`}
                          >
                            <span className="material-symbols-outlined text-sm">{opt.icon}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest">{opt.label}</span>
                            {logoPlacement === opt.value && <span className="material-symbols-outlined text-sm ml-auto">check</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {showResetConfirm && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/20" onClick={() => setShowResetConfirm(false)} />
              <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                className="relative bg-white rounded-2xl shadow-2xl p-8 max-w-sm">
                <h4 className="text-lg font-black text-primary mb-2">Reset Template?</h4>
                <p className="text-sm text-slate-500 mb-6">This will restore the template to its default content, including all tags, layout, and branding settings. Any customizations will be lost.</p>
                <div className="flex gap-3">
                  <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button onClick={handleReset} className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-rose-600 transition-all shadow-lg shadow-rose-500/20">Reset</button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
