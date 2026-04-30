import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { auditLogs, tenants, tenantDomains, supportCases } from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';

type Severity = 'info' | 'notice' | 'warning' | 'critical';

type AuditRow = {
  id: string;
  date: string;
  actor: string;
  action: string;
  target: string;
  severity: string;
  category?: string;
  tenantId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
};

type SecurityNote = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
};

const NOTES_KEY = 'platform_security_notes';

const SEVERITY_STYLES: Record<Severity, string> = {
  info: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  notice: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  warning: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const normalizeSeverity = (s: string): Severity => {
  if (s === 'notice' || s === 'warning' || s === 'critical') return s;
  return 'info';
};

const AuditSecurityPage: React.FC = () => {
  // Mirrored cross-cutting audit entries (commercial + platform ops).
  const [mirrored, setMirrored] = useState<AuditRow[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return;
        const raw = window.sessionStorage.getItem('audit_logs');
        if (!raw) { setMirrored([]); return; }
        const arr = JSON.parse(raw) as AuditRow[];
        setMirrored(Array.isArray(arr) ? arr : []);
      } catch { setMirrored([]); }
    };
    read();
    window.addEventListener('audit_logs:changed', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('audit_logs:changed', read);
      window.removeEventListener('storage', read);
    };
  }, []);

  // Persistent platform security notes (sessionStorage).
  const [notes, setNotes] = useState<SecurityNote[]>([]);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(NOTES_KEY);
      if (raw) setNotes(JSON.parse(raw));
    } catch { /* noop */ }
  }, []);
  const persistNotes = (next: SecurityNote[]) => {
    setNotes(next);
    try { window.sessionStorage.setItem(NOTES_KEY, JSON.stringify(next)); } catch { /* noop */ }
  };

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'commercial' | 'security' | 'support' | 'configuration' | 'domains' | 'team' | 'other'>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState('');
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [newNoteBody, setNewNoteBody] = useState('');

  const allRows = useMemo<AuditRow[]>(() => {
    const seedIds = new Set(auditLogs.map(l => l.id));
    const merged: AuditRow[] = [
      ...mirrored.filter(m => !seedIds.has(m.id)),
      ...auditLogs.map(l => ({ ...l })),
    ];
    return merged.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [mirrored]);

  const visibleRows = useMemo(() => {
    return allRows.filter(r => {
      if (categoryFilter !== 'all') {
        if (categoryFilter === 'other') {
          if (['commercial', 'security', 'support', 'configuration', 'domains', 'team'].includes(r.category || '')) return false;
        } else if (r.category !== categoryFilter) {
          return false;
        }
      }
      if (severityFilter !== 'all' && normalizeSeverity(r.severity) !== severityFilter) return false;
      if (tenantFilter !== 'all' && (r.tenantId || '') !== tenantFilter) return false;
      if (searchText.trim()) {
        const hay = `${r.action} ${r.target} ${r.actor} ${r.note || ''}`.toLowerCase();
        if (!hay.includes(searchText.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [allRows, categoryFilter, severityFilter, tenantFilter, searchText]);

  const sslCoverage = useMemo(() => {
    const total = tenantDomains.length;
    const active = tenantDomains.filter(d => d.ssl === 'active').length;
    return { total, active, pct: total ? Math.round((active / total) * 100) : 0 };
  }, []);

  const openCases = useMemo(
    () => supportCases.filter(c => c.status !== 'closed' && c.status !== 'resolved').length,
    []
  );

  const recentCritical = useMemo(
    () => allRows.filter(r => normalizeSeverity(r.severity) === 'critical' || normalizeSeverity(r.severity) === 'warning').slice(0, 5).length,
    [allRows]
  );

  const addNote = () => {
    const body = newNoteBody.trim();
    if (!body) return;
    const note: SecurityNote = {
      id: `sn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      body,
      author: 'System Owner',
      createdAt: new Date().toISOString(),
    };
    persistNotes([note, ...notes]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'security_note_added',
      target: body.length > 60 ? `${body.slice(0, 60)}…` : body,
      category: 'security',
      severity: 'notice',
    });
    setNewNoteBody('');
  };

  const deleteNote = (id: string) => {
    const target = notes.find(n => n.id === id);
    persistNotes(notes.filter(n => n.id !== id));
    if (target) {
      pushPlatformAudit({
        actor: 'System Owner',
        action: 'security_note_deleted',
        target: target.body.length > 60 ? `${target.body.slice(0, 60)}…` : target.body,
        category: 'security',
      });
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Audit & Security</h2>
        <p className="text-slate-500 font-medium">Monitor platform activity, security posture, and recent events.</p>
      </div>

      {/* Posture cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Auth Governance</p>
          <p className="text-2xl font-black text-primary mb-1">Directory only</p>
          <p className="text-xs font-medium text-slate-500">SSO / MFA not enforced by app — see Platform Settings.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">SSL Coverage</p>
          <p className="text-2xl font-black text-primary mb-1">{sslCoverage.active}/{sslCoverage.total} <span className="text-sm text-slate-400">({sslCoverage.pct}%)</span></p>
          <p className="text-xs font-medium text-slate-500">Domains with active SSL — manual workflow.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Open Support Cases</p>
          <p className="text-2xl font-black text-primary mb-1">{openCases}</p>
          <p className="text-xs font-medium text-slate-500">Cases not yet resolved or closed.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Elevated Events (recent)</p>
          <p className="text-2xl font-black text-primary mb-1">{recentCritical}</p>
          <p className="text-xs font-medium text-slate-500">Warning + critical entries in audit stream.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search action, target, actor…"
            className="flex-1 min-w-[200px] px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
          />
          <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value as any)} className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black uppercase tracking-widest text-slate-600">
            <option value="all">All severities</option>
            <option value="info">Info</option>
            <option value="notice">Notice</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select value={tenantFilter} onChange={e => setTenantFilter(e.target.value)} className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black uppercase tracking-widest text-slate-600">
            <option value="all">All tenants</option>
            {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'commercial', 'security', 'support', 'configuration', 'domains', 'team', 'other'] as const).map(c => (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              className={`px-3.5 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${categoryFilter === c ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(log => {
              const sev = normalizeSeverity(log.severity);
              return (
                <tr key={log.id} onClick={() => setSelected(log)} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-600 whitespace-nowrap">{log.date}</td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{log.actor}</td>
                  <td className="px-6 py-3.5 text-sm text-slate-600">{log.action}</td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{log.target}</td>
                  <td className="px-6 py-3.5">
                    {log.category ? (
                      <span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">{log.category}</span>
                    ) : (
                      <span className="text-[10px] text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3.5">
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[sev]}`}>{sev}</span>
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">No audit entries match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Security Notes panel */}
      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-end justify-between mb-4">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Security Notes</h3>
            <p className="text-xs text-slate-500 font-medium">Internal posture / incident notes. Persisted per browser session and audited.</p>
          </div>
        </div>
        <div className="flex gap-2 mb-4">
          <input
            value={newNoteBody}
            onChange={e => setNewNoteBody(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addNote(); }}
            placeholder="Add a security note…"
            className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
          />
          <button onClick={addNote} disabled={!newNoteBody.trim()} className="px-5 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest disabled:opacity-40 hover:bg-primary/90 transition-all">Add Note</button>
        </div>
        <div className="space-y-2">
          {notes.length === 0 && <p className="text-xs text-slate-400 font-bold py-4 text-center">No security notes yet.</p>}
          {notes.map(n => (
            <div key={n.id} className="flex items-start justify-between gap-4 p-4 bg-slate-50 rounded-2xl">
              <div className="flex-1">
                <p className="text-sm text-slate-700 font-medium">{n.body}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">{n.author} · {new Date(n.createdAt).toLocaleString()}</p>
              </div>
              <button onClick={() => deleteNote(n.id)} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-600 transition-colors">Delete</button>
            </div>
          ))}
        </div>
      </div>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelected(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-md h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <div className="p-8 border-b border-slate-100 flex justify-between items-start">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Audit Event</p>
                  <h3 className="text-xl font-black text-primary mt-1">{selected.action}</h3>
                </div>
                <button onClick={() => setSelected(null)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-8 space-y-4">
                <Row label="Date" value={selected.date} />
                <Row label="Actor" value={selected.actor} />
                <Row label="Target" value={selected.target} />
                <Row label="Category" value={selected.category || '—'} />
                <Row label="Severity">
                  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[normalizeSeverity(selected.severity)]}`}>{normalizeSeverity(selected.severity)}</span>
                </Row>
                {selected.tenantId && <Row label="Tenant" value={selected.tenantId} />}
                {selected.oldValue != null && <Row label="From" value={String(selected.oldValue)} />}
                {selected.newValue != null && <Row label="To" value={String(selected.newValue)} />}
                {selected.note && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Note</p>
                    <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-2xl">{selected.note}</p>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 font-mono pt-4 border-t border-slate-100">id: {selected.id}</div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Row: React.FC<{ label: string; value?: string; children?: React.ReactNode }> = ({ label, value, children }) => (
  <div className="flex justify-between items-start gap-4">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest pt-1">{label}</span>
    {children ?? <span className="text-sm font-bold text-slate-700 text-right break-words max-w-[60%]">{value}</span>}
  </div>
);

export default AuditSecurityPage;
