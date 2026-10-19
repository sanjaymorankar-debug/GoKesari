-- batch-2026-10 0082_batch_d_catalogue (WS-D: operator-limited, product master data). ADDITIVE ONLY.
--
--   F8.4.2  Operator-Limited role, owner-OTP consent sessions, who onboarded a shop.
--   F9.1.2  Manufacturer accounts, members and hashed API keys; per-record licence attribution.
--   F9.1.4  Batched, resumable ingestion jobs (job + staged input rows), object store, image assets.
--
-- Seller database (docs/db-split-2026-10): every table here is owned by `seller`. Columns that point
-- at users (platform, physically the customer database) or at payment intents (customer database)
-- are plain uuid/text WITHOUT a foreign key.
--
-- New enum values are added here but never USED in this file (a value added by ALTER TYPE cannot be
-- used in the same transaction).

ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'OPERATOR_LIMITED';
--> statement-breakpoint
ALTER TYPE "public"."shop_payment_method" ADD VALUE IF NOT EXISTS 'ONLINE';
--> statement-breakpoint

-- F8.4.2 — which operator onboarded the shop (null: the owner registered it, or a full operator did
-- before this column existed). An Operator-Limited user sees only the shops carrying their own id.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "onboarded_by_user_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shops_onboarded_by_idx" ON "shops" ("onboarded_by_user_id") WHERE "onboarded_by_user_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shop_onboarding_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operator_id" uuid NOT NULL,
  "owner_email" text NOT NULL,
  "owner_user_id" uuid,
  "status" text DEFAULT 'OTP_SENT' NOT NULL,
  "otp_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "otp_verified_at" timestamp with time zone,
  "consent_expires_at" timestamp with time zone,
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL,
  "referral_code" text,
  "fee_mode" text,
  "fee_status" text DEFAULT 'NONE' NOT NULL,
  "fee_amount_paise" bigint,
  "fee_intent_id" text,
  "fee_link_url" text,
  "fee_expires_at" timestamp with time zone,
  "fee_failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_onboarding_sessions_status_check" CHECK ("status" IN ('OTP_SENT','OWNER_VERIFIED','SHOP_SUBMITTED','FEE_PENDING','FEE_PAID','PENDING_ADMIN','COMPLETED','CANCELLED')),
  CONSTRAINT "shop_onboarding_sessions_fee_status_check" CHECK ("fee_status" IN ('NONE','PENDING','PAID','FAILED','EXPIRED','WAIVED')),
  CONSTRAINT "shop_onboarding_sessions_fee_mode_check" CHECK ("fee_mode" IS NULL OR "fee_mode" IN ('LINK','CHECKOUT'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_onboarding_sessions_operator_idx" ON "shop_onboarding_sessions" ("operator_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_onboarding_sessions_shop_unique" ON "shop_onboarding_sessions" ("shop_id") WHERE "shop_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_onboarding_sessions_fee_idx" ON "shop_onboarding_sessions" ("fee_status", "fee_expires_at");
--> statement-breakpoint

-- F9.1.2 — manufacturer self-upload portal.
CREATE TABLE IF NOT EXISTS "pmd_manufacturer_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "brand_names" text[] DEFAULT '{}' NOT NULL,
  "contact_email" text,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "source_key" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pmd_manufacturer_accounts_status_check" CHECK ("status" IN ('ACTIVE','SUSPENDED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_manufacturer_accounts_slug_unique" ON "pmd_manufacturer_accounts" ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_manufacturer_accounts_source_unique" ON "pmd_manufacturer_accounts" ("source_key");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pmd_manufacturer_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "pmd_manufacturer_accounts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "role" text DEFAULT 'UPLOADER' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pmd_manufacturer_members_role_check" CHECK ("role" IN ('OWNER','UPLOADER'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_manufacturer_members_unique" ON "pmd_manufacturer_members" ("account_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_manufacturer_members_user_idx" ON "pmd_manufacturer_members" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pmd_manufacturer_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "pmd_manufacturer_accounts"("id") ON DELETE CASCADE,
  "label" text,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "use_count" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_manufacturer_api_keys_hash_unique" ON "pmd_manufacturer_api_keys" ("key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_manufacturer_api_keys_account_idx" ON "pmd_manufacturer_api_keys" ("account_id");
--> statement-breakpoint

-- F9.1.4 — batched, resumable ingestion. The input is staged once into pmd_ingest_job_rows; `cursor`
-- is the last row number whose batch has committed, so an interrupted job resumes after it.
CREATE TABLE IF NOT EXISTS "pmd_ingest_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "source_key" text NOT NULL,
  "manufacturer_account_id" uuid REFERENCES "pmd_manufacturer_accounts"("id") ON DELETE SET NULL,
  "file_name" text,
  "status" text DEFAULT 'QUEUED' NOT NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "valid_rows" integer DEFAULT 0 NOT NULL,
  "invalid_rows" integer DEFAULT 0 NOT NULL,
  "cursor" integer DEFAULT 0 NOT NULL,
  "batch_size" integer DEFAULT 1000 NOT NULL,
  "processed_rows" integer DEFAULT 0 NOT NULL,
  "staged_rows" integer DEFAULT 0 NOT NULL,
  "failed_rows" integer DEFAULT 0 NOT NULL,
  "images_stored" integer DEFAULT 0 NOT NULL,
  "images_failed" integer DEFAULT 0 NOT NULL,
  "batches_done" integer DEFAULT 0 NOT NULL,
  "run_ids" bigint[] DEFAULT '{}' NOT NULL,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "report" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid,
  "created_via" text DEFAULT 'PORTAL' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pmd_ingest_jobs_status_check" CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
  CONSTRAINT "pmd_ingest_jobs_kind_check" CHECK ("kind" IN ('MANUFACTURER_UPLOAD','MANUFACTURER_API','GS1_DATAKART','OPEN_FOOD_FACTS','FEED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_ingest_jobs_status_idx" ON "pmd_ingest_jobs" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_ingest_jobs_account_idx" ON "pmd_ingest_jobs" ("manufacturer_account_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pmd_ingest_job_rows" (
  "job_id" uuid NOT NULL REFERENCES "pmd_ingest_jobs"("id") ON DELETE CASCADE,
  "row_number" integer NOT NULL,
  "source_product_id" text,
  "gtin14" text,
  "payload" jsonb,
  "raw" jsonb,
  "status" text DEFAULT 'VALID' NOT NULL,
  "error_code" text,
  "error_message" text,
  CONSTRAINT "pmd_ingest_job_rows_pk" PRIMARY KEY ("job_id", "row_number"),
  CONSTRAINT "pmd_ingest_job_rows_status_check" CHECK ("status" IN ('VALID','INVALID','DUPLICATE','STAGED','FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_ingest_job_rows_status_idx" ON "pmd_ingest_job_rows" ("job_id", "status");
--> statement-breakpoint

-- Object store, default adapter: bytes in this table (or MEDIA_DIR on disk, as the blob store does).
CREATE TABLE IF NOT EXISTS "pmd_object_blobs" (
  "key" text PRIMARY KEY NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage" text DEFAULT 'DB' NOT NULL,
  "storage_key" text,
  "data" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pmd_object_blobs_bytes_present" CHECK (("storage" = 'DB' AND "data" IS NOT NULL) OR ("storage" = 'DISK' AND "storage_key" IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pmd_image_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gtin14" text,
  "source_product_id" text,
  "source_key" text,
  "source_url" text NOT NULL,
  "object_store" text,
  "object_key" text,
  "width" integer,
  "height" integer,
  "size_bytes" integer,
  "status" text NOT NULL,
  "error" text,
  "job_id" uuid REFERENCES "pmd_ingest_jobs"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pmd_image_assets_status_check" CHECK ("status" IN ('STORED','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_image_assets_unique" ON "pmd_image_assets" ("source_key", "source_product_id", "source_url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_image_assets_gtin_idx" ON "pmd_image_assets" ("gtin14");
--> statement-breakpoint

-- Licence attribution carried by each imported record (Open Food Facts: ODbL 1.0, images CC BY-SA).
CREATE TABLE IF NOT EXISTS "pmd_record_attributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL,
  "source_product_id" text NOT NULL,
  "gtin14" text,
  "attribution" text NOT NULL,
  "licence_name" text,
  "licence_url" text,
  "record_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pmd_record_attributions_unique" ON "pmd_record_attributions" ("source_key", "source_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pmd_record_attributions_gtin_idx" ON "pmd_record_attributions" ("gtin14");
