// Phase 1.5 M1 — Thin Server/API boundary: Platform Identity.
//
// ISOLATION: This is a SEPARATE express app from the shipping sidecar
// (server/index.ts). It has its own port, its own routes, and shares no state
// or middleware with shipping. The shipping sidecar is left untouched.
//
// SAFETY:
//   - The identity routes are DISABLED unless ENABLE_SUPABASE_PLATFORM_IDENTITY
//     === 'true' (default OFF). With the flag OFF, only /health and /readiness
//     respond, and the app does NOT open a DB connection.
//   - This boundary does NOT replace login, does NOT touch Firebase Auth, and
//     does NOT handle tenant/business data.
//   - No secret value is ever logged or returned. Config is reported as
//     presence booleans only.
//
// This file is NOT started by `npm run dev`; run it explicitly with
// `npm run identity:api` so default app behaviour is unchanged.

import express from 'express';
import { sanitizeError, safeLog } from '../safe-log';
import {
  FEATURE_FLAG,
  isPlatformIdentityEnabled,
  getConfigPresence,
  isServerConfigComplete,
} from './config';
import { findByProviderUid, upsertIdentity } from './identityRepository';
import { getDb } from './db';
import { withProtectedAction } from './protectedAction';
import { createSupabaseWhoamiHandler } from './verifiedWhoami';
import { createSessionResolveHandler } from './sessionResolve';
import { createBcpReadinessSummaryHandler, BCP_READINESS_ROUTE_PATH } from '../bcp-pilot/bcpReadOnlyExpressAdapter';
import { createBcpC02RegistryReadinessHandler, BCP_C02_REGISTRY_READINESS_ROUTE_PATH } from '../bcp-pilot/bcpC02ReadOnlyExpressAdapter';
import { getBcpC02RegistryModules } from '../bcp-pilot/bcpC02RegistryProvider';
import { createBcpC03UiCoverageReadinessHandler, BCP_C03_UI_COVERAGE_ROUTE_PATH } from '../bcp-pilot/bcpC03ReadOnlyExpressAdapter';
import { getBcpC03UiCoverageEntries } from '../bcp-pilot/bcpC03UiCoverageProvider';
import { createBcpC04RouteExposureReadinessHandler, BCP_C04_ROUTE_EXPOSURE_ROUTE_PATH } from '../bcp-pilot/bcpC04ReadOnlyExpressAdapter';
import { getBcpC04RouteExposureEntries } from '../bcp-pilot/bcpC04RouteExposureProvider';
import { createBcpC05FeatureFlagPostureReadinessHandler, BCP_C05_FEATURE_FLAG_POSTURE_ROUTE_PATH } from '../bcp-pilot/bcpC05ReadOnlyExpressAdapter';
import { getBcpC05FeatureFlagPostureEntries } from '../bcp-pilot/bcpC05FeatureFlagPostureProvider';

export function createPlatformIdentityApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // --- Always available: liveness + config presence (booleans only) ---------
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'platform-identity',
      featureFlag: FEATURE_FLAG,
      featureEnabled: isPlatformIdentityEnabled(),
      config: getConfigPresence(), // presence booleans only — never values
    });
  });

  // --- Readiness: flag ON + config present + DB reachable -------------------
  app.get('/readiness', async (_req, res) => {
    if (!isPlatformIdentityEnabled()) {
      res.status(503).json({ ready: false, reason: 'feature_flag_off' });
      return;
    }
    if (!isServerConfigComplete()) {
      res.status(503).json({ ready: false, reason: 'config_missing', config: getConfigPresence() });
      return;
    }
    try {
      const sql = getDb();
      await sql`select 1`;
      res.json({ ready: true });
    } catch (err) {
      safeLog.error('[platform-identity] readiness DB check failed', sanitizeError(err));
      res.status(503).json({ ready: false, reason: 'db_unreachable' });
    }
  });

  // --- Flag-gated identity resolution (dev-only foundation) -----------------
  // Maps an external auth UID to a stable, app-owned internal_user_id. This is
  // a FOUNDATION endpoint: it intentionally does NOT enforce production auth on
  // the caller (deferred to a later milestone) and is therefore gated behind
  // the default-OFF feature flag and intended for dev use only.
  app.post('/identity/resolve', async (req, res) => {
    if (!isPlatformIdentityEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const authProviderUid = typeof body.authProviderUid === 'string' ? body.authProviderUid.trim() : '';
    const authProvider = typeof body.authProvider === 'string' && body.authProvider.trim()
      ? body.authProvider.trim()
      : 'firebase';
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : null;

    if (!authProviderUid) {
      res.status(400).json({ error: { code: 'MISSING_UID', message: 'authProviderUid is required.' } });
      return;
    }

    try {
      const identity = await upsertIdentity({ authProvider, authProviderUid, email, displayName });
      res.json({ success: true, identity }); // safe public fields only
    } catch (err) {
      safeLog.error('[platform-identity] upsert failed', sanitizeError(err));
      res.status(500).json({ error: { code: 'UPSERT_FAILED', message: 'Failed to resolve identity.' } });
    }
  });

  // --- Flag-gated lookup ----------------------------------------------------
  app.get('/identity/by-uid', async (req, res) => {
    if (!isPlatformIdentityEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    const authProviderUid = typeof req.query.authProviderUid === 'string' ? req.query.authProviderUid.trim() : '';
    const authProvider = typeof req.query.authProvider === 'string' && req.query.authProvider.trim()
      ? req.query.authProvider.trim()
      : 'firebase';
    if (!authProviderUid) {
      res.status(400).json({ error: { code: 'MISSING_UID', message: 'authProviderUid is required.' } });
      return;
    }
    try {
      const identity = await findByProviderUid(authProvider, authProviderUid);
      if (!identity) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No identity for that reference.' } });
        return;
      }
      res.json({ success: true, identity });
    } catch (err) {
      safeLog.error('[platform-identity] lookup failed', sanitizeError(err));
      res.status(500).json({ error: { code: 'LOOKUP_FAILED', message: 'Failed to look up identity.' } });
    }
  });

  // --- Phase 1.5 M2: dev-only PROTECTED DIAGNOSTIC (no business effect) -------
  // Exercises the server-side enforcement spine end-to-end:
  //   request context → permission decision → advisory audit envelope.
  // Requires BOTH ENABLE_SUPABASE_PLATFORM_IDENTITY=true AND
  // PLATFORM_IDENTITY_DEV_DIAGNOSTICS=true (and a non-production process);
  // returns 404 FEATURE_DISABLED otherwise. Reads/writes NO tenant/business
  // data — the handler only echoes a safe, non-secret decision summary. The
  // required permission is the platform key `team_management` at `view`.
  app.post(
    '/diagnostics/echo-decision',
    withProtectedAction(
      'platform.diagnostic.echo',
      { kind: 'platform', featureKey: 'team_management', threshold: 'view' },
      (ctx) => ({
        internalUserId: ctx.actor.internalUserId,
        actorType: ctx.actor.actorType,
        scopeType: ctx.scope.scopeType,
        identityResolution: ctx.identityResolution,
      }),
    ),
  );

  // --- Phase 1.5 M3-Revised: dev-only VERIFIED Supabase actor diagnostic -------
  // Verifies a real Supabase Auth access token (JWKS via `jose`), derives the
  // trusted actor, resolves/creates the app-owned internal_user_id
  // (auth_provider='supabase'), and returns a safe whoami summary. Gated by BOTH
  // ENABLE_SUPABASE_PLATFORM_IDENTITY=true AND
  // PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS=true, and never served in production
  // (404 otherwise). Distinct from the M2 dev-asserted /diagnostics/echo-decision
  // path, which is unchanged. No durable roles, no business data, no RLS.
  app.post('/diagnostics/supabase-whoami', createSupabaseWhoamiHandler());

  // --- Phase 1.5 M7: dev-only DEFAULT-OFF /auth/session/resolve prototype -------
  // Production-safe-SHAPED session resolution, but NOT production-enabled. Verifies
  // a Supabase token (M3 JWKS verifier), resolves the app-owned internal_user_id
  // (M1, fail-closed), and returns the M6 contract DTO (authorization ALWAYS null).
  // The handler self-gates on BOTH ENABLE_SUPABASE_PLATFORM_IDENTITY=true AND
  // ENABLE_SESSION_RESOLVE=true, and is NEVER served in production (404 otherwise).
  // No frontend adoption, no AccessContext change, no durable audit, no schema/RLS.
  app.post('/auth/session/resolve', createSessionResolveHandler());

  // --- Phase 2.0 M7G: dev-only DEFAULT-OFF inert Backend CP read-only route -------
  // Registers the pure M7E handler (flag → guard → synthetic C-01 mapper) as an INERT,
  // synthetic-only GET route on THIS isolated API only (never the SaaS app, never the client
  // bundle). The handler self-gates: with ENABLE_BCP_DEV_READONLY_PILOT off, in production, or for
  // a non-GET method, it returns a safe unavailable/blocked/denied/405 response with no data. It
  // reads NOTHING live (no DB/Supabase/provider) and uses a fixed server-constructed synthetic
  // principal — no live session resolver, no auth change. `app.all` routes every method to the
  // handler so HEAD/OPTIONS/mutation semantics are decided by the pure handler.
  app.all(BCP_READINESS_ROUTE_PATH, createBcpReadinessSummaryHandler());

  // --- Phase 2.0 M8E: dev-only DEFAULT-OFF C-02 registry-readiness lens route -------
  // Registers the accepted M8D inert C-02 handler (flag → guard → code/config registry DTO) on THIS
  // isolated API only (never the SaaS app, never the client bundle). EVERY dependency is server-sourced:
  // isDevEnvironment from NODE_ENV, featureEnabled from the default-OFF flag
  // ENABLE_BCP_DEV_C02_REGISTRY_READINESS, and the module registry from the M10 SAFE SERVER-OWNED
  // provider (getBcpC02RegistryModules — a deterministic, code/config-only, no-throw, no-I/O list of
  // safe bounded { id, name, status } labels; NO src/mockData import, NO DB/Supabase/live read). The
  // provider is supplied ONLY through the accepted adapter getModules seam and is resolved by the
  // adapter ONLY after the DEV + feature gates pass. NOTHING from the request (query/body/headers/
  // cookies/params) is mapped into principal/modules/mode — only req.method is read, by the handler.
  // With the flag off, in production, or for a non-GET method, the handler returns a safe
  // unavailable/blocked/denied/405 response with no data. `app.all` routes every method to the handler
  // so HEAD/OPTIONS/mutation semantics are decided by the pure handler.
  app.all(
    BCP_C02_REGISTRY_READINESS_ROUTE_PATH,
    createBcpC02RegistryReadinessHandler({ getModules: getBcpC02RegistryModules }),
  );

  // --- Phase 2.0 M12: dev-only DEFAULT-OFF C-03 UI coverage / screen readiness lens route -----------
  // Registers the inert C-03 handler (flag → guard → code/config UI coverage DTO) on THIS isolated API
  // only (never the SaaS app, never the client bundle). EVERY dependency is server-sourced: isDev from
  // NODE_ENV, featureEnabled from the default-OFF flag ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS, and the
  // UI coverage registry from the M12 SAFE SERVER-OWNED provider (getBcpC03UiCoverageEntries — a
  // deterministic, code/config-only, no-throw, no-I/O list of safe bounded labels; NO src/mockData
  // import, NO DB/Supabase/live read), supplied ONLY through the accepted getCoverageEntries seam and
  // resolved by the adapter ONLY after the DEV + feature gates pass. NOTHING from the request is mapped
  // into authority/content — only req.method is read, by the handler. Flag-off / production / non-GET
  // return a safe response with no data. `app.all` routes every method to the pure handler.
  app.all(
    BCP_C03_UI_COVERAGE_ROUTE_PATH,
    createBcpC03UiCoverageReadinessHandler({ getCoverageEntries: getBcpC03UiCoverageEntries }),
  );

  // --- Phase 2.0 M14: dev-only DEFAULT-OFF C-04 route exposure posture lens route ------------------
  // Registers the inert C-04 handler (flag → guard → code/config route-exposure DTO) on THIS isolated
  // API only (never the SaaS app, never the client bundle). EVERY dependency is server-sourced: isDev
  // from NODE_ENV, featureEnabled from the default-OFF flag ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS,
  // and the route registry from the M14 SAFE SERVER-OWNED provider (getBcpC04RouteExposureEntries — a
  // deterministic, code/config-only, no-throw list of the FOUR allow-listed Backend CP DEV routes; NO
  // runtime route scan, NO router introspection, NO src/mockData import, NO DB/Supabase/live read),
  // supplied ONLY through the accepted getRouteExposureEntries seam and resolved by the adapter ONLY
  // after the DEV + feature gates pass. NOTHING from the request is mapped into authority/content — only
  // req.method is read, by the handler. Flag-off / production / non-GET return a safe response with no
  // data. `app.all` routes every method to the pure handler.
  app.all(
    BCP_C04_ROUTE_EXPOSURE_ROUTE_PATH,
    createBcpC04RouteExposureReadinessHandler({ getRouteExposureEntries: getBcpC04RouteExposureEntries }),
  );

  // --- Phase 2.0 M17: dev-only DEFAULT-OFF C-05 feature flag posture lens route --------------------
  // Registers the inert C-05 handler (flag → guard → code/config feature-flag-posture DTO) on THIS
  // isolated API only (never the SaaS app, never the client bundle). EVERY dependency is server-sourced:
  // isDev from NODE_ENV, featureEnabled from the default-OFF flag ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_
  // READINESS (a boolean GATE only — its value is NEVER surfaced as data), and the posture registry from
  // the M17 SAFE SERVER-OWNED provider (getBcpC05FeatureFlagPostureEntries — a deterministic, code/config-
  // only, no-throw list of the SIX allow-listed Backend CP feature flag NAMES; NO process.env read for
  // output, NO env enumeration, NO src/mockData import, NO DB/Supabase/live read, NO value oracle),
  // supplied ONLY through the accepted getFeatureFlagPostureEntries seam and resolved by the adapter ONLY
  // after the DEV + feature gates pass. NOTHING from the request is mapped into authority/content — only
  // req.method is read, by the handler. Flag-off / production / non-GET return a safe response with no
  // data. `app.all` routes every method to the pure handler.
  app.all(
    BCP_C05_FEATURE_FLAG_POSTURE_ROUTE_PATH,
    createBcpC05FeatureFlagPostureReadinessHandler({ getFeatureFlagPostureEntries: getBcpC05FeatureFlagPostureEntries }),
  );

  return app;
}

// Start only when run directly (e.g. `npm run identity:api`).
const PORT = parseInt(process.env.PLATFORM_IDENTITY_API_PORT || '5002', 10);
const app = createPlatformIdentityApp();
app.listen(PORT, '0.0.0.0', () => {
  const presence = getConfigPresence();
  safeLog.info(
    `[platform-identity] isolated API on port ${PORT} | featureEnabled=${isPlatformIdentityEnabled()} | ` +
    `config present: url=${presence.supabaseUrl} db=${presence.databaseUrl} serviceRole=${presence.serviceRoleKey}`,
  );
});

export default app;
