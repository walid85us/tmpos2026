// Phase 4.0 M4 — the admin host's web entry (G-WEBHARDEN).
//
// Serves the built admin SPA under the admin web policy (adminWeb.ts). It is meant to be composed
// with the runtime app for /admin/v1 once the admin session boundary is composable (G-CPLOGIN):
// `api` is that hand-off, and createBoundedServer (app.ts) is the server to bind it with. Nothing
// deploys it yet: the static deployment in .replit serves the tenant surface only.
//
// The build is read once at startup. Its root directory is deployment configuration (a symlink to
// it is followed, like any configured path); beneath the root nothing is ever followed through a
// symlink (lstat): the document by its file name, every other regular file into the asset map. The
// build is trusted deployment output, not writable by a client. A request reads nothing from the
// filesystem, so no request-target can reach a byte outside that preload. An API path goes to
// `api` (or gets the bounded JSON 404) whatever its method and is never answered with the
// document; a web path takes GET and HEAD only; every refusal is bounded JSON under the runtime
// API header policy.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { adminWebHeaders, apiPathRefusal, canonicalPath, classifyAdminWebPath, isApiPath } from './adminWeb.js';

export interface AdminBuildFile {
  readonly body: Buffer;
  readonly type: string;
}

export interface AdminBuild {
  /** The SPA document, served for every document path (its own included); never an asset. */
  readonly document: Buffer;
  /** Every other regular file, keyed by its '/'-joined path under the build directory. */
  readonly assets: ReadonlyMap<string, AdminBuildFile>;
}

const DOCUMENT_FILE = 'index.html'; // the Vite build's SPA document, at the build root

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
});

/** The build, read once at startup; refuses one whose document is absent or not a regular file. */
export function loadAdminBuild(dir: string): AdminBuild {
  const documentPath = join(dir, DOCUMENT_FILE);
  if (!lstatSync(documentPath, { throwIfNoEntry: false })?.isFile()) throw new Error('admin_build_invalid');
  const assets = new Map<string, AdminBuildFile>();
  (function walk(abs: string, prefix: string): void {
    for (const name of readdirSync(abs)) {
      if (prefix === '' && name === DOCUMENT_FILE) continue; // the document is never an asset
      const path = join(abs, name);
      const stat = lstatSync(path); // lstat: a symlink is neither a file nor a directory here
      if (stat.isDirectory()) walk(path, `${prefix}/${name}`);
      else if (stat.isFile()) {
        const type = TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
        assets.set(`${prefix}/${name}`, Object.freeze({ body: readFileSync(path), type }));
      }
    }
  })(dir, '');
  return Object.freeze({ document: readFileSync(documentPath), assets });
}

export interface AdminWebOptions {
  readonly build: AdminBuild;
  readonly authDomain: string;
  readonly https: boolean;
  /** The runtime app for API paths (G-CPLOGIN); without it an API path gets the bounded JSON 404. */
  readonly api?: RequestListener;
}

/** The admin host's listener. Every header map is built once, so a bad option refuses startup. */
// The runtime's operational paths (app.ts), matched in canonical form (/HEALTH, /health/, //health):
// a health check on the admin host reaches the runtime, or fails, and never gets the document — a
// draining runtime must not look healthy.
const RUNTIME_PATHS: ReadonlySet<string> = new Set(['/health', '/readiness']);

export function createAdminWebListener(opts: AdminWebOptions): RequestListener {
  const { build, https, api } = opts;
  if (typeof https !== 'boolean' || (api !== undefined && typeof api !== 'function')) throw new Error('admin_web_options_invalid');
  const web = { authDomain: opts.authDomain, https };
  const documentHeaders = { ...adminWebHeaders('document', web), 'Content-Type': 'text/html; charset=utf-8' };
  const fileHeaders = { asset: adminWebHeaders('asset', web), file: adminWebHeaders('file', web) };
  const refusal = apiPathRefusal({ https }); // the runtime API policy, HSTS over https, JSON type

  const send = (req: IncomingMessage, res: ServerResponse, status: number, headers: Readonly<Record<string, string>>, body: Buffer): void => {
    res.writeHead(status, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void =>
    send(req, res, status, { ...refusal.headers, ...extra }, Buffer.from(JSON.stringify({ error })));

  return (req, res) => {
    // Origin-form only, as createBoundedServer: any other request-target is a bounded 400.
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) {
      refuse(req, res, 400, 'invalid_request', { Connection: 'close' });
      return;
    }
    const rawPath = req.url.split(/[?#]/, 1)[0];
    if (isApiPath(rawPath) || RUNTIME_PATHS.has(canonicalPath(rawPath) ?? '')) {
      if (api) api(req, res);
      else send(req, res, refusal.status, refusal.headers, Buffer.from(refusal.body));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      refuse(req, res, 405, 'method_not_allowed', { Allow: 'GET, HEAD', Connection: 'close' });
      return;
    }
    const kind = classifyAdminWebPath(rawPath, (p) => build.assets.has(p));
    if (kind === 'document') {
      send(req, res, 200, documentHeaders, build.document);
      return;
    }
    const file = kind === 'asset' || kind === 'file' ? build.assets.get(rawPath) : undefined;
    if (file && (kind === 'asset' || kind === 'file')) send(req, res, 200, { ...fileHeaders[kind], 'Content-Type': file.type }, file.body);
    else refuse(req, res, 404, 'not_found'); // a missing asset (or, never, an API path): fail closed
  };
}
