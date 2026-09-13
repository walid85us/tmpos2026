// Minimal Chrome DevTools Protocol driver over --remote-debugging-pipe.
// Chromium reads commands on fd 3 and writes responses/events on fd 4, NUL-delimited JSON.
// No ports, no WebSocket, no dependencies.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HERMETIC_ARGS = [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
  '--disable-default-apps', '--disable-domain-reliability', '--metrics-recording-only',
  '--host-resolver-rules=MAP * ~NOTFOUND',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Strip query strings (the Firebase web API key rides in `?key=`), API-key-shaped values and
 * project identifiers that ride in Firebase hostnames or resource paths.
 */
export function redact(value) {
  return String(value)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]*)\?[^\s"'<>#]*/gi, '$1?<redacted>')
    .replace(/([?&]key=)[^&\s"'<>]*/gi, '$1<redacted>')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted>')
    .replace(/\b[a-z0-9-]+\.(firebaseapp\.com|web\.app)\b/gi, '<project>.$1')
    .replace(/\/projects\/[^/\s"'<>]+/g, '/projects/<redacted>');
}

export function findChromium() {
  for (const p of [process.env.CHROMIUM_PATH, '/repl/tools/bin/chromium']) if (p && existsSync(p)) return p;
  try {
    return execFileSync('which', ['chromium'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export async function launch({ executable = findChromium(), args = HERMETIC_ARGS } = {}) {
  if (!executable) throw new Error('Chromium not found');
  const profile = mkdtempSync(join(tmpdir(), 'tmpos-cdp-'));
  const proc = spawn(executable, [...args, `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const browser = new Browser(proc, profile);
  try {
    await browser.send('Browser.getVersion', {}, undefined, 15_000); // proves the pipe is live
  } catch (e) {
    await browser.close();
    throw new Error(redact(`Chromium did not answer on the pipe: ${e.message}\n${browser.stderr.slice(-2000)}`));
  }
  return browser;
}

class Browser {
  #id = 0;
  #pending = new Map();
  #listeners = new Set();
  #buf = Buffer.alloc(0);

  constructor(proc, profile) {
    this.proc = proc;
    this.profile = profile;
    this.stderr = '';
    this.interceptErrors = [];
    this.exited = new Promise((r) => proc.once('exit', r));
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-20_000); });
    proc.stdio[3].on('error', () => {});
    proc.stdio[4].on('error', () => {});
    proc.stdio[4].on('data', (chunk) => this.#onData(chunk));
    proc.once('exit', () => {
      for (const p of this.#pending.values()) p.reject(new Error(`${p.method}: Chromium exited`));
      this.#pending.clear();
    });
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    let i;
    while ((i = this.#buf.indexOf(0)) !== -1) {
      const msg = JSON.parse(this.#buf.subarray(0, i).toString('utf8'));
      this.#buf = this.#buf.subarray(i + 1);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(redact(`${p.method}: ${msg.error.message}`)));
        else p.resolve(msg.result);
      } else {
        for (const l of [...this.#listeners]) {
          if (l.method === msg.method && (l.sessionId === undefined || l.sessionId === msg.sessionId)) l.fn(msg.params, msg.sessionId);
        }
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method}: timed out`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      this.proc.stdio[3].write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0');
    });
  }

  /** Subscribe to an event; sessionId undefined = every session. Returns an unsubscribe function. */
  on(method, fn, sessionId) {
    const l = { method, fn, sessionId };
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /**
   * Browser-wide Fetch interception at Request stage. Every paused request gets exactly one answer:
   * handler returns {status, headers, body} -> fulfill; {continue: true} -> continue; anything else
   * (or a throw) -> failRequest BlockedByClient.
   */
  async intercept(handler) {
    this.on('Fetch.requestPaused', async (ev) => {
      let res = null;
      try { res = await handler(ev); } catch (e) { this.interceptErrors.push(redact(e?.stack ?? e)); }
      const { requestId } = ev;
      try {
        if (res?.continue) await this.send('Fetch.continueRequest', { requestId });
        else if (res) {
          const headers = Array.isArray(res.headers) ? res.headers : Object.entries(res.headers ?? {});
          await this.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: res.status ?? 200,
            responseHeaders: headers.map(([name, value]) => ({ name, value: String(value) })),
            ...(res.body != null && res.body !== '' ? { body: Buffer.from(res.body).toString('base64') } : {}),
          });
        } else await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } catch { /* request already gone (navigation / abort) */ }
    });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  /** New isolated browser context + page, attached with a flattened session. */
  async newPage({ width = 1440, height = 900, mobile = false } = {}) {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, browserContextId);
    await page.init(width, height, mobile);
    return page;
  }

  async close() {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      await Promise.race([this.send('Browser.close', {}, undefined, 5000).catch(() => {}), this.exited]);
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
      await Promise.race([this.exited, sleep(5000)]);
    }
    // Chromium's helpers can still be flushing into the profile just after exit; retry, don't fail the run.
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
const describe = (t) => (typeof t === 'string' ? t : `${t.role} "${t.name}"`);
const VISIBLE_FN = `function () {
  const r = this.getBoundingClientRect(), s = getComputedStyle(this);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0 &&
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}`;

class Page {
  constructor(browser, sessionId, contextId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.contextId = contextId;
    this.logs = []; // raw console / log / exception text (redact before printing)
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }
  on(method, fn) { return this.browser.on(method, fn, this.sessionId); }

  async init(width, height, mobile) {
    const arg = (a) => (a.value !== undefined ? JSON.stringify(a.value) : a.preview ? JSON.stringify(a.preview) : a.description ?? '');
    this.on('Runtime.consoleAPICalled', (e) => this.logs.push(`console.${e.type}: ${e.args.map(arg).join(' ')}`));
    this.on('Runtime.exceptionThrown', (e) => this.logs.push(`exception: ${e.exceptionDetails.exception?.description ?? e.exceptionDetails.text}`));
    this.on('Log.entryAdded', (e) => this.logs.push(`log.${e.entry.level}: ${e.entry.text} ${e.entry.url ?? ''}`));
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('DOM.enable'),
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    ]);
    await this.setViewport(width, height, mobile);
  }

  async goto(url, timeout = 15_000) {
    let off;
    const loaded = new Promise((resolve) => { off = this.on('Page.loadEventFired', resolve); });
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) { off(); throw new Error(redact(`navigate ${url}: ${r.errorText}`)); }
    const timer = sleep(timeout).then(() => { throw new Error(redact(`navigate ${url}: no load event in ${timeout}ms`)); });
    try { await Promise.race([loaded, timer]); } finally { off(); }
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(redact(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`));
    return r.result.value;
  }

  /** Poll a page expression (string) or a node-side async predicate (function) until truthy. */
  async waitFor(predicate, timeout = 5000, label = typeof predicate === 'string' ? predicate : 'condition') {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const v = typeof predicate === 'string' ? await this.evaluate(predicate) : await predicate();
        if (v) return v;
      } catch (e) { last = e; }
      if (Date.now() > deadline) throw new Error(redact(`waitFor timed out after ${timeout}ms: ${label}${last ? ` (last error: ${last.message})` : ''}`));
      await sleep(50);
    }
  }

  /** Non-ignored accessibility nodes matching {role, name?}, computed by the browser itself. */
  async axNodes({ role, name }) {
    const { result: doc } = await this.send('Runtime.evaluate', { expression: 'document' });
    const { nodes } = await this.send('Accessibility.queryAXTree', { objectId: doc.objectId, role, ...(name === undefined ? {} : { accessibleName: name }) });
    return nodes.filter((n) => !n.ignored && n.backendDOMNodeId);
  }

  /** CSS selector string, or {role, name} resolved through the browser's own accessibility tree. */
  async find(target) {
    if (typeof target === 'string') {
      const { result } = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(target)})` });
      return result.objectId ?? null;
    }
    const [hit] = await this.axNodes(target);
    if (!hit) return null;
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: hit.backendDOMNodeId });
    return object.objectId ?? null;
  }

  /** Run `fn` (as `this` = the element) in the page; returns by value. Throws when not found. */
  async call(target, fn, ...args) {
    const objectId = await this.find(target);
    if (!objectId) throw new Error(redact(`not found: ${describe(target)}`));
    const r = await this.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: String(fn), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(redact(`call on ${describe(target)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`));
    return r.result.value;
  }

  async isVisible(target) {
    return (await this.find(target)) ? this.call(target, VISIBLE_FN) : false;
  }

  async click(target) {
    const [x, y] = await this.call(target, function () {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const r = this.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }

  async type(text) { await this.send('Input.insertText', { text }); }

  async fill(target, text) { await this.click(target); await this.type(text); }

  async press(key, { shift = false } = {}) {
    const code = KEYS[key];
    if (!code) throw new Error(`press: unsupported key ${key}`);
    const text = key === 'Enter' ? '\r' : undefined;
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
    await this.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    this.viewport = { width, height, mobile };
  }

  /** Two animation frames (bounded) so layout and paint settle. */
  async settle() {
    await this.evaluate('new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500); })').catch(() => {});
  }

  async screenshot(path) {
    await this.settle();
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  async close() {
    await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {});
  }
}
