# Cashfree — what only the owner can do (7 Nov 2026)

These need the Cashfree dashboard, the Hostinger environment, a real card / UPI account or the
app stores — none of which this build environment can reach. Times in IST.

## 1. Cashfree dashboard — webhooks (both sites)

Payment Gateway → Developers → Webhooks → Add webhook, events **Payment** and **Refund**,
version **2023-08-01**:

| Site | URLs to add |
|---|---|
| test.gokesari.com (Sandbox dashboard) | `https://test.gokesari.com/api/webhooks/cashfree` and `https://test.gokesari.com/api/webhooks/payments/cashfree` |
| gokesari.com (Production dashboard) | `https://gokesari.com/api/webhooks/cashfree` and `https://gokesari.com/api/webhooks/payments/cashfree` |

Evidence this is missing on staging: on 7 Nov 2026 at 19:35 IST five sandbox top-ups were paid
and none was credited by a webhook within two minutes (TEST_RESULTS §2). After this release the
top-up orders also send their own `notify_url`, so a dashboard webhook is a second safety net,
and the 5-minute `payments-reconcile` job a third.

## 2. Production: ask Cashfree what is switched on

On gokesari.com, signed in as admin: **Admin → Finance → Cashfree set-up & tests**
(`/admin/payments/cashfree`) → **Ask Cashfree (keys + payment methods)**.

- "Needs attention" must be empty (no sandbox keys, `CASHFREE_ENV=production`, https URLs).
- Keys: **accepted**.
- Payment methods: confirm `card`, `upi`, `netbanking` and `app` (wallets: Paytm, PhonePe,
  Amazon Pay …) show **on**. Anything you want but see **off** → Cashfree dashboard →
  Settings → Payment methods → request activation.

## 3. Production whitelisting

Payment Gateway → Developers → Whitelisting:

- **Domain:** `gokesari.com` and `www.gokesari.com` (production checkout refuses other domains).
- **App:** `com.gokesari.app` (Android and iOS) — needed for the 1.8.0 app's Cashfree SDK.
- Payouts (only when `payouts.provider = CASHFREE`): Payouts → Developers → Two-Factor
  Authentication → whitelist the server's outbound IP (the admin bank-check card shows it);
  Payouts webhook V2 → `https://gokesari.com/api/webhooks/payouts/cashfree`.

## 4. Live ₹1 tests on gokesari.com (one per mode, refunded at once)

Only after this release is on gokesari.com and §2 is clean. On `/admin/payments/cashfree`:

1. **Start ₹1 test** → Cashfree's checkout opens → pay with **a credit card** → the page shows
   the order id, `cf_payment_id`, the method and the refund (`cf_refund_id`, STANDARD).
2. Repeat with **a debit card**, **a UPI app / UPI ID** and **a wallet** (e.g. PhonePe / Paytm /
   Amazon Pay — whichever §2 shows on).
3. Optional: **₹2 test, partial refund** — ₹1 comes back, then "Check & refund" returns the other ₹1.
4. Every test is listed on the page with IST times; copy the rows into
   [TEST_RESULTS.md](TEST_RESULTS.md) §4 (or send them and they will be added).

Rules: your own card / UPI / wallet only; never Cashfree's test cards on gokesari.com. Refunds
are STANDARD (back to the card / UPI / wallet in Cashfree's normal time, usually 5–7 working
days for cards, sooner for UPI). Any live **payout** test: ₹1 only, to Sanjay's own account,
and only once `payouts.provider` is switched to CASHFREE.

## 5. Decisions needed

| Item | Today | Options |
|---|---|---|
| ₹1 bank check by **credit card** | Counts as verified (`PAYMENT_ONLY`) — proves a card, not the bank account that will receive payouts | (a) keep; (b) allow only UPI / debit card / net banking for the ₹1 (`payment_methods: upi,dc,nb`); (c) switch on Secure ID bank verification (rule `bankAccountCheck`, keys `CASHFREE_VERIFICATION_*`) — a real bank-name match, no ₹1 |
| Instant refunds | STANDARD (Cashfree default) | Ask Cashfree to enable INSTANT, then set `CASHFREE_REFUND_SPEED=INSTANT` in Hostinger (costs a fee per refund) |
| Order checkout by Cashfree | test.gokesari.com: `PAYMENT_GATEWAY=CASHFREE` from 21:51 IST, 7 Nov; tested end to end (TEST_RESULTS §7, §8). gokesari.com: `SANDBOX` / rule off. F17 **released 8 Nov, 05:13 IST** | On gokesari.com after §1–§4 (F17, the fix without which every Cashfree order checkout failed, is now live). Set the variable through hPanel → Deployments → Redeploy → **"Settings and redeploy"**: a plain Node.js restart does not apply it. Then switch on rule `onlinePayments` and pay one ₹1 order yourself |
| Order checkout: a failed first attempt ends the attempt (D-A09) | A retry inside the same Cashfree page becomes "late capture" (support alerted) | keep, or let a failed attempt stay open until the Cashfree order expires |
| Cashfree PG API version | 2023-08-01 | Plan the move to 2025-01-01 / 2026-01-01 as its own change |

## 6. Mobile apps 1.8.0

- Android: the "Mobile APK" workflow builds `GoKesari-preview` / `GoKesari-production` APKs on
  every push to `mobile/` (debug-signed, for testing with the **test app against the sandbox**).
  Store build: `eas build --profile production --platform android` → Play Console (internal
  testing first — Cashfree's production SDK refuses sideloaded APKs).
- iOS: Actions → "Mobile iOS" (`profile: production`, `submit: true`) → TestFlight.
- After the store builds are live, raise the website's "newest app version" so 1.7.0 users are
  offered the update (docs/app-install-2026-10).
