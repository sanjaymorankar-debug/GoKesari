CREATE TABLE "maps_api_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"purpose" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"success" boolean NOT NULL,
	"response_time_ms" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "landmark" text;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "delivery_instructions" text;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "location_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "location_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "location_source" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pickup_latitude" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pickup_longitude" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pickup_instructions" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "landmark" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "location_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "location_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "location_source" text;--> statement-breakpoint
CREATE INDEX "maps_api_call_log_service_idx" ON "maps_api_call_log" USING btree ("service");--> statement-breakpoint
CREATE INDEX "maps_api_call_log_created_idx" ON "maps_api_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "maps_api_call_log_entity_idx" ON "maps_api_call_log" USING btree ("entity_type","entity_id");