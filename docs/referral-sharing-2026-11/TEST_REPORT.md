# Referral sharing — test report

PR [#573](https://github.com/sanjaymorankar-debug/GoKesari/pull/573) with fix [#598](https://github.com/sanjaymorankar-debug/GoKesari/pull/598). All times IST. Status as of **26-Nov-2026 22.55 IST**.

| Run | When (IST) | Where | Result |
|---|---|---|---|
| Local automated | 25-Nov-2026 17.30–17.36; 26-Nov 10.40 (fix #598) | Mac, throwaway PostgreSQL 18 with all migrations | **Pass**: unit 1,742 / 1,742; referral integration 16 / 16; integration 343 / 343 on 25-Nov; mobile 63 / 63 on 25-Nov |
| Test (test.gokesari.com) | 26-Nov-2026 batch #594 → **failed**; fix #598 staging-verified 11.29 | staging queue (CI, migrate, deploy, post-deploy check, guest QA) + manual link checks 11.35 | **Pass** after fix (defect D-1 below) |
| Prod (gokesari.com) | released 26-Nov-2026 11.40 (release #608, main `8622344c`); post-deploy check passed; link checks 22.50 | gokesari.com, signed out | **Pass** for every signed-out case; signed-in and phone cases not run (see below) |

## Cases

| ID | Case | Local (automated) | Test site | Prod |
|---|---|---|---|---|
| RS-01 | Customer link `/r/<GK…>?c=wa` → sign-in, cookies, click logged with channel | Pass | Pass (`/r/qa-link-2026` → 307 `/signin`, `gk_ref=QALINK2026`, 30 days, HttpOnly) | Pass (`/r/NOSUCH99` → 307 `/signin`, `gk_ref` 30 days, Secure, HttpOnly) |
| RS-02 | Dealer `GKD-`, team lead `GKT-`, agent `GKA-` links keep hyphen → Add my shop with code; level and "Referred by" name right | Pass | Not run (no live partner code at hand) | Not run (needs a real partner code) |
| RS-03 | Expired code → `/invite` "expired on …"; inactive → "inactive"; **unknown → original route** (changed by #598) | Pass | Pass (unknown → `/signin`; `/invite/GKD-ZZZZZ` 200 "isn't valid") | Pass (same as test site) |
| RS-04 | Self-referral: own link applies nothing (SELF); apply own code refused | Pass | Not run (signed in) | Not run (signed in) |
| RS-05 | Duplicate: first valid link wins (KEPT_FIRST); one referrer per account | Pass | Not run (signed in) | Not run (signed in) |
| RS-06 | Share log: owner only; dealer for employees' codes; API needs sign-in and a known channel | Pass | Pass (guest QA: API refuses signed-out) | Pass (guest access only) |
| RS-07 | Deferred link: app first open on the same network → code filled in, claimed once | Pass | Not run (fresh APK install on a phone) | Not run (phone) |
| RS-08 | My referrals page | Pass | Pass (guest → sign-in) | Pass (`/referrals` → 307 `/signin`) |
| RS-09 | Admin report filters: referrer, role, channel, IST dates | Pass | Pass (guest → sign-in) | Pass (`/admin/referral-links` → 307 `/signin`) |
| RS-10 | Rule `referralSharing` off: original `/r/` behaviour, nothing logged | Pass | n/a (rule on) | n/a (rule on) |
| RS-11 | Registration code check after G-4; franchise-closed message | Pass | Pass (staging QA) | Not run (signed in) |
| RS-12 | Mandatory / optional toggle unchanged | Pass | Pass (staging QA) | Not run |
| RS-13 | Commission 20 / 4 / 3 and franchise 25 % unchanged | Pass | Pass (staging CI) | Not run (no money flow tested on prod) |
| RS-14 | Share via WhatsApp / SMS / Email / native sheet on Android app, iPhone, web | Unit pass | Not run (manual, phone) | Not run (manual, phone) |
| RS-15 | Link with app installed opens the app (Android App Links) | n/a | Not run (phone) | Not run (phone) |
| RS-16 | iOS Universal Links | n/a | Blocked: `MOBILE_IOS_APP_IDS` (Apple Team ID) not set; no iOS build | Blocked |
| RS-17 | `/app-open` (deferred-link landing) in a browser | n/a | Pass | Pass (307 → home) |

Note on prod: a shop code (`/r/SHOP…`) goes to `/signin` on gokesari.com and to Add my shop on the test site. That is the shop-refers-shop rule (off on prod, on on staging), not a defect.

## Defects

| ID | Found (IST) | Defect | Fix |
|---|---|---|---|
| G-2 | 25-Nov 17.20 | `/r/GKD-…` stripped the hyphen: partner codes never matched | Hyphen kept; partner codes go to Add my shop |
| G-4 | 25-Nov 17.20 | Closed franchise code showed generic "inactive" in the wizard | Franchise check first |
| G-5 | 25-Nov 17.20 | Replaced team-lead code got `GKA-` | `GKT-` for team leads |
| D-1 | 26-Nov ~09.30 (staging batch #594, guest QA TC-MKT-018, TC-SREF-002, TC-RBAC-002) | Unknown codes went to `/invite` instead of the original route; `/invite` was not listed as a public page | #598: unknown codes keep the original `/r/` route; `/invite/[code]` public. Staging-verified 11.29, on prod 11.40 |

## Still open

- Manual phone tests (RS-07, RS-14, RS-15) and signed-in cases on prod (RS-02, RS-04, RS-05, RS-11–13).
- APK publish of app 1.15.0 on the website; iOS build and `MOBILE_IOS_APP_IDS` need the owner.
