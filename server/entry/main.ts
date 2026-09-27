// Phase 4.0 M6-ENTRY-P1 — the deployable production executable (`npm start`).
//
// The only file that runs the production entry against the real process: the process environment is its configuration,
// PRODUCTION_CONSTRUCTION its construction, and process.exit its exit — nothing else can be selected here. Everything the
// entry does before and after binding is productionEntry.ts's. Importing this module is side-effect free: it starts only
// when executed as the entry point, so a plain import never opens a database connection or a port.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitLog } from '../runtime/logging.js';
import { PRODUCTION_CONSTRUCTION } from './entryStartup.js';
import { startProductionEntry } from './productionEntry.js';

function main(): void {
  startProductionEntry({
    env: process.env,
    construction: PRODUCTION_CONSTRUCTION,
    proc: process,
    exit: (code) => { process.exit(code); },
  }).catch(() => {
    // Reached only when the lifecycle cannot be installed on the process, before anything is composed: a fixed code,
    // never the error.
    emitLog('error', { event: 'startup_refused', reason: 'startup_failed' });
    process.exit(1);
  });
}

// Start only when executed directly. Canonical real paths are compared on BOTH sides, so a symlinked launch still matches
// rather than silently exiting without starting: argv[1] may be a symlink, and under --preserve-symlinks-main
// import.meta.url stays the symlinked path too.
const invoked = process.argv[1];
let isEntry = false;
if (invoked !== undefined) {
  try {
    isEntry = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    isEntry = false;
  }
}
if (isEntry) main();
