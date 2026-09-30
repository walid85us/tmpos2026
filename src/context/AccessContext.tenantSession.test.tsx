// M7A-CUSTOMERS-P3-R2 (AM4) — the tenant-server session follows the Firebase user. The provider under test is the real
// AccessProvider; Firebase is mocked at its boundary (onAuthStateChanged captures the callback, getDoc answers), and the
// shop's real tenant session client runs over a scripted fetch — so these assert the requests that reach the tenant
// session boundary, in order: a sign-out (the first callback of a page load included) ends a surviving session, and a
// user switch ends the previous user's session BEFORE the next user logs in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  authCallback: null as ((user: unknown) => void | Promise<void>) | null,
  fetch: (async () => { throw new Error('unscripted request'); }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
}));
vi.mock('../firebase', () => ({ auth: {}, db: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: unknown, cb: (u: unknown) => void) => {
    h.authCallback = cb;
    return () => {};
  }),
}));
const getDoc = vi.fn();
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: (...a: unknown[]) => getDoc(...a),
}));
vi.mock('../tenant/tenantSessionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tenant/tenantSessionClient')>();
  return { ...actual, tenantSession: actual.createTenantSessionClient({ fetch: (input, init) => h.fetch(input, init) }) };
});

import { AccessProvider } from './AccessContext';
import { sessionSubjectOf, tenantSession, TENANT_SESSION_PATHS } from '../tenant/tenantSessionClient';

const CSRF_A = 'a'.repeat(43);
const CSRF_B = 'b'.repeat(43);
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const active = (csrf: string): Response => json(200, { status: 'active', csrfToken: csrf });
/** A tenant session 200 naming `uid`'s session (M7A-CUSTOMERS-P5-R1: the session read names whose session it is). */
const activeOf = async (csrf: string, uid: string): Promise<Response> =>
  json(200, { status: 'active', csrfToken: csrf, subject: await sessionSubjectOf(uid) });
const NONE = (): Response => json(401, { error: 'unauthenticated' });
const user = (uid: string) => ({ uid, email: `${uid}@example.test` });

interface Sent { readonly what: string; readonly headers: Headers }
let sent: Sent[] = [];
let replies: Array<Response | Promise<Response>> = [];

function script(next: Array<Response | Promise<Response>>): void {
  sent = [];
  replies = next;
  h.fetch = async (input, init = {}) => {
    sent.push({ what: `${init.method ?? 'GET'} ${String(input)}`, headers: new Headers(init.headers) });
    const reply = replies.shift();
    if (reply === undefined) throw new TypeError('unscripted request');
    return reply;
  };
}
const settle = () => act(async () => { for (let n = 0; n < 5; n += 1) await new Promise((r) => setTimeout(r, 0)); });
async function fire(next: unknown): Promise<void> {
  await act(async () => { await h.authCallback?.(next); });
}

beforeEach(async () => {
  getDoc.mockReset();
  getDoc.mockResolvedValue({ exists: () => true, data: () => ({ role: 'store_owner', name: 'Synthetic' }) });
  // Start every case with nothing remembered by the shared client.
  script([json(401, { error: 'unauthenticated' })]);
  await tenantSession.logout();
  h.authCallback = null;
});
afterEach(() => cleanup());

describe('AccessContext — tenant session handoff (M7A-CUSTOMERS-P3-R2 AM4)', () => {
  it('ATS-01. the first callback of a page load, signed out, ends a surviving session; none left sends no logout', async () => {
    script([active(CSRF_A), new Response(null, { status: 204 })]);
    render(<AccessProvider><span /></AccessProvider>);
    await fire(null);
    await settle();
    expect(sent.map((r) => r.what)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(sent[1].headers.get('x-tmpos-session-csrf')).toBe(CSRF_A);
    expect(sent[1].headers.get('x-tmpos-csrf')).toBe('1');

    script([json(401, { error: 'unauthenticated' })]);
    await fire(null); // signed out again: it reads first and finds no session
    await settle();
    expect(sent.map((r) => r.what)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
  });

  it('ATS-02. a user switch A→B ends A\'s session before B reads or logs in; a late logout cannot end B\'s', async () => {
    render(<AccessProvider><span /></AccessProvider>);
    script([]);
    await fire(user('uid-a'));
    await settle();
    expect(sent).toHaveLength(0); // a sign-in by itself sends nothing
    script([NONE(), await activeOf(CSRF_A, 'uid-a'), await activeOf(CSRF_A, 'uid-a')]); // no session yet: read, login, confirming read
    expect(await tenantSession.ensure('uid-a', async () => 'tok-a')).toEqual({ kind: 'ok', csrf: CSRF_A });

    let endA!: (r: Response) => void;
    script([new Promise<Response>((resolve) => { endA = resolve; }), NONE(), await activeOf(CSRF_B, 'uid-b'), await activeOf(CSRF_B, 'uid-b')]);
    await fire(user('uid-b')); // no sign-out between: Firebase simply reports another user
    const b = tenantSession.ensure('uid-b', async () => 'tok-b');
    await settle();
    expect(sent.map((r) => r.what)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]); // B waits for A's logout
    expect(sent[0].headers.get('x-tmpos-session-csrf')).toBe(CSRF_A);
    endA(new Response(null, { status: 204 }));
    expect(await b).toEqual({ kind: 'ok', csrf: CSRF_B });
    expect(sent.map((r) => r.what)).toEqual([
      `POST ${TENANT_SESSION_PATHS.logout}`, `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`,
      `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(sent[2].headers.get('authorization')).toBe('Bearer tok-b');
  });

  it('ATS-03. the same user reported again sends nothing; signing out afterwards ends that user\'s session', async () => {
    render(<AccessProvider><span /></AccessProvider>);
    script([]);
    await fire(user('uid-a'));
    script([NONE(), await activeOf(CSRF_A, 'uid-a'), await activeOf(CSRF_A, 'uid-a')]); // no session yet: read, login, confirming read
    await tenantSession.ensure('uid-a', async () => 'tok-a');
    script([]);
    await fire(user('uid-a')); // e.g. a token refresh or a re-subscription
    await settle();
    expect(sent).toHaveLength(0);
    script([new Response(null, { status: 204 })]);
    await fire(null);
    await settle();
    expect(sent.map((r) => r.what)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]); // the remembered token: no read needed
    expect(sent[0].headers.get('x-tmpos-session-csrf')).toBe(CSRF_A);
  });
});
