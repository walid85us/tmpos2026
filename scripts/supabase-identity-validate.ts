// Phase 1.5 M1 — Platform Identity validation script.
//
// Safe diagnostics for the M1 backend slice. RUN IN THE REPLIT SHELL (where the
// Supabase secrets exist). It NEVER prints secret values — only present/missing
// booleans and safe status.
//
// Usage:
//   npm run identity:validate                 # env presence only (no DB)
//   npm run identity:validate -- --connect    # + connect and `select 1`
//   npm run identity:validate -- --check-table# + verify platform_identity exists
//   npm run identity:validate -- --smoke      # + dev-only upsert of a FAKE
//                                             #   identity, then clean it up
//
// --smoke also requires ENABLE_SUPABASE_PLATFORM_IDENTITY=true and inserts only
// a clearly-fake identity (auth_provider='dev-smoke-test'), which it deletes
// immediately afterwards. No real/business data is written.

import postgres from 'postgres';

function present(name: string): boolean {
  return !!process.env[name];
}

async function main() {
  const args = process.argv.slice(2);
  const doConnect = args.includes('--connect') || args.includes('--check-table') || args.includes('--smoke');
  const doCheckTable = args.includes('--check-table') || args.includes('--smoke');
  const doSmoke = args.includes('--smoke');

  // 1) Env presence — booleans only, never values.
  const presence = {
    SUPABASE_URL: present('SUPABASE_URL'),
    SUPABASE_DATABASE_URL: present('SUPABASE_DATABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: present('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_ANON_KEY: present('SUPABASE_ANON_KEY'),
  };
  console.log('[validate] Secret presence (values never shown):');
  for (const [k, v] of Object.entries(presence)) {
    console.log(`  ${k}: ${v ? 'PRESENT' : 'MISSING'}`);
  }
  console.log(`[validate] Feature flag ENABLE_SUPABASE_PLATFORM_IDENTITY: ${process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true' ? 'ON' : 'OFF (default)'}`);

  const required = ['SUPABASE_URL', 'SUPABASE_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const missingRequired = required.filter((k) => !present(k));
  if (missingRequired.length) {
    console.error(`[validate] Missing required secrets: ${missingRequired.join(', ')}`);
    if (doConnect) process.exitCode = 1;
  }

  if (!doConnect) {
    console.log('[validate] Done (presence-only). Pass --connect / --check-table / --smoke for DB checks.');
    return;
  }

  const databaseUrl = process.env.SUPABASE_DATABASE_URL;
  if (!databaseUrl) {
    console.error('[validate] Cannot connect: SUPABASE_DATABASE_URL missing.');
    process.exitCode = 1;
    return;
  }

  const sql = postgres(databaseUrl, { ssl: 'require', max: 1, prepare: false, connect_timeout: 10 });
  try {
    // 2) Connectivity.
    await sql`select 1`;
    console.log('[validate] DB connectivity: OK');

    // 3) Table existence.
    if (doCheckTable) {
      const rows = await sql`
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'platform_identity' limit 1
      `;
      console.log(`[validate] Table platform_identity: ${rows.length ? 'EXISTS' : 'MISSING (apply the migration first)'}`);
      if (!rows.length && doSmoke) {
        console.error('[validate] Cannot run --smoke: table is missing.');
        process.exitCode = 1;
        return;
      }
    }

    // 4) Smoke test — dev-only, fake identity, with cleanup.
    if (doSmoke) {
      if (process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY !== 'true') {
        console.error('[validate] --smoke requires ENABLE_SUPABASE_PLATFORM_IDENTITY=true.');
        process.exitCode = 1;
        return;
      }
      const fakeUid = `smoke-${Math.floor(Date.now() / 1000)}-${process.pid}`;
      const inserted = await sql`
        insert into platform_identity (auth_provider, auth_provider_uid, email, display_name)
        values ('dev-smoke-test', ${fakeUid}, null, 'DEV SMOKE (safe to delete)')
        on conflict (auth_provider, auth_provider_uid) do update set updated_at = now()
        returning internal_user_id
      `;
      const id = inserted[0]?.internal_user_id;
      console.log(`[validate] Smoke upsert OK (internal_user_id present: ${!!id}).`);
      const deleted = await sql`delete from platform_identity where auth_provider = 'dev-smoke-test' and auth_provider_uid = ${fakeUid}`;
      console.log(`[validate] Smoke cleanup OK (rows removed: ${deleted.count}).`);
    }

    console.log('[validate] All requested checks passed.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[validate] DB check FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
