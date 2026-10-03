CREATE TYPE "public"."gst_status" AS ENUM('UNKNOWN', 'NOT_REGISTERED', 'PENDING_VERIFICATION', 'REGISTERED', 'COMPOSITION', 'VERIFICATION_FAILED');--> statement-breakpoint
CREATE TYPE "public"."identity_verification_source" AS ENUM('PROVIDER_VERIFIED', 'SELF_DECLARED', 'ADMIN_VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."pan_status" AS ENUM('UNKNOWN', 'PENDING_VERIFICATION', 'VERIFIED', 'VERIFICATION_FAILED');--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_status" "gst_status" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_trade_name" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_verification_source" "identity_verification_source";--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gst_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_status" "pan_status" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_number_encrypted" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_last4" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_holder_name" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_verification_source" "identity_verification_source";--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pan_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_gst_verified_by_users_id_fk" FOREIGN KEY ("gst_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_pan_verified_by_users_id_fk" FOREIGN KEY ("pan_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;