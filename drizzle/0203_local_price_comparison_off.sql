-- docs/price-comparison-off-2026-11 (owner decision 24-Nov-2026): price comparison between local
-- shops is switched off. A missing row already reads as OFF; the row is written so the database
-- itself shows the value on both sites (Admin → Feature flags). A site where an admin already
-- set the flag keeps its value.
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('local_price_comparison_enabled', false) ON CONFLICT DO NOTHING;
