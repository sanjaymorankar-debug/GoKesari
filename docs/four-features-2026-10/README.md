# Four features — fulfilment options, legal documents, bank accounts, referral codes (October 2026)

Built on the `staging` branch (test.gokesari.com), on top of the event layer
(0058) and the shop wallet / delivery code (0059). **Not for production** until
approved. Every behaviour is a business rule (Admin → Business rules), **off by
default in code**, switched on for the test site by
[test-settings.sql](test-settings.sql) (applied by the "Test database" workflow
when it changes on `staging`). With the rules off, the app behaves exactly as
before.

| # | Feature | Rule | Migration | Rollback |
|---|---|---|---|---|
| 1 | Delivery options and scheduling | `fulfilmentOptions` | `drizzle/0061_fulfilment_options.sql` | `scripts/rollback-0061.sql` |
| 2 | Mandatory legal documents by shop type | `legalDocuments` | `drizzle/0062_legal_documents.sql` | `scripts/rollback-0062.sql` |
| 3 | Bank account details + ₹1 verification | `bankAccounts` | `drizzle/0063_bank_accounts.sql` | `scripts/rollback-0063.sql` |
| 4 | Mandatory referral code + request a code | `shopReferral` | `drizzle/0064_referral_code_requests.sql` | `scripts/rollback-0064.sql` |

Added on 9 Oct 2026 from the owner's answers to §6 (details in §2, "Decided by the owner"):

| # | Change | Rule | Migration | Rollback |
|---|---|---|---|---|
| 1a | Pickup gives the customer's delivery fee back | `fulfilmentOptions.refundDeliveryFeeOnPickup` (on) | `drizzle/0065_pickup_delivery_fee_refund.sql` | `scripts/rollback-0065.sql` |
| 3a | Refunds to a customer's bank | `bankRefunds` (off; on for test) | `drizzle/0066_bank_refund_requests.sql` | `scripts/rollback-0066.sql` |
| 4a | Referral code checked at customer registration too | `customerSignupReferral` (off; on for test) | `drizzle/0067_customer_signup_referrals.sql` | `scripts/rollback-0067.sql` |
| 2a | Shops past the grace period show "not taking new orders" (O-4) | `legalDocuments` | — | revert the code |
| 4b | Referral code mandatory for customers + customers ask for one (O-5) | `customerSignupReferral.required` (off; on for test) | `drizzle/0072_customer_referral_requests.sql` | `scripts/rollback-0072.sql` |

Test checklist (every flow, every role): [TEST_CHECKLIST.md](TEST_CHECKLIST.md).
Test results on test.gokesari.com, step by step: [TEST_RESULTS.md](TEST_RESULTS.md).

---

## 1. What was built

### Feature 1 — Delivery options and scheduling

When a shop marks an order ready (`/shop/orders`, "Packed — mark ready") it now
chooses, in the same step:

* **Pickup from the shop** — the customer collects it. The customer sees a
  4-digit **pickup code** on My Orders (and in the email); the shop enters it
  ("Customer collected") to complete the order.
* **Shop's own delivery** — one of the shop's own delivery people
  (`/shop/delivery-staff`: add, edit, deactivate / reactivate — name and mobile).
  The shop shares a private **delivery link** with them (Copy / WhatsApp); on
  their phone they see the address, call buttons, items and cash to collect,
  press "Start delivery" (the customer is emailed the delivery code — the
  existing delivery-code mechanism: hashed, "Get a new code", 5 wrong codes →
  locked + support ticket) and enter the customer's code to complete. The shop
  can also do both from its order card.
* **GoKesari delivery partner** — the existing rider dispatch, unchanged. A
  later slot starts the rider search 45 min before it; "Find rider now" still
  works immediately.

Each choice has a **date and time slot** (1-hour slots 07:00–22:00 IST, up to
7 days ahead — all configurable). The shop can **change the option, the
delivery person or the time** until the order is collected / out for delivery /
picked up by a rider; switching away from a GoKesari rider releases the rider
(who is told). The **customer is notified at once** (in the app and by email)
when the plan is set and every time it changes, and sees the option, person
and time on My Orders. All status changes and notifications happen in the
request (event layer) — no cron involved except the existing dispatch sweep for
a GoKesari slot booked for later.

Money: pickup and own-delivery orders never get the shop-wallet **delivery
charge** (the existing rule charges it only for orders a GoKesari rider
delivered); the commission applies on delivery as for every order.

### Feature 2 — Mandatory legal documents

`/shop/legal-documents` ("Legal documents", linked from the shop menu and the
dashboard prompt) lists what the shop must hold:

| Document | Needed by | Fields |
|---|---|---|
| FSSAI licence | Food shops (food shop type or any food aisle — the detection seller verification already uses) | number (exactly **14 digits**), expiry date, uploaded copy |
| Drug licence | Pharmacy shop type / "pharmacy" category | number, expiry date, uploaded copy |
| Medical registration | "Doctor / Clinic" category (added by 0062) | number, issuing council, uploaded copy |

The mapping (shop types and category slugs) is part of the rule, editable
without a deploy. A **new shop cannot be approved** (go live) until each
required document is submitted. A shop **already live** when a requirement
first applies gets a **grace period (15 days, configurable)** with a clear
prompt on its dashboard and an email — it keeps trading; after the grace
period checkout refuses it and it cannot accept orders until it uploads. No
existing shop is disabled immediately. Expiry: a reminder 30 days ahead
(dashboard + email, once per expiry date, by the daily seller-verification
job); an expired licence gets the same grace period from its expiry date.
**Operations** review at `/admin/legal-documents` (filters: to review,
rejected, not uploaded, expiring soon, approved, all): open the copy (audited),
approve, or reject with a reason the shop sees; "Check all live shops now"
runs the requirement / reminder check on demand.

### Feature 3 — Bank account details and ₹1 verification

Customers (`/profile/bank-account`, for refunds) and shop owners
(`/shop/bank-account`, for payouts) add a bank account (holder name, account
number twice, IFSC) or a UPI ID. Verification is a **₹1 payment through
Cashfree** — UPI, debit card, credit card and net banking offered — confirmed
server-to-server and **refunded automatically**. Stored: status (pending /
verified / failed), matched account holder name, timestamp, payment method,
gateway reference, refund status. Failed → "Try again"; changing the details
creates a new, unverified account (re-verification). Account numbers and UPI
IDs are **encrypted at rest** (`PAN_ENCRYPTION_KEY`); screens show the last 4
digits only; card details never reach GoKesari (Cashfree's checkout).
Gates: a shop settlement cannot be sent to the bank or marked paid without a
verified account (`requireVerifiedForShopPayouts`, on for test). Existing
users get **prompts, never a lockout**: the shop dashboard, My Profile, and
the cart at the first checkout. Finance sees all accounts (masked) at
`/admin/bank-accounts`.

### Feature 4 — Mandatory referral code + "Request a referral code"

The shop registration form (`/shop/register`) has a mandatory **Referral code**
field, checked as the owner leaves it and again on submit: an empty, unknown,
inactive or expired code blocks the registration with a clear message; a
valid one is attributed to the shop (the existing referral report counts it).
Operators registering a shop for someone are not asked for one. Next to the
field, **Request a referral code** opens a short form: the browser asks for
location permission; if granted, latitude, longitude and a Google Maps link
are captured; if denied, the request still goes, marked "location not shared".
Fields: name, mobile, type of shop, area, city, PIN code (6 digits). The
request is saved, **emailed to referrals@gokesari.com** (name, mobile, type
of shop, area, city, PIN, coordinates, Maps link, time), support is told in
the app, and the requester sees a confirmation with a reference. A second
request from the same mobile within 24 h is refused (with the first one's
reference). Operations work them at `/admin/referral-requests` (new / code
issued / rejected): issue a code (typed or generated — the requester is told
in the app and by email), reject with a reason, or resend the email.

---

## 2. DECISIONS log

Decisions taken without asking, with the reason. Flag any you want changed.

### General
- **G-1. Base branch `staging`, not `main`.** test.gokesari.com deploys from
  `staging`, which holds the shop wallet, the delivery code and the event layer
  these features build on (main was reverted to 0055 on 8 Oct).
- **G-2. Every feature is a rule, off by default in code, on for test** via
  `test-settings.sql` — the pattern the shop wallet and the event layer used. So
  existing shops, customers, orders and riders behave exactly as before
  wherever the rules are off, and production needs an explicit switch-on.
- **G-3. Existing files touched only where a feature hooks in**, each edit
  additive (listed in §4). No rename, refactor or removal.
- **G-4. Migrations 0061–0064 are additive** (new tables only, plus one new
  shop category row) and each has a tested rollback script (the
  migrate-on-build test rolls all four back and re-applies them).
- **G-5. Robust to deploy order.** The fulfilment checks on the order path
  first look whether table `order_fulfilment_arrangements` exists (once), so if
  the code goes live a minute before the migration, every existing order flow
  keeps working. The other three features read their tables only when their
  rule is on, which is only possible after the migration.

### Feature 1 — fulfilment
- **F1-1. The choice is made in the "mark ready" step** (one click with the
  plan; the server saves plan + READY in one transaction). With the rule on, the
  plain "ready" action is refused without a plan (409 `needsFulfilmentChoice`).
  The plan can also be set earlier (ACCEPTED / PREPARING) through the API.
- **F1-2. The shop's own delivery people have no GoKesari account.** The
  requirement asks only for name and phone. They act through a private delivery
  link (an HMAC-signed token, nothing secret stored; a new link when the person
  changes, dead once delivered/cancelled). Actions via the link are recorded
  against the shop owner (the shop is responsible for its staff) with the
  person's name in the note, and the owner is told. Customer details on the
  link disappear once the delivery is finished.
- **F1-3. "Keep the existing delivery-OTP completion" for own delivery** = the
  same mechanism as rider drops: a fresh 4-digit code when the order goes out,
  stored only as a salted HMAC, emailed directly, "Get a new code" with the same
  limits (rule `deliveryOtp`), wrong-code count with lockout + grievance ticket +
  support alert. For GoKesari partners the existing flow is untouched.
- **F1-4. Pickup code** = 4 digits derived with HMAC from a stored random nonce
  and the server secret, so the customer can see it any time on My Orders
  without it being stored; same 5-attempt lockout; operations can confirm a
  locked pickup after speaking to the customer.
- **F1-5. Slots**: 1-hour slots 07:00–22:00 IST, today (the current slot
  included, so "now" is always possible) to 7 days ahead; configurable. The
  shop's opening hours are not used to narrow slots (an order may be collected
  by arrangement).
- **F1-6. Changes allowed until** the order is collected (pickup), goes out
  (own delivery) or is picked up by a rider (GoKesari). Switching away from a
  GoKesari rider before pickup cancels the rider's offer/assignment (the rider is
  told; ASSIGNED → READY) and stops the search.
- **F1-7. GoKesari partner needs a delivery address and the shop's delivery
  switched on** (the existing dispatch requirements); own delivery needs an
  address. Orders without an address can only be picked up.
- **F1-8. Charges (as instructed, logged):** pickup and own-delivery orders are
  never charged the shop-wallet delivery charge (₹5/km on test) — the existing rule
  charges it only when a GoKesari rider delivered. The commission is charged from
  the shop wallet on delivery as for every order. *Superseded on 9 Oct 2026 by
  the owner's decision O-1:* the customer's delivery fee is now given back when
  the shop chooses pickup.
- **F1-9. Cash on delivery**: whoever hands over (shop at the counter, delivery
  person) confirms "cash collected", as riders do.
- **F1-10. Notifications**: customer in the app + email on set and on every
  change; the shop when support changed its plan; the rider when released. The
  plan "updated" is shown on the customer's order card.

### Feature 2 — legal documents
- **F2-1. A new "Legal documents" section** (`/shop/legal-documents`) next to
  the existing business verification (PAN / GSTIN / Udyam / FSSAI number check /
  Shop Act), because the existing FSSAI vendor check has no upload or expiry
  entry and drug licence / medical registration did not exist. The existing
  seller verification is unchanged.
- **F2-2. Who needs what**: FSSAI uses the existing food detection; drug
  licence = PHARMACY type or "pharmacy" category; medical registration = the new
  "Doctor / Clinic" category (no doctor shop type exists; categories are
  data). All lists are rule values.
- **F2-3. "Submitted" is enough to trade**; operations' approval is a review,
  and a rejection takes it away. The whole shop is restricted (not just one
  category's products — products are not tied to shop categories).
- **F2-4. Restriction** = checkout refuses the shop's orders and the shop
  cannot accept orders already placed (CONFIRMED → ACCEPTED); orders already
  accepted carry on. Shops are not hidden from the directory.
- **F2-5. Grace period** starts when a requirement is first seen for a live
  shop (daily job, dashboard visit, checkout or "Check all live shops now").
  A new shop has none (it cannot be approved without the document). A live
  shop whose document is rejected for the first time with no grace left gets
  one grace period; never more than one.
- **F2-6. Expired licence**: the same grace period counted from the expiry
  date. Reminder 30 days ahead, once per expiry date (daily job + dashboard).
  An expiry date in the past is refused on upload.
- **F2-7. Formats**: FSSAI exactly 14 digits; drug licence and medical
  registration have no single national format, so 4–40 letters/digits/`/-.()`
  with at least 3 digits. Files: PDF / JPEG / PNG / WebP up to 5 MB, type
  checked from the bytes, encrypted at rest; reviewers' views audited.
- **F2-8. Reviewers** = the existing seller-document reviewers
  (`SHOP_GST_PAN_VERIFY`: operators and admins).

### Feature 3 — bank accounts
- **F3-1. ₹1 debit-and-refund, not penny drop.** The integrated gateway is
  Cashfree PG. Crediting ₹1 to an account (penny drop) is Cashfree's separate
  Payouts / Verification product with its own keys, not integrated. PG supports
  taking ₹1 by UPI, debit card, credit card and net banking and refunding it
  through its Refunds API — chosen.
- **F3-2. What "matched account holder name" means here**: when Cashfree
  reports the payer's name, it must match the holder name (score ≥ 80, the
  existing name-match used for seller documents); when it reports the paying
  UPI ID or account (last 4 + IFSC), it must be the one given; for a card
  payment Cashfree reports neither, so the ₹1 proves a working instrument and
  the declared name is recorded with match method "payment only", visible to
  finance. Third-party validation (TPV) was not used because it would restrict
  the payment to UPI / net banking only, against the "all methods" requirement.
- **F3-3. Refund**: the ₹1 is refunded through Cashfree's Refunds API right
  after the result (also when the name did not match); the refund status and
  reference are stored.
- **F3-4. Test simulator.** Without Cashfree keys (local, CI, or a test site
  without sandbox keys) a clearly labelled "TEST MODE — no money moves"
  simulator stands in for the checkout (choose UPI / debit / credit / net
  banking and success / failure / different holder) and the same matching,
  recording, refund and notifications run. It is refused when keys are set and
  on gokesari.com (`AUTH_URL` host), where without keys verification is
  "not set up".
- **F3-5. "Required before refunds to bank"**: refunds go to the GoKesari
  wallet first. The guard `assertCustomerBankRefundAllowed` is used by the
  refund-to-bank path added on 9 Oct 2026 (O-2). Customers are prompted at
  their first checkout and in My Profile.
- **F3-6. Payout gate** sits on the settlement actions that move money
  ("process" = sent to the bank, "pay"); approving a settlement is unaffected.
  Only the shop's owner can change its payout account; finance can view it.
- **F3-7. Limits**: 5 verification attempts per user per day (rule).
- **F3-8. No webhook change.** The browser confirms after the checkout closes
  (server asks Cashfree); a bank-verification order is not in the `payments`
  table, so the existing wallet webhook ignores it and can never credit a wallet.

### Feature 4 — referral codes
- **F4-1. Valid code** = an existing shop referral code (Admin console →
  referral codes) that is ACTIVE and not expired — the existing rules.
- **F4-2. Operators / admins registering a shop for someone** are not asked
  for a code (the existing operator-only path).
- **F4-3. Location**: the browser Geolocation API (Chrome / Android use
  Google's location service), latitude/longitude to 6 decimals with accuracy,
  link `https://www.google.com/maps?q=lat,lng`. The form never waits on the
  permission prompt: sending while it is still open sends without location.
- **F4-4. Duplicates**: one request per mobile number per 24 h (configurable),
  enforced under a lock; plus a per-IP limit (5 per 10 min).
- **F4-5. Email**: sent directly at submission to every address in
  `shopReferral.notifyEmails` (default referrals@gokesari.com) through the
  existing SMTP settings; the result (sent / failed / not configured) is stored
  and shown, and operations can resend.
- **F4-6. Issuing a code** creates an ordinary referral code labelled with the
  request reference (typed, or generated as `GKS` + 6 characters); the requester
  is told in the app and by email when they were signed in.

### Decided by the owner (9 Oct 2026)
The owner answered the open questions of §6. What was built:

- **O-1. Pickup gives the customer's delivery fee back** (answer to F1-8: yes).
  - **When:** as soon as the plan becomes pickup, at "mark ready" or by
    changing the plan later. Once per order, recorded on the plan (`0065`).
  - **How:** a wallet order is refunded to the wallet, the same way a removed
    line is. A cash order is charged that much less.
  - **The order's numbers:** its delivery fee and total drop by the amount.
    So no delivery fee is booked as platform revenue at delivery, the invoice
    shows none, and a later cancellation refunds only the rest.
  - **Switching back** to a delivery option does not charge it again; the
    shop chose to deliver after all.
  - **Who is told:** the customer's "Ready for pickup" / "plan changed"
    message says so. The shop's planner shows it before and after. The
    customer's order card shows it.
  - **Rule:** `fulfilmentOptions.refundDeliveryFeeOnPickup`, on by default.
    An order with no delivery fee is unaffected.
- **O-2. Refunds to a customer's bank** (answer to F3-5: yes). Refunds still
  land in the wallet at once, as before. For `windowDays` (30) afterwards, the
  customer can send one to their verified bank account from My Wallet.
  - **What can be sent:** only the customer-funded part, never promotional
    credit or a top-up, and only what is still in the wallet.
  - **On request:** the amount leaves the wallet straight away.
  - **Finance's side** (Admin → Refunds to bank, `FINANCE_*` permissions, so
    admins): works it like a shop settlement. An audited look at the full
    account, "sent from bank", then "paid" with the bank's reference (UTR),
    or "failed" and the amount returns to the wallet.
  - **Cancelling:** the customer can cancel until finance starts.
  - **Who is told:** the customer by email and in the app at each step;
    admins in the app.
  - **Records:** table `bank_refund_requests` (`0066`).
  - **Rule:** `bankRefunds`, **off by default**, on for test only.
  - **No gateway payouts:** the site has no payouts product. Sending through
    Cashfree Payouts would be a later change.
  - **Before switching it on in production**, the Wallet Terms ("cannot be
    withdrawn as cash or transferred to a bank account") and the Refund
    Policy must be updated; suggested wording is in §5. Legal pages were not
    changed.
- **O-3. Referral code at customer registration** (answer: GoKesari owns
  referrals@gokesari.com, defines the schemes and issues the codes, and the
  app checks them whenever someone registers, shop owner or customer).
  - **Where:** the customer's first-time setup now has a "Referral code"
    field, prefilled from a `/r/CODE` link, checked when they continue.
  - **A code GoKesari issued** (Admin → Referral codes; active, unexpired;
    hyphens kept) is recorded against the customer.
  - **A friend's code** (rule `customerReferrals` on) starts the existing
    friend reward unchanged.
  - **Limits:** once per customer, and only before the first order.
  - **Admin view:** Admin → Referral requests shows how many customers joined
    with each code.
  - **Records:** table `customer_signup_referrals` (`0067`).
  - **Rule:** `customerSignupReferral`, off by default, on for test.
  - **Optional at first;** made mandatory by O-5 below.

### Decided by the owner (9 Oct 2026, second round)
- **O-4. Shops past their legal-document grace period: option B.**
  - **What customers see:** the shop shows "not taking new orders right
    now", exactly like a paused shop or one below its wallet minimum. The
    cart warns at once; checkout refuses as before. Customers are not told
    why.
  - **Reopens** as soon as the missing document is uploaded (it no longer
    blocks while it waits for review).
  - **Only documents the shop's category needs** count, as at checkout.
  - **How:** `legallyBlockedShopIds()` in `legal-documents.ts`, added to the
    existing wallet gate (`withWalletGate` in `serviceability.ts`), which
    every listing, the cart and checkout already use. No new rule: it
    follows `legalDocuments`.
- **O-5. A referral code is mandatory for customers, and they can ask for
  one.**
  - **Before the first order:** a new customer can browse and search
    (signed in or not), but checkout and a new subscription are refused
    until they give a code. A saved draft subscription is allowed.
  - **Which code:** one GoKesari issued, or a friend's invite code (O-6).
  - **Where they see it:** first-time setup asks for it ("needed before your
    first order"; no code → setup ends on My referral code). The cart shows
    a warning with a link. The account menu has "My referral code"
    (`/referral`).
  - **Asking for a code** (My referral code): the customer's Google location
    (when they allow it; latitude, longitude, Maps link), contact number,
    city and PIN code, and their name.
    - The request is saved with a reference `CRR-…`.
    - Operations are told in the app.
    - The referrals team gets an email with every field (the same
      `shopReferral.notifyEmails` list as shop owners' requests).
    - One request per customer or mobile number within
      `requestDuplicateWindowHours` (24).
  - **Operations** (Admin → Referral requests → "Customers asking for a
    code"): call or send someone, then issue a code (typed, or generated
    `GKC…`) or decline with a reason. The customer is told in the app and by
    email, the code appears on My referral code with "Use this code", and
    they can order.
  - **Who is never stopped:**
    - customers who already ordered;
    - customers who joined before `requiredFrom` (a date; empty = every
      customer without an order);
    - shop owners (they gave a code at shop registration) and staff.
  - **Records:** table `customer_referral_requests` (`0072`; 0068–0071 are
    the three-modules work merged on staging in between).
  - **Rule:** `customerSignupReferral.required` / `requiredFrom` /
    `requestDuplicateWindowHours`, off by default. On for test with
    `requiredFrom` 2026-10-09, so existing test customers keep ordering.
- **O-6. Search without signing in; anyone can invite.**
  - **Search:** was already public. Confirmed on test: `/search?q=milk`
    signed out lists the products. Adding to the cart asks the customer to
    sign in, as before.
  - **Invite codes:** every signed-in user (customer, shop owner, delivery
    partner, staff) already had an invite code and link at `/refer` (rule
    `customerReferrals`). It was only linked from My Wallet. The account
    menu now has "Invite friends" whenever that rule is on. A friend's code
    counts as the mandatory referral code (O-5).
- **O-7. Cashfree's account-verification product: buy it.** Not built yet.
  It needs the product activated on the Cashfree account and its sandbox
  keys (§6).

### Found and decided during the staging run (8–9 Oct 2026)
- **S-1. Repeated requests are harmless.** On test a "Packed — mark ready"
  was executed twice. A double tap, or the slow test server's edge repeating a
  long request, could cause it. The second answered 409 although the first had
  worked. A repeated "mark ready" with the plan already applied, a repeated
  pickup completion and a concurrent "start delivery" now answer with what was
  done. Nothing happens twice: one notification, one wallet charge, one code email.
- **S-2. ₹1 refund status is re-checked.** Cashfree first answers a refund as
  PENDING. The status is now asked again, by our own refund id, whenever the
  account is shown to its holder or to finance, and recorded as REFUNDED (or
  FAILED when Cashfree cancelled it). Only the latest attempt of an account
  that is shown gets re-checked. The ₹1 of an account replaced since then stays
  PENDING in our records, even though Cashfree refunds it the same way, and
  Cashfree's dashboard is the place to see it.
- **S-3. Small UI fixes.** A corrected referral code no longer shows the last
  submit's error. "FSSAI licence" keeps its capitals mid-sentence. The
  rider-search note is hidden on pickup and own-delivery orders.
- **S-4. Lock alerts are in-app.** A locked pickup or own-delivery code tells the
  customer, the shop and support in the app straight away, with the ticket
  number. Emails go only where the event catalogue marks EMAIL (the delivery code
  itself, plan set / changed, decisions on legal documents).
- **S-5. Some emails on test were late or never sent: the mail host's sending
  limit.** The test site's mailbox has an hourly cap at Hostinger. During the
  run, nine test accounts were emailed about every step, and Hostinger began
  refusing messages: `451 4.7.1 Ratelimit "hostinger_out_ratelimit" exceeded`.
  The existing outbox did what it is built to do. It kept every in-app
  notification, retried each email with back-off, and after 4 attempts marked
  some as DEAD and alerted support (`notifications.maxAttempts`). This hit
  every kind of email, old and new alike, so no code was changed. The test
  report lists the outbox for the test accounts (`test-report.sql`). For
  production, see §5 item 2.
- **S-6. A repeated "ask for a code" showed an error (fixed, 9 Oct).** On
  test, the customer's request was saved, but the host's CDN answered the
  browser's POST with a 307 and the browser sent it again. The repeat hit the
  one-request rule, so the customer saw "We already have your request"
  instead of "Request received".
  - **Fix:** the same request from the same customer within 2 minutes (same
    contact number, city and PIN) is now answered as the first one: same
    reference, no second email.
  - **Other forms:** the CDN can do this to any POST. Checkout and payments
    already carry a request id, so a repeat is harmless there. The shop
    owner's "request a code" form would show the same "already have your
    request" message in that case; the request itself is not lost.
- **T-1. How the staging run signed in.** Test accounts are plus-aliases of the
  owner's mailbox (sanjaymorankar+gk-*@gmail.com), signing in with the real
  email code. `test-e2e-accounts.sql` gave one of them ADMIN and one OPERATOR on
  the test database. Remove them after testing (commands in that file).
- **T-2. Readable copy of the referral email.** On test only, `shopReferral.notifyEmails`
  also lists sanjaymorankar+gk-referrals@gmail.com, so the email's arrival and
  content could be checked. Remove it in Business rules → shopReferral when done.
- **T-3. Cashfree sandbox from a GitHub runner.** The session that ran the tests
  cannot reach Cashfree (its network policy blocks the host). The site itself
  created each ₹1 order and confirmed and refunded it with Cashfree as normal.
  Only the "customer pays" step ran on a GitHub runner (`.github/workflows/sandbox-pay.yml`,
  sandbox only, no secrets), using Cashfree's test instruments: UPI
  testsuccess@gocash / testfailure@gocash, credit card 4111 1111 1111 1111,
  debit card 4706 1312 1121 2123, net banking (bank 3003), OTP 111000.

---

## 3. Migrations, deploy and rollback

All four are additive. **Migrate first, deploy second** (DEPLOY_RUNBOOK §0) —
although this release tolerates the reverse order (G-5).

**Test (automatic):** merging into `staging` runs the "Test database"
workflow: back up → migrate (0061–0067 and 0072 are this work) → apply
`test-settings.sql` → verify.
Manual alternative: `DATABASE_URL=<test db> npm run db:migrate`, then
`psql "$TEST_DATABASE_URL" -f docs/four-features-2026-10/test-settings.sql`.

**Rollback** (each feature independently):
1. Switch the feature off: Admin → Business rules → `fulfilmentOptions` /
   `legalDocuments` / `bankAccounts` / `shopReferral` / `bankRefunds` /
   `customerSignupReferral` → Restore default (or set
   `fulfilmentOptions.refundDeliveryFeeOnPickup` to false). The app
   is then as before (planned orders already in progress still complete through
   their plan; finish them first if you roll back code).
2. Code: revert the merge on `staging`; Hostinger redeploys.
3. Schema (only after the old code is live): run `scripts/rollback-0072.sql`
   (customer requests for a code are lost, codes already issued stay), then
   `-0067`, `-0066`, `-0065`, `-0064`, `-0063`, `-0062`, `-0061` (newest first, any
   subset; settle open refunds to bank before 0066). Delete each rolled-back
   migration's row from `drizzle.__drizzle_migrations` (match `created_at` to
   its `when` in `drizzle/meta/_journal.json`, e.g.
   `node -e "console.log(require('./drizzle/meta/_journal.json').entries.find(e=>e.tag.startsWith('0072_')).when)"`).
   0068–0071 belong to the three-modules work and have their own rollbacks;
   leave them unless that work is rolled back too.
   Back up first — plans, documents, bank accounts and requests are lost.

---

## 4. Files

New files (all under the paths below):

* Schema/migrations: `drizzle/0061_fulfilment_options.sql`, `0062_legal_documents.sql`,
  `0063_bank_accounts.sql`, `0064_referral_code_requests.sql` (+ `drizzle/meta`),
  `scripts/rollback-0061.sql` … `rollback-0064.sql`.
* Libraries: `src/lib/fulfilment-options.ts`, `legal-documents.ts`, `bank-accounts.ts`, `referral-requests.ts`.
* Services: `src/server/services/fulfilment-options.ts`, `fulfilment-guards.ts`,
  `legal-documents.ts`, `bank-accounts.ts`, `referral-requests.ts`.
* API: `src/app/api/orders/[id]/fulfilment-plan/{route,handover/route,code/route}.ts`,
  `src/app/api/shops/[id]/delivery-staff/{route,[staffId]/route}.ts`,
  `src/app/api/delivery-link/[token]/route.ts`,
  `src/app/api/shops/[id]/legal-documents/route.ts`, `src/app/api/legal-documents/files/[fileId]/route.ts`,
  `src/app/api/admin/legal-documents/{route,[id]/decision/route,sweep/route}.ts`,
  `src/app/api/bank-account/{route,schema}.ts`, `src/app/api/bank-account/verification/{route,confirm/route,simulate/route}.ts`,
  `src/app/api/shops/[id]/bank-account/route.ts`, `src/app/api/admin/bank-accounts/route.ts`,
  `src/app/api/referral-requests/route.ts`, `src/app/api/referral-codes/check/route.ts`,
  `src/app/api/admin/referral-requests/{route,[id]/route}.ts`.
* Pages: `src/app/shop/delivery-staff`, `src/app/delivery/[token]`, `src/app/shop/legal-documents`,
  `src/app/admin/legal-documents`, `src/app/profile/bank-account`, `src/app/shop/bank-account`,
  `src/app/admin/bank-accounts`, `src/app/admin/referral-requests`.
* Components: `fulfilment-planner.tsx`, `order-fulfilment-card.tsx`, `delivery-staff-manager.tsx`,
  `staff-delivery-view.tsx`, `legal-documents-panel.tsx`, `legal-documents-banner.tsx`,
  `legal-document-review-queue.tsx`, `bank-account-manager.tsx`, `bank-account-prompt.tsx`,
  `referral-request-dialog.tsx`, `referral-request-queue.tsx`.
* Tests: `tests/integration/fulfilment-options.test.ts`, `legal-documents.test.ts`,
  `bank-accounts.test.ts`, `referral-codes.test.ts`.
* Docs: this folder.

Added on 9 Oct 2026 (O-1 to O-3):
* Migrations: `drizzle/0065_pickup_delivery_fee_refund.sql`, `0066_bank_refund_requests.sql`,
  `0067_customer_signup_referrals.sql` (+ `drizzle/meta`), `scripts/rollback-0065.sql` … `rollback-0067.sql`.
* Services: `src/server/services/bank-refunds.ts`, `customer-signup-referrals.ts`
  (O-1 lives in `fulfilment-options.ts`: `refundDeliveryFeeForPickup`).
* API: `src/app/api/bank-refunds/{route,[id]/cancel/route}.ts`,
  `src/app/api/admin/bank-refunds/{route,[id]/route,[id]/account/route}.ts`,
  `src/app/api/me/signup-referral/route.ts`.
* Pages / components: `src/app/admin/bank-refunds/page.tsx`, `src/components/bank-refunds-panel.tsx`,
  `bank-refund-queue.tsx`.
* Tests: `tests/integration/bank-refunds.test.ts`, `customer-signup-referrals.test.ts`;
  four new cases in `fulfilment-options.test.ts`.

Added on 9 Oct 2026, second round (O-4 to O-6):
* Migration: `drizzle/0072_customer_referral_requests.sql` (+ `drizzle/meta`), `scripts/rollback-0072.sql`.
* Service: `src/server/services/customer-referral-requests.ts`; in `customer-signup-referrals.ts`
  `needsSignupReferralCode` / `assertSignupReferralForFirstOrder`; in `legal-documents.ts`
  `legallyBlockedShopIds` (O-4).
* API: `src/app/api/me/referral-request/route.ts`,
  `src/app/api/admin/customer-referral-requests/{route,[id]/route}.ts`.
* Pages / components: `src/app/referral/page.tsx`, `src/components/customer-referral-code.tsx`,
  `customer-referral-request-queue.tsx`.
* Tests: `tests/integration/customer-referral-requests.test.ts`,
  `tests/unit/customer-referral-request-check.test.ts`; `legal-documents.test.ts` updated for O-4.

Existing files touched (additive; exact lines in [EXISTING_FILE_CHANGES.md](EXISTING_FILE_CHANGES.md)):
`src/server/db/schema.ts` (new tables appended), `src/server/config/rules.ts`
(4 rule groups appended), `src/server/notifications/types.ts`,
`src/server/services/audit.ts`, `src/server/events/catalog.ts` (new entries),
`src/server/services/orders.ts` (3 hook lines), `src/server/services/delivery-assignment.ts` (1),
`src/server/services/fulfilment.ts` (optional parameter + 2 lines),
`src/server/services/shops.ts` (1), `src/app/api/shops/route.ts` (3),
`src/app/api/finance/settlements/[id]/route.ts` (1),
`src/app/api/cron/seller-verification/route.ts` (sweep added to the response),
`src/components/shop-order-manager.tsx`, `src/components/shop-register-form.tsx`,
`src/components/site-header.tsx`, `src/app/shop/orders/page.tsx`,
`src/app/orders/page.tsx`, `src/app/shop/page.tsx`, `src/app/profile/page.tsx`,
`src/app/cart/page.tsx`, `src/app/shop/register/page.tsx`,
`.github/workflows/test-db.yml`, `scripts/test-db/verify.sh`,
`tests/integration/migrate-on-build.test.ts` (counts later migrations instead of exactly four).

---

## 5. Production (gokesari.com) — needed before going live

Nothing here touches production. When you decide to promote:

1. **Cashfree live keys** must be set (`CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`,
   `CASHFREE_ENV=production`) — the ₹1 verification needs the Refunds API on the
   account (enabled by default on Cashfree PG; confirm with Cashfree). Without
   keys production shows "payments are not set up" (no simulator there).
2. **Email**: `AUTH_EMAIL_FROM` / `AUTH_EMAIL_SERVER` set, and the mailbox
   **referrals@gokesari.com** must exist and receive mail (check spam rules /
   SPF/DKIM for the sending domain). Check the **hourly sending limit** of the
   mailbox the site sends from (S-5). A busy day of orders sends more than the
   test run did, so raise the limit with the host or send through a
   transactional email service.
3. **`PAN_ENCRYPTION_KEY`** set (already, for PANs) — bank account numbers and
   licence copies use it.
4. **Daily cron** `POST /api/cron/seller-verification` (06:30 IST) — it now also
   starts legal-document grace periods and sends expiry reminders.
5. Migrate 0061–0067 and 0072, along with whatever else staging carries
   (Production database workflow / `npm run db:migrate`), then
   switch each rule on in Admin → Business rules, one at a time.
6. **Create referral codes** for shop owners before switching `shopReferral.required`
   on, or new registrations will be blocked until codes are issued.
7. Tell shop owners about the 15-day legal-document grace period before switching
   `legalDocuments` on.
8. **Refunds to bank (`bankRefunds`)**: before switching it on, update the
   **Wallet Terms** and the **Refund Policy** (have them approved). Today they
   say the wallet cannot be transferred to a bank account. Suggested wording,
   for your lawyer to check:
   - *Wallet Terms*: replace "It cannot be withdrawn as cash or transferred to
     a bank account, UPI ID, or any external payment method." with "It cannot
     be withdrawn as cash. Money refunded to your wallet (not promotional
     credit, not top-ups) can be sent to your own verified bank account
     within 30 days of the refund; see the Refund Policy."
   - *Refund Policy*, "How refunds are paid", add: "Within 30 days of a
     refund you can ask for it to be sent to your verified bank account
     instead (My Wallet). It leaves your wallet straight away and reaches your
     bank within 5 working days; if the transfer fails, it returns to your
     wallet."

   Also decide who in finance sends these transfers, and how often.
9. **Customer referral codes (`customerSignupReferral`)**: create the codes for
   your schemes in Admin → Referral codes first (the same codes shop owners
   use).
   - **Mandatory (`required`):** set `requiredFrom` to the launch date, so
     customers who joined before it keep ordering.
   - **Before switching it on:** make sure someone watches Admin → Referral
     requests and the referrals@gokesari.com mailbox every day. New
     customers cannot order until they get a code.
   - **Invite codes:** turn on `customerReferrals` too if friends' invite
     codes should count.

## 6. Decisions needed from you
All answered and built: O-1 to O-3, then O-4 to O-6 (§2). Still open:

1. **Refunds to bank:** approve the Wallet Terms / Refund Policy wording
   (§5 item 8). Also say who in finance sends the transfers, and how often.
   Until then `bankRefunds` stays off in production.
2. **Cashfree's account-verification product (O-7, approved).** To build it:
   activate "Verification Suite" (bank account verification) on the Cashfree
   account. Then put its **sandbox** client id and secret in the test
   environment's settings, the same way as the payment keys; they are never
   in code. When it is live, every bank account a customer or shop adds is
   checked with the bank, and the bank's name for the holder is shown and
   compared with the name given. The ₹1 payment stays as a fallback.
