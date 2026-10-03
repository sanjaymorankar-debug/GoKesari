CREATE TYPE "public"."product_approval_status" AS ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."excel_row_status" ADD VALUE 'NEW_PRODUCT';--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "code" SET DEFAULT 'P' || lpad(nextval('product_code_seq')::text, 5, '0');--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "registration_number" SET DEFAULT 'BKS-' || lpad(nextval('shop_registration_seq')::text, 6, '0');--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "registration_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "excel_upload_items" ADD COLUMN "possible_duplicate_product_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "specifications" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sub_category" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "approval_status" "product_approval_status" DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "excel_upload_items" ADD CONSTRAINT "excel_upload_items_possible_duplicate_product_id_products_id_fk" FOREIGN KEY ("possible_duplicate_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_approval_status_idx" ON "products" USING btree ("approval_status");