-- 0057 C5: rider identity documents (Aadhaar, PAN, driving licence, vehicle RC).
--   The image lives in stored_images (purpose RIDER_KYC_DOC, private); this
--   table links it to the rider with a review status. Only an admin can open
--   the file. Additive; switched by rule riderFiles.kycDocuments.
-- Rollback: scripts/rollback-0057.sql
CREATE TABLE "delivery_partner_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"stored_image_id" uuid NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"rejection_reason" text,
	"uploaded_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_partner_documents" ADD CONSTRAINT "delivery_partner_documents_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_documents" ADD CONSTRAINT "delivery_partner_documents_stored_image_id_stored_images_id_fk" FOREIGN KEY ("stored_image_id") REFERENCES "public"."stored_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_documents" ADD CONSTRAINT "delivery_partner_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_documents" ADD CONSTRAINT "delivery_partner_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_partner_documents_partner_idx" ON "delivery_partner_documents" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE INDEX "delivery_partner_documents_image_idx" ON "delivery_partner_documents" USING btree ("stored_image_id");