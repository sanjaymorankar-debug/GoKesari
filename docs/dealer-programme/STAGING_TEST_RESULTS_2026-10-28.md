# Dealer Programme — staging test pass (step 10), 28 Oct 2026

- **Site:** test.gokesari.com only (production touched once, read-only, guest, one GET — see §F).
- **When:** 28 Oct 2026, 22:02–22:30 IST (16:32–17:00 UTC).
- **Build on staging:** branch `staging`, latest commit at test time `9e3e1b7`.
- **Tester:** QA agent (Claude), API calls (Node fetch) and headless Chromium (Playwright) with the saved staging sessions.
- **Evidence:** screenshots in `test-results/qa/artifacts/dealer-step10/` (git-ignored, on the machine that ran the test). Paths below are relative to the repository.

## Summary

| Area | PASS | FAIL | BLOCKED | Total |
|---|---|---|---|---|
| Setup (flags) | 1 | 0 | 0 | 1 |
| Step 1 — flags, geo areas | 5 | 0 | 1 | 6 |
| Step 2 — dealer application, approval, codes, employees | 3 | 1 | 4 | 8 |
| Step 3 — `?ref=` registration, attribution, leads, duplicates | 3 | 0 | 3 | 6 |
| Step 4 — instant approvals | 1 | 0 | 1 | 2 |
| Step 5 — commission, rating, payouts | 1 | 0 | 2 | 3 |
| Step 6 — dealer board, admin dealer list | 1 | 0 | 2 | 3 |
| Step 7 — support services | 1 | 0 | 6 | 7 |
| Step 8 — coverage & analytics | 3 | 0 | 1 | 4 |
| Flags OFF | 1 | 0 | 1 | 2 |
| Phone width (375 px) | 1 | 0 | 2 | 3 |
| **Total** | **21** | **1** | **23** | **45** |

**Why most of it is blocked:** only the **admin** staging session was signed in (`.e2e-auth/staging-admin.json`, valid to 27 Nov). The operator, shop-owner and customer sessions did not exist, and this test run had no Gmail access to read the emailed sign-in codes (skill `gokesari-qa-signin`). No codes were requested, so no sign-in limits were used. Every case that needs an operator, a dealer applicant, a dealer or a shop owner is BLOCKED. To unblock them: run `gokesari-qa-signin` from a session that has the Gmail connector for roles `ops,shop,customer` (plus a dealer-applicant account), then re-run the blocked rows.

**Second reason, approvals:** the QA rules for staging say "never approve or reject anything on staging" (those cases are local-tier). Approving a dealer at `/admin/dealers` (Step 2) therefore needs the owner's explicit go-ahead for staging, or has to run on the local tier. Instant approval (Step 4) is automatic, so that rule does not block it.

**Flags:** all four are **ON for Pune (MH-PUN) only** on test.gokesari.com and were **left ON** as instructed (§Setup). Production was not changed.

## Setup

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| S-1 Turn the 4 flags on for Pune | As admin, `PUT /api/admin/feature-flags` for each key: `{enabled:true, districtCodes:["MH-PUN"], reason:"Dealer programme step 10 staging test"}` | 200; flag on for MH-PUN; change logged with who/old/new/reason | All 4 → HTTP 200, `changed:true`, `lastChange` = admin e-mail, ADMIN, old `{enabled:false,districtCodes:null}`, new `{enabled:true,districtCodes:["MH-PUN"]}`, the reason. Change times 16:36:05–16:36:09 UTC. `/admin/feature-flags` shows "Now: On — Pune" | PASS | API responses; `admin-1280-_admin_feature_flags.png` |

## Step 1 — Feature flags and geo areas

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 1.1 Flags page for admin | Admin opens `/admin/feature-flags` (1280 and 375 px) | Page lists the 4 flags with state and district choice | HTTP 200, the 4 flags, "Every district / Chosen districts only", 36 districts; no page errors, no sideways overflow | PASS | `admin-1280-_admin_feature_flags.png`, `admin-375-_admin_feature_flags.png` |
| 1.2 Change is logged | `GET /api/admin/feature-flags` after S-1 | 4 entries in `changes` | 4 entries, one per flag, with reason and admin | PASS | API |
| 1.3 Operator refused | Operator opens `/admin/feature-flags` and `GET/PUT /api/admin/feature-flags` | Page refused; API 403 | Not run: no operator session | BLOCKED | — |
| 1.4 Guest refused | `GET /api/admin/feature-flags` with no session | 401 | HTTP 401 `UNAUTHENTICATED` | PASS | API |
| 1.5 Pune areas | Admin `GET /api/geo-areas?parent=MH-PUN`, `?level=DISTRICT`, `?pincode=411038` | Pune talukas; districts; PIN → area | Haveli, Pimpri-Chinchwad, Pune City (TALUKA); 36 Maharashtra districts; 411038 → Kothrud (LOCALITY) in district Pune (MH-PUN). Coverage data also lists 10 Pune localities (Viman Nagar, Hadapsar, Kothrud, Aundh, Baner, Shivajinagar, Chinchwad, Nigdi, Pimpri, Wakad/Hinjewadi) | PASS | API |
| 1.6 District limit applies | Admin opens `/dealer/apply` with the flag on for MH-PUN | Only Pune areas offered | "Where you will work": Pune (whole district), Haveli, Pimpri-Chinchwad, … — Pune only | PASS | `admin-1280-_dealer_apply.png` |

## Step 2 — Dealer application, approval, codes, employees

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 2.1 Application form | Open `/dealer/apply` signed in (admin, no dealer) | Form: business, dealer type, mobile, PAN/GSTIN/Shop Act, address, areas, documents | HTTP 200, all sections present; `GET /api/dealer/application` → `dealer:null`, document requirements per dealer type | PASS | `admin-1280-_dealer_apply.png` |
| 2.2 Submit an application with documents | Fill with fake test data, verify mobile, upload documents, submit | Application PENDING | Not run: needs a non-admin applicant account (applying from the admin account would make the admin a dealer), and mobile verification is by SMS OTP that this run cannot read | BLOCKED | — |
| 2.3 Admin approves at `/admin/dealers` | Admin opens the pending application, approves | Dealer APPROVED, decision logged | Not run: no application (2.2). Also: QA rule "no approvals on staging" needs owner go-ahead | BLOCKED | — |
| 2.4 Dealer code, share link, QR | Dealer opens `/dealer` | Code, `/shop/register?ref=CODE`, QR | Not run: no dealer | BLOCKED | — |
| 2.5 Employees with optional Employee ID | Dealer adds salespeople with and without Employee ID | Both saved; each gets a code | Not run: no dealer. (Read-only: the internal dealer "GoKesari Direct" in `GET /api/admin/dealers/{id}` lists migrated salespeople with `employeeId` e.g. `LEGACY-E2ETEST1` and their codes) | BLOCKED | API |
| 2.6 Dealer list filters | Admin opens `/admin/dealers` (Pending), `?status=APPROVED`, `?status=ALL` | Pending: none; Approved: GoKesari Direct; **All: every dealer** | Pending: "No dealers here." (correct); Approved: "GoKesari Direct · Company · internal · Approved" (correct); **All: "No dealers here."** — the All pill is highlighted but the page shows the Pending list | **FAIL — D-1** | `admin-1280-_admin_dealers_status_ALL.png`, `admin-1280-_admin_dealers_status_APPROVED.png` |
| 2.7 Document requirements editor | Admin, `/admin/dealers` | Matrix of document × dealer type | Shown (PAN, GST, Shop Act, address, bank proof, agreement × Individual / Proprietorship / Partnership / Company); API 200 | PASS | `admin-1280-_admin_dealers.png` |
| 2.8 Dealer APIs for a non-dealer | Admin `GET /api/dealer/code`, `/salespeople`, `/leads`, `/commission`, `/shops` | Refused | HTTP 404 "Dealer was not found." on all 5 | PASS | API |

## Step 3 — Shop registration through the `?ref=` link

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 3.1 Link pre-fills the code and shows Employee ID | Signed in (admin, no shop) open `/shop/register?ref=E2ETEST1` (existing migrated code; a new dealer's code was not available) — **form not submitted** | Referral code = E2ETEST1; "Employee ID or name (optional)" field shown | Referral code field value `E2ETEST1`; "Employee ID or name (optional) — If a GoKesari dealer's employee helped you, their ID or name, so their work is counted." visible, empty, at 1280 and 375 px | PASS | `admin-1280-register-ref-fields.png`, `admin-375-register-ref-fields.png` |
| 3.2 Guest opens the link | No session, `/shop/register?ref=E2ETEST1` | Sign-in, then back to the link with the code | Redirected to `/signin?callbackUrl=%2Fshop%2Fregister%3Fref%3DE2ETEST1` (code kept in the return address) | PASS | `none-1280-_shop_register_ref_E2ETEST1.png` |
| 3.3 Attribution shown to the dealer | Shop owner registers with the dealer's link; dealer opens `/dealer` | Shop listed under the dealer (and employee) | Not run: no shop-owner session, no dealer | BLOCKED | — |
| 3.4 Leads | Dealer adds a lead, follows it | Lead saved and listed | Not run: no dealer | BLOCKED | — |
| 3.5 Duplicate warning | Dealer adds a lead / assisted shop with an existing shop's mobile | Duplicate warning | Not run: no dealer | BLOCKED | — |
| 3.6 Claims page | Admin `/admin/dealers/claims`; `GET /api/admin/dealer-disputes` | Loads | "No claims."; API 200 `{"disputes":[]}` | PASS | `admin-1280-_admin_dealers_claims.png` |

Observation (not dealer programme): on `/shop/register` the map box says "Oops! Something went wrong. This page didn't load Google Maps correctly." in headless Chromium on staging. Probably the staging Maps key's referrer/headless limits; check in a normal browser.

## Step 4 — Instant approvals

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 4.1 Instant approvals page | Admin → Shops → Instant approvals (`/admin/shops/instant-approvals`), 1280 and 375 px; `GET /api/admin/shops/auto-approved` | Loads with All / Approved / Waiting / Suspensions | HTTP 200, explanation text, the 4 filters, "Nothing yet."; API 200 `{"shops":[]}` | PASS | `admin-1280-_admin_shops_instant_approvals.png`, `admin-375-_admin_shops_instant_approvals.png` |
| 4.2 Verified GST/PAN + Shop Act + gateway fee → instant approval | Shop owner in Pune registers with GST/PAN verified and Shop Act, pays the fee online | Approved with no admin step; e-mail | Not run: no shop-owner session; the gateway step needs **Cashfree sandbox via the "Sandbox payment" workflow** (`.github/workflows/sandbox-pay.yml`). No card or UPI data used | BLOCKED | — |

## Step 5 — Commission, rating and payouts

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 5.1 Rules visible to admin | Admin → Dealers → Commission, rating & payouts (`/admin/dealers/commission`); `GET /api/admin/dealer-commission` | Rules, settings, slabs, ledger | Rules v1 from 2026-10-28, every district, standard shops: Registration completed ₹100, Verified + catalogue ₹150, Activated ₹150; per-shop cap ₹999; catalogue minimum 10 products; rating slabs 0→5.0, 200→5.5, 250→6.0, 500→…; tabs Rules / Settings / Rating slabs / Ledger & payouts. 1280 and 375 px | PASS | `admin-1280-_admin_dealers_commission.png`, `admin-375-_admin_dealers_commission.png` |
| 5.2 Operator cannot change rules | Operator `PUT/POST /api/admin/dealer-commission` | 403 | Not run: no operator session (a guest gets 401) | BLOCKED | — |
| 5.3 Dealer sees own commission and rating | Dealer opens `/dealer` | Rating and commission shown | Not run: no dealer | BLOCKED | — |

## Step 6 — Dealer board and admin dealer list

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 6.1 `/dealer` board | Dealer opens `/dealer` | Tiles, pending, performance by day/week/month, employees, areas | Not run: no dealer | BLOCKED | — |
| 6.2 Admin list with rating / shops / commission | Admin `/admin/dealers?status=APPROVED` | Each external dealer: ★ rating · shops (live) · ₹ earned | Only the internal dealer exists, and stats are hidden for internal dealers by design; no external approved dealer to check | BLOCKED | `admin-1280-_admin_dealers_status_APPROVED.png` |
| 6.3 Non-dealer at `/dealer` | Admin (no dealer) opens `/dealer` | Sent to the application | Redirected to `/dealer/apply` | PASS | `admin-1280-_dealer.png` |

## Step 7 — Support services

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 7.1 Shop page with 3 services and prices | Shop owner opens `/shop/support-services` | General support (free), Product upload, Price update with prices | Not run: no shop-owner session (admin, who has no shop, is sent to `/shop` "You haven't registered a shop yet") | BLOCKED | `admin-1280-_shop_support_services.png` |
| 7.2 Live price for 120 products = ₹1,766.46 | Shop owner, Product upload, quantity 120 | ₹1,766.46 | Not run (the quote API allows only the shop owner or its dealer). The charge on staging is ₹499 per batch of 50, GST 18% → 3 batches = ₹1,497 + ₹269.46 = ₹1,766.46, so the configured charge matches the expected price; the screen was not seen | BLOCKED | `GET /api/admin/support-services` |
| 7.3 Free General support → ticket | Shop owner requests General support | Request + help-desk ticket | Not run | BLOCKED | — |
| 7.4 Priced request, pay from shop wallet | Credit the test shop wallet (Admin → Shop wallets), request, "Pay from shop wallet" | Paid + ticket | Not run: no shop-owner session (wallet not credited) | BLOCKED | — |
| 7.5 Cancel before work → refund | Cancel the paid request | Refund at 100 % (setting `refundPercentBeforeWork: 100`) | Not run | BLOCKED | — |
| 7.6 Admin page: charges editor and report | Admin `/admin/support-services` (1280, 375 px); `GET /api/admin/support-services` | Report by service, charges editor per service | Report table (3 services, 0 paid requests, ₹0.00); editor per service: version 1 from 2026-10-28, Free / Per request / Per item / Per batch, amount, items per batch, GST %, free requests per month, effective from, reason. Charges: General FREE; Product upload ₹499 / 50, GST 18 %, 0 free; Price update ₹199 / 50, GST 18 %, 1 free per month. Free for managed-billing shops: on | PASS | `admin-1280-_admin_support_services.png`, `admin-375-_admin_support_services.png` |
| 7.7 Online payment | Pay a support request online | Paid via gateway | Not run: needs **Cashfree sandbox via the "Sandbox payment" workflow** and a shop-owner session | BLOCKED | — |

## Step 8 — Coverage and analytics

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| 8.1 Three tabs load | Admin `/admin/dealers/analytics`: Coverage, Performance score, Activation & 30-day activity (1280 and 375 px) | Each loads | Coverage: map + table, "Maharashtra: 30 shops (0 through dealers), 2 operational, 0 active dealers"; Pune district 30 shops, 28 not operational, "No dealer". Performance: weights 35/20/20/15/10, GoKesari Direct rank 1/1 score 0. Activation: "No shops brought by dealers yet." No page errors | PASS | `admin-1280-analytics-*.png`, `admin-375-analytics-*.png` |
| 8.2 Admin sets an area target | `POST /api/admin/dealer-analytics {areaCode:"MH-PUN-PCMC-WAKAD", targetShops:25}`; read back; then invalid and unknown inputs; then remove | Saved and shown; bad input refused | 200 `saved:true`, coverage row shows `target:25`; `targetShops:-5` → 422 "Target: 0 to 100,000 shops."; `areaCode:"NOPE"` → 404 "Area was not found."; `targetShops:null` → 200, target back to null | PASS | API |
| 8.3 Operator can view, not set | Operator GET (200) and POST (403) | 200 / 403 | Not run: no operator session | BLOCKED | — |
| 8.4 Guest refused | `GET /api/admin/dealer-analytics` without a session | 401 | HTTP 401 | PASS | API |

## F — Behaviour with the flags OFF

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| F.1 Staging with flags off (before S-1) | Admin `GET /api/admin/dealer-analytics`, `/api/admin/dealers`, `/api/admin/support-services`, `/api/admin/dealer-commission` | 404 `FEATURE_NOT_AVAILABLE` | All 4 → HTTP 404 `{"code":"NOT_FOUND","message":"This feature is not available.","details":{"reason":"FEATURE_NOT_AVAILABLE"…}}` | PASS | API, 16:35 UTC |
| F.2 Production, read-only | Guest `GET https://gokesari.com/api/admin/dealer-analytics` (no sign-in, nothing changed) | 404 `FEATURE_NOT_AVAILABLE` | HTTP 404 but the site's **HTML not-found page**, not the JSON error: the dealer programme code is not on production yet (step 10 release to `main` pending). Not a defect; re-run after the production release | BLOCKED (not deployed) | API |

## Phone width (375 px)

| Case | Steps | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| P.1 `/dealer` | Dealer at 375 px | Readable, no sideways scroll | Not run: no dealer | BLOCKED | — |
| P.2 `/shop/support-services` | Shop owner at 375 px | Readable, no sideways scroll | Not run: no shop-owner session | BLOCKED | — |
| P.3 `/admin/dealers/analytics` | Admin at 375 px, all 3 tabs | Readable, no sideways page scroll | Page width = viewport (0 px overflow) on all 3 tabs; tables scroll sideways inside their box (`overflow-x-auto`, `min-w-[640px]`). Also checked at 375 px with no overflow: `/admin/feature-flags`, `/admin/dealers/commission`, `/admin/support-services`, `/admin/shops/instant-approvals`, `/shop/register?ref=…` | PASS | `admin-375-analytics-Coverage.png` etc. |

Observation on P.3: at 375 px the coverage table's visible part ends inside the "Shops" column (headers read "DealersSho"); Target, Not operational and Status are reached only by swiping the table, with no visual hint. Usable, but worth a hint or a stacked layout.

## Defects

### D-1 — Admin → Dealers, "All" filter shows only pending dealers

- **Where:** `/admin/dealers?status=ALL` on test.gokesari.com (dealer programme on).
- **Reproduce:** sign in as admin → Admin → Shops → Dealers → click **All**.
- **Expected:** every dealer, highest rating first (the page's own comment: "Approved / all: highest rating first").
- **Actual:** "No dealers here." with the All pill highlighted; `?status=APPROVED` on the same data shows "GoKesari Direct · Company · internal · Approved".
- **Cause (code read, not fixed):** `src/app/admin/dealers/page.tsx` line 34 accepts only values in `DEALER_STATUSES` (`DRAFT…TERMINATED`, no `ALL`), so `status=ALL` falls back to `"PENDING"` before `listDealers` is called; `listDealers` itself handles `"ALL"`.
  ```ts
  const status = (DEALER_STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as DealerStatus) : "PENDING";
  ```
- **Evidence:** `test-results/qa/artifacts/dealer-step10/admin-1280-_admin_dealers_status_ALL.png`.
- **Severity:** medium (admin can't see the full dealer list or the cross-dealer rating ranking in one place).

## What this run created or changed on staging (for clean-up)

| Item | Detail | State now |
|---|---|---|
| Feature flags | `dealer_programme_enabled`, `gov_verification_auto_approval_enabled`, `dealer_rating_bonus_enabled`, `paid_support_services_enabled` → ON, districts `["MH-PUN"]`, reason "Dealer programme step 10 staging test", by sanjaymorankar+gk-admin@gmail.com, 16:36:05–16:36:09 UTC | **Left ON (Pune only)** as instructed. To undo: `/admin/feature-flags` → Switch off each, with a reason |
| Area target | `MH-PUN-PCMC-WAKAD` (Wakad / Hinjewadi) target 25, note "Dealer programme step 10 staging test", then removed (target null) | Removed; the set/remove may appear in the area-target log |
| Accounts, dealers, shops, codes, leads, support requests, wallet credits, payments | none | nothing to clean up |

No sign-in codes were requested. Production was not changed (one guest GET).

## To finish step 10

1. Sign in `ops`, `shop`, `customer` with `gokesari-qa-signin` from a session with Gmail access; arrange a dealer-applicant test account (a new `sanjaymorankar+gk-*` alias, owner approval) and how its mobile OTP is read.
2. Get the owner's go-ahead for approving the test dealer on staging (QA rule: no approvals on staging), or run 2.3 on the local tier.
3. Run the payment cases (4.2, 7.7) through the "Sandbox payment" workflow with Cashfree sandbox data only.
4. Fix D-1, re-run 2.6 and 6.2.
5. After the production release, re-run F.2 (expect the JSON `FEATURE_NOT_AVAILABLE`).

---

## Second pass — 28 Oct 2026, 16:50–17:25 UTC

The operator, shop-owner and both customer test accounts were signed in with their e-mailed codes
(owner's mailbox, sign-in messages only). One customer account applied as a dealer; the other was
the owner in a dealer-assisted registration. Payments used the test site's own sandbox gateway
("Test payment page — no money moves"); no card, UPI or bank details were entered anywhere.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1.3 | Operator refused on feature flags | PASS | `PUT /api/admin/feature-flags` 403; `/admin/feature-flags` redirects home |
| 5.2 | Operator refused on commission rules | PASS | `POST /api/admin/dealer-commission` 403 |
| 8.3 | Operator reads analytics, cannot set a target | PASS | `GET` 200; `POST /api/admin/dealer-analytics` 403 |
| 2.2 | Dealer application with documents | PASS | Individual type; PAN, address and bank proof uploaded; submitted with agreement 2026-10-28 |
| 2.3 | Admin approval | PASS | Documents accepted; approved with mobile confirmed by call and bank verified by document |
| 2.4 | Code, share link, QR | PASS | `GKS-MH-PUN-EZJTJG`, `/shop/register?ref=GKS-MH-PUN-EZJTJG`, QR SVG, WhatsApp link |
| 2.5 | Employee with Employee ID | PASS | E01 "QA Field Employee", code `GKS-FE-WD6WN9` |
| 3.4 | Lead with owner consent | PASS | Open until 27 Nov (30 days) |
| SH-002 | Dealer-assisted registration | PASS | Owner code e-mailed (SMS not set up on staging), confirmed, shop BKS-000032 registered |
| 3.3 | Attribution shown to the dealer | PASS | Source DEALER_ASSISTED, employee "QA Field Employee", no duplicate flag |
| 6.1 | Dealer board | PASS | `/dealer` 200, Support services link per shop |
| 5.3 | Dealer sees rates, commission, statement | PASS | Rates ₹100 / ₹150 / ₹150; statement CSV downloads |
| 7.1 | Shop page with three services | PASS | `/shop/support-services` 200 for the shop owner |
| 7.2 | Price for 120 products | PASS | ₹1,766.46 (3 × ₹499 + 18% GST) |
| 7.3 | Free general support opens a ticket | PASS | Paid (free), ticket TKT-000003 |
| 7.4 | Priced request paid from the wallet | PASS | First 402 with shortfall ₹588.82; after a ₹600 test credit: paid, ticket TKT-000004 |
| 7.5 | Cancel before work → refund | PASS | Refunded ₹588.82 to the wallet; ticket closed |
| 7.7 | Online payment | PASS | Sandbox checkout "Pay (success)" → request paid online, ticket TKT-000005 |
| P.1 | `/dealer` at 375 px | PASS | No sideways scroll, no page errors |
| P.2 | `/shop/support-services` at 375 px | PASS | No sideways scroll, no page errors |
| 4.2 | Instant approval after a gateway-paid fee | **FAIL** | D-2 / D-3 below |
| CM-002 | Registration commission after the fee | **FAIL** | D-3 below |
| 3.5 | Duplicate warning | Not run on staging | Covered by automated tests (step 3) |

**D-2 (fixed in code, `3bf5a33`).** After the registration fee was paid through the gateway, the
step that runs the approval check and the dealer's commission was scheduled on a 2-second timer
after the capture transaction. On staging it never ran (no decision logged after the payment).
Capture follow-ups now run right after the commit, in the same request. New tests prove it locally
(`dealer-step4`, `dealer-step7`). Not yet re-tested on staging: the test shop's fee is already paid.

**D-3 (open).** For the same shop (BKS-000032: fee paid online, PAN and Shop Act verified by the
test provider, GST declaration accepted), a direct trigger — submitting a newly verified PAN — still
logged no new instant-approval decision and accrued no dealer commission. No error reaches the API
response. Finding the cause needs the staging server's logs (Hostinger).

**Also seen:** the dealer's ₹1 bank check stays "waiting" with Cashfree's sandbox test account
(1111222233 / TEST0001234). The dealer was approved with "bank verified by document".

**Created on staging in this pass (test data, clean up when done):** dealer "QA Staging Test Dealer"
(account `gk-cust`), employee E01, lead "QA Lead Kirana (staging)", shop BKS-000032
"QA Assisted Clothing (staging)" (owner `gk-lc14`, fee ₹1,178.82 paid in the sandbox), three support
requests on "E2E Referral MV2SJM8P-3" (one refunded), and a ₹600 test credit in that shop's wallet.

**Second pass totals:** 20 pass, 2 fail (D-2 fixed in code, D-3 open), 1 left to automated tests.

### D-3 resolved — same cause as D-2 (28 Oct, 17:14 UTC)

Read-only queries on the staging database (Neon project GoKesari-test-sg) showed:
- The fee was recorded online at 17:00:09.
- No approval decision was logged after 16:59:50.
- Every flag was on for Pune.

The approval check runs when a document's status **changes**. Both of the earlier re-triggers
re-verified documents that were already VERIFIED, so they did nothing. Moving the PAN to manual
review and back to verified (a real status change) ran the check at 17:14:02:
- **instant approval:** BKS-000032 APPROVED, decision logged with no reasons, lifecycle ACTIVE;
- **commission:** the dealer earned ₹100 (REGISTERED) and ₹150 (ACTIVATED); the shop counts as
  activated for the rating;
- **e-mail:** the owner received "Registration successful — QA Assisted Clothing (staging) is ready
  for product upload".

So the only fault was D-2: after a gateway payment, nothing re-ran the check. Fixed in `3bf5a33`.

| # | Case | Result |
|---|---|---|
| 4.2 | Instant approval with a gateway-paid fee | PASS once the check runs (D-2 fixed in code) |
| CM-002 | Registration and activation commission accrue | PASS (₹100 + ₹150 earned) |
| CM-003 | Live shop counts for the rating | PASS (activated 17:14:09) |
