-- 0049 Product image moderation (F10). Defaults to APPROVED, so every existing photo
-- stays live. Rollback: scripts/rollback-0049.sql
ALTER TABLE "product_images" ADD COLUMN "moderation_status" text DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_images_moderation_idx" ON "product_images" USING btree ("moderation_status","created_at");