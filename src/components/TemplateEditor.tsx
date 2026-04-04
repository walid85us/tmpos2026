import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { DocumentTemplate, LogoPlacement } from '../types';
import { getSlots, buildTemplateHtml, getDefaultEnabledTags } from '../utils/templateBuilder';

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
  onSave: (content: string, enabledTags: string[]) => void;
  onReset: () => void;
  onClose: () => void;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  onLogoUpload: (dataUrl: string) => void;
  onLogoRemove: () => void;
  onLogoPlacementChange: (placement: LogoPlacement) => void;
}

export default function TemplateEditor({ template, onSave, onReset, onClose, logoUrl, logoPlacement, onLogoUpload, onLogoRemove, onLogoPlacementChange }: TemplateEditorProps) {
  const [enabledTags, setEnabledTags] = useState<Set<string>>(new Set(template.enabledTags));
  const [content, setContent] = useState(template.content);
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [showMacros, setShowMacros] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [activePanel, setActivePanel] = useState<'tags' | 'branding'>('tags');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEnabledTags(new Set(template.enabledTags));
    setContent(template.content);
    setHasChanges(false);
  }, [template.id, template.content, template.enabledTags]);

  const slots = useMemo(() => getSlots(template.type), [template.type]);

  const slotCategories = useMemo(() => {
    const cats = new Map<string, typeof slots>();
    slots.forEach(s => {
      const list = cats.get(s.category) || [];
      list.push(s);
      cats.set(s.category, list);
    });
    return cats;
  }, [slots]);

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

  const toggleTag = useCallback((tag: string) => {
    const next = new Set(enabledTags);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    setEnabledTags(next);
    const newContent = buildTemplateHtml(template.type, Array.from(next));
    setContent(newContent);
    setHasChanges(true);
  }, [template.type, enabledTags]);

  const handleSourceChange = useCallback((newContent: string) => {
    setContent(newContent);
    setHasChanges(true);
  }, []);

  const handleSave = useCallback(() => {
    onSave(content, Array.from(enabledTags));
    setHasChanges(false);
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 2000);
  }, [content, enabledTags, onSave]);

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
                  onChange={(e) => handleSourceChange(e.target.value)}
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
                    <p className="text-[9px] font-medium text-slate-400 mb-4">Toggle tags on/off. Active tags are highlighted. Toggling regenerates the template with tags in their correct positions.</p>
                    {Array.from(slotCategories.entries()).map(([category, items]) => (
                      <div key={category} className="mb-4">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">{category}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {items.map(slot => {
                            const isActive = enabledTags.has(slot.tag);
                            return (
                              <button
                                key={slot.tag}
                                onClick={() => toggleTag(slot.tag)}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                                  isActive
                                  ? 'bg-primary text-white border-primary shadow-sm shadow-primary/20'
                                  : 'bg-white text-slate-500 border-slate-200 hover:border-primary/40 hover:text-primary'
                                }`}
                              >
                                {slot.label}
                                {isActive && (
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
