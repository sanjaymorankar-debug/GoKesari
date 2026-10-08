# Test checklist — shop wallet + OTP-confirmed delivery (test.gokesari.com)

Run on the **test site only**. Before starting:

1. Migration **0059** applied to the test database (merging the PR into
   `staging` does this automatically through the "Test database" workflow,
   after a backup; or run `npm run db:migrate` against the test database).
2. `test-settings.sql` (this folder) applied to the test database (the "Test
   database" workflow does it when the file changes on `staging`) — switches rule
   `shopWallet` on with the agreed amounts: ₹25 delivery charge, ₹200
   minimum, reminder below ₹300, 1% platform commission; 5 wrong codes, a
   new code at most every 60 s and 3 per delivery.
3. SMTP working on test (the delivery code goes by email; sign-in codes already do).
4. `test-wallet-credits.sql` gave **Kesari Dairy Farm** ₹500 and **Asmy Exports**
   ₹1,000 ("Credit by GoKesari" in their wallet history), so they can accept
   orders straight away. Section 0 starts from ₹0, so run it with another shop,
   or expect that credit row first.

**Accounts:** a customer with wallet money; a shop owner (approved shop,
delivery on, verified location); two riders (approved, online, near the
shop); an operator; an administrator.

**Useful queries** (replace the ids):

```sql
-- The shop's wallet and ledger, newest first
select balance_paise, low_balance_notified_at from shop_wallets where shop_id = '<shop id>';
select seq, type, direction, amount_paise, balance_before_paise, balance_after_paise, order_id, reason, created_at
from shop_wallet_transactions where shop_id = '<shop id>' order by seq desc limit 20;

-- The delivery's code state (never the code itself)
select status, delivery_otp is not null as plain_code, delivery_otp_hash is not null as hashed_code,
       delivery_otp_attempts, delivery_otp_resends, delivery_otp_sent_at, delivery_otp_used_at,
       delivery_otp_locked_at, delivery_otp_ticket_id
from delivery_orders where order_id = '<order id>';

-- Events and who was told
select created_at, type, from_status, to_status, notified from domain_events
where order_id = '<order id>' order by created_at;
```

Amounts below assume one ₹105 item, 1% commission and the ₹25 charge:
commission ₹1.05 + delivery charge ₹25 = **₹26.05** per rider-delivered order.

## 0. Wallet and recharge

| # | Do | Expected | Pass? |
|---|---|---|---|
| 0.1 | Shop owner opens **Wallet** (header menu) | Balance ₹0, minimum ₹200, commission 1%, delivery charge ₹25, "recharge to accept orders" badge, red banner on My Shop and Orders | |
| 0.2 | Recharge ₹500 (Cashfree sandbox) | Balance ₹500; ledger row "Recharge +₹500, balance after ₹500"; owner gets "Shop wallet recharged" ✉; banner gone | |
| 0.3 | Reload the Cashfree return / press verify again | No second credit (ledger still one recharge row) | |
| 0.4 | Another shop owner calls `GET /api/shops/<shop id>/wallet` | `403` | |
| 0.5 | Admin → **Shop wallets** → Debit ₹10,000 "test" | Refused: wallet holds less; nothing written | |
| 0.6 | In SQL: `update shop_wallets set balance_paise = 999999 where shop_id = '<shop id>';` | Error: *balance_paise changes only through shop_wallet_transactions* | |

## 1. Correct OTP

| # | Do | Expected | Pass? |
|---|---|---|---|
| 1.1 | Customer orders; shop **Accepts**, packs, **Mark ready**; rider accepts, enters pickup code, **Start delivery** | Order `OUT_FOR_DELIVERY`. Customer gets an email *"#### is your delivery code for order …"*. `delivery_otp_hash` set, `delivery_otp` **null** (no plain code in the database) | |
| 1.2 | Customer opens **My Orders** | "Your delivery code was emailed to a***@…" and **Get a new code**; the code itself is not on the page | |
| 1.3 | Rider enters the emailed code, **Mark delivered** | Order `DELIVERED`, delivery `DELIVERED`, `delivery_otp_used_at` set and hash cleared | |
| 1.4 | Shop wallet ledger | Two new rows linked to the order: **Commission −₹1.05** and **Delivery charge −₹25.00**, each with its balance after; balance ₹473.95 | |
| 1.5 | Notifications, at once (no cron) | Shop: "Order delivered — wallet charged … commission ₹1.05, delivery charge ₹25.00. New balance: ₹473.95" ✉ · Customer: "Order delivered" ✉ · Rider: "Delivery confirmed" 🔕 | |
| 1.6 | Shop → **Finance** | The order's payable is the full ₹105 (commission already paid from the wallet; not withheld again) | |

## 2. Wrong OTP

| # | Do | Expected | Pass? |
|---|---|---|---|
| 2.1 | On a started drop, rider enters a wrong code | Error "That delivery code does not match. 4 attempts left …"; order still `OUT_FOR_DELIVERY`; `delivery_otp_attempts` = 1; **no** wallet rows | |
| 2.2 | Rider then enters the right code | Delivered and charged once (as 1.3–1.5) | |

## 3. Lockout

| # | Do | Expected | Pass? |
|---|---|---|---|
| 3.1 | On a started drop, enter 5 wrong codes | 5th answer: "Too many wrong codes — this delivery is locked and support ticket GRV-###### has been raised". Rider screen shows **Delivery locked**, no code box | |
| 3.2 | Support ticket | Admin → Grievances: ticket GRV-…, category Order, "Delivery code locked — order …", customer's email and phone, linked to the order | |
| 3.3 | Alerts | Customer: "We're checking your delivery" (ticket number) ✉ · Shop: "Delivery code locked" 🔕 · every operator/admin: "Delivery code locked — confirm the drop" ✉ | |
| 3.4 | Rider enters the **right** code now | Still refused (locked); no wallet rows | |
| 3.5 | Customer presses **Get a new code** | Refused — "on hold … support will contact you (ticket …)"; page shows the on-hold note | |
| 3.6 | Operator confirms the delivery (exceptions queue / `confirm-delivery` with a proof note) | Order `DELIVERED`; wallet charged **once** (₹26.05); rider gets "Delivery confirmed" | |
| 3.7 | Change rule `deliveryOtp.maxAttempts` to 3; repeat 3.1 | Locks after 3 | |

## 4. Resend

| # | Do | Expected | Pass? |
|---|---|---|---|
| 4.1 | Right after the drop starts, customer presses **Get a new code** | Refused: "Please wait N seconds…" (60 s cooldown from the first email) | |
| 4.2 | After 60 s, press again | New code shown once on the page and emailed; "Your earlier code no longer works" | |
| 4.3 | Rider enters the **old** code | Refused as wrong (counts an attempt) | |
| 4.4 | Rider enters the **new** code | Delivered | |
| 4.5 | On another drop, request 3 new codes (60 s apart), then a 4th | 4th refused: "as many new codes as this delivery allows"; the button disappears | |
| 4.6 | Another customer calls `POST /api/orders/<order id>/delivery-code` | `404` | |

## 5. Double submit

| # | Do | Expected | Pass? |
|---|---|---|---|
| 5.1 | Rider double-taps **Mark delivered** with the right code (or two phones / two tabs at once) | One delivery; the second answer is the same delivered row, no error | |
| 5.2 | Ledger | Exactly one Commission and one Delivery charge row for the order | |
| 5.3 | In SQL, try to insert a second COMMISSION row for the same order | Refused by `shop_wallet_txn_order_charge_unique` | |

## 6. Wrong delivery partner

| # | Do | Expected | Pass? |
|---|---|---|---|
| 6.1 | Second rider (signed in) sends `PATCH /api/delivery-orders/<delivery id>` `{ "action": "deliver", "otp": "<right code>" }` | `403` "This delivery assignment does not belong to you."; attempts unchanged; order not delivered | |
| 6.2 | The customer sends the same request | `403` (no rider permission) | |
| 6.3 | The assigned rider's API responses / dashboard | Never contain the code or its hash (`needsDeliveryOtp: true` only) | |
| 6.4 | While the rider holds the order, the shop looks for "Mark delivered" on Orders, or sends `PATCH /api/orders/<id>/status` `{ "status": "DELIVERED" }` | No button; the API answers `409` "A rider is delivering this order…"; nothing charged | |

## 7. Low wallet balance

| # | Do | Expected | Pass? |
|---|---|---|---|
| 7.1 | Shop balance ₹150 (below ₹200); a new order arrives; shop presses **Accept** | Refused: "Recharge your shop wallet to accept new orders. Balance ₹150.00, minimum ₹200.00." Order stays `CONFIRMED`. Red "Recharge wallet" banner on Orders | |
| 7.2 | Same via API `POST /api/orders/<id>/fulfilment {"action":"accept"}` | `402 INSUFFICIENT_BALANCE`, `details.rechargeUrl = /shop/wallet` (server-side, not just UI) | |
| 7.3 | Recharge ₹500, accept again | Accepted | |
| 7.4 | Balance ₹320; deliver one order (−₹26.05 → ₹293.95) | Owner gets "Recharge your shop wallet … ₹293.95. Recharge before it falls below ₹200.00, or you will not be able to accept new orders." ✉ **once**; amber "running low" banner, the shop still accepts orders. A second delivery does not repeat it; a recharge back to ₹300 or more re-arms it | |
| 7.5 | Balance ₹10; an order already accepted earlier is delivered | Delivery completes; balance goes to −₹16.05 (shown in red); shop told "Recharge your wallet to keep accepting new orders"; next accept refused | |
| 7.6 | An order already **accepted** while the balance was fine | Can still be packed and delivered after the balance drops (only new acceptances are blocked) | |

## 8. Cancelled / undelivered

| # | Do | Expected | Pass? |
|---|---|---|---|
| 8.1 | Cancel an order before pickup (shop reject or customer cancel) | No wallet rows | |
| 8.2 | Cancel after the drop started (operator) | No wallet rows; `delivery_otp_hash` cleared; the old code is refused | |
| 8.3 | Rider reports **Could not deliver** | Order `FAILED`; no wallet rows; code cleared | |

## 9. Rule off (regression)

| # | Do | Expected | Pass? |
|---|---|---|---|
| 9.1 | Admin → Business rules → `shopWallet` → Restore default (off) | Wallet page says "Not switched on yet"; no banner; accept works at any balance | |
| 9.2 | Deliver an order | No wallet rows; commission withheld at settlement exactly as before; delivery code still hashed and emailed | |
