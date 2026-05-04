import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants, tenantUsage, tenantUsagePrior, plans, featureMatrix, billingTransactions,
  invoiceHistory, creditNotes, auditLogs, addOns, tenantFeatureOverrides,
  tenantSupportNotes, tenantDomainHistory, planHistory,
} from './mockData';
import type { SupportNoteCategory, FeatureOverrideType, ActivationStatus, AddOn, TenantFeatureOverride } from './mockData';
import { tenantUsers } from './accessMockData';
import { resolveTenantFeature, REASON_LABEL, REASON_EXPLAINER, type EntitlementReason } from './entitlements';
import { pushCommercialAudit } from './commercialAudit';
import { getAddOnGrantSafety } from './readiness';
import { hasPlatformPermission } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import { useAccess } from '../context/AccessContext';
import {
  readInvoices,
  getInvoiceById,
  getInvoicesForTenant,
  deriveInvoiceUiStatus,
  createInvoiceForOverride,
  markInvoicePaid,
  cancelInvoice,
} from './commercialInvoices';
import type { CommercialInvoice } from './mockData';

type Tab = 'Overview' | 'Owner & Users' | 'Subscription' | 'Features' | 'Billing' | 'Domains' | 'Usage' | 'Activity / Audit' | 'Support Notes';

const TenantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAccess();
  const tdpRole = (session?.role as Role | undefined) || null;
  const canGrantTrial = hasPlatformPermission(tdpRole, 'grant_trial').allowed;
  const canGrantPaidOverride = hasPlatformPermission(tdpRole, 'grant_paid_override').allowed;
  const canRevokeOverride = hasPlatformPermission(tdpRole, 'revoke_addon_override').allowed;
  const tenant = tenants.find(t => t.id === id);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [noteInput, setNoteInput] = useState('');
  const [noteCategory, setNoteCategory] = useState<SupportNoteCategory>('general');
  const [noteAssignee, setNoteAssignee] = useState('');
  const [noteFollowUp, setNoteFollowUp] = useState('');
  const [localNotes, setLocalNotes] = useState<typeof tenantSupportNotes>([]);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('technician');
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [userDetailId, setUserDetailId] = useState<string | null>(null);
  const [planChangeModal, setPlanChangeModal] = useState<string | null>(null);
  const [trialExtendModal, setTrialExtendModal] = useState(false);
  const [trialDays, setTrialDays] = useState('7');
  const [auditCategoryFilter, setAuditCategoryFilter] = useState('all');
  const [auditActorFilter, setAuditActorFilter] = useState('all');
  const [supportCategoryFilter, setSupportCategoryFilter] = useState<string>('all');
  const [copiedDns, setCopiedDns] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState('');

  const [currentPlan, setCurrentPlan] = useState(tenant?.plan || 'essential');
  const [localOverrides, setLocalOverrides] = useState<TenantFeatureOverride[]>(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const raw = window.sessionStorage.getItem('tenant_overrides_data');
        if (raw) {
          const all = JSON.parse(raw) as TenantFeatureOverride[];
          return all.filter(o => o.tenantId === id);
        }
      }
    } catch { /* fall back */ }
    return tenantFeatureOverrides.filter(o => o.tenantId === id);
  });

  // Persist overrides for this tenant into a global sessionStorage map so
  // AccessContext / Permissions Matrix can read them without prop-drilling.
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      const raw = window.sessionStorage.getItem('tenant_overrides_data');
      const others: TenantFeatureOverride[] = raw
        ? (JSON.parse(raw) as TenantFeatureOverride[]).filter(o => o.tenantId !== id)
        : tenantFeatureOverrides.filter(o => o.tenantId !== id);
      window.sessionStorage.setItem('tenant_overrides_data', JSON.stringify([...others, ...localOverrides]));
      window.dispatchEvent(new Event('tenant_overrides_data:changed'));
    } catch { /* noop */ }
  }, [localOverrides, id]);
  const [invoiceDetailId, setInvoiceDetailId] = useState<string | null>(null);
  const [auditDetailId, setAuditDetailId] = useState<string | null>(null);
  const [customDomainLocal, setCustomDomainLocal] = useState<string | null>(tenant?.customDomain || null);
  const [domainVerification, setDomainVerification] = useState(tenant?.verification || 'pending');
  const [domainSsl, setDomainSsl] = useState(tenant?.ssl || 'pending');
  const [createOwnerModal, setCreateOwnerModal] = useState(false);
  const [createOwnerName, setCreateOwnerName] = useState('');
  const [createOwnerEmail, setCreateOwnerEmail] = useState('');
  const [featureTrialModal, setFeatureTrialModal] = useState<string | null>(null);
  const [featureTrialDays, setFeatureTrialDays] = useState('14');
  const [featurePaidModal, setFeaturePaidModal] = useState<string | null>(null);
  const [paidOverridePrice, setPaidOverridePrice] = useState('');
  const [paidOverrideModel, setPaidOverrideModel] = useState<'monthly' | 'one_time' | 'annual'>('monthly');
  const [paidOverrideNotes, setPaidOverrideNotes] = useState('');
  const [paidOverrideActivation, setPaidOverrideActivation] = useState<'after_payment' | 'immediate'>('after_payment');
  const [paidOverrideDueDate, setPaidOverrideDueDate] = useState<string>('');
  // Bumps any time invoices mutate, used to re-derive resolver state
  // and the Billing tab without depending on storage events.
  const [invoiceVersion, setInvoiceVersion] = useState(0);
  const [commercialInvoiceDetailId, setCommercialInvoiceDetailId] = useState<string | null>(null);
  const [cancelInvoiceConfirmId, setCancelInvoiceConfirmId] = useState<string | null>(null);
  const [localCreatedOwners, setLocalCreatedOwners] = useState<{ id: string; name: string; email: string; status: string; }[]>([]);
  const [creditDetailId, setCreditDetailId] = useState<string | null>(null);
  const [voidConfirmId, setVoidConfirmId] = useState<string | null>(null);
  const [localCreditStatuses, setLocalCreditStatuses] = useState<Record<string, string>>({});
  const [localInvoiceStatuses, setLocalInvoiceStatuses] = useState<Record<string, string>>({});
  const [revokeModal, setRevokeModal] = useState<string | null>(null);
  const [editOwnerModal, setEditOwnerModal] = useState<string | null>(null);
  const [editOwnerName, setEditOwnerName] = useState('');
  const [editOwnerEmail, setEditOwnerEmail] = useState('');
  const [deactivateOwnerId, setDeactivateOwnerId] = useState<string | null>(null);
  const [deleteOwnerId, setDeleteOwnerId] = useState<string | null>(null);
  const [localOwnerStatuses, setLocalOwnerStatuses] = useState<Record<string, string>>({});
  const [localOwnerEdits, setLocalOwnerEdits] = useState<Record<string, { name: string; email: string }>>({});
  const [localCreditLinks, setLocalCreditLinks] = useState<Record<string, { appliedToInvoice: string; appliedAmount: number; appliedDate: string }>>({});

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, durationMs = 3000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setInviteSuccess(msg);
    toastTimerRef.current = setTimeout(() => { setInviteSuccess(null); toastTimerRef.current = null; }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  if (!tenant) return (
    <div className="text-center py-20">
      <p className="text-xl font-black text-slate-400">Tenant not found</p>
      <button onClick={() => navigate('/owner/tenants')} className="mt-4 px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest">Back to Tenants</button>
    </div>
  );

  const plan = plans.find(p => p.id === currentPlan);
  const currentPlanObj = plans.find(p => p.id === currentPlan);
  const usage = tenantUsage.find(u => u.tenantId === tenant.id);
  const priorUsage = tenantUsagePrior.find(u => u.tenantId === tenant.id);
  const scopedUsers = tenantUsers.filter(u => u.tenantId === tenant.id);
  const tenantTx = billingTransactions.filter(tx => tx.tenantId === tenant.id);
  const tenantInv = invoiceHistory.filter(i => i.tenantId === tenant.id);
  const tenantCredits = creditNotes.filter(c => c.tenantId === tenant.id);
  const tenantLogs = auditLogs.filter(l => l.tenantId === tenant.id);
  const tenantAddOns = addOns.filter(a => a.governanceStatus === 'active' && a.compatiblePlans.includes(currentPlan));
  const supportNotes = [...tenantSupportNotes.filter(n => n.tenantId === tenant.id), ...localNotes];
  const domainHistory = tenantDomainHistory.filter(d => d.tenantId === tenant.id);
  const tenantPlanHistory = planHistory.filter(ph => ph.tenantId === tenant.id);

  const accountBalance = useMemo(() => {
    const totalBilled = tenantInv.reduce((s, i) => s + i.total, 0);
    const totalPaid = tenantTx.filter(tx => tx.status === 'paid').reduce((s, tx) => s + tx.amount, 0);
    const appliedCredits = tenantCredits.filter(c => c.status === 'applied').reduce((s, c) => s + c.appliedAmount, 0);
    const unappliedCredits = tenantCredits.filter(c => c.status === 'issued').reduce((s, c) => s + c.amount, 0);
    return { totalBilled, totalPaid, appliedCredits, unappliedCredits, balance: totalBilled - totalPaid - appliedCredits };
  }, [tenantInv, tenantTx, tenantCredits]);

  const healthScore = useMemo(() => {
    let score = 100;
    if (tenant.status === 'overdue') score -= 30;
    if (tenant.status === 'suspended') score -= 50;
    if (usage) {
      if (usage.seatsAllowed > 0 && usage.seatsUsed / usage.seatsAllowed >= 0.95) score -= 10;
      if (usage.apiLimit > 0 && usage.apiCalls / usage.apiLimit >= 0.9) score -= 10;
      if (usage.smsLimit > 0 && usage.smsUsed / usage.smsLimit >= 0.9) score -= 5;
      if (usage.storageLimitMb > 0 && usage.storageMb / usage.storageLimitMb >= 0.9) score -= 5;
    }
    const failedTx = tenantTx.filter(tx => tx.status === 'failed');
    if (failedTx.length > 0) score -= 15;
    if (tenant.ssl !== 'active') score -= 5;
    if (tenant.verification !== 'verified') score -= 5;
    return Math.max(0, Math.min(100, score));
  }, [tenant, usage, tenantTx]);

  const daysUntilRenewal = useMemo(() => {
    const today = new Date('2026-03-26');
    const renewal = new Date(tenant.renewal);
    return Math.ceil((renewal.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }, [tenant.renewal]);

  const tabs: Tab[] = ['Overview', 'Owner & Users', 'Subscription', 'Features', 'Billing', 'Domains', 'Usage', 'Activity / Audit', 'Support Notes'];

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      trialing: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      overdue: 'bg-red-400/10 text-red-700 border-red-400/20',
      suspended: 'bg-slate-400/10 text-slate-500 border-slate-200',
      paid: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      failed: 'bg-red-400/10 text-red-700 border-red-400/20',
      refunded: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      void: 'bg-slate-400/10 text-slate-500 border-slate-200',
      voided: 'bg-slate-400/10 text-slate-500 border-slate-200',
      pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      issued: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      verified: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      invited: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      applied: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      inherited: 'bg-slate-400/10 text-slate-500 border-slate-200',
      overridden: 'bg-violet-400/10 text-violet-700 border-violet-200',
      trial: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      disabled: 'bg-red-400/10 text-red-700 border-red-400/20',
      addon: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      'paid_override': 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
      'pending_payment': 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      deactivated: 'bg-slate-400/10 text-slate-500 border-slate-200',
      account_setup: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      pending_activation: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      upgrade: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
      new: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      trial_start: 'bg-indigo-400/10 text-indigo-700 border-indigo-200',
      suspension: 'bg-red-400/10 text-red-700 border-red-400/20',
      warning: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      info: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
      general: 'bg-slate-400/10 text-slate-500 border-slate-200',
      billing: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
      technical: 'bg-red-400/10 text-red-700 border-red-400/20',
      escalation: 'bg-red-400/10 text-red-700 border-red-400/20',
      onboarding: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
    };
    return <span className={`px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border ${styles[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{status.replace('_', ' ')}</span>;
  };

  const usageBar = (used: number, limit: number) => {
    if (limit === 0) return <span className="text-[10px] text-slate-400 font-bold">N/A</span>;
    const pct = Math.round((used / limit) * 100);
    const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-lime-500';
    return (
      <div className="flex items-center gap-2">
        <div className="w-20 h-1.5 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
        <span className={`text-[10px] font-black ${pct >= 90 ? 'text-red-500' : 'text-slate-500'}`}>{pct}%</span>
      </div>
    );
  };

  const trendArrow = (current: number, previous: number) => {
    if (previous === 0 && current === 0) return <span className="text-[10px] text-slate-400 font-bold">—</span>;
    if (previous === 0) return <span className="text-[10px] text-lime-600 font-black flex items-center gap-0.5"><span className="material-symbols-outlined text-xs">trending_up</span>New</span>;
    const pctChange = Math.round(((current - previous) / previous) * 100);
    if (pctChange === 0) return <span className="text-[10px] text-slate-400 font-bold">0%</span>;
    return (
      <span className={`text-[10px] font-black flex items-center gap-0.5 ${pctChange > 0 ? 'text-lime-600' : 'text-red-500'}`}>
        <span className="material-symbols-outlined text-xs">{pctChange > 0 ? 'trending_up' : 'trending_down'}</span>
        {pctChange > 0 ? '+' : ''}{pctChange}%
      </span>
    );
  };

  const healthColor = healthScore >= 80 ? 'text-lime-600' : healthScore >= 50 ? 'text-amber-600' : 'text-red-600';
  const healthBg = healthScore >= 80 ? 'bg-lime-50 border-lime-100' : healthScore >= 50 ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100';

  const inputClass = "w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary";
  const labelClass = "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2";

  const effectiveDomain = customDomainLocal;
  const dnsRecords = effectiveDomain ? [
    { type: 'CNAME', name: effectiveDomain, value: `${tenant.subdomain}.repairplatform.com`, ttl: '3600' },
    { type: 'TXT', name: `_verify.${effectiveDomain}`, value: `rp-verify=${tenant.id}`, ttl: '3600' },
  ] : [];

  const copyToClipboard = (text: string, cid: string) => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedDns(cid);
    setTimeout(() => setCopiedDns(null), 2000);
  };

  // Pinned reference date used throughout this page for trial / refund math.
  const NOW_MS = Date.parse('2026-03-26');

  // Live add-on catalog / feature matrix from sessionStorage when the
  // System Owner has edited them on the catalog pages; falls back to the
  // seed values. `catalogVersion` bumps on window focus and on cross-tab
  // `storage` events so edits made in another tab/window propagate to
  // this view (Compatible Plans edits MUST take effect immediately on
  // the Tenant Features tab — same-route mounts always re-read because
  // the dependency includes `catalogVersion`).
  const [catalogVersion, setCatalogVersion] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bump = () => setCatalogVersion(v => v + 1);
    window.addEventListener('focus', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('focus', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  const liveAddOns = useMemo<AddOn[]>(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const raw = window.sessionStorage.getItem('addons_data');
        if (raw) {
          // Legacy normalization: coerce any stale `governanceStatus:
          // 'draft'` from a previous build to 'disabled'. See replit.md
          // → "Add-on Governance & Archive Protection Rule".
          const parsed = JSON.parse(raw) as AddOn[];
          return parsed.map(a => (
            (a.governanceStatus as string) === 'draft'
              ? { ...a, governanceStatus: 'disabled' }
              : a
          ));
        }
      }
    } catch { /* fall back */ }
    return addOns;
  }, [catalogVersion]);

  const liveFeatureMatrix = useMemo(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const raw = window.sessionStorage.getItem('features_data');
        if (raw) return JSON.parse(raw) as typeof featureMatrix;
      }
    } catch { /* fall back */ }
    return featureMatrix;
  }, [catalogVersion]);

  const resolveFeature = useCallback((featureId: string) => {
    return resolveTenantFeature(featureId, {
      tenantPlan: currentPlan,
      featureMatrix: liveFeatureMatrix,
      addOns: liveAddOns,
      overrides: localOverrides as TenantFeatureOverride[],
      nowMs: NOW_MS,
      lookupInvoice: getInvoiceById,
      deriveInvoiceUi: deriveInvoiceUiStatus,
    });
    // invoiceVersion intentionally included to re-resolve after invoice
    // mutations (Mark Paid / Cancel) flip a row's badge or revoke the
    // override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlan, liveFeatureMatrix, liveAddOns, localOverrides, invoiceVersion]);

  // Tenant-scoped invoice list, re-derived whenever an invoice mutates.
  const tenantInvoices = useMemo<CommercialInvoice[]>(() => {
    return getInvoicesForTenant(tenant.id).slice().sort((a, b) => {
      // Newest first by issuedDate; tie-break by id.
      const da = Date.parse(a.issuedDate);
      const db = Date.parse(b.issuedDate);
      if (da !== db) return db - da;
      return a.invoiceId < b.invoiceId ? 1 : -1;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, invoiceVersion]);

  // Legacy adapter — preserves the existing `state.type` / `state.trialEnd`
  // shape consumed by other surfaces in this page. Callers that need the
  // canonical reason should use `resolveFeature` directly.
  const getFeatureState = (featureId: string): { type: FeatureOverrideType; trialEnd?: string } => {
    const override = localOverrides.find(o => o.featureId === featureId);
    if (override) return { type: override.type, trialEnd: override.trialEnd };
    const feature = featureMatrix.find(f => f.id === featureId);
    if (feature && feature.planAvailability[currentPlan]) return { type: 'inherited' };
    return { type: 'disabled' };
  };

  const getRefundEligibility = (addedDate?: string) => {
    if (!addedDate) return { eligible: false, daysAgo: 999, message: 'No charge date available' };
    const added = new Date(addedDate);
    const today = new Date('2026-03-26');
    const daysAgo = Math.floor((today.getTime() - added.getTime()) / (1000 * 60 * 60 * 24));
    if (daysAgo <= 7) return { eligible: true, daysAgo, message: `Charged ${daysAgo} day(s) ago — eligible for full refund` };
    return { eligible: false, daysAgo, message: `Charged ${daysAgo} days ago — refund window expired (7-day policy)` };
  };

  const handleEnableTrial = (featureId: string) => {
    const days = parseInt(featureTrialDays) || 14;
    const trialEnd = new Date('2026-03-26');
    trialEnd.setDate(trialEnd.getDate() + days);
    const endStr = trialEnd.toISOString().split('T')[0];
    const linkedAddOn = liveAddOns.find(a => a.linkedFeatureId === featureId) || liveAddOns.find(a => a.id === featureId);
    // Only carry the catalog add-on linkage when it is currently
    // OFFERABLE to this tenant (active + plan-compat). If the add-on
    // exists but is incompatible with the tenant's plan, the trial is
    // recorded as a pure tenant-level override so it never resurfaces
    // as add-on-driven entitlement / labeling.
    const eligibleAddOnId =
      linkedAddOn && linkedAddOn.governanceStatus === 'active' && linkedAddOn.compatiblePlans.includes(currentPlan)
        ? linkedAddOn.id
        : null;
    setLocalOverrides(prev => {
      const filtered = prev.filter(o => o.featureId !== featureId);
      return [...filtered, { tenantId: tenant.id, featureId, type: 'trial' as FeatureOverrideType, trialEnd: endStr, addedBy: 'You', addedDate: '2026-03-26', addOnId: eligibleAddOnId }];
    });
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'tenant_trial_granted',
      tenantId: tenant.id,
      featureId,
      addOnId: eligibleAddOnId,
      newValue: endStr,
      note: `${days}-day trial`,
    });
    setFeatureTrialModal(null);
    setFeatureTrialDays('14');
    showToast(`Trial enabled for ${featureMatrix.find(f => f.id === featureId)?.name || featureId}`);
  };

  const handleEnablePaidOverride = (featureId: string) => {
    const price = parseFloat(paidOverridePrice) || 0;
    const linkedAddOn = liveAddOns.find(a => a.linkedFeatureId === featureId) || liveAddOns.find(a => a.id === featureId);
    // Only attribute the override to the catalog add-on when that
    // add-on is currently OFFERABLE to this tenant (active + plan-
    // compat). Otherwise the override is recorded as a pure tenant-
    // level paid override with no add-on attribution, so it cannot be
    // re-presented as add-on-driven entitlement / labeling.
    const eligibleAddOnId =
      linkedAddOn && linkedAddOn.governanceStatus === 'active' && linkedAddOn.compatiblePlans.includes(currentPlan)
        ? linkedAddOn.id
        : null;
    const featureName = featureMatrix.find(f => f.id === featureId)?.name || featureId;
    const activationMode = paidOverrideActivation;
    const dueDate = paidOverrideDueDate || (() => {
      const d = new Date('2026-03-26');
      d.setDate(d.getDate() + (activationMode === 'after_payment' ? 30 : 7));
      return d.toISOString().slice(0, 10);
    })();
    // Create the internal SaaS invoice first so we can link the
    // override to it. Both activation modes generate an OPEN invoice.
    const invoice = createInvoiceForOverride({
      tenantId: tenant.id,
      featureId,
      featureName,
      addOnId: eligibleAddOnId,
      amount: price,
      cadence: paidOverrideModel,
      dueDate,
      activationMode,
      createdBy: 'System Owner',
      notes: paidOverrideNotes || undefined,
    });
    const overrideType: FeatureOverrideType = activationMode === 'immediate' ? 'paid_override' : 'pending_payment';
    setLocalOverrides(prev => {
      const filtered = prev.filter(o => o.featureId !== featureId);
      return [...filtered, {
        tenantId: tenant.id,
        featureId,
        type: overrideType,
        addedBy: 'You',
        addedDate: '2026-03-26',
        pricingModel: paidOverrideModel,
        price,
        pricingNotes: paidOverrideNotes || undefined,
        addOnId: eligibleAddOnId,
        activationMode,
        invoiceId: invoice.invoiceId,
        dueDate,
      }];
    });
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'tenant_paid_override_granted',
      tenantId: tenant.id,
      featureId,
      addOnId: eligibleAddOnId,
      oldValue: linkedAddOn?.price ?? null,
      newValue: price,
      note: paidOverrideNotes || (linkedAddOn && price !== linkedAddOn.price ? 'Custom price' : 'Catalog price'),
    });
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'invoice_created',
      tenantId: tenant.id,
      featureId,
      addOnId: eligibleAddOnId,
      newValue: invoice.invoiceId,
      note: `Open invoice · ${activationMode === 'immediate' ? 'Immediate activation' : 'Activate after payment'} · Due ${dueDate}`,
    });
    if (activationMode === 'immediate') {
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'immediate_activation_granted',
        tenantId: tenant.id,
        featureId,
        addOnId: eligibleAddOnId,
        newValue: invoice.invoiceId,
        note: 'Feature active before payment',
      });
    }
    setInvoiceVersion(v => v + 1);
    setFeaturePaidModal(null);
    setPaidOverridePrice('');
    setPaidOverrideModel('monthly');
    setPaidOverrideNotes('');
    setPaidOverrideActivation('after_payment');
    setPaidOverrideDueDate('');
    const modelLabel = paidOverrideModel === 'monthly' ? '/mo' : paidOverrideModel === 'annual' ? '/yr' : ' one-time';
    const stateLabel = activationMode === 'immediate' ? 'active now (invoice open)' : 'pending payment';
    showToast(`Paid override ${stateLabel} for ${featureName} at $${price}${modelLabel}`);
  };

  const handleMarkInvoicePaid = (invoiceId: string) => {
    const inv = getInvoiceById(invoiceId);
    if (!inv) return;
    markInvoicePaid(invoiceId);
    // Find the linked override and flip pending_payment → paid_override.
    let activatedFeatureId: string | null = null;
    setLocalOverrides(prev => prev.map(o => {
      if (o.invoiceId !== invoiceId) return o;
      if (o.type === 'pending_payment') {
        activatedFeatureId = o.featureId;
        return { ...o, type: 'paid_override' as FeatureOverrideType };
      }
      return o;
    }));
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'invoice_marked_paid',
      tenantId: tenant.id,
      featureId: inv.featureId ?? null,
      addOnId: inv.addOnId ?? null,
      newValue: inv.invoiceId,
      note: 'Manual confirmation by System Owner',
    });
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'manual_payment_confirmation',
      tenantId: tenant.id,
      featureId: inv.featureId ?? null,
      addOnId: inv.addOnId ?? null,
      newValue: inv.amount,
      note: `Invoice ${inv.invoiceId} marked paid`,
    });
    if (activatedFeatureId) {
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'feature_activated_after_payment',
        tenantId: tenant.id,
        featureId: activatedFeatureId,
        addOnId: inv.addOnId ?? null,
        newValue: inv.invoiceId,
      });
    }
    setInvoiceVersion(v => v + 1);
    const fname = inv.featureId ? (featureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : inv.invoiceId;
    showToast(`Invoice ${inv.invoiceId} marked paid${activatedFeatureId ? ` — ${fname} is now active` : ''}`);
  };

  const handleCancelInvoiceClick = (invoiceId: string) => {
    setCancelInvoiceConfirmId(invoiceId);
  };

  const handleConfirmCancelInvoice = (invoiceId: string) => {
    const inv = getInvoiceById(invoiceId);
    if (!inv) {
      setCancelInvoiceConfirmId(null);
      return;
    }
    cancelInvoice(invoiceId);
    // Find linked override and decide the consequence.
    const linked = localOverrides.find(o => o.invoiceId === invoiceId);
    let revokedFeatureId: string | null = null;
    if (linked) {
      if (linked.type === 'pending_payment') {
        // Activate-after-payment + cancelled → drop the override entirely
        // so the row reverts to Not in Plan (no Revoked badge).
        setLocalOverrides(prev => prev.filter(o => o.invoiceId !== invoiceId));
      } else if (linked.type === 'paid_override' && linked.activationMode === 'immediate') {
        // Immediate-active + cancel invoice → revoke the feature.
        const today = new Date().toISOString().slice(0, 10);
        setLocalOverrides(prev => prev.map(o => o.invoiceId === invoiceId
          ? { ...o, revokedDate: today, revokedBy: 'System Owner', revokeReason: 'Invoice cancelled' }
          : o));
        revokedFeatureId = linked.featureId;
      }
    }
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'invoice_cancelled',
      tenantId: tenant.id,
      featureId: inv.featureId ?? null,
      addOnId: inv.addOnId ?? null,
      newValue: inv.invoiceId,
      note: linked?.type === 'pending_payment' ? 'Reverted to Not in Plan' : (revokedFeatureId ? 'Feature revoked' : 'No override change'),
    });
    if (revokedFeatureId) {
      pushCommercialAudit({
        actor: 'System Owner',
        action: 'paid_override_revoked_due_to_cancel',
        tenantId: tenant.id,
        featureId: revokedFeatureId,
        addOnId: inv.addOnId ?? null,
        newValue: inv.invoiceId,
      });
    }
    setInvoiceVersion(v => v + 1);
    setCancelInvoiceConfirmId(null);
    const fname = inv.featureId ? (featureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : inv.invoiceId;
    if (linked?.type === 'pending_payment') {
      showToast(`Invoice ${inv.invoiceId} cancelled — ${fname} reverted to Not in Plan`);
    } else if (revokedFeatureId) {
      showToast(`Invoice ${inv.invoiceId} cancelled — ${fname} access revoked`);
    } else {
      showToast(`Invoice ${inv.invoiceId} cancelled`);
    }
  };

  const handleRevokeFeature = (featureId: string) => {
    const override = localOverrides.find(o => o.featureId === featureId) as (typeof localOverrides[0] & { price?: number }) | undefined;
    if (override && override.type === 'paid_override' && override.price && override.price > 0) {
      setRevokeModal(featureId);
    } else {
      // Mark as revoked (kept for history) when not a billed paid override.
      const today = new Date().toISOString().slice(0, 10);
      setLocalOverrides(prev => prev.map(o => o.featureId === featureId ? { ...o, revokedDate: today, revokedBy: 'System Owner', revokeReason: 'Revoked by System Owner' } : o));
      pushCommercialAudit({
        actor: 'System Owner',
        action: override?.type === 'pending_payment' ? 'tenant_pending_payment_cancelled' : (override?.type === 'trial' ? 'tenant_trial_revoked' : 'tenant_override_revoked'),
        tenantId: tenant.id,
        featureId,
        addOnId: override?.addOnId ?? null,
      });
      showToast(`Override revoked for ${featureMatrix.find(f => f.id === featureId)?.name || featureId}`);
    }
  };

  // Part F: Re-enable handler for rows whose state is currently
  // `feature_disabled_by_owner`. Removes the disabled override row so
  // the resolver returns to the natural plan/lifecycle state. We do
  // not delete history rows — only the dormant disabled flag for this
  // feature — and we audit it as `tenant_override_revoked` because
  // the disabled override is itself a kind of override.
  const handleReenableFeature = (featureId: string) => {
    const ov = localOverrides.find(o => o.featureId === featureId);
    setLocalOverrides(prev => prev.filter(o => !(o.featureId === featureId && o.type === 'disabled')));
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'tenant_override_revoked',
      tenantId: tenant.id,
      featureId,
      addOnId: ov?.addOnId ?? null,
      note: 'Disabled-by-Owner cleared (feature re-enabled)',
    });
    showToast(`${featureMatrix.find(f => f.id === featureId)?.name || featureId} re-enabled`);
  };

  const handleConfirmRevoke = (featureId: string, issueRefund: boolean) => {
    const today = new Date().toISOString().slice(0, 10);
    const ov = localOverrides.find(o => o.featureId === featureId);
    setLocalOverrides(prev => prev.map(o => o.featureId === featureId ? { ...o, revokedDate: today, revokedBy: 'System Owner', revokeReason: issueRefund ? 'Revoked + refund' : 'Revoked' } : o));
    pushCommercialAudit({
      actor: 'System Owner',
      action: 'tenant_override_revoked',
      tenantId: tenant.id,
      featureId,
      addOnId: ov?.addOnId ?? null,
      note: issueRefund ? 'Refund issued' : 'No refund',
    });
    setRevokeModal(null);
    const name = featureMatrix.find(f => f.id === featureId)?.name || featureId;
    showToast(issueRefund ? `${name} revoked — refund issued` : `${name} revoked — no refund (past refund window)`);
  };

  const handleAddDomain = () => {
    if (domainInput.includes('.')) {
      setCustomDomainLocal(domainInput);
      setDomainVerification('pending');
      setDomainSsl('pending');
      setDomainInput('');
      showToast(`Custom domain ${domainInput} added. Configure DNS records below.`, 4000);
    }
  };

  const [domainPropagation, setDomainPropagation] = useState<'unknown' | 'checking' | 'propagated' | 'not_propagated'>('unknown');

  const handleRemoveDomain = () => {
    setCustomDomainLocal(null);
    setDomainVerification('pending');
    setDomainSsl('pending');
    setDomainPropagation('unknown');
    showToast('Custom domain removed.');
  };

  const handleCheckPropagation = () => {
    setDomainPropagation('checking');
    setTimeout(() => {
      setDomainPropagation('propagated');
      showToast('DNS propagation confirmed. You can now verify the domain.');
    }, 1500);
  };

  const handleVerifyDomain = () => {
    if (domainPropagation !== 'propagated') {
      showToast('DNS propagation must be confirmed before verification. Run Check Propagation first.');
      return;
    }
    setDomainVerification('verified');
    showToast('DNS records verified successfully.');
  };

  const handleProvisionSsl = () => {
    if (domainVerification !== 'verified') {
      showToast('DNS must be verified before SSL can be provisioned.');
      return;
    }
    setDomainSsl('active');
    showToast('SSL certificate provisioned and active.');
  };

  const handleFailDomain = () => {
    setDomainVerification('failed');
    showToast('DNS verification failed. Check records and try again.');
  };

  const pinnedNotes = supportNotes.filter(n => n.pinned);
  const unpinnedNotes = supportNotes.filter(n => !n.pinned);
  const filteredSupportNotes = supportCategoryFilter === 'all' ? [...pinnedNotes, ...unpinnedNotes] : [...pinnedNotes.filter(n => n.category === supportCategoryFilter), ...unpinnedNotes.filter(n => n.category === supportCategoryFilter)];

  const filteredLogs = useMemo(() => {
    let logs = [...tenantLogs];
    if (auditCategoryFilter !== 'all') logs = logs.filter(l => l.category === auditCategoryFilter);
    if (auditActorFilter !== 'all') logs = logs.filter(l => l.actor === auditActorFilter);
    return logs;
  }, [tenantLogs, auditCategoryFilter, auditActorFilter]);

  const auditCategories = [...new Set(tenantLogs.map(l => l.category))];
  const auditActors = [...new Set(tenantLogs.map(l => l.actor))];

  const allScopedUsers = useMemo(() => {
    const created = localCreatedOwners.filter(o => o.status !== 'deleted' && localOwnerStatuses[o.id] !== 'deleted').map(o => {
      const edits = localOwnerEdits[o.id];
      return {
        id: o.id, name: edits?.name || o.name, email: edits?.email || o.email, role: 'store_owner', status: localOwnerStatuses[o.id] || o.status,
        tenantId: tenant.id, lastActive: null as string | null, phone: null as string | null, notes: 'Created by platform admin' as string | null,
      };
    });
    const dbUsers = scopedUsers.filter(u => localOwnerStatuses[u.id] !== 'deleted').map(u => {
      const edits = localOwnerEdits[u.id];
      return { ...u, name: edits?.name || u.name, email: edits?.email || u.email, status: localOwnerStatuses[u.id] || u.status };
    });
    return [...dbUsers, ...created];
  }, [scopedUsers, localCreatedOwners, tenant.id, localOwnerStatuses, localOwnerEdits]);

  const storeOwners = useMemo(() => allScopedUsers.filter(u => u.role === 'store_owner'), [allScopedUsers]);
  const teamMembers = useMemo(() => allScopedUsers.filter(u => u.role !== 'store_owner'), [allScopedUsers]);

  const effectiveInvoices = useMemo(() =>
    tenantInv.map(inv => ({ ...inv, status: (localInvoiceStatuses[inv.id] || inv.status) as typeof inv.status })),
  [tenantInv, localInvoiceStatuses]);

  const effectiveCredits = useMemo(() =>
    tenantCredits.map(cr => {
      const link = localCreditLinks[cr.id];
      return {
        ...cr,
        status: (localCreditStatuses[cr.id] || cr.status) as typeof cr.status,
        ...(link ? { appliedToInvoice: link.appliedToInvoice, appliedAmount: link.appliedAmount, appliedDate: link.appliedDate } : {}),
      };
    }),
  [tenantCredits, localCreditStatuses, localCreditLinks]);

  const selectedUserDetail = userDetailId ? allScopedUsers.find(u => u.id === userDetailId) : null;
  const selectedInvoice = invoiceDetailId ? effectiveInvoices.find(i => i.id === invoiceDetailId) : null;
  const selectedAuditLog = auditDetailId ? tenantLogs.find(l => l.id === auditDetailId) : null;
  const selectedCredit = creditDetailId ? effectiveCredits.find(c => c.id === creditDetailId) : null;
  const voidCredit = voidConfirmId ? effectiveCredits.find(c => c.id === voidConfirmId) : null;
  const revokeFeature = revokeModal ? featureMatrix.find(f => f.id === revokeModal) : null;
  const revokeOverride = revokeModal ? localOverrides.find(o => o.featureId === revokeModal) as (typeof localOverrides[0] & { price?: number; pricingModel?: string; pricingNotes?: string }) | undefined : undefined;

  const activeStoreOwners = useMemo(() => storeOwners.filter(o => o.status === 'active'), [storeOwners]);
  const [primaryOwnerId, setPrimaryOwnerId] = useState<string>(() => {
    const match = allScopedUsers.find(u => u.email === tenant.owner.email && u.role === 'store_owner');
    return match?.id || '';
  });
  const isPrimaryOwner = useCallback((userId: string) => {
    return userId === primaryOwnerId;
  }, [primaryOwnerId]);
  const canDeleteOwner = useCallback((userId: string) => {
    if (isPrimaryOwner(userId)) return { allowed: false, reason: 'This is the primary Store Owner. To delete, first reassign ownership to another Store Owner.' };
    if (storeOwners.length <= 1) return { allowed: false, reason: 'Cannot delete the only Store Owner. At least one Store Owner must exist for tenant continuity.' };
    const userObj = storeOwners.find(o => o.id === userId);
    if (userObj?.status === 'active' && activeStoreOwners.length <= 1) return { allowed: false, reason: 'Cannot delete the last active Store Owner. At least one active Store Owner is required for tenant operations.' };
    return { allowed: true, reason: '' };
  }, [storeOwners, activeStoreOwners, isPrimaryOwner]);
  const canDeactivateOwner = useCallback((userId: string) => {
    if (isPrimaryOwner(userId)) return { allowed: false, reason: 'Cannot deactivate the primary Store Owner. Reassign primary ownership first.' };
    const otherActive = activeStoreOwners.filter(o => o.id !== userId);
    if (otherActive.length === 0) return { allowed: false, reason: 'Cannot deactivate the last active Store Owner. At least one active Store Owner is required.' };
    return { allowed: true, reason: '' };
  }, [activeStoreOwners, isPrimaryOwner]);

  const eligibleInvoicesForCredit = useMemo(() => effectiveInvoices.filter(inv => inv.status === 'overdue' || inv.status === 'pending'), [effectiveInvoices]);

  const [reassignOwnerId, setReassignOwnerId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/owner/tenants')} className="w-10 h-10 flex items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 transition-all">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-black text-primary tracking-tight">{tenant.name}</h2>
              {statusBadge(tenant.status)}
              <div className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border ${healthBg}`}>
                <span className={`material-symbols-outlined text-xs ${healthColor}`}>monitor_heart</span>
                <span className={`text-[9px] font-black ${healthColor}`}>{healthScore}</span>
              </div>
            </div>
            <p className="text-slate-500 font-medium text-sm">{tenant.id} · {tenant.owner.email} · {currentPlan} plan</p>
          </div>
        </div>
        <div className="flex gap-2">
          {tenant.status === 'overdue' && <button className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all active:scale-95">Suspend</button>}
          {tenant.status === 'suspended' && <button className="px-4 py-2.5 bg-lime-600 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-lime-700 transition-all active:scale-95">Reactivate</button>}
          {tenant.status === 'trialing' && <button className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95">Convert to Paid</button>}
        </div>
      </div>

      <AnimatePresence>
        {inviteSuccess && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="p-4 bg-lime-50 rounded-xl border border-lime-200 flex items-center gap-2">
            <span className="material-symbols-outlined text-lime-600 text-sm">check_circle</span>
            <p className="text-sm font-bold text-lime-700">{inviteSuccess}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all whitespace-nowrap ${activeTab === tab ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-white/80 text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
        {activeTab === 'Overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className={`p-4 rounded-xl border ${healthBg}`}>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Health Score</p>
                <p className={`text-2xl font-black ${healthColor}`}>{healthScore}</p>
                <p className="text-[10px] text-slate-400">{healthScore >= 80 ? 'Healthy' : healthScore >= 50 ? 'Needs Attention' : 'Critical'}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Plan</p>
                <p className="font-black text-primary capitalize">{currentPlan}</p>
                <p className="text-[10px] text-slate-400">{currentPlanObj ? `$${currentPlanObj.price}/mo` : ''}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">MRR</p>
                <p className="font-black text-primary">${tenant.mrr}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Renewal</p>
                <p className="font-black text-slate-900">{tenant.renewal}</p>
                <p className={`text-[10px] font-bold ${daysUntilRenewal <= 7 ? 'text-red-500' : daysUntilRenewal <= 30 ? 'text-amber-600' : 'text-slate-400'}`}>
                  {daysUntilRenewal > 0 ? `${daysUntilRenewal} days` : daysUntilRenewal === 0 ? 'Today' : `${Math.abs(daysUntilRenewal)}d overdue`}
                </p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Balance</p>
                <p className={`font-black ${accountBalance.balance > 0 ? 'text-red-500' : 'text-lime-600'}`}>${accountBalance.balance.toFixed(2)}</p>
                {accountBalance.unappliedCredits > 0 && <p className="text-[10px] text-violet-600 font-bold">${accountBalance.unappliedCredits.toFixed(2)} credit</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                <p className={`font-black ${tenant.seatsUsed >= tenant.seatsAllowed ? 'text-red-500' : 'text-slate-900'}`}>{tenant.seatsUsed}/{tenant.seatsAllowed}</p>
                {usageBar(tenant.seatsUsed, tenant.seatsAllowed)}
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Locations</p>
                <p className="font-black text-slate-900">{tenant.locationsUsed}/{tenant.locationsAllowed}</p>
                {usageBar(tenant.locationsUsed, tenant.locationsAllowed)}
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Domain</p>
                <p className="font-bold text-slate-900 text-sm">{effectiveDomain || `${tenant.subdomain}.repairplatform.com`}</p>
                <div className="flex gap-1 mt-1">
                  {statusBadge(domainSsl === 'active' ? 'active' : domainSsl)}
                  {statusBadge(domainVerification === 'verified' ? 'verified' : domainVerification)}
                </div>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Onboarded</p>
                <p className="font-black text-slate-900">{tenant.onboardedDate}</p>
              </div>
            </div>

            {(tenant as typeof tenant & { activationStatus?: ActivationStatus; inviteSentDate?: string; activatedDate?: string | null; accountSetupDate?: string | null }).activationStatus && (() => {
              const t = tenant as typeof tenant & { activationStatus: ActivationStatus; inviteSentDate?: string; activatedDate?: string | null; accountSetupDate?: string | null };
              const steps: { key: ActivationStatus; label: string; icon: string }[] = [
                { key: 'invited', label: 'Invited', icon: 'mail' },
                { key: 'pending_activation', label: 'Pending', icon: 'hourglass_top' },
                { key: 'account_setup', label: 'Setup', icon: 'settings' },
                { key: 'active', label: 'Active', icon: 'check_circle' },
              ];
              const currentIdx = steps.findIndex(s => s.key === t.activationStatus);
              return (
                <div className="p-5 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-100 shadow-sm">
                  <div className="flex justify-between items-center mb-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs text-primary">rocket_launch</span>
                      Activation Lifecycle
                    </p>
                    {t.activationStatus !== 'active' && (
                      <div className="flex gap-2">
                        {(t.activationStatus === 'invited' || t.activationStatus === 'pending_activation') && (
                          <button onClick={() => showToast(`Invitation resent to ${tenant.owner.email}`)} className="px-3 py-1.5 bg-blue-500 text-white font-black text-[10px] rounded-lg uppercase tracking-widest hover:bg-blue-600 transition-all flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">forward_to_inbox</span> Resend Invite
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 mb-4">
                    {steps.map((step, idx) => (
                      <React.Fragment key={step.key}>
                        <div className={`flex flex-col items-center gap-1 ${idx <= currentIdx ? 'opacity-100' : 'opacity-30'}`}>
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${idx < currentIdx ? 'bg-lime-100 text-lime-600' : idx === currentIdx ? 'bg-primary/10 text-primary ring-2 ring-primary/30' : 'bg-slate-100 text-slate-400'}`}>
                            <span className="material-symbols-outlined text-sm">{idx < currentIdx ? 'check' : step.icon}</span>
                          </div>
                          <span className="text-[9px] font-black uppercase tracking-widest text-slate-600">{step.label}</span>
                        </div>
                        {idx < steps.length - 1 && <div className={`flex-1 h-0.5 ${idx < currentIdx ? 'bg-lime-300' : 'bg-slate-200'}`} />}
                      </React.Fragment>
                    ))}
                  </div>
                  <div className="flex gap-4 flex-wrap text-[10px] text-slate-500">
                    {t.inviteSentDate && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">mail</span> Invited: {t.inviteSentDate}</span>}
                    {t.accountSetupDate && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">settings</span> Setup: {t.accountSetupDate}</span>}
                    {t.activatedDate && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">check_circle</span> Activated: {t.activatedDate}</span>}
                    {!t.activatedDate && t.activationStatus !== 'active' && (
                      <span className="flex items-center gap-1 text-amber-600"><span className="material-symbols-outlined text-xs">schedule</span> Awaiting {t.activationStatus === 'invited' ? 'invite acceptance' : t.activationStatus === 'pending_activation' ? 'activation' : 'account setup completion'}</span>
                    )}
                  </div>
                  {t.activationStatus === 'active' && (
                    <div className="mt-3 p-3 bg-lime-50 rounded-xl border border-lime-100">
                      <p className="text-sm text-lime-700 font-bold flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">check_circle</span>
                        Tenant fully activated. Store is accessible at {effectiveDomain && domainVerification === 'verified' ? effectiveDomain : `${tenant.subdomain}.repairplatform.com`}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {tenant.flags.length > 0 && (
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">flag</span> Flags
                </p>
                <div className="flex gap-2 flex-wrap">
                  {tenant.flags.map((f, i) => <span key={i} className="px-2.5 py-1 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-400/20">{f}</span>)}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Recent Activity</p>
              <div className="space-y-2">
                {tenantLogs.slice(0, 5).map(log => (
                  <div key={log.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <span className={`material-symbols-outlined text-sm ${log.severity === 'warning' ? 'text-amber-500' : 'text-blue-400'}`}>
                      {log.severity === 'warning' ? 'warning' : 'info'}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-900">{log.action}</p>
                      <p className="text-[10px] text-slate-400">{log.actor} · {log.date}</p>
                    </div>
                    {statusBadge(log.category)}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button onClick={() => setActiveTab('Billing')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">receipt_long</span> View Billing
              </button>
              <button onClick={() => setActiveTab('Usage')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">analytics</span> View Usage
              </button>
              <button onClick={() => setActiveTab('Support Notes')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">support_agent</span> Support Notes
              </button>
              <button onClick={() => setActiveTab('Features')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">tune</span> Features
              </button>
            </div>
          </div>
        )}

        {activeTab === 'Owner & Users' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center flex-wrap gap-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                <span className="material-symbols-outlined text-xs text-violet-500">shield_person</span>
                Store Owners ({storeOwners.length})
              </p>
              <button onClick={() => setCreateOwnerModal(true)} className="px-4 py-2 bg-violet-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-violet-600 transition-all active:scale-95 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">shield_person</span> Create Store Owner
              </button>
            </div>

            <div className="p-3 bg-violet-50 rounded-xl border border-violet-100">
              <p className="text-[10px] text-violet-700 font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">info</span>
                Store Owner identity is platform-controlled. Only System Owners can create, edit, deactivate, or delete Store Owner accounts. Tenant-side roles cannot manage Store Owner identity.
              </p>
            </div>

            <div className="space-y-2">
              {storeOwners.map(user => (
                <button type="button" key={user.id} className="w-full flex justify-between items-center p-4 bg-violet-50/50 rounded-xl border border-violet-100 cursor-pointer hover:bg-violet-50 transition-colors text-left" onClick={() => setUserDetailId(user.id)}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-violet-100 rounded-full flex items-center justify-center">
                      <span className="material-symbols-outlined text-violet-600 text-sm">shield_person</span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-900 flex items-center gap-2">{user.name}{isPrimaryOwner(user.id) && <span className="text-[8px] font-black text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 uppercase tracking-widest">Primary</span>}</p>
                      <p className="text-[10px] text-slate-400">{user.email}</p>
                      {user.lastActive && <p className="text-[10px] text-slate-400">Last active: {user.lastActive}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] font-black text-violet-600 bg-violet-100 px-2 py-1 rounded-lg uppercase tracking-widest">Store Owner</span>
                    {statusBadge(user.status)}
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="border-t border-slate-100 pt-6" />

            <div className="flex justify-between items-center flex-wrap gap-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                <span className="material-symbols-outlined text-xs text-primary">group</span>
                Team Members ({teamMembers.length})
              </p>
              <button onClick={() => setInviteModal(true)} className="px-4 py-2 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">person_add</span> Invite User
              </button>
            </div>

            <div className="space-y-2">
              {teamMembers.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No team members for this tenant.</p>}
              {teamMembers.map(user => (
                <button type="button" key={user.id} className="w-full flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-100 cursor-pointer hover:bg-slate-100 transition-colors text-left" onClick={() => setUserDetailId(user.id)}>
                  <div>
                    <p className="font-bold text-slate-900">{user.name}</p>
                    <p className="text-[10px] text-slate-400">{user.email}</p>
                    {user.lastActive && <p className="text-[10px] text-slate-400">Last active: {user.lastActive}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-slate-600 capitalize">{user.role.replace('_', ' ')}</span>
                    {statusBadge(user.status)}
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>
                </button>
              ))}
            </div>

            <AnimatePresence>
              {selectedUserDetail && (
                <div role="dialog" aria-modal="true" aria-label="User Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setUserDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setUserDetailId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100 flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-black text-primary tracking-tight">{selectedUserDetail.name}</h3>
                        <p className="text-sm text-slate-500 mt-1">{selectedUserDetail.email}</p>
                      </div>
                      {selectedUserDetail.role === 'store_owner' && (
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-[9px] font-black text-violet-600 bg-violet-100 px-2 py-1 rounded-lg uppercase tracking-widest">Store Owner</span>
                          {isPrimaryOwner(selectedUserDetail.id) && <span className="text-[8px] font-black text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 uppercase tracking-widest">Primary</span>}
                        </div>
                      )}
                    </div>
                    <div className="p-8 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Role</p>
                          <p className="font-bold text-slate-900 capitalize">{selectedUserDetail.role.replace('_', ' ')}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Status</p>
                          {statusBadge(selectedUserDetail.status)}
                        </div>
                        <div>
                          <p className={labelClass}>Last Active</p>
                          <p className="font-bold text-slate-900 text-sm">{selectedUserDetail.lastActive || 'Never'}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Phone</p>
                          <p className="font-bold text-slate-900 text-sm">{selectedUserDetail.phone || '—'}</p>
                        </div>
                      </div>
                      {selectedUserDetail.notes && (
                        <div>
                          <p className={labelClass}>Notes</p>
                          <p className="text-sm text-slate-600">{selectedUserDetail.notes}</p>
                        </div>
                      )}
                      {selectedUserDetail.role === 'store_owner' && (
                        <div className="p-3 bg-violet-50 rounded-xl border border-violet-100">
                          <p className="text-[10px] text-violet-700 font-bold flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">shield</span>
                            Platform-controlled identity. Changes to Store Owner accounts are audited.
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 flex-wrap">
                      {selectedUserDetail.status === 'invited' && (
                        <button onClick={() => { showToast(`Invitation resent to ${selectedUserDetail.email}`); }} className="px-4 py-2.5 bg-blue-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-blue-600 transition-all">Resend Invite</button>
                      )}
                      {selectedUserDetail.role === 'store_owner' && selectedUserDetail.status !== 'deactivated' && (
                        <button onClick={() => { setEditOwnerModal(selectedUserDetail.id); setEditOwnerName(selectedUserDetail.name); setEditOwnerEmail(selectedUserDetail.email); setUserDetailId(null); }} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">edit</span> Edit Profile
                        </button>
                      )}
                      {selectedUserDetail.role === 'store_owner' && selectedUserDetail.status === 'active' && (() => {
                        const deactivateCheck = canDeactivateOwner(selectedUserDetail.id);
                        return deactivateCheck.allowed
                          ? <button onClick={() => { setDeactivateOwnerId(selectedUserDetail.id); setUserDetailId(null); }} className="px-4 py-2.5 bg-amber-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-amber-600 transition-all">Deactivate</button>
                          : <span className="px-4 py-2.5 bg-slate-100 text-slate-400 font-black text-[10px] rounded-xl uppercase tracking-widest cursor-not-allowed" title={deactivateCheck.reason}>Deactivate</span>;
                      })()}
                      {selectedUserDetail.role === 'store_owner' && selectedUserDetail.status === 'deactivated' && (
                        <button onClick={() => { setLocalOwnerStatuses(prev => ({ ...prev, [selectedUserDetail.id]: 'active' })); setUserDetailId(null); showToast(`${selectedUserDetail.name} reactivated`); }} className="px-4 py-2.5 bg-lime-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-lime-600 transition-all">Reactivate</button>
                      )}
                      {selectedUserDetail.role === 'store_owner' && (() => {
                        const deleteCheck = canDeleteOwner(selectedUserDetail.id);
                        return deleteCheck.allowed
                          ? <button onClick={() => { setDeleteOwnerId(selectedUserDetail.id); setUserDetailId(null); }} className="px-4 py-2.5 bg-red-100 text-red-600 font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-200 transition-all">Delete</button>
                          : <span className="px-4 py-2.5 bg-slate-100 text-slate-400 font-black text-[10px] rounded-xl uppercase tracking-widest cursor-not-allowed" title={deleteCheck.reason}>Delete</span>;
                      })()}
                      {selectedUserDetail.role === 'store_owner' && (() => {
                        const deleteCheck = canDeleteOwner(selectedUserDetail.id);
                        const deactivateCheck = canDeactivateOwner(selectedUserDetail.id);
                        const blockedReason = !deleteCheck.allowed ? deleteCheck.reason : !deactivateCheck.allowed ? deactivateCheck.reason : null;
                        return blockedReason ? (
                          <div className="w-full mt-1 p-2 bg-slate-50 rounded-lg border border-slate-100">
                            <p className="text-[9px] text-slate-500 font-bold flex items-center gap-1">
                              <span className="material-symbols-outlined text-[10px]">info</span>
                              {blockedReason}
                            </p>
                          </div>
                        ) : null;
                      })()}
                      {selectedUserDetail.status === 'active' && selectedUserDetail.role !== 'store_owner' && (
                        <button onClick={() => { setLocalOwnerStatuses(prev => ({ ...prev, [selectedUserDetail.id]: 'deactivated' })); setUserDetailId(null); showToast(`${selectedUserDetail.name} deactivated`); }} className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Deactivate</button>
                      )}
                      <button onClick={() => setUserDetailId(null)} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ml-auto">Close</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {editOwnerModal && (
                <div role="dialog" aria-modal="true" aria-label="Edit Store Owner" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setEditOwnerModal(null)} onKeyDown={e => { if (e.key === 'Escape') setEditOwnerModal(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Edit Store Owner Profile</h3>
                      <p className="text-sm text-slate-500 mt-1">Platform-controlled identity update for {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-5">
                      <div>
                        <label htmlFor="edit-owner-name" className={labelClass}>Full Name</label>
                        <input id="edit-owner-name" value={editOwnerName} onChange={e => setEditOwnerName(e.target.value)} className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="edit-owner-email" className={labelClass}>Email</label>
                        <input id="edit-owner-email" value={editOwnerEmail} onChange={e => setEditOwnerEmail(e.target.value)} className={inputClass} type="email" />
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setEditOwnerModal(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button disabled={!editOwnerName || !editOwnerEmail.includes('@')} onClick={() => { setLocalOwnerEdits(prev => ({ ...prev, [editOwnerModal!]: { name: editOwnerName, email: editOwnerEmail } })); setEditOwnerModal(null); showToast('Store Owner profile updated'); }} className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest transition-all disabled:opacity-40 hover:bg-primary/90">Save Changes</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {deactivateOwnerId && (() => {
                const deactivateCheck = canDeactivateOwner(deactivateOwnerId);
                return (
                  <div role="dialog" aria-modal="true" aria-label="Deactivate Store Owner" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setDeactivateOwnerId(null)} onKeyDown={e => { if (e.key === 'Escape') setDeactivateOwnerId(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-primary tracking-tight">{deactivateCheck.allowed ? 'Deactivate Store Owner' : 'Deactivation Blocked'}</h3>
                        <p className="text-sm text-slate-500 mt-1">{deactivateCheck.allowed ? `This will revoke the Store Owner's access to ${tenant.name}.` : 'This action cannot be completed right now.'}</p>
                      </div>
                      <div className="p-8 space-y-4">
                        {!deactivateCheck.allowed ? (
                          <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                            <p className="text-sm text-amber-700 font-bold flex items-center gap-2">
                              <span className="material-symbols-outlined text-sm">shield</span>
                              {deactivateCheck.reason}
                            </p>
                          </div>
                        ) : (
                          <div className="p-3 bg-amber-50 rounded-xl border border-amber-100">
                            <p className="text-sm text-amber-700 font-bold flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">warning</span>
                              The owner will lose all admin access. This action can be reversed by reactivating the account.
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setDeactivateOwnerId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">{deactivateCheck.allowed ? 'Cancel' : 'Close'}</button>
                        {deactivateCheck.allowed && (
                          <button onClick={() => { setLocalOwnerStatuses(prev => ({ ...prev, [deactivateOwnerId]: 'deactivated' })); setDeactivateOwnerId(null); showToast('Store Owner account deactivated'); }} className="flex-1 py-4 bg-amber-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-amber-500/20 uppercase tracking-widest transition-all hover:bg-amber-600">Deactivate</button>
                        )}
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {deleteOwnerId && (() => {
                const deleteCheck = canDeleteOwner(deleteOwnerId);
                return (
                  <div role="dialog" aria-modal="true" aria-label="Delete Store Owner" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setDeleteOwnerId(null)} onKeyDown={e => { if (e.key === 'Escape') setDeleteOwnerId(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-red-600 tracking-tight">{deleteCheck.allowed ? 'Delete Store Owner' : 'Deletion Blocked'}</h3>
                        <p className="text-sm text-slate-500 mt-1">{deleteCheck.allowed ? `Permanently remove this Store Owner from ${tenant.name}.` : 'This action cannot be completed right now.'}</p>
                      </div>
                      <div className="p-8 space-y-4">
                        {!deleteCheck.allowed && (
                          <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                            <p className="text-sm text-amber-700 font-bold flex items-center gap-2">
                              <span className="material-symbols-outlined text-sm">shield</span>
                              {deleteCheck.reason}
                            </p>
                          </div>
                        )}
                        {!deleteCheck.allowed && isPrimaryOwner(deleteOwnerId) && activeStoreOwners.length > 1 && (
                          <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                            <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest mb-2">Reassign Primary Ownership First</p>
                            <p className="text-sm text-blue-600 mb-3">Select a new primary Store Owner before deleting this account.</p>
                            <button onClick={() => { setDeleteOwnerId(null); setReassignOwnerId(deleteOwnerId); }} className="px-4 py-2 bg-blue-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-blue-600 transition-all">Start Reassignment</button>
                          </div>
                        )}
                        {deleteCheck.allowed && (
                          <div className="p-3 bg-red-50 rounded-xl border border-red-100">
                            <p className="text-sm text-red-700 font-bold flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">error</span>
                              This action is permanent and cannot be undone. The account and all associated permissions will be removed.
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setDeleteOwnerId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">{deleteCheck.allowed ? 'Cancel' : 'Close'}</button>
                        {deleteCheck.allowed && (
                          <button onClick={() => { setLocalOwnerStatuses(prev => ({ ...prev, [deleteOwnerId]: 'deleted' })); setDeleteOwnerId(null); showToast('Store Owner account deleted'); }} className="flex-1 py-4 bg-red-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-red-500/20 uppercase tracking-widest transition-all hover:bg-red-600">Delete Permanently</button>
                        )}
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {reassignOwnerId && (() => {
                const currentOwner = allScopedUsers.find(u => u.id === reassignOwnerId);
                const otherOwners = storeOwners.filter(o => o.id !== reassignOwnerId && o.status === 'active');
                return (
                  <div role="dialog" aria-modal="true" aria-label="Reassign Primary Ownership" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setReassignOwnerId(null)} onKeyDown={e => { if (e.key === 'Escape') setReassignOwnerId(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-primary tracking-tight">Reassign Primary Ownership</h3>
                        <p className="text-sm text-slate-500 mt-1">Transfer primary ownership from {currentOwner?.name} to another Store Owner.</p>
                      </div>
                      <div className="p-8 space-y-4">
                        <div className="p-3 bg-violet-50 rounded-xl border border-violet-100">
                          <p className="text-[10px] text-violet-700 font-bold flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">info</span>
                            The new primary owner will become the main contact and governance anchor for this tenant.
                          </p>
                        </div>
                        <div>
                          <p className={labelClass}>Select New Primary Owner</p>
                          <div className="space-y-2">
                            {otherOwners.map(o => (
                              <button key={o.id} onClick={() => {
                                setPrimaryOwnerId(o.id);
                                setReassignOwnerId(null);
                                showToast(`Primary ownership reassigned to ${o.name}. You may now delete the previous owner.`);
                              }} className="w-full flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100 hover:bg-violet-50 hover:border-violet-200 transition-colors text-left">
                                <div className="w-8 h-8 bg-violet-100 rounded-full flex items-center justify-center">
                                  <span className="material-symbols-outlined text-violet-600 text-sm">shield_person</span>
                                </div>
                                <div>
                                  <p className="font-bold text-slate-900 text-sm">{o.name}</p>
                                  <p className="text-[10px] text-slate-400">{o.email}</p>
                                </div>
                              </button>
                            ))}
                          </div>
                          {otherOwners.length === 0 && <p className="text-sm text-slate-400 font-bold py-2">No other active Store Owners available. Create a new Store Owner first.</p>}
                        </div>
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setReassignOwnerId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {createOwnerModal && (
                <div role="dialog" aria-modal="true" aria-label="Create Store Owner" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setCreateOwnerModal(false)} onKeyDown={e => { if (e.key === 'Escape') setCreateOwnerModal(false); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Create Store Owner</h3>
                      <p className="text-sm text-slate-500 mt-1">Platform-controlled action. Creates a new Store Owner account for {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-5">
                      <div className="p-3 bg-violet-50 rounded-xl border border-violet-100">
                        <p className="text-[10px] font-bold text-violet-700 flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">shield</span>
                          This action is only available to System Owners. The new Store Owner will have full tenant admin access.
                        </p>
                      </div>
                      <div>
                        <label htmlFor="create-owner-name" className={labelClass}>Full Name</label>
                        <input id="create-owner-name" value={createOwnerName} onChange={e => setCreateOwnerName(e.target.value)} className={inputClass} placeholder="Full name" />
                      </div>
                      <div>
                        <label htmlFor="create-owner-email" className={labelClass}>Email</label>
                        <input id="create-owner-email" value={createOwnerEmail} onChange={e => setCreateOwnerEmail(e.target.value)} className={inputClass} placeholder="owner@business.com" type="email" />
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => { setCreateOwnerModal(false); setCreateOwnerName(''); setCreateOwnerEmail(''); }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button disabled={!createOwnerName || !createOwnerEmail.includes('@')} onClick={() => { setLocalCreatedOwners(prev => [...prev, { id: `owner-local-${Date.now()}`, name: createOwnerName, email: createOwnerEmail, status: 'invited' }]); setCreateOwnerModal(false); showToast(`Store Owner account created for ${createOwnerEmail}. Invitation sent.`); setCreateOwnerName(''); setCreateOwnerEmail(''); }} className="flex-1 py-4 bg-violet-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-violet-500/20 uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-violet-600">Create Owner</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {inviteModal && (
                <div role="dialog" aria-modal="true" aria-label="Invite User" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setInviteModal(false)} onKeyDown={e => { if (e.key === 'Escape') setInviteModal(false); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Invite User</h3>
                      <p className="text-sm text-slate-500 mt-1">Invite a team member to {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-5">
                      <div>
                        <label htmlFor="invite-name" className={labelClass}>Name</label>
                        <input id="invite-name" value={inviteName} onChange={e => setInviteName(e.target.value)} className={inputClass} placeholder="Full name" />
                      </div>
                      <div>
                        <label htmlFor="invite-email" className={labelClass}>Email</label>
                        <input id="invite-email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} className={inputClass} placeholder="user@business.com" type="email" />
                      </div>
                      <div>
                        <label htmlFor="invite-role" className={labelClass}>Role</label>
                        <select id="invite-role" value={inviteRole} onChange={e => setInviteRole(e.target.value)} className={inputClass}>
                          <option value="technician">Technician</option>
                          <option value="manager">Manager</option>
                          <option value="sales_staff">Sales Staff</option>
                        </select>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => { setInviteModal(false); setInviteName(''); setInviteEmail(''); }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button disabled={!inviteName || !inviteEmail.includes('@')} onClick={() => { setInviteModal(false); showToast(`Invitation sent to ${inviteEmail}`); setInviteName(''); setInviteEmail(''); }} className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90">Send Invite</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Subscription' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Current Plan</p>
                <p className="font-black text-primary text-lg capitalize">{currentPlan}</p>
                <p className="text-[10px] text-slate-400">${currentPlanObj?.price || tenant.mrr}/mo</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Billing Cycle</p>
                <p className="font-black text-slate-900 capitalize">{tenant.billingCycle}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next Renewal</p>
                <p className="font-black text-slate-900">{tenant.renewal}</p>
                <p className={`text-[10px] font-bold ${daysUntilRenewal <= 7 ? 'text-red-500' : 'text-slate-400'}`}>{daysUntilRenewal > 0 ? `${daysUntilRenewal} days` : 'Overdue'}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Status</p>
                {statusBadge(tenant.status)}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Plan Limits</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-600">Seats</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-black ${tenant.seatsUsed >= (currentPlanObj?.limits.seats || tenant.seatsAllowed) ? 'text-red-500' : 'text-slate-900'}`}>{tenant.seatsUsed} / {currentPlanObj?.limits.seats || tenant.seatsAllowed}</span>
                    {tenant.seatsUsed >= (currentPlanObj?.limits.seats || tenant.seatsAllowed) && <span className="text-[8px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded uppercase">At Limit</span>}
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-600">Locations</span>
                  <span className="font-black text-slate-900">{tenant.locationsUsed} / {currentPlanObj?.limits.locations || tenant.locationsAllowed}</span>
                </div>
              </div>
            </div>

            {tenant.status === 'trialing' && tenant.trialEnd && (
              <div className="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-[10px] font-black text-indigo-700 uppercase tracking-widest mb-1">Trial Period</p>
                    <p className="font-bold text-indigo-900">Expires {tenant.trialEnd}</p>
                    <p className="text-[10px] text-indigo-500">
                      {Math.ceil((new Date(tenant.trialEnd).getTime() - new Date('2026-03-26').getTime()) / (1000 * 60 * 60 * 24))} days remaining
                    </p>
                  </div>
                  <button onClick={() => setTrialExtendModal(true)} className="px-4 py-2 bg-indigo-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-indigo-600 transition-all">Extend Trial</button>
                </div>
              </div>
            )}

            {tenantAddOns.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Available Add-ons</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {tenantAddOns.map(addon => (
                    <div key={addon.id} className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-100">
                      <div>
                        <p className="font-bold text-slate-900">{addon.name}</p>
                        <p className="text-[10px] text-slate-400">{addon.description.slice(0, 60)}...</p>
                      </div>
                      <span className="font-black text-primary">${addon.price}/mo</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Change Plan</p>
              <div className="flex gap-2 flex-wrap">
                {plans.filter(p => p.id !== currentPlan).map(p => {
                  const isUpgrade = plans.findIndex(pl => pl.id === p.id) > plans.findIndex(pl => pl.id === currentPlan);
                  return (
                    <button key={p.id} onClick={() => setPlanChangeModal(p.id)} className={`px-4 py-2.5 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ${isUpgrade ? 'bg-lime-500 hover:bg-lime-600 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}>
                      {isUpgrade ? 'Upgrade' : 'Downgrade'} to {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {tenantPlanHistory.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Plan History</p>
                <div className="space-y-2">
                  {tenantPlanHistory.map(ph => (
                    <div key={ph.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-sm text-slate-400">history</span>
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{ph.fromPlan ? `${ph.fromPlan} → ${ph.toPlan}` : ph.toPlan}</p>
                          <p className="text-[10px] text-slate-400">{ph.date}</p>
                        </div>
                      </div>
                      {statusBadge(ph.type)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AnimatePresence>
              {planChangeModal && (() => {
                const targetPlan = plans.find(p => p.id === planChangeModal);
                const isUp = plans.findIndex(pl => pl.id === planChangeModal) > plans.findIndex(pl => pl.id === currentPlan);
                return (
                  <div role="dialog" aria-modal="true" aria-label="Plan Change" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setPlanChangeModal(null)} onKeyDown={e => { if (e.key === 'Escape') setPlanChangeModal(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-primary tracking-tight">{isUp ? 'Upgrade' : 'Downgrade'} Plan</h3>
                        <p className="text-sm text-slate-500 mt-1">{tenant.name}: {currentPlan} → {targetPlan?.name}</p>
                      </div>
                      <div className="p-8 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Current</p>
                            <p className="font-black text-slate-900 capitalize">{currentPlan}</p>
                            <p className="text-sm text-slate-500">${currentPlanObj?.price || tenant.mrr}/mo</p>
                          </div>
                          <div className={`p-4 rounded-xl border ${isUp ? 'bg-lime-50 border-lime-100' : 'bg-amber-50 border-amber-100'}`}>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">New</p>
                            <p className="font-black text-slate-900">{targetPlan?.name}</p>
                            <p className="text-sm text-slate-500">${targetPlan?.price}/mo</p>
                          </div>
                        </div>
                        <div className="p-3 bg-amber-50 rounded-xl border border-amber-100">
                          <p className="text-sm text-amber-700 font-bold">
                            {isUp ? 'Upgrade is effective immediately. Pro-rated charges will apply.' : 'Downgrade takes effect at next billing cycle. Features may be reduced.'}
                          </p>
                        </div>
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setPlanChangeModal(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                        <button onClick={() => { setCurrentPlan(planChangeModal); setPlanChangeModal(null); showToast(`Plan ${isUp ? 'upgraded' : 'downgraded'} to ${targetPlan?.name}`); }} className={`flex-1 py-4 text-white font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest transition-all ${isUp ? 'bg-lime-600 hover:bg-lime-700 shadow-lime-600/20' : 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20'}`}>Confirm {isUp ? 'Upgrade' : 'Downgrade'}</button>
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {trialExtendModal && (
                <div role="dialog" aria-modal="true" aria-label="Extend Trial" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setTrialExtendModal(false)} onKeyDown={e => { if (e.key === 'Escape') setTrialExtendModal(false); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Extend Trial</h3>
                      <p className="text-sm text-slate-500 mt-1">Extend the trial period for {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div>
                        <label htmlFor="trial-days" className={labelClass}>Extension Days</label>
                        <select id="trial-days" value={trialDays} onChange={e => setTrialDays(e.target.value)} className={inputClass}>
                          <option value="7">7 days</option>
                          <option value="14">14 days</option>
                          <option value="30">30 days</option>
                        </select>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setTrialExtendModal(false)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button onClick={() => { setTrialExtendModal(false); showToast(`Trial extended by ${trialDays} days`); }} className="flex-1 py-4 bg-indigo-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-indigo-500/20 uppercase tracking-widest transition-all hover:bg-indigo-600">Extend</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Features' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center flex-wrap gap-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Features for <span className="text-primary capitalize">{currentPlan}</span> plan</p>
              <div className="flex gap-1.5 flex-wrap">
                {statusBadge('inherited')}
                {statusBadge('overridden')}
                {statusBadge('trial')}
                {statusBadge('addon')}
                {statusBadge('disabled')}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {liveFeatureMatrix.filter(f => {
                if (f.lifecycle === 'draft') return false;
                // Add-on-derived row visibility rule (locked):
                // when a feature is linked to a catalog Add-on, the
                // row only appears in this tenant's Features tab if
                // (a) the Add-on is `governanceStatus === 'active'`
                // AND (b) the tenant's current plan is in the
                // Add-on's `compatiblePlans`. If either is false the
                // entire row is hidden — no "Not in Plan", no
                // "Add-on", no Trial/Paid Override actions, no
                // "Plan upgrade required". This applies even when a
                // historical override (trial / pending payment /
                // paid / revoked) exists on the feature; the
                // historical record is preserved in Billing / Audit.
                // Normal plan/core features that are not linked to
                // any catalog Add-on are always shown.
                // Features that ARE included in the tenant's plan
                // baseline are also always shown — the visibility
                // gate only applies to rows that would otherwise be
                // available solely via the add-on path.
                const planKey = currentPlan === 'starter' ? 'essential' : currentPlan;
                const inPlanBaseline = !!f.planAvailability[planKey];
                const linkedAddOn =
                  liveAddOns.find(a => a.linkedFeatureId === f.id) ||
                  liveAddOns.find(a => a.id === f.id);
                if (inPlanBaseline) return true;
                if (!linkedAddOn) return true;
                const addOnEligible =
                  linkedAddOn.governanceStatus === 'active' &&
                  linkedAddOn.compatiblePlans.includes(currentPlan);
                return addOnEligible;
              }).map(feature => {
                const r = resolveFeature(feature.id);
                const enabled = r.enabled;
                const reason: EntitlementReason = r.reason;
                const ov = r.override;
                const ovAny = ov as (typeof ov & { price?: number; pricingModel?: string }) | undefined;
                const isPendingPayment = ov?.type === 'pending_payment' && !ov.revokedDate;
                const isTrialActive = reason === 'enabled_by_trial_addon';
                const isPaidActive = reason === 'enabled_by_paid_addon' || reason === 'enabled_by_paid_override';
                const isExpired = reason === 'trial_expired';
                const isRevoked = reason === 'override_revoked';
                const isAddOnDisabled = reason === 'addon_disabled' || reason === 'addon_archived';
                // An "available" linked add-on must be (a) active in the
                // governance catalog AND (b) compatible with the
                // tenant's current plan. Used by the secondary
                // "Add-on Available" pill and by the Paid Override
                // modal price/cadence pre-fill. Disabled / archived /
                // plan-incompatible add-ons must NOT contribute either.
                const eligibleAddOn =
                  r.addOn &&
                  r.addOn.governanceStatus === 'active' &&
                  r.addOn.compatiblePlans.includes(currentPlan);
                // Trial / Paid Override (fresh grant) buttons are only
                // for rows with NO prior override history at all. If a
                // revoked or expired override row exists, the row
                // surfaces Re-trial / Re-grant Paid instead — never
                // both action families together. This prevents the
                // confusing 4-button cluster on revoked rows
                // (Trial / Paid Override / Re-trial / Re-grant Paid).
                const canOfferGrant =
                  feature.lifecycle === 'implemented' &&
                  !enabled &&
                  !ov &&
                  reason !== 'feature_disabled_by_owner';
                // Add-on Implementation Readiness — apply grant safety
                // gating for any row whose linked add-on isn't fully
                // runtime-backed. Block placeholders / implementation-
                // required (unless allowManualPresaleGrant), and surface
                // a compact reason chip + warning for partial / parent-
                // feature linked. When no linked add-on exists, the row
                // is a plain plan/feature row and grant safety is N/A.
                // See replit.md → "Add-on Implementation Readiness".
                const grantSafety = r.addOn ? getAddOnGrantSafety(r.addOn) : null;
                const grantBlockedByReadiness = !!grantSafety && !grantSafety.allowed;
                const grantWarningByReadiness = !!grantSafety && grantSafety.allowed && grantSafety.requiresWarning;
                const finalCanOfferGrant = canOfferGrant && !grantBlockedByReadiness;
                const finalCanReGrant = (isExpired || isRevoked) && feature.lifecycle === 'implemented' && !grantBlockedByReadiness;
                const cardBg = isPendingPayment
                  ? 'bg-amber-50/50 border-amber-100'
                  : isExpired
                    ? 'bg-orange-50/50 border-orange-100'
                    : isRevoked
                      ? 'bg-red-50/40 border-red-100'
                      : enabled
                        ? 'bg-slate-50 border-slate-100'
                        : 'bg-slate-50/50 border-slate-100/50';
                const iconColor = isPendingPayment
                  ? 'text-amber-500'
                  : isExpired
                    ? 'text-orange-500'
                    : isRevoked
                      ? 'text-red-500'
                      : enabled
                        ? 'text-lime-600'
                        : 'text-slate-300';
                const iconName = isPendingPayment
                  ? 'hourglass_top'
                  : isExpired
                    ? 'history_toggle_off'
                    : isRevoked
                      ? 'block'
                      : enabled
                        ? 'check_circle'
                        : 'remove_circle_outline';
                const titleColor = enabled
                  ? 'text-slate-900'
                  : isPendingPayment
                    ? 'text-amber-800'
                    : isExpired
                      ? 'text-orange-800'
                      : isRevoked
                        ? 'text-red-800'
                        : 'text-slate-400';
                const reasonBadgeClass = enabled
                  ? 'bg-lime-50 text-lime-700 border-lime-100'
                  : isPendingPayment
                    ? 'bg-amber-50 text-amber-700 border-amber-100'
                    : isExpired
                      ? 'bg-orange-50 text-orange-700 border-orange-100'
                      : isRevoked
                        ? 'bg-red-50 text-red-700 border-red-100'
                        : isAddOnDisabled
                          ? 'bg-slate-100 text-slate-600 border-slate-200'
                          : 'bg-slate-50 text-slate-500 border-slate-100';
                return (
                  <div key={feature.id} className={`p-4 rounded-xl border ${cardBg}`}>
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <span className={`material-symbols-outlined text-sm mt-0.5 ${iconColor}`}>{iconName}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-bold ${titleColor}`}>{feature.name}</span>
                            {feature.lifecycle !== 'implemented' && (
                              <span className="text-[8px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">{feature.lifecycle}</span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-500 mt-1">{REASON_EXPLAINER[reason]}</p>
                          {isTrialActive && ov?.trialEnd && <p className="text-[10px] text-indigo-500 font-bold mt-0.5">Trial until {ov.trialEnd}</p>}
                          {(isPaidActive || isPendingPayment) && ovAny?.price !== undefined && ovAny.price > 0 && (
                            <p className={`text-[10px] font-bold mt-0.5 ${isPendingPayment ? 'text-amber-600' : 'text-emerald-600'}`}>
                              ${ovAny.price}/{ovAny.pricingModel === 'monthly' ? 'mo' : ovAny.pricingModel === 'annual' ? 'yr' : 'once'}
                              {r.addOn && r.addOn.price !== ovAny.price && (
                                <span className="ml-1.5 text-[9px] font-black text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded uppercase tracking-widest">Custom Price</span>
                              )}
                              {isPendingPayment ? ' · Awaiting payment' : ''}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        <div className="flex items-center gap-1.5 flex-wrap justify-end">
                          <span className={`text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest whitespace-nowrap ${reasonBadgeClass}`}>{REASON_LABEL[reason]}</span>
                          {/* Add-on visibility (locked rule): an add-on
                              surfaces in a tenant's Features tab ONLY when
                              all three are true:
                                1) feature is linked to a catalog add-on
                                2) catalog add-on governanceStatus === 'active'
                                3) tenant's current plan is in compatiblePlans
                              All three are captured by `eligibleAddOn`. If
                              any is false, no add-on pill renders — the row
                              shows only its normal feature state. There is
                              NO "Plan upgrade required" tail; an
                              incompatible add-on is simply not shown as an
                              add-on at all.

                              Emerald "Add-on available" appears next to a
                              `Not in Plan` row when the add-on can actually
                              be granted now. Violet "Add-on" appears next
                              to `Paid Override` / `Pending Payment` rows
                              that are linked to an active+compatible
                              catalog add-on. The violet pill is suppressed
                              when the row's primary reason is already
                              `enabled_by_paid_addon` (whose own primary
                              pill already reads "Add-on") so the badges
                              don't double up. The Custom Price pill is
                              rendered separately below the price line and
                              only when tenant price diverges from catalog
                              price. */}
                          {reason === 'disabled_by_plan' && eligibleAddOn && (
                            <span className="text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest whitespace-nowrap bg-emerald-50 text-emerald-700 border-emerald-100">Add-on</span>
                          )}
                          {/* Source-of-truth rule (Part C-1): when a feature
                              is included by the tenant's plan AND a linked
                              catalog Add-on exists and is active, surface
                              "Included by Plan" + "Add-on" so the operator
                              sees the entitlement comes from plan inclusion
                              backed by an add-on capability. No Trial /
                              Paid Override actions are offered for this
                              row because the feature is already included.
                              An archived/disabled linked add-on does NOT
                              get an active "Add-on" badge here. */}
                          {reason === 'included_by_plan' && r.addOn && r.addOn.governanceStatus === 'active' && (
                            <span className="text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest whitespace-nowrap bg-emerald-50 text-emerald-700 border-emerald-100">Add-on</span>
                          )}
                          {(isPaidActive || isPendingPayment) && eligibleAddOn && reason !== 'enabled_by_paid_addon' && (
                            <span className="text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest whitespace-nowrap bg-violet-50 text-violet-700 border-violet-100">Add-on</span>
                          )}
                          {/* Spec L: surface "Invoice Open / Overdue" alongside Paid Override
                              when the linked SaaS invoice is still open. */}
                          {isPaidActive && (r.invoiceUiStatus === 'open' || r.invoiceUiStatus === 'overdue') && (
                            <span className={`text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest whitespace-nowrap ${r.invoiceUiStatus === 'overdue' ? 'bg-red-50 text-red-700 border-red-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}>
                              Invoice {r.invoiceUiStatus === 'overdue' ? 'Overdue' : 'Open'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-wrap justify-end">
                          {/* Spec L: Pending payment rows show ONLY Mark Paid / Cancel
                              Invoice / View Invoice — no Trial, no Paid Override, no Re-grant. */}
                          {finalCanOfferGrant && !isPendingPayment && canGrantTrial && (
                              <button
                                onClick={() => setFeatureTrialModal(feature.id)}
                                title={grantWarningByReadiness ? grantSafety!.warningText : undefined}
                                className={`text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest transition-colors ${
                                  grantWarningByReadiness
                                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                    : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
                                }`}
                              >Trial</button>
                          )}
                          {finalCanOfferGrant && !isPendingPayment && canGrantPaidOverride && (
                              <button
                                onClick={() => { setPaidOverridePrice(eligibleAddOn && r.addOn?.price ? String(r.addOn.price) : ''); setPaidOverrideModel(eligibleAddOn && r.addOn?.billingCadence === 'annual' ? 'annual' : eligibleAddOn && r.addOn?.billingCadence === 'one_time' ? 'one_time' : 'monthly'); setPaidOverrideActivation('after_payment'); setPaidOverrideDueDate((() => { const d = new Date('2026-03-26'); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })()); setFeaturePaidModal(feature.id); }}
                                title={grantWarningByReadiness ? grantSafety!.warningText : undefined}
                                className={`text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest transition-colors ${
                                  grantWarningByReadiness
                                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                    : 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100'
                                }`}
                              >Paid Override</button>
                          )}
                          {/* Add-on Implementation Readiness — compact reason
                              chip when grant is blocked, or short warning
                              badge when allowed-with-warning. Tooltip
                              carries the longer explanation. The chip
                              replaces the buttons when blocked so the
                              operator sees why. */}
                          {grantSafety && grantBlockedByReadiness && canOfferGrant && !isPendingPayment && (
                            <span
                              title={grantSafety.blockReason || ''}
                              className="text-[8px] font-black text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg uppercase tracking-widest"
                            >{grantSafety.shortBadge || 'Not Grantable'}</span>
                          )}
                          {grantSafety && grantWarningByReadiness && canOfferGrant && !isPendingPayment && grantSafety.shortBadge && (
                            <span
                              title={grantSafety.warningText}
                              className="text-[8px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg uppercase tracking-widest"
                            >{grantSafety.shortBadge}</span>
                          )}
                          {isAddOnDisabled && feature.lifecycle === 'implemented' && (
                            <span className="text-[8px] font-black text-slate-500 bg-slate-100 px-2 py-1 rounded-lg uppercase tracking-widest">Catalog {reason === 'addon_archived' ? 'archived' : 'disabled'}</span>
                          )}
                          {isPendingPayment && ov?.invoiceId && (
                            <>
                              <button onClick={() => handleMarkInvoicePaid(ov.invoiceId!)} className="text-[8px] font-black text-lime-600 bg-lime-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-lime-100 transition-colors">Mark Paid</button>
                              <button onClick={() => handleCancelInvoiceClick(ov.invoiceId!)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Cancel Invoice</button>
                              <button onClick={() => { setActiveTab('Billing'); setCommercialInvoiceDetailId(ov.invoiceId!); }} className="text-[8px] font-black text-slate-600 bg-slate-100 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-slate-200 transition-colors">View Invoice</button>
                            </>
                          )}
                          {/* Legacy pending-payment rows that pre-date invoices keep
                              the original Approve/Cancel pair so they still resolve. */}
                          {isPendingPayment && !ov?.invoiceId && (
                            <button onClick={() => handleRevokeFeature(feature.id)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Cancel</button>
                          )}
                          {isTrialActive && canRevokeOverride && (
                            <button onClick={() => handleRevokeFeature(feature.id)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">End Trial</button>
                          )}
                          {isPaidActive && canRevokeOverride && (
                            <>
                              <button onClick={() => handleRevokeFeature(feature.id)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Revoke</button>
                              {ov?.invoiceId && (r.invoiceUiStatus === 'open' || r.invoiceUiStatus === 'overdue') && (
                                <>
                                  <button onClick={() => handleMarkInvoicePaid(ov.invoiceId!)} className="text-[8px] font-black text-lime-600 bg-lime-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-lime-100 transition-colors">Mark Paid</button>
                                  <button onClick={() => { setActiveTab('Billing'); setCommercialInvoiceDetailId(ov.invoiceId!); }} className="text-[8px] font-black text-slate-600 bg-slate-100 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-slate-200 transition-colors">View Invoice</button>
                                </>
                              )}
                            </>
                          )}
                          {finalCanReGrant && canGrantTrial && (
                              <button
                                onClick={() => setFeatureTrialModal(feature.id)}
                                title={grantWarningByReadiness ? grantSafety!.warningText : undefined}
                                className={`text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest transition-colors ${
                                  grantWarningByReadiness
                                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                    : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
                                }`}
                              >Re-trial</button>
                          )}
                          {finalCanReGrant && canGrantPaidOverride && (
                              <button
                                onClick={() => { setPaidOverridePrice(eligibleAddOn && r.addOn?.price ? String(r.addOn.price) : ''); setPaidOverrideModel(eligibleAddOn && r.addOn?.billingCadence === 'annual' ? 'annual' : eligibleAddOn && r.addOn?.billingCadence === 'one_time' ? 'one_time' : 'monthly'); setPaidOverrideActivation('after_payment'); setPaidOverrideDueDate((() => { const d = new Date('2026-03-26'); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })()); setFeaturePaidModal(feature.id); }}
                                title={grantWarningByReadiness ? grantSafety!.warningText : undefined}
                                className={`text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest transition-colors ${
                                  grantWarningByReadiness
                                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                    : 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100'
                                }`}
                              >Re-grant Paid</button>
                          )}
                          {(isExpired || isRevoked) && feature.lifecycle === 'implemented' && grantBlockedByReadiness && (
                            <span
                              title={grantSafety!.blockReason || ''}
                              className="text-[8px] font-black text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg uppercase tracking-widest"
                            >{grantSafety!.shortBadge || 'Not Grantable'}</span>
                          )}
                          {/* Part F: Disabled by Owner only renders when there
                              is a real disabled override AND the plan would
                              otherwise include the feature (resolver guarded).
                              Surface a clear Re-enable action so the state
                              is reversible. */}
                          {reason === 'feature_disabled_by_owner' && (
                            <button onClick={() => handleReenableFeature(feature.id)} className="text-[8px] font-black text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-emerald-100 transition-colors">Re-enable</button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Per the QA correction pass: the Tenant Features tab is a
                  commercial entitlement surface only — it must not duplicate
                  permission detail. Role-level sub-permissions are managed
                  in the Store Permissions Matrix. A single lightweight
                  link is provided here as a wayfinder. */}
              <p className="text-[10px] text-slate-400 italic mt-2 px-1">
                Manage role permissions in the Store Permissions Matrix.
              </p>
            </div>
            {(() => {
              // Apply the same row-visibility gate to the Override
              // History list: when an override is on a feature that
              // would otherwise be hidden from the active grid (linked
              // to an ineligible add-on AND not in the tenant's plan
              // baseline), suppress it from this list too. The
              // historical record itself is preserved in the SaaS
              // Subscription Invoices section of the Billing tab and
              // in the Commercial Audit log.
              const planKey = currentPlan === 'starter' ? 'essential' : currentPlan;
              const visibleOverrides = localOverrides.filter(o => {
                const f = liveFeatureMatrix.find(ft => ft.id === o.featureId);
                if (!f) return false;
                if (f.lifecycle === 'draft') return false;
                if (f.planAvailability[planKey]) return true;
                const linkedAddOn =
                  liveAddOns.find(a => a.linkedFeatureId === f.id) ||
                  liveAddOns.find(a => a.id === f.id);
                if (!linkedAddOn) return true;
                return (
                  linkedAddOn.governanceStatus === 'active' &&
                  linkedAddOn.compatiblePlans.includes(currentPlan)
                );
              });
              if (visibleOverrides.length === 0) return null;
              return (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 mt-4">Override History</p>
                <div className="space-y-2">
                  {visibleOverrides.map((o, i) => {
                    const f = liveFeatureMatrix.find(ft => ft.id === o.featureId);
                    const ov = o as typeof o & { price?: number; pricingModel?: string; pricingNotes?: string };
                    const wasRevoked = !!o.revokedDate;
                    return (
                      <div key={i} className={`flex justify-between items-center p-3 rounded-xl border ${wasRevoked ? 'bg-red-50/40 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
                        <div>
                          <p className={`font-bold text-sm ${wasRevoked ? 'text-red-800' : 'text-slate-900'}`}>{f?.name || o.featureId}</p>
                          <p className="text-[10px] text-slate-400">{o.addedBy} · {o.addedDate}{o.trialEnd ? ` · Trial until ${o.trialEnd}` : ''}</p>
                          {ov.price !== undefined && ov.price > 0 && (
                            <p className={`text-[10px] font-bold ${wasRevoked ? 'text-slate-500 line-through' : 'text-emerald-600'}`}>${ov.price}/{ov.pricingModel === 'monthly' ? 'mo' : ov.pricingModel === 'annual' ? 'yr' : 'once'}{ov.pricingNotes ? ` · ${ov.pricingNotes}` : ''}</p>
                          )}
                          {wasRevoked && (
                            <p className="text-[10px] font-bold text-red-600">Revoked {o.revokedDate} by {o.revokedBy}{o.revokeReason ? ` · ${o.revokeReason}` : ''}</p>
                          )}
                        </div>
                        {wasRevoked ? (
                          <span className="text-[9px] font-black px-2 py-1 rounded-lg border uppercase tracking-widest bg-red-50 text-red-700 border-red-100">Revoked</span>
                        ) : (
                          statusBadge(o.type)
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              );
            })()}

            <AnimatePresence>
              {featureTrialModal && (
                <div role="dialog" aria-modal="true" aria-label="Enable Feature Trial" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setFeatureTrialModal(null)} onKeyDown={e => { if (e.key === 'Escape') setFeatureTrialModal(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Enable Feature Trial</h3>
                      <p className="text-sm text-slate-500 mt-1">Grant {tenant.name} trial access to {featureMatrix.find(f => f.id === featureTrialModal)?.name}.</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div>
                        <label htmlFor="feature-trial-days" className={labelClass}>Trial Duration</label>
                        <select id="feature-trial-days" value={featureTrialDays} onChange={e => setFeatureTrialDays(e.target.value)} className={inputClass}>
                          <option value="7">7 days</option>
                          <option value="14">14 days</option>
                          <option value="30">30 days</option>
                          <option value="60">60 days</option>
                        </select>
                      </div>
                      <div className="p-3 bg-indigo-50 rounded-xl border border-indigo-100">
                        <p className="text-sm text-indigo-700 font-bold">The tenant will have full access to this feature for the trial period. No charges will apply during the trial.</p>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setFeatureTrialModal(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button onClick={() => handleEnableTrial(featureTrialModal)} className="flex-1 py-4 bg-indigo-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-indigo-500/20 uppercase tracking-widest transition-all hover:bg-indigo-600">Start Trial</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {featurePaidModal && (
                <div role="dialog" aria-modal="true" aria-label="Enable Paid Override" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => { setFeaturePaidModal(null); setPaidOverridePrice(''); setPaidOverrideModel('monthly'); setPaidOverrideNotes(''); setPaidOverrideActivation('after_payment'); setPaidOverrideDueDate(''); }} onKeyDown={e => { if (e.key === 'Escape') { setFeaturePaidModal(null); setPaidOverridePrice(''); setPaidOverrideModel('monthly'); setPaidOverrideNotes(''); setPaidOverrideActivation('after_payment'); setPaidOverrideDueDate(''); } }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Enable Paid Override</h3>
                      <p className="text-sm text-slate-500 mt-1">Set pricing for {featureMatrix.find(f => f.id === featurePaidModal)?.name} for {tenant.name}.</p>
                    </div>
                    <div className="p-8 space-y-5">
                      <div>
                        <label htmlFor="paid-override-model" className={labelClass}>Pricing Model</label>
                        <select id="paid-override-model" value={paidOverrideModel} onChange={e => setPaidOverrideModel(e.target.value as 'monthly' | 'one_time' | 'annual')} className={inputClass}>
                          <option value="monthly">Monthly Recurring</option>
                          <option value="annual">Annual (Billed Yearly)</option>
                          <option value="one_time">One-Time Charge</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="paid-override-price" className={labelClass}>Price ($) *</label>
                        <div className="flex items-center gap-0">
                          <span className="px-3 py-3 bg-slate-100 border border-slate-200 border-r-0 rounded-l-xl text-sm font-bold text-slate-500">$</span>
                          <input id="paid-override-price" type="number" min="0" step="0.01" value={paidOverridePrice} onChange={e => setPaidOverridePrice(e.target.value)} className={`${inputClass} rounded-l-none`} placeholder="0.00" />
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">
                          {paidOverrideModel === 'monthly' ? 'Charged monthly on the billing cycle' : paidOverrideModel === 'annual' ? 'Charged once per year on renewal date' : 'One-time charge added to the next invoice'}
                        </p>
                      </div>
                      <div>
                        <label className={labelClass}>Activation Mode</label>
                        <div className="grid grid-cols-2 gap-2">
                          <button type="button" onClick={() => setPaidOverrideActivation('after_payment')} className={`py-3 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-colors ${paidOverrideActivation === 'after_payment' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>Activate after payment</button>
                          <button type="button" onClick={() => setPaidOverrideActivation('immediate')} className={`py-3 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-colors ${paidOverrideActivation === 'immediate' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>Activate immediately</button>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">
                          {paidOverrideActivation === 'after_payment'
                            ? 'Feature stays disabled. Invoice opens; access turns on once you mark it paid.'
                            : 'Feature turns on right now. Invoice stays open until you manually mark it paid.'}
                        </p>
                      </div>
                      <div>
                        <label htmlFor="paid-override-due" className={labelClass}>Invoice Due Date</label>
                        <input id="paid-override-due" type="date" value={paidOverrideDueDate} onChange={e => setPaidOverrideDueDate(e.target.value)} className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="paid-override-notes" className={labelClass}>Internal Notes</label>
                        <input id="paid-override-notes" value={paidOverrideNotes} onChange={e => setPaidOverrideNotes(e.target.value)} className={inputClass} placeholder="e.g. Custom agreement, special pricing reason..." />
                      </div>
                      <div className={`p-3 rounded-xl border ${paidOverrideActivation === 'immediate' ? 'bg-amber-50 border-amber-100' : 'bg-emerald-50 border-emerald-100'}`}>
                        <p className={`text-sm font-bold ${paidOverrideActivation === 'immediate' ? 'text-amber-700' : 'text-emerald-700'}`}>
                          {paidOverrideActivation === 'immediate'
                            ? 'An open SaaS invoice will be created. Feature access starts immediately. Cancelling the invoice will revoke access; marking it paid clears the open badge.'
                            : 'An open SaaS invoice will be created. Feature access starts only after you confirm payment manually. Cancelling the invoice reverts the row to Not in Plan with no Revoked badge.'}
                        </p>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => { setFeaturePaidModal(null); setPaidOverridePrice(''); setPaidOverrideModel('monthly'); setPaidOverrideNotes(''); setPaidOverrideActivation('after_payment'); setPaidOverrideDueDate(''); }} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button disabled={!paidOverridePrice || parseFloat(paidOverridePrice) <= 0} onClick={() => handleEnablePaidOverride(featurePaidModal)} className={`flex-1 py-4 text-white font-black text-sm rounded-2xl shadow-lg uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${paidOverrideActivation === 'immediate' ? 'bg-amber-500 shadow-amber-500/20 hover:bg-amber-600' : 'bg-emerald-500 shadow-emerald-500/20 hover:bg-emerald-600'}`}>{paidOverrideActivation === 'immediate' ? 'Activate' : 'Create Invoice'} @ ${paidOverridePrice || '0'}/{paidOverrideModel === 'monthly' ? 'mo' : paidOverrideModel === 'annual' ? 'yr' : 'once'}</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {revokeModal && revokeFeature && (
                <div role="dialog" aria-modal="true" aria-label="Revoke Feature Override" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setRevokeModal(null)} onKeyDown={e => { if (e.key === 'Escape') setRevokeModal(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-red-600 tracking-tight">Revoke Paid Override</h3>
                      <p className="text-sm text-slate-500 mt-1">Remove {revokeFeature.name} from {tenant.name}</p>
                    </div>
                    <div className="p-8 space-y-4">
                      {revokeOverride?.price && (
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                          <div className="flex justify-between items-center">
                            <div>
                              <p className={labelClass}>Charged Amount</p>
                              <p className="text-lg font-black text-slate-900">${revokeOverride.price}/{revokeOverride.pricingModel === 'monthly' ? 'mo' : revokeOverride.pricingModel === 'annual' ? 'yr' : 'once'}</p>
                            </div>
                            <div className="text-right">
                              <p className={labelClass}>Added</p>
                              <p className="text-sm font-bold text-slate-700">{revokeOverride.addedDate}</p>
                            </div>
                          </div>
                        </div>
                      )}
                      {(() => {
                        const refundInfo = getRefundEligibility(revokeOverride?.addedDate);
                        return (
                          <div className={`p-3 rounded-xl border ${refundInfo.eligible ? 'bg-lime-50 border-lime-100' : 'bg-amber-50 border-amber-100'}`}>
                            <p className={`text-sm font-bold flex items-center gap-1 ${refundInfo.eligible ? 'text-lime-700' : 'text-amber-700'}`}>
                              <span className="material-symbols-outlined text-xs">{refundInfo.eligible ? 'check_circle' : 'schedule'}</span>
                              {refundInfo.message}
                            </p>
                          </div>
                        );
                      })()}
                      <div className="p-3 bg-red-50 rounded-xl border border-red-100">
                        <p className="text-[10px] text-red-700 font-bold flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">warning</span>
                          The tenant will immediately lose access to this feature.
                        </p>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setRevokeModal(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      {getRefundEligibility(revokeOverride?.addedDate).eligible ? (
                        <>
                          <button onClick={() => handleConfirmRevoke(revokeModal, false)} className="py-4 px-5 bg-amber-500 text-white font-black text-[10px] rounded-2xl uppercase tracking-widest transition-all hover:bg-amber-600">Revoke Only</button>
                          <button onClick={() => handleConfirmRevoke(revokeModal, true)} className="py-4 px-5 bg-red-500 text-white font-black text-[10px] rounded-2xl shadow-lg shadow-red-500/20 uppercase tracking-widest transition-all hover:bg-red-600">Revoke + Refund</button>
                        </>
                      ) : (
                        <button onClick={() => handleConfirmRevoke(revokeModal, false)} className="flex-1 py-4 bg-red-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-red-500/20 uppercase tracking-widest transition-all hover:bg-red-600">Revoke Override</button>
                      )}
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Billing' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Billed</p>
                <p className="text-lg font-black text-primary">${accountBalance.totalBilled.toFixed(2)}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Paid</p>
                <p className="text-lg font-black text-lime-600">${accountBalance.totalPaid.toFixed(2)}</p>
              </div>
              <div className={`p-4 rounded-xl border text-center ${accountBalance.balance > 0 ? 'bg-red-50 border-red-100' : 'bg-lime-50 border-lime-100'}`}>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Balance Due</p>
                <p className={`text-lg font-black ${accountBalance.balance > 0 ? 'text-red-600' : 'text-lime-600'}`}>${accountBalance.balance.toFixed(2)}</p>
              </div>
              <div className="p-4 bg-violet-50 rounded-xl border border-violet-100 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Unapplied Credits</p>
                <p className="text-lg font-black text-violet-600">${accountBalance.unappliedCredits.toFixed(2)}</p>
              </div>
            </div>

            {tenantTx.some(tx => tx.status === 'failed') && (
              <div className="p-4 bg-red-50 rounded-xl border border-red-100">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-[10px] font-black text-red-700 uppercase tracking-widest mb-1 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">credit_card_off</span> Failed Payments
                    </p>
                    <p className="text-sm font-bold text-red-700">{tenantTx.filter(tx => tx.status === 'failed').length} failed payment(s) require attention</p>
                  </div>
                  <button onClick={() => { showToast('Payment retry initiated'); }} className="px-4 py-2 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Retry Payment</button>
                </div>
              </div>
            )}

            {/* Spec K: SaaS Subscription Invoices — internal records for paid
                overrides and paid add-on grants. NO Stripe / external processor.
                System Owner manually confirms payment. */}
            <div>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">SaaS Subscription Invoices</p>
                <span className="text-[9px] font-black text-violet-600 bg-violet-50 border border-violet-100 px-2 py-1 rounded-lg uppercase tracking-widest">Internal · Manual confirmation</span>
              </div>
              {tenantInvoices.length === 0 ? (
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
                  <p className="text-sm text-slate-400 font-bold">No SaaS subscription invoices yet.</p>
                  <p className="text-[10px] text-slate-400 mt-1">Granting a Paid Override or Paid Add-on creates an internal invoice.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {tenantInvoices.map(inv => {
                    const ui = deriveInvoiceUiStatus(inv, NOW_MS);
                    const fname = inv.featureId ? (liveFeatureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : '—';
                    const linkedOverride = localOverrides.find(o => o.invoiceId === inv.invoiceId);
                    const isImmediate = inv.activationMode === 'immediate';
                    const statusClass = ui === 'paid'
                      ? 'bg-lime-50 text-lime-700 border-lime-100'
                      : ui === 'cancelled'
                        ? 'bg-slate-100 text-slate-500 border-slate-200'
                        : ui === 'overdue'
                          ? 'bg-red-50 text-red-700 border-red-100'
                          : 'bg-amber-50 text-amber-700 border-amber-100';
                    const cadenceLabel = inv.cadence === 'monthly' ? '/mo' : inv.cadence === 'annual' ? '/yr' : ' one-time';
                    // Part A: monthly + annual subscriptions are
                    // recurring; one-time grants are not. Surface
                    // truthful copy so the operator (and tenant
                    // mirror in Settings) can tell at a glance
                    // whether settling this invoice ends the bill or
                    // just covers the current cycle.
                    const recurrenceCopy = inv.cadence === 'monthly'
                      ? 'Recurring monthly — a new invoice is issued each cycle until the override is revoked.'
                      : inv.cadence === 'annual'
                        ? 'Recurring annually — a new invoice is issued each year until the override is revoked.'
                        : 'One-time charge — settles in full when paid; no future invoices.';
                    return (
                      <div key={inv.invoiceId} className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div className="flex justify-between items-start gap-3 flex-wrap">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="material-symbols-outlined text-sm text-slate-400 mt-0.5">receipt_long</span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-bold text-slate-900 text-sm">{inv.invoiceId}</p>
                                <span className={`text-[9px] font-black px-2 py-0.5 rounded border uppercase tracking-widest ${statusClass}`}>{ui}</span>
                                <span className={`text-[9px] font-black px-2 py-0.5 rounded border uppercase tracking-widest ${isImmediate ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>{isImmediate ? 'Immediate' : 'After payment'}</span>
                              </div>
                              <p className="text-[10px] text-slate-500 mt-1">{inv.lineItems[0]?.description || '—'}</p>
                              <p className="text-[10px] text-slate-400">Feature: <span className="font-bold text-slate-600">{fname}</span> · Issued {inv.issuedDate} · Due {inv.dueDate}{inv.paidDate ? ` · Paid ${inv.paidDate}` : ''}{inv.cancelledDate ? ` · Cancelled ${inv.cancelledDate}` : ''}</p>
                              {/* Part A: per-row recurrence callout. Avoids
                                  the user having to infer "is this monthly
                                  bill going to keep coming?" from a tiny
                                  /mo suffix. */}
                              <p className={`text-[10px] mt-1 italic ${inv.cadence === 'one_time' ? 'text-slate-400' : 'text-violet-600 font-semibold'}`}>{recurrenceCopy}</p>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1.5">
                            <span className="font-black text-primary text-sm">${inv.amount.toFixed(2)}<span className="text-[10px] font-bold text-slate-400">{cadenceLabel}</span></span>
                            <div className="flex items-center gap-1 flex-wrap justify-end">
                              {(ui === 'open' || ui === 'overdue') && (
                                <>
                                  <button onClick={() => handleMarkInvoicePaid(inv.invoiceId)} className="text-[8px] font-black text-lime-600 bg-lime-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-lime-100 transition-colors">Mark Paid</button>
                                  <button onClick={() => handleCancelInvoiceClick(inv.invoiceId)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Cancel Invoice</button>
                                </>
                              )}
                              <button onClick={() => setCommercialInvoiceDetailId(inv.invoiceId)} className="text-[8px] font-black text-slate-600 bg-slate-100 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-slate-200 transition-colors">View</button>
                            </div>
                            {linkedOverride && !linkedOverride.revokedDate && (
                              <p className="text-[9px] text-slate-400 italic">Linked to {fname} override</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Part B: Tenant Billing View Preview — embeds the exact
                read-only invoice list the tenant sees inside their
                own Settings → Plan & Add-on Billing panel. Lets the
                System Owner verify, without role-switching, that the
                tenant view is truthful, matches mark-paid/cancel
                state, and never exposes payment buttons. */}
            <div>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant Billing View Preview</p>
                <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-1 rounded-lg uppercase tracking-widest">What the tenant sees</span>
              </div>
              <div className="p-4 bg-indigo-50/30 rounded-xl border border-indigo-100/60">
                <p className="text-[10px] text-slate-500 font-medium mb-3 leading-relaxed">
                  These are internal SaaS subscription invoices for paid feature overrides and add-ons applied by your account manager. Payment is confirmed manually by the System Owner — there is no in-app payment button. Contact support to settle an open invoice.
                </p>
                {tenantInvoices.length === 0 ? (
                  <p className="text-sm font-bold text-slate-500 text-center py-3">No subscription invoices on file.</p>
                ) : (
                  <div className="space-y-2">
                    {tenantInvoices.map(inv => {
                      // Use the same default time reference (Date.now())
                      // as the tenant Settings panel calls
                      // `deriveInvoiceUiStatus(inv)` with no nowMs — this
                      // guarantees the preview's open/overdue badge
                      // matches exactly what the tenant sees in their own
                      // Settings → Plan & Add-on Billing view.
                      const ui = deriveInvoiceUiStatus(inv);
                      const fname = inv.featureId ? (liveFeatureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : '—';
                      const cadenceLabel = inv.cadence === 'monthly' ? '/mo' : inv.cadence === 'annual' ? '/yr' : ' one-time';
                      const recur = inv.cadence === 'monthly'
                        ? 'Recurring monthly'
                        : inv.cadence === 'annual'
                          ? 'Recurring annually'
                          : 'One-time';
                      const tStatus = ui === 'paid'
                        ? 'bg-lime-50 text-lime-700 border-lime-100'
                        : ui === 'cancelled'
                          ? 'bg-slate-100 text-slate-500 border-slate-200'
                          : ui === 'overdue'
                            ? 'bg-red-50 text-red-700 border-red-100'
                            : 'bg-amber-50 text-amber-700 border-amber-100';
                      return (
                        <div key={'preview-' + inv.invoiceId} className="p-3 bg-white rounded-lg border border-indigo-100/60">
                          <div className="flex justify-between items-start gap-3 flex-wrap">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-bold text-slate-900 text-sm">{inv.invoiceId}</p>
                                <span className={`text-[9px] font-black px-2 py-0.5 rounded border uppercase tracking-widest ${tStatus}`}>{ui}</span>
                                <span className="text-[9px] font-black bg-violet-50 text-violet-700 border border-violet-100 px-2 py-0.5 rounded uppercase tracking-widest">{recur}</span>
                              </div>
                              <p className="text-[10px] text-slate-500 mt-1">{inv.lineItems[0]?.description || '—'} · {fname}</p>
                              <p className="text-[10px] text-slate-400">Issued {inv.issuedDate} · Due {inv.dueDate}{inv.paidDate ? ` · Paid ${inv.paidDate}` : ''}</p>
                            </div>
                            <span className="font-black text-primary text-sm whitespace-nowrap">${inv.amount.toFixed(2)}<span className="text-[10px] font-bold text-slate-400">{cadenceLabel}</span></span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 italic mt-3">No payment buttons appear in the tenant view — settlement is confirmed manually by the System Owner above.</p>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Plan Invoices</p>
              <div className="space-y-2">
                {effectiveInvoices.map(inv => (
                  <button type="button" key={inv.id} onClick={() => setInvoiceDetailId(inv.id)} className="w-full flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100 hover:bg-slate-100 transition-colors text-left cursor-pointer">
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-sm text-slate-400">receipt</span>
                      <div>
                        <p className="font-bold text-slate-900 text-sm">{inv.invoiceNo}</p>
                        <p className="text-[10px] text-slate-400">{inv.date} · {inv.plan}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-primary">${inv.total.toFixed(2)}</span>
                      {statusBadge(inv.status)}
                      <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {effectiveCredits.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Credits & Refunds</p>
                <div className="space-y-2">
                  {effectiveCredits.map(cr => (
                    <button type="button" key={cr.id} className="w-full flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100 hover:bg-slate-100 transition-colors text-left cursor-pointer">
                      <div className="flex items-center gap-3 flex-1" onClick={() => setCreditDetailId(cr.id)}>
                        <span className={`material-symbols-outlined text-sm ${cr.type === 'refund' ? 'text-amber-500' : cr.type === 'cancellation' ? 'text-red-400' : 'text-violet-400'}`}>{cr.type === 'refund' ? 'currency_exchange' : cr.type === 'cancellation' ? 'cancel' : 'redeem'}</span>
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{cr.creditNo}</p>
                          <p className="text-[10px] text-slate-400">{cr.date} · {cr.reason.slice(0, 50)}{cr.reason.length > 50 ? '...' : ''}</p>
                          <p className="text-[10px] text-slate-400 capitalize">{cr.type} · {cr.appliedToInvoice ? `Applied to ${cr.appliedToInvoice}` : 'Unapplied'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-violet-600">${cr.amount.toFixed(2)}</span>
                        {statusBadge(cr.status)}
                        {cr.status === 'issued' && (
                          <div className="flex gap-1 ml-1" onClick={e => e.stopPropagation()}>
                            <button onClick={() => {
                              const target = eligibleInvoicesForCredit[0];
                              if (target) {
                                setLocalCreditStatuses(prev => ({ ...prev, [cr.id]: 'applied' }));
                                setLocalInvoiceStatuses(prev => ({ ...prev, [target.id]: 'paid' }));
                                setLocalCreditLinks(prev => ({ ...prev, [cr.id]: { appliedToInvoice: target.invoiceNo, appliedAmount: cr.amount, appliedDate: '2026-03-26' } }));
                                showToast(`Credit ${cr.creditNo} applied to ${target.invoiceNo}`);
                              } else {
                                showToast('No invoices with overdue or pending status to apply this credit to');
                              }
                            }} className="text-[8px] font-black text-lime-600 bg-lime-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-lime-100 transition-colors">Apply</button>
                            <button onClick={() => setVoidConfirmId(cr.id)} className="text-[8px] font-black text-red-500 bg-red-50 px-2 py-1 rounded-lg uppercase tracking-widest hover:bg-red-100 transition-colors">Void</button>
                          </div>
                        )}
                        <span className="material-symbols-outlined text-slate-400 text-sm" onClick={() => setCreditDetailId(cr.id)}>chevron_right</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button onClick={() => navigate('/owner/billing')} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">open_in_new</span> Open Platform Billing
            </button>

            {/* SaaS Subscription Invoice — cancel confirmation. The body
                explains the consequence based on the linked override. */}
            <AnimatePresence>
              {cancelInvoiceConfirmId && (() => {
                const inv = getInvoiceById(cancelInvoiceConfirmId);
                if (!inv) return null;
                const linked = localOverrides.find(o => o.invoiceId === cancelInvoiceConfirmId);
                const willRevoke = linked && linked.type === 'paid_override' && linked.activationMode === 'immediate' && !linked.revokedDate;
                const willRevert = linked && linked.type === 'pending_payment';
                const fname = inv.featureId ? (liveFeatureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : '—';
                return (
                  <div role="dialog" aria-modal="true" aria-label="Cancel SaaS Invoice" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setCancelInvoiceConfirmId(null)} onKeyDown={e => { if (e.key === 'Escape') setCancelInvoiceConfirmId(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                      <div className="p-8 border-b border-slate-100">
                        <h3 className="text-xl font-black text-red-600 tracking-tight">Cancel SaaS Invoice</h3>
                        <p className="text-sm text-slate-500 mt-1">{inv.invoiceId} · ${inv.amount.toFixed(2)} · {fname}</p>
                      </div>
                      <div className="p-8 space-y-4">
                        <div className={`p-4 rounded-xl border ${willRevoke ? 'bg-red-50 border-red-100' : willRevert ? 'bg-amber-50 border-amber-100' : 'bg-slate-50 border-slate-100'}`}>
                          <p className={`text-sm font-bold ${willRevoke ? 'text-red-700' : willRevert ? 'text-amber-700' : 'text-slate-700'}`}>
                            {willRevoke && `Cancelling this invoice will REVOKE feature access for ${fname}. The override row will show as Revoked.`}
                            {willRevert && `Cancelling this invoice will revert ${fname} to Not in Plan. No Revoked badge will appear because the feature was never active.`}
                            {!willRevoke && !willRevert && 'Cancelling this invoice will mark it as Cancelled. No tenant access change.'}
                          </p>
                        </div>
                        <p className="text-[10px] text-slate-400">This action is recorded in the commercial audit log and cannot be undone. The invoice row remains visible for history.</p>
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                        <button onClick={() => setCancelInvoiceConfirmId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Keep Invoice</button>
                        <button onClick={() => handleConfirmCancelInvoice(cancelInvoiceConfirmId)} className="flex-1 py-4 bg-red-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-red-500/20 uppercase tracking-widest transition-all hover:bg-red-600">{willRevoke ? 'Cancel & Revoke' : 'Cancel Invoice'}</button>
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            {/* SaaS Subscription Invoice — read-only detail view. */}
            <AnimatePresence>
              {commercialInvoiceDetailId && (() => {
                const inv = getInvoiceById(commercialInvoiceDetailId);
                if (!inv) return null;
                const ui = deriveInvoiceUiStatus(inv, NOW_MS);
                const fname = inv.featureId ? (liveFeatureMatrix.find(f => f.id === inv.featureId)?.name || inv.featureId) : '—';
                const statusClass = ui === 'paid'
                  ? 'bg-lime-50 text-lime-700 border-lime-100'
                  : ui === 'cancelled'
                    ? 'bg-slate-100 text-slate-500 border-slate-200'
                    : ui === 'overdue'
                      ? 'bg-red-50 text-red-700 border-red-100'
                      : 'bg-amber-50 text-amber-700 border-amber-100';
                const cadenceLabel = inv.cadence === 'monthly' ? '/mo' : inv.cadence === 'annual' ? '/yr' : ' one-time';
                return (
                  <div role="dialog" aria-modal="true" aria-label="SaaS Invoice Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setCommercialInvoiceDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setCommercialInvoiceDetailId(null); }}>
                    <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden">
                      <div className="p-8 border-b border-slate-100 flex justify-between items-start">
                        <div>
                          <h3 className="text-xl font-black text-primary tracking-tight">{inv.invoiceId}</h3>
                          <p className="text-sm text-slate-500 mt-1">{tenant.name} · Internal SaaS subscription</p>
                        </div>
                        <span className={`text-[9px] font-black px-2 py-1 rounded border uppercase tracking-widest ${statusClass}`}>{ui}</span>
                      </div>
                      <div className="p-8 space-y-5">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className={labelClass}>Issued</p>
                            <p className="font-bold text-slate-900">{inv.issuedDate}</p>
                          </div>
                          <div>
                            <p className={labelClass}>Due</p>
                            <p className="font-bold text-slate-900">{inv.dueDate}</p>
                          </div>
                          <div>
                            <p className={labelClass}>Activation Mode</p>
                            <p className="font-bold text-slate-900 capitalize">{inv.activationMode === 'immediate' ? 'Immediate' : 'After payment'}</p>
                          </div>
                          <div>
                            <p className={labelClass}>Cadence</p>
                            <p className="font-bold text-slate-900 capitalize">{inv.cadence.replace('_', ' ')}</p>
                            <p className={`text-[10px] mt-0.5 italic ${inv.cadence === 'one_time' ? 'text-slate-400' : 'text-violet-600 font-semibold'}`}>
                              {inv.cadence === 'monthly'
                                ? 'Recurring monthly until override revoked'
                                : inv.cadence === 'annual'
                                  ? 'Recurring annually until override revoked'
                                  : 'One-time charge'}
                            </p>
                          </div>
                          <div>
                            <p className={labelClass}>Linked Feature</p>
                            <p className="font-bold text-slate-900">{fname}</p>
                          </div>
                          <div>
                            <p className={labelClass}>Created By</p>
                            <p className="font-bold text-slate-900">{inv.createdBy}</p>
                          </div>
                          {inv.paidDate && (
                            <div>
                              <p className={labelClass}>Paid</p>
                              <p className="font-bold text-lime-600">{inv.paidDate}</p>
                            </div>
                          )}
                          {inv.cancelledDate && (
                            <div>
                              <p className={labelClass}>Cancelled</p>
                              <p className="font-bold text-red-600">{inv.cancelledDate}</p>
                            </div>
                          )}
                        </div>
                        <div>
                          <p className={labelClass}>Line Items</p>
                          <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-slate-100">
                                  <th className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest text-left">Description</th>
                                  <th className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {inv.lineItems.map((li, idx) => (
                                  <tr key={idx} className="border-b border-slate-100 last:border-0">
                                    <td className="px-4 py-3 text-sm font-bold text-slate-700">{li.description}</td>
                                    <td className="px-4 py-3 text-sm font-black text-slate-900 text-right">${li.amount.toFixed(2)}{cadenceLabel}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        {inv.notes && (
                          <div>
                            <p className={labelClass}>Notes</p>
                            <p className="text-sm text-slate-700 font-medium">{inv.notes}</p>
                          </div>
                        )}
                        <div className="p-3 bg-violet-50 rounded-xl border border-violet-100">
                          <p className="text-[10px] text-violet-700 font-bold">
                            Internal SaaS subscription record. No external payment processor. Payment is confirmed manually by a System Owner.
                          </p>
                        </div>
                      </div>
                      <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 flex-wrap">
                        {(ui === 'open' || ui === 'overdue') && (
                          <>
                            <button onClick={() => { handleMarkInvoicePaid(inv.invoiceId); setCommercialInvoiceDetailId(null); }} className="px-4 py-2.5 bg-lime-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-lime-600 transition-all">Mark Paid</button>
                            <button onClick={() => { setCommercialInvoiceDetailId(null); handleCancelInvoiceClick(inv.invoiceId); }} className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Cancel Invoice</button>
                          </>
                        )}
                        <button onClick={() => setCommercialInvoiceDetailId(null)} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ml-auto">Close</button>
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
            </AnimatePresence>

            <AnimatePresence>
              {selectedInvoice && (
                <div role="dialog" aria-modal="true" aria-label="Invoice Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setInvoiceDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setInvoiceDetailId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden">
                    <div className="p-8 border-b border-slate-100 flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-black text-primary tracking-tight">{selectedInvoice.invoiceNo}</h3>
                        <p className="text-sm text-slate-500 mt-1">{selectedInvoice.tenant}</p>
                      </div>
                      {statusBadge(selectedInvoice.status)}
                    </div>
                    <div className="p-8 space-y-5">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Issue Date</p>
                          <p className="font-bold text-slate-900">{selectedInvoice.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Due Date</p>
                          <p className="font-bold text-slate-900">{selectedInvoice.dueDate}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Plan</p>
                          <p className="font-bold text-slate-900">{selectedInvoice.plan}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Paid Date</p>
                          <p className="font-bold text-slate-900">{selectedInvoice.paidDate || '—'}</p>
                        </div>
                      </div>

                      <div>
                        <p className={labelClass}>Line Items</p>
                        <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                          <table className="w-full">
                            <thead>
                              <tr className="border-b border-slate-100">
                                <th className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest text-left">Description</th>
                                <th className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Qty</th>
                                <th className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedInvoice.items.map((item, idx) => (
                                <tr key={idx} className="border-b border-slate-100 last:border-0">
                                  <td className="px-4 py-3 text-sm font-bold text-slate-700">{item.description}</td>
                                  <td className="px-4 py-3 text-sm text-slate-500 text-center">{item.qty}</td>
                                  <td className="px-4 py-3 text-sm font-black text-slate-900 text-right">${item.amount.toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div className="space-y-2 pt-3 border-t border-slate-100">
                        <div className="flex justify-between">
                          <span className="text-sm text-slate-500">Subtotal</span>
                          <span className="text-sm font-bold text-slate-900">${selectedInvoice.amount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-slate-500">Tax</span>
                          <span className="text-sm font-bold text-slate-900">${selectedInvoice.tax.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between pt-2 border-t border-slate-100">
                          <span className="text-sm font-black text-slate-900">Total</span>
                          <span className="text-lg font-black text-primary">${selectedInvoice.total.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 flex-wrap">
                      {selectedInvoice.status === 'overdue' && (
                        <button onClick={() => { setInvoiceDetailId(null); showToast('Payment reminder sent'); }} className="px-4 py-2.5 bg-red-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-600 transition-all">Send Reminder</button>
                      )}
                      <button onClick={() => { setInvoiceDetailId(null); showToast('Invoice PDF downloaded'); }} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">download</span> Download PDF
                      </button>
                      <button onClick={() => setInvoiceDetailId(null)} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ml-auto">Close</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {selectedCredit && (
                <div role="dialog" aria-modal="true" aria-label="Credit Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setCreditDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setCreditDetailId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden">
                    <div className="p-8 border-b border-slate-100 flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-black text-primary tracking-tight">{selectedCredit.creditNo}</h3>
                        <p className="text-sm text-slate-500 mt-1">{selectedCredit.tenant}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg border bg-violet-400/10 text-violet-700 border-violet-200">{selectedCredit.type}</span>
                        {statusBadge(selectedCredit.status)}
                      </div>
                    </div>
                    <div className="p-8 space-y-5">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Issue Date</p>
                          <p className="font-bold text-slate-900">{selectedCredit.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Amount</p>
                          <p className="font-black text-violet-600 text-lg">${selectedCredit.amount.toFixed(2)}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Applied Amount</p>
                          <p className="font-bold text-slate-900">${selectedCredit.appliedAmount.toFixed(2)}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Remaining</p>
                          <p className={`font-bold ${(selectedCredit.amount - selectedCredit.appliedAmount) > 0 ? 'text-amber-600' : 'text-slate-400'}`}>${(selectedCredit.amount - selectedCredit.appliedAmount).toFixed(2)}</p>
                        </div>
                      </div>
                      <div>
                        <p className={labelClass}>Reason</p>
                        <p className="text-sm text-slate-700 font-medium">{selectedCredit.reason}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Related Invoice</p>
                          <p className="font-bold text-slate-900">{selectedCredit.relatedInvoice || '—'}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Applied To</p>
                          <p className="font-bold text-slate-900">{selectedCredit.appliedToInvoice || '—'}</p>
                        </div>
                      </div>
                      {selectedCredit.appliedDate && (
                        <div>
                          <p className={labelClass}>Applied Date</p>
                          <p className="font-bold text-slate-900">{selectedCredit.appliedDate}</p>
                        </div>
                      )}
                      {selectedCredit.status === 'issued' && (
                        <div className="p-3 bg-amber-50 rounded-xl border border-amber-100">
                          <p className="text-sm text-amber-700 font-bold flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">info</span>
                            {eligibleInvoicesForCredit.length > 0
                              ? `This credit can be applied to ${eligibleInvoicesForCredit.length} eligible invoice(s) with overdue or pending status.`
                              : 'No invoices with overdue or pending status are available to apply this credit to.'}
                          </p>
                        </div>
                      )}
                      {selectedCredit.type === 'refund' && (
                        <div className="p-3 bg-amber-50/50 rounded-xl border border-amber-100">
                          <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1">Refund Details</p>
                          <div className="grid grid-cols-2 gap-3 mt-2">
                            <div>
                              <p className={labelClass}>Refund Reference</p>
                              <p className="font-bold text-slate-900 text-sm">{selectedCredit.creditNo}</p>
                            </div>
                            <div>
                              <p className={labelClass}>Source Invoice</p>
                              <p className="font-bold text-slate-900 text-sm">{selectedCredit.relatedInvoice || '—'}</p>
                            </div>
                            <div>
                              <p className={labelClass}>Refund Amount</p>
                              <p className="font-black text-amber-600 text-sm">${selectedCredit.amount.toFixed(2)}</p>
                            </div>
                            <div>
                              <p className={labelClass}>Refund Date</p>
                              <p className="font-bold text-slate-900 text-sm">{selectedCredit.date}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3 flex-wrap">
                      {selectedCredit.status === 'issued' && (
                        <button onClick={() => {
                          const target = eligibleInvoicesForCredit[0];
                          if (target) {
                            setLocalCreditStatuses(prev => ({ ...prev, [selectedCredit.id]: 'applied' }));
                            setLocalInvoiceStatuses(prev => ({ ...prev, [target.id]: 'paid' }));
                            setLocalCreditLinks(prev => ({ ...prev, [selectedCredit.id]: { appliedToInvoice: target.invoiceNo, appliedAmount: selectedCredit.amount, appliedDate: '2026-03-26' } }));
                            setCreditDetailId(null);
                            showToast(`Credit ${selectedCredit.creditNo} applied to ${target.invoiceNo}`);
                          } else {
                            showToast('No invoices with overdue or pending status to apply this credit to');
                          }
                        }} className="px-4 py-2.5 bg-lime-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-lime-600 transition-all flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">check</span> Apply Credit
                        </button>
                      )}
                      {selectedCredit.status === 'issued' && (
                        <button onClick={() => { setCreditDetailId(null); setVoidConfirmId(selectedCredit.id); }} className="px-4 py-2.5 bg-red-100 text-red-600 font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-red-200 transition-all">Void</button>
                      )}
                      <button onClick={() => { setCreditDetailId(null); showToast('Credit note PDF downloaded'); }} className="px-4 py-2.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">download</span> Download PDF
                      </button>
                      <button onClick={() => setCreditDetailId(null)} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all ml-auto">Close</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {voidConfirmId && voidCredit && (
                <div role="dialog" aria-modal="true" aria-label="Void Credit Confirmation" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setVoidConfirmId(null)} onKeyDown={e => { if (e.key === 'Escape') setVoidConfirmId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-red-600 tracking-tight">Void Credit Note</h3>
                      <p className="text-sm text-slate-500 mt-1">This will permanently void {voidCredit.creditNo}</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
                        <div>
                          <p className={labelClass}>Credit Amount</p>
                          <p className="text-lg font-black text-violet-600">${voidCredit.amount.toFixed(2)}</p>
                        </div>
                        <div className="text-right">
                          <p className={labelClass}>Type</p>
                          <p className="text-sm font-bold text-slate-700 capitalize">{voidCredit.type}</p>
                        </div>
                      </div>
                      <div className="p-3 bg-red-50 rounded-xl border border-red-100">
                        <p className="text-sm text-red-700 font-bold flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">warning</span>
                          Voided credits cannot be reinstated. The tenant will no longer have this credit available.
                        </p>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setVoidConfirmId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Cancel</button>
                      <button onClick={() => { setLocalCreditStatuses(prev => ({ ...prev, [voidConfirmId]: 'voided' })); setVoidConfirmId(null); showToast(`${voidCredit.creditNo} has been voided`); }} className="flex-1 py-4 bg-red-500 text-white font-black text-sm rounded-2xl shadow-lg shadow-red-500/20 uppercase tracking-widest transition-all hover:bg-red-600">Void Credit</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Domains' && (
          <div className="space-y-6">
            <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
              <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest mb-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">info</span> Primary Domain
              </p>
              <p className="text-sm font-bold text-blue-700">
                {effectiveDomain && domainVerification === 'verified'
                  ? `${effectiveDomain} is the primary domain. All traffic resolves here.`
                  : `${tenant.subdomain}.repairplatform.com is the primary domain (default subdomain).`}
              </p>
              <p className="text-[10px] text-blue-500 mt-1">
                {effectiveDomain && domainVerification === 'verified'
                  ? `Subdomain ${tenant.subdomain}.repairplatform.com redirects to the custom domain.`
                  : 'Add and verify a custom domain to make it the primary.'}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subdomain</p>
                  {statusBadge('active')}
                </div>
                <p className="font-black text-primary text-lg">{tenant.subdomain}.repairplatform.com</p>
                <p className="text-[10px] text-slate-400 mt-1">Platform-managed · Always active</p>
                <button onClick={() => copyToClipboard(`${tenant.subdomain}.repairplatform.com`, 'subdomain')} className="mt-2 px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">{copiedDns === 'subdomain' ? 'check' : 'content_copy'}</span>
                  {copiedDns === 'subdomain' ? 'Copied' : 'Copy URL'}
                </button>
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Custom Domain</p>
                {effectiveDomain ? (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-black text-primary text-lg">{effectiveDomain}</p>
                      {statusBadge(domainVerification)}
                    </div>
                    <p className="text-[10px] text-slate-400">Tenant-owned domain{domainVerification === 'verified' ? ' · Primary' : ''}</p>
                    <div className="flex gap-2 mt-2">
                      {domainVerification !== 'verified' && (
                        <button onClick={handleVerifyDomain} className="px-3 py-1.5 bg-lime-500 hover:bg-lime-600 text-white font-black text-[10px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">verified</span> Verify Now
                        </button>
                      )}
                      <button onClick={handleRemoveDomain} className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all">Remove</button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-400 font-bold">No custom domain configured</p>
                    <div className="flex gap-2">
                      <input value={domainInput} onChange={e => setDomainInput(e.target.value)} className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="example.com" />
                      <button onClick={handleAddDomain} disabled={!domainInput.includes('.')} className="px-3 py-2 bg-primary text-white font-black text-[10px] rounded-lg uppercase tracking-widest disabled:opacity-40 hover:bg-primary/90 transition-all">Add Domain</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {effectiveDomain && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Domain Setup Progress</p>
                {domainVerification === 'failed' && (
                  <div className="p-3 bg-red-50 rounded-xl border border-red-100 mb-3">
                    <p className="text-sm text-red-700 font-bold flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">error</span>
                      DNS verification failed. Please check your DNS records and try again.
                    </p>
                  </div>
                )}
                <div className="flex items-center gap-0">
                  {[
                    { label: 'Added', done: true, failed: false, icon: 'add_circle' },
                    { label: 'DNS Config', done: domainPropagation === 'propagated' || domainVerification === 'verified', failed: false, icon: 'dns' },
                    { label: 'Propagated', done: domainPropagation === 'propagated' || domainVerification === 'verified', failed: domainPropagation === 'not_propagated', icon: domainPropagation === 'checking' ? 'hourglass_top' : 'wifi' },
                    { label: 'Verified', done: domainVerification === 'verified', failed: domainVerification === 'failed', icon: 'verified' },
                    { label: 'SSL Active', done: domainSsl === 'active', failed: false, icon: 'lock' },
                    { label: 'Live', done: domainVerification === 'verified' && domainSsl === 'active', failed: false, icon: 'public' },
                  ].map((step, i, arr) => (
                    <React.Fragment key={i}>
                      <div className="flex flex-col items-center gap-1 flex-1">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center ${step.failed ? 'bg-red-100 border-2 border-red-400' : step.done ? 'bg-lime-100 border-2 border-lime-400' : 'bg-slate-100 border-2 border-slate-200'}`}>
                          <span className={`material-symbols-outlined text-sm ${step.failed ? 'text-red-600' : step.done ? 'text-lime-600' : 'text-slate-400'}`}>{step.failed ? 'close' : step.done ? 'check' : step.icon}</span>
                        </div>
                        <span className={`text-[8px] font-black uppercase tracking-widest ${step.failed ? 'text-red-600' : step.done ? 'text-lime-700' : 'text-slate-400'}`}>{step.label}</span>
                      </div>
                      {i < arr.length - 1 && <div className={`h-0.5 w-6 mt-[-12px] ${step.failed ? 'bg-red-300' : step.done ? 'bg-lime-400' : 'bg-slate-200'}`} />}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DNS Propagation</p>
                  {statusBadge(domainPropagation === 'propagated' || domainVerification === 'verified' ? 'active' : domainPropagation === 'checking' ? 'pending' : domainPropagation === 'not_propagated' ? 'failed' : 'pending')}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${domainPropagation === 'propagated' || domainVerification === 'verified' ? 'text-lime-600' : domainPropagation === 'checking' ? 'text-amber-500 animate-spin' : 'text-slate-400'}`}>
                    {domainPropagation === 'propagated' || domainVerification === 'verified' ? 'check_circle' : domainPropagation === 'checking' ? 'progress_activity' : 'wifi'}
                  </span>
                  <p className="text-sm font-bold text-slate-600">
                    {domainPropagation === 'propagated' || domainVerification === 'verified' ? 'DNS propagated' : domainPropagation === 'checking' ? 'Checking propagation...' : 'Awaiting propagation'}
                  </p>
                </div>
                {domainPropagation !== 'propagated' && domainVerification !== 'verified' && effectiveDomain && domainPropagation !== 'checking' && (
                  <button onClick={handleCheckPropagation} className="mt-2 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white font-black text-[10px] rounded-lg uppercase tracking-widest transition-all">Check Propagation</button>
                )}
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DNS Verification</p>
                  {statusBadge(domainVerification === 'verified' ? 'verified' : domainVerification === 'failed' ? 'failed' : 'pending')}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${domainVerification === 'verified' ? 'text-lime-600' : domainVerification === 'failed' ? 'text-red-500' : 'text-amber-500'}`}>
                    {domainVerification === 'verified' ? 'check_circle' : domainVerification === 'failed' ? 'cancel' : 'pending'}
                  </span>
                  <p className="text-sm font-bold text-slate-600">
                    {domainVerification === 'verified' ? 'DNS records verified' : domainVerification === 'failed' ? 'Verification failed' : 'Awaiting verification'}
                  </p>
                </div>
                {effectiveDomain && domainVerification !== 'verified' && (
                  <div className="flex gap-2 mt-2">
                    <button onClick={handleVerifyDomain} disabled={domainPropagation !== 'propagated'} className={`px-3 py-1.5 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all ${domainPropagation === 'propagated' ? 'bg-lime-500 hover:bg-lime-600 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>{domainPropagation !== 'propagated' ? 'Verify DNS (propagation required)' : 'Verify DNS'}</button>
                    {domainVerification !== 'failed' && (
                      <button onClick={handleFailDomain} className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all">Simulate Fail</button>
                    )}
                  </div>
                )}
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL Certificate</p>
                  {statusBadge(domainSsl === 'active' ? 'active' : 'pending')}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`material-symbols-outlined text-sm ${domainSsl === 'active' ? 'text-lime-600' : 'text-amber-500'}`}>
                    {domainSsl === 'active' ? 'verified_user' : 'hourglass_top'}
                  </span>
                  <p className="text-sm font-bold text-slate-600">
                    {domainSsl === 'active' ? 'SSL is active and valid' : domainVerification !== 'verified' ? 'Requires DNS verification first' : 'Ready for provisioning'}
                  </p>
                </div>
                {domainSsl !== 'active' && effectiveDomain && (
                  <button onClick={handleProvisionSsl} disabled={domainVerification !== 'verified'} className="mt-2 px-3 py-1.5 bg-lime-500 hover:bg-lime-600 text-white font-black text-[10px] rounded-lg uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed">Provision SSL</button>
                )}
              </div>
            </div>

            {effectiveDomain && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Setup Checklist</p>
                <p className="text-[10px] text-slate-400 mb-3">Complete each step in order. DNS changes may take up to 48 hours to propagate.</p>
                <div className="space-y-2">
                  {[
                    { label: 'CNAME record points to platform', done: domainPropagation === 'propagated' || domainVerification === 'verified' },
                    { label: 'TXT verification record added', done: domainPropagation === 'propagated' || domainVerification === 'verified' },
                    { label: 'DNS propagation confirmed', done: domainPropagation === 'propagated' || domainVerification === 'verified' },
                    { label: 'DNS ownership verified', done: domainVerification === 'verified', failed: domainVerification === 'failed' },
                    { label: 'SSL certificate provisioned', done: domainSsl === 'active' },
                    { label: 'Domain live and resolving', done: domainVerification === 'verified' && domainSsl === 'active' },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <span className={`material-symbols-outlined text-sm ${'failed' in item && item.failed ? 'text-red-500' : item.done ? 'text-lime-600' : 'text-slate-300'}`}>{'failed' in item && item.failed ? 'cancel' : item.done ? 'check_circle' : 'radio_button_unchecked'}</span>
                      <span className={`text-sm font-bold ${'failed' in item && item.failed ? 'text-red-600' : item.done ? 'text-slate-900' : 'text-slate-400'}`}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dnsRecords.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">DNS Records Configuration</p>
                <p className="text-[10px] text-slate-400 mb-3">Configure these DNS records at your domain registrar. Click any row to copy.</p>
                <div className="bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">Type</th>
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">Name</th>
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">Value</th>
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-left">TTL</th>
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                        <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-right"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {dnsRecords.map((rec, i) => (
                        <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-100/50 transition-colors">
                          <td className="px-4 py-3"><span className="text-[9px] font-black text-white bg-primary/70 px-2 py-0.5 rounded-md uppercase">{rec.type}</span></td>
                          <td className="px-4 py-3 font-mono text-sm font-bold text-slate-700">{rec.name}</td>
                          <td className="px-4 py-3 font-mono text-sm font-bold text-primary max-w-[200px] truncate">{rec.value}</td>
                          <td className="px-4 py-3 text-sm text-slate-500 font-bold">{rec.ttl}</td>
                          <td className="px-4 py-3 text-center">{statusBadge(domainVerification === 'verified' ? 'verified' : 'pending')}</td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => copyToClipboard(`${rec.type}\t${rec.name}\t${rec.value}\t${rec.ttl}`, `dns-${i}`)} className="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-600 font-black text-[9px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1 ml-auto">
                              <span className="material-symbols-outlined text-xs">{copiedDns === `dns-${i}` ? 'check' : 'content_copy'}</span>
                              {copiedDns === `dns-${i}` ? 'Copied' : 'Copy'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {domainHistory.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Domain History</p>
                <div className="space-y-2">
                  {domainHistory.map(dh => (
                    <div key={dh.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-sm text-slate-400">history</span>
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{dh.action}</p>
                          <p className="text-[10px] text-slate-400">{dh.domain} · {dh.actor} · {dh.date}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Usage' && (() => {
          if (!usage) return <p className="text-slate-400 font-bold">No usage data available for this tenant.</p>;
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Seats</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.seatsUsed}/{usage.seatsAllowed}</p>
                    {usage.seatsUsed >= usage.seatsAllowed && <span className="text-[8px] font-black text-red-500 bg-red-50 px-1.5 py-0.5 rounded uppercase">At Limit</span>}
                  </div>
                  {usageBar(usage.seatsUsed, usage.seatsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Locations</p>
                  <p className="font-black text-primary">{usage.locationsUsed}/{usage.locationsAllowed}</p>
                  {usageBar(usage.locationsUsed, usage.locationsAllowed)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">API Calls</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.apiCalls.toLocaleString()}/{usage.apiLimit.toLocaleString()}</p>
                    {priorUsage && trendArrow(usage.apiCalls, priorUsage.apiCalls)}
                  </div>
                  {usageBar(usage.apiCalls, usage.apiLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Storage</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.storageMb}MB/{usage.storageLimitMb}MB</p>
                    {priorUsage && trendArrow(usage.storageMb, priorUsage.storageMb)}
                  </div>
                  {usageBar(usage.storageMb, usage.storageLimitMb)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">SMS</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.smsUsed}/{usage.smsLimit}</p>
                    {priorUsage && trendArrow(usage.smsUsed, priorUsage.smsUsed)}
                  </div>
                  {usageBar(usage.smsUsed, usage.smsLimit)}
                </div>
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tickets / Invoices</p>
                  <div className="flex items-center justify-between">
                    <p className="font-black text-primary">{usage.ticketsThisMonth} / {usage.invoicesThisMonth}</p>
                    {priorUsage && trendArrow(usage.ticketsThisMonth, priorUsage.ticketsThisMonth)}
                  </div>
                  <p className="text-[10px] text-slate-400">this month</p>
                </div>
              </div>

              {priorUsage && (
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Period Comparison</p>
                  <div className="bg-slate-50 rounded-xl border border-slate-100 overflow-hidden">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Metric</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Prior</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Current</th>
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { label: 'API Calls', current: usage.apiCalls, prior: priorUsage.apiCalls },
                          { label: 'Storage (MB)', current: usage.storageMb, prior: priorUsage.storageMb },
                          { label: 'SMS', current: usage.smsUsed, prior: priorUsage.smsUsed },
                          { label: 'Tickets', current: usage.ticketsThisMonth, prior: priorUsage.ticketsThisMonth },
                          { label: 'Invoices', current: usage.invoicesThisMonth, prior: priorUsage.invoicesThisMonth },
                        ].map(row => (
                          <tr key={row.label} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-3 text-sm font-bold text-slate-700">{row.label}</td>
                            <td className="px-4 py-3 text-sm font-bold text-slate-500 text-right">{row.prior.toLocaleString()}</td>
                            <td className="px-4 py-3 text-sm font-black text-slate-900 text-right">{row.current.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right">{trendArrow(row.current, row.prior)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <Link to={`/owner/usage?tenant=${tenant.id}`} className="inline-flex items-center gap-2 px-5 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 active:scale-95 transition-all uppercase tracking-widest">
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                View Platform Usage
              </Link>
            </div>
          );
        })()}

        {activeTab === 'Activity / Audit' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center flex-wrap gap-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Activity log for {tenant.name}</p>
              <div className="flex gap-2 flex-wrap">
                <select value={auditCategoryFilter} onChange={e => setAuditCategoryFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Categories</option>
                  {auditCategories.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
                </select>
                <select value={auditActorFilter} onChange={e => setAuditActorFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Actors</option>
                  {auditActors.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <button onClick={() => { showToast('Audit log exported'); }} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-lg uppercase tracking-widest transition-all flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">download</span> Export
                </button>
              </div>
            </div>
            {filteredLogs.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No activity matches your filters.</p>}
            <div className="space-y-2">
              {filteredLogs.map(log => (
                <button type="button" key={log.id} onClick={() => setAuditDetailId(log.id)} className="w-full flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100 hover:bg-slate-100 transition-colors text-left cursor-pointer">
                  <div className="flex items-center gap-3">
                    <span className={`material-symbols-outlined text-sm ${log.severity === 'warning' ? 'text-amber-500' : 'text-blue-400'}`}>
                      {log.severity === 'warning' ? 'warning' : 'info'}
                    </span>
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{log.action}</p>
                      <p className="text-[10px] text-slate-400">{log.actor} · {log.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(log.category)}
                    {statusBadge(log.severity === 'warning' ? 'warning' : 'info')}
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>
                </button>
              ))}
            </div>
            <button onClick={() => navigate('/owner/audit-security')} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">open_in_new</span> Full Audit Log
            </button>

            <AnimatePresence>
              {selectedAuditLog && (
                <div role="dialog" aria-modal="true" aria-label="Audit Log Detail" className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={() => setAuditDetailId(null)} onKeyDown={e => { if (e.key === 'Escape') setAuditDetailId(null); }}>
                  <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} onClick={e => e.stopPropagation()} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-8 border-b border-slate-100">
                      <h3 className="text-xl font-black text-primary tracking-tight">Audit Log Detail</h3>
                      <p className="text-sm text-slate-500 mt-1">{selectedAuditLog.id}</p>
                    </div>
                    <div className="p-8 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className={labelClass}>Action</p>
                          <p className="font-bold text-slate-900">{selectedAuditLog.action}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Target</p>
                          <p className="font-bold text-slate-900">{selectedAuditLog.target}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Actor</p>
                          <p className="font-bold text-slate-900">{selectedAuditLog.actor}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Date</p>
                          <p className="font-bold text-slate-900">{selectedAuditLog.date}</p>
                        </div>
                        <div>
                          <p className={labelClass}>Category</p>
                          {statusBadge(selectedAuditLog.category)}
                        </div>
                        <div>
                          <p className={labelClass}>Severity</p>
                          {statusBadge(selectedAuditLog.severity === 'warning' ? 'warning' : 'info')}
                        </div>
                      </div>
                      <div>
                        <p className={labelClass}>Tenant</p>
                        <p className="font-bold text-slate-900">{tenant.name} ({tenant.id})</p>
                      </div>
                    </div>
                    <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                      <button onClick={() => setAuditDetailId(null)} className="flex-1 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-black text-sm rounded-2xl uppercase tracking-widest transition-all">Close</button>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        {activeTab === 'Support Notes' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center flex-wrap gap-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Support Notes ({supportNotes.length})</p>
              <div className="flex gap-2">
                <select value={supportCategoryFilter} onChange={e => setSupportCategoryFilter(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20">
                  <option value="all">All Categories</option>
                  <option value="general">General</option>
                  <option value="billing">Billing</option>
                  <option value="technical">Technical</option>
                  <option value="escalation">Escalation</option>
                  <option value="onboarding">Onboarding</option>
                </select>
              </div>
            </div>

            {tenant.flags.length > 0 && (
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">Active Flags</p>
                <div className="flex gap-2 flex-wrap">
                  {tenant.flags.map((f, i) => <span key={i} className="px-2.5 py-1 bg-amber-400/10 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg border border-amber-400/20">{f}</span>)}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {filteredSupportNotes.length === 0 && <p className="text-sm text-slate-400 font-bold py-4">No support notes match your filter.</p>}
              {filteredSupportNotes.map(note => (
                <div key={note.id} className={`p-4 rounded-xl border ${note.pinned ? 'bg-amber-50 border-amber-100' : note.isEscalated ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      {note.pinned && <span className="material-symbols-outlined text-amber-500 text-sm">push_pin</span>}
                      {note.isEscalated && <span className="material-symbols-outlined text-red-500 text-sm">priority_high</span>}
                      {statusBadge(note.category)}
                    </div>
                    <div className="flex items-center gap-2">
                      {note.assignedTo && <span className="text-[10px] font-bold text-slate-500">{note.assignedTo}</span>}
                      {note.followUpDate && (
                        <span className={`text-[10px] font-bold ${new Date(note.followUpDate) <= new Date('2026-03-26') ? 'text-red-500' : 'text-slate-400'}`}>
                          Follow-up: {note.followUpDate}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-slate-700 font-medium">{note.text}</p>
                  <p className="text-[10px] text-slate-400 mt-2">{note.createdBy} · {note.createdDate}</p>
                </div>
              ))}
            </div>

            <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 space-y-4">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Add Note</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="note-category" className={labelClass}>Category</label>
                  <select id="note-category" value={noteCategory} onChange={e => setNoteCategory(e.target.value as SupportNoteCategory)} className={inputClass}>
                    <option value="general">General</option>
                    <option value="billing">Billing</option>
                    <option value="technical">Technical</option>
                    <option value="escalation">Escalation</option>
                    <option value="onboarding">Onboarding</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="note-assignee" className={labelClass}>Assign To</label>
                  <input id="note-assignee" value={noteAssignee} onChange={e => setNoteAssignee(e.target.value)} className={inputClass} placeholder="Admin name" />
                </div>
                <div>
                  <label htmlFor="note-followup" className={labelClass}>Follow-up Date</label>
                  <input id="note-followup" type="date" value={noteFollowUp} onChange={e => setNoteFollowUp(e.target.value)} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="support-note" className={labelClass}>Note</label>
                <textarea id="support-note" value={noteInput} onChange={e => setNoteInput(e.target.value)} className={`${inputClass} resize-none`} rows={3} placeholder="Add a support note for this tenant..." />
              </div>
              <button onClick={() => {
                if (noteInput.trim()) {
                  setLocalNotes(prev => [...prev, {
                    id: `sn-local-${Date.now()}`,
                    tenantId: tenant.id,
                    text: noteInput.trim(),
                    category: noteCategory,
                    pinned: false,
                    followUpDate: noteFollowUp || null,
                    assignedTo: noteAssignee || null,
                    createdBy: 'You',
                    createdDate: '2026-03-26',
                    isEscalated: false,
                  }]);
                  setNoteInput('');
                  setNoteAssignee('');
                  setNoteFollowUp('');
                  showToast('Support note added');
                }
              }} disabled={!noteInput.trim()} className="px-6 py-3.5 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">Add Note</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TenantDetailPage;
