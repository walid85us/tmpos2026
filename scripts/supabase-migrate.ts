// Phase 1.5 M1/M10.2 — Platform Identity migration runner (convenience script).
//
// PARAMETERIZED + DEV-SAFE (M10.2). The runner discovers migration pairs under
// server/platform-identity/migrations/ and supports four shapes:
//
//   npm run identity:migrate                                  # --list (default, DB-free)
//   npx tsx scripts/supabase-migrate.ts --list               # list discovered migrations
//   npx tsx scripts/supabase-migrate.ts --dry-run --migration 002 [--direction up|down]
//   npx tsx scripts/supabase-migrate.ts --migration 002 --direction up   --apply --confirm-dev
//   npx tsx scripts/supabase-migrate.ts --migration 002 --direction down --apply --allow-down --confirm-dev
//
// DEFAULT IS SAFE: with no apply flags the runner LISTS migrations and never
// connects to the database (this is a deliberate behaviour change from the old
// hardcoded "apply 001" default — 001 is already applied to DEV, and silent
// auto-apply is exactly the footgun this removes).
//
// APPLY IS THE ONLY MODE THAT TOUCHES THE DATABASE, and it refuses unless EVERY
// guard is satisfied:
//   - NODE_ENV !== 'production'                         (production hard-blocked)
//   - ALLOW_SUPABASE_MIGRATION_APPLY === 'true'
//   - CONFIRM_SUPABASE_TARGET === 'tmpos2026-dev'       (typed DEV confirmation)
//   - --confirm-dev                                     (explicit CLI confirmation)
//   - SUPABASE_DATABASE_URL present
//   - direction 'down' additionally requires --allow-down
//   - optional: if EXPECTED_DEV_PROJECT_REF is set, the project ref derived from
//     SUPABASE_DATABASE_URL must match (boolean-only report; refuse on mismatch)
//
// SECURITY: never prints SUPABASE_DATABASE_URL, the derived project ref, the SQL
// file contents, or any secret. Reports only safe status (migration id, basename,
// direction, relative path, the CONFIRM_SUPABASE_TARGET label, booleans). Multi-
// statement SQL (incl. trigger functions) is executed in simple-query mode, which
// Postgres runs as a single implicit transaction.
//
// This runner is an OPERATOR CLI only. It is never imported by the client (`src/`)
// or by the server runtime; importing it opens no connection.

import { readFileSync, readdirSync, existsSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute, sep } from 'path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'server', 'platform-identity', 'migrations');
const MIGRATIONS_REL = 'server/platform-identity/migrations';

// The ONLY accepted DEV confirmation token. Baking the DEV project label in means
// CONFIRM_SUPABASE_TARGET must be typed to exactly this value to apply — a wrong
// (e.g. production) label can never satisfy the guard. The label is not a secret.
const EXPECTED_DEV_TARGET = 'tmpos2026-dev';

// Migration filename grammar: NNN_name.(up|down).sql — three digits, lower
// snake_case name, explicit direction.
const MIGRATION_NAME_RE = /^(\d{3})_([a-z0-9_]+)\.(up|down)\.sql$/;
// A migration identifier (number or basename) may contain ONLY these characters.
// This alone rejects '/', '\\', '..', '.', and absolute paths.
const IDENT_RE = /^[a-z0-9_]+$/i;

// ---- argument parsing -------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f: string): boolean => argv.includes(f);
function getOpt(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return undefined;
}

const wantApply = hasFlag('--apply');
const wantDryRun = hasFlag('--dry-run');
const wantList = hasFlag('--list');
const migrationInput = getOpt('--migration');
const direction = getOpt('--direction') ?? (hasFlag('--down') ? 'down' : 'up');

// ---- safe failure -----------------------------------------------------------

/** Print a safe refusal/error (variable NAMES only, never values) and exit non-zero. */
function refuse(message: string): never {
  console.error(`[migrate] REFUSED: ${message}`);
  process.exit(1);
}

// ---- migration discovery + path-safe resolution -----------------------------

interface MigrationPair {
  number: string;
  name: string;
  up: boolean;
  down: boolean;
}

function discoverMigrations(): MigrationPair[] {
  const byNumber = new Map<string, MigrationPair>();
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const m = MIGRATION_NAME_RE.exec(file);
    if (!m) continue;
    const [, number, name, dir] = m;
    const cur = byNumber.get(number) ?? { number, name, up: false, down: false };
    cur.name = name;
    if (dir === 'up') cur.up = true;
    else cur.down = true;
    byNumber.set(number, cur);
  }
  return [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number));
}

function assertSafeInput(input: string | undefined): asserts input is string {
  if (!input) {
    throw new Error('a migration identifier is required (e.g. --migration 002)');
  }
  // Defense-in-depth: explicit traversal rejection BEFORE the allow-list, so the
  // error is precise. The allow-list below is the actual guarantee.
  if (input.includes('/') || input.includes('\\') || input.includes('..') || isAbsolute(input)) {
    throw new Error('invalid migration identifier: path separators / traversal are not allowed');
  }
  if (!IDENT_RE.test(input)) {
    throw new Error('invalid migration identifier: only letters, digits, and underscore are allowed');
  }
}

interface Resolved {
  id: string;
  basename: string;
  direction: 'up' | 'down';
  selectedFile: string;
  pairedFile: string;
  selectedAbs: string;
  sqlText: string;
}

function resolveMigration(input: string | undefined, dir: 'up' | 'down'): Resolved {
  assertSafeInput(input);
  const migrations = discoverMigrations();
  const match = /^\d{3}$/.test(input)
    ? migrations.find((m) => m.number === input)
    : migrations.find((m) => `${m.number}_${m.name}` === input);
  if (!match) {
    throw new Error(`no migration found for "${input}" under ${MIGRATIONS_REL}/`);
  }

  const basename = `${match.number}_${match.name}`;
  const pairedDir = dir === 'up' ? 'down' : 'up';
  const selectedFile = `${basename}.${dir}.sql`;
  const pairedFile = `${basename}.${pairedDir}.sql`;
  const selectedAbs = join(MIGRATIONS_DIR, selectedFile);
  const pairedAbs = join(MIGRATIONS_DIR, pairedFile);

  if (!existsSync(selectedAbs)) throw new Error(`selected migration file is missing: ${selectedFile}`);
  if (!existsSync(pairedAbs)) throw new Error(`paired ${pairedDir} migration file is missing: ${pairedFile}`);

  // Containment: the resolved file MUST live inside the migrations directory.
  const dirReal = realpathSync(MIGRATIONS_DIR);
  const fileReal = realpathSync(selectedAbs);
  if (fileReal !== join(dirReal, selectedFile) && !fileReal.startsWith(dirReal + sep)) {
    throw new Error('resolved migration escapes the migrations directory');
  }

  const sqlText = readFileSync(selectedAbs, 'utf8');
  if (sqlText.trim().length === 0) throw new Error(`selected migration file is empty: ${selectedFile}`);

  return { id: match.number, basename, direction: dir, selectedFile, pairedFile, selectedAbs, sqlText };
}

// ---- modes ------------------------------------------------------------------

function runList(): void {
  const migrations = discoverMigrations();
  console.log(`[migrate] discovered migrations under ${MIGRATIONS_REL}/:`);
  if (migrations.length === 0) {
    console.log('  (none found)');
  } else {
    for (const m of migrations) {
      console.log(`  id=${m.number}  basename=${m.number}_${m.name}  up=${m.up ? 'yes' : 'no'}  down=${m.down ? 'yes' : 'no'}`);
    }
  }
  console.log('[migrate] list mode: no database connection, no SQL executed.');
}

function runDryRun(dir: 'up' | 'down'): void {
  const r = resolveMigration(migrationInput, dir);
  console.log('[migrate] dry-run (no database connection, no SQL executed):');
  console.log(`  migration id:   ${r.id}`);
  console.log(`  basename:       ${r.basename}`);
  console.log(`  direction:      ${dir}`);
  console.log(`  selected file:  ${MIGRATIONS_REL}/${r.selectedFile}`);
  console.log(`  paired file:    ${MIGRATIONS_REL}/${r.pairedFile}`);
  console.log('  pair verified:  yes');
  console.log('  non-empty:      yes');
  console.log('[migrate] dry-run OK. To apply (DEV only), use the guarded apply command (see docs).');
}

/** Project ref derived from the DB URL host/username. Returns null if not derivable. */
function deriveProjectRef(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl);
    const hostM = /^db\.([a-z0-9]+)\.supabase\.(co|com|net)$/i.exec(u.hostname);
    if (hostM) return hostM[1];
    const userM = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(u.username || ''));
    if (userM) return userM[1];
  } catch {
    /* not a parseable URL — treat as not derivable */
  }
  return null;
}

function assertApplyGuards(dir: 'up' | 'down'): void {
  if (process.env.NODE_ENV === 'production') {
    refuse('NODE_ENV=production — production is hard-blocked. This runner is DEV-only.');
  }
  if (process.env.ALLOW_SUPABASE_MIGRATION_APPLY !== 'true') {
    refuse('ALLOW_SUPABASE_MIGRATION_APPLY must equal "true".');
  }
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_DEV_TARGET) {
    refuse(`CONFIRM_SUPABASE_TARGET must equal the expected DEV target "${EXPECTED_DEV_TARGET}".`);
  }
  if (!hasFlag('--confirm-dev')) {
    refuse('--confirm-dev flag is required to apply.');
  }
  if (dir === 'down' && !hasFlag('--allow-down')) {
    refuse('--allow-down flag is required to run a DOWN migration (DEV rollback only).');
  }
}

async function runApply(dir: 'up' | 'down'): Promise<void> {
  // 1) All non-DB guards first — apply REFUSES before any connection is created.
  assertApplyGuards(dir);

  // 2) DB URL presence (still no connection yet).
  const databaseUrl = process.env.SUPABASE_DATABASE_URL;
  if (!databaseUrl) {
    refuse('SUPABASE_DATABASE_URL is not set. Run in the Replit shell where the secret exists.');
  }

  // 3) Optional automated DEV target check — boolean-only, never prints the ref/URL.
  const expectedRef = process.env.EXPECTED_DEV_PROJECT_REF;
  if (expectedRef) {
    const derived = deriveProjectRef(databaseUrl);
    const matched = derived !== null && derived === expectedRef;
    console.log(`[migrate] expected dev project ref matched: ${matched}`);
    if (!matched) {
      refuse('the project ref derived from SUPABASE_DATABASE_URL does not match EXPECTED_DEV_PROJECT_REF.');
    }
  }

  // 4) Resolve + validate the migration (same path-safe resolver as dry-run).
  const r = resolveMigration(migrationInput, dir);

  if (dir === 'down') {
    console.warn('[migrate] ⚠ DOWN MIGRATION — DEV ONLY.');
    console.warn('[migrate] ⚠ Never run a down migration against production.');
    console.warn('[migrate] ⚠ Never drop a populated audit_event in production without explicit approval, a verified backup, and a compliance review.');
  }

  // Safe target LABEL only (the value the owner already typed); never the DB URL.
  console.log(`[migrate] target (CONFIRM_SUPABASE_TARGET): ${process.env.CONFIRM_SUPABASE_TARGET}`);
  console.log(`[migrate] applying ${r.basename} ${dir.toUpperCase()} (id=${r.id}) …`);

  const sql = postgres(databaseUrl, { ssl: 'require', max: 1, prepare: false, connect_timeout: 10 });
  try {
    await sql.unsafe(r.sqlText).simple();
    console.log(`[migrate] SUCCESS: ${r.basename} ${dir.toUpperCase()} applied.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[migrate] FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---- dispatch ---------------------------------------------------------------

async function main(): Promise<void> {
  if (direction !== 'up' && direction !== 'down') {
    console.error('[migrate] ERROR: --direction must be "up" or "down".');
    process.exitCode = 1;
    return;
  }
  try {
    if (wantApply) {
      await runApply(direction);
    } else if (wantDryRun) {
      runDryRun(direction);
    } else if (wantList) {
      runList();
    } else {
      // Default (no mode flag): SAFE, DB-free listing.
      runList();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[migrate] ERROR: ${message}`);
    process.exitCode = 1;
  }
}

main();
