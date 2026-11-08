-- Owner, 08-Nov-2026: the guided "Set up your shop's products" flow.
-- A listing added without a quantity waits as Needs Stock; every existing listing keeps false, so nothing changes for it.
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "stock_pending" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- The owner stopped selling this listing. is_available cannot carry this: it follows the stock (inventory-alerts.ts).
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "owner_paused" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_product_setup" (
  "shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "step" smallint NOT NULL DEFAULT 1,
  "new_products_seen_at" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_product_setup_step_range" CHECK ("step" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_bulk_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "uploaded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "file_name" text NOT NULL,
  "file_sha256" text NOT NULL,
  "file_data" bytea,
  "status" text NOT NULL DEFAULT 'CHECKING',
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "plan" jsonb,
  "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "headers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "failure" text,
  "pause_confirmed" boolean NOT NULL DEFAULT false,
  "total_rows" integer NOT NULL DEFAULT 0,
  "applied_rows" integer NOT NULL DEFAULT 0,
  "result" jsonb,
  "last_progress_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  CONSTRAINT "shop_bulk_uploads_status_known" CHECK ("status" IN ('CHECKING', 'READY', 'REJECTED', 'APPLYING', 'DONE', 'CANCELLED', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_bulk_uploads_shop_idx" ON "shop_bulk_uploads" ("shop_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_bulk_uploads_hash_idx" ON "shop_bulk_uploads" ("shop_id", "file_sha256");
