# Tile Board UI pass — test results (test.gokesari.com, 9 Oct 2026)

Companion to `UI_PASS_2026-10-09.md`. Full tables (every link, access case, Lighthouse run and page measurement) are in `GoKesari_UI_Test_Report_2026-10-09.xlsx`; screenshots are in the deliverables folder (`test-evidence/`).

## Counts

| Role / suite | Run | Pass | Fail | Not run |
|---|---|---|---|---|
| Customer · end-to-end (B, D) | 18 | 16 | 1 | 1 |
| Shop owner · end-to-end (B, D) | 21 | 17 | 2 | 2 |
| Operator · end-to-end (B, D) | 8 | 6 | 1 | 1 |
| Admin · end-to-end (B, D) | 10 | 9 | 1 | 0 |
| Customer · A Navigation | 93 | 93 | 0 | 0 |
| ShopOwner · A Navigation | 168 | 167 | 1 | 0 |
| Admin · A Navigation | 228 | 228 | 0 | 0 |
| Operator · A Navigation | 168 | 168 | 0 | 0 |
| Visitor · A Navigation | 34 | 34 | 0 | 0 |
| Visitor · E Access | 30 | 30 | 0 | 0 |
| Customer · E Access | 28 | 28 | 0 | 0 |
| ShopOwner · E Access | 16 | 16 | 0 | 0 |
| Operator · E Access | 24 | 24 | 0 | 0 |
| Admin · E Access | 12 | 12 | 0 | 0 |
| All · D Lighthouse | 15 | 14 | 1 | 0 |
| Visitor · Fit role homes | 33 | 33 | 0 | 0 |
| Customer · Fit role homes | 33 | 33 | 0 | 0 |
| ShopOwner · Fit role homes | 33 | 32 | 1 | 0 |
| Admin · Fit role homes | 33 | 33 | 0 | 0 |
| Operator · Fit role homes | 33 | 33 | 0 | 0 |
| Total | 1038 | 1026 | 8 | 4 |

## End-to-end tests (B), app (D) and slow network (D)

| ID | Role | Test | Steps | Expected | Actual | Result | Screenshot |
|---|---|---|---|---|---|---|---|
| C-01 | Customer | Top up the wallet (Cashfree sandbox, UPI testsuccess@gocash) | Wallet › Add money → 500 → Proceed to payment → pay the sandbox session (Sandbox payment workflow) → site verifies | Balance +₹500 | Not completed: the wallet screen created the Cashfree sandbox session (session_iPGj…), but GitHub Actions did not start the Sandbox payment job (run 37973592123: “recent account payments have failed or your spending limit needs to be increased”). This session cannot reach Cashfree itself | NOT RUN | C-01-wallet-topup.png |
| C-02 | Customer | Search from the board (phone) | Home board → type 'bread' in the search box → Enter | Search results list matching products with prices | /search?q=bread: 14 product cards | PASS | C-02-search.png |
| C-03 | Customer | Categories → category page (phone) | Board › Categories (see all) → type 'Bak' → tap Bakery | Category page with products | /category/BAKERY: 60 products | PASS | C-03-category.png |
| C-04 | Customer | Shops tile → shop page shows products first | Board › Shops → open 'E2E Four Features Bakery' | Shop page: delivery line, info folded, product cards on the first screen | first product card at y=571 px (screen 800); shop info folded: true | PASS | C-04-shop-page.png |
| C-05 | Customer | Add to cart (phone card: Add, then −/+) | Shop page → 'Burger Bun' → Add to cart | Card switches to the −/+ stepper with 1; cart has Burger Bun | stepper shown; cart: Burger Bun×1 | PASS | C-05-added.png |
| C-15 | Customer | Accepted order: Cancel follows the business rule | Orders › Active → DB-20261008-8QZBEQ (ACCEPTED) | Rule cancellation = CONFIRMED on test.gokesari.com: no Cancel button once the shop has accepted (server refuses too) | order shown: true; Cancel button: 0; direct API cancel → 409 {"error":{"code":"CONFLICT","message":"This order is already being prepared. Please contact the shop to cancel it."}} | PASS | C-15-accepted-no-cancel.png |
| C-06 | Customer | Checkout (wallet, or cash on delivery when the wallet is short) | Cart bar → Cart → Pay from wallet (→ 'Ignore and continue' when an open order exists) | Order placed; Orders opens with the new order; wallet debited by the total | order DB-20261009-LSIMHV CONFIRMED (WALLET), total ₹50; wallet ₹80 → ₹30; URL /orders?placed=1 | PASS | C-06-order-placed.png |
| C-07 | Customer | Track an order from 'Do now' (phone) | Home board → Do now › Track order | My Orders › Active opens with the order on its way | Do now said "Track order ready · E2E Four Features Bakery" (→ /orders?tab=active#order-DB-20261008-8QZBEQ); landed on /orders?tab=active#order-DB-20261008-8QZBEQ with 1 active order card(s) | PASS | C-07-track.png |
| C-10 | Customer | Return an item from a delivered order | Orders › Past → DB-20261009-KLK7DD → Return items → reason Something else + note → Submit return request; then Orders › Returns tab (opens /returns) | Return request created and listed under Orders › Returns | RT-30B14E73 UNDER_REVIEW, refund due ₹40, created 19:41 UTC; listed on Returns tab: true | PASS | C-10-return.png |
| C-11 | Customer | Raise a dispute on a delivered order | Orders › Past → DB-20261008-NMBAE9 → Raise a dispute → reason, description, amount → submit | Dispute opened; dispute page shows it | opened /disputes/c8150aa7-282f-4c35-80d1-8ac0a90cfe65?opened=1 | PASS | C-11-dispute.png |
| C-12 | Customer | Report a problem (support ticket) | Orders › Past → DB-20261008-Q7CDEY → Report a problem → type → description → Send | Ticket number shown | Reported — ticket GRV-000002. We will get back to you. | PASS | C-12-ticket.png |
| C-13 | Customer | Set up a daily subscription (saved as a draft) | Shop page › Burger Bun › Subscribe → Save as draft — start later (a live one would order daily from the test shop) | Subscription created; Subscriptions lists it | /subscriptions/8e2cb590-4cac-45aa-9f40-25301a82de27; subscriptions: Burger Bun DRAFT | PASS | C-13-subscription.png |
| C-14 | Customer | Profile quick links and language switch (phone) | Board › Profile → quick links → language menu → हिं → back to EN | Profile shows its submenus at the top; header and board switch to Hindi and back | profile quick links: 5; board in Devanagari after हिं: true; cookie back to: en | PASS | C-14-hindi-board.png |
| S-07 | Shop owner | Update a price | My shop › Products (manage) → Butter Cookies → Edit → online price 60 → 62 → Save changes (then back to 60) | New price saved and shown; restored afterwards | saved ₹62; restored ₹60 | PASS | S-07-price.png |
| S-08 | Shop owner | Change stock | Same form → Online stock 100 → 90 → Save (then back to 100); Inventory tile shows the product | Stock saved; restored | saved 90; restored 100; inventory page /shop/inventory | PASS | S-08-inventory.png |
| S-09 | Shop owner | Add a product category (then remove it) | Board › Product categories → Add a category → choose → Add → Remove → Yes, remove | Category added to the shop and removed again | added "Dairy" → [Bakery, Dairy] (message: ""); after remove → [Bakery] | PASS | S-09-category.png |
| S-10 | Shop owner | Add a product photo | Board › Photo catalogue → search 'Butter Khari' → Add/Change photo → choose test-khari.png | Upload accepted; tile shows the photo (or 'awaiting review') | message ""; live photo not yet; listed under "Awaiting approval": true | PASS | S-10-photo.png |
| S-11 | Shop owner | Handle the customer return (approve) | Board › Returns (Requests tab) → RT-30B14E73 → Approve return | Return approved; rider pickup requested | Approved 19:47 UTC; status APPROVED, Pickup: finding a rider (shown to shop and operations) | PASS | S-11-return.png |
| S-12 | Shop owner | Reply to the customer's dispute | Board › Disputes (Open tab) → the dispute → write your side → Send | Reply saved on the case | /disputes/c8150aa7-282f-4c35-80d1-8ac0a90cfe65: reply shown true | PASS | S-12-dispute.png |
| S-14 | Shop owner | Payout bank account page | Board › Payout bank | Verified payout account shown (UPI, masked) | ttlements. Finance → Ramesh Joshi UPI ID te•••••••••@gocash Verified Verified on 9/10/2026 by UPI · name Ramesh Joshi · ref 1461 | PASS | S-14-bank.png |
| S-15 | Shop owner | Create an offer (then switch it off) | Board › Offers › New offer → title, one product (Butter Khari), 10 % off, today–tomorrow → Create offer → Switch off | Offer created and listed; switched off afterwards | created: true (10% on Butter Khari); switched off: true | PASS | S-15-offer.png |
| S-16 | Shop owner | Analytics | Board › Analytics | KPI dashboard with figures for the period | Analytics E2E Four Features Bakery — 2026-09-11 to 2026-10-11 (end exclusive). Last 7 days Last 30 days Last 90 days Orders KPI-001GMV deliv | PASS | S-16-analytics.png |
| S-17 | Shop owner | Legal documents | Board › Legal documents | Documents with state and expiry (FSSAI approved, to 31 Mar 2027) | ters are shown. Business verification → FSSAI licence Required for: Shops that sell food Approved Number ••••1234 Expires 31  | PASS | S-17-legal.png |
| O-07 | Operator | Returns queue (all returns, status filters) | Board › Orders › Returns | Every return listed with its status and actions | RT-30B14E73 listed (Approved, finding a rider) with Find a rider again / Cancel return; 13 status filters | PASS |  |
| S-11b | Shop owner | Return pickup, inspection and refund | Rider collects → shop Inspect goods → Accept — refund the customer | Customer refunded ₹40 to the wallet | Not tested: needs a delivery partner to accept and collect the pickup (manual completion is offered to staff only once a rider is on the way); no rider sign-in in this run | NOT RUN |  |
| A-02 | Admin | Suspend a shop, then reinstate it | Board › Shops › All shops → search E2E Four Features Stationery → Suspend… (impact on open orders shown) → reason → Suspend shop; then Reinstate → reason → Confirm | Shop SUSPENDED with the order impact shown, then APPROVED again | Suspended (row showed suspended + Reinstate); reinstated at 20:2x UTC → approved + Suspend… again | PASS | A-02-suspended.png |
| A-03 | Admin | Users and privileges: give a role, then take it back | Board › Users › Users (Shop owners) → E2E Doctor Kulkarni → Manage privileges → tick 'Delivery Partner held' → Save Changes → confirm 'Yes, save privileges' → reload → untick → Save Changes → confirm | A confirmation names the change; role added and saved; removed and saved | Save enabled after the change: true; saved on: true; removed again: true | PASS | A-03-privileges.png |
| A-04 | Admin | Categories and product master | Board › Product master › Categories; Product master › Products (dashboard) | Category tree listed; product master figures shown | categories page lists Bakery/Dairy: true; product master: 2164 products with quality figures (review queue, duplicates, missing data) | PASS | A-04-categories.png |
| A-05 | Admin | Payments menu: every page opens | Board › Payments → open each entry of the menu page | Every page loads without an error | 9 pages opened; errors: none | PASS | A-05-menu.png |
| A-07 | Admin | Reports menu: every page opens | Board › Reports → open each entry of the menu page | Every page loads without an error | 7 pages opened; errors: none | PASS | A-07-menu.png |
| A-08 | Admin | Settings menu: every page opens | Board › Settings → open each entry of the menu page | Every page loads without an error | 10 pages opened; errors: none | PASS | A-08-menu.png |
| A-06 | Admin | Resolve the customer's dispute | Board › Disputes → DSP-000001 (DB-20261008-NMBAE9) → Work case → Triaged → Resolution proposed (note) → Resolve: Refunded in full ₹60, borne by Platform → Resolve case | Dispute RESOLVED; customer refunded ₹60 to the wallet | DSP-000001 RESOLVED; customer wallet ₹20 → ₹80. The status changed a few seconds after the click; a repeat click was refused (409: order already refunded). Observation: the queue gave no visible confirmation within 5 s | PASS | A-06-dispute.png |
| O-02 | Operator | Approve a shop application | Board › Do now › Shop applications → E2E UI Pass Stationery 504466 → Approve | Shop approved | Not completed: the shop is KYC pending (PAN, GSTIN, Shop Act certificate not yet verified), so Approve is disabled with the reason “Only a verified shop can be approved” (correct, gate rule statusModels). Queue, stage filters, next-step text and the verification link were checked | NOT RUN | O-02-onboarding-queue.png |
| O-03 | Operator | Find and support a customer order | Board › Orders › Live orders → search DB-20261008-TRM5R5; Order support (exceptions) page | Order found with its status; exceptions queue opens | order DB-20261008-TRM5R5 found: true; exceptions page opens: true | PASS | O-03-order-support.png |
| O-04 | Operator | Riders and societies | Board › Riders → riders page; Board › Societies → societies page | Both pages list their records | riders page 256 chars ("Delivery partners Registered 0 Under review 0 Approved 1 Rej"); societies "Societies Verify new societies; suspend or reinstate existin" | PASS | O-04-riders.png |
| O-05 | Operator | Vouchers: list, bulk upload (create is admin-only) | Board › Vouchers | Voucher figures, list and the bulk upload are shown; no Create button (permission) | figures and list shown: true; upload shown: true; Create button: 0 | PASS | O-05-vouchers.png |
| O-06 | Operator | Ticket open → in progress → resolved → closed | Board › Tickets › Grievances → search GRV-000002 → View → Mark in progress → notes → Mark resolved → Close | Ticket ends CLOSED | states seen: OPEN → IN PROGRESS → RESOLVED → CLOSED | PASS | O-06-ticket.png |
| A-09 | Admin | Create a top-up voucher | Board › Payments › Vouchers → Create Voucher → name, code, 5 %, dates → Create voucher | Voucher listed | voucher E2EUI5003 listed: true | PASS | O-05-voucher.png |
| C-08 | Customer | Cancel a new order before the shop accepts it → full refund | Orders › Active → DB-20261009-LSIMHV (CONFIRMED, paid ₹50 from wallet) → Cancel order → Yes, cancel order | Order cancelled and refunded in full; moved to Past with a message | Status REFUNDED; wallet ₹30 → ₹80 (₹50 of ₹50); message: Order DB-20261009-LSIMHV cancelled — The full amount has gone back to your wallet | PASS | C-08-cancelled.png |
| S-02 | Shop owner | Reject a new order with a reason | Board › Orders (New tab) → DB-20261009-PKEFIF → Reject → reason “E2E UI pass: out of stock today” → Reject & refund | Order rejected; customer refunded in full | Status REFUNDED; customer wallet ₹30 → ₹80 (₹50 of ₹50); the server took ~5 s to apply it | PASS | S-02-reject.png |
| S-03 | Shop owner | Accept a new order | Orders (New tab) → DB-20261009-254Q4A → Accept order | Order ACCEPTED and listed under Packing | status ACCEPTED; on Packing tab: true | PASS | S-03-accepted.png |
| S-04 | Shop owner | Fulfilment option 1 — shop's own delivery | Packing tab → Start picking → 'Shop's own delivery', slot, Ravi Kumar E2E → Packed — mark ready → Ready tab → Out for delivery | Plan saved; order READY then OUT_FOR_DELIVERY | after plan: READY; after hand-over: OUT_FOR_DELIVERY | PASS | S-04-own-delivery.png |
| C-09 | Customer | Receive the order with the delivery code (OTP) | Customer: Orders › Active shows the delivery-code card; new code requested (API, as the card's button does) → shop: Out tab → enter code → Delivered | Wrong code refused; right code → DELIVERED | wrong code → still OUT_FOR_DELIVERY; right code → DELIVERED | PASS | C-09-customer-delivery-code.png |
| S-05 | Shop owner | Fulfilment option 2 — pickup from the shop (customer's pickup code) | Ready tab → DB-20261008-TRM5R5 (plan: Pickup from the shop) → wrong code, then the code the customer sees on My Orders → Customer collected | Wrong code refused; right code → DELIVERED | plan "Pickup from the shop · Fri 9 Oct, 10–11 am"; wrong code → still READY; customer's code → DELIVERED | PASS | S-05-pickup.png |
| S-06 | Shop owner | Fulfilment option 3 — GoKesari delivery partner | Packing tab → DB-20261008-8QZBEQ (accepted) → Start picking → 'GoKesari delivery partner' → Packed — mark ready | Order READY with a partner plan; rider search shown | status READY; plan "GoKesari delivery partner · Sat 10 Oct, 7–8 am"; rider search "No rider search has started for this order yet." | PASS | S-06-partner.png |
| S-01 | Shop owner | Register a shop with a referral code | New account gk-uireg → /shop/register → name, owner, phone, address, PIN 411038, type Stationery, Shop Act no. → referral code E2ETEST1 → submit | Shop registered, awaiting approval; owner sees the next step | E2E UI Pass Stationery 504466 registered; owner board: Awaiting approval — KYC pending, with the documents still needed; listed in the operator queue (KYC pending, fee ₹100) | PASS | S-01-registered.png |
| S-13 | Shop owner | Recharge the shop wallet (Cashfree sandbox) | Board › Wallet › Recharge → amount → pay the sandbox session | Shop wallet credited | Not run: the pay step runs in the Sandbox payment GitHub workflow, which GitHub is not starting (billing). Shop wallet page, balance ₹967.20 and history were checked in the navigation test | NOT RUN |  |
| D-APP-Customer | Customer | Customer home in the app (360×728, app user-agent, EN/हिं/मरा) | Open / at 360×728 with the GoKesariApp user-agent in each language | Board fits the screen; no errors; language applied | en: board bottom 722px, errors 0; hi: board bottom 722px, Devanagari true, errors 0; mr: board bottom 722px, Devanagari true, errors 0 | PASS | D-APP-Customer-360x728.png |
| D-APP-Shopowner | Shop owner | Shop owner home in the app (360×728, app user-agent, EN/हिं/मरा) | Open /shop at 360×728 with the GoKesariApp user-agent in each language | Board fits the screen; no errors; language applied | en: board bottom 721px, errors 0; hi: board bottom 721px, Devanagari true, errors 0; mr: board bottom 721px, Devanagari true, errors 0 | PASS | D-APP-Shopowner-360x728.png |
| D-APP-Admin | Admin | Admin home in the app (360×728, app user-agent, EN/हिं/मरा) | Open /admin at 360×728 with the GoKesariApp user-agent in each language | Board fits the screen; no errors; language applied | en: board bottom 719px, errors 0; hi: board bottom 719px, Devanagari true, errors 0; mr: board bottom 719px, Devanagari true, errors 0 | PASS | D-APP-Admin-360x728.png |
| D-APP-Operator | Operator | Operator home in the app (360×728, app user-agent, EN/हिं/मरा) | Open /admin at 360×728 with the GoKesariApp user-agent in each language | Board fits the screen; no errors; language applied | en: board bottom 719px, errors 0; hi: board bottom 719px, Devanagari true, errors 0; mr: board bottom 719px, Devanagari true, errors 0 | PASS | D-APP-Operator-360x728.png |
| D-NET-Customer-_ | Customer | / on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open / at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 3.8 s, fully loaded 3.9 s | FAIL |  |
| D-NET-Customer-_orders | Customer | /orders on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open /orders at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 2.8 s, fully loaded 3.0 s | PASS |  |
| D-NET-Shopowner-_shop | Shop owner | /shop on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open /shop at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 3.7 s, fully loaded 4.0 s | FAIL |  |
| D-NET-Shopowner-_shop_orders | Shop owner | /shop/orders on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open /shop/orders at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 5.0 s, fully loaded 5.1 s | FAIL |  |
| D-NET-Admin-_admin | Admin | /admin on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open /admin at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 3.6 s, fully loaded 3.8 s | FAIL |  |
| D-NET-Operator-_admin | Operator | /admin on slow 4G (150 ms, 1.6 Mbps down) | Throttle the network (Chrome DevTools protocol), open /admin at 360×800, warm second load | Usable (content painted, board or list visible) within 3 s on a warm load | usable after 3.6 s, fully loaded 4.0 s | FAIL |  |

## Checks before → after

| Check | Before | After | Target |
|---|---|---|---|
| Role homes on one screen (test site, real data, 7 sizes × 3 languages) | 0 of 105 (admin 70.9, operator 63.3, shop 24.0, customer 3.0 phone screens) | 104 of 105 (shop owner 320×640 is 2 px over) | 105 |
| Role homes on one screen (local, 4 sizes × 3 languages, PR #124) | 0 | 60 of 60 | all |
| Every function within 2 taps (links clicked from the boards and menu pages) | not provable (dropdowns of 12–39 links) | 236 of 236 local (both sizes); 218 of 219 on test site (Maps blocked here) | all |
| Smallest touch target on role homes (phone) | 15–20 px | 44 px (48 px at ≥360 px wide) | 48 dp |
| Targets under 44 px on all pages (phone) | 4,056 | 347 (PR #124; mostly 20 px tick boxes inside 44 px labels, headings) | 0 |
| Smallest text (phone) | 10–11 px | 12 px (labels 14 px; 13/12 px on short screens) | 14 px body |
| Lowest text contrast | 1.69:1 | 4.52:1 | 4.5:1 |
| Second-level pages, median height (phone) | 2.2 screens (149 pages) | 2.2 screens (207 pages after splitting; 38 over 3) | 1 |
| Access to another role's screens (direct links) | — | 55 of 55 refused (test site and local) | all |
| PageSpeed mobile, gokesari.com home | 92 (Speed Index 8.6 s) | 99 warm / 93 cold (Speed Index 3.3 s warm) | ≥90 |
| Signed-in page, server time (test site) | 3.4–5.1 s | PR #124: 52→24 queries; with prepared statements ~2× faster (local, 200 ms DB); hosting fix pending | <1 s |
| Usable on slow 4G (test site, warm) | — | 1 of 6 pages under 3 s (2.8–5.0 s) | <3 s |

## Not run, and why

- C-01 Top up the wallet (Cashfree sandbox, UPI testsuccess@gocash): Not completed: the wallet screen created the Cashfree sandbox session (session_iPGj…), but GitHub Actions did not start the Sandbox payment job (run 37973592123: “recent account payments have failed or your spending limit needs to be increased”). This session cannot reach Cashfree itself
- S-11b Return pickup, inspection and refund: Not tested: needs a delivery partner to accept and collect the pickup (manual completion is offered to staff only once a rider is on the way); no rider sign-in in this run
- O-02 Approve a shop application: Not completed: the shop is KYC pending (PAN, GSTIN, Shop Act certificate not yet verified), so Approve is disabled with the reason “Only a verified shop can be approved” (correct, gate rule statusModels). Queue, stage filters, next-step text and the verification link were checked
- S-13 Recharge the shop wallet (Cashfree sandbox): Not run: the pay step runs in the Sandbox payment GitHub workflow, which GitHub is not starting (billing). Shop wallet page, balance ₹967.20 and history were checked in the navigation test
- D-NET-Customer-_ / on slow 4G (150 ms, 1.6 Mbps down): usable after 3.8 s, fully loaded 3.9 s
- D-NET-Shopowner-_shop /shop on slow 4G (150 ms, 1.6 Mbps down): usable after 3.7 s, fully loaded 4.0 s
- D-NET-Shopowner-_shop_orders /shop/orders on slow 4G (150 ms, 1.6 Mbps down): usable after 5.0 s, fully loaded 5.1 s
- D-NET-Admin-_admin /admin on slow 4G (150 ms, 1.6 Mbps down): usable after 3.6 s, fully loaded 3.8 s
- D-NET-Operator-_admin /admin on slow 4G (150 ms, 1.6 Mbps down): usable after 3.6 s, fully loaded 4.0 s

## Environment

- Test accounts: sanjaymorankar+gk-cust / gk-shop / gk-admin / gk-ops / gk-uireg (sign-in codes from the owner's mailbox).
- Browser: Chromium (Playwright) only; Firefox and Safari not available here.
- GitHub Actions stopped starting jobs at 18:04 UTC (billing): no Cashfree sandbox payments, no CI after #122.
- Lighthouse 13.5.0 locally (same engine as PageSpeed Insights).
