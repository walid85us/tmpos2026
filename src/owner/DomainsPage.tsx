import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants,
  tenantDomains as tenantDomainsSeed,
  type TenantDomainRecord,
  type DomainStatus,
  type DomainSslStatus,
  type DomainKind,
} from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';

const DOMAINS_KEY = 'tenant_domains_v1';

const STATUS_LABELS: Record<DomainStatus, string> = {
  pending: 'Pending',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Failed',
  disabled: 'Disabled',
};

const STATUS_STYLES: Record<DomainStatus, string> = {
  pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  verifying: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  verified: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  failed: 'bg-red-500/10 text-red-700 border-red-500/30',
  disabled: 'bg-slate-200 text-slate-600 border-slate-300',
};

const SSL_STYLES: Record<DomainSslStatus, string> = {
  none: 'bg-slate-100 text-slate-500 border-slate-200',
  pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  failed: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const loadDomains = (): TenantDomainRecord[] => {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [...tenantDomainsSeed];
    const raw = window.sessionStorage.getItem(DOMAINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TenantDomainRecord[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* noop */ }
  return [...tenantDomainsSeed];
};

const saveDomains = (d: TenantDomainRecord[]) => {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(DOMAINS_KEY, JSON.stringify(d));
    }
  } catch { /* noop */ }
};

const DomainsPage: React.FC = () => {
  const [domains, setDomains] = useState<TenantDomainRecord[]>(() => loadDomains());
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | DomainStatus>('all');
  const [draft, setDraft] = useState({ tenantId: '', hostname: '', kind: 'subdomain' as DomainKind });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { saveDomains(domains); }, [domains]);

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  const visible = useMemo(() => {
    return domains.filter(d => filter === 'all' || d.status === filter);
  }, [domains, filter]);

  const selected = useMemo(() => domains.find(d => d.id === selectedId) || null, [domains, selectedId]);

  const today = new Date().toISOString().slice(0, 10);

  const handleCreate = () => {
    if (!draft.tenantId || !draft.hostname.trim()) return;
    const hostname = draft.hostname.trim().toLowerCase();
    const dup = domains.some(d => d.hostname === hostname);
    if (dup) {
      alert('A domain record with that hostname already exists.');
      return;
    }
    const next: TenantDomainRecord = {
      id: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: draft.tenantId,
      hostname,
      kind: draft.kind,
      status: draft.kind === 'subdomain' ? 'verified' : 'pending',
      ssl: draft.kind === 'subdomain' ? 'active' : 'none',
      createdAt: today,
      verifiedAt: draft.kind === 'subdomain' ? today : null,
      lastCheckedAt: today,
      notes: '',
    };
    setDomains(prev => [next, ...prev]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_created',
      target: `${tenantById.get(draft.tenantId) || draft.tenantId} · ${hostname}`,
      category: 'domains',
      tenantId: draft.tenantId,
      severity: 'info',
      newValue: hostname,
      note: `Kind: ${draft.kind}; initial status: ${next.status}`,
    });
    setDraft({ tenantId: '', hostname: '', kind: 'subdomain' });
    setShowCreate(false);
    setSelectedId(next.id);
  };

  const updateDomain = (id: string, patch: Partial<TenantDomainRecord>) => {
    setDomains(prev => prev.map(d => d.id === id ? { ...d, ...patch, lastCheckedAt: today } : d));
  };

  const setStatus = (d: TenantDomainRecord, next: DomainStatus) => {
    if (d.status === next) return;
    const patch: Partial<TenantDomainRecord> = { status: next };
    if (next === 'verified' && !d.verifiedAt) patch.verifiedAt = today;
    updateDomain(d.id, patch);
    pushPlatformAudit({
      actor: 'System Owner',
      action: next === 'disabled' ? 'domain_disabled' : 'domain_status_changed',
      target: `${tenantById.get(d.tenantId) || d.tenantId} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: d.status,
      newValue: next,
      severity: next === 'failed' || next === 'disabled' ? 'warning' : 'notice',
    });
  };

  const setSsl = (d: TenantDomainRecord, next: DomainSslStatus) => {
    if (d.ssl === next) return;
    updateDomain(d.id, { ssl: next });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_ssl_changed',
      target: `${tenantById.get(d.tenantId) || d.tenantId} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: d.ssl,
      newValue: next,
      severity: next === 'failed' ? 'warning' : 'notice',
    });
  };

  const reenable = (d: TenantDomainRecord) => {
    updateDomain(d.id, { status: d.kind === 'subdomain' ? 'verified' : 'pending' });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_reenabled',
      target: `${tenantById.get(d.tenantId) || d.tenantId} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: 'disabled',
      newValue: d.kind === 'subdomain' ? 'verified' : 'pending',
      severity: 'notice',
    });
  };

  const copy = (text: string, key: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch { /* noop */ }
  };

  const counts = useMemo(() => ({
    total: domains.length,
    verified: domains.filter(d => d.status === 'verified').length,
    pending: domains.filter(d => d.status === 'pending' || d.status === 'verifying').length,
    failed: domains.filter(d => d.status === 'failed').length,
  }), [domains]);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Domains</h2>
          <p className="text-slate-500 font-medium">Tenant subdomains & custom domains. <span className="text-amber-600 font-black">Manual verification only — no real DNS lookup or SSL automation.</span></p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all">+ Add Domain</button>
      </div>

      {/* Posture row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Pill label="Total" value={counts.total} />
        <Pill label="Verified" value={counts.verified} tint="lime" />
        <Pill label="Pending" value={counts.pending} tint="amber" />
        <Pill label="Failed" value={counts.failed} tint="red" />
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-black text-primary tracking-tight">Domain Records</h3>
          <div className="flex flex-wrap gap-2">
            {(['all', 'pending', 'verifying', 'verified', 'failed', 'disabled'] as const).map(s => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${filter === s ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Hostname</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Kind</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Created</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(d => (
              <tr key={d.id} onClick={() => setSelectedId(d.id)} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{d.hostname}</td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{tenantById.get(d.tenantId) || d.tenantId}</td>
                <td className="px-6 py-3.5"><span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">{d.kind}</span></td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_STYLES[d.status]}`}>{STATUS_LABELS[d.status]}</span></td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SSL_STYLES[d.ssl]}`}>{d.ssl}</span></td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-500 whitespace-nowrap">{d.createdAt}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">No domain records match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add modal */}
      <AnimatePresence>
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreate(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">Add Domain</h3>
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
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Kind</label>
                  <select value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value as DomainKind }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="subdomain">Platform Subdomain</option>
                    <option value="custom">Custom Domain</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Hostname</label>
                  <input value={draft.hostname} onChange={e => setDraft(d => ({ ...d, hostname: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder={draft.kind === 'subdomain' ? 'tenant.repairplatform.com' : 'shop.example.com'} />
                </div>
                <p className="text-[10px] text-slate-500 font-bold">Custom domains start as <span className="text-amber-700">pending</span> and require manual verification using the DNS instructions in the detail view.</p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !draft.hostname.trim()} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 transition-all">Add Domain</button>
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
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-md h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <div className="p-7 border-b border-slate-100 flex justify-between items-start">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain</p>
                  <h3 className="text-lg font-black text-primary mt-1 break-all">{selected.hostname}</h3>
                  <p className="text-xs text-slate-500 font-bold mt-1">{tenantById.get(selected.tenantId) || selected.tenantId} · {selected.kind}</p>
                </div>
                <button onClick={() => setSelectedId(null)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>

              <div className="p-7 space-y-6">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
                    <select value={selected.status} onChange={e => setStatus(selected, e.target.value as DomainStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['pending', 'verifying', 'verified', 'failed', 'disabled'] as DomainStatus[]).map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">SSL</label>
                    <select value={selected.ssl} onChange={e => setSsl(selected, e.target.value as DomainSslStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['none', 'pending', 'active', 'failed'] as DomainSslStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                {/* DNS instructions */}
                {selected.kind === 'custom' && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Manual DNS Instructions</p>
                    <p className="text-[11px] text-amber-700 font-bold mb-3">Configure the following at the customer's DNS provider, then mark this record verified once you've manually confirmed propagation. <span className="font-medium text-slate-500">No DNS lookup is performed by this app.</span></p>
                    <DnsBlock
                      label="CNAME"
                      host={selected.hostname}
                      target="proxy.repairplatform.com"
                      onCopy={() => copy(`${selected.hostname} CNAME proxy.repairplatform.com`, 'cname')}
                      copied={copied === 'cname'}
                    />
                    <div className="h-2" />
                    <DnsBlock
                      label="TXT (verification)"
                      host={`_repairplatform.${selected.hostname}`}
                      target={`verify=${selected.id}`}
                      onCopy={() => copy(`_repairplatform.${selected.hostname} TXT verify=${selected.id}`, 'txt')}
                      copied={copied === 'txt'}
                    />
                  </div>
                )}

                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Quick actions</p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setStatus(selected, 'verified')} disabled={selected.status === 'verified'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-lime-400/10 text-lime-700 border border-lime-400/20 rounded-xl disabled:opacity-40 hover:bg-lime-400/20 transition-all">Mark Verified</button>
                    <button onClick={() => setStatus(selected, 'failed')} disabled={selected.status === 'failed'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-red-500/10 text-red-700 border border-red-500/30 rounded-xl disabled:opacity-40 hover:bg-red-500/20 transition-all">Mark Failed</button>
                    {selected.status !== 'disabled' ? (
                      <button onClick={() => setStatus(selected, 'disabled')} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-200 transition-all">Disable</button>
                    ) : (
                      <button onClick={() => reenable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl hover:bg-blue-400/20 transition-all">Re-enable</button>
                    )}
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 grid grid-cols-2 gap-2 pt-4 border-t border-slate-100">
                  <div>Created: <span className="font-bold text-slate-600">{selected.createdAt}</span></div>
                  <div>Verified: <span className="font-bold text-slate-600">{selected.verifiedAt || '—'}</span></div>
                  <div className="col-span-2">Last checked: <span className="font-bold text-slate-600">{selected.lastCheckedAt || '—'}</span></div>
                  <div className="col-span-2 font-mono">id: {selected.id}</div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Pill: React.FC<{ label: string; value: number; tint?: 'lime' | 'amber' | 'red' }> = ({ label, value, tint }) => {
  const tintCls = tint === 'lime' ? 'text-lime-700' : tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  return (
    <div className="bg-white/80 backdrop-blur-xl p-5 rounded-3xl border border-slate-200 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
    </div>
  );
};

const DnsBlock: React.FC<{ label: string; host: string; target: string; onCopy: () => void; copied: boolean }> = ({ label, host, target, onCopy, copied }) => (
  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 font-mono text-[11px] text-slate-700">
    <div className="flex justify-between items-center mb-2">
      <span className="font-black uppercase tracking-widest text-[10px] text-slate-500">{label}</span>
      <button onClick={onCopy} className="text-[10px] font-black uppercase tracking-widest text-primary hover:opacity-80 transition-opacity">{copied ? 'Copied!' : 'Copy'}</button>
    </div>
    <div>Host: <span className="break-all">{host}</span></div>
    <div>Value: <span className="break-all">{target}</span></div>
  </div>
);

export default DomainsPage;
