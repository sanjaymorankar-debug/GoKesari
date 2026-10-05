-- 0040 Seller verification (PAN, GSTIN, Udyam, FSSAI, Shop Act).
--   * seller_verifications: one row per shop per document — current status,
--     masked + encrypted number, verified name, expiry, vendor reference.
--   * seller_verification_events: append-only history behind it.
-- Additive only: no existing table or column changes, so the previous release
-- keeps working if this is applied first. Rollback: scripts/rollback-0040.sql
CREATE TYPE "public"."seller_doc_type" AS ENUM('PAN', 'GSTIN', 'UDYAM', 'FSSAI', 'SHOP_ACT');--> statement-breakpoint
CREATE TYPE "public"."seller_verification_status" AS ENUM('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'FAILED', 'MANUAL_REVIEW', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "seller_verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"doc_type" "seller_doc_type" NOT NULL,
	"event_type" text NOT NULL,
	"from_status" "seller_verification_status",
	"to_status" "seller_verification_status",
	"actor_id" uuid,
	"actor_role" "user_role",
	"provider_id" text,
	"provider_ref" text,
	"error_code" text,
	"note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"doc_type" "seller_doc_type" NOT NULL,
	"status" "seller_verification_status" DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"number_encrypted" text,
	"number_masked" text,
	"number_hash" text,
	"verified_name" text,
	"name_match_score" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_until" date,
	"provider_id" text,
	"provider_ref" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"idempotency_key" text,
	"consent_given_at" timestamp with time zone,
	"consent_version" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_verifications_attempts_non_negative" CHECK ("seller_verifications"."attempt_count" >= 0),
	CONSTRAINT "seller_verifications_number_all_or_none" CHECK (("seller_verifications"."number_encrypted" IS NULL) = ("seller_verifications"."number_masked" IS NULL) AND ("seller_verifications"."number_encrypted" IS NULL) = ("seller_verifications"."number_hash" IS NULL)),
	CONSTRAINT "seller_verifications_submitted_has_consent" CHECK ("seller_verifications"."status" = 'NOT_SUBMITTED' OR "seller_verifications"."number_encrypted" IS NULL OR "seller_verifications"."consent_given_at" IS NOT NULL),
	CONSTRAINT "seller_verifications_name_match_range" CHECK ("seller_verifications"."name_match_score" IS NULL OR "seller_verifications"."name_match_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "seller_verification_events" ADD CONSTRAINT "seller_verification_events_verification_id_seller_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."seller_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verification_events" ADD CONSTRAINT "seller_verification_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_verification_events_verification_idx" ON "seller_verification_events" USING btree ("verification_id","created_at");--> statement-breakpoint
CREATE INDEX "seller_verification_events_shop_idx" ON "seller_verification_events" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_verifications_shop_doc_unique" ON "seller_verifications" USING btree ("shop_id","doc_type");--> statement-breakpoint
CREATE INDEX "seller_verifications_status_idx" ON "seller_verifications" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "seller_verifications_valid_until_idx" ON "seller_verifications" USING btree ("valid_until") WHERE "seller_verifications"."valid_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "seller_verifications_number_hash_idx" ON "seller_verifications" USING btree ("doc_type","number_hash") WHERE "seller_verifications"."number_hash" IS NOT NULL;--> statement-breakpoint
-- History is append-only: UPDATE is refused so no bug or compromised app role
-- can rewrite what happened. DELETE stays allowed (unlike audit_logs) because
-- the DPDP Act requires erasing verification data once its retention period
-- ends, and because deleting a shop cascades here.
CREATE OR REPLACE FUNCTION seller_verification_events_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'seller_verification_events is append-only: UPDATE is not allowed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS seller_verification_events_append_only ON "seller_verification_events";--> statement-breakpoint
CREATE TRIGGER seller_verification_events_append_only
  BEFORE UPDATE ON "seller_verification_events"
  FOR EACH ROW EXECUTE FUNCTION seller_verification_events_block_update();
