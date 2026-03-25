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
- `src/context/accessConfig.ts` - Platform/tenant roles, plan features, permissions
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
- **Preview mode**: DevSessionSwitcher enables role/tenant switching for development

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
