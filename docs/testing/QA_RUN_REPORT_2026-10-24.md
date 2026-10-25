# GoKesari QA run report — 24 Oct 2026

The 798-case plan is automated as Playwright UI and API checks (`tests/qa`): 863 cases and scenarios, of which 850 are automated and 13 stay manual. On 24 Oct the suite ran on all three sites. Production (gokesari.com) was then released through #242 and retested.

## Production after the release

- **Build:** gokesari.com serves main at `df923a2` (#242), the same files as staging `c6dbef1`. The production database already held every migration through 0091; the release added none.
- **Retest:** the guest tier passed **96, failed 0 and was blocked 0**, across 68 cases on desktop and phone (one skip, TC-QA-007, which needs the server's database).
  - All 11 checks that failed on the previous production run now pass. These cover D-01, D-02, D-03, D-04, D-06 and D-14.
  - Results: `docs/testing/qa-runs/2026-10-24-production-release-3.json`.
- **Not run on production:** the signed-in and local tiers. Production is guest-only by rule: no sign-in, order, payment, upload or submission.
- **New features not yet checked on production:** the guest tier has no checks for the new features (the paused-shop notice, India-time voucher dates, the cart and checkout race fixes, the product-master fix). Integration tests cover them on both database layouts; the production run shows that public pages did not regress.

## Update 25 Oct: release #248 (D-104) to gokesari.com

- **Released:** #248 merged into main as 1ed8e09 at 01:47 UTC. CI passed on both database layouts. It carries the D-104 fix: the shop owner's menus link to the public page only when the shop is approved.
- **Outage:** gokesari.com stopped answering from about 01:56 to 02:10 UTC (E-02). Another session merged #249 with the same files 75 seconds after #248, so two Hostinger deploys overlapped. A restart of the Node.js app (no rebuild) brought the site back. Details and recommendations: `docs/gokesari-audit/INCIDENT_2026-10-25_production_hang.md`.
- **Retest after the restart:** the guest tier passed **96, failed 0 and was blocked 0** (68 cases, desktop and phone; one skip, TC-QA-007).
  - No page took longer than 5 s; the home page was the slowest at 3.1 s.
  - Results: `docs/testing/qa-runs/2026-10-25-production-release-4.json`.
- **Not checked:** D-104 itself needs a signed-in shop owner, so it can't be checked on production and stays "Fixed (re-test pending)" until the next signed-in run on staging.

## Per site (latest run of each case; from the master register)

| Site | Pass | Pass (partial) | Fail | Blocked | Manual | Skipped (rule) |
|---|---|---|---|---|---|---|
| Local server (one database and split) | 296 | 407 | 46 | 101 | 13 | 0 |
| Staging (test.gokesari.com) | 51 | 100 | 30 | 203 | 4 | 475 |
| Production (gokesari.com, guest tier) | 24 | 43 | 0 | 0 | 0 | 1 |

"Skipped (rule)" means a check needs the server's database, which only the local run has.

Overall across all three sites: 306 pass, 384 pass (partial), 73 fail, 87 blocked, 13 manual. 66 P0 cases are not yet passed on every site.

**Staging, round 3** (signed-in and guest tiers): 209 passed and 41 failed. The checked failures were all in the tests, except one minor app defect:
- D-104: the shop owner's menu links to the public page of a shop that is not yet approved, which gives a 404. The fix is in #247.
- Examples of test-side failures: order look-ups read only the first page of orders, and some checks hard-code the local test shop's area and type instead of staging's.
- Not every failure was triaged one by one.

Results: `docs/testing/qa-runs/2026-10-24-staging-round-3.json`.

**Local, round 3** (one database: 920 pass, 45 fail, 246 blocked; split: 916 pass, 48 fail, 247 blocked). The only new app defect was D-100. It is now fixed (#244) and covered by integration tests on both layouts.

## Defects (`docs/testing/qa-defects.json`)

There are 105 entries.

| Status | Count |
|---|---|
| Fixed, retest passed | 73 |
| Fixed, retest on the sites pending (covered by unit / integration tests) | 22 |
| Open | 8 |
| Not a defect / not changed by design | 2 |

**Open defects:**
- **Owner decision needed:**
  - D-25: a rewarded referral later found fraudulent cannot be reversed.
  - D-57: riders can be approved with no identity documents.
  - D-69: an owner cannot close their shop.
- **Deferred:**
  - D-23: after a session expires, sign-in does not return to the page asked for.
  - D-91: order lines record no MRP.
  - D-95: loose stock cannot hold decimals.
  - D-96: the inventory page has no filters or sort.
- **To fix:**
  - D-103: on a signed-in desktop at 1280 px, the header search box collapses to 0 px.

**Fixed today:**
- D-99: test-site sessions failed after a migration was skipped. 0089 repaired it, and the journal guard test now stops it happening again.
- D-100: promoting a product-master record fails on two databases.
- D-101: vouchers took "today" from the UTC date.
- D-102: simultaneous adds to the cart answered 500 or lost units.
- The checkout cart race (#243).
- D-104: in #247.

## Released today (PRs)

- **To gokesari.com:**
  - #227: location found by itself.
  - #233 and #235: privacy and cookie policies.
  - #237: purchase lists.
  - #242: the QA suite and the fixes for 98 defects (#228, #232, #234, #238, #244), the paused-shop notice (#246), the cart and checkout fixes (#241, #243), India-time vouchers, the trending and guest-search changes (#236), and the www redirect (#224).
- **Merged into another PR:** #239 (purchase-list QA results) went in through #246.
- **Closed without merging:** #240, replaced by #241; and #245, replaced by #242.
- **Still open:** #247 (D-104 and the round-3 results). It merges into staging once CI is green.

## Observations for the owner

1. **Preview builds:** Hostinger's preview build for a PR into main migrates the production database before the PR merges. That is how 0089–0091 reached production early, and it caused the D-99 migration skip on the test site. This needs a decision (Blockers #71).
2. **Sandbox webhook:** the Cashfree sandbox webhook did not credit the wallet top-ups on staging; the verify call did.
3. **UTC dates elsewhere:** registration fees, legal documents, referrals and seller verification still take today's date in UTC. Nothing fails today; these are noted for a follow-up.
4. **Shop-registration sequence:** it has the same hazard on two databases that D-100 had for product codes.
5. **Test-side follow-ups:**
   - TC-PAY-034: the check reads a UUID as a card number.
   - TC-CAT-057: label.
   - Checks that read only the first page.
   - TC-LOC-023: waiting for the save.
   - TC-COD-010: adjustments.
   - SC-06: fairness ranking.
   - TC-SEC-005: flags `"code":"NOT_READ"`.
   - Area and shop type hard-coded to the local world in the TC-DISC-004 and TC-DISC-005 checks.
