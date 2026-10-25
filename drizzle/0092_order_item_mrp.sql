-- split: core
-- D-91 (owner, 25 Oct 2026): an order line keeps the MRP its product had when it was sold
-- (products.mrp_paise; NULL when the product has none, e.g. loose goods), and a substitute keeps its own.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "mrp_paise" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "substitute_mrp_paise" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_mrp_non_negative" CHECK (("mrp_paise" IS NULL OR "mrp_paise" >= 0) AND ("substitute_mrp_paise" IS NULL OR "substitute_mrp_paise" >= 0));
