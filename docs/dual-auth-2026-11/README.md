# Dual authentication — mobile OTP + e-mail for every account (owner brief 26-Nov-2026, 11.28 PM IST)

Feature flag **`dual_auth`** (Admin → Feature flags). Migration **0219** seeds it **ON on the staging database
(`gokesari_test`)** and **OFF on production**. With the flag off, every flow behaves exactly as before. All times in
this document, the admin report and the audit trail are IST.

It is built on top of onboarding v2 (`docs/onboarding-v2-2026-11`, already live). It reuses the existing sign-in code
(`src/server/otp/*`, the SMS second factor of `docs/sms-2fa-2026-11`), the checkout login sheet, the shop identity
step and the audit log. Nothing is duplicated.

## The rule

An account counts only when **both** of these are verified:
- **mobile**: by an SMS code (`users.phone_verified_at`);
- **e-mail**: by an e-mailed code, the e-mailed one-time link, or Google with `email_verified = true`
  (`users.email_verified`, or a linked Google account), on a real (non-placeholder) address.

The rule is **in force** when the flag is on **and** SMS codes can be sent on the server (`SMS_PROVIDER` + rule
`otp.smsEnabled`). If the flag is on but no SMS can be sent, nothing is asked and Admin → Dual authentication shows
"On, but not in force".

## DualVerify — one shared module

| Piece | Where |
|---|---|
| Rule, factor state, gates | `src/server/dual-auth/policy.ts` |
| Verifying the missing factor (mobile code, e-mail code; account check after the code) | `src/server/dual-auth/verify.ts` |
| Trusted devices (cookie `gk_device`, table `trusted_devices`, 30 days) | `src/server/dual-auth/devices.ts` |
| Two codes for sensitive actions | `src/server/dual-auth/step-up.ts` |
| Reminders for mobile-only shops (hourly job, 10:00–19:00 IST) | `src/server/dual-auth/reminders.ts` |
| Admin report | `src/server/dual-auth/report.ts`, `/admin/dual-auth` |
| APIs | `/api/dual-auth/status`, `/api/dual-auth/verify`, `/api/dual-auth/step-up` |
| UI | `/account/verify` (`src/components/dual-verify/*`), the banner, the two-code dialog (fetch guard) |

The same web module runs in the Android and iOS apps: both apps are WebView shells (`mobile/src/App.tsx`), so the
DualVerify screens, the sign-in steps and the code boxes reach the apps with each website deploy (no store update).

### Steps
- **A. Terms**: the existing ticks — checkout sheet (`user_consents` + `policy_acceptances`, version + time) and the
  sign-in page / shop identity step (`recordConsent`).
- **B. Mobile**: +91 number, validated (`parseIndianMobile`); 6-digit SMS code through the existing SMS provider.
  Code boxes use `autocomplete="one-time-code"` (iOS / Safari / WKWebView autofill, Android keyboard suggestion);
  Chrome on Android also reads it with the WebOTP API when the SMS ends with `@<host> #<code>`.
- **C. E-mail**: e-mail **code** (new on the web sheet; purpose `DUAL_VERIFY_EMAIL` / `LOGIN`), e-mail **link**
  (existing), or **Continue with Google** (accepted only when Google says `email_verified = true`).
- **D. Account check** (only after the code proved the number / address):
  - mobile or e-mail already belongs to the account → that account is used, never a duplicate;
  - mobile and e-mail on **two different accounts** → "This mobile and email belong to different accounts. Log in
    with one, or contact support." + audit `auth.account_conflict` (Admin → Dual authentication lists them);
  - otherwise the account (and wallet) exist; `phone_verified_at` and `email_verified` are stored.

## Wired into

| Flow | Behaviour with the flag on |
|---|---|
| Customer checkout | Guests browse freely. "Place order" opens the sheet: Terms → e-mail (code, link or Google) → mobile code (strict, no unverified fallback) → back to the cart with the cart intact. A returning customer on a new device gives the SMS code inside the sheet. No referral code asked. `/api/checkout` refuses a one-factor account (403 + DualVerify link). |
| Shop onboarding step 1 (`V2_IDENTITY`) | E-mail and mobile steps go through DualVerify. Skipped for a signed-in account with both verified. |
| Mobile-only shop sign-up (Module 3 `/sell` self-registration) | Closed: "Please use Add my shop … it verifies your mobile and e-mail". A paid registration from before still completes. |
| Shops registered on the owner's behalf (admin, operator, dealer, helper) | The shop is not approved (manual or automatic) until the owner has verified both; it is released automatically when the owner finishes (`releaseShopsHeldForDualAuth`). |
| Franchise / team | Inherit the account's verification; dealer / team / franchise pages send a one-factor account to DualVerify; invitees without an account sign up through the same sheet. |
| Staff (admin, operator, all internal roles) | Every `/admin`, `/operator`, `/staff` page and every staff API (`requirePermission` / `requireRole`) needs both factors. |

## Returning sign-ins and sensitive actions

- Customers, shop owners, dealers, riders, society admins: on a **trusted device** (both factors done there in the
  last 30 days) one factor signs in; on a **new device / browser** both factors.
- Admin, operator and every staff role: both factors on **every** sign-in.
- **Always both codes** (SMS + e-mail), whatever the device: changing mobile or e-mail (`linkPhone`, `unlinkPhone`,
  e-mail change, DualVerify number change), adding / changing a bank / UPI / payout account (`saveBankAccount`, rider
  bank removal, dealer application bank, team member payee), withdrawals (rider wallet, refund to bank), role changes
  in My team (upgrade, downgrade, reassign, remove, promote). Shop ownership transfer: **no such flow exists in the
  code yet**; the guard (`OWNERSHIP_TRANSFER`) is ready for it.
- A changed mobile or e-mail revokes every trusted device of the account.

## Existing accounts (migration 0219)

- `users.needs_second_factor` = true for every live account with no verified mobile or no verified real e-mail
  (`needs_second_factor_since` = migration time). Kept in step by the app.
- They can browse. Ordering, shop / dealer / admin work and withdrawals ask for the missing factor first
  (`/account/verify`, then back).
- Mobile-only shops (placeholder e-mail): asked for an e-mail at the next sign-in (Seller Central sends them to
  DualVerify), see a banner on every page, get an in-app + SMS reminder every 3 days (10:00–19:00 IST). The shop is
  never taken offline. Admin → Dual authentication lists them.

## Security

| Item | Value (rule `dualAuth`, admin-editable) |
|---|---|
| Mobile code lifetime | 5 min |
| E-mail code lifetime | 10 min |
| E-mail link | 15 min, single use (Auth.js) |
| Resend | after 30 s; at most 4 codes (3 resends) per 15 min per number / e-mail |
| Lockout | 5 wrong codes → that number / e-mail locked 15 min |
| Rate limits | per number, per e-mail, per account (DB), per IP (DB + route limits) |
| Storage | codes stored only as salted HMAC; never logged (audits keep masked identifiers) |
| Audit (IST in admin) | `auth.dual_factor_verified`, `auth.dual_sign_in`, `auth.device_trusted`, `auth.devices_revoked`, `auth.step_up_*`, `auth.account_conflict`, `auth.dual_gate_blocked`, `auth.second_factor_reminder`, `auth.otp_*` |
| No enumeration | codes are sent before any "already registered" answer; the conflict message appears only after both factors were proven |

## Defaults — "DEFAULT – confirm with Sanjay"

From the brief:
1. Google sign-in counts as e-mail verification only when `email_verified = true`.
2. Customers: one factor on a trusted device, both on a new device. Shop owners, dealers, team members: both on every
   new device. Devices trusted for 30 days.
3. OTP lifetimes, resend limits and lockouts as in "Security".
4. Shops registered with only a mobile number stay live; prompted for an e-mail at the next sign-in.

Choices made while building (each marked in code):
5. `mobile_verified_at` / `email_verified_at` are the existing `users.phone_verified_at` / `users.email_verified`
   columns (plus a linked Google account for the e-mail) — no duplicate columns.
6. In force only where SMS can be sent: with the flag on and no SMS provider nothing is asked (no lock-out).
7. The account row is created at the first verified factor (as today) but is held by `needs_second_factor` — it can
   only browse until the second factor is verified. A new Google account is allowed for the same reason.
8. Delivery partners and society admins get device trust like customers; every internal staff role (CA, accountant,
   support, operations, dealership staff) is treated like admin / operator (both factors every sign-in).
9. "At most 3 resends per 15 minutes" = 4 codes per 15 minutes per number / e-mail (first + 3 resends).
10. One two-code check covers repeats of the **same** sensitive action for 10 minutes (rule `dualAuth.stepUpMinutes`).
11. A changed mobile or e-mail revokes all trusted devices of the account.
12. If the e-mail is new and the mobile belongs to an existing account (or the reverse), the step stops with the
    "different accounts" message rather than signing in on the mobile alone (one factor).
13. DualVerify offers the e-mail code and the e-mail link to an existing account; "Continue with Google" is offered at
    sign-in and in the checkout sheet (Auth.js does not link Google to an existing e-mail account automatically).
14. Android SMS Retriever (native auto-read) needs an app hash inside the DLT SMS template and a store build; the apps
    are WebView shells, so they use keyboard / WebOTP autofill (`autocomplete="one-time-code"`), shipped with the website.
15. Mobile-only self-registration (Module 3) is closed while the rule is in force; owners use Add my shop.
16. Reminders: in-app + SMS every 3 days between 10:00 and 19:00 IST. On gokesari.com the SMS goes out only once an SMS
    template for it exists with the provider (today only the OTP template is DLT-registered); the in-app notice always works.
17. Admin → Dual authentication is open to ADMIN (menu) and OPERATOR / operations / support managers (direct link).
18. Production: flag switched on only after the production test pass AND with real SMS (SMSFortius keys, PR #632).

## Rollback

Switch `dual_auth` off (instant). Schema rollback: `scripts/rollback-0219-dual-auth.sql` (drops only what 0219 added).
