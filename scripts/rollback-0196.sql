-- Rollback for 0196_delivery_signature_gps (Module 4 delivery signature / GPS; docs/delivery-signature-navigation-2026-11/).
-- Before running: deploy the previous release's code. Signatures, GPS points and reason codes are lost
-- (failure_reason keeps the text). Then delete the 0196 row from drizzle.__drizzle_migrations.
DELETE FROM "delivery_proofs" WHERE "kind" = 'SIGNATURE';
ALTER TABLE "delivery_proofs" DROP CONSTRAINT IF EXISTS "delivery_proofs_kind_check";
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_kind_check" CHECK ("kind" IN ('PICKUP', 'DELIVERY'));
ALTER TABLE "delivery_proofs" DROP COLUMN IF EXISTS "signer_name";
ALTER TABLE "delivery_proofs" DROP COLUMN IF EXISTS "latitude";
ALTER TABLE "delivery_proofs" DROP COLUMN IF EXISTS "longitude";
ALTER TABLE "delivery_orders" DROP CONSTRAINT IF EXISTS "delivery_orders_failure_reason_code_check";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "failure_reason_code";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "delivered_latitude";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "delivered_longitude";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "delivered_accuracy_m";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "failed_latitude";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "failed_longitude";
