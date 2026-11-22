-- Rollback for 0162_referral_moves (referral moves, owner 22-Nov-2026; src/server/dealers/referral-moves.ts).
-- Before running: deploy the previous release's code, export the move requests and their consent letters if they
-- matter, then delete the 0162 row from drizzle.__drizzle_migrations. Run before rollback-0157.sql.
-- Moves already applied stay applied (shop attributions, plans and codes are not put back).
DROP TABLE IF EXISTS "referral_move_documents";
DROP TABLE IF EXISTS "referral_move_requests";
DROP TABLE IF EXISTS "franchise_shop_team_periods";
ALTER TABLE IF EXISTS "franchise_shop_attributions" DROP COLUMN IF EXISTS "attached_from";
ALTER TABLE IF EXISTS "shop_attributions" DROP COLUMN IF EXISTS "placement_at";
