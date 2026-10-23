// QA-INTERACTIVE-P1 — the QA bundle's build: the unchanged application (index.html, src/) with exactly two modules
// swapped by resolved path, src/firebase.ts and firebase-applet-config.json, for the QA initializer and demo config.
// Not the production artifact: it is written to the QA run directory, never dist/. The launcher passes the values below
// in a scoped environment; nothing is read from .env files (envDir points at this directory, which holds none).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SWAPS = new Map([
  [path.join(ROOT, 'src/firebase.ts'), path.join(HERE, 'qaFirebase.ts')],
  [path.join(ROOT, 'firebase-applet-config.json'), path.join(HERE, 'qa-firebase-config.json')],
]);

function qaSwaps(): Plugin {
  return {
    name: 'tmpos-qa-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved === null ? null : (SWAPS.get(resolved.id) ?? null);
    },
  };
}

function required(name: string, pattern: RegExp): string {
  const value = process.env[name] ?? '';
  if (!pattern.test(value)) throw new Error(`vite.qa.config: ${name} is missing or malformed`);
  return value;
}

export default defineConfig(() => {
  const origin = required('QA_PUBLIC_ORIGIN', /^https:\/\/[a-z0-9.-]+$/);
  const projectId = required('QA_PROJECT_ID', /^demo-[a-z0-9-]{1,40}$/);
  const runId = required('QA_RUN_ID', /^[a-z0-9-]{4,40}$/);
  const outDir = required('QA_OUT_DIR', /^\/\S+$/);
  const cacheDir = required('QA_CACHE_DIR', /^\/\S+$/);
  return {
    root: ROOT,
    envDir: HERE,
    cacheDir,
    plugins: [qaSwaps(), react(), tailwindcss()],
    define: { __TMPOS_QA__: JSON.stringify({ origin, host: new URL(origin).host, projectId, runId }) },
    resolve: { alias: { '@': ROOT } },
    build: { outDir, emptyOutDir: true },
  };
});
