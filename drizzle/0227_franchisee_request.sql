-- Free franchisee requests (owner, 27-Nov-2026): a shop owner with a live shop asks to become a free franchisee
-- (dealer); the request waits for an admin, who approves it and issues the dealer code. The dealer row records where
-- it came from: source SHOP_REQUEST. Rule dealerApplication (requireLiveShop, code default true) needs no seed.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0227-franchisee-request.sql.
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_source";
--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_source" CHECK ("source" IN ('APPLICATION', 'LEGACY_MIGRATION', 'ADMIN', 'SHOP_REQUEST'));
