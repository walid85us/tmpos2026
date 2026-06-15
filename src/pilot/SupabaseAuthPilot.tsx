// Phase 1.5 M4 — Supabase Auth Frontend Login Pilot (dev-only, isolated screen).
//
// PURPOSE: prove Supabase email/password sign-in / sign-out / safe session
// visibility in the browser, and optionally round-trip the access token to the
// EXISTING M3 backend whoami diagnostic. This is an IDENTITY proof, NOT an
// authorization mechanism.
//
// HARD ISOLATION (binding):
//   - Does NOT import Firebase, AccessContext, AccessGuard, or any business module.
//   - Does NOT create Firestore user docs and does NOT navigate into the app.
//   - Never renders, logs, persists, or files the raw access token or full JWT
//     payload. The session panel shows a token-PRESENT boolean + expiry only.
//   - Never treats the Supabase user/session as app authorization.

import React, { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabasePilot } from './supabaseClient';
import { runWhoamiDiagnostic, type WhoamiResult } from './identityDiagnosticClient';
import { runSessionResolve, type SessionResolveResult } from './sessionResolvePilotClient';

const PILOT_LABEL = 'Diagnostic pilot only — proves Supabase identity, not app authorization.';

/** Partially redact an opaque id for display (never the access token). */
function redactId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function readDisplayName(session: Session): string | null {
  const meta = session.user?.user_metadata as Record<string, unknown> | undefined;
  if (meta) {
    for (const k of ['full_name', 'name', 'display_name']) {
      const v = meta[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

function formatExpiry(session: Session): string {
  // Supabase `expires_at` is a unix timestamp in SECONDS.
  if (typeof session.expires_at === 'number') {
    return new Date(session.expires_at * 1000).toISOString();
  }
  return 'unknown';
}

const Banner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-bold text-amber-800">
    {children}
  </div>
);

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-start justify-between gap-4 py-2 border-b border-slate-100 last:border-b-0">
    <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <span className="text-sm font-semibold text-slate-700 text-right break-all">{value}</span>
  </div>
);

export default function SupabaseAuthPilot() {
  const { client, configured, message } = supabasePilot;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whoami, setWhoami] = useState<WhoamiResult | null>(null);
  const [whoamiLoading, setWhoamiLoading] = useState(false);
  const [resolveResult, setResolveResult] = useState<SessionResolveResult | null>(null);
  const [resolveLoading, setResolveLoading] = useState(false);

  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session ?? null);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  const handleSignIn = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!client) return;
      setLoading(true);
      setError(null);
      setWhoami(null);
      setResolveResult(null);
      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError) setError(signInError.message);
      setPassword(''); // never keep the password around
      setLoading(false);
    },
    [client, email, password],
  );

  const handleSignOut = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    setWhoami(null);
    setResolveResult(null);
    await client.auth.signOut();
    setLoading(false);
  }, [client]);

  const handleWhoami = useCallback(async () => {
    if (!client) return;
    setWhoamiLoading(true);
    setWhoami(null);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setWhoami({ ok: false, status: 0, message: 'No active Supabase session — sign in first.' });
      setWhoamiLoading(false);
      return;
    }
    // `token` is passed straight to the diagnostic client as the Bearer header
    // value only. It is never stored in component state or rendered.
    const result = await runWhoamiDiagnostic(token);
    setWhoami(result);
    setWhoamiLoading(false);
  }, [client]);

  // M8: optional, manual-only "Resolve App Session" against the M7 prototype.
  // The access token is read fresh at click time and handed straight to the
  // client as the Bearer value — it is NEVER stored in React state, rendered,
  // or logged. This is a dev diagnostic, NOT app authorization.
  const handleResolveSession = useCallback(async () => {
    if (!client) return;
    setResolveLoading(true);
    setResolveResult(null);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setResolveResult({
        ok: false,
        status: 0,
        authorization: null,
        message: 'No active Supabase session — sign in first.',
      });
      setResolveLoading(false);
      return;
    }
    // `token` is passed straight to the session-resolve client as the Bearer
    // header value only. It is never stored in component state or rendered.
    const result = await runSessionResolve(token);
    setResolveResult(result);
    setResolveLoading(false);
  }, [client]);

  const signedIn = !!session;

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-6">
      <div className="w-full max-w-lg bg-white p-8 rounded-3xl shadow-xl border border-slate-100">
        <h1 className="text-2xl font-black text-primary mb-1">Supabase Auth Pilot</h1>
        <p className="text-[12px] font-bold text-slate-400 mb-4">Phase 1.5 M4 · dev-only</p>
        <Banner>{PILOT_LABEL}</Banner>

        {!configured && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
            {message}
          </div>
        )}

        {configured && !signedIn && (
          <form onSubmit={handleSignIn} className="space-y-4">
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <input
              type="email"
              placeholder="Supabase email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 border rounded-xl"
              autoComplete="off"
              required
            />
            <input
              type="password"
              placeholder="Supabase password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border rounded-xl"
              autoComplete="off"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 transition-all disabled:opacity-60"
            >
              {loading ? 'Signing in…' : 'Sign in with Supabase'}
            </button>
          </form>
        )}

        {configured && signedIn && session && (
          <div className="space-y-5">
            {error && <p className="text-red-500 text-sm">{error}</p>}

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">
                Safe session state
              </p>
              <Row label="Provider" value="supabase" />
              <Row label="User id" value={session.user?.id ? redactId(session.user.id) : '—'} />
              <Row label="Email" value={session.user?.email ?? '—'} />
              <Row label="Display name" value={readDisplayName(session) ?? '—'} />
              <Row label="Access token present" value={session.access_token ? 'true' : 'false'} />
              <Row label="Token expiry" value={formatExpiry(session)} />
              <Row label="Session" value="active" />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleWhoami}
                disabled={whoamiLoading}
                className="flex-1 py-3 bg-slate-900 text-white font-bold rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-60"
              >
                {whoamiLoading ? 'Running…' : 'Run whoami diagnostic'}
              </button>
              <button
                onClick={handleSignOut}
                disabled={loading}
                className="flex-1 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-2xl hover:bg-slate-50 transition-all disabled:opacity-60"
              >
                Sign out
              </button>
            </div>

            <button
              onClick={handleResolveSession}
              disabled={resolveLoading}
              className="w-full py-3 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-500 transition-all disabled:opacity-60"
            >
              {resolveLoading ? 'Resolving…' : 'Resolve App Session'}
            </button>

            {whoami && (
              <div
                className={`rounded-2xl border px-4 py-3 ${
                  whoami.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'
                }`}
              >
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">
                  {whoami.ok ? 'Whoami diagnostic — identity proven' : 'Whoami diagnostic — failure'}
                </p>
                <Row label="HTTP status" value={String(whoami.status)} />
                {whoami.authState && <Row label="Auth state" value={whoami.authState} />}
                {whoami.internalUserId && (
                  <Row label="Internal user id" value={redactId(whoami.internalUserId)} />
                )}
                {whoami.decision && <Row label="Decision" value={whoami.decision} />}
                {whoami.reasonCode && <Row label="Reason code" value={whoami.reasonCode} />}
                {whoami.sourceOfTruth && <Row label="Source of truth" value={whoami.sourceOfTruth} />}
                {whoami.errorCode && <Row label="Error code" value={whoami.errorCode} />}
                {whoami.requestId && <Row label="Request id" value={whoami.requestId} />}
                {whoami.message && <Row label="Note" value={whoami.message} />}
                {!whoami.ok && (
                  <p className="mt-2 text-[12px] font-semibold text-rose-700">
                    This is a diagnostic failure, not an app authorization decision.
                  </p>
                )}
              </div>
            )}

            {resolveResult && (
              <div
                className={`rounded-2xl border px-4 py-3 ${
                  resolveResult.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'
                }`}
              >
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-1">
                  Session resolve (M7) — dev diagnostic, not app authorization
                </p>
                <p className="text-[11px] font-semibold text-slate-500 mb-2">
                  Dev-only diagnostic validation only — NOT app authorization. Firebase login and
                  AccessContext are unchanged.
                </p>
                <Row label="HTTP status" value={String(resolveResult.status)} />
                {resolveResult.authState && <Row label="Auth state" value={resolveResult.authState} />}
                {resolveResult.decision && <Row label="Decision" value={resolveResult.decision} />}
                {resolveResult.reasonCode && <Row label="Reason code" value={resolveResult.reasonCode} />}
                {resolveResult.sourceOfTruth && (
                  <Row label="Source of truth" value={resolveResult.sourceOfTruth} />
                )}
                {resolveResult.internalUserId && (
                  <Row label="Internal user id" value={redactId(resolveResult.internalUserId)} />
                )}
                {resolveResult.authProviderUid && (
                  <Row label="Auth provider uid" value={redactId(resolveResult.authProviderUid)} />
                )}
                {resolveResult.authProvider && (
                  <Row label="Auth provider" value={resolveResult.authProvider} />
                )}
                {/* Prefer the already-visible signed-in email; otherwise show presence only. */}
                <Row
                  label="Email"
                  value={session.user?.email ?? (resolveResult.email ? 'present' : '—')}
                />
                {resolveResult.displayName && (
                  <Row label="Display name" value={resolveResult.displayName} />
                )}
                {resolveResult.errorCode && <Row label="Error code" value={resolveResult.errorCode} />}
                {resolveResult.errorMessage && <Row label="Error message" value={resolveResult.errorMessage} />}
                {resolveResult.requestId && <Row label="Request id" value={resolveResult.requestId} />}
                <Row label="Authorization" value="null" />
                <p className="mt-2 text-[12px] font-semibold text-slate-600">
                  authorization: null — server-derived authorization is deferred.
                </p>
                {resolveResult.message && (
                  <p className="mt-2 text-[12px] font-semibold text-slate-700">{resolveResult.message}</p>
                )}
                {resolveResult.authState === 'token-verified' &&
                  resolveResult.reasonCode === 'identity_resolution_error' && (
                    <p className="mt-2 text-[12px] font-semibold text-rose-700">
                      Token proven, app identity not resolved — fail-closed.
                    </p>
                  )}
                {!resolveResult.ok && (
                  <p className="mt-2 text-[12px] font-semibold text-rose-700">
                    This is a diagnostic failure, not an app authorization decision.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
