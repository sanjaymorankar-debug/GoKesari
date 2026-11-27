-- Rollback of drizzle/0226_franchisee_request.sql. Deploy the previous release first, then run this and delete the
-- 0226 row from drizzle.__drizzle_migrations. Idempotent. Requests keep their rows as ordinary applications.
UPDATE "dealers" SET "source" = 'APPLICATION' WHERE "source" = 'SHOP_REQUEST';
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_source";
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_source" CHECK ("source" IN ('APPLICATION', 'LEGACY_MIGRATION', 'ADMIN'));
DELETE FROM "platform_settings" WHERE "key" = 'dealerApplication';
