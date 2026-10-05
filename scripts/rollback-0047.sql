-- Reverses drizzle/0047_coupons.sql. Afterwards delete the 0047 row from drizzle.__drizzle_migrations.
DROP TABLE IF EXISTS "coupon_redemptions";
DROP TABLE IF EXISTS "coupons";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "coupon_code", DROP COLUMN IF EXISTS "discount_paise";
