-- split: both
-- Owner request, 26 Oct 2026: professional practices and offices can register on
-- Add my shop (src/lib/shop-types.ts). Both enums built from the shop-type list
-- get the new values: shop_type (shops) and department (product categories).
-- They live on both sides: the seller tables use them and the core's foreign
-- tables need the same types.
--
-- New enum values are added here but never USED in this file (a value added by
-- ALTER TYPE cannot be used in the same transaction).
ALTER TYPE "public"."shop_type" ADD VALUE IF NOT EXISTS 'PROFESSIONAL_OFFICE';--> statement-breakpoint
ALTER TYPE "public"."shop_type" ADD VALUE IF NOT EXISTS 'DOCTOR_CLINIC';--> statement-breakpoint
ALTER TYPE "public"."shop_type" ADD VALUE IF NOT EXISTS 'CONSULTING_SERVICES';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE IF NOT EXISTS 'PROFESSIONAL_OFFICE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE IF NOT EXISTS 'DOCTOR_CLINIC';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE IF NOT EXISTS 'CONSULTING_SERVICES';
