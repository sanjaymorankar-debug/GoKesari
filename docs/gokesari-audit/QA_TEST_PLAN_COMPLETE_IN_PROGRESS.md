# Gokesari — QA test plan for the "complete in-progress features" release

**For:** ChatGPT (QA), executed against the deployed staging/test application.
**Covers:** everything added in the Phase A–J work (commits `bd1327c` … `ca19358` on `staging`, plus the settings screen).
**Development did not include functional QA** — nothing below has been exercised in a browser. Treat every
"Expected" line as a hypothesis to confirm or refute, and report any deviation with the exact steps.

## 0. Before you start

| Item | What to do |
|---|---|
| Migrations | Apply `drizzle/0025` … `0034` in order on the test DB (after 0024). Confirm the app boots. |
| Email | Set `AUTH_EMAIL_FROM` and `AUTH_EMAIL_SERVER` (SMTP). Without them mobile-login codes and email notifications are unavailable (by design — the sign-in screen says so). |
| Cron | Schedule `POST /api/cron/delivery-dispatch` and `POST /api/cron/notifications` every minute with `Authorization: Bearer $CRON_SECRET`. The first now also sweeps return pickups; the second sends queued and retried email. |
| Accounts | ADMIN, OPERATOR, two SHOP_OWNERs (one delivering shop with a pinned location), two CUSTOMERs (one with a linked mobile number), one approved DELIVERY_PARTNER (online, location pinned), one society with a verified admin. |
| Data | A packaged product with an MRP, a shop listing with stock ≥ 20, at least one address with coordinates. |
| Defaults | Rules are editable at **/admin/settings**. Unless a case says otherwise, keep defaults. |

Convention: **Pass** = behaves as Expected; **Fail** = differs; **Blocked** = cannot be tested (say why). Record the request/response or a screenshot for each Fail.

---

## 1. Mobile login with email OTP (Phase A)

| ID | Steps | Expected |
|---|---|---|
| A-01 | Profile → "Mobile number for login": link `+91 9XXXXXXXXX` to a signed-in account. Sign out. | Link succeeds. A "Mobile number changed" notification (in-app + email) arrives. |
| A-02 | Sign in page → "Login with mobile number": enter country code + the linked number → Next. | Step 2 asks "Where would you like to receive your OTP?" with Email selectable and SMS shown as "(coming soon)" and disabled. |
| A-03 | Choose Email → Send OTP. | Message: "If that mobile number is registered, a code has been sent to the email address on the account." A 6-digit code email arrives at the account's address. |
| A-04 | Enter the correct code. | Signed in, redirected home. A "New sign-in" security email/notification is sent. |
| A-05 | Request a code for a number that **is not** registered. | Identical message and status as A-03. No email is sent. (No account enumeration.) |
| A-06 | Enter a wrong code 5 times (default limit). | Every failure shows the same "invalid or expired" message. After the limit, even the right code is refused; request a new one. |
| A-07 | Request a code, wait past expiry (default 10 min), enter it. | Refused with the generic message. |
| A-08 | Request two codes in a row; use the **first**. | First code refused (superseded); second works. |
| A-09 | Click Resend immediately, then after the cooldown (default 60 s). | Immediate: refused with "wait N seconds"; the button is disabled until the cooldown ends. After: a new code is sent. |
| A-10 | Request codes repeatedly (default 5 per hour per number). | The 6th is refused ("Too many code requests"). Unknown numbers are throttled identically. |
| A-11 | Reuse a code that already signed you in. | Refused. |
| A-12 | Enter an invalid number (letters, 5 digits, +91 starting with 5). | Field-level error; nothing is sent. |
| A-13 | Link the same number to a second account. | Refused: "already linked to another account". |
| A-14 | Suspend the account (admin), then attempt mobile login. | Refused with the generic message; no session. |
| A-15 | ADMIN → **/admin/settings** → `otp`: set expiry 1, attempts 2, cooldown 5. Retest A-06/A-07/A-09. | New limits apply within ~15 s. "Restore default" reverts. |
| A-16 | Audit log (admin): search `auth.otp_`. | Requested / verified / failed / blocked rows exist; numbers are masked; no code appears anywhere. |
| A-17 | Database (if you have access): `select code_hash from login_otps`. | Values look like `salt:hex` — never a plain 6-digit code. |

## 2. Location, delivery eligibility and cart (Phase B)

| ID | Steps | Expected |
|---|---|---|
| B-01 | Add an address: type Home/Work/Other, recipient name, recipient mobile, landmark, PIN, pin on map. Save; edit; set default. | All fields persist and display. Invalid recipient mobile is rejected. |
| B-02 | Home page → "Deliver to" → Change → "Search an address" (needs the Maps key), pick a result. | Location label updates; "Shops that deliver to you" refreshes. Saving the place as an address is offered. |
| B-03 | Choose a saved address, then "Use my current location", then a PIN. | Each changes the list; the choice persists across pages. |
| B-04 | Shop owner sets delivery radius 2 km; customer 5 km away. | Shop is absent from "Shops that deliver to you"; the cart shows "does not deliver" with **Change address**. |
| B-05 | Add the customer's PIN to the shop's **extra delivery zones**. | Shop now appears for that PIN even beyond the radius. |
| B-06 | Shop sets **minimum order ₹200**; cart with ₹100. | Cart shows "needs a minimum order … add ₹100 more" with **Add items**; checkout button is disabled; a direct API checkout returns a validation error. Pickup (no address) orders are exempt. |
| B-07 | Shop ticks **Pause new orders**. | Shop disappears from delivery lists; cart shows "not taking new orders" with **Remove these items**; checkout refuses. Un-pause restores. |
| B-08 | Cart with items from two shops; change the address so one shop cannot deliver. | Only that shop's group shows the issue; **Remove these items** clears just that shop's lines. Checkout stays disabled until resolved. |
| B-09 | Change the address in the cart dropdown. | Issues, delivery fee and eligibility update without a page reload (`GET /api/cart/validate?addressId=`). |
| B-10 | Outside the shop's opening hours. | A non-blocking "closed right now" notice; checkout still allowed. |

## 3. Rider navigation, gate access, Find Rider Now (Phase C)

| ID | Steps | Expected |
|---|---|---|
| C-01 | Rider accepts an order. Rider dashboard. | Progress chips (Accepted / At the shop / Picked up / On the way / At the customer). Pickup shows a **Navigate to the shop** link (Google Maps). Drop shows **area only** and a note that the full address appears after pickup. Customer name/phone are never shown. |
| C-02 | Rider taps **I've arrived at the shop**. | Chip ticks; the shop owner is notified. Tapping again is harmless. |
| C-03 | Enter pickup code → confirm; **Start delivery**. | Drop now shows the full address, landmark/instructions and **Navigate to the customer**. Pickup code/OTP never appear in the rider UI or API responses. |
| C-04 | Rider taps **I've arrived at the customer**. | Customer is notified ("Your rider has arrived"). For a society order the wording follows the society's entry mode; society staff are told if security notices are on. |
| C-05 | Society admin → Rules: entry mode **Security calls the resident**, security desk contact set, "show to rider" on, "tell resident at gate" on. | Rider on a job to that society sees the gate mode and a tap-to-call desk number. With "show to rider" **off**, the number is not shown. |
| C-06 | Shop: mark an order READY with **no riders online**. | Order shows a status line "Looking for a rider — attempt 1 of 10…"; shop receives a "Looking for a rider" notification. |
| C-07 | Leave it. Cron runs. | Attempts continue every retry interval (default 60 s); the **Find rider now** button respects the 30 s manual cooldown. |
| C-08 | After the limit (default 10 attempts / 30 min) or once the promised delivery time + 15 min passes. | Search stops; status reads why; shop is notified once ("No rider found"); button becomes **Try finding a rider again**. |
| C-09 | Press **Try finding a rider again** with a rider now online. | Search restarts (attempt counter reset) and an offer goes to the rider. |
| C-10 | Cancel the order during a search. | Search closes as "order cancelled"; no further offers. |
| C-11 | Rider declines / lets the offer lapse (default 120 s). | Not re-offered that order; next rider tried; no order ever has two active assignments. |
| C-12 | Press **Stop searching**. | Search stops ("You stopped the search"). |
| C-13 | Admin → `dispatch` rule: change retry interval / limits. | New values apply to subsequent searches. |

## 4. Rider earnings (Phase D)

| ID | Steps | Expected |
|---|---|---|
| D-01 | With no slots/incentives, complete a delivery of 3 km. | Earning = base + 3 × per-km (default ₹20 + 3 × ₹8). Statement shows the breakdown lines. |
| D-02 | **/admin/rider-earnings** → add slot "Morning" 06:00–11:00, base ₹30, per-km ₹5, peak bonus ₹10 (peak). Use **Try a delivery** at 09:30. | Preview picks Morning; lines: base, distance, slot bonus; total as computed. At 15:00 the default rate applies. |
| D-03 | Overnight slot 22:00–02:00; preview at 23:30, 01:00, 03:00. | Matches the first two only. |
| D-04 | Two overlapping slots with different priority. | Higher priority wins. Weekday and date limits are honoured. |
| D-05 | Incentives: daily target 3 orders ₹50; order-count (>2 per day) ₹10; distance ≥ 2500 m ₹7; peak-hour 09:00–10:00 ₹9; campaign with dates. Complete deliveries to trigger each. | Each pays when its condition is met, appears as a separate ledger line, and one-off targets pay **once** per day/week. |
| D-06 | Minimum earning ₹60 (rule `riderEarnings` or slot). | Short orders are topped up to ₹60 with a "top-up" line. |
| D-07 | Failed delivery with `failedDeliveryPayoutPercent` 50. | Earning is 50% with a deduction line. Default (100) pays in full. |
| D-08 | Customer cancels after pickup (D10). | Rider is still paid in full by default. |
| D-09 | Weekly payout batch (finance). | Earnings — including return-pickup fees — are included; totals match the statement. |
| D-10 | Switch a slot off; deliver again. | Past earnings keep their breakdown; new ones ignore the slot. |

## 5. Returns and return pickup (Phase E)

| ID | Steps | Expected |
|---|---|---|
| E-01 | Delivered order → **Return items**. | Form lists lines with returnable quantity, condition, per-item comment, photos, a reason list (CHANGED_MIND absent by default) and the window end. |
| E-02 | Submit with reason "Damaged", no photo. | Refused: photo required for that reason. With a photo → return created, "Under review", shop notified. |
| E-03 | Try to return more than the delivered quantity, or the same item twice. | Refused with the maximum returnable. |
| E-04 | Order delivered more than 48 h ago (adjust in DB or wait). | Refused: window passed. |
| E-05 | Shop → **Returns** → view photos → **Approve**. | Status Approved; customer notified; a rider pickup is offered. |
| E-06 | Shop → **Reject** with a reason. | Status Rejected; customer sees the reason. |
| E-07 | Rider accepts the pickup (dashboard "return pickup" panel). | Return → Pickup assigned; customer sees a **handover code** and can **Choose pickup time** (→ Pickup scheduled). |
| E-08 | Rider **Set off**, then enters a **wrong** code, then the right one. | Wrong: refused (limit 5, then only operations can complete). Right: Pickup completed; rider's flat fee is credited as an earning. Rider never sees the code. |
| E-09 | Rider reports "could not collect". | Return goes back to Approved; customer + shop notified; shop can **Find a rider again**. |
| E-10 | Shop → **Goods received** → **Inspect** → Accept (full or partial amount). | Approved for refund → Refund initiated → Refund completed; wallet credited; ledger/settlement shows the shop's share; notification sent. |
| E-11 | Inspect → **Reject**. | Return rejected; no refund. |
| E-12 | Shop that does not deliver: return approved. | No pickup; "Customer handed goods over" moves it to inspection. |
| E-13 | Customer cancels before the rider sets off; after set-off. | First works (pickup cancelled); second is refused (contact support). Operations can still cancel. |
| E-14 | Refund fails (e.g. temporarily) then retry **Retry refund**. | Return stays "Refund initiated"; retry completes it exactly once (no double credit). |
| E-15 | Photos: another customer opens `/api/images/{id}` of your evidence. | 404. The shop's owner and staff can open it. |
| E-16 | Admin → `returns` rule: enable CHANGED_MIND, change window/charge-to. | New requests follow it. |

## 6. Notifications (Phase F)

| ID | Steps | Expected |
|---|---|---|
| F-01 | Place an order; accept; assign rider; pick up; deliver; cancel another. | In-app notifications for each (including "Order picked up"). Email arrives for placed, accepted, rider assigned, arriving, picked up, delivered, cancelled. |
| F-02 | Profile → **Notification settings**: switch "Your orders → Email" off; repeat an order step. | No email for that category; in-app still arrives. |
| F-03 | Try to switch "Account & security" off. | Not possible (locked). |
| F-04 | SMS / Push / WhatsApp columns. | Shown as "soon" — not selectable. |
| F-05 | Break SMTP (wrong host) and trigger a notification. | Delivery shows FAILED, retried on the backoff (1 m, 5 m, 30 m), then DEAD; **/api/admin/notifications?status=DEAD** lists it; the dashboard shows a failure; fix SMTP and **POST {id}** requeues it. |
| F-06 | No SMTP at all. | Email deliveries are SKIPPED, not failed; nothing breaks. |
| F-07 | Read / mark-all-read. | Unread counts update. |
| F-08 | Same event with the same dedupe key twice (e.g. low balance). | One notification. |
| F-09 | Security events: link/remove number, change a role, suspend/reinstate an account. | Each sends a security notice that ignores preferences. |

## 7. Shop suspension (Phase G)

| ID | Steps | Expected |
|---|---|---|
| G-01 | Admin → Shop Product Management → **Suspend…** on a shop with open orders in several statuses. | Impact panel lists each order with its planned action and counts (cancel & refund / shop finishes / hold for operations) and refund value before confirming. |
| G-02 | Confirm with a reason and an "expected action". | Shop becomes Suspended. Unaccepted (CONFIRMED) orders are cancelled and refunded with restock; PICKED_UP/OUT_FOR_DELIVERY continue; ACCEPTED/PREPARING/READY/ASSIGNED are held. Response summarises the impact. |
| G-03 | Owner opens **/shop**. | Red banner with reason, effective time, what to do, and what happened to orders; a notification + email arrived with the same content. |
| G-04 | Customer tries to buy from the suspended shop. | Items unavailable; checkout refuses; shop absent from delivery lists. |
| G-05 | Owner tries to accept a new order / advance a **held** order. | Refused with a clear message. Orders that were left to continue can be completed normally. |
| G-06 | **/admin/suspensions**: for a held order choose "Let the shop finish it" / "Cancel & refund". | Order proceeds or is cancelled with full refund; outcome recorded; owner notified. |
| G-07 | A held READY order with a rider search. | Not dispatched to a rider until decided. |
| G-08 | Reinstate the shop. | Status Approved; held orders go back to the shop; owner notified; ordering works again. |
| G-09 | Change the `suspension` rule (e.g. READY → CONTINUE), suspend another shop. | New policy is applied and shown in the preview. |
| G-10 | Risk review → suspend a shop via the risk page (old endpoint, reason only). | Works and now applies the same policy + notice. |

## 8. Order cancellation — D10 (Phase H)

Run the automated file first if you have a shell: `npx vitest run tests/integration/d10-cancellation-policy.test.ts`. Then, in the UI:

| ID | Steps | Expected |
|---|---|---|
| H-01 | Customer cancels a CONFIRMED order. | Full refund (goods + delivery fee); stock returned. |
| H-02 | Customer cancels while ACCEPTED / PREPARING / READY / ASSIGNED. | Blocked: "already being prepared — contact the shop". |
| H-03 | Customer cancels after pickup / out for delivery. | Goods-only refund; delivery fee kept; rider still paid; assignment cancelled. Finance → ledger shows a `DELIVERY_FEE` credit for the platform for that order. |
| H-04 | Shop/operator cancels at each stage. | Full refund every time, stock returned; rider paid only if the goods had been picked up. |
| H-05 | Cancel an order that had a removed item earlier. | Refund equals what is still held; the removed item is not restocked. |
| H-06 | Cancelled orders and shop settlements. | Never appear in a settlement batch. |

## 9. External prices, MRP, stock thresholds, images (Phase I)

| ID | Steps | Expected |
|---|---|---|
| I-01 | **/admin/price-references**: record a reference (product code, price, source, URL, location, observed date). | Appears as Unverified; **Verify** / **Reject** (needs a note) / **Reopen** work; history is kept. |
| I-02 | Check the product page as a customer. | Reference prices are **not** shown (rule off by default). MRP and shop prices are shown separately. |
| I-03 | Admin `externalPrices` → showToCustomers true. | Verified, recent references now appear under "Reference prices" with the "not the MRP / not a shop price" note. |
| I-04 | Confirm a reference never changes a shop price or the MRP. | Neither changes after create/verify. |
| I-05 | **/admin/mrp**: set an MRP for a packaged product. | Saved with source/verification; history appended; audit row written. A shop owner cannot do this (403). |
| I-06 | Shop sets an online price **above** a verified MRP (form, API and Excel upload). | Refused: "above the MRP". Equal or below works. Loose products unaffected. |
| I-07 | Lower an MRP below a shop's current price. | The shop is notified; its price is unchanged; it appears in "Shop prices above the MRP". |
| I-08 | Shop owner (product page) → "MRP looks wrong?" claim a value. | MRP unchanged; product shows awaiting verification; operations decide (**Accept claim** updates the MRP, **Reject** restores status). |
| I-09 | **/shop/inventory**: set shop default low-stock 10; product default via API; listing threshold 3. | Effective threshold uses listing → product → shop, and the table shows where it came from. |
| I-10 | Buy stock down through the threshold. | One alert + one notification per crossing; no duplicates while it stays low; alert resolves when restocked. |
| I-11 | Hand-edit stock on a listing. | An inventory movement is written and alerts re-evaluate. |
| I-12 | Reserved / available / on-hand. | Reserved equals units in open orders; on-hand = available + reserved. |
| I-13 | **Photos** on a listing: add several, make one primary, move left/right, replace, delete the primary. | Order and primary persist; next photo becomes primary on delete; deleted files are removed; product card/cart/gallery update. |
| I-14 | Upload a 6 MB file, a PDF renamed `.jpg`, a 20×20 px image. | Refused with clear messages. A 4000 px phone photo is accepted (shrunk in the browser). |
| I-15 | Break an image URL / product without a photo. | Neutral placeholder — never a broken-image icon. |
| I-16 | Another shop's owner tries to edit your listing photos via API. | 403/404. |

## 10. Dashboards (Phase J)

| ID | Steps | Expected |
|---|---|---|
| J-01 | Shop owner → **/shop**. | Sections: today's orders (placed / awaiting acceptance / in progress / delivered / cancelled), revenue, riders, returns & complaints, inventory with low-stock list, notifications. |
| J-02 | Place, accept, deliver and cancel orders; refresh. | Counts change exactly with those actions; revenue reflects delivered orders only. |
| J-03 | Admin → **/admin/dashboard**. | Live-operations block plus: exceptions, rider searches stopped, inventory exceptions, risk, shops/riders/returns/refunds, suspended shops with orders needing a decision, catalogue governance, notification failures, OTP/sign-in activity (24 h), KPIs. |
| J-04 | Cross-check three figures per role against the database. | They match. No figure is a constant. |
| J-05 | Operator vs admin vs customer access. | Customers are redirected; operators see what their permissions allow. |

## 11. Business rules screen

| ID | Steps | Expected |
|---|---|---|
| S-01 | **/admin/settings** (admin only). | Every rule group shown with default vs current. An operator gets redirected. |
| S-02 | Save an out-of-range value (e.g. OTP length 2). | Rejected with the field message; nothing changes. |
| S-03 | Save a valid value, then **Restore default**. | Applies within seconds; audit log shows before/after for both. |

## 12. Regression — existing behaviour that must be unchanged

Sign in (Google, email link), wallet top-up and voucher, cart/checkout (wallet and COD), subscriptions and the daily-order cron, shop approval, price-approval workflow and Excel upload, delivery accept/pickup/OTP delivery, society dashboards, finance weekly settlement and reconciliation, risk review, grievance form, marketing consent, admin order monitoring.

## 13. Security spot-checks

* Every new API rejects unauthenticated calls (401) and wrong-role calls (403); ids of other users' orders/returns/listings are not readable or writable.
* `/api/images/{id}` for return evidence is private; product photos are public and cacheable.
* Uploaded SVG/HTML renamed to `.jpg` is refused (content sniffed, not trusted by name).
* Rate limits: OTP request (per IP and per number), image upload, phone link.
* Rider API responses never contain `pickupCode`, `deliveryOtp`, `handoverCode` or the customer's name/phone.
