-- Owner request, 21-Nov-2026: an admin may approve a food shop without its FSSAI licence, with a
-- written reason. The owner then has rule documentUpload.fssaiWaiverDays (30) to upload it; the
-- 1st / 15th follow-up reminds them and suspends the shop if it is still missing after due_at
-- (src/server/services/fssai-waiver.ts).
-- Kept apart from shop_document_waivers on purpose: a row there makes shop_kyc_complete() true and
-- lifts the "documents later" payout hold; an FSSAI waiver must do neither.
-- waived_by is a platform user: no foreign key (seller and customer tables have none between them).
-- Additive only. Rollback: DROP TABLE IF EXISTS "shop_fssai_waivers";
CREATE TABLE IF NOT EXISTS "shop_fssai_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"reason" text NOT NULL,
	"waived_by" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_fssai_waivers_shop_idx" ON "shop_fssai_waivers" USING btree ("shop_id", "created_at");
