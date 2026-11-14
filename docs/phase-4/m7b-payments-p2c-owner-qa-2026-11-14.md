# Isolated QA of the shop's payment reversal — 2026-11-14 (M7B-PAYMENTS-P2C)

**Status: evidence record only.**
- It records owner-directed isolated QA of the shop's payment reversal and its recovery (M7B-PAYMENTS-P2C; [15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.14), in two runs, the second on the files committed as `9c4d201`.
- **What kind of QA.** Isolated QA on synthetic data with fictional `*@tmpos-qa.test` accounts. It is not UAT and not a deployment. G-UAT stays OPEN: this is not a UAT sign-off.
- It closes no gate. Doc [08](./08-production-gate-and-risk-register.md)'s Current column is unchanged: 37 gates, 29 OPEN, 7 PARTIAL and 1 PASS at repository level; none is closed for production.
- It is not acceptance of the application, of M7b or of Phase 4.0, and it makes no production-readiness claim.
- A reversal corrects the payment record: it records that the payment was entered in error. It returns no money and is not a refund.
- The earlier record, [Manual Browser Recheck: Payment Recording 2026-11-13](./m7b-payments-p2b-owner-qa-2026-11-13.md), is unchanged.

All dates are 2026.

**Source.** This record summarizes the results of the two runs below. It performed none of the checks again.
- **Run 1.** Session `qa-20261114t0126-5028`, on an earlier revision of the candidate (patch sha `a5cbfb02…`), before the layout fix and two small session-check hardenings. The owner reported its results.
- **Run 2.** Session `qa-20261114t1153-9fa0`, on files byte-identical to the eight paths of `9c4d201` (`9c4d2010149c42aee362566a5f40f6897b8243ce`). A QA-only one-line durable-PostgreSQL overlay in the QA supervisor was used; it is not part of the commit.
- **Fixtures** (both runs; synthetic data):

| Invoice | Fixture label | Note |
|---|---|---|
| 6 | `pay-rev-cancel` | Used for the layout and focus recheck in run 2 |
| 7 | `pay-rev-one` | Used for the double-click check in run 1 |
| 8 | `pay-rev-history` | — |
| 9 | `pay-rev-voided` | Voided by the QA fixture tool's API, not through the shop |
| 10 | `pay-rev-tabs` | — |
| 11 | `pay-rev-stale` | — |

## 1. Observations

These are the observations from the two runs. The last column names what each did not show and, where it applies, the automated tests that cover the behaviour ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.14).

| Run | Check | Result | What was observed | Limits kept |
|---|---|---|---|---|
| 1 | A reversal | PASS (owner-reported) | A recorded payment was reversed | Earlier revision, not the committed files. Automated: SII-232, SIS-35 |
| 1 | Renewed sign-in after an aged sign-in | PASS (owner-reported) | After an aged sign-in, the sign-in was renewed | Earlier revision. Automated: SII-241, SIS-39 |
| 1 | Role visibility | PASS (owner-reported) | No Reverse control for roles without the permission | Earlier revision. Automated: SII-231, SII-234, SIS-36 |
| 1 | Voided and reversed history | PASS (owner-reported) | Voided and reversed history shown | Invoice 9 was voided by the QA fixture tool's API, not through the shop. Voiding after every payment is reversed through the shop was not checked |
| 1 | Two tabs | PASS (owner-reported) | A sequential two-tab check: the same signed-in session, both confirmations opened before submitting either | Sequential, not concurrent. Simultaneous attempts are tested only by IPR-22, IPH-08 and IPH-09; SIS-38 is sequential too |
| 1 | Double-click on invoice 7 | One reversed row | The history showed one reversed row | The number of requests was not measured. Automated: SII-240 |
| 1 | Layout at 320 × 309 CSS px | Issue found | "Keep payment" broke "payment" across lines | Rechecked in run 2 on the committed files |
| 2 | Layout and focus at 320 × 309 CSS px, invoice 6 | As observed | At 16 px, "Keep payment" and "Reverse payment" each on one line. At 24 px, both wrapped only between words. Both controls reachable with no horizontal overflow. Escape restored focus to the payment row's button at both sizes. The balance stayed $12.50 recorded and $17.50 remaining | No screen reader. Automated: SIS-37 |

## 2. What the QA did not cover

These P2C behaviours rest on automated or server-only evidence ([15](./15-m7b-invoice-payment-recording-decision-pack.md) §12.14). Several cannot be staged on the QA stack:
- simultaneous attempts: only the database and HTTP tests (IPR-22, IPH-08, IPH-09); SIS-38 and the manual two-tab check are sequential;
- a lost reply after commit (P2C-10): a component simulation only (SII-246 and SII-250, where a scripted fetch applies the reversal and drops the answer, then Check payment reads it Reversed; SII-247's Retry follows a 500 that reversed nothing), plus the server's same-key replay on the real HTTP chain (IPH-03), which does not drop a reply; no real browser-to-server dropped-reply run was performed, and it is not stageable in QA;
- an unresolved attempt across a reload (P2C-17): a jsdom remount only (SII-257); no real reload test and no manual run;
- a late answer after switching invoice or store (P2C-16): jsdom only (SII-255, SII-256, SII-264); not stageable;
- screen readers: roles, labels and live regions are asserted (SII, SIS-39); no assistive-technology run and no axe;
- voiding after every payment is reversed through the shop (P2C-19): server only (IPR-10, IPH-04); not in SII or SIS and not by hand;
- P2C-15's "more than 60 s" was an example in the contract; the adopted UI spec deliberately uses no elapsed time or lease as evidence, and the new key's safety rests on the server's one-reversal-per-payment rule (IPH-08);
- not run by hand: the double-press request count, Stop waiting and the 30 s timeout, an eligibility 429 or failure, presses on another invoice or tenant, detach paths, and the Retry and Check paths.

## 3. Not claimed

- UAT, or any gate's movement; G-UAT stays OPEN.
- Deployment; production readiness.
- That a reversal returns money; refunds, credit notes or receipts. Credit notes remain for the next workstream.
- Simultaneous attempts at the browser level; screen-reader announcement.
- Layout beyond the sizes recorded above.
- That run 1 tested the committed files; it ran on an earlier revision.
- An exact executable binding beyond `9c4d201`'s eight paths and the two session ids above.
