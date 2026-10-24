-- split: core
-- Purchase lists (docs/purchase-lists-2026-10): a customer's own named weekly / monthly
-- lists of things they buy again and again — a shopping list or a medicines list.
--   purchase_lists       the list: name, kind (SHOPPING / MEDICINE), frequency (WEEKLY / MONTHLY), reminder
--   purchase_list_items  a shop's product on the list and how many (0–99; 0 = skip this time), with an optional note
-- Customer tables (core database, next to carts). purchase_list_items.shop_product_id points at
-- the seller database, so it has no foreign key: the service checks it before writing.
-- Additive only: nothing existing is changed.
CREATE TABLE IF NOT EXISTS "purchase_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"kind" text DEFAULT 'SHOPPING' NOT NULL,
	"frequency" text DEFAULT 'MONTHLY' NOT NULL,
	"remind" boolean DEFAULT true NOT NULL,
	"last_ordered_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_lists_name_length" CHECK (char_length("name") BETWEEN 1 AND 60),
	CONSTRAINT "purchase_lists_kind_valid" CHECK ("kind" IN ('SHOPPING','MEDICINE')),
	CONSTRAINT "purchase_lists_frequency_valid" CHECK ("frequency" IN ('WEEKLY','MONTHLY'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_lists_user_name_unique" ON "purchase_lists" USING btree ("user_id", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_lists_user_idx" ON "purchase_lists" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL REFERENCES "purchase_lists"("id") ON DELETE cascade,
	"shop_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_list_items_quantity_range" CHECK ("quantity" BETWEEN 0 AND 99),
	CONSTRAINT "purchase_list_items_note_length" CHECK ("note" IS NULL OR char_length("note") <= 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_list_items_list_product_unique" ON "purchase_list_items" USING btree ("list_id","shop_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_list_items_list_idx" ON "purchase_list_items" USING btree ("list_id");
