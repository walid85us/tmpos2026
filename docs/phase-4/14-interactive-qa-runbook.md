# 14 — Interactive QA runbook (QA-INTERACTIVE-P1): the isolated tenant-backend session

**Status: operator runbook, documentation only.** It describes tooling that exists in the repository (`tests/qa/interactive/`, started with `npm run qa:interactive`). Nothing in this document says that any check below passes: every result line is left **PASS / FAIL — PENDING** for the owner to decide. Every production gate in [08](./08-production-gate-and-risk-register.md) stays OPEN. Nothing is deployed.

**Audience.** The repository owner, who types commands in Replit's Shell and tests in an ordinary browser. Commands are written exactly as typed. Where this runbook states what a command prints or what the app shows, the statement comes from the tooling's or the app's source; where it could not be checked in source it says "record what you see".

**How the examples were checked.** The command list, flags, refusal codes, labels, accounts and fixture names below were read from `tests/qa/interactive/*.mjs` and from the output of `npm run qa:interactive -- status` of run `qa-20261023t0805-5efa`, generation 1. Menu and button names were read from `src/`. Record ids are not listed here because they change on every start and reset; read them from `status`.

---

## 1. What this is, and what it is not

**It is** QA tooling that lets you exercise the server-backed part of the shop in a normal browser, with nothing real behind it:

- the **real tenant runtime** — `startTenantEntry`, the shipped routes, authorization, sessions, CSRF, request limits, transactions, idempotency and audits — running against
- an **owned, disposable PostgreSQL** cluster with migrations 001–035 applied (the same trusted-apply path the database test suites use), started by the tool and thrown away on `stop`/`reset`;
- the **Firebase Auth and Firestore emulators** (project `demo-tmpos-qa`, loopback only) as the stand-ins for sign-in and for the `users/{uid}` document, with the repository's own `firestore.rules` loaded into the Firestore emulator;
- a **separate QA build** of the shop (built into the run directory, never into `dist/`), served by a small front on port 5000 so that the Replit Preview shows it. The ordinary `src/firebase.ts` and the ordinary build are untouched; the QA build talks only to the Preview's own origin.

**It is not** a deployment, a staging environment, a production-readiness claim, or a test of any real provider. Specifically:

- All data and credentials are fictional (`*@tmpos-qa.test`, `example.test`, "(QA)" names, "(synthetic)" lines). No real Firebase project, database, payment, email or shipping provider is contacted; the QA build contains none of the live Firebase configuration values (the tool checks this before it serves anything).
- The only substituted part of the runtime is the token verifier. It accepts only ID tokens that the Auth emulator actually issued in this run (the front records every token the emulator hands out, and so do the seed's and the probe's own sign-ins), for this run's seeded accounts, with a lifetime of at most one hour; an `iat` more than 60 seconds ahead is refused (a small clock allowance); a hand-made or replayed token for a seeded uid is refused. The front never forwards an `Authorization` header to the Auth emulator, and it refuses `accounts:lookup` or Firestore Listen credentials that are not such a token (the emulators' own admin credential, `Bearer owner`, passes no route). An identity request it forwards must have an exact content type (`application/json`, or `application/x-www-form-urlencoded` for a token refresh; the only parameter allowed is `charset=utf-8`), no compressed body, and, for `accounts:lookup`, a body whose only key is `idToken`; anything else is answered 404 `not_found` (the app's own SDK requests meet this). A GET or HEAD request that carries a body is refused with 400 `bad_request`. Every route handler and rule is the shipped one.
- **The issued-token ledger, for testers.** The front keeps a ledger of the ID tokens and refresh tokens the Auth emulator issued **in this run only** (two separate kinds: an ID token never passes as a refresh token or the reverse). It is bounded to the **500 most recent** entries (older ones are forgotten), kept **in memory only** (as digests; nothing is written to disk), and **emptied by `reset`**. A token refresh (`/securetoken.googleapis.com/v1/token`) is forwarded only when its body names exactly one recorded refresh token; an unrecorded or hand-made refresh token, or a refresh token in the query string, is refused with 404 `not_found` and never reaches the emulator. In practice: after a `reset`, or after a very long session with many sign-ins, a tab's old tokens no longer pass — sign in again.
- The page carries a fixed corner label, `QA ONLY · synthetic data · run <run id>`, and the browser tab title starts with `[QA]`.

---

## 2. Commands

Everything is typed in Replit's Shell, in the repository root. The `--` after the script name is required. Adding `--silent` (`npm run --silent qa:interactive -- status`) hides npm's own extra lines when a command fails.

```
npm run qa:interactive -- help
npm run qa:interactive -- start [--origin https://<host>] [--project demo-<id>]
npm run qa:interactive -- status
npm run qa:interactive -- scenario normal
npm run qa:interactive -- scenario held-void [invoice label]       (default inv-held)
npm run qa:interactive -- scenario aged-sign-in [account label]    (default owner-a)
npm run qa:interactive -- scenario stalled-reauth [account label]  (default owner-a)
npm run qa:interactive -- release
npm run qa:interactive -- evidence [label|id ...]   |   evidence --recent
npm run qa:interactive -- probe [--positive]
npm run qa:interactive -- reset
npm run qa:interactive -- stop
```

A refusal prints `Refused (<code>): <message>` (on standard error) and exits with code 2. Any other failure prints `Failed: <message>` (on standard error) and exits with code 1 — for example an unknown scenario, `probe` while a fault is pending, any command the session refuses because it is not ready (`Failed: the session is <state>`), or `the session did not answer in time`. Two outcomes exit with code 1 without a `Failed:` prefix, printed as ordinary output: `another start won (run <id>)` (§2.2) and `stop` finding the supervisor still running (§2.7).

### 2.1 Before the first start

1. **Stop the ordinary dev server.** The QA front must own port 5000. Replit's supervisor starts `npm run dev` by itself whenever port 5000 is free, so a dev server can reappear after any stop or reboot. `start` does not move to another port (never 5001): it refuses with `port_busy` instead. Press Replit's **Stop** button first.
2. `TM_POS_TEST_DATABASE_URL` must not be set in the Shell (`unset TM_POS_TEST_DATABASE_URL`). QA starts only its own database. An ambient `DATABASE_URL` or `PG*` variable (for example Replit's own database settings) is **not** a refusal and need not be unset: it is never passed to any process QA starts — the bundle build, the supervisor, the emulators and `pg_ctl` each get a scoped environment that names only what they need (`PATH`, their own `HOME`/`TMPDIR`, `LANG` and the QA settings). Only `TM_POS_TEST_DATABASE_URL` is refused.
3. At least 1200 MB of `MemAvailable` (the VM has about 8 GB and no swap).
4. Java 21 or newer for the Firestore emulator. If `java` is not on `PATH`, the tool looks for an `openjdk-21` in `/nix/store`; if there is no Java 21 or newer it refuses with `java_missing` (suggested fix in the message: `nix shell nixpkgs#jdk21_headless`, then start again from that shell).
5. The first start downloads the Firestore emulator jar (network access needed); later starts reuse it from `.cache/tmpos-qa/firebase-emulators/`.

### 2.2 `start`

Order of work: if a session is already running, report it and stop (options are not even checked then) → read options and the environment → clean up a stale record → check memory → check port 5000 → find Java → build the QA bundle (about two minutes) → check the bundle for live Firebase values → check port 5000 again → start one detached supervisor → wait up to 12 minutes for readiness.

It prints `Building the QA bundle (run <id>) …`, then `Starting the emulators, the disposable database and the tenant runtime (the first start downloads the Firestore emulator) …`, then progress lines of the form `  … <state>`, and finally the session summary (see §3; the same text `status` prints). The session keeps running after the Shell command ends.

**Start again while a session runs.** It prints `A QA session is already running (run <id>); nothing new was started and no other port is used.` followed by the current summary. Whatever options you give on that second call are not re-checked and change nothing.

**Two starts at the same moment.** If another `start` became the live session while yours was starting, yours prints `another start won (run <id>)` with the other run's id and exits with code 1; the other run is left alone, and yours removes its own run directory once its supervisor has given up. Use `status` to see the winning session.

**Leftovers of an earlier run.** When `start` (or `stop`) finds a stale record it cleans what that run owned and prints one line per step, prefixed `(previous run) ` on `start` (for example `(previous run) stopped the previous run's emulators (pid <pid>)`, `removed its cluster directory`, `removed its run directory`). A record that could not be read is removed with the note `the session record was unreadable and has been removed; check for leftover QA processes (ps) before starting`. A process that cannot be proved stopped is never deleted under: the clean-up is refused with `stale_cluster_running` or `stale_process_running` (table below).

**Refusals and failures** (all from `config.mjs` and `cli.mjs`):

| Code | When | What to do |
|---|---|---|
| `unknown_option` | any argument other than `--origin` and `--project`, an option given twice, or an option without a value. `--database-url` is one of these. The message names the argument's position or the option's name, never a value. | Remove the argument. |
| `ambient_database` | `TM_POS_TEST_DATABASE_URL` is set and not blank | `unset TM_POS_TEST_DATABASE_URL` |
| `not_demo_project` | `--project` is not `demo-` followed by 1 to 40 **lower-case** letters, digits or dashes (`PROJECT_SHAPE` in `config.mjs`; `demo-QA` and `demo_qa` are refused) | Use the default (`demo-tmpos-qa`) or another `demo-` name in that shape. |
| `origin_invalid` | `REPLIT_DEV_DOMAIN` is not a plain host name, or `--origin` is not exactly `https://<host>` (no port, path, query, credentials; not an IP address) | Fix or drop `--origin`. |
| `origin_mismatch` | `--origin` names a different host from `REPLIT_DEV_DOMAIN` | Drop `--origin`; on Replit the domain is supplied for you. |
| `origin_missing` | neither `REPLIT_DEV_DOMAIN` nor `--origin` gives a public host | Give `--origin https://<your preview host>`. |
| `low_memory` | `MemAvailable` below 1200 MB, or not reported | Free memory (stop other servers), then retry. |
| `port_busy` | something already listens on port 5000 — usually the dev server — either at the start or when the bundle build finishes | Replit's Stop button, then `start` again. |
| `java_missing` | no Java 21 or newer | See §2.1. |
| `build_failed` | the QA bundle did not build. The message gives the exit status and ends `its log is kept at <path>`: the build log is copied to `.cache/tmpos-qa/last-build.log` (readable only by you) and the run directory is removed | Read `.cache/tmpos-qa/last-build.log` and report it; nothing was started. |
| `live_config_in_bundle` | a file of the built bundle contains a live Firebase configuration value; the bundle is deleted and not served | Report it; do not work around it. |
| `start_failed` — session still running | the session did not become ready (unavailable, failed and still not stopped after 30 seconds, or 12 minutes passed) and its supervisor is still running. When the start reports `failed` (or `unavailable`), `start` first waits up to 30 seconds while the session reports `failed`, `unavailable` or `stopping`, because a failed start stops itself (during the first start an emulator that exits shows `unavailable` moments before the start fails and the session stops); only a supervisor still running after that wait gets this message: ``the QA session did not become ready: the session (run <id>) is still running in state <state>; run `stop` before starting again. Last log lines: …``. That supervisor still owns its processes and its run directory, which is kept | Run `stop`, then `start` once more; keep the log text. |
| `start_failed` — supervisor gone | the session did not become ready and its supervisor has exited (including one that stopped itself during that 30-second wait): `the QA session did not become ready. Last log lines: …`. Anything it left is cleaned first (lines prefixed `(this run) `) and the run directory is removed | `start` once more; keep the log text. If that clean-up itself is refused, the code is `stale_cluster_running` or `stale_process_running` with the log lines appended (rows below). |
| `stale_cluster_running` | a stale record's database server did not stop with `pg_ctl … stop` and could not be proved gone (the recorded postmaster still runs, or `pg_ctl status` did not report "not running" or "no data directory"), or any live process still names the recorded data directory on its command line (for example a server the record does not name, after a reboot); a directory a live process names is never deleted | The record and the cluster and run directories are kept. Stop it with the command the message names (`pg_ctl --pgdata <data dir> -m fast stop`), or end the process that names that directory (find it with `ps -eo pid,args` and look for the data directory), then run the same command (`start` or `stop`) again. |
| `stale_process_running` | a stale record's emulators, Firestore emulator JVM or database server (the message names which, and its pid) is still the recorded process after SIGTERM and SIGKILL (for the database server: SIGINT, then SIGQUIT) | The record and the directories are kept. End that process yourself (check with `ps -p <pid>`), then run the same command again. |

The start-failure message ends with the last 12 lines of each of the run's `supervisor.out`, `supervisor.log` and `emulators.log`, and of `.cache/tmpos-qa/last-run.log` and `.cache/tmpos-qa/last-emulators.log`, as far as they exist and are not empty. Each file's lines are headed `--- <path>` (relative to the repository root); the last two are headed `--- .cache/tmpos-qa/last-run.log (from an earlier run unless this run has finished)` and the same for `last-emulators.log`, because the supervisor writes them only when it finishes. With no file at all the tail reads `(no log)`.

### 2.3 `status`

Prints the summary below. With no session it prints `No QA session is running.`; if a record is left over (for example after a reboot) it prints `No QA session is running (a stale record remains; `start` or `stop` cleans it).`

```
QA session ready — run <run id>, generation <n>
Preview: https://<preview host>/  (the corner label reads "QA ONLY · synthetic data · run <run id>")
Fault: <reason>                                          (only when the session has become unavailable)
Accounts (fictional; sign in at /login with these):   (one row per account: label, email, password, role, tenant, stores)
Fixtures (label → id):                                   (one row per fixture: group, label, id, plus name or @store)
Faults: armed=<none | kind label> held=<none | label since <time>> aged-sign-in pending=<n>
  fault record: {…}      (up to the last five; see §6)
Processes: supervisor <pid>, emulators <pid>; ports: front 5000 (public), runtime <port>, auth emulator 9399, firestore emulator 8385 (loopback)
```

The `Accounts` and `Fixtures` blocks above are shortened here; §3 lists them in full. The first word after "QA session" is the state: `starting`, `ready`, `failed`, `unavailable`, `resetting` or `stopping`. `failed` lasts only an instant: a session whose start failed stops itself at once, so `status` then shows `stopping` or that no session is running. Anything but `ready` means the app's server calls answer 503. `status` reports `unavailable` if an emulator, the tenant runtime's listener or the database stops answering (the session checks them about every ten seconds and gives up after three misses in a row, about 30 seconds; a single slow answer under memory pressure is only logged), if a process of the session exits unexpectedly, or if a `reset` fails, so it never says `ready` over a dead part. The first such reason is printed as `Fault: <reason>` under the `Preview:` line. **`unavailable` is sticky:** the session does not recover by itself and `reset` cannot repair it (it is refused while the session is not `ready`); run `stop`, then `start`. `status` does not print the database location; the recorded cluster directory is the `clusterRoot` field of `.cache/tmpos-qa/current.json` (inside `.cache/tmpos-qa/`).

### 2.4 `scenario`, `release`

Print their result as JSON.

- `scenario normal` — `{ "disarmed": true, "released": … }`. Disarms the armed fault, releases a held sign-in, and clears any pending `aged-sign-in`.
- `scenario held-void [invoice label]` — arms the one-shot fault of §6 for that invoice fixture (default `inv-held`). Unknown label: `Failed: unknown invoice fixture: <label>`.
- `scenario stalled-reauth [account label]` — arms the one-shot stall of §6 for that account's next sign-in (default `owner-a`). Unknown label: `Failed: unknown account fixture: <label>`.
- `scenario aged-sign-in [account label]` — `{ "armed": "aged-sign-in", "account": "<label>" }`. See §6.
- `release` — forwards a held sign-in; prints `{ "released": false }` when nothing is held, otherwise `{ "releasedAt": …, "upstreamStatus": …, "deliveredToBrowser": true|false }`.
- Only one of held-void and stalled-reauth can be armed or held at a time; arming a second prints `Failed: a fault is already armed or a sign-in is held` (run `scenario normal` first). `aged-sign-in` is separate and can be pending at the same time.
- With no session: `Refused (not_running): no QA session is running; start one first`. With a session that is not `ready` (for example during `reset`): every command except `status` and `stop` is refused at once, with a `Failed:` message that names the state (`Failed: the session is <state>`); it is not queued behind the reset. From the moment a `reset` arrives until it has finished, the same commands — including a second `reset` — are refused with `Failed: the session is resetting`.

### 2.5 `evidence`

Read-only, bounded database evidence, printed as JSON; details in §6.

- `evidence` — the run summary.
- `evidence <label|id> [<label|id> …]` — one record each. A label is a **customer, draft or invoice** fixture label (`cust-ada`, `draft-edit`, `inv-probe`, …) or a record id (a UUID). A tenant or store label is not accepted.
- `evidence --recent` — the five newest customers, drafts and issued invoices of the two QA tenants.

### 2.6 `probe`

`probe` sends four bounded refusal requests (item 10) through the QA front; `probe --positive` sends those four and then the positive control. It prints a JSON object with one entry per request, each `{ "status": <http status>, "body": "<first 160 characters of the response>" }`:

| Entry | Request | What the runtime should answer (from `server/runtime/app.ts`: 401 is `unauthenticated`, other refusals are `forbidden`) |
|---|---|---|
| `no session` | void of `inv-probe` with no session cookie | 401 |
| `restricted: tech-a (Invoices View Only)` | the same, signed in as `tech-a` | 403 |
| `owner-a without X-TMPOS-CSRF` | owner-a's session, header `X-TMPOS-CSRF` removed | 403 |
| `owner-a with a wrong session CSRF value` | owner-a's session, first character of the session CSRF value changed | 403 |
| `positive control: owner-a` (only with `--positive`) | the same void as owner-a, correct headers | the void succeeds |

The positive control **really voids `inv-probe`** and cannot be undone until `reset`. Run it once per generation. `probe` refuses to run while a fault is armed or held or an `aged-sign-in` is pending: it prints ``Failed: a fault is armed or pending; run `scenario normal` first`` (a plain failure, exit code 1, not a `Refused`). Run `scenario normal`, then `probe`.

### 2.7 `reset` and `stop`

- `reset` prints `Resetting: every synthetic record and session of this run is discarded …` (can take minutes), then the new summary. It runs only on a `ready` session; while another reset is queued or running it is refused with `Failed: the session is resetting`. If the previous generation's database server cannot be proved stopped, the reset does not start a second cluster beside it: it fails, the server keeps its data directory, and the session stays `unavailable` (`Fault: reset failed: …`) until `stop` and `start`. A `stop` sent while a reset is running waits for that reset to finish (at most 120 seconds) and then stops everything; a reset that has not yet started its new cluster when the `stop` arrives starts none. See §7.
- `stop` closes the front, the tenant runtime, the emulators and the database, deletes the run directory and prints ``Stopped run <id>: … Restore the ordinary Preview with Replit's Run button or `npm run dev`.`` With nothing running it prints `No QA session is running.` With a stale record it cleans the leftovers, printing one line per step, then `The recorded session was no longer running (e.g. after a reboot); its leftovers are cleaned.` (or refuses with `stale_cluster_running` / `stale_process_running`, §2.2). If the session itself could not prove one of its processes stopped, it keeps its record and its run directory (its log says `leftover processes; the record is kept for cleanup`); a database server that will not stop also keeps its data directory (it is never deleted under a running server) and `stop` cleans that record the same way before it prints `Stopped run …`.
- **`stop` when the supervisor will not end.** `stop` asks the session to stop and waits up to 240 seconds for it to finish (a session in the middle of a reset may first wait up to 120 seconds for that reset, then stops everything, which can take about two minutes more), then sends the supervisor SIGTERM and waits 30 seconds more. If it is still running it prints `Run <id> is still running (supervisor pid <pid>) after SIGTERM; nothing was cleaned. Run stop again, or end that process yourself.` and exits with code 1 (no `Failed:` prefix). Nothing was deleted; run `stop` again, or end that pid yourself (check with `ps -p <pid>`) and then run `stop` once more to clean the leftovers.

### 2.8 Restoring the ordinary frontend afterwards

```
npm run qa:interactive -- stop
```

then press Replit's **Run** button (or type `npm run dev`). Replit may also start `npm run dev` on its own once port 5000 is free. Port 5000 cannot be shared: while QA runs the ordinary dev server cannot run, and while the dev server runs `start` refuses.

---

## 3. The session you have now

**Preview URL (this workspace):** `https://70fecabe-2df6-4353-8c25-cf5ce1c5075d-00-16avf9cycmdtz.worf.replit.dev/` — the session left running for the hand-over is run `qa-20261023t1522-8ffb`, generation 1 (every `start` makes a new run id and every `reset` a new generation; `status` and the corner label show the current ones). Open exactly this address: the front answers only requests whose Host is exactly the Preview host (anything else gets `404 {"error":"host_not_served"}`). Sign in at `/login`.

### 3.1 Accounts (fictional; shortened from `status`, which prints the same five rows)

| Label | Email | Password | Role | Tenant | Stores |
|---|---|---|---|---|---|
| `owner-a` | `owner-a@tmpos-qa.test` | `qa-owner-a-pass` | `store_owner` | `tenant-a` | `store-a-main`, `store-a-harbor` |
| `manager-a` | `manager-a@tmpos-qa.test` | `qa-manager-a-pass` | `manager` | `tenant-a` | `store-a-main` |
| `tech-a` | `tech-a@tmpos-qa.test` | `qa-tech-a-pass` | `technician` | `tenant-a` | `store-a-main` |
| `sales-a` | `sales-a@tmpos-qa.test` | `qa-sales-a-pass` | `sales_staff` | `tenant-a` | `store-a-main` |
| `owner-b` | `owner-b@tmpos-qa.test` | `qa-owner-b-pass` | `store_owner` | `tenant-b` | `store-b-main` |

Use the email and password fields on the sign-in page. The Google sign-in button cannot work here (§5).

### 3.2 Fixtures (shortened: labels stay, ids change on every start and reset; `status` prints the ids)

| Group | Label | What it is | Used for |
|---|---|---|---|
| tenant | `tenant-a` | QA Northwind Repairs (synthetic) | items 3–10 |
| tenant | `tenant-b` | QA Southfield Mobile (synthetic) | item 5 |
| store | `store-a-main` | Northwind Main (QA) — issuing settings are configured; every draft and invoice below is here | items 6–11 |
| store | `store-a-harbor` | Northwind Harbor (QA) — only `owner-a` is a member; no issuing settings, no records | item 5 (store choice) |
| store | `store-b-main` | Southfield Central (QA), tenant-b | item 5 |
| customer | `cust-ada` | Ada Fictional (QA), phone and email given (tenant-a) | draft and invoice customer |
| customer | `cust-ben` | Ben Placeholder (QA), name only (tenant-a) | `draft-discard` |
| customer | `cust-zoe` | Zoe Southfield (QA), phone and email given (tenant-b) | item 5 |
| draft | `draft-edit` | one line, 42.00 USD, customer `cust-ada` | item 6 (edit, conflict) |
| draft | `draft-discard` | one line, 15.00 USD, customer `cust-ben` | item 6 (discard) |
| draft | `draft-issue` | two lines, 29.00 + 30.00 USD, customer `cust-ada` | item 7 (issue) |
| invoice | `inv-void` | issued, 50.00 USD, `cust-ada` | item 7 (void) |
| invoice | `inv-held` | issued, 50.00 USD | item 8 (held void) |
| invoice | `inv-stall` | issued, 50.00 USD | item 9 (stalled sign-in) |
| invoice | `inv-probe` | issued, 50.00 USD | item 10 (refusals, positive control) |
| invoice | `inv-voided` | issued, then voided during the seed (reason "Issued by mistake") | an already-terminal invoice |
| invoice | `inv-b` | issued, 9.00 USD, `cust-zoe`, tenant-b / `store-b-main` | item 5 |

All business records were made through the real routes as the seeded accounts, not inserted behind them. `evidence <label>` prints the invoice **number** and a draft's **created time**, which is how you find the matching row in the app (rows show numbers and times, not labels).

### 3.3 What each account can do (adopted defaults)

These follow the adopted defaults in `server/platform-identity/permissionCatalog.ts` (`TENANT_ROLE_PERMISSION_DEFAULTS`: manager Customers Full / Invoices Full; technician View / View; sales_staff Create / Create; store_owner full by the owner rule) and the adopted thresholds recorded in docs [11](./11-m7b-invoice-draft-discard-decision-pack.md), [12](./12-m7b-invoice-issue-decision-pack.md) and [13](./13-m7b-invoice-void-and-correction-decision-pack.md), enforced by migrations 020–035 and the route handlers.

| Action (threshold) | `owner-a` | `manager-a` | `tech-a` | `sales-a` |
|---|---|---|---|---|
| Read customers (Customers ≥ view) | yes | yes | yes | yes |
| Create a customer (≥ create) | yes | yes | no | yes |
| Edit a customer (≥ edit) | yes | yes | no | no |
| Create a draft (Invoices ≥ create **and** Customers ≥ view) | yes | yes | no | yes |
| Edit a draft (Invoices ≥ edit) | yes | yes | no | no |
| Discard a draft (Invoices ≥ manage) | yes | yes | no | no |
| Issue an invoice (Invoices ≥ approve **and** Customers ≥ view) | yes | yes | no | no |
| Void an invoice (Invoices ≥ approve; also needs a recent sign-in, §6) | yes | yes | no | no |
| Issuing settings; the two server-saved role-level panels (owner only) | yes | no | no | no |

The table holds only while nobody has changed a level. Item 4 changes one and restores it.

---

## 4. The twelve owner checks

Each item says which account and fixture to use, the exact clicks, which operator commands to run and when, and what to compare. The result lines are deliberately empty: **only the owner decides**. Two sessions at once (item 4, 5, 6) need a second browser or a private window/profile, because the signed-in user is stored per browser profile.

Navigation names (left sidebar): **Customer Directory**, **Employees**, **Invoices**. Employees has a **Permissions** tab. The Invoices page has two server sections: **Server drafts** (button **Show server drafts**) and **Issued invoices** (button **Show issued invoices**); each has a **Choose a store…** list.

### Item 1 — Start and identify the isolated session

- Account: none yet. Fixtures: none.
1. Stop the dev server (Replit **Stop**). In the Shell: `npm run qa:interactive -- start`. Wait for `QA session ready`.
2. `npm run qa:interactive -- status`. Confirm: first line `QA session ready`; one `Processes:` line with a supervisor and an emulators pid; `ports: front 5000 (public)`, and the other three ports on loopback. To see the database answering, run `npm run qa:interactive -- evidence` (it reads the disposable database and prints `generation`, `idempotency` and both tenants); `grep clusterRoot .cache/tmpos-qa/current.json` shows where the disposable cluster lives (under `.cache/tmpos-qa/`).
3. Open the Preview URL from the `Preview:` line.
4. Confirm the corner label `QA ONLY · synthetic data · run <id>` and that `<id>` and the generation equal `status`.
5. Run `start` again. Expect `A QA session is already running (run <same id>); nothing new was started and no other port is used.` To check nothing listens on 5001, use a listener listing if the Shell has one (for example `ss -ltn`); the tool itself never opens 5001.

Result: PASS / FAIL — PENDING
Notes:

### Item 2 — Synthetic sign-in without live services

- Account: `owner-a`.
1. Open `<Preview URL>login` in a normal browser window. Sign in with `owner-a@tmpos-qa.test` / `qa-owner-a-pass` (not a real Firebase account).
2. Open the browser's Network tool **before** signing in (read-only observation; nothing needs to be intercepted or injected). Expect the identity and data requests to go to the same host as the page, for example `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`, `/securetoken.googleapis.com/v1/token`, `/google.firestore.v1.Firestore/Listen/channel` and `/api/v1/…`. Confirm every request goes to the Preview host: none may go to a Google host such as `identitytoolkit.googleapis.com` or `firestore.googleapis.com` (those names appear only inside the paths). (The page's content-security policy allows only the page's own origin for connections.)
3. Reload the page. Record what happens (stays signed in, shows the sign-in page, a reconnect notice). That behaviour belongs to the app; the runbook does not predict it.
4. Confirm that you did not need any DevTools request override, extra extension, or pasted cookie.
- Operator command: none needed; `status` shows the same run id.

Result: PASS / FAIL — PENDING
Notes:

### Item 3 — Customers persist through the real API

- Account: `owner-a`. Fixtures: `cust-ada` (to see the seeded shape).
1. Sidebar **Customer Directory**. The seeded customers `Ada Fictional (QA)` and `Ben Placeholder (QA)` are listed.
2. In the add form fill **Name** (a unique fictional name, for example `Casey Runbook (QA)`), **Phone (optional)** `+1 555 0142`, **Email (optional)** `casey.runbook@example.test`; press **Add customer**. Wait for the notice that it was saved on the server.
3. Open the new customer's profile (the address becomes `/customers/directory/<id>`; the id is also what `evidence` takes). Confirm name, phone, email and **Created**.
4. Press **Edit**, change the phone, press **Save**, and wait for the confirmed `Saved` notice.
5. Reload the page and open the profile again; confirm the saved phone.
6. Evidence: before step 2 run `npm run qa:interactive -- evidence` (note `tenant-a` `customers` and the `tenant.customer.create` count; on a fresh seed they are 2 and 2). After step 5 run `npm run qa:interactive -- evidence --recent` (the new customer is first), then `npm run qa:interactive -- evidence <id from the address>`. Compare: the row's `name`, `phone`, `email`, `created_at` equal the screen; `row_version` after the edit is one higher than after the add (the smoke run saw 2 after one edit); `audits` lists the actions recorded for that customer (the edit appears as `tenant.customer.update`, count 1 after one edit); the creation is counted in `tenantCreateAudits`, which is one higher than before (3 on a fresh seed).

Result: PASS / FAIL — PENDING
Notes:

### Item 4 — Server-saved role panels decide access

- Accounts: `owner-a` (first browser), `sales-a` (second browser or private window). Panels: **Employees** → **Permissions** tab → **Server-enforced Customers access** and **Server-saved Invoices level**. The role rows are the built-in ones; the sales role is shown as **Sales Associate** (role id `sales_staff`).
1. Evidence first: `npm run qa:interactive -- evidence`; note the `roleLevels` entries for `tenant-a` (`role_id`, `domain`, `level`, `version`) and the audit counts. A level that was never edited may show no row or `(default)`.
2. As `owner-a`, in **Server-enforced Customers access**, for the **Sales Associate** row choose **View Only** (from the pickers: None, View Only, Create, Edit, Full Access), type a reason of 10–500 characters, press **Save to server**. If the panel shows **Confirm your sign-in to save this change**, enter `qa-owner-a-pass` and press **Confirm sign-in**. Confirm the row reads **Saved** and, after leaving and reopening the tab, still shows the new level (fresh read-back).
3. In the second browser sign in as `sales-a` and open **Customer Directory**; try **Add customer** with a fictional name. The server decides: with Customers at View Only the create must be refused (the smoke run saw HTTP 403, and the page may still offer **Add customer** until it re-reads the policy). Reload or sign out and in, and try again; write down what the page offers and what is answered, before and after the reload. As a second check, compare with §3.3: at Create `sales-a` may add but not edit.
4. Compare with evidence: `npm run qa:interactive -- evidence` again — the `sales_staff` / `customers` entry shows `view` and a higher `version`, and the audit counts have grown by the saved change; no customer was added.
5. Restore: choose **Create** again for **Sales Associate**, a reason, **Save to server** (confirm the sign-in if asked). Run `evidence`: the level is back to `create` and the `version` is higher still (a version does not go back). The same can be repeated in **Server-saved Invoices level**.

Result: PASS / FAIL — PENDING
Notes:

### Item 5 — Store and tenant isolation hold

- Accounts: `owner-a` (tenant-a), `owner-b` (tenant-b, second browser), `manager-a` (one store). Fixtures: `cust-ada`, `cust-zoe`, `inv-void`, `inv-b`.
1. As `owner-a`, open **Customer Directory** → `Ada Fictional (QA)`. Copy the id from the address `/customers/directory/<id>`. Run `npm run qa:interactive -- evidence cust-ada cust-zoe inv-b` and keep the output (tenants, `row_version`, `audits`).
2. In the second browser sign in as `owner-b` (tenant-b). The directory lists only `Zoe Southfield (QA)`.
3. In the address bar type `<Preview URL>customers/directory/<Ada's id>`.
4. Expect the app's not-found text `No customer with this address is available in this store.`, no name, phone or email of Ada anywhere. Repeat in the other direction (`owner-a` opens Zoe's address).
5. Run the same `evidence cust-ada cust-zoe inv-b` and confirm `row_version` and `audits` did not change.
- Store choice: as `owner-a`, **Invoices** → **Show issued invoices** → **Choose a store…** lists `Northwind Main (QA)` and `Northwind Harbor (QA)` (Harbor is empty); as `manager-a` the list should offer only `Northwind Main (QA)`; as `owner-b` only `Southfield Central (QA)`. Record what each list shows.
- **Invoice half (read-only request from the browser's own console):** the app has no address that opens an invoice by id, so use one plain same-origin read. Signed in as `owner-b`, open the browser's developer Console and run `fetch('/api/v1/stores/<store-a-main id>/invoices/<inv-void id>').then(r => r.text().then(t => console.log(r.status, t)))`, with the two ids from `status`. Expect a refusal (the smoke run saw 403 with a body naming only `forbidden` and a request id) and no data of tenant-a. This is an ordinary request with your own session, not a request override. Then run `evidence inv-void inv-b` before and after to show both invoices are untouched.

Result: PASS / FAIL — PENDING
Notes:

### Item 6 — Draft lifecycle and conflicts use PostgreSQL

- Account: `owner-a`. Fixtures: `draft-edit`, `draft-discard`, store `store-a-main`.
1. **Invoices** → **Show server drafts** → **Choose a store…** → `Northwind Main (QA)`. Evidence: `npm run qa:interactive -- evidence` (note `drafts_open`, `idempotency`).
2. Create: **New server draft** → choose the customer from the server list (search `Ada`) → add a line → **Save draft**. `evidence --recent` lists it first; `evidence <id>` shows `status` `draft`, `version`, `line_count`, `subtotal_cents`, audits and outbox.
3. Two tabs: open `draft-edit` in tab 1 and tab 2 (the row is **Open** with the draft's created time; `evidence draft-edit` prints `created_at` to find it) and press **Edit draft** in both. In tab 1 change a line and save. Run `evidence draft-edit`: `version` is one higher.
4. In tab 2 (older) change something and save. Confirm the app's existing conflict view (**Your changes and the draft on the server now**) and its review flow; do not force it. Run `evidence draft-edit` again: `version` is unchanged by the conflicted save.
5. Discard: open `draft-discard` → **Discard draft…** → confirm. `evidence draft-discard` shows `status` `discarded`; `evidence` shows `drafts_discarded` one higher and the `idempotency` counts (counts only; digests are never shown).

Result: PASS / FAIL — PENDING
Notes:

### Item 7 — Issue and void follow the adopted authority rules

- Account: `owner-a` (manager-a can repeat it). Fixtures: `draft-issue` to issue; `inv-void` to void.
1. `npm run qa:interactive -- evidence draft-issue inv-void` — `draft-issue` is a `draft`, `inv-void` is `issued` (note its `number`).
2. **Invoices** → **Show server drafts** → store `Northwind Main (QA)` → open `draft-issue` → **Issue invoice…** → check the review → **Issue invoice**. Confirm the issued state and details the page shows. `evidence draft-issue` now shows `status` `issued`; `evidence --recent` lists the new issued invoice first (its `number`, `issued_at`).
3. **Show issued invoices** → store `Northwind Main (QA)` → open the `inv-void` row (by its number) → **Void invoice…**. If you have signed in within the last 10 minutes no extra sign-in is needed; if the page asks **Confirm your sign-in to void this invoice**, enter the password and press **Confirm sign-in** (§6 explains how to make this prompt appear on purpose).
4. Confirm the dialog title reads `Void invoice <number>?` for the right number, choose a reason (for example **Issued by mistake**), press **Void invoice** once.
5. Reload. `evidence inv-void`: `state` `voided`, `void.reason_code`, `voided_at`, and the audits for that invoice; `evidence` summary: `invoices_voided` one higher (2 on a fresh seed) and `invoices_issued` one higher (6) after the issue. Compare that each action appears once in the audits, with no duplicate.

Result: PASS / FAIL — PENDING
Notes:

### Item 8 — A held outcome recovers without a duplicate action

- Account: `owner-a`. Fixture: `inv-held`.
1. Sign in fresh (within the last 10 minutes). `npm run qa:interactive -- evidence inv-held` (state `issued`; note `number`). Arm: `npm run qa:interactive -- scenario held-void` (the default is `inv-held`; `status` now shows `armed=held-void inv-held`).
2. **Invoices** → **Show issued invoices** → `Northwind Main (QA)` → open the `inv-held` row → **Void invoice…** → choose a reason → **Void invoice**, once. The browser receives no answer from the app's server: the front closes the connection and the Replit edge turns that into an HTTP 502. The page shows the unresolved state, in the smoke run: `Void of invoice <n> at Northwind Main (QA) is not confirmed. The server may or may not have voided it. The server answered, but not with a result.` with **Check again** and **Check invoice** (and **Dismiss** on the card). `status` now shows `armed=none` (the fault is one-shot) and a `fault record:` line for the held void.
3. Read the outcome two ways. `npm run qa:interactive -- status` prints `fault record: {"kind":"held-void","label":"inv-held","at":…,"upstreamStatus":…,"committed":…,"upstreamError":…}`; `committed` is `true` when the real runtime answered 200, `false` when it answered another status, and `null` when the front got no answer at all (`upstreamStatus` is then `null` and `upstreamError` names why: `unavailable`, `timeout` or `too_large`, as in §6): `null` means unknown, not "did not happen". Confirm with `npm run qa:interactive -- evidence inv-held`: `state` `voided` with a `void` row and its audit means the void ran; `state` still `issued` with `committed` false means it was refused before it ran (for example a stale sign-in; arm again and repeat); with `committed` null the evidence alone decides.
4. Press **Check again** (it resends the same request with the same key and the same bytes) or **Check invoice** on the card or in the dialog, as the page directs; do not start a second void by hand. Read the text it shows. In the smoke run **Check again** resolved to `Invoice <n> at Northwind Main (QA) was voided.`
5. Compare with `evidence inv-held` and `evidence`: the page's statement agrees with the database; the invoice has exactly one void audit (the resend is an idempotent replay, not a second void); `invoices_voided` rose by exactly one.
6. Afterwards `npm run qa:interactive -- scenario normal` (harmless if already used).

Result: PASS / FAIL — PENDING
Notes:

### Item 9 — Stalled recent sign-in remains escapable

- Account: `owner-a`. Fixture: `inv-stall`. The void asks for a recent sign-in only when the login is older than 10 minutes. Two ways to get there:
  - **Either (fast)** — before signing in as `owner-a` run `npm run qa:interactive -- scenario aged-sign-in owner-a` (`status` shows `aged-sign-in pending=1`). **Sign out of `owner-a` first, in every tab, then arm, then sign in:** the fault applies to the account's *next* tenant login, and that can be a re-authentication rather than the sign-in you meant. **Honest statement of what this does:** the QA verifier records that one login with a sign-in time 11 minutes earlier than the emulator's token says; the 10-minute rule therefore asks for a recent sign-in at once. It changes that single login's `auth_time` and nothing else — not the clock, not the token, not any other account, not any rule; it applies once and is then used up. The re-authentication that follows is verified with its true time.
  - **Or (slow)** — sign in and wait 10 real minutes before step 1.
1. `evidence inv-stall` (state `issued`; note `number` and the audit list). **Invoices** → **Show issued invoices** → `Northwind Main (QA)` → open `inv-stall` → **Void invoice…** → choose a reason → **Void invoice**. The page should ask **Confirm your sign-in to void this invoice** and show a password field.
2. Now arm: `npm run qa:interactive -- scenario stalled-reauth owner-a`. Enter `qa-owner-a-pass` and press **Confirm sign-in**. The sign-in request is held by the QA front: `status` shows `held=owner-a since <time>`.
3. Observe the bounded wait. Either press **Stop waiting** (the page says it stopped waiting and sent nothing for this invoice) or let the 30-second deadline pass (`Not voided: this page stopped waiting for your sign-in after 30 seconds and sent nothing for this invoice. You can try again.`). Close the review.
4. Release the late answer: `npm run qa:interactive -- release`. It prints `releasedAt`, the emulator's `upstreamStatus`, and `deliveredToBrowser` (true only if the browser was still connected). What the app does with a late answer is its own 30-second rule; record whether the old review revives or sends anything.
5. Navigate elsewhere in the app and back (normal navigation should still work). `evidence inv-stall`: `state` still `issued`, audit list unchanged from step 1. Finish with `npm run qa:interactive -- scenario normal`.

Result: PASS / FAIL — PENDING
Notes:

### Item 10 — Backend refusals change no business state

- Fixture: `inv-probe`. Accounts used by the tool itself: `tech-a` (restricted) and `owner-a` (positive control). No browser needed.
1. `npm run qa:interactive -- scenario normal` (the probe refuses to run while a fault is armed or held or an aged sign-in is pending: ``Failed: a fault is armed or pending; run `scenario normal` first``), then `npm run qa:interactive -- evidence inv-probe` and `npm run qa:interactive -- evidence`; keep both (`state` `issued`, the audit list, the `idempotency` counts).
2. `npm run qa:interactive -- probe`. Expect four entries: `no session` 401; `restricted: tech-a (Invoices View Only)` 403; `owner-a without X-TMPOS-CSRF` 403; `owner-a with a wrong session CSRF value` 403 — with the runtime's `unauthenticated` or `forbidden` error body. Compare each status and body with those names; write down any difference.
3. `evidence inv-probe` and `evidence` again. Expect the invoice still `issued`, no new audit, and the business counts unchanged. Compare the `idempotency` counts too: if they changed, record by how much (the output shows counts only) and say which request is the likely cause; whether a refused request leaves such a record is not established by this runbook.
4. Positive control: `npm run qa:interactive -- probe --positive` (it repeats the four refusals and then voids `inv-probe` as `owner-a`). The last entry is `positive control: owner-a`. `evidence inv-probe`: `state` `voided`, with its void row and audit.

Result: PASS / FAIL — PENDING
Notes:

### Item 11 — Responsive controls remain usable

- Account: `owner-a`. Screen: **Invoices** → **Issued invoices**, with a recovery card or a void dialog open. The easiest way to have one is to do item 8 or item 9 first (use a fixture not yet used; after items 7, 8 and 10, which void `inv-void`, `inv-held` and `inv-probe`, the issued invoices left in Northwind Main (QA) are `inv-stall` and the invoice item 7 issued from `draft-issue`; `inv-b` is tenant-b's, in Southfield Central (QA). Run `reset` first if you need the seeded fixtures again).
1. Desktop: a window 1440 px wide and about 1000 px high (the size the repository's browser tests use as the desktop reference). Check the sidebar, the invoice rows and the action labels (**Void invoice…**, **Check again**, **Check invoice**, **Dismiss**, **Stop waiting**, **Close**).
2. 320 px wide with 24 px text: in Chrome a 1280 px window at 400 % zoom lays out at 320 CSS px (the repository's tests use this), and the text size is the browser's own font-size setting (Chrome Settings → Appearance → Font size; "Very large" is 24 px).
3. 768 px wide with 24 px text: the same font setting; the window or the DevTools device toolbar set to 768 px.
4. At each size scroll normally and operate the recovery or close controls by pointer **and** keyboard (Tab to the control, Enter or Space).
5. Confirm the sidebar never covers the intended action and no hidden styling or forced click was needed. Record the size, text size and what overflowed, if anything.

Result: PASS / FAIL — PENDING
Notes:

### Item 12 — Reset and stop affect only QA-owned resources

1. Record the run id (`status`) and the generation, and create a new fictional customer and a draft (item 3 and item 6 steps). Optionally `git status --short` and `ls .cache/tmpos-qa` for a before-picture.
2. `npm run qa:interactive -- reset`. Old tabs are now stale: their Firebase accounts, tokens and server sessions belong to the discarded generation, so they end up signed out or failing; sign in again with the same passwords (the account uids change, the emails do not).
3. After the reset `status` shows generation 2 and a new list of ids. Sign in again; `Customer Directory` and the drafts list show only the fresh seed. `evidence --recent` shows no record created before the reset.
4. `npm run qa:interactive -- stop`, then `npm run qa:interactive -- status` (expect `No QA session is running.`). The Preview no longer shows the QA page; `ls .cache/tmpos-qa/runs` has no run directory for this run (`last-run.log` stays in `.cache/tmpos-qa`; `last-emulators.log` is written there only after a failed start, so one seen now comes from an earlier failed start).
5. Confirm nothing else changed: `git status --short` shows the same files as before, your ordinary dev server comes back with Replit's **Run** button, and unrelated files are untouched. To leave the session ready for more QA, stop the dev server (Replit **Stop**) if Replit restarted it, then `npm run qa:interactive -- start` once.

Result: PASS / FAIL — PENDING
Notes:

---

## 5. Readiness: what is real, what is emulated, what is not here

| Area | What you are really exercising | How it is provided |
|---|---|---|
| **Real runtime on a real PostgreSQL** | Customers (list, read, create, edit, profile), the server-saved role levels (Customers and Invoices), invoice drafts (create, list, edit, conflict, discard), issuing settings and issue, void, held-attempt recovery, tenant sessions, CSRF, request limits, audits, idempotency | The shipped tenant runtime and routes on the owned disposable PostgreSQL (migrations 001–035). Authorization, transactions and audit writes are the real ones. |
| **Local emulation** | Sign-in, re-authentication (the void's recent sign-in, role-level saves), token refresh | Firebase Auth emulator (`demo-tmpos-qa`, loopback), reached through the QA front. Real browser SDK calls, an emulator behind them. |
| **Local emulation** | The user's role and name document | Firestore emulator serving only `users/{uid}` under the repository's own `firestore.rules`. |
| **Browser-only legacy features** (in-memory / `sessionStorage`; nothing is saved on the server, a reload or sign-out loses it) | Dashboard, POS (Sales), Repairs, Inventory, the legacy Customers screen, Employees role edits other than the two server-saved panels, Warranties, the legacy Invoices table, Services, Supply Chain, Returns, Marketing, Reports, Settings, Support, Prospects, Integrations, Widgets, Shipping Center | They run as in the ordinary app; QA gives them no server. Looking at them proves nothing about the backend. |
| **Unavailable in QA** | Google sign-in popup; the admin console (`/admin` flows — this stack has no admin entry and the front routes no admin API); deployment; real providers (payment gateways, email, shipping, hosted database) | Not provided, by design. |

## 6. Faults and evidence: exact semantics

**Faults** are armed only from the Shell (a private control channel inside the run directory); nothing over HTTP can arm, read or release one. Each fault is one-shot.

- **`held-void`** — the next `POST` to the void route of the named invoice (exactly that store and invoice) is **forwarded to the real runtime and the real void transaction runs**; the answer is then withheld: the front closes the browser's connection, which the Replit edge shows the app as an HTTP 502, and the app treats it as unresolved. The upstream status and `committed` are recorded and **`status` prints the last five records**, one per line, as `  fault record: {"kind":"held-void","label":…,"at":…,"upstreamStatus":…,"committed":…,"upstreamError":…}`. `committed` is `true` only for a 200, `false` only for another real status from the runtime, and `null` (unknown) when the front got no answer — then `upstreamStatus` is `null` and `upstreamError` is `unavailable` (no connection or a broken one), `timeout` (no answer within 30 seconds) or `too_large` (a body without a declared length, or chunked, that streamed past 128 KiB: the front cut it off and answered 413, so the runtime never received the whole request). A request whose declared `Content-Length` is over 128 KiB is refused with 413 before the fault is taken: nothing is recorded and the fault stays armed. Read the evidence to learn whether the void ran. (A held sign-in's record has `heldAt`, `browserLeftAt`, and after a release `releasedAt`, `upstreamStatus`, `deliveredToBrowser`.) Confirm the outcome with `evidence <invoice>` (`state` `voided`/`issued`). If the armed request is itself refused (for example a stale sign-in), it is the one the fault takes and `committed` is false; arm again. **Check again** resends the same key and bytes, so it resolves to the same result: an idempotent replay with still one void audit.
- **`stalled-reauth`** — the next sign-in request (`accounts:signInWithPassword`) for that account's email is **held at the front and not forwarded**; `status` shows `held=<label> since <time>`. `release` (or `scenario normal`) forwards it to the Auth emulator and delivers the answer **only if the browser is still connected**; otherwise the answer is dropped (`deliveredToBrowser: false`). What the app does with a late answer is the app's own 30-second rule.
- **`aged-sign-in`** — makes the next verified login of that account carry a sign-in time 11 minutes old, so the 10-minute recent-sign-in rule asks at once. One use; cleared by `scenario normal` and by `reset`. `status` shows `aged-sign-in pending=<n>` until used.
- **Only one** of `held-void` and `stalled-reauth` at a time; `scenario normal` disarms and releases; `reset` clears all faults; `stop` disarms.

**Rate limit.** The real login limiter applies. Every visitor reaches the runtime as one client address (the front's loopback peer), so about eight sign-ins within a minute are answered 429 (the smoke run hit this). Wait a few minutes, or `reset` (a fresh database also clears the limiter state). Anyone else who has the Preview URL shares that budget.

**Evidence** runs in a READ ONLY transaction as the database owner, on fixed queries whose columns are named from migrations 001–035. It returns only the rows of the labels or ids you ask for, at most five per kind for `--recent`, plus per-tenant counts. It never returns session material, keys or idempotency digests; idempotency is reported **as counts only** (`total`, `completed`, `pending`).

- Summary (`evidence`): `generation`, `idempotency`, and per tenant: `counts` (`customers`, `drafts_open`, `drafts_discarded`, `drafts_issued`, `invoices_issued`, `invoices_voided`), `audits` (a count per `action_id`), `roleLevels` (`role_id`, `domain`, `level`, `version`).
- Customer: `name`, `phone`, `email`, `row_version`, `created_at`, `audits`, `tenantCreateAudits`.
- Draft: `status` (`draft`/`discarded`/`issued`), `version`, `line_count`, `subtotal_cents`, `audits`, `outbox` (event counts).
- Issued invoice: `number`, `total_cents`, `issued_at`, `state` (`issued`/`voided`), `void` (reason and time), `audits`.
- An id that is not a UUID, or a label that is not a customer, draft or invoice fixture, gets `not a fixture label or a record id`; an unknown UUID gets `no such customer, draft or issued invoice in this QA database`.

## 7. Shutdown, reset and reboot

- **`reset`**: the front answers 503 for server calls while it runs; the tenant runtime stops; the database cluster is replaced with a new one; the emulators' accounts and documents are cleared; new keys are made (so every old session cookie and token fails); the issued-token ledger (§1) is emptied, so every earlier ID and refresh token is refused; the generation number goes up, the accounts get new uids, and the world is seeded again. Every synthetic record and session is discarded. Old tabs become signed out or stale; sign in again. A reset runs only on a `ready` session; a failed reset leaves the session `unavailable` until `stop` and `start` (§2.3, §2.7). A `stop` sent during a reset waits for it to finish (at most 120 seconds), then stops everything.
- **`stop`**: closes the front, the runtime, the emulators and the database; removes the run directory. Fictional data is gone. A process the session could not prove stopped keeps the record and the run directory (a database server that will not stop also keeps its data directory), and `stop` (or the next `start`) cleans it or refuses with `stale_cluster_running` / `stale_process_running` (§2.2).
- **Where state lives:** on disk under `.cache/tmpos-qa/` (not `/tmp`, which is RAM-backed on this VM): `current.json` (the ownership record), `runs/<run id>/`, `tmp/` (the database cluster), `home/`, `firebase-emulators/` (the emulator jar), `vite-cache/`, and three kept logs: `last-run.log` (the supervisor log of the last run that stopped), `last-emulators.log` (the emulators' log, copied only after a failed start, because it can hold synthetic tokens) and `last-build.log` (only after `build_failed`). `.cache/` is ignored by git. Emulators and the Firestore JVM are signalled only by their records: only a process whose recorded start time, boot id and command line still match is ever signalled. A database server is also stopped with `pg_ctl … stop` when the `postmaster.pid` in the run's own data directory under `.cache/tmpos-qa/tmp/` (a directory the QA tool made) names a live postgres on that directory in the same boot (when the record names a postmaster, it must be that very process).
- **After a reboot** the session is simply gone. `status` says `No QA session is running (a stale record remains; …)`; nothing reconnects to live services. `start` (or `stop`) cleans the leftovers and `start` then begins a fresh session. Replit may start the ordinary dev server on port 5000 after a reboot; stop it before `start`.
- **Known residual: an unrecorded database cluster.** A supervisor killed (or the VM's out-of-memory killer, or a reboot) between the cluster's `initdb` and the moment the cluster is written into the record (seconds, up to minutes under load), leaves a cluster that no record names, so neither `start` nor `stop` cleans it. It lives in a directory `.cache/tmpos-qa/tmp/tmpos-s1b-<suffix>`. To see one: `ls .cache/tmpos-qa/tmp` after `npm run qa:interactive -- stop` has finished (which also cleans any recorded cluster; a `tmpos-s1b-*` entry left then is such a leftover). If its server is still running (after a reboot it is not), stop it with `pg_ctl --pgdata .cache/tmpos-qa/tmp/tmpos-s1b-<suffix>/data -m fast stop`; the directory can then be removed. The tool has no code for this case.
- **Known residual: check, then signal.** Every ownership check (pid, start time, boot id, command line, and for the database server a plain pid in `postmaster.pid` naming a postgres whose only `-D` is that run's data directory) happens just before its signal, as a separate step; `pg_ctl` then reads `postmaster.pid` again. A process that exits in those milliseconds could in principle have its pid reused by another before the signal (Linux hands out pids in sequence, so this needs the whole pid range to wrap in that moment). Node offers no pidfd signalling to bind the two, so this is not closed.

## 8. Earlier-phase QA cases this stack cannot exercise

- Google popup sign-in (the Google button is not wired to anything real here).
- The admin console and the administrative backend flows.
- The legacy browser-only screens listed in §5 (their data is not server data).
- Deployment, the managed database, backups, real providers (payment, email, shipping).
- Multi-device and real email flows (password reset, verification mail, push or notification delivery).

None of this runbook closes a gate. The owner's Manual QA remains PENDING, and every production gate in [08](./08-production-gate-and-risk-register.md) stays OPEN.
