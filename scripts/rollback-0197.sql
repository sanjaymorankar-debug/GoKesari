-- Rollback for 0197_shop_membership_renewal (shop membership renewal; docs/shop-membership-renewal-2026-11/).
-- Before running: deploy the previous release's code, switch rule shopMembership.renewalCheckoutEnabled and
-- remindersEnabled off, and let any open SHOP_MEMBERSHIP_RENEWAL payment finish (a capture after the rollback
-- has no handler and is flagged for support). Then delete the 0197 row from drizzle.__drizzle_migrations.
-- The renewal history (shop_membership_periods) and the exemptions are lost; memberships' end dates
-- (shops.membership_valid_until) and the payment ledger are kept. The SHOP_MEMBERSHIP_RENEWAL payment purpose
-- stays allowed (inert).
DROP TABLE IF EXISTS "shop_membership_periods";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "membership_exempt_set_at";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "membership_exempt_set_by";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "membership_exempt_reason";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "membership_exempt";
