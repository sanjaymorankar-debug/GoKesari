-- Rollback of drizzle/0226_super_franchisee.sql (docs/super-franchisee/README.md).
-- Deploy the previous release's code first, then run this and delete the 0226 row from drizzle.__drizzle_migrations.
-- Idempotent. Check first that no super franchisee line was paid:
--   SELECT count(*) FROM dealer_commission_ledger WHERE entry_type IN ('SUPER_FEE', 'SUPER_ORDER') AND status = 'PAID';
-- Unpaid lines are deleted; the widened entry-type and shop checks stay (harmless supersets).
DELETE FROM "dealer_commission_ledger" WHERE "entry_type" IN ('SUPER_FEE', 'SUPER_ORDER') AND "status" <> 'PAID';
DROP TABLE IF EXISTS "super_franchisee_members";
DROP TABLE IF EXISTS "super_franchisees";
DELETE FROM "platform_settings" WHERE "key" = 'superFranchisee';
