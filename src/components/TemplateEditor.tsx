import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { DocumentTemplate, TemplateType, TemplateMacro } from '../types';

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
}

export default function TemplateEditor({ template, onSave, onReset, onClose }: TemplateEditorProps) {
  const [content, setContent] = useState(template.content);
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [showMacros, setShowMacros] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const previewHtml = useMemo(() => {
    let html = content;
    html = html.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, inner) => {
      const val = SAMPLE_DATA[`{{${key}}}`];
      return val && val !== '$0.00' ? inner : '';
    });
    Object.entries(SAMPLE_DATA).forEach(([tag, val]) => {
      html = html.split(tag).join(val);
    });
    return html;
  }, [content]);

  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent);
    setHasChanges(true);
  }, []);

  const insertMacro = useCallback((tag: string) => {
    if (mode === 'source' && textareaRef.current) {
      const ta = textareaRef.current;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newContent = content.substring(0, start) + tag + content.substring(end);
      setContent(newContent);
      setHasChanges(true);
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(start + tag.length, start + tag.length);
      }, 0);
    } else {
      handleContentChange(content + '\n' + tag);
    }
  }, [mode, content, handleContentChange]);

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
              <span className="material-symbols-outlined text-sm">data_object</span>
            </button>
            {!template.isDefault && (
              <button onClick={() => setShowResetConfirm(true)} className="px-4 py-2 bg-slate-100 text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">restart_alt</span> Reset
              </button>
            )}
            <button onClick={handleSave} disabled={!hasChanges} className={`px-6 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center gap-1.5 ${savedFeedback ? 'bg-emerald-500 text-white' : hasChanges ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}>
              <span className="material-symbols-outlined text-sm">{savedFeedback ? 'check' : 'save'}</span> {savedFeedback ? 'Saved!' : 'Save'}
            </button>
            <button onClick={onClose} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
              <span className="material-symbols-outlined text-slate-400">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className={`flex-1 overflow-auto ${showMacros ? '' : ''}`}>
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
              <motion.div initial={{ width: 0, opacity: 0 }} animate={{ width: 280, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.2 }}
                className="border-l border-slate-100 bg-slate-50/50 overflow-y-auto shrink-0">
                <div className="p-4">
                  <h4 className="text-[10px] font-black text-primary uppercase tracking-widest mb-4">Available Tags</h4>
                  <p className="text-[9px] font-medium text-slate-400 mb-4">Click a tag to insert it into the template source code.</p>
                  {Array.from(macroCategories.entries()).map(([category, items]) => (
                    <div key={category} className="mb-4">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">{category}</p>
                      <div className="space-y-1">
                        {items.map(macro => (
                          <button key={macro.tag} onClick={() => insertMacro(macro.tag)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white rounded-xl border border-slate-100 hover:border-primary/30 hover:bg-primary/5 transition-all group text-left">
                            <span className="text-[10px] font-bold text-slate-700 group-hover:text-primary">{macro.label}</span>
                            <code className="text-[8px] font-mono text-slate-400 group-hover:text-primary/60">{macro.tag}</code>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
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
                <p className="text-sm text-slate-500 mb-6">This will restore the template to its default content. Any customizations will be lost.</p>
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
