# Dual authentication — test plan (docs/dual-auth-2026-11)

Automated: `tests/integration/dual-auth.test.ts` (Vitest, real PostgreSQL, SMS_PROVIDER=mock). Manual / UI cases are
run on test.gokesari.com (SMS mock outbox at /admin/test-messages, e-mails to the testing inbox) and on
gokesari.com. All run times are IST.

| ID | Case | Brief item | Automated |
|---|---|---|---|
| TC-DUAL-001 | Flag on = in force; flag off = nothing changes | flag | ✓ |
| TC-DUAL-002 | No SMS available → not in force, nobody locked out | default 6 | ✓ |
| TC-DUAL-003 | One-factor account cannot place an order (403 + /account/verify) | migration / checkout | ✓ |
| TC-DUAL-004 | needs_second_factor kept in step | migration | ✓ |
| TC-DUAL-010 | Returning customer, new device: e-mail code then SMS code | returning, new device | ✓ |
| TC-DUAL-011 | Trusted device (30 days): one factor for customer / shop owner / dealer; new browser both | trusted device | ✓ |
| TC-DUAL-012 | Trust expires | trusted device | ✓ |
| TC-DUAL-013 | Admin / operator / staff: both every time | staff | ✓ |
| TC-DUAL-014 | SMS first → e-mail second | mobile OTP login | ✓ |
| TC-DUAL-015 | One-factor sign-in opens a browse-only session | migration | ✓ |
| TC-DUAL-016 | Google only with email_verified; new Google account allowed | mobile OTP + Google | ✓ |
| TC-DUAL-020 | DualVerify mobile code completes the account, device trusted | DualVerify B | ✓ |
| TC-DUAL-021 | Mobile of another account → different-accounts message after the code + operator log | D | ✓ |
| TC-DUAL-022 | Mobile-only shop owner adds and verifies an e-mail | mobile-only shops | ✓ |
| TC-DUAL-023 | Duplicate prevention (e-mail of another account) | D | ✓ |
| TC-DUAL-024 | Existing account by e-mail → logged in to it | D | ✓ |
| TC-DUAL-030 | Bank change: SMS + e-mail codes; wrong e-mail code keeps SMS code; pass per action | sensitive | ✓ |
| TC-DUAL-031 | Mobile change: both codes first; devices revoked; new number verified again | sensitive | ✓ |
| TC-DUAL-032 | Step-up API | sensitive | ✓ |
| TC-DUAL-033 | One-factor account: DualVerify before step-up | sensitive | ✓ |
| TC-DUAL-040 | Lifetimes SMS 5 / e-mail 10 min | security | ✓ |
| TC-DUAL-041 | Expired code refused | security | ✓ |
| TC-DUAL-042 | Resend 30 s; 4 codes per 15 min | security | ✓ |
| TC-DUAL-043 | 5 wrong codes → 15-min lock (also new codes) | security | ✓ |
| TC-DUAL-044 | Codes stored hashed, not in audit | security | ✓ |
| TC-DUAL-045 | Rate limit on the API (429) | security | ✓ |
| TC-DUAL-050 | Shop of a one-factor owner cannot go live; can after both | on-behalf | ✓ |
| TC-DUAL-051 | Mobile-only registration closed | mobile-only removed | ✓ |
| TC-DUAL-052 | Existing mobile-only shop stays live, owner gated | migration | ✓ |
| TC-DUAL-UI-01 | New customer at checkout: Terms → e-mail code → mobile code → cart kept → order | web | Test site |
| TC-DUAL-UI-02 | New customer: mobile + e-mail link | web | Test site |
| TC-DUAL-UI-03 | New customer: Google + mobile code | web | Test site (Google account needed) |
| TC-DUAL-UI-04 | Returning customer new browser: SMS step inside the sheet | web | Test site |
| TC-DUAL-UI-05 | Shop onboarding identity step with both codes | web | Test site |
| TC-DUAL-UI-06 | /account/verify page, banner, staff redirect | web | Test site |
| TC-DUAL-UI-07 | Two-code dialog on bank change / withdrawal | web | Test site |
| TC-DUAL-UI-08 | Admin → Dual authentication report in IST | web | Test site |
| TC-DUAL-APP-01 | Android app (WebView): same flows, code autofill | Android | device needed |
| TC-DUAL-APP-02 | iOS app (WebView): same flows, one-time-code autofill | iOS | device needed |
