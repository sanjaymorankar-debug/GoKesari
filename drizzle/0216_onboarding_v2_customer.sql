-- Onboarding v2, Flow 1 — customer signs in only at checkout (docs/onboarding-v2-2026-11). Flag `onboarding_v2`.
--
-- * orders.address_pending_since: set only by a v2 checkout that places a delivery order before the customer has
--   given the delivery address (the address is asked straight after payment). While it is set, rider dispatch
--   does not start; the customer's "Set delivery location" clears it. NULL on every other order (all existing
--   rows), so with the flag off nothing changes.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0216-onboarding-v2-customer.sql.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "address_pending_since" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_address_pending_idx" ON "orders" ("user_id") WHERE "address_pending_since" IS NOT NULL;
