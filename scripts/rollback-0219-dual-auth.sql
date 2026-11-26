-- Rollback of drizzle/0219_dual_auth.sql (docs/dual-auth-2026-11). Switch the flag off first; nothing else needs it.
-- Drops only what 0219 added. Accounts, codes and audit rows are kept.
UPDATE "feature_flags" SET "enabled" = false WHERE "key" = 'dual_auth';
DROP TABLE IF EXISTS "trusted_devices";
DROP INDEX IF EXISTS "users_needs_second_factor_idx";
ALTER TABLE "users" DROP COLUMN IF EXISTS "second_factor_reminded_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "needs_second_factor_since";
ALTER TABLE "users" DROP COLUMN IF EXISTS "needs_second_factor";
