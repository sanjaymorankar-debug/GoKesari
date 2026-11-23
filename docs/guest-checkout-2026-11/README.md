# Guest checkout, guest tracking, best-shop panel, group reconciliation (Module 1, 23-Nov-2026)

Owner brief 23-Nov-2026, Module 1 "Guest shopping". Builds on PR #504 (guest cart, flag `guest_cart_enabled`).
Branch `feat/m1-guest-checkout`. Migration **0184**. Flag **`guest_checkout_enabled`** (seeded OFF; shows nothing
unless `guest_cart_enabled` is ON as well). With the flag off the site behaves exactly as before.

## What already existed

- Multi-shop cart (`services/cart.ts`); one order per shop, `order_groups` parent reference (always for an ONLINE
  multi-shop payment, else rule `parentOrders`, default off); per-shop delivery fee and coupon split; part
  refunds of removed items (`fulfilment.ts`); per-shop cancel; refunds against the ORDER_GROUP payment intent;
  shop isolation (`requireShopAccess(order.shopId)`).
- PR #504: browser cart, `/api/cart/preview`, `/api/cart/merge`; "Place order" sends a guest to `/signin`.
- E-mail sign-in codes that silently create an account (`otp/service.ts`), SMS through `SMS_PROVIDER`
  (`none | mock`) and rule `otp.smsEnabled`; no SMS vendor.
- Smart-shopping shop comparison (`services/smart-list/compare.ts`).

## Design decision: a guest is a lightweight, verified, ordinary account

No orders with a null user. At checkout the guest gives name, mobile, e-mail and address and enters a one-time
code. On success the existing sign-in path (`verifyLoginOtp`) finds or creates the account (Terms consent recorded
as for `/signin`), a new account gets `users.guest_created = true`, the name, the proven mobile
(`phone_verified_at`) and the address are saved, a normal session is opened (Auth.js login ticket, as `/signin`
does), the browser cart is merged (`GuestCartMerge`) and the customer picks payment on the normal `/cart`
checkout, which calls the normal `checkout()`. So every order, refund, cancel and shop-isolation rule is
reused untouched.

## Requirement status

| # | Requirement | Status |
|---|---|---|
| 1 | Guest step at checkout (contact + address + code, then normal payment; no password, no form) | **DEVELOPED** |
| 1a | E-mail code | **DEVELOPED** (live channel) |
| 1b | Mobile code | **DEVELOPED for mock SMS** (staging: codes at `/admin/test-messages`). **BLOCKED for real SMS**: no vendor / DLT template (decision D2). Without SMS the mobile is saved unverified, like e-mail sign-in today. |
| 2 | Tracking without sign-in: `/track/[token]` (signed, 30-day link) and `/track` lookup; link in order e-mails of guest-created accounts | **DEVELOPED** |
| 3 | Combined timeline on `/orders/group/[reference]`, reused on the token page | **ENHANCED** |
| 4 | "Best shop for this cart" panel (compare.ts ranking; serviceable shops only) | **DEVELOPED** |
| 5a | Per-child GST snapshot in `orders.tax_paise` | **BLOCKED on CA (NEW-027)** — see below |
| 5b | Admin reconciliation (group payment vs children, refunds per child, settlement) | **DEVELOPED** (read-only) |

### Why `orders.tax_paise` stays 0 (5a)

A GST rate source does exist (`products.gst_rate_bp`, shop overrides, `hsn_tax_rates`, `invoicing.defaultGstRateBp`,
used by `services/invoices.ts`). But GoKesari prices are **tax-inclusive** and `orders.total_paise =
subtotal + delivery + tax_paise − discount`: writing a tax amount there would **add GST on top of the price the
customer saw** and over-charge every order. The per-shop-order GST breakdown already exists where it belongs —
the tax invoice / bill of supply issued per child order (`issueInvoiceForOrder`, inclusive split). Filling a
separate "GST included" snapshot needs the CA's confirmed rates and HSN codes (NEW-027, still open), so this is
left as is and recorded as BLOCKED on the CA.

## Pages and APIs

| Path | What | Access |
|---|---|---|
| `/cart` (guest) | "Checkout as a guest" card under the cart, best-shop panel above it | Public, both flags |
| `/cart` (signed in) | Best-shop panel; after verifying, `/cart?guest=1` shows "You are signed in" | Customer, both flags |
| `POST /api/guest-checkout/start` | Step 1: sends the e-mail code (+ SMS code where SMS is set up). Creates nothing. | Public, both flags, 5 / 10 min per IP + OTP limits |
| Server action `verifyGuestCheckoutAction` (`src/app/cart/guest-checkout-actions.ts`) | Step 2: checks code(s), finds/creates the account, saves address, signs in, redirects to `/cart?guest=1` | Public, both flags, 20 / 10 min per IP + OTP attempt cap |
| `POST /api/cart/recommendation` | Suggestion for the session cart, or for guest lines `{ lines }` | Public, both flags |
| `POST /api/cart/recommendation/apply` `{ shopId }` | Moves a signed-in cart's lines (suggestion re-computed server-side) | `ORDER_PLACE`, both flags |
| `/track` + `POST /api/track/lookup` | Reference + mobile last 4 → link; or reference + e-mail → code → link. One answer for every failure. | Public, both flags, 10 / 10 min per IP, 5 / h per reference, audited |
| `/track/[token]` | Status per shop, items, totals, timeline, live-map link (`/orders/[id]`, sign-in) | Link holder, both flags |
| `/orders/group/[reference]` | + combined timeline | Owner of the group; timeline only with both flags |
| `/admin/payments/order-groups` | Reconciliation (filter by reference) | `FINANCE_VIEW` or `PAYMENT_VIEW_ANY`, both flags |

The tracking token: `base64url({k: G|O, id, exp}).HMAC-SHA256(AUTH_SECRET, "guest-track:v1:" + payload)`. No new
environment variable. Rotating `AUTH_SECRET` ends every tracking link (and every session). The page shows only
the first name and a masked mobile — no address, e-mail or full number.

The order-confirmed notification (wallet/COD in `orders.ts`, online in `payments/order-payments.ts`) uses the
tracking link as its button for guest-created accounts while the flags are on; everyone else keeps `/orders`.

## Reconciliation maths

Per order group: paid = captured ORDER_GROUP intent(s); children at checkout = Σ(child `total_paise` +
`refunded_paise`, the part refunds that already lowered the total). Difference = paid − children. Refund check:
intent `refunded_paise` vs Σ SUCCESS `payment_refunds` per child. Also shown: `order_refunds` per child (wallet or
original method) and the shop settlement status (`order_financials.settlement_id` → `shop_settlements`).
Verdicts: MATCHED, AMOUNT_MISMATCH, REFUND_MISMATCH, NO_PAYMENT, DUPLICATE_PAYMENT, NOT_ONLINE (wallet / COD group).

## Files

- Migration `drizzle/0184_guest_checkout.sql` (+ journal), rollback `scripts/rollback-0184.sql`
- `src/server/db/schema.ts` (users.guest_created, flag key, OTP purposes GUEST_MOBILE / ORDER_TRACK)
- `src/server/guest-checkout/` — `service.ts` (start / complete), `token.ts`, `tracking.ts`, `timeline.ts`,
  `recommendation.ts`, `reconciliation.ts`
- `src/server/otp/service.ts` (guest mobile and order-track codes), `services/audit.ts`
  (`guest_checkout.verified`, `guest_checkout.tracking_lookup`), `services/feature-flags.ts`,
  `components/feature-flags-panel.tsx`
- `src/server/services/orders.ts`, `src/server/payments/order-payments.ts` (e-mail link only)
- Pages / routes listed above; components in `src/components/guest-checkout/`; `src/lib/guest-checkout-i18n.ts`
  (EN / HI / MR); `src/components/guest-cart/guest-cart-view.tsx`; `src/app/cart/page.tsx`;
  `src/app/orders/group/[reference]/page.tsx`

## Tests

- Unit: `tests/unit/guest-checkout-token.test.ts` (sign / verify / expiry / tamper / secret),
  `guest-checkout-timeline.test.ts`, `guest-checkout-recommendation.test.ts` (ranking, suggestion),
  `guest-checkout-reconciliation.test.ts` (maths), `guest-checkout-flow.test.ts` (verification flow, flag off,
  SMS required when available, guest-created marking, address reuse)
- Integration: `tests/integration/guest-tracking.test.ts` (token page shows only that group and that customer's
  orders, lookup by mobile digits, e-mail link only for guest-created accounts with flags on)

## Known limits / still blocked

- Real SMS: needs an SMS vendor and DLT-registered template (D2). Until then mobile numbers from guest checkout
  on the live site are unverified.
- GST snapshot: CA (NEW-027), see above.
- Mandatory first-order referral code (rule `customerSignupReferral.required`), when on, also applies to a new
  guest account: the cart shows the existing "A referral code is needed" notice.
- The address is typed in the guest card (PIN code and coordinates taken from the location the guest already
  chose with the header location picker); the full map pin picker is not embedded in the guest card.
- Live rider map stays sign-in only (`/orders/[id]`); the token page shows status, expected time and the link.
- Production: flag ON only with the owner's OK, in the 23.00 IST window.
