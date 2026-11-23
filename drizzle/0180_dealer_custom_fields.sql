-- Dealership & Franchise Platform, Phase 5: custom fields (owner brief 23-Nov-2026; docs/dealer-platform/).
--
-- * dealers.custom_values: the applicant's answers to his scheme's custom fields (field key → value). The fields
--   themselves are part of the scheme version's terms (versioned, never changed once published).
-- * dealer_custom_files: files uploaded for FILE-type custom fields, encrypted like dealer documents; the latest
--   per dealer and field counts.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0180.sql.
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "custom_values" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_custom_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
  "field_key" text NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content" bytea NOT NULL,
  "uploaded_by" uuid,
  "uploaded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dealer_custom_files_key" CHECK ("field_key" ~ '^[a-z][a-z0-9_]{0,29}$'),
  CONSTRAINT "dealer_custom_files_size" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_custom_files_dealer_idx" ON "dealer_custom_files" ("dealer_id", "field_key", "uploaded_at");
