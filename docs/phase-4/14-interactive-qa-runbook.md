# 14 — Interactive QA runbook (QA-INTERACTIVE-P1): the isolated tenant-backend session

**Status: operator runbook, documentation only.** It describes tooling that exists in the repository (`tests/qa/interactive/`, started with `npm run qa:interactive`). Nothing in this document says that any check below passes: every result line is left **PASS / FAIL — PENDING** for the owner to decide. Every production gate in [08](./08-production-gate-and-risk-register.md) stays OPEN. Nothing is deployed.

**Audience.** The repository owner, who types commands in Replit's Shell and tests in an ordinary browser. Commands are written exactly as typed. Where this runbook states what a command prints or what the app shows, the statement comes from the tooling's or the app's source; where it could not be checked in source it says "record what you see".

**How the examples were checked.** The command list, flags, refusal codes, labels, accounts and fixture names below were read from `tests/qa/interactive/*.mjs` and from the output of `npm run qa:interactive -- status` of run `qa-20261023t0805-5efa`, generation 1. Menu and button names were read from `src/`. QA-INTERACTIVE-P1-R1 rechecked the commands and the quoted page texts against run `qa-20261023t2047-d5e0`, and ran U01–U05's steps there by automation (§10); its text size, width and fresh sign-ins were set the automated way (font-size and viewport emulation, a new browser profile), not through the browser settings the owner uses. Record ids are not listed here because they change on every start and reset; read them from `status`.

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

Each line below is one complete command; type one line at a time (nothing here is a pipeline). The label at the end of a `scenario` or `evidence` line can be swapped for another fixture or account label from `status`.

```
npm run qa:interactive -- help
npm run qa:interactive -- start
npm run qa:interactive -- status
npm run qa:interactive -- scenario normal
npm run qa:interactive -- scenario aged-sign-in owner-a
npm run qa:interactive -- scenario stalled-reauth owner-a
npm run qa:interactive -- scenario held-void inv-held
npm run qa:interactive -- release
npm run qa:interactive -- evidence
npm run qa:interactive -- evidence inv-held
npm run qa:interactive -- evidence --recent
npm run qa:interactive -- probe
npm run qa:interactive -- reset
npm run qa:interactive -- stop
```

Options and defaults: `start` also takes `--origin https://<host>` and `--project demo-<id>` (§2.2; neither is needed on Replit). Without a label, `scenario held-void` uses `inv-held`, and `scenario aged-sign-in` and `scenario stalled-reauth` use `owner-a`. `evidence` takes one or more customer, draft or invoice labels or record ids. `probe --positive` also voids `inv-probe` (§2.6).

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

**Preview URL (this workspace):** `https://70fecabe-2df6-4353-8c25-cf5ce1c5075d-00-16avf9cycmdtz.worf.replit.dev/`. Open exactly this address: the front answers only requests whose Host is exactly the Preview host (anything else gets `404 {"error":"host_not_served"}`). Sign in at `/login`.

**The session handed over in QA-INTERACTIVE-P1-R1** (2026-10-23, ready 20:57:07Z): run `qa-20261023t2055-fa9b`, generation 1, no fault armed or held, no fault record yet, and a fresh database (so the login limiter has spent nothing). Every `start` makes a new run id and every `reset` a new generation; `status` and the corner label show the current ones, and only they count — the values here are a record, not a promise that this run is still up (a reboot ends it; §7).

- **Its ownership record** (`.cache/tmpos-qa/current.json`, boot `08971338…`): supervisor pid 120171, emulators 121025, Firestore emulator JVM 122616, database server 124452 on the cluster `.cache/tmpos-qa/tmp/tmpos-s1b-LnrNHO`; ports: front 5000 (public), tenant runtime 39169, Auth emulator 9399, Firestore emulator 8385 (loopback).
- **What it runs.** The QA bundle is built by `start` from this checkout's files. Commit `04a9529` (the hand-over's HEAD) and `089c622` (the QA tool) have identical `server/`, `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `firebase-applet-config.json` and `firestore.rules` trees. The checkout matched them: no tracked file in those paths differed, and there was no untracked file under `server/`, `src/`, `scripts/` or `tests/qa/` (the only untracked test paths, `tests/browser/capture-preview.mjs` and `tests/quality/fixtures/`, are not part of the QA bundle). The built bundle embeds its run id, so its bytes differ per run. For this run, the SHA-256 of the `sha256sum` listing of its 12 files (sorted by path) begins `c37e53a5aff75738`.

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
| invoice | `inv-void` | issued, 50.00 USD, `cust-ada` | U04; item 7 (void) |
| invoice | `inv-held` | issued, 50.00 USD | U05; item 8 (held void) |
| invoice | `inv-stall` | issued, 50.00 USD | U02, U03; item 9 (stalled sign-in) |
| invoice | `inv-probe` | issued, 50.00 USD | U01 (held attempt); item 10 (refusals, positive control) — not both in one generation |
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

## 4. The owner's checks U01–U16

The owner's workload is the sixteen checks U01–U16 of the critical-QA shortlist (`TMPOS2026-critical-qa-shortlist.md`), beginning with U01–U05 below. That shortlist file is **not in this repository**: this runbook gives procedures for U01–U05 only, so **U06–U16 cannot be carried out from this runbook** until the shortlist is supplied. The backend checks B01–B12 belong to the operator (§9), not the owner. The twelve procedures of §4A are operator reference material from QA-INTERACTIVE-P1, **not** additional owner checks.

Every result line is **PASS / FAIL — PENDING**: only the owner decides. The operator's automated run of the same steps (§10) is separate evidence and marks nothing.

### 4.1 Readiness

| Check | What it needs here | Readiness in this stack |
|---|---|---|
| U01 | a held void attempt on `inv-probe`; the recovery card at 320×600 with 24 px text | ready; the operator's automated run of these steps passed (§10); owner PENDING |
| U02 | an aged sign-in, then a held provider sign-in request on `inv-stall` | ready; operator run passed; owner PENDING |
| U03 | a second held sign-in request on `inv-stall`, Stop waiting, leave, release | ready; operator run passed; owner PENDING |
| U04 | an explicit void of `inv-void` with a chosen reason | ready; operator run passed; owner PENDING |
| U05 | a held void on `inv-held`, leave and return, one Check again | ready; operator run passed; owner PENDING |
| U06–U14, U16 | defined in the shortlist, which is not in this checkout | not executable from this runbook; owner PENDING |
| U15 | an isolated admin console | blocked here: this stack has no admin entry and the front routes no admin API (§5, §8). This does not block the tenant invoice checks |

### 4.2 Before U01: one browser, one account, three sign-ins

- **Who does what.** Steps marked **Shell** are typed in Replit's Shell. **Operator check** lines are Shell commands that read the database or the fault records. Lines marked **Network (optional)** are things you can see in your own browser's developer tools; nothing needs to be intercepted, overridden or pasted, and nothing you see there should be copied anywhere.
- **Write down the invoice numbers.** Run `npm run qa:interactive -- status`, then `npm run qa:interactive -- evidence inv-probe inv-stall inv-void inv-held`. All four are `issued`, each with one `store.invoice.issue` audit, and each shows its `number`. The page shows numbers, not labels. Then run `npm run qa:interactive -- evidence` and keep the summary (it holds `invoices_voided` and the `idempotency` totals for U04 and U05).
- **Getting a fresh sign-in.** The shop has no Sign out control. Wherever a step says "sign in", open a **new private (incognito) window**, go to the Preview's `/login`, and sign in with `owner-a@tmpos-qa.test` and the password from `status`. Close the earlier window first. A private window is a new browser profile; it is what the operator's run did.
- **Login budget (the real limiter, unchanged).**
  - Every visitor reaches the runtime as one client (§6). Every sign-in and every recent sign-in sends one tenant login exchange.
  - Two limits apply: **10 attempts per 60 seconds for that one client** (counted before the credential is checked) and **5 verified logins per account per 5 minutes**. Each window opens at its first attempt.
  - U01–U05 in this order need **three** `owner-a` logins (U01, U02, U04), which fits both limits. Do not run `probe` while you test: it signs `tech-a` and `owner-a` in by itself and spends the same budget.
  - If a sign-in is refused for too many requests, the page may not say how long to wait. Wait one minute (the client limit), or five minutes if it is refused again (the account limit), then try again. Do not `reset` in the middle: it discards the run's records.
- **Order and timing.**
  - Do the checks in this order. U01 uses its own invoice. U02 prepares the aged sign-in that U03 and U04 rely on.
  - U04's sign-in makes U05's void go through without a prompt, so **send U05's void within 10 minutes of U04's sign-in**.
  - U01's void must likewise be sent within 10 minutes of U01's sign-in.
- **Fixtures are used up.** U01 voids `inv-probe`, U04 voids `inv-void` and U05 voids `inv-held`. After U01, `probe --positive` and §4A items 7, 8 and 10 no longer find those invoices `issued`. To start over with fresh fixtures, run `npm run qa:interactive -- reset` and sign in again.

### U01 — Recovery controls are reachable

- Account `owner-a`. Fixture: `inv-probe` (U01's held-attempt fixture; `inv-held` is kept for U05).
1. Sign in (login 1; see §4.2). Then **Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)` → open the row with `inv-probe`'s number.
2. **Shell:** `npm run qa:interactive -- scenario held-void inv-probe` (`status` then shows `armed=held-void inv-probe`).
3. **Void invoice…** → choose a reason → **Void invoice**, once. The page reports the attempt as not confirmed (the edge answers 502; §6). Close the confirmation and the invoice dialog, so that the card **Void of invoice <n>** stays on the page.
4. Text size and width. Set the browser's font size to 24 px (Chrome: Settings → Appearance → Font size → **Very large**), and make the page 320 CSS px wide and 600 high (DevTools → device toolbar → Responsive, 320 × 600). Write down the method you used. Set the font size back afterwards.
5. Scroll to the card. Its heading names the invoice number, and **Check again**, **Check invoice** and **Dismiss** are readable and not covered.
6. Press Tab until **Check invoice** has focus, then press Enter. It reads that one invoice and says what it shows now (for example `Invoice <n> is voided now. This does not show which request voided it.`).
7. Click **Dismiss** with the mouse. The card goes, and nothing is sent to void the invoice.
- **Operator check:** `npm run qa:interactive -- status` shows a `fault record` for `inv-probe`, with `committed` true when the held request ran. `npm run qa:interactive -- evidence inv-probe` then shows `voided` with exactly one `store.invoice.void` audit. That audit is the held attempt's own void; nothing comes from **Check invoice** or **Dismiss**. **Network (optional):** Enter sent one `GET …/invoices/<id>`, and Dismiss sent nothing.

Result: PASS / FAIL — PENDING
Notes:

### U02 — A stalled sign-in releases the page at its deadline

- Account `owner-a`. Fixture: `inv-stall`.
1. Close the browser window. **Shell:** `npm run qa:interactive -- scenario aged-sign-in owner-a` (`status` shows `aged-sign-in pending=1`). Sign in again in a new private window (login 2). This login's sign-in time is recorded as 11 minutes old, so the void asks for a recent sign-in at once (§6).
2. **Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)` → open `inv-stall` → **Void invoice…** → choose a reason → **Void invoice**. The page asks **Confirm your sign-in to void this invoice**. That first send was refused before anything ran.
3. **Shell:** `npm run qa:interactive -- scenario stalled-reauth owner-a`.
4. Type the password and press **Confirm sign-in** once; start timing. The QA front now holds that sign-in request instead of forwarding it; `status` shows `held=owner-a since <time>`.
5. At about 30 seconds the page says `Not voided: this page stopped waiting for your sign-in after 30 seconds and sent nothing for this invoice. You can try again.` It says it stopped waiting; it does not say the provider request was cancelled. The password field is empty, and you can type in it.
6. Close the dialog and the invoice, then click **Customer Directory** in the sidebar (no reload). It opens normally.
7. **Shell:** `npm run qa:interactive -- release` (it prints `deliveredToBrowser`). Nothing on the page reopens, and no further void is sent.

Result: PASS / FAIL — PENDING
Notes:

### U03 — Stop waiting prevents the old attempt from resuming

- Account `owner-a`, still on U02's aged login. Fixture: `inv-stall` (still `issued`).
1. **Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)` → open `inv-stall` → **Void invoice…** → reason → **Void invoice**. The sign-in is asked for again (this send is also refused before running).
2. **Shell:** `npm run qa:interactive -- scenario stalled-reauth owner-a`. Type the password and press **Confirm sign-in**. The sign-in request is now held at the front, before any tenant-session renewal can be sent.
3. Press **Stop waiting** within a few seconds, well before the 30-second deadline. The page says it stopped waiting and sent nothing for this invoice.
4. Close the dialog and the invoice, and click **Customer Directory** in the sidebar.
5. **Shell:** `npm run qa:interactive -- release`.
6. Confirm that no old review or void reopens.
- **Operator check:** `npm run qa:interactive -- evidence inv-stall` is still `issued`, with one audit.
- **Network (optional):** after **Confirm sign-in** there is no `POST /api/v1/session/login` and no `POST …/void`. Requests that do appear after the release are the identity SDK's own events and the page's ordinary reads, not the abandoned renewal or void: `accounts:lookup`, `securetoken … token`, the Firestore `Listen` channel, and plain `GET /api/v1/session` or `GET /api/v1/customers`.

Result: PASS / FAIL — PENDING
Notes:

### U04 — Explicit void changes the selected invoice only

- Account `owner-a`, still on the aged login. Fixture: `inv-void`.
1. **Operator check:** `npm run qa:interactive -- evidence inv-void` (`issued`, with its `number`) and `npm run qa:interactive -- evidence` (note `invoices_voided`). Then **Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)` → open `inv-void`, and note its number, customer and Total.
2. **Void invoice…**: the confirmation is titled `Void invoice <n>?` with the same customer and Total, and no reason is selected.
3. Choose a reason and press **Void invoice**. Because the login is aged, the page asks you to confirm your sign-in. Enter the password and press **Confirm sign-in** (login 3). The confirmation stays open and nothing is voided yet. Choose the reason again if it was cleared, then press **Void invoice**.
4. Wait for the server's confirmation. Then reload the page and open `inv-void` again: it shows **Voided**, the reason you chose, the void time, and the same number, customer and Total.
- **Operator check:** `npm run qa:interactive -- evidence inv-void` shows `voided`, a `void` row with your reason, and exactly one `store.invoice.void` audit. `npm run qa:interactive -- evidence` shows `invoices_voided` one higher than in step 1.

Result: PASS / FAIL — PENDING
Notes:

### U05 — A lost answer recovers without duplication

- Account `owner-a`, signed in recently by U04's step 3. The void must be sent within 10 minutes of that sign-in (§4.2). Fixture: `inv-held`.
1. **Operator check:** `npm run qa:interactive -- evidence inv-held` (`issued`) and `npm run qa:interactive -- evidence` (note `invoices_voided` and the `idempotency` total). **Shell:** `npm run qa:interactive -- scenario held-void inv-held`.
2. **Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)` → open `inv-held` → **Void invoice…** → reason → **Void invoice**, once. The page says the void is not confirmed and that the server may or may not have voided it. That is the simulated lost answer, not a product failure: the Replit edge answers **502** after the QA front withholds the runtime's answer. **Network (optional):** the `POST …/void` answered 502.
3. Leave (**Customer Directory**) and come back (**Invoices** → **Show issued invoices** → **Choose a store…** → `Northwind Main (QA)`). The card still holds the unconfirmed attempt, and nothing new was sent.
4. Press **Check again** once, when it is enabled. The card then says `Invoice <n> at Northwind Main (QA) was voided.`
- **Operator check.** First read the `fault record` for `inv-held` with `npm run qa:interactive -- status`:
  - `committed` true means the void ran before its answer was withheld.
  - `committed` false means the runtime refused it before running; the commonest cause is a sign-in older than 10 minutes. The browser still sees only the 502, so **Check again** cannot fix it. Run `npm run qa:interactive -- scenario normal`, sign in again in a new private window, arm again with `npm run qa:interactive -- scenario held-void inv-held`, and repeat from step 2.

  Then `npm run qa:interactive -- evidence inv-held` shows `voided` with exactly one `store.invoice.void` audit. `npm run qa:interactive -- evidence` shows `invoices_voided` one higher and the `idempotency` total one higher for the pair: the Check again is a replay, not a second record.
- **Network (optional):** both `POST …/void` requests go to the same address with the same `Idempotency-Key` value and the same payload. Compare them on screen and do not copy them anywhere.

Result: PASS / FAIL — PENDING
Notes:

---

## 4A. Operator reference procedures (QA-INTERACTIVE-P1's twelve items — not owner checks)

These twelve procedures are kept as operator reference material: they show how to exercise the rest of the stack. They are not owner assignments and carry no result lines. Two sessions at once (item 4, 5, 6) need a second browser or a private window/profile, because the signed-in user is stored per browser profile.

Navigation names (left sidebar): **Customer Directory**, **Employees**, **Invoices**. Employees has a **Permissions** tab. The Invoices page has two server sections: **Server drafts** (button **Show server drafts**) and **Issued invoices** (button **Show issued invoices**); each has a **Choose a store…** list.

### Item 1 — Start and identify the isolated session

- Account: none yet. Fixtures: none.
1. Stop the dev server (Replit **Stop**). In the Shell: `npm run qa:interactive -- start`. Wait for `QA session ready`.
2. `npm run qa:interactive -- status`. Confirm: first line `QA session ready`; one `Processes:` line with a supervisor and an emulators pid; `ports: front 5000 (public)`, and the other three ports on loopback. To see the database answering, run `npm run qa:interactive -- evidence` (it reads the disposable database and prints `generation`, `idempotency` and both tenants); `grep clusterRoot .cache/tmpos-qa/current.json` shows where the disposable cluster lives (under `.cache/tmpos-qa/`).
3. Open the Preview URL from the `Preview:` line.
4. Confirm the corner label `QA ONLY · synthetic data · run <id>` and that `<id>` and the generation equal `status`.
5. Run `start` again. Expect `A QA session is already running (run <same id>); nothing new was started and no other port is used.` To check nothing listens on 5001, use a listener listing if the Shell has one (for example `ss -ltn`); the tool itself never opens 5001.


### Item 2 — Synthetic sign-in without live services

- Account: `owner-a`.
1. Open `<Preview URL>login` in a normal browser window. Sign in with `owner-a@tmpos-qa.test` / `qa-owner-a-pass` (not a real Firebase account).
2. Open the browser's Network tool **before** signing in (read-only observation; nothing needs to be intercepted or injected). Expect the identity and data requests to go to the same host as the page, for example `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`, `/securetoken.googleapis.com/v1/token`, `/google.firestore.v1.Firestore/Listen/channel` and `/api/v1/…`. Confirm every request goes to the Preview host: none may go to a Google host such as `identitytoolkit.googleapis.com` or `firestore.googleapis.com` (those names appear only inside the paths). (The page's content-security policy allows only the page's own origin for connections.)
3. Reload the page. Record what happens (stays signed in, shows the sign-in page, a reconnect notice). That behaviour belongs to the app; the runbook does not predict it.
4. Confirm that you did not need any DevTools request override, extra extension, or pasted cookie.
- Operator command: none needed; `status` shows the same run id.


### Item 3 — Customers persist through the real API

- Account: `owner-a`. Fixtures: `cust-ada` (to see the seeded shape).
1. Sidebar **Customer Directory**. The seeded customers `Ada Fictional (QA)` and `Ben Placeholder (QA)` are listed.
2. In the add form fill **Name** (a unique fictional name, for example `Casey Runbook (QA)`), **Phone (optional)** `+1 555 0142`, **Email (optional)** `casey.runbook@example.test`; press **Add customer**. Wait for the notice that it was saved on the server.
3. Open the new customer's profile (the address becomes `/customers/directory/<id>`; the id is also what `evidence` takes). Confirm name, phone, email and **Created**.
4. Press **Edit**, change the phone, press **Save**, and wait for the confirmed `Saved` notice.
5. Reload the page and open the profile again; confirm the saved phone.
6. Evidence: before step 2 run `npm run qa:interactive -- evidence` (note `tenant-a` `customers` and the `tenant.customer.create` count; on a fresh seed they are 2 and 2). After step 5 run `npm run qa:interactive -- evidence --recent` (the new customer is first), then `npm run qa:interactive -- evidence <id from the address>`. Compare: the row's `name`, `phone`, `email`, `created_at` equal the screen; `row_version` after the edit is one higher than after the add (the smoke run saw 2 after one edit); `audits` lists the actions recorded for that customer (the edit appears as `tenant.customer.update`, count 1 after one edit); the creation is counted in `tenantCreateAudits`, which is one higher than before (3 on a fresh seed).


### Item 4 — Server-saved role panels decide access

- Accounts: `owner-a` (first browser), `sales-a` (second browser or private window). Panels: **Employees** → **Permissions** tab → **Server-enforced Customers access** and **Server-saved Invoices level**. The role rows are the built-in ones; the sales role is shown as **Sales Associate** (role id `sales_staff`).
1. Evidence first: `npm run qa:interactive -- evidence`; note the `roleLevels` entries for `tenant-a` (`role_id`, `domain`, `level`, `version`) and the audit counts. A level that was never edited may show no row or `(default)`.
2. As `owner-a`, in **Server-enforced Customers access**, for the **Sales Associate** row choose **View Only** (from the pickers: None, View Only, Create, Edit, Full Access), type a reason of 10–500 characters, press **Save to server**. If the panel shows **Confirm your sign-in to save this change**, enter `qa-owner-a-pass` and press **Confirm sign-in**. Confirm the row reads **Saved** and, after leaving and reopening the tab, still shows the new level (fresh read-back).
3. In the second browser sign in as `sales-a` and open **Customer Directory**; try **Add customer** with a fictional name. The server decides: with Customers at View Only the create must be refused (the smoke run saw HTTP 403, and the page may still offer **Add customer** until it re-reads the policy). Reload or sign out and in, and try again; write down what the page offers and what is answered, before and after the reload. As a second check, compare with §3.3: at Create `sales-a` may add but not edit.
4. Compare with evidence: `npm run qa:interactive -- evidence` again — the `sales_staff` / `customers` entry shows `view` and a higher `version`, and the audit counts have grown by the saved change; no customer was added.
5. Restore: choose **Create** again for **Sales Associate**, a reason, **Save to server** (confirm the sign-in if asked). Run `evidence`: the level is back to `create` and the `version` is higher still (a version does not go back). The same can be repeated in **Server-saved Invoices level**.


### Item 5 — Store and tenant isolation hold

- Accounts: `owner-a` (tenant-a), `owner-b` (tenant-b, second browser), `manager-a` (one store). Fixtures: `cust-ada`, `cust-zoe`, `inv-void`, `inv-b`.
1. As `owner-a`, open **Customer Directory** → `Ada Fictional (QA)`. Copy the id from the address `/customers/directory/<id>`. Run `npm run qa:interactive -- evidence cust-ada cust-zoe inv-b` and keep the output (tenants, `row_version`, `audits`).
2. In the second browser sign in as `owner-b` (tenant-b). The directory lists only `Zoe Southfield (QA)`.
3. In the address bar type `<Preview URL>customers/directory/<Ada's id>`.
4. Expect the app's not-found text `No customer with this address is available in this store.`, no name, phone or email of Ada anywhere. Repeat in the other direction (`owner-a` opens Zoe's address).
5. Run the same `evidence cust-ada cust-zoe inv-b` and confirm `row_version` and `audits` did not change.
- Store choice: as `owner-a`, **Invoices** → **Show issued invoices** → **Choose a store…** lists `Northwind Main (QA)` and `Northwind Harbor (QA)` (Harbor is empty); as `manager-a` the list should offer only `Northwind Main (QA)`; as `owner-b` only `Southfield Central (QA)`. Record what each list shows.
- **Invoice half (read-only request from the browser's own console):** the app has no address that opens an invoice by id, so use one plain same-origin read. Signed in as `owner-b`, open the browser's developer Console and run `fetch('/api/v1/stores/<store-a-main id>/invoices/<inv-void id>').then(r => r.text().then(t => console.log(r.status, t)))`, with the two ids from `status`. Expect a refusal (the smoke run saw 403 with a body naming only `forbidden` and a request id) and no data of tenant-a. This is an ordinary request with your own session, not a request override. Then run `evidence inv-void inv-b` before and after to show both invoices are untouched.


### Item 6 — Draft lifecycle and conflicts use PostgreSQL

- Account: `owner-a`. Fixtures: `draft-edit`, `draft-discard`, store `store-a-main`.
1. **Invoices** → **Show server drafts** → **Choose a store…** → `Northwind Main (QA)`. Evidence: `npm run qa:interactive -- evidence` (note `drafts_open`, `idempotency`).
2. Create: **New server draft** → choose the customer from the server list (search `Ada`) → add a line → **Save draft**. `evidence --recent` lists it first; `evidence <id>` shows `status` `draft`, `version`, `line_count`, `subtotal_cents`, audits and outbox.
3. Two tabs: open `draft-edit` in tab 1 and tab 2 (the row is **Open** with the draft's created time; `evidence draft-edit` prints `created_at` to find it) and press **Edit draft** in both. In tab 1 change a line and save. Run `evidence draft-edit`: `version` is one higher.
4. In tab 2 (older) change something and save. Confirm the app's existing conflict view (**Your changes and the draft on the server now**) and its review flow; do not force it. Run `evidence draft-edit` again: `version` is unchanged by the conflicted save.
5. Discard: open `draft-discard` → **Discard draft…** → confirm. `evidence draft-discard` shows `status` `discarded`; `evidence` shows `drafts_discarded` one higher and the `idempotency` counts (counts only; digests are never shown).


### Item 7 — Issue and void follow the adopted authority rules

- Account: `owner-a` (manager-a can repeat it). Fixtures: `draft-issue` to issue; `inv-void` to void.
1. `npm run qa:interactive -- evidence draft-issue inv-void` — `draft-issue` is a `draft`, `inv-void` is `issued` (note its `number`).
2. **Invoices** → **Show server drafts** → store `Northwind Main (QA)` → open `draft-issue` → **Issue invoice…** → check the review → **Issue invoice**. Confirm the issued state and details the page shows. `evidence draft-issue` now shows `status` `issued`; `evidence --recent` lists the new issued invoice first (its `number`, `issued_at`).
3. **Show issued invoices** → store `Northwind Main (QA)` → open the `inv-void` row (by its number) → **Void invoice…**. If you have signed in within the last 10 minutes no extra sign-in is needed; if the page asks **Confirm your sign-in to void this invoice**, enter the password and press **Confirm sign-in** (§6 explains how to make this prompt appear on purpose).
4. Confirm the dialog title reads `Void invoice <number>?` for the right number, choose a reason (for example **Issued by mistake**), press **Void invoice** once.
5. Reload. `evidence inv-void`: `state` `voided`, `void.reason_code`, `voided_at`, and the audits for that invoice; `evidence` summary: `invoices_voided` one higher (2 on a fresh seed) and `invoices_issued` one higher (6) after the issue. Compare that each action appears once in the audits, with no duplicate.


### Item 8 — A held outcome recovers without a duplicate action

- Account: `owner-a`. Fixture: `inv-held`.
1. Sign in fresh (within the last 10 minutes). `npm run qa:interactive -- evidence inv-held` (state `issued`; note `number`). Arm: `npm run qa:interactive -- scenario held-void` (the default is `inv-held`; `status` now shows `armed=held-void inv-held`).
2. **Invoices** → **Show issued invoices** → `Northwind Main (QA)` → open the `inv-held` row → **Void invoice…** → choose a reason → **Void invoice**, once. The browser receives no answer from the app's server: the front closes the connection and the Replit edge turns that into an HTTP 502. The page shows the unresolved state, in the smoke run: `Void of invoice <n> at Northwind Main (QA) is not confirmed. The server may or may not have voided it. The server answered, but not with a result.` with **Check again** and **Check invoice** (and **Dismiss** on the card). `status` now shows `armed=none` (the fault is one-shot) and a `fault record:` line for the held void.
3. Read the outcome two ways. `npm run qa:interactive -- status` prints `fault record: {"kind":"held-void","label":"inv-held","at":…,"upstreamStatus":…,"committed":…,"upstreamError":…}`; `committed` is `true` when the real runtime answered 200, `false` when it answered another status, and `null` when the front got no answer at all (`upstreamStatus` is then `null` and `upstreamError` names why: `unavailable`, `timeout` or `too_large`, as in §6): `null` means unknown, not "did not happen". Confirm with `npm run qa:interactive -- evidence inv-held`: `state` `voided` with a `void` row and its audit means the void ran; `state` still `issued` with `committed` false means it was refused before it ran (for example a stale sign-in; arm again and repeat); with `committed` null the evidence alone decides.
4. Press **Check again** (it resends the same request with the same key and the same bytes) or **Check invoice** on the card or in the dialog, as the page directs; do not start a second void by hand. Read the text it shows. In the smoke run **Check again** resolved to `Invoice <n> at Northwind Main (QA) was voided.`
5. Compare with `evidence inv-held` and `evidence`: the page's statement agrees with the database; the invoice has exactly one void audit (the resend is an idempotent replay, not a second void); `invoices_voided` rose by exactly one.
6. Afterwards `npm run qa:interactive -- scenario normal` (harmless if already used).


### Item 9 — Stalled recent sign-in remains escapable

- Account: `owner-a`. Fixture: `inv-stall`. The void asks for a recent sign-in only when the login is older than 10 minutes. Two ways to get there:
  - **Either (fast)** — before signing in as `owner-a` run `npm run qa:interactive -- scenario aged-sign-in owner-a` (`status` shows `aged-sign-in pending=1`). **Sign out of `owner-a` first, in every tab, then arm, then sign in:** the fault applies to the account's *next* tenant login, and that can be a re-authentication rather than the sign-in you meant. **Honest statement of what this does:** the QA verifier records that one login with a sign-in time 11 minutes earlier than the emulator's token says; the 10-minute rule therefore asks for a recent sign-in at once. It changes that single login's `auth_time` and nothing else — not the clock, not the token, not any other account, not any rule; it applies once and is then used up. The re-authentication that follows is verified with its true time.
  - **Or (slow)** — sign in and wait 10 real minutes before step 1.
1. `evidence inv-stall` (state `issued`; note `number` and the audit list). **Invoices** → **Show issued invoices** → `Northwind Main (QA)` → open `inv-stall` → **Void invoice…** → choose a reason → **Void invoice**. The page should ask **Confirm your sign-in to void this invoice** and show a password field.
2. Now arm: `npm run qa:interactive -- scenario stalled-reauth owner-a`. Enter `qa-owner-a-pass` and press **Confirm sign-in**. The sign-in request is held by the QA front: `status` shows `held=owner-a since <time>`.
3. Observe the bounded wait. Either press **Stop waiting** (the page says it stopped waiting and sent nothing for this invoice) or let the 30-second deadline pass (`Not voided: this page stopped waiting for your sign-in after 30 seconds and sent nothing for this invoice. You can try again.`). Close the review.
4. Release the late answer: `npm run qa:interactive -- release`. It prints `releasedAt`, the emulator's `upstreamStatus`, and `deliveredToBrowser` (true only if the browser was still connected). What the app does with a late answer is its own 30-second rule; record whether the old review revives or sends anything.
5. Navigate elsewhere in the app and back (normal navigation should still work). `evidence inv-stall`: `state` still `issued`, audit list unchanged from step 1. Finish with `npm run qa:interactive -- scenario normal`.


### Item 10 — Backend refusals change no business state

- Fixture: `inv-probe`. Accounts used by the tool itself: `tech-a` (restricted) and `owner-a` (positive control). No browser needed.
1. `npm run qa:interactive -- scenario normal` (the probe refuses to run while a fault is armed or held or an aged sign-in is pending: ``Failed: a fault is armed or pending; run `scenario normal` first``), then `npm run qa:interactive -- evidence inv-probe` and `npm run qa:interactive -- evidence`; keep both (`state` `issued`, the audit list, the `idempotency` counts).
2. `npm run qa:interactive -- probe`. Expect four entries: `no session` 401; `restricted: tech-a (Invoices View Only)` 403; `owner-a without X-TMPOS-CSRF` 403; `owner-a with a wrong session CSRF value` 403 — with the runtime's `unauthenticated` or `forbidden` error body. Compare each status and body with those names; write down any difference.
3. `evidence inv-probe` and `evidence` again. Expect the invoice still `issued`, no new audit, and the business counts unchanged. Compare the `idempotency` counts too: if they changed, record by how much (the output shows counts only) and say which request is the likely cause; whether a refused request leaves such a record is not established by this runbook.
4. Positive control: `npm run qa:interactive -- probe --positive` (it repeats the four refusals and then voids `inv-probe` as `owner-a`). The last entry is `positive control: owner-a`. `evidence inv-probe`: `state` `voided`, with its void row and audit.


### Item 11 — Responsive controls remain usable

- Account: `owner-a`. Screen: **Invoices** → **Issued invoices**, with a recovery card or a void dialog open. The easiest way to have one is to do item 8 or item 9 first (use a fixture not yet used; after items 7, 8 and 10, which void `inv-void`, `inv-held` and `inv-probe`, the issued invoices left in Northwind Main (QA) are `inv-stall` and the invoice item 7 issued from `draft-issue`; `inv-b` is tenant-b's, in Southfield Central (QA). Run `reset` first if you need the seeded fixtures again).
1. Desktop: a window 1440 px wide and about 1000 px high (the size the repository's browser tests use as the desktop reference). Check the sidebar, the invoice rows and the action labels (**Void invoice…**, **Check again**, **Check invoice**, **Dismiss**, **Stop waiting**, **Close**).
2. 320 px wide with 24 px text: in Chrome a 1280 px window at 400 % zoom lays out at 320 CSS px (the repository's tests use this), and the text size is the browser's own font-size setting (Chrome Settings → Appearance → Font size; "Very large" is 24 px).
3. 768 px wide with 24 px text: the same font setting; the window or the DevTools device toolbar set to 768 px.
4. At each size scroll normally and operate the recovery or close controls by pointer **and** keyboard (Tab to the control, Enter or Space).
5. Confirm the sidebar never covers the intended action and no hidden styling or forced click was needed. Record the size, text size and what overflowed, if anything.


### Item 12 — Reset and stop affect only QA-owned resources

1. Record the run id (`status`) and the generation, and create a new fictional customer and a draft (item 3 and item 6 steps). Optionally `git status --short` and `ls .cache/tmpos-qa` for a before-picture.
2. `npm run qa:interactive -- reset`. Old tabs are now stale: their Firebase accounts, tokens and server sessions belong to the discarded generation, so they end up signed out or failing; sign in again with the same passwords (the account uids change, the emails do not).
3. After the reset `status` shows generation 2 and a new list of ids. Sign in again; `Customer Directory` and the drafts list show only the fresh seed. `evidence --recent` shows no record created before the reset.
4. `npm run qa:interactive -- stop`, then `npm run qa:interactive -- status` (expect `No QA session is running.`). The Preview no longer shows the QA page; `ls .cache/tmpos-qa/runs` has no run directory for this run (`last-run.log` stays in `.cache/tmpos-qa`; `last-emulators.log` is written there only after a failed start, so one seen now comes from an earlier failed start).
5. Confirm nothing else changed: `git status --short` shows the same files as before, your ordinary dev server comes back with Replit's **Run** button, and unrelated files are untouched. To leave the session ready for more QA, stop the dev server (Replit **Stop**) if Replit restarted it, then `npm run qa:interactive -- start` once.


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

**Rate limit.** The real limiter applies unchanged (`RATE_LIMITS` in `server/runtime/rateLimit.ts`, fixed windows that open at the first attempt). The QA runtime trusts no proxy (`TRUSTED_PROXY_CIDRS` is `127.0.0.2/32`, which nothing connects from), so it buckets every request by its own socket peer — the front on loopback — and every visitor is **one client**. The front also drops every `forwarded`, `x-real-ip`, `x-forwarded-*` and `x-replit-*` header it receives and sets its own `X-Forwarded-For`, which the runtime does not trust. For the tenant login exchange (`POST /api/v1/session/login`, which every sign-in and every recent sign-in sends) two buckets apply: **10 attempts per 60 seconds per client**, counted before the credential is checked, and **5 verified logins per account per 5 minutes**. Every request, logins included, also spends the client's general bucket of 300 per 60 seconds. A refusal is a 429 whose `Retry-After` is the rest of that window. In QA-INTERACTIVE-P1's smoke the eighth login exchange, about 44 seconds after the first, was refused; it was the sixth `owner-a` login inside five minutes, so the account bucket is the one its records show spent (its 429 body was not kept). Remedies: wait for the window (at most one or five minutes), or `reset` (a fresh database also clears the limiter state). Nothing in QA forges a client address, raises a limit or exempts a request. Anyone else who has the Preview URL shares the client bucket.

**Fault records survive `reset`.** `reset` disarms every fault, but the list of the last five fault records that `status` prints is kept, and a record does not say which generation it came from. Compare a record's `at` (or `heldAt`) time with the time you acted; a fresh `start` begins with an empty list.

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

## 9. Operator backend evidence B01–B12

These are the operator's checks, not the owner's. Each row names the assertions that carry it.
- **CI evidence** is exact-SHA CI 39980272453 on `089c622`, both jobs green on attempt 1. Its executable trees equal the hand-over's `04a9529` (§3), so it applies unchanged; each named test passed there in the CI step given.
- **Live evidence** is this stage's own runs through the QA session (§10).

Layers are labelled separately:
- **PG**: a disposable PostgreSQL in CI.
- **HTTP**: a real loopback socket without a real database.
- **contract**: unit, in-memory or static checks. A static or source-order check is not behavioural evidence.
- **proxy**: the public Preview origin, live in this stage.

CI has no public-proxy layer. Nothing here is production evidence, and every gap is carried as written.

| ID | Verdict | Layers | Named assertions (file → test ids; CI step) | Gaps kept explicit |
|---|---|---|---|---|
| B01 revoked session/authority | PASS | PG | **Admin:** `tests/db/adminRevocation.integration.test.mjs` M5R-03a, M5R-04a and `adminBoundary.integration.test.mjs` M5E-B3, M5E-G (steps "Administrative revocation ordering…", "Administrative session boundary…"). **Tenant:** `tenantAdmission` M5A-04b; `tenantSessionOrdering` M5T-D2; on shipped routes `invoiceDraftDiscardHttp` IDDH-05, `invoiceDraftsHttp` IDH-09, `invoiceVoidHttp` IVH-10, `invoiceIssueHttp` IIH-06 (a replay from a revoked session is 401, not the stored 201). | M5A-04b and M5T-* reach the tenant session through harness-only witness routes (M5T-L1 proves those are not shipped). During a void, a revocation is exercised in flight only as a session revocation, a level narrowing and a sign-in age. IDDH-05's "nothing written" is the delta after the owner's change. |
| B02 foreign tenant / unauthorized store | PASS | PG | **Customers:** `tenantEntry` M7TE-14; `customerDetail` M7CD-03; `customerDirectory` M7C-04 (pages never cross tenants); `customerEditHttp` M7CH-03. **Unauthorized-store invoices:** `invoiceDraftsHttp` IDH-02; `invoiceIssueHttp` IIH-02; `invoiceVoidHttp` IVH-03; `invoiceDraftRoutine` IDR-04. | G-ISOLATION stays OPEN in doc 08. DA-93 (a compromised runtime holding the issuer key) is open. Firestore holds no customer or invoice path (catch-all deny), so the emulator gives no isolation evidence for them. |
| B03 positive control; Host, Origin and CSRF refusals; no prohibited writes | PASS | PG, HTTP, proxy | **Tenant:** `invoiceRoleLevels` M5IRLH-04 (13 refusals before any key — session/audience, Host, Idempotency-Key, Origin and CSRF — then a zero write delta, then the owner's positive PUT); `customerCreate` M7CC-02; `tenantEntry` M7TE-05 (Host), M7TE-06 (Origin, pre-session CSRF). **Admin:** `productionEntry` M6EP-10, M6EP-11, with the positive control M6EP-04. **QA front Host:** `qaInteractiveFront` "host: wrong name, a port, a trailing dot…" (HTTP). **Live (proxy, this stage):** `probe --positive` (401, then 403 three times, then 200; the refusals wrote nothing: idempotency +1 and voided +1, both from the positive control); through the public origin, a void with a foreign `Origin` 403; on the front's loopback port, a wrong Host 404 (HTTP layer, not the edge). | Admin Host refusal is never shown on a mutating admin command followed by a database count. M6EP-11 counts the tenant row and idempotency records but not audit or outbox rows. M7CC-02 and M5IRLH-04 check the write delta once per batch of refusals. M7TE-05 takes no row count after its login refusals. The live probe covers CSRF and the positive control; Host and Origin were checked live without a session only. |
| B04 spoofed forwarding cannot move a client bucket | PASS | PG, HTTP, contract | `rateLimitRuntime` M6RS-09 (a spoofed `X-Forwarded-For` prefix or an untrusted peer's header cannot move the bucket), M6RS-01 (two runtimes share one client bucket), M6RS-06 ("Rate-limited runtime over real sockets…"); `server/runtime/clientAddress.test.ts` (a direct client is bucketed by its socket peer whatever it sends); `enforcement.test.ts` (forwarding headers from an untrusted peer cannot escape); `production-runtime-contract` (no per-process limiter or second proxy chain, contract). **QA front (contract):** it drops every `x-forwarded-*`, `forwarded`, `x-real-ip` and `x-replit-*` header and sets `X-Forwarded-For` to its own peer (`front.mjs` `forwardHeaders`). The supervisor trusts only `127.0.0.2/32`, so the runtime buckets by its socket peer: one client for every visitor. | `Forwarded`, `X-Real-IP`, `True-Client-IP` and `CF-Connecting-IP` are never sent against the real PostgreSQL limiter, nor from a trusted peer. The static guard names only three of those headers. The front-to-runtime-to-limiter chain is not exercised in CI. DA-9 (IPv4 loopback only) is open. The deterministic runner prints suite totals, not per-test lines. |
| B05 limiter budget; bounded outage; no allow-all fallback | PASS | PG, HTTP, contract | `rateLimiter` RLR-04 (overload fails closed), M6R-09 (a held lock answers unavailable within `lock_timeout`; "Distributed rate limiter…"); `rateLimitRuntime` M6RS-00 (no store binding refuses composition), M6RS-03, M6RS-10 (store down: every protected request a bounded 503), M6RS-11 (no local fallback for a known bucket), M6RS-14; `enforcement.test.ts` (an unavailable or hanging limiter fails closed, HTTP); `production-runtime-contract` (no in-memory limiter in production, contract). | A slow, rather than down, store is not driven end to end at HTTP. The runtime bound is asserted as under 2 s rather than against the 500 ms deadline. DA-52 (cost on the primary database) is open. Evidence is on a local disposable cluster only. The QA session's own limiter path has no outage test. |
| B06 audit failure cannot partially commit a void; lease recorded | PASS | PG | `invoiceVoidHttp` IVH-08 (a fault at the audit INSERT, among others, rolls the whole void back while the separately acquired idempotency lease stays open and uncompleted), IVH-09 (an unknown commit), IVH-11, IVH-11b; `invoiceVoidRoutine` IVR-08 (the routine writes only the void record; the audit is the command's). Step "Invoice void over HTTP…". | IVH-08 does not retry the same key after the audit fault. Lease expiry is forced rather than waited out. No `pg_locks` check follows the fault. DA-118 and DA-119 are open (direct routine calls by a holder of the runtime login and a minted key). The faults are owner triggers. |
| B07 concurrent issuing: one invoice per source, allocation, transaction facts | PASS | PG | `invoiceIssueRoutine` IIR-12 (deterministic races: one invoice per draft; numbers serialize at the store counter), IIR-13 (the source link is permanent, even for the table owner in replica mode); `invoiceIssueHttp` IIH-08 (all-or-nothing at six fault points; a failed issue consumes no number), IIH-09 (two tenant entries racing one draft). | The unique constraints are never violated directly. Concurrent allocation on different drafts is shown at routine level only. There is no concurrent same-key issue. The issue writes no outbox event, so no event fact is tested. There is no load or soak test. |
| B08 trusted audit actor/subject; no runtime rewrite; no invented event or worker | PASS | PG, contract | `invoiceVoidHttp` IVH-04 (the one void audit row is deep-equal to the trusted actor, store and subject; no outbox row), IVH-06 (client-supplied identity fields refused); `invoiceDraftDiscardHttp` IDDH-16; `productionEntry` M6AA-14 (the runtime login may only INSERT audit, through `tmpos_audit_writer`); `rlsIsolation` S2-DB-* (the audit writer is append-only); `invoiceVoidRoutine` IVR-08; `production-runtime-contract` (no bound outbox delivery worker, contract). | DA-118 is open. The privilege proof uses a test login carrying the shipped roles. The audit trigger is not `ENABLE ALWAYS`, so owner and superuser rewrites are not blocked (doc 13). "No worker" is static evidence only. |
| B09 migration hashes; clean disposable apply; startup preflight | PASS | PG, contract | `server/persistence/postgresStartupPreflight.test.ts` (exactly the up files 001–035, each pinned in `REQUIRED_MIGRATIONS`) and `tests/quality/migration-files-contract.test.mjs` (each file matches its pinned byte fingerprint; contract). `rlsIsolation` S2-DB-1 (001–005 applied to a fresh disposable service by the trusted executor); `customerDirectory` M7C-01 (001–035 applied clean). `productionEntryPreflight` M6PF-02, M6PF-22 (a changed checksum refuses `migration_state_invalid`). `tenantEntry` M7TE-10 (a ledger that is not exactly 001–035 refuses startup). Live (inferred from the tool's design, not printed): every QA `start`/`reset` in this stage made a new owned cluster through the trusted executor, and the tenant entry, whose preflight refuses any ledger other than exactly 001–035 (M7TE-10), started on it. | No single CI step applies 001–035 to an empty database in one go: one fresh service is carried forward across steps. The preflight trusts ledger rows, so in-place drift is not re-read (DA-55). Contract suites have count lines only. No managed database was checked; G-MIGRATE stays OPEN. |
| B10 approved runtime grants; direct-write refusals; routine gaps explicit | PASS (as worded) | PG | `productionEntryPreflight` M6PF-01 (the runtime login's privileges equal `APPROVED_ROLE_GRANTS` exactly), M6PF-14 (a stray privilege is refused at startup). `customerCreate` M7CC-09 (as the runtime login, every direct INSERT, UPDATE, DELETE and TRUNCATE on the customer table is 42501). `invoiceDraftRoutine` IDR-02 (no runtime privilege by any path on two RLS tables). `rlsIsolation` S2-DB-6, S2-DB-7 (the approved `store`/`tenant` verbs). | Approved direct table grants remain by design and are recorded: INSERT on `public.store`, column UPDATE on `public.store.store_name` and `public.tenant.legal_name` (DA-23, DA-29), and INSERT on `public.audit_event` for `tmpos_audit_writer`. All 52 `tmpos_app` EXECUTE grants are shared by the admin and tenant entries (DA-37). A holder of the runtime login and a minted key can call definer routines directly, outside audit, idempotency and outbox (DA-118, DA-119, DA-132). M6PF-01 proves equality with the approved list, not minimality. S2-DB-* ran at the 001–005 state. G-DBROLE stays OPEN. |
| B11 explicit SQL grants; no automatic public-table exposure; Data API HTTP | PASS (SQL); HTTP part not available here | PG | `rlsIsolation` S2-DB-22c (a table created later is closed by default), S2-DB-0 (PUBLIC `TEMPORARY` closed). `productionEntryPreflight` M6PF-30, M6PF-31 (PUBLIC relation, column or definer-routine exposure is refused), M6PF-36 (refused through the entry). `invoiceVoidRoutine` IVR-05 (035's exact routine surface; nothing granted to PUBLIC, `anon`, `authenticated` or the audit writer). | **Reported, not fixed here:** the startup preflight checks the runtime login, its two roles and PUBLIC, but not `anon` or `authenticated`. Those are checked only in migration postconditions (011, 020–022). A grant to `anon` added beside the migrations would therefore pass startup. Default privileges hold only for 005's role. There is no Data API or PostgREST layer in this repository, and none ran in CI. Migrations 002 and 004 defend against "PostgREST + anon key", so a hosted Data API's exposure is a deployment property this stage cannot evidence (G-DBROLE OPEN). |
| B12 QA isolation; no live provider traffic; production containment; owned cleanup | PASS (live operator evidence); CI part contract/HTTP only | contract, HTTP, proxy | **CI:** `qaInteractiveContainment` (src/ and server/ never import or name the QA tooling; the production construction carries no token verifier; the QA bundle config swaps exactly two modules and reads no `.env`; neither `.replit` nor CI mentions the tool), with build integrity PASS and forbidden-artifact PASS. `qaInteractiveFront` (the CSP `connect-src 'self'`; identity forwarding only to the emulators). **Live:** the only hosts the browser contacted were the Preview and the app's two web-font hosts (`fonts.googleapis.com`, `fonts.gstatic.com`, which the ordinary app also loads); no identity, data or business provider was contacted. A socket snapshot of the hand-over run's four recorded processes and their children, twelve processes in all (21:19:24Z), found no connection to a non-loopback address; port 5000 was the only public listener. Two resets each made a new generation, and one stop ended every recorded process and left no record, run directory or postgres process. | The QA session never runs in CI. Egress is shown by a browser host list and one socket snapshot, not by continuous capture. The lifecycle helpers (`stillOwned`, `removeOwnedDir`, `insideStateDir`, the supervisor's reset/stop paths) have no CI test; only the strict `postmaster.pid` read and `postgresOn` do. The check-then-signal window stays (§7). `.replit` has an uncommitted working-tree change; CI read only the committed file. |

Adjudications by the operator (recorded, not hidden):
- **B10.** An adversarial pass proposed FAIL against a stricter wording ("the runtime cannot write any table directly"). The row's requirement is the approved grants, the direct-write refusals and explicit routine gaps. Those hold, with the approved direct grants listed as gaps.
- **B12.** BLOCKED for CI alone, PASS once this stage's live operator evidence is counted.

## 10. QA-INTERACTIVE-P1-R1 verification record (2026-10-23)

This is the operator's evidence. It marks no owner check.

- **Entry.** HEAD and `origin/main` were both `04a9529`. The VM had rebooted since the P1 hand-over (boot about 20:15Z, `oom_kill` reset to 0), so run `qa-20261023t1522-8ffb` was gone and `status` reported a stale record. Replit had started `npm run dev` on port 5000. It was stopped with SIGINT at 20:47:35Z, and `start` then cleaned the stale record.
- **Run used for the smoke.** `qa-20261023t2047-d5e0`, ready at 20:49:06Z, built from the source trees of §3. Every browser step went through the public HTTPS Preview origin in one headless Chromium (flags below). The automation drove and observed the page only: it never intercepted or replaced a request or response, never set a cookie, and never bypassed sign-in. Faults came only from the operator commands. Request equality is shown as SHA-256 digest prefixes; no key, body, token, cookie or password was logged.
- **Attempt 1 (generation 1) — failed, kept.**
  - Script step U01 passed. Script step U02 passed every check up to its navigation, then failed in the scratch script's own sidebar lookup (the entries' text starts with the icon's name). Steps U03 and U04 failed the same way before acting; the release step between U02 and U03 passed.
  - Step U05 then ran out of order on a login that was still aged, and itself failed at the same lookup after the checks below. The runtime refused the held request before running it (fault record: `upstreamStatus` 403, `committed` false). The browser saw the edge's 502, the page said the void was not confirmed and might or might not have happened (true: nothing had run), and `inv-held` stayed `issued`.
  - This failure was in the operator's tool, not in the product.
- **Attempt 2 (generation 2, the lookup fixed): every script step passed.** These are the operator's script steps named after the owner's checks; they mark no owner result. This is a rerun with a corrected scratch script, not a product repair.
  - U01:
    - The held void on `inv-probe` was answered 502 at the browser. The page said "not confirmed".
    - At 320×600 with a 24 px default font size (`Page.setFontSizes`; viewport set by device-metrics emulation), the page did not scroll sideways. **Check again**, **Check invoice** and **Dismiss** were each inside the viewport and hit-tested to themselves, with no sidebar overlap.
    - Tab reached **Check invoice** in 42 presses. Enter sent exactly one `GET` of `inv-probe`, and the card said `Invoice 4 is voided now. This does not show which request voided it.`
    - A mouse **Dismiss** sent no request that changes anything.
    - Fault record `committed` true; evidence shows one void audit.
  - U02:
    - The aged login's first void send was answered 403 and the sign-in prompt opened.
    - The provider answer was held, and the deadline text appeared after 30.1 s.
    - The password field was empty, enabled and typable. **Customer Directory** opened from the sidebar without a reload.
    - Apart from that first refused send, no void and no session renewal were sent.
    - On `release` the late answer reached the browser (`deliveredToBrowser` true), and in the next 10 s nothing was sent and nothing reopened.
  - U03:
    - The provider sign-in was out and held, with no renewal sent. **Stop waiting** said it stopped and sent nothing.
    - After leaving the page and `release` (delivered), no `POST /api/v1/session/login` and no void were sent after **Confirm sign-in** (only the step's first send, refused 403, preceded it), and no review reopened.
    - The requests seen after the release were the SDK's `accounts:lookup`, `securetoken … token` and Firestore `Listen`, plus plain `GET /api/v1/session` and `GET /api/v1/customers` reads.
    - `inv-stall` stayed `issued`.
  - U04:
    - The confirmation read `Void invoice 1?` with the same customer and Total, and no reason preselected.
    - The first send was answered 403, the recent sign-in's login 200, and no void was sent between that login and the explicit press. The explicit void was answered 200.
    - After a reload the invoice read **Voided** / **Issued by mistake** with the same number and `Total $50.00`.
    - Evidence: `voided`, one void audit, `invoices_voided` 2 → 3.
  - U05:
    - The proxy's answer to the void was **502**, with no content type, only `content-length`, `date`, `replit-cluster` and `x-robots-tag` headers, and the request reported as aborted (`ERR_ABORTED`). The page reported uncertainty, claiming neither success nor rollback.
    - The fault record showed `upstreamStatus` 200, `committed` true. While the browser was held, the evidence was already `voided`, with one void audit.
    - On leaving and returning, the card was still unresolved and nothing was re-sent.
    - One explicit **Check again** went to the same path with the same key digest and the same body digest (88 bytes) and was answered 200: `Invoice 2 at Northwind Main (QA) was voided.`
    - Evidence: still one void audit; idempotency total 23 → 24 and `invoices_voided` 3 → 4 for the pair.
  - The run used three `owner-a` login exchanges in total. The only hosts contacted were the Preview host and the two web-font hosts, with no content-security-policy line.
- **What the held-void fixture proves, and what it does not.** It proves the branch where the runtime committed and answered 200, and the QA front withheld that answer from the browser. Attempt 1 also showed, by accident, the branch where the runtime refused the request before running it. Neither is a database COMMIT-acknowledgement-loss test: suppressing a browser response says nothing about a commit whose acknowledgement is lost between PostgreSQL and the runtime, and that branch stays untested here.
- **Backend probe (generation 3).**
  - `probe --positive` gave: no session 401 `unauthenticated`; `tech-a` 403; `owner-a` without CSRF 403; `owner-a` with a wrong CSRF value 403; positive control 200 (`voided`). The four refusals wrote nothing: idempotency 21 → 22 and `invoices_voided` 1 → 2, both from the positive control.
  - Public edge, with no session: `/` 200; `/api/v1/customers` 401; a void with `Origin: https://evil.example` 403; a wrong Host on port 5000 404 `host_not_served`.
- **Hand-over.**
  - `stop` (20:55:14–16Z) ended the four recorded processes, removed the record and the run directory, and left no postgres process.
  - A fresh `start` (ready 20:57:07Z) is the session of §3. It was started instead of a `reset` so that the owner's `status` shows no fault record from the operator's runs (§6).
- **Memory and out-of-memory window (observed, not a repair claim).**
  - The VM has 7,965 MB of memory and no swap (`free -m` at entry). At the stage's first scratch script write (about 20:47:10–20Z), this session's own code-intelligence integration started a TypeScript language server, a child of the agent CLI, holding 2.2 GB. It was not stopped.
  - `MemAvailable`: 2,307 MB before `start`; 1,482 MB once ready; 1,016 MB when the smoke's own guard first refused to launch a browser.
  - The guard was then lowered to 900 MB. Chromium ran with one renderer process and a 192 MB script heap, under a watchdog that would stop only that Chromium below 350 MB; it never triggered.
  - Free memory reached a minimum of 518 MB during attempt 1 and 698 MB during attempt 2, and 1,146 MB after the hand-over start.
  - `oom_kill` stayed 0 through the whole window.
  - This establishes that window only. It does not prove the earlier 72 kills' cause repaired; they belong to the previous boot.
- **Residuals.**
  - All QA traffic shares one login-limiter client.
  - A held void reaches the browser as the edge's 502.
  - Fault records survive `reset` without a generation (§6).
  - A cluster is unrecorded between `initdb` and its record (§7).
  - The window between an ownership check and its signal (§7).
  - The TypeScript language server's memory beside the stack.

None of this runbook closes a gate. The owner's Manual QA remains PENDING, and every production gate in [08](./08-production-gate-and-risk-register.md) stays OPEN.
