# Test checklist: four features on test.gokesari.com

Run this on the **test site only**. Before you start:

1. Migrations **0061–0064** are applied to the test database. Merging into
   `staging` does this through the "Test database" workflow, after a backup.
2. [test-settings.sql](test-settings.sql) is applied. The same workflow runs it
   when the file changes on `staging`. It switches on the rules
   `fulfilmentOptions`, `legalDocuments` (15-day grace, 30-day reminders),
   `bankAccounts` (verified account needed for shop payouts) and
   `shopReferral` (code required; emails to referrals@gokesari.com).
3. SMTP is working on test. Sign-in codes already go by email.

**Accounts:** a customer, a shop owner (approved shop with delivery switched
on and some wallet balance), a GoKesari rider (approved, online, near the
shop), an operator and an administrator. Run every screen at **phone width
(390 px)** and at **desktop width (1280 px)**.

## 1. Delivery options and scheduling

| # | Do | Expected |
|---|---|---|
| 1.1 | Shop owner: **Delivery staff** (menu) → add "Ravi", 98xxxxxxxx | Listed as active. A duplicate mobile or a 9-digit mobile is refused |
| 1.2 | Edit Ravi's name. Deactivate, then reactivate | Saved each time. A deactivated person cannot be chosen |
| 1.3 | Customer orders (with a delivery address). Shop **Accepts**, then opens the order | The old "Mark ready" button is replaced by "Packed: choose delivery". Three options with day + slot pickers |
| 1.4 | Mark ready with plain `POST /api/orders/<id>/fulfilment {"action":"ready"}` | `409`, `needsFulfilmentChoice: true` |
| **A** | **Pickup** | |
| 1.5 | Choose **Pickup from the shop**, today, current slot → Mark ready | READY. Customer gets "Ready for pickup" in the app and by email. My Orders shows option, time and a 4-digit **pickup code** |
| 1.6 | Shop presses Mark delivered / Out for delivery (API) | `409`. A pickup completes only with the code |
| 1.7 | Shop enters a wrong code | "does not match, 4 attempts left" |
| 1.8 | Shop enters the right code | DELIVERED. The customer is told. No shop-wallet delivery charge, commission only |
| **B** | **Shop's own delivery** | |
| 1.9 | New order → choose **Shop's own delivery**, Ravi, a later slot → Mark ready | READY. Customer told "Shop's own delivery, Ravi, <slot>". The shop sees the delivery link with Copy and WhatsApp buttons |
| 1.10 | **Change** to another slot, then to Pickup, then back to own delivery | Each change is saved and the customer is notified each time. My Orders shows "updated" |
| 1.11 | Open the delivery link (signed out, phone width) | Address, call buttons, items and cash to collect. **Start delivery** |
| 1.12 | Start delivery | OUT_FOR_DELIVERY. The customer is emailed the delivery code. Changing the plan is now refused |
| 1.13 | Wrong code ×5 on the link | Locked. Grievance ticket raised. Customer, shop and support told |
| 1.14 | On another order: right code on the link | DELIVERED. The link then shows "Delivered" with no customer details. No shop-wallet delivery charge |
| 1.15 | Customer: **Get a new code** while out for delivery | New code emailed. The old one is refused |
| **C** | **GoKesari delivery partner** | |
| 1.16 | New order → **GoKesari delivery partner**, current slot → Mark ready | Rider search starts at once (existing flow). The rider accepts and completes with the existing pickup and delivery codes. The shop-wallet charge applies as before |
| 1.17 | New order → GoKesari, slot 3 hours later | READY, but no rider is searched yet. The search starts 45 min before the slot (dispatch sweep). "Find rider now" still works at once |
| 1.18 | GoKesari order with a rider ASSIGNED → change to Pickup | The rider is released and told. Order back to READY. Customer told |
| 1.19 | After the rider has picked it up → try to change | Refused |
| 1.20 | Another shop's owner calls `GET /api/orders/<id>/fulfilment-plan` | `403` / `404` |

## 2. Mandatory legal documents

| # | Do | Expected |
|---|---|---|
| 2.1 | New food shop registers (Bakery). Admin tries to approve it | Refused: "upload FSSAI licence" |
| 2.2 | Owner: **Legal documents** → FSSAI `1234567890123` (13 digits) | "must be exactly 14 digits" |
| 2.3 | FSSAI 14 digits, expiry date in the past | Refused |
| 2.4 | FSSAI 14 digits, future expiry, a `.txt` file renamed `.pdf` | Refused (the file type is read from its bytes) |
| 2.5 | Valid FSSAI number, expiry and PDF | SUBMITTED. Support told. Admin can now approve the shop |
| 2.6 | **Pharmacy** shop → Legal documents | Drug licence asked for (number, expiry, upload) |
| 2.7 | **Doctor / Clinic** category shop | Medical registration asked for (number, **issuing council**, upload) |
| 2.8 | Operator: **Legal documents** queue → open the copy → **Reject** with "blurred" | Shop sees "Rejected: blurred" and is told by email |
| 2.9 | Owner re-uploads → operator **Approves** | APPROVED. Shop told |
| 2.10 | Existing live food shop without FSSAI (or "Check all live shops now") | Dashboard prompt "15 days left", plus an email. The shop keeps trading |
| 2.11 | Set its `grace_until` to the past (SQL) → customer checks out from it | Refused. The shop cannot accept orders until it uploads |
| 2.12 | Document expiring in 20 days → sweep | One reminder (dashboard + email). It does not repeat |
| 2.13 | A customer or another shop's owner opens `/api/legal-documents/files/<id>` | `404` |

## 3. Bank account and ₹1 verification

| # | Do | Expected |
|---|---|---|
| 3.1 | Customer: **Bank account** → account 12 digits, IFSC `SBIN0001234`, name | Saved as **Pending**. The page shows only the last 4 digits. The database holds it encrypted |
| 3.2 | IFSC `SBIN1234567`, or the account number typed twice differently | Refused |
| 3.3 | **Verify with ₹1** → **UPI** → success | **Verified**: matched name, time, method UPI, reference. ₹1 refunded (status REFUNDED). Customer told |
| 3.4 | Change the account number | A new **Pending** account. The old one is superseded |
| 3.5 | Verify → **Debit card** → success | Verified (match method recorded) |
| 3.6 | Change again → verify → **Credit card** → **failure** | **Failed**, with the reason. **Try again** works |
| 3.7 | Verify with the payer name "Someone Else" | Failed: name does not match. ₹1 still refunded |
| 3.8 | Shop owner: **Payout bank account** → UPI ID → verify by UPI | Verified |
| 3.9 | Shop with no verified account: finance tries to **process / pay** a settlement | Refused: "needs a verified bank account" |
| 3.10 | Cart at the first checkout, and My Profile | A friendly prompt to add a bank account. Checkout is **not** blocked |
| 3.11 | 6th verification attempt in a day | Refused (limit 5) |
| 3.12 | Finance: **Bank accounts** screen | All accounts, masked. A customer gets `403` |

With Cashfree sandbox keys on test the Cashfree checkout opens. Use
Cashfree's test UPI ID / test cards. Without keys the **TEST MODE** simulator
stands in, and the page says so.

## 4. Referral code at registration

| # | Do | Expected |
|---|---|---|
| 4.1 | Admin creates referral code `E2ETEST1` (Admin console → Referral codes) | Active |
| 4.2 | New user → **Register a shop** with no code | "Enter the referral code…". Nothing is created |
| 4.3 | Code `NOPE123` | "not valid". Blocked |
| 4.4 | Code `E2ETEST1` | Registered. The referral report shows the shop under E2ETEST1 |
| 4.5 | **Request a referral code** → allow location → fill in → Send | Confirmation with an RCR-… reference. Request saved with lat/lng and a Maps link. Email to **referrals@gokesari.com** with every field (`email_status = SENT`) |
| 4.6 | Same, with location **denied** | Saved as "location not shared". Email says so |
| 4.7 | Same mobile again within 24 h | Refused, showing the first reference |
| 4.8 | PIN `012345` or `12345` | Refused |
| 4.9 | Operator: **Referral requests** → **Issue code** → then reject another one | Status "code issued" with the code. "rejected" with a reason |

## 4a. Added on 9 Oct 2026 (the owner's decisions)

| # | Step | Expected |
|---|---|---|
| O1.1 | Shop: a wallet-paid order with a ₹20 delivery fee → choose **Pickup** in the planner | Hint: "the customer's ₹20.00 delivery fee goes back to them" |
| O1.2 | "Packed — mark ready" | Customer's wallet +₹20 ("Delivery fee refund…"). Order total −₹20, fee 0. "Ready for pickup" message says the fee was refunded. The customer's order card and the shop's planner both say so |
| O1.3 | Change to own delivery and back to pickup; then complete the pickup | No second refund, no charge. Shop wallet: commission only |
| O2.1 | Customer with a verified bank account: **My Wallet → Send a refund to your bank** | Recent refunds listed (customer-funded part), with the account they go to |
| O2.2 | Send one → confirm | Leaves the wallet at once. "On its way" and an email. Finance (admins) get an in-app alert |
| O2.3 | Admin → **Refunds to bank** → Show account details → Mark sent → Paid with a UTR | Full details shown to finance only, and audited. Customer: "Paid to your bank" with the reference |
| O2.4 | Another refund → finance marks it **Failed** | Back in the wallet; the customer is told. It can be sent again |
| O2.5 | Another → the customer **cancels** before finance starts | Back in the wallet |
| O2.6 | No verified account / promotional refund / refund older than 30 days | Not offered or refused; a prompt to verify the account |
| O3.1 | A **new** customer signs in → first-time setup | "Referral code (optional)" field |
| O3.2 | Wrong code → Save | Error on the field; nothing saved |
| O3.3 | A code GoKesari issued (e.g. `E2EANIL1`) → Save | Accepted; continues to the address step. Admin → Referral requests → "Customers who joined with a code" counts it |
| O3.4 | After the first order | Not asked any more; a code is refused |

## 4b. Added on 9 Oct 2026, second round (the owner's decisions)

| # | Step | Expected |
|---|---|---|
| O4.1 | A shop whose required legal document is past its grace period (Admin → Legal documents → grace over) | Listed as "not taking new orders right now"; a cart with its items warns at once; checkout refuses. Customers are not told why |
| O4.2 | The shop uploads the document | Back to normal straight away, before review |
| O5.1 | Signed out: search `milk`, open a shop | Products and shops shown; adding to the cart asks you to sign in |
| O5.2 | A **new** customer: first-time setup | "Referral code" field: "Needed before your first order". Left empty → setup ends on **My referral code** |
| O5.3 | Browse, search, add to cart | Allowed. Cart: "A referral code is needed for your first order" with a link |
| O5.4 | Checkout | Refused: "Enter your referral code before your first order — or ask us for one" |
| O5.5 | My referral code → **Ask us for one**: allow location; contact number, city, PIN | "Request received" with `CRR-…`. Admins/operators get an in-app alert. referrals@gokesari.com (and the test alias) get an email with every field and the Google Maps link |
| O5.6 | Ask again | "We already have your request (CRR-…)" |
| O5.7 | Admin → Referral requests → **Customers asking for a code** → Issue a code | Code created (`GKC…` or typed). The customer gets an in-app message and email with the code; My referral code shows it with **Use this code** |
| O5.8 | Use this code → checkout | Order placed |
| O5.9 | Decline another request with a reason | The customer is told, with the reason |
| O5.10 | An existing customer (joined before 9 Oct) with no order; a shop owner | Not stopped |
| O6.1 | Any signed-in user (customer, shop owner, delivery partner): menu → **Invite friends** | Own invite code and link. A new customer who uses it at setup can order |
| O7.1 | Admin → Bank accounts | "Bank check with Cashfree" card: Rule on; Keys found (sandbox), with the variable names (no values) and the two-factor mode |
| O7.2 | **Test connection** | Cashfree's answer for its sample account (VALID, JOHN DOE) and the server's outbound IP; or the error (e.g. IP not whitelisted) |
| O7.3 | Customer → Bank account for refunds → save 026291800001191 / YESB0000262, holder "John Doe" | "Saved and verified with your bank — no ₹1 payment needed"; "Verified with your bank · name at bank …" |
| O7.4 | A name that does not match, or Cashfree's failure sample account | "Your bank did not confirm these details" with the reason; no "Verify with ₹1" button |
| O7.5 | Cashfree refusing (2FA) | Saved; "We could not reach your bank"; ₹1 and "Check with my bank again" offered |
| O7.6 | `bankAccountCheck` off | Exactly as before: "Saved. Now verify it with a ₹1 payment" |
| O8.1 | `bankRefunds` on: open /legal/wallet-terms and /legal/refund-policy (signed out is fine) | The approved wording: "It cannot be withdrawn as cash. Money refunded to your wallet … within 30 days of the refund" and "Within 30 days of a refund you can ask for it to be sent to your verified bank account … within 5 working days". With the rule off (production today), the old "cannot be … transferred to a bank account" bullet and no paragraph |

## 5. Regression (existing flows)

Registration · sign-in (email code) · browse · cart · checkout (wallet) ·
wallet top-up (Cashfree sandbox) · shop accept · rider pickup and delivery
with the delivery code · shop wallet charge · cancel and refund · admin
approve shop. Everything behaves as before. With a rule switched off
(Admin → Business rules → Restore default), its feature disappears and the
old behaviour returns.
