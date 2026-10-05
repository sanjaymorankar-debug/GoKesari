-- 0046 Parent orders (F6): one reference (GK-…) for a multi-shop checkout. New table
-- + nullable column; existing orders keep NULL. Rollback: scripts/rollback-0046.sql
CREATE TABLE "order_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_group_id" uuid;--> statement-breakpoint
ALTER TABLE "order_groups" ADD CONSTRAINT "order_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_groups_reference_uq" ON "order_groups" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "order_groups_request_uq" ON "order_groups" USING btree ("user_id","request_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_group_id_order_groups_id_fk" FOREIGN KEY ("order_group_id") REFERENCES "public"."order_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_order_group_idx" ON "orders" USING btree ("order_group_id");