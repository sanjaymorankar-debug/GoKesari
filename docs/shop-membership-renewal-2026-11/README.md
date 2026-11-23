# Shop membership renewal — modules 8 + 9 (23-Nov-2026)

Yearly shop fee renewal checkout, renewal reminders, an admin report and per-shop exemption,
and the admin ON/OFF switches. Branch `feat/m8-membership-renewal`, migration **0189**.

## What already existed
- `shops.membership_valid_until` (0094) and rule `shopMembership {enabled, periodMonths 12, graceDays 15, reminderDays 30}`.
- `services/shop-membership.ts`: `membershipEndAfterPayment` (extends from the later of the current end and the
  payment — kept), `membershipStatus` (DUE_SOON / GRACE / LAPSED), `membershipOrderGate` and
  `membershipLapsedShopIds` wired into `serviceability.ts` (a lapsed shop is closed to customers).
- `shop_payments` ledger (REGISTRATION_FEE / RENEWAL / ADJUSTMENT / REFUND / REVERSAL), the owner's online
  registration-fee checkout (`registration-fee-payment.ts`) and its capture handler.
- Operators could already record a RENEWAL payment by hand (`POST /api/shop-payments`).

## Gaps closed
| # | Requirement | Status |
|---|---|---|
| 1 | Rule switches: `renewalFeePaise`, `addGst`, `renewalCheckoutEnabled` (off), `remindersEnabled` (off), `renewalWindowDays` (30), `exemptShopTypes`, `exemptCategorySlugs` | DEVELOPED |
| 2 | Migration 0189: exemption columns, payment purpose `SHOP_MEMBERSHIP_RENEWAL`, `shop_membership_periods` (history) | DEVELOPED |
| 3 | Renewal checkout + capture handler; **defect fixed**: a part payment no longer extends the membership; refund / reversal rolls the period back | DEVELOPED / FIXED |
| 4 | Printable receipt for a renewal (GST split when known) | DEVELOPED |
| 5 | Owner UI: plan, fee, expiry, renewal date, state, Renew now, renewal history; "Renew it" link fixed; "Not enforced" copy | DEVELOPED / FIXED |
| 6 | Daily reminders (reminderDays / 7 / 1 / 0 days before, grace end), in-app + e-mail, deduplicated | DEVELOPED |
| 7 | Admin report with filters + CSV; per-shop exemption (audited); switches via the existing rules editor | DEVELOPED |
| 8 | Exemptions respected by `membershipStatus`, `membershipOrderGate`, `membershipLapsedShopIds` | DEVELOPED |

## How it works
- **Periods.** Every extension writes a row in `shop_membership_periods` (kind REGISTRATION / RENEWAL; start,
  end, the end before it, the fee it consumed, GST split, the payment). A shop's fee payments (REGISTRATION_FEE,
  RENEWAL, REFUND and reversals of those) are one pool; a payment opens a period only when the unallocated
  pool covers the next fee — the registration fee snapshot for the first period, the renewal fee after that —
  at most one period per payment. ADJUSTMENT rows are not in the pool.
- **Rollback.** After a REFUND, or a reversal of a fee payment, while the pool no longer pays for the periods
  the newest ones are voided (`voided_at`, reason, the correcting payment). The latest period restores the
  end before it (or its start date, never "no end date"); an older one takes its length off the end. LEGACY
  rows are never rolled back.
- **LEGACY backfill.** The migration gives each shop with an end date one LEGACY row holding what it had paid
  so far, so old payments are not counted again towards the next renewal. Shops that got a year from a part
  payment before this fix keep it.
- **Renewal fee.** `renewalFeePaise` > 0: that base fee for every shop. 0 (default): the shop's own
  registration base fee (`registration_fee_base_paise`, without its coupon). GST is added at the
  PLATFORM_FEE_GST rate for REGISTRATION_FEE (as on the registration fee; falls back to the shop's own rate if
  no statutory row is in force) when `addGst` is on. A shop registered before the breakdown was kept renews
  at its registration total. Manual operator renewals use the same fee to decide whether a period is paid.
- **Checkout.** Only while `renewalCheckoutEnabled`, for a live (APPROVED/SUSPENDED), non-exempt shop with an
  end date, whose registration fee is settled, from `renewalWindowDays` before the end or once DUE_SOON /
  GRACE / LAPSED. Idempotency key `shop-membership-renewal:<shop>:<current end date>:<attempt>`; a live
  checkout for the same period and amount is reused; a captured one refuses a new one. The quote and the
  period key are stored on the intent's metadata.
- **Capture.** `onShopMembershipRenewalCaptured` (purpose-handlers.ts), in the capture transaction: idempotent
  on `<gateway>:<payment id>`; records RENEWAL / ONLINE; the membership extends from the current expiry. If
  the period was already renewed meanwhile (second checkout paid), the money is recorded as an ADJUSTMENT
  "to be refunded", nothing is extended and the payment is flagged for support. After commit: renewal dealer
  commission (existing TIERED rule) and the "Membership renewed" notification. Failed / expired attempts show
  on the owner's page ("did not go through"); pending shows "Checking your payment…".
- **OFF rules.** `enabled` off: nobody is closed (unchanged) and the owner sees "not enforced" instead of
  "renew or go offline". `renewalCheckoutEnabled` off: no new checkout starts (open ones still complete).
  `remindersEnabled` off: no reminders. Switching anything off never suspends a shop.

## Files
- `drizzle/0189_shop_membership_renewal.sql`, `drizzle/meta/_journal.json`, `scripts/rollback-0189.sql`
- `src/server/db/schema.ts` (shops exemption columns, `shopMembershipPeriods`, payment purpose)
- `src/server/config/rules.ts` (rule `shopMembership`)
- `src/server/services/shop-membership.ts` (exemptions, periods, rollback, renewal fee)
- `src/server/services/shop-membership-renewal.ts` (new: checkout, capture, reminders, report, exemption, receipt)
- `src/server/services/shop-payments.ts` (partial-instalment fix, refund / reversal rollback)
- `src/server/registration/service.ts` (self-registration records its period)
- `src/server/payments/intents.ts`, `purpose-handlers.ts`; `src/server/cron/schedule.ts` (`shop-membership-reminders`)
- `src/server/notifications/types.ts`, `templates.ts` (`shop.membership_renewal_due`, `shop.membership_renewed`)
- `src/server/services/audit.ts` (5 new actions)
- UI: `src/components/membership-renewal-card.tsx`, `membership-renew-button.tsx`, `membership-exemption-toggle.tsx`,
  `shop-status-panel.tsx`; `src/app/shop/manage/[section]/page.tsx`; `src/app/shop/membership/receipt/[periodId]/page.tsx`;
  `src/app/admin/shops/memberships/page.tsx`; `src/lib/board/menus.ts` (Admin → Shops → Shop memberships)

## API
- `POST /api/shops/{id}/membership-renewal` → `{intentId, amountPaise, redirectUrl}` (owner of the shop only; rate limited; 409 when refused).
- `GET /api/admin/shop-memberships?state=&q=&endsWithinDays=[&format=csv]` (PAYMENT_VIEW_ANY; CSV masks mobiles).
- `POST /api/admin/shop-memberships {shopId, exempt, reason}` (ADMIN only; audited `shop.membership_exemption_changed`).
- Settings: Admin → Settings → rule `shopMembership` (existing editor, audited `setting.changed`).

## Feature flag
None — the new behaviour is behind the rule switches, which default OFF (`renewalCheckoutEnabled`,
`remindersEnabled`; exemption lists empty). Always on: the part-payment fix, refund rollback, the
"Not enforced" copy, the fixed "Renew it" link, the read-only report.

## Tests
- `tests/unit/shop-membership-renewal.test.ts` — 18 tests: status / exemptions / OFF, extension from expiry,
  renewal fee, part payments, rollback, reminder stages, Renew-now eligibility, CSV.
- `tests/integration/shop-membership-renewal.test.ts` — 12 tests: partial instalments (registration and
  renewal), refund and reversal rollback, sandbox checkout (OFF by default, once per period, replayed capture,
  duplicate period → adjustment, failed retry, other owner), reminders off / on and dedupe, exemptions (per
  shop, audited, by type), membership off.
- Updated: `owner-decisions-2026-10-25` (the shop's fee now equals the renewal paid — the old test relied on a
  part payment extending the membership, the defect fixed here) and `cron-schedule` (new daily job).

## Still open / for the owner
- Turn on `renewalCheckoutEnabled` and `remindersEnabled` on staging (Admin → Settings) and test with the sandbox
  page (`/orders/pay/sandbox/…`, "Pay (success)").
- Confirm the renewal fee default (the shop's own registration base + GST) or set a fixed `renewalFeePaise`.
- Refunds of a duplicate renewal payment are done by finance (flagged for support); not automatic.
- Reversing a refund does not re-open the voided period automatically (record the renewal again).
- Hindi / Marathi: the Registration page is English-only today, so the new owner strings are English too.
