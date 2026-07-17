# 07 — Quality & Test Strategy

**Scope:** the mandatory test pyramid, the emulator/CI foundation, and the coverage gates that govern promotion. Foundation is **M2**; every M7 domain adds its slice; the Firestore emulator semantic suite is a **mandatory pre-deployment gate**.

## 1. Current baseline (honest)

- **UI/business surfaces:** 0 tests (`src/components/**`, `src/owner/**`) — heavy stateful logic unverified (GAP-22).
- **Backend:** substantial — the BCP corpus (`server/bcp-pilot/**`), platform-identity suites, and 8 BCP client-classifier tests (`src/backend-control-plane/**`).
- **Firestore rules:** a **static** source-pattern guard (21/21) **plus** the M2 **semantic emulator suite (41/41 PASS)** against the Java-backed emulator (ephemeral Nix JDK21, `demo-` project, no creds). CI re-run pending committed workflow (GAP-18, gate G-EMU).
- **Typecheck:** a known non-zero baseline exists (non-production surfaces: shipping adapters, `import.meta.env` typing gap, billing). Treat as a ratchet.

## 2. Mandatory test pyramid

| Layer | What it proves | When |
|---|---|---|
| **Pure unit** | domain logic, resolvers, comparators (incl. the **unified permission comparator**, [04](./04-canonical-iam-and-four-user-migration.md)) | M2 + every domain |
| **Authorization matrix** | every (role × scope × domain × action) → allow/deny; parity/cap; suspended/plan-disabled fail closed | M2 (framework), M5 (canonical), each M7 |
| **Database repository** | CRUD + constraints + FKs + optimistic concurrency against a real DB | M3 + each M7 |
| **Migration** | forward+rollback apply cleanly; up/down symmetry; no data loss | M3 + each migration |
| **Firestore emulator (semantic)** | rules actually deny/allow as intended (own-`/users` get only; everything else deny) | **M2 — mandatory pre-deploy gate** |
| **API contract** | request/response schema, error envelope, status codes, pagination, idempotency | M3 + each M7 |
| **Integration** | end-to-end request → authz → DB → audit → response | M3 + each M7 |
| **Real-socket** | server actually binds/serves; session cookie issued/verified over a real socket | M3/M4 |
| **Browser accessibility** | WCAG basics on tenant + admin SPAs | M8 |
| **Tenant-isolation** | tenant A cannot read/write tenant B; store roles cannot escape store | M5 + each M7 (**hard gate**) |
| **RLS negative** | the scoped app role **cannot** read/write another tenant, cannot touch audit tables, and cannot operate without tenant context (proves RLS, not just "policies exist") | M3/M5 + each M7 (**hard gate**) |
| **Security behavior** | authn/authz, unified permission-ordering, CSRF, MFA/step-up, SSRF egress allow/deny-list, webhook signature verification, audit immutability (UPDATE/DELETE rejected) | M2/M4/M8 |
| **SAST + dependency (SCA)** | static code flaws + third-party vulnerabilities on every PR | **M2 (G-APPSEC)** |
| **DAST** | runtime vulnerability scan against staging | M8 (G-APPSEC) |
| **Provider adapter** | egress uses allowlisted hosts; no request-controlled URL; webhook signature verified | M7e/M8 |
| **Payment (G-PCI)** | auth/capture/void/refund/dispute lifecycle; webhook signature verification; **idempotency + duplicate-charge prevention**; reconciliation vs provider settlement; **assert no PAN/CVV/track/PIN ever enters TM POS2026 (only opaque tokens)** | M7b |
| **Inventory consistency (G-INVENTORY-CONSISTENCY)** | a sale never reports a decrement without a durable/idempotent mutation-or-obligation; M7c reconciliation of M7b obligations is exact and idempotent | M7b→M7c |
| **DSAR (G-PRIVACY)** | cross-domain export completeness; correction; deletion/anonymization with retention/legal-hold honored; requester identity verification; **partial-completion is audited, never reported as complete** | M7 + M8/M9 |
| **Failure / rollback / idempotency** | partial-failure rolls back; retried idempotent write does not double-apply | M6 + each M7 |
| **Load / rate-limit** | distributed rate limits + `Retry-After` under load | M8 |
| **Staging smoke** | critical paths green on staging before promotion | M9 |
| **UAT** | owner/operator acceptance of end-to-end flows | M9 |
| **Backup/restore rehearsal** | restore from backup + PITR verified | M8/M9 |

## 3. Emulator / CI foundation (M2)

- **Java-enabled environment** stood up so the Firestore emulator runs; the semantic suite becomes a repeatable CI gate (clears M0 G-EMU as a *gate*, not a one-off). Until it passes, **no Firestore-rules deployment or go-live**.
- **CI pipeline** runs unit + authz-matrix + repository + migration + API-contract + emulator + tenant-isolation + RLS-negative + **SAST + dependency-audit (SCA)** on every PR; **red blocks merge**. The disabled Semgrep hook is restored here (G-APPSEC), not left as out-of-scope tooling.
- **Typecheck ratchet:** the baseline count may never increase; drive toward zero as production surfaces are typed. `tsc --noEmit` in CI.
- **Static Firestore guard retained** as a fast pre-emulator check (the existing 21/21 guard).

### 3a. Lockfile portability (M2 — a mandatory subcriterion of **G-APPSEC**)

**Ownership.** This is not a separate production gate. G-APPSEC already owns the dependency (SCA) audit, and `npm audit` reads `package-lock.json`: if the lockfile is not the artifact that installs, the audit scans a fiction and G-APPSEC's "scans green" pass rule proves nothing. Lock fidelity is therefore a precondition of G-APPSEC's own evidence, tracked in [08](./08-production-gate-and-risk-register.md) under that gate.

**Non-waivable.** G-APPSEC is a HIGH gate and therefore owner-waivable; this subcriterion is **not**. A G-APPSEC waiver may cover SAST/DAST/SCA findings but may never waive the pre-install portability checker, which blocks merge independently of that gate's disposition ([08, Security-HIGH waiver rule](./08-production-gate-and-risk-register.md)). The reasoning matters: "an unportable lock would fail the build anyway" is **false** — npm skips an unfetchable `optional`/`devOptional` package and `npm ci` exits 0, which is exactly how the original failure stayed green. The control cannot rest on the build failing loudly, so it is enforced by the checker and is not waivable with its host gate.

**Registry policy.** Every `resolved` URL in `package-lock.json` must be an HTTPS tarball on the exact host `registry.npmjs.org`, on the default port, carrying an `integrity` value. No other host — internal, private, loopback, link-local, `.local`, or any alternate registry — is permitted. `.npmrc` pins `registry=https://registry.npmjs.org/` for anyone who does not carry a conflicting environment.

**Why it is a gate and not a convention.** The committed lockfile had been generated behind an environment-internal mirror (`package-firewall.replit.local`, mounted under a `/npm/` path prefix): 688 of 1095 `resolved` URLs named a host that does not exist on a CI runner. The failure was silent rather than loud — npm marks some packages `devOptional`, and a `devOptional` package whose tarball cannot be fetched is **skipped**, leaving `npm ci` to exit 0 with the package absent. That is precisely how a green CI install shipped without `@types/react`, which degraded every JSX element to `any` and let the typecheck ratchet report zero while checking nothing.

**Ordering is the whole point.** Because the defect survives `npm ci` with a zero exit, `npm run lockfile:check` runs **before** `npm ci` in every installing job, is mandatory (never `--if-present`, never `|| true`), and depends only on Node built-ins so it needs no install to run. `typecheck:contract` remains **after** `npm ci`; the two are complementary — one proves the lockfile is fetchable from the public registry, the other proves the React types actually arrived.

**Recurrence is prevented by the gate, not by `.npmrc`.** npm resolves configuration CLI > environment > project `.npmrc`, so an environment that exports `npm_config_registry` still overrides the project file locally. Any lockfile regenerated in such an environment is re-contaminated silently. `.npmrc` is therefore a convenience for clean environments; **the fail-closed pre-install checker is the authoritative protection**, and lockfile changes must be reproduced with a clean-cache, public-registry install before they are trusted.

**Bundled dependencies.** `bundleDependencies` ship inside the parent's tarball and legitimately carry no `resolved` and no `integrity` of their own. They are not exempt: the gate requires the parent to exist, to be an approved integrity-pinned tarball, and to actually declare that name and a version the entry satisfies. `inBundle` is asserted by the file under review, so it is never trusted on its own.

## 4. Coverage gates

| Gate | Rule |
|---|---|
| Authorization | 100% of (role × scope × sensitive-action) pairs have an explicit allow/deny test before that surface ships |
| Tenant isolation | every domain has a passing cross-tenant + cross-store denial test (hard gate) |
| Money paths | POS/payments/invoices/refunds/billing have transaction + idempotency + rollback tests |
| Migration | every migration has an applied + rolled-back test |
| Emulator | semantic suite green in a Java-enabled env before any rules deploy |
| Lockfile portability (**G-APPSEC**) | every `resolved` URL is an HTTPS `registry.npmjs.org` tarball with `integrity`; checked **before** `npm ci`, fail-closed. A lockfile change is untrusted until reproduced by a clean-cache, public-registry `npm ci` |
| Deterministic-suite ratchet | the runner fails closed if a configured test root is absent, if nothing is discovered, if the discovered count falls below the recorded baseline, or if a named sentinel suite disappears — a count alone would be satisfied by unrelated files |
| No unverified critical surface | a Critical/High gap in [08](./08-production-gate-and-risk-register.md) cannot be marked closed without a passing test as evidence |

## 4a. Payment-gateway (store-owned) test & evidence design (M7b)

Future tests the store-owned gateway ([05 §5.1](./05-canonical-data-ownership-and-api-db-contracts.md), [04 §2.1](./04-canonical-iam-and-four-user-migration.md)) must pass:

- **Authorization:** Store Owner **allowed** to connect their store's gateway; an explicitly-authorized store user **allowed**; a **generic manager without the permission denied**; unmapped user **denied**; suspended user **denied**; user from **another store denied**.
- **System Owner boundary:** System Owner **cannot retrieve secrets**; cross-store connection access **denied**; System Owner cannot activate/impersonate a store connection outside a governed, store-consented, audited break-glass flow.
- **Isolation:** sandbox/production credential isolation; a terminal **cannot be paired across stores**; credential reference cannot be reassigned by client input; provider account id not accepted as authority.
- **Credential secrecy:** OAuth **state/PKCE + callback validation** where applicable; **secret never returned or logged**; **Test Connection occurs server-side** (never client→provider).
- **Webhooks & payments:** webhook **signature + account + store** validation; **replay rejected**; **duplicate payment prevented** (idempotency); provider **switching blocked with pending obligations**.
- **Audit:** durable audit exists for **connect / test / activate / replace / disconnect**.
- **Cross-domain consistency:** **shipping and payment credential-service contract consistency** (Shipping is upgraded to the same standard in M7e — [06](./06-module-migration-map-m7.md)).

## 5. Verification discipline

No milestone is "done" on assertion — each closes against **fresh command output** (test run, migration apply, emulator pass). Completion claims cite the evidence. Independent review (cross-model + a specialist reviewer) runs on each milestone's artifacts before accept-ready.
