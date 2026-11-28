-- Dealer / super dealer promotion (owner, 28-Nov-2026 ~20.00 IST; docs/dealer-promotion-2026-11/README.md).
-- Additive only. Rollback: scripts/rollback-0233-dealer-super-wish.sql.
--
-- A shop owner who asks to become a dealer may also ask to become a super dealer, and an admin / operator who
-- promotes a shop owner may tick "also make super dealer". The dealer is not approved yet at that moment, so the wish
-- is kept on the dealer row and acted on when the dealer is approved:
--   wants_super_by = an ADMIN  -> promoted to super dealer at once (the admin's decision);
--   anyone else                -> a super dealer request is raised for an admin / operator to approve.
-- Cleared once acted on.
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "wants_super_at" timestamp with time zone;
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "wants_super_by" uuid;
