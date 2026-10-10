-- 0074 Referral settings (docs/nearby-referral-2026-10, feature 2): referral code Mandatory/Optional
-- for customer and shop registration, admin-only, with a change log. Both start OPTIONAL.
-- shop_registrations.referral_code_id becomes nullable (a self-registration without a code while
-- the shop setting is OPTIONAL). Additive only. Rollback: scripts/rollback-0074.sql.
CREATE TABLE "referral_setting_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setting_key" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"changed_by" uuid,
	"changed_by_email" text,
	"changed_by_role" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text DEFAULT 'OPTIONAL' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_settings_value" CHECK ("referral_settings"."value" in ('MANDATORY', 'OPTIONAL'))
);
--> statement-breakpoint
ALTER TABLE "shop_registrations" ALTER COLUMN "referral_code_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_setting_changes" ADD CONSTRAINT "referral_setting_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_settings" ADD CONSTRAINT "referral_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_setting_changes_key_idx" ON "referral_setting_changes" USING btree ("setting_key","changed_at");--> statement-breakpoint
INSERT INTO "referral_settings" ("key", "value") VALUES ('referral_required_customer', 'OPTIONAL'), ('referral_required_shop', 'OPTIONAL') ON CONFLICT ("key") DO NOTHING;