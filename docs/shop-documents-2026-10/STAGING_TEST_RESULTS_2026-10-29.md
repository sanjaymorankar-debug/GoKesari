# Staging test results: shop documents before the fee, 30-day promise, approve on promise (29 Oct 2026)

**Site:** test.gokesari.com (staging) only. gokesari.com was not touched.
**Build:** `main` after PR #273 (and #274/#275); the new routes answer on staging (`/documents-promise` 401 signed out, not 404).
**Run by:** the QA agent (Claude). 29 Oct 2026, 09:21–09:40 UTC. Desktop Chromium; 390 px and 1280 px viewports.
**Design:** [README.md](README.md).
**Automation:** `tests/qa/signed-in/sellers-shop-documents.spec.ts` (signed tier; checks SD-01 to SD-06b, which are not in `test-cases.xlsx` yet). Raw results are in `test-results/qa/test.gokesari.com/desktop.jsonl` (not committed).
**Evidence:** screenshots in [staging-2026-10-29/](staging-2026-10-29/).

## Accounts and test data

| | |
|---|---|
| Accounts | Staging test accounts from `tests/qa/worlds/staging.json`: shop owner (`+gk-shop`), operator (`+gk-ops`), admin (`+gk-admin`), signed in with the normal emailed code (one round, 3 codes) |
| QA shop created | **QA Docs 2026-10-29 mvtcd0sw**, id `0ff927dc-ff96-4b54-b857-ee69a90f7da5`, registration no. BKS-000033. Owner "QA Docs Owner", Stationery Store, Shivajinagar, Pune 411001, turnover ₹5 lakh, fee ₹1,178.82 (₹999 + 18% GST), referral code E2ETEST1 |
| Its state now | PENDING_APPROVAL / KYC_PENDING. PAN VERIFIED (mock vendor). GSTIN and Shop Act not given. Promise given 29 Oct 09:35 UTC, due **28 Nov 2026**. Fee PENDING (₹0 paid); one open sandbox checkout intent `8d828931-fb33-44d0-822d-a7761f966621` |
| Not changed | No feature flag, rule or admin setting. No shop approved, rejected or suspended. The follow-up job was not triggered |

**For the team:** while this shop waits, the shop-owner test account cannot register another shop through the long form (409 "… is already waiting for approval"). An operator should approve or reject it when the review below is finished.

## Results

| # | Case (from the brief) | Check | Result | Evidence |
|---|---|---|---|---|
| 1 | No verified document: fee page shows "Documents first" and no Pay button | SD-01 | **Pass** | `documents-before-fee` shows "Documents first / Get at least one of your documents verified…" and "Verify my documents". No Pay button, no promise box, at 1280 and 390 px. [sd01-…-1280](staging-2026-10-29/sd01-fee-page-no-verified-1280.png), [sd01-…-390](staging-2026-10-29/sd01-fee-page-no-verified-390.png) |
| 1 | Fee API refuses | SD-01 | **Pass** | `POST /api/shops/{id}/registration-fee` → 409 CONFLICT, `details.reason` `NO_VERIFIED_DOCUMENT`, "Please get at least one of your documents verified (for example your PAN) before paying the registration fee." |
| 1 | Promising now is refused | SD-01 | **Pass** | `POST /api/shops/{id}/documents-promise {promise:true}` → 409, `details.reason` `NO_VERIFIED_DOCUMENT` |
| 1+ | Extra: a PAN the vendor found but held for the team (MANUAL_REVIEW) does not count as verified | SD-02a | **Pass** | PAN MANUAL_REVIEW (`consistency_below_threshold`): fee 409 `NO_VERIFIED_DOCUMENT` (missing PAN, GSTIN, SHOP_ACT), promise 409, page still "Documents first" with no promise box. [sd02a-verification](staging-2026-10-29/sd02a-verification-pan-in-review-390.png), [sd02a-fee](staging-2026-10-29/sd02a-fee-page-pan-in-review-390.png) |
| 2 | Verify one document on the app's verification page | SD-02 | **Pass** | On `/shop/verification`, PAN typed, consent ticked, Verify clicked → badge "Verified" (mock vendor). [sd02-verification](staging-2026-10-29/sd02-verification-pan-verified-1280.png) |
| 2 | Fee page lists the remaining documents; fee still refused before the promise | SD-02 | **Pass** | "Not verified yet: GST number (GSTIN), Shop Act (Shops & Establishments) certificate…", "Verified: PAN". Fee API → 409 `DOCUMENTS_MISSING` |
| 2 | "Continue to payment" disabled until ticked; tick it | SD-02 | **Pass** | Disabled → enabled on tick → clicked. [unticked](staging-2026-10-29/sd02-fee-page-promise-unticked-390.png), [ticked](staging-2026-10-29/sd02-fee-page-promise-ticked-390.png) |
| 2 | Promised date (+30 days) and the Pay button appear | SD-02 | **Pass** | Alert "Documents promised by 28 Nov 2026 — Still to provide: GST number (GSTIN), Shop Act…"; "Pay ₹1,178.82 now" shown; no horizontal scroll at 390 px. `documentsDueAt` = promisedAt + 30 days exactly. A second promise → 200 and keeps the first date. [after promise](staging-2026-10-29/sd02-fee-page-after-promise-390.png) |
| 2 | Fee API no longer refused | SD-02 | **Pass** | `POST …/registration-fee` → 201, intent `8d828931-…`, ₹1,178.82 |
| 3 | Pay with the Cashfree sandbox (workflow); fee PAID, shop stays PENDING_APPROVAL | SD-03 | **Not run** | Staging gave the fee checkout to the app's in-process SANDBOX gateway (`redirectUrl` `/orders/pay/sandbox/gk_…`), not Cashfree. There is no Cashfree `payment_session_id`, so `sandbox-pay.yml` cannot pay it. The in-process "Pay (success)" page was not used because the brief says Cashfree sandbox only. Logged as **E-04** (environment, owner decision). The "never auto-approved after payment" rule is covered locally by `tests/integration/shop-document-follow-up.test.ts` and `onboarding-wizard-step2.test.ts` (README §4), not on staging |
| 4 | Operator queue: promise badge and "Approve on promise" | SD-04 | **Pass** | As operator, Admin console → Shops: the QA shop shows "documents promised by 28 Nov 2026" and **Approve on promise**. [badge](staging-2026-10-29/sd04-ops-queue-promise-badge-1280.png) |
| 4 | Confirm step | SD-04 | **Pass** | Approve on promise opens: "QA Docs Owner promised to provide GST number (GSTIN), Shop Act … by 28 Nov 2026. Approve … as Green after inspecting it… The registration fee and any licence … are still checked." plus **Confirm approval**. [confirm](staging-2026-10-29/sd04-ops-queue-confirm-step-1280.png) |
| 4 | Confirm → shop APPROVED | SD-04 | **Not run** | Not clicked. The QA agent's rule 2 is never to approve, reject or suspend anything on staging. The fee is also unpaid (case 3), and approval still checks the fee, so it would be refused anyway. Needs a person, or the owner's go-ahead, once the fee is paid |
| 4 | A shop without a promise shows no such button | SD-04 | **Pass** | The other pending shop, "E2E Four Features Pharmacy" (no promise), has Approve / Reject / Remind but no Approve on promise (same screenshot) |
| 5 | `/admin/shops/missing-documents` as admin; filters; missing documents; "Reminders: 0 of 3"; promised date | SD-05 | **Pass (partial)** | Filters Live / Suspended / Awaiting approval. The QA shop is under **Awaiting approval** (not approved, so not under Live) with "GST number (GSTIN) missing", "Shop Act … missing", "promised by 28 Nov 2026" and "Reminders: 0 of 3". Header: "next: 1 Nov 2026". Counts: Live 16, Suspended 0, Awaiting approval 2. [390](staging-2026-10-29/sd05-missing-documents-pending-390.png), [1280](staging-2026-10-29/sd05-missing-documents-pending-1280.png) |
| 5 | Shop appears under **Live** after approval | — | **Not run** | Depends on case 4's approval (not run) |
| 5 | 390 px, no horizontal scroll | SD-05 | **Pass** | scrollWidth ≤ clientWidth on all three views, at 390 and at 1280 px |
| 6 | Non-admin `?wizard=1` shows the long form | SD-06 | **Pass** | Shop owner: "Tell us about your shop, clinic or office." long form, no wizard. [owner](staging-2026-10-29/sd06-wizard-1-shop-owner-long-form-390.png) |
| 6 | Wizard step routes answer 404 FEATURE_NOT_AVAILABLE | SD-06 | **Pass** | `registration-draft/details`, `/location`, `/documents`, `/submit` → 404, `code` NOT_FOUND, `details.reason` FEATURE_NOT_AVAILABLE, `feature` `shop_onboarding_wizard_enabled`. `code` is NOT_FOUND by design (`featureNotAvailable()` in `feature-flags.ts`); the reason sits in `details` |
| 6 | Same for the wizard's step-1 routes | SD-06b | **Fail: D-106** | `registration-draft/gstin` and `/pan` → **422** VALIDATION_FAILED to the same empty body (field errors gstin/pan, consent), so the request gets past the flag. These two routes never call `requireWizardAvailable`. Per the code, a valid body opens a draft and runs a KYC vendor check |
| 6 | Admin `?wizard=1` opens the wizard | SD-06 | **Pass** | Admin: "A few quick steps…" wizard. [admin](staging-2026-10-29/sd06-wizard-1-admin-wizard-390.png) |
| 6 | Admin reaches the review step (optional) | — | **Not run** | Skipped as allowed: it would create an admin-owned draft and shop on staging |
| — | Follow-up job `shop-document-follow-up` | — | **Not run (by design)** | Acts only on the 1st and 15th; not triggered today. **First real run 1 Nov 2026** (05:00 IST). Afterwards, check `/admin/shops/missing-documents` (Live: reminders 1 of 3) and the owners' inboxes |

**Totals (8 automated checks):** 6 pass (SD-01, SD-02, SD-02a, SD-04 partial, SD-05 partial, SD-06), 1 fail (SD-06b, D-106), 0 skipped, 1 blocked / Not run (SD-03, E-04). Sub-steps not run: approve on promise → APPROVED, the shop under Live after approval, the wizard review step, and the follow-up job.

## Defects and findings

| ID | Severity | Where it reproduces | Summary |
|---|---|---|---|
| **D-106** | Low | test.gokesari.com, shop-owner test account (any signed-in non-admin) | With `shop_onboarding_wizard_enabled` off, `POST /api/shops/registration-draft/gstin` and `/pan` are not gated: 422 validation instead of 404 FEATURE_NOT_AVAILABLE. A valid body would open a draft and spend a KYC vendor check. Fix: `requireWizardAvailable(user)` in both routes, as #274 did for the other four. gokesari.com not tested (read-only for QA) |
| **E-04** | Info (environment) | test.gokesari.com | The registration-fee checkout goes to the in-process SANDBOX gateway (`PAYMENT_GATEWAY` = SANDBOX), so the Cashfree "Sandbox payment" workflow cannot be used. Owner decision: switch staging to the Cashfree sandbox, or allow the in-process page for fee tests |

Both are logged in [`docs/testing/qa-defects.json`](../testing/qa-defects.json).

Test-side corrections made during the run (not defects): (1) The first PAN went to MANUAL_REVIEW because the shop's PIN (411038) differed from the mock vendor's record PIN (411001), which lowers the consistency score. The owner corrected the QA shop's PIN to 411001 and the PAN was submitted again. The spec now registers at 411001, and the in-review state is kept as check SD-02a. (2) SD-06 first expected `error.code` FEATURE_NOT_AVAILABLE; by design it is `details.reason`.

## Not tested, and why

- **Paying the fee (case 3):** no Cashfree session on staging (E-04). Also not checked on staging: fee PAID with the shop still PENDING_APPROVAL.
- **Approve on promise → APPROVED (case 4) and the shop under Live (case 5):** the QA agent does not approve shops on staging (its rule 2), and the fee is unpaid. To finish, after the fee is paid: an operator clicks Confirm approval for "QA Docs 2026-10-29 mvtcd0sw". Then check: status APPROVED; the waiver "Owner promised the documents by 28 Nov 2026; approved after inspection"; the shop under Live with "Reminders: 0 of 3".
- **Long form in the browser:** the shop was registered through the long form's own endpoint (`POST /api/shops`) rather than by filling the form. Google Maps did not load in the test browser ("This page didn't load Google Maps correctly"), and location confirmation is part of the form.
- **Wizard review step (`review-documents`, promise box, "Create my shop and pay" disabled):** optional and skipped, because it would create admin-owned data on staging.
- **Follow-up job:** first real run on 1 Nov 2026.
- **gokesari.com:** not touched, as instructed.
