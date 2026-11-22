-- Rollback of drizzle/0167_smart_shopping.sql. Drops only the new tables (their data is lost).
DROP TABLE IF EXISTS "smart_wishlist_items";
DROP TABLE IF EXISTS "smart_wishlists";
DROP TABLE IF EXISTS "shopping_list_scan_pages";
DROP TABLE IF EXISTS "shopping_list_scans";
DROP TABLE IF EXISTS "ai_usage_log";
