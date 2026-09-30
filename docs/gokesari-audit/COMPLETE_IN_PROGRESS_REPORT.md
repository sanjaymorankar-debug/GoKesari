# Gokesari — "complete in-progress features": development report

**Date:** 2026-09-30 · **Branch:** `staging` (nothing pushed, nothing deployed) · **Commits:** `bd1327c` … `9c5d440`
**Scope:** the 13 in-progress/partly-built areas in the brief, in the brief's phase order (A → J).
**Rule followed:** no functional QA during development. What *was* run is stated exactly in section I.

Companion documents: [D10_VERIFICATION.md](./D10_VERIFICATION.md) ·
[QA_TEST_PLAN_COMPLETE_IN_PROGRESS.md](./QA_TEST_PLAN_COMPLETE_IN_PROGRESS.md)

---

## 0. Feature status (Development and Testing are separate)

| Feature | Development Status | Testing Status |
|---|---|---|
| Mobile OTP (email delivery) | COMPLETED | IN PROGRESS — phone parsing + email template unit-tested; flow not exercised |
| SMS OTP channel | BLOCKED — needs decision D2 (provider); abstraction and screen wiring are ready | YET TO START |
| Location picker | COMPLETED | YET TO START |
| Delivery eligibility | COMPLETED | YET TO START |
| Cart ⇄ location validation | COMPLETED | YET TO START |
| Rider navigation | COMPLETED | YET TO START |
| Society gate access | COMPLETED | YET TO START |
| Find Rider Now retry | COMPLETED | YET TO START |
| Rider earnings (slots, incentives, ledger) | COMPLETED | IN PROGRESS — calculation engine unit-tested (12 cases); persistence and screens not exercised |
| Return pickup (full returns workflow) | COMPLETED | IN PROGRESS — state machine unit-tested; flows not exercised |
| Notifications framework | COMPLETED (email live; SMS / push / WhatsApp are seams) | IN PROGRESS — templates and email rendering unit-tested; delivery/retry not exercised |
| Shop suspension | COMPLETED | YET TO START |
| D10 cancellation policy | COMPLETED — verified, 2 gaps fixed | IN PROGRESS — 13 characterization tests pass on a scratch DB; QA to confirm on the deployed app |
| External price references | COMPLETED (manual entry; customer display held back pending D7) | YET TO START |
| MRP governance | COMPLETED | YET TO START |
| Low-stock thresholds | COMPLETED | YET TO START |
| Product images | COMPLETED | YET TO START |
| Operator (shop) dashboard | COMPLETED | YET TO START |
| Admin operational dashboard | COMPLETED | YET TO START |
| Business-rules screen (support for "configurable") | COMPLETED | YET TO START |

No feature is left IN PROGRESS on the development side. "COMPLETED" means the backend, database, API and UI
exist and compile together — **not** that it has been shown to work in a browser.

---

## A. Completed

**Phase A — Authentication.** Mobile-number login where the one-time code goes to the account's email:
country code + number → "Where would you like to receive your OTP?" (Email; SMS shown as coming soon) → code →
signed in. Codes are salted-HMAC hashed, single-use, expire, attempt-limited, resend-limited (cooldown and per-window
cap counted per number *whether or not an account exists*), supersede each other, and unknown numbers get an identical
response (no enumeration). Every request, success, failure and block is audited with the number masked; a "new sign-in"
security notice is sent. A mobile number is linked from the profile page. `OtpProvider` interface: `EmailOtpProvider`
live, SMS provider seam returns "unavailable" until a vendor is chosen.

**Phase B — Customer experience.** Addresses gain recipient name, recipient mobile and Home/Work/Other. Location picker
gains address search (Maps Places) and a "save this place" path. Shops gain **extra delivery zones** (PIN codes),
**minimum order value** and a **pause new orders** switch; serviceability, checkout and discovery honour them. A new
cart-validation service re-checks every shop against the chosen location — deliverability, paused/unavailable shop,
unavailable items, minimum order, delivery charge, closed-now — and the cart shows each issue with an action
(change address / add items / remove these items), re-validating when the address changes.

**Phase C — Fulfilment.** Rider checkpoints (arrived at shop / at customer) with notifications; navigation deep links;
privacy: the rider sees only the customer's area until pickup, never name/phone, never the handover codes. Society
**gate entry mode**, optional security-desk contact (shared with the rider only if the society enables it) and a
customer-at-gate notice. **Find Rider Now** is now a bounded, configurable search (`rider_searches`, `dispatch_attempts`):
retry interval, attempt limit, total time limit, delivery-window expiry, manual cooldown; every attempt is logged; the shop
sees status, can retry or stop; duplicate assignment stays impossible.

**Phase D — Rider earnings.** Time slots (incl. overnight, weekdays, validity, priority) with their own base, per-km,
minimum, order-based component and peak bonus; incentives (order count, daily/weekly target, distance, peak hour,
campaign); every earning stores its breakdown (base, distance, order component, slot incentive, top-up, order/other
incentive, deductions, net) plus append-only ledger lines and idempotent award rows. With no slots configured the result
is exactly today's base + per-km. Admin screen with a "try a delivery" calculator.

**Phase E — Returns.** Request (reason, condition, quantity, photos, comments) → automatic validation (window,
per-reason policy, evidence, quantity holds under an order lock) → approval → rider pickup (offer / accept / en route /
customer handover code / failure and re-offer, bounded) → goods received → inspection → refund through the *existing*
`refundDeliveredOrder` (wallet, ledger, shop share, audit; idempotent per return) with all 13 requested statuses and a
history. Customer, shop and operations screens; rider pickup panel; rider fee credited as an earning.

**Phase F — Notifications.** In-app + email, queued per channel with retries/backoff, delivery log, dead-letter handling,
per-category preferences (security notices always on), read/unread, templates for every event listed in the brief, and a
provider seam for SMS/push/WhatsApp. Nothing external is mandatory.

**Phase G — Suspension.** Configurable policy per open-order status (cancel & refund / continue / hold for review);
impact preview before, impact list and per-order decisions after; the owner is told reason, time, expected action and
impact; new orders stop at once; held orders are neither advanced by the shop nor dispatched; reinstatement.

**Phase H — D10.** Verified against code, history and tests ([D10_VERIFICATION.md](./D10_VERIFICATION.md)); two real gaps
fixed; 13 characterization tests added.

**Phase I — Product & inventory.** External reference prices with source, time, location, URL and verification and an
audit history — separate from MRP and selling price and never written into either. MRP governance: selling price above an
enforced MRP refused everywhere a shop price is written, MRP drops notify shops (prices untouched), shop corrections
decided by operations. Stock thresholds at shop / product / listing level with an explicit opt-out, reserved / available /
on-hand, one notification per new alert, hand-edited stock now writes the ledger and re-checks alerts. Product images:
several per product or per listing, primary, order, replace, delete, validation, browser-side shrink, safe fallback.

**Phase J — Dashboards.** Shop operator and admin dashboards built entirely from live queries.

---

## B. In progress

None on the development side.

Known limitations (things that are *not* broken but not built — listed so nothing is assumed):

* The UI has **not** been exercised in a browser (no dev server or Playwright run). Type-checked and built only.
* Reference prices are entered by hand. Importing them from the Product Master (`pmd.product_offer`) or from a sheet is not built.
* Return-pickup matching is nearest-eligible-rider (with society exclusivity). It does not reuse delivery dispatch's
  reliability/fairness weights.
* Navigation is a deep link to Google Maps; there is no in-app map or turn-by-turn.
* The in-memory rate limiter is per server instance (unchanged from before).
* Email needs SMTP in production; without it email is skipped, not failed.
* `platform_settings` values are edited as JSON on `/admin/settings` (validated server-side), not with per-field forms.

## C. Blocked / needs a decision

| Blocker | Decision needed | Impact | Recommended next action |
|---|---|---|---|
| **D2 — SMS provider** | Which SMS/OTP vendor (India needs DLT registration) | SMS OTP and SMS/push/WhatsApp notifications cannot go live. Email works. | Pick a vendor; implement `OtpProvider` / `ChannelProvider` for it (one file each), set `otp.smsEnabled`. |
| **D7 — licensed source for external prices** | Whether/which reference prices may be shown to customers | Reference prices are staff/shop-visible only (rule `externalPrices.showToCustomers` = false). | Decide; flip the rule. No code change. |
| **D6 — settlement model** | How the delivery fee kept on a dispatched cancel is shared/reported | It is now journaled as platform revenue; settlement treatment unchanged. | Confirm with the finance model. |
| **D10 extension statuses** | Confirm ACCEPTED/ASSIGNED (customer blocked) and PICKED_UP (goods-only refund) | Implemented as recorded in the code comment; still marked "pending confirmation". | Confirm or correct. |
| **Defaults I had to choose** (all editable at `/admin/settings`) | Confirm or change: return window **48 h**; "changed my mind" **not** accepted; defect reasons charged to the **shop**, others to the platform; rider return-pickup fee = the **base delivery fee**; suspension policy (unaccepted → cancel & refund, accepted/preparing/ready/assigned → hold, on the road → continue); dispatch retry 60 s × 10 attempts / 30 min / +15 min after promised time; OTP 6 digits / 10 min / 5 attempts / 60 s cooldown / 5 per hour; image limit 2 MB, 8 per product; MRP enforced only when **verified** | Behaviour follows these until changed. | Review the table in `/admin/settings` with the business owner. |

## D. Yet to start

Nothing from the brief. Deliberately not started (out of scope): reference-price import from Product Master, in-app
maps, per-field forms for business rules, SMS/push/WhatsApp providers.

## E. Database changes

Ten additive migrations, `0025`–`0034` (existing rows keep their data; every new column is nullable or has a default).
Checked by applying `0000`–`0034` in order to a fresh scratch database — they all run.

| Migration | Change |
|---|---|
| 0025 | `users.phone_e164`, `phone_verified_at` (+ partial unique index); new `login_otps`, `platform_settings` |
| 0026 | `addresses.recipient_name/recipient_phone/address_type`; `shops.delivery_pincodes/min_order_paise/orders_paused` |
| 0027 | `delivery_orders.arrived_at_shop_at/arrived_at_customer_at`; `societies` gate columns (5); new `rider_searches`, `dispatch_attempts` |
| 0028 | `delivery_partner_earnings` breakdown columns (7); new `rider_earning_slots`, `rider_incentive_rules`, `rider_incentive_awards`, `rider_earnings_ledger` |
| 0029 | new `stored_images`, `return_requests`, `return_items`, `return_status_history`, `return_pickups`; `delivery_partner_earnings.delivery_order_id` now nullable + `return_pickup_id` (unique) |
| 0030 | `notification_channel` enum + `WHATSAPP`; new `notification_preferences`, `notification_deliveries` |
| 0031 | new `shop_suspensions`, `shop_suspension_orders` |
| 0032 | new `external_price_references`, `external_price_reference_history`, `mrp_corrections` |
| 0033 | `shops`/`products` default stock thresholds (3 each); `shop_products.stock_alerts_disabled` |
| 0034 | `product_images`: `shop_product_id`, `stored_image_id`, `alt_text`, `is_primary`, `created_by` (+ one-primary-per-scope indexes) |

Rollback: each migration is additive, so rolling the *application* back is safe with the columns left in place. The only
non-additive change is `delivery_partner_earnings.delivery_order_id` dropping NOT NULL; reversing it requires no
return-pickup earnings to exist. There is no automatic down-migration (drizzle generates forward SQL only).

## F. API changes

**New**

* Auth/profile: `POST|GET /api/otp/request`, `PUT|DELETE /api/me/phone`
* Rules: `GET|PUT|DELETE /api/admin/settings`
* Cart: `GET|DELETE /api/cart/validate`
* Rider earnings: `GET|POST /api/admin/rider-earnings/slots`, `PATCH …/slots/{id}`, `GET|POST …/incentives`, `PATCH …/incentives/{id}`, `POST …/preview`
* Returns: `POST /api/orders/{id}/returns`, `GET /api/returns`, `GET|PATCH /api/returns/{id}`, `PATCH /api/return-pickups/{id}`
* Images: `POST /api/images`, `GET /api/images/{id}`; `GET|POST /api/products/{id}/images`, `PATCH|DELETE …/{imageId}`, `PUT …/order`
* Notifications: `GET|PUT /api/notifications/preferences`, `GET|POST /api/admin/notifications`, `POST|GET /api/cron/notifications`
* Suspension: `POST /api/shops/{id}/reactivate`, `GET|POST /api/admin/suspensions`
* Prices/MRP: `GET|POST /api/admin/price-references`, `GET|PATCH …/{id}`, `GET /api/products/{id}/price-references`, `GET|POST /api/mrp`, `GET|POST /api/mrp/corrections`, `PATCH …/{id}`
* Inventory: `GET|PATCH /api/shops/{id}/inventory`, `PATCH /api/shop-products/{id}/stock-settings`, `PATCH /api/stock-alerts/{id}`, `PATCH /api/admin/products/{id}/stock-defaults`

**Modified (backward compatible)**

* `PATCH /api/delivery-orders/{id}` — new actions `arrived_shop`, `arrived_customer`
* `POST /api/orders/{id}/assign` — "Find rider now" is now the bounded search (still 409 when nobody can be offered); new `{stop:true}`; new `GET` for search status
* `GET|POST /api/shops/{id}/suspend` — `GET` = impact preview; `POST` accepts optional `expectedAction`, returns `impact`; `{reason}` alone still works
* `PATCH /api/orders/{id}/status` — the customer cancel branch now requires `ORDER_CANCEL_OWN`
* `POST|PATCH /api/addresses…`, `PATCH /api/shops/{id}`, `PATCH /api/societies/{id}`, `POST /api/location` — new optional fields
* `POST /api/cron/delivery-dispatch` — also sweeps return pickups
* `GET /api/delivery-partner/earnings` — each earning now includes its `lines`
* Image fields on product/listing routes accept an uploaded `/api/images/{id}` as well as an http(s) URL

**Removed:** none.

## G. Configuration changes

**New environment variables: none.** Email reuses `AUTH_EMAIL_FROM` / `AUTH_EMAIL_SERVER`; address search reuses
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.

**New cron:** `POST /api/cron/notifications` every minute (sends queued email, retries failures). The existing
`/api/cron/delivery-dispatch` schedule now also serves return pickups.

**New admin-tunable rule groups** (table `platform_settings`, screen `/admin/settings`, code defaults in
`src/server/config/rules.ts`): `otp`, `dispatch`, `riderEarnings`, `returns`, `images`, `notifications`, `suspension`,
`mrp`, `externalPrices`. Rider slots and incentives are data (tables), managed at `/admin/rider-earnings`.

**New permission:** `price-reference:manage` (operator, admin).

## H. Tests added

| Kind | File | What it covers |
|---|---|---|
| Unit | `tests/unit/earnings-calc.test.ts` | local time / week keys, midnight-crossing windows, slot priority + weekday + validity, base+per-km parity, slot rates, minimum top-up, daily/weekly/order-count/distance/peak incentives, once-only awards, failed/cancelled payout, late penalty, ledger lines sum to the total |
| Unit | `tests/unit/phone-and-templates.test.ts` | number parsing/masking, return state machine (reachability, terminals, no skipped steps), template coverage of every listed event, categories, mandatory security notices, email escaping and link safety |
| Integration / characterization / D10 | `tests/integration/d10-cancellation-policy.test.ts` | customer cancel at CONFIRMED / ACCEPTED / PREPARING / READY / ASSIGNED / PICKED_UP / OUT_FOR_DELIVERY; shop cancel at each stage; refund amounts and retained fee (and its ledger entry); rider assignment cancelled / released; rider earnings; inventory restock incl. removed lines; partial-refund-then-cancel; settlement exclusion; double-cancel |

## I. Deployment readiness

{{VERIFICATION}}

**Environment requirements:** Node hosting as today; PostgreSQL with `gen_random_uuid()` (already required);
SMTP for OTP and email notifications; two cron jobs (dispatch, notifications).

**Known deployment risks**

1. **Apply migrations `0025`–`0034` in order, after `0024`.** None has been applied to Neon or any shared database.
   `0030` adds an enum value (`WHATSAPP`); apply it as its own migration step (drizzle does).
2. **Email is required for mobile login.** With `AUTH_EMAIL_FROM`/`AUTH_EMAIL_SERVER` unset in production the mobile
   sign-in option is hidden and existing sign-in methods are unaffected.
3. **Mobile numbers are claimed, not proven.** A user links a number from a signed-in session; an email-delivered code
   proves the *mailbox*, not the SIM. A number can be "squatted" by whoever links it first. `phoneVerifiedAt` is only set
   by an SMS code, so this closes when SMS goes live (D2).
4. **Cron for notifications must be scheduled**, or email queued inside transactions waits for the next unrelated send.
5. **Behaviour changes to existing flows** (all intentional, all covered in the QA plan): checkout now refuses paused
   shops and orders below a shop's minimum; suspended shops cannot accept; shop price writes above a verified MRP are
   refused; hand-edited stock now writes the ledger.
6. **D10 code was already on `main`** (PR #19); confirm the host runs it and has `0017`–`0024` before relying on it.
7. The production `.env` was not touched. Nothing was pushed, merged to `main`, or deployed.
