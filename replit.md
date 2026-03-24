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
- `firebase-applet-config.json` - Firebase project config (projectId, apiKey, etc.)
- `firebase-blueprint.json` - Firestore data model schema
- `firestore.rules` - Firestore security rules
- `vite.config.ts` - Vite build configuration

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

## Deployment

- Target: Static site
- Build command: `npm run build`
- Public directory: `dist`
