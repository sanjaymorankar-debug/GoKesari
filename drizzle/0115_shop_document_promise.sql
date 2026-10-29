-- split: seller
-- Owner decision, 29 Oct 2026 (docs/shop-documents-2026-10):
--   1. The registration fee is paid only once the shop's documents are verified (at least
--      one). An owner who can't provide the rest ticks "I will provide all relevant documents
--      within 30 days": shops.documents_promised_at / documents_due_at. Such a shop is not
--      approved automatically; an admin or operator inspects and approves it.
--   2. On the 1st and 15th of each month every live shop still missing a mandatory document
--      gets a reminder (shop_document_reminders); after the 3rd, the shop is suspended.
-- All seller-side; the reminder table's foreign key stays inside the seller database.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0115.sql
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "documents_promised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "documents_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "has_shop_act" boolean;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "documents_promised_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_document_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"sent_on" date NOT NULL,
	"reminder_no" integer NOT NULL,
	"missing_doc_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_document_reminders_no_positive" CHECK ("reminder_no" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_document_reminders_shop_day_uq" ON "shop_document_reminders" USING btree ("shop_id","sent_on");
