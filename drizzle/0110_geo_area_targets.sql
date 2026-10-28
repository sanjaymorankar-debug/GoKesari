-- split: seller
-- Dealer programme step 8 (docs/dealer-programme, GKS-GEO-001): the number of shops GoKesari
-- aims to have in an area (district, taluka or locality), for "target vs registered" on the
-- coverage map. Set by an admin. ADDITIVE ONLY; idempotent. updated_by names a user on the
-- customer side, so it has no foreign key (two-database layout).
CREATE TABLE IF NOT EXISTS "geo_area_targets" (
	"area_code" text PRIMARY KEY NOT NULL,
	"target_shops" integer NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_area_targets_target" CHECK ("target_shops" >= 0 AND "target_shops" <= 100000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "geo_area_targets" ADD CONSTRAINT "geo_area_targets_area_code_geo_areas_code_fk" FOREIGN KEY ("area_code") REFERENCES "public"."geo_areas"("code") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
