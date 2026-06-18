// Phase 1.6 M5 — Dormant, DEV-flag-gated, app-level Supabase Auth FOUNDATION.
//
// WHAT THIS IS: a clean, app-level Supabase BROWSER-auth foundation that adapts the
// proven `src/pilot/**` patterns (anon-key-only client, VITE_-only env boundary,
// default-OFF flag gating, no-throw disabled state) into a real app module — WITHOUT
// importing, promoting, or modifying the pilot.
//
// WHAT THIS IS NOT (binding for M5): it changes NO current behavior. Firebase remains
// the sole active/default production session authority. This module is DORMANT:
//   - It is imported by NOTHING in the active app — not Login, AccessContext,
//     AccessGuard, App routing, or src/main.tsx — so the bundler tree-shakes it out
//     of the production bundle entirely. (Proven by the M5 dormancy diagnostic and
//     the M4 inventory diagnostic's compensating assertions.)
//   - It has NO import-time side effects and builds NO Supabase client at import.
//     The client is constructed ONLY when `getSupabaseAuthFoundation()` is explicitly
//     called — and NO call site is added in M5.
//
// SECURITY (binding):
//   - Reads ONLY public, client-safe `VITE_`-prefixed values:
//       VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ENABLE_SUPABASE_AUTH_FOUNDATION.
//   - NEVER reads a service-role key, a database URL / connection string, a raw JWT
//     secret, or any server-only Supabase env name (those are non-`VITE_`, so Vite
//     would never expose them to the browser bundle anyway).
//   - NEVER connects to the database and NEVER authorizes anything itself. Identity
//     is server-verified; authorization is SERVER-DERIVED (deferred to later stages).
//   - Does NOT call the backend session-resolve route, any protected business API,
//     any backend control API, or any database-control API.
//
// FLAG (binding): VITE_ENABLE_SUPABASE_AUTH_FOUNDATION is DEV-only and default OFF. It
// is intentionally SEPARATE from the dev pilot's enable flag (the pilot route) and from
// the future Stage-5 server-authz shadow flag. Even when the foundation flag is 'true',
// M5 wires this module to nothing — the flag only gates FUTURE activation (Stage 3:
// dual-provider bootstrap). The exact pilot/shadow flag names are intentionally NOT
// repeated here so the M4 frontend diagnostics' "dormant flag" invariants stay precise.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  SupabaseAuthFoundationHandle,
  SupabaseAuthFoundationState,
} from './supabaseAuthFoundationTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast
// so the foundation adds NO `Property 'env' does not exist on type 'ImportMeta'`
// error and does not alter the global type baseline (mirrors the pilot's pattern).
// -----------------------------------------------------------------------------

interface FoundationPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** Supabase project URL — client-safe public value. */
  VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key — client-safe by design (RLS is the real guard). */
  VITE_SUPABASE_ANON_KEY?: string;
  /** DEV-only foundation opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SUPABASE_AUTH_FOUNDATION?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): FoundationPublicEnv {
  return (import.meta as unknown as { env?: FoundationPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted the foundation in. */
export function isFoundationFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SUPABASE_AUTH_FOUNDATION === 'true';
}

/**
 * The foundation is ENABLED only when BOTH hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit opt-in flag is 'true'.
 * Default behaviour is OFF.
 */
export function isSupabaseAuthFoundationEnabled(): boolean {
  return isDevBuild() && isFoundationFlagOn();
}

// -----------------------------------------------------------------------------
// Dormancy / readiness state (no-throw). Computing this NEVER builds a client and
// NEVER touches the network — it only reports why the foundation is on/off/ready.
// -----------------------------------------------------------------------------

/**
 * Describe the foundation's current dormancy/readiness without constructing
 * anything. Returns a render-safe, non-secret state in every branch (no throw).
 */
export function getSupabaseAuthFoundationState(): SupabaseAuthFoundationState {
  const env = readEnv();

  if (env.DEV !== true) {
    return {
      enabled: false,
      configured: false,
      status: 'dormant_not_dev',
      message:
        'Supabase auth foundation is dormant: not a DEV build (production stays Firebase-only).',
    };
  }

  if (env.VITE_ENABLE_SUPABASE_AUTH_FOUNDATION !== 'true') {
    return {
      enabled: false,
      configured: Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY),
      status: 'dormant_flag_off',
      message:
        'Supabase auth foundation is dormant: VITE_ENABLE_SUPABASE_AUTH_FOUNDATION is not "true".',
    };
  }

  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    return {
      enabled: true,
      configured: false,
      status: 'unconfigured_env',
      message:
        'Supabase auth foundation is enabled but not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public, client-safe).',
    };
  }

  return {
    enabled: true,
    configured: true,
    status: 'ready',
    message: 'Supabase auth foundation is ready (client built on demand only).',
  };
}

// -----------------------------------------------------------------------------
// Lazy factory. The Supabase browser client is constructed ONLY here, ONLY when
// this function is explicitly called, and ONLY when state is 'ready'. It is cached
// after first construction. In M5 NOTHING calls this — the foundation stays dormant.
// -----------------------------------------------------------------------------

/** Memoized client. Initialized to null — NO client is built at import time. */
let memoizedClient: SupabaseClient | null = null;

/**
 * Explicitly obtain the dormant foundation's state and (only when 'ready') a Supabase
 * browser client built from the PUBLIC anon key + URL. No-throw: when not ready, the
 * returned `client` is null and `state` explains why.
 *
 * The client uses standard Supabase browser-session behaviour; this module NEVER
 * reads, logs, renders, persists (beyond the SDK's own storage), or otherwise
 * surfaces the access token. It does NOT call the backend session-resolve route —
 * feeding the token to the backend is a later, separately-approved stage.
 */
export function getSupabaseAuthFoundation(): SupabaseAuthFoundationHandle {
  const state = getSupabaseAuthFoundationState();
  if (state.status !== 'ready') {
    return { state, client: null };
  }

  if (!memoizedClient) {
    const env = readEnv();
    memoizedClient = createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Email/password foundation (no OAuth redirect), so do not parse tokens
        // out of the URL.
        detectSessionInUrl: false,
      },
    });
  }

  return { state, client: memoizedClient };
}
