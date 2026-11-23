-- Module 4 — delivery signature, GPS at delivery / failure, fixed failed-delivery reasons
-- (owner brief 23-Nov-2026; docs/delivery-signature-navigation-2026-11/README.md).
--
-- * delivery_proofs.kind may now be SIGNATURE (the customer's signature, a PNG stored privately in
--   stored_images like the door photo); signer_name (optional) and latitude / longitude (rule
--   deliveryProof.captureGps) are new optional columns.
-- * delivery_orders: delivered_latitude / delivered_longitude / delivered_accuracy_m and
--   failed_latitude / failed_longitude (rule deliveryProof.captureGps, operations only), and
--   failure_reason_code (rule deliveryProof.failureReasons; failure_reason keeps the text).
-- * No feature-flag row: every behaviour is behind rule deliveryProof / riderNavigation fields whose
--   code defaults are off (signatureEnabled, signatureRequired, captureGps, failureReasons, multiStop).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0188.sql (delete SIGNATURE proof rows first).
ALTER TABLE "delivery_proofs" DROP CONSTRAINT IF EXISTS "delivery_proofs_kind_check";--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_kind_check" CHECK ("kind" IN ('PICKUP', 'DELIVERY', 'SIGNATURE'));--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD COLUMN IF NOT EXISTS "signer_name" text;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD COLUMN IF NOT EXISTS "latitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD COLUMN IF NOT EXISTS "longitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "failure_reason_code" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "delivered_latitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "delivered_longitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "delivered_accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "failed_latitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "failed_longitude" double precision;--> statement-breakpoint
ALTER TABLE "delivery_orders" DROP CONSTRAINT IF EXISTS "delivery_orders_failure_reason_code_check";--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_failure_reason_code_check" CHECK ("failure_reason_code" IS NULL OR "failure_reason_code" IN ('CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'REFUSED', 'PHONE_UNREACHABLE', 'OTHER'));
