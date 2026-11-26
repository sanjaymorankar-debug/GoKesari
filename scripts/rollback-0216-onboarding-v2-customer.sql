-- Rollback of drizzle/0216_onboarding_v2_customer.sql (docs/onboarding-v2-2026-11, Flow 1 customer).
-- Switch the flag off first (Admin → Feature flags → onboarding_v2). Orders still waiting for a delivery address
-- should be given one (or cancelled) before this runs: once the column is gone, nothing holds their rider dispatch.
DROP INDEX IF EXISTS "orders_address_pending_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "address_pending_since";
