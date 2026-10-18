# Owner inputs needed — build & integrate batch (18 Oct 2026)

Everything in the batch is built, tested on the sandbox/mock providers and
deployed with its **production switch OFF**. Each row below is what only the
owner can provide, **where to put it**, and **which switch to turn on after**.

- *Hostinger env* = hPanel → the site (gokesari.com, and test.gokesari.com
  where noted) → Environment variables, then redeploy.
- *GitHub secret* = repository Settings → Environments → **production** (or
  Secrets and variables → Actions).
- *Admin setting* = gokesari.com → Admin → Business rules (Settings) → the rule
  named; every change is audited and live within 15 seconds.

## 1. Payment gateway and keys (F1.7.3 / F1.8.4 / F6.2.3)

| What | Where | Then switch on |
|---|---|---|
| Choose the gateway (Cashfree is already integrated for wallet top-ups; Razorpay / PhonePe are scaffolds) and open its merchant account for **per-order payments** | — | — |
| `PAYMENT_GATEWAY` = `CASHFREE` (or `RAZORPAY` / `PHONEPE`) | Hostinger env (gokesari.com) | — |
| Live keys: Cashfree reuses `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=production`; Razorpay `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; PhonePe `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, `PHONEPE_SALT_INDEX`, `PHONEPE_ENV` | Hostinger env | — |
| `PAYMENT_PUBLIC_BASE_URL` = `https://gokesari.com` | Hostinger env | — |
| Cron `payments-reconcile` every 5 min, `auth-housekeeping` hourly (§9) | Hostinger cron | — |
| A test payment of ₹1 with a real card, then refund it | gokesari.com | **Admin setting `onlinePayments.enabled` = true** (the original-method refund comes with it; `refundChoice.originalMethodEnabled` is optional) |

## 2. Webhook secrets (payments and payouts)

| What | Where | Then |
|---|---|---|
| Register `https://gokesari.com/api/webhooks/payments/<gateway>` (`cashfree` / `razorpay` / `phonepe`) in the gateway dashboard | Gateway dashboard | — |
| Its signing secret: `PAYMENT_WEBHOOK_SECRET_CASHFREE` (defaults to `CASHFREE_SECRET_KEY`), `PAYMENT_WEBHOOK_SECRET_RAZORPAY`, or PhonePe's salt key | Hostinger env | — |
| Payout webhooks: register `https://gokesari.com/api/webhooks/payouts/<razorpayx|cashfree>`; secret `RAZORPAYX_WEBHOOK_SECRET` (Cashfree Payouts signs with its client secret) | Payout dashboard + Hostinger env | see §3 |

## 3. Payout account and keys (F10.2.4)

| What | Where | Then switch on |
|---|---|---|
| GoKesari's **debit (current) account number** | Admin setting `payouts.debitAccountNumber` | — |
| Your bank's **bulk-upload file template** (the generic NEFT/RTGS CSV is a placeholder) | Send the template; a developer maps the columns | — |
| Cron `payout-cycle` daily (§9) | Hostinger cron | **`payouts.enabled` = true with `provider` = `BANK_FILE`** (download file → upload to the bank → "Mark paid" with each UTR in Admin → Payouts) |
| For automatic transfers: RazorpayX `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET` **or** Cashfree Payouts `CASHFREE_PAYOUT_CLIENT_ID`, `CASHFREE_PAYOUT_CLIENT_SECRET`, `CASHFREE_PAYOUT_ENV=production` | Hostinger env | `payouts.provider` = `RAZORPAYX` / `CASHFREE`; run **one** test payout first (request formats are coded from public docs, unverified) |
| Confirm the cycle (default every **5 days** from `payouts.anchorDate`), hold days, minimum payout, maker-checker (on) | Admin setting `payouts` | — |

## 4. GoKesari GSTIN and legal details (F10.2.5)

| What | Where | Then switch on |
|---|---|---|
| Legal name, trade name, **GSTIN**, PAN, registered address, two-letter state code, billing e-mail | Admin setting `platformTaxProfile` | **`platformInvoicing.enabled` = true** (GoKesari's own fee invoices to shops, one per payout cycle) |

## 5. Invoice prefix (F10.2.5)

| What | Where | Then |
|---|---|---|
| Series prefixes (1–4 capitals/digits; numbers read `GKP/2627/000001`, ≤ 16 characters, unique per FY): invoice `GKP`, credit note `GKC`, debit note `GKD` — confirm or change **before the first invoice** | Admin setting `platformTaxProfile` (`invoicePrefix`, `creditNotePrefix`, `debitNotePrefix`) | — |
| Customer invoices per shop already number per shop per FY; to also e-mail them (PDF) to customers and copy shop owners | — | **`invoiceDelivery.enabled` = true** (SMTP is already configured) |

## 6. CA confirmation of TCS / TDS / SAC rates

| What | Where | Then |
|---|---|---|
| Confirm each row (all marked **"not confirmed by CA"**): GST TCS s.52 0.5% (Notif. 15/2024-CT), TDS old s.194-O 0.1% / 5% without PAN / ₹5 lakh individual-HUF exemption (now s.393 ITA 2025), GST 18% on GoKesari's fees, s.9(5) restaurant 5% (disabled) and local delivery 18% (disabled), unregistered-seller rules | Admin → **Statutory** (`/admin/statutory`): edit or add a dated row, tick "confirmed by CA" | payout maths uses the confirmed rows automatically |
| SAC codes per fee type (defaults: 998599 commission/platform/registration, 996813 delivery, 998319 billing management) | Admin setting `platformTaxProfile.sacCodes` | — |
| GST on the after-packing cancellation fee (not computed today) | Advise; a developer adds it | — |

## 7. Grievance Officer details (F6.3.3)

| What | Where | Then |
|---|---|---|
| Name, designation, e-mail, phone, address, hours (today's values are pre-filled from the legal page) | Admin setting `grievanceOfficer` | shown at once on the site and in the app |
| Counsel to confirm the Consumer Protection (E-Commerce) Rules, 2020 Rule 4 timelines (48 h acknowledge, one month resolve) — `docs/helpdesk-2026-10.md` | Admin setting `helpdesk` (to tighten, e.g. 24 h / 15 days) | — |
| Cron `aftercare` hourly (§9) | Hostinger cron | help desk is on by default |
| Review the after-packing fee defaults (₹20 flat; limits ₹100 / 20%) and update the refund policy text | Admin setting `afterPackingCancellation` | **`afterPackingCancellation.enabled` = true** |

## 8. GS1 India agreement (F9.1.2)

| What | Where | Then switch on |
|---|---|---|
| Sign a **GS1 India Solution Provider** agreement or subscribe to **DataKart Premium** (no public price list — ask GS1 India for a quote; see `docs/product-data-sources.md`) | — | — |
| `GS1_DATAKART_BASE_URL`, `GS1_DATAKART_API_KEY` | Hostinger env | a developer maps the client to GS1's API spec, then **`pmdSources.gs1Enabled` = true** |
| Accept the Open Food Facts ODbL terms (attribution shown on imported records) | — | **`pmdSources.openFoodFactsEnabled` = true** |
| Optional S3-compatible storage for imported images: `OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | Hostinger env | `objectStore.s3Enabled` = true (try on test first) |
| Crons `pmd-ingest` every minute, `operator-onboarding` every 5 min (§9) | Hostinger cron | — |

## 9. Cron jobs

Add the lines in **`docs/batch-2026-10/crontab.txt`** to the Hostinger crontab on
test.gokesari.com, then gokesari.com (9 jobs; each does nothing while its
feature is off).

## 10. Signing fingerprint and Apple Team ID (F15.2.3 deep links)

| What | Where | Then |
|---|---|---|
| Android **SHA-256 signing fingerprint** of the first store build (Play Console → App integrity → App signing key certificate, or `eas credentials`) | Hostinger env `MOBILE_ANDROID_CERT_SHA256` on gokesari.com (production app) and test.gokesari.com (preview app) | links verify automatically; until then `/.well-known/assetlinks.json` serves a placeholder |
| **Apple Team ID** | Hostinger env `MOBILE_IOS_APP_IDS` = `<TEAMID>.com.gokesari.app` (test: `.preview`); GitHub secret `APPLE_TEAM_ID` | `/.well-known/apple-app-site-association` serves it |
| Full steps and how to verify: **`docs/deep-links-activation.md`** | | |

## 11. Mobile push (F13.1.2)

| What | Where | Then switch on |
|---|---|---|
| Expo account: an access token as GitHub secret **`EXPO_TOKEN`**, and the Expo project id in `mobile/app.config.ts` (`npx eas-cli init` in `mobile/` once) — the "iPhone app" workflow stops without both (trial run 39146871432, 18 Oct) | GitHub secret + one commit | — |
| Apple Developer account: App Store Connect API key as secrets `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `APPLE_TEAM_ID` | GitHub secrets | iOS internal builds from the "iPhone app" workflow |
| EAS project linked (`EAS_PROJECT_ID`), FCM V1 key and APNs key uploaded to Expo; `google-services.json` as EAS file variable `GOOGLE_SERVICES_JSON` | Expo / EAS | — |
| `EXPO_ACCESS_TOKEN` only if Expo "enhanced push security" is on | Hostinger env | — |
| Build app **1.2.0** (Google Play / App Store publishing stays on hold) | "Android app" / "iPhone app" workflows | **`push.enabled` = true, `push.provider` = `expo`** |
| Cron `push-receipts` every 15 min, `broadcast-dispatch` every minute (§9) | Hostinger cron | — |

## 12. Other switches (no input needed — owner's choice)

| Feature | Switch | Notes |
|---|---|---|
| Broadcast rider offers 2 → 4 → 6 km (F3.3.2) | `dispatchBroadcast.enabled` | needs the existing `timeout-sweep` cron |
| Pickup by signed QR (F4.1.3) | `pickupQr.enabled` | first set Hostinger env **`PICKUP_QR_SECRET`** (≥ 16 random characters) on gokesari.com |
| In-app rider navigation (F4.2.2) | `riderNavigation.enabled` + `provider` | `google` needs the Routes API on `GOOGLE_MAPS_SERVER_API_KEY`; `osrm` needs your own OSRM server URL |
| Inventory sync (#92/#120) | `inventorySync.enabled` | descoped — leave OFF |

## 13. Production database (F14.2.1 / F14.2.4)

| What | Where |
|---|---|
| Make sure `PROD_DATABASE_HOST` and `PROD_DATABASE_NAME` exist as **variables** on the **production** environment (the 15 Oct run saw them empty) | GitHub → Settings → Environments → production → Variables |
| Go-ahead and a window for the seller/customer split cut-over (`DB_SPLIT_MODE`), plus enabling logical replication on the Neon project | `docs/db-split-2026-10/CUTOVER_2026-10-18.md` |

## 14. Production order-lifecycle test (F14.1.3 production subset)

| What | Where | Then |
|---|---|---|
| A production shop with delivery on that may receive test orders, and its owner's sign-in email | Tell the developer | — |
| An approved production rider (or permission to register one for approval) | Tell the developer | — |
| Whether the test order is COD (no money moves) or a real payment the owner makes (as chosen on 14 Oct — Cashfree live keys confirmed set) | Decision | the full production lifecycle is run and added to `docs/test-reports/2026-10-batch.md` |
