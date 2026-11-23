-- Rollback for 0184_guest_checkout (docs/guest-checkout-2026-11).
-- Before running: switch guest_checkout_enabled OFF and deploy the previous release's code, then delete the 0184
-- row from drizzle.__drizzle_migrations. Accounts made by guest checkout stay (they are normal customer accounts);
-- only the marker column goes. Tracking links already e-mailed stop working once the code is gone.
ALTER TABLE "users" DROP COLUMN IF EXISTS "guest_created";
DELETE FROM "feature_flags" WHERE "key" = 'guest_checkout_enabled';
