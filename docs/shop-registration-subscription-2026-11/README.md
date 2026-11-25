# Shop registration subscription — 1-year validity, expiry, reminders, payment links

Owner brief: 25-Nov-2026 02.02 IST. Branch `feat/shop-registration-subscription-2026-11-25`, migration **0204**.
Builds on the yearly membership (D-69, 0094) and on PR #518's renewal module (0197,
[docs/shop-membership-renewal-2026-11](../shop-membership-renewal-2026-11/README.md)) — this PR must be merged
after #518. All times IST.

## What it does

| Brief | Where |
|---|---|
| 1. Registration fee = 1-year subscription; Unpaid until paid; start = payment date, expiry = +12 months | `shop-membership.ts` (periods, `noteRegistrationPayment`, `registrationStatusOf`), `shop-payments.ts` |
| 1. Fields per shop | `shops.registration_status`, `registration_start_date`, `membership_valid_until` (= registration_expiry_date), `registration_fee_paise` (= registration_fee), `renewal_fee_paise`, `last_registration_payment_id` / `_at`, `registration_grace_days`, `registration_grace_until`, `registration_reminders_enabled` |
| 1. Renewal fee = registration fee by default, admin per shop type | rule `shopRegistrationSubscription.renewalFeeByShopType`; per shop: row → Settings; precedence shop → type → `shopMembership.renewalFeePaise` → the shop's own registration base fee (+ GST as #518) |
| 1. Migration of existing shops + report | `drizzle/0200_…sql`: paid → start = first fee payment, +12 months (LEGACY period); never paid → UNPAID; computed expiry past → GRACE until +7 days; counts in `shop_registration_migration_reports` (shown on the admin screen) |
| 2. Admin / operator screen with filters and columns | Admin → Shops → **Unpaid & expiring registrations** (`/admin/shops/registrations`), CSV |
| 2a. Send reminder (row / bulk) | e-mail + push + in-app; "complete your registration payment" or "renew your shop registration". WhatsApp: not sent — WhatsApp templates are not approved yet (Meta keys pending), so it is not "already integrated" for this |
| 2b. Create payment link | existing gateway (Cashfree payment links, sandbox on staging); amount editable; validity default 7 days; a new link cancels the older one (Cashfree `POST /links/{id}/cancel`); sent by e-mail + push + in-app |
| 2c. Set / change expiry | extend, shorten, set a date, Expire now (no grace) — reason mandatory |
| 2d. Mark as paid (offline) | reference number + note; written to the shop's ledger (same reference refused twice) |
| 2. Audit log | every action: who, when, old value, new value, reason (`shop.registration_*` actions); History button per row, times IST |
| 2. Settings (admin only) | `/admin/shops/registrations/settings`: validity months, grace days, reminder schedule, renewal fee per shop type, link validity, CC list (default ceo@agtci.com), commission on renewals |
| 3. Reminders 30 / 15 days, last 7 days, expiry day, grace days; unpaid 1 / 3 / 7 then weekly | job `shop-registration` (every 15 min; sends from 09.00 IST, once per shop, stage and day); schedule in the rule |
| 3. Each reminder: shop name, expiry (or payment pending), amount due, Pay Now link (auto-created) | `reminderText` — English + Marathi; e-mail in the existing GoKesari layout |
| 3. Event-driven | payment capture, link created, expiry changed → status and owner notice at once |
| 4. Owner dashboard card + banners on every Seller Central screen | `components/seller/registration-status.tsx` (card on /shop and Registration page; banner in the Seller Central frame) |
| 4. Push for reminders and on payment | notification types `shop.registration_reminder`, `_payment_link`, `_expiry_changed`, `_confirmed` (PUSH + EMAIL) |
| 4. Payment history with receipts | Shop → Registration and fee: periods and payments; receipt per year (`/shop/membership/receipt/<id>`, GST split when known — #518). GoKesari's GST invoices for fees come from the platform-invoicing module when it is switched on |
| 5. Grace (default 7 days) then Expired: hidden from search / nearby / shop + QR page, no new orders; in-progress orders finish; owner can log in and renew | `registrationListed` (search, home discovery, catalogue, price comparison, `/shops/<slug>`); order gate `membershipOrderGate` (existing) |
| 6. Webhook: Unpaid → Active (+ existing auto-approval and welcome); renewal = max(expiry, payment) + 12 months; idempotent; reconcile | existing capture handlers + `markRegistrationLinksPaid`, `afterRegistrationPayment`; open links are checked with the gateway every 15 min |
| 6. Commission on renewals: setting, default **No** | `shopRegistrationSubscription.payCommissionOnRenewals` gates the TIERED renewal commission (registration commission unchanged) |
| 7. Apps | app 1.14.0 (Android versionCode 15, iPhone build 15): deep links for the registration pages; the card / banners / payment are web pages, so older app versions show them too |

## Switches before go-live (per site)

1. Migration 0204 runs with the deploy (staging queue / production release).
2. Admin → Unpaid & expiring registrations → Settings: **Send reminders** on; **Online renewal** on. Check grace (7) and CC list.
3. The status is enforced while rule `shopMembership.enabled` is on (it is on by default).

## Owner decisions taken as defaults (change in Settings)

- Grace default changed from 15 to **7 days** (brief). Shops already past their expiry at migration get 7 days from the migration.
- Waived / zero-fee / exempt shops never expire ("no end date").
- Expire now = no grace (the shop is hidden at once).
- The CC list gets **one daily digest** (unpaid, expiring in 7 days, grace, expired) instead of a copy of every owner reminder.
- An admin's amount on a payment link for an unpaid shop becomes the registration fee owed.

## Files

- `drizzle/0204_shop_registration_subscription.sql`, `scripts/rollback-0204.sql`
- `src/server/services/shop-registration-subscription.ts` (new), `shop-membership.ts`, `shop-payments.ts`,
  `shop-membership-renewal.ts`, `operator-limited.ts`, `registration/service.ts`
- `src/server/payments/intents.ts` (link expiry + metadata), `processing.ts` (long links not "stuck"),
  `gateway/types.ts`, `cashfree.ts`, `sandbox.ts` (cancel link)
- `src/server/config/rules.ts` (rule `shopRegistrationSubscription`; grace 7), `authz/permissions.ts`
  (`SHOP_REGISTRATION_SUBSCRIPTION_MANAGE`: ADMIN, OPERATOR), `notifications/types.ts`, `templates.ts`, `audit.ts`,
  `cron/schedule.ts`
- Discovery: `shops.ts`, `home-discovery.ts`, `catalogue.ts`, `search-suggest.ts`, `price-comparison.ts`
- UI: `src/app/admin/shops/registrations/**`, `src/components/admin/shop-registrations-table.tsx`,
  `shop-registration-settings-form.tsx`, `src/components/seller/registration-status.tsx`, `seller-shell.tsx`,
  `src/app/shop/layout.tsx`, `src/app/shop/page.tsx`, `src/app/shop/manage/[section]/page.tsx`, `src/lib/board/menus.ts`
- API: `GET/POST /api/admin/registration-subscription`, `GET /api/admin/registration-subscription/{shopId}`,
  `GET/PUT /api/admin/registration-subscription/settings`
- App: `mobile/app.config.ts`, `mobile/package.json`, `mobile/src/deep-links.ts`, `src/lib/deep-links.ts`, `mobile/RELEASE_NOTES.md`
- Tests: `tests/unit/shop-registration-subscription.test.ts` (15), `tests/integration/shop-registration-subscription.test.ts` (18),
  `mobile/src/__tests__/shop-registration-links.test.ts`; updated `cron-schedule`, `owner-decisions-2026-10-25` (grace 7)

## API

- `GET /api/admin/registration-subscription?filter=UNPAID|EXPIRING_30|EXPIRING_15|EXPIRING_7|GRACE|EXPIRED|ACTIVE|EXEMPT|ALL&shopType=&area=&dealerCode=&q=[&format=csv]`
- `POST /api/admin/registration-subscription` `{action: "REMIND", shopIds}` · `{action: "LINK", shopIds, amountPaise?, validityDays?}` ·
  `{action: "EXPIRY", shopId, change: {mode: EXTEND|SHORTEN, days} | {mode: SET_DATE, date} | {mode: EXPIRE_NOW}, reason}` ·
  `{action: "MARK_PAID", shopId, reference, note, method, amountPaise?, paidOn?}` · `{action: "SETTINGS", shopId, remindersEnabled?, renewalFeePaise?, graceDays?, reason}`
- `GET /api/admin/registration-subscription/{shopId}` → payments + audit trail
- `GET/PUT /api/admin/registration-subscription/settings` (ADMIN)

## Rollback

Deploy the previous release, then run `scripts/rollback-0204.sql` and delete the 0204 row from
`drizzle.__drizzle_migrations`. Shops that got their first expiry from 0204 go back to "no end date".
