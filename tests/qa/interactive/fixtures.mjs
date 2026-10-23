// QA-INTERACTIVE-P1 — the named synthetic fixtures of one QA generation, and the bounded refusal probes.
// Identity, tenant, store and grant rows are inserted as the database owner exactly as the browser suite inserts them
// (tests/browser/shopRoleLevels.browser.test.mjs: actor/newTenant/newStore); every business record — customers,
// issuing settings, drafts, issued and voided invoices — is made through the real tenant routes as a seeded account
// with a real emulator sign-in and a real tenant session, so the adopted rules decide everything. All names, emails,
// phones and passwords are fictional.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../../server/runtime/requestSecurity.ts';
import { SESSION_CSRF_HEADER } from '../../../server/runtime/sessions.ts';
import { createAccount, seedUserDoc, signIn } from './emulators.mjs';

export const QA_EMAIL_DOMAIN = 'tmpos-qa.test';
const passwordOf = (label) => `qa-${label}-pass`; // fictional, shown in the runbook and by `status`
const LINE = (description, unitPriceCents) => ({ description, quantity: 1, unitPriceCents });

/** Accounts: label → role, grants (tenant + store scope), shown name. Effective access follows the adopted defaults. */
const ACCOUNTS = Object.freeze([
  { label: 'owner-a', role: 'store_owner', tenant: 'tenant-a', stores: ['store-a-main', 'store-a-harbor'], name: 'QA Owner A' },
  { label: 'manager-a', role: 'manager', tenant: 'tenant-a', stores: ['store-a-main'], name: 'QA Manager A' },
  { label: 'tech-a', role: 'technician', tenant: 'tenant-a', stores: ['store-a-main'], name: 'QA Technician A' },
  { label: 'sales-a', role: 'sales_staff', tenant: 'tenant-a', stores: ['store-a-main'], name: 'QA Sales A' },
  { label: 'owner-b', role: 'store_owner', tenant: 'tenant-b', stores: ['store-b-main'], name: 'QA Owner B' },
]);
const TENANTS = Object.freeze({ 'tenant-a': 'QA Northwind Repairs (synthetic)', 'tenant-b': 'QA Southfield Mobile (synthetic)' });
const STORES = Object.freeze({
  'store-a-main': ['tenant-a', 'Northwind Main (QA)'], 'store-a-harbor': ['tenant-a', 'Northwind Harbor (QA)'],
  'store-b-main': ['tenant-b', 'Southfield Central (QA)'],
});

/** A tenant-runtime client over loopback, as a same-origin browser would speak to it (exact Host and Origin). */
export function runtimeClient({ port, publicHost, publicOrigin }) {
  function send(method, path, headers, body) {
    const payload = body === undefined ? null : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path, agent: false,
        headers: payload ? { ...headers, 'content-length': String(payload.length) } : headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`no reply within 30 s: ${method} ${path}`)));
      req.end(payload ?? undefined);
    });
  }
  async function login(idToken) {
    const res = await send('POST', '/api/v1/session/login', {
      host: publicHost, origin: publicOrigin, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer ${idToken}`,
    }, '');
    if (res.status !== 200) throw new Error(`tenant login answered ${res.status}`);
    return { cookie: res.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(res.text).csrfToken };
  }
  async function call(method, path, { session = null, body, key, omit = [], override = {} } = {}) {
    const unsafe = method !== 'GET';
    const headers = {
      host: publicHost,
      ...(session ? { cookie: session.cookie, [SESSION_CSRF_HEADER]: session.csrf } : {}),
      ...(unsafe ? { origin: publicOrigin, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
      ...override,
    };
    for (const name of omit) delete headers[name];
    return send(method, path, headers, body === undefined ? (unsafe ? '' : undefined) : JSON.stringify(body));
  }
  return { login, call };
}

const ok = (res, status, what) => {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 200)}`);
  return res.text === '' ? null : JSON.parse(res.text);
};

/**
 * One generation's world. `owner` is the harness's owner client; `client` a runtimeClient on the tenant entry.
 * Returns the registry every operator command resolves labels against.
 */
export async function seedWorld({ owner, client, projectId, apiKey, generation, onSignedIn }) {
  const reg = { generation, tenants: {}, stores: {}, accounts: {}, customers: {}, drafts: {}, invoices: {} };
  for (const [label, name] of Object.entries(TENANTS)) {
    const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${name}, 'active') returning tenant_id`;
    reg.tenants[label] = id;
  }
  for (const [label, [tenant, name]] of Object.entries(STORES)) {
    const [{ store_id: id }] = await owner`insert into store (tenant_id, store_name, status) values (${reg.tenants[tenant]}, ${name}, 'active') returning store_id`;
    reg.stores[label] = { id, tenant, name };
  }
  for (const a of ACCOUNTS) {
    const uid = `qa-${a.label}-g${generation}`;
    const tenantId = reg.tenants[a.tenant];
    const [{ internal_user_id: id }] = await owner`
      insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
    await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${tenantId}, null, 'tenant', ${a.role}, 'active')`;
    for (const s of a.stores) {
      await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
        values (${id}, ${tenantId}, ${reg.stores[s].id}, 'store', ${a.role}, 'active')`;
    }
    const email = `${a.label}@${QA_EMAIL_DOMAIN}`;
    await createAccount(projectId, { uid, email, password: passwordOf(a.label), displayName: a.name });
    await seedUserDoc(projectId, uid, a.role, a.name);
    reg.accounts[a.label] = { uid, email, password: passwordOf(a.label), role: a.role, tenant: a.tenant, stores: a.stores, name: a.name };
  }

  // Business records, through the routes, as the owners.
  // The verifier accepts only tokens the ledger saw issued: this sign-in goes to the emulator directly, not via the front.
  const sessionOf = async (label) => {
    const idToken = await signIn(apiKey, reg.accounts[label].email, reg.accounts[label].password);
    onSignedIn(idToken);
    return client.login(idToken);
  };
  const storeLabelOf = (id) => Object.keys(reg.stores).find((k) => reg.stores[k].id === id);
  const a = await sessionOf('owner-a');
  const tA = reg.tenants['tenant-a'];
  const customer = async (s, tenant, label, body) => {
    const made = ok(await client.call('POST', '/api/v1/customers', { session: s, key: randomUUID(), body }), 201, `customer ${label}`);
    reg.customers[label] = { id: made.customer.id, tenant, name: body.name };
  };
  await customer(a, 'tenant-a', 'cust-ada', { name: 'Ada Fictional (QA)', phone: '+1 555 0100', email: 'ada.fictional@example.test' });
  await customer(a, 'tenant-a', 'cust-ben', { name: 'Ben Placeholder (QA)' });
  const settings = async (s, tenant, store, values) => {
    const read = ok(await client.call('GET', `/api/v1/issuing-settings/${store}`, { session: s }), 200, 'settings read');
    ok(await client.call('PUT', `/api/v1/issuing-settings/${store}`, {
      session: s, key: randomUUID(), body: { expectedTenant: tenant, expectedVersion: read.issuingSettings.version, ...values },
    }), 200, 'settings write');
  };
  const mainA = reg.stores['store-a-main'].id;
  await settings(a, tA, mainA, {
    legalName: 'Northwind Repairs QA LLC (fictional)', storeName: 'Northwind Main (QA)', postalAddress: '1 Fictional Way\nTestville',
    taxRegistrationId: null, tax: { mode: 'none' },
  });
  const drafts = (store) => `/api/v1/stores/${store}/invoice-drafts`;
  const draft = async (s, tenant, store, label, customerLabel, lines) => {
    const made = ok(await client.call('POST', drafts(store), {
      session: s, key: randomUUID(), body: { expectedTenant: reg.tenants[tenant], customerId: reg.customers[customerLabel].id, currency: 'USD', lines },
    }), 201, `draft ${label}`);
    reg.drafts[label] = { id: made.draft.id, tenant, store: storeLabelOf(store) };
    return made.draft.id;
  };
  const issue = async (s, tenant, store, label, customerLabel, lines) => {
    const id = await draft(s, tenant, store, `${label}-source`, customerLabel, lines);
    const preview = ok(await client.call('GET', `${drafts(store)}/${id}/issue-preview`, { session: s }), 200, `preview ${label}`);
    const issued = ok(await client.call('POST', `${drafts(store)}/${id}/issue`, { session: s, key: randomUUID(), body: preview.preview.expected }), 201, `issue ${label}`);
    delete reg.drafts[`${label}-source`];
    reg.invoices[label] = { id: issued.invoice.id, tenant, store: storeLabelOf(store) };
    return issued.invoice.id;
  };
  await draft(a, 'tenant-a', mainA, 'draft-edit', 'cust-ada', [LINE('QA screen repair (synthetic)', 4200)]);
  await draft(a, 'tenant-a', mainA, 'draft-discard', 'cust-ben', [LINE('QA battery check (synthetic)', 1500)]);
  await draft(a, 'tenant-a', mainA, 'draft-issue', 'cust-ada', [LINE('QA case replacement (synthetic)', 2900), LINE('QA labour (synthetic)', 3000)]);
  for (const [label, desc] of [['inv-void', 'QA charging port (synthetic)'], ['inv-held', 'QA speaker repair (synthetic)'],
    ['inv-stall', 'QA camera module (synthetic)'], ['inv-probe', 'QA diagnostics (synthetic)'], ['inv-voided', 'QA data transfer (synthetic)']]) {
    await issue(a, 'tenant-a', mainA, label, 'cust-ada', [LINE(desc, 5000)]);
  }
  ok(await client.call('POST', `/api/v1/stores/${mainA}/invoices/${reg.invoices['inv-voided'].id}/void`, {
    session: a, key: randomUUID(), body: { expectedTenant: tA, reasonCode: 'issued_in_error' },
  }), 200, 'void inv-voided');

  const b = await sessionOf('owner-b');
  const tB = reg.tenants['tenant-b'];
  const mainB = reg.stores['store-b-main'].id;
  await customer(b, 'tenant-b', 'cust-zoe', { name: 'Zoe Southfield (QA)', phone: '+1 555 0199', email: 'zoe.southfield@example.test' });
  await settings(b, tB, mainB, {
    legalName: 'Southfield Mobile QA Ltd (fictional)', storeName: 'Southfield Central (QA)', postalAddress: '9 Placeholder Road\nSampletown',
    taxRegistrationId: null, tax: { mode: 'none' },
  });
  await issue(b, 'tenant-b', mainB, 'inv-b', 'cust-zoe', [LINE('QA screen protector (synthetic)', 900)]);
  return reg;
}

/** The uids the verifier may accept: this generation's seeded accounts only (known before the seed signs any in). */
export const accountUids = (generation) => new Set(ACCOUNTS.map((a) => `qa-${a.label}-g${generation}`));

/**
 * The bounded refusal probes (runbook item 10), each through the QA front exactly as a browser request would arrive:
 * the void of `inv-probe` with no session, as the read-only technician, without the CSRF header, with a wrong session
 * CSRF value — and, only when asked, the positive control as the owner.
 */
export async function runProbes({ front, reg, apiKey, positive, onSignedIn }) {
  const inv = reg.invoices['inv-probe'];
  const store = reg.stores[inv.store].id;
  const tenant = reg.tenants[inv.tenant];
  const path = `/api/v1/stores/${store}/invoices/${inv.id}/void`;
  const body = { expectedTenant: tenant, reasonCode: 'issued_in_error' };
  const shown = (res) => ({ status: res.status, body: res.text.slice(0, 160) });
  // The verifier accepts only tokens the ledger saw issued: this sign-in goes to the emulator directly, not via the front.
  const sessionOf = async (label) => {
    const idToken = await signIn(apiKey, reg.accounts[label].email, reg.accounts[label].password);
    onSignedIn(idToken);
    return front.login(idToken);
  };
  const out = {};
  out['no session'] = shown(await front.call('POST', path, { key: randomUUID(), body }));
  const tech = await sessionOf('tech-a');
  out['restricted: tech-a (Invoices View Only)'] = shown(await front.call('POST', path, { session: tech, key: randomUUID(), body }));
  const boss = await sessionOf('owner-a');
  out['owner-a without X-TMPOS-CSRF'] = shown(await front.call('POST', path, { session: boss, key: randomUUID(), body, omit: [CSRF_HEADER] }));
  const wrong = `${boss.csrf[0] === 'A' ? 'B' : 'A'}${boss.csrf.slice(1)}`;
  out['owner-a with a wrong session CSRF value'] = shown(await front.call('POST', path, {
    session: boss, key: randomUUID(), body, override: { [SESSION_CSRF_HEADER]: wrong },
  }));
  if (positive) out['positive control: owner-a'] = shown(await front.call('POST', path, { session: boss, key: randomUUID(), body }));
  return out;
}
