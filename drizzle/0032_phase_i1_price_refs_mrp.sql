CREATE TABLE "external_price_reference_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_id" uuid NOT NULL,
	"action" text NOT NULL,
	"previous" jsonb,
	"next" jsonb NOT NULL,
	"note" text,
	"actor_id" uuid,
	"actor_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_price_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"price_paise" bigint NOT NULL,
	"unit_basis" text,
	"source_type" text NOT NULL,
	"source_name" text NOT NULL,
	"source_identifier" text,
	"reference_url" text,
	"market_location" text,
	"pincode" text,
	"referenced_at" timestamp with time zone NOT NULL,
	"verification_status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_price_refs_price_positive" CHECK ("external_price_references"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "mrp_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"shop_id" uuid,
	"claimed_mrp_paise" bigint NOT NULL,
	"note" text,
	"submitted_by" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"previous_verification_status" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_mrp_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mrp_corrections_claim_non_negative" CHECK ("mrp_corrections"."claimed_mrp_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "external_price_reference_history" ADD CONSTRAINT "external_price_reference_history_reference_id_external_price_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."external_price_references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_price_reference_history" ADD CONSTRAINT "external_price_reference_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_price_references" ADD CONSTRAINT "external_price_references_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_price_references" ADD CONSTRAINT "external_price_references_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_price_references" ADD CONSTRAINT "external_price_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mrp_corrections" ADD CONSTRAINT "mrp_corrections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mrp_corrections" ADD CONSTRAINT "mrp_corrections_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mrp_corrections" ADD CONSTRAINT "mrp_corrections_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mrp_corrections" ADD CONSTRAINT "mrp_corrections_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_price_ref_history_idx" ON "external_price_reference_history" USING btree ("reference_id","created_at");--> statement-breakpoint
CREATE INDEX "external_price_refs_product_idx" ON "external_price_references" USING btree ("product_id","referenced_at");--> statement-breakpoint
CREATE INDEX "mrp_corrections_status_idx" ON "mrp_corrections" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "mrp_corrections_product_idx" ON "mrp_corrections" USING btree ("product_id");