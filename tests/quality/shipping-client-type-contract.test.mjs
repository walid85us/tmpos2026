// Phase 4.0 M3 — compile-time contract for the Shipping client result type.
//
// THE DEFECT THIS PINS. Every operation used to return `{ success: boolean; data?: … ;
// error?: ProviderError }`, and three of them (`getProvidersStatus`, `getActiveProvider`,
// `getWebhookLog`) made `success` OPTIONAL. Two consequences, both live in this repo:
//
//   1. Success-only payload was readable without proving success. `(await getRates(…)).rates`
//      compiled, so a caller could consume `rates`/`label`/`providers`/`events` from a
//      response that had failed. Every "unavailable rendered as empty" defect fixed by hand
//      in this milestone was an instance of this one type hole.
//   2. `undefined` was neither success nor failure. With `success?: boolean`, the strict test
//      `if (result.success === false)` FAILS OPEN on `undefined` while the loose test
//      `if (!result.success)` fails closed — and this codebase contained both spellings, so
//      the identical condition produced opposite behaviour depending on the call site.
//
// This suite proves the contract with the repository's REAL TypeScript compiler against a
// disposable fixture, not with a grep. A grep cannot tell whether the compiler actually
// rejects an unsafe consumer; only the compiler can, and that is the whole claim.
//
// The fixture derives each operation's type via `Awaited<ReturnType<typeof client.op>>`, so
// it binds to the live exported signatures and cannot drift from an out-of-date local copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLIENT = join(REPO, 'src', 'shipping', 'shippingApiClient.ts');
const TSC = join(REPO, 'node_modules', '.bin', 'tsc');

/** The 17 Shipping client operations the contract must hold for, uniformly. */
const OPERATIONS = [
  'storeProviderCredentials', 'removeProviderCredentials', 'setActiveProvider',
  'getActiveProvider', 'getProvidersStatus', 'testConnection', 'validateAddress',
  'getRates', 'purchaseLabel', 'createProviderPickup', 'buyProviderPickup',
  'cancelProviderPickup', 'syncTracking', 'bulkSyncTracking', 'simulateTrackingEvent',
  'getWebhookLog', 'replayWebhookEvent',
];

const created = [];
test.after(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

/**
 * Compile `files` with the repository's own compiler options.
 * Returns { status, errorLines:Set<number>, out } for the file named `main`.
 */
function compile(files, main) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-type-contract-'));
  created.push(dir);
  const repoOptions = JSON.parse(readFileSync(join(REPO, 'tsconfig.json'), 'utf8')).compilerOptions;
  const tsconfig = {
    compilerOptions: {
      ...repoOptions,
      noEmit: true,
      // The fixture is standalone: no ambient @types, and `@client` resolves to the
      // real module so the contract is checked against shipped source, not a copy.
      types: [],
      baseUrl: dir,
      paths: { '@client': [CLIENT] },
    },
    include: [join(dir, '*.ts')],
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);

  const r = spawnSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.json')], {
    encoding: 'utf8', cwd: dir, timeout: 180000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const errorLines = new Set();
  const re = new RegExp(`${main.replace('.', '\\.')}\\((\\d+),\\d+\\): error`, 'g');
  for (const m of out.matchAll(re)) errorLines.add(Number(m[1]));
  return { status: r.status, errorLines, out };
}

/**
 * Build a source file from numbered lines so an expected compile error can be asserted
 * against an exact line rather than against a substring of the compiler's prose.
 */
function sourceOf(lines) {
  return lines.join('\n') + '\n';
}

/** Shared fixture preamble: binds `R<'op'>` to the live exported signature. */
const PREAMBLE = [
  `import * as client from '@client';`,
  `type Fn = (...a: any[]) => any;`,
  `type R<K extends keyof typeof client> = Awaited<ReturnType<typeof client[K] extends Fn ? typeof client[K] : never>>;`,
];

test('an unnarrowed consumer cannot read success-only data', () => {
  // Negative fixture: EVERY marked line must be rejected by the compiler.
  const header = [
    ...PREAMBLE,
    `declare const rates: R<'getRates'>;`,
    `declare const status: R<'getProvidersStatus'>;`,
    `declare const webhook: R<'getWebhookLog'>;`,
    `declare const active: R<'getActiveProvider'>;`,
    `declare const label: R<'purchaseLabel'>;`,
  ];
  const cases = [
    // success-only payload read WITHOUT proving success
    `void rates.rates;`,
    `void status.providers;`,
    `void status.activeProviderId;`,
    `void webhook.events;`,
    `void webhook.total;`,
    `void active.activeProviderId;`,
    `void label.label;`,
    // failure-only data read WITHOUT proving failure
    `void rates.error;`,
    `void status.error;`,
    // the success branch must not require the caller to interpret an error
    `if (rates.success) { void rates.error; }`,
    // the failure branch must not expose success-only data
    `if (rates.success === false) { void rates.rates; }`,
    `if (status.success === false) { void status.providers; }`,
    `if (webhook.success === false) { void webhook.events; }`,
    // NEGATED TRUTHINESS DOES NOT NARROW without strictNullChecks, which this project does
    // not enable. Pinned deliberately: `if (!r.success)` is the intuitive spelling, and a
    // future edit that "simplifies" `=== false` into it must fail to compile rather than
    // silently stop narrowing. If this line ever stops erroring, strictNullChecks was
    // turned on and the narrowing guidance in shippingApiClient.ts should be revisited.
    `if (!rates.success) { void rates.error; }`,
    // `success` must not be omittable — it is the discriminant
    `const a: R<'getProvidersStatus'> = { providers: [], activeProviderId: null };`,
    `const b: R<'getWebhookLog'> = { events: [], total: 0 };`,
    `const c: R<'getActiveProvider'> = { activeProviderId: null };`,
  ];
  const src = sourceOf([...header, ...cases]);
  const firstCaseLine = header.length + 1;

  const { errorLines, out } = compile({ 'negative.ts': src }, 'negative.ts');

  const notRejected = cases
    .map((c, i) => ({ c, line: firstCaseLine + i }))
    .filter(({ line }) => !errorLines.has(line));

  assert.deepEqual(
    notRejected.map(({ c }) => c),
    [],
    `the compiler must reject each of these unsafe consumers:\n${out}`,
  );
});

test('properly narrowed success and failure consumers compile cleanly', () => {
  // Positive fixture: the contract must not be so strict that correct code cannot be
  // written. Zero errors required — otherwise the union would just be unusable.
  const src = sourceOf([
    ...PREAMBLE,
    `declare const rates: R<'getRates'>;`,
    `declare const status: R<'getProvidersStatus'>;`,
    `declare const webhook: R<'getWebhookLog'>;`,
    `declare const active: R<'getActiveProvider'>;`,
    // narrowed success consumer
    `if (rates.success) { void rates.rates; }`,
    `if (status.success) { void status.providers; void status.activeProviderId; }`,
    `if (webhook.success) { void webhook.events; void webhook.total; }`,
    `if (active.success) { void active.activeProviderId; }`,
    // narrowed failure consumer — `error` is present, not optional
    `if (rates.success === false) { const code: string = rates.error.code; void code; }`,
    `if (status.success === false) { const m: string = status.error.message; void m; }`,
    // early-return narrowing, the exact shape every migrated call site uses
    `function consume(r: R<'getRates'>): number { if (r.success === false) { void r.error.code; return -1; } return r.rates.length; }`,
    `void consume;`,
    // the `else` of a `=== false` test is the success branch, with payload readable
    `if (rates.success === false) { void rates.error; } else { void rates.rates; }`,
  ]);

  const { status, errorLines, out } = compile({ 'positive.ts': src }, 'positive.ts');
  assert.deepEqual([...errorLines], [], `narrowed consumers must compile:\n${out}`);
  assert.equal(status, 0, `tsc must exit 0 for the positive fixture:\n${out}`);
});

test('every one of the 17 operations returns a required `success` discriminant', () => {
  // A per-operation check, so a future operation added without the discriminant cannot
  // slip in behind the representative sample used above.
  const header = [
    ...PREAMBLE,
    // `{} extends Pick<T,'success'>` is true only when the property is OPTIONAL, and it
    // is independent of strictNullChecks — which this repository does not enable.
    `type Req<T> = [T] extends [{ success: boolean }] ? ({} extends Pick<T, 'success'> ? false : true) : false;`,
    `type Assert<T extends true> = T;`,
  ];
  // Each line must COMPILE; `Req` is `false` when the discriminant is missing or
  // optional, and `Assert<false>` is a compile error.
  const cases = OPERATIONS.map((op) => `type _${op} = Assert<Req<R<'${op}'>>>;`);
  const src = sourceOf([...header, ...cases]);

  const { errorLines, out } = compile({ 'discriminant.ts': src }, 'discriminant.ts');
  const firstCaseLine = header.length + 1;
  const failing = OPERATIONS.filter((_, i) => errorLines.has(firstCaseLine + i));

  assert.deepEqual(failing, [], `these operations lack a required \`success\` discriminant:\n${out}`);
  assert.equal(OPERATIONS.length, 17, 'the operation inventory must stay at 17');
});

test('the client is still network-free and returns a bounded unavailable code', () => {
  // The type contract must not be satisfied by reintroducing a real network call.
  const source = readFileSync(CLIENT, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(/\bfetch\s*\(/.test(code), false, 'the shipping client must make zero fetch calls');
  assert.equal(
    /\bXMLHttpRequest\b|\bnavigator\.sendBeacon\b|\bnew\s+WebSocket\b|\bEventSource\b/.test(code), false,
    'no alternative browser egress channel may appear in the shipping client',
  );
  assert.match(source, /SHIPPING_UNAVAILABLE_CODE\s*=\s*'SHIPPING_UNAVAILABLE'/);
});
