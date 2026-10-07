-- 0041 Seller verification: uploaded certificates (Shop Act / Form G receipts
-- where no vendor can check the number). Bytes are encrypted by the app.
-- Additive only. Rollback: DROP TABLE "seller_verification_files";
CREATE TABLE "seller_verification_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data_encrypted" "bytea" NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_verification_files_size" CHECK ("seller_verification_files"."size_bytes" > 0 AND "seller_verification_files"."size_bytes" <= 5000000)
);
--> statement-breakpoint
ALTER TABLE "seller_verification_files" ADD CONSTRAINT "seller_verification_files_verification_id_seller_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."seller_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verification_files" ADD CONSTRAINT "seller_verification_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_verification_files_verification_idx" ON "seller_verification_files" USING btree ("verification_id","created_at");--> statement-breakpoint
CREATE INDEX "seller_verification_files_sha_idx" ON "seller_verification_files" USING btree ("sha256");