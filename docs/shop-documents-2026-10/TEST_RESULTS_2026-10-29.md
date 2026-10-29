# Test results — shop documents gate, 30-day promise, 1st / 15th follow-up (29 Oct 2026)

Branch `claude/peaceful-pascal-jai8w2`, based on staging `45cb376`. Local runs (cloud session).

## Automated

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | clean |
| ESLint on every changed file | clean |
| Full suite, single database | **235 files, 2,918 tests passed** |
| Full suite, two-database split (`DB_SPLIT_MODE=split`) | SPLIT_RESULT |

New and changed tests:

| File | Covers |
|---|---|
| `tests/integration/shop-document-follow-up.test.ts` (9) | Approve on promise by an operator and an admin (waiver with the due date, audit `documentsPromise: true`); customer refused; unpromised shop refused; never automatic. Follow-up idle on other days and with the rule off; reminders 1–3 on 1 Nov / 15 Nov / 1 Dec, a second run the same day sends nothing, e-mail queued although the owner switched shop e-mails off; "last reminder … 15 Dec 2026"; suspended on 15 Dec with the suspension e-mail; count cleared; promise date respected (waits, then suspends); documents with the team not chased; a failed check chased again; complete documents clear the count; food shop chased for FSSAI; pending and closed shops left alone; next reminder day. |
| `tests/integration/onboarding-wizard-step2.test.ts` (25) | Rewritten for the new rule: all verified → live after payment; Shop Act in review → promise required, then paid but pending, 30-day due date, no deferral rows; Shop Act "I don't have it now" drops a checked number; no verified document → refused even with the promise; no-GSTIN route needs no promise but waits; food shop FSSAI "not now" → promise → not live; the long form's fee gate (refused → promise → paid, pending). |
| `tests/integration/registration-fee-*.test.ts` | The checkout answers 409 `NO_VERIFIED_DOCUMENT` before the documents; the payment tests verify them first. |
| `tests/integration/cron-schedule.test.ts` | New daily job `shop-document-follow-up`. |

## Browser check (local `next dev`, Chromium)

| Page | Width | Result |
|---|---|---|
| `/shop/registration-fee` — PAN verified, GSTIN and Shop Act missing | 390 | "Documents first" block, no Pay button; "Continue to payment" disabled until the box is ticked; after the tick: "Documents promised by 28 Nov 2026 — Still to provide: …", Pay button shown; `documents_promised_at` / `documents_due_at` (+30 days) saved |
| Admin approval queue — promised shop | 1280 | Badge "documents promised by 28 Nov 2026"; **Approve on promise** → confirmation text → shop APPROVED; waiver reason "Owner promised the documents by 28 Nov 2026; approved after inspection." |
| `/admin/shops/missing-documents` | 1280 / 390 | Live / Suspended / Awaiting approval filters; missing documents, reminders "1 of 3", last sent, next reminder day; no horizontal scroll at 390 |
| Wizard review step (Maharashtra Shop Act in review) | 390 | Documents block "Verified: PAN, GST number (GSTIN) — Not verified yet: Shop Act …"; "Create my shop and pay" disabled until the promise is ticked, enabled after |

No page errors on any page.

## Not run here

- Staging (test.gokesari.com) after merge: walk the long form and the wizard with the mock KYC vendor, pay with the Cashfree sandbox (`sandbox-pay.yml`), approve on promise as the operator test account.
- The real 1 Nov run on staging (05:00 IST daily cron) — check `/admin/shops/missing-documents` and the owners' inboxes afterwards.
