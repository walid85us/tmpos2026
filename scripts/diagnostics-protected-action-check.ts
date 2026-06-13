// Phase 1.5 M2 — dev-only smoke harness for the protected diagnostic endpoint.
//
// Spins up an EPHEMERAL in-process Express app that mounts the SAME protected
// diagnostic route as server/platform-identity/server.ts, then exercises the
// gates and decision paths over HTTP. Dev-only.
//
// Requires NO secrets and prints none. When the Supabase config is absent
// (the normal case here), identity resolution is simply skipped and the decision
// still runs off the dev-asserted snapshot, so all enforcement paths are
// testable without a database.
//
// Run:  npx tsx scripts/diagnostics-protected-action-check.ts
//
// NOTE: this does NOT import server/platform-identity/server.ts (that module
// starts a listener on import); it re-mounts the identical route via
// withProtectedAction so there is no side effect.

import express from 'express';
import type { AddressInfo } from 'net';
import { withProtectedAction } from '../server/platform-identity/protectedAction';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  // Mirrors the route in server/platform-identity/server.ts (kept in sync).
  app.post(
    '/diagnostics/echo-decision',
    withProtectedAction(
      'platform.diagnostic.echo',
      { kind: 'platform', featureKey: 'team_management', threshold: 'view' },
      (ctx) => ({ internalUserId: ctx.actor.internalUserId, scopeType: ctx.scope.scopeType }),
    ),
  );
  return app;
}

async function post(base: string, body: unknown) {
  const res = await fetch(`${base}/diagnostics/echo-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore non-JSON */ }
  return { status: res.status, json };
}

const platformViewActor = {
  devActor: {
    authProvider: 'firebase',
    authProviderUid: 'dev-uid-1',
    email: 'dev@example.test',
    actorType: 'platform_user',
    scope: { scopeType: 'platform', tenantId: null, storeId: null },
    permissionSnapshot: {
      source: 'dev_asserted_snapshot',
      platformRoleId: 'support_admin',
      tenantRoleId: null,
      permissions: { team_management: 'view' },
      subPermissions: {},
    },
  },
};
const platformNoPermActor = {
  devActor: {
    ...platformViewActor.devActor,
    permissionSnapshot: { ...platformViewActor.devActor.permissionSnapshot, permissions: { team_management: 'none' } },
  },
};
const systemOwnerActor = {
  devActor: {
    ...platformViewActor.devActor,
    permissionSnapshot: { ...platformViewActor.devActor.permissionSnapshot, platformRoleId: 'system_owner', permissions: {} },
  },
};
const tenantScopeActor = {
  devActor: {
    ...platformViewActor.devActor,
    actorType: 'tenant_user',
    scope: { scopeType: 'tenant', tenantId: 'tenant-1', storeId: null },
    permissionSnapshot: {
      source: 'dev_asserted_snapshot',
      platformRoleId: null,
      tenantRoleId: 'manager',
      permissions: { team_management: 'full' },
      subPermissions: {},
    },
  },
};

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main() {
  const app = makeApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // A) Flag OFF (both env unset) → 404 FEATURE_DISABLED
    delete process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY;
    delete process.env.PLATFORM_IDENTITY_DEV_DIAGNOSTICS;
    let r = await post(base, platformViewActor);
    check('A flag OFF → 404', r.status === 404 && r.json?.error?.code === 'FEATURE_DISABLED', `status=${r.status} code=${r.json?.error?.code}`);

    // B) Flag ON, dev diagnostics OFF → 404
    process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY = 'true';
    delete process.env.PLATFORM_IDENTITY_DEV_DIAGNOSTICS;
    r = await post(base, platformViewActor);
    check('B flag ON, diagnostics OFF → 404', r.status === 404, `status=${r.status} code=${r.json?.error?.code}`);

    // C) Flag ON + diagnostics ON
    process.env.PLATFORM_IDENTITY_DEV_DIAGNOSTICS = 'true';

    r = await post(base, platformViewActor);
    check('C1 allow path', r.status === 200 && r.json?.decision === 'allow', `status=${r.status} decision=${r.json?.decision}`);

    r = await post(base, platformNoPermActor);
    check('C2 deny missing permission', r.status === 403 && r.json?.reasonCode === 'denied_missing_permission', `status=${r.status} reason=${r.json?.reasonCode}`);

    r = await post(base, {});
    check('C3 no assertion → unauthenticated deny', r.status === 401 && r.json?.reasonCode === 'denied_unauthenticated', `status=${r.status} reason=${r.json?.reasonCode}`);

    r = await post(base, tenantScopeActor);
    check('C4 scope isolation (tenant ⊥ platform)', r.status === 403 && r.json?.reasonCode === 'denied_scope_mismatch', `status=${r.status} reason=${r.json?.reasonCode}`);

    r = await post(base, systemOwnerActor);
    check('C5 system owner allow', r.status === 200 && r.json?.decision === 'allow', `status=${r.status} decision=${r.json?.decision}`);

    r = await post(base, { ...platformViewActor, verifier: 'stub-firebase' });
    check('C6 stub firebase not-implemented', r.status === 501 && r.json?.reasonCode === 'firebase_verification_not_implemented', `status=${r.status} reason=${r.json?.reasonCode}`);
  } finally {
    server.close();
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n[diagnostics-smoke] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main();
