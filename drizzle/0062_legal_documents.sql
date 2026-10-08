-- 0062 Mandatory legal documents by shop category (docs/four-features-2026-10,
-- feature 2): FSSAI licence, drug licence, medical registration — number,
-- expiry / issuing council and an uploaded copy, reviewed by operations.
-- Additive only: two new tables, plus one new shop category ("Doctor / Clinic",
-- only if no category of that name or slug exists). Rollback: scripts/rollback-0062.sql.
CREATE TABLE "shop_legal_document_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data_encrypted" "bytea" NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_legal_document_files_size" CHECK ("shop_legal_document_files"."size_bytes" > 0 AND "shop_legal_document_files"."size_bytes" <= 5000000)
);
--> statement-breakpoint
CREATE TABLE "shop_legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"number_encrypted" text,
	"number_last4" text,
	"issuing_council" text,
	"expiry_date" date,
	"grace_until" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"rejection_reason" text,
	"expiry_reminder_sent_for" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_legal_document_files" ADD CONSTRAINT "shop_legal_document_files_document_id_shop_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."shop_legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_legal_document_files" ADD CONSTRAINT "shop_legal_document_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_legal_documents" ADD CONSTRAINT "shop_legal_documents_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_legal_documents" ADD CONSTRAINT "shop_legal_documents_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_legal_documents" ADD CONSTRAINT "shop_legal_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_legal_document_files_document_idx" ON "shop_legal_document_files" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_legal_documents_shop_type_uq" ON "shop_legal_documents" USING btree ("shop_id","doc_type");--> statement-breakpoint
CREATE INDEX "shop_legal_documents_status_idx" ON "shop_legal_documents" USING btree ("status","submitted_at");--> statement-breakpoint
INSERT INTO "shop_categories" ("name", "slug", "description")
VALUES ('Doctor / Clinic', 'doctor-clinic', 'Doctors, clinics and medical practitioners (medical registration required)')
ON CONFLICT DO NOTHING;