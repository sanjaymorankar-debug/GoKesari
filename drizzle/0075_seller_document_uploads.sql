-- 0075 Shop document upload with auto-read (docs/document-upload-2026-10).
--   seller_document_uploads: one row per photo / file a shop owner uploads on
--   the "Upload your documents" screen — the encrypted file, what the reader
--   (OCR) pulled out of it, the flags shown to the owner (expired, name
--   mismatch, unreadable…), and, once the owner confirms, the fields they
--   submitted and the verification / legal-document row it went to.
-- Numbers, names and addresses read off a document are personal data: they
-- are stored only encrypted (extracted_encrypted / confirmed_encrypted, the
-- same AES-GCM key as PANs). flags hold no document content.
-- Owned by the SELLER database in the seller/customer split (docs/db-split-2026-10).
-- Additive only: no existing table or column changes.
-- Rollback: scripts/rollback-0075.sql
CREATE TABLE "seller_document_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"status" text DEFAULT 'EXTRACTED' NOT NULL,
	"source" text DEFAULT 'FILE' NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data_encrypted" bytea,
	"reader_engine" text NOT NULL,
	"reader_confidence" integer,
	"extracted_encrypted" text,
	"detected_type" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"confirmed_encrypted" text,
	"number_last4" text,
	"valid_until" date,
	"fields_corrected" text[] DEFAULT '{}'::text[] NOT NULL,
	"verification_id" uuid,
	"legal_document_id" uuid,
	"uploaded_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_document_uploads_doc_type" CHECK ("seller_document_uploads"."doc_type" in ('PAN', 'GSTIN', 'UDYAM', 'FSSAI', 'SHOP_ACT', 'DRUG_LICENCE', 'MEDICAL_REGISTRATION')),
	CONSTRAINT "seller_document_uploads_status" CHECK ("seller_document_uploads"."status" in ('EXTRACTED', 'CONFIRMED', 'DISCARDED')),
	CONSTRAINT "seller_document_uploads_source" CHECK ("seller_document_uploads"."source" in ('FILE', 'CAMERA')),
	CONSTRAINT "seller_document_uploads_size" CHECK ("seller_document_uploads"."size_bytes" > 0 AND "seller_document_uploads"."size_bytes" <= 10000000),
	CONSTRAINT "seller_document_uploads_confidence" CHECK ("seller_document_uploads"."reader_confidence" IS NULL OR "seller_document_uploads"."reader_confidence" BETWEEN 0 AND 100),
	CONSTRAINT "seller_document_uploads_confirmed_has_fields" CHECK ("seller_document_uploads"."status" <> 'CONFIRMED' OR ("seller_document_uploads"."confirmed_encrypted" IS NOT NULL AND "seller_document_uploads"."confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."seller_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_legal_document_id_fk" FOREIGN KEY ("legal_document_id") REFERENCES "public"."shop_legal_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_document_uploads_shop_idx" ON "seller_document_uploads" USING btree ("shop_id","doc_type","created_at");--> statement-breakpoint
CREATE INDEX "seller_document_uploads_status_idx" ON "seller_document_uploads" USING btree ("status","created_at");
