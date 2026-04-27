import React, { useEffect, useState, useMemo } from 'react';
import { auditLogs } from './mockData';

type AuditRow = {
  id: string;
  date: string;
  actor: string;
  action: string;
  target: string;
  severity: string;
  category?: string;
};

const AuditSecurityPage: React.FC = () => {
  // Merge mirrored commercial audit entries (written by `commercialAudit.ts`
  // into sessionStorage('audit_logs')) with the static seed so System Owner
  // commercial actions surface here without bespoke pages.
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

  const [categoryFilter, setCategoryFilter] = useState<'all' | 'commercial' | 'other'>('all');

  const allRows = useMemo<AuditRow[]>(() => {
    const seedIds = new Set(auditLogs.map(l => l.id));
    const merged: AuditRow[] = [
      ...mirrored.filter(m => !seedIds.has(m.id)),
      ...auditLogs.map(l => ({ ...l })),
    ];
    return merged.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [mirrored]);

  const visibleRows = useMemo(() => {
    if (categoryFilter === 'all') return allRows;
    if (categoryFilter === 'commercial') return allRows.filter(r => r.category === 'commercial');
    return allRows.filter(r => r.category !== 'commercial');
  }, [allRows, categoryFilter]);

  const commercialCount = allRows.filter(r => r.category === 'commercial').length;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Audit & Security</h2>
          <p className="text-slate-500 font-medium">Monitor platform activity and security events.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setCategoryFilter('all')} className={`px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${categoryFilter === 'all' ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}>All ({allRows.length})</button>
          <button onClick={() => setCategoryFilter('commercial')} className={`px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${categoryFilter === 'commercial' ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}>Commercial ({commercialCount})</button>
          <button onClick={() => setCategoryFilter('other')} className={`px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${categoryFilter === 'other' ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}>Other</button>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((log) => (
              <tr key={log.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 text-sm font-bold text-slate-600">{log.date}</td>
                <td className="px-8 py-4 font-bold text-slate-900">{log.actor}</td>
                <td className="px-8 py-4 text-sm text-slate-600">{log.action}</td>
                <td className="px-8 py-4 font-bold text-slate-900">{log.target}</td>
                <td className="px-8 py-4">
                  {log.category ? (
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${log.category === 'commercial' ? 'bg-violet-50 text-violet-700 border-violet-100' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{log.category}</span>
                  ) : (
                    <span className="text-[10px] text-slate-400">—</span>
                  )}
                </td>
                <td className="px-8 py-4">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                    log.severity === 'info' ? 'bg-blue-400/10 text-blue-700 border-blue-400/20' : 'bg-orange-400/10 text-orange-700 border-orange-400/20'
                  }`}>
                    {log.severity}
                  </span>
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">No audit entries match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AuditSecurityPage;
