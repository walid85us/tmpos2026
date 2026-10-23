// QA-INTERACTIVE-P1 end-to-end smoke: one ordinary headless Chromium driven through the PUBLIC Preview URL, as the owner
// will use it. CDP is used only to drive and observe (Page, Runtime, Input, Emulation, Network events, DOM/Accessibility
// through cdp.mjs helpers): no Fetch domain, no cookies or headers set, no request or response modified.
// Run: node tests/qa/interactive/smoke.browser.mjs   (against an already running `qa:interactive` session)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERMETIC_ARGS, launch, redact } from '../../browser/cdp.mjs';

const OUT = '/home/runner/workspace/.workflow/qa-interactive-p1/scratch/smoke';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const by = (id) => `[data-testid="${id}"]`;
const q = (id) => `document.querySelector(${JSON.stringify(by(id))})`;
const textOf = (page, id) => page.evaluate(`${q(id)}?.innerText.trim().replace(/\\s+/g, ' ').slice(0, 400) ?? null`);
const offered = (page, id) => page.evaluate(`${q(id)} !== null && ${q(id)}.disabled !== true && ${q(id)}.getAttribute('aria-disabled') !== 'true'`);
const focusOf = (page) => page.evaluate(`document.activeElement?.dataset?.testid || document.activeElement?.id || document.activeElement?.tagName || null`);

// ---- operator CLI (read-only use plus the permitted scenario/release commands) ----
function cli(...args) {
  try {
    return execFileSync('npm', ['run', '--silent', 'qa:interactive', '--', ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `EXIT ${e.status}: ${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
  }
}
const evidence = (...args) => { const t = cli('evidence', ...args); try { return JSON.parse(t); } catch { return t.slice(0, 2000); } };
const status = cli('status');
const runId = /run (qa-\S+?),/.exec(status)?.[1];
const ORIGIN = /Preview: (https:\/\/\S+?)\/?\s/.exec(status)?.[1];
const ids = {};
for (const m of status.matchAll(/^\s+\S+\s+([a-z]+-[a-z0-9-]+)\s+([0-9a-f-]{36})/gm)) ids[m[1]] = m[2];
const label = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
const ACC = Object.fromEntries([...status.matchAll(/^\s+([a-z]+-[ab])\s+(\S+@tmpos-qa\.test)\s+(\S+)/gm)].map((m) => [m[1], { label: m[1], email: m[2], password: m[3] }]));
if (!runId || !ORIGIN || !ids['inv-void'] || !ACC['owner-a']) throw new Error(`status not parsed:\n${status.slice(0, 500)}`);
const HOST = new URL(ORIGIN).host;

// ---- network observation (Network domain events only) ----
const net = [];
function observe(page, tag) {
  const byId = new Map();
  page.on('Network.requestWillBeSent', (e) => {
    if (!/^https?:/.test(e.request.url)) return;
    const u = new URL(e.request.url);
    const rec = { tag, method: e.request.method, host: u.host, path: u.pathname, status: null, failed: null, t: Date.now() };
    byId.set(e.requestId, rec); net.push(rec);
  });
  page.on('Network.responseReceived', (e) => { const r = byId.get(e.requestId); if (r) r.status = e.response.status; });
  page.on('Network.loadingFailed', (e) => { const r = byId.get(e.requestId); if (r) r.failed = e.errorText; });
  return page.send('Network.enable');
}
const nice = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => `<${label[u] ?? 'uuid'}>`);
const api = (from) => net.slice(from).filter((r) => r.host === HOST && r.path.startsWith('/api/v1'))
  .map((r) => `${r.tag} ${r.method} ${nice(r.path)} → ${r.status ?? r.failed ?? 'pending'}`);

// ---- browser ----
const mem = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024;
if (mem < 1200) { console.log(`STOP: MemAvailable ${mem.toFixed(0)} MB < 1200 MB`); process.exit(2); }
// The hermetic flags map every host to NOTFOUND; the public Preview needs ordinary DNS, so that one rule is dropped.
const browser = await launch({ args: HERMETIC_ARGS.filter((a) => !a.startsWith('--host-resolver-rules')) });
const consoleLines = [];
async function newPage(tag, { width = 1280, height = 800 } = {}) {
  const page = await browser.newPage({ width, height });
  page.tag = tag;
  await observe(page, tag);
  return page;
}
/** A second tab in the same browser context (same cookies/storage), built with cdp.mjs's own Page class. */
async function sameContextTab(page, tag) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: page.contextId });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = new page.constructor(browser, sessionId, page.contextId);
  await tab.init(1280, 800, false);
  tab.tag = tag;
  await observe(tab, tag);
  return tab;
}
async function done(...pages) {
  for (const p of pages) { consoleLines.push(...p.logs.map((l) => `${p.tag}: ${redact(l)}`)); await p.close(); }
}
let shots = 0;
async function shot(page, name) { if (shots >= 6) return null; shots += 1; const f = join(OUT, `${shots}-${name}.png`); await page.screenshot(f); return f; }

async function signIn(page, who) {
  await page.goto(`${ORIGIN}/login`, 30_000);
  await page.waitFor(`!!document.querySelector('input[type="email"]')`, 30_000, 'the sign-in form');
  await page.fill('input[type="email"]', who.email);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitFor(`location.pathname === '/'`, 30_000, `${who.label} signed in and left /login`);
}
const go = (page, path) => page.evaluate(`history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`);
const waitData = (page, id, key, value, timeout = 30_000) => page.waitFor(`${q(id)}?.dataset.${key} === ${JSON.stringify(value)}`, timeout, `${id} data-${key}=${value}`);
const setValue = (page, sel, proto, event, value) => page.call(sel, function (p, ev, v) {
  Object.getOwnPropertyDescriptor(window[p].prototype, 'value').set.call(this, v); this.dispatchEvent(new Event(ev, { bubbles: true }));
}, proto, event, value);
async function retype(page, id, text) {
  await page.click(by(id));
  await page.evaluate(`${q(id)}.select()`);
  await page.type(text);
  await page.waitFor(`${q(id)}?.value === ${JSON.stringify(text)}`, 10_000, `${id} reads what was typed`);
}
async function openIssued(page, store) {
  await go(page, '/invoices');
  await page.waitFor(`!!${q('issued-show')}`, 30_000, 'Issued invoices Show');
  await page.click(by('issued-show'));
  await waitData(page, 'issued-stores-state', 'phase', 'ready');
  await setValue(page, by('issued-store'), 'HTMLSelectElement', 'change', store);
}
const openOf = (id) => `${by('issued-row')}[data-id="${id}"] ${by('issued-open')}`;
async function openInvoice(page, id) {
  await page.waitFor(`!!document.querySelector(${JSON.stringify(openOf(id))})`, 30_000, `issued row ${label[id]}`);
  await page.click(openOf(id));
  await page.waitFor(`!!${q('issued-view-total')}`, 30_000, 'the issued invoice dialog');
}
async function openDrafts(page, store) {
  await go(page, '/invoices');
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'Server drafts Show');
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  await setValue(page, by('drafts-store'), 'HTMLSelectElement', 'change', store);
}
async function reopenDraft(page, id) {
  const sel = `${by('drafts-row')}[data-id="${id}"] ${by('drafts-open')}`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 30_000, `draft row ${label[id]}`);
  await page.click(sel);
  await page.waitFor(`!!${q('draft-view-lines')}`, 30_000, 'the reopened draft');
}
/** Void confirmation opened from the issued dialog, a reason chosen by its radio, Void sent. */
async function startVoid(page) {
  await page.waitFor(() => offered(page, 'issued-view-void'), 30_000, 'Void invoice… offered');
  await page.click(by('issued-view-void'));
  await page.waitFor(`!!${q('issued-void-confirm')}`, 30_000, 'the void confirmation');
  await page.click(by('issued-void-reason-issued_in_error'));
  await page.waitFor(`${q('issued-void-reason-issued_in_error')}?.checked === true`, 5_000, 'reason chosen');
  await page.waitFor(() => offered(page, 'issued-void-send'), 15_000, 'Void send offered');
  const from = net.length;
  await page.click(by('issued-void-send'));
  return from;
}
const voidUi = (page) => page.evaluate(`(() => {
  const t = (id) => document.querySelector('[data-testid="' + id + '"]')?.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300) ?? null;
  return { confirmOpen: !!document.querySelector('[data-testid="issued-void-confirm"]'), attempt: document.querySelector('[data-testid="issued-void-attempt"]')?.dataset.state ?? null,
    attemptText: t('issued-void-attempt'), status: t('issued-void-confirm-status'), card: document.querySelector('[data-testid="issued-void-card"]')?.dataset.state ?? null,
    cardText: t('issued-void-card'), viewReason: t('issued-view-void-reason'), voidedAt: t('issued-view-voided-at'), reauth: !!document.querySelector('[data-testid="issued-void-reauth-password"]'),
    reauthHint: t('issued-void-reauth-hint'), alert: t('issued-void-confirm-alert') };
})()`);

// ---- steps ----
const result = { runId, origin: ORIGIN, startedAt: new Date().toISOString(), steps: [] };
// SMOKE_ONLY=10 reruns chosen steps alone (a labelled rerun; its result goes to its own file).
const ONLY = process.env.SMOKE_ONLY ? process.env.SMOKE_ONLY.split(',').map(Number) : null;
if (ONLY) result.rerunOf = ONLY;
async function step(n, title, fn) {
  if (ONLY && !ONLY.includes(n)) return;
  const from = net.length;
  const rec = { n, title, status: 'PASS', notes: [] };
  const t0 = Date.now();
  try { Object.assign(rec, await fn(rec)); } catch (e) { rec.status = rec.status === 'PASS' ? 'FAIL' : rec.status; rec.error = redact(e.message).slice(0, 600); }
  rec.api = api(from);
  rec.ms = Date.now() - t0;
  result.steps.push(rec);
  console.log(`[${n}] ${rec.status} ${title}${rec.error ? ` — ${rec.error.slice(0, 200)}` : ''}`);
}
const check = (rec, ok, note) => { if (!ok) rec.status = 'FAIL'; rec.notes.push(`${ok ? 'ok' : 'NOT OK'}: ${note}`); };
const unique = `QA Smoke ${Date.now().toString(36)}`;

let A; // owner-a context used by steps 1–4
await step(1, 'banner + run id, sign-in owner-a, reload keeps session', async (rec) => {
  A = await newPage('A');
  await A.goto(`${ORIGIN}/login`, 30_000);
  const banner = await A.waitFor(`${q('qa-run-banner')}?.textContent.trim()`, 30_000, 'the QA banner');
  check(rec, banner.includes(runId), `banner "${banner}" contains status run id ${runId}`);
  await signIn(A, ACC['owner-a']);
  await A.settle();
  await A.send('Page.reload', {});
  await sleep(4000);
  await A.waitFor(`document.readyState === 'complete'`, 20_000);
  await sleep(3000);
  const path = await A.evaluate('location.pathname');
  check(rec, path !== '/login', `after reload the page stays at ${path} (not /login)`);
  return { banner, afterReload: path, shot: await shot(A, 'signed-in') };
});

await step(2, 'network hosts and CSP', async (rec) => {
  await sleep(1000);
  const hosts = [...new Set(net.map((r) => r.host))];
  const allowed = (h) => h === HOST || /^(fonts\.googleapis\.com|fonts\.gstatic\.com|i\.pravatar\.cc|picsum\.photos|fastly\.picsum\.photos)$/.test(h);
  const live = hosts.filter((h) => /googleapis|firebase|firestore|gstatic/.test(h) && !/^fonts\.(googleapis|gstatic)\.com$/.test(h));
  check(rec, live.length === 0, `no live Google/Firebase host contacted (${live.join(', ') || 'none'})`);
  check(rec, hosts.every(allowed), `only allowed hosts: ${hosts.join(', ')}`);
  const csp = A.logs.filter((l) => /Content Security Policy|Refused to/i.test(l)).map(redact).slice(0, 10);
  rec.notes.push(`CSP console lines: ${csp.length}`);
  return { hosts, csp };
});

let customerId;
await step(3, 'Customer Directory create/profile/edit/reload/evidence', async (rec) => {
  await go(A, '/customers/directory');
  await A.waitFor(`!!${q('customer-directory')}`, 30_000, 'Customer directory');
  await waitData(A, 'directory-state', 'phase', 'ready');
  await A.fill(by('directory-name'), unique);
  await A.fill(by('directory-phone'), '+1 555 0100');
  await A.fill(by('directory-email'), 'smoke@example.test');
  await A.waitFor(() => offered(A, 'directory-add'), 15_000, 'Add customer enabled');
  await A.click(by('directory-add'));
  await A.waitFor(`!!${q('directory-saved-link')}`, 30_000, 'saved confirmation link');
  const saved = await textOf(A, 'directory-saved');
  await A.click(by('directory-saved-link'));
  await A.waitFor(`!!${q('directory-detail-id')}`, 30_000, 'the profile');
  customerId = (await textOf(A, 'directory-detail-id'))?.match(/[0-9a-f-]{36}/)?.[0];
  label[customerId] = 'smoke-customer';
  await A.click(by('directory-edit'));
  await A.waitFor(`!!${q('directory-edit-phone')}`, 15_000, 'edit form');
  await retype(A, 'directory-edit-phone', '+1 555 0199');
  await A.click(by('directory-edit-save'));
  await A.waitFor(`!${q('directory-edit-phone')} && (${q('directory-detail-phone')}?.textContent ?? '').includes('0199')`, 30_000, 'server-confirmed save shown');
  const afterSave = { status: await textOf(A, 'directory-edit-status'), phone: await textOf(A, 'directory-detail-phone') };
  await A.send('Page.reload', {});
  await A.waitFor(`(${q('directory-detail-phone')}?.textContent ?? '').includes('0199')`, 30_000, 'phone after reload');
  const afterReload = { name: await textOf(A, 'directory-detail-name'), phone: await textOf(A, 'directory-detail-phone'), email: await textOf(A, 'directory-detail-email') };
  const ev = evidence(customerId);
  const row = Array.isArray(ev) ? ev[0] : ev;
  check(rec, JSON.stringify(row).includes('0199') && /row_version/.test(JSON.stringify(row)), 'evidence shows the edited phone and a row_version');
  return { name: unique, customerId, saved, afterSave, afterReload, evidence: row };
});

await step(4, 'Permissions: sales_staff Customers level, refused create as sales-a, restore', async (rec) => {
  const levelsOpen = async (page) => {
    await go(page, '/employees');
    const tab = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Permissions'))`;
    await page.waitFor(`!!${tab}`, 30_000, 'Permissions tab');
    await page.evaluate(`${tab}.setAttribute('data-smoke', 'permissions-tab')`);
    await page.click('[data-smoke="permissions-tab"]');
    await page.waitFor(`!!document.querySelector('[data-testid="server-level-select-sales_staff"]')`, 30_000, 'the server levels panel');
    await page.waitFor(`document.querySelector('[data-testid="server-level-select-sales_staff"]').disabled === false`, 30_000, 'row ready');
  };
  const save = async (level) => {
    await setValue(A, by('server-level-select-sales_staff'), 'HTMLSelectElement', 'change', level);
    await setValue(A, by('server-level-reason-sales_staff'), 'HTMLInputElement', 'input', 'QA smoke check of customer access');
    await A.waitFor(`${q('server-level-save-sales_staff')}?.disabled === false`, 10_000, 'Save enabled');
    await A.click(by('server-level-save-sales_staff'));
    const end = Date.now() + 45_000;
    for (;;) {
      if (await A.evaluate(`!!document.querySelector('[data-testid="server-level-reauth-password"]')`)) {
        rec.notes.push('a recent sign-in was asked for the level save');
        await A.fill(by('server-level-reauth-password'), ACC['owner-a'].password);
        await A.click(by('server-level-reauth-confirm'));
      }
      const s = await textOf(A, 'server-level-status-sales_staff');
      const busy = await A.evaluate(`${q('server-level-select-sales_staff')}?.disabled === true`);
      if (s && !busy && s !== 'Not saved yet.' && !s.startsWith('Saving')) return s;
      if (Date.now() > end) throw new Error(`save of ${level} did not settle (status ${s})`);
      await sleep(250);
    }
  };
  await levelsOpen(A);
  const original = await A.evaluate(`${q('server-level-select-sales_staff')}.value`);
  const target = original === 'view' ? 'none' : 'view';
  const saved = await save(target);
  const readBack = await textOf(A, 'server-level-row-sales_staff');
  check(rec, readBack.includes(target === 'view' ? 'View Only' : 'None'), `read-back row: ${readBack}`);
  const S = await newPage('S');
  let refused;
  try {
    await signIn(S, ACC['sales-a']);
    await go(S, '/customers/directory');
    await S.waitFor(`!!${q('customer-directory')}`, 30_000, 'directory as sales-a');
    await S.waitFor(`['ready','denied','error'].includes(${q('directory-state')}?.dataset.phase) || !!${q('directory-name')} === false`, 30_000, 'directory settled');
    const from = net.length;
    const canType = await S.evaluate(`!!${q('directory-name')} && !${q('directory-name')}.disabled`);
    let addOffered = false;
    if (canType) {
      await S.fill(by('directory-name'), `${unique} sales`);
      await sleep(1000);
      addOffered = await offered(S, 'directory-add');
      if (addOffered) { await S.click(by('directory-add')); await sleep(5000); }
    }
    const posts = net.slice(from).filter((r) => r.tag === 'S' && r.method === 'POST' && r.path === '/api/v1/customers');
    refused = { canType, addOffered, posts: posts.map((r) => r.status), state: await textOf(S, 'directory-state'), page: (await S.evaluate(`${q('customer-directory')}?.innerText.slice(0, 400)`))?.replace(/\s+/g, ' ') };
    check(rec, !posts.some((r) => r.status >= 200 && r.status < 300), `sales-a create not accepted (POST statuses ${JSON.stringify(refused.posts)}, add offered ${addOffered})`);
  } finally { await done(S); }
  const restored = await save(original);
  const restoredRow = await textOf(A, 'server-level-row-sales_staff');
  const ev = evidence();
  return { original, target, saved, readBack, refused, restored, restoredRow, evidence: JSON.stringify(ev).match(/"role[^]*?\}/g)?.slice(0, 6) ?? JSON.stringify(ev).slice(0, 1500) };
});
if (A) await done(A);

await step(5, 'Drafts: stale-tab conflict on draft-edit; discard draft-discard', async (rec) => {
  const T1 = await newPage('T1');
  await signIn(T1, ACC['owner-a']);
  const T2 = await sameContextTab(T1, 'T2');
  try {
    await T2.goto(`${ORIGIN}/`, 30_000);
    const store = ids['store-a-main'];
    for (const t of [T1, T2]) {
      await openDrafts(t, store);
      await reopenDraft(t, ids['draft-edit']);
      await t.waitFor(() => offered(t, 'draft-view-edit'), 30_000, 'Edit offered');
      await t.click(by('draft-view-edit'));
      await t.waitFor(`!!${q('draft-edit')}`, 15_000, 'editor');
    }
    const typeLine = async (t, text) => {
      await t.evaluate(`document.querySelector('${by('draft-edit-line')} ${by('draft-edit-description')}').setAttribute('data-smoke', 'd0')`);
      await t.click('[data-smoke="d0"]');
      await t.evaluate(`document.querySelector('[data-smoke="d0"]').select()`);
      await t.type(text);
    };
    await typeLine(T1, `Smoke tab1 ${Date.now().toString(36)}`);
    await T1.click(by('draft-edit-save'));
    await T1.waitFor(`!${q('draft-edit')} && !!${q('draft-view-saved')}`, 30_000, 'tab 1 saved');
    const tab1 = { saved: await textOf(T1, 'draft-view-saved'), version: await textOf(T1, 'draft-view-version') };
    await typeLine(T2, `Smoke tab2 ${Date.now().toString(36)}`);
    await T2.click(by('draft-edit-save'));
    await T2.waitFor(`${q('draft-edit-conflict')}?.dataset.phase === 'ready' || !!${q('draft-view-saved')}`, 30_000, 'tab 2 answered');
    const tab2 = { conflict: await textOf(T2, 'draft-edit-conflict'), phase: await T2.evaluate(`${q('draft-edit-conflict')}?.dataset.phase ?? null`), saved: await textOf(T2, 'draft-view-saved') };
    check(rec, tab2.phase === 'ready', 'stale tab 2 shows the conflict review');
    // Discard draft-discard in tab 1.
    await T1.click(by('draft-view-close')).catch(() => {});
    await T1.waitFor(`!${q('draft-view')}`, 15_000, 'view closed').catch(() => {});
    await reopenDraft(T1, ids['draft-discard']);
    await T1.waitFor(() => offered(T1, 'draft-discard-open'), 30_000, 'Discard offered');
    await T1.click(by('draft-discard-open'));
    await T1.waitFor(`!!${q('draft-discard-confirm')}`, 15_000, 'discard confirmation');
    const confirmText = await textOf(T1, 'draft-discard-confirm');
    await T1.click(by('draft-discard-send'));
    await T1.waitFor(`!${q('draft-discard-confirm')}`, 30_000, 'discard confirmation closed');
    const notice = await textOf(T1, 'drafts-notice');
    const ev = evidence('draft-edit', 'draft-discard');
    check(rec, JSON.stringify(ev).includes('discarded'), 'evidence shows draft-discard discarded');
    return { tab1, tab2, discard: { confirmText: confirmText?.slice(0, 200), notice }, evidence: ev };
  } finally { await done(T2, T1); }
});

await step(6, 'Issue draft-issue; void inv-void (fresh sign-in)', async (rec) => {
  const P = await newPage('P6');
  try {
    await signIn(P, ACC['owner-a']);
    await openDrafts(P, ids['store-a-main']);
    await reopenDraft(P, ids['draft-issue']);
    await P.waitFor(() => offered(P, 'draft-issue-open'), 30_000, 'Issue invoice… offered');
    await P.click(by('draft-issue-open'));
    await P.waitFor(`!!${q('draft-issue-confirm')}`, 15_000, 'issue confirmation');
    await P.waitFor(() => offered(P, 'draft-issue-send'), 30_000, 'Issue send offered (preview answered)');
    await P.click(by('draft-issue-send'));
    await P.waitFor(`!${q('draft-issue-confirm')}`, 30_000, 'issue confirmation closed');
    const issued = { notice: await textOf(P, 'drafts-notice'), view: await textOf(P, 'issued-view-title') };
    await P.evaluate(`${q('issued-view-close')}?.click()`).catch(() => {}); // only if the app opened the new invoice itself
    await openIssued(P, ids['store-a-main']);
    await openInvoice(P, ids['inv-void']);
    await startVoid(P);
    await P.waitFor(`!${q('issued-void-confirm')} || ${q('issued-void-attempt')}?.dataset.state === 'unresolved' || !!${q('issued-void-reauth-password')}`, 30_000, 'void answered');
    await sleep(1500);
    const ui = await voidUi(P);
    check(rec, !ui.reauth, 'no recent sign-in was asked (fresh sign-in)');
    const ev = evidence('inv-void', 'draft-issue');
    check(rec, JSON.stringify(ev[0] ?? ev).includes('"voided"'), 'evidence: inv-void voided with void row');
    check(rec, JSON.stringify(ev[1] ?? '').includes('issued'), 'evidence: draft-issue issued');
    return { issued, voidUi: ui, evidence: ev };
  } finally { await done(P); }
});

await step(7, 'Held void on inv-held, evidence, Check again', async (rec) => {
  const P = await newPage('P7');
  try {
    await signIn(P, ACC['owner-a']);
    await openIssued(P, ids['store-a-main']);
    await openInvoice(P, ids['inv-held']);
    rec.scenario = cli('scenario', 'held-void', 'inv-held').trim().slice(0, 300);
    await startVoid(P);
    await P.waitFor(`${q('issued-void-attempt')}?.dataset.state === 'unresolved' || !!${q('issued-void-card')} || !${q('issued-void-confirm')}`, 45_000, 'held state shown');
    await sleep(1000);
    const held = await voidUi(P);
    const heldShot = await shot(P, 'held-void');
    const ev = evidence('inv-held');
    check(rec, JSON.stringify(ev).includes('"voided"'), 'evidence inv-held voided while the browser is held');
    const checkBtn = (await P.isVisible(by('issued-void-confirm-check'))) ? 'issued-void-confirm-check' : (await P.isVisible(by('issued-void-check'))) ? 'issued-void-check' : null;
    if (!checkBtn) throw new Error(`no Check again/Check invoice control visible; UI: ${JSON.stringify(held)}`);
    const from = net.length;
    await P.click(by(checkBtn));
    await P.waitFor(async () => net.slice(from).some((r) => r.tag === 'P7' && r.status !== null), 30_000, 'the check answered');
    await sleep(3000);
    const resolved = await voidUi(P);
    // The front records { upstreamStatus, committed } per taken fault, but `status` prints only armed/held/pending.
    const faults = cli('status').split('\n').filter((l) => /^Faults/.test(l)).join(' | ');
    if (!/committed/i.test(faults)) { rec.status = 'PARTIAL'; rec.notes.push(`NOT OBSERVABLE: status prints no committed entry (${faults})`); }
    return { held, heldShot, evidence: ev, pressed: checkBtn, resolved, faults };
  } finally { await done(P); }
});

await step(8, 'Stalled re-auth on inv-stall, Stop waiting, release, no late void', async (rec) => {
  rec.aged = cli('scenario', 'aged-sign-in', 'owner-a').trim().slice(0, 300);
  const P = await newPage('P8');
  try {
    await signIn(P, ACC['owner-a']);
    await openIssued(P, ids['store-a-main']);
    await openInvoice(P, ids['inv-stall']);
    await startVoid(P);
    await P.waitFor(`!!${q('issued-void-reauth-password')}`, 30_000, 'the recent-sign-in prompt');
    const prompt = await voidUi(P);
    rec.stalled = cli('scenario', 'stalled-reauth', 'owner-a').trim().slice(0, 300);
    await P.fill(by('issued-void-reauth-password'), ACC['owner-a'].password);
    await P.click(by('issued-void-reauth-confirm'));
    await sleep(3000);
    const waiting = await voidUi(P);
    const waitShot = await shot(P, 'stalled-reauth-waiting');
    const stopVisible = await P.isVisible(by('issued-void-reauth-stop'));
    if (stopVisible) await P.click(by('issued-void-reauth-stop')); else await sleep(31_000);
    await sleep(1500);
    const stopped = await voidUi(P);
    const releaseAt = Date.now();
    rec.release = cli('release').trim().slice(0, 300);
    await sleep(6000);
    const lateVoid = net.filter((r) => r.tag === 'P8' && r.method === 'POST' && /\/invoices\/[^/]+\/void$/.test(r.path) && r.t >= releaseAt);
    const anyVoidPost = net.filter((r) => r.tag === 'P8' && r.method === 'POST' && /\/void$/.test(r.path)).map((r) => r.status);
    check(rec, lateVoid.length === 0, `no void POST after release (all void POSTs in this context: ${JSON.stringify(anyVoidPost)})`);
    const after = await voidUi(P);
    const ev = evidence('inv-stall');
    check(rec, JSON.stringify(ev).includes('"state": "issued"') || JSON.stringify(ev).includes('"state":"issued"'), 'evidence inv-stall still issued');
    return { prompt, waiting, stopVisible, stopped, after, evidence: ev };
  } finally { await done(P); }
});

await step(9, 'Isolation: owner-b fetches tenant A inv-void detail', async (rec) => {
  const B = await newPage('B');
  try {
    await signIn(B, ACC['owner-b']);
    await openIssued(B, ids['store-b-main']);
    await sleep(2000);
    const path = `/api/v1/stores/${ids['store-a-main']}/invoices/${ids['inv-void']}`;
    const r = await B.evaluate(`fetch(${JSON.stringify(path)}, { credentials: 'same-origin' }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 400) }))`);
    const leaked = [ids['tenant-a'], 'Ada Fictional', 'Northwind', ids['inv-void']].filter((s) => r.body.includes(s));
    const shown = await B.evaluate(`document.body.innerText`);
    const shownLeak = ['Ada Fictional', 'Ben Placeholder', 'Northwind'].filter((s) => shown.includes(s));
    check(rec, r.status >= 400 && leaked.length === 0, `refused ${r.status}, body leaks: ${leaked.join(', ') || 'none'}`);
    check(rec, shownLeak.length === 0, `owner-b page shows no tenant A names (${shownLeak.join(', ') || 'none'})`);
    return { request: nice(path), response: r };
  } finally { await done(B); }
});

await step(10, 'Responsive: issued-invoice dialog controls at 1280/320@24px/768@24px', async (rec) => {
  const P = await newPage('P10');
  const hit = (id) => P.call(by(id), function () {
    this.scrollIntoView({ block: 'center', inline: 'center' });
    const r = this.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const el = document.elementFromPoint(x, y);
    const side = [...document.querySelectorAll('aside, nav')].filter((n) => !n.contains(this) && !this.contains(n)).map((n) => n.getBoundingClientRect())
      .filter((s) => s.width > 0 && s.height > 0 && s.left < r.right && s.right > r.left && s.top < r.bottom && s.bottom > r.top);
    return { inside: !!el && this.contains(el), hit: el ? (el.dataset?.testid || el.tagName) : null, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], sidebarOverlap: side.length > 0, inViewport: r.left >= 0 && r.right <= innerWidth };
  });
  try {
    await signIn(P, ACC['owner-a']);
    await openIssued(P, ids['store-a-main']);
    const cells = [];
    for (const [w, h, font] of [[1280, 800, 16], [320, 640, 24], [768, 1024, 24]]) {
      await P.setViewport(w, h);
      await P.send('Page.setFontSizes', { fontSizes: { standard: font, fixed: Math.round(font * 13 / 16) } });
      await P.settle();
      const cell = { viewport: `${w}x${h}`, font };
      if (!(await P.evaluate(`!!${q('issued-view')}`))) await openInvoice(P, ids['inv-probe']);
      cell.scrollX = await P.evaluate('document.documentElement.scrollWidth > innerWidth');
      // Keyboard: Tab to Void invoice…, Enter opens the confirmation, Enter on Keep (first focus) closes it; Tab to Close, Enter.
      const tabTo = async (id) => { for (let i = 0; i < 60; i += 1) { if ((await focusOf(P)) === id) return i; await P.press('Tab'); } return -1; };
      cell.tabsToVoid = await tabTo('issued-view-void');
      if (cell.tabsToVoid >= 0) {
        await P.press('Enter');
        cell.kbConfirmOpened = await P.waitFor(`!!${q('issued-void-confirm')}`, 10_000).then(() => true, () => false);
        cell.kbFirstFocus = await focusOf(P);
        if (cell.kbFirstFocus === 'issued-void-keep') await P.press('Enter');
        cell.kbConfirmClosed = await P.waitFor(`!${q('issued-void-confirm')}`, 10_000).then(() => true, () => false);
      }
      cell.tabsToClose = await tabTo('issued-view-close');
      if (cell.tabsToClose >= 0) { await P.press('Enter'); cell.kbClosed = await P.waitFor(`!${q('issued-view')}`, 10_000).then(() => true, () => false); }
      // Pointer: reopen, hit-test then a real mouse click on Void invoice…, Keep invoice, Close.
      if (!(await P.evaluate(`!!${q('issued-view')}`))) await openInvoice(P, ids['inv-probe']);
      cell.voidHit = await hit('issued-view-void');
      if (cell.voidHit.inside) {
        await P.click(by('issued-view-void'));
        cell.ptrConfirmOpened = await P.waitFor(`!!${q('issued-void-confirm')}`, 10_000).then(() => true, () => false);
        if (cell.ptrConfirmOpened) {
          cell.keepHit = await hit('issued-void-keep');
          if (cell.keepHit.inside) await P.click(by('issued-void-keep')); else await P.press('Escape');
          cell.ptrConfirmClosed = await P.waitFor(`!${q('issued-void-confirm')}`, 10_000).then(() => true, () => false);
        }
      }
      cell.closeHit = await hit('issued-view-close');
      cell.shot = await shot(P, `issued-view-${w}`);
      if (cell.closeHit.inside) { await P.click(by('issued-view-close')); cell.ptrClosed = await P.waitFor(`!${q('issued-view')}`, 10_000).then(() => true, () => false); }
      const ok = cell.kbClosed && cell.kbConfirmClosed && cell.voidHit.inside && cell.ptrConfirmClosed && cell.closeHit.inside && cell.ptrClosed;
      check(rec, !!ok, `${cell.viewport}@${font}px keyboard+pointer (void ${cell.voidHit.hit}, close ${cell.closeHit.hit}, sidebar overlap void=${cell.voidHit.sidebarOverlap} close=${cell.closeHit.sidebarOverlap})`);
      cells.push(cell);
    }
    const ev = evidence('inv-probe');
    check(rec, JSON.stringify(ev).includes('"state": "issued"') || JSON.stringify(ev).includes('"state":"issued"'), 'inv-probe still issued after the Keep presses');
    return { cells };
  } finally { await done(P); }
});

await browser.close();
result.hosts = [...new Set(net.map((r) => r.host))];
result.cspLines = consoleLines.filter((l) => /Content Security Policy|Refused to/i.test(l)).slice(0, 20);
result.consoleErrors = consoleLines.filter((l) => /error|exception/i.test(l)).slice(0, 30);
result.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, ONLY ? `smoke-result-rerun-${ONLY.join('-')}.json` : 'smoke-result.json'), JSON.stringify(result, null, 2));
console.log(`hosts: ${result.hosts.join(', ')} | CSP lines: ${result.cspLines.length} | written ${OUT}`);
