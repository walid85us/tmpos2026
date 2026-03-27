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
- `src/components/POS.tsx` - Full POS with cart, payments, modals, repair intake, held orders
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
- **ProvisioningPage**: 3-step flow; plan selection uses dropdown (no card grid conflict with presets); when preset selected, plan shown as read-only auto-selected card; onboarding presets show full pre-configured settings, preset details on confirm screen, "Next Steps" on success, 8-item checklist
- **TenantDetailPage**: 9 fully-built tabs:
  - Overview: summary cards (plan, MRR, renewal, onboarded, seats, locations, domain, SSL/DNS), flags, quick actions
  - Owner & Users: tenant-scoped users, invite user modal, violet "Create Store Owner" button + platform-only modal; `localCreatedOwners` state merges with DB users via `allScopedUsers` memo so newly created owners appear instantly
  - Subscription: `currentPlan` local state that updates on plan change confirmation, limits adjust to new plan
  - Features: `localOverrides` state with Trial (modal + duration picker), Paid Override (modal with pricing model monthly/annual/one-time, price input, internal notes), End Trial/Revoke/Remove buttons; `paid_override` objects carry `price`, `pricingModel`, `pricingNotes`
  - Billing: invoices clickable → invoice detail modal (line items, subtotal/tax/total, PDF/Reminder actions); credits/refunds clickable → credit detail modal (amount/applied/remaining, reason, Apply Credit/Void/Download PDF actions)
  - Domains: primary domain info banner, 5-step setup progress stepper (Domain Added → DNS Records → Verified → SSL Issued → Live), DNS instructions text, local state with working Add/Remove/Verify/Check DNS/Provision SSL
  - Usage: seats, locations, API, storage, SMS, tickets/invoices with progress bars and trend arrows
  - Activity/Audit: audit entries are clickable, opening audit log detail modal with all fields (action, target, actor, date, category, severity, tenant)
  - Support Notes: existing notes, flags, add note with local state persistence
- **Toast system**: Centralized `showToast()` with useRef cleanup on unmount (no stale setTimeout leaks)
- **Mock data**: `accessMockData.ts` tenantUsers with `tenantId`, `billingTransactions` with `tenantId`, `tenantFeatureOverrides`, `provisioningTemplates` with settings/features
- **Accessibility**: label/id pairs on form inputs, keyboard-navigable table rows, modal dialog semantics

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
