-- split: core
-- Dealer programme (docs/dealer-programme, step 1): admin-controlled feature flags. ADDITIVE ONLY.
-- Every flag is seeded OFF; with all of them off the site behaves exactly as before.
-- district_codes NULL = every district; otherwise the flag is on only for shops / dealers in
-- those districts (codes of geo_areas rows, checked by the service — geo_areas is a seller
-- table, so there is no foreign key from here).
CREATE TABLE IF NOT EXISTS "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"district_codes" text[],
	"updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flag_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_key" text NOT NULL,
	"old_value" jsonb NOT NULL,
	"new_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"changed_by_email" text,
	"changed_by_role" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_changes_key_idx" ON "feature_flag_changes" ("flag_key", "changed_at");--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES
	('dealer_programme_enabled', false),
	('gov_verification_auto_approval_enabled', false),
	('dealer_rating_bonus_enabled', false),
	('paid_support_services_enabled', false)
ON CONFLICT DO NOTHING;
