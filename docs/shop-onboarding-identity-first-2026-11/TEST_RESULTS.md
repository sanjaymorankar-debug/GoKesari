# Shop onboarding: identity first — test results (08-Nov-2026, IST)

Brief and design: [BRIEF.md](BRIEF.md). PR #368 (`feat/onboarding-identity-first`).

## Summary

| Environment | When (IST) | Result |
|---|---|---|
| Local, integration tests (real Postgres, mock KYC) | 08-Nov-2026 10.26–11.04 | 3388 / 3392 pass; the 4 failures are unrelated (product-import parser, migrate-on-build connect timeout on the local DB). All onboarding suites pass. |
| GitHub CI on PR #368 | 08-Nov-2026 11.06–12.08 | Pass (scope, test) |
| test.gokesari.com — staging queue (CI, migration, deploy, post-deploy check, guest QA) | 08-Nov-2026 12.10–13.13 | **staging-verified** |
| test.gokesari.com — signed-in run (this report) | 08-Nov-2026 13.15–15.25 | **Pass**, with the limits below |
| gokesari.com — production release (PR #369) | 08-Nov-2026 15.26 merge, 15.33 post-deploy check | **Deployed**; wizard flag still off (owner) |

## Staging, signed-in (test.gokesari.com)

Accounts: the staging QA accounts (admin, customer = lc14, customer2). KYC on staging is
sandbox.co.in's **test** service; the fee goes to Cashfree **sandbox**, paid with Cashfree's test UPI
(`testfailure@gocash` / `testsuccess@gocash`, through `scripts/test-site/sandbox-pay.mjs`, as the
"Sandbox payment" workflow does). Screenshots: [staging-2026-11-08/](staging-2026-11-08/).

| ID | Platform | Case | Result | Time (IST) | Evidence |
|---|---|---|---|---|---|
| ON-01 | Web, desktop Chrome 1280 | "Verify your business" is the first screen: referral code + "Do you have a GST number?" Yes / No on one screen; 7 tiles | PASS | 15.19 | on01-verify-desktop.png |
| ON-02 | Web, desktop | Invalid GSTIN (12 characters) → "Enter the 15-character GSTIN …", stays on Verify; retry with a valid one | PASS | 15.19 | on02-invalid-gstin.png |
| ON-03 | Web, desktop | Company GSTIN → verified, PAN taken from it; record names no owner → only "Owner name" asked | PASS | 15.19 | on03-owner-name.png |
| ON-04 | Web, desktop | Address: the record gave none (staging's test company is foreign) → typed; map pin; shop name **pre-filled from GST**; Check and pay | PASS | 15.20 | on04-address.png, on08-map.png, on08-shop.png, on08-review.png |
| ON-05 | Web, desktop | Payment **fails** (UPI testfailure) → shop stays "Pending approval", fee still owing, can pay again | PASS | 15.22 | on05-admin-before.png, on05-admin-after-fee.png |
| ON-06 | Web, desktop | Payment **succeeds** (UPI testsuccess) → shop **Live** | PASS | 15.23 | on06-admin-live.png |
| ON-06b | Phone size | Live screen: "Your onboarding is complete. Your shop is now live and accepting orders." + "Add your products now …" + **Add Products** | PASS | 14.45 | on06b-live-screen-add-products.png |
| ON-07 | Android size (Chrome, Pixel 7) | Existing customer account opens Register a shop → starts at the GST / PAN screen | PASS | 15.20 | on07-sell-verify-android.png |
| ON-08 | Android size | GSTIN → owner name → address → map pin → shop name → pay (success) → **Live** | PASS | 15.24 | on08-address.png … on08-android-live.png |
| ON-09 | iPhone 14 size (Chromium emulation) | Invalid PAN (8 characters) → "Enter the 10-character PAN …", stays on Verify | PASS | 15.21 | on09-invalid-pan-ios.png |
| ON-10 | iPhone size | PAN only (no GST) → verified → address → … | **BLOCKED on staging** | 15.21 | on10-pan-blocked-staging-kyc.png |
| ON-11 | Web, desktop | Duplicate registration refused **with the existing shop's status** ("… is already registered and is waiting for admin approval") | PASS (name + PIN duplicate, seen live) | 15.22 | — (API answer 409 DUPLICATE_SHOP, shopStatus PENDING_APPROVAL) |

### Limits of the staging run

- **PAN-only route (ON-10):** blocked by staging's KYC test service, which answers only a request that
  exactly matches its saved example and refuses every PAN request (known since 31-Oct, defect D2 in
  `docs/shop-documents-2026-10/TEST_RESULTS_seller_bank_verification_2026-10-31.md`). The screen shows
  "Not verified — please check it and try again" and does not let the owner continue, which is the
  intended behaviour. Covered by the integration tests (`shop-registration-flow.test.ts`: PAN verified,
  PAN with address returned, PAN without address) and to be seen on production with live keys.
- **GST "owner name returned" and "address returned":** staging's test service returns one foreign
  company record for every GSTIN (no owner, no address), so on staging only the "not returned" branches
  could be seen. The "returned" branches are covered by the integration tests.
- **GSTIN / PAN duplicates from another account:** covered by the integration tests; on staging the
  same-name-and-PIN duplicate was refused with the existing shop's status.
- **Android / iOS apps:** the apps open `/shop/register` in their WebView, so they show exactly these
  pages. Tested here at Pixel 7 and iPhone 14 sizes in Chromium; WebKit itself hangs on this Mac
  (frozen macOS 14 build), so no Safari-engine run. No native build was needed or made.
- **E-mail** ("Your onboarding is complete — … is now live"): covered by the integration tests; the
  staging mailbox was not read (the QA sign-in rules allow reading only sign-in codes).

### Notes (not blocking)

- The page subtitle on /shop/register still says "… or you add them after your shop is live" (older
  wording). Cosmetic; follow-up.
- On a phone, the "Get the GoKesari app" prompt covers the lower part of the screen until dismissed
  (existing behaviour, not this change).
- When the GSTIN is verified but the PAN taken from it could not be confirmed, a yellow note "We
  couldn't confirm this automatically. You can carry on — our team will check it." is shown (seen on
  staging because its test service knows no PAN).

## Production (gokesari.com)

| Step | Time (IST) | Result |
|---|---|---|
| No other release in flight (no open PR into `main`, last Post-deploy check passed 07.29) | 15.25 | OK |
| PR #369 `staging` → `main` (carries only #368; no migration) merged | 15.26 | Done |
| Post-deploy check (`/`, `/shops`, `/robots.txt` 200 four rounds) | 15.33 | **PASS** |
| `/`, `/shop/register`, `/sell` answer 200 | 15.34 | PASS |
| `shop_onboarding_wizard_enabled` switched on | — | **Pending — owner** (Admin → Feature flags; sessions may not sign in on gokesari.com) |
| New flow seen on production (live KYC, real fee) | — | Pending — after the flag; no test data or sandbox payments on production |

Until the flag is on, gokesari.com keeps serving the old one-page form (DI-10). *(Superseded: the flag was retired and #376 released one flow only at 21.09 IST on 08-Nov-2026. See Phase 2 below.)*


---

# Phase 2: full test on both servers (08 and 09-Nov-2026, IST)

Written 09-Nov-2026, 02.26 IST. Evidence: [onboarding-identity-first-phase2-2026-11-08/](onboarding-identity-first-phase2-2026-11-08/) (screenshots `p2-*.png`, raw results `results*.json`).

## Result in short

| Server | When (IST) | Result |
|---|---|---|
| test.gokesari.com, registration flow | 08-Nov 22.45–23.17 | **27 of 33 cases pass**; 2 partly, 3 blocked, 1 not run. 4 defects, none stops a registration. |
| test.gokesari.com, regression (desktop + phone) | 08-Nov 23.18 to 09-Nov 01.14; failed checks re-run on desktop 01.18–02.21 | **Inconclusive for checkout and order handling.** Desktop after the re-run: 267 pass, 109 fail, 182 blocked, 548 skipped. Phone (first run only): 57 pass, 42 fail, 47 blocked, 24 skipped. |
| gokesari.com, release | 08-Nov 21.09 merge (#376), 21.16 post-deploy check | **Deployed, check passed.** |
| gokesari.com, guest checks | 08-Nov 22.41–22.51 | 104 pass, 2 fail, 3 blocked, 3 skipped. |
| gokesari.com, signed-in and payment cases | not run | **Not run** (see below). No test shop or test data was created on production. |

## test.gokesari.com: registration flow, case by case

KYC is sandbox.co.in's test service; the fee goes to Cashfree sandbox (test UPI). Sessions: staging QA accounts.

| Case | ID | What was checked | Result | Time (IST) | Evidence | Notes |
|---|---|---|---|---|---|---|
| New user | P2-40 | Signed-out visitor gets the sign-in step (Step 1 of 5), no old form | **PARTLY** | 22.57 | p2-40-signed-out.png | A brand-new account was not created: the staging rules allow only the existing QA mailboxes. Covered from the sign-in step onward. |
| Existing customer via Sell | P2-20 | Existing account without a shop: Sell → first screen | **PASS** | 22.57 | p2-20-sell.png, p2-20-first-screen.png | Sell → /shop/register; only referral code and GST / PAN; no review wording |
| Referral link, valid | P2-03 | Code taken from the link, checked, '✓ Applied' | **PASS** | 22.45 | p2-03-link-valid.png | E2ETEST1 filled from the link, '✓ Applied' |
| Referral link, invalid | P2-01 | Refused on the screen, request option shown | **PASS** | 22.45 | p2-01-link-invalid.png | 'Referral code NOSUCH99 does not exist'; Request a referral code shown |
| Referral link, expired | P2-02 | Refused with the expiry date | **PASS** | 22.45 | p2-02-link-expired.png | 'TQGC5XFX expired on 2026-10-31' |
| Referral typed, valid | P2-22 | Typed code saved | **PASS** | 22.57 | p2-22-pan-failed.png | E2ETEST1 typed and saved; Read in full Verify PAN 📷 Read it from a photo of your PAN card XXXXXX793E Not verified W; no Continue |
| Referral typed, invalid | P2-21 | Refused before any GST / PAN check | **PASS** | 22.57 | p2-21-typed-invalid.png | 'Referral code WRONG123 does not exist'; request option shown |
| Referral toggle: optional | P2-23 | Label says optional; empty code goes on | **PASS** | 22.57 | p2-23-optional.png | Setting put back to MANDATORY straight after. |
| Referral toggle: mandatory | P2-24 | Empty code cannot verify; request offered | **PASS** | 22.57 | p2-24-mandatory.png | setting MANDATORY; Verify disabled with empty code; request offered |
| First screen | P2-20 | Only referral code and GST / PAN | **PASS** | 22.57 | p2-20-sell.png, p2-20-first-screen.png | Sell → /shop/register; only referral code and GST / PAN; no review wording |
| GST success, PAN derived | P2-05 | PAN = GSTIN characters 3–12, read-only | **PASS** | 22.45 | p2-05-derived-pan.png | derived PAN equals GSTIN characters 3–12; field read-only |
| GST failure (format) | P2-06 | 12-character GSTIN refused, stays on Verify | **PASS** | 22.45 | p2-06-gst-format.png | 12-character GSTIN refused; stays on Verify |
| GST failure (check character) | P2-07 | Wrong check character refused, stays on Verify | **PASS** | 22.45 | p2-07-gst-checkchar.png | A 'not found' answer from the GST registry cannot be produced on staging (its test service returns one record for any GSTIN); integration tests cover it. |
| GST / PAN service down | P2-08 | Check fails: stays on Verify, nothing marked verified, retry works | **PARTLY** | 22.45 | p2-08-connection-down.png, p2-08-retry-ok.png | Simulated by cutting the browser's request. A real outage at the KYC company is covered by the integration tests only. |
| PAN-only success | — | PAN verified, carries on | **BLOCKED** | — | — | Staging's KYC test service refuses every PAN (known defect D2 since 31-Oct). Integration tests pass; needs a real run on production. |
| PAN failure | P2-22 | 'Not verified', no Continue | **PASS** | 22.57 | p2-22-pan-failed.png | E2ETEST1 typed and saved; Read in full Verify PAN 📷 Read it from a photo of your PAN card XXXXXX793E Not verified W; no Continue |
| Owner name returned | — | No owner screen | **BLOCKED** | — | — | Staging's test record names no owner. Integration tests pass. |
| Owner name missing | P2-09 | Only that field asked; Back keeps it | **PASS** | 22.45 | p2-09-owner.png | owner name asked once, Back returned it unchanged |
| Address returned | — | Address pre-filled | **BLOCKED** | — | — | Staging's test record has no address. Integration tests pass. |
| Address missing | P2-10 | Typed; Back keeps it | **PASS** | 22.45 | p2-10-address.png | address typed (staging's record has none); Back returned it unchanged |
| Geotagging | P2-11 | Map loads, 'Use my current location' shown; pin outside India refused; pin saved | **PASS** | 23.01 | p2-11-map.png, p2-11-outside-india.png | London refused ('Please place the pin on your shop in India. Place the pin on your shop. '); Pune pin saved |
| Shop details | P2-12 | Name pre-filled, 10-digit phone enforced, email prefilled | **PASS** | 23.05 | p2-12-licence-pharmacy.png, p2-12-phone-refused.png, p2-12-review.png | name 'QA Phase2 75689'; Shop email: sanjaymorankar+gk-shop@gmail.com Change; 5-digit phone refused; DAIRY:notice, PHARMACY:notice, DOCTOR_CLINIC:notic |
| Licence notice | P2-12 | 90-day notice for dairy, pharmacy, doctor, professional; none for general | **PASS** | 23.05 | p2-12-licence-pharmacy.png, p2-12-phone-refused.png, p2-12-review.png | name 'QA Phase2 75689'; Shop email: sanjaymorankar+gk-shop@gmail.com Change; 5-digit phone refused; DAIRY:notice, PHARMACY:notice, DOCTOR_CLINIC:notic |
| Suspended shop page | P2-42 | 'This shop is suspended and is not taking orders.' | **PASS** | 22.57 | p2-42-suspended-shop.png | Seen on a shop another session suspended for its own test. The 90-day automatic suspension itself is covered by integration tests only. |
| Payment success | P2-15 | Paid → Approved at once, exact completion text | **PASS** | 23.16 | p2-15-live.png | completion text exact; shop 'QA Phase2 Live 94542' APPROVED, fee PAID |
| Payment failure | P2-14b | Not live, Pay button offered, retry succeeds and goes live | **PASS** | 23.17 | p2-14-retry-live.png | See defect P2-D2: the failed-payment note does not appear. |
| Resume | P2-13 | New browser session returns to the same step with the data | **PASS** | 23.05 | p2-13-resume.png | fresh session opened at Check and pay with the shop name |
| Completion + Add products | P2-17 | Manual opens categories; template shows download (.xlsx) and upload | **PASS** | 23.12 | p2-17-template.png, p2-17-manual.png | template 200, filename="GoKesari_Product_Upload_Template.xlsx", 14865 bytes; upload link /shop/product-import; manual opened /shop/register |
| Referral commission attribution | P2-16 | Code's shop count and fees rise after go-live | **PASS** | 23.09 | API answer | E2ETEST1 shops 14 → 15; fees attributed ₹12188.2 → ₹13367.02 |
| Whole flow on a phone | P2-30 | GST → owner → address → pin → shop → pay → live, no sideways scroll | **PASS** | 23.16 | p2-30-live-android.png | Phone-size Chromium, not a real device. |
| Old URLs | P2-41 | ?form and ?wizard redirect; referral code kept | **PASS** | 22.57 | API answer | /shop/register?form → /shop/register; /shop/register?wizard → /shop/register; /shop/register?form&ref=E2ETEST1 → /shop/register?ref=E2ETEST1 |
| Languages | P2-25 | First screen in Hindi and Marathi | **PASS** | 22.50 | p2-25-hi.png, p2-25-mr.png | Later screens are still mostly English. |
| Existing-shop email | — | Live e-mail and licence e-mail | **NOT RUN** | — | — | The QA rules allow reading only sign-in codes. Integration tests pass. |

Referral requirement was switched to optional for P2-23 and put back to MANDATORY straight after (verified).

**Not separately tested on staging:** the optional Employee ID field (integration tests cover it).

## test.gokesari.com: regression of existing seller and customer flows

The checks ran on `/`, cart, orders, shop, rider, admin, security and field rules. The first run counted 149 failures; I then opened the QA bakery all day and re-ran the failed checks on desktop. That barely changed the desktop result (failing 107 → 109, passing 261 → 267), so closing time was **not** the main cause.

Compared with the last full staging run (03-Nov), 35 checks newly pass and 46 no longer pass. Of those 46, none traced to a fault in today's code: 4 are the Excel checks whose columns #372 changed on purpose, RB-02 fails because the admin account now owns a live shop, and most of the rest are rate limits or the set-up problems below.

Failures left on desktop after the re-run (109), by cause:

| Count | Kind | Cause | Checks |
|---|---|---|---|
| 34 | Not traced | Other: also failed or was blocked in earlier runs, or not traced one by one | SC-GW TC-CART-002 TC-CART-006 TC-CART-008 TC-CART-011 TC-CART-015 TC-COD-001 TC-DISC-001 TC-DISC-004 TC-DISC-005 TC-DISC-007 TC-DISC-017 TC-FIN-010 TC-FLD-017 TC-FLD-021 TC-FLD-022 TC-FLD-051 TC-FLD-056 TC-FUL-009 TC-LOC-004 TC-LOC-005 TC-LOC-006 TC-LOC-007 TC-LOC-008 TC-LOC-010 TC-LOC-011 TC-LOC-015 TC-LOC-023 TC-ONB-029 TC-ORD-007 TC-PRE-008 TC-RBAC-004 TC-SEC-009 |
| 21 | Environment | Rate limit: the site answered 429 'Too many requests' to the test run's own volume | TC-APP-008 TC-AUTH-020 TC-AUTH-054 TC-FIN-018 TC-FIN-031 TC-FLD-007 TC-FLD-123 TC-KPI-002 TC-RBAC-003 TC-RBAC-006 TC-RBAC-012 TC-RBAC-016 TC-RBAC-017 TC-RBAC-018 TC-RBAC-019 TC-RBAC-020 TC-RBAC-021 TC-SEC-004 TC-SEC-005 TC-SPI-027 |
| 16 | Test data (since 29-Oct) | Shop owner account opens another shop (QA Docs, wallet ₹0), so orders of the QA bakery are not listed | SD-01 TC-CART-017 TC-FLD-028 TC-FLD-084 TC-FUL-001 TC-FUL-002 TC-FUL-003 TC-FUL-004 TC-FUL-007 TC-FUL-008 TC-FUL-011 TC-FUL-013 TC-ORD-012 TC-SPI-006 TC-SPI-008 TC-SPI-015 |
| 9 | Test data, cause open | QA products and second shop no longer usable: Cow Milk page 404, Asmy test2 not taking orders / does not deliver | TC-CART-015 TC-DISC-008 TC-DISC-009 TC-FUL-010 TC-FUL-012 TC-ORD-011 TC-PAY-025 TC-RBAC-001 TC-SUB-001 |
| 9 | Test data | Only scheduled delivery is offered at the QA bakery (delivery-windows API, probably no rider online), so Pay stays disabled until a slot is picked; the checks do not pick one | TC-CART-009 TC-CART-012 TC-COD-002 TC-LOC-018 TC-LOC-020 TC-LOC-022 TC-LOC-024 TC-PAY-007 TC-PAY-017 |
| 9 | Test data | Delivery flow needs a rider online and a plan for the order | TC-CART-015 TC-CART-016 TC-CART-017 TC-DEL-001 TC-DEL-010 TC-DEL-012 TC-DEL-020 TC-FLD-029 TC-LOC-022 |
| 4 | Test data | Test accounts changed by onboarding tests: customer (lc14) and admin now own shops | RB-02 TC-MKT-013 TC-RBAC-003 |
| 4 | Test out of date | Excel upload checks still expect the old columns replaced by #372 (Goods Type, Quantity) | TC-OPG-001 TC-OPG-002 TC-OPG-003 TC-OPG-005 |
| 2 | Test too strict | Forged-cookie check wants a 307 header; the page sends the same /signin redirect inside a 200 page, no data shown (same on production) | TC-RBAC-002 TC-SEC-001 |
| 1 | My test set-up | Bakery hours set to all day by me for the re-run (test expects Mon 06:00–22:00) | TC-DISC-013 |

How far this can be trusted:
- Causes are grouped from each failure's message and, for the largest groups, from the page the check saw. The 34 under "Not traced" were not followed up one by one; 24 of those 33 checks had not passed in the 01-Nov or 03-Nov runs either.
- **Checkout, shop order handling and delivery could not be proven end to end on staging tonight**, because the test set-up cannot get that far. They did not show a fault either. Today's two releases (#369, #376) did not change the cart page, the checkout API, the orders service, the shop orders pages or the product pages.
- Blocked (182): mostly checks that wait on an earlier failed step, the missing `shopB` / `rider2` sessions, or a provider staging does not have.
- The forged-cookie check was checked by hand: signed-out `/shop`, `/shop/orders` and `/shop/finance` return the sign-in redirect, on both servers, and a forged cookie on `/shop` got the same on staging.
- Open: the QA "Cow Milk" product page answers 404 though its listing is active and unchanged since 03-Nov. Cause not found.

## gokesari.com: case by case

**Standing rule: this session never signs in on gokesari.com and never uses test data or sandbox payments there.** So only the signed-out part could be tested.

| Case | Result | Notes |
|---|---|---|
| New user / signed-out visitor | **PASS (guest)** | Sign-in step shown, no "Add my shop", no review wording. Creating an account: not run. |
| Old URLs (?form, ?wizard) | **PASS (guest)** | Both redirect to /shop/register; `ref` is kept. |
| Existing customer via Sell | **NOT RUN** | Needs sign-in. |
| Referral link valid / invalid / expired | **NOT RUN** | Needs sign-in. Link capture through the redirect is confirmed. |
| Referral typed valid / invalid | **NOT RUN** | Needs sign-in. |
| Referral toggle on / off | **NOT RUN** | Needs an admin sign-in and changes a live setting. |
| GST success with PAN derived | **NOT RUN** | Needs sign-in and a real GSTIN. |
| GST failure, PAN failure, API down | **NOT RUN** | Needs sign-in. |
| PAN-only success | **NOT RUN** | Needs a real run on live KYC. **Not proven on any live KYC service yet.** |
| Owner name / address returned or missing | **NOT RUN** | Needs live KYC. **"Returned" branches are proven only by integration tests.** |
| Geotagging | **NOT RUN** | Needs sign-in. |
| Payment success / failure | **NOT RUN** | Real registration fee; no test data or sandbox allowed on production. |
| Resume | **NOT RUN** | Needs sign-in. |
| Completion + Add products | **NOT RUN** | Follows a real payment. |
| Regression, existing seller and customer flows | **PARTLY** | Guest tier only: 104 pass, 2 fail, 3 blocked, 3 skipped (see below). Signed-in flows: not run. |

Release: `main` at 76d34de6, service-worker version `2026-11-08T15:39:54.262Z`. Migration 0148 is inferred applied (a failed migration stops the build); it was not read directly.

Guest failures: TC-SEC-001 and TC-RBAC-002. POST `/api/admin/support-services` answers 404 because `paid_support_services_enabled` is off and the route checks the flag before the sign-in. Staging answers 401. Code from 28-Oct, not this release; no data exposed. Blocked 3: host firewall (E-01).

### One real registration, for the owner to run on gokesari.com

1. Sign in with an account that has no shop, tap Sell. Expect only referral code and GST / PAN.
2. Use a real referral link, then verify a real **PAN without GST** (never yet proven on live KYC).
3. Check that the owner name and address come through, or are asked for only when missing.
4. Place the map pin, confirm phone and email.
5. Pay the real fee. Expect the shop to go live at once and the completion text with Add products.
6. Check the "shop is live" e-mail arrives.
7. If it was only a test shop, suspend it afterwards so no test shop stays live.

## Android and iOS apps

The apps are WebViews of the site with the `/shop/register` deep link, location bridge and download handling already in place, so they show this flow without a native change or store build. Tested at phone size in Chromium only; **not tested on a real Android or iPhone device.**

## Defects

| ID | Severity | Status | Defect | Evidence |
|---|---|---|---|---|
| P2-D1 | Minor | Fixed in code 09-Nov-2026, not deployed | Seller Central header badge says "Pending approval" for a registration that has not been paid yet, although the normal flow no longer has an approval step. | p2-04-*.png |
| P2-D2 | Minor | Fixed in code 09-Nov-2026, not deployed | The note "Your last payment did not go through" never appears in the wizard: nothing sets the fee status to FAILED. The shop correctly stays not live, Pay is offered and retry works. The fee page's own note also did not appear within about 4 minutes. | p2-14-*.png; `onboarding-wizard.tsx:446` |
| P2-D3 | Minor | Fixed in code 09-Nov-2026, not deployed (two of the three; see below) | Three refusals arrive only at the last step ("Create my shop and pay"): account with a shop awaiting approval, same shop name at the PIN, inactive PAN. The owner fills every screen first. | Seen in staging runs; no separate screenshot |
| P2-D4 | Low | Fixed in code 09-Nov-2026, not deployed (see below) | Once a referral code is saved it cannot be changed or cleared ("the first one is kept"), yet the field stays editable. | Seen in staging runs; no separate screenshot |

Notes, not defects: later wizard screens are still mostly English; held GST / PAN duplicates still see "Payment received — pending admin approval" (intended, they need a review); `/shop/register` needs a reload after a sandbox payment.

## Defect fixes P2-D1 to P2-D4 (09-Nov-2026, IST)

Fixed on branch `fix/onboarding-p2-defects` (from `main` 76d34de6). **Not committed and not on test.gokesari.com or gokesari.com yet**, so nothing below has been seen on either server.

| ID | What changed | How it was checked |
|---|---|---|
| P2-D1 | A shop that still owes its fee now shows "Payment pending" (English, Hindi, Marathi) in the Seller Central header, on the seller home and on the manage page. "Pending approval" stays only for a paid shop that really is with the team. | Unit test; screen check 1280 and 390 px for the header and seller home (the manage page by type-check only) |
| P2-D2 | The note now reads the latest payment attempt (failed or expired), which is what actually records a failure. Opening the payment step also asks the gateway about an attempt still open, so the note does not wait for the webhook. | Integration tests; screen check 1280 and 390 px |
| P2-D3 | An account with a shop still waiting is told on arrival, with a link to pay, and the referral, GST and PAN steps refuse before any paid check. The same name at the same PIN is refused on the shop step. The check at "Create my shop and pay" stays as the final guard. | Integration tests; screen check 1280 and 390 px |
| P2-D4 | The saved code is now shown read-only with the reason. The rule itself is unchanged: decision DT-13 keeps the first code entered while shop referrals are on. | Integration test; screen check 1280 and 390 px |

**Correction to P2-D3:** the third item, "inactive PAN at the last step", was a mistake in this report. An inactive PAN is refused on the first screen on both the GST and the PAN route (integration test "an inactive PAN → FAILED; the owner cannot go on", staging case ON-09). No change was needed.

**Results, 09-Nov-2026:** whole automated test suite 19.06–19.44 IST: 3,413 tests in 273 files, all pass. Type-check and lint clean. Screen check on a local server with a throwaway database: 20 of 20 pass. Evidence: `p2-defects-local-2026-11-09/`.

**Still to do:** see these on test.gokesari.com after the release goes through the staging queue, then on gokesari.com.

## Test data left on staging

- Shops: BKS-000047 "QA Phase2 Live 94542" (admin), BKS-000048 "QA Phase2 Phone 41132" (customer), BKS-000049 "QA Phase2 Retry 42462" (ops). Open drafts on the shop and rider accounts.
- BKS-000046 "QA Licence Pharmacy PR374" (suspended) belongs to another session's test.
- Referral code E2ETEST1 counted one more shop. QA bakery hours are back to 06:00–22:00 (restored 02.21 IST).

## Open questions for the owner

- Should tax consultants (who share PROFESSIONAL_OFFICE) see the registration message?
- Which other shop types need a licence (firecracker shops, Consultants)?
