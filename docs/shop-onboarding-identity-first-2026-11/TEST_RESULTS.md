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

Until the flag is on, gokesari.com keeps serving the old one-page form (DI-10).
