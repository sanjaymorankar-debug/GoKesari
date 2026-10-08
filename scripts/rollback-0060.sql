-- Rollback for 0060_fulfilment_options (docs/four-features-2026-10, feature 1).
-- Run only after the previous code is live (it never reads these tables), then
-- delete the 0060 row from drizzle.__drizzle_migrations (see the release README).
-- Orders keep their status; plans and the shop delivery staff list are lost —
-- back up first if they matter.
DROP TABLE IF EXISTS "order_fulfilment_arrangements";
DROP TABLE IF EXISTS "shop_delivery_staff";
