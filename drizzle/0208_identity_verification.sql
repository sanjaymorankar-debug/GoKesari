-- One-time identity verification for customers and shop owners (docs/identity-verification-2026-11, 24-Nov-2026).
--
-- * identity_verifications: one row per attempt (Aadhaar by DigiLocker, or PAN). At most one VERIFIED and one
--   PENDING row per user. Only the masked id (last four), the verified name, the method, the provider reference
--   and the consent record are kept — never the Aadhaar number, OTP, e-KYC XML, photo, date of birth or address.
--   The check constraint refuses a masked id with five or more digits in a row.
-- * identity_verification_prompts: when a shop owner was first asked (start of the seller grace period).
-- * Feature flags identity_verification_customers_enabled and identity_verification_shop_owners_enabled, both
--   seeded OFF: nothing changes until an admin turns one on (Admin → Identity verification → Settings).
--
-- Additive and safe to re-run. Rollback: DROP TABLE identity_verification_prompts, identity_verifications;
-- DELETE FROM feature_flags WHERE key IN ('identity_verification_customers_enabled', 'identity_verification_shop_owners_enabled');
CREATE TABLE IF NOT EXISTS "identity_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "method" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "masked_id" text NOT NULL,
  "id_token" text,
  "provider" text NOT NULL,
  "provider_ref" text,
  "verified_name" text,
  "compared_name" text,
  "name_match_score" integer,
  "name_match_result" text,
  "error_code" text,
  "consent_at" timestamp with time zone NOT NULL,
  "consent_version" text NOT NULL,
  "consent_ip" text,
  "consent_user_agent" text,
  "session_id" text,
  "session_status" text,
  "session_url" text,
  "session_expires_at" timestamp with time zone,
  "session_return_key" text,
  "verified_at" timestamp with time zone,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "identity_verifications_subject" CHECK ("subject" IN ('CUSTOMER', 'SHOP_OWNER')),
  CONSTRAINT "identity_verifications_method" CHECK ("method" IN ('AADHAAR_DIGILOCKER', 'PAN', 'DRIVING_LICENCE', 'VOTER_ID')),
  CONSTRAINT "identity_verifications_status" CHECK ("status" IN ('PENDING', 'VERIFIED', 'NAME_MISMATCH_REVIEW', 'REJECTED', 'FAILED')),
  CONSTRAINT "identity_verifications_name_match_result" CHECK ("name_match_result" IS NULL OR "name_match_result" IN ('MATCH', 'MISMATCH', 'NO_NAME')),
  CONSTRAINT "identity_verifications_session_status" CHECK ("session_status" IS NULL OR "session_status" IN ('created', 'succeeded', 'failed', 'expired')),
  CONSTRAINT "identity_verifications_masked_id_no_number" CHECK (length(regexp_replace("masked_id", '[^0-9]', '', 'g')) <= 4)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_verifications_user_idx" ON "identity_verifications" ("user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_verifications_one_verified" ON "identity_verifications" ("user_id") WHERE "status" = 'VERIFIED';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_verifications_one_open" ON "identity_verifications" ("user_id") WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_verifications_status_idx" ON "identity_verifications" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_verifications_session_idx" ON "identity_verifications" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_verifications_return_key_unique" ON "identity_verifications" ("session_return_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_verifications_token_idx" ON "identity_verifications" ("method", "id_token");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_verification_prompts" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "first_prompted_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('identity_verification_customers_enabled', false) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('identity_verification_shop_owners_enabled', false) ON CONFLICT DO NOTHING;
