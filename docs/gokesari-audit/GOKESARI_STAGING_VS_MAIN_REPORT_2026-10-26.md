# GoKesari: staging vs main, defects and open work

As of 26 Oct 2026, 04:30 UTC. Workbook with the full lists: `GOKESARI_STAGING_VS_MAIN_REPORT_2026-10-26.xlsx` (sheets: Summary, Environments, Staging vs main, Defects open, Features open, Blockers, Incidents). GoKesari only.

## 1. Where each site stands

| Site | Branch | Head | Code | Database | Status (26 Oct 04:25 UTC) |
|---|---|---|---|---|---|
| gokesari.com | main | 76b9d34 (#262) | Same as 4a32386 (#249, the 24 Oct release) | Migrations up to 0094 | Up: `/` 200 (11.7 s cold), `/shops` 200 (1.4 s) |
| test.gokesari.com | staging | 59a6163 (#260) | All of main plus the PRs below | Migrations up to 0096 | Up: `/shops` 200 (6.1 s) |

- The 25 Oct release, #261 (the code of #254), was rolled back by #262 during the outage E-03 (section 5). main's code is now byte-for-byte the 24 Oct release.
- Migrations 0092–0094 stayed on the production database. They are additive, and the old code doesn't use them.
- main has nothing that staging lacks.

## 2. On staging, not on main

| PR | What | Type | On main? | Migrations |
|---|---|---|---|---|
| #250 | Seven open bugs: GAP-011, 012, 014, 016, 017, 018, 019 | Code | No | – |
| #251 | Dates in India time everywhere; voucher upload refuses a past end date (D-105) | Code | No | – |
| #254 | Owner decisions 25 Oct: D-103, D-57, D-91, D-25, D-96, D-23, D-69 | Code | Rolled back | 0092–0094 (already on the production database) |
| #257 | Loose stock in decimals (D-95) | Code | No | 0095, 0096 |
| #259 | GAP-013 (staff complete a return waiting for a rider), GAP-019 faster checkout | Code | No | – |
| #260 | One production release at a time; post-deploy check workflow (E-02) | Process + workflow | No (the workflow runs only from main) | – |
| #252, #253, #256, #258 | QA re-tests, incident note E-02, gap analysis, status report | Docs | No | – |
| #263 (open, draft) | QA: D-101 voucher dates re-tested on test (TC-FLD-114 pass) | Docs | – | – |

## 3. Defects (docs/testing/qa-defects.json on staging)

**107 logged:**
- 74 fixed and re-tested;
- 30 fixed and waiting for a re-test;
- 1 unchanged by design (D-54);
- 1 not a defect;
- 2 open incidents (E-02, plus E-03 added in this report).

**Fixed only on staging (9), so they still fail on gokesari.com:**
- D-23, D-25, D-57, D-69, D-91, D-96 and D-103 (#254, rolled back);
- D-95 (#257);
- D-105 (#251).

**Fixed on both sites and waiting for a re-test (21):**
- High severity: D-29, D-30, D-32, D-100.
- Medium: D-07, D-08, D-20, D-36, D-46, D-48.
- Low: D-11, D-15, D-16, D-40, D-53, D-56, D-70, D-75, D-78 (in part; there is still no logo upload), D-92, D-104.

**Open:**
- **E-02 (High), owner decision on the release process.** On 25 Oct, two overlapping deploys stopped gokesari.com for about 14 minutes.
- **E-03 (High), new.** About 4 h 15 min outage after the #261 release.

## 4. Features not completed on production

| ID | Feature | Status | Blocked on / next step |
|---|---|---|---|
| GAP-011, 012, 014, 016, 017, 018; GAP-013 | Bug fixes from the 21 Oct report | Built on staging (#250, #259) | Re-test, release |
| 25 Oct D-items, D-95, India-time dates | Owner decisions, loose stock in decimals, dates | Built on staging (#254, #257, #251) | Re-test, release |
| GAP-019 | Wallet checkout 30–38 s on test | In progress (#250, #259 on staging) | The rest depends on GAP-010 |
| NEW-043 | Android and iPhone app | In progress (Android test builds only) | Owner: when to publish to the stores |
| QA-003 | 791 test cases and sign-off | In progress | Re-run after the next staging build |
| PLT-017 | iPhone app workflow | Blocked | Owner: store decision, then EXPO_TOKEN and Apple keys |
| QA-009 | Production order run with a real payment | Blocked | Owner: production shop, rider, live Cashfree keys |
| NEW-027 | GST rates / HSN codes check | Blocked | A CA confirms rates, codes and invoice wording |
| GAP-010 | Slow signed-in pages, cold first visits | Blocked | Owner: database and web server in the same region |
| GAP-003 | Signature at delivery | Yet to start | Phase 2 |
| GAP-009 | Email sending capacity | Yet to start | Owner: email provider or a higher limit |
| GAP-015 | Hindi / Marathi for inner pages | Yet to start | Owner decision (with native review) |

**Corrections to the 25 Oct register:**
- NEW-070 (www → gokesari.com) is live: www answered 308 on 25 Oct.
- GAP-008 is resolved (#258).

## 5. Incidents

| ID | When (UTC) | What | Status |
|---|---|---|---|
| E-02 | 25 Oct 01:56–02:10 | Two production builds overlapped (#248 and #249 merged 75 s apart). Recovered by restarting the app. | Open (owner decision on the release process; #260 waits for release) |
| E-03 | 25 Oct 09:59–14:15 | See details below. | Open |

**E-03 details:**
- **What happened:** after the #261 release, gokesari.com didn't answer. The build was clean, but the app restarted every few seconds with no error. test.gokesari.com ran the same code throughout.
- **What didn't help:** an API restart at 12:38, and the rollback to the 24 Oct code (deployed 13:02). The site came back at 14:15 with no further change from our side.
- **Likely cause (not proven):** the hosting account's limits. The account also runs six Bkesari/Ladwani Node apps created that day.

## 6. Blockers and decisions (45 open; full list in the workbook)

**Hosting:**
- Find the cause of E-03: account resource use, the other Node apps on the account, Hostinger support.
- Add uptime monitoring with an alert.

**Release:**
- One staging → main PR for #250, #251, #254, #257, #259, #260 and the docs.
- Do it in an agreed window, one deploy at a time, and check the site after the deploy.
- Hostinger preview builds run migrations against the target site's database before the PR merges (blocker #71). That's how 0092–0094 reached production.

**Owner inputs:**
- Live Cashfree and payout keys, and webhook secrets.
- A CA check of GST/HSN and of the TCS/TDS rates.
- An email provider.
- The hosting region.
- App-store accounts and Expo.
- The GoKesari GSTIN and grievance officer details.
- Production crons.
- Which off-by-default features to switch on.

**Security:**
- Rotate the production database password (it was posted in a chat on 12 Oct).
- Delete the downloaded copy-shops SQL files.

## 7. Recommended order

1. **Hosting (owner).** Find why gokesari.com kept restarting on 25 Oct, and set up uptime monitoring.
2. **Re-test on test.gokesari.com:**
   - the 9 staging-only fixes;
   - GAP-011 to GAP-019;
   - TC-SPI-025 (loose stock).
3. **Release.** One release PR staging → main in an agreed window, then check the site.
4. **Re-test on gokesari.com** the 21 fixes still marked "re-test pending".
5. **Owner inputs** from section 6.
