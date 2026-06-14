// Phase 1.5 M4 — Supabase Auth Frontend Login Pilot.
//
// Isolated Supabase BROWSER client for the pilot ONLY.
//
// SECURITY (binding):
//   - Builds the client from ONLY the public anon key + project URL
//     (see ./pilotEnv). NEVER reads a service-role key, DB URL, or JWT secret.
//   - If either public value is missing, this module does NOT throw: it exposes
//     a disabled state with a safe, non-secret message so the pilot screen can
//     render a "not configured" panel instead of crashing.
//
// ISOLATION: imported only by the pilot under `src/pilot/**`. It does NOT import
// Firebase, AccessContext, or any app/business module, and nothing in the normal
// app imports it.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './pilotEnv';

export interface SupabasePilotClient {
  /** The live client, or null when public config is missing. */
  client: SupabaseClient | null;
  /** True only when both public env vars are present. */
  configured: boolean;
  /** Safe, non-secret status message for the UI. */
  message: string;
}

function build(): SupabasePilotClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      client: null,
      configured: false,
      message:
        'Supabase pilot is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public, client-safe) to enable sign-in.',
    };
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Standard Supabase browser-session behaviour for a dev pilot. We never
      // read, log, render, or otherwise surface the persisted access token.
      persistSession: true,
      autoRefreshToken: true,
      // Pilot is not an OAuth-redirect flow (email/password only in M4), so we
      // do not parse tokens out of the URL.
      detectSessionInUrl: false,
    },
  });

  return { client, configured: true, message: 'Supabase pilot client configured.' };
}

export const supabasePilot: SupabasePilotClient = build();
