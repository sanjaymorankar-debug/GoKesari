-- split: seller
-- Billing v2, phase 5 (docs/billing §7, §2.3): the sync log (every record exchanged with the
-- shop's accounting software, by that software's key, with the last hash and direction), the
-- conflict queue, and the shop's unit → GST unit code (UQC) map. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0130.sql
CREATE TABLE IF NOT EXISTS "sync_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"system" text NOT NULL,
	"entity_type" text NOT NULL,
	"gokesari_id" text,
	"external_key" text NOT NULL,
	"last_hash" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'SYNCED' NOT NULL,
	"error" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_records_direction_check" CHECK ("direction" IN ('OUT', 'IN')),
	CONSTRAINT "sync_records_status_check" CHECK ("status" IN ('SYNCED', 'FAILED', 'CONFLICT'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_records_key_uq" ON "sync_records" USING btree ("shop_id", "system", "entity_type", "external_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_records_shop_idx" ON "sync_records" USING btree ("shop_id", "system", "last_synced_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"system" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_key" text NOT NULL,
	"gokesari_id" text,
	"local_snapshot" jsonb NOT NULL,
	"incoming_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_conflicts_status_check" CHECK ("status" IN ('OPEN', 'KEPT_LOCAL', 'TOOK_INCOMING'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_conflicts_open_uq" ON "sync_conflicts" USING btree ("shop_id", "system", "entity_type", "external_key") WHERE "status" = 'OPEN';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_conflicts_shop_idx" ON "sync_conflicts" USING btree ("shop_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inv_unit_uqc" (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"unit" text NOT NULL,
	"uqc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_unit_uqc_pk" PRIMARY KEY ("shop_id", "unit")
);
