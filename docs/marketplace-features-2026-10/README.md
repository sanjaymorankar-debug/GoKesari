# Marketplace features F1–F11 (October 2026)

Eleven additive features. Every behaviour change is behind a business rule
(Admin → Business rules), **off by default in code**, so deploying this code
alone changes nothing a customer, shop or rider sees. `scripts/enable-new-features.sql`
switches them on (used on test); `scripts/disable-new-features.sql` switches them off.

## Baseline: existing flows (before this work)

| Flow | Where | Notes kept intact |
|---|---|---|
| Browse / cart / checkout | `services/catalogue.ts`, `services/cart.ts`, `services/orders.ts#checkout` | One order (`DB-YYYYMMDD-XXXXXX`) per shop, one transaction per shop; wallet or COD; idempotent on request id |
| Payment / wallet | `services/wallet.ts`, `services/payments.ts` | Customer-funded vs promotional split; refunds preserve the split |
| Order status / tracking | `services/orders.ts#updateOrderStatus`, `lib/tracking.ts` | Same status set and transitions; finance snapshot on DELIVERED |
| Shop inventory & pricing | `services/catalogue.ts`, `services/shop-inventory*` | Loose goods have an empty price; category fill adds products at count 100 with missing prices left to the owner; a shop's own price change applies to that shop only |
| Rider assignment & delivery | `services/delivery-assignment.ts`, `delivery-eligibility.ts`, `delivery-feasibility.ts` | Nearest free rider; straight-line distance at 20 km/h |
| Subscriptions | `services/subscriptions.ts` | Daily generation idempotent per (subscription, date) |
| Admin | `/admin/*` | Unchanged pages; new pages added |

Baseline test suite: **71 files, 1089 tests, all passing** (commit 45fbfb3).
Playwright acceptance (`tests/e2e`): 10/10 passing.

## Features

| # | Feature | Rule (default) | Where |
|---|---|---|---|
| F1 | Lifecycle status models (shop / rider / subscription), transitions enforced in the database, every change logged with actor | `statusModels.enforceTransitions` (true) | `lib/status-models.ts`, migration 0042, `/admin/status-changes` |
| F2 | Rider self-edit; ID / bank changes go to admin review (encrypted) | — | `/gig/profile`, `/admin/rider-changes` |
| F3 | Busy riders ranked after free ones instead of excluded | `dispatch.busyRidersAsFallback` (false), `maxActiveDeliveriesPerRider` (2) | `delivery-assignment.ts` |
| F4 | Road distance / travel time (Google Routes or OSRM), arrival time for customer and rider, straight-line fallback | `routing.enabled` (false), `provider` (google) | `services/routing.ts`, tracking map, rider dashboard |
| F5 | Delivery slot capacity per shop / PIN code / default; full slots unavailable; no overbooking (advisory lock) | `deliverySlots.enabled` (false) | `services/delivery-slots.ts`, `/admin/delivery-slots` |
| F6 | One parent reference (`GK-…`) for a multi-shop checkout; shops keep their own orders | `parentOrders.enabled` (false) | `services/order-groups.ts`, `/orders/group/[reference]` |
| F7 | Order-level coupons (flat / %, min order, dates, total and per-customer limits), split by goods value, server-validated | `coupons.enabled` (false) | `services/coupons.ts`, cart, `/admin/coupons` |
| F8 | Shop offers on a product or category with dates; on shop page; priced in cart and checkout | `shopOffers.enabled` (false) | `services/shop-offers.ts`, `/shop/offers` |
| F9 | Home-page price comparison across shops delivering to the customer; cheapest highlighted; empty-priced loose goods skipped | `homePriceComparison.enabled` (false) | `services/price-comparison.ts`, home page |
| F10 | Product image moderation (pending → approve / reject with reason); existing photos stay live | `imageModeration.enabled` (false) | `services/product-images.ts`, `/admin/image-moderation` |
| F11 | Customer referral code / link; both rewarded on the friend's first delivered order; self-referral and duplicate-account guards | `customerReferrals.enabled` (false), rewards ₹50 / ₹50 | `services/customer-referrals.ts`, `/refer`, `/r/CODE`, `/admin/customer-referrals` |

## Migrations and rollback

| Migration | Adds | Rollback |
|---|---|---|
| 0042_status_models | lifecycle columns, `status_changes`, `status_transition_rules`, trigger functions | `scripts/rollback-0042.sql` |
| 0043_rider_change_requests | `delivery_partner_change_requests`, PROFILE_PHOTO image purpose | `scripts/rollback-0043.sql` |
| 0044_delivery_routes | `delivery_orders.route_source / leg_duration_seconds / pickup_duration_seconds` | `scripts/rollback-0044.sql` |
| 0045_delivery_slots | `delivery_slot_capacities`, `orders.delivery_slot_key` | `scripts/rollback-0045.sql` |
| 0046_order_groups | `order_groups`, `orders.order_group_id` | `scripts/rollback-0046.sql` |
| 0047_coupons | `coupons`, `coupon_redemptions`, `orders.discount_paise` (default 0), `orders.coupon_code` | `scripts/rollback-0047.sql` |
| 0048_shop_offers | `shop_offers` | `scripts/rollback-0048.sql` |
| 0049_image_moderation | `product_images.moderation_status` (default APPROVED) + review columns | `scripts/rollback-0049.sql` |
| 0050_customer_referrals | `customer_referral_codes`, `customer_referrals` | `scripts/rollback-0050.sql` |

All new columns are nullable or have a default that keeps current behaviour.
Roll back newest first (0050 → 0042); after each script delete that
migration's row from `drizzle.__drizzle_migrations`. Switch the features off
first (`scripts/disable-new-features.sql`).

## Decisions

See the final report in the pull request for the full list. Key ones:
coupons are platform-funded and offers shop-funded; a "slot" is a shop's
window per IST hour (express / standard) or per IST day (scheduled); coupon
usage counts per checkout, not per sub-order, and is not returned on
cancellation; line refunds on a discounted order are capped at what was paid.
