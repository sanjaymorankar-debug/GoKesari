# Test results — four features on test.gokesari.com (8–9 Oct 2026)

**Where:** test.gokesari.com, staging build 58bb4c0 (PR #102). The follow-up
fixes went out as PR #103 (staging 6f3c28f) and were re-checked on test
afterwards (§4). Production (gokesari.com) was never touched.

**How it was run:**
- **Browser:** a real browser (Chromium via Playwright) against the live test
  site, at phone width (Pixel 7) and desktop width (1280 px), as each role.
- **Sign-in:** the real emailed sign-in code. The codes, and every email
  checked below, were read from the owner's mailbox.
- **Payments:** Cashfree **sandbox**, the test site's own keys. The pay step ran
  on a GitHub runner (README T-3).
- **Database evidence:** the read-only `four-features-report` action of the
  "Test database" workflow.

**Accounts (all on test):**

| Role | Account |
|---|---|
| customer | sanjaymorankar+gk-cust@gmail.com |
| shop owners | +gk-shop (bakery), +gk-pharma, +gk-clinic, +gk-kirana (stationery) |
| GoKesari rider | +gk-rider |
| operator / admin | +gk-ops / +gk-admin |
| shop's own delivery person | "Ravi Kumar E2E" (no account, delivery link only) |

**Shops created:** E2E Four Features Bakery, Pharmacy, Clinic and Stationery.

**Orders:** DB-20261008-3BVWQU (pickup), -OGXVZW (own delivery), -2B89V5
(GoKesari rider), -Q7CDEY (own delivery, code locked), -TRM5R5 (rider
released), -8QZBEQ (blocked shop), -SPQS44 (cancel / refund), -NMBAE9 (pickup,
re-check of the fixes).

## 1. Summary

| Area | Result |
|---|---|
| F1 Delivery options & scheduling | **Pass**: pickup, shop's own delivery and GoKesari partner, each to completion. Also covered: slots, changes with customer notification, held / immediate rider search, rider release, lockout, support override, charges. One bug (a repeated "mark ready" answered 409) was fixed (S-1) and re-checked on test (§4). |
| F2 Mandatory legal documents | **Pass**: FSSAI (14-digit and expiry checks, file type), drug licence, medical registration with council. A new shop can't go live without them. Existing live shops get 15 days. Expiry reminder, block after grace, unblock on upload, review approve / reject with reason, file access. One cosmetic fix (S-3), re-checked on test (§4). |
| F3 Bank accounts & ₹1 | **Pass**: ₹1 verified by UPI, credit card, debit card and net banking through Cashfree sandbox, plus a failure and a retry. Also covered: re-verification on change, daily limit, masking, encryption, shop payout account, finance view. Refund status now re-checked (S-2); on test it shows "refunded" (§4). The payout gate itself was not run on test (no settlement can exist yet; see 3.x). |
| F4 Referral code | **Pass**: valid / invalid / missing code in the form and API, attribution. Request with location shared, unanswered and denied; email to referrals@gokesari.com; duplicate and PIN checks; operator issue / reject; issued code used to register. |
| Regression | **Pass**: sign-in, onboarding, address, wallet top-up (Cashfree sandbox), checkout, shop accept, rider dispatch / pickup / delivery code / door photo, shop wallet charges, seller verification, registration fee, approval, cancel / refund, notifications. One existing issue on test: map "Confirm location" answers 500 (geocoding; not touched by this work). |
| Owner's decisions, round 1 (§5) | **Pass**: delivery fee back on pickup; refunds to bank (paid, failed, cancelled); referral code at customer registration. |
| Owner's decisions, round 2 (§6) | **Pass**: shops past the legal-document grace period read "not taking new orders" (list and cart) and reopen on upload. A referral code is mandatory before a new customer's first order: the request with location, the referrals email, issuing the code and the first order were all checked. Search works signed out; every role has an invite code. Two problems found and fixed on test (S-6, S-7). |

## 2. Step by step (UTC times, 8 Oct 2026)

| Time | Flow | Step | Result |
|---|---|---|---|
| 18:59 | Regression · login | Customer sanjaymorankar+gk-cust signs in with the emailed code (phone width) | PASS — code emailed, signed in, sent to /onboarding |
| 19:19 | Regression · profile | Onboarding: name + mobile 7397100101 saved | PASS |
| 19:22 | Regression · address | Map "Confirm location" (geo-tag) on /profile/addresses | PRE-EXISTING ISSUE on test (old code): "Something went wrong. Please try again." — geo-tag optional |
| 19:23 | Regression · address | Address saved without geo-tag, default | PASS |
| 19:24 | Regression · wallet | ₹500 top-up: gateway order (Cashfree sandbox) → paid by UPI collect testsuccess@gocash (sandbox-pay workflow run 37831015803) → /api/wallet/verify | PASS — balance ₹0 → ₹500, alreadyProcessed false |
| 19:35 | Deploy | PR #102 merged into staging (58bb4c0); Hostinger rebuilt test.gokesari.com — new routes live 19:38 | PASS |
| 19:36 | Deploy · DB | Test database run 37833141417: backup gokesari_test_2026-10-08_1936_run11.dump → migrate (67 rows, newest 0064) → four rules on → E2E admin/operator roles → verify | PASS |
| 19:39 | Admin | /admin/settings shows fulfilmentOptions, legalDocuments, bankAccounts, shopReferral with test values | PASS |
| 19:40 | F4 setup · admin | Referral code E2ETEST1 created (Admin → Referral codes) | PASS |
| 19:40 | Regression · rider | Admin approves delivery partner "E2E Rider Vijay" | PASS |
| 19:42 | F4 · registration (desktop) | Empty code → blocked in browser ("A referral code is required…"), 0 requests sent | PASS |
| 19:42 | F4 · registration | Invalid NOPE123 → "Referral code NOPE123 does not exist.", blocked, 0 requests | PASS (bug found: the old error stayed visible after correcting the code until re-submit — fixed in follow-up) |
| 19:42 | F4 · registration | Valid E2ETEST1 → shop "E2E Four Features Bakery" registered (PENDING_APPROVAL), attributed to E2ETEST1 (report: shops_attributed 1) | PASS |
| 19:42 | F4 · API | POST /api/shops without code → 422 "Enter your referral code, or request one."; invalid → 422 "Referral code NOPE123 does not exist. Check the code, or request one." | PASS |
| 19:44 | F4 · request (phone) | Location allowed → "Location captured (18.50890, 73.92590). See on Google Maps"; RCR-5A71759C saved | PASS |
| 19:45 | F4 · email | Email "Referral code request RCR-5A71759C — E2E Ref Requester Anil, Pune 411006" received (copy to readable alias) with name, mobile, type, area, city, PIN, coordinates ±12 m, Maps link, time | PASS |
| 19:45 | F4 · request | PIN 012345 → "A PIN code is 6 digits and does not start with 0.", not sent | PASS |
| 19:45 | F4 · request | Same mobile again → 429 "We already have a request from this mobile number (RCR-5A71759C, …)" shown in the dialog | PASS |
| 19:46 | F4 · request (desktop) | Location prompt unanswered → sent without location: RCR-CA8BBBB6, "Your location was not shared…" | PASS |
| 19:47 | F4 · request (phone) | Location blocked → "Location not shared (permission denied)…"; RCR-24EAA7D1 saved | PASS |
| 19:48 | F2/F3 · shop dashboard | New shop dashboard: "Your shop cannot accept orders — FSSAI licence is required. Upload now" and "Add your bank account to receive payouts … ₹1 payment, refunded" | PASS |
| 19:51 | Regression · seller verification | PAN, GST declaration, FSSAI number, Shop Act + certificate submitted → admin approves all 4 in /admin/seller-verification | PASS |
| 19:53 | Regression · fee | Registration fee ₹100 recorded (cash) → PAID | PASS |
| 19:53 | F2 · cannot go live | Admin "Approve" with FSSAI not uploaded → 409 "This shop needs its FSSAI licence uploaded before it can go live." shown on the card | PASS |
| 19:54 | F2 · FSSAI validation | 13 digits → "exactly 14 digits", submit disabled; past expiry → "already expired"; text file named .pdf → "Upload a PDF, JPEG, PNG or WebP file." | PASS |
| 19:55 | F2 · FSSAI upload | Valid 14-digit number + expiry 31 Mar 2027 + PDF → SUBMITTED; page shows ••••0123, expiry, "View uploaded copy" | PASS |
| 19:56 | F2 · go live | Admin "Approve" → 200, shop APPROVED | PASS |
| 19:56 | F2 · review (operator) | Operator opens the uploaded copy (200, original 619-byte PDF, decrypted) and approves → APPROVED | PASS |
| 19:56 | F2 · permissions | Copy URL: customer 404, another shop owner 404, signed-out 401, own owner 200 | PASS |
| 20:01 | F1 · staff (phone) | /shop/delivery-staff: add Ravi + Suresh; duplicate mobile → "Ravi E2E already has this mobile number in your team."; edit name; deactivate (badge), reactivate, deactivate; another shop owner GET → 403 | PASS |
| 20:07 | Regression · checkout | Customer orders Bread ₹40 + ₹20 delivery from a closed shop (scheduled 6–8 am) paying from wallet → CONFIRMED; first-checkout bank-account prompt shown in cart (F3) | PASS |
| 20:10 | F1 · ready needs a choice | POST /fulfilment {"action":"ready"} without a plan → 409 needsFulfilmentChoice | PASS |
| 20:10 | F1 · pickup | "Packed — mark ready" with Pickup, Fri 9 Oct 7–8 am → READY; customer email "Ready for pickup"; My Orders shows option, time, shop address and pickup code 4883 | PASS (bug: a duplicate request answered 409 "Start preparing…" although the first succeeded — fixed in follow-up: idempotent) |
| 20:28 | F1 · pickup completion | Status DELIVERED without code → 409 "Complete a pickup with the customer's pickup code."; wrong code → "4 attempts left"; right code → DELIVERED; customer "Order delivered" email | PASS |
| 20:29 | F1 · charges | Shop wallet after pickup: COMMISSION −₹0.40 only, no DELIVERY_CHARGE | PASS |
| 20:25 | F1 · own delivery | Plan Shop's own delivery (only active staff offered: Ravi; deactivated Suresh absent), Fri 9–10 am → READY; email "Delivery scheduled" | PASS |
| 20:26 | F1 · changes | 9–10 → 11–12 → Pickup 11–12 → own delivery Sat 7–8 am; each saved; 3 emails "Your order's delivery plan changed … Before: …"; My Orders shows "(updated)" | PASS |
| 20:29 | F1 · link | Old link after re-planning → 404 (new link issued) | PASS |
| 20:32 | F1 · delivery link (phone, signed out) | Shows order, slot, customer, address, Call customer/Directions/Call shop, items; "start delivery" → OUT_FOR_DELIVERY; customer emailed "0594 is your delivery code" | PASS |
| 20:33 | F1 · no change once out | Change plan → 409 "This order's delivery can no longer be changed." | PASS |
| 20:33 | F1 · own delivery completion | Wrong code → "4 attempts left"; right code → DELIVERED; link then shows "Delivered" only, customer details gone | PASS |
| 20:36 | F1 · new code (phone) | Customer "Get a new code" right after start → "Please wait 21 seconds…"; after cooldown → new code 0940 shown + emailed, "Your earlier code no longer works", 2 resends left | PASS |
| 20:38 | F1 · lockout | 5 wrong codes on the link: 4,3,2,1 attempts left, then 409 "Too many wrong codes — this order is on hold and support ticket GRV-000001 has been raised"; link shows "On hold", no code box | PASS |
| 20:34 | F1 · owner told | Shop owner email "Delivered — Ravi Kumar E2E delivered order DB-20261008-OGXVZW" | PASS |
| 20:40 | Regression · rider | Rider goes online (phone, location near shop) | PASS |
| 20:41 | F1 · GoKesari later slot | GoKesari partner 7–8 am → READY; rider search held: "The rider search starts at 6:15 am — or press Find rider now" (riderSearchFrom 00:45Z) | PASS |
| 20:42 | F1 · GoKesari now | "Find rider now" → offer to the rider ("NEW DELIVERY OFFER — ACCEPT WITHIN 2 MINUTES"), rider accepts → ASSIGNED | PASS |
| 20:46 | Regression · rider pickup | Rider "arrived at shop"; shop card shows "Pickup code for the rider: 9497"; rider confirms → PICKED_UP | PASS |
| 20:46 | F1 · no change after pickup | Change plan after rider pickup → 409 "This order's delivery can no longer be changed." | PASS |
| 20:47 | Regression · delivery OTP | Start delivery → customer emailed "7991 is your delivery code"; door photo (rule on test) + code → DELIVERED | PASS |
| 20:52 | F1 · charges | Rider-delivered order: DELIVERY_CHARGE −₹15 (3.0 km) + COMMISSION; pickup/own-delivery orders: COMMISSION only | PASS |
| 20:38 | F1 · lock alerts (in-app) | Customer "Delivery on hold … ticket GRV-000001"; shop "Code locked — support will confirm"; operator + admin "Pickup / own-delivery code locked … GRV-000001" | PASS |
| 20:53 | F1 · support confirm | Shop "confirm" without code → 403 "Only operations can confirm a handover without the customer's code."; operator confirm → DELIVERED | PASS |
| 20:57 | F1 · release rider | Order 5 GoKesari → Find rider now → rider accepts (ASSIGNED) → shop changes to Pickup 10–11 am → 200, order READY; rider screen back to "Waiting for a delivery offer…"; rider notified "Delivery cancelled — … The shop changed the delivery plan."; customer notified "delivery plan changed … Before: GoKesari…" | PASS |
| 19:47 | F4 · support told | Operator/admin in-app "New referral-code request — …" for each request | PASS |
| 21:00 | F3 · validation (phone) | IFSC SBIN1234567 → "An IFSC is 11 characters, like SBIN0001234 (the 5th is a zero)."; mismatched re-entry → "The two numbers do not match."; holder name with digits → "Use letters, spaces and . ' & - only." (server repeats every check, 422) | PASS |
| 21:00 | F3 · save | Customer account saved PENDING; page shows "Account ••••9012 · IFSC SBIN0001234 · Not verified yet · Verify with ₹1" | PASS |
| 21:02 | F3 · ₹1 by UPI (Cashfree sandbox) | Site creates ₹1 order (payment methods upi,dc,cc,nb) → runner pays UPI collect testsuccess@gocash → site confirms with Cashfree → VERIFIED, method UPI, ref 1461827909118528000, matched name recorded (PAYMENT_ONLY: sandbox gives no payer name), refund initiated | PASS |
| 21:03 | F3 · re-verification | Changing the account number creates a new PENDING account (old one superseded) | PASS |
| 21:10 | F3 · ₹1 by credit card | Card 4111 1111 1111 1111 → Cashfree simulator "Credit Card Transaction", OTP 111000 → VERIFIED, method CREDIT_CARD, ref 1461829571801093120 | PASS |
| 21:13 | F3 · ₹1 by debit card | Card 4706 1312 1121 2123 → "Debit Card Transaction" → VERIFIED, method DEBIT_CARD, ref 1461830515526142464 | PASS |
| 21:15 | F3 · failure | UPI testfailure@gocash → FAILED "Simulated response message", refund not required; page shows "Verification failed … Try again with ₹1" (phone) | PASS |
| 21:20 | F3 · retry by net banking | Try again → net banking (bank 3003, simulator SUCCESS) → VERIFIED, method NET_BANKING, ref 1461831684971140096 | PASS |
| 21:21 | F3 · daily limit | 6th attempt in a day → 429 "You can try verifying 5 times a day." | PASS |
| 21:08 | F3 · shop payout UPI | Shop owner UPI ID testsuccess@gocash (masked te•••••••••@gocash, "Payouts are on hold" shown before) → ₹1 by UPI → VERIFIED, match GATEWAY_UPI (Cashfree's payer UPI ID equals the saved one) | PASS |
| 21:21 | F3 · finance view | /admin/bank-accounts lists accounts masked; no full number/UPI ID anywhere in the page HTML; customer → 403 | PASS |
| — | F3 · refund status | Refunds stay "refund pending" after Cashfree accepts them — nothing re-checked the status | BUG → fixed in follow-up (status refreshed from Cashfree when the account is shown) |
| — | F3 · payout gate | No shop settlement can exist on test for a new shop until the settlement hold period passes (preparing one would also create drafts for other test shops) — covered by integration tests (process/pay refused without a verified account, allowed after) | NOT RUN ON STAGING (by design) |
| 21:14 | F4 · admin queue | Operator issues E2EANIL1 to RCR-5A71759C (CODE_ISSUED), rejects RCR-CA8BBBB6 "Outside our current service area" (REJECTED); email status SENT for all three; customer → 403 | PASS |
| 21:14 | F4 · requester told | Requester (signed in) emailed "Your referral code is ready — Use referral code E2EANIL1" | PASS |
| 21:17 | F4 · issued code works | Pharmacy registered (phone width) with the issued code E2EANIL1 | PASS |
| 21:19 | F2 · drug licence (phone) | Pharmacy: "Drug licence — Required for: Medical shops and pharmacies"; number + expiry + PDF → SUBMITTED ••••3456 | PASS |
| 21:19 | F2 · medical registration | Clinic (category Doctor / Clinic): number + issuing council "Maharashtra Medical Council" + PDF → SUBMITTED | PASS |
| 21:20 | F2 · reject / approve | Operator rejects drug licence "The copy is not readable — please upload a clear scan" → owner sees "Rejected — upload again … Rejected by operations: …"; approves medical registration → APPROVED | PASS |
| 21:23 | F2 · expiry reminder | Bakery FSSAI re-uploaded with expiry 29 Oct 2026 → operator "Check all live shops now" → {"shopsChecked":8,"requirementsStarted":7,"remindersSent":1}; "Expiring soon" filter lists it | PASS |
| 21:23 | F2 · existing live shops | The same check started the 15-day grace for existing live shops missing a document (QA Test Bakery A, Agtci, Chikan Shop, Asmy Exports, EcoMed Solutions ×2, Samarth tea center …): "Not uploaded · Deadline 24 Oct 2026" — they keep trading | PASS |
| 21:28 | F2 · blocked after grace | Grace 0 (Business rules) → operator rejects bakery FSSAI "Licence number does not match the copy" → grace restored to 15. Shop "Accept order" → 409 "E2E Four Features Bakery can't take orders until its FSSAI licence is uploaded."; dashboard "Your shop cannot accept orders"; customer checkout → 409 same message | PASS (note: the cart page does not warn before checkout) |
| 21:31 | F2 · unblocked | New FSSAI upload (SUBMITTED) → accepting the waiting order works again | PASS |
| 21:32 | F2 · emails | Owner emails: "FSSAI licence required" (at registration), "FSSAI licence approved", "FSSAI licence rejected: Licence number does not match the copy…" (queued, ~4 min) | PASS |
| 21:35 | Regression · cancel/refund | Customer cancels a confirmed order → REFUNDED, wallet ₹80 → ₹140 | PASS |
| 21:44 | Regression · approval | Non-food stationery shop: seller documents verified, fee recorded → auto-approved (rule autoApproveShop on test) without any legal document | PASS |
| 21:45 | F2 · new requirement on a live shop (phone) | Stationery shop adds the Bakery product category → dashboard "Upload your FSSAI licence — Keep taking orders until 24 Oct 2026; after that orders stop until it is uploaded"; legal page "Upload by 24 Oct 2026" | PASS (cosmetic: "the fssai licence" lower-cased — fixed in follow-up) |

## 3. Not run on test, and why

| # | What | Why | Covered by |
|---|---|---|---|
| 3.x | A shop settlement refused for "process" / "pay" without a verified account | A settlement only takes orders delivered more than the hold period ago. Preparing one now would also create drafts for every other test shop. | `bank-accounts.test.ts` "only the owner sets it; payouts wait for a verified account" |
| — | Payer-name mismatch on the ₹1 | Cashfree sandbox reports no payer name, so every UPI / card / net-banking payment matches as "payment only". The UPI-ID match (GATEWAY_UPI) did run (shop account). | `bank-accounts.test.ts` "a payment from a different account holder fails" |
| — | Arrival in the referrals@gokesari.com inbox | That mailbox is not readable from here. SMTP accepted the message for it (email status SENT for all three requests), and the identical copy arrived at the readable alias. | Owner to confirm the inbox |

## 4. Follow-up fixes re-checked on test

PR #103 merged into staging at 22:08 UTC. Hostinger rebuilt test.gokesari.com
by 22:13, confirmed by the served legal-documents page chunk carrying the new code.

| Time | Fix | Step | Result |
|---|---|---|---|
| 22:13 | S-2 ₹1 refund status | Shop owner opens Bank account (phone): "Verified on 9/10/2026 by UPI · name Ramesh Joshi · ref 1461828618859418624 · ₹1 refund **refunded**". Before the fix it read "pending". Database: the attempt is REFUNDED, refunded_at 22:13:38, recorded when the page was opened. | PASS |
| 22:18 | S-2 finance view | Admin → Bank accounts: the shop's account "refund refunded". No full account number or UPI ID on the page. Customer GET /api/admin/bank-accounts → 403. | PASS |
| 22:13 | S-3 casing | Bakery legal page: "FSSAI licence"; no lower-case "fssai" anywhere. Stationery shop (phone): "After that date it cannot accept orders until the FSSAI licence is uploaded." | PASS |
| 22:14 | S-3 referral error | Registration form filled, no code, Submit → "A referral code is required to register a shop…", no request sent. Typing "E2E" → the error is gone at once and the hint is back. | PASS |
| 22:16 | S-1 repeated "mark ready" | New order DB-20261008-NMBAE9: shop picks Pickup, Fri 9 Oct 7–8 am, "Packed — mark ready" → 200 READY. The same request sent twice more (a double tap or a retry) → **200, 200** with the same plan. Before the fix: 409. | PASS |
| 22:16 | S-3 rider-search note | NMBAE9's card (pickup, READY): "Pickup from the shop · Fri 9 Oct, 7–8 am · Change · Customer's pickup code"; rider-search note not shown (0 elements). | PASS |
| 22:17 | S-1 repeated pickup | Customer's My Orders shows pickup code 2309. Shop enters it → 200 DELIVERED. The same completion sent twice more → **200, 200** DELIVERED. | PASS |
| 22:18 | S-1 nothing twice | Database for NMBAE9: one `order.fulfilment_set`, one `order.ready`, one `order.delivered`; one COMMISSION (₹0.40) and no DELIVERY_CHARGE in the shop's ledger. | PASS |

### Email delivery on test (S-5)

Some emails reached the test mailboxes late (about 4 minutes) or not at all,
although the in-app notification was always there. The outbox (newest 40 rows
for the test accounts, `test-report.sql`) shows the cause. From about 20:58
UTC the test site's mail host refused messages with `451 4.7.1 Ratelimit
"hostinger_out_ratelimit" exceeded`, the mailbox's hourly sending cap. The run
emailed nine test accounts about every step. The existing outbox retried each
email with back-off, and after 4 attempts it marked a few DEAD and alerted
support. Emails of every kind were refused, old and new alike (order
confirmed, rider assigned, seller review, legal documents), so the new
features are not the cause and no code was changed. The production
prerequisite is in the README (§5 item 2).

## 5. The owner's decisions (9 Oct 2026), tested on test

PR #106 merged into staging at 05:17 UTC (`7e72292`). The "Test database"
workflow backed up, applied 0065–0067 (70 migrations, newest 0067) and
switched on `bankRefunds` and `customerSignupReferral` for test. Hostinger
served the new build from 05:19.

| Time (UTC) | Flow | Step | Result |
|---|---|---|---|
| 05:03 | Setup | The customer's current account KKBK0000111 ••••5566 verified with ₹1 by UPI, through the Cashfree sandbox. The daily attempt limit was raised to 10 for this step, then set back to 5 | PASS |
| 05:20 | O-1 · shop (phone) | Order DB-20261009-KLK7DD (₹40 bread + ₹20 delivery). In the planner, choosing **Pickup** shows "With pickup, the customer's ₹20.00 delivery fee goes back to them". "Packed — mark ready" → 200 READY. The card now shows ₹40 and "The customer's ₹20.00 delivery fee was given back for pickup" | PASS |
| 05:20 | O-1 · customer (phone) | My Orders: "No delivery for this order: your ₹20.00 delivery fee was given back". Wallet: "Delivery fee refund: order DB-20261009-KLK7DD is collected from the shop", +₹20. Email "Ready for pickup … Your ₹20.00 delivery fee has been refunded…" arrived | PASS |
| 05:21 | O-1 · completion | Pickup code 3773 → DELIVERED. Shop wallet: COMMISSION ₹0.40 only. Database: the order's delivery fee is 0, total ₹40, refunded ₹20; the plan records ₹20 at 05:20:12; one wallet refund of ₹20. Pickup orders from before the change are unchanged | PASS |
| 05:22 | O-2 · customer (phone) | My Wallet → "Send a refund to your bank" lists the ₹20 fee refund, and the ₹60 cancellation refund of DB-20261008-SPQS44 limited to the ₹40 still in the wallet. "Send ₹20.00 to my bank" → "Yes, send it" → 201 REQUESTED. The wallet drops by ₹20; the other refund now offers ₹20. Email "Refund on its way to your bank" arrived | PASS |
| 05:23 | O-2 · finance (desktop) | Admin → Refunds to bank → To send. "Show account details" shows the full account to finance (12 digits, ending 5566, IFSC KKBK0000111; the look-up is audited). "Mark sent from bank" → PROCESSING. "Paid" with UTR TESTUTR20261009A → PAID. Customer: "Paid to your bank · bank reference TESTUTR20261009A" and the email "Refund sent to your bank (bank reference …)" | PASS |
| 05:24 | O-2 · failed | The SPQS44 refund (₹20) sent; finance marks it **Failed** ("Beneficiary account closed (test)"). The ₹20 is back in the wallet. Customer: "Failed — back in wallet" with the reason, and the email "Refund back in your wallet" | PASS |
| 05:25 | O-2 · cancel | The returned ₹20 is offered again ("Back in your wallet: the transfer … failed") → sent → the customer presses **Cancel** → CANCELLED, back in the wallet. Database: three requests (PAID, FAILED, CANCELLED), each with its wallet debit and, for the last two, its return | PASS |
| 05:25 | O-3 · new customer (phone) | sanjaymorankar+gk-new1 signs in for the first time → first-time setup shows "Referral code (optional)". `NOPE999` → "This referral code is not valid." on the field, and the step stays. Typing clears the error. `e2eanil1` → accepted as E2EANIL1 (GOKESARI, label "Requested by E2E Ref Requester Anil"), then the address step | PASS |
| 05:27 | O-3 · friend's code | sanjaymorankar+gk-new2: `GKZZZZZZ` refused, then the existing customer's friend code `gk2lqxbl` → accepted as FRIEND (`customerReferrals` is on for test) | PASS |
| 05:26 | O-3 · operator | Admin → Referral requests → "Customers who joined with a code": E2EANIL1, issued by GoKesari, 1 | PASS |
| 05:28 | O-3 · existing customer | The customer with orders is not asked (`ask: false`); giving a code is refused with "A referral code can only be given when you join, before your first order." | PASS |

All emails for these steps arrived within a minute: no sending-limit delays
this time.


## 6. The owner's second-round decisions (9 Oct 2026), tested on test

PR #109 merged into staging at 09:20 UTC (`6d7f292`). The "Test database"
workflow backed up, applied 0072 (75 migrations; 0068–0071 are the
three-modules work merged just before) and set `customerSignupReferral` to
`{"enabled": true, "required": true, "requiredFrom": "2026-10-09"}`. Hostinger
served the new build from 09:22.

| Time (UTC) | Flow | Step | Result |
|---|---|---|---|
| 08:49 | O-6 · signed out (phone) | Home page search box: "milk" → /search, 15 products listed with prices and shops, no sign-in. "Add to cart" → the sign-in page | PASS |
| 09:23 | O-5 · new customer (phone) | sanjaymorankar+gk-new3 signs in for the first time. First-time setup: "Referral code — Needed before your first order … No code? Leave it empty and ask us for one next." Name and mobile saved with no code; after the address step's "Fill in later", setup ends on **My referral code** | PASS |
| 09:23 | O-5 · My referral code | "A referral code is needed before your first order. Browse and search all you like in the meantime." Enter-a-code box, and "No referral code? Ask us for one" with the location captured (18.52043, 73.85674, Google Maps link) and name and contact number prefilled. API: `needsCode: true` | PASS |
| 09:24 | O-5 · browse and cart | The E2E bakery's page lists 45 products; bread added. Cart: "A referral code is needed for your first order — Enter the code you were given — or ask us for one — in My referral code." Checkout → 409 "Enter your referral code before your first order — or ask us for one in My referral code." (`needsReferralCode: true`) | PASS |
| 09:25 | O-5 · ask for a code | City Pune, PIN 411001 → request CRR-0423186D saved with the location. Asking again → "We already have your request (CRR-0423186D, …)". **Found:** the first POST came back as a 307 from the host's CDN and was repeated, so the customer saw that message instead of "Request received" (S-6; fixed in PR #110, re-checked below) | PASS with S-6 |
| 09:25 | O-5 · emails | referrals@gokesari.com list (test copy to the +gk-referrals alias): "Customer referral code request CRR-0423186D — Anil Three, Pune 411001" with name, contact number, email, city, PIN, location shared, coordinates ±20 m, Google Maps link, time in IST. One email only | PASS |
| 09:25 | O-5 · operations | In-app "Customer asked for a referral code — Anil Three, Pune 411001 (CRR-0423186D)" for operations/admins | PASS |
| 09:30 | O-5 · issue (desktop) | Admin → Referral requests → "Customers asking for a code": the request with contact number, location and Maps link. "Issue a code" (generated) with a note → Code issued **GKCMUWB6K** | PASS |
| 09:31 | O-5 · customer told | Email "Your GoKesari referral code — Your referral code is GKCMUWB6K. Enter it in My referral code to start ordering (CRR-0423186D)." and the same in the app. My referral code lists the request with the code and **Use this code** | PASS |
| 09:31 | O-5 · use the code | "Use this code" → "You're all set — You joined with the referral code GKCMUWB6K (Customer Anil Three (CRR-0423186D))". `needsCode: false`; the cart warning is gone | PASS |
| 09:49 | O-5 · first order | Address added; ₹100 wallet top-up through the Cashfree sandbox (UPI); order DB-20261009-WXLQQN (₹40 bread + ₹20 delivery) placed from the wallet → CONFIRMED | PASS |
| 09:51 | O-5 · not stopped | Existing accounts: the customer with orders, a shop owner, a delivery partner, and the 9 Oct customer who joined with E2EANIL1 → `needsCode: false` | PASS |
| 09:52 | O-5 · decline | sanjaymorankar+gk-new2 asks (CRR-34C3012F, location not shared). Operations rejects "E2E: you already joined with a friend's code" → in-app "We could not give you a referral code this time: E2E: you already joined with a friend's code (CRR-34C3012F)." | PASS |
| 09:32 | O-6 · menu (phone) | The menu drawer shows **My referral code** and **Invite friends** for a customer, a shop owner and a delivery partner | PASS |
| 09:33 | O-6 · invite codes | /refer gives each their own code and link: customer GKNY7C2L, shop owner GKYJJAE6, delivery partner GKJ5KLH8, operator GKX46WXM (`customerReferrals` is on for test: ₹50 each after the friend's first delivered order) | PASS |
| 09:38 | O-4 · baseline | The existing customer (phone): the E2E bakery "Delivers to you · 1.1 km"; bread added to the cart; cart normal | PASS |
| 09:41 | O-4 · blocked | Grace 0 → the shop re-uploads its FSSAI → operations rejects it ("E2E O-4: licence copy unreadable") → grace back to 15. Cart: "E2E Four Features Bakery is not taking new orders right now. Try again later or remove its items." with "Remove these items". **Found:** the shop list showed the bakery as "Pickup · outside its delivery area · 1.1 km", as it does any paused shop (S-7; fixed in PR #110, re-checked below) | PASS with S-7 |
| 09:47 | O-4 · reopened | The shop uploads the FSSAI again (under review) → straight away "Delivers to you · 1.1 km" and a normal cart. Operations then approves it | PASS |
| 09:56 | Regression · rider delivery | Order DB-20261009-WXLQQN: shop accepts, picks, chooses GoKesari partner → offer to the rider → accepted → "Pickup code for the rider: 3393" → PICKED_UP → start → customer emailed "5549 is your delivery code for order DB-20261009-WXLQQN" → door photo + 5549 → DELIVERED. The customer's order shows "delivered", the tax invoice and the delivery photo | PASS |
| 10:34 | S-6 re-check | PR #110 merged at 10:23 (`fe94abf`), live by 10:33. sanjaymorankar+gk-new1 sends the same request (Pune 411007, location shared) twice, 31 s apart → 201 CRR-89C48687 both times; one request; one email to the referrals list. Operations then declined it (test request) | PASS |
| 10:37 | S-7 re-check | Bakery blocked again (grace 0, FSSAI re-uploaded and rejected, grace back to 15). Shop list: "E2E Four Features Bakery … **Not taking new orders right now** · 1.1 km"; cart: "… is not taking new orders right now". Upload + approval → "Delivers to you · 1.1 km" | PASS |

All flows of the second round pass on test. The two problems found (S-6,
S-7) were fixed and re-checked there.
