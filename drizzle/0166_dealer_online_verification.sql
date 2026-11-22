-- Dealer documents checked online (owner, 22-Nov-2026; docs/dealer-programme/ONLINE_VERIFICATION.md).
-- Additive and safe to re-run: one row per dealer and document type with the latest online check of the number
-- the dealer typed (PAN through the KYC provider, GSTIN likewise). number_key is the PAN blind index or the GSTIN,
-- so a check stops counting as soon as the number changes. Only the normalised result is stored (name on the
-- record, status, the provider's reference), never the vendor's raw response.
-- Rollback: scripts/rollback-0166.sql.
CREATE TABLE IF NOT EXISTS "dealer_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "number_key" text NOT NULL,
  "status" text NOT NULL,
  "matched_name" text,
  "name_score" smallint,
  "error_code" text,
  "provider" text NOT NULL,
  "provider_ref" text,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "checked_by" uuid,
  "checked_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_verifications_dealer_doc_uq" ON "dealer_verifications" ("dealer_id", "doc_type");
