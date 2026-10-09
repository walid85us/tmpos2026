// M7A-CUSTOMERS-P3-R2 — THE SHOP'S BUILT-IN CUSTOMERS LEVELS, END TO END IN A REAL BROWSER: a PRODUCTION build of the shop
// SPA in Chromium, signed in through a synthetic Firebase identity provider, talking to the REAL tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) over loopback HTTP, over a disposable PostgreSQL holding every migration.
// M7A-CUSTOMERS-P4 (DA-125) — TWO tenant entries share that database: a scenario routes a page or tab to the second one
// (st.second), so the stale-draft cases cross instances. Every save asserts the tenant and version its draft was read at.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY:
//   - The network. Chromium resolves nothing (cdp.mjs HERMETIC_ARGS); CDP Fetch interception answers every request. The
//     page lives on https://shop.tmpos.test, which is also SESSION_TENANT_ORIGINS: its static files come from the build,
//     and its /api/v1/* requests are forwarded to the tenant entry with Host shop.tmpos.test preserved, every header and
//     body as Chromium sent them, and the answer (Set-Cookie included) handed back as the entry gave it — the same-origin
//     front DA-107 records as a pre-deployment dependency. Each forwarded request leaves from its own random 127.x source
//     (the login limit is per source; the trusted proxy 127.0.0.2 is never one).
//   - The identity provider. identitytoolkit/securetoken are answered here with unsigned Firebase-shaped ID tokens; the
//     entry's token verifier accepts exactly the tokens this file issued and answers their uid and auth_time (the only
//     substitution on the server path, as in tests/db/roleLevels.integration.test.mjs).
//   - Firestore (the shop reads users/{uid} for its role). Under `firebase emulators:exec --only firestore` (CI, and any
//     host holding the emulator), requests are forwarded to FIRESTORE_EMULATOR_HOST running the repository's
//     firestore.rules, loaded for the page's own project id. Where the emulator cannot run (it downloads a jar, and a local
//     run may not leave loopback), P3R2_FIRESTORE=stub answers the Listen channel for users/{uid} to that user alone —
//     the rules' single allow — and nothing else. The evidence names the mode.
// The tenant entry's host lock, Origin/CSRF checks, limiter, session boundary, authorizer, step-up rule, idempotency store,
// command transaction, migrations 020/021's routines, audit writer and read-back route are production's own code,
// unmodified (each entry's pool is smaller than production's MAX_POOLS, so two fit a disposable cluster's connections).
//
// WHAT IS PROVEN (CP5 of the stage brief), each case in tenants of its own, with counts the database owner reads:
//   SRL-W  THE ENTRY WITNESS: an owner narrows Sales Associate's Customers level from Create to View in the shop screen; one
//          PUT commits (level view, one audit, one completion) and a sales_staff session issued before the edit is refused
//          on POST /api/v1/customers with nothing written while GET stays 200. The driver uses the server panel when the
//          build has one and otherwise the Permissions grid (the only control the entry commit has), so the same case runs
//          red on the entry SPA (no PUT ever leaves the page) and green on the final one.
//   SRL-01 the owner sees the catalog defaults; narrows to View (saved only after read-back; enforced; GET follows View);
//          the stored level survives a reload and a second browser; None refuses GET and POST; restored to Create, the key
//          refused under None creates afresh (201, not a replay).
//   SRL-02 two tenants stay independent; a tenant-A read held past a same-browser switch to tenant B never replaces B's
//          panel; B's save lands on B alone.
//   SRL-03 a write whose session is missing or ended, whose session CSRF or Origin is stripped/foreign, whose Host is wrong,
//          whose owner lost the grant, or whose tenant server is down never shows "Saved" and writes nothing, each with the
//          status line the panel promises (AM1/AM6); a focus refresh during the outage keeps the rows (AM3); then a save
//          succeeds. M7A-CUSTOMERS-P6: after the session ended in the store, the owner presses Reconnect (one login)
//          before the next save — Save no longer signs in on its own. A revoked owner grant ends the owner's session:
//          the held key's save sends no login and no PUT ("Not confirmed yet", Reconnect offered); with the grant back,
//          Reconnect logs in once and a 403 refusal of the held key still says "Not confirmed yet"; and a Reconnect pressed
//          while the grant is revoked logs in once, shows the owner-only Denied state and writes nothing.
//   SRL-04 a stale sign-in is refused (403 step_up_required), the owner re-authenticates in a labelled prompt that takes
//          focus (AM7), and only then saves.
//   SRL-05 a failed identity verifier leaves the panel unavailable (no levels, no save) until it recovers.
//   SRL-06 a manager sees the panel denied, and the server refuses the manager's direct reads and PUTs — the self-grant and
//          its variants (another domain, Manage, an extra field) included — with nothing written, not even an audit record.
//   SRL-07 the local grid is labelled local-only; a grid change — a built-in role's Customers cell (which points to the
//          server panel) or a custom role's — sends nothing to any server and moves no server level; no global Save.
//   SRL-08 two browsers on two tenant entries read one role at the same version: the first narrows it (Saved); the
//          second's older, permissive draft is refused by the version precondition (409 write_conflict, nothing written,
//          no edit audit, the restrictive level and its authority stand) and shown as a conflict (the server's level and
//          the unsaved choice, Discard/Reapply, Save off); Reapply and a new Save (new version, new key) land it; the
//          first browser's "Saved" then says "Changed elsewhere" on its next refresh (AM2). A sales_staff session's
//          create and read answer each committed level.
//   SRL-08T the same with two TABS of one browser (one cookie jar, one sign-in), each tab on its own entry.
//   SRL-09 a user switch in one browser (a second tab signs in as another owner) ends the first user's tenant session
//          BEFORE the next user's login leaves the page (AM4: while that login is held, the old cookie reads 401); signing
//          out (the persisted sign-in cleared, as a sign-out in another tab leaves it) ends the next user's session too.
//   SRL-10 a draft made in tenant A, saved after the SAME owner's session moved to tenant B (grant swapped): since
//          M7A-CUSTOMERS-P6 the save finds the session ended and sends NOTHING — no login, no PUT — and offers Reconnect;
//          the Reconnect's one login (now B's) reads another store, so the draft is cleared and the shop says the store
//          changed. Nothing is written in A or B — no level, version, edit audit, completion or idempotency row.
//   SRL-11 a save PARKED INSIDE THE DATABASE (a side transaction holds A's role row FOR UPDATE; the PUT's backend waits
//          on it) while the owner's session moves to B (another tab of the browser signs in again): B is untouched, A
//          holds whatever the server decided, and the panel — now B's — reports it only as a detached notice, never as
//          B's save.
//   SRL-12 reset to the default, then an older draft: View, then Create restored (the default word, a newer version); a
//          draft made at the first version is refused though the level it saw is back (no ABA); Discard drops it.
//
// M7A-CUSTOMERS-P5 — THE CUSTOMER DIRECTORY PAGE (/customers/directory, src/tenant/ServerCustomerDirectory.tsx), in the
// same harness, driven by its test ids and judged on the wire (st.api) and in the database, each case in tenants of its
// own. One more substitution, stated: st.lose makes the front drop ONE request before it reaches the entry, or ONE answer
// after the entry gave it — the page sees a network failure, exactly what a cut connection leaves it.
//   SCB-01 THE ENTRY WITNESS: an owner opens the directory from the sidebar (empty), adds a customer — exactly one POST
//          from the page, 201, one customer, one create audit, one completion, no role edit; the row survives a reload,
//          a second account's browser shows it, its detail opens by click and by direct URL; no request names a tenant,
//          store, role or actor. Red on the entry SPA: no POST ever leaves the page and no row exists.
//   SCB-02 isolation: another tenant's customer id, a well-formed unknown id and a malformed id (no request at all) show
//          the SAME not-found text; tenant B's list holds B's customers only.
//   SCB-03 paging: 60 rows -> 50, "Load more" -> 60, ids unique, in the server's byte order, no `limit` sent.
//   SCB-04 a sales_staff page open while the owner narrows Customers to View: Add is refused (403), nothing written — no
//          customer, audit, completion or lease — and the list is still shown; narrowed to None, Refresh shows the denied
//          state and no rows.
//   SCB-05 a reply lost after the commit: the unresolved card, never "saved"; "Check again" re-sends the SAME key and the
//          byte-identical body (though the field was edited since), answered 201 as a replay; ONE customer of that name.
//   SCB-06 a first send that never reached the server, then the account's grant moves to tenant B: "Check again" finds
//          the session ended and sends nothing — no login, no POST (M7A-CUSTOMERS-P6) — and that end detaches the attempt
//          at once (M7B-INVOICES-P1-R2, DA-200); the owner's Reconnect signs in (now B's) and the attempt stays detached —
//          no POST leaves under the new session, neither tenant holds the name.
//
// M7A-CUSTOMERS-P5-R1 — the tenant session is REUSED across loads and the customer reads are BOUND to it (same harness).
// One more substitution, stated: SCB-08 swaps the browser's tenant session cookie (CDP Storage.setCookies in the page's
// browser context) while one read is parked at the front, and the front forwards that parked read with the swapped cookie —
// exactly what the jar would have sent had the swap landed a moment earlier. Numbers are appended to scb-witness.jsonl in
// the evidence folder BEFORE anything is asserted, so the entry run records the whole "before" picture.
//   SCB-07 SESSION REUSE (DA-143): inside one 5-minute window an owner opens the directory, reloads it 6 times, reopens it
//          by in-app navigation (away, back by the sidebar), makes one load that shows both server consumers (directory,
//          Permissions server panel, directory again) and opens it in a second TAB of the same browser; every load shows
//          the rows. Counted: POST /api/v1/session/login for this owner, live tmpos_session.session rows for the principal,
//          tmpos_mint.tenant_session rows (live, and the ledger's growth), every 429, and whether each load read GET
//          /api/v1/session before its first customer read. Expected: ONE login, one session row, one mint row, no 429.
//   SCB-08 READ BINDING (DA-138): owner A's page; owner B's valid session made outside the page. A's next list read (a
//          Refresh), then separately A's detail read (one of A's customers, by URL), is parked at the front AFTER the page's
//          session check was answered; the jar's session cookie is replaced with B's; the read is released carrying B's.
//          Recorded per read: the session it carried (A/B), the status, whether any answer delivered to the page or the DOM
//          (sampled at release and after the page settles) held a B id or name, and what the page ends showing. Expected:
//          403 with no customers, no B id ever on page A, and — after a session read, A's login and a confirming read — A's
//          own rows and customer again (a new A session).
//
// M7A-CUSTOMERS-P6 — a session the page confirmed that the server then ends is NEVER re-established on its own (same
// harness). The end is the one SRL-03 makes: the owner's tmpos_session.session rows (and their mint rows) deleted.
//   SCB-09 SESSION END: an owner's page with rows and an unresolved create (its answer lost after the commit); the session
//          is ended in the store. Refresh, a window focus, a tab return (visibilitychange), a customer opened in the app
//          and the way back send ZERO logins and no POST; the list and the detail show "Reconnect" and no customer; the
//          end the Refresh found detached the attempt at once (M7B-INVOICES-P1-R2, DA-200: no Check again). ONE Reconnect
//          click sends exactly ONE login, the rows return and the attempt stays detached (never re-sent: one POST in the
//          whole case). Ended again, a valid session another TAB made is reused on focus with
//          no login from the page. A reload while the cookie names an ended session is a fresh page: one login, the
//          stated residual (the 401 does not say "expired", and the page stores nothing). Not run in this stage's
//          sandbox (no browser gate here): written to SCB-05/07/08's helpers.
// Since M7A-CUSTOMERS-P6 the detail view reads the customer's profile (GET /api/v1/customers/{id}/profile): every detail
// matcher above names that path.
//   SCB-10 CONTACT RECORD: an owner adds a customer with a phone (typed with edge spaces) and an email — ONE POST whose body
//          is exactly { name, phone, email } (trimmed), 201 { id, name }; the database holds the trimmed phone, the email
//          and a creation time; the profile (opened from the saved notice) shows both and that time as a <time> whose
//          datetime is the stored instant; list rows and the notice show no contact. A customer from before contacts
//          (inserted with no phone, email or creation time) shows "Not provided" twice and "Not recorded".
// Since M7A-CUSTOMERS-P7 the profile 200 carries the customer's row version as a strong ETag, and the detail edits it
// (PATCH /api/v1/customers/{id}, body { expectedVersion, name, phone?, email? }):
//   SCB-11 PERSISTENT EDIT: an owner edits a customer's name and phone and clears its email — ONE PATCH of exactly
//          { expectedVersion: 1, name, phone, email: null } under a fresh v4 key, 200 { customer: { id, name }, version: 2,
//          changed: true }; one customer change, one update audit naming the customer, one completion; "Saved" and the
//          profile read again; after a reload and in a second browser through the second entry the same id, the same
//          creation time and the edited values.
//   SCB-12 STALE EDITOR: two browsers (the second through the second entry) open the same customer at version 1; the
//          first saves; the second's save is a 409 write_conflict that writes nothing but its completion, keeps its draft
//          and sends nothing more on its own; "Review latest" only reads; its deliberate save expects version 2 under a
//          NEW key and lands.
// Since M7A-CUSTOMERS-P8 the list takes a name search (GET /api/v1/customers?q=<text>, a search's own 44-character cursor;
// migration 025's routine matches case-insensitively anywhere in the name):
//   SCB-13 SEARCH: 60 matching customers (both letter cases) among others, the same names in a second tenant. The Search
//          button and Enter each send ONE GET of q; page one is exactly the first 50 matches in the database's
//          (name collate "C", id) order, "Load more" sends the search's own cursor and completes them, nothing of the
//          other tenant; a search with no match says "No customers match"; a search whose request is lost at the front is
//          the outage state, never "no matches", and its "Try again" reads the same search; Clear reads the unfiltered
//          list. No customer, audit, completion, idempotency or session record is written; the address never holds the text.
//   SCB-14 SEARCH THEN EDIT: a match opened by its row's link (one profile read); renamed out of the search, the active
//          search is read again from page one (one GET of q after the PATCH) and the way back lists it no longer, the
//          search box still holding the text; a search for the new name (by Enter) finds it.
// Since M7A-CUSTOMERS-P9 a new invoice draft may name a saved server customer, chosen in a picker over the same list route:
//   SCB-15 INVOICE DRAFT PICKER: 55 matches of one word, others, two customers with one identical name, a second tenant.
//          The picker opens on the unfiltered page; a search and "Load more" bind a second-page match by its database id
//          (the server-customer limit is said, Generate stays disabled); of the identical names the second is bound
//          exactly; Change then Cancel keeps it; Remove clears it; a local customer replaces a server one. Only GETs of the
//          list, session reads and ONE login are sent; no customer, audit, completion or idempotency record is written;
//          no answer holds the other tenant's customers; the directory still lists the tenant's customers.
// Since M7A-CUSTOMERS-P10 the picker is a modal over any host dialog (z-[190]; Tab and Shift+Tab wrap around its enabled
// controls; every other <body> child is inert while it is open; Escape closes it alone; focus goes back to "Select a server
// customer" or Change), and a new repair ticket may name a server customer too, which Create Ticket refuses:
//   SCB-16 REPAIR DRAFT PICKER: five customers, a second tenant. Device and issue filled, so only the customer can keep
//          Create off. A picked row is bound by its database id, the limit is said and names Create's description, Create
//          stays disabled and a press on it makes no ticket and keeps the draft; the browser's own hit test puts the picker
//          above the z-[110] ticket form; Change then Cancel keeps it; Remove clears it; a typed name and a local pick
//          replace it (Create on), a server pick replaces the local one; Cancel and New Ticket again hold no server
//          customer. Only list GETs, session reads and ONE login; nothing written; no request names a repair.
//   SCB-17 PICKER KEYBOARD (invoice draft): three customers. Tab from the local select reaches "Select a server customer",
//          Enter opens the picker on the search box with #root inert; Tab x6 then Shift+Tab x3 is the exact wrap over
//          Search, the three Selects and Cancel, each stop inside the dialog with a visible focus ring; Escape closes the
//          picker alone (the invoice draft stays, #root no longer inert, focus on the opener); Enter reopens it and a
//          Select reached by Tab and pressed with Enter binds that row, focus on Change. Two list reads, ONE login.
//   SCB-18 PICKER KEYBOARD (repair draft): the same journey from the ticket form's customer box; the ticket form stays
//          open after Escape, and the keyboard-bound customer keeps Create off with the limit as its description.
//   SRL-13 INVOICES LEVEL (M5-INVOICES-AUTH-P1): the Permissions tab holds a clearly labelled "Server-saved Invoices level"
//          panel beside the Customers one (its own ids), saying only the LEVEL is saved on the server and invoices stay in
//          this browser; the defaults, an owner save held at its read-back (never "Saved" before it), the exact PUT body,
//          the Customers panel and the Customers level untouched, the stored level surviving a reload and a second
//          browser, and the local grid's Invoices row pointing to the server section. In the database: 020's row for
//          (tenant, role, 'invoices') holds the level, 021's version for it is 1, exactly ONE tenant-scope edit audit names
//          the Invoices edit (reason code and the owner's reason), and the Customers row, version and audits are unchanged.
//   SRL-14 INVOICES COMPETING EDIT: a second browser saves first; the first browser's older draft is refused by the
//          version precondition (409 write_conflict) and writes nothing but its idempotency lease (no row, version or audit
//          change), shown as a conflict with the server's level, and only Reapply and a new Save (a NEW key) land it, with
//          exactly one more edit audit; the Customers panel, row, version and audits are untouched throughout.
//   SRL-15/SRL-16 LOST PUT REPLY (M5-INVOICES-AUTH-P1-R1, AC-10), Customers then Invoices: the owner's PUT commits and its
//          answer is dropped at the front. Before any user action: exactly ONE PUT left the page (no automatic re-send), one
//          change in the database (level, version 1, one edit audit), and the row says "Not confirmed yet" after its read-back.
//          Save pressed again sends exactly one more PUT, same Idempotency-Key and byte-identical body, answered as a replay
//          that writes nothing; the read-back then says "Saved".
// M7B-INVOICES-P1 — the Invoices page's "Server drafts" section (src/tenant/ServerInvoiceDrafts.tsx): store-owned invoice
// drafts over GET /api/v1/stores and /api/v1/stores/{storeId}/invoice-drafts[/{id}], migration 028's routines behind them.
// Each case's owner holds the tenant grant the shop signs in with (and the server customer picker reads through) AND a
// store grant at each of its stores: a draft route is decided only by the store grant at the store the path names (design
// D1), the picker only by the tenant grant (R2). D/L/A/O are that tenant's drafts, lines, draft create audits and draft
// events, read by the database owner; K and L of counts() its completions and idempotency records.
//   SDB-01 (AC-13) SAVE, RELOAD, LIST, REOPEN: the owner chooses one of two real stores (nothing preselected, nothing read
//          before Show and the choice), picks an existing server customer, types three lines (dollars parsed to exact
//          cents) and presses Save draft: ONE POST of exactly { expectedTenant, customerId, currency, lines } under a v4
//          key, 201 with its Location, ONE draft with its three ordered lines, one store-scope audit naming it, one event,
//          one completion; "Draft saved on the server." after one read-back GET. The row (customer name, creation time, line
//          count, Draft subtotal) survives a reload, and the read-only reopen shows the persisted lines, amounts and the
//          creation time the database holds (to the microsecond in the answer); the other store lists nothing; a second
//          browser through the second entry reopens the same draft; the local invoice table never gains a row. No draft
//          id, key, customer id, description or body in the address, browser storage (local, session, IndexedDB), the
//          page's own console or either entry's log.
//   SDB-02 (AC-14) LOST REPLY: the POST reaches the entry and commits, and its answer is dropped at the front (st.lose, after
//          the entry answered). A double press sends ONE POST; the attempt is held "Not confirmed yet" (never saved). A
//          window focus and a visibilitychange event, closing the dialog, leaving the page and coming back, and a list
//          read that SHOWS the draft
//          send nothing: still one POST and one draft (rows counted). "Check again" sends exactly one more POST with the
//          SAME Idempotency-Key and byte-identical body, answered 201 as a replay naming the stored draft; the database
//          still holds ONE draft, one audit, one event, one completion; the list shows it once.
//   SDB-03 (AC-15) STORE AND SESSION CHANGES: an unresolved create held for store W (its answer lost). Choosing another store
//          clears the scoped list at once; a list answer for the store left behind, parked at the front until the user has
//          moved back, changes nothing when released (its rows never appear); the held attempt keeps its own store and is
//          never re-sent or retargeted. Then the tenant session cookie is swapped (CDP Storage.setCookies, SCB-08's
//          substitution) for another valid session of the same owner while a reopen read's answer is parked: a window
//          focus starts a new connection — the store list is read again with nothing chosen, the open draft and the rows
//          are gone, the held attempt is detached (no Check again) — and the parked answer for the old session, released,
//          shows nothing. Those two parked answers belong to reads the PAGE ABORTS on the change (a store choice cancels the
//          list read, a new connection every read), so their fetch is gone before the release: they prove that nothing of
//          the old scope shows, not the section's staleness checks (the jsdom cases SID-06 and SID-19 pin those). Until
//          then ONE POST from the page (the two drafts seeded from outside the browser aside); the database holds exactly
//          the seeded drafts and the one the lost reply committed. Then a late answer the page does NOT abort reaches it:
//          after Stop tracking, a new draft for W is saved (201) and its one read-back GET — sent under that session, with
//          no abort signal — has its answer parked while the cookie is swapped again and a focus starts a third
//          connection. Released, that answer IS delivered (the page receives it) and is ignored: no "Draft saved on the
//          server." from it; the next render says "A server draft was saved under an earlier connection." and W's list,
//          read under the new session, shows the draft once. Two POSTs from the page in the whole case.
//   SDB-04 (AC-14) LOST REQUEST: the first POST never reaches the entry (st.lose, before it is forwarded). ONE POST; the
//          attempt is held "Not confirmed yet" and NOTHING is stored (no draft, line, audit, event, completion or
//          idempotency record) — the dangerous branch, since the server never saw the key. A window focus sends nothing.
//          "Check again" sends exactly one more POST with the SAME Idempotency-Key and byte-identical body, answered 201 as
//          the key's FIRST create (no Idempotent-Replayed): exactly ONE draft row, with its line, audit, event and one
//          completion; the list shows it once.
// M7B-INVOICES-P1's closing round. A SIGN-OUT here is SRL-09's: the persisted Firebase sign-in cleared in the page, exactly
// what a sign-out in another tab leaves behind (the shop has no sign-out control of its own); the tab's Firebase SDK
// notices it, AccessContext starts the tenant logout (not awaited) and the route guard shows /login in the SAME document.
// The next user signs in through that form, so the page's module memory (the draft hold store, the picker's pair) is the
// one the previous user left: a marker set on `window` before the sign-out is asserted still there.
//   SDB-05 (AC-15, DA-193, DA-198) USER SWITCH IN ONE TAB: user A (a store grant at store W) has W chosen, its rows listed,
//          the read-only reopen dialog open and an unconfirmed save held (the POST committed, its answer lost at the front).
//          A signs out; user B (another account of the tenant with its own store grant at W) signs in in the same tab.
//          Nothing of A shows — no store choice, row, dialog or held attempt (no "Check again"), before or after B's own
//          "Show server drafts", which lists B's stores with none chosen; no draft POST leaves the page during or after
//          the switch (its only POSTs: A's logout and B's login); no request after the sign-out carries A's session CSRF
//          token but the logout that ends A's session (A's cookie then reads 401), and once that logout has run A's token
//          is held nowhere in the page's JavaScript heap (a CDP heap snapshot of the renderer, searched as text: the draft
//          hold store, which kept it beside the held attempt, heard the sign-out — DA-198 in a real browser); B's own list
//          of W works. B signs out
//          and A signs in again in the same document: A's attempt is shown detached (no "Check again"), Stop tracking
//          puts focus on the section heading, and still no draft POST: one in the whole case, the lost one.
//   SDB-06 (DA-199) FOCUS IN REAL CHROMIUM, outside the dialogs: document.activeElement after each press is what the
//          section promises — "Show server drafts" (its stores read lost at the front), the stores' "Try again", the
//          list's "Try again" and the stores' "Reconnect" (after the session is ended in the store): the section heading;
//          "Load more" with more pages left: Load more itself, kept focusable (aria-disabled, never disabled) while its
//          read is parked, a press meanwhile sending nothing; "Load more" that brings the last page: the first row it
//          appended (its Open); "Load more" whose read is lost: the heading.
//   SDB-07 (AC-04) A BROWSER-ONLY CUSTOM ROLE AGAINST THE SERVER'S AUTHORITY. The shop cannot persist or assign a custom
//          role: it only reads users/{uid} (firestore.rules lets the client write no users document), and a role made in
//          its Roles tab lives only in that page's memory (AccessContext's tenantRolesState, through addTenantRole). So the
//          owner makes the role in the Roles tab and gives it Invoices Full and Customers View in the local grid (no write
//          request reaches the tenant server and nothing is written to Firestore), and the HARNESS seeds the second
//          account's users/{uid}.role with that role's id (Employees.tsx's rule: the name lower-cased, whitespace to "_")
//          to stand for a browser-only role; that account signs in in the SAME document after the owner's sign-out, so the
//          page still holds the role. Its server grants are `technician` (tenant and store: Invoices View by default). The
//          page's hint follows the seeded id into that in-memory role (Invoices Full), so the invoice form's "Create
//          Invoice" IS offered (the local invoices are the browser's own). M7B-INVOICES-P1-R2 (DA-201, AC-09) inverts the
//          section's half: "New server draft" is the server's decision now, and its eligibility read is answered 403
//          `forbidden` (after the one fresh session check: the same token), so New is NOT offered and the section says the
//          account may not save drafts there; the store's draft still lists (View). The direct save stays refused on its
//          own (AC-10): the POST a Save would send — the page's own session cookie, its session CSRF token, the
//          request-intent header, a v4 key and the exact body — sent by the harness from inside the page (fetch in its
//          document, same-origin, credentials included: no stand-in route, no test-only permission, the real store) is
//          answered 403 `forbidden`; nothing is written: no draft, line, audit, outbox event, idempotency completion or
//          lease, and no role-level row or version, and the eligibility reads wrote nothing either.
//   SDB-08 (AC-15, DA-198) A READ OUT WHEN ANOTHER USER SIGNS IN: user A has W chosen, and W's list read has been
//          answered by the entry with A's row but its answer is parked at the front. User B (another account of the tenant,
//          a store grant at W) signs in in a second tab of the same browser — SRL-09's switch: this tab's Firebase SDK
//          follows the shared sign-in, so AccessContext starts A's logout and then awaits B's users/{uid} profile, which
//          the harness holds (the Listen channel's request naming that document), keeping A's page MOUNTED. A's answer is
//          released then: the drafts section has already ended at the sign-out (its stores say the session ended), and
//          the answer shows nothing — no row, draft or customer name — and starts nothing: no customer-name read, and no
//          request from this tab after the switch began but its one logout of A's session carries A's session CSRF token
//          (answered 401 when the other tab's own switch has already ended that session, as it can). Once B's profile is
//          released this tab shows B's Invoices page, and still nothing of A.
// M7B-INVOICES-P1-R2 — SERVER ELIGIBILITY (DA-201, journey D): "New server draft" follows GET
// /api/v1/stores/{storeId}/invoice-drafts/eligibility, answered by the real entry over 028.
//   SDB-09 (AC-08, AC-11, AC-13) A manager with store grants at W and E: W's eligibility answer (200, exactly
//          {"eligibility":"allowed"}, carrying the session CSRF token, no query) is parked at the front — no New, the
//          section says it is checking — and released: New. A stale allowance cannot cross a store switch: E's check is
//          parked before it reaches the entry, then W's next allowance is parked, then E is chosen again (its check parked
//          too); W's allowance released while E is chosen offers nothing (the page aborted that read on the switch, so
//          this shows that nothing of W's scope shows, not the section's staleness checks — the jsdom SID-63..65 pin
//          those); E's own released check then offers New. The owner lowers the manager's Invoices level to View outside
//          the browser (the shop's PUT): the next check (choosing W) is 403 forbidden and New goes, said as an alert, and
//          the same at E; raised back to Create, the next check offers New again. Nothing the checks do writes: no
//          draft, line, audit, outbox event, completion, lease, idempotency record or role-level row; no draft POST.
//   SDB-10 (AC-13) A STALE ALLOWANCE ACROSS A SESSION/USER SWITCH: user A has W chosen and W's eligibility allowance
//          parked at the front; B signs in in a second tab (SDB-08's window: B's profile held, A's page mounted). Released
//          then, the allowance offers nothing — the section had ended at the sign-out (its stores say so) — and starts
//          nothing; no request after the switch but A's logout carries A's token; B's page then shows no New of A's.
// M7B-INVOICES-P2 — EDITING A SAVED DRAFT: PATCH /api/v1/stores/{storeId}/invoice-drafts/{id} and GET
// …/{id}/edit-eligibility (Invoices Edit), answered by the real entry over migration 029. E/V/W of editCounts: the
// tenant's draft edit audits, its edit events and the draft's stored version. Each case says which kind of evidence it is.
//   SDB-11 (AC-16, observable end to end: the wire, the page and the database) EDIT, RELOAD, SECOND SESSION: the owner
//          saves a two-line draft, then Edit — offered only once the server's edit eligibility answered — opens the
//          editor seeded with the draft (customer, ordered lines, version 1); another customer, a line edited, one
//          added, one removed, one moved up; Save: ONE PATCH of exactly { expectedTenant, expectedVersion: 1,
//          customerId, lines } under a v4 key, 200 { draftId, version: 2, changed: true }; one version step, one
//          store-scope edit audit naming the draft, one edit event, one completion, the lines replaced; "Saved" after
//          ONE read-back. A reload and a second browser through the second entry read version 2 and the new lines. A
//          sales_staff account (Invoices Create by default) lists the draft but gets no Edit (the edit eligibility 403,
//          said), and its direct PATCH from the page — its own cookie, session token, intent header, a v4 key — is
//          refused 403 with nothing written.
//   SDB-12 (AC-16, observable end to end) A CONFLICT NEEDS EXPLICIT REVIEW: two browsers (two entries) open the editor
//          at version 1; the second saves first (version 2); the first's save is the sealed 409 write_conflict, writing
//          only its completion: the server keeps the second browser's line, the first keeps its working copy, reads the
//          draft afresh ONCE and shows both, sends nothing more on its own and holds Save back; Reapply sends the same
//          working copy under a NEW key at version 2 and lands version 3 (two edit audits in all).
//   SDB-13 (AC-17, observable end to end) UNKNOWN OUTCOME: the PATCH commits and its answer is dropped at the front
//          (st.lose): "Not confirmed yet", never "Saved"; a focus and a visibilitychange send nothing; "Check again"
//          sends exactly one more PATCH with the SAME key and byte-identical body (read from the network log), answered
//          200 as a replay: still ONE version step. A second lost edit, then a reload: no editor comes back and nothing
//          is sent (that edit committed: version 3).
//   SDB-14 (AC-17, observable no-old-content) SIGN-OUT DURING AN UNKNOWN OUTCOME: the lost edit's owner signs out (the
//          route guard unmounts the page) and signs in again in the same document: no editor, attempt, Check again,
//          dialog or typed line, and no PATCH after the sign-out; the server kept the edit it committed.
//   SDB-15 (AC-17, a late answer actually delivered) DA-198's window: A's PATCH is answered by the entry (committed)
//          and its answer parked at the front; B signs in in a second tab (B's profile held, A's page mounted). The
//          editor closed at the sign-out; released, the answer IS received by A's page (no session end aborts the PATCH
//          — it carries only the client's own request deadline — so the browser reports it finished) and shows nothing
//          — no "Saved", no dialog, no read-back — and starts nothing; no request after the switch but A's logout
//          carries A's token.
// M7B-INVOICES-P1-R2 — SESSION-END CLEANUP (DA-200, DA-202, AC-07). A production sign-out unmounts the page (the route
// guard), so a case that needs the old page still mounted uses SDB-08's window: another account signs in in a second tab
// of the same browser, this tab starts A's logout and then awaits B's profile, which the harness holds.
//   SSE-01 (DA-200, AC-01..04) THE CUSTOMER DIRECTORY'S CREATE HOLD: an owner adds a customer with a phone and an email;
//          ONE POST commits and its answer is lost at the front (Check again offered). The owner signs out in this tab
//          (the same document): once the logout has run, the page's JavaScript heap holds neither the session CSRF token
//          nor the exact body sent (the phone and email strings are still reachable there through the detached inputs a
//          CDP handle of this harness keeps, and React's value tracker on them — recorded with their retaining path, not
//          asserted: no erasure of the contact is claimed). Signed in again (a new session), the attempt shows detached and unnamed, with no
//          Check again, through a navigation away and back; Stop tracking forgets it. A second add (name only) has its
//          201 parked at the front, the owner signs out, and the answer is released at /login: nothing is read or sent
//          for it. Signed in again, the directory says a customer sent before the session ended was saved — no name, no
//          link. Two POSTs in the whole case, two customers, each with its one audit and completion.
//   SSE-02 (DA-202, AC-05/06) A CHOSEN SERVER CUSTOMER WITH THE PICKER CLOSED: A's invoice draft holds a server customer
//          ("Save as server draft" offered), the picker closed; B signs in in a second tab (B's profile held, A's page
//          mounted): the field drops the customer with the session-ended notice, and the limit text and "Save as server
//          draft" go — observed while every session check of this tab (a focus or tab-return check included) is held
//          before it leaves, so the drop is the sign-out's own. Once B's profile loads, the draft (now B's) holds no server
//          customer, and opening B's picker binds nothing. Nothing is written.
//   SSE-03 (AC-07) THE DRAFT HAND-OVER'S SESSION CHECK: A hands a server customer to the Server drafts section and chooses
//          a store; the server's eligibility answer (parked, then released: M7B-INVOICES-P1-R2) opens the New server draft
//          dialog; its session check (GET /api/v1/session) is held at the front.
//          B signs in in a second tab (B's profile held); the check's answer, released then, opens nothing: no dialog, no
//          customer, no hand-over note, no draft POST and no login, and no request after the switch but A's logout carries
//          A's session CSRF token. A REGRESSION GUARD, not evidence of the AC-07 fix: it passes on the entry commit too
//          (recorded: the session client's epoch neutralizes an answer that arrives after the logout began, and the
//          section's own sign-out listener closes the dialog). The fix's cases — an answer that had arrived just before
//          the sign-out, a new or ended generation before the answer — are jsdom-only (ServerInvoiceDrafts.test.tsx
//          SID-55, SID-56).
// M7B-INVOICES-P2 — THE CUSTOMER DIRECTORY'S EDIT HOLD AT A SIGN-OUT (AC-01/AC-02).
//   SSE-04 (AC-01/02) THE EDIT HOLD AND THE OPEN EDIT FORM: an owner edits a customer's name and phone; ONE PATCH commits
//          and its answer is lost at the front (Check again offered). The owner signs out in this tab (the same document):
//          once the logout has run, the page's heap holds neither the session CSRF token nor the exact PATCH body (the
//          same search just before the sign-out finds both: a positive control; the new name and phone are recorded with
//          their retaining path, not asserted). Signed in again (a new session) nothing of the edit is held, offered or
//          said, through a navigation away and back and a Refresh. The edit form is opened again and a phone typed; at the
//          next sign-out nothing is sent and the heap holds no token of either session (the typed phone recorded with its
//          retaining path, not asserted). A REGRESSION GUARD, not evidence of the fix: it passes on the entry commit too (a
//          real sign-out reaches the mounted page, whose listener drops its user's held edit, and the entry's edit store
//          also followed the Firebase sign-in). The fix's cases — a sign-out heard with no page mounted, a logout that never reached the
//          server so the same session is found again, a late answer or a Check again around the sign-out — are
//          jsdom-only (ServerCustomerDirectory.test.tsx SCD-177..186).
//   All run against the REAL tenant entry and the disposable database only: the file has no stand-in for any route.
//
// RUN (the SPA build runs Tailwind's scanner over the source root: point P3R2_SPA_SOURCE at a clean export, node_modules
// linked, when the working tree holds large untracked directories — the same variable builds the entry commit's SPA for the
// witness; P3R2_SPA_DIST reuses a finished build; P3R2_EVIDENCE names the evidence folder):
//   firebase emulators:exec --only firestore --project demo-tmpos-shop 'tsx --test tests/browser/shopRoleLevels.browser.test.mjs'
//   P3R2_FIRESTORE=stub tsx --test tests/browser/shopRoleLevels.browser.test.mjs          (no emulator: stub, stated)
// DISPOSABLE ONLY: the database target is tests/db/localPostgres.harness.mjs's (a supplied CI service or a cluster made and
// destroyed here). On a shared service this file removes its customers, role levels and their 021 versions (or 021's
// rollback would refuse), sessions and mint rows, restores the
// limiter fingerprint and issuer key row it found, and drops its login. Since M7B-INVOICES-P1 it first removes its tenants'
// drafts, lines and draft events and clears every audit subject naming one of its drafts (an owner transaction lifting
// 002's append-only trigger, then restoring it — the HTTP draft suite's technique): their foreign keys hold its customers
// (no CASCADE), and a draft or a draft audit subject left behind would make 028's rollback refuse (R8). What it leaves is
// what every suite leaves: its synthetically named identities, tenants, stores and grants, their audit records and
// idempotency records.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from '../db/localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { isApiPath } from '../../server/runtime/adminWeb.ts';
import { findChromium, launch, redact } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = process.env.P3R2_SPA_SOURCE ?? ROOT;
const PREBUILT = process.env.P3R2_SPA_DIST ?? null;
const EVIDENCE = process.env.P3R2_EVIDENCE ?? join(tmpdir(), 'tmpos-p3r2-evidence');
const CHROMIUM = findChromium();
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ?? null;
if (EMULATOR !== null && !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR)) throw new Error('FIRESTORE_EMULATOR_HOST must be a loopback host:port');
const FIRESTORE_MODE = EMULATOR !== null ? 'emulator' : process.env.P3R2_FIRESTORE === 'stub' ? 'stub' : null;

const SHOP_HOST = 'shop.tmpos.test';
const SHOP = `https://${SHOP_HOST}`;
const ADMIN = 'https://admin.tmpos.test';
const IDP_HOST = 'identitytoolkit.googleapis.com';
const STS_HOST = 'securetoken.googleapis.com';
const FS_HOST = 'firestore.googleapis.com';
/** The project and database the page's Firebase SDK names (the build embeds this file). */
const FIREBASE = JSON.parse(readFileSync(join(SOURCE, 'firebase-applet-config.json'), 'utf8'));
const PROJECT = FIREBASE.projectId;
const DATABASE_ID = FIREBASE.firestoreDatabaseId ?? '(default)';

/** Literals, not imports: this file must load against the entry commit's tree as well. */
const ROLE_LEVELS = '/api/v1/roles/levels';
const INVOICES_READ = '/api/v1/roles/levels/invoices';
const CUSTOMERS = '/api/v1/customers';
const LOGIN = '/api/v1/session/login';
const CREATE_ACTION = 'tenant.customer.create';
const EDIT_ACTION = 'tenant.role.level.update';
const UPDATE_ACTION = 'tenant.customer.update';
const REASON = 'Owner review of customer access';
const LABELS = Object.freeze({ none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', manage: 'Manage', approve: 'Approve', full: 'Full Access' });
const STALE_S = Math.ceil((RECENT_AUTH_MAX_AGE_MS + 60_000) / 1000);
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7srl_probe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host', 'content-length']);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token43 = () => randomBytes(32).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const postBody = (request) => request.postData ?? (request.postDataEntries ?? []).map((e) => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('');
/** A random 127.x.y.z loopback source, never the trusted proxy 127.0.0.2: each is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// the disposable database: every migration in the directory, a least-privilege runtime login, the three keys
// (mirrors tests/db/roleLevels.integration.test.mjs)
// ---------------------------------------------------------------------------------------------------------------------

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = join(ROOT, MIG_REL);
const TARGET = resolveDisposableTarget('M7SRL');
const TARGET_DSN = TARGET.dsn;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);
const owner = testClient(TARGET, { max: 3, onnotice: () => {} });

function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  url.username = user;
  url.password = '';
  return url.toString();
}

const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const UIDS = [];
const TENANTS = [];
let fingerprintBefore;
let issuerKeyBefore;

async function setupDatabase() {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: { purpose: 'migration', migratorRef: 'm7srl-migrator', runtimeRef: 'm7srl-runtime' },
      lockKey: 528_527, now: () => new Date().toISOString(), deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
  const [fp] = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  fingerprintBefore = fp === undefined ? null : { ...fp, fingerprint: Buffer.from(fp.fingerprint) };
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  const [ik] = await owner`select key from tmpos_mint.issuer_key where singleton`;
  issuerKeyBefore = ik === undefined ? null : Buffer.from(ik.key);
  await installTestIssuerKey(owner, ISSUER_KEY);
}

async function teardownDatabase() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    if (TENANTS.length > 0) {
      // M7B-INVOICES-P1 (R8): drafts before the customers their foreign keys hold; their audit subjects cleared and their
      // events removed, so nothing of this file blocks 028's rollback (an entry commit before 028 has no such table).
      await step(async () => {
        const [{ present }] = await owner`select to_regclass('tmpos_invoice_draft.invoice_draft') is not null as present`;
        if (!present) return;
        await owner.begin('isolation level read committed', async (sql) => {
          const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
          if (drafts.length > 0) {
            // 002's append-only trigger is lifted for this one update and put back in exactly the mode it was found in.
            const [{ mode }] = await sql`select tgenabled as mode from pg_catalog.pg_trigger
              where tgrelid = 'public.audit_event'::regclass and tgname = 'trg_audit_event_reject_mutation'`;
            const restore = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' }[mode];
            assert.ok(restore, `the append-only trigger's mode is known: ${mode}`);
            await sql.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
            await sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`;
            await sql.unsafe(`alter table public.audit_event ${restore} trg_audit_event_reject_mutation`);
          }
          await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
          await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
          await sql`delete from tmpos_internal.outbox_event where event_type = 'invoice_draft.created'
            and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = any(${TENANTS}::uuid[]))`;
        });
      });
      await step(async () => { // 021's version rows first (an entry commit before 021 has no such table)
        const [{ present }] = await owner`select to_regclass('tmpos_role_edit.role_level_version') is not null as present`;
        if (present) await owner`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
      });
      await step(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
      await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
      await step(async () => { // R8, checked rather than assumed
        const [{ present }] = await owner`select to_regclass('tmpos_invoice_draft.invoice_draft') is not null as present`;
        if (!present) return;
        const [state] = await owner`select
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[]))::int as lines,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors`;
        assert.deepEqual({ ...state }, { drafts: 0, lines: 0, subjects: 0, anchors: 0 }, 'R8: nothing of this file blocks 028\'s rollback');
      });
    }
    if (UIDS.length > 0) {
      await step(async () => {
        const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`).map((r) => r.session_key);
        if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
        await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
      });
    }
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
    if (fingerprintBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
        if (fingerprintBefore !== null) {
          await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
            values (${fingerprintBefore.singleton}, ${fingerprintBefore.fingerprint}, ${fingerprintBefore.registered_at}::text::timestamptz)`;
        }
      }));
    }
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    TARGET.cluster?.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7SRL teardown: a cleanup step failed');
}

/**
 * C/A/E/U/K/L/T: customers, create audits, role edit audits, customer update audits, sealed completions, every idempotency
 * row, and EVERY audit record (session logins and logouts included, so T is asserted only across steps that make no
 * session) — deltas around a step.
 */
async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as c,
    (select count(*) from public.audit_event where action_id = ${CREATE_ACTION})::int as a,
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION})::int as e,
    (select count(*) from public.audit_event where action_id = ${UPDATE_ACTION})::int as u,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as k,
    (select count(*) from tmpos_internal.idempotency_record)::int as l,
    (select count(*) from public.audit_event)::int as t`;
  return r;
}
async function deltaSince(before) {
  const now = await counts();
  return { C: now.c - before.c, A: now.a - before.a, E: now.e - before.e, U: now.u - before.u, K: now.k - before.k, L: now.l - before.l, T: now.t - before.t };
}
async function assertDelta(before, expected, label) {
  const got = note(label, await deltaSince(before));
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/A/E/U/K/L/T ${JSON.stringify(got)}`);
}
const NOTHING = Object.freeze({ C: 0, A: 0, E: 0, K: 0, L: 0 });
/** A refused request on a session made beforehand: nothing at all, not even an audit record of any kind. */
const REFUSED = Object.freeze({ ...NOTHING, T: 0 });
/** One role edit: its audit record, its completion, its one idempotency record, no customer. */
const EDIT = Object.freeze({ C: 0, A: 0, E: 1, K: 1, L: 1 });

/** The stored Customers level of a role: a level, null (020's lock row: the default) or undefined (no row). */
async function levelOf(tenant, roleId) {
  const rows = await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${tenant} and role_id = ${roleId} and domain = 'customers'`;
  return rows.length === 0 ? undefined : rows[0].level;
}

/** One tenant's whole role-level footprint: its edit audits, stored levels (020's lock row: 'lock') and 021 versions. */
async function tenantState(tenant) {
  const [r] = await owner`select
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION} and tenant_id = ${tenant})::int as edits,
    (select coalesce(jsonb_object_agg(role_id, coalesce(level, 'lock')), '{}') from tmpos_role.tenant_role_level where tenant_id = ${tenant}) as levels,
    (select coalesce(jsonb_object_agg(role_id, version), '{}') from tmpos_role_edit.role_level_version where tenant_id = ${tenant}) as versions`;
  return r;
}

/**
 * One role's footprint in ONE domain of one tenant (M5-INVOICES-AUTH-P1): its stored level (020's lock row: 'lock'; no row:
 * null), its 021 version (null: none) and every tenant-scope edit audit whose reason code names this role and domain —
 * the reason code and the owner's reason of each, oldest first.
 */
async function domainState(tenant, roleId, domain) {
  const [r] = await owner`select
    (select coalesce(level, 'lock') from tmpos_role.tenant_role_level where tenant_id = ${tenant} and role_id = ${roleId} and domain = ${domain}) as level,
    (select version::int from tmpos_role_edit.role_level_version where tenant_id = ${tenant} and role_id = ${roleId} and domain = ${domain}) as version,
    (select coalesce(jsonb_agg(jsonb_build_array(reason_code, human_readable_reason) order by occurred_at, event_id), '[]')
       from public.audit_event where action_id = ${EDIT_ACTION} and scope_type = 'tenant' and tenant_id = ${tenant}
        and starts_with(reason_code, ${`role_${roleId}_${domain}_to_`})) as audits`;
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// the synthetic identity provider: accounts, unsigned ID tokens, and the entry's verifier over exactly those tokens
// ---------------------------------------------------------------------------------------------------------------------

const ACCOUNTS = new Map(); // email -> { uid, email, password, staleOnce }
const ISSUED = new Map(); // ID token -> { uid, authTime }
const REFRESH = new Map(); // refresh token -> { uid, authTime, email }
const idp = { verifierDown: false };

/** An unsigned Firebase-shaped ID token: the page's SDK parses it; only VERIFIER, over ISSUED, ever accepts it. */
function mintToken(uid, authTime = nowSec(), email = `${uid}@shop.tmpos.test`) {
  const iat = nowSec();
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: authTime, user_id: uid, sub: uid, iat, exp: iat + 3600,
    email, email_verified: true, firebase: { identities: { email: [email] }, sign_in_provider: 'password' },
  };
  const token = `${b64u({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' })}.${b64u(payload)}.${randomBytes(64).toString('base64url')}`;
  ISSUED.set(token, { uid, authTime });
  return token;
}

/** The entry's token verifier: a token this file issued answers the uid and auth_time its payload carries; else a verdict. */
const VERIFIER = Object.freeze({
  async verify(token) {
    if (idp.verifierDown) throw new Error('synthetic verifier outage'); // no credential verdict: the runtime answers 503
    if (!ISSUED.has(token)) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { uid: claims.user_id, authTime: claims.auth_time, secondFactor: claims.firebase?.sign_in_second_factor };
  },
});

function corsFor(request) {
  const h = lower(request.headers);
  return [['access-control-allow-origin', h.origin ?? SHOP], ['access-control-allow-credentials', 'true'], ['vary', 'origin']];
}
function preflight(request) {
  const h = lower(request.headers);
  return {
    status: 204,
    headers: [...corsFor(request), ['access-control-allow-methods', 'GET,POST,OPTIONS'],
      ['access-control-allow-headers', h['access-control-request-headers'] ?? 'content-type'], ['access-control-max-age', '600']],
  };
}

// Shapes as tests/browser/admin-console.browser.test.mjs confirmed them against node_modules/@firebase/auth (firebase 12).
function identityProvider(request, u) {
  if (request.method === 'OPTIONS') return preflight(request);
  st.idp.push(`${request.method} ${u.host}${u.pathname}`);
  const reply = (status, obj) => ({ status, headers: [...corsFor(request), ['content-type', 'application/json; charset=UTF-8']], body: JSON.stringify(obj) });
  const fail = (message) => reply(400, { error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } });
  const session = (a, authTime) => {
    const idToken = mintToken(a.uid, authTime, a.email);
    const refreshToken = token43();
    REFRESH.set(refreshToken, { uid: a.uid, authTime, email: a.email });
    return { idToken, refreshToken };
  };
  if (u.host === STS_HOST && u.pathname === '/v1/token') {
    const r = REFRESH.get(new URLSearchParams(postBody(request)).get('refresh_token'));
    if (r === undefined) return fail('INVALID_REFRESH_TOKEN');
    const { idToken, refreshToken } = session(r, r.authTime); // a refresh keeps the sign-in's auth_time, as Firebase does
    return reply(200, { access_token: idToken, expires_in: '3600', id_token: idToken, project_id: '0', refresh_token: refreshToken, token_type: 'Bearer', user_id: r.uid });
  }
  let body = {};
  try { body = JSON.parse(postBody(request) || '{}'); } catch { /* treated as empty */ }
  if (u.host === IDP_HOST && u.pathname === '/v1/accounts:signInWithPassword') {
    const a = ACCOUNTS.get(body.email);
    if (a === undefined || a.password !== body.password) return fail('INVALID_LOGIN_CREDENTIALS');
    const authTime = nowSec() - (a.staleOnce ? STALE_S : 0); // a stale account signed in "long ago" once
    a.staleOnce = false;
    const { idToken, refreshToken } = session(a, authTime);
    return reply(200, { kind: 'identitytoolkit#VerifyPasswordResponse', localId: a.uid, email: a.email, displayName: '', registered: true, idToken, refreshToken, expiresIn: '3600' });
  }
  if (u.host === IDP_HOST && u.pathname === '/v1/accounts:lookup') {
    const rec = ISSUED.get(body.idToken);
    const a = rec && [...ACCOUNTS.values()].find((x) => x.uid === rec.uid);
    if (!a) return fail('INVALID_ID_TOKEN');
    return reply(200, {
      kind: 'identitytoolkit#GetAccountInfoResponse',
      users: [{
        localId: a.uid, email: a.email, emailVerified: true, passwordHash: 'UkVEQUNURUQ=', passwordUpdatedAt: 1767225600000, validSince: '1767225600',
        providerUserInfo: [{ providerId: 'password', federatedId: a.email, email: a.email, rawId: a.email }],
        createdAt: '1767225600000', lastLoginAt: String(Date.now()), lastRefreshAt: new Date().toISOString(),
      }],
    });
  }
  st.blocked.push(`${request.method} https://${u.host}${u.pathname}`);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Firestore: the emulator (forwarded, the repository's rules) or, stated, the Listen-only stand-in
// ---------------------------------------------------------------------------------------------------------------------

const USER_DOCS = new Map(); // uid -> { role, name }
const emulatorUrl = (path) => `http://${EMULATOR}${path}`;

async function seedUserDoc(uid, role, name) {
  USER_DOCS.set(uid, { role, name });
  if (FIRESTORE_MODE !== 'emulator') return;
  const res = await fetch(emulatorUrl(`/v1/projects/${PROJECT}/databases/${DATABASE_ID}/documents/users/${uid}`), {
    method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { role: { stringValue: role }, name: { stringValue: name } } }),
  });
  assert.equal(res.status, 200, `seed users/${uid} in the emulator: ${res.status} ${await res.text()}`);
}

async function loadEmulatorRules() {
  // The page's project id, not the exec's demo- id: the rules must govern the requests the page makes.
  const res = await fetch(emulatorUrl(`/emulator/v1/projects/${PROJECT}:securityRules`), {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ content: readFileSync(join(ROOT, 'firestore.rules'), 'utf8') }] } }),
  });
  assert.equal(res.status, 200, `load firestore.rules into the emulator: ${res.status} ${await res.text()}`);
}

function forwardFirestore(request, u) {
  const payload = request.hasPostData || request.postData || request.postDataEntries ? Buffer.from(postBody(request)) : null;
  const headers = Object.fromEntries(Object.entries(lower(request.headers)).filter(([k]) => !HOP.has(k)));
  const [host, port] = EMULATOR.split(':');
  return new Promise((resolve) => {
    const req = http.request({
      host, port: Number(port), method: request.method, path: `${u.pathname}${u.search}`, agent: false,
      headers: { ...headers, host: EMULATOR, ...(payload ? { 'content-length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => resolve(null));
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          if (!HOP.has(name) && !name.startsWith('access-control-')) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        }
        resolve({ status: res.statusCode, headers: [...pairs, ...corsFor(request)], body: Buffer.concat(chunks) });
      });
    });
    req.on('error', () => resolve(null));
    // A streaming backchannel hangs until the SDK notices the buffering and switches to long polling.
    req.setTimeout(70_000, () => req.destroy());
    req.end(payload ?? undefined);
  });
}

// ponytail: a Listen-only WebChannel stand-in for a host without the emulator jar. It serves users/{uid} to that user
// alone (the rules' one allow) and refuses every other target; the emulator is the gate's real Firestore.
const CHANNELS = new Map(); // SID -> { uid, next, queue, wake }
const chunk = (value) => { const text = JSON.stringify(value); return `${text.length}\n${text}`; };
function listen(channel, message) {
  if (message.addTarget === undefined) return;
  const { targetId } = message.addTarget;
  const names = message.addTarget.documents?.documents ?? [];
  const push = (m) => channel.queue.push([m]);
  push({ targetChange: { targetChangeType: 'ADD', targetIds: [targetId] } });
  const own = names.length === 1 ? /\/documents\/users\/([^/]+)$/.exec(names[0]) : null;
  if (own === null || own[1] !== channel.uid) {
    push({ targetChange: { targetChangeType: 'REMOVE', targetIds: [targetId], cause: { code: 7, message: 'Missing or insufficient permissions.' } } });
    return;
  }
  const doc = USER_DOCS.get(own[1]);
  const at = new Date().toISOString();
  if (doc) {
    push({ documentChange: { document: { name: names[0], fields: { role: { stringValue: doc.role }, name: { stringValue: doc.name } }, createTime: at, updateTime: at }, targetIds: [targetId] } });
  }
  push({ targetChange: { targetChangeType: 'CURRENT', targetIds: [targetId], resumeToken: 'AQ==', readTime: at } });
  push({ targetChange: { resumeToken: 'AQ==', readTime: at } });
}
async function firestoreStub(request, u) {
  if (request.method === 'OPTIONS') return preflight(request);
  const reply = (text, status = 200) => ({ status, headers: [...corsFor(request), ['content-type', 'application/javascript; charset=utf-8'], ['cache-control', 'no-store']], body: text });
  if (!u.pathname.endsWith('/google.firestore.v1.Firestore/Listen/channel')) return null;
  const sid = u.searchParams.get('SID');
  if (request.method === 'POST') {
    const form = new URLSearchParams(postBody(request));
    const messages = [];
    for (let i = 0; i < Number(form.get('count') ?? 0); i++) messages.push(JSON.parse(form.get(`req${i}___data__`) ?? '{}'));
    let channel = CHANNELS.get(sid);
    if (sid === null) {
      const bearer = /authorization:\s*bearer\s+([^\r\n]+)/i.exec(form.get('headers') ?? '');
      channel = { id: token43(), uid: bearer ? ISSUED.get(bearer[1].trim())?.uid ?? null : null, next: 1, queue: [], wake: null };
      CHANNELS.set(channel.id, channel);
    }
    if (channel === undefined) return reply('Unknown SID', 400);
    for (const m of messages) listen(channel, m);
    channel.wake?.();
    return reply(sid === null ? chunk([[0, ['c', channel.id, '', 8, 14, 30000]]]) : chunk([1, channel.next - 1, 0]));
  }
  const channel = CHANNELS.get(sid);
  if (channel === undefined) return reply('Unknown SID', 400);
  if (u.searchParams.get('TYPE') === 'terminate') { CHANNELS.delete(sid); return reply(chunk([1, channel.next - 1, 0])); }
  if (channel.queue.length === 0) await Promise.race([new Promise((r) => { channel.wake = r; }), delay(20_000)]);
  channel.wake = null;
  if (channel.queue.length === 0) channel.queue.push(['noop']);
  return reply(chunk(channel.queue.splice(0).map((m) => [channel.next++, m])));
}

// ---------------------------------------------------------------------------------------------------------------------
// the tenant entry (one at a time; SRL-03 stops and restarts it) and direct HTTP to it
// ---------------------------------------------------------------------------------------------------------------------

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ENV = Object.freeze({
  NODE_ENV: 'production',
  PORT: '8443',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: ADMIN,
  SESSION_TENANT_ORIGINS: SHOP,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'm7srl-test-project', client_email: 'm7srl@m7srl-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

let entry = null; // { port, cap } while the tenant entry listens
let entry2 = null; // the second tenant entry over the same database (P4): pages and tabs in st.second reach it
/** Each entry's pool: two, the owner's client and the cluster's reserved slots fit a disposable cluster's 20 connections. */
const POOLS = Math.min(5, MAX_POOLS);

async function startEntry() {
  entry = await listenEntry();
}

async function listenEntry() {
  const cap = { codes: [], lines: [], proc: new EventEmitter() };
  const construction = {
    databaseClient: () => createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
    }),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({
    env: ENV, construction, proc: cap.proc, exit: (code) => { cap.codes.push(code); }, log: { log: (line) => { cap.lines.push(line); } },
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  return { port: result.address.port, cap };
}

async function stopEntry() {
  const stopping = entry;
  entry = null;
  await stopped(stopping);
}

async function stopped(listening) {
  if (listening === null) return;
  const { cap } = listening;
  cap.proc.emit('SIGTERM');
  for (const until = Date.now() + 10_000; cap.codes.length === 0 && Date.now() < until;) await delay(20);
  assert.ok(cap.codes.length > 0, 'the tenant entry stopped: an outage case is a real one');
}

function send(port, method, path, headers, body) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false, localAddress: randomLoopback(),
      headers: payload ? { ...headers, 'content-length': String(payload.length) } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (!HOP.has(res.rawHeaders[i].toLowerCase())) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, headers: res.headers, pairs, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`no reply within 30 s: ${method} ${path}`)));
    req.end(payload ?? undefined);
  });
}

/**
 * A request from outside the browser (a pre-issued employee session, a manager's direct attempt), as a same-origin client.
 * A request with a session names it by its session CSRF token, as the shop does: the customer reads require it since
 * M7A-CUSTOMERS-P5-R1 (DA-138), and it changes nothing on a route that does not.
 */
async function call(method, path, { session = null, body, key } = {}) {
  const unsafe = method !== 'GET';
  const headers = {
    host: SHOP_HOST,
    ...(session ? { cookie: session.cookie } : {}),
    // A bare cookie (readWith: the unbound roles/levels read) carries no token to send.
    ...(typeof session?.csrf === 'string' ? { [SESSION_CSRF_HEADER]: session.csrf } : {}),
    ...(unsafe ? { origin: SHOP, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  };
  const bodyText = body === undefined ? (unsafe ? '' : undefined) : JSON.stringify(body);
  const res = await send(entry.port, method, path, headers, bodyText);
  return { status: res.status, headers: res.headers, text: res.body.toString('utf8') };
}

/**
 * Every tenant login attempt of the run, per account (the server allows 5 per account per 5 minutes): the evidence names
 * the most any account made inside one such window, so a scenario that spends the budget shows before it fails.
 */
const LOGINS = new Map(); // uid -> [performance.now() of each attempt]
function noteLogin(uid) {
  if (uid !== null) LOGINS.set(uid, [...(LOGINS.get(uid) ?? []), performance.now()]);
}
function loginPeak() {
  let peak = { account: null, logins: 0 };
  for (const [uid, times] of LOGINS) {
    for (const start of times) {
      const logins = times.filter((t) => t >= start && t < start + 5 * 60_000).length;
      if (logins > peak.logins) peak = { account: uid, logins };
    }
  }
  return { ...peak, accounts: LOGINS.size, attempts: [...LOGINS.values()].reduce((n, times) => n + times.length, 0) };
}

/** A tenant session established outside the browser with a token this file issued: { cookie, csrf }. */
async function directLogin(who) {
  noteLogin(who.uid);
  const res = await send(entry.port, 'POST', LOGIN, {
    host: SHOP_HOST, origin: SHOP, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${mintToken(who.uid)}`,
  }, '');
  assert.equal(res.status, 200, `direct login ${who.label}: ${res.body}`);
  return { cookie: res.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(res.body.toString('utf8')).csrfToken };
}

// ---------------------------------------------------------------------------------------------------------------------
// fixtures: principals, tenants, grants, accounts and users docs
// ---------------------------------------------------------------------------------------------------------------------

async function actor(label, memberships, { role = null } = {}) {
  const uid = `m7srl-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.store === undefined ? 'tenant' : 'store'}, ${m.role}, 'active')`;
  }
  UIDS.push(uid);
  const who = { id, uid, label, email: `${label}-${SUFFIX}@shop.tmpos.test`, password: `synthetic-${label}-password` };
  if (role !== null) {
    ACCOUNTS.set(who.email, { uid, email: who.email, password: who.password, staleOnce: false });
    await seedUserDoc(uid, role, `Synthetic ${label}`);
  }
  return who;
}
const grant = (tenant, role) => ({ tenant, role });
/** A STORE-scope grant (M7B-INVOICES-P1): what the draft routes decide on, at exactly that store. */
const storeGrant = (tenant, store, role) => ({ tenant, store, role });

async function newTenant(label) {
  const [{ tenant_id: tenant }] = await owner`insert into tenant (display_name, status) values (${`m7srl-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(tenant);
  return tenant;
}

/** A tenant of its own with its store owner, who can sign in to the shop. */
async function shop(label) {
  const tenant = await newTenant(label);
  const boss = await actor(`${label}-owner`, [grant(tenant, 'store_owner')], { role: 'store_owner' });
  return { tenant, boss };
}

/**
 * The same account's store moves from `from` to `to`: its grant is swapped in one transaction (two tenant grants at once
 * are refused), which ends its sessions (their admission no longer holds); its next login is scoped to `to`.
 */
async function moveOwner(who, from, to) {
  await owner.begin(async (sql) => {
    await sql`delete from user_membership where internal_user_id = ${who.id} and tenant_id = ${from}`;
    await sql`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${who.id}, ${to}, null, 'tenant', 'store_owner', 'active')`;
  });
}

/** A level set outside the browser the way the shop sets it: read the tenant and version, then PUT asserting both. */
async function directSet(session, roleId, level) {
  const read = await call('GET', ROLE_LEVELS, { session });
  assert.equal(read.status, 200, read.text);
  const { tenant, roles } = JSON.parse(read.text);
  const expectedVersion = roles.find((r) => r.roleId === roleId).version;
  return call('PUT', ROLE_LEVELS, { session, body: { roleId, domain: 'customers', level, reason: REASON, expectedTenant: tenant, expectedVersion }, key: randomUUID() });
}

/** What a sales_staff session may do under each committed Customers level: [POST create, GET list] statuses. */
const AUTHORITY = Object.freeze({ none: [403, 403], view: [403, 200], create: [201, 200], edit: [201, 200] });
async function assertAuthority(staffSession, level, label) {
  const post = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL ${label} ${randomUUID().slice(0, 8)}` }, key: randomUUID() });
  const list = await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession });
  note(`authority: ${label}`, [post.status, list.status]);
  assert.deepEqual([post.status, list.status], AUTHORITY[level], `${label}: a sales_staff session's create and read under ${level}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// interception: the shop host (build + forwarded API), the identity provider, Firestore; everything else is refused
// ---------------------------------------------------------------------------------------------------------------------

const files = new Map();
let browser = null;
let st = null; // the running scenario's recordings, gates and tamper hook
const evidence = { firestore: FIRESTORE_MODE, source: SOURCE === ROOT ? 'repository root' : 'P3R2_SPA_SOURCE', scenarios: {} };

function note(key, value) { if (st) st.notes[key] = value; return value; }

async function route(ev) {
  let u;
  try { u = new URL(ev.request.url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (st === null) return null;
  if (u.protocol === 'https:' && u.host === SHOP_HOST) return isApiPath(u.pathname) ? shopApi(ev, u) : shopStatic(ev, u);
  if (u.protocol === 'https:' && (u.host === IDP_HOST || u.host === STS_HOST)) return identityProvider(ev.request, u);
  // The shop's stylesheet @imports Google Fonts; a failed @import fails Vite's CSS preload and with it the app chunk.
  if (u.protocol === 'https:' && u.host === 'fonts.googleapis.com') return { status: 200, headers: [['content-type', 'text/css; charset=utf-8'], ...corsFor(ev.request)], body: '' };
  if (u.protocol === 'https:' && u.host === FS_HOST) {
    if (ev.request.method === 'OPTIONS') return preflight(ev.request);
    st.firestore.push(`${ev.request.method} ${u.pathname}`);
    const s = st;
    for (const g of [...s.profileGates]) {
      if (!g.match(ev, u)) continue;
      s.profileGates.delete(g);
      g.hit();
      await g.released;
    }
    return FIRESTORE_MODE === 'emulator' ? forwardFirestore(ev.request, u) : firestoreStub(ev.request, u);
  }
  st.blocked.push(`${ev.request.method} ${u.protocol}//${u.host}${u.pathname}`);
  return null;
}

function shopStatic(ev, u) {
  if (ev.request.method !== 'GET') { st.blocked.push(`${ev.request.method} ${SHOP}${u.pathname}`); return null; }
  const file = files.get(u.pathname) ?? files.get('/index.html'); // the SPA fallback a static host gives
  return { status: 200, headers: [['content-type', TYPES[extname(file)] ?? 'application/octet-stream'], ['cache-control', 'no-store']], body: readFileSync(file) };
}

/** The same-origin front: /api/v1/* to the tenant entry, Host preserved, every header and the body as sent. */
async function shopApi(ev, u) {
  const s = st;
  const { request } = ev;
  const headers = lower(request.headers);
  // at: when the page sent it; doneAt: when the entry had answered it; cookie: the session cookie it set, name=value.
  // via: the tenant entry it was forwarded to (2: the page or tab is in st.second).
  const rec = { method: request.method, path: u.pathname, query: u.search, frameId: ev.frameId, via: s.second.has(ev.frameId) ? 2 : 1, headers, body: postBody(request), status: null, at: performance.now(), doneAt: null, cookie: null };
  s.api.push(rec);
  if (rec.method === 'POST' && rec.path === LOGIN) noteLogin(bearerUid(rec));
  await passGates(s, rec, 'request');
  // st.lose (SCB-05/06): this request never reaches the entry; the page's fetch fails as a cut connection does.
  if (s.lose?.(rec, 'request')) { rec.lost = 'request'; rec.status = 0; rec.doneAt = performance.now(); return null; }
  const out = { ...Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k))), host: SHOP_HOST };
  if (s.tamper) await s.tamper(rec, out);
  let res = null;
  const target = rec.via === 2 ? entry2 : entry;
  if (target !== null) res = await send(target.port, rec.method, `${u.pathname}${u.search}`, out, rec.body === '' && rec.method === 'GET' ? undefined : rec.body).catch(() => null);
  if (res === null) res = { status: 502, pairs: [['content-type', 'text/plain'], ['cache-control', 'no-store']], body: Buffer.from('Bad Gateway') };
  rec.doneAt = performance.now();
  rec.status = res.status;
  try {
    const answer = JSON.parse(res.body.toString('utf8'));
    rec.error = answer.error;
    if (typeof answer.csrfToken === 'string') s.secrets.add(answer.csrfToken);
  } catch { /* not JSON */ }
  const cookie = res.pairs.find(([k]) => k.toLowerCase() === 'set-cookie');
  if (cookie) {
    rec.cookie = cookie[1].split(';')[0];
    const value = rec.cookie.split('=').slice(1).join('=');
    if (value !== '') s.secrets.add(value); // a logout's clearing cookie carries no value
  }
  // replied: what the entry answered (headers lower-cased, the body as text), whether or not the page receives it.
  rec.replied = { headers: lower(Object.fromEntries(res.pairs)), text: res.body.toString('utf8') };
  await passGates(s, rec, 'response');
  // st.lose: the entry answered (and committed whatever it committed); the answer never reaches the page.
  if (s.lose?.(rec, 'response')) { rec.lost = 'response'; return null; }
  // handedBack: the answer is on its way to the page (SDB-03 waits for it before sampling a released answer's effect). A
  // request the page has aborted meanwhile is gone: Chrome refuses the fulfilment and the page never receives the answer.
  rec.handedBack = true;
  return { status: res.status, headers: res.pairs, body: res.body };
}

async function passGates(s, rec, phase) {
  for (const g of [...s.gates]) {
    if (g.phase !== phase || !g.match(rec)) continue;
    s.gates.delete(g);
    g.hit(rec);
    await g.released;
  }
}

/** Hold the next API request (or its answer) that `match`es until release() — bounded, and released at scenario end. */
function gate(match, phase) {
  let hit;
  let release;
  const reached = new Promise((r) => { hit = r; });
  const released = new Promise((r) => { release = r; });
  st.gates.add({ match, phase, hit, released: Promise.race([released, delay(60_000)]) }); // a bound, never a result
  st.releases.push(release);
  return { reached, release };
}

/**
 * Hold `page`'s next Firestore read of users/{uid} — the Listen channel's forward POST whose form-encoded messages name
 * that document (AccessContext's profile read after a sign-in: getDoc rides the WebChannel) — until release(); bounded,
 * and released at scenario end. Keep a hold short: the SDK calls itself offline after 10 s without a healthy stream.
 */
function profileGate(page, uid) {
  let hit;
  let release;
  const reached = new Promise((r) => { hit = r; });
  const released = new Promise((r) => { release = r; });
  const match = (ev, u) => ev.frameId === page.frameId && ev.request.method === 'POST' && u.pathname.endsWith('/Listen/channel')
    && [...new URLSearchParams(postBody(ev.request)).values()].some((v) => v.includes(`/documents/users/${uid}"`));
  st.profileGates.add({ match, hit, released: Promise.race([released, delay(30_000)]) }); // a bound, never a result
  st.releases.push(release);
  return { reached, release };
}

const apiLine = (r) => `${r.via === 2 ? '[entry2] ' : ''}${r.method} ${r.path}${r.query} -> ${r.status ?? 'held'}${r.error ? ` ${r.error}` : ''}${r.lost ? ` (${r.lost} lost at the front)` : ''}`;
/** An answer's status and error, e.g. "409 write_conflict". */
const answered = (r) => `${r.status}${r.error ? ` ${r.error}` : ''}`;
const isPut = (r) => r.method === 'PUT' && r.path === ROLE_LEVELS;
const isRead = (r) => r.method === 'GET' && r.path === ROLE_LEVELS;
const isInvPut = (r) => r.method === 'PUT' && r.path === ROLE_LEVELS && r.body.includes('"domain":"invoices"');
const isInvRead = (r) => r.method === 'GET' && r.path === INVOICES_READ;
const isLogout = (r) => r.method === 'POST' && r.path === '/api/v1/session/logout';
/** The UID whose ID token a login carried (a token this file issued), or null. */
const bearerUid = (r) => ISSUED.get(/^Bearer (\S+)$/i.exec(r.headers.authorization ?? '')?.[1] ?? '')?.uid ?? null;
/** A login for `who` that the entry accepted: its session cookie (name=value) is the one that user held. */
const acceptedLogin = (who) => (r) => r.method === 'POST' && r.path === LOGIN && r.status === 200 && r.cookie !== null && bearerUid(r) === who.uid;
/** What a GET /api/v1/roles/levels on exactly this cookie answers now, from outside the browser. */
const readWith = (cookie) => call('GET', ROLE_LEVELS, { session: { cookie } });

// ---------------------------------------------------------------------------------------------------------------------
// the page: sign in, open the editor, drive the server panel (or, on the entry build, the grid)
// ---------------------------------------------------------------------------------------------------------------------

async function openPage() {
  const page = await browser.newPage({ width: 1440, height: 1000 });
  page.frameId = (await page.send('Page.getFrameTree')).frameTree.frame.id;
  st.pages.push(page);
  return page;
}

/** A second tab in the SAME browser context (shared cookies and Firebase persistence), built on the page's own class. */
async function sameContextTab(page) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: page.contextId });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = Object.assign(Object.create(Object.getPrototypeOf(page)), { browser, sessionId, contextId: page.contextId, logs: [] });
  await tab.init(1440, 1000, false);
  tab.frameId = targetId;
  st.tabs.push(targetId);
  return tab;
}

async function signIn(page, who) {
  await page.goto(`${SHOP}/login`, 30_000);
  await page.waitFor(`!!document.querySelector('input[type="email"]')`, 30_000, 'the sign-in form');
  await page.fill('input[type="email"]', who.email);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitFor(`location.pathname === '/'`, 30_000, `${who.label} signed in and left /login`);
}

async function openPermissions(page) {
  await page.evaluate(`history.pushState({}, '', '/employees'); dispatchEvent(new PopStateEvent('popstate'))`);
  const tab = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Permissions'))`;
  await page.waitFor(`!!${tab}`, 30_000, 'the Permissions tab');
  await page.evaluate(`${tab}.setAttribute('data-p3r2', 'permissions-tab')`);
  await page.click('[data-p3r2="permissions-tab"]');
  await page.waitFor(`!!document.querySelector('[data-testid="server-customer-levels"]') || [...document.querySelectorAll('th')].some((th) => th.textContent.includes('Module / Action'))`, 30_000, 'the Permissions tab content');
}

const hasPanel = (page) => page.evaluate(`!!document.querySelector('[data-testid="server-customer-levels"]')`);
const panelState = (page) => page.evaluate(`document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() ?? null`);
const waitState = (page, state, timeout = 30_000) =>
  page.waitFor(`document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === ${JSON.stringify(state)}`, timeout, `the server panel is ${state}`);

/** A role's row as the panel shows it: { level (label), badge }, or null. */
async function rowOf(page, roleId, prefix = 'server-level') {
  const text = await page.evaluate(`document.querySelector('[data-testid="${prefix}-row-${roleId}"]')?.textContent ?? null`);
  if (text === null) return null;
  // "Last known level" is the same level not established by a read since (a failed read-back): `known` says which.
  const m = /(Server|Last known) level:\s*(None|View Only|Create|Edit|Manage|Approve|Full Access)\s*(Custom|Default)/.exec(text);
  return m ? { level: m[2], badge: m[3], known: m[1] === 'Server' } : { text };
}
async function waitRow(page, roleId, level, badge, prefix = 'server-level') {
  await page.waitFor(async () => {
    const row = await rowOf(page, roleId, prefix);
    return row?.level === LABELS[level] && row?.badge === badge;
  }, 20_000, `${roleId} shows ${LABELS[level]} (${badge})`);
}

/** Choose a level and a reason for a role in the server panel (a React-visible value change on each control). */
async function draft(page, roleId, level, reason = REASON, prefix = 'server-level') {
  const set = function (proto, event, value) {
    Object.getOwnPropertyDescriptor(window[proto].prototype, 'value').set.call(this, value);
    this.dispatchEvent(new Event(event, { bubbles: true }));
  };
  await page.call(`[data-testid="${prefix}-select-${roleId}"]`, set, 'HTMLSelectElement', 'change', level);
  await page.call(`[data-testid="${prefix}-reason-${roleId}"]`, set, 'HTMLInputElement', 'input', reason);
}

const statusOf = (page, roleId, prefix = 'server-level') => page.evaluate(`document.querySelector('[data-testid="${prefix}-status-${roleId}"]')?.textContent.trim() ?? null`);

/** Press "Save to server"; answers the API record count at the click, for settle(). */
async function clickSave(page, roleId, prefix = 'server-level') {
  const button = `[data-testid="${prefix}-save-${roleId}"]`;
  await page.waitFor(`document.querySelector(${JSON.stringify(button)})?.disabled === false`, 10_000, `Save enabled for ${roleId}`);
  const from = st.api.length;
  await page.click(button);
  return from;
}

/**
 * The row's status once this save has settled: every save sends at least one request (the session check), so it has settled
 * when a request went out after the click, every one of those has been answered, the row is no longer busy, and its status
 * line is not a transitional one. (A previous attempt's identical text can therefore never be mistaken for this one's.)
 */
function settle(page, roleId, from, prefix = 'server-level') {
  const mine = (r) => r.frameId === page.frameId;
  return page.waitFor(async () => {
    const sent = st.api.slice(from).filter(mine);
    if (sent.length === 0 || sent.some((r) => r.status === null)) return null;
    const text = await statusOf(page, roleId, prefix);
    // A disabled select is a save still finishing — or a settled conflict, which locks the row until Discard or Reapply.
    const busy = await page.evaluate(`(document.querySelector('[data-testid="${prefix}-select-${roleId}"]')?.disabled ?? false)
      && document.querySelector('[data-testid="${prefix}-status-${roleId}"]')?.dataset.status !== 'conflict'`);
    return !busy && text && text !== 'Not saved yet.' && !text.startsWith('Saving') ? text : null;
  }, 45_000, `the save of ${roleId} settled`);
}

/** Press "Save to server" and wait for the row's settled status line; answers that text. */
async function save(page, roleId, prefix = 'server-level') {
  return settle(page, roleId, await clickSave(page, roleId, prefix), prefix);
}
/** AM1: exactly "Saved" is the one success line; every other line is not a save. */
const saved = (text) => text === 'Saved';

/** The status lines the panel promises (src/tenant/ServerCustomerLevels.tsx, AM1-AM6), by outcome. */
const SAY = Object.freeze({
  signedOut: 'Not saved: your server session ended. Reconnect, then save again.',
  refused: 'Not saved: the server refused this change. Only the store owner can change these levels.',
  unreachable: 'Not saved: the store server could not be reached. Try again.',
  stepUp: 'Not saved: sign in again to save this change.',
  signedInAgain: 'Signed in again. Press "Save to server" to save this change.',
  notConfirmed: (level) => `Not confirmed yet — press Save again to check. The server has ${LABELS[level]}.`,
  // a held attempt (its key may have committed) refused or unsent: never "Not saved" (R2-2)
  confirmDenied: 'Not confirmed yet — the server refused the check. Only the store owner can change these levels.',
  confirmEnded: 'Not confirmed yet — your server session ended. Reconnect, then press Save again to check.',
  confirmUnreachable: 'Not confirmed yet — the store server could not be reached. Press Save again to check.',
  lostRace: (level) => `Changed elsewhere — the server now has ${LABELS[level]}. Your change is not saved.`,
  changedElsewhere: (level) => `Changed elsewhere — the server now has ${LABELS[level]}.`,
  reapplied: 'Reapplied to the current server level. Not saved yet.',
});
const REFRESH_FAILED = 'Could not refresh from the server; values may be out of date.';
/** The panel's notices after a same-account tenant switch (STORE_CHANGED_NOTICE and PREVIOUS_STORE there). */
const STORE_CHANGED = 'The store server now answers for a different store. Unsent changes were cleared. No change was sent to the newly connected store.';
const PREVIOUS_STORE = Object.freeze({
  acknowledged: 'A change sent before the store connection changed was acknowledged by the server; it could not be read back here.',
  notSaved: 'A change sent before the store connection changed was not saved.',
  unconfirmed: 'A change sent before the store connection changed could not be confirmed.',
});

/** The backends waiting on `pid` (pg_blocking_pids), with what they run. */
const blockedBy = (pid) => owner`select pid, usename, wait_event_type, left(query, 200) as query
  from pg_catalog.pg_stat_activity where ${pid}::int = any(pg_catalog.pg_blocking_pids(pid))`;
/** Poll `fn` until it answers something truthy (that answer), or fail after `timeout` ms. */
async function until(fn, timeout, label) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out after ${timeout} ms: ${label}`);
    await delay(100);
  }
}
/** { changed: the store-changed notice or null, previous: the previous-store notices }. */
const noticesOf = (page) => page.evaluate(`({
  changed: document.querySelector('[data-testid="server-levels-store-changed"]')?.textContent.trim() ?? null,
  previous: [...document.querySelectorAll('[data-testid="server-levels-previous-store"] p')].map((p) => p.textContent.trim()),
})`);
/** A role's conflict group: "The server now has X. Your unsaved choice: Y." or null. */
const conflictOf = (page, roleId) => page.evaluate(`document.querySelector('[data-testid="server-level-conflict-${roleId}"] p')?.textContent.trim() ?? null`);
const saveEnabled = (page, roleId) => page.evaluate(`document.querySelector('[data-testid="server-level-save-${roleId}"]')?.disabled === false`);
const hasDraft = (page, roleId) => page.evaluate(`!!document.querySelector('[data-testid="server-level-unsaved-${roleId}"]')`);
/** Route a page's (or tab's) API requests to the second tenant entry; answers the page. */
const viaSecond = (page) => { st.second.add(page.frameId); return page; };

/** The entry build's only control: the Permissions grid's cell for (role column, domain row). */
async function setGridLevel(page, roleName, domainLabel, level) {
  return page.evaluate(`(() => {
    const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent.includes('Module / Action'));
    const col = [...table.querySelectorAll('thead th')].findIndex((th) => th.textContent.trim().startsWith(${JSON.stringify(roleName)}));
    const row = [...table.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim().startsWith(${JSON.stringify(domainLabel)}));
    const select = row.querySelectorAll('td')[col].querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(level)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
}

/** A button whose text ends with `suffix` (a tab or a toolbar action: its icon's ligature comes first), clicked. */
async function clickButton(page, suffix, tag) {
  const find = `[...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.trim().endsWith(${JSON.stringify(suffix)}))`;
  await page.waitFor(`!!${find}`, 30_000, `a "${suffix}" button`);
  await page.evaluate(`${find}.setAttribute('data-p3r2', ${JSON.stringify(tag)})`);
  await page.click(`[data-p3r2="${tag}"]`);
}

/** A custom role made in the Roles tab: it lives in this tab's state only (addTenantRole), like the grid. */
async function createCustomRole(page, name) {
  // The Roles tab sits in the Employees tab bar beside the Permissions tab.
  const tab = `[...document.querySelector('[data-p3r2="permissions-tab"]').parentElement.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Roles'))`;
  await page.evaluate(`${tab}.setAttribute('data-p3r2', 'roles-tab')`);
  await page.click('[data-p3r2="roles-tab"]');
  await clickButton(page, 'Create Role', 'create-role-open');
  const input = 'input[placeholder="e.g. Senior Technician"]';
  await page.waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 10_000, 'the Create Role form');
  // The dialog animates in (Employees.tsx: its panel enters from opacity 0, scale 0.9 and 20 px down): a click aimed
  // while it moves can miss the field, so the name never lands and the submit stays disabled (seen once in four SDB-07
  // runs). Click only once that entry is OVER — every ancestor of the field has computed opacity 1 and no transform (none,
  // or the identity matrix) — and check the name landed before looking for the submit.
  const atRest = `(() => {
    const field = document.querySelector(${JSON.stringify(input)});
    if (field === null) return false;
    for (let n = field.parentElement; n !== null; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.opacity !== '1' || (style.transform !== 'none' && style.transform !== 'matrix(1, 0, 0, 1, 0, 0)')) return false;
    }
    return true;
  })()`;
  let polls = 0;
  await page.waitFor(async () => { polls += 1; return (await page.evaluate(atRest)) === true; }, 10_000, 'the Create Role form at rest (its entry motion over)');
  note('Create Role form polls until at rest', polls);
  await page.fill(input, name);
  await page.waitFor(`document.querySelector(${JSON.stringify(input)})?.value === ${JSON.stringify(name)}`, 10_000, 'the role name typed');
  const submit = `[...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.trim() === 'Create Role')`;
  await page.waitFor(`!!${submit}`, 10_000, 'the Create Role submit');
  await page.evaluate(`${submit}.setAttribute('data-p3r2', 'create-role-submit')`);
  await page.click('[data-p3r2="create-role-submit"]');
  await page.waitFor(`!document.querySelector(${JSON.stringify(input)})`, 10_000, 'the Create Role form closed');
}

/** Owner signs in, opens Employees → Permissions, and (when the build has it) waits for the server panel. */
async function ownerPanel(who, page = null) {
  const p = page ?? await openPage();
  await signIn(p, who);
  await openPermissions(p);
  if (await hasPanel(p)) await waitState(p, 'Ready');
  return p;
}

/** Session material never lands where script can read it. */
async function assertNoLeak(page) {
  const seen = await page.evaluate(`JSON.stringify({ cookie: document.cookie, local: Object.values(localStorage).join('\\n'), session: Object.values(sessionStorage).join('\\n'), html: document.documentElement.outerHTML })`);
  const surfaces = JSON.parse(seen);
  assert.ok(!surfaces.cookie.includes('__Host-tmpos_tenant_session'), 'document.cookie does not expose the tenant session cookie');
  for (const secret of st.secrets) {
    for (const [where, text] of Object.entries(surfaces)) assert.ok(!text.includes(secret), `a session secret appears in ${where}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every scenario this file must register, by id: a lost registration (a deleted or mis-merged scenario) fails the run in
 * after(), instead of leaving a smaller run green (M7B-INVOICES-P1). Add an id with its scenario.
 */
const REQUIRED_SCENARIOS = Object.freeze([
  'SRL-W', 'SRL-01', 'SRL-02', 'SRL-03', 'SRL-04', 'SRL-05', 'SRL-06', 'SRL-07', 'SRL-08', 'SRL-08T', 'SRL-09', 'SRL-10',
  'SRL-11', 'SRL-12', 'SRL-13', 'SRL-14', 'SRL-15', 'SRL-16',
  'SCB-01', 'SCB-02', 'SCB-03', 'SCB-04', 'SCB-05', 'SCB-06', 'SCB-07', 'SCB-08', 'SCB-09', 'SCB-10', 'SCB-11', 'SCB-12',
  'SCB-13', 'SCB-14', 'SCB-15', 'SCB-16', 'SCB-17', 'SCB-18',
  'SDB-01', 'SDB-02', 'SDB-03', 'SDB-04', 'SDB-05', 'SDB-06', 'SDB-07', 'SDB-08', 'SDB-09', 'SDB-10',
  'SDB-11', 'SDB-12', 'SDB-13', 'SDB-14', 'SDB-15',
  'SSE-01', 'SSE-02', 'SSE-03', 'SSE-04',
]);
const registered = new Set();
const repeated = [];

function scenario(id, title, fn, timeout = 180_000) {
  if (registered.has(id)) repeated.push(id);
  registered.add(id);
  test(`${id}: ${title}`, { timeout }, async () => {
    st = { id, api: [], idp: [], firestore: [], blocked: [], gates: new Set(), profileGates: new Set(), releases: [], tamper: null, lose: null, pages: [], tabs: [], second: new Set(), secrets: new Set(), notes: {} };
    const s = st;
    const errorsBefore = browser.interceptErrors.length;
    let outcome = 'fail';
    try {
      await fn();
      assert.deepEqual(browser.interceptErrors.slice(errorsBefore), [], 'interception handler errors');
      // Every request to a host this file stands in for was answered; other third-party loads (placeholder avatars) are
      // refused and only recorded.
      const ours = [SHOP_HOST, IDP_HOST, STS_HOST, FS_HOST].map((h) => `//${h}/`);
      assert.deepEqual(s.blocked.filter((b) => ours.some((h) => b.includes(h))).map(redact), [], 'requests the stand-ins did not answer');
      outcome = 'pass';
    } finally {
      s.tamper = null;
      for (const release of s.releases) release();
      evidence.scenarios[id] = {
        title, outcome, notes: s.notes, api: s.api.map(apiLine), idp: s.idp, firestore: s.firestore.length, blocked: s.blocked.map(redact),
        pageLogs: s.pages.flatMap((p) => p.logs).filter((l) => /error|exception|fail/i.test(l)).slice(0, 20).map(redact),
      };
      for (const targetId of s.tabs) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
      for (const page of s.pages) await page.close();
      if (entry === null) await startEntry();
      st = null;
    }
  });
}

before(async () => {
  assert.ok(CHROMIUM, 'Chromium not found: set CHROMIUM_PATH, or provide /repl/tools/bin/chromium or `chromium` on PATH');
  assert.ok(FIRESTORE_MODE, 'INFRASTRUCTURE BLOCKER: no Firestore — run under `firebase emulators:exec --only firestore` (FIRESTORE_EMULATOR_HOST), or set P3R2_FIRESTORE=stub to use the stated stand-in');
  mkdirSync(EVIDENCE, { recursive: true });
  let outDir = PREBUILT;
  if (outDir === null) {
    outDir = mkdtempSync(join(tmpdir(), 'tmpos-shop-build-'));
    const buildStarted = performance.now();
    const built = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: SOURCE,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VITE_ADMIN_CONSOLE_ORIGINS: ADMIN }, // never inherit process.env
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(built.status, 0, redact(`production build failed (${built.error?.message ?? `exit ${built.status}, signal ${built.signal}`}):\n${`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-3000)}`));
    process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
    evidence.buildSeconds = Math.round((performance.now() - buildStarted) / 1000);
    console.log(`SPA build: ${evidence.buildSeconds} s`);
  }
  for (const f of walk(outDir)) files.set(`/${relative(outDir, f).split(sep).join('/')}`, f);
  assert.ok(files.has('/index.html'), 'the build holds index.html');
  await setupDatabase();
  if (FIRESTORE_MODE === 'emulator') await loadEmulatorRules();
  await startEntry();
  entry2 = await listenEntry();
  browser = await launch({ executable: CHROMIUM });
  await browser.intercept(route);
}, { timeout: 900_000 });

after(async () => {
  evidence.logins = loginPeak();
  console.log(`tenant logins: most by one account inside 5 minutes = ${evidence.logins.logins} (${evidence.logins.attempts} attempts by ${evidence.logins.accounts} accounts)`);
  try { writeFileSync(join(EVIDENCE, 'shop-role-levels.json'), `${JSON.stringify(evidence, null, 2)}\n`); } catch { /* evidence is best effort */ }
  await browser?.close().catch((e) => console.warn(redact(`browser teardown: ${e.message}`)));
  await stopEntry();
  await stopped(entry2).catch((e) => console.warn(redact(`second entry teardown: ${e.message}`)));
  entry2 = null;
  await teardownDatabase();
  // Checked here, after the teardown: node runs the first scenario (and with it before()) while later ones still register.
  // The list and the registrations must match exactly: none missing, none unlisted, no id registered twice.
  assert.deepEqual(
    { missing: REQUIRED_SCENARIOS.filter((id) => !registered.has(id)), unlisted: [...registered].filter((id) => !REQUIRED_SCENARIOS.includes(id)), repeated },
    { missing: [], unlisted: [], repeated: [] },
    'the browser scenario inventory',
  );
});

// ---------------------------------------------------------------------------------------------------------------------

scenario('SRL-W', 'ENTRY WITNESS — an owner narrows Sales Associate Create→View in the shop screen: one PUT commits, and the sales_staff session issued before it cannot POST a customer (nothing written) while GET stays 200', async () => {
  const { tenant, boss } = await shop('w');
  const staff = await actor('w-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const page = await ownerPanel(boss);
  const panel = await hasPanel(page);
  note('ui', panel ? 'server panel' : 'entry grid only');
  const before = await counts();
  if (panel) {
    await waitRow(page, 'sales_staff', 'create', 'Default');
    await draft(page, 'sales_staff', 'view');
    note('status', await save(page, 'sales_staff'));
  } else {
    note('grid', await setGridLevel(page, 'Sales Associate', 'Customers', 'view'));
    await delay(2_000); // whatever the page would send, it has sent
  }
  // Everything is observed first, so the entry run records the whole "before" picture, then judged.
  const puts = note('PUT statuses', st.api.filter(isPut).map((r) => r.status));
  const stored = note('stored level', (await levelOf(tenant, 'sales_staff')) ?? 'no row (the default, create)');
  const edit = note('edit delta', await deltaSince(before));
  const mid = await counts();
  const post = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL w ${SUFFIX}` }, key: randomUUID() });
  note('staff POST', post.status);
  const postDelta = note('staff POST delta', await deltaSince(mid));
  const list = await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession });
  note('staff GET', list.status);

  assert.deepEqual(puts, [200], `the shop edit reached the tenant server as one committed PUT (API seen: ${st.api.map(apiLine).join('; ') || 'none'})`);
  assert.equal(stored, 'view', 'the stored Customers level of sales_staff');
  assert.deepEqual(edit, { ...edit, ...EDIT }, `the edit: one audit record and one completion ${JSON.stringify(edit)}`);
  assert.ok(saved(st.notes.status), `the panel says Saved only now: ${st.notes.status}`);
  assert.equal(post.status, 403, `the pre-issued sales_staff session is refused: ${post.text}`);
  assert.deepEqual(postDelta, { ...postDelta, ...REFUSED }, `the refused POST wrote nothing, not even an audit record ${JSON.stringify(postDelta)}`);
  assert.equal(list.status, 200, 'View still reads');
  await assertNoLeak(page);
});

scenario('SRL-01', 'the owner sees the defaults, narrows to View (saved after read-back, enforced, surviving reload and a second browser), None refuses GET and POST, and Create restored lets the refused key create afresh', async () => {
  const { tenant, boss } = await shop('s1');
  const staff = await actor('s1-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const page = await ownerPanel(boss);
  assert.equal((await rowOf(page, 'store_owner'))?.text?.includes('Full — fixed'), true, 'the store owner row is fixed');
  await waitRow(page, 'manager', 'full', 'Default');
  await waitRow(page, 'technician', 'view', 'Default');
  await waitRow(page, 'sales_staff', 'create', 'Default');
  // AM7: an unready Save is disabled and described by a visible hint saying what it is missing.
  assert.equal(await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="server-level-save-sales_staff"]');
    return button.disabled && document.getElementById(button.getAttribute('aria-describedby'))?.textContent.trim();
  })()`), 'To save, choose a new level and enter a reason of 10–500 characters.', 'Save is disabled and says why');
  const created = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 a ${SUFFIX}` }, key: randomUUID() });
  assert.equal(created.status, 201, `the default Create level creates: ${created.text}`);

  let before = await counts();
  await draft(page, 'sales_staff', 'view');
  // The read-back after the PUT is held: while it is, the PUT has committed and the row still does not say "Saved".
  const readBack = gate((r) => isRead(r) && r.frameId === page.frameId && st.api.some(isPut), 'request');
  const from = await clickSave(page, 'sales_staff');
  assert.ok(await Promise.race([readBack.reached, delay(15_000).then(() => null)]), 'a read-back follows the PUT');
  assert.deepEqual(st.api.filter(isPut).map((r) => r.status), [200], 'the PUT committed first');
  await delay(500);
  const whileHeld = note('status while the read-back is held', await statusOf(page, 'sales_staff'));
  assert.ok(!saved(whileHeld), `not "Saved" before the read-back: ${whileHeld}`);
  readBack.release();
  const viewStatus = await settle(page, 'sales_staff', from);
  assert.ok(saved(viewStatus), viewStatus);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  await assertDelta(before, EDIT, 'narrowed to View');
  before = await counts();
  assert.equal((await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 b ${SUFFIX}` }, key: randomUUID() })).status, 403, 'View refuses a create');
  assert.equal((await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession })).status, 200, 'View reads');
  await assertDelta(before, REFUSED, 'View refused the create');

  await page.goto(`${SHOP}/employees`, 30_000); // a reload: the page keeps nothing but the browser's own cookie and sign-in
  await openPermissions(page);
  await waitState(page, 'Ready');
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  const second = await ownerPanel(boss); // a second browser: its own cookie jar and sign-in
  await waitRow(second, 'sales_staff', 'view', 'Custom');

  before = await counts();
  await draft(second, 'sales_staff', 'none');
  assert.ok(saved(await save(second, 'sales_staff')), 'None saved from the second browser');
  await assertDelta(before, EDIT, 'narrowed to None');
  before = await counts();
  const refusedKey = randomUUID();
  assert.equal((await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession })).status, 403, 'None refuses the read');
  assert.equal((await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 c ${SUFFIX}` }, key: refusedKey })).status, 403, 'None refuses the create');
  await assertDelta(before, REFUSED, 'None refused both, holding no lease');

  await draft(second, 'sales_staff', 'create');
  assert.ok(saved(await save(second, 'sales_staff')), 'Create restored');
  before = await counts();
  const again = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 c ${SUFFIX}` }, key: refusedKey });
  assert.equal(again.status, 201, `the refused key creates afresh: ${again.text}`);
  assert.equal(again.headers['idempotent-replayed'], undefined, 'a new command, not a replay');
  await assertDelta(before, { C: 1, A: 1, E: 0, K: 1 }, 'the restored create');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'create');
});

scenario('SRL-02', 'two tenants stay independent; a tenant-A read held past a same-browser switch to tenant B never replaces B\'s panel; B\'s save lands on B alone', async () => {
  const a = await shop('s2a');
  const b = await shop('s2b');
  const direct = await directLogin(a.boss);
  const put = await directSet(direct, 'sales_staff', 'view');
  assert.equal(put.status, 200, put.text);
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  // What this proves is the ABORT path: the switch starts a new generation, which aborts the tenant-A fetch, so Chromium
  // drops the held answer when it is released. The generation check that drops an answer which did arrive late (and the
  // tenant check on reads) is proved at the network boundary in src/tenant/ServerCustomerLevels.test.tsx.
  const held = gate((r) => isRead(r) && r.frameId === page.frameId, 'response');
  await page.evaluate(`dispatchEvent(new Event('focus'))`); // the panel refreshes on focus
  const heldRead = await Promise.race([held.reached, delay(10_000).then(() => null)]);
  assert.ok(heldRead, 'a tenant-A read is in flight and held');
  const tab = await sameContextTab(page);
  await signIn(tab, b.boss); // the same browser signs in as tenant B's owner; the first tab follows the shared sign-in
  await waitRow(page, 'sales_staff', 'create', 'Default');
  held.release();
  await delay(1_500);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  note('held A read', heldRead.status);
  await draft(page, 'sales_staff', 'edit');
  assert.ok(saved(await save(page, 'sales_staff')), 'B saved');
  assert.equal(await levelOf(b.tenant, 'sales_staff'), 'edit', 'B holds its own edit');
  assert.equal(await levelOf(a.tenant, 'sales_staff'), 'view', 'A is untouched');
});

scenario('SRL-03', 'a write with no session, an ended session, a stripped session CSRF, a foreign Origin, a wrong Host, a revoked owner grant, or the tenant server down never shows "Saved" and writes nothing; then the save succeeds', async () => {
  const { tenant, boss } = await shop('s3');
  const page = await ownerPanel(boss);
  await draft(page, 'sales_staff', 'view');
  // [label, tamper, the PUT's status, the row's status line (AM1: a 404 is an answer that decides nothing: the key is
  // held — it may have committed — and the server's level read back; AM6: any 403 other than step_up_required is the
  // owner-only refusal)]
  const cases = [
    ['no session on the write', async (rec, out) => { if (isPut(rec)) delete out.cookie; }, 401, SAY.signedOut],
    ['the session ended in the store', async (rec) => {
      if (!isPut(rec)) return;
      const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = ${boss.uid}`).map((r) => r.session_key);
      if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
      await owner`delete from tmpos_session.session where auth_provider_uid = ${boss.uid}`;
    }, 401, SAY.signedOut],
    ['the session CSRF stripped', async (rec, out) => { if (isPut(rec)) delete out[SESSION_CSRF_HEADER]; }, 403, SAY.refused],
    ['a foreign Origin', async (rec, out) => { if (isPut(rec)) out.origin = ADMIN; }, 403, SAY.refused],
    ['a wrong Host', async (rec, out) => { if (isPut(rec)) out.host = 'admin.tmpos.test'; }, 404, SAY.notConfirmed('create')],
  ];
  for (const [label, tamper, expected, says] of cases) {
    const before = await counts();
    const from = st.api.length;
    st.tamper = tamper;
    const status = await save(page, 'sales_staff');
    st.tamper = null;
    note(label, status);
    assert.equal(status, says, label);
    assert.deepEqual(st.api.slice(from).filter(isPut).map((r) => r.status), [expected], `${label}: ${st.api.slice(from).map(apiLine).join('; ')}`);
    await assertDelta(before, NOTHING, label);
    assert.equal(await levelOf(tenant, 'sales_staff'), undefined, `${label}: nothing stored`);
    if (label === 'the session ended in the store') {
      // M7A-CUSTOMERS-P6: the session this page confirmed is gone, and no save signs in on its own — the owner presses
      // Reconnect: exactly one login, and the panel is ready again with the draft kept.
      const reconnect = st.api.length;
      await page.click('[data-testid="server-levels-retry"]');
      await page.waitFor(`!document.querySelector('[data-testid="server-levels-retry"]') && document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === 'Ready'`, 30_000, 'the panel reconnected');
      assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
    }
  }
  // The 404 left the key HELD (it may have committed), so the next two saves re-send that key: a refusal of it, or a
  // save that never reaches the server, does not say what it did — "Not confirmed yet", never "Not saved" (R2-2).
  // M7A-CUSTOMERS-P6: revoking the grant ends the owner's session in the store, and Save no longer signs in on its own:
  // the held key is NOT re-sent (no login, no PUT) and the row says "Not confirmed yet", with Reconnect offered.
  {
    const before = await counts();
    await owner`update user_membership set role_id = 'technician' where internal_user_id = ${boss.id}`;
    const from = st.api.length;
    const status = await save(page, 'sales_staff');
    await owner`update user_membership set role_id = 'store_owner' where internal_user_id = ${boss.id}`;
    note('the owner grant revoked', status);
    assert.equal(status, SAY.confirmEnded);
    assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'the save sent no login and no PUT');
    await assertDelta(before, NOTHING, 'the owner grant revoked');
    // The grant back, Reconnect logs in exactly once; the draft and the held key are kept for the read that follows.
    const reconnect = st.api.length;
    await page.click('[data-testid="server-levels-retry"]');
    await page.waitFor(`!document.querySelector('[data-testid="server-levels-retry"]') && document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === 'Ready'`, 30_000, 'the panel reconnected');
    assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
    // A refusal of the held key (here a foreign Origin, 403) does not say what the key did: "Not confirmed yet" (R2-2).
    const refused = st.api.length;
    st.tamper = async (rec, out) => { if (isPut(rec)) out.origin = ADMIN; };
    const again = await save(page, 'sales_staff');
    st.tamper = null;
    note('the held key refused', again);
    assert.equal(again, SAY.confirmDenied);
    assert.deepEqual(st.api.slice(refused).filter(isPut).map((r) => r.status), [403], 'the server refused the held key\'s PUT');
    await assertDelta(before, NOTHING, 'the held key refused');
  }
  {
    const before = await counts();
    await stopEntry();
    // AM3: a focus refresh that cannot reach the server keeps the panel ready, its rows in place, and says so.
    await page.evaluate(`dispatchEvent(new Event('focus'))`);
    await page.waitFor(`document.querySelector('[data-testid="server-customer-levels"] [role="status"]')?.textContent.trim() === ${JSON.stringify(REFRESH_FAILED)}`, 20_000, 'the refresh-failed note');
    assert.equal(await panelState(page), 'Ready', 'a failed refresh keeps the panel ready');
    assert.equal((await rowOf(page, 'sales_staff'))?.level, LABELS.create, 'and its rows');
    const from = st.api.length;
    const status = await save(page, 'sales_staff');
    await startEntry();
    note('the tenant server down', status);
    assert.equal(status, SAY.confirmUnreachable);
    assert.deepEqual(st.api.slice(from).map((r) => r.status), [502], 'the one request made was answered by the front alone');
    await assertDelta(before, NOTHING, 'the tenant server down');
  }
  const before = await counts();
  const status = await save(page, 'sales_staff');
  note('recovered', status);
  assert.ok(saved(status), status);
  await assertDelta(before, EDIT, 'the save after every failure');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view');
  // M7A-CUSTOMERS-P6: a Reconnect pressed while the grant is revoked logs in once and shows what that account may see —
  // the owner-only Denied state, no save control — and writes nothing.
  {
    await draft(page, 'sales_staff', 'create');
    const revoked = await counts();
    await owner`update user_membership set role_id = 'technician' where internal_user_id = ${boss.id}`;
    try {
      const from = st.api.length;
      const ended = await save(page, 'sales_staff');
      note('revoked, then saved', ended);
      assert.equal(ended, SAY.signedOut);
      assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'the save sent no login and no PUT');
      const reconnect = st.api.length;
      await page.click('[data-testid="server-levels-retry"]');
      await waitState(page, 'Denied');
      assert.deepEqual(st.api.slice(reconnect).filter((r) => r.path === LOGIN).map(answered), ['200'], 'the Reconnect: exactly one login');
      assert.deepEqual(st.api.slice(reconnect).filter(isPut).map(apiLine), [], 'the Reconnect sent no PUT');
      assert.match(await page.evaluate(`document.querySelector('[data-testid="server-customer-levels"]').textContent`), /only be viewed and changed by the store owner/);
      assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control for a revoked owner');
      await assertDelta(revoked, NOTHING, 'the Reconnect while revoked');
      assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'nothing stored');
    } finally {
      await owner`update user_membership set role_id = 'store_owner' where internal_user_id = ${boss.id}`;
    }
  }
});

scenario('SRL-04', 'a stale sign-in is refused with step_up_required and nothing written; the owner re-authenticates in the page, and only the next save lands', async () => {
  const { tenant, boss } = await shop('s4');
  ACCOUNTS.get(boss.email).staleOnce = true;
  const page = await ownerPanel(boss);
  const before = await counts();
  await draft(page, 'sales_staff', 'view');
  const first = await save(page, 'sales_staff');
  note('stale', first);
  assert.equal(first, SAY.stepUp);
  assert.deepEqual(st.api.filter(isPut).map((r) => `${r.status} ${r.error}`), ['403 step_up_required']);
  await assertDelta(before, NOTHING, 'the stale sign-in');
  await page.waitFor(`!!document.querySelector('[data-testid="server-level-reauth-password"]')`, 10_000, 'the password prompt');
  // AM7: the prompt is a group named by its title, its password field takes focus, and Confirm says what it is missing.
  assert.equal((await page.axNodes({ role: 'group', name: 'Confirm your sign-in to save this change' })).length, 1, 'the prompt is a labelled group');
  await page.waitFor(`document.activeElement?.dataset.testid === 'server-level-reauth-password'`, 5_000, 'the password field has focus');
  assert.equal(await page.evaluate(`(() => {
    const confirm = document.querySelector('[data-testid="server-level-reauth-confirm"]');
    return confirm.disabled && document.getElementById(confirm.getAttribute('aria-describedby'))?.textContent.trim();
  })()`), 'Enter your password to confirm your sign-in.', 'Confirm is disabled and described by what it needs');
  await page.fill('[data-testid="server-level-reauth-password"]', boss.password);
  await page.click('[data-testid="server-level-reauth-confirm"]');
  await page.waitFor(async () => (await statusOf(page, 'sales_staff')) === SAY.signedInAgain, 20_000, 'the re-authentication');
  assert.ok(st.api.some((r) => r.method === 'POST' && r.path === LOGIN && r.headers['x-tmpos-reauthenticate'] === '1' && r.status === 200), 'the session was renewed with the fresh sign-in');
  const second = await save(page, 'sales_staff');
  note('after re-authentication', second);
  assert.ok(saved(second), second);
  await assertDelta(before, EDIT, 'the one save');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view');
});

scenario('SRL-05', 'a failed identity verifier leaves the panel unavailable with no levels and no save until it recovers', async () => {
  const { boss } = await shop('s5');
  idp.verifierDown = true;
  const page = await openPage();
  try {
    await signIn(page, boss);
    await openPermissions(page);
    await waitState(page, 'Unavailable');
  } finally {
    idp.verifierDown = false;
  }
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control while unavailable');
  assert.deepEqual(st.api.filter((r) => r.path === LOGIN).map((r) => r.status), [503], 'the login was an outage, not a verdict');
  assert.equal(st.api.filter(isPut).length, 0);
  await page.click('[data-testid="server-levels-retry"]');
  await waitState(page, 'Ready');
});

scenario('SRL-06', 'a manager sees the panel denied, and the server refuses the manager\'s direct reads and PUTs, the self-grant included', async () => {
  const { tenant } = await shop('s6');
  const manager = await actor('s6-manager', [grant(tenant, 'manager')], { role: 'manager' });
  const page = await openPage();
  await signIn(page, manager);
  await openPermissions(page);
  await waitState(page, 'Denied');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control for a manager');
  assert.match(await page.evaluate(`document.querySelector('[data-testid="server-customer-levels"]').textContent`), /only be viewed and changed by the store owner/);
  const direct = await directLogin(manager);
  const before = await counts();
  const read = await call('GET', ROLE_LEVELS, { session: direct });
  // Well-formed bodies (the manager's own tenant and version 0 asserted), so the owner rule is what refuses them.
  const put = (roleId, domain, level, extra = {}) => call('PUT', ROLE_LEVELS, {
    session: direct, body: { roleId, domain, level, reason: REASON, expectedTenant: tenant, expectedVersion: 0, ...extra }, key: randomUUID(),
  });
  const narrow = await put('sales_staff', 'customers', 'view');
  const self = await put('manager', 'customers', 'full');
  // The self-grant in other shapes: another domain (where manage_role_permissions would live), Manage, and an extra
  // field naming the grant. Whether the body rule (400) or the owner rule (403) answers first, none may write.
  const variants = {
    'another domain': await put('manager', 'employees', 'full'),
    'Manage for manager': await put('manager', 'customers', 'manage'),
    'an extra field': await put('manager', 'customers', 'full', { permission: 'manage_role_permissions' }),
  };
  note('manager direct', { read: read.status, narrow: narrow.status, self: self.status, ...Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.status])) });
  assert.deepEqual([read.status, narrow.status, self.status], [403, 403, 403]);
  for (const [label, res] of Object.entries(variants)) assert.ok([400, 403].includes(res.status), `${label}: ${res.status} ${res.text}`);
  await assertDelta(before, REFUSED, 'the manager wrote nothing, not even an audit record');
  assert.equal(await levelOf(tenant, 'sales_staff'), undefined);
  assert.equal(await levelOf(tenant, 'manager'), undefined);
  assert.equal((await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${tenant}`)[0].n, 0, 'no row of any role or domain');
});

scenario('SRL-07', 'the local grid is labelled local-only; a grid change — a built-in role\'s Customers cell or a custom role\'s — sends nothing to any server and moves no server level; there is no global Save', async () => {
  const { tenant, boss } = await shop('s7');
  const page = await ownerPanel(boss);
  const banner = await page.evaluate(`document.querySelector('[data-testid="local-only-banner"]')?.textContent ?? null`);
  note('banner', banner);
  assert.match(banner ?? '', /not saved to the server/i, 'the grid says it is local-only');
  const customersCell = await page.evaluate(`[...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim().startsWith('Customers'))?.querySelector('td')?.textContent ?? null`);
  note('Customers row', customersCell);
  assert.match(customersCell ?? '', /Built-in roles: set in Server-enforced Customers access above/, 'the grid\'s Customers row points to the server panel');
  const from = st.api.length;
  const fsFrom = st.firestore.length;
  const before = await counts();
  // A custom role exists in this tab only; its Customers control is the grid's, and stays there.
  const custom = `M7SRL Local ${SUFFIX}`;
  await createCustomRole(page, custom);
  await openPermissions(page);
  await waitState(page, 'Ready');
  assert.equal(await setGridLevel(page, 'Technician', 'Inventory', 'none'), 'none');
  assert.equal(await setGridLevel(page, 'Sales Associate', 'Customers', 'view'), 'view', 'a built-in role\'s Customers cell in the grid');
  assert.equal(await setGridLevel(page, custom, 'Customers', 'view'), 'view', 'the custom role\'s Customers cell');
  await delay(1_500);
  // A panel refresh (GET) may happen on focus; a write never may — not to the tenant server, not to Firestore.
  assert.deepEqual(st.api.slice(from).filter((r) => r.method !== 'GET').map(apiLine), [], 'a grid change sends nothing');
  assert.deepEqual(st.firestore.slice(fsFrom).filter((f) => f.includes('/Write/')), [], 'nor writes to Firestore');
  await assertDelta(before, REFUSED, 'the grid changes');
  assert.equal(await levelOf(tenant, 'sales_staff'), undefined, 'the server level of sales_staff did not move');
  assert.deepEqual(await rowOf(page, 'sales_staff'), { level: LABELS.create, badge: 'Default', known: true }, 'the server panel still shows the server\'s level');
  const rows = await page.evaluate(`[...document.querySelectorAll('[data-testid^="server-level-row-"]')].map((r) => r.dataset.testid.slice('server-level-row-'.length))`);
  assert.deepEqual(rows, ['store_owner', 'manager', 'technician', 'sales_staff'], 'the server panel lists the built-in roles only, never the custom role');
  const saves = await page.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /save/i.test(t))`);
  note('save buttons', saves);
  assert.ok(saves.every((t) => t === 'Save to server'), `the only save controls are the per-role server saves: ${saves.join(', ')}`);
});

/**
 * Two editors read one role at the same version (Create, the default: version 0). `one` narrows it to View; `two`'s older,
 * permissive draft (Edit) is then refused by the version precondition — nothing written, no edit audit, View and its
 * authority stand — and shown as a conflict; only an explicit Reapply and a new Save (the new version, a new key) land it.
 * `two` is on the second tenant entry; a sales_staff session's create and read answer every committed level.
 */
async function staleDraftRefused(tenant, one, two, staffSession, where) {
  await waitRow(one, 'sales_staff', 'create', 'Default');
  await waitRow(two, 'sales_staff', 'create', 'Default');
  await assertAuthority(staffSession, 'create', 'the default');
  await draft(one, 'sales_staff', 'view');
  let before = await counts();
  const first = note(`first ${where}`, await save(one, 'sales_staff'));
  assert.ok(saved(first), first);
  await assertDelta(before, EDIT, `the first ${where}'s View`);
  await assertAuthority(staffSession, 'view', `the first ${where}'s View`);

  await draft(two, 'sales_staff', 'edit'); // against what `two` read: Create at version 0
  before = await counts();
  const stale = note(`second ${where}`, await save(two, 'sales_staff'));
  assert.equal(stale, SAY.lostRace('view'), `the stale ${where} is a conflict, never "Saved"`);
  await assertDelta(before, { ...REFUSED, L: 1 }, `the stale ${where}'s save wrote nothing but its lease`);
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view', 'View stands: the older draft restored nothing');
  const puts = st.api.filter(isPut);
  assert.deepEqual(puts.map((r) => `entry${r.via} ${answered(r)}`), ['entry1 200', 'entry2 409 write_conflict'], `the stale save was refused on the other entry: ${st.api.map(apiLine).join('; ')}`);
  const staleBody = JSON.parse(puts[1].body);
  assert.deepEqual([staleBody.level, staleBody.expectedTenant, staleBody.expectedVersion], ['edit', tenant, 0], 'it asserted the version it was drafted at');
  await assertAuthority(staffSession, 'view', `View after the stale ${where}`);
  // The conflict: the server's level and the unsaved choice; Save stays off until Discard or Reapply.
  await waitRow(two, 'sales_staff', 'view', 'Custom');
  assert.equal(await conflictOf(two, 'sales_staff'), 'The server now has View Only. Your unsaved choice: Edit.');
  assert.equal(await saveEnabled(two, 'sales_staff'), false, 'no Save while the conflict stands');
  assert.equal(await two.evaluate(`!!document.querySelector('[data-testid="server-level-discard-sales_staff"]')`), true, 'Discard is offered');

  await two.click('[data-testid="server-level-reapply-sales_staff"]');
  await two.waitFor(async () => (await statusOf(two, 'sales_staff')) === SAY.reapplied, 10_000, 'the draft reapplied to the version just read');
  assert.equal(await conflictOf(two, 'sales_staff'), null, 'the conflict is resolved by the choice');
  assert.equal(st.api.filter(isPut).length, 2, 'Reapply sends nothing');
  before = await counts();
  const again = note(`second ${where} after Reapply`, await save(two, 'sales_staff'));
  assert.ok(saved(again), again);
  await assertDelta(before, EDIT, `the deliberate save after Reapply`);
  const last = st.api.filter(isPut).at(-1);
  assert.equal(answered(last), '200');
  assert.equal(JSON.parse(last.body).expectedVersion, 1, 'asserting the version it was reapplied to');
  assert.notEqual(last.headers['idempotency-key'], puts[1].headers['idempotency-key'], 'under a new key');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'edit');
  await assertAuthority(staffSession, 'edit', `the second ${where}'s Edit`);
}

scenario('SRL-08', 'two browsers on two tenant entries read one role at one version: the first narrows it; the second\'s older, permissive draft is refused (409, nothing written, View and its authority stand) and shown as a conflict; Reapply and a new Save land it; the first browser\'s "Saved" then says "Changed elsewhere"', async () => {
  const { tenant, boss } = await shop('s8');
  const staff = await actor('s8-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = await ownerPanel(boss, viaSecond(await openPage()));
  await staleDraftRefused(tenant, one, two, staffSession, 'browser');
  // AM2: the second browser's save — seen by the first browser's next refresh — ends the first one's "Saved".
  await one.evaluate(`dispatchEvent(new Event('focus'))`);
  await one.waitFor(async () => (await statusOf(one, 'sales_staff')) === SAY.changedElsewhere('edit'), 20_000, 'the former "Saved" says the level changed elsewhere');
  await waitRow(one, 'sales_staff', 'edit', 'Custom');
});

scenario('SRL-08T', 'two TABS of one browser (one cookie jar, one sign-in), each on its own tenant entry: the stale tab\'s older draft is refused and shown as a conflict, and only Reapply and a new Save land it', async () => {
  const { tenant, boss } = await shop('s8t');
  const staff = await actor('s8t-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = viaSecond(await sameContextTab(one));
  await two.goto(`${SHOP}/employees`, 30_000); // signed in already: the tabs share the browser's persisted sign-in
  await openPermissions(two);
  await waitState(two, 'Ready');
  await staleDraftRefused(tenant, one, two, staffSession, 'tab');
});

scenario('SRL-10', 'TENANT SWITCH BEFORE THE SAVE — a draft made in tenant A, saved after the same owner\'s session moved to tenant B, writes nothing in A or B (no level, version, edit audit or completion); the shop says the store changed and the change was not saved', async () => {
  const a = await shop('s10a');
  const b = await newTenant('s10b');
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await draft(page, 'sales_staff', 'view');
  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page holds a tenant-A session');
  await moveOwner(a.boss, a.tenant, b);
  assert.equal((await readWith(aLogin.cookie)).status, 401, 'the switch ended the tenant-A session');
  const was = { a: await tenantState(a.tenant), b: await tenantState(b) };
  const before = await counts();
  // M7A-CUSTOMERS-P6: the move ended the session this page confirmed, so the save signs nothing in and sends nothing.
  const from = st.api.length;
  const first = await save(page, 'sales_staff');
  note('the save after the switch', first);
  assert.equal(first, SAY.signedOut, 'the save found the session ended');
  assert.deepEqual(st.api.slice(from).filter((r) => isPut(r) || r.path === LOGIN).map(apiLine), [], 'no login and no PUT left the page');
  // Reconnect: one login — now scoped to B — whose read names another store: the draft is cleared, the store-changed notice shown.
  const reconnect = st.api.length;
  await page.click('[data-testid="server-levels-retry"]');
  await page.waitFor(async () => (await noticesOf(page)).changed === STORE_CHANGED, 30_000, 'the store-changed notice');
  await waitState(page, 'Ready');
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 10_000, 'every request answered');
  const sent = note('requests', st.api.slice(from).map(apiLine));
  assert.deepEqual(st.api.slice(from).filter(isPut).map(answered), [], `no PUT at all, to either store: ${sent.join('; ')}`);
  assert.deepEqual((await noticesOf(page)).previous, [], 'no change was sent, so there is no previous-store notice');
  assert.equal(st.api.slice(reconnect).filter(acceptedLogin(a.boss)).length, 1, 'exactly one login: the Reconnect (scoped to B)');
  assert.deepEqual(st.api.slice(from, reconnect).filter(acceptedLogin(a.boss)), [], 'none before it');
  await assertDelta(before, NOTHING, 'the A draft after the switch: nothing written (T: the Reconnect\'s login)');
  assert.deepEqual({ a: await tenantState(a.tenant), b: await tenantState(b) }, was, 'neither A nor B changed: no level, version or edit audit');
  assert.equal(await statusOf(page, 'sales_staff'), '', 'B\'s row says nothing of A\'s draft');
  assert.equal(await hasDraft(page, 'sales_staff'), false, 'no draft survives the switch');
  await assertNoLeak(page);
});

scenario('SRL-11', 'IN FLIGHT ACROSS A SWITCH — a save parked INSIDE the database (its role row held FOR UPDATE by a side transaction) while the same owner\'s session moves to B: B is untouched, A holds whatever the server decided, and the panel (now B\'s) reports it only as a detached notice, never as B\'s save', async () => {
  const a = await shop('s11a');
  const b = await newTenant('s11b');
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  await draft(page, 'sales_staff', 'view');
  // The row the PUT locks (set_v2 step 8), made now so it can be held: 020's NULL lock row — still the catalog default at
  // version 0, so the draft read before it stays current.
  await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (${a.tenant}, 'sales_staff', 'customers', null, now()) on conflict do nothing`;
  const wasA = await tenantState(a.tenant);
  const wasB = await tenantState(b);
  const before = await counts();
  // LOCK ORDERING (why this cannot deadlock). The side transaction holds ONLY A's sales_staff role row and waits on
  // nothing. set_v2 takes the standing hold (016), the session and mint rows and the issuer FOR SHARE and checks the
  // grant BEFORE step 8, then waits on that row. The switch — moveOwner's grant swap (015's standing-serialize triggers)
  // and the other tab's login (its establish takes the standing hold; it may replace the shared cookie's session row) —
  // can wait only on what set_v2 holds, never on the side transaction: a chain (switch → set_v2 → side), no cycle. So the
  // switch is never awaited while parked: it runs alongside, and the park is released once the switch has either
  // finished or is itself waiting on the parked PUT. set_v2 then finishes and commits; its answer is held at the front
  // until the switch has finished, so the page's read-back runs on the B session. Should the database still find a
  // cycle, it aborts one side and a bounded wait below fails the case — it never hangs. The owner pool (3) covers the
  // side transaction, the grant swap and the polling at once.
  let unpark;
  const parkedUntil = new Promise((r) => { unpark = r; });
  st.releases.push(unpark);
  let holds;
  const holding = new Promise((r) => { holds = r; });
  const side = owner.begin(async (tx) => {
    const [{ pid }] = await tx`select pg_catalog.pg_backend_pid() as pid`;
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${a.tenant} and role_id = 'sales_staff' and domain = 'customers' for update`;
    holds(pid);
    await Promise.race([parkedUntil, delay(90_000)]); // a bound, never a result
  });
  const sidePid = await Promise.race([holding, side.then(() => { throw new Error('the side transaction ended before it held the row'); })]);
  const answer = gate((r) => isPut(r) && r.frameId === page.frameId, 'response');
  // Every status line the page renders from here on, recorded in the page as it changes (a node's old text included), so
  // a transient "Saved" cannot slip between two polls.
  await page.evaluate(`(() => {
    const lines = window.__srlStatusLines = [];
    const isStatus = (node) => node?.closest?.('[data-testid^="server-level-status-"]') ?? node?.parentElement?.closest('[data-testid^="server-level-status-"]');
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData' && isStatus(r.target) && r.oldValue) lines.push(r.oldValue.trim());
        if (r.type === 'childList' && isStatus(r.target)) for (const gone of r.removedNodes) lines.push((gone.textContent ?? '').trim());
      }
      for (const el of document.querySelectorAll('[data-testid^="server-level-status-"]')) lines.push(el.textContent.trim());
    }).observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true });
  })()`);
  const from = await clickSave(page, 'sales_staff');
  const parked = await until(async () => (await blockedBy(sidePid)).find((r) => r.usename === RUNTIME_LOGIN), 20_000, 'the PUT waiting on the held role row');
  note('parked', { wait: parked.wait_event_type, query: parked.query });
  assert.match(parked.query, /m7a_role_level_set_v2|<insufficient privilege>/, 'the waiting statement is the versioned edit');
  assert.equal(st.api.slice(from).filter(isPut).length, 1, 'one PUT, in the database');
  // The switch while parked: the grant moves, and another tab of this browser signs the same account in again (on the
  // second entry), so the shared cookie jar will hold the B session.
  let switched = false;
  const switching = (async () => {
    await moveOwner(a.boss, a.tenant, b);
    const tab = viaSecond(await sameContextTab(page));
    await tab.goto(`${SHOP}/employees`, 30_000);
    await openPermissions(tab);
    await waitState(tab, 'Ready', 60_000);
  })().finally(() => { switched = true; });
  switching.catch(() => {}); // awaited below; a failure there fails the case
  const waitingOnPark = async () => [...await blockedBy(parked.pid), ...(await blockedBy(sidePid)).filter((r) => r.pid !== parked.pid)];
  const during = await until(async () => (switched ? 'finished while parked' : (await waitingOnPark()).length > 0 ? 'waiting on the parked PUT' : null), 60_000, 'the switch finished or waits on the parked PUT');
  note('the switch while the PUT was parked', during);
  unpark(); // commit the side transaction (it wrote nothing): set_v2 goes on
  await side;
  const put = await Promise.race([answer.reached, delay(30_000).then(() => null)]);
  assert.ok(put, 'the PUT was answered once released; its answer is held at the front');
  await Promise.race([switching, delay(90_000).then(() => { throw new Error('the switch did not finish after the release'); })]);
  const decided = note('the server decided', answered(put));
  answer.release();
  // The page's outcome. A refusal of this first attempt (400/401/403/413/422) reads nothing back: the row's own
  // "Not saved" line. Every other answer is read back on the B session, so it surfaces only as a detached notice: a 200
  // as the acknowledgement, a write_conflict as not saved, anything undecided (a 5xx, a 409 in progress, a body the
  // page cannot name) as unconfirmed.
  const refusal = /^(400|401|403|413|422)\b/.test(decided);
  const notice = decided === '200' ? PREVIOUS_STORE.acknowledged
    : decided === '409 write_conflict' ? PREVIOUS_STORE.notSaved : PREVIOUS_STORE.unconfirmed;
  await page.waitFor(async () => {
    const n = await noticesOf(page);
    return refusal ? /^Not saved/.test((await statusOf(page, 'sales_staff')) ?? '') : n.changed === STORE_CHANGED && n.previous.length > 0;
  }, 30_000, 'the A outcome surfaced');
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 10_000, 'every request answered');
  note('requests', st.api.map(apiLine));
  const lines = note('status lines seen', [...new Set(await page.evaluate('window.__srlStatusLines'))]);
  assert.ok(!lines.some((t) => /^Saved\b/.test(t)), `the page never said Saved: ${lines.join(' | ')}`);
  if (!refusal) assert.deepEqual((await noticesOf(page)).previous, [notice], `the A answer (${decided}), only as a detached notice`);
  assert.deepEqual(st.api.filter(isPut).map(answered), [decided], 'one PUT: nothing was retried or sent to B');
  assert.deepEqual(await tenantState(b), wasB, 'B is untouched: no level, version or edit audit');
  if (decided === '200') {
    await waitState(page, 'Ready');
    await waitRow(page, 'sales_staff', 'create', 'Default'); // B's level: never A's save
    assert.equal(await statusOf(page, 'sales_staff'), '', 'B\'s row says nothing of A\'s save');
    assert.equal(await hasDraft(page, 'sales_staff'), false);
    await assertDelta(before, { C: 0, A: 0, E: 1, K: 1, L: 1 }, 'the one edit (T: the other tab\'s login)');
    assert.deepEqual(await tenantState(a.tenant), { edits: wasA.edits + 1, levels: { sales_staff: 'view' }, versions: { sales_staff: 1 } }, 'A holds the edit');
  } else {
    await assertDelta(before, { C: 0, A: 0, E: 0, K: 0 }, `refused (${decided}): no edit`);
    assert.deepEqual(await tenantState(a.tenant), wasA, `refused (${decided}): A unchanged`);
  }
});

scenario('SRL-12', 'RESET TO THE DEFAULT, THEN AN OLDER DRAFT — View, then Create restored (the default level at a newer version): a draft made at the first version is refused though the level it saw is back; Discard drops it; authority follows each committed level', async () => {
  const { tenant, boss } = await shop('s12');
  const staff = await actor('s12-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const one = await ownerPanel(boss);
  const two = await ownerPanel(boss, viaSecond(await openPage()));
  await waitRow(two, 'sales_staff', 'create', 'Default');
  await assertAuthority(staffSession, 'create', 'the default');
  await draft(two, 'sales_staff', 'edit'); // against version 0
  for (const level of ['view', 'create']) {
    await draft(one, 'sales_staff', level);
    const status = note(`first browser ${level}`, await save(one, 'sales_staff'));
    assert.ok(saved(status), status);
    await assertAuthority(staffSession, level, `after ${level}`);
  }
  await waitRow(one, 'sales_staff', 'create', 'Custom');
  assert.deepEqual(await tenantState(tenant), { edits: 2, levels: { sales_staff: 'create' }, versions: { sales_staff: 2 } }, 'Create restored at version 2');
  assert.deepEqual(await rowOf(two, 'sales_staff'), { level: LABELS.create, badge: 'Default', known: true }, 'the older browser still shows the level it read');
  const before = await counts();
  const stale = note('older draft', await save(two, 'sales_staff'));
  assert.equal(stale, SAY.lostRace('create'), 'refused, though the level it read is back');
  await assertDelta(before, { ...REFUSED, L: 1 }, 'the older draft wrote nothing but its lease');
  const last = st.api.filter(isPut).at(-1);
  assert.equal(`entry${last.via} ${answered(last)}`, 'entry2 409 write_conflict');
  assert.equal(JSON.parse(last.body).expectedVersion, 0);
  assert.deepEqual(await tenantState(tenant), { edits: 2, levels: { sales_staff: 'create' }, versions: { sales_staff: 2 } }, 'unchanged');
  await assertAuthority(staffSession, 'create', 'after the refused older draft');
  assert.equal(await conflictOf(two, 'sales_staff'), 'The server now has Create. Your unsaved choice: Edit.');
  await two.click('[data-testid="server-level-discard-sales_staff"]');
  await two.waitFor(async () => (await conflictOf(two, 'sales_staff')) === null && !(await hasDraft(two, 'sales_staff')), 10_000, 'Discard dropped the draft');
  assert.equal(await statusOf(two, 'sales_staff'), '');
  await waitRow(two, 'sales_staff', 'create', 'Custom');
  assert.equal(await saveEnabled(two, 'sales_staff'), false, 'nothing left to save');
  assert.equal(st.api.filter(isPut).length, 3, 'Discard sends nothing');
});

scenario('SRL-09', 'a user switch in one browser ends the previous user\'s tenant session before the next user\'s login leaves the page, and signing out ends the next one\'s (AM4)', async () => {
  const a = await shop('s9a');
  const b = await shop('s9b');
  // The two stores' panels differ: A's sales_staff is stored View, B's is the default Create.
  const direct = await directLogin(a.boss);
  const put = await directSet(direct, 'sales_staff', 'view');
  assert.equal(put.status, 200, put.text);
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page established A\'s tenant session');
  assert.equal((await readWith(aLogin.cookie)).status, 200, 'A\'s cookie reads while A is signed in');

  // The switch: a second tab of the same browser signs in as B, and the first tab follows the shared sign-in. B's login is
  // held at the front while A's old cookie is tried from outside: it must already be dead.
  const from = st.api.length;
  const held = gate((r) => r.method === 'POST' && r.path === LOGIN && bearerUid(r) === b.boss.uid, 'request');
  const tab = await sameContextTab(page);
  await signIn(tab, b.boss);
  const heldLogin = await Promise.race([held.reached, delay(30_000).then(() => null)]);
  assert.ok(heldLogin, 'the page logs in as B');
  const probe = await readWith(aLogin.cookie);
  note('A\'s cookie while B\'s login is held', probe.status);
  held.release();
  assert.equal(probe.status, 401, `A's session was over before B's login left the page: ${probe.text}`);
  const endedA = st.api.slice(from).filter((r) => isLogout(r) && r.status === 204 && (r.headers.cookie ?? '').includes(aLogin.cookie));
  assert.ok(endedA.length >= 1, `a logout carrying A's cookie ended it: ${st.api.slice(from).map(apiLine).join('; ')}`);
  note('A\'s logout answered before B\'s login was sent (ms)', Math.round(heldLogin.at - endedA[0].doneAt));
  await waitRow(page, 'sales_staff', 'create', 'Default'); // the first tab now shows B's store
  await waitState(page, 'Ready');
  note('switch', st.api.slice(from).map(apiLine));
  const bLogin = st.api.filter(acceptedLogin(b.boss)).at(-1);
  assert.ok(bLogin, 'B\'s login was accepted');
  const bRead = await readWith(bLogin.cookie);
  assert.equal(bRead.status, 200, `B's session stands: no late logout ended it: ${bRead.text}`);
  assert.equal(JSON.parse(bRead.text).tenant, b.tenant, 'and it is B\'s store');

  // Sign-out: the persisted sign-in cleared, exactly what a sign-out in another tab leaves behind (every tab's Firebase
  // SDK notices on its next poll). Every tab is now signed out, and B's tenant session must end with it.
  const out = st.api.length;
  await page.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('firebaseLocalStorageDb');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').clear();
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await page.waitFor(async () => (await readWith(bLogin.cookie)).status === 401, 20_000, 'B\'s session ended by the sign-out');
  note('sign-out', st.api.slice(out).map(apiLine));
  assert.ok(st.api.slice(out).some((r) => isLogout(r) && r.status === 204 && (r.headers.cookie ?? '').includes(bLogin.cookie)), 'a logout carrying B\'s cookie ended it');
  assert.equal(await page.evaluate(`fetch('/api/v1/session', { credentials: 'include', cache: 'no-store' }).then((r) => r.status)`), 401, 'the browser holds no tenant session');
  assert.deepEqual(st.api.slice(out).filter((r) => r.path === LOGIN).map(apiLine), [], 'nobody signed back in');
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P5 — the Customer directory page, by the test ids of the stage design (section 10)
// ---------------------------------------------------------------------------------------------------------------------

const DIRECTORY = '/customers/directory';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One create: its customer, its audit record, its sealed completion, its one idempotency record, no role edit. */
const CREATED = Object.freeze({ C: 1, A: 1, E: 0, K: 1, L: 1 });
/** One customer edit: no new customer, its update audit, its sealed completion, its one idempotency record. */
const UPDATED = Object.freeze({ C: 0, A: 0, E: 0, U: 1, K: 1, L: 1 });
/** A stale edit (409 write_conflict): only its own sealed completion — no customer change, no audit. */
const CONFLICTED = Object.freeze({ C: 0, A: 0, E: 0, U: 0, K: 1, L: 1 });
const by = (id) => `[data-testid="${id}"]`;
const q = (id) => `document.querySelector(${JSON.stringify(by(id))})`;
const has = (page, id) => page.evaluate(`!!${q(id)}`);
const textOf = (page, id) => page.evaluate(`${q(id)}?.textContent.trim() ?? null`);
/** A control that is there and enabled. */
const offered = (page, id) => page.evaluate(`${q(id)} !== null && ${q(id)}.disabled !== true`);
const waitData = (page, id, key, value, timeout = 30_000) =>
  page.waitFor(`${q(id)}?.dataset.${key} === ${JSON.stringify(value)}`, timeout, `${id} has data-${key}="${value}"`);
const waitList = (page, phase = 'ready') => waitData(page, 'directory-state', 'phase', phase);
/** The rows the list shows, in the order shown: [{ id, name }]. */
const rowsOf = (page) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by('directory-row'))})].map((li) => ({ id: li.dataset.id ?? null, name: li.querySelector('a')?.textContent.trim() ?? null }))`);
async function waitRows(page, expected, label) {
  let seen;
  await page.waitFor(async () => { seen = await rowsOf(page); return JSON.stringify(seen) === JSON.stringify(expected); }, 30_000, label)
    .catch((e) => { throw new Error(`${e.message}; rows shown: ${JSON.stringify(seen)?.slice(0, 600)}`); });
}

const isCreate = (r) => r.method === 'POST' && r.path === CUSTOMERS;
const isList = (r) => r.method === 'GET' && r.path === CUSTOMERS;
const isDetail = (r) => r.method === 'GET' && r.path.startsWith(`${CUSTOMERS}/`);
const isEdit = (r) => r.method === 'PATCH' && r.path.startsWith(`${CUSTOMERS}/`);
/** The path the detail view reads for `id` (M7A-CUSTOMERS-P6: the customer's profile). */
const profilePath = (id) => `${CUSTOMERS}/${id}/profile`;
/** The API requests a page (or tab) made that `match`, from record index `from`. */
const sentBy = (page, match, from = 0) => st.api.slice(from).filter((r) => r.frameId === page.frameId && match(r));
const quiet = (page, from) => page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 20_000, 'every request answered');

/** In-app navigation (no page load, so no new tenant login). */
const go = (page, path) => page.evaluate(`history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`);
async function openDirectory(page, path = DIRECTORY) {
  await go(page, path);
  await page.waitFor(`!!${q('customer-directory')}`, 30_000, 'the Customer directory page');
}
/** A new browser: signs in and opens the directory in the app — ONE tenant login (the page's first connect). */
async function directoryPage(who) {
  const page = await openPage();
  await signIn(page, who);
  await openDirectory(page);
  await waitList(page);
  return page;
}
/** The sidebar's "Customer Directory" link, clicked; false when the build has no such entry (the entry commit's). */
async function openBySidebar(page) {
  const link = `[...document.querySelectorAll('a[href="${DIRECTORY}"]')].find((a) => a.textContent.trim().endsWith('Customer Directory'))`;
  if (!(await page.waitFor(`!!${link}`, 15_000, 'the Customer Directory sidebar link').catch(() => false))) return false;
  await page.evaluate(`${link}.setAttribute('data-p5', 'directory-link')`);
  await page.click('[data-p5="directory-link"]');
  await page.waitFor(`location.pathname === '${DIRECTORY}' && !!${q('customer-directory')}`, 30_000, 'the Customer directory page');
  return true;
}
/** Replace a field's text as a user does: select it all and type over it (an empty `text` deletes it). */
async function retype(page, id, text) {
  await page.click(by(id));
  await page.evaluate(`${q(id)}.select()`);
  if (text === '') await page.evaluate(`document.execCommand('delete')`);
  else await page.type(text);
  await page.waitFor(`${q(id)}?.value === ${JSON.stringify(text)}`, 10_000, `${id} reads what was typed`);
}
/** Type a name and press "Add customer"; answers the API record count at the click. */
async function addCustomer(page, name) {
  await page.fill(by('directory-name'), name);
  await page.waitFor(() => offered(page, 'directory-add'), 15_000, 'Add customer is enabled');
  const from = st.api.length;
  await page.click(by('directory-add'));
  return from;
}

/** One tenant's customers as the database owner reads them, in the server's page order (017: name in byte order, then id). */
async function customersOf(tenant) {
  const rows = await owner`select customer_id as id, name from tmpos_customer.customer where tenant_id = ${tenant} order by name collate "C", customer_id`;
  return Array.from(rows, (r) => ({ id: r.id, name: r.name }));
}
const named = async (tenant, name) => (await customersOf(tenant)).filter((c) => c.name === name);
/** Rows put in a tenant by the database owner (no session, audit or idempotency record): [{ id, name }] as given. */
async function seedCustomers(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}

/**
 * Customers requests select nothing: the query is empty, one cursor, or a search and its own cursor, a POST body is { name } with at most a phone and an
 * email after it (in that order), a PATCH body is { expectedVersion, name } with at most a phone and an email after it, a
 * GET has no body,
 * no header is named for a tenant, store, role or actor, and none of `values` (tenant ids, the accounts' ids) rides
 * anywhere in the path, query, headers or body.
 */
function assertNoSelector(records, values) {
  assert.ok(records.length > 0, 'customers requests were made');
  for (const r of records) {
    const line = apiLine(r);
    // M7A-CUSTOMERS-P8: a search rides first as `q=<encodeURIComponent(text)>`, with only its own 44-character cursor after it.
    assert.match(r.query, /^(\?cursor=[A-Za-z0-9_-]{23}|\?q=[A-Za-z0-9%._~!*'()-]+(&cursor=[A-Za-z0-9_-]{44})?)?$/, `only a search and a cursor may ride the query: ${line}`);
    assert.deepEqual(Object.keys(r.headers).filter((h) => /tenant|store|role|actor/i.test(h)), [], `no selecting header: ${line}`);
    if (r.method === 'POST') {
      const keys = Object.keys(JSON.parse(r.body));
      assert.deepEqual(keys, ['name', 'phone', 'email'].filter((k) => keys.includes(k)), `the body is { name, phone?, email? }: ${line}`);
      assert.equal(keys[0], 'name', `the body names the customer: ${line}`);
    }
    else if (r.method === 'PATCH') {
      const keys = Object.keys(JSON.parse(r.body));
      assert.deepEqual(keys, ['expectedVersion', 'name', 'phone', 'email'].filter((k) => keys.includes(k)), `the body is { expectedVersion, name, phone?, email? }: ${line}`);
      assert.deepEqual(keys.slice(0, 2), ['expectedVersion', 'name'], `the body names the version and the customer: ${line}`);
      assert.equal(r.headers['if-match'], undefined, `no validator rides an edit: ${line}`);
    }
    else assert.equal(r.body, '', `a read carries no body: ${line}`);
    const wire = `${r.path}${r.query}\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n${r.body}`;
    for (const value of values) assert.ok(!wire.includes(String(value)), `a tenant or account id rides a request: ${line}`);
  }
}

scenario('SCB-01', 'ENTRY WITNESS — an owner opens the Customer directory from the sidebar and adds a customer: ONE POST from the page commits (201; one customer, one create audit, one completion); the row survives a reload, a second account\'s browser shows it, and its detail opens by click and by direct URL; no request names a tenant, store, role or actor', async () => {
  const { tenant, boss } = await shop('c1');
  const manager = await actor('c1-manager', [grant(tenant, 'manager')], { role: 'manager' });
  const name = `M7SCB c1 ${SUFFIX}`;
  const page = await openPage();
  await signIn(page, boss);
  const ui = await openBySidebar(page);
  note('ui', ui ? 'customer directory' : 'no Customer Directory entry (the entry build)');
  const before = await counts();
  let empty = null;
  if (ui) {
    await waitList(page);
    empty = note('before the create', { text: await textOf(page, 'directory-empty'), rows: await rowsOf(page) });
    const from = await addCustomer(page, name);
    await page.waitFor(async () => sentBy(page, isCreate, from).some((r) => r.status !== null) && (await rowsOf(page)).some((r) => r.name === name), 30_000, 'the created row is shown')
      .catch((e) => note('the created row was not shown', e.message));
  } else {
    await delay(2_000); // whatever the page would send, it has sent
  }
  // Everything is observed first, so the entry run records the whole "before" picture, then judged: wire, then database.
  const posts = sentBy(page, isCreate);
  note('POST statuses', posts.map((r) => r.status));
  const stored = note('stored', await named(tenant, name));
  const made = note('create delta', await deltaSince(before));

  assert.deepEqual(posts.map((r) => r.status), [201], `the directory page sent exactly one POST ${CUSTOMERS}, answered 201 (API seen: ${st.api.map(apiLine).join('; ') || 'none'}; customers of that name in the tenant: ${stored.length})`);
  assert.equal(stored.length, 1, 'the tenant holds exactly one customer of that name');
  assert.deepEqual(made, { ...made, ...CREATED }, `one customer, one create audit, one sealed completion, no role edit ${JSON.stringify(made)}`);
  const [{ id }] = stored;
  const [post] = posts;
  assert.equal(post.body, JSON.stringify({ name }), 'the body is the name and nothing else');
  assert.match(post.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.deepEqual(JSON.parse(post.replied.text), { customer: { id, name } }, 'the answer names the stored row');
  assert.equal(post.replied.headers.location, `${CUSTOMERS}/${id}`);
  assert.equal(post.replied.headers['idempotent-replayed'], undefined, 'a first answer, not a replay');
  assert.deepEqual(empty.rows, [], 'no row before the create');
  assert.ok(empty.text, 'the empty state said so after a list answer');
  await waitRows(page, [{ id, name }], 'the created row, once, under the id the server gave');
  assert.equal(await page.evaluate(`${q('directory-saved-link')}?.getAttribute('href') ?? null`), `${DIRECTORY}/${id}`, 'the saved notice links to the detail');

  await page.goto(`${SHOP}${DIRECTORY}`, 30_000); // a reload: a new page, a new tenant session, nothing kept but the sign-in
  await waitList(page);
  await waitRows(page, [{ id, name }], 'the row after a reload');

  const second = await directoryPage(manager); // a second browser, a second account of the same store
  await waitRows(second, [{ id, name }], 'the row in a second account\'s browser');
  await second.click(`${by('directory-row')}[data-id="${id}"] a`);
  await waitData(second, 'directory-detail', 'phase', 'ready');
  assert.equal(await second.evaluate('location.pathname'), `${DIRECTORY}/${id}`);
  assert.deepEqual([await textOf(second, 'directory-detail-id'), await textOf(second, 'directory-detail-name')], [id, name], 'the detail by click');
  const reads = sentBy(second, isDetail).map((r) => `${r.path} -> ${r.status}`);
  assert.ok(reads.length >= 1 && reads.every((line) => line === `${profilePath(id)} -> 200`), `the detail came from its own read: ${reads.join('; ')}`);
  await second.click(by('directory-back'));
  await waitRows(second, [{ id, name }], 'the list is still there on the way back');

  await page.goto(`${SHOP}${DIRECTORY}/${id}`, 30_000); // the address itself, loaded cold
  await waitData(page, 'directory-detail', 'phase', 'ready');
  assert.deepEqual([await textOf(page, 'directory-detail-id'), await textOf(page, 'directory-detail-name')], [id, name], 'the detail by direct URL');

  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id, manager.uid, manager.id]);
  assert.equal((await named(tenant, name)).length, 1, 'still one: nothing re-sent the create');
  assert.equal(st.api.filter(isCreate).length, 1, 'one POST in the whole case');
  await assertNoLeak(page);
  await assertNoLeak(second);
});

scenario('SCB-02', 'ISOLATION — tenant B\'s owner opening tenant A\'s customer id, a well-formed unknown id and a malformed id sees the SAME not-found text (the malformed one without any request), and B\'s list holds B\'s customers only', async () => {
  const a = await shop('c2a');
  const b = await shop('c2b');
  const theirs = await seedCustomers(a.tenant, [`M7SCB c2 A one ${SUFFIX}`, `M7SCB c2 A two ${SUFFIX}`]);
  const [own] = await seedCustomers(b.tenant, [`M7SCB c2 B own ${SUFFIX}`]);
  const page = await directoryPage(b.boss);
  await waitRows(page, [own], 'B\'s list is exactly B\'s customer');
  // own (a real transition to ready) first, then the malformed id (no request may leave), then the two the server answers.
  const seen = {};
  for (const [label, id, phase] of [['own', own.id, 'ready'], ['malformed', 'not-a-customer-id', 'not-found'], ['foreign', theirs[0].id, 'not-found'], ['unknown', randomUUID(), 'not-found']]) {
    const from = st.api.length;
    await go(page, `${DIRECTORY}/${id}`);
    if (label === 'malformed') await delay(1_000); // whatever it would send, it has sent
    else await page.waitFor(() => sentBy(page, isDetail, from).some((r) => r.path === profilePath(id) && r.status !== null), 20_000, `the ${label} id was read`);
    await page.settle();
    await waitData(page, 'directory-detail', 'phase', phase);
    seen[label] = {
      text: await textOf(page, phase === 'ready' ? 'directory-detail-name' : 'directory-not-found'),
      requests: sentBy(page, isDetail, from).map((r) => (r.path === profilePath(id) ? `this id -> ${answered(r)}` : apiLine(r))),
      page: await textOf(page, 'customer-directory'),
    };
    note(label, { text: seen[label].text, requests: seen[label].requests });
  }
  assert.equal(seen.own.text, own.name, 'B\'s own customer opens');
  assert.ok(seen.unknown.text, 'a not-found text is shown');
  assert.equal(seen.foreign.text, seen.unknown.text, 'another tenant\'s customer reads exactly as one that does not exist');
  assert.equal(seen.malformed.text, seen.unknown.text, 'and as a malformed address');
  assert.deepEqual(seen.malformed.requests, [], `a malformed id sends no ${CUSTOMERS}/ request`);
  assert.ok(seen.foreign.requests.length >= 1 && seen.foreign.requests.every((line) => line.startsWith('this id -> 404')), `the server answered 404: ${seen.foreign.requests.join('; ')}`);
  assert.deepEqual([...new Set(seen.foreign.requests)], [...new Set(seen.unknown.requests)], 'the same answer on the wire for foreign and unknown');
  await go(page, DIRECTORY);
  await waitRows(page, [own], 'B\'s list, unchanged');
  const everything = [...Object.values(seen).map((s) => s.page), await textOf(page, 'customer-directory'), ...sentBy(page, () => true).map((r) => r.replied?.text ?? '')].join('\n');
  for (const c of theirs) assert.ok(!everything.includes(c.name), `A's customer "${c.name}" never reached B's page or its answers`);
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [a.tenant, b.tenant, b.boss.uid, b.boss.id]);
});

scenario('SCB-03', 'PAGING — 60 customers: the page shows the first 50, "Load more" the other 10, every id once, in the server\'s byte order, and never sends a limit', async () => {
  const { tenant, boss } = await shop('c3');
  // Byte order is not dictionary order (A B Z a b é), and two pairs share a name (the id breaks the tie).
  const names = Array.from({ length: 58 }, (_, i) => `${['b', 'A', 'a', 'B', 'é', 'Z'][i % 6]} M7SCB c3 ${SUFFIX} ${String(i).padStart(2, '0')}`);
  await seedCustomers(tenant, [...names, names[0], names[1]]);
  const expected = await customersOf(tenant);
  assert.equal(expected.length, 60);
  assert.notDeepEqual(expected.map((c) => c.name), expected.map((c) => c.name).sort((x, y) => x.localeCompare(y)), 'the server\'s order is not a dictionary sort: a re-sorting page would show');
  const page = await directoryPage(boss);
  await waitRows(page, expected.slice(0, 50), 'the first page: 50 rows in the server\'s order');
  await page.waitFor(() => offered(page, 'directory-load-more'), 15_000, 'Load more is offered');
  await page.click(by('directory-load-more'));
  await waitRows(page, expected, 'all 60 rows in the server\'s order');
  const shown = await rowsOf(page);
  assert.equal(new Set(shown.map((r) => r.id)).size, 60, 'every id once');
  assert.equal(await offered(page, 'directory-load-more'), false, 'nothing more to load');
  const lists = sentBy(page, isList);
  note('list requests', lists.map(apiLine));
  assert.deepEqual(lists.map((r) => r.status), [200, 200], 'two reads: page one and its continuation');
  assert.equal(lists[0].query, '', 'page one carries no limit and no cursor');
  assert.match(lists[1].query, /^\?cursor=[A-Za-z0-9_-]{23}$/, 'the continuation carries the cursor alone');
  const pages = lists.map((r) => JSON.parse(r.replied.text));
  assert.equal(lists[1].query, `?cursor=${pages[0].nextCursor}`, 'the cursor is the one the server gave, verbatim');
  assert.deepEqual(pages.map((p) => [p.customers.length, p.nextCursor === null]), [[50, false], [10, true]]);
  assert.deepEqual(shown, pages.flatMap((p) => p.customers), 'the rows are the answers, in arrival order');
  assertNoSelector(lists, [tenant, boss.uid, boss.id]);
});

scenario('SCB-04', 'PERMISSION NARROWED WHILE OPEN — a sales_staff page with Add available; the owner narrows Customers to View: Add is refused (403) with nothing written and the list still shown; narrowed to None, Refresh shows the denied state and no rows', async () => {
  const { tenant, boss } = await shop('c4');
  const staff = await actor('c4-staff', [grant(tenant, 'sales_staff')], { role: 'sales_staff' });
  const kept = await seedCustomers(tenant, [`M7SCB c4 kept ${SUFFIX}`]);
  const name = `M7SCB c4 refused ${SUFFIX}`;
  const ownerSession = await directLogin(boss);
  const page = await directoryPage(staff);
  await waitRows(page, kept, 'the staff page lists the store\'s customer');
  assert.equal(await has(page, 'directory-add'), true, 'Add is available to sales_staff (Create, the default)');

  const view = await directSet(ownerSession, 'sales_staff', 'view');
  assert.equal(view.status, 200, view.text);
  const before = await counts();
  const from = await addCustomer(page, name);
  await page.waitFor(() => sentBy(page, isCreate, from).some((r) => r.status !== null), 20_000, 'the create was answered');
  await page.waitFor(() => sentBy(page, isList, from).some((r) => r.status !== null), 20_000, 'the list was read again after the refusal');
  await quiet(page, from);
  await waitList(page);
  const said = note('after the refused create', { status: await textOf(page, 'directory-create-status'), draft: await page.evaluate(`${q('directory-name')}?.value ?? null`) });
  note('requests', st.api.slice(from).map(apiLine));
  assert.deepEqual(sentBy(page, isCreate, from).map(answered).map((s) => s.slice(0, 3)), ['403'], 'one POST, refused');
  // The authorizer refuses before the idempotency record is acquired: no lease row is left (L 0), as under SRL-01's View.
  await assertDelta(before, NOTHING, 'the refused create: no customer, no create audit, no completion, no lease');
  assert.deepEqual(await customersOf(tenant), kept, 'the tenant holds what it held');
  assert.match(said.status ?? '', /refused/i, 'the page says the server refused');
  assert.doesNotMatch(said.status ?? '', /\bsaved\b/i);
  assert.equal(await has(page, 'directory-saved'), false, 'no saved notice');
  assert.equal(await has(page, 'directory-hold'), false, 'a refusal is conclusive: nothing is held');
  assert.equal(said.draft, name, 'the draft is kept');
  assert.deepEqual(sentBy(page, isList, from).map((r) => r.status).slice(-1), [200], 'View still reads');
  await waitRows(page, kept, 'the list is still shown after its reload');

  const none = await directSet(ownerSession, 'sales_staff', 'none');
  assert.equal(none.status, 200, none.text);
  const refresh = st.api.length;
  await page.click(by('directory-refresh'));
  await waitList(page, 'denied');
  assert.deepEqual(sentBy(page, isList, refresh).map((r) => r.status), [403], 'None refuses the read');
  assert.deepEqual(await rowsOf(page), [], 'no rows under the denied state');
  assert.ok(!(await textOf(page, 'customer-directory')).includes(kept[0].name), 'nor the name anywhere on the page');
  assert.equal(await offered(page, 'directory-add'), false, 'and no Add');
  assert.equal(sentBy(page, isCreate).length, 1, 'one POST in the whole case');
});

scenario('SCB-05', 'LOST REPLY AFTER THE COMMIT — the POST commits but its answer never reaches the page: the unresolved card, never "saved"; "Check again" re-sends the SAME key and the byte-identical body, answered 201 as a replay; ONE customer of that name', async () => {
  const { tenant, boss } = await shop('c5');
  const name = `M7SCB c5 ${SUFFIX}`;
  const page = await directoryPage(boss);
  const before = await counts();
  let lost = 0;
  st.lose = (rec, phase) => phase === 'response' && isCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
  const from = await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const [first] = sentBy(page, isCreate, from);
  assert.deepEqual([first.status, first.lost], [201, 'response'], 'the create committed, and its answer was lost');
  await assertDelta(before, CREATED, 'the create whose answer was lost');
  const stored = await named(tenant, name);
  assert.equal(stored.length, 1);
  const card = note('card', await textOf(page, 'directory-hold'));
  assert.ok(card.includes(name), 'the card names what is not confirmed');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'false');
  assert.equal(await has(page, 'directory-saved'), false, 'never "saved" on an answer that did not arrive');
  assert.ok(!(await rowsOf(page)).some((r) => r.name === name), 'nor shown as a row');

  // The field is edited meanwhile: what is re-sent is the held attempt, never the field.
  await page.fill(by('directory-name'), ' edited since');
  const mid = await counts();
  await page.waitFor(() => offered(page, 'directory-check-again'), 15_000, 'Check again is offered');
  const again = st.api.length;
  await page.click(by('directory-check-again'));
  await page.waitFor(`!!${q('directory-saved')}`, 30_000, 'the saved notice');
  await quiet(page, again);
  const posts = sentBy(page, isCreate);
  note('creates', posts.map(apiLine));
  assert.equal(posts.length, 2, 'the first send and one check');
  const second = posts[1];
  assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key'], 'the SAME Idempotency-Key');
  assert.match(first.headers['idempotency-key'] ?? '', UUID_V4_RE);
  assert.equal(second.body, first.body, 'the byte-identical body');
  assert.equal(first.body, JSON.stringify({ name }));
  assert.deepEqual([second.status, second.replied.headers['idempotent-replayed']], [201, 'true'], 'answered as a replay');
  assert.deepEqual(JSON.parse(second.replied.text), { customer: stored[0] }, 'the sealed answer: the row already stored');
  await assertDelta(mid, NOTHING, 'the replay wrote nothing');
  assert.deepEqual(await named(tenant, name), stored, 'exactly ONE customer of that name');
  assert.equal(await page.evaluate(`${q('directory-saved-link')}?.getAttribute('href') ?? null`), `${DIRECTORY}/${stored[0].id}`);
  await waitRows(page, stored, 'the list shows it once');
  assert.equal(await has(page, 'directory-hold'), false, 'the card is gone');
  await assertNoLeak(page);
});

scenario('SCB-06', 'HELD ATTEMPT, MOVED GRANT — a first send that never reached the server is held; the account\'s grant moves to tenant B: "Check again" finds the session ended and the attempt is detached for good at once (M7B-INVOICES-P1-R2), NO POST leaves under the new session, and neither tenant holds the name', async () => {
  const a = await shop('c6a');
  const b = await newTenant('c6b');
  const inA = await seedCustomers(a.tenant, [`M7SCB c6 A only ${SUFFIX}`]);
  const name = `M7SCB c6 held ${SUFFIX}`;
  const page = await directoryPage(a.boss);
  await waitRows(page, inA, 'the page shows tenant A');
  const before = await counts();
  // The dangerous case: the server never saw this key, so a re-send under ANY session would create afresh.
  st.lose = (rec, phase) => phase === 'request' && isCreate(rec) && rec.frameId === page.frameId;
  const from = await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const sent = sentBy(page, isCreate, from);
  assert.deepEqual(sent.map((r) => r.lost), ['request'], 'one POST left the page and never reached the server');
  await page.waitFor(() => offered(page, 'directory-check-again'), 15_000, 'Check again is offered while the connection is the attempt\'s');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'false');

  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page holds a tenant-A session');
  await moveOwner(a.boss, a.tenant, b);
  assert.equal((await readWith(aLogin.cookie)).status, 401, 'the move ended the tenant-A session');
  const moved = st.api.length;
  await page.click(by('directory-check-again')); // the page's next action: it must check the connection before anything is sent
  // M7A-CUSTOMERS-P6: the move ended the session this page confirmed — "Check again" finds it ended and sends nothing:
  // no login and no POST; the list offers Reconnect. M7B-INVOICES-P1-R2 (DA-200): that end detaches the card at once.
  await waitList(page, 'signed-out');
  await quiet(page, moved);
  assert.deepEqual(st.api.slice(moved).filter((r) => isLogin(r) || isCreate(r)).map(apiLine), [], 'no login and no POST on "Check again"');
  assert.equal(await page.evaluate(`${q('directory-hold')}.dataset.detached`), 'true', 'the ended session detached it at once: it can never be sent again');
  assert.equal(await textOf(page, 'directory-retry'), 'Reconnect');
  const reconnect = st.api.length;
  await page.click(by('directory-retry'));
  await waitData(page, 'directory-hold', 'detached', 'true');
  await waitList(page);
  await waitRows(page, [], 'the list is now tenant B\'s: empty');
  await quiet(page, moved);
  await delay(1_000); // whatever it would still send, it has sent
  note('after the move', st.api.slice(moved).map(apiLine));
  const relogin = st.api.slice(moved).filter(acceptedLogin(a.boss));
  assert.equal(relogin.length, 1, 'the page signed in again once, on the Reconnect: the new session is tenant B\'s');
  assert.ok(st.api.indexOf(relogin[0]) >= reconnect, 'and only after the click');
  assert.deepEqual(st.api.slice(moved).filter(isCreate).map(apiLine), [], 'NO POST left under the new session');
  assert.equal(await offered(page, 'directory-check-again'), false, 'Check again is not offered for a detached attempt');
  assert.match((await textOf(page, 'directory-hold-detached')) ?? '', /earlier connection/, 'the card says why it cannot be checked from here');
  assert.equal(await has(page, 'directory-connection-changed'), true, 'the page says the store connection changed');
  assert.equal(await has(page, 'directory-saved'), false, 'nothing is called saved');
  assert.equal(await has(page, 'directory-empty'), true, 'tenant B\'s empty state, after its own list answer');
  assert.deepEqual(await named(b, name), [], 'tenant B holds no customer of that name');
  assert.deepEqual(await customersOf(b), [], 'nor any other');
  assert.deepEqual(await customersOf(a.tenant), inA, 'tenant A holds what it held');
  await assertDelta(before, NOTHING, 'nothing was written anywhere: no customer, audit, completion or lease');
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P5-R1 — session reuse (DA-143) and read binding (DA-138)
// ---------------------------------------------------------------------------------------------------------------------

const isSessionRead = (r) => r.method === 'GET' && r.path === '/api/v1/session';
const isLogin = (r) => r.method === 'POST' && r.path === LOGIN;
const isCustomersRead = (r) => r.method === 'GET' && r.path.startsWith(CUSTOMERS);
const cookieValue = (pair) => pair.split('=').slice(1).join('=');
/** Numbers first: one JSON line per case in the evidence folder (labels, counts, statuses, booleans — no secrets). */
function record(id, data) {
  try { appendFileSync(join(EVIDENCE, 'scb-witness.jsonl'), `${JSON.stringify({ id, at: new Date().toISOString(), ...data })}\n`); } catch { /* best effort */ }
  return note('witness', data);
}

/** A principal's live tenant sessions, the mint rows beside them, and every mint row (for the ledger's growth). */
async function sessionRows(who) {
  const [r] = await owner`select
    (select count(*) from tmpos_session.session where audience = 'tenant' and auth_provider_uid = ${who.uid})::int as sessions,
    (select count(*) from tmpos_mint.tenant_session m join tmpos_session.session s using (session_key) where s.auth_provider_uid = ${who.uid})::int as mint_live,
    (select count(*) from tmpos_mint.tenant_session)::int as mint_all`;
  return r;
}

/** The list's settled phase after a load or reopen (never throws: 'timeout' is an observation too). */
function listSettled(page, from, timeout = 30_000) {
  return page.waitFor(async () => {
    const phase = await page.evaluate(`${q('directory-state')}?.dataset.phase ?? null`);
    if (phase === null || phase === 'loading') return null;
    if (phase === 'ready' && !sentBy(page, isList, from).some((r) => r.status !== null)) return null;
    return phase;
  }, timeout, 'the list settled').catch(() => 'timeout');
}

/** What one load (or reopen) of the directory did on the wire and showed. */
async function observeLoad(page, label, from, expected) {
  const phase = await listSettled(page, from);
  await quiet(page, from).catch(() => {});
  const mine = st.api.slice(from).filter((r) => r.frameId === page.frameId);
  const firstRead = mine.findIndex(isCustomersRead);
  const rows = await rowsOf(page);
  return {
    label, phase,
    logins: mine.filter(isLogin).map(answered),
    sessionReads: mine.filter(isSessionRead).map(answered),
    sessionReadBeforeCustomers: firstRead >= 0 && mine.slice(0, firstRead).some((r) => isSessionRead(r) && r.status !== null),
    customerReads: mine.filter(isCustomersRead).map(answered),
    status429: mine.filter((r) => r.status === 429).map((r) => `${r.method} ${r.path}`),
    rowsShown: JSON.stringify(rows) === JSON.stringify(expected),
    rowCount: rows.length,
  };
}

scenario('SCB-07', 'SESSION REUSE (DA-143) — inside one 5-minute window: first open, 6 reloads, an in-app reopen, one load showing both server consumers and a second tab; ONE login, one session row, one mint row, no 429, every load reads the session before any customer read and shows the rows', async () => {
  const { tenant, boss } = await shop('c7');
  await seedCustomers(tenant, [`M7SCB c7 one ${SUFFIX}`, `M7SCB c7 two ${SUFFIX}`, `M7SCB c7 three ${SUFFIX}`]);
  const expected = await customersOf(tenant);
  const dbBefore = await sessionRows(boss);
  const started = performance.now();
  const loads = [];
  const page = await openPage();
  await signIn(page, boss);
  await openDirectory(page);
  loads.push(await observeLoad(page, 'first open (sign-in, then in-app)', 0, expected));
  for (let i = 1; i <= 6; i++) {
    const from = st.api.length;
    await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
    loads.push(await observeLoad(page, `reload ${i}`, from, expected));
  }
  {
    const from = st.api.length;
    await go(page, '/');
    await page.waitFor(`!${q('customer-directory')}`, 10_000, 'left the directory');
    const back = await openBySidebar(page);
    loads.push({ ...(await observeLoad(page, 'in-app reopen (away, back by the sidebar)', from, expected)), sidebar: back });
  }
  {
    const from = st.api.length;
    await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
    const directory = await observeLoad(page, 'both consumers: directory', from, expected);
    await openPermissions(page);
    const panel = await page.waitFor(`(() => { const s = ${q('server-levels-state')}?.dataset.state; return s && s !== 'loading' ? s : null; })()`, 30_000, 'the server panel settled').catch(() => 'timeout');
    const mid = st.api.length;
    const back = await openBySidebar(page);
    const again = await observeLoad(page, 'both consumers: directory again', mid, expected);
    const whole = await observeLoad(page, 'both consumers (one load)', from, expected);
    loads.push({ ...whole, panel, sidebar: back, directoryFirst: directory.rowsShown, directoryAgain: again.rowsShown, rowsShown: directory.rowsShown && again.rowsShown });
  }
  {
    const tab = await sameContextTab(page);
    const from = st.api.length;
    await tab.goto(`${SHOP}${DIRECTORY}`, 30_000);
    await tab.waitFor(`!!${q('customer-directory')}`, 30_000, 'the directory in the second tab').catch(() => {});
    loads.push(await observeLoad(tab, 'second tab of the same browser', from, expected));
  }
  const elapsedSeconds = Math.round((performance.now() - started) / 1000);
  const logins = st.api.filter((r) => isLogin(r) && bearerUid(r) === boss.uid);
  const db = await sessionRows(boss);
  const numbers = record('SCB-07', {
    elapsedSeconds, loads,
    loginsTotal: logins.length, loginStatuses: logins.map(answered),
    firstLoginOnLoad: loads.findIndex((l) => l.logins.length > 0),
    status429: st.api.filter((r) => r.status === 429).map((r) => `${r.method} ${r.path}`),
    first429OnLoad: loads.findIndex((l) => l.status429.length > 0),
    sessionRowsLive: db.sessions, mintRowsLive: db.mint_live, mintRowsAdded: db.mint_all - dbBefore.mint_all,
  });

  assert.ok(elapsedSeconds < 300, `every load inside one 5-minute window: ${elapsedSeconds} s`);
  assert.equal(loads.length, 10, 'first open + 6 reloads + in-app reopen + both-consumer load + second tab');
  assert.deepEqual(numbers.loginStatuses, ['200'], `exactly ONE login for the whole case: ${loads.map((l) => `${l.label}: [${l.logins.join(', ')}]`).join('; ')}`);
  assert.deepEqual(numbers.status429, [], 'no 429 anywhere');
  assert.deepEqual([numbers.sessionRowsLive, numbers.mintRowsLive, numbers.mintRowsAdded], [1, 1, 1], 'one live session row, one mint row beside it, one mint row made');
  for (const l of loads) {
    assert.equal(l.phase, 'ready', `${l.label}: the list is ready`);
    assert.ok(l.rowsShown, `${l.label}: the rows are shown`);
    assert.ok(l.sessionReadBeforeCustomers, `${l.label}: GET /api/v1/session answered before any customer read (${l.sessionReads.join(', ')} / ${l.customerReads.join(', ')})`);
  }
  assert.equal(loads.find((l) => l.panel !== undefined).panel, 'ready', 'the Permissions server panel was ready in the same load');
  await assertNoLeak(page);
}, 360_000);

/** Whether page A's DOM holds any of tenant B's ids or names: { id, name } booleans (nothing else recorded). */
async function domHasB(page, bees) {
  const html = await page.evaluate('document.documentElement.outerHTML');
  return { id: bees.some((c) => html.includes(c.id)), name: bees.some((c) => html.includes(c.name)) };
}

/**
 * Park page A's next read that `match`es AFTER the page's session check was answered, swap the jar's tenant session cookie
 * to B's, release the read carrying B's cookie, and observe. Answers labels, statuses and booleans only.
 */
async function swapRead(page, { match, trigger, cookieName, aValues, bSession, bees }) {
  const from = st.api.length;
  const held = gate((r) => r.frameId === page.frameId && match(r), 'request');
  await trigger();
  const rec = await Promise.race([held.reached, delay(30_000).then(() => null)]);
  if (rec === null) return { reached: false, requests: st.api.slice(from).map(apiLine) };
  const mine = st.api.slice(from).filter((r) => r.frameId === page.frameId);
  const before = mine.slice(0, mine.indexOf(rec));
  const bValue = cookieValue(bSession.cookie);
  const label = (header) => {
    const v = (header ?? '').split(/;\s*/).find((p) => p.startsWith(`${cookieName}=`));
    if (v === undefined) return 'none';
    return aValues().has(cookieValue(v)) ? 'A' : cookieValue(v) === bValue ? 'B' : 'other';
  };
  const sent = label(rec.headers.cookie);
  await browser.send('Storage.setCookies', {
    browserContextId: page.contextId,
    cookies: [{ name: cookieName, value: bValue, url: `${SHOP}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }],
  });
  let forwarded = null;
  st.tamper = async (r, out) => {
    if (r !== rec) return;
    const others = (out.cookie ?? '').split(/;\s*/).filter((p) => p !== '' && !p.startsWith(`${cookieName}=`));
    out.cookie = [...others, `${cookieName}=${bValue}`].join('; ');
    forwarded = label(out.cookie);
  };
  held.release();
  await page.waitFor(() => rec.status !== null, 30_000, 'the swapped read was answered');
  st.tamper = null;
  let swappedBody = null;
  try { swappedBody = JSON.parse(rec.replied?.text ?? ''); } catch { /* not JSON */ }
  const atRelease = await domHasB(page, bees);
  await page.waitFor(() => st.api.slice(from).every((r) => r.status !== null), 30_000, 'every request answered').catch(() => {});
  await delay(3_000); // whatever the page does next (a re-check, a new sign-in, a re-read), it has done
  await quiet(page, from).catch(() => {});
  await page.settle();
  const settled = await domHasB(page, bees);
  const after = st.api.slice(from).filter((r) => r.frameId === page.frameId && st.api.indexOf(r) > st.api.indexOf(rec));
  const delivered = st.api.slice(from).filter((r) => r.frameId === page.frameId && r.lost === undefined && typeof r.replied?.text === 'string');
  return {
    reached: true,
    sessionCheckBefore: before.filter((r) => isSessionRead(r) || isLogin(r)).map((r) => `${r.method} ${r.path} -> ${answered(r)}`),
    sentWith: sent, forwardedWith: forwarded,
    swapped: {
      status: rec.status, error: rec.error ?? null,
      customersKey: swappedBody !== null && (Object.hasOwn(swappedBody, 'customers') || Object.hasOwn(swappedBody, 'customer')),
      bIdsInAnswer: bees.filter((c) => rec.replied.text.includes(c.id)).length,
    },
    deliveredWithB: delivered.filter((r) => bees.some((c) => r.replied.text.includes(c.id))).map((r) => `${r.method} ${r.path === rec.path ? '(the swapped path)' : r.path} -> ${answered(r)}`),
    domAtRelease: atRelease, domSettled: settled,
    afterRelease: after.map((r) => `${r.method} ${r.path.startsWith(`${CUSTOMERS}/`) ? `${CUSTOMERS}/{id}` : r.path} -> ${answered(r)}`),
  };
}

scenario('SCB-08', 'READ BINDING (DA-138) — page A\'s list read and detail read, each parked after the session check and released with tenant B\'s session cookie: 403 with no customers, no B id ever reaches page A\'s answers or DOM, and the page ends on A\'s own rows and customer (a new A session)', async () => {
  const a = await shop('c8a');
  const b = await shop('c8b');
  await seedCustomers(a.tenant, [`M7SCB c8 A one ${SUFFIX}`, `M7SCB c8 A two ${SUFFIX}`, `M7SCB c8 A three ${SUFFIX}`]);
  const bees = await seedCustomers(b.tenant, [`M7SCB c8 B one ${SUFFIX}`, `M7SCB c8 B two ${SUFFIX}`, `M7SCB c8 B three ${SUFFIX}`]);
  const expectA = await customersOf(a.tenant);
  const page = await directoryPage(a.boss);
  await waitRows(page, expectA, 'page A shows tenant A\'s rows');
  const cookieName = st.api.filter(acceptedLogin(a.boss)).at(-1).cookie.split('=')[0];
  const aValues = () => new Set(st.api.filter(acceptedLogin(a.boss)).map((r) => cookieValue(r.cookie)));

  // The list: a Refresh (the page's session check, then the list read — parked).
  const list = await swapRead(page, {
    match: isList, trigger: () => page.click(by('directory-refresh')), cookieName, aValues, bSession: await directLogin(b.boss), bees,
  });
  const listRows = await rowsOf(page);
  list.end = {
    phase: await page.evaluate(`${q('directory-state')}?.dataset.phase ?? null`),
    rowsA: JSON.stringify(listRows) === JSON.stringify(expectA), rowsB: listRows.some((r) => bees.some((c) => c.id === r.id)), rowCount: listRows.length,
  };

  // The detail: a fresh B session, the jar emptied, one of A's customers opened by URL (a load: sign-in, then the reads).
  const target = expectA[0];
  const bSession = await directLogin(b.boss);
  await browser.send('Storage.clearCookies', { browserContextId: page.contextId });
  const detail = await swapRead(page, {
    match: (r) => isDetail(r) && r.path === profilePath(target.id), trigger: () => page.goto(`${SHOP}${DIRECTORY}/${target.id}`, 30_000), cookieName, aValues, bSession, bees,
  });
  detail.end = {
    phase: await page.evaluate(`${q('directory-detail')}?.dataset.phase ?? null`),
    showsA: (await textOf(page, 'directory-detail-id')) === target.id,
    showsB: (await domHasB(page, bees)).id,
  };
  record('SCB-08', { list, detail });

  for (const [label, r] of [['list', list], ['detail', detail]]) {
    assert.ok(r.reached, `${label}: the read was parked (${(r.requests ?? []).join('; ')})`);
    assert.ok(r.sessionCheckBefore.some((line) => line.endsWith(' -> 200')), `${label}: the page's session check was answered first: ${r.sessionCheckBefore.join('; ')}`);
    assert.deepEqual([r.sentWith, r.forwardedWith], ['A', 'B'], `${label}: sent with A's session, forwarded with B's`);
    assert.equal(r.swapped.status, 403, `${label}: the swapped read is refused`);
    assert.equal(r.swapped.customersKey, false, `${label}: the refusal carries no customers`);
    assert.equal(r.swapped.bIdsInAnswer, 0, `${label}: no B id in the refusal`);
    assert.deepEqual(r.deliveredWithB, [], `${label}: no answer delivered to page A holds a B id`);
    assert.deepEqual([r.domAtRelease, r.domSettled], [{ id: false, name: false }, { id: false, name: false }], `${label}: no B id or name ever in page A's DOM`);
  }
  // The page recovers as A: after the refused read it checks the session, finds B's, signs A in again and confirms it.
  const inOrder = (lines, wanted) => {
    let at = 0;
    for (const w of wanted) {
      at = lines.findIndex((l, i) => i >= at && l.startsWith(`${w} -> `)) + 1;
      if (at === 0) return false;
    }
    return true;
  };
  for (const [label, r] of [['list', list], ['detail', detail]]) {
    assert.ok(inOrder(r.afterRelease, ['GET /api/v1/session', `POST ${LOGIN}`, 'GET /api/v1/session']), `${label}: a session read, A's login, then a session read after the refused read: ${r.afterRelease.join('; ')}`);
  }
  assert.deepEqual([list.end.phase, list.end.rowsA], ['ready', true], `the list ends on A's own rows: ${JSON.stringify(list.end)}`);
  assert.equal(list.end.rowsB, false, 'never B\'s rows on A\'s page');
  assert.deepEqual([detail.end.phase, detail.end.showsA], ['ready', true], `the detail ends on A's own customer: ${JSON.stringify(detail.end)}`);
  assert.equal(detail.end.showsB, false, 'never B\'s customer on A\'s page');
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P6 — an ended session is never re-established on its own
// ---------------------------------------------------------------------------------------------------------------------

/** The end SRL-03 makes: every tenant session of `who` (and its mint row) removed in the store. */
async function endSessions(who) {
  const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = ${who.uid}`).map((r) => r.session_key);
  if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
  await owner`delete from tmpos_session.session where auth_provider_uid = ${who.uid}`;
}

scenario('SCB-09', 'SESSION END (M7A-CUSTOMERS-P6) — the session the page confirmed is ended in the store: Refresh, a focus, a tab return and a customer opened in the app send ZERO logins and no POST, showing Reconnect and no customer, and the end detaches the unresolved create at once (M7B-INVOICES-P1-R2: no Check again); ONE Reconnect click sends exactly ONE login, the rows return and the create stays detached, never re-sent; ended again, another tab\'s valid session is reused with no login; a reload with an ended cookie signs in once (the stated residual)', async () => {
  const { tenant, boss } = await shop('c9');
  await seedCustomers(tenant, [`M7SCB c9 one ${SUFFIX}`, `M7SCB c9 two ${SUFFIX}`]);
  const name = `M7SCB c9 held ${SUFFIX}`;
  const page = await directoryPage(boss);
  // An unresolved create: it commits, and its answer is lost at the front (as SCB-05).
  let lost = 0;
  st.lose = (rec, phase) => phase === 'response' && isCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
  await addCustomer(page, name);
  await waitData(page, 'directory-hold', 'state', 'unresolved');
  st.lose = null;
  const expected = await customersOf(tenant); // the two seeded and the held one
  await waitRows(page, expected.filter((c) => c.name !== name), 'the page shows the rows it read');
  const pageLogins = (from) => sentBy(page, isLogin, from);
  const steps = {};

  // The end, while the page is ready. Everything the page does by itself — or that is not a Reconnect — signs nothing in.
  const ended = st.api.length;
  await endSessions(boss);
  await page.click(by('directory-refresh'));
  await waitList(page, 'signed-out');
  steps.refresh = { logins: pageLogins(ended).map(answered), state: await textOf(page, 'directory-state') };
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  await page.waitFor(`${q('directory-hold')}?.dataset.detached === 'true'`, 15_000, 'the end detached the attempt (DA-200)');
  steps.checkAgain = await has(page, 'directory-check-again');
  await go(page, `${DIRECTORY}/${expected[0].id}`);
  await waitData(page, 'directory-detail', 'phase', 'signed-out');
  steps.detail = { name: await has(page, 'directory-detail-name'), retry: await textOf(page, 'directory-detail-retry') };
  await go(page, DIRECTORY);
  await waitList(page, 'signed-out');
  await quiet(page, ended);
  await delay(2_000); // whatever it would still send on its own, it has sent
  steps.ended = {
    logins: pageLogins(ended).map(answered),
    creates: sentBy(page, isCreate, ended).map(answered),
    customerReads: sentBy(page, isCustomersRead, ended).map(answered),
    rows: (await rowsOf(page)).length,
    retry: await textOf(page, 'directory-retry'),
    detached: await page.evaluate(`${q('directory-hold')}?.dataset.detached ?? null`),
  };

  // The Reconnect: exactly one login, and the rows are back; the attempt is detached (a new session), never re-sent.
  const reconnect = st.api.length;
  await page.click(by('directory-retry'));
  await waitList(page);
  await waitData(page, 'directory-hold', 'detached', 'true');
  await quiet(page, reconnect);
  const shown = await rowsOf(page);
  steps.reconnect = {
    logins: pageLogins(reconnect).map(answered),
    rowsBack: JSON.stringify(shown) === JSON.stringify(expected),
    creates: sentBy(page, isCreate).length,
  };

  // Ended again; another TAB of this browser then signs the same owner in: the page's focus reuses that session (no login).
  const again = st.api.length;
  await endSessions(boss);
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await waitList(page, 'signed-out');
  const tab = await sameContextTab(page);
  await tab.goto(`${SHOP}${DIRECTORY}`, 30_000);
  await tab.waitFor(`${q('directory-state')}?.dataset.phase === 'ready'`, 30_000, 'the second tab is ready');
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await waitList(page);
  await waitRows(page, expected, 'the page shows the rows under the other tab\'s session');
  steps.otherTab = { pageLogins: pageLogins(again).map(answered), tabLogins: sentBy(tab, isLogin, again).map(answered) };

  // The stated residual: a reload while the cookie names an ended session is a fresh page — its first 401 signs in.
  await endSessions(boss);
  const reload = st.api.length;
  await page.goto(`${SHOP}${DIRECTORY}`, 30_000);
  await waitList(page);
  await quiet(page, reload);
  steps.reload = { logins: pageLogins(reload).map(answered) };
  record('SCB-09', steps);

  assert.deepEqual(steps.refresh.logins, [], 'Refresh after the end: no login');
  assert.match(steps.refresh.state ?? '', /session ended/i, 'the list says the session ended');
  assert.deepEqual([steps.detail.name, steps.detail.retry], [false, 'Reconnect'], 'the detail shows no customer, and Reconnect');
  assert.deepEqual(steps.ended.logins, [], 'ZERO logins across Refresh, focus, tab return and the route changes');
  assert.deepEqual(steps.ended.creates, [], 'no POST: the uncertain create is not re-sent');
  assert.deepEqual(steps.ended.customerReads, [], 'no customer read without a session');
  assert.deepEqual([steps.ended.rows, steps.ended.retry, steps.ended.detached, steps.checkAgain], [0, 'Reconnect', 'true', false],
    'no rows, Reconnect, the attempt still held but detached by the end, with no Check again');
  assert.deepEqual(steps.reconnect.logins, ['200'], 'ONE Reconnect click: exactly one login');
  assert.ok(steps.reconnect.rowsBack, 'the rows return');
  assert.equal(steps.reconnect.creates, 1, 'one POST in the whole case: the attempt is detached, never re-sent');
  assert.deepEqual(steps.otherTab.pageLogins, [], 'another tab\'s valid session is reused: no login from the page');
  assert.deepEqual(steps.otherTab.tabLogins, ['200'], 'the other tab signed in once (its own first load)');
  assert.deepEqual(steps.reload.logins, ['200'], 'a reload with an ended cookie signs in once (the stated residual)');
  assert.deepEqual(await named(tenant, name), expected.filter((c) => c.name === name), 'ONE customer of the held name');
  await assertNoLeak(page);
}, 240_000);

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P6 — a customer's contact record
// ---------------------------------------------------------------------------------------------------------------------

scenario('SCB-10', 'CONTACT RECORD (M7A-CUSTOMERS-P6) — an owner adds a customer with a phone and an email: ONE POST of exactly { name, phone, email } (trimmed), stored with a creation time; the profile shows both and that time, and no list row or notice shows a contact; a customer from before contacts shows "Not provided" and "Not recorded"', async () => {
  const { tenant, boss } = await shop('c10');
  const name = `M7SCB c10 ${SUFFIX}`;
  const phone = '+1 555 0100';
  const email = 'ada@example.test';
  // A customer from before contacts: no phone, no email and no creation time, as 023 leaves every earlier row.
  const legacy = { id: randomUUID(), name: `M7SCB c10 legacy ${SUFFIX}` };
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, created_at) values (${legacy.id}, ${tenant}, ${legacy.name}, null)`;
  const page = await directoryPage(boss);
  await page.fill(by('directory-phone'), `  ${phone} `);
  await page.fill(by('directory-email'), email);
  const from = await addCustomer(page, name);
  await page.waitFor(() => sentBy(page, isCreate, from).some((r) => r.status !== null), 30_000, 'the create was answered');
  await page.waitFor(`!!${q('directory-saved-link')}`, 30_000, 'the saved notice');
  // The list read again after the 201 has answered: the created row is shown before the rows are judged.
  await page.waitFor(async () => (await rowsOf(page)).some((r) => r.name === name), 30_000, 'the created row is shown');
  const stored = await owner`select customer_id as id, name, phone, email,
    to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created
    from tmpos_customer.customer where tenant_id = ${tenant} and name = ${name}`;
  const notice = await textOf(page, 'directory-saved');
  const listText = await textOf(page, 'directory-list');
  const opened = st.api.length;
  await page.click(by('directory-saved-link'));
  await waitData(page, 'directory-detail', 'phase', 'ready');
  const created = {
    phone: await textOf(page, 'directory-detail-phone'),
    email: await textOf(page, 'directory-detail-email'),
    datetime: await page.evaluate(`${q('directory-detail-created')}?.querySelector('time')?.getAttribute('datetime') ?? null`),
    createdText: await textOf(page, 'directory-detail-created'),
    reads: sentBy(page, isDetail, opened).map((r) => `${r.path} -> ${answered(r)}`),
  };
  await go(page, `${DIRECTORY}/${legacy.id}`);
  await page.waitFor(`${q('directory-detail-name')}?.textContent.trim() === ${JSON.stringify(legacy.name)}`, 30_000, 'the legacy customer');
  const old = {
    phone: await textOf(page, 'directory-detail-phone'),
    email: await textOf(page, 'directory-detail-email'),
    created: await textOf(page, 'directory-detail-created'),
    time: await page.evaluate(`!!${q('directory-detail-created')}?.querySelector('time')`),
  };
  const posts = sentBy(page, isCreate, from); // every POST the page made in the case, counted at the end
  // The evidence names no contact value: whether each one matched, only.
  record('SCB-10', {
    posts: posts.map((r) => r.status),
    stored: stored.map((r) => ({ phoneMatches: r.phone === phone, emailMatches: r.email === email, createdAtSet: r.created !== null })),
    profile: {
      phoneMatches: stored.length === 1 && created.phone === stored[0].phone,
      emailMatches: stored.length === 1 && created.email === stored[0].email,
      createdAtMatches: stored.length === 1 && created.datetime === stored[0].created,
      reads: created.reads,
    },
    old,
  });

  assert.deepEqual(posts.map((r) => r.status), [201], 'exactly one POST, answered 201');
  assert.equal(posts[0].body, JSON.stringify({ name, phone, email }), 'the body is { name, phone, email }, trimmed, in that order');
  assert.equal(stored.length, 1, 'one customer of that name');
  const [row] = stored;
  assert.deepEqual(JSON.parse(posts[0].replied.text), { customer: { id: row.id, name } }, 'the 201 stays { id, name }');
  assert.deepEqual([row.phone, row.email], [phone, email], 'the database holds the trimmed phone and the email');
  assert.match(row.created ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'and a creation time');
  assert.ok(!(notice ?? '').includes(phone) && !(notice ?? '').includes(email), `the saved notice shows no contact: ${notice}`);
  assert.ok(!(listText ?? '').includes(phone) && !(listText ?? '').includes(email), 'no list row shows a contact');
  assert.ok(created.reads.length >= 1 && created.reads.every((line) => line === `${profilePath(row.id)} -> 200`), `the profile came from its own read: ${created.reads.join('; ')}`);
  assert.deepEqual([created.phone, created.email, created.datetime], [phone, email, row.created], 'the profile shows the phone, the email and the stored instant');
  assert.match(created.createdText ?? '', /UTC$/, 'the creation time is shown in UTC');
  assert.deepEqual([old.phone, old.email, old.created, old.time], ['Not provided', 'Not provided', 'Not recorded', false], 'a customer from before contacts invents nothing');
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id]);
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P7 — editing a customer from the detail
// ---------------------------------------------------------------------------------------------------------------------

const textIs = (page, id, text, label) => page.waitFor(`${q(id)}?.textContent.trim() === ${JSON.stringify(text)}`, 30_000, label);
/** The stored row as the database owner reads it: values, version and creation time (toISOString's form). */
async function storedCustomer(id) {
  const [row] = await owner`select customer_id as id, tenant_id as tenant, name, phone, email, row_version::text as version,
    to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created
    from tmpos_customer.customer where customer_id = ${id}`;
  return row;
}
/** What the detail shows of a customer. */
async function shownCustomer(page) {
  return {
    id: await textOf(page, 'directory-detail-id'),
    name: await textOf(page, 'directory-detail-name'),
    phone: await textOf(page, 'directory-detail-phone'),
    email: await textOf(page, 'directory-detail-email'),
    created: await page.evaluate(`${q('directory-detail-created')}?.querySelector('time')?.getAttribute('datetime') ?? null`),
  };
}
/** Open the edit form on the customer the detail shows. */
async function openEditForm(page) {
  await page.waitFor(() => offered(page, 'directory-edit'), 30_000, 'Edit is offered');
  await page.click(by('directory-edit'));
  await page.waitFor(`!!${q('directory-edit-name')}`, 15_000, 'the edit form');
}

scenario('SCB-11', 'PERSISTENT EDIT (M7A-CUSTOMERS-P7) — an owner edits a customer\'s name and phone and clears its email: ONE PATCH of exactly { expectedVersion, name, phone, email: null } under a fresh key; one change, one update audit naming the customer, one completion; "Saved", the profile read again; after a reload and in a second browser through the second entry: the same id, the same creation time, the edited values', async () => {
  const { tenant, boss } = await shop('c11');
  const name = `M7SCB c11 ${SUFFIX}`;
  const renamed = `M7SCB c11 renamed ${SUFFIX}`;
  const phone = '+1 555 0100';
  const newPhone = '+1 555 0199';
  const email = 'ada@example.test';
  const page = await directoryPage(boss);
  await page.fill(by('directory-phone'), phone);
  await page.fill(by('directory-email'), email);
  await addCustomer(page, name);
  await page.waitFor(`!!${q('directory-saved-link')}`, 30_000, 'the saved notice');
  const [{ id }] = await named(tenant, name);
  const initial = await storedCustomer(id);
  const opened = st.api.length;
  await page.click(by('directory-saved-link'));
  await waitData(page, 'directory-detail', 'phase', 'ready');
  await quiet(page, opened);
  const firstRead = sentBy(page, isDetail, opened).filter((r) => r.path === profilePath(id)).at(-1);
  await openEditForm(page);
  await retype(page, 'directory-edit-name', ` ${renamed} `);
  await retype(page, 'directory-edit-phone', newPhone);
  await retype(page, 'directory-edit-email', '');
  const before = await counts();
  const at = st.api.length;
  await page.click(by('directory-edit-save'));
  await textIs(page, 'directory-edit-status', 'Saved', 'the edit is confirmed');
  await textIs(page, 'directory-detail-name', renamed, 'the profile, read again');
  await quiet(page, at);
  const edits = sentBy(page, isEdit, at);
  const reread = sentBy(page, isDetail, at).map((r) => `${r.path} -> ${answered(r)} ${r.replied?.headers?.etag ?? 'no etag'}`);
  const made = await deltaSince(before);
  const stored = await storedCustomer(id);
  const [audit] = await owner`select count(*)::int as n, count(*) filter (where subject_customer_id = ${id} and tenant_id = ${tenant})::int as named
    from public.audit_event where action_id = ${UPDATE_ACTION} and subject_customer_id = ${id}`;
  const afterSave = await shownCustomer(page);

  await page.goto(`${SHOP}${DIRECTORY}/${id}`, 30_000); // a reload: a new page, nothing kept but the sign-in
  await waitData(page, 'directory-detail', 'phase', 'ready');
  const afterReload = await shownCustomer(page);
  const two = viaSecond(await openPage()); // another browser, through the second entry
  await signIn(two, boss);
  await openDirectory(two, `${DIRECTORY}/${id}`);
  await waitData(two, 'directory-detail', 'phase', 'ready');
  const elsewhere = await shownCustomer(two);
  const secondReads = sentBy(two, isDetail).map((r) => `${r.via === 2 ? 'entry2' : 'entry1'} ${r.path} -> ${answered(r)}`);
  // The evidence names no contact value: whether each one matched, only.
  record('SCB-11', {
    patches: edits.map((r) => r.status), versionHeader: firstRead?.replied?.headers?.etag ?? null, reread, made,
    stored: { nameMatches: stored.name === renamed, phoneMatches: stored.phone === newPhone, emailCleared: stored.email === null, version: stored.version, createdKept: stored.created === initial.created },
    audit, secondReads,
  });

  assert.equal(firstRead?.replied?.headers?.etag, '"1"', 'the profile carried version 1 as a strong ETag');
  assert.deepEqual(edits.map((r) => r.status), [200], 'exactly one PATCH, answered 200');
  const [patch] = edits;
  assert.equal(patch.path, `${CUSTOMERS}/${id}`);
  assert.equal(patch.body, JSON.stringify({ expectedVersion: 1, name: renamed, phone: newPhone, email: null }), 'the exact body: trimmed, the email cleared');
  assert.match(patch.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.deepEqual(JSON.parse(patch.replied.text), { customer: { id, name: renamed }, version: 2, changed: true }, 'the 200 names no contact');
  assert.deepEqual(made, { ...made, ...UPDATED }, `one change, one update audit, one completion ${JSON.stringify(made)}`);
  assert.deepEqual(audit, { n: 1, named: 1 }, 'the update audit names this customer in this tenant');
  assert.deepEqual([stored.name, stored.phone, stored.email, stored.version, stored.created, stored.tenant], [renamed, newPhone, null, '2', initial.created, tenant], 'stored: the edit, version 2, the same creation time and tenant');
  assert.ok(reread.length >= 1 && reread.every((line) => line === `${profilePath(id)} -> 200 "2"`), `the profile was read again at version 2: ${reread.join('; ')}`);
  const expected = { id, name: renamed, phone: newPhone, email: 'Not provided', created: initial.created };
  assert.deepEqual(afterSave, expected, 'after the save');
  assert.deepEqual(afterReload, expected, 'after a reload');
  assert.deepEqual(elsewhere, expected, 'in a second browser through the second entry');
  assert.ok(secondReads.length >= 1 && secondReads.every((line) => line.startsWith('entry2 ')), `the second browser read through the second entry: ${secondReads.join('; ')}`);
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id]);
  await assertNoLeak(page);
  await assertNoLeak(two);
});

scenario('SCB-12', 'STALE EDITOR (M7A-CUSTOMERS-P7) — two browsers open one customer at version 1; the first saves; the second\'s save is a 409 write_conflict that writes nothing but its completion, keeps its draft and sends nothing more on its own; "Review latest" only reads; its deliberate save expects version 2 under a NEW key and lands', async () => {
  const { tenant, boss } = await shop('c12');
  const [customer] = await seedCustomers(tenant, [`M7SCB c12 ${SUFFIX}`]);
  const first = `M7SCB c12 first ${SUFFIX}`;
  const second = `M7SCB c12 second ${SUFFIX}`;
  const one = await directoryPage(boss);
  await go(one, `${DIRECTORY}/${customer.id}`);
  await waitData(one, 'directory-detail', 'phase', 'ready');
  const two = viaSecond(await openPage());
  await signIn(two, boss);
  await openDirectory(two, `${DIRECTORY}/${customer.id}`);
  await waitData(two, 'directory-detail', 'phase', 'ready');
  await openEditForm(one);
  await openEditForm(two); // both drafts start from version 1
  await retype(two, 'directory-edit-name', second);
  await retype(one, 'directory-edit-name', first);
  const atOne = st.api.length;
  await one.click(by('directory-edit-save'));
  await textIs(one, 'directory-edit-status', 'Saved', 'the first editor\'s save');
  await quiet(one, atOne);

  const before = await counts();
  const atTwo = st.api.length;
  await two.click(by('directory-edit-save'));
  await textIs(two, 'directory-edit-alert', 'Someone else changed this customer. Review the latest details, then save again.', 'the conflict');
  await quiet(two, atTwo);
  const conflicted = await deltaSince(before);
  const afterConflict = await storedCustomer(customer.id);
  const draftKept = await two.evaluate(`${q('directory-edit-name')}?.value ?? null`);
  await delay(2_000); // whatever the page would send on its own, it has sent
  const stale = sentBy(two, isEdit, atTwo);

  const reviewAt = st.api.length;
  await two.click(by('directory-edit-review'));
  await textIs(two, 'directory-edit-status', 'The latest details are loaded. Your changes are still in the form: save again to apply them.', 'reviewed');
  await quiet(two, reviewAt);
  const review = sentBy(two, (r) => r.path.startsWith(CUSTOMERS), reviewAt).map((r) => `${r.method} ${r.path} -> ${answered(r)}`);
  const latestShown = await textOf(two, 'directory-detail-name');
  const mid = await counts();
  const saveAt = st.api.length;
  await two.click(by('directory-edit-save'));
  await textIs(two, 'directory-edit-status', 'Saved', 'the deliberate save after the review');
  await quiet(two, saveAt);
  const landed = sentBy(two, isEdit, saveAt);
  const made = await deltaSince(mid);
  const final = await storedCustomer(customer.id);
  record('SCB-12', { stale: stale.map((r) => r.status), conflicted, review, landed: landed.map((r) => r.status), made, versions: [afterConflict.version, final.version] });

  const [winner] = sentBy(one, isEdit, atOne);
  assert.equal(winner.status, 200, 'the first editor\'s PATCH committed');
  assert.deepEqual(stale.map((r) => r.status), [409], 'the stale PATCH, once, and nothing more on its own');
  assert.deepEqual(JSON.parse(stale[0].replied.text).error, 'write_conflict');
  assert.equal(stale[0].body, JSON.stringify({ expectedVersion: 1, name: second }));
  assert.deepEqual(conflicted, { ...conflicted, ...CONFLICTED }, `a stale edit writes only its completion ${JSON.stringify(conflicted)}`);
  assert.deepEqual([afterConflict.name, afterConflict.version], [first, '2'], 'the first editor\'s change stands');
  assert.equal(draftKept, second, 'the stale draft is kept');
  assert.deepEqual(review, [`GET ${profilePath(customer.id)} -> 200`], 'Review latest only reads the profile');
  assert.equal(latestShown, first, 'and shows the latest');
  assert.deepEqual(landed.map((r) => r.status), [200], 'the deliberate save lands');
  assert.equal(landed[0].body, JSON.stringify({ expectedVersion: 2, name: second }), 'built from the reviewed version');
  assert.notEqual(landed[0].headers['idempotency-key'], stale[0].headers['idempotency-key'], 'under a NEW key');
  assert.notEqual(landed[0].headers['idempotency-key'], winner.headers['idempotency-key']);
  assert.deepEqual(made, { ...made, ...UPDATED }, `one change, one update audit, one completion ${JSON.stringify(made)}`);
  assert.deepEqual([final.name, final.version, final.id], [second, '3', customer.id], 'stored at version 3, the same id');
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id]);
  await assertNoLeak(one);
  await assertNoLeak(two);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P8 — searching the directory by name
// ---------------------------------------------------------------------------------------------------------------------

/** Replace the search box's text as a user does, then apply it by the Search button or by Enter; answers the record count at the action. */
async function searchFor(page, text, how = 'button') {
  await retype(page, 'directory-search-input', text);
  const from = st.api.length;
  if (how === 'enter') await page.press('Enter');
  else await page.click(by('directory-search-submit'));
  return from;
}
/** The list's phase once every list read made since `from` has answered (or was lost at the front). */
function searchSettled(page, from) {
  return page.waitFor(async () => {
    const reads = sentBy(page, isList, from);
    if (reads.length === 0 || reads.some((r) => r.status === null)) return null;
    const phase = await page.evaluate(`${q('directory-state')}?.dataset.phase ?? null`);
    return phase === null || phase === 'loading' ? null : phase;
  }, 30_000, 'the search settled');
}
const readLines = (records) => records.map((r) => `${r.query} -> ${r.status}${r.lost ? ` (${r.lost} lost)` : ''}`);
const searchBox = (page) => page.evaluate(`${q('directory-search-input')}?.value ?? null`);

scenario('SCB-13', 'SEARCH (M7A-CUSTOMERS-P8) — the Search button and Enter each send ONE GET of q; only this tenant\'s matches, both letter cases, in the server\'s order; "Load more" sends the search\'s own cursor; no match says so; a lost search is the outage state, never "no matches"; Clear reads the unfiltered list; searching writes nothing', async () => {
  const { tenant, boss } = await shop('c13');
  const other = await newTenant('c13-other');
  const word = 'Kestrel';
  const matching = Array.from({ length: 60 }, (_, i) => `M7SCB c13 ${i % 2 === 0 ? word.toUpperCase() : word.toLowerCase()} ${String(i).padStart(2, '0')} ${SUFFIX}`);
  await seedCustomers(tenant, [...matching, ...Array.from({ length: 15 }, (_, i) => `M7SCB c13 Plover ${String(i).padStart(2, '0')} ${SUFFIX}`)]);
  const foreign = await seedCustomers(other, matching.slice(0, 5));
  const expected = (await customersOf(tenant)).filter((c) => c.name.toUpperCase().includes(word.toUpperCase()));
  assert.equal(expected.length, 60);
  const nothing = `zz none ${SUFFIX}`;
  const page = await directoryPage(boss);
  const before = await counts();

  let from = await searchFor(page, word);
  const first = await searchSettled(page, from);
  const firstReads = readLines(sentBy(page, isList, from));
  const firstRows = await rowsOf(page);
  const summary = await textOf(page, 'directory-search-summary');
  from = st.api.length;
  await page.click(by('directory-load-more'));
  await page.waitFor(async () => (await rowsOf(page)).length === 60, 30_000, 'the second page of matches');
  const moreReads = sentBy(page, isList, from);
  const allRows = await rowsOf(page);
  const moreOffered = await has(page, 'directory-load-more');

  from = await searchFor(page, nothing, 'enter');
  const noMatch = await searchSettled(page, from);
  const noMatchReads = readLines(sentBy(page, isList, from));
  const noMatchText = await textOf(page, 'directory-search-none');

  let lost = 0;
  st.lose = (rec, phase) => phase === 'request' && isList(rec) && rec.frameId === page.frameId && lost++ === 0;
  from = await searchFor(page, word);
  const failed = await searchSettled(page, from);
  st.lose = null;
  const failedReads = readLines(sentBy(page, isList, from));
  const failedShown = {
    none: await has(page, 'directory-search-none'), summary: await has(page, 'directory-search-summary'), empty: await has(page, 'directory-empty'),
    rows: (await rowsOf(page)).length, state: await textOf(page, 'directory-state'),
  };
  from = st.api.length;
  await page.click(by('directory-retry'));
  const retried = await searchSettled(page, from);
  const retryReads = readLines(sentBy(page, isList, from));
  const retryRows = await rowsOf(page);

  from = st.api.length;
  await page.click(by('directory-search-clear'));
  const cleared = await searchSettled(page, from);
  const clearReads = readLines(sentBy(page, isList, from));
  const clearedBox = await searchBox(page);
  const clearedRows = (await rowsOf(page)).length;
  const made = await deltaSince(before);
  const address = await page.evaluate('location.pathname + location.search + location.hash');
  record('SCB-13', { first, firstReads: firstReads.length, more: moreReads.map((r) => r.status), noMatch, failed, failedRows: failedShown.rows, retried, cleared, made });

  assert.equal(first, 'ready');
  assert.deepEqual(firstReads, [`?q=${word} -> 200`], 'the Search button sent ONE read of the search');
  assert.deepEqual(firstRows, expected.slice(0, 50), 'page one: the first 50 matches, both letter cases, in the server\'s order');
  assert.equal(summary, `Customers matching “${word}”`);
  assert.equal(moreReads.length, 1, 'one read for "Load more"');
  assert.match(moreReads[0].query, new RegExp(`^\\?q=${word}&cursor=[A-Za-z0-9_-]{44}$`), 'with the search\'s own continuation');
  assert.equal(moreReads[0].status, 200);
  assert.deepEqual(allRows, expected, 'every match exactly once, in order');
  assert.equal(moreOffered, false, 'and no more after the last');
  for (const f of foreign) assert.ok(!allRows.some((r) => r.id === f.id), 'nothing of the other tenant');
  assert.equal(noMatch, 'ready');
  assert.deepEqual(noMatchReads, [`?q=${encodeURIComponent(nothing)} -> 200`], 'Enter sent ONE read of the search');
  assert.equal(noMatchText, `No customers match “${nothing}”.`);
  assert.equal(failed, 'unavailable', 'a lost search is the outage state');
  assert.deepEqual(failedReads, [`?q=${word} -> 0 (request lost)`]);
  assert.deepEqual(failedShown, { none: false, summary: false, empty: false, rows: 0, state: 'The customer directory is unavailable right now.' }, 'never "no matches"');
  assert.equal(retried, 'ready');
  assert.deepEqual(retryReads, [`?q=${word} -> 200`], '"Try again" reads the same search');
  assert.deepEqual(retryRows, expected.slice(0, 50));
  assert.equal(cleared, 'ready');
  assert.deepEqual(clearReads, [' -> 200'], 'Clear reads the unfiltered list');
  assert.equal(clearedBox, '');
  assert.equal(clearedRows, 50);
  assert.deepEqual(made, { ...made, ...REFUSED, U: 0 }, `searching writes nothing ${JSON.stringify(made)}`);
  assert.equal(address, DIRECTORY, 'the address never holds the search');
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, other, boss.uid, boss.id]);
  await assertNoLeak(page);
});

scenario('SCB-14', 'SEARCH THEN EDIT (M7A-CUSTOMERS-P8) — a match opens its profile by its row\'s link; renamed out of the search, the active search is read again from page one and no longer lists it; the way back keeps the search box; the new name is found by its own search', async () => {
  const { tenant, boss } = await shop('c14');
  const word = 'merlin';
  const [target, sibling] = await seedCustomers(tenant, [`M7SCB c14 Merlin A ${SUFFIX}`, `M7SCB c14 MERLIN B ${SUFFIX}`, `M7SCB c14 Other ${SUFFIX}`]);
  const renamed = `M7SCB c14 Osprey ${SUFFIX}`;
  const page = await directoryPage(boss);
  let from = await searchFor(page, word);
  await searchSettled(page, from);
  const listed = await rowsOf(page);
  const opened = st.api.length;
  await page.click(`${by('directory-row')}[data-id="${target.id}"] a`);
  await waitData(page, 'directory-detail', 'phase', 'ready');
  await quiet(page, opened);
  const profileReads = sentBy(page, isDetail, opened).map((r) => `${r.path} -> ${r.status}`);
  await openEditForm(page);
  await retype(page, 'directory-edit-name', renamed);
  const at = st.api.length;
  await page.click(by('directory-edit-save'));
  await textIs(page, 'directory-edit-status', 'Saved', 'the edit is confirmed');
  await page.waitFor(() => sentBy(page, isList, at).some((r) => r.status !== null), 30_000, 'the active search is read again');
  await quiet(page, at);
  const edits = sentBy(page, isEdit, at).map((r) => r.status);
  const refreshed = readLines(sentBy(page, isList, at));
  const addressAfterEdit = await page.evaluate('location.pathname + location.search');
  await page.click(by('directory-back'));
  await waitList(page);
  const after = await rowsOf(page);
  const summary = await textOf(page, 'directory-search-summary');
  const box = await searchBox(page);
  from = await searchFor(page, 'osprey', 'enter');
  await searchSettled(page, from);
  const found = await rowsOf(page);
  record('SCB-14', { listed: listed.length, profileReads, edits, refreshed: refreshed.length, after: after.length, found: found.length });

  assert.deepEqual(listed, [{ id: sibling.id, name: sibling.name }, { id: target.id, name: target.name }], 'both matches, in the server\'s order (MERLIN before Merlin)');
  assert.deepEqual(profileReads, [`${profilePath(target.id)} -> 200`], 'the row opened its profile');
  assert.deepEqual(edits, [200], 'one PATCH, confirmed');
  assert.deepEqual(refreshed, [`?q=${word} -> 200`], 'the active search, read again from page one');
  assert.equal(addressAfterEdit, `${DIRECTORY}/${target.id}`, 'the address never holds the search');
  assert.deepEqual(after, [{ id: sibling.id, name: sibling.name }], 'renamed out of the search: no longer listed');
  assert.equal(summary, `Customers matching “${word}”`);
  assert.equal(box, word, 'the way back keeps the search box');
  assert.deepEqual(found, [{ id: target.id, name: renamed }], 'the new name, found by its own search');
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, boss.uid, boss.id]);
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P9 — a new invoice draft names a saved server customer chosen in the picker (AC-09)
// ---------------------------------------------------------------------------------------------------------------------

/** The rows the picker shows, in the order shown: [{ id, name }]. */
const pickerRowsOf = (page) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by('picker-row'))})].map((li) => ({ id: li.dataset.id ?? null, name: li.querySelector('p')?.textContent.trim() ?? null }))`);
/** Replace the picker's search text and apply it by its Search button or by Enter; answers the record count at the action. */
async function pickerSearch(page, text, how = 'button') {
  await retype(page, 'picker-search-input', text);
  const from = st.api.length;
  if (how === 'enter') await page.press('Enter');
  else await page.click(by('picker-search-submit'));
  return from;
}
/** The picker's phase once every list read made since `from` has answered. */
function pickerSettled(page, from) {
  return page.waitFor(async () => {
    const reads = sentBy(page, isList, from);
    if (reads.length === 0 || reads.some((r) => r.status === null)) return null;
    const phase = await page.evaluate(`${q('picker-state')}?.dataset.phase ?? null`);
    return phase === null || phase === 'loading' ? null : phase;
  }, 30_000, 'the picker read settled');
}
/** `id` is shown and has stopped moving (the draft's modal animates in), so a click lands where it is measured. */
async function still(page, id) {
  let last = null;
  let same = 0;
  await page.waitFor(async () => {
    const at = await page.evaluate(`JSON.stringify(${q(id)}?.getBoundingClientRect() ?? null)`);
    same = at !== 'null' && at === last ? same + 1 : 0;
    last = at;
    return same >= 3; // unchanged across four reads, 50 ms apart
  }, 15_000, `${id} has stopped moving`);
}
/** Open the picker by `button` (picker-open or picker-change); answers its unfiltered first page's read lines once shown. */
async function openPicker(page, button) {
  await still(page, button);
  const from = st.api.length;
  await page.click(by(button));
  await page.waitFor(`!!${q('picker-dialog')}`, 15_000, 'the picker dialog');
  assert.equal(await pickerSettled(page, from), 'ready', 'the picker\'s first page');
  return readLines(sentBy(page, isList, from));
}
/** Click a row's Select; the dialog closes and the draft shows that customer. */
async function pickRow(page, id) {
  await page.click(`${by('picker-row')}[data-id="${id}"] ${by('picker-select')}`);
  await page.waitFor(`!${q('picker-dialog')} && ${q('picker-value')}?.dataset.id === ${JSON.stringify(id)}`, 15_000, `the draft names ${id}`);
}
/**
 * ServerCustomerPicker.tsx's SERVER_DRAFT_LIMIT_TEXT (a literal: this file loads against the entry commit's tree too). Since
 * M7B-INVOICES-P1 it names "Save as server draft" (design R10 changes this text deliberately); the limit itself — no
 * invoice for a server customer, Generate disabled — is unchanged and still asserted.
 */
const SERVER_DRAFT_LIMIT = "This draft uses a customer saved on the server, so no invoice can be generated here for it. To keep this customer, use \"Save as server draft\": only the customer is carried over, not these lines. To generate the invoice here, choose a customer from this browser's list instead.";
const boundId = (page) => page.evaluate(`${q('picker-value')}?.dataset.id ?? null`);

scenario('SCB-15', 'INVOICE DRAFT PICKER (M7A-CUSTOMERS-P9, AC-09) — "Create Invoice" opens a draft whose picker reads only GET /api/v1/customers: a search over two pages binds a second-page customer by its database id, the server-customer limit shows and Generate stays disabled; of two identical names the second is bound exactly; Change then Cancel keeps the binding; Remove clears it; a local customer replaces a server one; nothing is written and no other tenant\'s customer is ever answered', async () => {
  const { tenant, boss } = await shop('c15');
  const other = await newTenant('c15-other');
  const word = 'Heron';
  const matching = Array.from({ length: 55 }, (_, i) => `M7SCB c15 ${i % 2 === 0 ? word.toUpperCase() : word.toLowerCase()} ${String(i).padStart(2, '0')} ${SUFFIX}`);
  const twin = `M7SCB c15 Twin ${SUFFIX}`;
  await seedCustomers(tenant, [...matching, ...Array.from({ length: 4 }, (_, i) => `M7SCB c15 Plover ${i} ${SUFFIX}`), twin, twin]);
  const foreign = await seedCustomers(other, [...matching.slice(0, 4), twin]);
  const all = await customersOf(tenant);
  const expected = all.filter((c) => c.name.toUpperCase().includes(word.toUpperCase()));
  const twins = await named(tenant, twin);
  assert.equal(expected.length, 55);
  assert.equal(twins.length, 2);
  const target = expected[52]; // only on the second page of the search
  const before = await counts();
  const page = await openPage();
  await signIn(page, boss);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('invoice-create-open')}`, 30_000, 'the Invoices page offers Create Invoice');
  await page.click(by('invoice-create-open'));
  await page.waitFor(`!!${q('picker-open')}`, 15_000, 'the draft offers the server-customer picker');

  // 1. A search over two pages; a second-page row is bound.
  const firstOpen = await openPicker(page, 'picker-open');
  const unfiltered = await pickerRowsOf(page);
  let from = await pickerSearch(page, word);
  const searched = await pickerSettled(page, from);
  const searchReads = readLines(sentBy(page, isList, from));
  const pageOne = await pickerRowsOf(page);
  from = st.api.length;
  await page.click(by('picker-load-more'));
  await page.waitFor(async () => (await pickerRowsOf(page)).length === expected.length, 30_000, 'the second page of matches');
  const moreReads = sentBy(page, isList, from);
  const bothPages = await pickerRowsOf(page);
  const moreOffered = await has(page, 'picker-load-more');
  await pickRow(page, target.id);
  const bound = { id: await boundId(page), name: await textOf(page, 'picker-value-name') };
  const limitShown = await textOf(page, 'invoice-server-limit');
  const saveDisabled = await page.evaluate(`${q('invoice-create-save')}?.disabled === true`);
  const localWhileServer = await page.evaluate(`${q('invoice-customer-select')}?.value ?? null`);

  // 2. Two identical names: the second one is bound exactly.
  const changeOpen = await openPicker(page, 'picker-change');
  from = await pickerSearch(page, twin, 'enter');
  const twinSearch = await pickerSettled(page, from);
  const twinReads = readLines(sentBy(page, isList, from));
  const twinRows = await pickerRowsOf(page);
  await pickRow(page, twins[1].id);
  const twinBound = { id: await boundId(page), name: await textOf(page, 'picker-value-name') };

  // 3. Change, then Cancel: the binding stays.
  const cancelOpen = await openPicker(page, 'picker-change');
  await page.click(by('picker-cancel'));
  await page.waitFor(`!${q('picker-dialog')}`, 15_000, 'the picker closed');
  const afterCancel = await boundId(page);

  // 4. Remove: no server customer, the picker is offered again.
  await page.click(by('picker-remove'));
  await page.waitFor(`!${q('picker-value')} && !!${q('picker-open')}`, 15_000, 'the server customer removed');
  const removed = { limit: await has(page, 'invoice-server-limit'), local: await page.evaluate(`${q('invoice-customer-select')}?.value ?? null`) };

  // 5. A local customer chosen after a server one replaces it.
  const reopen = await openPicker(page, 'picker-open');
  const firstRow = (await pickerRowsOf(page))[0];
  await pickRow(page, firstRow.id);
  const local = await page.evaluate(`[...${q('invoice-customer-select')}.options].map((o) => o.value).find((v) => v !== '') ?? null`);
  assert.ok(local, 'the browser\'s own list offers a customer');
  await page.evaluate(`(() => { const s = ${q('invoice-customer-select')}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(local)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.waitFor(`!${q('picker-value')} && !!${q('picker-open')}`, 15_000, 'the local customer replaced the server one');
  const replaced = { limit: await has(page, 'invoice-server-limit'), local: await page.evaluate(`${q('invoice-customer-select')}?.value ?? null`) };

  // 6. The directory still lists the tenant's customers.
  await openDirectory(page);
  await waitList(page);
  const directory = await rowsOf(page);
  await quiet(page, 0);
  const made = await deltaSince(before);
  const mine = st.api.filter((r) => r.frameId === page.frameId);
  const others = mine.filter((r) => !isList(r) && !isSessionRead(r) && !isLogin(r)).map(apiLine);
  const lists = mine.filter(isList);
  const answered = lists.map((r) => r.replied?.text ?? '');
  record('SCB-15', { firstOpen, unfiltered: unfiltered.length, searched, searchReads, more: moreReads.map((r) => r.status), changeOpen: changeOpen.length, twinSearch, cancelOpen: cancelOpen.length, reopen: reopen.length, logins: mine.filter(isLogin).length, sessionReads: mine.filter(isSessionRead).length, lists: lists.length, made });

  assert.deepEqual(firstOpen, [' -> 200'], 'the picker opened on ONE unfiltered read');
  assert.deepEqual(unfiltered, all.slice(0, 50), 'the unfiltered first page: the tenant\'s first 50, in the server\'s order');
  assert.equal(searched, 'ready');
  assert.deepEqual(searchReads, [`?q=${word} -> 200`], 'the Search button sent ONE read of the search');
  assert.deepEqual(pageOne, expected.slice(0, 50), 'page one: the first 50 matches, both letter cases, in the server\'s order');
  assert.equal(moreReads.length, 1, 'one read for "Load more"');
  assert.match(moreReads[0].query, new RegExp(`^\\?q=${word}&cursor=[A-Za-z0-9_-]{44}$`), 'with the search\'s own continuation');
  assert.equal(moreReads[0].status, 200);
  assert.deepEqual(bothPages, expected, 'every match exactly once, in order');
  assert.equal(moreOffered, false, 'and no more after the last');
  assert.ok(!pageOne.some((r) => r.id === target.id), 'the bound customer was only on the second page');
  assert.deepEqual(bound, target, 'the draft names the database\'s customer: its id and its name');
  assert.equal(limitShown, SERVER_DRAFT_LIMIT, 'the server-customer limit is said');
  assert.equal(saveDisabled, true, 'Generate Invoice stays disabled');
  assert.equal(localWhileServer, '', 'no local customer beside the server one');
  assert.deepEqual(changeOpen, [' -> 200'], 'Change opened on ONE unfiltered read');
  assert.equal(twinSearch, 'ready');
  assert.deepEqual(twinReads, [`?q=${encodeURIComponent(twin)} -> 200`], 'Enter sent ONE read of the search');
  assert.deepEqual(twinRows, twins, 'both identical names, in the server\'s order');
  assert.notEqual(twinRows[0].id, twinRows[1].id, 'two distinct customers');
  assert.deepEqual(twinBound, twins[1], 'the second of the two is bound, exactly');
  assert.deepEqual(cancelOpen, [' -> 200']);
  assert.equal(afterCancel, twins[1].id, 'Cancel keeps the binding');
  assert.deepEqual(removed, { limit: false, local: '' }, 'Remove: no customer at all');
  assert.deepEqual(reopen, [' -> 200']);
  assert.deepEqual(replaced, { limit: false, local }, 'the local customer is the draft\'s one customer');
  assert.deepEqual(directory, all.slice(0, 50), 'the directory still lists the tenant\'s customers');
  assert.deepEqual(others, [], 'only customer list reads, session reads and the sign-in: no write, no detail, no invoice route');
  assert.equal(lists.length, 8, 'eight list reads: four opens, two searches, one "Load more", the directory');
  assert.equal(mine.filter(isLogin).length, 1, 'ONE tenant login: the picker\'s first connect, reused after');
  assert.ok(lists.every((r) => r.status === 200 && r.body === ''), 'every list read answered 200');
  for (const f of [...foreign.map((c) => c.id), other]) assert.ok(!answered.some((t) => t.includes(f)), 'nothing of the other tenant is ever answered');
  assert.deepEqual(made, { ...NOTHING, U: 0, T: 1 }, `the picker writes nothing; the one audit record is the one login's ${JSON.stringify(made)}`);
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, other, boss.uid, boss.id]);
  await assertNoLeak(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P10 — the picker as a modal over its host dialog (DA-178), and a new repair ticket names a server customer
// ---------------------------------------------------------------------------------------------------------------------

/** RepairTickets.tsx's SERVER_REPAIR_LIMIT_TEXT (a literal, as SERVER_DRAFT_LIMIT: this file loads against older trees). */
const SERVER_REPAIR_LIMIT = "This ticket uses a customer saved on the server. Creating a repair ticket for a server customer isn't available yet, so this ticket can't be created. To create it here, type the customer's name or choose a customer from this browser's list instead.";
/**
 * Whether a click at `selector`'s centre lands on it: the browser's own hit test, which is what a user's click (and
 * page.click) meets — a picker stacked under its host dialog's layer answers false.
 */
const onTop = (page, selector) => page.evaluate(`(() => {
  const n = document.querySelector(${JSON.stringify(selector)});
  if (n === null) return false;
  n.scrollIntoView({ block: 'center', inline: 'center' });
  const r = n.getBoundingClientRect();
  return n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
})()`);
/** The picker is open and every other child of <body> — the app's #root among them — is inert. */
const behindInert = (page) => page.evaluate(`(() => {
  const d = ${q('picker-dialog')};
  const rest = [...document.body.children].filter((n) => !n.contains(d));
  return d !== null && rest.some((n) => n.id === 'root') && rest.every((n) => n.inert === true);
})()`);
const rootInert = (page) => page.evaluate(`document.getElementById('root')?.hasAttribute('inert') === true`);
const focusedId = (page) => page.evaluate(`document.activeElement?.dataset?.testid ?? document.activeElement?.tagName ?? null`);
/**
 * Where focus is: a test id, a row's Select as `select:<its row's place>`, prefixed `outside:` when it is not inside the
 * picker's dialog; `ring` is :focus-visible with an outline the browser draws (a style, not 'none', at least 2px wide).
 */
const FOCUS_AT = `(() => {
  const n = document.activeElement, d = ${q('picker-dialog')};
  const id = n?.dataset?.testid ?? n?.tagName ?? 'none';
  const rows = [...document.querySelectorAll(${JSON.stringify(by('picker-row'))})];
  const name = id === 'picker-select' ? 'select:' + rows.indexOf(n.closest(${JSON.stringify(by('picker-row'))})) : id;
  const s = n ? getComputedStyle(n) : null;
  return { at: d !== null && d.contains(n) ? name : 'outside:' + name, ring: !!s && n.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
})()`;
/** The repair tickets the page lists, by number, in order (the shop's own local list: no server holds tickets). */
const ticketsOf = (page) => page.evaluate(`[...document.querySelectorAll('tbody > tr')].map((tr) => tr.querySelector('td span')?.textContent.trim() ?? tr.textContent.trim())`);
/** The ticket form's Create Ticket: disabled, and what describes it. */
const repairCreate = (page) => page.evaluate(`(() => { const b = ${q('repair-create-save')}; return b === null ? null : { disabled: b.disabled, describedBy: b.getAttribute('aria-describedby') }; })()`);
/** Open New Ticket on /repairs and wait for its picker field; the form animates in, so wait for it to stand still. */
async function openTicketForm(page) {
  await page.waitFor(`!!${q('repair-create-open')}`, 30_000, 'the Repairs page offers New Ticket');
  await page.click(by('repair-create-open'));
  await page.waitFor(`!!${q('repair-create-dialog')} && !!${q('picker-field')}`, 15_000, 'the new ticket offers the server-customer picker');
  await still(page, 'repair-create-dialog');
}

/**
 * The picker driven from the keyboard alone, inside a host dialog whose `host` test id must survive Escape. Focus starts
 * on the control just before "Select a server customer" (the caller puts it there). Answers what was seen; asserts
 * nothing, so the entry tree's run records its whole "before" picture.
 */
async function keyboardJourney(page, host, rows) {
  await page.press('Tab');
  const entry = await focusedId(page);
  let from = st.api.length;
  await page.press('Enter');
  await page.waitFor(`!!${q('picker-dialog')}`, 15_000, 'Enter opened the picker');
  const firstOpen = await pickerSettled(page, from);
  const firstReads = readLines(sentBy(page, isList, from));
  const opened = await page.waitFor(`document.activeElement === ${q('picker-search-input')}`, 15_000, 'focus on the search box').catch(() => false);
  const shown = await pickerRowsOf(page);
  const moreOffered = await has(page, 'picker-load-more');
  const inertOpen = await behindInert(page);
  const cycle = [];
  for (const shift of [false, false, false, false, false, false, true, true, true]) {
    await page.press('Tab', { shift });
    cycle.push(await page.evaluate(FOCUS_AT));
  }
  await page.press('Escape');
  await page.waitFor(`!${q('picker-dialog')}`, 15_000, 'Escape closed the picker');
  await page.waitFor(`document.activeElement === ${q('picker-open')}`, 15_000, 'focus back on the opener').catch(() => {});
  const escaped = { host: await has(page, host), bound: await has(page, 'picker-value'), focus: await focusedId(page), inert: await rootInert(page) };

  from = st.api.length;
  await page.press('Enter');
  await page.waitFor(`!!${q('picker-dialog')}`, 15_000, 'Enter reopened the picker');
  const secondOpen = await pickerSettled(page, from);
  const secondReads = readLines(sentBy(page, isList, from));
  const reopened = await page.waitFor(`document.activeElement === ${q('picker-search-input')}`, 15_000, 'focus on the search box').catch(() => false);
  for (let i = 0; i < 3; i += 1) await page.press('Tab');
  const onSelect = await page.evaluate(FOCUS_AT);
  await page.press('Enter');
  await page.waitFor(`!${q('picker-dialog')} && ${q('picker-value')}?.dataset.id === ${JSON.stringify(rows[1].id)}`, 15_000, `Enter on a Select bound ${rows[1].id}`);
  await page.waitFor(`document.activeElement === ${q('picker-change')}`, 15_000, 'focus on Change').catch(() => {});
  const picked = { host: await has(page, host), id: await boundId(page), name: await textOf(page, 'picker-value-name'), focus: await focusedId(page), inert: await rootInert(page) };
  return { entry, firstOpen, firstReads, opened: opened === true, shown, moreOffered, inertOpen, cycle, escaped, secondOpen, secondReads, reopened: reopened === true, onSelect, picked };
}
/** The exact stops keyboardJourney's Tab x6, Shift+Tab x3 meets over three rows (Clear is disabled while nothing is typed). */
const KEYBOARD_CYCLE = ['picker-search-submit', 'select:0', 'select:1', 'select:2', 'picker-cancel', 'picker-search-input', 'picker-cancel', 'select:2', 'select:1'];
/** keyboardJourney's observations against `rows` (the tenant's three customers, in the server's order). */
function assertKeyboardJourney(seen, rows, host) {
  assert.equal(seen.entry, 'picker-open', 'Tab from the control before it reaches "Select a server customer"');
  assert.equal(seen.firstOpen, 'ready');
  assert.deepEqual(seen.firstReads, [' -> 200'], 'Enter opened the picker on ONE unfiltered read');
  assert.equal(seen.opened, true, 'the opened picker holds focus on its search box');
  assert.deepEqual(seen.shown, rows, 'the three customers, in the server\'s order');
  assert.equal(seen.moreOffered, false, 'no "Load more" on a single page');
  assert.equal(seen.inertOpen, true, 'while the picker is open every other <body> child, #root among them, is inert');
  assert.deepEqual(seen.cycle.map((s) => s.at), KEYBOARD_CYCLE, 'Tab and Shift+Tab wrap inside the picker, never leaving it');
  assert.deepEqual(seen.cycle.filter((s) => !s.ring).map((s) => s.at), [], 'every stop shows a visible focus ring');
  assert.deepEqual(seen.escaped, { host: true, bound: false, focus: 'picker-open', inert: false }, `Escape closed the picker alone (${host} stays), nothing bound, #root live again, focus on the opener`);
  assert.equal(seen.secondOpen, 'ready');
  assert.deepEqual(seen.secondReads, [' -> 200'], 'Enter reopened it on ONE unfiltered read');
  assert.equal(seen.reopened, true, 'the reopened picker holds focus on its search box');
  assert.deepEqual(seen.onSelect, { at: 'select:1', ring: true }, 'Tab x3 reaches the second row\'s Select, with a focus ring');
  assert.deepEqual(seen.picked, { host: true, id: rows[1].id, name: rows[1].name, focus: 'picker-change', inert: false }, 'Enter on it bound that row exactly; focus on Change; #root live again');
}
/** The wire and the database for one picker case: list GETs only (each unfiltered, 200), session reads, ONE login, nothing written. */
async function assertPickerWire(page, before, lists, tenant, who, foreign = []) {
  await quiet(page, 0);
  const made = await deltaSince(before);
  const mine = st.api.filter((r) => r.frameId === page.frameId);
  const others = mine.filter((r) => !isList(r) && !isSessionRead(r) && !isLogin(r)).map(apiLine);
  const reads = mine.filter(isList);
  const answered = reads.map((r) => r.replied?.text ?? '');
  assert.deepEqual(others, [], 'only customer list reads, session reads and the sign-in: no write, no detail, no invoice or repair route');
  assert.ok(!mine.some((r) => /repair|ticket|invoice/i.test(r.path)), 'no request names a repair, ticket or invoice');
  assert.equal(reads.length, lists, `${lists} list reads, one per opening`);
  assert.ok(reads.every((r) => r.status === 200 && r.body === '' && r.query === ''), 'every list read unfiltered and answered 200');
  assert.equal(mine.filter(isLogin).length, 1, 'ONE tenant login: the picker\'s first connect, reused after');
  for (const f of foreign) assert.ok(!answered.some((t) => t.includes(f)), 'nothing of the other tenant is ever answered');
  assert.deepEqual(made, { ...NOTHING, U: 0, T: 1 }, `the picker writes nothing; the one audit record is the one login's ${JSON.stringify(made)}`);
  assertNoSelector(st.api.filter((r) => r.path.startsWith(CUSTOMERS)), [tenant, who.uid, who.id, ...foreign]);
  await assertNoLeak(page);
  return { made, logins: mine.filter(isLogin).length, sessionReads: mine.filter(isSessionRead).length, lists: reads.length };
}

scenario('SCB-16', 'REPAIR DRAFT PICKER (M7A-CUSTOMERS-P10, DA-177) — "New Ticket" opens a form whose picker binds a server customer by its database id above the z-[110] form; the limit describes Create Ticket, which stays disabled and creates nothing when pressed; Change then Cancel keeps it; Remove clears it; a typed name and a local pick replace it and a server pick replaces the local one; closing the form drops it; nothing is written and no other tenant\'s customer is ever answered', async () => {
  const { tenant, boss } = await shop('c16');
  const other = await newTenant('c16-other');
  await seedCustomers(tenant, Array.from({ length: 5 }, (_, i) => `M7SCB c16 Godwit ${i} ${SUFFIX}`));
  const foreign = await seedCustomers(other, Array.from({ length: 3 }, (_, i) => `M7SCB c16 Godwit ${i} ${SUFFIX}`));
  const all = await customersOf(tenant);
  const target = all[3];
  const second = all[1];
  const before = await counts();
  const page = await openPage();
  await signIn(page, boss);
  await go(page, '/repairs');
  await page.waitFor(`!!${q('repair-create-open')}`, 30_000, 'the Repairs page offers New Ticket');
  await page.settle();
  const tickets = await ticketsOf(page);
  await openTicketForm(page);
  // Device and issue first: from here only the customer can keep Create Ticket disabled.
  await page.fill(by('repair-device'), `M7SCB c16 device ${SUFFIX}`);
  await page.fill(by('repair-issue'), `M7SCB c16 issue ${SUFFIX}`);

  // 1. A server customer is bound; the limit describes Create Ticket, which stays disabled and creates nothing.
  const firstOpen = await openPicker(page, 'picker-open');
  const shown = await pickerRowsOf(page);
  const inertOpen = await behindInert(page);
  const selectOnTop = await onTop(page, `${by('picker-row')}[data-id="${target.id}"] ${by('picker-select')}`);
  await pickRow(page, target.id);
  const bound = { id: await boundId(page), name: await textOf(page, 'picker-value-name') };
  const whileServer = {
    create: await repairCreate(page),
    limit: await textOf(page, 'repair-server-limit'),
    limitId: await page.evaluate(`${q('repair-server-limit')}?.id ?? null`),
    search: await page.evaluate(`${q('repair-customer-search')}?.value ?? null`),
    inert: await rootInert(page),
  };
  await page.click(by('repair-create-save'));
  await page.settle();
  const pressed = { form: await has(page, 'repair-create-dialog'), bound: await boundId(page), tickets: await ticketsOf(page) };

  // 2. Change, then the picker's own Cancel: the binding stays, the form stays.
  const changeOpen = await openPicker(page, 'picker-change');
  const cancelOnTop = await onTop(page, by('picker-cancel'));
  await page.click(by('picker-cancel'));
  await page.waitFor(`!${q('picker-dialog')}`, 15_000, 'the picker closed');
  const afterCancel = { bound: await boundId(page), form: await has(page, 'repair-create-dialog') };

  // 3. Remove: no server customer, the picker is offered again.
  await page.click(by('picker-remove'));
  await page.waitFor(`!${q('picker-value')} && !!${q('picker-open')}`, 15_000, 'the server customer removed');
  const removed = { limit: await has(page, 'repair-server-limit'), create: await repairCreate(page) };

  // 4. A typed name (a walk-in), then a pick from the browser's own list: Create Ticket is offered (the control).
  const typedOpen = await openPicker(page, 'picker-open');
  await pickRow(page, target.id);
  await retype(page, 'repair-customer-search', 'Alex');
  await page.waitFor(`!${q('picker-value')} && !!${q('picker-open')}`, 15_000, 'the typed name replaced the server customer');
  const typed = { limit: await has(page, 'repair-server-limit'), create: await repairCreate(page) };
  const localPick = `[...${q('repair-create-dialog')}.querySelectorAll('button')].find((b) => b.querySelector('p')?.textContent.trim() === 'Alexander Wright')`;
  await page.waitFor(`!!${localPick}`, 15_000, 'the browser\'s own list offers Alexander Wright');
  await page.evaluate(`${localPick}.setAttribute('data-p10', 'local-customer')`);
  await page.click('[data-p10="local-customer"]');
  await page.waitFor(`${q('repair-customer-search')}?.value === 'Alexander Wright'`, 15_000, 'the local customer chosen');
  const local = { bound: await has(page, 'picker-value'), open: await has(page, 'picker-open'), limit: await has(page, 'repair-server-limit'), create: await repairCreate(page) };

  // 5. A server customer chosen after a local one replaces it: the box empties, Create is off again.
  const replaceOpen = await openPicker(page, 'picker-open');
  await pickRow(page, second.id);
  const replaced = { search: await page.evaluate(`${q('repair-customer-search')}?.value ?? null`), limit: await textOf(page, 'repair-server-limit'), create: await repairCreate(page) };

  // 6. Cancel the form, open New Ticket again: no server customer survives the draft.
  await page.click(by('repair-create-cancel'));
  await page.waitFor(`!${q('repair-create-dialog')}`, 15_000, 'the new ticket form closed');
  await openTicketForm(page);
  await page.settle();
  const reopened = {
    bound: await has(page, 'picker-value'), open: await has(page, 'picker-open'), notice: await has(page, 'picker-notice'),
    limit: await has(page, 'repair-server-limit'), search: await page.evaluate(`${q('repair-customer-search')}?.value ?? null`), create: await repairCreate(page),
  };
  const ticketsAfter = await ticketsOf(page);
  const wire = await assertPickerWire(page, before, 4, tenant, boss, [other, ...foreign.map((c) => c.id)]);
  record('SCB-16', { firstOpen, changeOpen, typedOpen, replaceOpen, selectOnTop, cancelOnTop, inertOpen, tickets: tickets.length, ...wire });

  assert.deepEqual(firstOpen, [' -> 200'], 'the picker opened on ONE unfiltered read');
  assert.deepEqual(shown, all, 'the tenant\'s five customers, in the server\'s order');
  assert.equal(inertOpen, true, 'the ticket form behind the open picker is inert');
  assert.equal(selectOnTop, true, 'the picker is above the ticket form: a click on its Select lands on it');
  assert.deepEqual(bound, target, 'the ticket names the database\'s customer: its id and its name');
  assert.deepEqual(whileServer, {
    create: { disabled: true, describedBy: 'repair-server-limit' }, limit: SERVER_REPAIR_LIMIT, limitId: 'repair-server-limit', search: '', inert: false,
  }, 'the limit is said and describes Create Ticket, which stays disabled; the local box is empty; the form is live again');
  assert.deepEqual(pressed, { form: true, bound: target.id, tickets }, 'pressing the disabled Create makes no ticket and keeps the draft');
  assert.deepEqual(changeOpen, [' -> 200'], 'Change opened on ONE unfiltered read');
  assert.equal(cancelOnTop, true, 'the picker\'s Cancel is above the ticket form');
  assert.deepEqual(afterCancel, { bound: target.id, form: true }, 'the picker\'s Cancel keeps the binding and the form');
  assert.deepEqual(removed, { limit: false, create: { disabled: true, describedBy: null } }, 'Remove: no customer at all, no limit');
  assert.deepEqual(typedOpen, [' -> 200']);
  assert.deepEqual(typed, { limit: false, create: { disabled: false, describedBy: null } }, 'a typed name replaces the server customer and Create is offered');
  assert.deepEqual(local, { bound: false, open: true, limit: false, create: { disabled: false, describedBy: null } }, 'a local customer is the ticket\'s one customer and Create is offered');
  assert.deepEqual(replaceOpen, [' -> 200']);
  assert.deepEqual(replaced, { search: '', limit: SERVER_REPAIR_LIMIT, create: { disabled: true, describedBy: 'repair-server-limit' } }, 'a server pick replaces the local customer');
  assert.deepEqual(reopened, { bound: false, open: true, notice: false, limit: false, search: '', create: { disabled: true, describedBy: null } }, 'a new form holds no server customer from the closed one');
  assert.deepEqual(ticketsAfter, tickets, 'no ticket was created');
});

scenario('SCB-17', 'PICKER KEYBOARD, INVOICE DRAFT (M7A-CUSTOMERS-P10, DA-178) — from the invoice draft, Tab reaches "Select a server customer" and Enter opens the picker on its search box with the page behind inert; Tab and Shift+Tab wrap exactly over its enabled controls with a visible focus ring; Escape closes the picker alone and returns focus; a Select reached by Tab binds on Enter, focus on Change; nothing is written', async () => {
  const { tenant, boss } = await shop('c17');
  await seedCustomers(tenant, Array.from({ length: 3 }, (_, i) => `M7SCB c17 Avocet ${i} ${SUFFIX}`));
  const rows = await customersOf(tenant);
  const before = await counts();
  const page = await openPage();
  await signIn(page, boss);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('invoice-create-open')}`, 30_000, 'the Invoices page offers Create Invoice');
  await page.click(by('invoice-create-open'));
  await page.waitFor(`!!${q('picker-open')}`, 15_000, 'the draft offers the server-customer picker');
  await still(page, 'picker-open');
  // The local select is the control before the field (focused by script: a click would open the native list).
  await page.evaluate(`${q('invoice-customer-select')}.focus()`);
  const seen = await keyboardJourney(page, 'invoice-create-save', rows);
  const save = await page.evaluate(`${q('invoice-create-save')}?.disabled === true`);
  const wire = await assertPickerWire(page, before, 2, tenant, boss);
  record('SCB-17', { ...seen, shown: seen.shown.length, ...wire });

  assertKeyboardJourney(seen, rows, 'invoice-create-save');
  assert.equal(await textOf(page, 'invoice-server-limit'), SERVER_DRAFT_LIMIT, 'the server-customer limit is said');
  assert.equal(save, true, 'Generate Invoice stays disabled');
});

scenario('SCB-18', 'PICKER KEYBOARD, REPAIR DRAFT (M7A-CUSTOMERS-P10, DA-178) — the same keyboard journey inside the z-[110] ticket form: Tab from the customer box reaches the picker\'s opener, Enter opens it with the form inert, the wrap is exact both ways with a focus ring, Escape closes the picker alone (the form stays), a Select reached by Tab binds on Enter, focus on Change, and Create Ticket stays off with the limit as its description; nothing is written', async () => {
  const { tenant, boss } = await shop('c18');
  await seedCustomers(tenant, Array.from({ length: 3 }, (_, i) => `M7SCB c18 Avocet ${i} ${SUFFIX}`));
  const rows = await customersOf(tenant);
  const before = await counts();
  const page = await openPage();
  await signIn(page, boss);
  await go(page, '/repairs');
  await openTicketForm(page);
  await page.click(by('repair-customer-search')); // empty: no local list opens, so Tab goes on to the picker's opener
  const seen = await keyboardJourney(page, 'repair-create-dialog', rows);
  const create = await repairCreate(page);
  const limit = await textOf(page, 'repair-server-limit');
  const wire = await assertPickerWire(page, before, 2, tenant, boss);
  record('SCB-18', { ...seen, shown: seen.shown.length, ...wire });

  assertKeyboardJourney(seen, rows, 'repair-create-dialog');
  assert.equal(limit, SERVER_REPAIR_LIMIT, 'the server-customer limit is said');
  assert.deepEqual(create, { disabled: true, describedBy: 'repair-server-limit' }, 'Create Ticket stays disabled, described by the limit');
});

// ---------------------------------------------------------------------------------------------------------------------
// M5-INVOICES-AUTH-P1: the Invoices LEVEL editor, on the real tenant entry and database. Only the level is server-backed.
// ---------------------------------------------------------------------------------------------------------------------

const INV = 'server-invoice-level';
const invReady = (page) => page.waitFor(`document.querySelector('[data-testid="server-invoice-levels-state"]')?.textContent.trim() === 'Ready'`, 30_000, 'the Invoices panel is Ready');
/** What an Invoices read on exactly this session answers now, from outside the browser: { status, roles by id }. */
async function invoiceLevels(session) {
  const res = await call('GET', INVOICES_READ, { session });
  return { status: res.status, ...(res.status === 200 ? { roles: Object.fromEntries(JSON.parse(res.text).roles.map((r) => [r.roleId, r])) } : {}) };
}

scenario('SRL-13', 'INVOICES LEVEL — the Permissions tab holds a labelled, server-saved Invoices level beside Customers: defaults, an owner save held at its read-back then Saved, the exact PUT, Customers untouched, a reload and a second browser see it, the grid row points to it', async () => {
  const { tenant, boss } = await shop('s13');
  const session = await directLogin(boss);
  const page = await ownerPanel(boss);
  await invReady(page);
  const customersWas = await domainState(tenant, 'sales_staff', 'customers');
  assert.deepEqual(await domainState(tenant, 'sales_staff', 'invoices'), { level: null, version: null, audits: [] }, 'no Invoices row, version or audit yet');
  // The panel says what it is: the level decides server drafts (M7B-INVOICES-P1); other invoices stay in this browser, unchecked.
  const copy = await page.evaluate(`(() => {
    const section = document.querySelector('[data-testid="server-invoice-levels"]');
    return { heading: document.getElementById(section.getAttribute('aria-labelledby'))?.textContent.trim(), text: section.textContent };
  })()`);
  assert.equal(copy.heading, 'Server-saved Invoices level');
  assert.ok(copy.text.includes('only the Invoices level of the built-in roles') && copy.text.includes('decide who may save, list, open and edit server drafts at a store')
    && copy.text.includes('Other invoices are still saved in this browser and are not checked by the server'), copy.text);
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid="server-customer-levels"]').length`), 1, 'the Customers panel is still there, once');
  assert.equal(await page.evaluate(`(() => { const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); return ids.length === new Set(ids).size; })()`), true, 'no id is used twice with both panels mounted');
  assert.equal((await rowOf(page, 'store_owner', INV))?.text?.includes('Full — fixed'), true, 'the store owner row is fixed');
  await waitRow(page, 'manager', 'full', 'Default', INV);
  await waitRow(page, 'technician', 'view', 'Default', INV);
  await waitRow(page, 'sales_staff', 'create', 'Default', INV);
  assert.equal(await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="${INV}-save-sales_staff"]');
    return button.disabled && document.getElementById(button.getAttribute('aria-describedby'))?.textContent.trim();
  })()`), 'To save, choose a new level and enter a reason of 10–500 characters.', 'Save is disabled and says why');
  // The local grid's built-in Invoices cells point to the server section, as the Customers row does.
  const pointer = await page.evaluate(`(() => {
    const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent.includes('Module / Action'));
    return [...table.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim().startsWith('Invoices'))?.querySelector('td')?.textContent ?? null;
  })()`);
  assert.match(pointer ?? '', /Built-in roles: set in Server-saved Invoices level above/, "the grid's Invoices row points to the server panel");

  await draft(page, 'sales_staff', 'view', 'Sales staff may only view invoices', INV);
  const before = await counts();
  // The read-back after the PUT is held: the PUT has committed and the row still does not say "Saved".
  const readBack = gate((r) => isInvRead(r) && r.frameId === page.frameId && st.api.some(isInvPut), 'request');
  const from = await clickSave(page, 'sales_staff', INV);
  assert.ok(await Promise.race([readBack.reached, delay(15_000).then(() => null)]), 'a read-back follows the PUT');
  assert.deepEqual(st.api.filter(isInvPut).map((r) => r.status), [200], 'the PUT committed first');
  // No fixed wait: the row is waited into its transitional state, which it must still be in while the read-back is held.
  await page.waitFor(`document.querySelector('[data-testid="${INV}-status-sales_staff"]')?.dataset.status === 'saving'`, 10_000, 'the row is saving while its read-back is held');
  const whileHeld = note('status while the read-back is held', await statusOf(page, 'sales_staff', INV));
  assert.equal(whileHeld, 'Saving to the server…', 'the in-progress line while the read-back is held');
  assert.ok(!saved(whileHeld), `not "Saved" before the read-back: ${whileHeld}`);
  readBack.release();
  assert.ok(saved(await settle(page, 'sales_staff', from, INV)), 'Saved after the read-back');
  await waitRow(page, 'sales_staff', 'view', 'Custom', INV);
  const [put] = st.api.filter(isInvPut);
  const sent = JSON.parse(put.body);
  assert.deepEqual(Object.keys(sent), ['roleId', 'domain', 'level', 'reason', 'expectedTenant', 'expectedVersion'], 'the six fields, in the fixed order');
  assert.deepEqual([sent.roleId, sent.domain, sent.level, sent.expectedVersion], ['sales_staff', 'invoices', 'view', 0]);
  assert.ok(!st.api.some(isPut) || st.api.filter(isPut).every((r) => r.body.includes('"domain":"invoices"')), 'no Customers PUT left the page');
  // Customers is untouched: the page's Customers panel and the server's Customers answer.
  await waitRow(page, 'sales_staff', 'create', 'Default');
  const customers = JSON.parse((await call('GET', ROLE_LEVELS, { session })).text).roles.find((r) => r.roleId === 'sales_staff');
  assert.deepEqual([customers.level, customers.source, customers.version], ['create', 'default', 0], 'the Customers level did not move');
  assert.equal((await invoiceLevels(session)).roles.sales_staff.level, 'view', 'the server holds the Invoices level');
  assert.equal((await invoiceLevels(session)).roles.sales_staff.version, 1);
  // The database: one edit (its audit, completion and idempotency record, no customer), the Invoices row and version, the
  // one tenant-scope audit naming it, and the Customers row, version and audits exactly as before.
  await assertDelta(before, EDIT, 'the Invoices save');
  assert.deepEqual(note('Invoices state', await domainState(tenant, 'sales_staff', 'invoices')),
    { level: 'view', version: 1, audits: [['role_sales_staff_invoices_to_view', 'Sales staff may only view invoices']] }, 'the Invoices level, version 1, one audit');
  assert.deepEqual(await domainState(tenant, 'sales_staff', 'customers'), customersWas, 'the Customers row, version and audits did not move');

  await page.goto(`${SHOP}/employees`, 30_000);
  await openPermissions(page);
  await invReady(page);
  await waitRow(page, 'sales_staff', 'view', 'Custom', INV);
  const second = await ownerPanel(boss);
  await invReady(second);
  await waitRow(second, 'sales_staff', 'view', 'Custom', INV);
  await waitRow(second, 'sales_staff', 'create', 'Default'); // and Customers there is still its default
  await assertNoLeak(page);
});

scenario('SRL-14', 'INVOICES COMPETING EDIT — a second browser saves first; the first browser\'s older draft is refused (409 write_conflict, nothing written), shown as a conflict with the server\'s level, and only Reapply and a new Save (a new key) land it; Customers is untouched', async () => {
  const { tenant, boss } = await shop('s14');
  const session = await directLogin(boss);
  const customersWas = await domainState(tenant, 'technician', 'customers');
  const first = await ownerPanel(boss);
  await invReady(first);
  const second = await ownerPanel(boss);
  await invReady(second);
  await waitRow(first, 'technician', 'view', 'Default', INV);
  await waitRow(second, 'technician', 'view', 'Default', INV);

  await draft(first, 'technician', 'edit', 'Technicians edit invoices now', INV); // made against version 0, not yet saved
  await draft(second, 'technician', 'none', 'Technicians lose invoices access', INV);
  assert.ok(saved(await save(second, 'technician', INV)), 'the second browser saved None first');
  assert.equal((await invoiceLevels(session)).roles.technician.level, 'none');
  const won = await domainState(tenant, 'technician', 'invoices');
  assert.deepEqual(won, { level: 'none', version: 1, audits: [['role_technician_invoices_to_none', 'Technicians lose invoices access']] }, 'the second browser\'s edit');

  const beforeLoss = await counts();
  const lost = await save(first, 'technician', INV);
  assert.equal(lost, SAY.lostRace('none'), `the stale draft is a conflict: ${lost}`);
  const puts = st.api.filter((r) => isInvPut(r) && r.frameId === first.frameId);
  assert.deepEqual(puts.map(answered), ['409 write_conflict'], 'the older draft was refused by the version precondition');
  const now = await invoiceLevels(session);
  assert.deepEqual([now.roles.technician.level, now.roles.technician.version], ['none', 1], 'nothing was written by the refused save');
  await assertDelta(beforeLoss, { ...REFUSED, L: 1 }, 'the losing save wrote nothing but its lease');
  assert.deepEqual(await domainState(tenant, 'technician', 'invoices'), won, 'the 409 changed no Invoices row, version or audit');
  assert.equal(await page_conflict(first), 'The server now has None. Your unsaved choice: Edit.');
  assert.equal(await first.evaluate(`document.querySelector('[data-testid="${INV}-save-technician"]').disabled`), true, 'Save stays off until the conflict is resolved');
  assert.equal((await rowOf(first, 'technician', INV)).level, LABELS.none, 'the shown level is the server\'s, never the draft');
  await first.click(`[data-testid="${INV}-reapply-technician"]`);
  await first.waitFor(`document.querySelector('[data-testid="${INV}-save-technician"]')?.disabled === false`, 10_000, 'Save enabled after Reapply');
  const beforeReapply = await counts();
  assert.ok(saved(await save(first, 'technician', INV)), 'Reapply, then a new Save, lands it');
  const keys = st.api.filter((r) => isInvPut(r) && r.frameId === first.frameId).map((r) => r.headers['idempotency-key']);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'a changed request gets a new key');
  const done = await invoiceLevels(session);
  assert.deepEqual([done.roles.technician.level, done.roles.technician.version], ['edit', 2]);
  await assertDelta(beforeReapply, EDIT, 'the save after Reapply');
  assert.deepEqual(note('Invoices state', await domainState(tenant, 'technician', 'invoices')),
    { level: 'edit', version: 2, audits: [...won.audits, ['role_technician_invoices_to_edit', 'Technicians edit invoices now']] }, 'exactly one more audit, version 2');
  assert.deepEqual(await domainState(tenant, 'technician', 'customers'), customersWas, 'the Customers row, version and audits never moved');
  const customers = JSON.parse((await call('GET', ROLE_LEVELS, { session })).text).roles.find((r) => r.roleId === 'technician');
  assert.deepEqual([customers.level, customers.version], ['view', 0], 'the Customers level never moved');
  await waitRow(first, 'technician', 'view', 'Default'); // the Customers panel on the same page
});
const page_conflict = (page) => page.evaluate(`document.querySelector('[data-testid="${INV}-conflict-technician"] p')?.textContent.trim() ?? null`);

// M5-INVOICES-AUTH-P1-R1 (AC-10) — a role-level save never re-sends a PUT on its own. One case per domain.
const LOST_REPLY = Object.freeze({
  customers: { id: 'SRL-15', prefix: 'server-level', ready: (page) => waitState(page, 'Ready'), isReadBack: isRead },
  invoices: { id: 'SRL-16', prefix: INV, ready: invReady, isReadBack: isInvRead },
});
/** Tones a held row may show before the owner presses Save again: never 'saved', never a not-saved tone. */
const HELD_TONES = new Set(['idle', 'saving', 'confirm']);
for (const [domain, { id, prefix, ready, isReadBack }] of Object.entries(LOST_REPLY)) {
  scenario(id, `LOST PUT REPLY, ${domain.toUpperCase()} — the PUT commits but its answer never reaches the page: exactly ONE PUT and one change (row, version 1, one audit), the row "Not confirmed yet", never "Saved" or "Not saved", and NO automatic re-send; Save again sends one more PUT with the SAME key and byte-identical body, replayed (nothing written), then "Saved"`, async () => {
    const { tenant, boss } = await shop(`s${id.slice(4)}`);
    const reason = `Lost reply check for ${domain} level`;
    const page = await ownerPanel(boss);
    await ready(page);
    await waitRow(page, 'sales_staff', 'create', 'Default', prefix);
    assert.deepEqual(await domainState(tenant, 'sales_staff', domain), { level: null, version: null, audits: [] }, 'no row, version or audit yet');
    // EVERY PUT this page sent, whatever its domain: a re-send under any domain is a re-send.
    const pagePuts = () => st.api.filter((r) => isPut(r) && r.frameId === page.frameId);
    const isMyPut = (r) => isPut(r) && r.frameId === page.frameId && JSON.parse(r.body).domain === domain;
    const myReadAfter = (i) => st.api.slice(i).filter((r) => isReadBack(r) && r.frameId === page.frameId);
    await draft(page, 'sales_staff', 'view', reason, prefix);
    // Every data-status the row takes from the click on (the element may be replaced: observe the whole document).
    await page.evaluate(`(() => {
      const sel = '[data-testid="${prefix}-status-sales_staff"]';
      const seen = window.__srlTones = [];
      const look = () => { const t = document.querySelector(sel)?.dataset.status ?? null; if (seen.at(-1) !== t) seen.push(t); };
      look();
      window.__srlObserver = new MutationObserver(look);
      window.__srlObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'], characterData: true });
    })()`);
    const before = await counts();
    let lost = 0;
    let first;
    let barrier;
    try {
      st.lose = (rec, phase) => phase === 'response' && isMyPut(rec) && lost++ === 0;
      const from = await clickSave(page, 'sales_staff', prefix);
      // Settled: every request the save sent is answered (its read-back included), the row no longer busy, its line not a
      // transitional one — no fixed wait.
      first = await settle(page, 'sales_staff', from, prefix);
      // Stability barrier: an ordinary focus refresh, its read answered, and only then the PUTs are counted.
      barrier = st.api.length;
      await page.evaluate(`dispatchEvent(new Event('focus'))`);
      await page.waitFor(() => myReadAfter(barrier).some((r) => r.status !== null), 15_000, 'the focus refresh read was answered');
      await page.waitFor(async () => (await statusOf(page, 'sales_staff', prefix)) === first, 5_000, 'the row line is unchanged by the refresh').catch(() => {});
    } finally {
      st.lose = null;
    }
    const puts1 = pagePuts();
    const tones1 = await page.evaluate(`[...window.__srlTones]`);
    const afterLoss = { delta: await deltaSince(before), state: await domainState(tenant, 'sales_staff', domain) };
    const readBack = st.api.filter((r) => isReadBack(r) && r.frameId === page.frameId && puts1[0] && r.at > puts1[0].doneAt);
    const firstNow = await statusOf(page, 'sales_staff', prefix);
    record(id, {
      phase: 'lost reply, before any user action', domain, status: first, statusAfterBarrier: firstNow, tones: tones1,
      puts: puts1.map(apiLine), readBacks: readBack.map(answered), ...afterLoss.delta, version: afterLoss.state.version, audits: afterLoss.state.audits.length,
    });
    assert.deepEqual(puts1.map((r) => `${JSON.parse(r.body).domain} ${r.status} ${r.lost ?? 'delivered'}`), [`${domain} 200 response`],
      `exactly ONE PUT left the page, committed, its answer lost — no automatic re-send (API: ${st.api.map(apiLine).join('; ')})`);
    assert.deepEqual(afterLoss.state, { level: 'view', version: 1, audits: [[`role_sales_staff_${domain}_to_view`, reason]] }, 'one change: the level, version 1, one audit');
    assert.deepEqual(afterLoss.delta, { C: 0, A: 0, E: 1, U: 0, K: 1, L: 1, T: 1 }, 'exactly one edit (EDIT, and nothing unlisted)');
    assert.ok(readBack.length >= 1 && readBack.every((r) => r.status === 200), 'the page read the level back after the PUT');
    assert.equal(first, SAY.notConfirmed('view'), 'held: "Not confirmed yet", never "Saved" or "Not saved"');
    assert.equal(firstNow, first, 'still held after the refresh');
    assert.ok(tones1.every((t) => t === null || HELD_TONES.has(t)) && tones1.at(-1) === 'confirm', `the row never showed a saved or not-saved tone: ${tones1.join(' > ')}`);

    const mid = await counts();
    const again = await clickSave(page, 'sales_staff', prefix);
    const second = await settle(page, 'sales_staff', again, prefix);
    await page.evaluate(`window.__srlObserver?.disconnect()`);
    const puts2 = pagePuts();
    const afterReplay = { delta: await deltaSince(mid), state: await domainState(tenant, 'sales_staff', domain) };
    const replay = puts2[1];
    const readBack2 = replay ? st.api.filter((r) => isReadBack(r) && r.frameId === page.frameId && r.at > replay.doneAt) : [];
    record(id, {
      phase: 'Save pressed again', domain, status: second, puts: puts2.map(apiLine), readBacks: readBack2.map(answered),
      sameKey: replay?.headers['idempotency-key'] === puts1[0].headers['idempotency-key'], sameBody: replay?.body === puts1[0].body,
      replayed: replay?.replied?.headers['idempotent-replayed'] ?? null, ...afterReplay.delta, version: afterReplay.state.version, audits: afterReplay.state.audits.length,
    });
    assert.equal(puts2.length, 2, `exactly one more PUT, on the click (${puts2.map(apiLine).join('; ')})`);
    assert.ok(st.api.indexOf(replay) >= again, 'sent only after the click');
    assert.equal(JSON.parse(replay.body).domain, domain);
    assert.equal(replay.headers['idempotency-key'], puts1[0].headers['idempotency-key'], 'the SAME Idempotency-Key');
    assert.equal(replay.body, puts1[0].body, 'the byte-identical body');
    assert.deepEqual([replay.status, replay.replied.headers['idempotent-replayed']], [200, 'true'], 'answered as a replay');
    assert.deepEqual(afterReplay.delta, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0, T: 0 }, 'the replay wrote nothing (NOTHING, and nothing unlisted)');
    assert.deepEqual(afterReplay.state, afterLoss.state, 'no second version increment, no duplicate audit');
    assert.ok(readBack2.length >= 1 && readBack2.every((r) => r.status === 200), 'a read-back after the replay, answered 200');
    assert.ok(saved(second), `Saved after the replay and its read-back: ${second}`);
    await waitRow(page, 'sales_staff', 'view', 'Custom', prefix);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// M7B-INVOICES-P1 — store-owned invoice drafts saved on the server (the Invoices page's "Server drafts" section)
// ---------------------------------------------------------------------------------------------------------------------

/** Literals, as above: this file must load against the entry commit's tree as well. */
const DRAFT_ACTION = 'store.invoice_draft.create';
const DRAFT_EVENT = 'invoice_draft.created';
const STORES = '/api/v1/stores';
const draftsPath = (store) => `${STORES}/${store}/invoice-drafts`;
/** ServerInvoiceDrafts.tsx DRAFTS_TEXT.saved. */
const DRAFT_SAVED = 'Draft saved on the server.';
const SAVED_EARLIER = 'A server draft was saved under an earlier connection.';
const MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const isStoresRead = (r) => r.method === 'GET' && r.path === STORES;
const isDraftsRoute = (r) => r.path.startsWith(`${STORES}/`);
const isDraftCreate = (r) => r.method === 'POST' && /^\/api\/v1\/stores\/[^/]+\/invoice-drafts$/.test(r.path);
const isDraftList = (store) => (r) => r.method === 'GET' && r.path === draftsPath(store);
/** The eligibility read of `store` (M7B-INVOICES-P1-R2: GET /api/v1/stores/{storeId}/invoice-drafts/eligibility). */
const isEligibility = (store) => (r) => r.method === 'GET' && r.path === `${draftsPath(store)}/eligibility`;
const isDraftGet = (store, id) => (r) => r.method === 'GET' && r.path === `${draftsPath(store)}/${id}`;
const minus = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));

/** Integer cents as the shop shows them ($1,234.56): digit arithmetic only. */
const usd = (cents) => `$${String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(cents % 100).padStart(2, '0')}`;
/** ServerCustomerDirectory.tsx createdText: the UTC date and minute of a stored instant. */
const minuteOf = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** A line as the user types it (a description, a whole quantity, a price in dollars) and the cents it must become. */
const typed = (description, quantity, price, cents) => ({ description, quantity, price, cents });
/** The exact POST body the shop must send (invoiceDraftsClient.ts draftBody: these keys in this order, amounts as numbers). */
const bodyFor = (tenant, customerId, lines) => JSON.stringify({
  expectedTenant: tenant, customerId, currency: 'USD',
  lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.cents })),
});
/** The lines as stored and answered: in order, each total quantity x unit price. */
const linesFor = (lines) => lines.map((l, i) => ({
  position: i + 1, description: l.description, quantity: Number(l.quantity), unitPriceCents: l.cents, lineTotalCents: Number(l.quantity) * l.cents,
}));
const subtotalOf = (lines) => lines.reduce((n, l) => n + Number(l.quantity) * l.cents, 0);
/** The reopen dialog's table cells for `lines`: position, description, quantity, unit price, line total. */
const viewCells = (lines) => linesFor(lines).map((l) => [String(l.position), l.description, String(l.quantity), usd(l.unitPriceCents), usd(l.lineTotalCents)]);

async function newStore(tenant, name) {
  const [{ store_id: id }] = await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, 'active') returning store_id`;
  return id;
}

/**
 * A tenant of its own with stores named `M7SDB <label> <each> <suffix>` (their byte order is the order given) and an owner
 * who signs in to the shop: its tenant grant (the shop's sign-in, the customer picker and the customer names) and a
 * store_owner STORE grant at every store (the draft routes, decided at the store the path names only).
 */
async function draftShop(label, storeLabels) {
  const tenant = await newTenant(label);
  const stores = [];
  for (const s of storeLabels) {
    const name = `M7SDB ${label} ${s} ${SUFFIX}`;
    stores.push({ id: await newStore(tenant, name), name });
  }
  const boss = await actor(`${label}-owner`, [grant(tenant, 'store_owner'), ...stores.map((s) => storeGrant(tenant, s.id, 'store_owner'))], { role: 'store_owner' });
  return { tenant, stores, boss };
}

/** D/L/A/O: one tenant's drafts, lines, draft create audits and draft events, as the database owner reads them. */
async function draftCounts(tenant) {
  const [r] = await owner`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenant})::int as d,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = ${tenant})::int as l,
    (select count(*) from public.audit_event where action_id = ${DRAFT_ACTION} and tenant_id = ${tenant})::int as a,
    (select count(*) from tmpos_internal.outbox_event where event_type = ${DRAFT_EVENT}
      and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = ${tenant}))::int as o`;
  return { D: r.d, L: r.l, A: r.a, O: r.o };
}

/** One tenant's drafts as stored, in the list's order ((created_at, draft_id) newest first), each with its lines in order. */
async function storedDrafts(tenant) {
  const drafts = await owner`select draft_id, store_id, customer_id, status, currency, version::int as version, line_count,
      subtotal_cents::text as subtotal, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenant} order by created_at desc, draft_id desc`;
  const lines = await owner`select draft_id, position, description, quantity::text as quantity, unit_price_cents::text as price,
      line_total_cents::text as total
    from tmpos_invoice_draft.invoice_draft_line where tenant_id = ${tenant} order by draft_id, position`;
  return Array.from(drafts, (d) => ({
    id: d.draft_id, storeId: d.store_id, customerId: d.customer_id, status: d.status, currency: d.currency, version: d.version,
    lineCount: d.line_count, subtotalCents: Number(d.subtotal), createdAt: d.created_at,
    lines: Array.from(lines).filter((l) => l.draft_id === d.draft_id).map((l) => ({
      position: l.position, description: l.description, quantity: Number(l.quantity), unitPriceCents: Number(l.price), lineTotalCents: Number(l.total),
    })),
  }));
}

/** The draft create audits of one tenant: their scope, store and subject, oldest first. */
async function draftAudits(tenant) {
  const rows = await owner`select scope_type, store_id, subject_invoice_draft_id from public.audit_event
    where action_id = ${DRAFT_ACTION} and tenant_id = ${tenant} order by occurred_at, event_id`;
  return Array.from(rows, (r) => ({ scope: r.scope_type, store: r.store_id, subject: r.subject_invoice_draft_id }));
}

/** The Invoices page by in-app navigation, then "Show server drafts"; answers the draft requests sent BEFORE that press. */
async function openDrafts(page) {
  const from = st.api.length;
  await go(page, '/invoices');
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'the Server drafts section offers Show');
  await page.settle();
  const early = sentBy(page, (r) => isStoresRead(r) || isDraftsRoute(r), from).map(apiLine);
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  return early;
}
const storeOptions = (page) => page.evaluate(`[...(${q('drafts-store')}?.options ?? [])].map((o) => ({ value: o.value, text: o.textContent.trim() }))`);
const chosenStore = (page) => page.evaluate(`${q('drafts-store')}?.value ?? null`);
const listPhase = (page) => page.evaluate(`${q('drafts-list-state')}?.dataset.phase ?? null`);
const holdState = (page) => page.evaluate(`${q('drafts-hold')}?.dataset.state ?? null`);
/** Choose `id` in the store select as a user does: the select's own change event. */
async function pickStore(page, id) {
  await page.evaluate(`(() => { const s = ${q('drafts-store')}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(id)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
const draftRowsOf = (page) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by('drafts-row'))})].map((li) => ({
  id: li.dataset.id ?? null,
  customer: li.querySelector(${JSON.stringify(by('drafts-row-customer'))})?.textContent.trim() ?? null,
  created: li.querySelector(${JSON.stringify(by('drafts-row-created'))})?.textContent.trim() ?? null,
  lines: li.querySelector(${JSON.stringify(by('drafts-row-lines'))})?.textContent.trim() ?? null,
  subtotal: li.querySelector(${JSON.stringify(by('drafts-row-subtotal'))})?.textContent.trim() ?? null,
}))`);
/** The list's read settled ('ready') showing exactly `ids` in that order, and (when given) `customer` on its first row. */
async function waitDraftRows(page, ids, label, customer = null) {
  let seen;
  await page.waitFor(async () => {
    seen = await draftRowsOf(page);
    return JSON.stringify(seen.map((r) => r.id)) === JSON.stringify(ids) && (await listPhase(page)) === 'ready' && (customer === null || seen[0]?.customer === customer);
  }, 30_000, label).catch((e) => { throw new Error(`${e.message}; rows shown: ${JSON.stringify(seen)?.slice(0, 600)}`); });
  return seen;
}
/** Type over one field of line `i` (0-based) of the New server draft dialog (or, M7B-INVOICES-P2, the editor: `prefix` 'draft-edit') as a user does: select it all, then type. */
async function typeLineField(page, i, field, text, prefix = 'draft-new') {
  const mark = `[data-sdb="line-${i}-${field}"]`;
  await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by(`${prefix}-line`))})][${i}].querySelector(${JSON.stringify(by(`${prefix}-${field}`))}).setAttribute('data-sdb', 'line-${i}-${field}')`);
  await page.click(mark);
  await page.evaluate(`document.querySelector(${JSON.stringify(mark)}).select()`);
  await page.type(text);
  await page.waitFor(`document.querySelector(${JSON.stringify(mark)})?.value === ${JSON.stringify(text)}`, 10_000, `line ${i + 1} ${field} reads what was typed`);
}
/** "New server draft" for the chosen store: a server customer picked by its database id in the picker, then `lines` typed. */
async function composeDraft(page, customerId, lines) {
  await page.waitFor(() => offered(page, 'drafts-new'), 30_000, 'New server draft is offered (the server allowed it: M7B-INVOICES-P1-R2)');
  await page.click(by('drafts-new'));
  await page.waitFor(`!!${q('draft-new')}`, 15_000, 'the New server draft dialog');
  await openPicker(page, 'picker-open');
  await pickRow(page, customerId);
  for (const [i, line] of lines.entries()) {
    if (i > 0) {
      await page.click(by('draft-new-add-line'));
      await page.waitFor(`document.querySelectorAll(${JSON.stringify(by('draft-new-line'))}).length === ${i + 1}`, 10_000, `line ${i + 1} added`);
    }
    await typeLineField(page, i, 'description', line.description);
    await typeLineField(page, i, 'quantity', line.quantity);
    await typeLineField(page, i, 'price', line.price);
  }
}
/** What the read-only reopen dialog shows. */
const viewOf = (page) => page.evaluate(`({
  customer: ${q('draft-view-customer')}?.textContent.trim() ?? null,
  store: ${q('draft-view-store')}?.textContent.trim() ?? null,
  created: ${q('draft-view-created')}?.textContent.trim() ?? null,
  status: ${q('draft-view-status')}?.textContent.trim() ?? null,
  subtotal: ${q('draft-view-subtotal')}?.textContent.trim() ?? null,
  lines: [...document.querySelectorAll(${JSON.stringify(by('draft-view-line'))})].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())),
})`);
/** Open row `id` read-only; answers what the dialog shows once the customer's name has been read. */
async function reopenDraft(page, id, customerName) {
  await page.click(`${by('drafts-row')}[data-id="${id}"] ${by('drafts-open')}`);
  await page.waitFor(`!!${q('draft-view-lines')} && ${q('draft-view-customer')}?.textContent.trim() === ${JSON.stringify(customerName)}`, 30_000, 'the reopened draft, its customer named');
  return viewOf(page);
}
async function closeView(page) {
  await page.click(by('draft-view-close'));
  await page.waitFor(`!${q('draft-view')}`, 15_000, 'the reopen dialog closed');
}
/** The browser's own invoice table (the Invoices page's list): its row count and text. */
const localInvoices = (page) => page.evaluate(`(() => {
  const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent.trim() === 'Invoice #');
  return table ? { rows: table.querySelectorAll('tbody > tr').length, text: table.textContent } : null;
})()`);

/** Every value in the page's address, its local and session storage and every IndexedDB object store (as JSON text). */
const STORAGE_DUMP = `(async () => {
  const out = { address: location.href, local: JSON.stringify(Object.entries(localStorage)), session: JSON.stringify(Object.entries(sessionStorage)), indexedDB: '' };
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    for (const store of db.objectStoreNames) {
      out.indexedDB += JSON.stringify(await new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }));
    }
    db.close();
  }
  return JSON.stringify(out);
})()`;
/**
 * Wrappers installed in every document of a page before any script of the app runs: each value written to local or session
 * storage, each address pushed or replaced, and each value put or added to IndexedDB is told to the test (a CDP binding),
 * so a value written and removed again before the end is still seen.
 */
const WRITE_HOOKS = `(() => {
  const tell = (where, values) => { let text; try { text = JSON.stringify(values); } catch { text = String(values); } try { window.__sdbWrite(where + ' ' + text); } catch { /* no binding */ } };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) { tell('storage', [key, value]); return setItem.call(this, key, value); };
  for (const name of ['pushState', 'replaceState']) {
    const original = History.prototype[name];
    History.prototype[name] = function (state, title, url) { tell('address', [String(url ?? ''), state]); return original.call(this, state, title, url); };
  }
  for (const name of ['put', 'add']) {
    const original = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (value, key) { tell('indexedDB', [value, key ?? null]); return original.apply(this, arguments); };
  }
})()`;
/** Record every write WRITE_HOOKS sees on `page` into page.writes, from its next document on (call before signIn). */
async function recordWrites(page) {
  page.writes = [];
  page.on('Runtime.bindingCalled', (e) => { if (e.name === '__sdbWrite') page.writes.push(e.payload); });
  await page.send('Runtime.addBinding', { name: '__sdbWrite' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WRITE_HOOKS });
  return page;
}

/**
 * None of `values` (draft ids, Idempotency-Keys, customer ids, descriptions, bodies) in a page's address, browser storage,
 * own console or exceptions (the browser's network log lines are its own, not the shop's), or in any log line either
 * tenant entry wrote — at the end, and (recordWrites) in anything written to the address or storage on the way.
 */
async function assertDraftsNowhere(pages, values) {
  assert.ok(values.every((v) => typeof v === 'string' && v.length >= 8), 'every value is a real one');
  for (const page of pages) {
    assert.ok(page.writes?.some((w) => w.startsWith('address ')), 'the write recorder saw the page\'s own navigations');
    for (const w of page.writes) for (const v of values) assert.ok(!w.includes(v), `written on the way: ${w.slice(0, w.indexOf(' '))} held draft data (${v.slice(0, 8)}…)`);
    const seen = JSON.parse(await page.evaluate(STORAGE_DUMP));
    for (const [where, text] of Object.entries(seen)) for (const v of values) assert.ok(!text.includes(v), `${where} holds draft data (${v.slice(0, 8)}…)`);
    for (const line of page.logs.filter((l) => l.startsWith('console.') || l.startsWith('exception:'))) {
      for (const v of values) assert.ok(!line.includes(v), `the page's console holds draft data (${v.slice(0, 8)}…)`);
    }
  }
  const lines = [...(entry?.cap.lines ?? []), ...(entry2?.cap.lines ?? [])];
  assert.ok(lines.length > 0, 'the entries\' log lines were captured');
  for (const line of lines) for (const v of values) assert.ok(!line.includes(v), `a tenant entry log line holds draft data (${v.slice(0, 8)}…)`);
}

scenario('SDB-01', 'AC-13 SAVE, RELOAD, LIST, REOPEN — the owner chooses a real store (nothing preselected), picks an existing server customer and saves a three-line draft: ONE POST of the exact body, 201, one draft with its ordered lines, one store-scope audit, one event, one completion; after a reload the store\'s list shows it and the read-only reopen shows the persisted lines, amounts and creation time; the other store lists nothing; a second browser through the second entry reopens it; nothing in the address, storage or logs', async () => {
  const { tenant, stores: [north, south], boss } = await draftShop('d1', ['north', 'south']);
  const customers = await seedCustomers(tenant, [`M7SDB d1 Avery ${SUFFIX}`, `M7SDB d1 Blake ${SUFFIX}`, `M7SDB d1 Casey ${SUFFIX}`]);
  const customer = customers[1];
  const lines = [
    typed(`Screen repair, café counter ${SUFFIX}`, '1', '129.99', 12_999),
    typed(`Battery pack ${SUFFIX}`, '2', '45.50', 4_550),
    typed(`Labour hour ${SUFFIX}`, '3', '60', 6_000),
  ];
  const subtotal = subtotalOf(lines);
  const page = await recordWrites(await openPage());
  await signIn(page, boss);

  // 1. Nothing is read before Show; the stores are the server's, in its order, and none is chosen for the user.
  const early = await openDrafts(page);
  const options = await storeOptions(page);
  const unchosen = { value: await chosenStore(page), hint: await has(page, 'drafts-choose'), listReads: sentBy(page, isDraftsRoute).map(apiLine) };
  await pickStore(page, north.id);
  await waitDraftRows(page, [], 'the north store has no draft yet');
  const localBefore = await localInvoices(page);

  // 2. The draft: a server customer, three lines, Save draft.
  await composeDraft(page, customer.id, lines);
  const dialog = { store: await textOf(page, 'draft-new-store'), subtotal: await textOf(page, 'draft-new-subtotal') };
  const before = await counts();
  const dBefore = await draftCounts(tenant);
  const from = st.api.length;
  await page.click(by('draft-new-save'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-notice')}?.textContent.trim() === ${JSON.stringify(DRAFT_SAVED)}`, 30_000, 'saved, read back, the dialog closed');
  const stored = await storedDrafts(tenant);
  assert.equal(stored.length, 1, 'ONE draft stored');
  const [draft] = stored;
  const shown = await waitDraftRows(page, [draft.id], 'the north store lists the new draft', customer.name);
  await quiet(page, from);
  const posts = sentBy(page, isDraftCreate);
  const readBack = sentBy(page, isDraftGet(north.id, draft.id), from);
  const dDelta = minus(await draftCounts(tenant), dBefore);
  const audits = await draftAudits(tenant);
  const localAfter = await localInvoices(page);
  record('SDB-01', { phase: 'saved', early, options: options.length, unchosen, dialog, posts: posts.map(apiLine), readBack: readBack.map(answered), ...dDelta });

  assert.deepEqual(early, [], 'nothing about stores or drafts is read before "Show server drafts"');
  assert.deepEqual(options, [{ value: '', text: 'Choose a store…' }, { value: north.id, text: north.name }, { value: south.id, text: south.name }],
    'the server\'s stores, in its order, under their own names');
  assert.deepEqual(unchosen, { value: '', hint: true, listReads: [] }, 'no store is chosen for the user, and no list is read before the choice');
  assert.deepEqual(dialog, { store: north.name, subtotal: `Draft subtotal ${usd(subtotal)}` }, 'the dialog names the chosen store and the exact Draft subtotal');
  assert.equal(posts.length, 1, `ONE POST: ${posts.map(apiLine).join('; ')}`);
  const [post] = posts;
  assert.equal(post.path, draftsPath(north.id), 'to the chosen store');
  assert.equal(post.query, '', 'nothing rides the query');
  assert.equal(post.body, bodyFor(tenant, customer.id, lines), 'exactly the typed draft, the dollar prices parsed to exact cents');
  assert.match(post.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.deepEqual(Object.keys(post.headers).filter((h) => /tenant|store|role|actor/i.test(h)), [], 'no selecting header');
  assert.equal(post.status, 201);
  assert.equal(post.replied.headers.location, `${draftsPath(north.id)}/${draft.id}`, 'its Location');
  assert.deepEqual(JSON.parse(post.replied.text), { draft: { id: draft.id, status: 'draft', currency: 'USD', lineCount: 3, subtotalCents: subtotal } });
  assert.deepEqual(readBack.map(answered), ['200'], 'read back once, never a second POST');
  assert.ok(readBack[0].at > post.doneAt, 'the read-back follows the 201');
  assert.deepEqual(draft, {
    id: draft.id, storeId: north.id, customerId: customer.id, status: 'draft', currency: 'USD', version: 1, lineCount: 3, subtotalCents: subtotal,
    createdAt: draft.createdAt, lines: linesFor(lines),
  }, 'the draft as stored: its store, customer, USD cents, subtotal and ordered lines');
  assert.match(draft.createdAt, MICROS);
  assert.deepEqual(dDelta, { D: 1, L: 3, A: 1, O: 1 }, 'one draft, three lines, one audit, one event');
  assert.deepEqual(audits, [{ scope: 'store', store: north.id, subject: draft.id }], 'the audit is store-scope and names the draft');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 1, L: 1, T: 1 }, 'the save');
  assert.deepEqual(shown, [{ id: draft.id, customer: customer.name, created: minuteOf(draft.createdAt), lines: '3 lines', subtotal: `Draft subtotal ${usd(subtotal)}` }]);
  assert.ok(localBefore !== null && localAfter !== null, 'the local invoice table is on the page');
  assert.equal(localAfter.rows, localBefore.rows, 'the browser\'s own invoice list gains no row');
  assert.ok(lines.every((l) => !localAfter.text.includes(l.description)), 'no server draft line in the local invoice list');

  // 3. A reload: the hold is gone with the page; the server's list and reopen show what was saved.
  const reload = st.api.length;
  await page.goto(`${SHOP}/invoices`, 30_000);
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'the reloaded Invoices page');
  const reloaded = { hold: await has(page, 'drafts-hold'), notice: await has(page, 'drafts-notice') };
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  const chosenAfterReload = await chosenStore(page);
  await pickStore(page, north.id);
  const rowsAfterReload = await waitDraftRows(page, [draft.id], 'the saved draft after a reload', customer.name);
  const view = await reopenDraft(page, draft.id, customer.name);
  const got = sentBy(page, isDraftGet(north.id, draft.id), reload);
  await closeView(page);
  await pickStore(page, south.id);
  await waitDraftRows(page, [], 'the south store lists nothing');
  const localReloaded = await localInvoices(page);
  record('SDB-01', { phase: 'reloaded', reloaded, chosenAfterReload, view, got: got.map(answered) });

  assert.deepEqual(reloaded, { hold: false, notice: false }, 'a fresh page: nothing held, nothing said');
  assert.equal(chosenAfterReload, '', 'no store is remembered');
  assert.deepEqual(rowsAfterReload, shown, 'the same row from the server');
  assert.deepEqual(got.map(answered), ['200'], 'the reopen is one read of its own');
  assert.deepEqual(JSON.parse(got[0].replied.text), {
    draft: {
      id: draft.id, storeId: north.id, customerId: customer.id, status: 'draft', currency: 'USD', version: 1, createdAt: draft.createdAt,
      subtotalCents: subtotal, lines: linesFor(lines),
    },
  }, 'the answer: the stored draft, its creation time to the microsecond');
  assert.deepEqual(view, {
    customer: customer.name, store: north.name, created: minuteOf(draft.createdAt), status: 'Draft · USD',
    subtotal: `Draft subtotal ${usd(subtotal)}`, lines: viewCells(lines),
  }, 'the read-only reopen: the persisted lines, amounts and creation time');
  assert.equal(localReloaded?.rows, localBefore.rows, 'after the reload, list and reopen, the local invoice list still has no new row');
  assert.ok(lines.every((l) => !localReloaded.text.includes(l.description)), 'nor any server draft line');

  // 4. Another authorized session: a second browser through the second tenant entry.
  const other = viaSecond(await recordWrites(await openPage()));
  await signIn(other, boss);
  await openDrafts(other);
  await pickStore(other, north.id);
  await waitDraftRows(other, [draft.id], 'the second browser lists the draft', customer.name);
  const otherView = await reopenDraft(other, draft.id, customer.name);
  await quiet(other, 0); // M7B-INVOICES-P2: the reopen also asks the edit eligibility; every read answered before they are judged
  const otherReads = sentBy(other, isDraftsRoute);
  assert.deepEqual(otherView, view, 'the same draft in another session');
  assert.ok(otherReads.length > 0 && otherReads.every((r) => r.via === 2 && r.status === 200), `through the second entry: ${otherReads.map(apiLine).join('; ')}`);
  assert.deepEqual(sentBy(other, isDraftCreate), [], 'the second browser sent no POST');
  await closeView(other);
  const otherLocal = await localInvoices(other);
  assert.ok(otherLocal !== null && lines.every((l) => !otherLocal.text.includes(l.description)), 'no server draft line in the second browser\'s local invoice list');

  await assertDraftsNowhere([page, other], [draft.id, post.headers['idempotency-key'], customer.id, post.body, ...lines.map((l) => l.description)]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-02', 'AC-14 LOST REPLY — the POST commits and its answer is dropped at the front: a double press sends ONE POST, held "Not confirmed yet"; a focus and a visibilitychange event, closing the dialog, leaving and coming back and a list that shows the draft send nothing; "Check again" sends exactly one more POST with the SAME key and byte-identical body, a 201 replay; ONE draft row in the database', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d2', ['main']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d2 Dana ${SUFFIX}`]);
  const lines = [typed(`Diagnostics ${SUFFIX}`, '1', '35', 3_500), typed(`Charging port ${SUFFIX}`, '2', '89.95', 8_995)];
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [], 'no draft yet');
  await composeDraft(page, customer.id, lines);
  const myPosts = () => sentBy(page, isDraftCreate);
  const before = await counts();
  const dBefore = await draftCounts(tenant);
  let lost = 0;
  try {
    // st.lose: the entry answered (and committed); that answer never reaches the page.
    st.lose = (rec, phase) => phase === 'response' && isDraftCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-new-save'));
    await page.click(by('draft-new-save')); // a second press, at once: in flight, it sends nothing
    await waitData(page, 'drafts-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const [first] = myPosts();
  const afterLoss = { posts: myPosts().map((r) => `${r.status} ${r.lost ?? 'delivered'}`), d: await draftCounts(tenant), stored: await storedDrafts(tenant) };
  const card = await textOf(page, 'drafts-hold');
  record('SDB-02', { phase: 'lost reply', posts: afterLoss.posts, ...minus(afterLoss.d, dBefore), card });
  assert.deepEqual(afterLoss.posts, ['201 response'], 'ONE POST for a double press: it committed, its answer lost at the front');
  assert.equal(first.body, bodyFor(tenant, customer.id, lines));
  assert.match(first.headers['idempotency-key'] ?? '', UUID_V4_RE);
  assert.deepEqual(minus(afterLoss.d, dBefore), { D: 1, L: 2, A: 1, O: 1 }, 'the lost create committed: one draft, its lines, audit and event');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 1, L: 1, T: 1 }, 'the create whose answer was lost');
  assert.ok(card.startsWith('Not confirmed yet'), `held, never saved: ${card}`);
  assert.equal(await has(page, 'drafts-notice'), false, 'never "saved" on an answer that did not arrive');
  const [stored] = afterLoss.stored;

  // Nothing re-sends on its own: a focus and a visibilitychange event, the dialog closed, the page left and opened again, a list read
  // that SHOWS the committed draft (a list is not proof of an uncertain create), and time.
  const mid = await counts();
  const barrier = st.api.length;
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  await page.click(by('draft-new-cancel'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-hold')}?.dataset.state === 'unresolved'`, 15_000, 'the dialog hidden, the attempt still held in the section');
  await go(page, '/');
  await page.waitFor(`!${q('drafts-section')}`, 15_000, 'the Invoices page left');
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [stored.id], 'the list shows the committed draft');
  await quiet(page, barrier);
  await delay(2_000); // whatever it would still send on its own, it has sent
  const held = { posts: myPosts().length, state: await holdState(page), check: await offered(page, 'drafts-check-again'), notice: await has(page, 'drafts-notice') };
  record('SDB-02', { phase: 'before the retry click', ...held, requests: st.api.slice(barrier).filter((r) => r.frameId === page.frameId).map(apiLine) });
  assert.deepEqual(held, { posts: 1, state: 'unresolved', check: true, notice: false }, 'still ONE POST, still held, Check again offered');
  assert.deepEqual(await draftCounts(tenant), afterLoss.d, 'nothing more stored');
  await assertDelta(mid, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'no completion or idempotency record without a press');

  // Check again: the SAME key and the SAME bytes, once; the server answers the stored draft as a replay.
  const again = st.api.length;
  await page.click(by('drafts-check-again'));
  await page.waitFor(`${q('drafts-notice')}?.textContent.trim() === ${JSON.stringify(DRAFT_SAVED)} && !${q('drafts-hold')}`, 30_000, 'confirmed by the check and read back');
  await waitDraftRows(page, [stored.id], 'the list shows it once');
  await quiet(page, again);
  const posts = myPosts();
  const [{ n: rows }] = await owner`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenant}`;
  record('SDB-02', { phase: 'Check again', posts: posts.map(apiLine), rows });
  assert.equal(posts.length, 2, `exactly one more POST, on the press (${posts.map(apiLine).join('; ')})`);
  const second = posts[1];
  assert.ok(st.api.indexOf(second) >= again, 'sent only after the press');
  assert.equal(second.path, first.path, 'to the attempt\'s own store');
  assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key'], 'the SAME Idempotency-Key');
  assert.equal(second.body, first.body, 'the byte-identical body');
  assert.deepEqual([second.status, second.replied.headers['idempotent-replayed']], [201, 'true'], 'answered as a replay');
  assert.deepEqual(JSON.parse(second.replied.text), { draft: { id: stored.id, status: 'draft', currency: 'USD', lineCount: 2, subtotalCents: subtotalOf(lines) } }, 'the sealed answer names the stored draft');
  assert.equal(second.replied.headers.location, `${draftsPath(main.id)}/${stored.id}`);
  assert.equal(rows, 1, 'exactly ONE draft row');
  assert.deepEqual(await draftCounts(tenant), afterLoss.d, 'the replay wrote no draft, line, audit or event');
  await assertDelta(mid, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'the replay wrote no completion or idempotency record');
  await assertDraftsNowhere([page], [stored.id, first.headers['idempotency-key'], customer.id, first.body, ...lines.map((l) => l.description)]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-03', 'AC-15 STORE AND SESSION CHANGES — with an unresolved create held for one store: another store clears the scoped list at once, and a list answer for the store left behind (its read aborted by the page), released after the user moved back, shows nothing; the hold keeps its store and is never re-sent; a swapped session cookie (another session of the same owner) noticed on focus clears the stores, rows and open draft, detaches the hold, and a parked reopen answer of the old session (aborted too) shows nothing; then a late read-back answer the page does NOT abort is delivered after a third connection starts and is ignored; one POST until then, two in the whole case', async () => {
  const { tenant, stores: [east, west], boss } = await draftShop('d3', ['east', 'west']);
  const [cEast, cWest] = await seedCustomers(tenant, [`M7SDB d3 Ellis ${SUFFIX}`, `M7SDB d3 Wren ${SUFFIX}`]);
  // One draft per store, saved from outside the browser by the owner's own session.
  const direct = await directLogin(boss);
  const seed = async (store, customer, lines) => {
    const res = await call('POST', draftsPath(store.id), { session: direct, body: JSON.parse(bodyFor(tenant, customer.id, lines)), key: randomUUID() });
    assert.equal(res.status, 201, res.text);
    return JSON.parse(res.text).draft.id;
  };
  const eastLines = [typed(`East seed ${SUFFIX}`, '1', '10', 1_000)];
  const westLines = [typed(`West seed one ${SUFFIX}`, '1', '20', 2_000), typed(`West seed two ${SUFFIX}`, '2', '5', 500)];
  const dEast = await seed(east, cEast, eastLines);
  const dWest = await seed(west, cWest, westLines);
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, west.id);
  await waitDraftRows(page, [dWest], 'west lists its draft', cWest.name);

  // 1. An unresolved create for west: it commits, its answer is lost; the dialog is closed (the attempt stays held).
  const heldLines = [typed(`West held ${SUFFIX}`, '4', '2.25', 225)];
  await composeDraft(page, cWest.id, heldLines);
  let lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isDraftCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-new-save'));
    await waitData(page, 'drafts-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  await page.click(by('draft-new-cancel'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-hold')}?.dataset.state === 'unresolved'`, 15_000, 'the attempt held in the section');
  const posts = () => sentBy(page, isDraftCreate);
  const [first] = posts();
  const stored = await storedDrafts(tenant);
  const heldDraft = stored.find((d) => d.lines[0]?.description === heldLines[0].description);
  assert.ok(heldDraft, 'the lost create committed');
  const westIds = stored.filter((d) => d.storeId === west.id).map((d) => d.id);
  const what = await textOf(page, 'drafts-hold-what');
  const before = await counts();
  const dBefore = await draftCounts(tenant);

  // 2. Store change: east's list answer is parked at the front; the user moves back to west before it is released.
  const parkedList = gate((r) => r.frameId === page.frameId && isDraftList(east.id)(r), 'response');
  await pickStore(page, east.id);
  const eastRead = await Promise.race([parkedList.reached, delay(30_000).then(() => null)]);
  assert.ok(eastRead, 'east\'s list read reached the entry; its answer is parked');
  const whileParked = { rows: (await draftRowsOf(page)).map((r) => r.id), chosen: await chosenStore(page), phase: await listPhase(page) };
  await pickStore(page, west.id);
  await waitDraftRows(page, westIds, 'back on west: its rows', cWest.name);
  parkedList.release();
  await page.waitFor(() => eastRead.handedBack === true, 15_000, 'the parked east answer was handed back to the browser');
  await page.settle(); // two frames, then 500 ms
  await delay(1_000); // and a margin: whatever reaching the page would make it do, it has done (the page aborted this read
  // when the store changed, so the answer is refused at the browser: this shows no effect of the old scope — the late
  // answer the page does receive is step 5's)
  const storeChange = {
    rows: (await draftRowsOf(page)).map((r) => r.id), chosen: await chosenStore(page),
    eastShown: (await page.evaluate('document.documentElement.outerHTML')).includes(dEast),
    hold: await holdState(page), what: await textOf(page, 'drafts-hold-what'), posts: posts().length,
  };
  record('SDB-03', { phase: 'store change', parked: answered(eastRead), whileParked, storeChange });
  assert.equal(eastRead.status, 200);
  assert.ok(eastRead.replied.text.includes(dEast), 'the parked answer was a real one, for the store left behind');
  assert.deepEqual(whileParked, { rows: [], chosen: east.id, phase: 'loading' }, 'choosing another store clears the scoped list at once');
  assert.deepEqual(storeChange, { rows: westIds, chosen: west.id, eastShown: false, hold: 'unresolved', what, posts: 1 },
    'the late answer for the store left behind changes nothing; the hold keeps its own store and nothing is re-sent');
  assert.ok(what.startsWith(`${west.name} · 1 line · Draft subtotal ${usd(subtotalOf(heldLines))}`), `the hold names its own store: ${what}`);

  // 3. Session change: a reopen read's answer is parked; the jar's session cookie becomes another valid session of the
  //    same owner (made outside the page, as SCB-08 swaps one); a window focus lets the page notice.
  const parkedGet = gate((r) => r.frameId === page.frameId && isDraftGet(west.id, dWest)(r), 'response');
  await page.click(`${by('drafts-row')}[data-id="${dWest}"] ${by('drafts-open')}`);
  const oldRead = await Promise.race([parkedGet.reached, delay(30_000).then(() => null)]);
  assert.ok(oldRead, 'the reopen read reached the entry; its answer is parked');
  await page.waitFor(`${q('draft-view-state')}?.dataset.phase === 'loading'`, 10_000, 'the reopen dialog waits for its read');
  const swapped = await directLogin(boss);
  const cookieName = swapped.cookie.slice(0, swapped.cookie.indexOf('='));
  await browser.send('Storage.setCookies', {
    browserContextId: page.contextId,
    cookies: [{ name: cookieName, value: cookieValue(swapped.cookie), url: `${SHOP}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }],
  });
  const change = st.api.length;
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.waitFor(`!!${q('drafts-connection-changed')} && ${q('drafts-stores-state')}?.dataset.phase === 'ready' && !${q('draft-view')}`, 30_000,
    'a new connection: the stores read again, the open draft gone');
  parkedGet.release();
  await page.waitFor(() => oldRead.handedBack === true, 15_000, 'the parked reopen answer was handed back to the browser');
  await page.settle(); // two frames, then 500 ms
  await delay(1_000); // and a margin, as above
  await quiet(page, change);
  const html = await page.evaluate('document.documentElement.outerHTML');
  const sessionChange = {
    chosen: await chosenStore(page), rows: (await draftRowsOf(page)).length, view: await has(page, 'draft-view'),
    oldLinesShown: westLines.some((l) => html.includes(l.description)), hold: await holdState(page), check: await has(page, 'drafts-check-again'),
    posts: posts().length,
  };
  const carried = (r) => ((r.headers.cookie ?? '').includes(cookieValue(swapped.cookie)) ? 'swapped' : 'other');
  const checks = sentBy(page, isSessionRead, change).map(carried);
  const storesAgain = sentBy(page, isStoresRead, change).map((r) => `${carried(r)} ${answered(r)}`);
  record('SDB-03', { phase: 'session change', parked: answered(oldRead), sessionChange, checks, storesAgain, logins: sentBy(page, isLogin, change).map(answered) });
  assert.equal(oldRead.status, 200);
  assert.ok(westLines.every((l) => oldRead.replied.text.includes(l.description)), 'the parked answer was a real one, under the old session');
  assert.ok(checks.length > 0 && checks[0] === 'swapped', 'the page checked its session with the swapped cookie');
  assert.deepEqual(sentBy(page, isLogin, change), [], 'no login: the other session is reused');
  assert.deepEqual(storesAgain, ['swapped 200'], 'the stores are read again, once, under the new session');
  assert.deepEqual((await storeOptions(page)).map((o) => o.value), ['', east.id, west.id], 'the new connection\'s stores, none chosen');
  assert.deepEqual(sessionChange, { chosen: '', rows: 0, view: false, oldLinesShown: false, hold: 'detached', check: false, posts: 1 },
    'the stores read again with nothing chosen, no rows, no open draft, the old answer never shown, the hold detached, nothing re-sent');

  // 4. Under the new session each store lists its own; still nothing is sent.
  await pickStore(page, east.id);
  await waitDraftRows(page, [dEast], 'east under the new session', cEast.name);
  await pickStore(page, west.id);
  await waitDraftRows(page, westIds, 'west under the new session', cWest.name);
  await quiet(page, change);
  await delay(2_000); // whatever it would still send on its own, it has sent
  record('SDB-03', { phase: 'after', posts: posts().map(apiLine) });
  assert.deepEqual(posts().map((r) => `${r.status} ${r.lost ?? 'delivered'}`), ['201 response'], 'ONE POST from the page in the whole case: the lost one');
  assert.deepEqual(await draftCounts(tenant), dBefore, 'no draft, line, audit or event after the lost create');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'no completion or idempotency record after the lost create');
  assert.deepEqual((await storedDrafts(tenant)).map((d) => d.id).sort(), [dEast, dWest, heldDraft.id].sort(), 'exactly the seeded drafts and the one the lost reply committed');

  // 5. A late answer the page does NOT abort: a created draft's one read-back GET (sent under the session it was saved
  //    with, no abort signal) has its answer parked while the cookie is swapped again and a focus starts a third
  //    connection. Released, it reaches the page (a resource-timing entry says the fetch completed) and is ignored: it
  //    never says "Draft saved on the server.", and the next render reports the save as one of an earlier connection.
  await page.click(by('drafts-stop')); // the detached hold is let go: a new draft may be saved
  await page.waitFor(`!${q('drafts-hold')} && ${q('drafts-new')}?.disabled === false`, 15_000, 'no hold; New offered');
  const lateLines = [typed(`West late ${SUFFIX}`, '3', '1.5', 150)];
  await composeDraft(page, cWest.id, lateLines);
  const isReadBack = (r) => r.frameId === page.frameId && r.method === 'GET' && r.path.startsWith(`${draftsPath(west.id)}/`);
  const parkedBack = gate(isReadBack, 'response');
  const dLate = await draftCounts(tenant);
  const saved = st.api.length;
  await page.click(by('draft-new-save'));
  const backRead = await Promise.race([parkedBack.reached, delay(30_000).then(() => null)]);
  assert.ok(backRead, 'the read-back GET reached the entry; its answer is parked');
  const parkedAt = performance.now();
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-hold')}?.dataset.state === 'created'`, 15_000, 'created: the dialog closed, the read-back out');
  const [lateCreate] = sentBy(page, isDraftCreate, saved);
  const lateId = JSON.parse(lateCreate.replied.text).draft.id;
  assert.equal(backRead.path, `${draftsPath(west.id)}/${lateId}`, 'the parked read is the new draft\'s read-back');
  const third = await directLogin(boss);
  await browser.send('Storage.setCookies', {
    browserContextId: page.contextId,
    cookies: [{ name: cookieName, value: cookieValue(third.cookie), url: `${SHOP}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }],
  });
  const thirdFrom = st.api.length;
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.waitFor(`!!${q('drafts-connection-changed')} && ${q('drafts-stores-state')}?.dataset.phase === 'ready' && ${q('drafts-store')}?.value === ''`, 30_000,
    'a third connection: the stores read again, nothing chosen');
  await quiet(page, thirdFrom);
  // The page's own record that the read-back fetch COMPLETED (an aborted fetch leaves no resource entry).
  await page.evaluate(`(() => { window.__sdbDone = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__sdbDone.push(e.name); }).observe({ type: 'resource' }); })()`);
  const heldFor = performance.now() - parkedAt;
  assert.ok(heldFor < 12_000, `released well inside the client's 15 s request timeout (${Math.round(heldFor)} ms): the page still waits for it`);
  parkedBack.release();
  await page.waitFor(() => backRead.handedBack === true, 15_000, 'the parked read-back answer was handed back to the browser');
  await page.waitFor(`window.__sdbDone.some((n) => n.endsWith(${JSON.stringify(backRead.path)}))`, 15_000, 'the page received the late read-back answer');
  await page.settle();
  await delay(1_000); // whatever that answer makes the page do, it has done
  const lateSeen = { notice: await textOf(page, 'drafts-notice'), hold: await holdState(page), posts: posts().length };
  await pickStore(page, west.id); // the next render: the created attempt is reported under the new connection
  await waitDraftRows(page, [lateId, ...westIds], 'west under the third session: the late draft once, newest first', cWest.name);
  await page.waitFor(`${q('drafts-notice')}?.textContent.trim() === ${JSON.stringify(SAVED_EARLIER)}`, 15_000, 'reported as saved under an earlier connection');
  await quiet(page, thirdFrom);
  record('SDB-03', { phase: 'late read-back', parked: answered(backRead), heldMs: Math.round(heldFor), lateSeen, notice: await textOf(page, 'drafts-notice') });
  assert.equal(backRead.status, 200);
  assert.ok(backRead.replied.text.includes(lateLines[0].description), 'the parked answer was a real one, the new draft as stored');
  assert.notEqual(lateSeen.notice, DRAFT_SAVED, 'the late answer of the old connection never says "Draft saved on the server."');
  // Ignored: the created attempt is kept for the new connection to report (on its next render, which may already have run).
  assert.ok(lateSeen.hold === 'created' ? lateSeen.notice === null : lateSeen.hold === null && lateSeen.notice === SAVED_EARLIER, `ignored: ${JSON.stringify(lateSeen)}`);
  assert.equal(lateSeen.posts, 2, 'nothing re-sent');
  assert.equal(await has(page, 'drafts-hold'), false);
  assert.deepEqual(sentBy(page, isReadBack, thirdFrom).filter((r) => r.path === backRead.path), [], 'no second read-back under the new connection');
  assert.deepEqual(posts().map((r) => `${r.status} ${r.lost ?? 'delivered'}`), ['201 response', '201 delivered'], 'two POSTs in the whole case: the lost one and the late draft');
  assert.deepEqual(minus(await draftCounts(tenant), dLate), { D: 1, L: 1, A: 1, O: 1 }, 'the late draft: one draft, its line, audit and event');
  await assertDraftsNowhere([page], [dEast, dWest, heldDraft.id, lateId, first.headers['idempotency-key'], lateCreate.headers['idempotency-key'], cEast.id, cWest.id,
    first.body, lateCreate.body, ...[...eastLines, ...westLines, ...heldLines, ...lateLines].map((l) => l.description)]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-04', 'AC-14 LOST REQUEST — the first POST never reaches the entry (dropped at the front): ONE POST, held "Not confirmed yet", nothing stored; a focus sends nothing; "Check again" sends exactly one more POST with the SAME key and byte-identical body, answered 201 as the key\'s FIRST create (no replay): exactly ONE draft row', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d4', ['main']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d4 Drew ${SUFFIX}`]);
  const lines = [typed(`Battery swap ${SUFFIX}`, '1', '49.5', 4_950)];
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [], 'no draft yet');
  await composeDraft(page, customer.id, lines);
  const myPosts = () => sentBy(page, isDraftCreate);
  const before = await counts();
  const dBefore = await draftCounts(tenant);
  let lost = 0;
  try {
    // st.lose before forwarding: the entry never sees this request (or its key); the page's fetch fails as a cut
    // connection does. The dangerous branch: a re-send under any other key would create afresh.
    st.lose = (rec, phase) => phase === 'request' && isDraftCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-new-save'));
    await waitData(page, 'drafts-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const [first] = myPosts();
  const afterLoss = { posts: myPosts().map((r) => `${r.status} ${r.lost ?? 'delivered'}`), d: minus(await draftCounts(tenant), dBefore) };
  const card = await textOf(page, 'drafts-hold');
  record('SDB-04', { phase: 'lost request', ...afterLoss, card });
  assert.deepEqual(afterLoss.posts, ['0 request'], 'ONE POST, dropped before it reached the entry');
  assert.equal(first.body, bodyFor(tenant, customer.id, lines));
  assert.match(first.headers['idempotency-key'] ?? '', UUID_V4_RE);
  assert.deepEqual(afterLoss.d, { D: 0, L: 0, A: 0, O: 0 }, 'nothing stored: the request never arrived');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'no completion or idempotency record for a request that never arrived');
  assert.ok(card.startsWith('Not confirmed yet'), `held, never saved and never refused: ${card}`);
  assert.equal(await has(page, 'drafts-notice'), false);

  // Nothing re-sends on its own: a window focus (a session check), the dialog closed, and time.
  const barrier = st.api.length;
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await page.click(by('draft-new-cancel'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-hold')}?.dataset.state === 'unresolved'`, 15_000, 'the dialog hidden, the attempt still held');
  await quiet(page, barrier);
  await delay(1_000); // whatever it would still send on its own, it has sent
  assert.equal(myPosts().length, 1, 'still ONE POST before the press');
  assert.equal(await offered(page, 'drafts-check-again'), true, 'Check again offered');

  // Check again: the SAME key and the SAME bytes, once; the server sees the key for the first time and creates.
  const again = st.api.length;
  await page.click(by('drafts-check-again'));
  await page.waitFor(`${q('drafts-notice')}?.textContent.trim() === ${JSON.stringify(DRAFT_SAVED)} && !${q('drafts-hold')}`, 30_000, 'created by the check and read back');
  await quiet(page, again);
  const posts = myPosts();
  const stored = await storedDrafts(tenant);
  record('SDB-04', { phase: 'Check again', posts: posts.map(apiLine), rows: stored.length });
  assert.equal(posts.length, 2, `exactly one more POST, on the press (${posts.map(apiLine).join('; ')})`);
  const second = posts[1];
  assert.ok(st.api.indexOf(second) >= again, 'sent only after the press');
  assert.equal(second.path, first.path, 'to the attempt\'s own store');
  assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key'], 'the SAME Idempotency-Key');
  assert.equal(second.body, first.body, 'the byte-identical body');
  assert.deepEqual([second.status, second.replied.headers['idempotent-replayed'] ?? null], [201, null], 'the key\'s first create, not a replay');
  assert.equal(stored.length, 1, 'exactly ONE draft row');
  assert.deepEqual(JSON.parse(second.replied.text), { draft: { id: stored[0].id, status: 'draft', currency: 'USD', lineCount: 1, subtotalCents: subtotalOf(lines) } });
  assert.equal(second.replied.headers.location, `${draftsPath(main.id)}/${stored[0].id}`);
  assert.deepEqual(stored[0].lines, linesFor(lines), 'its line as typed, in cents');
  assert.deepEqual(minus(await draftCounts(tenant), dBefore), { D: 1, L: 1, A: 1, O: 1 }, 'one draft, its line, audit and event');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 1, L: 1 }, 'one completion and one idempotency record: the check was the key\'s first create');
  await waitDraftRows(page, [stored[0].id], 'the list shows it once');
  await assertDraftsNowhere([page], [stored[0].id, first.headers['idempotency-key'], customer.id, first.body, ...lines.map((l) => l.description)]);
  await assertNoLeak(page);
}, 240_000);

// ---------------------------------------------------------------------------------------------------------------------
// M7B-INVOICES-P1 closing round — a user switch in one tab (SDB-05), focus outside the dialogs (SDB-06), a browser-only
// custom role against the server's authority (SDB-07) and a read out when another user signs in (SDB-08)
// ---------------------------------------------------------------------------------------------------------------------

/** ServerInvoiceDrafts.tsx ELIGIBILITY_TEXT.denied: the server's eligibility refused (M7B-INVOICES-P1-R2). */
const ELIG_DENIED = 'This account may not save drafts at this store.';
/** ServerInvoiceDrafts.tsx REFUSED_TEXT.denied: a save the server refused 403. */
const DRAFT_DENIED = 'Not saved: this account may not save drafts at this store.';
/** ServerInvoiceDrafts.tsx HOLD_TEXT.detached, its start. */
const HOLD_DETACHED = 'This draft could not be confirmed: the store connection changed.';
/** The section heading's DOM id: where a press that takes its own control away hands focus. */
const HEADING = 'drafts-title';
const SESSION_CSRF = SESSION_CSRF_HEADER.toLowerCase();
/** Set on `window` before a sign-out; still true after the next sign-in only if the document was never reloaded. */
const SAME_DOCUMENT = 'window.__sdbSameDocument === true';

/**
 * Sign out in this tab as SRL-09 does — the persisted Firebase sign-in cleared, what a sign-out in another tab leaves
 * behind; the shop has no sign-out control of its own — and wait for the route guard's /login in the same document.
 * Answers the API record count before the sign-out began.
 */
async function signOutHere(page) {
  const from = st.api.length;
  await page.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('firebaseLocalStorageDb');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').clear();
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await page.waitFor(`location.pathname === '/login' && !!document.querySelector('input[type="email"]')`, 30_000, 'signed out: the route guard shows /login');
  return from;
}

/** Sign in through the /login form the route guard shows: no navigation, so the document and its module memory stay. */
async function signInHere(page, who) {
  await page.waitFor(`location.pathname === '/login' && !!document.querySelector('input[type="email"]')`, 30_000, 'the sign-in form');
  await page.fill('input[type="email"]', who.email);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitFor(`location.pathname === '/'`, 30_000, `${who.label} signed in and left /login`);
}

/**
 * `n` one-line drafts put in a store by the database owner (no session, audit, event, completion or idempotency record),
 * created one second apart: their ids in the list's order (newest first).
 */
async function seedDrafts(tenant, store, customerId, createdBy, n, label) {
  const ids = Array.from({ length: n }, () => randomUUID());
  await owner.begin(async (sql) => {
    for (const [i, id] of ids.entries()) {
      const cents = 100 + i;
      await sql`insert into tmpos_invoice_draft.invoice_draft
          (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_at, created_by)
        values (${id}, ${tenant}, ${store}, ${customerId}, 'draft', 'USD', 1, 1, ${cents}, pg_catalog.now() - ${i + 1}::int * interval '1 second', ${createdBy})`;
      await sql`insert into tmpos_invoice_draft.invoice_draft_line
          (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
        values (${id}, ${tenant}, ${store}, 1, ${`${label} ${i + 1} ${SUFFIX}`}, 1, ${cents}, ${cents})`;
    }
  });
  return ids;
}

/** What has focus: its DOM id, else its test id, else its tag name ('BODY' when focus fell to the page). */
const focusOf = (page) => page.evaluate(`(() => { const a = document.activeElement; return a === null ? null : a.id || a.dataset?.testid || a.tagName; })()`);
/** The session CSRF tokens a record carried (its header) or was answered (a login's or a session read's csrfToken). */
function tokensOf(r) {
  const out = typeof r.headers[SESSION_CSRF] === 'string' ? [r.headers[SESSION_CSRF]] : [];
  try {
    const answered = JSON.parse(r.replied?.text ?? '').csrfToken;
    if (typeof answered === 'string') out.push(answered);
  } catch { /* not JSON */ }
  return out;
}
/** The session CSRF tokens the entry answered to `records` (a login's or a session read's csrfToken). */
const answeredTokens = (records) => records.flatMap((r) => tokensOf({ headers: {}, replied: r.replied }));
/**
 * Which of `values` the page's JavaScript heap still holds as a string: a CDP heap snapshot (V8 collects garbage before
 * taking one, and a collection is asked for first), searched as text. What it sees is the renderer's JS heap only.
 */
async function heldInHeap(page, values) {
  const snapshot = await heapSnapshot(page);
  return values.filter((v) => snapshot.includes(v));
}
/** A CDP heap snapshot of `page`'s renderer JS heap (a collection asked for first), as its JSON text. */
async function heapSnapshot(page) {
  const chunks = [];
  const stop = page.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
  try {
    await page.send('HeapProfiler.enable');
    await page.send('HeapProfiler.collectGarbage');
    await browser.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, page.sessionId, 60_000);
  } finally {
    stop();
    await page.send('HeapProfiler.disable').catch(() => {});
  }
  const snapshot = chunks.join('');
  assert.ok(snapshot.length > 100_000 && snapshot.includes('"strings"'), 'a heap snapshot was taken');
  return snapshot;
}
/**
 * The retaining path of the first heap string that contains `value` (M7B-INVOICES-P1-R2, SSE-01): from that string up
 * through its retainers (weak edges skipped), breadth first, at most `depth` steps — each step "type name -edge->". A
 * diagnostic for the evidence: it names what keeps the string, it decides nothing.
 */
function retainingPath(snapshotText, value, depth = 12) {
  const { snapshot: { meta }, nodes, edges, strings } = JSON.parse(snapshotText);
  const N = meta.node_fields.length;
  const E = meta.edge_fields.length;
  const [nType, nName, nEdges] = ['type', 'name', 'edge_count'].map((f) => meta.node_fields.indexOf(f));
  const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((f) => meta.edge_fields.indexOf(f));
  const nodeTypes = meta.node_types[nType];
  const edgeTypes = meta.edge_types[eType];
  const count = nodes.length / N;
  const target = [];
  for (let n = 0; n < count; n += 1) if (/string/.test(nodeTypes[nodes[n * N + nType]]) && strings[nodes[n * N + nName]].includes(value)) target.push(n);
  if (target.length === 0) return null;
  const owner = new Map(target.map((n) => [n, null])); // node -> [retainer, edge label]
  let frontier = new Set(target);
  let root = null;
  for (let d = 0; d < depth && frontier.size > 0 && root === null; d += 1) {
    const next = new Set();
    for (let from = 0, e = 0; from < count; from += 1) {
      for (let k = 0; k < nodes[from * N + nEdges]; k += 1, e += E) {
        const to = edges[e + eTo] / N;
        if (!frontier.has(to) || owner.has(from)) continue;
        const kind = edgeTypes[edges[e + eType]];
        if (kind === 'weak') continue;
        const name = kind === 'element' || kind === 'hidden' ? `[${edges[e + eName]}]` : strings[edges[e + eName]];
        owner.set(from, [to, `${kind}:${String(name).slice(0, 40)}`]);
        next.add(from);
        if (nodeTypes[nodes[from * N + nType]] === 'synthetic') root = from;
      }
    }
    frontier = next;
  }
  // Walk back from the deepest node reached (the root when one was), down to the string.
  let at = root ?? [...frontier][0] ?? target[0];
  const path = [];
  while (at !== undefined && owner.has(at)) {
    const step = owner.get(at);
    path.push(`${nodeTypes[nodes[at * N + nType]]} ${String(strings[nodes[at * N + nName]]).slice(0, 60)}${step === null ? '' : ` -${step[1]}->`}`);
    at = step === null ? undefined : step[0];
  }
  return path;
}
/** Whether any of `values` rides a request: its path, query, any header or its body. */
const carries = (r, values) => {
  const wire = `${r.path}${r.query}\n${JSON.stringify(r.headers)}\n${r.body}`;
  return values.some((v) => wire.includes(v));
};

scenario('SDB-05', 'AC-15 USER SWITCH IN ONE TAB (DA-193, DA-198) — user A, with a store chosen, its row listed, the reopen dialog open and an unconfirmed save held, signs out and user B signs in in the same document: no A store choice, row, dialog or held attempt shows, no draft POST is sent during or after the switch, no request after the sign-out but A\'s logout carries A\'s session CSRF token, and B\'s own list works; A, back in the same document, finds the attempt detached (no Check again)', async () => {
  const tenant = await newTenant('d5');
  const westName = `M7SDB d5 west ${SUFFIX}`;
  const west = { id: await newStore(tenant, westName), name: westName };
  const [customer] = await seedCustomers(tenant, [`M7SDB d5 Quinn ${SUFFIX}`]);
  // A and B: two accounts of one tenant, each with its tenant grant (the picker and the names) and a store grant at W.
  const a = await actor('d5-a', [grant(tenant, 'store_owner'), storeGrant(tenant, west.id, 'store_owner')], { role: 'store_owner' });
  const b = await actor('d5-b', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager')], { role: 'manager' });
  const seedLabel = 'M7SDB d5 seed';
  const [dSeed] = await seedDrafts(tenant, west.id, customer.id, a.id, 1, seedLabel);
  const page = await recordWrites(await openPage());
  await signIn(page, a);

  // 1. A: W chosen, its row listed, a save held unconfirmed (it committed; its answer lost at the front), the reopen open.
  await openDrafts(page);
  await pickStore(page, west.id);
  await waitDraftRows(page, [dSeed], 'A lists W', customer.name);
  const heldLines = [typed(`West held by A ${SUFFIX}`, '2', '7.25', 725)];
  await composeDraft(page, customer.id, heldLines);
  let lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isDraftCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-new-save'));
    await waitData(page, 'drafts-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  await page.click(by('draft-new-cancel'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-hold')}?.dataset.state === 'unresolved'`, 15_000, 'the attempt held in the section');
  const view = await reopenDraft(page, dSeed, customer.name);
  const [first] = sentBy(page, isDraftCreate);
  const heldDraft = (await storedDrafts(tenant)).find((d) => d.lines[0]?.description === heldLines[0].description);
  assert.ok(heldDraft, 'the lost create committed');
  const beforeOut = {
    chosen: await chosenStore(page), rows: (await draftRowsOf(page)).map((r) => r.id), view: await has(page, 'draft-view'),
    hold: await holdState(page), check: await offered(page, 'drafts-check-again'),
  };
  const aLogin = st.api.filter(acceptedLogin(a)).at(-1);
  assert.ok(aLogin, 'the page established A\'s tenant session');
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  const dBefore = await draftCounts(tenant);
  const before = await counts();
  record('SDB-05', { phase: 'A before the sign-out', ...beforeOut, viewLines: view.lines.length, aTokens: aTokens.length, posts: sentBy(page, isDraftCreate).map(apiLine) });
  assert.deepEqual(beforeOut, { chosen: west.id, rows: [dSeed], view: true, hold: 'unresolved', check: true },
    'A: W chosen, its row listed, the reopen dialog open, the save held with Check again');
  assert.deepEqual(view.lines, viewCells([typed(`${seedLabel} 1 ${SUFFIX}`, '1', '1', 100)]), 'the reopen shows the stored line');
  assert.ok(aTokens.length > 0 && aTokens.every((t) => typeof t === 'string' && t.length >= 16), 'A\'s session CSRF token was seen');

  // 2. A signs out in this tab; B signs in through the /login the route guard shows — the same document.
  await page.evaluate('window.__sdbSameDocument = true');
  const out = await signOutHere(page);
  const atLogin = { view: await has(page, 'draft-view'), section: await has(page, 'drafts-section') };
  await page.waitFor(async () => (await readWith(aLogin.cookie)).status === 401, 20_000, 'A\'s tenant session ended by the sign-out');
  await page.waitFor(() => st.api.slice(out).some((r) => isLogout(r) && r.handedBack === true), 20_000, 'the logout\'s answer was handed to the page');
  await page.settle();
  // DA-198: once the logout has run, nothing in the page's JavaScript heap keeps A's token. A snapshot may still catch the logout's
  // own work finishing (it sends the token), so up to three are taken, a second apart; a holder that keeps it never clears.
  let aTokensInHeap = null;
  for (let i = 0; i < 3 && aTokensInHeap !== 0; i++) {
    if (i > 0) await delay(1_000);
    aTokensInHeap = (await heldInHeap(page, aTokens)).length;
  }
  await signInHere(page, b);
  const same = await page.evaluate(SAME_DOCUMENT);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'B\'s Invoices page');
  await page.settle();
  const shownOfA = async () => {
    const html = await page.evaluate('document.documentElement.outerHTML');
    return [dSeed, heldDraft.id, heldLines[0].description, `${seedLabel} 1 ${SUFFIX}`, customer.id].filter((v) => html.includes(v)).length;
  };
  const atSwitch = {
    hold: await has(page, 'drafts-hold'), check: await has(page, 'drafts-check-again'), view: await has(page, 'draft-view'),
    store: await has(page, 'drafts-store'), rows: await has(page, 'drafts-row'), notice: await has(page, 'drafts-notice'), shownOfA: await shownOfA(),
  };
  // B's own "Show server drafts": B's stores, none chosen; still nothing of A.
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  const afterShow = {
    options: (await storeOptions(page)).map((o) => o.value), chosen: await chosenStore(page), rows: await has(page, 'drafts-row'),
    hold: await has(page, 'drafts-hold'), view: await has(page, 'draft-view'), shownOfA: await shownOfA(),
  };
  // B's own list of W: the store's drafts (A's seeded one and the one A's lost reply committed), read under B's session.
  const westIds = (await storedDrafts(tenant)).filter((d) => d.storeId === west.id).map((d) => d.id);
  await pickStore(page, west.id);
  await waitDraftRows(page, westIds, 'B lists W', customer.name);
  const bNew = await page.waitFor(() => offered(page, 'drafts-new'), 30_000, 'B is offered New once the server allows it').then(() => true, () => false);
  await quiet(page, out);
  await delay(2_000); // whatever it would still send on its own, it has sent
  const after = sentBy(page, () => true, out);
  const bLogins = after.filter(acceptedLogin(b));
  const evidenceOfSwitch = {
    same, atLogin, aTokensInHeap, atSwitch, afterShow, bNew,
    posts: after.filter((r) => r.method === 'POST').map((r) => `${r.path} ${answered(r)}`),
    carriersOfA: after.filter((r) => carries(r, aTokens)).map(apiLine),
    lists: sentBy(page, isDraftList(west.id), out).map((r) => `${carries(r, aTokens) ? 'A' : carries(r, answeredTokens(after)) ? 'B' : 'none'} ${answered(r)}`),
  };
  record('SDB-05', { phase: 'B after the switch', ...evidenceOfSwitch, requests: after.map(apiLine) });
  assert.equal(same, true, 'the same document: nothing was reloaded, the module memory is the one A left');
  assert.deepEqual(atLogin, { view: false, section: false }, 'signed out: the Invoices page and its dialog are gone');
  assert.equal(aTokensInHeap, 0, 'once signed out, A\'s session CSRF token is held nowhere in the page\'s JavaScript heap (the draft hold store and the picker heard the sign-out)');
  assert.deepEqual(atSwitch, { hold: false, check: false, view: false, store: false, rows: false, notice: false, shownOfA: 0 },
    'B\'s Invoices page shows no store choice, row, dialog, held attempt or notice of A');
  assert.deepEqual(afterShow, { options: ['', west.id], chosen: '', rows: false, hold: false, view: false, shownOfA: 0 },
    'B\'s stores, none chosen; no row, held attempt or dialog of A');
  assert.equal(bNew, true, 'B, a manager at W, is offered a draft of its own');
  assert.deepEqual(sentBy(page, isDraftCreate, out), [], 'no draft POST during or after the switch');
  assert.ok(evidenceOfSwitch.posts.length > 0 && evidenceOfSwitch.posts.every((p) => p.startsWith('/api/v1/session/logout ') || p.startsWith(`${LOGIN} `)),
    `the switch's only POSTs: a logout and B's login (${evidenceOfSwitch.posts.join('; ')})`);
  assert.equal(bLogins.length, 1, 'B signed in to the tenant server once');
  const aLogouts = after.filter((r) => isLogout(r) && r.status === 204 && (r.headers.cookie ?? '').includes(aLogin.cookie));
  assert.equal(aLogouts.length, 1, `one logout, carrying A's cookie, ended A's session: ${after.map(apiLine).join('; ')}`);
  assert.ok(carries(aLogouts[0], aTokens), 'that logout names A\'s session by its CSRF token');
  assert.deepEqual(after.filter((r) => r !== aLogouts[0] && carries(r, aTokens)).map(apiLine), [],
    'no request after the sign-out but that logout carries A\'s session CSRF token');
  assert.deepEqual(after.filter((r) => r !== aLogouts[0] && (r.headers.cookie ?? '').includes(aLogin.cookie)).map(apiLine), [], 'nor A\'s session cookie');
  assert.deepEqual(evidenceOfSwitch.lists, ['B 200'], 'B\'s list of W: one read, under B\'s session');
  assert.deepEqual(await draftCounts(tenant), dBefore, 'no draft, line, audit or event written by the switch');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'no completion or idempotency record written by the switch');

  // 3. B signs out; A signs in again in the same document: A's attempt is there, detached, and can never be sent.
  const back = await signOutHere(page);
  await signInHere(page, a);
  const sameAgain = await page.evaluate(SAME_DOCUMENT);
  await go(page, '/invoices');
  await page.waitFor(`${q('drafts-hold')}?.dataset.state === 'detached'`, 30_000, 'A\'s attempt, shown detached');
  const aBack = { hold: await holdState(page), check: await has(page, 'drafts-check-again'), text: await textOf(page, 'drafts-hold') };
  await page.click(by('drafts-stop'));
  await page.waitFor(`!${q('drafts-hold')}`, 15_000, 'stopped tracking');
  await page.settle();
  const stopFocus = await focusOf(page);
  await quiet(page, back);
  await delay(1_000); // whatever it would still send on its own, it has sent
  record('SDB-05', { phase: 'A back', sameAgain, aBack, stopFocus, requests: sentBy(page, () => true, back).map(apiLine), posts: sentBy(page, isDraftCreate).map(apiLine) });
  assert.equal(sameAgain, true, 'still the same document');
  assert.equal(aBack.hold, 'detached', 'A\'s attempt is shown detached');
  assert.equal(aBack.check, false, 'no Check again: it can never be sent');
  assert.ok(aBack.text.startsWith(HOLD_DETACHED), `the card says so: ${aBack.text}`);
  assert.equal(stopFocus, HEADING, 'Stop tracking hands focus to the section heading');
  assert.deepEqual(sentBy(page, isDraftCreate).map((r) => `${r.status} ${r.lost ?? 'delivered'}`), ['201 response'], 'ONE draft POST in the whole case: the lost one');
  assert.deepEqual((await storedDrafts(tenant)).map((d) => d.id).sort(), [dSeed, heldDraft.id].sort(), 'exactly the seeded draft and the one the lost reply committed');
  await assertDraftsNowhere([page], [dSeed, heldDraft.id, first.headers['idempotency-key'], customer.id, first.body, heldLines[0].description]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-06', 'DA-199 FOCUS IN REAL CHROMIUM — outside the dialogs no press leaves focus on <body>: Show server drafts, the stores\' Try again, the list\'s Try again and the stores\' Reconnect put it on the section heading; Load more keeps it while more pages remain (aria-disabled during its parked read, a press then sending nothing), moves it to the first row the last page appended, and to the heading when its read is lost', async () => {
  const { tenant, stores: [paged, short], boss } = await draftShop('d7', ['paged', 'short']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d7 Fern ${SUFFIX}`]);
  const pagedIds = await seedDrafts(tenant, paged.id, customer.id, boss.id, 45, 'M7SDB d7 paged');
  const shortIds = await seedDrafts(tenant, short.id, customer.id, boss.id, 25, 'M7SDB d7 short');
  const page = await openPage();
  await signIn(page, boss);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'the Server drafts section offers Show');
  await page.settle();
  const seen = {};

  // 1. "Show server drafts", its stores read lost at the front: the heading. The stores' "Try again": the heading.
  let lostStores = 0;
  try {
    st.lose = (rec, phase) => phase === 'request' && isStoresRead(rec) && rec.frameId === page.frameId && lostStores++ === 0;
    await page.click(by('drafts-show'));
    await waitData(page, 'drafts-stores-state', 'phase', 'unavailable');
  } finally {
    st.lose = null;
  }
  await page.settle();
  seen.show = await focusOf(page);
  seen.storesRetryLabel = await textOf(page, 'drafts-retry');
  await page.click(by('drafts-retry'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  await page.settle();
  seen.storesRetry = await focusOf(page);

  // 2. The list's first read lost: the list's "Try again": the heading.
  let lostList = 0;
  try {
    st.lose = (rec, phase) => phase === 'request' && isDraftList(paged.id)(rec) && rec.frameId === page.frameId && lostList++ === 0;
    await pickStore(page, paged.id);
    await waitData(page, 'drafts-list-state', 'phase', 'unavailable');
  } finally {
    st.lose = null;
  }
  await page.click(by('drafts-list-retry'));
  await waitDraftRows(page, pagedIds.slice(0, 20), 'page one of the paged store');
  await page.settle();
  seen.listRetry = await focusOf(page);

  // 3. "Load more" with pages left, its answer parked: focus stays on it, aria-disabled (never disabled); a press then
  //    sends nothing; the answer appends page two and Load more, still there, keeps focus.
  const parked = gate((r) => r.frameId === page.frameId && isDraftList(paged.id)(r) && r.query.includes('cursor='), 'response');
  const fromMore = st.api.length;
  await page.click(by('drafts-load-more'));
  const moreRead = await Promise.race([parked.reached, delay(30_000).then(() => null)]);
  assert.ok(moreRead, 'Load more\'s read reached the entry; its answer is parked');
  await page.settle();
  seen.duringRead = {
    focus: await focusOf(page), ariaDisabled: await page.evaluate(`${q('drafts-load-more')}?.getAttribute('aria-disabled') ?? null`),
    disabled: await page.evaluate(`${q('drafts-load-more')}?.disabled ?? null`),
  };
  await page.click(by('drafts-load-more')); // pressed again during the read
  await page.settle();
  seen.readsWhileParked = sentBy(page, isDraftList(paged.id), fromMore).length;
  parked.release();
  await waitDraftRows(page, pagedIds.slice(0, 40), 'page two appended');
  await page.settle();
  seen.morePages = { focus: await focusOf(page), loadMore: await has(page, 'drafts-load-more') };

  // 4. "Load more" bringing the last page: Load more goes; focus on the first row it appended (its Open).
  await page.click(by('drafts-load-more'));
  await waitDraftRows(page, pagedIds, 'the last page appended');
  await page.waitFor(`!${q('drafts-load-more')}`, 10_000, 'Load more gone after the last page');
  await page.settle();
  seen.lastPage = await focusOf(page);

  // 5. The other store: "Load more" whose read is lost — Load more goes (the rows kept, last known): the heading.
  await pickStore(page, short.id);
  await waitDraftRows(page, shortIds.slice(0, 20), 'page one of the short store');
  let lostMore = 0;
  try {
    st.lose = (rec, phase) => phase === 'request' && isDraftList(short.id)(rec) && rec.query.includes('cursor=') && rec.frameId === page.frameId && lostMore++ === 0;
    await page.click(by('drafts-load-more'));
    await waitData(page, 'drafts-list-state', 'phase', 'unavailable');
  } finally {
    st.lose = null;
  }
  await page.settle();
  seen.moreLost = { focus: await focusOf(page), loadMore: await has(page, 'drafts-load-more'), retry: await has(page, 'drafts-list-retry'), rows: (await draftRowsOf(page)).length };

  // 6. The session ended in the store, found on a focus: "Reconnect" (one login): the heading.
  await endSessions(boss);
  await page.evaluate(`dispatchEvent(new Event('focus'))`);
  await waitData(page, 'drafts-stores-state', 'phase', 'signed-out');
  seen.reconnectLabel = await textOf(page, 'drafts-retry');
  const fromReconnect = st.api.length;
  await page.click(by('drafts-retry'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  await page.settle();
  seen.reconnect = await focusOf(page);
  seen.reconnectLogins = sentBy(page, isLogin, fromReconnect).map(answered);
  record('SDB-06', seen);

  assert.equal(seen.show, HEADING, '"Show server drafts" (it goes): the heading');
  assert.equal(seen.storesRetryLabel, 'Try again');
  assert.equal(seen.storesRetry, HEADING, 'the stores\' "Try again" (it goes): the heading');
  assert.equal(seen.listRetry, HEADING, 'the list\'s "Try again" (it goes): the heading');
  assert.deepEqual(seen.duringRead, { focus: 'drafts-load-more', ariaDisabled: 'true', disabled: false }, 'during its read Load more keeps focus: aria-disabled, never disabled');
  assert.equal(seen.readsWhileParked, 1, 'a press during the read sends nothing');
  assert.deepEqual(seen.morePages, { focus: 'drafts-load-more', loadMore: true }, 'more pages left: focus stays on Load more');
  assert.equal(seen.lastPage, `drafts-open-${pagedIds[40]}`, 'the last page: focus on the first row it appended');
  assert.deepEqual(seen.moreLost, { focus: HEADING, loadMore: false, retry: true, rows: 20 }, 'a lost Load more read: the heading, the rows kept');
  assert.equal(seen.reconnectLabel, 'Reconnect');
  assert.equal(seen.reconnect, HEADING, '"Reconnect" (it goes): the heading');
  assert.deepEqual(seen.reconnectLogins, ['200'], 'Reconnect: exactly one login');
  assert.deepEqual(sentBy(page, isDraftCreate), [], 'nothing was saved');
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-07', 'AC-04 BROWSER-ONLY CUSTOM ROLE AGAINST THE SERVER\'S AUTHORITY — the owner makes a custom role with Invoices Full in the shop\'s own Roles tab (page memory only); the harness seeds a technician-granted account\'s users/{uid}.role with its id, standing for a browser-only role the shop cannot persist; signed in in the same document, the page offers Create Invoice on that local hint and lists the store\'s draft (View), but the server\'s eligibility is 403 and New server draft is NOT offered (M7B-INVOICES-P1-R2, AC-09); the save, sent directly from the page with its own session, is refused 403 forbidden and writes nothing (AC-10)', async () => {
  const tenant = await newTenant('d7-custom');
  const mainName = `M7SDB d7c main ${SUFFIX}`;
  const main = { id: await newStore(tenant, mainName), name: mainName };
  const [customer] = await seedCustomers(tenant, [`M7SDB d7c Robin ${SUFFIX}`]);
  const boss = await actor('d7-custom-owner', [grant(tenant, 'store_owner'), storeGrant(tenant, main.id, 'store_owner')], { role: 'store_owner' });
  const custom = `M7SDB Inv Full ${SUFFIX}`;
  const customId = custom.toLowerCase().replace(/\s+/g, '_'); // Employees.tsx handleCreateRole's id for that name
  // The shop can neither persist this role nor assign it (it only READS users/{uid}; firestore.rules allows the client no
  // write there), so the harness seeds users/{uid}.role with the role's id, as it seeds every account's role, to stand
  // for a browser-only role. How the page derives its hint for it: AccessContext reads users/{uid}.role at sign-in into
  // session.role, so effectiveRole is that id (no POS operator role is set here); checkPermission (decideTenantPermission
  // → tenantPermissionLevel, tenantAccessDecisions.ts) finds the role with that id in tenantRolesState — the in-memory list
  // the owner's addTenantRole appended it to in THIS document — and reads its Invoices level, Full; so Invoices.tsx's
  // local Create Invoice is offered. The Server drafts section takes no local hint since M7B-INVOICES-P1-R2: its New
  // follows the server's eligibility only. In a fresh document the id would match no role: level `none`, and canAccess
  // refuses the page.
  const tech = await actor('d7-custom-tech', [grant(tenant, 'technician'), storeGrant(tenant, main.id, 'technician')], { role: customId });
  const [dSeed] = await seedDrafts(tenant, main.id, customer.id, boss.id, 1, 'M7SDB d7c seed');
  const page = await recordWrites(await openPage());

  // 1. The owner makes the custom role in the shop's Roles tab and gives it Invoices Full and Customers View in the grid.
  await ownerPanel(boss, page);
  const fsFrom = st.firestore.length;
  const local = st.api.length;
  await createCustomRole(page, custom);
  await openPermissions(page);
  await waitState(page, 'Ready');
  const grid = { invoices: await setGridLevel(page, custom, 'Invoices', 'full'), customers: await setGridLevel(page, custom, 'Customers', 'view') };
  await delay(1_000); // whatever the grid would send, it has sent
  const sentByGrid = st.api.slice(local).filter((r) => r.method !== 'GET').map(apiLine);
  const writesByGrid = st.firestore.slice(fsFrom).filter((f) => f.includes('/Write/'));

  // 2. The owner signs out; the account whose seeded users/{uid}.role names that role signs in in the same document.
  await page.evaluate('window.__sdbSameDocument = true');
  const switched = await signOutHere(page);
  await signInHere(page, tech);
  const same = await page.evaluate(SAME_DOCUMENT);
  await openDrafts(page);
  const createInvoice = await page.evaluate(`[...document.querySelectorAll('button')].some((b) => !b.disabled && b.textContent.trim().endsWith('Create Invoice'))`);
  const options = (await storeOptions(page)).map((o) => o.value);
  await pickStore(page, main.id);
  await waitDraftRows(page, [dSeed], 'the technician grant lists the store\'s draft (Invoices View)', customer.name);
  // The server decides New (M7B-INVOICES-P1-R2): its eligibility answer for this store and session, never the local hint.
  await page.waitFor(`${q('drafts-elig')}?.dataset.phase === 'denied'`, 30_000, 'the server\'s eligibility answer: denied');
  await quiet(page, switched);
  const newOffered = await offered(page, 'drafts-new');
  // The refusal is an alert of its own; the section's eligibility status region keeps its role and goes quiet.
  const eligText = await textOf(page, 'drafts-elig-alert');
  const eligRole = await page.evaluate(`${q('drafts-elig-alert')}?.getAttribute('role') ?? null`);
  const eligReads = sentBy(page, isEligibility(main.id), switched);
  const techLogin = st.api.filter(acceptedLogin(tech)).at(-1);
  assert.ok(techLogin, 'the page established the custom-role account\'s tenant session');

  // 3. The direct save, refused on its own: the POST a Save sends, sent from inside the page's document with its own
  // session (the cookie by credentials, the session CSRF token the entry answered this account), as Save would send it.
  const lines = [typed(`Custom role line ${SUFFIX}`, '1', '15', 1_500)];
  const token = answeredTokens(sentBy(page, () => true, switched)).at(-1);
  assert.ok(typeof token === 'string', 'the session CSRF token the entry answered this account');
  const key = randomUUID();
  const before = await counts();
  const dBefore = await draftCounts(tenant);
  const roleBefore = await tenantState(tenant);
  const from = st.api.length;
  const direct = await page.evaluate(`fetch(${JSON.stringify(draftsPath(main.id))}, {
    method: 'POST', credentials: 'include', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ${JSON.stringify(CSRF_HEADER)}: ${JSON.stringify(CSRF_HEADER_VALUE)},
      ${JSON.stringify(SESSION_CSRF_HEADER)}: ${JSON.stringify(token)}, 'Idempotency-Key': ${JSON.stringify(key)} },
    body: ${JSON.stringify(bodyFor(tenant, customer.id, lines))},
  }).then((r) => r.status)`);
  await quiet(page, from);
  await delay(1_000); // whatever it would still send on its own, it has sent
  const posts = sentBy(page, isDraftCreate, from);
  const logins = sentBy(page, isLogin, from);
  const dDelta = minus(await draftCounts(tenant), dBefore);
  const roleAfter = await tenantState(tenant);
  record('SDB-07', { same, grid, sentByGrid, writesByGrid, createInvoice, options, newOffered, eligText, eligReads: eligReads.map(apiLine), direct, posts: posts.map(apiLine), logins: logins.map(apiLine), ...dDelta, roleAfter });
  assert.deepEqual(grid, { invoices: 'full', customers: 'view' }, 'the custom role\'s levels in the local grid');
  assert.deepEqual(sentByGrid, [], 'the role and its levels are local: no write (non-GET) request reaches the tenant server');
  assert.deepEqual(writesByGrid, [], 'nor written to Firestore');
  assert.equal(same, true, 'the same document: the custom role made here is still this page\'s');
  assert.equal(createInvoice, true, 'what the page shows: the local role decides the browser\'s own invoices, so the invoice form\'s Create Invoice is offered');
  assert.deepEqual(options, ['', main.id], 'the server\'s stores for the technician grant');
  assert.deepEqual(eligReads.map(answered), ['403 forbidden'], `the server's eligibility for this store and session: ${eligReads.map(apiLine).join('; ')}`);
  assert.equal(newOffered, false, 'New server draft is NOT offered: the server denied it, whatever the local role\'s Invoices Full says (AC-09)');
  assert.deepEqual([eligText, eligRole], [ELIG_DENIED, 'alert'], 'the section says the account may not save drafts at this store');
  assert.equal(direct, 403, 'the direct POST is refused');
  assert.deepEqual(posts.map(answered), ['403 forbidden'], `ONE POST, refused by the server: ${posts.map(apiLine).join('; ')}`);
  const [post] = posts;
  assert.equal(post.path, draftsPath(main.id), 'to the real store');
  assert.equal(post.body, bodyFor(tenant, customer.id, lines), 'the exact body a Save sends');
  assert.match(post.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.equal(post.headers[CSRF_HEADER], CSRF_HEADER_VALUE, 'with the request-intent header');
  assert.equal(post.headers[SESSION_CSRF], token, 'with the session CSRF token the entry answered this account');
  assert.ok((post.headers.cookie ?? '').includes(techLogin.cookie), 'and the page\'s own session cookie');
  assert.deepEqual(logins, [], 'no login around the save');
  assert.deepEqual(dDelta, { D: 0, L: 0, A: 0, O: 0 }, 'no draft, line, audit or outbox event');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0, T: 0 }, 'refused before anything is recorded: no idempotency completion or lease, no audit of any kind');
  assert.deepEqual((await storedDrafts(tenant)).map((d) => d.id), [dSeed], 'the store holds only its seeded draft');
  assert.deepEqual(roleAfter, roleBefore, 'no role-level row, version or edit audit changed');
  assert.deepEqual(roleAfter.levels, {}, 'no role level is stored for the tenant: the custom role\'s Full reached no server');
  assert.deepEqual(sentBy(page, isDraftCreate).length, 1, 'the page sent no POST of its own: the one is the harness\'s');
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-08', 'AC-15 A READ OUT WHEN ANOTHER USER SIGNS IN (DA-198) — user A has store W chosen and W\'s list answer parked at the front; B signs in in another tab of the same browser, so this tab switches A to B directly and keeps A\'s page mounted while B\'s profile loads (held); A\'s answer, released then, shows nothing and starts nothing: no customer-name read, and no request from this tab after the switch began but its logout of A\'s session carries A\'s session CSRF token', async () => {
  const tenant = await newTenant('d8');
  const westName = `M7SDB d8 west ${SUFFIX}`;
  const west = { id: await newStore(tenant, westName), name: westName };
  const [customer] = await seedCustomers(tenant, [`M7SDB d8 Rowan ${SUFFIX}`]);
  const a = await actor('d8-a', [grant(tenant, 'store_owner'), storeGrant(tenant, west.id, 'store_owner')], { role: 'store_owner' });
  const b = await actor('d8-b', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager')], { role: 'manager' });
  const [dSeed] = await seedDrafts(tenant, west.id, customer.id, a.id, 1, 'M7SDB d8 seed');
  const page = await recordWrites(await openPage());
  await signIn(page, a);
  await openDrafts(page);
  // 1. W's list read reaches the entry and is answered (A's row); the answer is parked at the front.
  const parked = gate((r) => r.frameId === page.frameId && isDraftList(west.id)(r), 'response');
  await pickStore(page, west.id);
  const listRead = await Promise.race([parked.reached, delay(30_000).then(() => null)]);
  assert.ok(listRead, 'W\'s list read reached the entry; its answer is parked');
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  assert.ok(aTokens.length > 0, 'A\'s session CSRF token was seen');
  // 2. B signs in in a second tab of this browser (SRL-09's switch): this tab's Firebase SDK follows the shared sign-in,
  // and AccessContext starts A's logout and then awaits B's users/{uid} profile — held here, so A's page stays mounted.
  const from = st.api.length;
  const profile = profileGate(page, b.uid);
  const tab = await sameContextTab(page);
  await signIn(tab, b);
  const reached = await Promise.race([profile.reached.then(() => true), delay(30_000).then(() => false)]);
  assert.ok(reached, 'this tab reads B\'s profile: the switch has begun (A\'s logout was started first)');
  await page.waitFor(() => sentBy(page, isLogout, from).length > 0, 15_000, 'A\'s logout left this tab');
  // 3. A's answer, released while A's page is still mounted (B's profile still held).
  parked.release();
  await page.waitFor(() => listRead.handedBack === true, 15_000, 'the parked answer was handed back to the browser');
  await page.settle();
  await delay(1_500); // whatever reaching the page would make it do, it has done
  const whileMounted = {
    section: await has(page, 'drafts-section'), stores: await page.evaluate(`${q('drafts-stores-state')}?.dataset.phase ?? null`),
    rows: await has(page, 'drafts-row'),
    shownOfA: await page.evaluate(`${JSON.stringify([dSeed, customer.name])}.filter((v) => document.documentElement.outerHTML.includes(v)).length`),
  };
  profile.release();
  await page.waitFor(`!!${q('drafts-show')} && !${q('drafts-stores-state')}`, 30_000, 'B\'s Invoices page in this tab (A\'s section gone)');
  await quiet(page, from);
  await delay(2_000); // whatever it would still send on its own, it has sent
  const after = sentBy(page, () => true, from);
  const seen = {
    whileMounted,
    nameReads: after.filter(isDetail).map(apiLine),
    carriersOfA: after.filter((r) => !isLogout(r) && carries(r, aTokens)).map(apiLine),
    shownOfA: await page.evaluate(`${JSON.stringify([dSeed, customer.id, customer.name])}.filter((v) => document.documentElement.outerHTML.includes(v)).length`),
  };
  record('SDB-08', { parked: answered(listRead), ...seen, requests: after.map(apiLine) });
  assert.equal(listRead.status, 200);
  assert.ok(listRead.replied.text.includes(dSeed), 'the parked answer was a real one, naming A\'s draft');
  assert.deepEqual(seen, { whileMounted: { section: true, stores: 'signed-out', rows: false, shownOfA: 0 }, nameReads: [], carriersOfA: [], shownOfA: 0 },
    'released while A\'s section was still mounted (B\'s profile held), A\'s answer showed nothing and started nothing; the section had ended at the sign-out');
  const aLogouts = after.filter((r) => isLogout(r) && carries(r, aTokens));
  assert.equal(aLogouts.length, 1, `this tab sent one logout, naming A's session: ${after.map(apiLine).join('; ')}`);
  assert.deepEqual(sentBy(page, isDraftCreate), [], 'no draft POST');
  await assertNoLeak(page);
}, 180_000);

// ---------------------------------------------------------------------------------------------------------------------
// M7B-INVOICES-P1-R2 — server eligibility (DA-201, journey D): SDB-09 and SDB-10
// ---------------------------------------------------------------------------------------------------------------------

const eligPhaseOf = (page) => page.evaluate(`${q('drafts-elig')}?.dataset.phase ?? null`);
/**
 * The browser-side end of `page`'s requests (CDP Network domain, enabled on this page only): each request's id by path in
 * send order, and how its load ended — finished (the page received the answer) or failed (canceled: the page aborted it,
 * so no answer can reach it). Call before the requests it must see.
 */
async function watchNetwork(page) {
  const sent = [];
  const ends = new Map();
  const waiters = new Map();
  const end = (id, how) => { ends.set(id, how); waiters.get(id)?.(how); };
  page.on('Network.requestWillBeSent', (e) => { try { sent.push({ id: e.requestId, path: new URL(e.request.url).pathname }); } catch { /* not a URL */ } });
  page.on('Network.loadingFinished', (e) => end(e.requestId, 'finished'));
  page.on('Network.loadingFailed', (e) => end(e.requestId, e.canceled === true ? 'canceled' : `failed ${e.errorText}`));
  await page.send('Network.enable');
  page.net = {
    /** How many requests to `path` the browser has sent so far: taken just before a request is parked. */
    mark: (path) => sent.filter((r) => r.path === path).length,
    /**
     * How the browser ended THE request to `path` sent after `mark` (exactly one: the parked one), null if it has not
     * within `timeout`.
     */
    endOfParked(path, mark, timeout = 15_000) {
      const after = sent.filter((r) => r.path === path).slice(mark);
      assert.equal(after.length, 1, `exactly one request to ${path} since the park began: ${after.length}`);
      const [parked] = after;
      if (ends.has(parked.id)) return Promise.resolve(ends.get(parked.id));
      return Promise.race([new Promise((ok) => waiters.set(parked.id, ok)), delay(timeout).then(() => null)]);
    },
  };
  return page;
}
/** One role's Invoices level set outside the browser the way the shop's owner sets it: read the tenant, then PUT asserting `expectedVersion`. */
async function setInvoicesLevel(session, roleId, level, expectedVersion) {
  const read = await call('GET', ROLE_LEVELS, { session });
  assert.equal(read.status, 200, read.text);
  const { tenant } = JSON.parse(read.text);
  const res = await call('PUT', ROLE_LEVELS, { session, body: { roleId, domain: 'invoices', level, reason: REASON, expectedTenant: tenant, expectedVersion }, key: randomUUID() });
  assert.equal(res.status, 200, `the owner's Invoices level for ${roleId}: ${res.text}`);
}
/** Park `page`'s next eligibility read of `store` at `phase`; answers the parked record (null after 30 s). */
async function parkEligibility(page, store, phase, choose = true) {
  const g = gate((r) => r.frameId === page.frameId && isEligibility(store)(r), phase);
  if (choose) await pickStore(page, store);
  const rec = await Promise.race([g.reached, delay(30_000).then(() => null)]);
  assert.ok(rec, `the eligibility read of the store reached the front (${phase})`);
  return { rec, release: g.release };
}

scenario('SDB-09', 'DA-201 SERVER ELIGIBILITY (AC-08, AC-11, AC-13) — a manager gets New only once the server\'s eligibility for the chosen store answers allowed (parked: checking, no New); W\'s allowance released after a switch to E offers nothing at E; the owner lowering the manager\'s Invoices level makes the next check 403 and New goes, raising it back brings New again; the checks write nothing and nothing is posted', async () => {
  const tenant = await newTenant('d9');
  const westName = `M7SDB d9 west ${SUFFIX}`;
  const eastName = `M7SDB d9 east ${SUFFIX}`;
  const west = { id: await newStore(tenant, westName), name: westName };
  const east = { id: await newStore(tenant, eastName), name: eastName };
  const boss = await actor('d9-owner', [grant(tenant, 'store_owner')], { role: 'store_owner' });
  const mgr = await actor('d9-mgr', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager'), storeGrant(tenant, east.id, 'manager')], { role: 'manager' });
  const page = await watchNetwork(await recordWrites(await openPage()));
  await signIn(page, mgr);
  await openDrafts(page);
  const dBefore = await draftCounts(tenant);
  const before = await counts();
  const start = st.api.length;

  // 1. W: the allowance parked at the front — checking, no New — then released: New.
  const first = await parkEligibility(page, west.id, 'response');
  await page.waitFor(async () => (await eligPhaseOf(page)) === 'checking', 15_000, 'the section says it is checking');
  const whileParked = { newShown: await has(page, 'drafts-new'), text: await textOf(page, 'drafts-elig'), role: await page.evaluate(`${q('drafts-elig')}?.getAttribute('role') ?? null`) };
  first.release();
  await page.waitFor(() => offered(page, 'drafts-new'), 30_000, 'New once the server allowed it');
  const firstRead = first.rec;

  // 2. A stale allowance cannot cross a store switch: E's check parked before the entry, W's next allowance parked at the
  // front, E chosen again (parked before the entry); W's allowance released while E is chosen.
  const e1 = await parkEligibility(page, east.id, 'request');
  const w2Mark = page.net.mark(`${draftsPath(west.id)}/eligibility`);
  const w2 = await parkEligibility(page, west.id, 'response');
  const e2 = await parkEligibility(page, east.id, 'request');
  w2.release();
  await page.waitFor(() => w2.rec.handedBack === true, 15_000, 'W\'s allowance was handed back to the browser');
  // The browser's own end of that very request: finished (the page received the answer) or canceled (the page aborted
  // it on the switch, so no answer can reach it); then two frames, so whatever it made the page do has run.
  const w2End = await page.net.endOfParked(`${draftsPath(west.id)}/eligibility`, w2Mark);
  assert.ok(w2End !== null, 'the browser ended W\'s parked request');
  await page.settle();
  const atEast = { chosen: await chosenStore(page), newShown: await has(page, 'drafts-new'), phase: await eligPhaseOf(page) };
  e1.release();
  e2.release();
  await page.waitFor(() => offered(page, 'drafts-new'), 30_000, 'E\'s own allowance: New');

  // 3. The owner lowers the manager's Invoices level to View: the next check (W chosen) is 403, and New goes.
  const ownerSession = await directLogin(boss);
  await setInvoicesLevel(ownerSession, 'manager', 'view', 0);
  const lowered = await tenantState(tenant);
  const writesFrom = await counts();
  const dFrom = await draftCounts(tenant);
  const lowerAt = st.api.length;
  await pickStore(page, west.id);
  await page.waitFor(async () => (await eligPhaseOf(page)) === 'denied', 30_000, 'W: the server denies it now');
  const deniedWest = { newShown: await has(page, 'drafts-new'), text: await textOf(page, 'drafts-elig-alert'), role: await page.evaluate(`${q('drafts-elig-alert')}?.getAttribute('role') ?? null`) };
  await pickStore(page, east.id);
  await page.waitFor(async () => (await eligPhaseOf(page)) === 'denied', 30_000, 'E: denied too');
  const deniedEast = { newShown: await has(page, 'drafts-new') };
  await quiet(page, lowerAt);
  const deniedReads = sentBy(page, (r) => isEligibility(west.id)(r) || isEligibility(east.id)(r), lowerAt);
  const deniedWrites = { ...minus(await draftCounts(tenant), dFrom), roleChanged: JSON.stringify(await tenantState(tenant)) !== JSON.stringify(lowered) };
  await assertDelta(writesFrom, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0, T: 0 }, 'the denied checks recorded nothing: no completion, lease, idempotency record or audit');

  // 4. Raised back to Create: the next check (W chosen) offers New again.
  await setInvoicesLevel(ownerSession, 'manager', 'create', 1);
  await pickStore(page, west.id);
  await page.waitFor(() => offered(page, 'drafts-new'), 30_000, 'W: allowed again');
  await quiet(page, start);
  const reads = sentBy(page, (r) => isEligibility(west.id)(r) || isEligibility(east.id)(r), start);
  record('SDB-09', {
    whileParked, firstRead: answered(firstRead), firstBody: firstRead.replied.text, atEast, w2: { handedBack: w2.rec.handedBack === true, status: answered(w2.rec), browserEnd: w2End },
    deniedWest, deniedEast, deniedReads: deniedReads.map(apiLine), deniedWrites, reads: reads.map(apiLine),
  });
  assert.deepEqual(whileParked, { newShown: false, text: 'Checking with the server whether drafts can be saved at this store…', role: 'status' }, 'nothing until the server answers');
  assert.equal(firstRead.status, 200);
  assert.equal(firstRead.replied.text, '{"eligibility":"allowed"}', 'the closed allowance, nothing else');
  assert.equal(firstRead.query, '', 'no query');
  assert.ok(answeredTokens(sentBy(page, () => true, 0)).includes(firstRead.headers[SESSION_CSRF]), 'under the session CSRF token the entry answered this page');
  assert.deepEqual(atEast, { chosen: east.id, newShown: false, phase: 'checking' }, 'W\'s allowance, released while E is chosen, offered nothing at E');
  assert.equal(w2.rec.status, 200, 'what was released was a real allowance');
  assert.deepEqual(deniedWest, { newShown: false, text: ELIG_DENIED, role: 'alert' }, 'the lowered level: W\'s next check takes New away');
  assert.deepEqual(deniedEast, { newShown: false }, 'and E\'s');
  assert.ok(deniedReads.length >= 2 && deniedReads.every((r) => r.status === 403 && r.error === 'forbidden'), `each check after the edit is 403 forbidden: ${deniedReads.map(apiLine).join('; ')}`);
  assert.deepEqual(deniedWrites, { D: 0, L: 0, A: 0, O: 0, roleChanged: false }, 'the denied checks wrote no draft, line, audit, event or role-level row');
  assert.deepEqual(sentBy(page, isDraftCreate), [], 'no draft POST in the whole case');
  assert.deepEqual(minus(await draftCounts(tenant), dBefore), { D: 0, L: 0, A: 0, O: 0 }, 'no draft, line, audit or event in the whole case');
  await assertDelta(before, { C: 0, K: 2, L: 2 }, 'the whole case: no customer; its only completions and idempotency records are the owner\'s two level edits');
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-10', 'DA-201 A STALE ALLOWANCE ACROSS A SESSION/USER SWITCH (AC-13) — A has W chosen and W\'s eligibility allowance parked at the front; B signs in in another tab (B\'s profile held, A\'s page mounted); the allowance released then offers nothing and starts nothing, and only A\'s logout carries A\'s token after the switch', async () => {
  const tenant = await newTenant('d10');
  const westName = `M7SDB d10 west ${SUFFIX}`;
  const west = { id: await newStore(tenant, westName), name: westName };
  const a = await actor('d10-a', [grant(tenant, 'store_owner'), storeGrant(tenant, west.id, 'store_owner')], { role: 'store_owner' });
  const b = await actor('d10-b', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager')], { role: 'manager' });
  const page = await watchNetwork(await recordWrites(await openPage()));
  await signIn(page, a);
  await openDrafts(page);
  const parkMark = page.net.mark(`${draftsPath(west.id)}/eligibility`);
  const parked = await parkEligibility(page, west.id, 'response');
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  assert.ok(aTokens.length > 0, 'A\'s session CSRF token was seen');
  const from = st.api.length;
  const profile = await switchHeld(page, b, from);
  parked.release();
  await page.waitFor(() => parked.rec.handedBack === true, 15_000, 'the parked allowance was handed back to the browser');
  // The browser's own end of that very request (finished: received; canceled: aborted by the sign-out), then two frames.
  const parkedEnd = await page.net.endOfParked(`${draftsPath(west.id)}/eligibility`, parkMark);
  assert.ok(parkedEnd !== null, 'the browser ended the parked request');
  await page.settle();
  const whileMounted = {
    section: await has(page, 'drafts-section'), stores: await page.evaluate(`${q('drafts-stores-state')}?.dataset.phase ?? null`),
    newShown: await has(page, 'drafts-new'), dialog: await has(page, 'draft-new'),
  };
  profile.release();
  await page.waitFor(`!!${q('drafts-show')} && !${q('drafts-stores-state')}`, 30_000, 'B\'s Invoices page in this tab (A\'s section gone)');
  await quiet(page, from);
  const after = sentBy(page, () => true, from);
  const seen = {
    whileMounted, newNow: await has(page, 'drafts-new'),
    eligAfter: after.filter((r) => isEligibility(west.id)(r)).map(apiLine),
    carriersOfA: after.filter((r) => !isLogout(r) && carries(r, aTokens)).map(apiLine),
  };
  record('SDB-10', { parked: answered(parked.rec), browserEnd: parkedEnd, ...seen, requests: after.map(apiLine) });
  assert.equal(parked.rec.status, 200, 'the parked answer was a real allowance');
  assert.deepEqual(seen, {
    whileMounted: { section: true, stores: 'signed-out', newShown: false, dialog: false }, newNow: false, eligAfter: [], carriersOfA: [],
  }, 'released while A\'s section was mounted, A\'s allowance offered nothing and started nothing');
  assert.equal(after.filter((r) => isLogout(r) && carries(r, aTokens)).length, 1, `one logout, naming A's session: ${after.map(apiLine).join('; ')}`);
  assert.deepEqual(sentBy(page, isDraftCreate), [], 'no draft POST');
  await assertNoLeak(page);
}, 180_000);

// ---------------------------------------------------------------------------------------------------------------------
// M7B-INVOICES-P2 — the editor of a saved server draft (AC-16, AC-17): PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}
// and GET …/{id}/edit-eligibility, answered by the real entry over migration 029. Literals: the shop's own texts.
// ---------------------------------------------------------------------------------------------------------------------

const EDIT_DRAFT_ACTION = 'store.invoice_draft.update';
const EDIT_DRAFT_EVENT = 'invoice_draft.updated';
const isDraftPatch = (store, id) => (r) => r.method === 'PATCH' && r.path === `${draftsPath(store)}/${id}`;
const isEditEligibility = (store, id) => (r) => r.method === 'GET' && r.path === `${draftsPath(store)}/${id}/edit-eligibility`;
/** ServerInvoiceDrafts.tsx EDIT_TEXT.saved, .later, .unresolved (its start) and EDIT_ELIGIBILITY_TEXT.denied. */
const EDIT_SAVED = (version) => `Saved on the server: this draft is now version ${version}.`;
const EDIT_LATER = (version) => `It has been changed on the server again since: this is version ${version}.`;
const EDIT_UNRESOLVED = 'Not confirmed yet: the server may have saved your changes.';
const EDIT_DENIED = 'This account may not edit drafts at this store.';
/** The exact PATCH body the shop must send (invoiceDraftsClient.ts draftEditBody: these keys in this order, the lines in order). */
const editBodyFor = (tenant, expectedVersion, customerId, lines) => JSON.stringify({
  expectedTenant: tenant, expectedVersion, customerId,
  lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.cents })),
});

/** E/V/W: one tenant's draft edit audits and edit events, and `draftId`'s stored version, as the database owner reads them. */
async function editCounts(tenant, draftId) {
  const [r] = await owner`select
    (select count(*) from public.audit_event where action_id = ${EDIT_DRAFT_ACTION} and tenant_id = ${tenant})::int as e,
    (select count(*) from tmpos_internal.outbox_event where event_type = ${EDIT_DRAFT_EVENT}
      and (payload ->> 'storeId')::uuid in (select store_id from public.store where tenant_id = ${tenant}))::int as v,
    (select version::int from tmpos_invoice_draft.invoice_draft where draft_id = ${draftId}) as w`;
  return { E: r.e, V: r.v, W: r.w };
}
/** The edit audits of one tenant: scope, store and subject, oldest first. */
async function editAudits(tenant) {
  const rows = await owner`select scope_type, store_id, subject_invoice_draft_id from public.audit_event
    where action_id = ${EDIT_DRAFT_ACTION} and tenant_id = ${tenant} order by occurred_at, event_id`;
  return Array.from(rows, (r) => ({ scope: r.scope_type, store: r.store_id, subject: r.subject_invoice_draft_id }));
}
/** Mark the control `testId` inside line `i` (0-based) of the `prefix` dialog, so a real click can reach it. */
async function markInLine(page, i, testId, prefix = 'draft-edit') {
  const mark = `[data-sdb="line-${i}-${testId}"]`;
  await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by(`${prefix}-line`))})][${i}].querySelector(${JSON.stringify(by(testId))}).setAttribute('data-sdb', 'line-${i}-${testId}')`);
  return mark;
}
/** The editor's lines as its fields hold them: [description, quantity, price] each, in order. */
const editorLines = (page) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(by('draft-edit-line'))})].map((line) =>
  ['description', 'quantity', 'price'].map((f) => line.querySelector('[data-testid="draft-edit-' + f + '"]').value))`);
/** Reopen row `id`, wait for Edit (offered only on the server's own edit eligibility), press it: the editor. */
async function openEditor(page, store, id, customerName) {
  const from = st.api.length;
  await reopenDraft(page, id, customerName);
  await page.waitFor(() => offered(page, 'draft-view-edit'), 30_000, 'Edit is offered: the server\'s edit eligibility allowed it');
  const asked = sentBy(page, isEditEligibility(store, id), from);
  await page.click(by('draft-view-edit'));
  await page.waitFor(`!!${q('draft-edit')} && !${q('draft-view')}`, 15_000, 'the editor replaced the reopen dialog');
  return asked;
}
/**
 * Arm a guard that records every PATCH `page` sends from now on (let through, so the case then fails on it rather than
 * hangs): the "nothing is sent on its own" claims hold it across the page's own observable reaction to what was done
 * (focusAndSettle, a reload's reads and rendered state) — never across a fixed sleep. disarm() answers what it saw.
 */
function patchGuard(page) {
  const seen = [];
  const guard = { phase: 'request', match: (r) => r.frameId === page.frameId && r.method === 'PATCH', hit: (r) => { seen.push(apiLine(r)); st.gates.add(guard); }, released: Promise.resolve() };
  st.gates.add(guard);
  return { disarm: () => { st.gates.delete(guard); return seen; } };
}
/**
 * A window focus (or a tab return) and the page's OWN reaction to it, as a barrier: the session read(s) it sends for it
 * (the section's focus check, and a server-customer field's), every one answered, then two frames.
 */
async function focusAndSettle(page, event = 'focus') {
  const from = st.api.length;
  // A hidden page checks nothing on either event (the section's and the field's own rule): then its reaction is none.
  const visible = await page.evaluate(`document.visibilityState === 'visible'`);
  await page.evaluate(event === 'focus' ? `dispatchEvent(new Event('focus'))` : `document.dispatchEvent(new Event('visibilitychange'))`);
  if (visible) await page.waitFor(() => sentBy(page, isSessionRead, from).length > 0, 15_000, `the page's own session check on ${event}`);
  await quiet(page, from);
  await page.settle();
}
/** Whether `text` is on the page: in its text or the value of any field (an editor's working copy lives in its inputs). */
const typedAnywhere = (text) => `document.body.innerText.includes(${JSON.stringify(text)}) || [...document.querySelectorAll('input, textarea')].some((f) => f.value.includes(${JSON.stringify(text)}))`;
/** The reopen dialog after a save: its saved note, its version, its lines. */
const savedViewOf = (page) => page.evaluate(`({
  saved: ${q('draft-view-saved')}?.textContent.trim() ?? null,
  version: ${q('draft-view-version')}?.textContent.trim() ?? null,
  lines: [...document.querySelectorAll(${JSON.stringify(by('draft-view-line'))})].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())),
})`);

scenario('SDB-11', 'AC-16 EDIT, RELOAD, SECOND SESSION — the owner edits a saved draft (another customer, a line edited, one added, one removed, one moved up): Edit only on the server\'s edit eligibility; ONE PATCH of the exact body under a v4 key, 200 version 2; one version step, one store-scope edit audit naming the draft, one edit event, one completion; "Saved" after ONE read-back; the reload and a second browser through the second entry read version 2 and the new lines; a Create-level account sees no Edit (the server\'s denial) and its direct PATCH from the page is refused 403 with nothing written', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d11', ['main']);
  const [avery, blake] = await seedCustomers(tenant, [`M7SDB d11 Avery ${SUFFIX}`, `M7SDB d11 Blake ${SUFFIX}`]);
  const staff = await actor('d11-staff', [grant(tenant, 'sales_staff'), storeGrant(tenant, main.id, 'sales_staff')], { role: 'sales_staff' });
  const lines = [typed(`Screen ${SUFFIX}`, '1', '100', 10_000), typed(`Cable ${SUFFIX}`, '2', '5.25', 525)];
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [], 'no draft yet');
  await composeDraft(page, avery.id, lines);
  await page.click(by('draft-new-save'));
  await page.waitFor(`!${q('draft-new')} && ${q('drafts-notice')}?.textContent.trim() === ${JSON.stringify(DRAFT_SAVED)}`, 30_000, 'the draft saved and read back');
  const [created] = await storedDrafts(tenant);
  await waitDraftRows(page, [created.id], 'the saved draft is listed', avery.name);

  // 1. The editor: Edit offered on the server's own answer, seeded from the draft just read; then the user's changes.
  const asked = await openEditor(page, main.id, created.id, avery.name);
  const seeded = { lines: await editorLines(page), version: await textOf(page, 'draft-edit-version'), customer: await boundId(page) };
  await openPicker(page, 'picker-change');
  await pickRow(page, blake.id);
  await typeLineField(page, 0, 'description', `Screen glass ${SUFFIX}`, 'draft-edit');
  await page.click(by('draft-edit-add-line'));
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(by('draft-edit-line'))}).length === 3`, 10_000, 'a third line');
  await typeLineField(page, 2, 'description', `Labour ${SUFFIX}`, 'draft-edit');
  await typeLineField(page, 2, 'quantity', '3', 'draft-edit');
  await typeLineField(page, 2, 'price', '40', 'draft-edit');
  await page.click(await markInLine(page, 1, 'draft-edit-remove-line')); // Cable goes
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(by('draft-edit-line'))}).length === 2`, 10_000, 'the line removed');
  await page.click(await markInLine(page, 1, 'draft-edit-up')); // Labour moves up
  const edited = [typed(`Labour ${SUFFIX}`, '3', '40', 4_000), typed(`Screen glass ${SUFFIX}`, '1', '100.00', 10_000)]; // its seeded price, untouched
  const working = await editorLines(page);
  const before = await counts();
  const dBefore = await draftCounts(tenant);
  const eBefore = await editCounts(tenant, created.id);
  const from = st.api.length;
  await page.click(by('draft-edit-save'));
  await page.waitFor(`!${q('draft-edit')} && ${q('draft-view-saved')}?.textContent.trim() === ${JSON.stringify(EDIT_SAVED(2))} && ${q('draft-view-version')}?.textContent.trim() === '2'`,
    30_000, 'saved, the editor closed, the draft read back at version 2');
  await quiet(page, from);
  const view = await savedViewOf(page);
  const patches = sentBy(page, isDraftPatch(main.id, created.id));
  const readBack = sentBy(page, isDraftGet(main.id, created.id), from);
  const [stored] = await storedDrafts(tenant);
  const eDelta = minus(await editCounts(tenant, created.id), eBefore);
  const dDelta = minus(await draftCounts(tenant), dBefore);
  record('SDB-11', { phase: 'edited', asked: asked.map(apiLine), seeded, working, patches: patches.map(apiLine), readBack: readBack.map(answered), eDelta, dDelta, view });

  assert.deepEqual(asked.map(answered), ['200'], 'Edit followed ONE edit-eligibility read, answered allowed');
  assert.equal(asked[0].body, '', 'a read: no body');
  assert.deepEqual(seeded, { lines: [[lines[0].description, '1', '100.00'], [lines[1].description, '2', '5.25']], version: '1', customer: avery.id },
    'the editor holds the draft as the server answered it: its customer, its lines in order (prices as dollars), version 1');
  assert.deepEqual(working, edited.map((l) => [l.description, l.quantity, l.price]), 'the working copy: Labour moved up, Cable removed');
  assert.equal(patches.length, 1, `ONE PATCH: ${patches.map(apiLine).join('; ')}`);
  const [patch] = patches;
  assert.equal(patch.query, '', 'nothing rides the query');
  assert.equal(patch.body, editBodyFor(tenant, 1, blake.id, edited), 'exactly { expectedTenant, expectedVersion, customerId, lines }, in the new order');
  assert.match(patch.headers['idempotency-key'] ?? '', UUID_V4_RE, 'under a fresh v4 key');
  assert.equal(patch.headers[CSRF_HEADER], CSRF_HEADER_VALUE, 'with the request-intent header');
  assert.deepEqual(Object.keys(patch.headers).filter((h) => /tenant|store|role|actor/i.test(h)), [], 'no selecting header');
  assert.equal(patch.status, 200);
  assert.deepEqual(JSON.parse(patch.replied.text), { draftId: created.id, version: 2, changed: true }, 'the sealed answer');
  assert.deepEqual(readBack.map(answered), ['200'], 'read back ONCE, never a second PATCH');
  assert.ok(readBack[0].at > patch.doneAt, 'the read-back follows the 200');
  assert.deepEqual(stored, {
    ...created, customerId: blake.id, version: 2, lineCount: 2, subtotalCents: subtotalOf(edited), lines: linesFor(edited),
  }, 'the draft as stored: the new customer, the ordered lines and subtotal, version 2; id, store, status, currency and creation time unchanged');
  assert.deepEqual(eDelta, { E: 1, V: 1, W: 1 }, 'one edit audit, one edit event, one version step');
  assert.deepEqual(dDelta, { D: 0, L: 0, A: 0, O: 0 }, 'no new draft, the lines replaced (two before, two after), no create audit or event');
  assert.deepEqual(await editAudits(tenant), [{ scope: 'store', store: main.id, subject: created.id }], 'the edit audit is store-scope and names the draft');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 1, L: 1 }, 'the edit: one completion, one idempotency record');
  assert.deepEqual(view, { saved: EDIT_SAVED(2), version: '2', lines: viewCells(edited) }, 'the read-back: version 2 and the new lines');

  // 2. A reload: the server's draft, version 2.
  await page.goto(`${SHOP}/invoices`, 30_000);
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'the reloaded Invoices page');
  const reloaded = { editor: await has(page, 'draft-edit'), view: await has(page, 'draft-view') };
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  await pickStore(page, main.id);
  await waitDraftRows(page, [created.id], 'the edited draft after a reload', blake.name);
  const afterReload = { ...(await reopenDraft(page, created.id, blake.name)), version: await textOf(page, 'draft-view-version') };
  await closeView(page);
  assert.deepEqual(reloaded, { editor: false, view: false }, 'a fresh page: no editor, no dialog');
  assert.deepEqual([afterReload.version, afterReload.customer, afterReload.lines], ['2', blake.name, viewCells(edited)], 'the reload reads version 2');

  // 3. A second session: a second browser through the second entry.
  const other = viaSecond(await recordWrites(await openPage()));
  await signIn(other, boss);
  await openDrafts(other);
  await pickStore(other, main.id);
  await waitDraftRows(other, [created.id], 'the second browser lists the draft', blake.name);
  const otherView = { ...(await reopenDraft(other, created.id, blake.name)), version: await textOf(other, 'draft-view-version') };
  const otherReads = sentBy(other, isDraftGet(main.id, created.id));
  assert.deepEqual([otherView.version, otherView.lines], ['2', viewCells(edited)], 'the second session reads version 2');
  assert.ok(otherReads.length === 1 && otherReads[0].via === 2 && otherReads[0].status === 200, `through the second entry: ${otherReads.map(apiLine).join('; ')}`);
  assert.deepEqual(sentBy(other, (r) => r.method === 'PATCH'), [], 'the second browser sent no PATCH');
  await closeView(other);

  // 4. A Create-level account (sales_staff's default Invoices level): the draft opens, but the server refuses Edit.
  const sales = await recordWrites(await openPage());
  await signIn(sales, staff);
  await openDrafts(sales);
  await pickStore(sales, main.id);
  await waitDraftRows(sales, [created.id], 'the sales account lists the draft (Invoices View and up)');
  await sales.click(`${by('drafts-row')}[data-id="${created.id}"] ${by('drafts-open')}`);
  await waitData(sales, 'draft-view-edit-state', 'phase', 'denied');
  const salesView = { edit: await has(sales, 'draft-view-edit'), text: await textOf(sales, 'draft-view-edit-state'), reads: sentBy(sales, isEditEligibility(main.id, created.id)).map(answered) };
  const token = answeredTokens(sentBy(sales, () => true)).at(-1);
  assert.ok(typeof token === 'string', 'the session CSRF token the entry answered the sales account');
  const sBefore = await counts();
  const sDraft = await editCounts(tenant, created.id);
  const sFrom = st.api.length;
  const key = randomUUID();
  const directBody = editBodyFor(tenant, 2, avery.id, lines);
  const direct = await sales.evaluate(`fetch(${JSON.stringify(`${draftsPath(main.id)}/${created.id}`)}, {
    method: 'PATCH', credentials: 'include', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ${JSON.stringify(CSRF_HEADER)}: ${JSON.stringify(CSRF_HEADER_VALUE)},
      ${JSON.stringify(SESSION_CSRF_HEADER)}: ${JSON.stringify(token)}, 'Idempotency-Key': ${JSON.stringify(key)} },
    body: ${JSON.stringify(directBody)},
  }).then((r) => r.status)`);
  await quiet(sales, sFrom);
  record('SDB-11', { phase: 'create level', salesView, direct, patches: sentBy(sales, (r) => r.method === 'PATCH').map(apiLine) });
  assert.deepEqual(salesView, { edit: false, text: EDIT_DENIED, reads: ['403 forbidden'] }, 'no Edit: the server\'s edit eligibility is 403 for Invoices Create');
  assert.equal(direct, 403, 'the direct PATCH from the page is refused');
  assert.deepEqual(sentBy(sales, (r) => r.method === 'PATCH').map(answered), ['403 forbidden'], 'ONE PATCH, refused');
  assert.deepEqual(await editCounts(tenant, created.id), sDraft, 'nothing written: version 2, no edit audit or event');
  await assertDelta(sBefore, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0, T: 0 }, 'refused before anything is recorded');
  assert.equal((await storedDrafts(tenant))[0].customerId, blake.id, 'the draft keeps the owner\'s edit');

  await assertDraftsNowhere([page, other, sales], [created.id, patch.headers['idempotency-key'], blake.id, patch.body, ...edited.map((l) => l.description), key, directBody]);
  await assertNoLeak(page);
}, 300_000);

scenario('SDB-12', 'AC-16 A CONFLICT NEEDS EXPLICIT REVIEW — two browsers (two entries) edit the same draft at version 1; the second saves first (version 2); the first\'s save is the sealed 409 write_conflict: nothing overwritten (its completion only), the working copy kept, the server\'s draft read afresh and shown beside it, nothing sent on its own; Reapply sends the same working copy under a NEW key at version 2 and lands version 3', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d12', ['main']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d12 Dale ${SUFFIX}`]);
  const [draftId] = await seedDrafts(tenant, main.id, customer.id, boss.id, 1, 'M7SDB d12 seed');
  const seedLine = `M7SDB d12 seed 1 ${SUFFIX}`;
  const theirs = [typed(`Theirs ${SUFFIX}`, '1', '1.00', 100)];
  const mine = [typed(`Mine ${SUFFIX}`, '1', '1.00', 100)];
  const first = await recordWrites(await openPage());
  await signIn(first, boss);
  await openDrafts(first);
  await pickStore(first, main.id);
  await waitDraftRows(first, [draftId], 'the seeded draft', customer.name);
  await openEditor(first, main.id, draftId, customer.name);
  const second = viaSecond(await recordWrites(await openPage()));
  await signIn(second, boss);
  await openDrafts(second);
  await pickStore(second, main.id);
  await waitDraftRows(second, [draftId], 'the seeded draft, second browser', customer.name);
  await openEditor(second, main.id, draftId, customer.name);
  const both = { first: await textOf(first, 'draft-edit-version'), second: await textOf(second, 'draft-edit-version'), lines: await editorLines(first) };

  // The second browser saves first.
  await typeLineField(second, 0, 'description', theirs[0].description, 'draft-edit');
  await second.click(by('draft-edit-save'));
  await second.waitFor(`${q('draft-view-saved')}?.textContent.trim() === ${JSON.stringify(EDIT_SAVED(2))}`, 30_000, 'the second browser saved version 2');

  // The first browser's save, at version 1: a conflict, reviewed.
  await typeLineField(first, 0, 'description', mine[0].description, 'draft-edit');
  const before = await counts();
  const eBefore = await editCounts(tenant, draftId);
  const from = st.api.length;
  await first.click(by('draft-edit-save'));
  await waitData(first, 'draft-edit-conflict', 'phase', 'ready');
  await quiet(first, from);
  const guard = patchGuard(first); // nothing on its own: across a focus and the page's own reaction to it
  await focusAndSettle(first);
  const unexpected = guard.disarm();
  const conflict = {
    status: await textOf(first, 'draft-edit-status'), server: await textOf(first, 'draft-edit-server'), mine: await textOf(first, 'draft-edit-mine'),
    working: await editorLines(first), saveOff: !(await offered(first, 'draft-edit-save')), reapply: await offered(first, 'draft-edit-reapply'),
  };
  const sent = sentBy(first, () => true, from);
  const [stale] = sentBy(first, isDraftPatch(main.id, draftId));
  const fresh = sentBy(first, isDraftGet(main.id, draftId), from);
  const [afterConflict] = await storedDrafts(tenant);
  record('SDB-12', { phase: 'conflict', both, conflict, sent: sent.map(apiLine), unexpected });
  assert.deepEqual(unexpected, [], 'no PATCH on its own after the conflict, a focus included');
  assert.deepEqual(both, { first: '1', second: '1', lines: [[seedLine, '1', '1.00']] }, 'both editors opened the draft at version 1');
  assert.equal(stale.body, editBodyFor(tenant, 1, customer.id, mine), 'the first browser sent its working copy at version 1');
  assert.deepEqual([stale.status, stale.replied.text], [409, '{"error":"write_conflict"}'], 'the sealed conflict');
  assert.deepEqual(sentBy(first, (r) => r.method === 'PATCH').length, 1, 'ONE PATCH from the first browser: nothing re-sent, nothing rebased on its own');
  assert.deepEqual(fresh.map(answered), ['200'], 'ONE fresh read of the server\'s draft for the review');
  assert.deepEqual(afterConflict.lines.map((l) => l.description), [theirs[0].description], 'nothing overwritten: the server keeps the second browser\'s line');
  assert.equal(afterConflict.version, 2);
  assert.deepEqual(minus(await editCounts(tenant, draftId), eBefore), { E: 0, V: 0, W: 0 }, 'the conflict wrote no edit, audit or event');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 1, L: 1 }, 'the conflict: its sealed completion only');
  assert.ok(conflict.status?.startsWith('Not saved: this draft was changed on the server after you opened it.'), conflict.status);
  assert.ok(conflict.server?.includes('version 2') && conflict.server.includes(theirs[0].description), `the server's draft shown: ${conflict.server}`);
  assert.ok(conflict.mine?.includes(mine[0].description), `the working copy shown: ${conflict.mine}`);
  assert.deepEqual([conflict.working, conflict.saveOff, conflict.reapply], [[[mine[0].description, '1', '1.00']], true, true], 'the working copy kept; Save waits for a decision; Reapply offered');

  // Reapply: the same working copy, a NEW key, the version the review read.
  const again = st.api.length;
  await first.click(by('draft-edit-reapply'));
  await first.waitFor(`${q('draft-view-saved')}?.textContent.trim() === ${JSON.stringify(EDIT_SAVED(3))}`, 30_000, 'reapplied: version 3');
  await quiet(first, again);
  const patches = sentBy(first, isDraftPatch(main.id, draftId));
  const [, reapplied] = patches;
  const [last] = await storedDrafts(tenant);
  record('SDB-12', { phase: 'reapplied', patches: patches.map(apiLine) });
  assert.equal(patches.length, 2, 'one more PATCH, on the press');
  assert.notEqual(reapplied.headers['idempotency-key'], stale.headers['idempotency-key'], 'a NEW key');
  assert.match(reapplied.headers['idempotency-key'] ?? '', UUID_V4_RE);
  assert.equal(reapplied.body, editBodyFor(tenant, 2, customer.id, mine), 'the same working copy at the version the review read');
  assert.deepEqual(JSON.parse(reapplied.replied.text), { draftId, version: 3, changed: true });
  assert.deepEqual([last.version, last.lines.map((l) => l.description)], [3, [mine[0].description]], 'version 3, the first browser\'s line');
  assert.deepEqual(await editAudits(tenant), [{ scope: 'store', store: main.id, subject: draftId }, { scope: 'store', store: main.id, subject: draftId }], 'two edits, two audits');
  const [theirsPatch] = sentBy(second, isDraftPatch(main.id, draftId));
  await assertDraftsNowhere([first, second], [
    draftId, stale.headers['idempotency-key'], reapplied.headers['idempotency-key'], theirsPatch.headers['idempotency-key'],
    stale.body, reapplied.body, theirsPatch.body, mine[0].description, theirs[0].description,
  ]);
  await assertNoLeak(first);
}, 300_000);

scenario('SDB-13', 'AC-17 UNKNOWN OUTCOME — the PATCH commits and its answer is dropped at the front: "Not confirmed yet", never saved; a focus and a visibilitychange event send nothing; "Check again" sends exactly one more PATCH with the SAME key and byte-identical body (the network log), answered 200 as a replay; ONE version step in the database; a second lost edit followed by a reload sends nothing and restores no editor', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d13', ['main']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d13 Eden ${SUFFIX}`]);
  const [draftId] = await seedDrafts(tenant, main.id, customer.id, boss.id, 1, 'M7SDB d13 seed');
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [draftId], 'the seeded draft', customer.name);
  await openEditor(page, main.id, draftId, customer.name);
  const changed = [typed(`Unconfirmed ${SUFFIX}`, '1', '1.00', 100)];
  await typeLineField(page, 0, 'description', changed[0].description, 'draft-edit');
  const myPatches = () => sentBy(page, isDraftPatch(main.id, draftId));
  const before = await counts();
  const eBefore = await editCounts(tenant, draftId);
  let lost = 0;
  try {
    // st.lose: the entry answered (and committed); that answer never reaches the page.
    st.lose = (rec, phase) => phase === 'response' && isDraftPatch(main.id, draftId)(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-edit-save'));
    await waitData(page, 'draft-edit-attempt', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const [first] = myPatches();
  const afterLoss = { patches: myPatches().map((r) => `${r.status} ${r.lost ?? 'delivered'}`), e: minus(await editCounts(tenant, draftId), eBefore), card: await textOf(page, 'draft-edit-attempt') };
  record('SDB-13', { phase: 'lost reply', ...afterLoss });
  assert.deepEqual(afterLoss.patches, ['200 response'], 'ONE PATCH: it committed, its answer lost at the front');
  assert.deepEqual(afterLoss.e, { E: 1, V: 1, W: 1 }, 'committed: one version step, one audit, one event');
  assert.ok(afterLoss.card?.startsWith(EDIT_UNRESOLVED), `held, never saved: ${afterLoss.card}`);
  assert.equal(await has(page, 'draft-view-saved'), false, 'never "Saved" on an answer that did not arrive');

  // Nothing re-sends on its own: a focus and a tab return, each held until the page's own session check has answered.
  const mid = await counts();
  const guard = patchGuard(page);
  await focusAndSettle(page, 'focus');
  await focusAndSettle(page, 'visibilitychange');
  const unexpected = guard.disarm();
  const held = { patches: myPatches().length, unexpected, state: await page.evaluate(`${q('draft-edit-attempt')}?.dataset.state ?? null`), check: await offered(page, 'draft-edit-check-again') };
  assert.deepEqual(held, { patches: 1, unexpected: [], state: 'unresolved', check: true }, 'still ONE PATCH, still unresolved, Check again offered');

  // Check again: the SAME key and the SAME bytes, once.
  const again = st.api.length;
  await page.click(by('draft-edit-check-again'));
  await page.waitFor(`!${q('draft-edit')} && ${q('draft-view-saved')}?.textContent.trim() === ${JSON.stringify(EDIT_SAVED(2))}`, 30_000, 'confirmed by the check, read back');
  await quiet(page, again);
  const patches = myPatches();
  const second = patches[1];
  record('SDB-13', { phase: 'Check again', patches: patches.map(apiLine), replayed: second?.replied.headers['idempotent-replayed'] ?? null });
  assert.equal(patches.length, 2, 'exactly one more PATCH, on the press');
  assert.ok(st.api.indexOf(second) >= again, 'sent only after the press');
  assert.deepEqual([second.path, second.headers['idempotency-key'], second.body], [first.path, first.headers['idempotency-key'], first.body], 'the SAME draft, key and byte-identical body');
  assert.equal(second.headers[SESSION_CSRF], first.headers[SESSION_CSRF], 'under the attempt\'s own session token');
  assert.deepEqual([second.status, second.replied.headers['idempotent-replayed'], JSON.parse(second.replied.text)], [200, 'true', { draftId, version: 2, changed: true }], 'answered as a replay of the committed edit');
  assert.deepEqual(minus(await editCounts(tenant, draftId), eBefore), { E: 1, V: 1, W: 1 }, 'still ONE version step, one audit, one event');
  await assertDelta(mid, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'the replay wrote nothing');
  await assertDelta(before, { K: 1, L: 1 }, 'one completion and one idempotency record for the edit');

  // A second edit whose answer is lost, then a reload: nothing is sent, no editor comes back; that PATCH committed.
  await closeView(page);
  await openEditor(page, main.id, draftId, customer.name);
  await typeLineField(page, 0, 'description', `Reloaded ${SUFFIX}`, 'draft-edit');
  lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isDraftPatch(main.id, draftId)(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-edit-save'));
    await waitData(page, 'draft-edit-attempt', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const reload = st.api.length;
  const reloadGuard = patchGuard(page); // across the reload, its reads, the list it shows and a focus check
  await page.goto(`${SHOP}/invoices`, 30_000);
  await page.waitFor(`!!${q('drafts-show')}`, 30_000, 'the reloaded Invoices page');
  await page.click(by('drafts-show'));
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');
  await pickStore(page, main.id);
  await waitDraftRows(page, [draftId], 'the draft after the reload', customer.name);
  await focusAndSettle(page);
  const reloaded = {
    editor: await has(page, 'draft-edit'), attempt: await has(page, 'draft-edit-attempt'), patches: sentBy(page, isDraftPatch(main.id, draftId), reload).length,
    unexpected: reloadGuard.disarm(),
  };
  record('SDB-13', { phase: 'reload', reloaded, version: (await editCounts(tenant, draftId)).W });
  assert.deepEqual(reloaded, { editor: false, attempt: false, patches: 0, unexpected: [] }, 'a reload restores no editor and sends nothing');
  assert.equal((await editCounts(tenant, draftId)).W, 3, 'the second lost edit committed under its own attempt');
  assert.equal(myPatches().length, 3, 'three PATCHes in the whole case');
  const secondAttempt = myPatches()[2];
  await assertDraftsNowhere([page], [
    draftId, first.headers['idempotency-key'], first.body, changed[0].description,
    secondAttempt.headers['idempotency-key'], secondAttempt.body, `Reloaded ${SUFFIX}`,
  ]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-14', 'AC-17 SIGN-OUT DURING AN UNKNOWN OUTCOME (observable no-old-content) — an edit\'s PATCH commits and its answer is lost; the owner signs out (the route guard unmounts the page) and signs in again in the same document: no editor, attempt, Check again or typed line shows, and no PATCH leaves the page after the sign-out; the server kept the committed edit', async () => {
  const { tenant, stores: [main], boss } = await draftShop('d14', ['main']);
  const [customer] = await seedCustomers(tenant, [`M7SDB d14 Finn ${SUFFIX}`]);
  const [draftId] = await seedDrafts(tenant, main.id, customer.id, boss.id, 1, 'M7SDB d14 seed');
  const secret = `Signed out line ${SUFFIX}`;
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [draftId], 'the seeded draft', customer.name);
  await openEditor(page, main.id, draftId, customer.name);
  await typeLineField(page, 0, 'description', secret, 'draft-edit');
  let lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isDraftPatch(main.id, draftId)(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('draft-edit-save'));
    await waitData(page, 'draft-edit-attempt', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  await page.evaluate(`window.__sdbMarker = true`);
  const guard = patchGuard(page); // across the sign-out, the sign-in, the section's reads and a focus check
  const out = await signOutHere(page);
  await signInHere(page, boss);
  await page.waitFor(`window.__sdbMarker === true`, 5_000, 'the same document');
  await openDrafts(page);
  await pickStore(page, main.id);
  await waitDraftRows(page, [draftId], 'the draft, listed again', customer.name);
  await focusAndSettle(page);
  await quiet(page, out);
  const seen = {
    unexpected: guard.disarm(),
    editor: await has(page, 'draft-edit'), attempt: await has(page, 'draft-edit-attempt'), check: await has(page, 'draft-edit-check-again'),
    view: await has(page, 'draft-view'), typed: await page.evaluate(typedAnywhere(secret)),
    patchesAfter: sentBy(page, (r) => r.method === 'PATCH', out).map(apiLine),
  };
  record('SDB-14', { seen, version: (await editCounts(tenant, draftId)).W });
  assert.deepEqual(seen, { unexpected: [], editor: false, attempt: false, check: false, view: false, typed: false, patchesAfter: [] },
    'nothing of the old editor after the sign-out and sign-in: no editor, attempt, Check again, dialog or typed line, no PATCH');
  assert.equal(sentBy(page, (r) => r.method === 'PATCH').length, 1, 'ONE PATCH in the whole case, the lost one');
  assert.equal((await editCounts(tenant, draftId)).W, 2, 'the server kept the edit it committed under the old attempt');
  const [lostPatch] = sentBy(page, (r) => r.method === 'PATCH');
  await assertDraftsNowhere([page], [draftId, lostPatch.headers['idempotency-key'], lostPatch.body, secret]);
  await assertNoLeak(page);
}, 240_000);

scenario('SDB-15', 'AC-17 A LATE PATCH ANSWER ACTUALLY DELIVERED (DA-198 window) — user A\'s PATCH is answered by the entry (committed) and that answer parked at the front; B signs in in another tab (B\'s profile held, A\'s page mounted: the section heard the sign-out, the editor closed); released, the answer IS delivered to A\'s page and shows nothing — no "Saved", no read-back, no editor — and starts nothing; only A\'s logout carries A\'s token after the switch', async () => {
  const tenant = await newTenant('d15');
  const westName = `M7SDB d15 west ${SUFFIX}`;
  const west = { id: await newStore(tenant, westName), name: westName };
  const a = await actor('d15-a', [grant(tenant, 'store_owner'), storeGrant(tenant, west.id, 'store_owner')], { role: 'store_owner' });
  const b = await actor('d15-b', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager')], { role: 'manager' });
  const [customer] = await seedCustomers(tenant, [`M7SDB d15 Gale ${SUFFIX}`]);
  const [draftId] = await seedDrafts(tenant, west.id, customer.id, a.id, 1, 'M7SDB d15 seed');
  const secret = `Late line ${SUFFIX}`;
  const page = await watchNetwork(await recordWrites(await openPage()));
  await signIn(page, a);
  await openDrafts(page);
  await pickStore(page, west.id);
  await waitDraftRows(page, [draftId], 'the seeded draft', customer.name);
  await openEditor(page, west.id, draftId, customer.name);
  await typeLineField(page, 0, 'description', secret, 'draft-edit');
  const path = `${draftsPath(west.id)}/${draftId}`;
  const parkMark = page.net.mark(path);
  const parked = gate((r) => r.frameId === page.frameId && isDraftPatch(west.id, draftId)(r), 'response');
  await page.click(by('draft-edit-save'));
  const patch = await Promise.race([parked.reached, delay(30_000).then(() => null)]);
  assert.ok(patch, 'the PATCH was answered by the entry and its answer parked at the front');
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  const from = st.api.length;
  const profile = await switchHeld(page, b, from);
  await page.settle();
  const closed = { editor: await has(page, 'draft-edit'), typed: await page.evaluate(typedAnywhere(secret)) };
  parked.release();
  await page.waitFor(() => patch.handedBack === true, 15_000, 'the parked answer was handed back to the browser');
  const parkedEnd = await page.net.endOfParked(path, parkMark);
  assert.ok(parkedEnd !== null, 'the browser ended the parked request');
  await page.settle();
  const whileMounted = {
    section: await has(page, 'drafts-section'), stores: await page.evaluate(`${q('drafts-stores-state')}?.dataset.phase ?? null`),
    editor: await has(page, 'draft-edit'), saved: await has(page, 'draft-view-saved'), view: await has(page, 'draft-view'),
  };
  profile.release();
  await page.waitFor(`!!${q('drafts-show')} && !${q('drafts-stores-state')}`, 30_000, 'B\'s Invoices page in this tab (A\'s section gone)');
  await quiet(page, from);
  const after = sentBy(page, () => true, from);
  const seen = {
    closed, whileMounted, browserEnd: parkedEnd,
    readBacks: after.filter((r) => isDraftGet(west.id, draftId)(r)).map(apiLine),
    patches: after.filter((r) => r.method === 'PATCH').map(apiLine),
    carriersOfA: after.filter((r) => !isLogout(r) && carries(r, aTokens)).map(apiLine),
  };
  record('SDB-15', { parked: answered(patch), ...seen, requests: after.map(apiLine), version: (await editCounts(tenant, draftId)).W });
  assert.equal(patch.status, 200, 'the parked answer was the committed edit\'s 200');
  assert.equal((await editCounts(tenant, draftId)).W, 2, 'the server committed it under the old attempt');
  assert.deepEqual(seen, {
    closed: { editor: false, typed: false },
    whileMounted: { section: true, stores: 'signed-out', editor: false, saved: false, view: false },
    browserEnd: parkedEnd, readBacks: [], patches: [], carriersOfA: [],
  }, 'the editor closed at the sign-out; the late answer, delivered while A\'s section was mounted, showed nothing and started nothing');
  assert.equal(parkedEnd, 'finished', 'the browser RECEIVED the answer: no session end aborts the PATCH (it carries only the client\'s own request deadline), so it was delivered to the page');
  assert.equal(after.filter((r) => isLogout(r) && carries(r, aTokens)).length, 1, `one logout, naming A's session: ${after.map(apiLine).join('; ')}`);
  await assertDraftsNowhere([page], [draftId, patch.headers['idempotency-key'], patch.body, secret]);
  await assertNoLeak(page);
}, 180_000);

// ---------------------------------------------------------------------------------------------------------------------
// M7B-INVOICES-P1-R2 — session-end cleanup (DA-200, DA-202, AC-07). The literals are the shop's own texts.
// ---------------------------------------------------------------------------------------------------------------------

/** ServerCustomerDirectory.tsx's ENDED_TEXT: what is said of an attempt a session end detached — never its name. */
const SSE_ENDED = Object.freeze({
  unresolved: 'Not confirmed yet: a customer sent before your server session ended. The server may have saved it.',
  saved: 'A customer sent before your server session ended was saved on the server.',
});
/** ServerCustomerPicker.tsx's PICK_ENDED_TEXT. */
const PICK_ENDED = 'Your server session ended, so the server customer was removed from this draft. Choose "Select a server customer", then Reconnect to select one again.';
/** Hold the switch to `b` in `page`: `b` signs in in a second tab of this browser, and `b`'s profile read in this tab is held (SDB-08). */
async function switchHeld(page, b, from) {
  const profile = profileGate(page, b.uid);
  const tab = await sameContextTab(page);
  await signIn(tab, b);
  const reached = await Promise.race([profile.reached.then(() => true), delay(30_000).then(() => false)]);
  assert.ok(reached, `this tab reads ${b.label}'s profile: the switch has begun (the logout was started first)`);
  await page.waitFor(() => sentBy(page, isLogout, from).length > 0, 15_000, 'the logout left this tab');
  return profile;
}

scenario('SSE-01', 'DA-200 THE DIRECTORY\'S CREATE HOLD AT A SIGN-OUT — a create whose answer is lost holds its token and exact body until the owner signs out: then the page\'s heap holds neither; signed in again it is detached and unnamed, never re-sent through navigation; a second create whose 201 arrives after the sign-out starts no read or send, and is said later without its name; two POSTs, two customers, nothing else', async () => {
  const { tenant, boss } = await shop('se1');
  const first = { name: `M7SSE se1 Ada ${SUFFIX}`, phone: `+1 555 01${SUFFIX.slice(0, 2).replace(/\D/g, '7')}`, email: `se1.${SUFFIX}@example.test` };
  const second = `M7SSE se1 Bea ${SUFFIX}`;
  const before = await counts();
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDirectory(page);
  await waitList(page);

  // 1. ONE POST, committed; its answer lost at the front: the attempt is held, Check again offered.
  await page.fill(by('directory-name'), first.name);
  await page.fill(by('directory-phone'), first.phone);
  await page.fill(by('directory-email'), first.email);
  await page.waitFor(() => offered(page, 'directory-add'), 15_000, 'Add customer is enabled');
  let lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isCreate(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('directory-add'));
    await waitData(page, 'directory-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const [post] = sentBy(page, isCreate);
  const heldBefore = { check: await offered(page, 'directory-check-again'), detached: await page.evaluate(`${q('directory-hold')}?.dataset.detached ?? null`) };
  assert.deepEqual(heldBefore, { check: true, detached: 'false' }, 'the attempt is held, attached, with Check again');
  assert.equal((await named(tenant, first.name)).length, 1, 'the lost answer\'s create committed');
  const tokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  assert.ok(tokens.length > 0, 'the session CSRF token was seen');
  assert.ok(post.body.includes(first.phone) && post.body.includes(first.email), 'the body sent carries the phone and the email');

  // 2. Signed out in this tab (the same document): once the logout has run, the heap holds no token and no body.
  await page.evaluate('window.__sdbSameDocument = true');
  const out = await signOutHere(page);
  await page.waitFor(() => st.api.slice(out).some((r) => isLogout(r) && r.handedBack === true), 20_000, 'the logout\'s answer was handed to the page');
  await page.settle();
  // What the heap is searched for: the token and the exact body (the hold store's; asserted absent) and the phone and email
  // (recorded only). In the recorded runs both contact strings were reachable as "(Global handles) / DevTools console ->
  // native <input id=directory-phone|email> -get value-> closure context": the detached inputs, kept alive by the CDP
  // remote object this harness's own click resolved (cdp.mjs `find`), and React's input value tracker on them — render
  // residue under the inspector, not an application holder; no erasure of the contact is claimed.
  let inHeap = null;
  let snapshot = '';
  // Each snapshot asks for a collection first; the logout's own work may still be finishing in the first one.
  for (let i = 0; i < 3 && (inHeap === null || inHeap.tokens + inHeap.body > 0); i++) {
    snapshot = await heapSnapshot(page);
    // The snapshot is JSON: a string holding quotes (the body) appears there escaped.
    inHeap = {
      tokens: tokens.filter((v) => snapshot.includes(v)).length, body: snapshot.includes(JSON.stringify(post.body).slice(1, -1)) ? 1 : 0,
      phone: snapshot.includes(first.phone), email: snapshot.includes(first.email),
    };
  }
  const retainers = { phone: inHeap.phone ? retainingPath(snapshot, first.phone) : null, email: inHeap.email ? retainingPath(snapshot, first.email) : null };
  snapshot = '';

  // 3. Signed in again (a new session): the attempt is detached and unnamed, and nothing re-sends it.
  await signInHere(page, boss);
  await openDirectory(page);
  await waitList(page);
  await page.waitFor(`${q('directory-hold')}?.dataset.detached === 'true'`, 15_000, 'the attempt, detached');
  const back = { text: await page.evaluate(`${q('directory-hold')}?.textContent ?? ''`), check: await has(page, 'directory-check-again') };
  await go(page, '/');
  await page.settle();
  await openDirectory(page);
  await waitList(page);
  const remounted = { detached: await page.evaluate(`${q('directory-hold')}?.dataset.detached ?? null`), check: await has(page, 'directory-check-again') };
  await page.click(by('directory-stop-tracking'));
  await page.waitFor(`!${q('directory-hold')}`, 15_000, 'stopped tracking');

  // 4. A second create, its 201 parked at the front; the owner signs out; the answer is released at /login.
  const parked = gate((r) => r.frameId === page.frameId && isCreate(r), 'response');
  await addCustomer(page, second);
  const late = await Promise.race([parked.reached, delay(30_000).then(() => null)]);
  assert.ok(late, 'the second POST reached the entry; its answer is parked');
  const out2 = await signOutHere(page);
  await page.waitFor(() => st.api.slice(out2).some((r) => isLogout(r) && r.handedBack === true), 20_000, 'the logout\'s answer was handed to the page');
  await page.settle();
  const releasedAt = st.api.length;
  parked.release();
  await page.waitFor(() => late.handedBack === true, 15_000, 'the parked 201 was handed back to the browser');
  await page.settle(); // two frames: the answer's continuation has run and anything it rendered is committed
  // The settle point: the next sign-in. Whatever the late answer made the page send was sent before it began.
  const afterLate = st.api.slice(releasedAt).filter((r) => r.frameId === page.frameId).map(apiLine);
  await signInHere(page, boss);
  await openDirectory(page);
  await waitList(page);
  await page.waitFor(`!!${q('directory-saved-earlier')}`, 15_000, 'the earlier session\'s create, said');
  const news = { text: await textOf(page, 'directory-saved-earlier'), link: await has(page, 'directory-saved-link'), hold: await has(page, 'directory-hold') };
  // A later deterministic event — a Refresh whose page-one read is answered — before anything is counted.
  const refreshAt = st.api.length;
  await page.click(by('directory-refresh'));
  await page.waitFor(() => sentBy(page, isList, refreshAt).some((r) => r.status !== null), 15_000, 'the Refresh read was answered');
  await quiet(page, out);
  const posts = sentBy(page, isCreate);
  record('SSE-01', { heldBefore, inHeap, retainers, back, remounted, late: answered(late), afterLate, news, posts: posts.map(apiLine) });
  assert.equal(await page.evaluate(SAME_DOCUMENT), true, 'the same document throughout: the module memory is the one the sign-outs left');
  assert.deepEqual(inHeap, { tokens: 0, body: 0, phone: inHeap.phone, email: inHeap.email },
    'once signed out, the page\'s JavaScript heap holds neither the session CSRF token nor the exact body sent (the hold store heard the sign-out)');
  assert.ok(back.text.includes(SSE_ENDED.unresolved), `the card says what it is, unnamed: ${back.text}`);
  assert.ok(!back.text.includes(first.name) && !back.text.includes(first.phone) && !back.text.includes(first.email), 'the card names no customer and no contact');
  assert.equal(back.check, false, 'no Check again: it can never be sent');
  assert.deepEqual(remounted, { detached: 'true', check: false }, 'a navigation away and back changes nothing');
  assert.equal(late.status, 201, 'the parked answer was the entry\'s 201');
  assert.deepEqual(afterLate, [], 'the late answer, at /login, made the page read or send nothing');
  assert.deepEqual(news, { text: SSE_ENDED.saved, link: false, hold: false }, 'the late create is said without its name and without a link');
  assert.deepEqual(posts.map((r) => r.status), [201, 201], 'two POSTs in the whole case: one per explicit Add (the first answer lost at the front)');
  assert.equal(posts[0].lost, 'response');
  assert.equal((await named(tenant, first.name)).length, 1, 'one customer for the first add');
  assert.equal((await named(tenant, second)).length, 1, 'one customer for the second add');
  await assertDelta(before, { C: 2, A: 2, E: 0, U: 0, K: 2, L: 2 }, 'two creates: two customers, two create audits, two completions, no other idempotency record');
  await assertNoLeak(page);
}, 240_000);

scenario('SSE-02', 'DA-202 A CHOSEN SERVER CUSTOMER, PICKER CLOSED, AT A SIGN-OUT — B signs in in a second tab and B\'s profile is held, so A\'s invoice draft stays mounted: its server customer goes at once with the session-ended notice, with the limit text and "Save as server draft" — no focus or tab-return check; once B\'s profile loads the draft holds no server customer and opening B\'s picker binds nothing; nothing is written', async () => {
  const { tenant, boss: a } = await shop('se2');
  const b = await actor('se2-b', [grant(tenant, 'manager')], { role: 'manager' });
  const [customer] = await seedCustomers(tenant, [`M7SSE se2 Robin ${SUFFIX}`]);
  const before = await counts();
  const page = await recordWrites(await openPage());
  await signIn(page, a);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('invoice-create-open')}`, 30_000, 'the Invoices page offers Create Invoice');
  await page.click(by('invoice-create-open'));
  await page.waitFor(`!!${q('picker-open')}`, 15_000, 'the draft offers the server-customer picker');
  await openPicker(page, 'picker-open');
  await pickRow(page, customer.id);
  const chosen = {
    bound: await boundId(page), dialog: await has(page, 'picker-dialog'), limit: await has(page, 'invoice-server-limit'), handoff: await has(page, 'invoice-server-draft'),
  };
  assert.deepEqual(chosen, { bound: customer.id, dialog: false, limit: true, handoff: true }, 'the draft holds the server customer, the picker closed');
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  const from = st.api.length;
  // Every session check this tab asks from here is held before it leaves (the field's own focus or tab-return check
  // included, which a new tab can trigger): what the field shows while they are held is the sign-out's own doing.
  const checksHeld = [0, 1, 2].map(() => gate((r) => r.frameId === page.frameId && isSessionRead(r), 'request'));
  const profile = await switchHeld(page, b, from);
  await page.settle(); // two frames after the logout began
  const whileMounted = {
    form: await has(page, 'invoice-customer-select'), bound: await boundId(page), notice: await textOf(page, 'picker-notice'),
    limit: await has(page, 'invoice-server-limit'), handoff: await has(page, 'invoice-server-draft'), drafts: await has(page, 'drafts-handoff'),
  };
  const checksSeen = sentBy(page, isSessionRead, from);
  const heldChecks = checksSeen.map(apiLine);
  record('SSE-02', { phase: 'A mounted, B\'s profile held', chosen, whileMounted, heldChecks, requests: sentBy(page, () => true, from).map(apiLine) });
  // Every session check this tab asked up to the observation is still held, unanswered (none escaped the gates), so what
  // the field shows is the sign-out listener's doing, not a check's answer.
  assert.ok(checksSeen.length <= checksHeld.length, `more session checks than gates: ${heldChecks.join('; ')}`);
  assert.ok(checksSeen.every((r) => r.status === null && r.handedBack !== true), `a session check was answered before the observation: ${heldChecks.join('; ')}`);
  for (const c of checksHeld) c.release();
  profile.release();
  await page.waitFor(`!!${q('invoice-create-open')}`, 30_000, 'B\'s Invoices page in this tab');
  await page.settle();
  // B's own draft: open one (or the one still open) and its picker: page one under B's session, no customer bound.
  if (!(await has(page, 'picker-field'))) {
    await page.click(by('invoice-create-open'));
    await page.waitFor(`!!${q('picker-field')}`, 15_000, 'B\'s draft offers the picker');
  }
  const bDraft = { bound: await boundId(page), limit: await has(page, 'invoice-server-limit') };
  let bPicker = null;
  if (await has(page, 'picker-open')) {
    await page.click(by('picker-open'));
    await page.waitFor(`!!${q('picker-state')} && ${q('picker-state')}.dataset.phase !== 'loading'`, 30_000, 'B\'s picker answered');
    bPicker = await page.evaluate(`${q('picker-state')}?.dataset.phase ?? null`);
    await page.click(by('picker-cancel'));
    await page.waitFor(`!${q('picker-dialog')}`, 15_000, 'the picker closed');
  }
  const bAfterPicker = { bound: await boundId(page), limit: await has(page, 'invoice-server-limit') };
  await quiet(page, from); // after B's picker read and its Cancel (the later deterministic event), every request answered
  const after = sentBy(page, () => true, from);
  record('SSE-02', { chosen, whileMounted, bDraft, bPicker, bAfterPicker, requests: after.map(apiLine) });
  assert.deepEqual(whileMounted, { form: true, bound: null, notice: PICK_ENDED, limit: false, handoff: false, drafts: false },
    'A\'s draft, still mounted: the server customer is gone with the notice, and nothing offers to carry it on');
  assert.deepEqual(bDraft, { bound: null, limit: false }, 'the draft, now B\'s, holds no server customer');
  assert.deepEqual(bAfterPicker, { bound: null, limit: false }, 'B\'s picker (whatever its own session state: it said "signed-out" in the recorded runs) restores nothing');
  assert.deepEqual(after.filter((r) => !isLogout(r) && carries(r, aTokens)).map(apiLine), [], 'no request after the switch but the logout carries A\'s session CSRF token');
  assert.deepEqual(after.filter((r) => r.method !== 'GET' && !isLogout(r) && !isLogin(r)).map(apiLine), [], 'nothing but a logout and B\'s login is sent');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'nothing written');
  await assertNoLeak(page);
}, 180_000);

scenario('SSE-03', 'AC-07 REGRESSION GUARD (it passes on the entry commit too: the client epoch layer) — THE DRAFT HAND-OVER\'S SESSION CHECK AT A SIGN-OUT — A hands a server customer to the Server drafts section and chooses a store; the New server draft dialog opens and its session check is held at the front; B signs in in a second tab (B\'s profile held, A\'s page mounted); the check\'s answer, released then, opens and fills nothing — no dialog, customer, hand-over, draft POST or login of A — and no request after the switch but A\'s logout carries A\'s token; nothing is written', async () => {
  const { tenant, stores: [west], boss: a } = await draftShop('se3', ['west']);
  const b = await actor('se3-b', [grant(tenant, 'manager'), storeGrant(tenant, west.id, 'manager')], { role: 'manager' });
  const [customer] = await seedCustomers(tenant, [`M7SSE se3 Sage ${SUFFIX}`]);
  const dBefore = await draftCounts(tenant);
  const before = await counts();
  const page = await recordWrites(await openPage());
  await signIn(page, a);
  await go(page, '/invoices');
  await page.waitFor(`!!${q('invoice-create-open')}`, 30_000, 'the Invoices page offers Create Invoice');
  await page.click(by('invoice-create-open'));
  await page.waitFor(`!!${q('picker-open')}`, 15_000, 'the draft offers the server-customer picker');
  await openPicker(page, 'picker-open');
  await pickRow(page, customer.id);
  await page.click(by('invoice-server-draft'));
  await page.waitFor(`!!${q('drafts-handoff')}`, 30_000, 'the Server drafts section holds the hand-over');
  await waitData(page, 'drafts-stores-state', 'phase', 'ready');

  // 1. The store choice asks the server's eligibility (M7B-INVOICES-P1-R2): its allowance, parked at the front, opens the
  // dialog for the hand-over once released; every session check asked from then on (the dialog's) is held at the front.
  const allowance = gate((r) => r.frameId === page.frameId && isEligibility(west.id)(r), 'response');
  await pickStore(page, west.id);
  const allowed = await Promise.race([allowance.reached, delay(30_000).then(() => null)]);
  assert.ok(allowed, 'the eligibility read reached the entry; its answer is parked');
  assert.equal(await has(page, 'draft-new'), false, 'no dialog before the server\'s answer');
  const checks = [0, 1, 2].map(() => gate((r) => r.frameId === page.frameId && isSessionRead(r), 'response'));
  const pickAt = st.api.length;
  allowance.release();
  const held = await Promise.race([checks[0].reached, delay(30_000).then(() => null)]);
  assert.ok(held, 'the session check reached the entry; its answer is parked');
  await page.waitFor(`!!${q('draft-new')}`, 15_000, 'the New server draft dialog opened for the hand-over');
  await page.settle(); // two frames after the dialog mounted: its effect has asked its check (its own request, or the shared one)
  const heldChecks = sentBy(page, isSessionRead, pickAt);
  assert.ok(heldChecks.length >= 1 && heldChecks.length <= checks.length && heldChecks.every((r) => r.handedBack !== true),
    `every session check since the allowance was released is held at the front: ${heldChecks.map(apiLine).join('; ')}`);
  // The dialog's own field (the Invoices form, still animating out, may show its old customer for a moment).
  const dialogBound = () => page.evaluate(`document.querySelector('${by('draft-new')} ${by('picker-value')}')?.dataset.id ?? null`);
  const opened = { bound: await dialogBound(), handoff: await has(page, 'drafts-handoff') };
  const aTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  assert.ok(aTokens.length > 0, 'A\'s session CSRF token was seen');

  // 2. B signs in in a second tab: A's logout starts, B's profile is held, A's page stays mounted.
  const from = st.api.length;
  const profile = await switchHeld(page, b, from);
  // 3. The checks' answers, released while A's page is mounted.
  for (const c of checks) c.release();
  await page.waitFor(() => heldChecks.every((r) => r.handedBack === true), 15_000, 'the parked answers were handed back to the browser');
  await page.settle(); // two frames: the answers' continuations have run and anything they rendered is committed
  const whileMounted = {
    section: await has(page, 'drafts-section'), dialog: await has(page, 'draft-new'), bound: await boundId(page), handoff: await has(page, 'drafts-handoff'),
    stores: await page.evaluate(`${q('drafts-stores-state')}?.dataset.phase ?? null`),
  };
  profile.release();
  await page.waitFor(`!!${q('drafts-show')} && !${q('drafts-stores-state')}`, 30_000, 'B\'s Invoices page in this tab (A\'s section gone)');
  await quiet(page, from); // B's page loaded (the later deterministic event), every request answered
  const after = sentBy(page, () => true, from);
  const seen = {
    whileMounted, dialogNow: await has(page, 'draft-new'), handoffNow: await has(page, 'drafts-handoff'),
    aLogins: after.filter(acceptedLogin(a)).map(apiLine),
    carriersOfA: after.filter((r) => !isLogout(r) && carries(r, aTokens)).map(apiLine),
  };
  record('SSE-03', { opened, held: heldChecks.map(answered), ...seen, requests: after.map(apiLine) });
  assert.deepEqual(opened, { bound: null, handoff: false }, 'while its check is held the dialog shows no customer yet');
  assert.deepEqual(seen, {
    whileMounted: { section: true, dialog: false, bound: null, handoff: false, stores: 'signed-out' },
    dialogNow: false, handoffNow: false, aLogins: [], carriersOfA: [],
  }, 'the released answer opened and filled nothing: the section had ended at the sign-out, and nothing of A followed');
  assert.deepEqual(sentBy(page, isDraftCreate), [], 'no draft POST in the whole case');
  assert.deepEqual(await draftCounts(tenant), dBefore, 'no draft, line, audit or event');
  await assertDelta(before, { C: 0, A: 0, E: 0, U: 0, K: 0, L: 0 }, 'no customer, completion or idempotency record');
  await assertNoLeak(page);
}, 180_000);

scenario('SSE-04', 'M7B-INVOICES-P2 REGRESSION GUARD (it passes on the entry commit too: a real sign-out also reaches the page while it is mounted, and on the entry commit the edit store also followed the Firebase sign-in) — THE DIRECTORY\'S EDIT HOLD AND OPEN EDIT FORM AT A SIGN-OUT — an edit whose PATCH answer is lost holds its token and exact body until the owner signs out: then the page\'s heap holds neither; signed in again nothing of it is held, offered or re-sent through navigation and a Refresh; an edit form with a typed phone open at the next sign-out sends nothing and leaves no session token of either session in the heap; one create, one edit, nothing else', async () => {
  const { tenant, boss } = await shop('se4');
  const name = `M7SSE se4 Ada ${SUFFIX}`;
  const renamed = `M7SSE se4 King ${SUFFIX}`;
  const digits = SUFFIX.replace(/\D/g, '7').slice(0, 2);
  const phone = `+1 555 02${digits}`;
  const newPhone = `+1 555 03${digits}`;
  const typedPhone = `+1 555 04${digits}`;
  const email = `se4.${SUFFIX}@example.test`;
  const before = await counts();
  const page = await recordWrites(await openPage());
  await signIn(page, boss);
  await openDirectory(page);
  await waitList(page);
  await page.fill(by('directory-phone'), phone);
  await page.fill(by('directory-email'), email);
  await addCustomer(page, name);
  await page.waitFor(`!!${q('directory-saved-link')}`, 30_000, 'the saved notice');
  const [{ id }] = await named(tenant, name);
  await page.click(by('directory-saved-link'));
  await waitData(page, 'directory-detail', 'phase', 'ready');
  /**
   * After a sign-out: how many of `tokens` and whether `body` the page's heap still holds (asserted), and whether it
   * holds each contact string (recorded with its retaining path only: SSE-01's render residue, no erasure claimed).
   */
  const searchHeap = async (tokens, body, contacts, tries = 3) => {
    let found = null;
    let snapshot = '';
    // Each snapshot asks for a collection first; the logout's own work may still be finishing in the first one.
    for (let i = 0; i < tries && (found === null || found.tokens + found.body > 0); i++) {
      snapshot = await heapSnapshot(page);
      found = { tokens: tokens.filter((v) => snapshot.includes(v)).length, body: snapshot.includes(JSON.stringify(body).slice(1, -1)) ? 1 : 0 };
    }
    const retainers = Object.fromEntries(contacts.map((c) => [c, snapshot.includes(c) ? retainingPath(snapshot, c) : null]));
    return { found, retainers };
  };
  const signedOut = async () => {
    const out = await signOutHere(page);
    await page.waitFor(() => st.api.slice(out).some((r) => isLogout(r) && r.handedBack === true), 20_000, 'the logout\'s answer was handed to the page');
    await page.settle();
    return out;
  };

  // 1. ONE PATCH, committed; its answer lost at the front: the edit is held, Check again offered.
  await openEditForm(page);
  await retype(page, 'directory-edit-name', renamed);
  await retype(page, 'directory-edit-phone', newPhone);
  let lost = 0;
  try {
    st.lose = (rec, phase) => phase === 'response' && isEdit(rec) && rec.frameId === page.frameId && lost++ === 0;
    await page.click(by('directory-edit-save'));
    await waitData(page, 'directory-edit-hold', 'state', 'unresolved');
  } finally {
    st.lose = null;
  }
  const [patch] = sentBy(page, isEdit);
  const heldBefore = { check: await offered(page, 'directory-edit-check'), lost: patch.lost ?? null };
  assert.deepEqual(heldBefore, { check: true, lost: 'response' }, 'the edit is held with Check again: its answer was lost at the front');
  assert.ok(patch.body.includes(newPhone) && patch.body.includes(renamed), 'the body sent carries the new name and phone');
  const firstTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  assert.ok(firstTokens.length > 0, 'the session CSRF token was seen');
  // The control: the same search BEFORE the sign-out finds the held edit's token and exact body in the heap, so their
  // absence after it is the sign-out's doing, not a search that cannot see them.
  const control = (await searchHeap(firstTokens, patch.body, [], 1)).found;
  assert.ok(control.tokens > 0 && control.body === 1, `before the sign-out the heap holds the token and the body: ${JSON.stringify(control)}`);

  // 2. Signed out in this tab (the same document): once the logout has run, the heap holds no token and no body.
  await page.evaluate('window.__sdbSameDocument = true');
  const out = await signedOut();
  const held = await searchHeap(firstTokens, patch.body, [renamed, newPhone]);

  // 3. Signed in again (a new session): nothing of the edit is held or offered, through navigation and a Refresh.
  await signInHere(page, boss);
  await openDirectory(page, `${DIRECTORY}/${id}`);
  await waitData(page, 'directory-detail', 'phase', 'ready');
  const shownAgain = async () => ({ hold: await has(page, 'directory-edit-hold'), check: await has(page, 'directory-edit-check'), edit: await offered(page, 'directory-edit') });
  const back = { ...(await shownAgain()), alert: await textOf(page, 'directory-edit-alert') };
  await go(page, '/');
  await page.settle();
  await openDirectory(page);
  await waitList(page);
  const refreshAt = st.api.length;
  await page.click(by('directory-refresh'));
  await page.waitFor(() => sentBy(page, isList, refreshAt).some((r) => r.status !== null), 15_000, 'the Refresh read was answered');
  await openDirectory(page, `${DIRECTORY}/${id}`);
  await waitData(page, 'directory-detail', 'phase', 'ready');
  const remounted = await shownAgain();

  // 4. The edit form open, a phone typed, at the next sign-out: nothing is sent, and the heap keeps no token or body.
  await openEditForm(page);
  await retype(page, 'directory-edit-phone', typedPhone);
  const allTokens = [...new Set(sentBy(page, () => true).flatMap(tokensOf))];
  await signedOut();
  const form = await searchHeap(allTokens, patch.body, [typedPhone]);
  await quiet(page, out);
  const edits = sentBy(page, isEdit);
  record('SSE-04', { heldBefore, control, held, back, remounted, form, edits: edits.map(apiLine) });
  assert.equal(await page.evaluate(SAME_DOCUMENT), true, 'the same document throughout: the module memory is the one the sign-outs left');
  assert.deepEqual(held.found, { tokens: 0, body: 0 }, 'once signed out with an edit held, the page\'s heap holds neither the session CSRF token nor the exact PATCH body');
  assert.deepEqual(back, { hold: false, check: false, edit: true, alert: '' }, 'signed in again: no held edit, no Check again, Edit offered, nothing said of it');
  assert.deepEqual(remounted, { hold: false, check: false, edit: true }, 'a navigation away and back and a Refresh change nothing');
  assert.deepEqual(form.found, { tokens: 0, body: 0 }, 'once signed out with the edit form open, the heap holds no session CSRF token of either session (and still no PATCH body)');
  assert.deepEqual(edits.map((r) => r.status), [200], 'one PATCH in the whole case: its answer lost at the front, never re-sent, and nothing sent from the form open at the second sign-out');
  const [stored] = await named(tenant, renamed);
  assert.equal(stored?.id, id, 'the lost answer\'s edit committed');
  await assertDelta(before, { C: 1, A: 1, E: 0, U: 1, K: 2, L: 2 }, 'one create and one edit: one customer, one create and one update audit, two completions');
  await assertNoLeak(page);
}, 240_000);
