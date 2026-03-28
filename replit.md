# Project Overview

A multi-tenant SaaS platform frontend built with React, TypeScript, Vite, Tailwind CSS, and Firebase (Auth + Firestore). Originally generated from Google AI Studio.

## Architecture

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS v4
- **Backend/DB**: Firebase Firestore (via `firebase-applet-config.json`)
- **Auth**: Firebase Authentication
- **AI**: Gemini API (`@google/genai`)
- **Charts**: Recharts
- **Routing**: React Router v7
- **Animations**: Motion (Framer Motion)

## Key Files

- `src/App.tsx` - Main app component and routing
- `src/firebase.ts` - Firebase initialization
- `src/types.ts` - TypeScript type definitions
- `src/context/AccessContext.tsx` - Auth session, tenant resolution, role management, preview mode
- `src/context/accessConfig.ts` - Platform/tenant roles, plan features, permissions, adminPermissions
- `src/components/TenantHeader.tsx` - Top header with notification bell, check-in, avatar, quick menu
- `src/components/Employees.tsx` - Employee management with roles, time tracking, payroll, activity
- `src/components/PendingApproval.tsx` - Approval workflow with labeled field detail view
- `src/components/ApprovalQueue.tsx` - Dashboard approval widget with inline review modal for approvers
- `src/components/POS.tsx` - Full POS with cart, payments, modals, repair intake, held orders, tax calculation (8.25%), discount application, qty support, inline new customer creation, walk-in customer, controlled payment inputs, change due display
- `src/components/Customers.tsx` - CRM with customer list, profiles, new customer modal
- `src/components/Reports.tsx` - Reports dashboard with charts (recharts)
- `src/components/Prospects.tsx` - Estimates, leads, inquiries pipeline
- `src/components/Marketing.tsx` - Loyalty program, campaigns, marketing tools
- `src/components/Integrations.tsx` - Third-party integrations (payments, phone, vendors)
- `src/components/Widgets.tsx` - Embeddable customer-facing widgets configuration
- `src/owner/TeamManagementPage.tsx` - Platform team/role management
- `firebase-applet-config.json` - Firebase project config (projectId, apiKey, etc.)
- `firebase-blueprint.json` - Firestore data model schema
- `firestore.rules` - Firestore security rules
- `vite.config.ts` - Vite build configuration (CRITICAL: watch.ignored config prevents reload loop)

## Design System

- Rounded cards: `rounded-[2.5rem]` / `rounded-[3rem]`
- Glass effect: `bg-white/80 backdrop-blur-xl`
- Primary color theme with `ghost-border` utility
- Typography: `font-black uppercase tracking-widest` for labels
- Animations: `motion/react` (AnimatePresence, motion.div)
- Toast notifications instead of `alert()` calls

## Auth & Access Control

- **Platform roles**: system_owner, support_admin, billing_admin, operations_admin, security_admin (tenant: null)
- **Tenant roles**: store_owner, manager, technician, sales_staff
- **Manager privacy**: Managers cannot see Store Owner pay/commission data on employee cards or payroll
- **Store Owner role**: System-protected, cannot be edited or deleted
- **Attendance lifecycle**: Full Check In → Start Break → Back from Break → Clock Out workflow
- **Time tracking**: Owner/manager get employee selector picker for all attendance actions; other roles self-clock only
- **Manager restrictions**: Cannot manage Store Owner attendance, cannot edit Store Owner role/status
- **Store Permissions Matrix**: Module access (sales, repairs, inventory, customers, employees, invoices, services, reports, prospects, marketing, integrations, widgets, settings, support) + Admin permissions (manage_employees, create_roles, edit_roles, manage_role_permissions, assign_roles, assign_same_role, assign_manager_role, manage_attendance, manage_compensation, approve_requests)
- **Manager delegation**: Manager cannot assign Manager role by default; requires explicit `assign_manager_role` permission from Store Owner
- **Admin permissions**: Not plan-gated; enforced by role only (via adminPermissions array in accessConfig)
- **UI enforcement**: Add Employee (manage_employees), Create Role (create_roles), Manage Permissions (manage_role_permissions), role dropdown (assign_manager_role), PendingApproval (approve_requests)
- **Preview mode**: DevSessionSwitcher enables role/tenant switching for development

## Tenant Management & Provisioning (Workstream 2)

- **TenantsPage**: 6-card summary row (Active, Trialing, Overdue, Suspended, Total MRR, Avg Health), richer health indicator with bar+label+color, subdomain+billingCycle shown in table rows, renewal countdown in days, seats progress bar
- **ProvisioningPage**: 3-step flow; plan selection uses dropdown (no card grid conflict with presets); when preset selected, plan shown as read-only auto-selected card; onboarding presets show full pre-configured settings, preset details on confirm screen, 8-item checklist; **success step** shows Activation Lifecycle stepper (invited → pending → setup → active), invitation confirmation + "Awaiting activation" status
- **TenantDetailPage**: 9 fully-built tabs:
  - Overview: summary cards (plan, MRR, renewal, onboarded, seats, locations, domain, SSL/DNS), **Activation Lifecycle** stepper (invited → pending_activation → account_setup → active) with invite/activated dates, flags, quick actions
  - Owner & Users: **Separated sections** — Store Owners (violet-themed cards with shield icons, platform-controlled identity banner) and Team Members. Owner profile modal with Edit/Deactivate/Reactivate/Delete actions; deactivate/delete use confirmation modals. `localOwnerStatuses` tracks status changes; `localCreatedOwners` carry `status` field. `storeOwners`/`teamMembers` derived via useMemo from `allScopedUsers`
  - Subscription: `currentPlan` local state that updates on plan change confirmation, limits adjust to new plan
  - Features: `localOverrides` state with Trial (modal + duration picker), Paid Override (starts as `pending_payment` → Approve transitions to `paid_override`). `pending_payment` features show amber styling + hourglass icon + Approve/Cancel buttons. Revoke on paid overrides opens refund eligibility modal (7-day refund window based on `addedDate`); `getRefundEligibility()` helper. Revoke + Refund or Revoke Only options
  - Billing: invoices via `effectiveInvoices` (local status overrides); credits via `effectiveCredits`. Credit status lifecycle: `issued` → `applied` or `voided` (never `pending`). Unapplied credits computed from `issued` status. Credit list shows inline Apply/Void buttons for `issued` credits. Apply Credit finds first unpaid invoice, marks credit `applied` + invoice `paid`. Void opens confirmation modal (`voidConfirmId`); confirmed voids mark credit `voided`. Credit detail modal also has working Apply/Void buttons
  - Domains: primary domain info banner, 5-step setup progress stepper, **DNS records table** with Type/Name/Value/TTL/Status/Copy columns, local state with working Add/Remove/Verify/Check DNS/Provision SSL
  - Usage: seats, locations, API, storage, SMS, tickets/invoices with progress bars and trend arrows
  - Activity/Audit: audit entries are clickable, opening audit log detail modal with all fields (action, target, actor, date, category, severity, tenant)
  - Support Notes: existing notes, flags, add note with local state persistence
- **Toast system**: Centralized `showToast()` with useRef cleanup on unmount (no stale setTimeout leaks)
- **Mock data**: `accessMockData.ts` tenantUsers with `tenantId`, `billingTransactions` with `tenantId`, `tenantFeatureOverrides`, `provisioningTemplates` with settings/features
- **Types**: `FeatureOverrideType` includes `pending_payment`; `ActivationStatus = 'invited' | 'pending_activation' | 'account_setup' | 'active'`; all 5 tenants carry `activationStatus`, `inviteSentDate`, `accountSetupDate`, `activatedDate` fields
- **Accessibility**: label/id pairs on form inputs, keyboard-navigable table rows, modal dialog semantics
- **Governance**: `canDeleteOwner`/`canDeactivateOwner`/`isPrimaryOwner` helpers; blocks deletion of last/primary owner with explanation UI; Reassignment modal for primary owner transfers
- **Credit rules**: Credits apply ONLY to invoices with status `overdue` or `pending`; `eligibleInvoicesForCredit` memo enforces this everywhere
- **Refund detail**: `currency_exchange` icon for refund items; refund section in Credit Detail modal (ref, source invoice, amount, date)
- **Domain workflow**: `domainPropagation` state (`unknown|checking|propagated|not_propagated`); 6-step stepper with `failed` states; separate Check Propagation → Verify DNS → Provision SSL controls
- **Lifecycle access gating**: `canAccess()` gates operational modules (sales, repairs, inventory, employees, etc.) during onboarding. Only `dashboard`, `settings`, `support` are accessible before activation. `ONBOARDING_ALLOWED_MODULES` constant is exported from AccessContext and shared with TenantLayout. `isStoreActivated()` checks onboardingStage==='active' + tenant status. Plan filtering is applied only after activation. TenantLayout shows locked items with lock icons under "After Activation" divider (plan-filtered). Route redirect to `/` via useEffect for direct navigation to gated routes. Employees sidebar is locked pre-activation even when plan includes it; unlocks only after activation + plan entitlement.
- **Store-side activation/onboarding**: `StoreActivationPanel` is a comprehensive lifecycle/domain/onboarding surface:
  - **Lifecycle stepper**: invited → pending_setup → setup_incomplete → pending_activation → active with dates
  - **Onboarding checklist**: Plan-entitlement-driven items (storeSetupComplete always; teamInvited only when employees entitled). "Invite team members" is system-driven (no manual Mark Done) — auto-completes via inline Add Employee modal on dashboard or from Employees page post-activation. Progress bar and action links; auto-hides when complete + active
  - **Domain readiness card**: shows domain mode (platform_subdomain/custom_pending/custom_dns_pending/custom_ssl_pending/custom_active), subdomain/custom domain URLs, DNS/SSL/propagation status chips, action prompts (View DNS Records, Check Status, Connect Custom Domain)
  - **Status-aware banners**: suspended (red), read_only (violet), overdue (amber with Update Payment), invited (indigo with Begin Store Setup), pending_setup/setup_incomplete (amber/blue with Continue Setup), pending_activation (violet with info), active/trialing (lime with plan badge + activation date)
  - **Fallback defaults**: derive from `onboardingStage` — active stores default checklist to complete, non-active default to incomplete
- **Tenant interface**: Extended with `onboardingStage`, `onboardingChecklist`, `domainInfo` (TenantDomainInfo), `inviteSentDate`, `setupStartedDate`, `activatedDate`, `trialEndsDate`
- **DevSessionSwitcher**: 11 test scenarios (active, trial, invited, setup_incomplete, domain_pending, pending_activation, suspended, overdue, pending_setup, custom_pending/domain_registering, ssl_pending) with "Test Scenarios" toggle button
- **Activation lifecycle (T006)**: Resend Invite button on Overview for non-active tenants; accountSetupDate display; awaiting-status messaging; active confirmation banner

## Data Model

- **PlatformUser** - Users (system_owner, support_admin, tenant_user roles)
- **Tenant** - Tenant/store entities (starter/growth/advanced plans)
- **TenantMembership** - Links users to tenants with roles
- **Invitation** - Tenant invitations
- **AuditEvent** - Audit log

## Environment Variables

- `GEMINI_API_KEY` - Required for AI features (set in `.env.local`)

## Development

- Run: `npm run dev` (port 5000)
- Build: `npm run build`
- CRITICAL: `vite.config.ts` must keep `server.watch.ignored` to prevent Replit log writes from causing page reloads

## Deployment

- Target: Static site
- Build command: `npm run build`
- Public directory: `dist`

## QA Audit Summary (Completed)

### Fixed Issues
- **Dead Routes**: 20+ PageShell placeholder routes converted to Navigate redirects (App.tsx)
- **POS Dead Buttons**: Apply Discount, Redeem Points, Add Payment Method, Verify Credit, Suggestive Sales, POS Config — all wired with modals/state
- **POS Math Coherence**: Tax (8.25%) computed on subtotal after discounts, qty multiplied into line totals, controlled payment inputs, change due display, discount buttons apply actual discounts, hold/resume preserves full state (payments, discounts, customer), success screen shows actual total + TX ID
- **Dashboard Role-Awareness**: Quick actions filtered by role (technician=repairs bias, sales_staff=POS bias, manager=broad, owner=full), stat cards filtered by role, dynamic date, Add Stock/New Customer open inline modals instead of navigating, Print Label has type selector (barcode/price/asset) + print feedback
- **TenantHeader**: Profile menu, notification click handlers, mark-all-read — all wired
- **Dashboard Cards**: Stat cards made clickable, navigate to relevant pages
- **Store Components** (12 components fixed): Marketing (campaign+tool modals), SupplyChain (PO+RMA modals), Reports (PDF export via window.print), Prospects (dynamic create modal), Integrations (detail modal for all buttons), Widgets (save+add handlers), Inventory (all tab action buttons), Invoices (print/PDF/SMS/email/duplicate/apply payment), Services (CRUD+category+upload), Settings (save with feedback, Domain & Storefront URL section with platform subdomain + custom domain 4-step setup guide)
- **Owner Pages** (8 pages fixed): TenantsPage (navigate provisioning/detail), TenantDetailPage (tab management), ProvisioningPage (animated feedback), PlansPage (create/edit/archive), DomainsPage/SubscriptionsPage/AddOnsPage/SupportToolsPage/PlatformSettingsPage (manage/save buttons)

### RBAC Validation
- Route-level: AccessGuard wraps all routes with allowedUserTypes + feature checks
- Nav filtering: TenantLayout filters by canAccess(item.id), OwnerLayout filters by canAccess(item.feature)
- canAccess() layers: system_owner bypass → platform role permissions → plan-gating → tenant role permissions
- Admin permissions bypass plan-gating correctly
- Employee component enforces granular permissions (manage_employees, create_roles, edit_roles, manage_role_permissions, assign_roles, assign_manager_role, manage_attendance, manage_compensation, approve_requests)

### Patterns Established
- Save feedback: button text swap + bg-emerald-500 class for 2s (no toast library)
- Modal pattern: AnimatePresence + fixed overlay + backdrop-blur-md + motion.div scale/y + rounded-[3rem]
- Integration buttons: setSelectedIntegration(name) → detail modal with dismiss
