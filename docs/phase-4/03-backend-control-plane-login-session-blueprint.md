# 03 — Backend Control Plane Login & Session Blueprint

**Scope:** the **separate** administrative login and session boundary for the Backend Control Plane (Backend CP), and the Backend CP's platform-governance responsibilities and controlled-action contract. Conceptual/design-only — endpoints are described, **not implemented** (implementation is M4). Delivered by **M4**; canonical authorization it relies on is **M5**.

## 1. Why separate

Today there is **no server session at all**: the live app uses the client Firebase session + a client-held role, and the DEV Backend CP shell's entry gate is a single local boolean with no auth ([01](./01-current-state-inventory-and-gap-matrix.md) §D, GAP-02). The Backend CP governs the entire platform (tenants, plans, entitlements, IAM, support, audit). It **must not** reuse the tenant/store browser session or share its trust boundary. A compromised or ordinary tenant session must never reach platform administration.

### 1a. Two server sessions, both required (not only the admin one)

The Backend CP is the *higher-privilege* boundary, but the **tenant/store application also needs a server session and per-request server-side identity verification** — otherwise canonical IAM ([04](./04-canonical-iam-and-four-user-migration.md)) has no verified tenant request identity to authorize, and the browser role/`sessionStorage` remains authoritative. **M4 delivers both session boundaries as separate, independent trust boundaries:** a tenant session cookie (for `/api/v1/*`) and a distinct admin session cookie (for `/admin/v1/*`). They share **one canonical IAM catalog and one status/suspension model** ([04](./04-canonical-iam-and-four-user-migration.md)) to avoid split-brain authorization, but never share a cookie, origin, or trust boundary. Each session is established by its own login exchange with the same server-side verification below.

## 2. Login & session requirements

| # | Requirement | Detail |
|---|---|---|
| 1 | **Dedicated entry** | A dedicated Backend CP entry route on a **dedicated admin hostname/subdomain (mandatory, a distinct origin)** — a separate cookie on a shared registrable domain is a weaker boundary and does not fully realize [ADR-02](./10-architecture-decision-records.md). |
| 2 | **No session reuse** | No automatic reuse of the tenant/store browser session. Admin auth is established independently. |
| 3 | **Firebase verification at the server** | The ID token is verified **only** at the server login exchange via `verifyIdToken(token, checkRevoked=true)` (adapter already exists, fails closed — [01](./01-current-state-inventory-and-gap-matrix.md) §E). The browser never uses the raw token as the app session. |
| 4 | **Server-issued admin session cookie** | `HttpOnly`, `Secure`, `SameSite=Strict` (unless an evidenced flow requires `Lax`), scoped to the exact admin origin, short-lived. |
| 5 | **CSRF protection** | Double-submit or synchronized-token CSRF for all state-changing admin requests, plus `Origin`/`Sec-Fetch-Site` checks (the BCP action guard already models exact-Origin + `Sec-Fetch-Site` + custom-intent-header defense). |
| 6 | **Trusted Origin** | Exact-match trusted Origin allowlist for the admin surface (no suffix/substring matching). |
| 7 | **Session rotation** | Rotate the session identifier on login and on privilege change; bounded absolute lifetime + inactivity timeout. |
| 8 | **Logout & revocation** | Explicit logout invalidates server-side; server-side revocation list; `checkRevoked=true` honored so disabled/revoked Firebase users cannot re-establish. |
| 9 | **MFA** | MFA required for Backend CP login. |
| 10 | **Step-up / recent-login** | Sensitive actions (status change, entitlement grant, role change, provisioning, break-glass) require recent-login/step-up re-authentication. |
| 11 | **Sanitized errors** | Login failures return a generic sanitized error; no user-enumeration, no provider detail. |
| 12 | **No token in browser storage** | No token in `localStorage`/`sessionStorage`; no UID/email/claim/token in URLs or browser logs (the DEV client comment already asserts the token is not placed in React state/logs — the M4 target must preserve this). |
| 13 | **Canonical authorization after auth** | Authentication ≠ authorization. After login, the effective admin authorization is resolved from **canonical Postgres** ([04](./04-canonical-iam-and-four-user-migration.md)), deny-by-default. |
| 14 | **Fail-closed status** | Suspended/inactive/parity/cap enforced server-side; missing mapping ⇒ deny (no synthetic/client-asserted administrator). |
| 15 | **Break-glass governance** | A governed, audited, time-boxed break-glass path with reason capture; never a silent bypass. |
| 16 | **Production hard-block for DEV paths** | The DEV-only action/diagnostic paths and DEV feature flags must be hard-blocked in production (`NODE_ENV==='production'` denies), not merely default-OFF. |
| 17 | **Login anti-automation** | Rate-limiting + brute-force lockout on the login exchange (MFA mitigates but is not anti-automation). |
| 18 | **Durable session store** | Server sessions backed by a durable store (e.g. Redis/DB) with a revocation list; sessions and revocation survive restart and work across instances. |
| 19 | **Cookie hardening** | Use the `__Host-` cookie prefix (host-locked, path `/`, Secure, no Domain) for both session cookies, in addition to HttpOnly/Secure/SameSite. |
| 20 | **Web/transport hardening** | Content-Security-Policy, `frame-ancestors`/X-Frame-Options (clickjacking — the admin CP especially), HSTS, and output-encoding/DOM-XSS controls on **both** SPAs. HttpOnly does **not** stop same-origin XSS from riding the cookie, and CSRF double-submit does not defend against same-origin XSS — so XSS controls are a first-class session-integrity requirement (gate G-WEBHARDEN). |

## 3. Administrative session endpoints (conceptual contracts — not implemented in M1)

| Endpoint | Purpose | Auth in | Result |
|---|---|---|---|
| `POST /admin/session/login` | Login exchange: Firebase ID token → verify → issue admin cookie | Firebase Bearer (once) | Set-Cookie (HttpOnly admin session) + sanitized whoami |
| `GET /admin/session/whoami` | Current admin session + effective authorization summary | admin cookie | sanitized principal + capabilities (no token/email in body beyond what's needed) |
| `POST /admin/session/logout` | Invalidate server-side session | admin cookie | cleared cookie |
| `POST /admin/session/step-up` | Re-authenticate for sensitive action; mark recent-login | admin cookie + fresh Firebase Bearer | step-up grant (short TTL) |
| `GET /admin/session/csrf` | CSRF token bootstrap (if double-submit chosen) | admin cookie | CSRF token |
| `POST /admin/session/revoke` | Admin-initiated session revocation | admin cookie (privileged) | revocation ack |
| `POST /admin/session/refresh-eligibility` | Re-resolve permissions/entitlements after a governance change | admin cookie | refreshed capability summary |

These endpoints are described to fix the **contract**; wiring is M4.

## 4. Backend CP responsibilities (governs the whole platform)

Platform operators, tenants, stores, users & memberships, roles & permissions, provisioning, plans & entitlements, subscriptions & billing governance, feature flags, module availability, domains & integrations, support operations, approvals, audit/security, operational health, data-quality findings, migration state, background jobs, provider status, incident/recovery controls.

## 5. Controlled-action contract (every admin mutation)

The DEV controlled-action pilot already demonstrates the target shape ([01](./01-current-state-inventory-and-gap-matrix.md) §E: method/dev/flag → request-security guard → global rate → verify Bearer → read-only identity → per-principal rate → authz guard → handler). Generalized, every Backend CP mutation MUST use:

1. a **typed service/API contract** (no ad-hoc row mutation);
2. **canonical authorization** (server-resolved, deny-by-default);
3. **explicit scope** (platform vs specific tenant/store);
4. **validation** of the request body;
5. a **transaction boundary**;
6. **idempotency** where applicable (durable key store — [05](./05-canonical-data-ownership-and-api-db-contracts.md));
7. **durable audit** (append-only `audit_event`, not advisory-only — closes GAP-07);
8. **reason capture** for sensitive operations;
9. **safe result classification** (bounded envelope, no stack/DB/provider leakage);
10. **least privilege**;
11. **production-safe error handling**.

**Read-only inspection is separated from controlled mutations.** Read lenses (the C01–C07 pattern) never mutate and never construct authority from request input; controlled mutations pass the full chain above. **The Backend CP must not bypass domain services or mutate database rows arbitrarily** — all administrative writes route through typed services with canonical authorization.

## 6. M4→M5 interim authorization posture

M4 delivers the session boundaries and the admin shell wired to server endpoints, but the **canonical authorization** those endpoints resolve against is **M5**. In the interval between M4 and M5, admin endpoints MUST enforce only the **existing narrow pilot guard** (visibility `system_owner` by exact equality, permission floor `manage`, fail-closed) — the same guard the DEV controlled-action pilot already uses — and MUST NOT expose generalized admin capability until M5 generalizes the canonical authorization service. No admin surface authenticates-without-authorization: unmapped/insufficient principals are denied.

> **INVARIANT (M4 mutation gate):** **No generalized Backend CP mutation endpoint may become available during M4 before the M5 canonical permission for that action exists.** The narrow pilot action (DEV-only, isolated, `system_owner` exact-eq) may remain under **hard environment gating** (`NODE_ENV==='production'` denies), a **typed-service allowlist**, **durable audit on every pilot action**, and **explicit removal-or-promotion criteria** (the pilot is either removed or promoted to a canonical M5-governed action — it does not linger unmanaged). Every *new* administrative mutation requires its canonical M5 permission to be defined and enforced before the endpoint is exposed. This prevents an authenticated-but-unauthorized admin capability window between M4 and M5.

## 7. Residual: admin mutation prohibition is application-enforced

The "no arbitrary row mutation" rule (§5) is an **application-layer convention**: the privileged admin/migration DB role bypasses RLS by design ([05 §4](./05-canonical-data-ownership-and-api-db-contracts.md)), so the database does not itself enforce it. This residual is compensated by making **typed-service + canonical-authorization + durable-audit mandatory** on every path that uses the privileged role, and by keeping the privileged role out of the tenant request path (which runs under the scoped, RLS-bound app role). Tracked under gate G-DBROLE.

## 8. System Owner boundary — store payment gateways (payment gateways are STORE-owned)

Payment-gateway connections are **store-owned** ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md)); the System Owner governs the **connector catalog and security policy only**.

**The System Owner Backend CP MAY:** define the supported connector catalog; control connector availability by environment/region; establish minimum versions and security requirements; view **bounded** connector health; view **sanitized** connection status; **disable a connector globally during a security incident**; manage feature/plan eligibility; review aggregate operational failures; support **audited break-glass** workflows.

**The System Owner MUST NOT normally:** supply a store's merchant credentials; retrieve or reveal a store credential; impersonate a store connection; activate a gateway for a store without store authorization; process a store payment outside a governed support workflow; **see raw provider tokens/secrets**; silently move a connection between stores.

**Any exceptional delegated-support workflow requires:** explicit **store consent** + **time-bounded elevation** + **step-up authentication** + **least privilege** + **reason capture** + **durable audit** + **automatic expiry** + **no credential reveal**. This is the only path by which a platform operator touches a store connection, and it never reveals a credential. **Allowed break-glass action set is bounded to diagnostics** (view sanitized status/health, assist a store-initiated reconnection); it **explicitly EXCLUDES** silent production activation, connection replacement, and any fund movement (payment/refund/void) — any state-changing break-glass action additionally requires **store-side positive confirmation + dual approval**.

**Global connector disablement** (a platform-wide payment-availability lever) is itself a **step-up + reason + durable-audit** action with **affected-store notification** — it disables catalog availability/routing, and does **not** touch, own, or reveal any store credential or perform a store-authorized lifecycle action.

## 9. Migration note

The read-only Backend Control Plane already drafted in DEV (phase-1.6 / phase-2.0 shell + C01–C07 lenses + the acknowledge-readiness-review action) is **absorbed into M4** (login/session + admin shell) and **M8** (hardening). Its legacy M21–M58 numbering is superseded by the M0–M9 roadmap ([09](./09-roadmap-m0-m9.md)). Controlled **write** actions beyond the pilot are **M7 verticals**, not M4.
