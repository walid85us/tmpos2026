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
| 9 | **MFA** | MFA required for Backend CP login. **M4 (M4-ADMIN-UI-P2, committed in `dd89ff9`):** an authenticator app (TOTP) only — the SMS/phone factor needs reCAPTCHA hosts that the admin CSP refuses (§2a). |
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
| 20 | **Web/transport hardening** | Content-Security-Policy, `frame-ancestors`/X-Frame-Options (clickjacking — the admin CP especially), HSTS, and output-encoding/DOM-XSS controls on **both** SPAs. HttpOnly does **not** stop same-origin XSS from riding the cookie, and CSRF double-submit does not defend against same-origin XSS — so XSS controls are a first-class session-integrity requirement (gate G-WEBHARDEN). **Progress (M4-ADMIN-UI-P2, committed in `dd89ff9`; not deployed):** the admin half exists in code — the admin document CSP and header policy, a production-intended admin web listener, the API/SPA routing boundary and uncontrolled credential inputs (§2a); no admin-host deployment exists, and the tenant SPA remains M8. |

### 2a. Production composition and origin topology (M4, committed in `dd89ff9`)

- **Origin topology — distinct hosts, as #1 requires.** Each boundary accepts login and unsafe session requests only from its own exact configured origins (`SESSION_TENANT_ORIGINS`, `SESSION_ADMIN_ORIGINS`: comma-separated exact `https` origins). The two may never share a host: cookies are host-scoped, so another port on the same host is not a separate boundary. A dedicated subdomain of the same site qualifies — SameSite=Strict does not separate same-site hosts, but the exact Origin check, the session-bound CSRF token and the host-only `__Host-` cookies do — and a separate registrable domain is stronger still. A same-origin deployment is not supported, and missing, malformed or ambiguous configuration refuses composition. Audiences, cookies, stores, admission, CSRF labels and route prefixes stay separate in every case.
- **Production composition.** The provider-independent runtime (`server/runtime`) defines the ports. One provider-aware composition root (`server/composition/productionSessions.ts`) binds the identity verifier (the Firebase adapter) and each boundary's own durable session store, admission and authorizer — all or nothing, from configuration only, naming every missing dependency when it refuses. It refuses today: no durable session store and no admission or authorizer adapter exists (G-DBROLE, migration 005, M5), so production sessions are not active.
- **Lifecycle.** Admin sessions last 1 h absolute / 15 min idle, tenant sessions 8 h / 30 min. Admission is re-checked every 1 min (admin) or 5 min (tenant) against a security-version witness; a denial or a changed version revokes the session. A denial, at revalidation or at login, ends every session of the principal in that boundary. Only a successful authorized request slides the idle window. Every port call is bounded (3 s by default) and handed a cancellation signal — an in-flight provider verification is abandoned at the deadline rather than cancelled; an outage is a 503, never a credential verdict.
- **Admin login evidence (#9, and the recent-login precondition of #10).** A provider-verified authenticator-app (`totp`) second factor and an authentication at most 5 minutes old; the tenant login requires neither. Step-up for sensitive actions remains. **TOTP only (M4-ADMIN-UI-P2):** the SMS/phone factor needs reCAPTCHA script and frame hosts (`www.google.com`, `www.gstatic.com`, known CSP-bypass hosts) that the admin CSP refuses, so neither the console nor the server login policy accepts it. This is a product limitation: admin accounts must enrol an authenticator app, and a phone-only admin gets the same generic refusal as any failed sign-in.
- **Admin console (M4-ADMIN-UI-P1, committed in `dd89ff9`; production login not active).**
  - **What it is.** The console (`src/backend-control-plane/console/`) is the production successor of the DEV mock shell. `src/main.tsx` chooses the surface from the address before anything loads.
  - **Where it runs.** In a production build it runs only on a configured administration origin: `VITE_ADMIN_CONSOLE_ORIGINS`, an exact `https` list fixed at build time. A missing or malformed list refuses on every host. The console owns that origin entirely. On any other address, `/admin` renders a refusal and makes no administrative request. A Vite dev server serves the console under `/admin` on the development host; production builds compile that branch out, which the build check and the browser suite prove.
  - **Sign-in.** It uses the existing Firebase client SDK on its own in-memory instance, so nothing reaches IndexedDB or Web Storage. It completes the provider's second-factor challenge and sends the one ID token once, as the Bearer of the bodiless `POST /admin/v1/session/login`. The provider session is signed out as soon as that token is read.
  - **Session handling.**
    - The session CSRF token lives only in the client's memory and is sent with logout alongside the intent header. Script never reads or constructs the HttpOnly cookie.
    - The shell renders only after `GET /admin/v1/session` confirms the session. The console re-reads the session on every in-console navigation and when the tab becomes visible; a read never extends the session.
    - Every refusal reads as one generic denial, while 429 and 503 are reported distinctly. A logout is reported only when the server confirms it.
  - **Workspaces.** The 11 workspaces are navigation placeholders marked "Coming later", with no action and no permission data.
- **Admin console hardening and read-only Command Center (M4-ADMIN-UI-P2, committed in `dd89ff9`; nothing deployed, production login not active).**
  - **API/SPA routing boundary.** `/admin/v1/*` and `/api/v1/*` are never a console page on any origin and are never redirected. One canonical rule decides it: decode once (a malformed escape counts as API), then every backslash — literal or decoded from `%5C` — is a slash, lowercase, drop empty and `.` segments and resolve `..` (never above the root). The rule lives in three places: `server/runtime/adminWeb.ts` `isApiPath`; the Vite dev/preview guard, which answers with the runtime's bounded JSON 404 and API header policy, never the SPA document; and the console surface (`src/backend-control-plane/console/adminSurface.ts`), where a page load renders a bounded "Not found" page that loads neither application chunk, sends no request and keeps the address. Inside the running console, an address under the same rule (`/admin/v1/*` or `/api/v1/*`, in any spelling) renders the same page, where P1 redirected it to `/admin`; any other unknown address still goes to `/admin`.
  - **Web policy and listener.** The admin document CSP is exactly `default-src 'none'; script-src 'self' https://apis.google.com; style-src 'self'; img-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com; frame-src https://<authDomain>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. `apis.google.com` and `frame-src` exist only for the Google popup resolver; `form-action 'none'` also stops a native form submit from putting credentials in a URL; there is no `unsafe-inline`, `unsafe-eval` or wildcard. The other headers are `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, a deny-list Permissions-Policy, CORP `same-origin`, `no-store` on the document and immutable caching on hashed assets. HSTS (`max-age=31536000; includeSubDomains`) is sent only at the HTTPS boundary; the runtime adds it under the production classification (`server/runtime/server.ts`). The production-intended listener (`createAdminWebListener`, `server/runtime/adminWebServer.ts`) serves a build preloaded at startup by `loadAdminBuild`, so no request touches the filesystem, and it delegates an API path to the runtime or refuses it. Nothing deploys it: the Replit static deployment (`.replit`) serves the tenant surface, and no admin-host deployment exists (deployment invariants: [08](./08-production-gate-and-risk-register.md) G-CPLOGIN). The dev server deliberately sends no framing header, because the Replit Preview embeds it in an iframe.
  - **Fonts.** The admin origin fetches no web font: Manrope and Material Symbols moved to the tenant-only `src/tenantFonts.css` (imported by `src/App.tsx`), and the console uses the platform UI stack. The tenant SPA still loads Google Fonts; that belongs to M8 / G-WEBHARDEN for both SPAs.
  - **Credentials.** Phone MFA is gone (TOTP only — see the admin login evidence above). The email, password and verification-code inputs are uncontrolled, so no typed credential reaches the markup; autocomplete stays `username` / `current-password` / `one-time-code`.
  - **Read-only Command Center (`server/runtime/commandCenter.ts`).** `GET /admin/v1/command-center`, body none, policy session/admin plus `{ scope: 'platform', permission: 'view_command_center' }` (the existing catalog view capability); there is no other method, so no state-changing operation. It maps an injected reader port into a bounded view: posture counts, per-area attention counts, governance signals and service health, each section `available` / `unavailable` / `not_configured` with `asOf` and `stale`. No reader string ever reaches the output, and a reader failure or overrun is a bounded 503. It is registered nowhere — the composition root and the deployable entry do not import it, and a test pins that the deployable app composes no such route — and no authoritative source exists (real data is M7h). The console dashboard (`/admin`) replaces the placeholder overview and leaves the workspace pages unchanged; it refreshes manually only, and an unavailable or not-configured section never shows a number. A reading that ages past 24 hours while the page is open becomes unavailable too, as the server would then say. Ages count from the server's generation instant plus the time elapsed on the page. A fixed page-clock offset therefore changes nothing, and a page clock stepped forward can only make a reading age early. The admission-revalidation race ([08](./08-production-gate-and-risk-register.md) G-CPLOGIN) still blocks production session activation, operational data access and every sensitive admin action; nothing in this stage bypasses it.

## 3. Administrative session endpoints (conceptual contracts — not implemented in M1)

| Endpoint | Purpose | Auth in | Result |
|---|---|---|---|
| `POST /admin/v1/session/login` | Login exchange: Firebase ID token → verify → issue admin cookie | Firebase Bearer (once) | Set-Cookie (HttpOnly admin session) + sanitized whoami |
| `GET /admin/v1/session/whoami` | Current admin session (the whoami contract; delivered as `GET /admin/v1/session`) | admin cookie | `{ status, csrfToken }` only until the M5 capability summary exists — no identity, token or email |
| `POST /admin/v1/session/logout` | Invalidate server-side session | admin cookie | cleared cookie |
| `POST /admin/v1/session/step-up` | Re-authenticate for sensitive action; mark recent-login | admin cookie + fresh Firebase Bearer | step-up grant (short TTL) |
| `GET /admin/v1/session/csrf` | CSRF token bootstrap (if double-submit chosen) | admin cookie | CSRF token |
| `POST /admin/v1/session/revoke` | Admin-initiated session revocation | admin cookie (privileged) | revocation ack |
| `POST /admin/v1/session/refresh-eligibility` | Re-resolve permissions/entitlements after a governance change | admin cookie | refreshed capability summary |

These endpoints are described to fix the **contract**; wiring is M4.

**M4 delivered contract (runtime, committed in `dd89ff9`):** each boundary exposes exactly `POST <prefix>/session/login`, `GET <prefix>/session` (the current session) and `POST <prefix>/session/logout`, where `<prefix>` is `/admin/v1` for the administrative boundary and `/api/v1` for the tenant/store boundary. Login and the current-session read return the session-bound CSRF token, so no separate CSRF bootstrap endpoint exists. Step-up, admin-initiated revocation and eligibility refresh remain conceptual under `/admin/v1/session/*` until their milestone.

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
