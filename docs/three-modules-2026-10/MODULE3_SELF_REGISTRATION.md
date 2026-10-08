# Module 3 — shop self-registration with auto-approval

A shop registers itself at **/shop/join** with its name, a mobile number
verified by SMS code, a distributor's referral code and an online fee
payment. When Cashfree's server webhook confirms the payment, with a verified
signature and the exact fee, the shop is approved and live at once. Nobody
has to review it. The owner then signs in with the mobile number and
completes the profile.

Test site only for now (test.gokesari.com). The `selfRegistration` rule
ships **off**, so production behaves as before until it is switched on.

## What the applicant does (mobile-first)

1. **/shop/join**: shop name, mobile, referral code. The code is checked
   first. If it is unknown, inactive, expired or used up, the applicant gets
   a clear message and no SMS is sent; no registration or payment is
   possible.
2. A 6-digit **SMS code** is sent (the existing `otp` rule sets length,
   expiry, cooldown and resends). The applicant enters it and picks one of
   the **fee plans** on offer (Basic, Silver, Gold, Platinum, Industry; only
   active plans with an amount are shown), then accepts the Seller Terms.
3. The registration is saved as **PENDING_PAYMENT**. The plan's fee is
   copied onto it, and it holds a place on the code's usage limit for
   `holdHours` (24 h). A private link `/shop/join/{token}` is shown and also
   sent by SMS; only a hash of the token is stored.
4. **Pay**: a Cashfree order (`reg_…`) is created for exactly the copied fee
   and the Cashfree checkout opens. Returning to the page only shows the
   status; it never approves.
5. The **webhook** approves (next section). The page then shows *Approved*,
   the shop number, a **receipt** (PDF) and *Sign in and complete profile*.

## What happens on payment: one transaction

`POST /api/webhooks/cashfree` (the existing route) sends `reg_…` orders to
`processRegistrationPaymentEvent`:

1. **Signature**: the existing HMAC check (timestamp + raw body, SHA-256,
   base64, with `CASHFREE_SECRET_KEY`). A bad signature gets 400 before
   anything is read.
2. **Amount**: currency INR, and the order amount, the paid amount and our
   order row must all equal the registration's fee. If not, the payment is
   marked **MISMATCH**, support is notified, and the shop is not approved.
3. **Approval in one transaction:**
   1. The registration row is locked. If it is no longer pending, see
      "Paid twice or after cancellation" below.
   2. The payment is marked SUCCESS.
   3. The owner's account is the account that already has this mobile. If
      there is none, a new account is created with the mobile verified, no
      email yet (an internal placeholder `m<digits>@no-email.gokesari.invalid`
      that is never mailed) and a customer wallet. The SHOP_OWNER role is
      granted.
   4. The shop is inserted **APPROVED / ACTIVE**, with:
      - classification from the rule (Green);
      - fee PAID;
      - `onboarding_channel = SELF_SERVICE`;
      - the next shop number;
      - type "General Trading Store" until the owner picks one.
   5. A **receipt** `PAY-YYYY-NNNNNN` is written to `shop_payments` (method
      CASHFREE, transaction = the Cashfree payment id).
   6. The existing **referral redemption** is recorded.
   7. The **shop wallet** is created through `getOrCreateShopWallet()`.
   8. The **distributor commission** is recorded as ACCRUED. It uses the
      distributor's own rate, or the default of the distributor's type: a
      flat amount or a % of the fee.
   9. The registration is marked APPROVED. An audit row
      `SHOP_SELF_REGISTERED` is written and `emitEvent('shop.self_registered')`
      fires.
4. **Right after commit**, the event outbox sends:
   - to the owner: an in-app notice, **SMS** and **WhatsApp** with the shop
     number, the receipt number and the sign-in link, plus email when the
     account has a real address;
   - to support: an in-app note.

   The Seller Terms consent is recorded for a new account.

**Idempotent.** Replays and concurrent deliveries of the same webhook approve
once. Each of these stops a second approval on its own:
- the registration row lock and status check;
- the unique gateway order id and payment id;
- the conditional payment update (only from CREATED/FAILED);
- one shop per registration (unique);
- one commission per registration (unique);
- one redemption per shop (unique);
- the event idempotency key.

A replay answers `ALREADY_APPROVED` and changes nothing.

### Failed, dropped or wrong payments

| Case | Result |
|---|---|
| Payment FAILED / USER_DROPPED | Payment row FAILED, registration stays **PENDING_PAYMENT**, the applicant gets an SMS saying to retry with the link. *Pay* again makes a new order |
| Browser returns, no webhook yet | Page shows "waiting for confirmation" and polls; nothing is approved |
| Amount or currency is not the fee | MISMATCH, not approved, support notified (Admin → Shop registrations) |
| Paid after the hold lapsed | Approved when it arrives, as long as the code still has room. If another shop took the last place, **Pay** is refused before any money moves |
| Paid twice, or after support cancelled the registration | Recorded as SUCCESS with "refund due", support notified, no second shop |

## After approval: sign-in and profile

- **Sign-in**: /signin → mobile number → the code goes by **SMS** when the
  account has no email (the placeholder), otherwise by email as today. The
  sign-in form also shows when email is off but SMS is available.
- **/shop/profile-setup** ("Complete your profile"):
  - Fields: owner name, address, city, state, PIN code, shop type and an
    optional GSTIN.
  - The GSTIN is checked through the GSP (Module 2):
    - an invalid, unknown or cancelled GSTIN is refused;
    - the legal name and status are shown;
    - a state that differs from the address is warned;
    - it is then saved through the existing GST flow, where operations
      confirm it.
  - Next steps link to the existing pages: product categories (each adds its
    products with stock 100 and an empty price), the map location,
    PAN/documents and the shop wallet.
  - A shop that sells food is **reminded** to add its FSSAI licence. Ordering
    is not blocked (P5 default: remind only).
  - The profile counts as complete with owner name, address, PIN code and at
    least one category. `profile_completed_at` is set and audited.

## Admin

| Page | Who | What |
|---|---|---|
| **/admin/self-registration** | Admin for fee plans; operators for the rest | Fee plans (amount, active, order). Distributor types (default commission: flat ₹ or %). Distributors (type, contact, district; own commission overrides the type's). Referral codes with distributor, usage limit, expiry and uses so far |
| **/admin/shops/auto-approved** | Operators | Self-registered shops. Filters: code, distributor, date, profile complete yes/no, search. Columns: fee, commission. **Suspend** in one click with a prefilled reason, through the existing suspend flow (`SHOP_SUSPEND`) |
| **/admin/shop-registrations** | Operators | Pending / approved / cancelled registrations. **Resend link** (new token by SMS). **Cancel** an unpaid one. Payment problems: mismatches and refunds due |
| **/admin/referral-commissions** | Operators view; admin changes status | Totals per distributor and per shop. Status moves forward only: ACCRUED → APPROVED → PAID, or REVERSED before payment. Recorded only; nothing is paid out by the system |
| **/admin/test-messages** | Operators | SMS/WhatsApp from the mock provider (test site), so testers can read codes |

Permissions are the existing ones:
- `SHOP_REGISTRATION_MANAGE`, `REFERRAL_MANAGE` and `SHOP_SUSPEND` (operator
  and admin);
- `REGISTRATION_FEE_MANAGE` (admin: fee plans and commission status).

## Security

- **Approval comes only from the server webhook**, after the signature
  check, with an exact amount and currency match. The browser, the return
  URL and the status page never approve.
- The referral code is re-checked **under a row lock** when the registration
  is saved, so the last place on a code goes to exactly one applicant
  (tested with five at once).
- The private token is 32 random bytes and only its SHA-256 is stored.
  Resending a link replaces it. The status page masks the mobile.
- Rate limits: per client on every public route, plus per mobile and per IP
  on the SMS code. There are at most `maxPendingPerMobile` unpaid
  registrations per mobile.
- The mock SMS/WhatsApp provider is refused on gokesari.com: there it counts
  as "not set up", so it writes nothing and sends no codes. The mock
  settle route answers 404 in a production build or when gateway keys are
  set.

## API

See [API.md → Shop self-registration (Module 3)](../../API.md#shop-self-registration-module-3).

## Database: migration `0064_shop_self_registration` (additive)

| Table / change | Purpose |
|---|---|
| `registration_fee_tiers` | The five plans, seeded **inactive** with no amount. An active plan must have an amount (check constraint) |
| `distributor_types` · `distributors` | Commission default per type; a per-distributor override (both null = the type's default). FLAT in paise, PERCENT in basis points |
| `referral_codes` + `distributor_id`, `max_uses` (> 0, null = unlimited) | Links a code to a distributor; usage limit |
| `shop_registrations` | One applicant: token hash, status, shop name, verified mobile, code, distributor, plan, **fee copy**, hold, owner, shop (unique), approved/cancelled timestamps |
| `registration_payments` | Gateway orders for the fee: unique order id, unique payment id, amount, status (CREATED/FAILED/SUCCESS/MISMATCH), webhook payload. Separate from wallet `payments`, so wallet code is untouched |
| `referral_commissions` | One per registration (unique): base, type, value, amount, status |
| `outbound_test_messages` | Messages written by the mock SMS/WhatsApp provider |
| `shops` + `onboarding_channel`, `shop_registration_id`, `registration_tier_id`, `auto_approved_at`, `profile_completed_at` | |
| `users` + `email_placeholder` | |
| `shop_payment_method` + `CASHFREE`; `login_otps.purpose` + `SHOP_REGISTRATION` | |

Rollback: `scripts/rollback-0064.sql`. It refuses while any registration
payment succeeded, because those are money records. Shops created by
self-registration stay, as ordinary approved shops.

## Configuration

| Setting | Where | Test | Production |
|---|---|---|---|
| `selfRegistration` rule | Admin → Business rules | `enabled: true` (test-settings.sql) | off until decided |
| Fee plan amounts | Admin → Self-registration | Test amounts ₹999 / ₹1,999 / ₹2,999 / ₹4,999 / ₹9,999 (test-settings.sql) | Owner's amounts (P4) |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER` | Environment | `mock` | a real provider (P2); `mock` is refused |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` | Environment | Sandbox keys, `sandbox` | Live keys, `production` |
| `AUTH_URL` | Environment | `https://test.gokesari.com` | `https://gokesari.com` (used for the private link and `notify_url`) |

`docs/three-modules-2026-10/test-settings.sql` holds the test values. The
"Test database" workflow applies it when the file changes on `staging`, or
by hand with the *three-modules-settings* action. It also switches
`invoicing` on for Module 2.

Without an SMS provider (`none`) self-registration cannot send codes, so
/shop/join says registration by mobile is unavailable. Nothing else changes.

## Tests

`tests/integration/shop-self-registration.test.ts` (13 tests, real
PostgreSQL):

- **Invalid referral**: unknown, inactive, expired and used-up codes are
  blocked before any SMS or registration. Five applicants race for a code's
  last place and exactly one wins. A wrong OTP or a plan that is not offered
  is refused.
- **Approval**: one transaction gives a live shop, the owner account, the
  receipt, the redemption, the wallet and the commission. Owner messages go
  by SMS and WhatsApp, with no email to the placeholder. The receipt PDF is
  checked, and so is the distributor's own rate over the type's.
- **Duplicate webhook**: the same event three times concurrently and again
  later gives one shop, one receipt, one redemption and one event.
- **Wrong payments**: an amount mismatch and a forged signature never
  approve. A payment after cancellation, or a second payment after
  approval, is marked refund due and support is told.
- **Failed payment**: the registration stays PENDING_PAYMENT, the retry SMS
  is sent, and a later payment approves. An expired hold frees the place,
  and paying later needs room on the code.
- **Accounts**: an existing account with the mobile is reused, and a
  mobile-only owner signs in with an SMS code.
- **Profile**: the GSTIN is checked through the GSP (format, cancelled,
  state mismatch), a food shop gets the FSSAI reminder, the profile
  completes with a category, and a stranger is refused.
- **Admin rules**: an offered plan needs an amount, commission moves forward
  only, and the switch closes registration.

`tests/integration/migrate-on-build.test.ts` covers 0056 → 0064 and the
rollback.

Checked by hand in a phone-sized browser (mock payment and SMS):
- join → SMS code → plan → pay → approved → receipt;
- sign in by SMS code → profile saved;
- no console errors.

## Deployment: test.gokesari.com

1. hPanel → the test app → Environment variables:
   - `SMS_PROVIDER=mock`, `WHATSAPP_PROVIDER=mock`;
   - check `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` (**sandbox**) and
     `CASHFREE_ENV=sandbox` are set;
   - check `AUTH_URL=https://test.gokesari.com`.
2. Cashfree sandbox dashboard → Webhooks: check
   `https://test.gokesari.com/api/webhooks/cashfree` is registered, as for
   wallet top-ups. Registration orders also carry it as `notify_url`.
3. Merge into `staging`. The "Test database" workflow backs up, applies
   **0064**, then applies `test-settings.sql` (self-registration on, test fee
   amounts, invoicing on). Check the run is green and its summary shows the
   five plans active.
4. Admin → **Self-registration**:
   - add a distributor type (e.g. "District distributor", 10 %);
   - add a distributor;
   - create a referral code for it with a usage limit (e.g. 5).
5. Smoke test on a phone:
   - /shop/join with a wrong code → blocked, no SMS in
     /admin/test-messages.
   - The right code → the SMS code appears in /admin/test-messages → enter
     it → pick Basic → Pay → Cashfree sandbox **failure** card → page says
     not paid, retry SMS in test messages.
   - Pay again with the **success** card → within seconds *Approved*, shop
     number, receipt downloads.
   - /admin/shops/auto-approved lists it with fee and commission;
     /admin/referral-commissions shows ACCRUED.
   - Cashfree dashboard → resend the same webhook → still one shop.
   - Sign out → /signin → the mobile → code in test messages → signed in
     as owner → **Complete your profile** → a GSTIN (mock GSP) → save → add a
     category → profile complete.
   - Admin → Suspend from the auto-approved list → the shop is suspended.
   - Use the code until its limit → the next applicant is blocked.
6. Admin → Business rules → `selfRegistration.enabled = false` → /shop/join
   says registration is closed.

## Deployment: production (gokesari.com), later

Do not start before all of these:
- the test smoke test passes;
- an **SMS provider** with a DLT sender and templates is integrated (P2).
  The mock is refused in production and without SMS the flow cannot send
  codes;
- the fee amounts are decided (P4);
- the CA questions on the fee receipt and the commission are answered (P7:
  GST on the fee, tax invoice vs receipt, TDS 194H).

Then:

1. Back up the database. Apply **0064** before the code (additive; the
   current build runs on a migrated database).
2. Deploy. Set the real `SMS_PROVIDER` / `WHATSAPP_PROVIDER` and check
   Cashfree is **production**, with the webhook registered for
   `https://gokesari.com/api/webhooks/cashfree`.
3. Admin → Self-registration: real fee amounts, distributor types,
   distributors and codes with limits.
4. Switch `selfRegistration.enabled` on. Do one real registration with a
   small test plan, then refund it from the Cashfree dashboard and suspend
   the shop.
5. Rollback: switch the rule off (stops new registrations at once). If
   needed, deploy the previous build, then `scripts/rollback-0064.sql`. It
   refuses once real payments exist; keep the tables then.

## Open questions and pending actions

See PLAN.md "Pending actions" and §9:
- **P2**: SMS and WhatsApp providers. Until then: mock on test.
- **P4**: fee amounts. Until then: test amounts.
- **P5**: FSSAI. Until then: remind only.
- **P7**: CA questions.

For the CA: whether the registration fee is GST-inclusive, the SAC, and
whether the receipt must be a tax invoice; GST and TDS (194H) on distributor
commission; unregistered sellers going live without a GSTIN. None of these
are implemented on assumptions.

## Assumptions

- A mobile that already has an account becomes the new shop's owner. One
  mobile may own several shops, each paying its own fee.
- A new shop is live (APPROVED / ACTIVE) right after payment, before its
  address is in. It is found by name, and shows in area and nearby results
  once the address and location are saved.
- An unpaid registration holds a place on the code for 24 h (rule). After
  that the place is free, and paying needs room on the code again.
- The receipt is the existing shop-payment receipt (`PAY-…`) as a PDF, not
  a tax invoice (pending the CA).
- Commission is recorded, never paid by the system. Its status is tracked
  by an admin.
- A self-registered shop gets the rule's classification (Green). Operators
  can change it as for any shop.

## Changes from the plan

- One plan per registration chosen by the applicant (owner decision: five
  tiers), not one tier per code.
- Payment problems that need a refund (paid twice, paid after cancellation)
  are recorded and shown to support. Refunds are made from the Cashfree
  dashboard.
- Events: `shop.self_registered` and `registration.payment_mismatch` (amount
  mismatch or refund due, to support). A failed payment sends the retry SMS
  directly instead of through a `payment_failed` event: only the applicant
  needs to know.
- The mock SMS/WhatsApp outbox is a table (`outbound_test_messages`) read at
  /admin/test-messages, rather than reusing the notification log.
