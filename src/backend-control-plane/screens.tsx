// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Screen components. Every screen is presentational and renders ONLY local static
// mock data. No fetching, no mutation, no backend calls. All action affordances are
// disabled / visual-only.

import React from 'react';
import type { BcpModule, EnvLabel } from './types';
import {
  ActionChipView,
  CheckIcon,
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
  APPROVALS,
  AUDIT_EVENTS,
  AUDIT_READINESS,
  DATABASES,
  DATA_GOVERNANCE,
  DIAGNOSTICS,
  IDENTITY_LINK_FACTS,
  IDENTITY_LINK_TIMELINE,
  IDENTITY_READINESS,
  KPIS,
  OPS_METRICS,
  PERMISSION_MATRIX,
  POLICIES,
  ROLES,
  SCOPE_AXES,
  SERVICES,
  STORES,
  SYSTEM_POSTURE,
  TENANTS,
} from './mockData';
import type { PostureCard } from './types';

function ScreenHeading({ module }: { module: BcpModule }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-100">{module.name}</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">{module.purpose}</p>
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
        <div key={c.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
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

// --------------------------------------------------------------------------- System Operations Overview
function SystemOperationsOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges />
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
    </div>
  );
}

// --------------------------------------------------------------------------- Data Governance Overview
function DataGovernanceOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">No Live DB Calls</DeferToneBadge>} />
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
    </div>
  );
}

// --------------------------------------------------------------------------- Identity Readiness Overview
function IdentityReadinessOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="warning">M20 Stream Paused</DeferToneBadge>} />
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
    </div>
  );
}

// --------------------------------------------------------------------------- Audit Governance Overview
function AuditGovernanceOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">Append-Only Concept</DeferToneBadge>} />
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
    </div>
  );
}

// --------------------------------------------------------------------------- Support & Diagnostics Overview
function SupportDiagnosticsOverview({ module }: { module: BcpModule; env: EnvLabel }) {
  return (
    <div>
      <ScreenHeading module={module} />
      <ReadOnlyBadges extra={<DeferToneBadge tone="neutral">No Live Invocation</DeferToneBadge>} />
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
};

export function ScreenRouter({ module, env }: { module: BcpModule; env: EnvLabel }) {
  const Comp = INCLUDED[module.id];
  if (Comp) return <Comp module={module} env={env} />;
  return <Placeholder module={module} env={env} />;
}
