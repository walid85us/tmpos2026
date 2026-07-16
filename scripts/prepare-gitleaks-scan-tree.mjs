#!/usr/bin/env node
// Phase 4.0 M2 — build a REPOSITORY-ONLY scan tree for Gitleaks current-tree
// scanning (§3). Derived from all tracked + all non-ignored untracked files
// (NUL-delimited git output, so spaces/tabs/newlines in names are safe). Skips
// files deleted from the working tree, never dereferences a symlink pointing
// outside the repository, and rejects devices/FIFOs/sockets/other non-regular
// objects. Copies only into a freshly created temp dir. Excludes ONLY the exact
// protected paths (never a broad compensation exclusion).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';

export const PROTECTED_EXCLUSIONS = [
  /^agency-agents\//,
  /^goose-[^/]*\.tar\.bz2$/,
  /^\.git\//,
  /^node_modules\//,
  /^dist\//,
  /(^|\/)semgrep-results\.json$/,   // documented generated scanner output
  /(^|\/)gitleaks-report\.json$/,
];

function gitZ(repoRoot, args) {
  const buf = execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return buf.toString('utf8').split('\0').filter(Boolean);
}

export function collectRepoFiles(repoRoot) {
  const tracked = gitZ(repoRoot, ['ls-files', '-z']);
  const untracked = gitZ(repoRoot, ['ls-files', '-z', '-o', '--exclude-standard']);
  const all = [...new Set([...tracked, ...untracked])];
  return all.filter((rel) => !PROTECTED_EXCLUSIONS.some((re) => re.test(rel)));
}

export function prepareScanTree(repoRoot = process.cwd(), outBase = tmpdir()) {
  const real = realpathSync(repoRoot);
  const files = collectRepoFiles(repoRoot);
  const dir = mkdtempSync(join(outBase, 'gitleaks-scan-'));
  const skipped = { deleted: 0, externalSymlink: 0, nonRegular: 0 };
  let copied = 0;
  for (const rel of files) {
    const abs = join(real, rel);
    if (!existsSync(abs)) { skipped.deleted++; continue; } // tracked but deleted from worktree
    let st;
    try { st = lstatSync(abs); } catch { skipped.nonRegular++; continue; }
    if (st.isSymbolicLink()) {
      let target;
      try { target = realpathSync(abs); } catch { skipped.externalSymlink++; continue; }
      if (target !== real && !target.startsWith(real + sep)) { skipped.externalSymlink++; continue; } // points outside repo
    } else if (!st.isFile()) {
      skipped.nonRegular++; continue; // device / FIFO / socket / dir
    }
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    copied++;
  }
  return { dir, copied, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dir, copied, skipped } = prepareScanTree(process.argv[2] || process.cwd());
  console.log(JSON.stringify({ dir, copied, skipped }));
}
