-- Rollback for 0184_payout_transfer_ids (payouts transfer ids and parked webhooks).
-- Before running: deploy the previous release's code. Then delete the 0184 row.
DROP TABLE IF EXISTS "payout_webhook_parked";
DROP INDEX IF EXISTS "dealer_payout_batches_provider_transfer_id_unique";
DROP INDEX IF EXISTS "rider_bank_transfers_provider_transfer_id_unique";
DROP INDEX IF EXISTS "payout_items_provider_transfer_id_unique";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "sent_at";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "provider_transfer_id";
ALTER TABLE "rider_bank_transfers" DROP COLUMN IF EXISTS "provider_transfer_id";
ALTER TABLE "payout_items" DROP COLUMN IF EXISTS "provider_transfer_id";
