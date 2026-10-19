-- split: seller
-- Homepage UI/UX upgrade (docs/homepage-uiux-2026-10): the header search's suggestions
-- (GET /api/search/suggest) match product and shop names with ILIKE '%…%'. Trigram
-- indexes let PostgreSQL answer those without reading every row. pg_trgm is already
-- installed by 0015 (product master); IF NOT EXISTS keeps this safe on either layout.
-- Index-only: no table or row changes.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shops_name_trgm_idx" ON "shops" USING gin ("name" gin_trgm_ops);
