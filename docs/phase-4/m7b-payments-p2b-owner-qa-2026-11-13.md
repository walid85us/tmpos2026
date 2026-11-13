# Manual browser recheck of the shop's payment recording — 2026-11-13 (M7B-PAYMENTS-P2B)

**Status: evidence record only.**
- It records a manual browser recheck of the shop's payment recording and recovery (M7B-PAYMENTS-P2B; [15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.13) on commit `9317291`.
- **Who did what.** ChatGPT performed the recheck in the browser. The owner supplied the test-account sign-ins (fictional `*@tmpos-qa.test` accounts). The observations below are therefore the recheck's, not the owner's own.
- It closes no gate. Doc [08](./08-production-gate-and-risk-register.md)'s Current column is unchanged: 37 gates, 29 OPEN, 7 PARTIAL and 1 PASS at repository level; none is closed for production. G-UAT stays OPEN: this is not a UAT sign-off.
- It is not acceptance of the application, of M7b or of Phase 4.0, and it makes no production-readiness claim.
- The earlier record, [Critical Owner QA Results 2026-11-06](./critical-owner-qa-results-2026-11-06.md), is unchanged.

All dates are 2026 and all times are UTC.

**Source.** The results reported by the recheck on 2026-11-13. This record performed none of the checks again. Its facts are what the recheck reported, reconciled with the fixtures the session was seeded with.
- **Build.** `9317291` (`93172914d552e510b1bcb774c026f99b92ed4ed4`), on `main` since the fast-forward from `2984e63`.
- **Session.** The disposable interactive QA session `qa-20261112t2329-78c0`, generation 1, store `store-a-main` ([14](./14-interactive-qa-runbook.md)). Payment fixtures were seeded at about 23:30 on 2026-11-12; the session has since been torn down. Data are synthetic and the accounts are the fictional `*@tmpos-qa.test` test accounts.
- **Fixtures used** (seeded state, read back read-only before the recheck):

| Invoice | Fixture label | Total | Seeded state |
|---|---|---|---|
| 15 | `pay-full` | $22.00 | One $22.00 cash payment recorded by the manager test account, its registration recorded and not yet confirmed; $0.00 remaining |
| 7 | `pay-hold` | $40.00 | No payment and no registration; $40.00 remaining |

## 1. Observations

These are the observations reported by the manual browser recheck. They are corroborated only by the seeded fixture readback above. The repository's suites did not re-execute them, beyond the automated tests cited in the last column.

| Check | Result | What the recheck observed | Limits kept |
|---|---|---|---|
| A manager confirms a seeded recorded payment | As expected (manual browser recheck) | Signed in as the manager test account: on invoice 15 the seeded $22 payment was confirmed | The report does not include the request log or the database's settlement row |
| The original failure sequence, repeated | As expected (manual browser recheck) | A fresh $40 payment of the full balance on invoice 7, then a reload before Confirm. After the reload the original attempt was found again; the invoice showed one history row and $0 remaining | Covered in automation by SII-230 and SIS-34. The report does not include the attempt id or the number of requests sent |
| A settled invoice has nothing unfinished | As expected (manual browser recheck) | On a settled invoice, the attempts lookup returned no unfinished attempts | The report does not name which settled invoice was checked or which control ran the lookup |
| A view-only technician | As expected (manual browser recheck) | Signed in as the view-only technician test account: the payment history was visible and no payment action was offered | Covered in automation by SIS-29 (a technician's payment eligibility GET is answered 403, never retried, and no "Record payment" is offered; `tests/browser/shopRoleLevels.browser.test.mjs:11119`) and SII-166 (a 403 hides "Record payment") |

## 2. What the manual recheck did not cover

These P2B behaviours rest on automated evidence alone ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.13). Most cannot be staged by hand on the QA stack:
- the cross-attempt settlement block (SII-187, SII-203, SII-216, SII-219);
- the 60-second wait for an uncertain registration, and late answers after a sign-out or a store switch (SII-213, SII-228, SII-229);
- the 24-hour lookup gap (SII-209, SII-224 to SII-227);
- the lookup's 20-page cap (SII-181, SII-227);
- the 23-hour Check again cutoff (SII-174);
- the record 404 (SII-170, SIS-33).

## 3. Not claimed

- The shop's reversal controls (not built); refunds, credit notes or receipts.
- Any gate's movement; deployment; production readiness.
- That a recorded payment proves funds were received.
- Layout beyond what the recheck's browser showed.
- An exact executable binding beyond `9317291` and the session id above.
- That the owner personally performed or observed these checks.
