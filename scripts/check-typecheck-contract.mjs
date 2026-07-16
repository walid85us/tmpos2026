#!/usr/bin/env node
// Phase 4.0 M2 — typecheck contract checker (gate diagnostic, permanent).
//
// The typecheck ratchet is only meaningful if it always compiles THIS repository's
// tsconfig.json with the React type declarations actually present. Two ways that
// silently degrades:
//   1. tsc selects a different config (it walks parent directories when a config is
//      not pinned at the invocation origin), so the effective options are not ours.
//   2. @types/react / @types/react-dom are missing, so every JSX element degrades to
//      `any` and the suite reports zero errors while checking nothing.
// This checker makes the effective contract explicit and fails closed on both.
//
// It resolves the repository from THIS FILE's location (never the caller's cwd), so a
// nested working directory or an unrelated parent tsconfig cannot influence it.
//
// Output is deliberately bounded: versions, the repository-relative config path,
// booleans and enum names only. Never the file list, environment, source values,
// identifiers, credentials, or any absolute path.
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** True only when `target` is inside `root` (never equal to, never escaping it). */
export function isInsideRepo(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Inspect the effective typecheck contract for `repoRoot`.
 * Returns { ok, problems[], summary{} } — never throws for the expected failures.
 */
export function inspectTypecheckContract(repoRoot = REPO_ROOT) {
  const problems = [];
  const tsconfigPath = join(repoRoot, 'tsconfig.json');

  // The selected config must be the repository's own, and must not escape it.
  if (!isInsideRepo(repoRoot, tsconfigPath)) {
    problems.push('selected tsconfig escapes the repository root');
  }
  if (!existsSync(tsconfigPath)) {
    problems.push('repository tsconfig.json not found');
    return { ok: false, problems, summary: null };
  }

  // Use the LOCALLY installed TypeScript, resolved from the repository — not a global
  // or ambient copy, so the reported version is the one the gate actually runs.
  const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
  let ts;
  try {
    ts = requireFromRepo('typescript');
  } catch {
    problems.push('locally installed typescript package not resolvable from the repository');
    return { ok: false, problems, summary: null };
  }

  const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (readResult.error) {
    problems.push('repository tsconfig.json could not be parsed');
    return { ok: false, problems, summary: null };
  }
  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, repoRoot, undefined, tsconfigPath);
  const o = parsed.options || {};

  // React type declarations must be present, or JSX silently becomes `any` and the
  // ratchet passes while checking nothing.
  const typesDir = join(repoRoot, 'node_modules', '@types');
  const reactTypes = existsSync(join(typesDir, 'react', 'index.d.ts'));
  const reactDomTypes = existsSync(join(typesDir, 'react-dom', 'index.d.ts'));
  if (!reactTypes) problems.push('@types/react is not installed — JSX would be implicitly any');
  if (!reactDomTypes) problems.push('@types/react-dom is not installed');

  const enumName = (obj, val) => {
    const hit = Object.keys(obj).find((k) => obj[k] === val && Number.isNaN(Number(k)) === true);
    return hit || String(val ?? 'default');
  };

  const summary = {
    typescript: ts.version,
    selectedConfig: relative(repoRoot, tsconfigPath) || 'tsconfig.json',
    strict: Boolean(o.strict),
    noImplicitAny: Boolean(o.noImplicitAny ?? o.strict),
    strictNullChecks: Boolean(o.strictNullChecks ?? o.strict),
    moduleResolution: enumName(ts.ModuleResolutionKind, o.moduleResolution),
    jsx: enumName(ts.JsxEmit, o.jsx),
    reactTypesPresent: reactTypes,
    reactDomTypesPresent: reactDomTypes,
  };

  return { ok: problems.length === 0, problems, summary };
}

/** Bounded, tool-agnostic rendering. Booleans / enum names / versions only. */
export function formatSummary(summary) {
  return [
    `typescript          ${summary.typescript}`,
    `selected config     ${summary.selectedConfig}`,
    `strict              ${summary.strict}`,
    `noImplicitAny       ${summary.noImplicitAny}`,
    `strictNullChecks    ${summary.strictNullChecks}`,
    `moduleResolution    ${summary.moduleResolution}`,
    `jsx                 ${summary.jsx}`,
    `@types/react        ${summary.reactTypesPresent}`,
    `@types/react-dom    ${summary.reactDomTypesPresent}`,
  ].join('\n');
}

export function runContractCheck(repoRoot = REPO_ROOT) {
  const { ok, problems, summary } = inspectTypecheckContract(repoRoot);
  if (summary) console.log(formatSummary(summary));
  for (const p of problems) console.error(`typecheck-contract: ${p}`);
  if (!ok) {
    console.error('typecheck-contract: FAILED');
    return 1;
  }
  // `strict` being false is the committed posture, not a failure. Report it honestly
  // rather than gating on it; adopting full strict mode is separate, future work.
  console.log('typecheck-contract: OK');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runContractCheck());
}
