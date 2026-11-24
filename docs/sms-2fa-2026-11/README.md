# SMS one-time codes: sign-in second factor and checkout code

24-Nov-2026. Branch `feat/sms-2fa-checkout-otp-2026-11-24`. Migration
`drizzle/0188_sms_two_factor.sql` (rollback `scripts/rollback-0188.sql`).
Everything ships **off**.

## What it does

### 3a — SMS code at sign-in (customers, shop owners)

With the switch for the account's audience on, signing in takes two codes:

1. the emailed code, as today (or Google, or the emailed link) — this no longer
   opens the session;
2. a code sent **by SMS** to the account's verified mobile. An account without
   a verified mobile types its 10-digit number (normalised to `+91…`), gets the
   code there and, once it is right, the number is saved with
   `phoneVerifiedAt`. Existing users do this at their next sign-in.

Only then is the login ticket handed to Auth.js and the session opened.

| Switch (feature flag, seeded off) | Audience (`users.role`) |
|---|---|
| `sms_otp_signin_customers_enabled` | CUSTOMER |
| `sms_otp_signin_shop_owners_enabled` | SHOP_OWNER |

Every other role (ADMIN, DELIVERY_PARTNER, DEALER, OPERATOR, staff roles) is
never asked. Accounts registered with a mobile number only (placeholder email)
already get their sign-in code by SMS and are not asked twice.

**Never a lock-out:** the SMS step is asked only while SMS codes can actually
be sent — `SMS_PROVIDER` is `mock` (test site) or `msg91` with all its keys,
**and** rule `otp.smsEnabled` is on. Otherwise sign-in is email-only whatever
the switches say, and Admin → Sign-in security shows "On — not in force".
Switching an audience off takes effect at the next sign-in (flag cache ≤ 15 s);
verified mobiles stay verified.

### 3b — checkout code (rule `checkoutOtp`)

```
checkoutOtp: { enabled: false, mode: "every_checkout" | "once_per_hours", hours: 12 }
```

When on (and SMS codes can be sent), `POST /api/checkout` refuses an order with
`403 FORBIDDEN { details: { stepUp: "CHECKOUT_OTP", needsPhone, maskedPhone, mode } }`
unless a verified `CHECKOUT` code covers it:

- `every_checkout` (default): a code verified in the last 10 minutes, used for
  one order. Placing the order spends it (`login_otps.step_up_request_id` = the
  checkout request id, so a retry of the same request is not asked again); a
  checkout that then fails gives it back.
- `once_per_hours`: any code verified in the last `hours` hours covers every order.

The cart page shows the step (send code, enter code, resend timer) and places
the order again once the code is right. APIs: `GET/POST /api/checkout/otp`,
`POST /api/checkout/otp/verify`. An account without a verified mobile gives its
number in the same step. Rule on but no SMS here → orders go through as before.

## Admin → Settings → Sign-in security (`/admin/sign-in-security`, ADMIN only)

- **SMS sign-in code** — the two switches with their state, last change (who,
  when in IST, reason). A reason is required; changes go through
  `setFeatureFlag` (logged in `feature_flag_changes` and the audit log) and,
  with `rbac_v2_four_eye_admin` on, wait for a second admin (Admin → Approvals).
  The SMS provider line shows none / mock / MSG91 configured and why codes
  cannot be sent — never a key.
- **Checkout code** — rule `checkoutOtp` (on/off, mode, hours), saved with
  `setRule` (audited).
- **Status** — customers / shop owners with a verified mobile, codes locked
  after too many wrong tries (24 h / 7 days), SMS codes sent in 24 h.

API: `GET/PUT /api/admin/sign-in-security`. The general Feature flags page also
lists both switches.

## Design notes

- **Codes** are `login_otps` rows like every other code (purposes `LOGIN_SMS`,
  `CHECKOUT`, channel SMS, bound to the user and to the number): salted HMAC,
  expiry (`otp.expiryMinutes`, 5), cooldown (60 s), per-account / per-IP window
  limits, `maxAttempts` (5) then "Too many wrong attempts. Request a new code.",
  single use, audit with masked number. The per-account limit (5 codes an hour)
  counts every purpose together.
- **Pending second factor:** after the email code the browser gets a signed
  challenge (`userId.expiry.HMAC`, 15 minutes, its own HMAC domain so it is
  never a login ticket). The Google / emailed-link path keeps it in an httpOnly
  cookie (`gk_2fa_challenge`) and sends the browser to `/signin/second-factor`.
- **Google:** Auth.js's `signIn` callback returns the redirect instead of
  opening the session. A *new* account cannot be created through Google while
  the customers' switch is on (no account to bind the challenge to yet): the
  sign-in page asks the person to create it with the email code; Google works
  afterwards. The app's Google flow (system browser) does the SMS step in the
  browser and then continues to `/mobile-auth/complete`, so the app gets its
  code as before — `mobile/` needs no change.
- **SMS provider:** `SMS_PROVIDER = none | mock | msg91`. `msg91` sends only the
  DLT-approved code template (src/server/messaging/msg91.ts, flow API, 10 s
  timeout, number masked to its last 4 in logs, never the code). General SMS
  (notifications, registration links) has no DLT template and is not sent in
  that mode. Keys: `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_OTP_TEMPLATE_ID`,
  optional `MSG91_DLT_TE_ID` — environment only. What the owner registers:
  [DLT_SETUP.md](DLT_SETUP.md).
- **Web input:** every code box has `autocomplete="one-time-code"` and
  `inputMode="numeric"` (Android / iOS offer the SMS code above the keyboard,
  also in the app's WebView). Native Android SMS Retriever was not added.

## Rollout

1. **Staging (test.gokesari.com):** `SMS_PROVIDER=mock` (already the test-site
   mode), rule `otp.smsEnabled` on (default). Admin → Sign-in security → switch
   on shop owners, then customers; optionally the checkout code. SMS codes are
   read at Admin → Test messages (`GET /api/admin/test-messages?to=<last 4>`).
   QA sign-in: `scripts/qa/signin-staging.ts` handles the SMS step — sign
   `admin` in first (admins never get the SMS step) and it reads each code from
   the mock outbox with the admin session; an account without a verified mobile
   needs `QA_SMS_MOBILE_<ROLE>` (a free number per account). The
   gokesari-qa-signin skill text (in `.claude/skills`, not editable from this
   session) should mention this.
2. **Production (gokesari.com):** only after DLT + MSG91 are live
   ([DLT_SETUP.md](DLT_SETUP.md)) and the server env is set with the owner's OK.
   Until then `SMS_PROVIDER` stays `none` and switching on changes nothing.
   Then shop owners first, customers next, checkout code last.
3. **Off at any time:** the same page, one switch per audience; nothing else to undo.

## Tests

- `tests/unit/msg91-sms.test.ts` — MSG91 request shape, refusals, timeout, no
  code / full number in logs; rule `checkoutOtp` parsing.
- `tests/integration/sms-two-factor.test.ts` — both factors needed when on;
  switch off unchanged; each switch gates its own audience; other roles never;
  phone + `phoneVerifiedAt` set; lockout after 5 wrong codes; cooldown; SMS
  unavailable → email-only; forged / expired challenge; Google gate; checkout
  refused without a fresh code, `once_per_hours` honoured, pass given back on a
  failed checkout, no verified mobile; admin page/API refuses non-admins.
- `tests/qa/guest/sms-2fa.spec.ts` — guest-visible answers (checkout code API
  needs sign-in, the second-factor page without a challenge, admin API refuses guests).
