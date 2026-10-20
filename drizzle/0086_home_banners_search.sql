-- split: core
-- Homepage UI/UX upgrade (docs/homepage-uiux-2026-10):
--   home_banners    the home page's hero carousel: schedule, order, on/off, city / PIN targeting (platform)
--   search_queries  header searches: a customer's recent searches, and trending across everyone (platform)
-- Both are platform tables (core database, next to users), so their foreign keys stay inside
-- one physical database. Additive only: nothing existing is changed.
CREATE TABLE IF NOT EXISTS "home_banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"image_url" text,
	"cta_label" text,
	"cta_href" text DEFAULT '/shops' NOT NULL,
	"kind" text DEFAULT 'GENERAL' NOT NULL,
	"city" text,
	"pincode" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_banners_kind_check" CHECK ("kind" IN ('DEAL', 'SEASONAL', 'NEW_SHOPS', 'GENERAL')),
	CONSTRAINT "home_banners_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "home_banners_live_idx" ON "home_banners" USING btree ("active","sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_queries_query_length" CHECK (char_length("query") BETWEEN 2 AND 80)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_user_idx" ON "search_queries" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_created_idx" ON "search_queries" USING btree ("created_at");
