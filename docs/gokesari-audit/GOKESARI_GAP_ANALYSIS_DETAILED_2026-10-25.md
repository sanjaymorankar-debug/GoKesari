# GoKesari: detailed gap analysis (sessions, defects, PRs)

As of 25 Oct 2026, 05:00 UTC (10:30 IST). Local (this cloud session, the owner's Mac), staging (test.gokesari.com) and main (gokesari.com). The workbook `GOKESARI_GAP_ANALYSIS_DETAILED_2026-10-25.xlsx` has every row, including all 107 defects.

## 1. Where each line stands

| Where | Branch | Commit | Latest migration | CI | Note |
|---|---|---|---|---|---|
| gokesari.com (production) | main | 4a32386 | 0091 | green | Release #249, 25 Oct 01:48 UTC |
| test.gokesari.com (staging) | staging | 82c6fd9 | 0094 | #254 merge green; #251 merge running | 5 PRs ahead of main; migrations 0092-0094 run on the next build |
| Local: this cloud session | staging (82c6fd9) | 82c6fd9 | 0094 | - | Clean, nothing unpushed |
| Local: owner's Mac | - | - | - | - | Not visible from the cloud; one known item (permissions allowlist) yet to commit |

## 2. Defects at a glance

| By status | Count |
|---|---|
| Fixed, re-test passed | 74 |
| Fixed, re-test pending | 29 |
| Closed, no change (not a defect / by design) | 2 |
| Open | 2 |

| Where the fix is | Count |
|---|---|
| In both | 95 |
| Release to main | 8 |
| By design | 1 |
| Open | 1 |
| Not a defect | 1 |
| Hosting / release process | 1 |

| Not closed yet, by severity | Count |
|---|---|
| Low | 14 |
| Medium | 13 |
| High | 5 |
| Info | 1 |

## 3. Defects not yet closed (33)

| ID | Severity | Title | Status (staging log) | Fix in staging (test) | Fix in main (prod) | Next step |
|---|---|---|---|---|---|---|
| D-07 | Medium | A deleted address can still be used at checkout | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-08 | Medium | The rider never sees address line 2 (flat, floor) | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-11 | Low | Order notes never reach the shop | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-15 | Low | The shop page does not show the minimum order | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-16 | Low | A broken product photo stays broken (no placeholder) | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-20 | Medium | A rider who signs out stays online and gets offers | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-23 | Low | After a session expires, sign-in does not return to the page asked for | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-25 | Medium | A rewarded referral found fraudulent cannot be reversed | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-29 | High | Reconciliation reports books that agree as UNMATCHED | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-30 | High | A shop cannot remove an unavailable line from an online-paid order | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-32 | High | Wallet 'Add money' is off-screen on a phone | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-36 | Medium | A negative rider payout is not flagged | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-40 | Low | Verifying an unpaid top-up gives 500 when the gateway is unreachable | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-46 | Medium | No 'Cancel order' button after pickup | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-48 | Medium | 1.5 of a per-piece item can be returned | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-53 | Low | The remove-line reason accepts anything | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-54 | Low | The failed-delivery reason accepts anything | Not changed (by design) | - | - | None |
| D-56 | Low | Admin refund form rounds 10.555 instead of refusing it | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-57 | Medium | Riders can be approved with no identity documents | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-69 | Medium | An owner cannot close their shop | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-70 | Low | Product card shows no MRP strike-through or discount | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-75 | Low | No upper limit on minimum order, delivery fee or free-delivery threshold | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-78 | Low | A 'javascript:' logo URL is accepted; no logo upload | Fixed in part (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-91 | Medium | Order lines record no MRP | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-92 | Low | Order pages lack unit price and payment method | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| D-95 | Medium | Loose stock cannot hold decimals | Open (owner decided - in a follow-up change) | No | No | Follow-up PR (decimal loose stock), owner decided |
| D-96 | Low | Inventory page has no filters or sort | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-100 | High | On two databases, promoting a product-master record into the catalogue fails (duplicate product code) | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| E-01 | Info | The host's firewall answers some requests itself (SQL-like search text, bursts) | Not a defect | - | - | None |
| D-103 | Medium | Signed-in desktop header: the search box collapses to 0 px and 'Search by voice' covers the Shops link | Fixed - awaiting retest | Yes (#254) | No | Re-test on test.gokesari.com, then release to main |
| D-104 | Low | Shop owner menu links to the public page of a shop that is not approved yet | Fixed (re-test pending) | Yes | Yes | Re-test (fix is live on both sites) |
| E-02 | High | gokesari.com stopped answering for about 14 minutes after two overlapping deploys | Open (owner decision) | - | - | Owner: one deploy at a time + site check after each release |
| D-105 | Medium | Voucher Excel upload accepted an end date that has already passed (also yesterday, from 00:00 to 05:30 IST) | Fixed (re-test pending) | Yes (#251) | No | Re-test on test.gokesari.com, then release to main |

Fixed and re-test passed (74): D-01, D-02, D-03, D-04, D-05, D-06, D-09, D-10, D-12, D-13, D-14, D-17, D-18, D-19, D-21, D-22, D-24, D-26, D-27, D-28, D-31, D-33, D-34, D-35, D-37, D-38, D-39, D-41, D-42, D-43, D-44, D-45, D-47, D-49, D-50, D-51, D-52, D-55, D-58, D-59, D-60, D-61, D-62, D-63, D-64, D-65, D-66, D-67, D-68, D-71, D-72, D-73, D-74, D-76, D-77, D-79, D-80, D-81, D-82, D-83, D-84, D-85, D-86, D-87, D-88, D-89, D-90, D-93, D-94, D-97, D-98, D-99, D-101, D-102.

## 4. Known gaps GAP-001 to GAP-019

| ID | Area | Item | 21 Oct status | 25 Oct status | In staging | In main | Fixed / built in | Next step |
|---|---|---|---|---|---|---|---|---|
| GAP-001 | Delivery | Pickup QR code | Completed, off | Completed, off | Yes | Yes | #190, #194 | Owner: set PICKUP_QR_SECRET and switch on |
| GAP-002 | Delivery | In-app turn-by-turn navigation | Completed, off | Completed, off | Yes | Yes | #190, #194 | Owner: routing provider, switch on |
| GAP-003 | Delivery | Signature capture at delivery | Yet to start | Deferred to Phase 2 | No | No | - | Phase 2 (owner decision) |
| GAP-004 | Delivery | Broadcast job offers / radius widening | Completed, off | Completed, off | Yes | Yes | #190, #194 | Owner: switch on (needs timeout-sweep cron) |
| GAP-005 | Finance | Automated bank transfer (settlements, payouts) | Completed, off | Completed, off | Yes | Yes | #190, #194 | Owner: payout keys (RazorpayX / Cashfree) |
| GAP-006 | Finance | Platform tax invoice for GoKesari's own fees | Completed, off | Completed, off | Yes | Yes | #190, #194 | Owner: GSTIN, legal details, prefix; CA rates |
| GAP-007 | Orders | Customer Cancel button on My Orders | Completed, live | Completed, live | Yes | Yes | #122, #123 | None |
| GAP-008 | Location | Map 'Confirm location' 500 on test | Blocked | Blocked | - | - | - | Owner: Maps server key restriction (IP, not referrer) |
| GAP-009 | Notifications | Email sending capacity | Yet to start | Open (owner) | - | - | - | Owner: email provider / higher limit |
| GAP-010 | Performance | Slow signed-in pages, cold first visits | Blocked | Blocked | - | - | - | Owner: hosting / database region |
| GAP-011 | Search | Search shows '0 shops' for products nearby shops sell | Yet to start | Fixed, re-test pending | Yes | No | #250 | Re-test on test, release |
| GAP-012 | Disputes | Admin dispute resolution: no confirmation | Yet to start | Fixed, re-test pending | Yes | No | #250 | Re-test on test, release |
| GAP-013 | Returns | Staff cannot complete a return waiting for a rider | Yet to start | Open (owner) | No | No | - | Owner: business rule |
| GAP-014 | Orders | /orders?tab=returns shows the Active list | Yet to start | Fixed, re-test pending | Yes | No | #250 | Re-test on test, release |
| GAP-015 | Navigation / UX | Hindi / Marathi for inner page bodies | Yet to start | Open (owner) | No | No | - | Owner: translate? (needs native review) |
| GAP-016 | Platform | Drizzle bare-id subquery bug (integrations 'listed') | Yet to start | Fixed, re-test pending | Yes | No | #250 | Re-test on test, release |
| GAP-017 | Platform | React #418 hydration (and UTC times on server pages) | Yet to start | Fixed, re-test pending | Yes | No | #250 (2 pages), #251 (every date) | Re-test on test, release |
| GAP-018 | Orders | My Orders wording after switch to pickup | Yet to start | Fixed, re-test pending | Yes | No | #250 | Re-test on test, release |
| GAP-019 | Checkout | Wallet checkout 30-38 s on test | Yet to start | Fixed in part, re-test pending | Yes | No | #250 (54 -> 46 queries) | Re-time on test; rest depends on GAP-010 |

## 5. PR gaps between staging and main

| PR | Title | From -> to | State | In staging | In main | Migrations | Gap / action |
|---|---|---|---|---|---|---|---|
| #250 | Fix the seven open bugs (GAP-011 to GAP-019) | peaceful-pascal -> staging | Merged 25 Oct 02:09 UTC | Yes | No | - | Release to main |
| #251 | Dates in India time everywhere + voucher upload past end date (D-105) | laughing-brown -> staging | Merged 25 Oct 04:27 UTC | Yes | No | - | Release to main (staging CI on the merge still running) |
| #252 | QA: staging re-tests of cart and checkout races passed (D-102) | serene-curie -> staging | Merged 25 Oct 02:18 UTC | Yes | No | - | Release to main (docs) |
| #253 | QA 25 Oct: production retest after #248; incident note E-02 | hopeful-cerf -> staging | Merged 25 Oct 03:27 UTC | Yes | No | - | Release to main (docs) |
| #254 | Owner decisions: D-103, D-57, D-91, D-25, D-96, D-23, D-69 | peaceful-pascal -> staging | Merged 25 Oct 03:58 UTC | Yes | No | 0092, 0093 (core), 0094 (seller) | Migrations on test with the deploy; on production in an approved window |
| #223 | Feature status report 21 Oct (merged straight into main) | peaceful-pascal -> main | Merged 24 Oct 22:02 UTC | No | Yes | - | Bring main back into staging (docs) |
| #255 | Add Driving Simulator placeholder page (+ Android app link) | festive-ride -> main | Open, draft | No | No | - | Goes to main directly, skipping staging and test.gokesari.com. Owner: confirm it belongs on GoKesari; if so, retarget to staging |
| (none) | Release staging -> main | staging -> main | Not opened | - | - | 0092-0094 | Open one release PR after the test-site re-tests |

## 6. Branches

| Branch | Commits not in staging | Last commit | PR | Verdict |
|---|---|---|---|---|
| claude/festive-ride-udspyl | 2 (+2 from main) | 25 Oct | #255 open (to main) | Active - see PR #255 |
| claude/trusting-allen-97xhex | 1 | 19 Oct | #212 closed | Superseded by #211. Safe to delete |
| claude/serene-gates-7cymxj | 2 | 9 Oct | #121 squash-merged | Already in staging. Safe to delete |
| claude/tile-board-ui | 1 (WIP) | 9 Oct | none | Superseded by the shipped Tile Board. Safe to delete |
| claude/awesome-dijkstra-fmccpl | 18 | 3 Oct | #26 closed | Abandoned MySQL port. Delete or keep as archive |
| claude/amazing-cannon-5n3fro | 1 | 2 Oct | #27 closed | Old docs fix. Check, then delete |
| (owner's Mac) claude/permissions-allowlist | ? | 25 Oct | none | Still not on GitHub: .claude/settings.json allowlist yet to commit |

## 7. Sessions

| Session | Status | Last update (UTC) | Branch / PR | Waiting on | Suggested action |
|---|---|---|---|---|---|
| Pin India time in all client-side date formatting (this session) | Running | 25 Oct 05:00 | #251 merged | - | This report |
| Feature status review and update #PR250+ | Idle | 25 Oct 03:22 | #250, #254 merged | - | D-95 follow-up PR is next there |
| Fix cart add race (D-99) | Idle - review ready | 25 Oct 04:22 | #252 merged | Its scheduled TC-FLD-114 re-test (19:00 UTC today) | Let it run once #251 is on test.gokesari.com |
| Gokesari.com test automation | Idle - done | 25 Oct 03:27 | #253 merged | - | Archive, or use it for the staging re-test run |
| Seamless deployment approvals (several projects; GoKesari part = PR #255) | Idle - needs input | 25 Oct 04:51 | #255 open (to main) | You: decide on PR #255 | Decide; retarget to staging if kept |
| Frequent "allow once" prompts | Archived | 25 Oct 03:40 | Mac: claude/permissions-allowlist | You: run the commit on the Mac | Still not on GitHub |
| PostgreSQL frequent downtime | Idle - needs input | 24 Oct 21:30 | no code | You: which site, what 'down' looks like | Answer it |
| Hostinger plugin installation (20 Oct) | Idle - needs input | 20 Oct 19:08 | no code | settings.json approval | Superseded; archive |
| Inventory & Accounting module for shop owners | Idle - needs input | 15 Oct 18:27 | released (#179) | An open question | Read and answer, or archive |
| GitHub billing messages issue | Idle - needs input | 11 Oct 02:39 | - | PROD_DATABASE_URL / prod DB password | Confirm done, archive |
| Older GoKesari sessions 28 Sep - 14 Oct with open questions (crons, Maps key, domain access, db:migrate, mobile, Turbopack, Mac spreadsheets) | Idle | 28 Sep - 14 Oct | merged or no code | Old questions | Very likely overtaken; check, then archive. Decide on the Mac spreadsheets |
| About 30 other GoKesari sessions 6-24 Oct | Idle - done | 6-24 Oct | PRs merged | - | Nothing pending; archive |

## Next steps

1. Wait for staging CI on #251's merge (running), then check test.gokesari.com rebuilt and ran migrations 0092-0094.
2. Re-test on test.gokesari.com: the 8 defects fixed only in staging (D-23, D-25, D-57, D-69, D-91, D-96, D-103, D-105), GAP-011/012/014/016/017/018/019, and TC-CART-001.
3. Re-test on gokesari.com the 21 defects already live there but marked 're-test pending' (D-07 ... D-104).
4. Open one release PR staging -> main (#250-#254). Production migrations 0092-0094 in an owner-approved window; one deploy at a time (E-02).
5. Bring main's 21 Oct status report (#223) back into staging.
6. Decide PR #255 (Driving Simulator page): it targets main directly and is outside the staging -> test -> main flow.
7. Owner decisions still open: E-02 (release process), D-95 (follow-up PR coming), GAP-008/009/010/013/015; Phase 2: GAP-003.
8. On the Mac: commit the .claude/settings.json allowlist; decide on the GoKesari spreadsheets (1 Oct session).
9. Delete the 5 stale branches; archive finished sessions.

## Notes

- Scope: GoKesari only. Sessions for Ladwani, Education, ATIP and Bkesari are left out (CLAUDE.md).
- Defect source: docs/testing/qa-defects.json on staging (107 entries) and on main (105). Fixes and their log entries ride in the same PRs, so a fix is on main when main's copy marks it fixed.
- GAP items: Feature Register of GOKESARI_FEATURE_STATUS_REPORT_2026-10-21.xlsx, updated with #250 and #251.
- Which build each site actually serves is not checked: no version endpoint, and the Hostinger connector needs authorising in claude.ai connector settings.
