# Testing report — Login & authentication finish (27-Nov-2026)

Owner brief 27-Nov-2026 01.34 PM IST ("GoKesari — finish login and authentication"), items 1–9.
Code: staging [#667](https://github.com/sanjaymorankar-debug/GoKesari/pull/667) + [#669](https://github.com/sanjaymorankar-debug/GoKesari/pull/669) (both `staging-verified`), production hotfix [#668](https://github.com/sanjaymorankar-debug/GoKesari/pull/668) (merged into `main` 17.34 IST, live 17.46 IST as `c6a8e5bd`).
Follow-up fix: [#675](https://github.com/sanjaymorankar-debug/GoKesari/pull/675) (plain message when the e-mail quota is used up), in the staging queue.

## Result in one line

All 9 items built and released. **`dual_auth` is ON on gokesari.com since 27-Nov-2026 17.51 IST** (tracker D7.4). Local, CI, staging and production checks passed. Three production cases need the owner's own phone (listed at the end).

## What was built (items 1–9)

| # | Item | Where |
|---|------|-------|
| L1 | Sign-in page: one box (mobile or e-mail), "I agree", Get code. No Google, no sign-in link. Unregistered-mobile 404 rule dropped; "No SMS after a minute? Use your email instead" on the code step | `src/app/signin/page.tsx`, `src/components/otp-login-form.tsx` |
| L2 | Safety step: an SMS sign-in to a never-verified number on an account with a real e-mail also asks that e-mail's code, then marks both verified | `src/server/otp/second-factor.ts`, `service.ts` |
| L3 | Mandatory `/account/verify` straight after sign-in while `dual_auth` is in force; no skip (shop registration and checkout sheet keep their own steps) | `src/app/onboarding/page.tsx` |
| L4 | E-mail by link for mobile-only accounts: single use, 15 min, 30 s resend gap, max 4 per 15 min, newest link only, duplicate address → DIFFERENT_ACCOUNTS | `src/server/dual-auth/verify.ts`, `src/app/account/verify/email/page.tsx` |
| L5 | Profile mobile added / changed only by SMS code (whenever SMS works); both codes only when changing an already verified number | `src/server/flows/phone-link.ts`, `src/server/otp/service.ts` |
| L6 | Device trust by role: customers 180 days rolling (max 365 from first trust); shop owners, dealers, riders, others 30 days fixed; staff never | `src/server/dual-auth/devices.ts`, rule `dualAuth` |
| L7 | Reminders for every account with a missing factor, hourly 10–19 IST, every `reminderEveryDays`; shop owners in-app + SMS; others in-app + e-mail (real address) + SMS (if a number) | `src/server/dual-auth/reminders.ts` |
| L8 | Android + iOS: the apps are WebView shells; `/account/*` already opens in the app (app links / AASA). No new build needed | — |
| L9 | `dual_auth` ON in production after the production pass | `feature_flags` (+ `feature_flag_changes`, `audit_logs`) |

## Run 1 — local (integration + regression)

| Suite | Result |
|---|---|
| `tests/integration/login-auth-2026-11.test.ts` (new: LA-3.1–3.3, LA-4.1–4.4, LA-5.1–5.3, LA-6.1–6.5, LA-7.1–7.2) | 19 / 19 passed |
| 7 auth test files on the production branch (`sms-two-factor`, `dual-auth`, `login-profile`, `qa-2026-10-24-auth-fixes`, …) | 148 / 148 passed |
| Full local regression | 5,437 passed; 3 `migrate-on-build` failures were local timeouts only (pass in CI) |
| CI on #667 (staging) and #668 (production): checks, 4 test shards, build, prod-db | all green |

Browser checks on the local dev server: one-box page; safety step (SMS → "Step 2 of 2" e-mail code → mobile and e-mail both verified); mobile-only sign-in → `/account/verify?return=/onboarding` → e-mail link → Confirm → back to `/onboarding` with the e-mail saved.

### Defects found and fixed

| Defect | Fix |
|---|---|
| With `dual_auth` on, adding a *first* mobile on the profile asked both codes first (403 for an e-mail-only account) | Step-up only when changing an already verified number (#668, #669) |
| Flaky TC-SMSLOGIN-002/006: a "New sign-in" notice arrives after the code e-mail | Test helper takes the newest code e-mail |
| Reminder query: drizzle left `id` unqualified in the `exists` subquery | Raw SQL naming `"users"."id"` |

## Run 2 — test.gokesari.com (staging, `SMS_PROVIDER=mock`, `dual_auth` ON)

Staging queue: #667 and #669 `staging-verified` (CI, migrations, deploy, post-deploy check, guest QA tier).
End-to-end run 27-Nov-2026 17.53–17.54 IST, fresh browser (Playwright), SMS code read from the mock outbox:

| Case | Result |
|---|---|
| S1 New mobile 9000012701 on `/signin`: one box + I agree → "OTP sent by SMS to +91 9000012701"; "Use your email instead" link shown | PASS |
| S2 Code entered → signed in → straight to `/account/verify?return=/onboarding`; no skip / later link | PASS |
| S3 New account: CUSTOMER, mobile verified, e-mail placeholder, `needs_second_factor` = true | PASS |
| S4 Opening `/onboarding` again → back to `/account/verify` (cannot get round it) | PASS |
| S5 "E-mail me a link instead" button shown for the mobile-only account | PASS |
| S6 Sending the link | **FAIL (environment)**: all 11 staging mailboxes had sent their 90 e-mails in 24 h (`MailboxesExhaustedError`); page said "Something went wrong" → fixed by #675 (plain "We can't send e-mails right now…" message, 503). Link logic itself covered by LA-4.1–4.4 |
| Existing staging test account shows the banner "Please verify your mobile number to keep ordering… Verify now" | PASS |

Not run on staging (e-mail codes for the staging test accounts are not readable from this session, and the mail quota was used up): safety step, trust renewal, staff every time. Covered by LA-6.x, TC-SMSLOGIN-002/006/007 and TC-DUAL-011.

## Run 3 — gokesari.com (production, SMSFortius live)

| Step | Time (IST) | Result |
|---|---|---|
| Pre-release: no other open PR into `main`; last post-deploy check green; site on `main`'s head `45c54dc6` | 16.05 / 17.34 | PASS |
| #668 merged (prod-db check green, no migrations) | 17.34 | done |
| Server deploy `c6a8e5bd` live (`/sw.js`) | 17.46 | PASS |
| Post-deploy check (script, 5 healthy rounds) + workflow "Post-deploy check" on `c6a8e5bd` | 17.47–17.51 | PASS |
| Real SMS: SMSFortius configured (`SMS_PROVIDER=smsfortius`, sender GOKSRI, DLT template); sign-in SMS at 14.00 and 14.08 accepted ("Message submitted successfully") | — | PASS |
| P1 `/signin`: one box, I agree, Get code; no Google button, no link form | 17.48 | PASS |
| P2 `/account/verify/email?t=<bad>` → "This link is not valid any more" | 17.48 | PASS |
| P3 `/account/verify` signed out → sign-in with return path | 17.48 | PASS |
| P4 `POST /api/me/phone/code` signed out → 401 | 17.48 | PASS |
| P5 `/admin/sign-in-security` signed out → sign-in | 17.48 | PASS |
| **`dual_auth` switched ON** (owner in chat: "carry on with prod tests and dual_auth on"); `feature_flag_changes` + `audit_logs` rows written | **17.51** | done |
| Re-run P1–P5 with the flag on; page config `dualAuth: true`; `/`, `/shops`, `/robots.txt` 200; no errors in the app log | 17.52 | PASS |
| Reminder run (hourly at :47, first with the flag on) | 18.47 | PASS (in-app + e-mail); SMS skipped, see below |

Production accounts at the switch (17.50 IST): 45 users, all `needs_second_factor`; 3 admins (0 verified mobile, 2 verified e-mail), 25 customers (0 / 5), 17 shop owners (2 / 3). Each is asked for the missing factor at the next sign-in; staff (admins) will add a mobile by SMS code. Mail capacity: 35 of 990 sends used in the last 24 h.

**Reminders, 18.47 IST run** (job `dual-auth-reminders`: checked 45, reminded 43; the other 2 were already reminded or no longer need a factor):

| Channel | Result |
|---|---|
| In-app | 43 notifications "Verify your mobile number" → `/account/verify` |
| E-mail | 43 sent, all to real addresses (42 Gmail, 1 Yahoo) |
| SMS | 28 **skipped**: "No provider is configured for this channel." SMSFortius on gokesari.com carries only the DLT one-time-code template; a reminder SMS needs its own DLT-registered template (owner input). The reminder still reached everyone by in-app + e-mail |

Next reminder to the same account after `reminderEveryDays`.

### Production cases that need the owner's phone

Real SMS codes reach only the owner's mobile, so these three are for the owner (about 5 minutes, any browser, signed out first):

1. Sign in on gokesari.com with your mobile → enter the SMS code → you land on **Verify your account** if your e-mail is not verified yet; finish it (code or link).
2. Sign in as admin → both codes are asked (staff are never trusted).
3. Profile → change mobile → an SMS code is asked before it is saved.

## DEFAULTS used (owner can change in Admin → Sign-in security / rule `dualAuth`)

| Default | Value |
|---|---|
| Customer trust maximum (rolling 180 days never past first trust + N days) | `customerTrustMaxDays` = 365 |
| Customer reminders | in-app + e-mail (real address) + SMS when a number is on file; shop owners in-app + SMS |
| SMS cannot be sent on the site | browsing allowed, orders blocked until verified; profile mobile linked unverified as before |
| E-mail link | single use, 15 minutes, 30 s resend gap, max 4 per 15 minutes |
| Reminder hours | 10.00–19.00 IST, every `reminderEveryDays` |

## Not covered / open

- The three owner-phone cases above.
- Reminder / notification SMS on gokesari.com: register a DLT template for the reminder text with SMSFortius (owner), then configure it; until then reminders go in-app + e-mail.
- #675 (e-mail quota message) in the staging queue; to production in the next release.
- Staging mail pool is at its daily cap (11 × 90); e-mail tests on staging resume when it frees up.
