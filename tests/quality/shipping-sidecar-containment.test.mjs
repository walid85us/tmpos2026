// Phase 4.0 M3 — legacy Shipping sidecar elimination: structural containment.
//
// The DEV Shipping sidecar (server/index.ts) exposed 22 unauthenticated routes
// including an arbitrary-URL label proxy (full-read SSRF), unauthenticated
// carrier-credential create/read/delete, active-provider mutation, real
// provider calls that spend money, webhook ingest/replay, and unauthenticated
// durable filesystem writes. It is DELETED, not firewalled: it had no importer
// and no test, and production ships a static SPA with no Node process, so
// elimination is strictly smaller and leaves no residual attack surface.
//
// This suite is the regression guard. It proves the sidecar cannot come back by
// accident — the sources are gone, nothing imports them, the Vite proxy no
// longer bridges a browser to them, the dev script no longer starts them, and no
// replacement request-controlled outbound fetch was introduced anywhere in
// server/. Rebuild belongs to M7e against the M6 encrypted-credential standard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** The eliminated sidecar cluster. server/types.ts is included because a fresh
 *  scan proved every importer was one of the other six files. */
const DELETED_FILES = [
  'server/index.ts',
  'server/credential-store.ts',
  'server/event-processor.ts',
  'server/adapters/easypost.ts',
  'server/adapters/shippo.ts',
  'server/adapters/shipstation.ts',
  'server/types.ts',
];

/** Specifier fragments that must no longer resolve from any tracked source. */
const DELETED_SPECIFIERS = [
  'credential-store',
  'event-processor',
  'adapters/easypost',
  'adapters/shippo',
  'adapters/shipstation',
];

/** Tracked source files, via git so node_modules/dist/.cache are never walked.
 *  Filtered to what exists on disk: `git ls-files` reports the index, which still
 *  lists a deleted file until the deletion is staged. */
function trackedSources(...prefixes) {
  const out = execFileSync('git', ['ls-files', '-z', ...prefixes], { cwd: REPO, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p))
    .filter((p) => existsSync(join(REPO, p)));
}

const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Drop comments so a denylist never trips on prose that merely NAMES what was
 *  removed. Documenting "do not reintroduce /api/shipping" is the opposite of
 *  reintroducing it. */
function stripComments(src) {
  // The `//` must not be preceded by `:` (a URL scheme) NOR by a quote/backtick — otherwise
  // a protocol-relative or concatenated string literal such as `base + '//api/shipping/...'`
  // is treated as a line comment and DELETED, erasing the very token the denylists below
  // search for. That turned comment-stripping into a bypass of this whole suite.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Static AND dynamic import/require specifiers referenced by a source file. */
function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

test('the legacy Shipping sidecar source files are absent', () => {
  for (const f of DELETED_FILES) {
    assert.equal(existsSync(join(REPO, f)), false, `${f} must be deleted`);
  }
  // safe-log is shared with platform-identity/bcp-pilot and must survive.
  assert.ok(existsSync(join(REPO, 'server', 'safe-log.ts')), 'server/safe-log.ts must be retained');
});

test('Vite exposes no /api/shipping proxy and keeps the identity proxy intact', () => {
  const cfg = stripComments(read('vite.config.ts'));
  assert.ok(!cfg.includes('/api/shipping'), 'the /api/shipping dev proxy must be removed');
  assert.ok(!cfg.includes('localhost:5001'), 'no proxy may target the legacy sidecar port');
  assert.ok(cfg.includes('/__identity'), 'the identity proxy must be preserved');
  assert.ok(cfg.includes('localhost:5002'), 'the identity proxy target must be preserved');
});

test('the development script starts no legacy sidecar; the compiled runtime is untouched', () => {
  const pkg = JSON.parse(read('package.json'));
  const dev = pkg.scripts.dev;
  assert.ok(!/server\/index\.ts/.test(dev), 'dev must not start the deleted sidecar');
  assert.ok(/\bvite\b/.test(dev), 'dev must still start Vite');
  assert.match(pkg.scripts['build:server'], /tsconfig\.server\.json/, 'compiled server build preserved');
  assert.match(pkg.scripts.start, /dist-server\//, 'compiled runtime start preserved');
  for (const s of Object.values(pkg.scripts)) {
    assert.ok(!/server\/index\.ts/.test(s), `no script may reference the deleted sidecar: ${s}`);
  }
});

test('no tracked source imports a deleted module, statically or dynamically', () => {
  for (const f of trackedSources('server', 'src', 'tests', 'scripts')) {
    // This suite necessarily names the deleted paths as denylist strings.
    if (f.endsWith('tests/quality/shipping-sidecar-containment.test.mjs')) continue;
    // The runtime-contract suite carries the same denylist by design.
    if (f.endsWith('tests/quality/production-runtime-contract.test.mjs')) continue;
    const src = read(f);
    for (const spec of importSpecifiers(src)) {
      for (const bad of DELETED_SPECIFIERS) {
        assert.ok(!spec.includes(bad), `${f}: imports deleted module '${spec}'`);
      }
      assert.ok(!/(^|\/)server\/(index|types)(\.js|\.ts)?$/.test(spec), `${f}: imports deleted '${spec}'`);
    }
  }
});

test('no label-proxy route or label-proxy URL construction remains anywhere', () => {
  for (const f of trackedSources('server', 'src')) {
    assert.ok(!stripComments(read(f)).includes('label-proxy'), `${f}: label-proxy reference must be gone`);
  }
});

test('no source performs a legacy /api/shipping request', () => {
  for (const f of trackedSources('server', 'src')) {
    assert.ok(!stripComments(read(f)).includes('/api/shipping'), `${f}: legacy Shipping API path must be gone`);
  }
});

test('no server module performs an outbound fetch — no arbitrary-fetch replacement', () => {
  // The eliminated cluster held every outbound call in server/ (18 fixed-host
  // adapter calls + the request-controlled label proxy). Zero is the invariant:
  // it fails closed if any replacement egress helper is reintroduced here.
  for (const f of trackedSources('server')) {
    if (f.endsWith('.test.ts') || f.endsWith('.test.mts')) continue; // denylist string literals
    const src = stripComments(read(f));
    assert.ok(!/\bfetch\s*\(/.test(src), `${f}: server code must perform no outbound fetch`);
    assert.ok(!/\breq\.query\.url\b/.test(src), `${f}: request-controlled URL must not be fetched`);
    // A replacement egress helper need not use fetch(); these are the other ways out.
    for (const spec of importSpecifiers(src)) {
      assert.ok(!/^(?:node:)?(?:https?|net|tls|dgram)$/.test(spec) || f.includes('runtime/'),
        `${f}: non-runtime server code must not import the network module '${spec}'`);
      assert.ok(!/^(?:undici|axios|node-fetch|got|superagent|request)$/.test(spec),
        `${f}: HTTP client dependency '${spec}' reintroduces egress`);
    }
  }
});

test('the compiled runtime still mounts zero Shipping business routes', () => {
  const scanned = [];
  for (const f of trackedSources('server/runtime')) {
    if (f.endsWith('.test.ts')) continue;
    scanned.push(f);
    const code = stripComments(read(f)).toLowerCase();
    for (const bad of ['shipping', 'carrier', 'label-proxy', 'credential']) {
      assert.ok(!code.includes(bad), `${f}: compiled runtime must not reference '${bad}'`);
    }
  }
  // Without this the whole test passes over an empty scan set.
  assert.ok(scanned.includes('server/runtime/app.ts'), 'the runtime app module must be scanned');
});

test('the Shipping client performs no network call at all', () => {
  const client = stripComments(read('src/shipping/shippingApiClient.ts'));
  assert.ok(!/\bfetch\s*\(/.test(client), 'the client must not call fetch');
  assert.ok(!/XMLHttpRequest|EventSource|navigator\.sendBeacon/.test(client), 'no alternate transport');
  assert.ok(client.includes('SHIPPING_UNAVAILABLE'), 'the client must return the bounded unavailable code');
});

test('no label artifact URL is reconstructed or opened in the browser', () => {
  // `pdfUrl` was only ever populated from the eliminated label proxy, and the
  // print/view controls opened `pdfUrl || label.url` — i.e. a provider-controlled
  // URL. Owner ruling: neither is an acceptable substitute, so both are gone and
  // the surface shows a bounded unavailable state until M7e.
  const sc = stripComments(read('src/components/ShippingCenter.tsx'));
  assert.ok(!/\bpdfUrl\s*[:=][^=]/.test(sc), 'pdfUrl must never be assigned or set as a property');
  assert.ok(
    !/window\.open\s*\([^)]*(label|pdfUrl|primaryUrl|\.url)/.test(sc),
    'no provider-controlled label URL may be opened',
  );
  assert.ok(sc.includes('label-preview-unavailable'), 'a bounded label-preview unavailable state must exist');
});

/** Identifiers that hold a provider-controlled label URL anywhere in the frontend. */
const LABEL_URL_IDENTIFIERS = /\b(labelUrl|returnLabelUrl|labelPdfUrl|pdfUrl)\b|\blabel\s*(\?\.|\.)\s*url\b/;

/**
 * Browser-fetching sinks, as (name, extractor) pairs. Each extractor yields the expression
 * text the sink would act on, so the identifier check runs against the ARGUMENT rather than
 * the whole file — otherwise merely reading `shipment.labelUrl` to decide whether to render
 * an unavailable notice would trip the guard.
 */
const SINK_PATTERNS = [
  ['href attribute', /\bhref\s*=\s*\{([^}]*)\}/g],
  ['src attribute', /\bsrc\s*=\s*\{([^}]*)\}/g],
  ['srcSet attribute', /\bsrcSet\s*=\s*\{([^}]*)\}/g],
  ['srcDoc attribute', /\bsrcDoc\s*=\s*\{([^}]*)\}/g],
  ['download attribute', /\bdownload\s*=\s*\{([^}]*)\}/g],
  ['data attribute', /\bdata\s*=\s*\{([^}]*)\}/g],
  ['poster attribute', /\bposter\s*=\s*\{([^}]*)\}/g],
  // react-router <Link to={…}> and <Navigate to={…}> render a real anchor.
  ['router to attribute', /\bto\s*=\s*\{([^}]*)\}/g],
  ['form action attribute', /\b(?:formAction|action)\s*=\s*\{([^}]*)\}/g],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML\s*=\s*\{([\s\S]{0,400}?)\}\s*\}/g],
  // Non-JSX property assignment: `img.src = u`, `a.href = u`, `new Image().src = u`.
  ['DOM property assignment', /\.\s*(?:src|href|srcset|action|data)\s*=\s*([^;\n]*)/g],
  // JSX spread carrying a sink: `<a {...{ href: labelUrl }}>`.
  ['object-literal sink key', /\b(?:href|src|srcDoc|action|poster)\s*:\s*([^,}\n]*)/g],
  ['window.open', /window\.open\s*\(([^;]*?)\)/g],
  ['location assignment', /(?:window\.)?location(?:\.href)?\s*=\s*([^;\n]*)/g],
  ['location.assign/replace', /location\.(?:assign|replace)\s*\(([^;]*?)\)/g],
  ['fetch', /\bfetch\s*\(([^;]*?)\)/g],
  ['alternate transport', /\b(?:XMLHttpRequest|EventSource|WebSocket)\s*\(([^;]*?)\)/g],
  ['sendBeacon', /sendBeacon\s*\(([^;]*?)\)/g],
  ['dynamic import', /\bimport\s*\(([^;]*?)\)/g],
  ['CSS url()', /url\((\s*[^)]*)\)/g],
  ['createObjectURL', /createObjectURL\s*\(([^;]*?)\)/g],
];

/**
 * Local aliases of a label URL, e.g. `const labelUrl = shipment.returnInfo?.returnLabelUrl`.
 * Without this an alias defeats the whole sink check: the file still MENTIONS a label
 * identifier so it is scanned, but `href={u}` names none of them and passes. ReturnsPortal
 * already creates exactly such an alias.
 */
function aliasIdentifiers(src) {
  const decls = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) decls.push([m[1], m[2]]);

  // Transitive closure. A single pass caught `const a = labelUrl` but not the second
  // hop `const b = a`, so `href={b}` slipped through — the alias only has to be
  // laundered once more to defeat a single-pass check. Iterate to a fixed point.
  const names = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, rhs] of decls) {
      if (names.has(name)) continue;
      const carries =
        LABEL_URL_IDENTIFIERS.test(rhs) ||
        [...names].some((a) => new RegExp(`\\b${a}\\b`).test(rhs));
      if (carries) { names.add(name); changed = true; }
    }
  }
  return names;
}

test('no frontend Shipping/Returns surface routes a provider label URL into a browser sink', () => {
  // Phase 4.0 M3 — the original guard covered ShippingCenter.tsx only, so the two
  // ReturnsPortal links (`returnInfo.returnLabelUrl` in the detail panel and the
  // label-delivery modal) sat outside it. The invariant is repo-wide: no provider-
  // controlled label URL may reach a sink from ANY frontend surface.
  const scanned = [];
  for (const f of trackedSources('src')) {
    if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue; // fixtures hold sentinel URLs
    const src = stripComments(read(f));
    if (!LABEL_URL_IDENTIFIERS.test(src)) continue;
    scanned.push(f);
    const aliases = aliasIdentifiers(src);
    const carriesLabelUrl = (expr) =>
      LABEL_URL_IDENTIFIERS.test(expr) || [...aliases].some((a) => new RegExp(`\\b${a}\\b`).test(expr));
    for (const [sinkName, re] of SINK_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        assert.ok(
          !carriesLabelUrl(m[1]),
          `${f}: ${sinkName} receives a provider label URL: ${m[1].trim().slice(0, 80)}`,
        );
      }
    }
  }
  // Positive control, by NAME. A bare count was satisfied by src/types.ts (which matches
  // only through type declarations), so it tolerated the silent loss of a real surface.
  for (const required of ['src/components/ShippingCenter.tsx', 'src/components/ReturnsPortal.tsx']) {
    assert.ok(scanned.includes(required), `${required} must still be scanned for label-URL sinks`);
  }
});

test('no module reachable from the Shipping client performs a network call', () => {
  // `shippingApiClient.ts` re-exports the locator adapters, so asserting only on that one
  // file left `src/shipping/locators/**` — scaffolded for live carrier endpoints — as an
  // unscanned egress path through the Shipping client's own export surface.
  const scanned = [];
  for (const f of trackedSources('src/shipping')) {
    if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
    scanned.push(f);
    const src = stripComments(read(f));
    assert.ok(!/\bfetch\s*\(/.test(src), `${f}: must perform no outbound fetch`);
    assert.ok(
      !/\b(?:XMLHttpRequest|EventSource|WebSocket)\s*\(|navigator\.sendBeacon/.test(src),
      `${f}: no alternate transport`,
    );
  }
  // The locator adapters are the reason this test exists — assert they were reached.
  assert.ok(scanned.includes('src/shipping/shippingApiClient.ts'), 'the Shipping client must be scanned');
  assert.ok(scanned.some((f) => f.startsWith('src/shipping/locators/')),
    'the locator adapters re-exported by the client must be scanned');
});

test('every frontend label-unavailable surface uses words plus an icon, not colour alone', () => {
  const surfaces = [
    ['src/components/ShippingCenter.tsx', 'label-preview-unavailable'],
    ['src/components/ReturnsPortal.tsx', 'return-label-unavailable'],
    ['src/components/ReturnsPortal.tsx', 'return-label-unavailable-share'],
    ['src/components/ShippingProvidersPage.tsx', 'shipping-service-unavailable'],
  ];
  for (const [file, testId] of surfaces) {
    const src = stripComments(read(file));
    const idx = src.indexOf(`data-testid="${testId}"`);
    assert.ok(idx !== -1, `${file}: missing unavailable surface ${testId}`);
    // The element and its children, bounded to the following ~600 chars of markup.
    const block = src.slice(idx, idx + 600);
    assert.match(block, /material-symbols-outlined/, `${testId}: must carry an icon`);
    assert.match(block, /unavailable/i, `${testId}: must say so in words`);
    assert.match(block, /role="(status|alert)"/, `${testId}: needs a status/alert semantic`);
  }
});
