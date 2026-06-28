// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Screen components. Every screen is presentational and renders ONLY local static
// mock data. No fetching, no mutation, no backend calls. All action affordances are
// disabled / visual-only.

import React from 'react';
import type { BcpModule, EnvLabel } from './types';
import {
  ActionChipView,
  CheckIcon,
  cx,
  DataTable,
  DeferToneBadge,
  GuardedButton,
  HealthLabel,
  KpiCardView,
  LockIcon,
  Monogram,
  Panel,
  ShieldIcon,
  StateChipView,
} from './ui';
import {
  ALERT_CATEGORIES,
  APPROVALS,
  AUDIT_DETAIL,
  AUDIT_EVENTS,
  AUDIT_READINESS,
  BILLING_OPS_POSTURE,
  BILLING_OPS_SUMMARY,
  BILLING_PLAN_SAFETY,
  BLOCKED_ACTIONS,
  BLOCKED_EVIDENCE,
  COVERAGE_MATRIX,
  CROSS_TENANT_SAFETY,
  DATABASES,
  DEV_REVIEW_POSTURE,
  DATA_GOVERNANCE,
  DATA_GOVERNANCE_DETAIL,
  DIAGNOSTIC_DETAIL,
  DIAGNOSTICS,
  ENTITLEMENT_POSTURE,
  EVIDENCE_REGISTER,
  EVIDENCE_SUMMARY,
  FINAL_SAFETY_GATE,
  GOVERNANCE_QUEUE,
  IDENTITY_DETAIL,
  IDENTITY_LINK_FACTS,
  IDENTITY_LINK_TIMELINE,
  IDENTITY_READINESS,
  KPIS,
  OPS_JOB_DETAIL,
  OPS_METRICS,
  OPS_SERVICE_DETAIL,
  PERMISSION_MATRIX,
  PLAN_POSTURE,
  PLAN_SUBSCRIPTION_SUMMARY,
  POLICIES,
  PRODUCTION_BLOCKERS,
  PRODUCTION_PATH,
  READINESS_GATE_CARDS,
  RISK_SUMMARY,
  ROLES,
  SCOPE_AXES,
  SERVICES,
  STORES,
  STORE_OPS_POSTURE,
  STORE_OPS_SUMMARY,
  SYSTEM_POSTURE,
  SYSTEM_POSTURE_NOTES,
  TENANTS,
  TENANT_OPS_POSTURE,
  TENANT_OPS_SUMMARY,
  TENANT_STORE_READINESS,
  TIMELINE_ENTRIES,
} from './mockData';
import type { EntitlementRow, GovDetail, Health, PostureCard, TenantStoreRow } from './types';
import type { ReadinessGateCard } from './types';
import C01ReadinessCard from './C01ReadinessCard';
import C02RegistryReadinessCard from './C02RegistryReadinessCard';
import C03UiCoverageReadinessCard from './C03UiCoverageReadinessCard';
import C04RouteExposureReadinessCard from './C04RouteExposureReadinessCard';
import C05FeatureFlagPostureReadinessCard from './C05FeatureFlagPostureReadinessCard';

function ScreenHeading({ module }: { module: BcpModule }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/60 pb-4">
      <div className="flex items-start gap-3">
        <span className="mt-1 h-9 w-1.5 shrink-0 rounded-full bg-gradient-to-b from-emerald-400/80 via-sky-400/50 to-transparent" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-black tracking-tight text-slate-100">{module.name}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">{module.purpose}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StateChipView state={module.state} />
        <ActionChipView action="Read Only" />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Command Center
function CommandCenter({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {KPIS.map((k) => (
          <div key={k.label}>
            <KpiCardView {...k} />
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Platform Topology" subtitle="Environment → Tenant → Store → Database (mock)">
          <div className="space-y-2 text-sm text-slate-300">
            {TENANTS.map((t) => (
              <div key={t.label} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Monogram label={t.label} tone="healthy" />
                  <span className="font-semibold text-slate-200">{t.label}</span>
                  <span className="ml-auto text-xs text-slate-400">{t.isolation}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Pending Approvals" subtitle="Separation of duties enforced (mock)">
          <ul className="space-y-2 text-sm">
            {APPROVALS.map((a) => (
              <li key={a.request} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                <span className="text-slate-200">{a.request}</span>
                <ActionChipView action="Approval Required" />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Recent Audit" subtitle="Immutable, redacted evidence (mock)">
          <ul className="space-y-1.5 text-sm">
            {AUDIT_EVENTS.slice(0, 5).map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 border-b border-slate-800/50 pb-1.5">
                <span className="font-mono text-xs text-slate-300">{e.category}</span>
                <span className="text-xs text-slate-500">{e.evidence}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Services Health" subtitle="Read-only (mock)">
          <div className="grid grid-cols-2 gap-2">
            {SERVICES.slice(0, 6).map((s) => (
              <div key={s.name} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                <HealthLabel tone={s.tone}>{s.name}</HealthLabel>
                <div className="mt-1 text-[11px] text-slate-500">{s.status}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Database Isolation" subtitle="RLS / masked connection posture (mock)">
          <ul className="space-y-1.5 text-sm">
            {DATABASES.map((d) => (
              <li key={d.scope} className="flex items-center justify-between border-b border-slate-800/50 pb-1.5">
                <HealthLabel tone={d.tone}>{d.scope}</HealthLabel>
                <span className="text-xs text-slate-500">{d.rls} · {d.connection}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Environment Guardrails" subtitle="Production blocked by default (mock)">
          <div className="flex flex-wrap gap-2">
            <DeferToneBadge tone="blocked"><LockIcon className="h-3.5 w-3.5" /> Production Locked</DeferToneBadge>
            <DeferToneBadge tone="warning">Approval Required</DeferToneBadge>
            <DeferToneBadge tone="neutral">DEV-First Writes</DeferToneBadge>
            <DeferToneBadge tone="healthy">Audit Required</DeferToneBadge>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Dangerous actions are blocked, dormant, or future-only. Production remains blocked
            until separately approved.
          </p>
        </Panel>

        <Panel
          title="Identity-Link Governance"
          subtitle="Dormant / default OFF / unwired (mock)"
          className="lg:col-span-2"
        >
          <div className="flex flex-wrap gap-2">
            <DeferToneBadge tone="neutral">Dormant</DeferToneBadge>
            <DeferToneBadge tone="neutral">Default OFF</DeferToneBadge>
            <DeferToneBadge tone="neutral">Unwired</DeferToneBadge>
            <DeferToneBadge tone="healthy">RLS Protected</DeferToneBadge>
            <DeferToneBadge tone="blocked">Production Blocked</DeferToneBadge>
            <DeferToneBadge tone="neutral">DEV table empty</DeferToneBadge>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Tenants
function Tenants({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Tenants" subtitle="Opaque references only — no real tenant data" right={<GuardedButton label="Provision Tenant DB" hint="Future · Approval Required · DEV-only" />}>
        <DataTable
          columns={['Tenant', 'Isolation', 'Tenant DB', 'Stores', 'Schema', 'Backup', 'Last Audit', 'Production']}
          rows={TENANTS.map((t) => [
            <span className="flex items-center gap-2"><Monogram label={t.label} tone="healthy" /><span className="font-semibold">{t.label}</span></span>,
            t.isolation,
            t.dbStatus,
            t.stores,
            t.schema,
            t.backup,
            <span className="text-slate-500">{t.lastAudit}</span>,
            <ActionChipView action="Production Blocked" />,
          ])}
        />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------------------- Stores
function Stores({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Stores" subtitle="Opaque references only — no real store data" right={<GuardedButton label="Provision Store DB" hint="Future · Approval Required · DEV-only" />}>
        <DataTable
          minWidthClass="min-w-[980px]"
          columns={['Store', 'Tenant', 'Store DB', 'Service', 'POS', 'Repair', 'Inventory', 'Backup', 'Last Event']}
          rows={STORES.map((s) => [
            <span className="flex items-center gap-2"><Monogram label={s.label} tone="neutral" /><span className="font-semibold">{s.label}</span></span>,
            s.tenant,
            s.dbStatus,
            s.service,
            s.pos,
            s.repair,
            s.inventory,
            s.backup,
            <span className="text-slate-500">{s.lastEvent}</span>,
          ])}
        />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------------------- Database Registry
function DatabaseRegistry({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Database Registry" subtitle="Posture metadata only — connection strings are never shown" right={<GuardedButton label="Lock / Unlock" hint="Future · Approval Required" />}>
        <DataTable
          columns={['Scope', 'Environment', 'Schema', 'Migration', 'RLS', 'Backup', 'Connection', 'Lock']}
          rows={DATABASES.map((d) => [
            <HealthLabel tone={d.tone}>{d.scope}</HealthLabel>,
            d.environment,
            d.schema,
            d.migration,
            <DeferToneBadge tone="healthy">{d.rls}</DeferToneBadge>,
            d.backup,
            <DeferToneBadge tone="neutral">{d.connection}</DeferToneBadge>,
            <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" />{d.lock}</DeferToneBadge>,
          ])}
        />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------------------- Services
function Services({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SERVICES.map((s) => (
          <div key={s.name} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <HealthLabel tone={s.tone}>{s.name}</HealthLabel>
            <div className="mt-2 text-lg font-bold text-slate-100">{s.status}</div>
            <div className="mt-1 text-xs text-slate-500">{s.uptime}</div>
            <div className="mt-3">
              <GuardedButton label="Restart" hint="Future · Approval Required · production-blocked" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Identity & Access
function IdentityAccess({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Roles" subtitle="Mock RBAC — no real users, no real role grants" className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((r) => (
            <div key={r.name} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
              <div className="flex items-center gap-2">
                <ShieldIcon className="h-4 w-4 text-sky-300" />
                <span className="text-sm font-bold text-slate-100">{r.name}</span>
              </div>
              <div className="mt-1.5 text-xs text-slate-400">Scope: {r.scope}</div>
              <div className="text-xs text-slate-400">Access: {r.access}</div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Permission Matrix" subtitle="Illustrative model — not an enforcement system" className="lg:col-span-2">
          <DataTable
            columns={['Role', 'Read', 'Request', 'Approve', 'Execute', 'Production']}
            rows={PERMISSION_MATRIX.map((p) => [p.role, p.read, p.request, p.approve, p.execute, p.production])}
          />
        </Panel>
        <Panel title="Owner-Granted Scope" subtitle="Mock scoped access">
          <ul className="space-y-1.5 text-sm">
            {SCOPE_AXES.map((s) => (
              <li key={s.axis} className="flex items-center justify-between border-b border-slate-800/50 pb-1.5">
                <span className="text-slate-400">{s.axis}</span>
                <span className="font-semibold text-slate-200">{s.value}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Identity Links
function IdentityLinks({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel
        title="Identity Links — Dormant"
        subtitle="Aligned with accepted M20.11 / M20.12 state"
        right={
          <div className="flex flex-wrap gap-2">
            <ActionChipView action="DEV Only" />
            <ActionChipView action="Default OFF" />
            <ActionChipView action="Production Blocked" />
          </div>
        }
        className="mb-4"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {IDENTITY_LINK_FACTS.map((f) => (
            <div key={f} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
              <CheckIcon className="h-3.5 w-3.5 text-emerald-300" />
              {f}
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Link Status" subtitle="DEV table is empty (mock)">
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-10 text-center">
            <p className="text-sm font-semibold text-slate-300">No identity links</p>
            <p className="mt-1 text-xs text-slate-500">
              The DEV identity_link table exists and remains empty. Opaque references only.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <GuardedButton label="Create Link" hint="Future · DEV-only · Approval + SoD" />
            <GuardedButton label="Disable Link" hint="Future · DEV-only · Approval + SoD" />
            <GuardedButton label="Revoke Link" hint="Future · DEV-only · Approval + SoD" />
          </div>
        </Panel>

        <Panel title="Redacted Lifecycle Timeline" subtitle="Taxonomy labels only (mock)">
          <ul className="space-y-2 text-sm">
            {IDENTITY_LINK_TIMELINE.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                <span className="font-mono text-xs text-slate-300">{e.category}</span>
                <span className="text-xs text-slate-500">{e.outcome} · {e.evidence}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Audit & Approvals
function AuditApprovals({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Approval Queue" subtitle="Separation of duties — requester ≠ approver (mock)" className="mb-4">
        <DataTable
          columns={['Request', 'Requester', 'Approver', 'State', 'Separation', 'Env', 'Actions']}
          rows={APPROVALS.map((a) => [
            a.request,
            <span className="text-slate-500">{a.requester}</span>,
            <span className="text-slate-500">{a.approver}</span>,
            <ActionChipView action="Approval Required" />,
            <ActionChipView action="Separation of Duties" />,
            a.environment,
            <span className="flex gap-2">
              <GuardedButton label="Approve" hint="Disabled — read-only foundation" />
              <GuardedButton label="Reject" hint="Disabled — read-only foundation" />
            </span>,
          ])}
        />
      </Panel>

      <Panel title="Immutable Audit Timeline" subtitle="Append-only — redacted evidence only (mock)">
        <DataTable
          columns={['Category', 'Outcome', 'Reason', 'Actor', 'Env', 'Evidence']}
          rows={AUDIT_EVENTS.map((e) => [
            <span className="font-mono text-xs text-slate-300">{e.category}</span>,
            e.outcome,
            e.reason,
            <span className="text-slate-500">{e.actor}</span>,
            e.environment,
            <span className="text-slate-500">{e.evidence}</span>,
          ])}
        />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------------------- Policies & Guardrails
function PoliciesGuardrails({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {POLICIES.map((p) => (
          <div key={p.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="flex items-start justify-between gap-2">
              <ShieldIcon className="h-5 w-5 text-emerald-300" />
              <DeferToneBadge tone="healthy"><CheckIcon className="h-3 w-3" /> Policy Enforced</DeferToneBadge>
            </div>
            <h3 className="mt-3 text-sm font-bold text-slate-100">{p.title}</h3>
            <p className="mt-1 text-xs text-slate-400">{p.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Placeholder / Deferred / Blocked
function Placeholder({ module }: { module: BcpModule; env: EnvLabel }) {
  const statusTone =
    module.status === 'blocked' ? 'blocked' : module.status === 'deferred' ? 'warning' : 'neutral';
  const statusLabel =
    module.status === 'blocked' ? 'Blocked' : module.status === 'deferred' ? 'Deferred' : 'Placeholder';
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel
        title={`${statusLabel} — ${module.name}`}
        subtitle="No backend action available in this read-only foundation"
        right={<StateChipView state={module.state} />}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Why {statusLabel.toLowerCase()}</h4>
            <p className="mt-1.5 text-sm text-slate-300">{module.reason}</p>
            <h4 className="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">What a future milestone would add</h4>
            <p className="mt-1.5 text-sm text-slate-300">{module.futureMilestone}</p>
          </div>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Blocked actions</h4>
            <ul className="mt-1.5 space-y-1.5">
              {module.blockedActions.map((b) => (
                <li key={b} className="flex items-center gap-2 text-sm text-slate-300">
                  <LockIcon className="h-3.5 w-3.5 text-rose-300" />
                  {b}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <DeferToneBadge tone={statusTone}>{statusLabel}</DeferToneBadge>
              <DeferToneBadge tone="neutral">No Backend Action</DeferToneBadge>
              <DeferToneBadge tone="blocked">Production Blocked</DeferToneBadge>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------------------- Access Gate (in-shell info screen)
function AccessGateInfo({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <Panel title="Separate Secure Workspace" subtitle="This shell is separate from the Owner Platform">
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            'Backend Control Plane is a separate secure workspace',
            'Owner-granted access is required',
            'Second-factor posture is visual only (mock)',
            'Production actions are locked',
            'All write actions require approval',
            'Entry is mock / read-only',
          ].map((t) => (
            <li key={t} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
              <ShieldIcon className="h-4 w-4 text-sky-300" />
              {t}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// =========================================================================
// Phase 1.6 M23 — read-only / mock-only operations expansion screens.
// Presentational only. No fetch, no mutation, no backend/DB/API calls.
// =========================================================================

// Shared safety badge row shown at the top of every expansion screen.
function ReadOnlyBadges({ extra }: { extra?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <DeferToneBadge tone="neutral">Read-Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Mock-Only</DeferToneBadge>
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Blocked</DeferToneBadge>
      <DeferToneBadge tone="blocked">Writes Blocked</DeferToneBadge>
      {extra}
    </div>
  );
}

// Reusable posture-tile grid (system / data / audit overviews).
function PostureGrid({ cards }: { cards: PostureCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <div key={c.title} className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/70 to-slate-900/40 p-4 ring-1 ring-white/5 transition hover:border-slate-700 hover:ring-white/10">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{c.title}</span>
            <HealthLabel tone={c.tone}>{c.status}</HealthLabel>
          </div>
          <p className="mt-2 text-xs text-slate-400">{c.detail}</p>
        </div>
      ))}
    </div>
  );
}

// Read-only internal tab switch (Overview <-> Detail). Local UI state only; no action.
function DetailTabs({ tab, setTab }: { tab: 'overview' | 'detail'; setTab: (t: 'overview' | 'detail') => void }) {
  const tabs: Array<{ key: 'overview' | 'detail'; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'detail', label: 'Detail' },
  ];
  return (
    <div className="mb-4 inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1 ring-1 ring-white/5">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setTab(t.key)}
          aria-pressed={t.key === tab}
          className={cx(
            'rounded-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
            t.key === tab ? 'bg-slate-700 text-slate-100 shadow-sm ring-1 ring-inset ring-white/10' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Derive a tone for a mock status category string (read-only display only).
function govTone(status: string): Health {
  const s = status.toLowerCase();
  if (s.includes('block')) return 'blocked';
  if (s.includes('warn') || s.includes('requir')) return 'warning';
  if (s.includes('neutral')) return 'neutral';
  return 'healthy';
}

// Shared read-only governance detail table (data governance + audit detail).
function GovDetailTable({ rows }: { rows: GovDetail[] }) {
  return (
    <DataTable
      minWidthClass="min-w-[760px]"
      columns={['Area', 'Posture', 'Status', 'Last Reviewed', 'Notes']}
      rows={rows.map((r) => [
        <span className="font-semibold text-slate-200">{r.area}</span>,
        r.posture,
        <DeferToneBadge tone={govTone(r.status)}>{r.status}</DeferToneBadge>,
        <span className="text-slate-500">{r.lastReviewed}</span>,
        <span className="text-slate-500">{r.note}</span>,
      ])}
    />
  );
}

// --------------------------------------------------------------------------- System Operations Overview
function SystemOperationsOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  const [tab, setTab] = React.useState<'overview' | 'detail'>('overview');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges />
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === 'overview' ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {OPS_METRICS.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Service Health" subtitle="Read-only / mock-only — no live systems">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SERVICES.map((s) => (
                  <div key={s.name} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                    <HealthLabel tone={s.tone}>{s.name}</HealthLabel>
                    <div className="mt-1 text-[11px] text-slate-500">{s.status} · {s.uptime}</div>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Operational Posture" subtitle="Production locked · write path blocked (mock)">
              <PostureGrid cards={SYSTEM_POSTURE} />
            </Panel>
          </div>
        </>
      ) : (
        <>
          <Panel title="Service Detail" subtitle="Service-by-service status (mock) — no live health check" className="mb-4">
            <DataTable
              columns={['Service', 'Status', 'Uptime', 'Latency', 'Last Checked']}
              rows={OPS_SERVICE_DETAIL.map((s) => [
                <HealthLabel tone={s.tone}>{s.name}</HealthLabel>,
                s.status,
                s.uptime,
                s.latency,
                <span className="text-slate-500">{s.lastChecked}</span>,
              ])}
            />
          </Panel>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Jobs · Queues · Alerts" subtitle="Mock detail — no run/repair/restart controls">
              <DataTable
                minWidthClass="min-w-[520px]"
                columns={['Name', 'Type', 'State', 'Severity', 'Last Event']}
                rows={OPS_JOB_DETAIL.map((j) => [
                  <span className="font-semibold text-slate-200">{j.name}</span>,
                  j.type,
                  j.state,
                  <DeferToneBadge tone={j.severity === 'Critical' ? 'blocked' : j.severity === 'Warning' ? 'warning' : 'neutral'}>{j.severity}</DeferToneBadge>,
                  <span className="text-slate-500">{j.lastEvent}</span>,
                ])}
              />
            </Panel>
            <Panel title="Operational Posture Explanation" subtitle="Why this surface is observational only">
              <ul className="space-y-2 text-sm">
                {SYSTEM_POSTURE_NOTES.map((n) => (
                  <li key={n} className="flex items-start gap-2 text-slate-300">
                    <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
                    {n}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Data Governance Overview
function DataGovernanceOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  const [tab, setTab] = React.useState<'overview' | 'detail'>('overview');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">No Live DB Calls</DeferToneBadge>} />
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === 'overview' ? (
        <>
          <Panel title="Data Governance Posture" subtitle="Schema / migration / isolation / RLS posture (mock)" className="mb-4">
            <PostureGrid cards={DATA_GOVERNANCE} />
          </Panel>
          <Panel
            title="Schema & Migration Posture"
            subtitle="Posture metadata only — connection strings are never shown"
            right={<DeferToneBadge tone="neutral">No Live DB Calls</DeferToneBadge>}
          >
            <DataTable
              columns={['Scope', 'Environment', 'Schema', 'Migration', 'RLS', 'Connection']}
              rows={DATABASES.map((d) => [
                <HealthLabel tone={d.tone}>{d.scope}</HealthLabel>,
                d.environment,
                d.schema,
                d.migration,
                <DeferToneBadge tone="healthy">{d.rls}</DeferToneBadge>,
                <DeferToneBadge tone="neutral">{d.connection}</DeferToneBadge>,
              ])}
            />
          </Panel>
        </>
      ) : (
        <>
          <Panel
            title="Governance Detail"
            subtitle="Schema · migration · isolation · RLS detail (mock) — no DB introspection, no migration runner"
            right={<DeferToneBadge tone="neutral">No DB Introspection</DeferToneBadge>}
            className="mb-4"
          >
            <GovDetailTable rows={DATA_GOVERNANCE_DETAIL} />
          </Panel>
          <Panel title="Boundary Notes" subtitle="Read-only / mock-only">
            <div className="flex flex-wrap gap-2">
              <DeferToneBadge tone="healthy">RLS Protected</DeferToneBadge>
              <DeferToneBadge tone="healthy">Tenant Isolation</DeferToneBadge>
              <DeferToneBadge tone="neutral">Masked Connection</DeferToneBadge>
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Migration Runner</DeferToneBadge>
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No DB Introspection</DeferToneBadge>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              All values are static, mock-only posture categories with mock review fields. This console
              never introspects a database, never runs a migration, and never shows a connection string.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Identity Readiness Overview
function IdentityReadinessOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  const [tab, setTab] = React.useState<'overview' | 'detail'>('overview');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="warning">M20 Stream Paused</DeferToneBadge>} />
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === 'overview' ? (
        <>
          <Panel title="Identity / Authorization Readiness" subtitle="Read-only status — writes and execution remain blocked (mock)" className="mb-4">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {IDENTITY_READINESS.map((r) => (
                <div key={r.domain} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-200">{r.domain}</span>
                    <HealthLabel tone={r.tone}>{r.status}</HealthLabel>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{r.detail}</p>
                  <div className="mt-3">
                    <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> {r.writeState}</DeferToneBadge>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Stream Status" subtitle="Aligned with accepted M20 paused state">
            <div className="flex flex-wrap gap-2">
              <DeferToneBadge tone="warning">M20.24-OptionC1 — NOT READY</DeferToneBadge>
              <DeferToneBadge tone="blocked">M20.20 Execution Blocked</DeferToneBadge>
              <DeferToneBadge tone="blocked">M20.17C Blocked</DeferToneBadge>
              <DeferToneBadge tone="neutral">No Controlled Pair A</DeferToneBadge>
              <DeferToneBadge tone="neutral">Identity-Link Wiring Absent</DeferToneBadge>
              <DeferToneBadge tone="blocked">No Identity-Link Writes</DeferToneBadge>
              <DeferToneBadge tone="blocked">No Registry Entry Creation</DeferToneBadge>
              <DeferToneBadge tone="blocked">No Fixture Provisioning</DeferToneBadge>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              This overview is observational only. It performs no identity-link creation, no registry-entry
              creation, and no fixture provisioning. Server authorization remains non-authoritative.
            </p>
          </Panel>
        </>
      ) : (
        <>
          <Panel
            title="Identity Readiness Detail"
            subtitle="Per-domain posture with explicit blocked write / execute / authority states (mock)"
            right={<DeferToneBadge tone="warning">M20 Paused</DeferToneBadge>}
            className="mb-4"
          >
            <DataTable
              minWidthClass="min-w-[920px]"
              columns={['Domain', 'Posture', 'Write State', 'Execute State', 'Authority', 'Notes']}
              rows={IDENTITY_DETAIL.map((d) => [
                <span className="font-mono text-xs font-semibold text-slate-200">{d.domain}</span>,
                d.posture,
                <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> {d.writeState}</DeferToneBadge>,
                <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> {d.executeState}</DeferToneBadge>,
                <span className="text-slate-400">{d.authority}</span>,
                <span className="text-slate-500">{d.note}</span>,
              ])}
            />
          </Panel>
          <Panel title="M20 Stream — Paused & Not Executable" subtitle="Accepted state; nothing here changes it">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                'Writes blocked (identity_link create / disable / revoke)',
                'Execution blocked (M20.20 fixture provisioning)',
                'Execution blocked (M20.17C controlled DB exercise)',
                'Not authoritative (Firebase remains authoritative)',
                'No Controlled Pair A exists',
                'Owner / reviewer / separation approval signals missing',
                'No registry entry creation',
                'No approval-signal provisioning',
              ].map((t) => (
                <div key={t} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
                  <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                  {t}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              This detail view is observational only. No identity-link, registry, fixture, or approval-signal
              capability exists here. The M20 stream remains paused until separately approved.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Audit Governance Overview
function AuditGovernanceOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  const [tab, setTab] = React.useState<'overview' | 'detail'>('overview');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">Append-Only Concept</DeferToneBadge>} />
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === 'overview' ? (
        <>
          <Panel title="Audit & Governance Readiness" subtitle="Append-only / redaction-first concept (mock)" className="mb-4">
            <PostureGrid cards={AUDIT_READINESS} />
          </Panel>
          <Panel title="Governance Indicators" subtitle="Approval-required · redaction · immutability (mock)">
            <div className="flex flex-wrap gap-2">
              <ActionChipView action="Approval Required" />
              <ActionChipView action="Owner Approval" />
              <ActionChipView action="Separation of Duties" />
              <ActionChipView action="Audit Required" />
              <DeferToneBadge tone="healthy"><ShieldIcon className="h-3 w-3" /> Redaction-First</DeferToneBadge>
              <DeferToneBadge tone="healthy"><CheckIcon className="h-3 w-3" /> Immutable Audit</DeferToneBadge>
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Audit Writes</DeferToneBadge>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              No audit_event is written from this console. Evidence is aggregate / redacted only — no raw
              identifiers, secrets, or payloads.
            </p>
          </Panel>
        </>
      ) : (
        <>
          <Panel
            title="Audit Readiness Detail"
            subtitle="Approval · redaction · immutability posture detail (mock) — no live audit query"
            right={<DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Audit Writes</DeferToneBadge>}
            className="mb-4"
          >
            <GovDetailTable rows={AUDIT_DETAIL} />
          </Panel>
          <Panel title="Governance Queue" subtitle="Mock queue — separation of duties enforced · no approve/deny controls">
            <DataTable
              minWidthClass="min-w-[640px]"
              columns={['Request', 'Requester', 'Approver', 'State', 'Separation', 'Env']}
              rows={APPROVALS.map((a) => [
                <span className="text-slate-200">{a.request}</span>,
                <span className="text-slate-500">{a.requester}</span>,
                <span className="text-slate-500">{a.approver}</span>,
                <ActionChipView action="Approval Required" />,
                <ActionChipView action="Separation of Duties" />,
                a.environment,
              ])}
            />
            <p className="mt-3 text-xs text-slate-400">
              The governance queue is observational only. No approve, deny, or evidence-editing control exists;
              evidence is append-only and redacted.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Support & Diagnostics Overview
function SupportDiagnosticsOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  const [tab, setTab] = React.useState<'overview' | 'detail'>('overview');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">No Live Invocation</DeferToneBadge>} />
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === 'overview' ? (
        <Panel title="Diagnostics & Runbooks" subtitle="Static labels only — no live diagnostic invocation, no route/API calls">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DIAGNOSTICS.map((d) => (
              <div key={d.label} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2">
                  <ShieldIcon className="h-4 w-4 text-sky-300" />
                  <span className="text-sm font-bold text-slate-100">{d.label}</span>
                </div>
                <div className="mt-1.5 text-xs text-slate-400">Category: {d.category}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <DeferToneBadge tone="neutral">{d.note}</DeferToneBadge>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-400">
            Runbook entries are static, non-clickable labels. This console invokes no live diagnostics, makes
            no route/API calls, and exposes no raw identifiers or secrets.
          </p>
        </Panel>
      ) : (
        <Panel
          title="Diagnostics Catalogue Detail"
          subtitle="Severity · owner · status (mock) — not invokable"
          right={<DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Not Invokable</DeferToneBadge>}
        >
          <DataTable
            minWidthClass="min-w-[820px]"
            columns={['Runbook', 'Category', 'Severity', 'Owner', 'Status', 'Invoke']}
            rows={DIAGNOSTIC_DETAIL.map((d) => [
              <span className="font-semibold text-slate-200">{d.label}</span>,
              d.category,
              <DeferToneBadge tone={d.severity === 'Critical' ? 'blocked' : d.severity === 'Warning' ? 'warning' : 'neutral'}>{d.severity}</DeferToneBadge>,
              <span className="text-slate-400">{d.owner}</span>,
              <DeferToneBadge tone="neutral">{d.status}</DeferToneBadge>,
              <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] font-semibold text-slate-500 opacity-70">
                <LockIcon className="h-3 w-3" /> Not Invokable
              </span>,
            ])}
          />
          <p className="mt-3 text-xs text-slate-400">
            Every catalogue entry is a static, non-invokable label. This console performs no live diagnostic
            invocation, makes no route/API calls, and exposes no raw identifiers or secrets.
          </p>
        </Panel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Risk & Alerts Lens
// Read-only multi-section tab switch (local UI state only; no action).
function SectionTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ key: string; label: string }>;
  active: string;
  onSelect: (k: string) => void;
}) {
  return (
    <div className="mb-4 inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1 ring-1 ring-white/5">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          aria-pressed={t.key === active}
          className={cx(
            'rounded-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
            t.key === active ? 'bg-slate-700 text-slate-100 shadow-sm ring-1 ring-inset ring-white/10' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function severityTone(severity: string): Health {
  const s = severity.toLowerCase();
  if (s.includes('critical')) return 'blocked';
  if (s.includes('high') || s.includes('warn') || s.includes('medium')) return 'warning';
  if (s.includes('low')) return 'neutral';
  return 'neutral';
}

function RiskAlertsLens({ module }: { module: BcpModule; env: EnvLabel }) {
  const [section, setSection] = React.useState('summary');
  const [activeCat, setActiveCat] = React.useState(ALERT_CATEGORIES[0].category);
  const selected = ALERT_CATEGORIES.find((c) => c.category === activeCat) || ALERT_CATEGORIES[0];
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">Observational Only</DeferToneBadge>} />
      <SectionTabs
        tabs={[
          { key: 'summary', label: 'Risk Summary' },
          { key: 'alerts', label: 'Alert Categories' },
          { key: 'governance', label: 'Governance Queue' },
          { key: 'blocked', label: 'Blocked Register' },
        ]}
        active={section}
        onSelect={setSection}
      />

      {section === 'summary' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {RISK_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel title="Risk Posture" subtitle="Observational only — no alerting, no notification (mock)" className="mt-5">
            <div className="flex flex-wrap gap-2">
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Locked</DeferToneBadge>
              <DeferToneBadge tone="blocked">Write Path Blocked</DeferToneBadge>
              <DeferToneBadge tone="warning">M20 Paused (NOT READY)</DeferToneBadge>
              <DeferToneBadge tone="neutral">No Alert Sending</DeferToneBadge>
              <DeferToneBadge tone="neutral">No Notification</DeferToneBadge>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              This lens is observational only. It sends no alerts and no notifications, performs no live
              diagnostics, and has no approve / deny / resolve / assign controls.
            </p>
          </Panel>
        </>
      )}

      {section === 'alerts' && (
        <>
          <Panel title="Alert Categories" subtitle="Static risk categories with severity / state (mock) — no notification sending" className="mb-4">
            <DataTable
              minWidthClass="min-w-[640px]"
              columns={['Category', 'Severity', 'State']}
              rows={ALERT_CATEGORIES.map((c) => [
                <span className="font-semibold text-slate-200">{c.category}</span>,
                <DeferToneBadge tone={severityTone(c.severity)}>{c.severity}</DeferToneBadge>,
                <DeferToneBadge tone={c.tone}>{c.state}</DeferToneBadge>,
              ])}
            />
          </Panel>
          <Panel title="Risk Detail" subtitle="Read-only category selection — no live drilldown, no external calls">
            <div className="mb-3 flex flex-wrap gap-2">
              {ALERT_CATEGORIES.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => setActiveCat(c.category)}
                  aria-pressed={c.category === activeCat}
                  className={cx(
                    'rounded-lg border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    c.category === activeCat
                      ? 'border-slate-600 bg-slate-800 text-slate-100'
                      : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200',
                  )}
                >
                  {c.category}
                </button>
              ))}
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-100">{selected.category}</span>
                <DeferToneBadge tone={severityTone(selected.severity)}>{selected.severity}</DeferToneBadge>
                <DeferToneBadge tone={selected.tone}>{selected.state}</DeferToneBadge>
              </div>
              <p className="mt-2 text-sm text-slate-300">{selected.detail}</p>
            </div>
          </Panel>
        </>
      )}

      {section === 'governance' && (
        <Panel
          title="Governance Attention Queue"
          subtitle="Read-only — no approve / deny / resolve / assign controls (mock)"
          right={<DeferToneBadge tone="warning">M20 NOT READY</DeferToneBadge>}
        >
          <DataTable
            minWidthClass="min-w-[760px]"
            columns={['Item', 'Area', 'State', 'Severity', 'Notes']}
            rows={GOVERNANCE_QUEUE.map((g) => [
              <span className="font-semibold text-slate-200">{g.item}</span>,
              g.area,
              <DeferToneBadge tone={g.state.toLowerCase().includes('block') ? 'blocked' : 'warning'}>{g.state}</DeferToneBadge>,
              <DeferToneBadge tone={severityTone(g.severity)}>{g.severity}</DeferToneBadge>,
              <span className="text-slate-500">{g.note}</span>,
            ])}
          />
          <p className="mt-3 text-xs text-slate-400">
            The queue is observational only. There are no approve, deny, resolve, or assign controls. The M20
            identity-link stream remains NOT READY (M20.24 Decision B); controlled-draft creation, fixture
            provisioning, and M20.17C remain blocked.
          </p>
        </Panel>
      )}

      {section === 'blocked' && (
        <Panel title="Blocked Action Register" subtitle="Actions that remain blocked, with the reason why (mock)">
          <div className="space-y-2">
            {BLOCKED_ACTIONS.map((b) => (
              <div key={b.action} className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
                <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-slate-100">{b.action}</span>
                    <DeferToneBadge tone="blocked">Blocked</DeferToneBadge>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{b.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Timeline & Evidence Lens
function TimelineEvidenceLens({ module }: { module: BcpModule; env: EnvLabel }) {
  const [section, setSection] = React.useState('timeline');
  const [activeM, setActiveM] = React.useState(TIMELINE_ENTRIES[0].milestone);
  const selected = TIMELINE_ENTRIES.find((t) => t.milestone === activeM) || TIMELINE_ENTRIES[0];
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">No Live Evidence</DeferToneBadge>} />
      <SectionTabs
        tabs={[
          { key: 'timeline', label: 'Milestone Timeline' },
          { key: 'evidence', label: 'Evidence Summary' },
          { key: 'register', label: 'Evidence Register' },
          { key: 'blocked', label: 'Blocked Context' },
        ]}
        active={section}
        onSelect={setSection}
      />

      {section === 'timeline' && (
        <>
          <Panel title="Milestone Timeline" subtitle="Static history — safe labels only, no raw logs or commit diffs" className="mb-4">
            <div className="space-y-2">
              {TIMELINE_ENTRIES.map((t) => (
                <button
                  key={t.milestone}
                  type="button"
                  onClick={() => setActiveM(t.milestone)}
                  aria-pressed={t.milestone === activeM}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    t.milestone === activeM ? 'border-slate-600 bg-slate-800/60' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-800/30',
                  )}
                >
                  <Monogram label={t.milestone} tone={t.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-slate-100">{t.milestone}</span>
                      <span className="text-xs text-slate-400">{t.title}</span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">{t.checkpoint}</span>
                  </span>
                  <DeferToneBadge tone={t.tone}>{t.state}</DeferToneBadge>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="Timeline Detail" subtitle="Read-only selection — no live drilldown, no audit/DB query">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-100">{selected.milestone}</span>
                <span className="text-xs text-slate-400">{selected.title}</span>
                <DeferToneBadge tone={selected.tone}>{selected.state}</DeferToneBadge>
                <DeferToneBadge tone="neutral">{selected.checkpoint}</DeferToneBadge>
              </div>
              <p className="mt-2 text-sm text-slate-300">{selected.detail}</p>
            </div>
          </Panel>
        </>
      )}

      {section === 'evidence' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {EVIDENCE_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel title="Evidence Posture" subtitle="DEV-gated · read-only/mock-only · code-split preserved (mock)" className="mt-5">
            <div className="flex flex-wrap gap-2">
              <DeferToneBadge tone="healthy">Build Green</DeferToneBadge>
              <DeferToneBadge tone="healthy">Code-Split Preserved</DeferToneBadge>
              <DeferToneBadge tone="healthy">DEV-Gated</DeferToneBadge>
              <DeferToneBadge tone="neutral">Read-Only / Mock-Only</DeferToneBadge>
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Live Evidence Ingestion</DeferToneBadge>
              <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Audit Writes</DeferToneBadge>
            </div>
          </Panel>
        </>
      )}

      {section === 'register' && (
        <Panel title="Evidence Register" subtitle="Static evidence categories with safe status + note — no raw terminal output">
          <DataTable
            minWidthClass="min-w-[680px]"
            columns={['Category', 'Status', 'Note']}
            rows={EVIDENCE_REGISTER.map((e) => [
              <span className="font-semibold text-slate-200">{e.category}</span>,
              <DeferToneBadge tone={e.tone}>{e.status}</DeferToneBadge>,
              <span className="text-slate-500">{e.note}</span>,
            ])}
          />
        </Panel>
      )}

      {section === 'blocked' && (
        <Panel title="Blocked Evidence Context" subtitle="M20 paused state — observational only" right={<DeferToneBadge tone="warning">M20 NOT READY</DeferToneBadge>}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {BLOCKED_EVIDENCE.map((b) => (
              <div key={b} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
                <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                {b}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            This context is observational only. No evidence ingestion, audit write, or export occurs. The M20
            stream remains paused until separately approved.
          </p>
        </Panel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Tenant & Store Operations Lens
// Read-only/mock-only tenant & store operational posture. Safe fake labels only.
// No live tenant/store data, no DB, no fetch, no mutation. The only interaction is
// read-only tab switching and read-only row selection (local UI state).
function TenantStoreOperationsLens({ module }: { module: BcpModule; env: EnvLabel }) {
  const [section, setSection] = React.useState('tenants');
  const [activeRow, setActiveRow] = React.useState(TENANT_STORE_READINESS[0].label);
  const selected: TenantStoreRow =
    TENANT_STORE_READINESS.find((r) => r.label === activeRow) || TENANT_STORE_READINESS[0];
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges
        extra={
          <>
            <DeferToneBadge tone="neutral">No Live Tenant Data</DeferToneBadge>
            <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No DB Access</DeferToneBadge>
          </>
        }
      />
      <SectionTabs
        tabs={[
          { key: 'tenants', label: 'Tenant Operations' },
          { key: 'stores', label: 'Store Operations' },
          { key: 'readiness', label: 'Readiness Table' },
          { key: 'safety', label: 'Cross-Tenant Safety' },
        ]}
        active={section}
        onSelect={setSection}
      />

      {section === 'tenants' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TENANT_OPS_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel
            title="Tenant Posture"
            subtitle="Isolation, plan, and permission posture (mock) — no create / edit / suspend controls"
            className="mt-5"
          >
            <PostureGrid cards={TENANT_OPS_POSTURE} />
          </Panel>
        </>
      )}

      {section === 'stores' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STORE_OPS_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel
            title="Store Posture"
            subtitle="Isolation, POS readiness, and permission posture (mock) — no create / edit / disable controls"
            className="mt-5"
          >
            <PostureGrid cards={STORE_OPS_POSTURE} />
          </Panel>
        </>
      )}

      {section === 'readiness' && (
        <>
          <Panel
            title="Tenant & Store Readiness"
            subtitle="Safe fake labels only — no real tenant/store/customer names, emails, domains, or IDs"
            className="mb-4"
          >
            <div className="mb-3 flex flex-wrap gap-2">
              {TENANT_STORE_READINESS.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => setActiveRow(r.label)}
                  aria-pressed={r.label === activeRow}
                  className={cx(
                    'rounded-lg border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    r.label === activeRow
                      ? 'border-slate-600 bg-slate-800 text-slate-100'
                      : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <DataTable
              minWidthClass="min-w-[820px]"
              columns={['Label', 'Kind', 'Region', 'Status', 'Operational', 'Plan', 'Permission', 'Review Reason']}
              rows={TENANT_STORE_READINESS.map((r) => [
                <span className="font-semibold text-slate-200">{r.label}</span>,
                r.kind,
                r.region,
                <DeferToneBadge tone={govTone(r.statusCategory)}>{r.statusCategory}</DeferToneBadge>,
                <DeferToneBadge tone={r.tone}>{r.operational}</DeferToneBadge>,
                r.plan,
                <DeferToneBadge tone="neutral">{r.permission}</DeferToneBadge>,
                <span className="text-slate-500">{r.reviewReason}</span>,
              ])}
            />
          </Panel>
          <Panel title="Detail Panel" subtitle="Read-only selection — no live drilldown, no tenant/store API, no DB query">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-100">{selected.label}</span>
                <DeferToneBadge tone="neutral">{selected.kind}</DeferToneBadge>
                <DeferToneBadge tone="neutral">{selected.region}</DeferToneBadge>
                <DeferToneBadge tone={govTone(selected.statusCategory)}>{selected.statusCategory}</DeferToneBadge>
                <DeferToneBadge tone={selected.tone}>{selected.operational}</DeferToneBadge>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-300 sm:grid-cols-2">
                <div><span className="text-slate-500">Plan posture: </span>{selected.plan}</div>
                <div><span className="text-slate-500">Permission posture: </span>{selected.permission}</div>
                <div className="sm:col-span-2"><span className="text-slate-500">Review reason: </span>{selected.reviewReason}</div>
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Observational only. No tenant/store create, edit, suspend, disable, or permission-assignment
                controls exist; no live tenant/store data is read.
              </p>
            </div>
          </Panel>
        </>
      )}

      {section === 'safety' && (
        <Panel
          title="Cross-Tenant Safety"
          subtitle="Tenant isolation blocked-state posture (mock) — observational only"
          right={<DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Isolation Enforced</DeferToneBadge>}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CROSS_TENANT_SAFETY.map((s) => (
              <div key={s} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
                <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                {s}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            The Backend Control Plane is internal DEV-only control-plane UI — not the SaaS Owner Platform. Tenant
            and store views are observational only: no cross-tenant access, no live data, no production action, and
            no DB read/write occur here. The M20 stream remains paused and is unrelated to this lens.
          </p>
        </Panel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Billing & Plan Operations Lens
// Read-only/mock-only billing, subscription, plan, and entitlement posture. Safe
// fake labels only. No live billing/payment provider, no DB, no fetch, no mutation.
// The only interaction is read-only tab switching and read-only row selection.
function BillingPlanOperationsLens({ module }: { module: BcpModule; env: EnvLabel }) {
  const [section, setSection] = React.useState('billing');
  const [activeRow, setActiveRow] = React.useState(ENTITLEMENT_POSTURE[0].label);
  const selected: EntitlementRow =
    ENTITLEMENT_POSTURE.find((r) => r.label === activeRow) || ENTITLEMENT_POSTURE[0];
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges
        extra={
          <>
            <DeferToneBadge tone="neutral">No Live Billing Data</DeferToneBadge>
            <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> No Payment Provider</DeferToneBadge>
          </>
        }
      />
      <SectionTabs
        tabs={[
          { key: 'billing', label: 'Billing Operations' },
          { key: 'plans', label: 'Plans & Subscriptions' },
          { key: 'entitlements', label: 'Entitlement Posture' },
          { key: 'safety', label: 'Billing & Plan Safety' },
        ]}
        active={section}
        onSelect={setSection}
      />

      {section === 'billing' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {BILLING_OPS_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel
            title="Billing Posture"
            subtitle="Observational only (mock) — no charge / refund / invoice / subscription-change controls"
            className="mt-5"
          >
            <PostureGrid cards={BILLING_OPS_POSTURE} />
          </Panel>
        </>
      )}

      {section === 'plans' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PLAN_SUBSCRIPTION_SUMMARY.map((k) => (
              <div key={k.label}>
                <KpiCardView {...k} />
              </div>
            ))}
          </div>
          <Panel
            title="Plan & Subscription Posture"
            subtitle="Plan / subscription / plan-to-permission posture (mock) — no plan-change controls"
            className="mt-5"
          >
            <PostureGrid cards={PLAN_POSTURE} />
          </Panel>
        </>
      )}

      {section === 'entitlements' && (
        <>
          <Panel
            title="Entitlement / Feature Posture"
            subtitle="Safe fake labels only — no raw permission/entitlement keys, no real billing data"
            className="mb-4"
          >
            <div className="mb-3 flex flex-wrap gap-2">
              {ENTITLEMENT_POSTURE.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => setActiveRow(r.label)}
                  aria-pressed={r.label === activeRow}
                  className={cx(
                    'rounded-lg border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    r.label === activeRow
                      ? 'border-slate-600 bg-slate-800 text-slate-100'
                      : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <DataTable
              minWidthClass="min-w-[720px]"
              columns={['Label', 'Kind', 'Status', 'Gating', 'Review Reason']}
              rows={ENTITLEMENT_POSTURE.map((r) => [
                <span className="font-semibold text-slate-200">{r.label}</span>,
                r.kind,
                <DeferToneBadge tone={govTone(r.statusCategory)}>{r.statusCategory}</DeferToneBadge>,
                <DeferToneBadge tone={r.tone}>{r.gating}</DeferToneBadge>,
                <span className="text-slate-500">{r.reviewReason}</span>,
              ])}
            />
          </Panel>
          <Panel title="Detail Panel" subtitle="Read-only selection — no live drilldown, no billing API, no DB query">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-100">{selected.label}</span>
                <DeferToneBadge tone="neutral">{selected.kind}</DeferToneBadge>
                <DeferToneBadge tone={govTone(selected.statusCategory)}>{selected.statusCategory}</DeferToneBadge>
                <DeferToneBadge tone={selected.tone}>{selected.gating}</DeferToneBadge>
              </div>
              <div className="mt-3 text-sm text-slate-300">
                <span className="text-slate-500">Review reason: </span>{selected.reviewReason}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Observational only. No billing, invoice, refund, subscription, plan, permission, or entitlement
                mutation controls exist; no live billing data is read and no payment provider is contacted.
              </p>
            </div>
          </Panel>
        </>
      )}

      {section === 'safety' && (
        <Panel
          title="Billing & Plan Safety"
          subtitle="Production billing / live payment blocked-state posture (mock) — observational only"
          right={<DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Billing Locked</DeferToneBadge>}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {BILLING_PLAN_SAFETY.map((s) => (
              <div key={s} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
                <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                {s}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            The Backend Control Plane is internal DEV-only control-plane UI — not the SaaS Owner Platform. Billing
            and plan views are observational only: no payment/billing provider calls, no invoice/refund/charge, no
            plan/subscription/permission mutation, and no live tenant billing data occur here. The M20 stream
            remains paused and is unrelated to this lens.
          </p>
        </Panel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Backend CP Readiness Gate (closeout)
// Read-only/mock-only foundation closeout. Classifies DEV-review / live / backend /
// production readiness and the path to production. No live data, no DB, no mutation.
// Only interaction is read-only tab switching (local UI state).
function ReadinessCardView({ card }: { card: ReadinessGateCard }) {
  const accent =
    card.tone === 'healthy' ? 'from-emerald-400/70'
    : card.tone === 'warning' ? 'from-amber-400/70'
    : card.tone === 'blocked' ? 'from-rose-400/70'
    : 'from-slate-400/60';
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/70 to-slate-900/40 p-4 ring-1 ring-white/5 transition hover:border-slate-700 hover:ring-white/10">
      <span className={cx('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r to-transparent', accent)} aria-hidden="true" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{card.stage}</span>
        <DeferToneBadge tone={card.tone}>{card.verdict}</DeferToneBadge>
      </div>
      <p className="mt-2 text-xs text-slate-400">{card.detail}</p>
    </div>
  );
}

function BackendCpReadinessGate({ module }: { module: BcpModule; env: EnvLabel }) {
  const [section, setSection] = React.useState('readiness');
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">Foundation Closeout</DeferToneBadge>} />
      <SectionTabs
        tabs={[
          { key: 'readiness', label: 'Readiness' },
          { key: 'c01', label: 'C-01 Live Preview' },
          { key: 'c02', label: 'C-02 Registry' },
          { key: 'c03', label: 'C-03 UI Coverage' },
          { key: 'c04', label: 'C-04 Route Exposure' },
          { key: 'c05', label: 'C-05 Feature Flags' },
          { key: 'coverage', label: 'Module Coverage' },
          { key: 'path', label: 'Production Path' },
          { key: 'blockers', label: 'Blockers & Final Gate' },
        ]}
        active={section}
        onSelect={setSection}
      />

      {section === 'readiness' && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {READINESS_GATE_CARDS.map((c) => (
              <div key={c.stage}>
                <ReadinessCardView card={c} />
              </div>
            ))}
          </div>
          <Panel title="DEV Review Readiness" subtitle="Foundation posture for read-only/mock-only DEV review (mock)" className="mt-5">
            <PostureGrid cards={DEV_REVIEW_POSTURE} />
          </Panel>
        </>
      )}

      {section === 'c01' && (
        <div className="mt-1">
          <C01ReadinessCard />
        </div>
      )}

      {section === 'c02' && (
        <div className="mt-1">
          <C02RegistryReadinessCard />
        </div>
      )}

      {section === 'c03' && (
        <div className="mt-1">
          <C03UiCoverageReadinessCard />
        </div>
      )}

      {section === 'c04' && (
        <div className="mt-1">
          <C04RouteExposureReadinessCard />
        </div>
      )}

      {section === 'c05' && (
        <div className="mt-1">
          <C05FeatureFlagPostureReadinessCard />
        </div>
      )}

      {section === 'coverage' && (
        <Panel
          title="Module Coverage Matrix"
          subtitle="DEV-review vs live-readiness vs production-readiness per Backend Control Panel area (mock)"
        >
          <DataTable
            minWidthClass="min-w-[860px]"
            columns={['Module', 'Area', 'DEV Review', 'Live Readiness', 'Production', 'Safety Notes']}
            rows={COVERAGE_MATRIX.map((r) => [
              <span className="font-semibold text-slate-200">{r.module}</span>,
              r.area,
              <DeferToneBadge tone="healthy">{r.devReview}</DeferToneBadge>,
              <DeferToneBadge tone="warning">{r.liveReadiness}</DeferToneBadge>,
              <DeferToneBadge tone="blocked">{r.prodReadiness}</DeferToneBadge>,
              <span className="text-slate-500">{r.note}</span>,
            ])}
          />
        </Panel>
      )}

      {section === 'path' && (
        <div className="space-y-4">
          {PRODUCTION_PATH.map((p) => (
            <div key={p.phase}>
              <Panel
                title={`${p.phase} — ${p.title}`}
                subtitle={p.goal}
                right={<DeferToneBadge tone={p.tone}>Not Ready</DeferToneBadge>}
              >
                <ul className="space-y-1.5">
                  {p.items.map((it) => (
                    <li key={it} className="flex items-center gap-2 text-sm text-slate-300">
                      <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                      {it}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          ))}
        </div>
      )}

      {section === 'blockers' && (
        <>
          <Panel title="Blockers Before Production" subtitle="Required before controlled backend actions and production release (mock)" className="mb-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {PRODUCTION_BLOCKERS.map((b) => (
                <div key={b} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">
                  <LockIcon className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                  {b}
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Final Safety Gate" subtitle="Foundation closeout classification (mock)" right={<DeferToneBadge tone="warning">Foundation Only</DeferToneBadge>}>
            <div className="flex flex-wrap gap-2">
              {FINAL_SAFETY_GATE.map((s) => (
                <span key={s}>
                  <DeferToneBadge tone={/:\s*yes$/i.test(s) ? 'healthy' : 'blocked'}>{s}</DeferToneBadge>
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              The Backend Control Panel foundation is ready for DEV review only. Live read-only data, controlled
              backend actions, and production release each remain NOT READY and require Phase 2, Phase 3, and Phase 4
              respectively. The M20 identity-link / DEV test-data registry stream remains paused and unrelated to
              this closeout.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Router
const INCLUDED: Record<string, (p: { module: BcpModule; env: EnvLabel }) => React.ReactNode> = {
  'access-gate': AccessGateInfo,
  'command-center': CommandCenter,
  tenants: Tenants,
  stores: Stores,
  'database-registry': DatabaseRegistry,
  services: Services,
  'identity-access': IdentityAccess,
  'identity-links': IdentityLinks,
  'audit-approvals': AuditApprovals,
  'policies-guardrails': PoliciesGuardrails,
  'system-operations-overview': SystemOperationsOverview,
  'data-governance-overview': DataGovernanceOverview,
  'identity-readiness-overview': IdentityReadinessOverview,
  'audit-governance-overview': AuditGovernanceOverview,
  'support-diagnostics-overview': SupportDiagnosticsOverview,
  'risk-alerts-lens': RiskAlertsLens,
  'timeline-evidence-lens': TimelineEvidenceLens,
  'tenant-store-operations-lens': TenantStoreOperationsLens,
  'billing-plan-operations-lens': BillingPlanOperationsLens,
  'readiness-gate': BackendCpReadinessGate,
};

export function ScreenRouter({ module, env }: { module: BcpModule; env: EnvLabel }) {
  const Comp = INCLUDED[module.id];
  if (Comp) return <Comp module={module} env={env} />;
  return <Placeholder module={module} env={env} />;
}
