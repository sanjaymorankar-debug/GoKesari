# Referral sharing — test report

PR [#573](https://github.com/sanjaymorankar-debug/GoKesari/pull/573). All times IST. Status as of **25-Nov-2026 17.50 IST**.

| Run | When (IST) | Where | Result |
|---|---|---|---|
| Local automated | 25-Nov-2026 17.30–17.36 | Mac, throwaway PostgreSQL 18 with all 203 migrations | **Pass**: unit 1,702 / 1,702; integration 343 / 343 (referral, dealer, franchise, registration suites); mobile 63 / 63 |
| Test (test.gokesari.com) | pending | staging queue (CI, migrate, deploy, post-deploy check, guest QA) | Waiting: 20+ PRs ahead in the queue |
| Prod (gokesari.com) | pending | 23.00 IST release window, after staging-verified | Not released |

## Cases

| ID | Case | Local (automated) | Test site | Prod |
|---|---|---|---|---|
| RS-01 | Customer link `/r/<GK…>?c=wa` → sign-in, cookies, click logged with channel | Pass | Pending | Pending |
| RS-02 | Dealer `GKD-`, team lead `GKT-`, agent `GKA-` links keep hyphen → Add my shop with code; level and "Referred by" name right | Pass | Pending | Pending |
| RS-03 | Expired code → `/invite` "expired on …"; inactive → "inactive"; unknown → "isn't valid" | Pass | Pending | Pending |
| RS-04 | Self-referral: own link applies nothing (SELF); apply own code refused | Pass | Pending | Pending |
| RS-05 | Duplicate: first valid link wins (KEPT_FIRST); one referrer per account | Pass | Pending | Pending |
| RS-06 | Share log: owner only; dealer for employees' codes; API needs sign-in and a known channel | Pass | Pending | Pending |
| RS-07 | Deferred link: app first open on the same network → code filled in, claimed once; browser / other network → home; not own code; not after 24 h | Pass | Pending (fresh APK install) | Pending |
| RS-08 | My referrals: shares by channel, opens, sign-ups, pending, earned (customer and agent) | Pass | Pending | Pending |
| RS-09 | Admin report filters: referrer, role, channel, IST dates | Pass | Pending | Pending |
| RS-10 | Rule `referralSharing` off: original `/r/` behaviour, nothing logged | Pass | Pending | Pending |
| RS-11 | Registration code check after G-4; franchise-closed message (franchise suite) | Pass | Pending | Pending |
| RS-12 | Mandatory / optional toggle unchanged (referral-settings suite, 4 combinations) | Pass | Pending | Pending |
| RS-13 | Commission 20 / 4 / 3 and franchise 25 % unchanged (dealer-tiered, franchise suites) | Pass | Pending | Pending |
| RS-14 | Share via WhatsApp / SMS / Email / native sheet on Android app, iPhone, web | Unit (links, message) pass | Pending (manual, phone) | Pending |
| RS-15 | Link with app installed opens the app (Android App Links) | n/a | Pending | Pending |
| RS-16 | iOS Universal Links | n/a | Blocked: `MOBILE_IOS_APP_IDS` (Apple Team ID) not set; no iOS build yet | Blocked |

## Defects found and fixed during this work

| ID | Found (IST) | Defect | Fix |
|---|---|---|---|
| G-2 | 25-Nov 17.20 | `/r/GKD-…` stripped the hyphen: partner codes never matched | Hyphen kept; partner codes go to Add my shop |
| G-4 | 25-Nov 17.20 | Closed franchise code showed generic "inactive" in the wizard | Franchise check first |
| G-5 | 25-Nov 17.20 | Replaced team-lead code got `GKA-` | `GKT-` for team leads |
