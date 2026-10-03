# TM POS2026 — Teal Metrics

**The all-in-one point-of-sale and shop-management platform for repair shops and independent retailers.**

Run the counter, the repair bench, the stockroom and the customer book from one place, with the controls a growing business needs.

> **Proprietary and confidential.** TM POS2026 is commercial software. It is not open source, and it is not offered for download, cloning, self-hosting or redistribution. See [License](#license).

> **Status: in development.** TM POS2026 is not yet available. This page describes the product being built. Nothing described here is live for customers yet, and demonstrations for prospective customers and partners are by arrangement.

---

## Contents

- [Why TM POS2026](#why-tm-pos2026)
- [Where things stand](#where-things-stand)
- [Capabilities: the shop app](#capabilities-the-shop-app)
- [Capabilities: the Backend Control Plane](#capabilities-the-backend-control-plane)
- [Security and trust](#security-and-trust)
- [Roadmap](#roadmap)
- [Version history](#version-history)
- [Availability](#availability)
- [License](#license)

---

## Why TM POS2026

Small shops often juggle a till, a repair log, a stock spreadsheet and a customer notebook, and none of them talk to each other. TM POS2026 brings that work into one workspace, built for businesses that sell, repair and service in the same place.

- **One workspace for the whole shop.** Sales, repairs, inventory, customers and staff in one place, instead of separate tools.
- **Built for repair and retail together.** Repair tickets, warranties, returns and parts sit alongside ordinary checkout.
- **Grows with the business.** Plans and add-ons switch modules on as the shop needs them.
- **Role-based access.** Each team member sees and does only what their role allows.
- **Security by design.** Server-side access checks and an audit trail are part of the platform foundation being built underneath the product.

TM POS2026 has two parts:

- **The shop app**, which a repair shop or retailer uses every day.
- **The Backend Control Plane**, the separate console that the organisation offering TM POS2026 uses to run the platform and look after every business on it.

---

## Where things stand

| Part | Status |
|---|---|
| **Shop app** | **Interactive preview.** The workflows below work end to end on sample data. Entries are not yet saved to a server (the exceptions, a customer directory that saves customer names, with an optional phone number and email address, to the server and the owner's customer-access settings on the role screen, are built and not deployed: see [With your customers](#with-your-customers)), and no real payments, messages or carrier purchases take place. Moving each area onto permanent, server-backed storage is planned (see [Roadmap](#roadmap)). |
| **Backend Control Plane** | **Initial foundation built, not deployed.** Secure administrator access, the business-account directory, renaming, suspending and reactivating businesses, and the audit record of those events are built and tested. They are not yet available to anyone. Other console areas are previews. |
| **Launch** | **Planned.** Launch follows a formal readiness review and is a separate, explicit decision. |

Status labels used below:

- **Preview:** the workflow works end to end in the preview app, using sample data. Nothing is saved to a server, and no real payments, messages or carrier purchases are made.
- **Preview (sample figures):** the screens work, but they show example figures, not the shop's own activity.
- **Console preview:** a Backend Control Plane screen with sample data. The capability behind it is planned.
- **Built, not deployed:** implemented and tested in the platform's code, but not yet available to anyone.
- **Coming later:** planned and not yet built.

---

## Capabilities: the shop app

### Plans and access control
- Plans that switch modules on as a shop grows: a starter plan covers checkout, customers, invoices and support, and higher plans add repairs, inventory, services, purchasing, staff, warranties, marketing, prospects, shipping and returns. *(Preview)*
- Per-role permissions with graded levels (view, create, edit, manage, approve and full), so a team member can, for example, view repair tickets without being able to close or reassign them. *(Preview)*
- Approving refunds and return payouts is a separate permission. The built-in owner and manager roles include it by default, custom roles start without it, and it can be granted or removed role by role. *(Preview)*
- Server-checked shop staff sessions: removing a person's access, or suspending their business or store, refuses their next request; a sign-in never completes on access that has already been removed; an ended session is never brought back; and each sign-in, re-confirmation and sign-out is kept in a durable record. *(Built, not deployed; the shop app uses it for the owner's customer-access settings on its role screen and for its customer directory)*

### At the counter: point of sale
- Cart-based checkout for products, services and repairs, with line-item quantity and price edits. *(Preview)*
- Split payments across several methods, with the remaining balance calculated automatically. *(Preview)*
- Percentage and fixed discounts, named promo codes and cash rounding. *(Preview)*
- Loyalty at the till: attach a customer, earn points on each sale and redeem them as a discount. *(Preview)*
- Held (parked) orders, order history and receipt reprints. *(Preview)*
- Cash drawer management: opening balance, cash in and out, and shift open and close. *(Preview)*
- Refunds and exchanges with a supervisor authorisation step. *(Preview)*
- Warranty claims and repair deposits started directly from a sale. *(Preview)*
- Add-on sale prompts, and switching between staff at the same register. *(Preview)*

### Invoices and receipts
- An invoice list with outstanding, paid-today, overdue and recurring summaries. *(Preview)*
- Line items, payment history and status on every invoice. *(Preview)*
- Sending invoices by email or text message with a pay-online link, printing, and taking payment in store. *(Preview; message delivery and live payments are not yet connected)*
- Customisable templates for invoices, receipts, repair tickets, estimates and labels. *(Preview)*

### At the repair bench
- Repair tickets from intake to hand-back, through clear stages: pending, diagnosed, in progress, awaiting parts, ready and completed. Each ticket has a full activity timeline. *(Preview)*
- Device intake, condition before and after the repair, diagnostic findings, and separate internal and customer-facing notes. *(Preview)*
- Parts and labour on each ticket, with a running cost summary. *(Preview)*
- Technician assignment and file attachments. *(Preview)*
- Quick intake from the counter, with barcode and QR scanning. *(Preview)*
- A service catalogue organised by category, with bulk price editing and warranty terms set per service. *(Preview)*

### Warranties and returns
- Warranty claims that move through submitted, under review, approved, rejected, in repair, replacement pending and completed, with a priority on each claim. *(Preview)*
- Claims linked to a repair for resolution. *(Preview)*
- A returns portal: intake with reason and requested outcome (refund, exchange or store credit), item-by-item inspection and disposition, return shipping and a status timeline. *(Preview)*
- Return approval as its own permission, separate from general access to returns. *(Preview)*

### In the stockroom
- Stock levels with low-stock and out-of-stock alerts, and total units and stock value at a glance. *(Preview)*
- Stock adjustments with a full movement log. *(Preview)*
- Products that can be marked as repair parts or hidden from the checkout catalogue. *(Preview)*
- Serial-number tracking. *(Preview)*
- Trade-ins and buybacks, with a refurbishment workflow to recondition traded-in devices. *(Preview)*
- Transfers between stores with receive-and-reconcile, and stock counts. *(Preview)*
- Suppliers and purchase orders: draft, sent, ordered, in transit, received and closed. Deliveries are checked against the order when received, and returns to suppliers are tracked. *(Preview)*
- Automatic stock deduction on each completed sale. *(Coming later, with permanent inventory storage)*

### Shipping and fulfilment
- Create and track shipments, with a full tracking-event history. *(Preview)*
- Address validation, rate comparison across carriers, and label purchase and reprint. *(Preview)*
- Drop-off and locker location selection for supported carriers. *(Preview)*
- Carrier pickup scheduling, with checks that show exactly what is missing before a pickup can be booked. *(Preview)*
- Packing stages tied to each shipment. *(Preview)*
- Automation rules that flag shipments, add notes, mark items for review or queue them for batch processing. They are designed so they cannot buy labels or take irreversible carrier actions on their own. Authorised staff can approve exceptions, and overrides are recorded. *(Preview)*
- Batch labelling and carrier scorecards comparing cost, speed and pickup reliability, on higher plans. *(Preview)*
- Several carrier accounts side by side, each configured separately. *(Preview)*

### With your customers
- Customer profiles with history, notes, custom fields and the devices each customer has brought in. *(Preview)*
- A loyalty programme with points balances and tiered membership (Bronze, Silver, Gold and Platinum), each tier with configurable privileges. *(Preview)*
- Prospect tracking through new, contacted and qualified. *(Preview)*
- Estimates and quotes (draft, sent, accepted, rejected) that convert into a sale, plus customer enquiry intake. *(Preview)*
- Marketing campaigns and loyalty-performance views. *(Preview (sample figures))*
- A customer list kept on the server, showing a signed-in team member only their own business's customers, by name. *(Built, not deployed; the shop app's Customer Directory page reads this list and opens a single customer from it, reuses the existing sign-in when the page is reopened or reloaded, waits for the user to choose Reconnect if that sign-in ends while the page is open instead of signing in again on its own, and only ever shows the list for the sign-in it is using. The contact details, loyalty and history on the Customers page remain a preview: they are held only in the browser's memory, are lost when the page is reloaded, and are not linked to it)*
- Adding a customer to that server-side list by name, for team members whose role allows it. Each addition made through the product is recorded in the audit trail, and retrying the same request is designed not to add the same customer twice. *(Built, not deployed; the shop app's Customer Directory page adds a customer by name and shows it as saved only once the server confirms it. Customers added on the Customers page are still a preview, held only in the browser's memory and lost when the page is reloaded)*
- An optional phone number and email address for each customer on that server-side list, and the time the server created the customer. *(Built, not deployed; the shop app's Customer Directory page asks for both when a customer is added and shows them on that customer's page, with "Not provided" when none was given and "Not recorded" as the creation time of a customer added before the server kept one. They are not verified or used to match customers, and any team member whose role can view customers can see them. Contact details on the Customers page are not copied to the server)*
- Correcting a saved customer's name, phone number or email address on that server-side list, for team members whose role allows editing customers. A change never silently overwrites one someone else saved first, and each change made through the product is recorded in the audit trail. *(Built, not deployed; the shop app's Customer Directory page edits a customer from that customer's page, shows a change as saved only once the server confirms it, and never sends a change again on its own when its outcome is unclear. A customer's identity and creation time never change. Customers on the Customers page are still a preview, held only in the browser's memory)*
- Finding a customer on that server-side list by typing part of their name, for team members whose role allows viewing customers. Letter case is ignored, so "ana" also finds "Ana" and "ANA", and only the signed-in team member's own business's customers are ever shown. *(Built, not deployed; the shop app's Customer Directory page has a search box with Search and Clear buttons, says plainly when no customer matches, and keeps what was typed out of the page address, the browser's history and its storage. Accents are not ignored, so "jose" does not find "José". Customers on the Customers page are still a preview, held only in the browser's memory)*
- Choosing a customer saved on that server-side list when preparing a new invoice, in stores whose plan includes customers, for team members whose role allows creating invoices and viewing customers: search by name, pick the exact customer (two customers with the same name are told apart by the end of their reference), and change or remove the choice. *(Built, not deployed; an invoice for a customer saved on the server cannot be created yet: the draft says so and points to the browser's own customer list instead. Existing invoices, editing an invoice and invoices for customers from the browser's own list work as before. The choice is held only while the draft is open, is lost when the page is reloaded, and is removed, with a note, if the sign-in it was made under ends or changes)*
- The business owner choosing, role by role, how much customer access the built-in staff roles have (for example, view only), kept on the server and checked whenever the customer list is viewed or a customer is added or edited, including for team members already signed in. Each change needs a recent sign-in and a reason, and changes made through the product are recorded in the audit trail. *(Built, not deployed; the shop app's role screen shows all four built-in roles' customer access as the server holds it, changes it for the Manager, Technician and Sales Associate roles, and shows a change as saved only once the server confirms it. Only the owner can see or change these settings. Custom roles and the screen's other permissions still apply only in that browser tab)*

### Running the business
- Staff profiles, clock in and out with break tracking, and a time-log editor. *(Preview)*
- Custom roles with a full permission matrix, down to individual actions such as approving refunds, managing purchase orders or dispatching a shipment. *(Preview)*
- A payroll and commission calculator. *(Preview)*
- A staff activity log. *(Preview)*
- A home dashboard with one-tap shortcuts (new sale, new customer, quick repair intake, scan, print label, add stock) and alerts for low stock, pending approvals, held orders and active repairs. *(Preview)*
- Sales, staff and inventory reports with revenue and category breakdowns. *(Preview (sample figures))*

### Connections and widgets
- An integrations directory covering accounting, e-commerce, payments, phone, text messaging, productivity, membership and parts suppliers, each with its own settings screen. *(Preview; no live integrations are connected)*
- Branded widgets for the shop's website and in-store screens: *(Preview)*
  - online appointment booking;
  - a repair-status tracker for customers;
  - a trade-in quote tool;
  - a customer self-service portal;
  - a customer-facing display at the counter;
  - a self-service check-in kiosk;
  - a queue display.

### Settings and support
- Store profile and branding, regional and tax settings, and configurable workflow statuses. *(Preview)*
- Setup screens for receipt and label printers, cash drawers and barcode scanners. *(Preview)*
- Plan and add-on management from inside the shop. *(Preview)*
- A help centre with getting-started guides. *(Preview)*

### Coming later
- **An app marketplace** of add-ons for the shop.
- **Mail-in repairs:** intake, shipping and payment for repairs customers send in, including bulk intake for business customers.
- **A general ledger** with double-entry bookkeeping, a chart of accounts and financial statements.

---

## Capabilities: the Backend Control Plane

The Backend Control Plane is the console for the organisation that offers TM POS2026 to shops. It is deliberately separate from the shop app.

### Secure administrator access
- A separate, restricted administrator console, with its own sign-in kept apart from shop staff sign-in. *(Built, not deployed)*
- Multi-factor authentication at every administrator sign-in. *(Built, not deployed)*
- Short-lived administrator sessions: removing an administrator's access refuses their next request and ends all of their open sessions. *(Built, not deployed)*
- A "recent sign-in" check: sensitive actions such as suspending a business ask the administrator to confirm their identity again, without leaving the page. *(Built, not deployed)*
- Sign-in attempt limits against automated attacks. *(Built, not deployed)*

### Business accounts
- A directory of every business on the platform, with its name and status. *(Built, not deployed)*
- Renaming a business account, checked against the administrator's permissions at the moment of the change. *(Built, not deployed)*
- Suspending and reactivating a business account, each with a stated reason and a recent sign-in, and each recorded. *(Built, not deployed)*
- Onboarding new businesses. *(Coming later)*

### Accountability and audit
- A durable record of administrator sign-ins, identity re-confirmations and sign-outs, saved together with each of those events. *(Built, not deployed)*
- A change record for every business-account rename, suspension and reactivation. *(Built, not deployed)*
- A platform-wide activity history covering every administrative action, with its own console view. *(Coming later)*

### Command Center
- An at-a-glance summary of the platform: account status counts, areas that need attention, and service health. Each section shows whether its information is available, unavailable or not yet set up, with an "as of" time, and is designed to show only figures it can back up. *(Console preview: it runs on sample data and is connected to no live source; all of its information sources arrive in later roadmap stages)*

### Plans, billing, provisioning and team
- Plans, feature matrix, add-ons, subscriptions and usage. *(Console preview)*
- Provisioning new businesses and managing their web addresses. *(Console preview)*
- Platform team management, covering who on the provider's team holds which role. Role-based permission checks already guard the business-account actions above. *(Console preview; the checks are built, not deployed)*

### Built to fail safe
- The platform checks its own configuration before it starts, and refuses to start rather than run misconfigured. *(Built, not deployed)*
- Administrative actions are designed so that a retried or interrupted request is not applied twice. *(Built, not deployed)*

---

## Security and trust

TM POS2026 is being built with these protections at its core:

- **Separation between businesses.** Each business's data and activity are designed to be kept apart from every other business's.
- **Server-side access control.** Roles and permissions are checked by the platform itself, not just hidden in the screen. Administrative actions already work this way, and each shop area follows as it moves onto the platform.
- **Protected administration.** Administrators use a separate console with multi-factor authentication and fresh identity checks before sensitive actions.
- **Accountability.** Administrator sign-ins and important administrative changes are recorded in a durable audit trail.
- **Abuse protection.** Request limits guard against automated attacks, starting with administrator sign-in.
- **Fail-safe by design.** When something is misconfigured or unavailable, the platform is designed to refuse the action rather than guess.
- **Continuous quality checks.** Changes are checked by automated tests and security scans.

---

## Roadmap

TM POS2026 is delivered in stages. "Done" means the work is complete and tested; it does not mean it is live. Nothing goes live until the launch stage. No dates are committed on this page.

### Stage 1: Foundation *(Done)*
- The shop app experience, designed and working as an interactive preview.
- The target architecture and a full production plan.
- An automated test suite, plus quality and security checks on changes.

### Stage 2: Server foundation and secure administration *(Done, not deployed)*
- The platform server, with a safe process for changing its data structures.
- Server-side access checks built in from the start.
- A separate, secure administrator sign-in with multi-factor authentication and sign-in limits.
- The Backend Control Plane console shell.

### Stage 3: Permissions checked by the server *(In progress)*
- **Done:** one consistent set of role and permission rules, checked by the server for administrative actions.
- **Done:** the first server-checked administrative actions: renaming a business account, and suspending or reactivating one with a recorded reason and a recent sign-in check, each with a change record.
- **Done:** the business-account page in the Backend Control Plane.
- **Next:** extending server-side permission checks to every action inside a shop and to plan entitlements, and managing custom platform-team roles.

### Stage 4: A trustworthy foundation for every action *(In progress)*
- **Built:** protection against the same action being applied twice when a request is retried or interrupted.
- **Built:** a durable record of follow-on work, saved together with each action, so one action (for example, a sale) can later trigger the next (for example, a stock update) even if part of the process fails.
- **Planned:** running that follow-on work.
- **Built:** a durable audit trail, starting with administrator sign-in activity and business-account changes.
- **Built:** request limits against automated abuse.
- **Built:** a start-up process that checks the platform's configuration before accepting any request.
- **Next:** putting this foundation to work in each shop area as it moves onto the platform.

### Next up
1. **The first server-backed actions inside an individual shop.** Adding a customer, and the owner's per-role customer access, are built and not yet deployed.
2. **Secure shop staff sign-in** connected to the server, matching what already exists for administrators.

### Stage 5: Shop data moves onto the platform *(Planned)*
Each area of the shop app moves onto permanent, permission-checked, audited storage in turn. Each can be released and rolled back on its own:

1. **Customers, staff and prospects**, the records everything else refers to.
2. **Sales, invoices and payments**, including connecting a shop's own card-payment provider. Card details are designed to stay with that provider rather than be stored by TM POS2026.
3. **Inventory and purchasing**, kept consistent with recorded sales so stock counts stay accurate.
4. **Repairs, services, warranties and returns.**
5. **Shipping**, for outbound and return shipments.
6. **Plans, subscriptions and add-ons**, with feature access granted and removed by the platform.
7. **Platform settings, web addresses and integrations.**
8. **Oversight tools for the provider's team:** support, audit views, approvals and access reviews.

### Stage 6: Launch readiness *(Planned)*
- Monitoring, alerting and performance tracking.
- Security hardening.
- Backup and disaster recovery.
- Accessibility and performance reviews.
- A fully operational process for customer data-rights requests (access, correction and deletion).

### Stage 7: Launch *(Planned)*
- End-to-end testing across the whole platform.
- A full rehearsal of moving existing data.
- A formal production-readiness review.
- Launch itself is a separate, explicit decision taken after that review.

### After launch *(Planned, not yet scheduled)*
- An app marketplace.
- Mail-in repairs.
- A general ledger.
- Onboarding new businesses from the Backend Control Plane, and self-service platform-team management.

---

## Version history

TM POS2026 has not had a public release, and it has no official version numbers or release tags yet. The labels below are development milestones, grouped after the fact from the work each period delivered, newest first. The dates are the periods when that work was done, not release dates.

**[Shop]** marks the shop app, **[Backend]** marks the Backend Control Plane and the platform server, and **[Platform]** marks work for the service provider. Every **[Shop]** item is interactive-preview work on sample data. **[Platform]** items in v0.1–v0.3 are sample-data console concepts. **[Backend]** items are built in code and not deployed. Nothing in this history is live.

### v0.8: Server-checked permissions and business-account management
*18–30 September 2026*
- [Backend] One unified set of permission rules, checked by the server for administrative actions.
- [Backend] The first administrative actions running fully on the server: renaming a business account, and suspending or reactivating one with a recorded reason, each with a change record.
- [Backend] A business-account page in the Backend Control Plane.
- [Backend] A "recent sign-in" check before sensitive administrative actions.
- [Backend] A durable audit record of administrator sign-ins, re-confirmations and sign-outs.
- [Backend] Sign-outs and access removals are now ordered against administrator actions happening at the same moment: a sign-in, a recent sign-in or a business-account change either completes before the removal or does not happen at all, and an ended session is never brought back.
- [Backend] Server-side groundwork for shop staff sign-in: shop sessions are ordered against access changes in the same way, and each sign-in and re-confirmation is recorded, as is each sign-out whose record can be written (a sign-out still ends the session when it cannot). Now used by the shop app's role screen and customer directory. Not yet switched on.
- [Backend] A server-side customer list for shops, names only, that shows each business only its own customers and checks the team member's permission on the server, and now read by the shop app's Customer Directory page. Not yet switched on.
- [Backend] Adding a customer on the server by name, for shop team members whose role allows it, recorded in the audit trail, with a repeat of the same request designed not to add the customer twice, and now offered from the shop app's Customer Directory page. Not yet switched on.
- [Backend] Owner-set customer access for each built-in shop role, stored and checked on the server when the customer list is viewed or a customer is added, and now set from the shop app's role screen. Not yet switched on.
- [Backend] Request limits connected to durable, platform-wide storage.
- [Backend] A start-up process that refuses to start unless its configuration checks pass.
- [Platform] This product page and the proprietary licence.

### v0.7: Sessions, administrator sign-in and reliability
*13–17 September 2026*
- [Backend] Server-checked administrator sessions with multi-factor authentication, and groundwork for a separate shop-staff session (not yet connected).
- [Backend] The Backend Control Plane console shell, connected to administrator sessions.
- [Backend] Protection against duplicate actions, and a durable record of follow-on work saved with each action (running that work is planned).
- [Backend] A durable data layer for the platform server.
- [Backend] A request-limit foundation against automated abuse.

### v0.6: Server data foundation
*1–6 August 2026*
- [Backend] The platform server's data foundation, with each part of the system given only the access it needs.
- [Backend] An audit-record foundation, written together with each change it records.
- [Backend] Server-side scoping of every request to the right business.

### v0.5: Production blueprint and quality checks
*10–31 July 2026*
- [Backend] A full production architecture covering identity, permissions, data ownership and interfaces.
- [Backend] The staged roadmap through to the launch decision.
- [Backend] The automated test suite and quality and security checks that every later stage is built against.
- [Backend] A controlled pilot of server-checked administrative actions.
- [Backend] More read-only views in the internal console preview.

### v0.4: Backend Control Plane groundwork
*5 June – 9 July 2026*
- [Backend] Work began on the Backend Control Plane as a separate console with its own sign-in.
- [Backend] The platform's access model, team roles and governance rules were defined, as the basis for permissions checked on the server.
- [Backend] The durable data model and sign-in approach were designed.
- [Backend] An internal, read-only console preview.

### v0.3: Operations, support and access controls
*1 May – 4 June 2026*
- [Platform] An operations dashboard concept for the service provider, with case escalation.
- [Platform] Support-case handling with prioritisation and reusable replies.
- [Platform] Platform permissions brought together behind a single access check.
- [Shop] Section- and action-level permission checks throughout the shop app.
- [Shop] Store web-address management in its own workspace.

### v0.2: Shipping and fulfilment
*8–30 April 2026*
- [Shop] A full shipping module: carrier connections, address validation, label purchase and tracking.
- [Shop] Pickup scheduling with guided recovery when a booking fails.
- [Shop] A packing workflow that must be complete before a label can be bought.
- [Shop] Shipping automation rules with approval steps and role-aware visibility.
- [Shop] Carrier performance comparison and bulk shipment reconciliation.
- [Shop] Store-to-store transfers, receiving and supplier returns.
- [Platform] Plan and add-on controls extended to shipping.

### v0.1: The shop app takes shape
*24 March – 7 April 2026*
- [Shop] Point of sale, cash handling and cash rounding.
- [Shop] Inventory with stock tracking, adjustments and quick-add.
- [Shop] Customer records with loyalty points.
- [Shop] Invoicing with editable templates, logo upload and PDF download, and invoices created from completed repair tickets.
- [Shop] Repair tickets with technician assignment and warranty handling.
- [Shop] Role-based staff permissions with an access-management screen.
- [Platform] A service-provider command centre concept for business accounts, plans, add-ons and billing.
- [Platform] Store-owner onboarding and account-activation concepts.

---

## Availability

TM POS2026 is in development and is not yet available. When it launches, it will be offered as a hosted service. There is no public download, source package or self-hosted edition.

Demonstrations and licensing are arranged directly with the owner.

<!-- Owner: add the sales or licensing contact (email or web form) here before publishing. -->

---

## License

**Proprietary — All Rights Reserved.**

Copyright © 2026 [Owner legal name]. All rights reserved.

TM POS2026 (Teal Metrics) is private, commercial software. Its source code, documentation, designs and related materials (excluding third-party components and customer data) are the confidential and proprietary property of their owner. It is not open source. Viewing this page, or any access to this repository, grants no license or right, express or implied.

Without a written license agreement with the owner, or the owner's prior written permission, you may not:

- copy, clone, download, mirror or reproduce the software or its documentation, in whole or in part;
- distribute, publish, sublicense, sell, rent or otherwise make the software available to any third party;
- modify, adapt, translate or create derivative works based on the software;
- reverse engineer, decompile or disassemble the software, except to the extent applicable law expressly permits it;
- scrape, index or extract its content, or use it to train, fine-tune or evaluate any machine-learning or AI system;
- remove or alter any proprietary notice.

Unauthorized use may give rise to legal liability, including under applicable copyright and trade-secret law. The owner reserves all rights and remedies.

This is a summary. The full terms are in [LICENSE](LICENSE), and where they differ, the LICENSE governs. Third-party components, such as open-source dependencies, remain licensed under their own terms.

*TM POS2026 and Teal Metrics are trademarks of [Owner legal name]. All other names and marks belong to their respective owners.*
