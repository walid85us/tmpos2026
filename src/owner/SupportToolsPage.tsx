import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants,
  supportCases as supportCasesSeed,
  type SupportCaseRecord,
  type SupportCaseStatus,
  type SupportCaseSeverity,
  type SupportCaseNote,
} from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';

const CASES_KEY = 'support_cases_v1';

const STATUS_LABELS: Record<SupportCaseStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_customer: 'Waiting Customer',
  resolved: 'Resolved',
  closed: 'Closed',
};

const STATUS_STYLES: Record<SupportCaseStatus, string> = {
  open: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  in_progress: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  waiting_customer: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  resolved: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  closed: 'bg-slate-200 text-slate-600 border-slate-300',
};

const SEVERITY_STYLES: Record<SupportCaseSeverity, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  normal: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  high: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  urgent: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const SEVERITY_TO_AUDIT: Record<SupportCaseSeverity, 'info' | 'notice' | 'warning' | 'critical'> = {
  low: 'info',
  normal: 'info',
  high: 'warning',
  urgent: 'critical',
};

const loadCases = (): SupportCaseRecord[] => {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [...supportCasesSeed];
    const raw = window.sessionStorage.getItem(CASES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SupportCaseRecord[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* noop */ }
  return [...supportCasesSeed];
};

const saveCases = (cases: SupportCaseRecord[]) => {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(CASES_KEY, JSON.stringify(cases));
    }
  } catch { /* noop */ }
};

const SupportToolsPage: React.FC = () => {
  const [cases, setCases] = useState<SupportCaseRecord[]>(() => loadCases());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SupportCaseStatus>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const [draft, setDraft] = useState({
    tenantId: '',
    subject: '',
    description: '',
    severity: 'normal' as SupportCaseSeverity,
  });

  useEffect(() => { saveCases(cases); }, [cases]);

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  const filteredCases = useMemo(() => {
    return cases.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (search.trim()) {
        const tenantName = tenantById.get(c.tenantId) || '';
        const hay = `${c.subject} ${c.description} ${tenantName} ${c.id}`.toLowerCase();
        if (!hay.includes(search.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [cases, statusFilter, search, tenantById]);

  const tenantSearchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return tenants.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      t.subdomain.toLowerCase().includes(q) ||
      (t.customDomain || '').toLowerCase().includes(q)
    ).slice(0, 5);
  }, [search]);

  const selected = useMemo(
    () => cases.find(c => c.id === selectedId) || null,
    [cases, selectedId]
  );

  const handleImpersonate = (tenantId: string) => {
    setImpersonating(tenantId);
    setTimeout(() => setImpersonating(null), 1800);
  };

  const handleCreate = () => {
    if (!draft.tenantId || !draft.subject.trim()) return;
    const now = new Date();
    const newCase: SupportCaseRecord = {
      id: `case_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: draft.tenantId,
      subject: draft.subject.trim(),
      description: draft.description.trim(),
      status: 'open',
      severity: draft.severity,
      assignee: null,
      openedAt: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString().slice(0, 10),
      notes: [],
    };
    setCases(prev => [newCase, ...prev]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_created',
      target: `${tenantById.get(draft.tenantId) || draft.tenantId} · ${newCase.subject}`,
      category: 'support',
      tenantId: draft.tenantId,
      severity: SEVERITY_TO_AUDIT[draft.severity],
      note: newCase.description || undefined,
    });
    setDraft({ tenantId: '', subject: '', description: '', severity: 'normal' });
    setShowCreate(false);
    setSelectedId(newCase.id);
  };

  const updateCase = (id: string, patch: Partial<SupportCaseRecord>, audit?: () => void) => {
    setCases(prev => prev.map(c => c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString().slice(0, 10) } : c));
    if (audit) audit();
  };

  const addNote = (id: string, body: string) => {
    if (!body.trim()) return;
    const note: SupportCaseNote = {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: body.trim(),
      createdAt: new Date().toISOString(),
      kind: 'note',
    };
    updateCase(id, {
      notes: [...(cases.find(c => c.id === id)?.notes || []), note],
    });
    const c = cases.find(x => x.id === id);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_note_added',
      target: `${c ? tenantById.get(c.tenantId) || c.tenantId : '—'} · ${id}`,
      category: 'support',
      tenantId: c?.tenantId,
      severity: 'info',
      note: note.body,
    });
  };

  const changeStatus = (c: SupportCaseRecord, next: SupportCaseStatus) => {
    if (c.status === next) return;
    const transitionNote: SupportCaseNote = {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Status: ${c.status} → ${next}`,
      createdAt: new Date().toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, { status: next, notes: [...c.notes, transitionNote] });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_status_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.status,
      newValue: next,
      severity: next === 'closed' || next === 'resolved' ? 'info' : 'notice',
    });
  };

  const changeSeverity = (c: SupportCaseRecord, next: SupportCaseSeverity) => {
    if (c.severity === next) return;
    updateCase(c.id, { severity: next });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_severity_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.severity,
      newValue: next,
      severity: SEVERITY_TO_AUDIT[next],
    });
  };

  const changeAssignee = (c: SupportCaseRecord, next: string) => {
    const assignee = next.trim() || null;
    if (assignee === c.assignee) return;
    updateCase(c.id, { assignee });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_assignee_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.assignee || '—',
      newValue: assignee || '—',
      severity: 'info',
    });
  };

  const flaggedTenants = tenants.filter(t => t.flags.length > 0);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Support Tools</h2>
          <p className="text-slate-500 font-medium">Tenant search, case management, and operational helpers.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all">+ New Case</button>
      </div>

      {/* Tenant search */}
      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
        <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-3">Tenant Search</h3>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by tenant name, ID, subdomain, or custom domain…"
          className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
        />
        {tenantSearchHits.length > 0 && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            {tenantSearchHits.map(t => (
              <div key={t.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-bold text-slate-900">{t.name}</p>
                  <p className="text-[10px] text-slate-500 font-bold">{t.id} · {t.subdomain}{t.customDomain ? ` · ${t.customDomain}` : ''}</p>
                </div>
                <button
                  onClick={() => { setDraft(d => ({ ...d, tenantId: t.id })); setShowCreate(true); }}
                  className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors"
                >
                  Open Case
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cases */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between gap-4 flex-wrap">
          <h3 className="text-lg font-black text-primary tracking-tight">Support Cases</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${statusFilter === s ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Case</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Assignee</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filteredCases.map(c => (
              <tr key={c.id} onClick={() => setSelectedId(c.id)} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                <td className="px-6 py-3.5">
                  <p className="text-sm font-bold text-slate-900 truncate max-w-[260px]">{c.subject}</p>
                  <p className="text-[10px] text-slate-400 font-mono">{c.id}</p>
                </td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{tenantById.get(c.tenantId) || c.tenantId}</td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_STYLES[c.status]}`}>{STATUS_LABELS[c.status]}</span></td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[c.severity]}`}>{c.severity}</span></td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-600">{c.assignee || '—'}</td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-500 whitespace-nowrap">{c.updatedAt}</td>
              </tr>
            ))}
            {filteredCases.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">No support cases match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Active Support Flags */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-lg font-black text-primary tracking-tight">Active Support Flags</h3>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Impersonate is a dev-only stub — no real session is started.</span>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Flag</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {flaggedTenants.map(tenant => (
              <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 font-bold text-slate-900">{tenant.name}</td>
                <td className="px-8 py-4 text-sm font-bold text-red-600">{tenant.flags.join(', ')}</td>
                <td className="px-8 py-4 text-right">
                  <button
                    onClick={() => handleImpersonate(tenant.id)}
                    className={`px-4 py-2 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 ${impersonating === tenant.id ? 'bg-emerald-500 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
                  >
                    {impersonating === tenant.id ? 'Stub Acknowledged' : 'Impersonate (stub)'}
                  </button>
                </td>
              </tr>
            ))}
            {flaggedTenants.length === 0 && (
              <tr><td colSpan={3} className="px-8 py-8 text-center text-slate-400 text-sm font-bold">No tenants currently flagged.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create Case modal */}
      <AnimatePresence>
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreate(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">New Support Case</h3>
                <button onClick={() => setShowCreate(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={draft.tenantId} onChange={e => setDraft(d => ({ ...d, tenantId: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="">Select tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subject</label>
                  <input value={draft.subject} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder="Short summary…" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                  <select value={draft.severity} onChange={e => setDraft(d => ({ ...d, severity: e.target.value as SupportCaseSeverity }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Description</label>
                  <textarea value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 h-28 resize-none" placeholder="Provide context, repro steps, contacts…" />
                </div>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !draft.subject.trim()} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 transition-all">Create Case</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedId(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-lg h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <div className="p-7 border-b border-slate-100 flex justify-between items-start">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{selected.id}</p>
                  <h3 className="text-lg font-black text-primary mt-1">{selected.subject}</h3>
                  <p className="text-xs text-slate-500 font-bold mt-1">{tenantById.get(selected.tenantId) || selected.tenantId}</p>
                </div>
                <button onClick={() => setSelectedId(null)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
                    <select value={selected.status} onChange={e => changeStatus(selected, e.target.value as SupportCaseStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as SupportCaseStatus[]).map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                    <select value={selected.severity} onChange={e => changeSeverity(selected, e.target.value as SupportCaseSeverity)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['low', 'normal', 'high', 'urgent'] as SupportCaseSeverity[]).map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Assignee</label>
                    <input
                      defaultValue={selected.assignee || ''}
                      onBlur={e => changeAssignee(selected, e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                      placeholder="Unassigned"
                    />
                  </div>
                </div>

                {selected.description && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Description</p>
                    <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-2xl whitespace-pre-wrap">{selected.description}</p>
                  </div>
                )}

                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Timeline ({selected.notes.length})</p>
                  <NotesTimeline notes={selected.notes} />
                </div>

                <AddNoteRow onAdd={body => addNote(selected.id, body)} />

                <div className="text-[10px] text-slate-400 pt-4 border-t border-slate-100 grid grid-cols-2 gap-2">
                  <div>Opened: <span className="font-bold text-slate-600">{selected.openedAt}</span></div>
                  <div>Updated: <span className="font-bold text-slate-600">{selected.updatedAt}</span></div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const NotesTimeline: React.FC<{ notes: SupportCaseNote[] }> = ({ notes }) => {
  if (notes.length === 0) return <p className="text-xs text-slate-400 font-bold py-4 text-center bg-slate-50 rounded-2xl">No notes yet.</p>;
  return (
    <div className="space-y-2">
      {notes.map(n => (
        <div key={n.id} className={`p-3 rounded-xl border ${n.kind === 'status_change' ? 'bg-blue-400/5 border-blue-400/20' : 'bg-slate-50 border-slate-100'}`}>
          <p className="text-sm text-slate-700">{n.body}</p>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">{n.author} · {new Date(n.createdAt).toLocaleString()}</p>
        </div>
      ))}
    </div>
  );
};

const AddNoteRow: React.FC<{ onAdd: (body: string) => void }> = ({ onAdd }) => {
  const [body, setBody] = useState('');
  return (
    <div className="flex gap-2">
      <input
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { onAdd(body); setBody(''); } }}
        placeholder="Add internal note…"
        className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-700"
      />
      <button onClick={() => { onAdd(body); setBody(''); }} disabled={!body.trim()} className="px-4 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 disabled:opacity-40 transition-all">Add</button>
    </div>
  );
};

export default SupportToolsPage;
