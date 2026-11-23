# New features on test.gokesari.com, 20 to 23 Nov 2026: functions and test cases

Prepared 23-Nov-2026, 22.34 IST, from the code on `origin/staging` at d9cef71e (after PR #503).
These features reached staging after the manual test workbook of 20-Nov. None of their pull requests
added cases to the plan, so this update writes them.

## What changed

| | Before (20 to 22 Nov) | Now (23-Nov) |
|---|---|---|
| Test cases (`test-cases.xlsx`, `tests/qa/catalog/cases.json`) | 1,159 | **1,631** (+472) |
| Test scenarios (workbook) | 313 | **383** (+70) |
| End-to-end journeys | 52 (SC-01 … SC-52) | **63** (SC-53 … SC-63 added) |
| Features traced (workbook Traceability sheet) | 312 | **409** (+97) |
| Modules | 40 | **49** |
| Older cases corrected | | **36** (+ journey SC-39) |
| Manual test workbook | 1.1, `GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-20.xlsx` | **2.0**, `GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-23.xlsx` |
| Testing-team training deck | 1.0 (29 slides) | **2.0**, `GoKesari_Testing_Techniques_Training_v2.0_2026-11-23.pptx` (32 slides) |
| QA engagement hand-over deck (testing partner) | 1.0 (29 slides) | **2.0**, `GoKesari_QA_Engagement_Owner_Handover_v2.0_2026-11-23.pptx` (31 slides) |

The new cases split as 99 P0, 240 P1, 117 P2 and 16 P3. Every Expected result was written from the code on
staging: routes, labels, messages, HTTP codes and amounts. Where the code differs from the pull request or
the owner's brief, the case follows the code and the difference is listed in
[`code-check-2026-11-23.json`](code-check-2026-11-23.json) (75 notes; the main ones are below). Every
new ID is declared in `tests/qa/signed-in/features-2026-11-23.spec.ts` as manual (not automated yet), so the
suite's self-check TC-QA-001 still passes. The master register lists them as **Not run** until a run is
collected.

Other sessions already recorded 119 results for what these cases check: 45 Pass and 3 Fail on staging,
9 Pass on production, and 62 Pass from local runs. They are in
[`evidence-2026-11-23.json`](evidence-2026-11-23.json). The 3 staging Fails were fixed later: VP-19 by PR #496,
the logo card padding by #490, and the guest 404 on /wishlist by #484. They need a retest.

## The features and their functions

| Feature (pull requests) | What it does | Switch on staging | Cases |
|---|---|---|---|
| **Puja Samagri** (#427, #437) | Puja Samagri & Temple Supplies shop type: a 499-item catalogue in English, Hindi and Marathi, taken at stock 100; owner screens to browse, remove and restore items, and to add own types and products (with a duplicate check and a review queue); admin catalogue editing, CSV export and import, festival collections; `/puja` storefront and search; "price on confirmation"; Nearby puja filter; normal checkout | Admin → Puja Samagri → Configuration, ON | TC-PUJA-001 … 060 (55; 001–004 and 010–018 were already automated), SC-53 |
| **Admin menu** (#463, #464) | Categories now holds only Shop and Product. Consultants and Health leave the Shops menu. Shop categories gets a "Shop types with their own setup" strip (Puja, Consultants, Health) | no flag | TC-ADM-023 … 030 |
| **Banner wording** (#448) | The welcome-kit banner's third label is "Everything For Everyone, Everywhere" (Marathi / Hindi too); new Marathi ribbon | no flag | TC-WKIT-014 … 018 |
| **Mailbox rotation** (#451) | E-mail goes out from code1 … code10@gokesari.com in turn, 90 per mailbox per rolling 24 h; a refused mailbox rests 1 h | env `EMAIL_POOL`, set on both sites | TC-NTF-021 … 028 |
| **Shop documents and FSSAI** (#458, #460, #467, #471, #475, #477) | FSSAI must-have for food shops before payment and approval (DF-08). Other documents are on a 90-day promise, with reminders on the 1st / 15th and automatic suspension. Admin "Approve without documents" (30 days to upload). Admin uploads a document for the owner. Admin → Shops → Document rules: must-have / promise / optional per shop type, plus new documents the law needs (DF-09). Shops already live keep 90 days. FSSAI checked online with Cashfree. Every doctor category needs a medical registration (H-52) | business rules | TC-DOC-001 … 058, SC-54, SC-55 |
| **Health specialties** (#466) | All medical practitioners in Health groups; 18 specialties; grouped doctor search with plain-word specialties and symptom chips; Admin Health → Specialties tab | rules `health`, `consultBooking` | TC-HLT-033 … 045 |
| **Franchise zones** (#446, #465, #469, #476, #479) | /franchise page and 99 zones (Pune 50, Mumbai (Konkan) 38, Nashik 11) with a city prefix. ₹1,50,000 + GST launch fee (25 places), regular rate shown. Free dealership or paid franchise. Paid: 15-minute hold, at most 2 per zone, active on the gateway webhook, KYC within 30 days. Coupons. /franchise/my. Admin console (zone status, settings, suspend, terminate, refund). Commission: free 20/4/3; franchise 25% own + 4% / 3% up the team + 20% of GoKesari's 2% recurring with a bonus up to 5%. Territory = franchise. Dealer application verifies PAN, GSTIN and bank online | "Booking open" setting, ON | TC-FRN-001 … 070, SC-56, SC-57 |
| **Referral moves** (#470) | Admin adds or moves shops' referral codes (up to 50) or moves a member with his code and shops. Signed consent letters. A second admin approves. Earned commission stays with the old owner | `dealer_programme_enabled`, ON | TC-REFM-001 … 025, SC-58 |
| **Dealership platform** (#503) | Versioned schemes (Free v2, Business Partner, Growth Partner, Territory Franchise), /dealer/apply with scheme choice and joining charge (₹12,980 / ₹24,780), one-time and monthly commission by scheme, scheme builder with formulas and simulator, scheme questions, six new staff roles, four-eye approvals, dashboard | migration publishes the schemes; `dealer_platform_four_eye` OFF | TC-DPLT-001 … 060, SC-59 |
| **Smart shopping** (#482, #484) | Photo of a written list → wishlist → compare shops within 3 km → order; shop owner adds a product by photo and voice; orders reach the shop's WhatsApp with Accept / Reject | three flags OFF; AI key and WhatsApp keys not set (those cases are Blocked) | TC-SMART-001 … 040, SC-60 |
| **Voice price and offer assistant** (#491, #496, #497) | The owner says or types a product and a new price or offer; nothing changes until "yes"; warns about a big price rise; no offers on unpriced products | `voice_price_assistant_enabled` ON on staging, OFF on production | TC-VPA-001 … 025, SC-61 |
| **Shop logo** (#489, #490, #492) | The owner uploads or removes the shop logo (JPEG / PNG / WebP, up to 2 MB, 100–4,096 px; large photos are shrunk in the browser); customers see it on the shop card; reusable by the dealer module | `shop_logo_upload_enabled` ON on staging, OFF on production | TC-LOGO-001 … 012 |
| **Society join requests** (#498) | A rider asks to join a society's rider list; the society admin approves or declines | `society_rider_join_requests_enabled` OFF | TC-SOC-018 … 030 |
| **Staff roles, RBAC v2** (#485, #487, #493, #500) | Five staff roles and a /staff board, approval engine, two-admin approval, accounting (journals, rates, bank reconciliation), support desk with SLAs and teams, shop-owner change requests, staff documents, operations tasks and handover | six `rbac_v2_*` flags ON on staging since 23-Nov 18.00 IST, OFF on production | TC-STAFF-001 … 080, SC-62, SC-63 |

## Corrections to older cases (36)

- **TC-TERR-001, 002, 025** rewritten, and **TC-TERR-003 … 024, 026** retired (they start Not Applicable in the
  workbook). The owner's decision of 21-Nov is that a territory and a franchise are the same thing. The
  `territoryDealer` rule is off and Admin → Settings refuses it; each retired case names the franchise
  case that replaces it.
- **TC-ONB-061, 070, 080, 081, 082, 083**: FSSAI is now must-have for food shops (DF-08), so the old 90-day FSSAI
  grace (DI-14) no longer applies. **Journey SC-39** now uses a pharmacy, as its automated spec already does.
- **TC-CON-019, 020**: Consultants now open from Categories → Shop.
- **TC-CAT-093**: logo limits 2 MB / 100–4,096 px, not 5 MB.
- **TC-TIER-010**: a standard dealer created after migration 0179 is on Free v2 (20%), so the 40% check needs an
  older dealer.

## Where the code looks wrong: for the owner or the developers

These are not logged as defects until a test run confirms them. All 75 notes are in `code-check-2026-11-23.json`.

1. **Dealership platform (#503) is not "flags off".** Migration 0179 publishes the paid schemes at once, and new
   dealers start on Free v2. The new staff roles mostly cannot act from the website: approve / reject, month
   close and payouts stay admin-only. With four-eye on, the builder says "Published…" although nothing has
   changed yet. 12-month schemes have no renewal. Monthly commission ignores "own shops". Repeating charges
   are taken only once.
2. **Referral moves:** a moved team lead becomes an agent; a failed member-move approval can leave a half move.
3. **Shop documents:** the "shops already live" date also protects new shops (no suspension before
   20 Feb 2027 on staging). Waivers for non-FSSAI documents still name the FSSAI licence. A food shop can go
   live with an FSSAI number Cashfree reported invalid (owner to confirm against DF-08). Defect D-151
   should be closed as superseded.
4. **Franchise:** the recurring tail is 2 years in the settings but "end of year 3" in the rules text.
   Closed GKF- codes show the general "inactive" message. A refund leaves the KYC banner up. The overdue
   e-mail points to a Bookings tab that does not exist and goes only to the CEO address. Headers still
   say "Pune".
5. **RBAC v2:** the fixes in #493 / #500 for roles held as a grant did not reach the Staff teams list, the
   Operations "Assign to" picker or the Support Manager notices. The flag `rbac_v2_staff_roles` is never read.
   The price-list template can be downloaded for any shop. "Approved and applied." shows after the first of
   two approvals.
6. **Puja Samagri:** retiring or merging a master product hides every shop's listing of it. Operators
   can change the Puja configuration. The mailbox-send table is never purged (the hourly cron does not
   call the purge).
7. **Smart shopping and society joins:** some routes still answer while their flag is off. Wishlist items
   are never marked "Ordered".

## Files

| File | Where |
|---|---|
| Test plan | `test-cases.xlsx` (repository); owner's dated copy `GoKesari_Test_Cases_2026-11-23.xlsx` |
| Cases added | `docs/testing/manual/cases-added-2026-11-23.json` |
| Master test register | `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx` |
| Manual test workbook 2.0 | `docs/testing/manual/GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-23.xlsx` (versions in `revisions.json`) |
| Training deck 2.0 and hand-over deck 2.0, and how they are built | `docs/testing/manual/deck/` |
| Owner's copies | `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/` |
