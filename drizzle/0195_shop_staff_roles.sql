-- Module 10: shop staff roles and permissions (owner brief 23-Nov-2026; docs/shop-staff-roles-2026-11/).
--
-- * shop_staff.role: the person's preset role in the shop. Every existing row (scope CATALOGUE: product photos
--   and descriptions) becomes CATALOGUE_MANAGER, which is what it already allowed. `scope` stays for compatibility.
-- * shop_staff.permissions: extra grants on top of the role, or the whole list for role CUSTOM.
-- * status gains INVITED and SUSPENDED (ACTIVE and REVOKED unchanged; the column is text, no constraint to change).
-- * invite fields: invite_email (a person without an account yet), invite_token_hash (sha-256 of the emailed link's
--   token), invite_expires_at, invited_by, accepted_at, plus suspended_at/by and role_changed_at.
-- * user_id becomes nullable: an invitation to an e-mail address that has no account yet has no user until it is
--   accepted. Accepting fills it in.
-- * one open row (INVITED / ACTIVE / SUSPENDED) per person per shop.
-- * feature flag shop_staff_roles_enabled (OFF): with it off, staff stay catalogue-only exactly as before.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0195.sql.
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'CATALOGUE_MANAGER';
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "permissions" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "invite_email" text;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "invite_token_hash" text;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "invite_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "suspended_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "shop_staff" ADD COLUMN IF NOT EXISTS "role_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_staff" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_staff_one_open" ON "shop_staff" USING btree ("shop_id","user_id")
  WHERE "status" IN ('INVITED', 'ACTIVE', 'SUSPENDED') AND "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_staff_one_open_email" ON "shop_staff" USING btree ("shop_id", lower("invite_email"))
  WHERE "status" = 'INVITED' AND "user_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_staff_invite_token_idx" ON "shop_staff" USING btree ("invite_token_hash")
  WHERE "invite_token_hash" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('shop_staff_roles_enabled', false) ON CONFLICT DO NOTHING;
