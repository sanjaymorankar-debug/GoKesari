-- Rollback for 0121_gig_worker_flow (gig worker flow, 31 Oct 2026).
-- Core database. Run only after the previous release's code is live and a backup is taken, then
-- delete the 0121 row from drizzle.__drizzle_migrations. Drops the KYC checks, the police
-- verification / character certificate files and the per-society access list: export them first
-- if they are needed.
BEGIN;
DROP TABLE IF EXISTS "society_partner_access";
DROP TABLE IF EXISTS "delivery_partner_background_docs";
DROP TABLE IF EXISTS "delivery_partner_kyc_checks";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "completed_at";
ALTER TABLE "delivery_proofs" DROP CONSTRAINT IF EXISTS "delivery_proofs_kind_check";
ALTER TABLE "delivery_proofs" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "delivery_partners" DROP CONSTRAINT IF EXISTS "delivery_partners_availability_check";
ALTER TABLE "delivery_partners"
  DROP COLUMN IF EXISTS "availability",
  DROP COLUMN IF EXISTS "availability_override_at",
  DROP COLUMN IF EXISTS "availability_override_by",
  DROP COLUMN IF EXISTS "availability_override_reason",
  DROP COLUMN IF EXISTS "gender",
  DROP COLUMN IF EXISTS "address_line",
  DROP COLUMN IF EXISTS "address_city",
  DROP COLUMN IF EXISTS "address_pincode",
  DROP COLUMN IF EXISTS "emergency_contact_name",
  DROP COLUMN IF EXISTS "emergency_contact_mobile",
  DROP COLUMN IF EXISTS "emergency_contact_relation",
  DROP COLUMN IF EXISTS "registration_location_at";
DROP INDEX IF EXISTS "delivery_partners_mobile_idx";
COMMIT;
