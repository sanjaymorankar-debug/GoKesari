-- Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11/README.md, 24-Nov-2026).
--
-- * consent_type + SELLER_GOODS_UNDERTAKING (the owner's promise never to send expired, stale or non-compliant goods)
--   and SELLER_TERMS (acceptance of the Marketplace Seller Terms), each recorded with its own version
--   (src/lib/legal/seller-undertaking.ts).
-- * user_consents + shop_id (the shop the seller consent was given for) and user_agent (evidence of the act);
--   both nullable, no foreign key (a consent is kept as evidence when a shop is deleted).
-- * feature flag seller_undertaking_gate_enabled (OFF): when ON, an owner without the current versions sees the
--   acknowledgement instead of Seller Central and their shops cannot accept new orders.
--
-- The enum values are added the way 0170 / 0181 add user_role values (EXECUTE inside a DO block, IF NOT EXISTS);
-- nothing in this migration uses the new values, so it is safe inside the migrator's transaction (PostgreSQL 12+).
-- Additive and safe to re-run. Rollback: scripts/rollback-0209.sql (enum values cannot be dropped; unused, inert).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'consent_type' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS ''SELLER_GOODS_UNDERTAKING''';
    EXECUTE 'ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS ''SELLER_TERMS''';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "user_consents" ADD COLUMN IF NOT EXISTS "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_consents" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_consents_user_type_created_idx" ON "user_consents" ("user_id", "consent_type", "created_at");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('seller_undertaking_gate_enabled', false) ON CONFLICT DO NOTHING;
