-- Rollback for 0180_dealer_custom_fields (Dealer platform phase 5; docs/dealer-platform/).
-- Before running: deploy the previous release's code; custom answers and files are lost. Then delete the 0180 row.
DROP TABLE IF EXISTS "dealer_custom_files";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "custom_values";
