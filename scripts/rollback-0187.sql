-- Rollback for 0187_tax_register (docs/tax-register/README.md).
-- Before running: deploy the previous release's code, then delete the 0187 row from
-- drizzle.__drizzle_migrations. Change requests, approvals and CA items are lost: export them first.
-- Settings already changed through the register keep their values (they live in their own tables).
BEGIN;
DROP TABLE IF EXISTS "ca_action_item_notes";
DROP TABLE IF EXISTS "ca_action_items";
DROP TABLE IF EXISTS "tax_param_approvals";
DROP TABLE IF EXISTS "tax_change_requests";
DELETE FROM "feature_flags" WHERE "key" = 'tax_register';
COMMIT;
