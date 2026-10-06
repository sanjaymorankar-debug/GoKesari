-- 0055 NEW-007: order completion.
--   * Shop acceptance timeout: orders.accept_by_at / accept_reminder_sent_at,
--     and shop_sla_events (reminders sent, orders missed) for the miss rate.
--   * Photo proof of delivery: delivery_proofs links a delivery to the
--     rider's photo in stored_images (purpose DELIVERY_PROOF, private).
--   * Tax invoice per delivered order: tax_invoices (immutable snapshot) and
--     invoice_counters (gapless number per shop per financial year).
-- All additive; each behaviour is switched by its own rule (shopAcceptance,
-- deliveryProof, invoicing), off by default. Rollback: scripts/rollback-0055.sql
CREATE TABLE "delivery_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_order_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"stored_image_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"shop_id" uuid NOT NULL,
	"financial_year" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_counters_shop_id_financial_year_pk" PRIMARY KEY("shop_id","financial_year")
);
--> statement-breakpoint
CREATE TABLE "shop_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"supply_type" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accept_by_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accept_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_stored_image_id_stored_images_id_fk" FOREIGN KEY ("stored_image_id") REFERENCES "public"."stored_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_sla_events" ADD CONSTRAINT "shop_sla_events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_sla_events" ADD CONSTRAINT "shop_sla_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_proofs_delivery_idx" ON "delivery_proofs" USING btree ("delivery_order_id");--> statement-breakpoint
CREATE INDEX "delivery_proofs_order_idx" ON "delivery_proofs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shop_sla_events_shop_idx" ON "shop_sla_events" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_sla_events_order_kind_unique" ON "shop_sla_events" USING btree ("order_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_order_unique" ON "tax_invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_number_unique" ON "tax_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_shop_seq_unique" ON "tax_invoices" USING btree ("shop_id","financial_year","sequence");
