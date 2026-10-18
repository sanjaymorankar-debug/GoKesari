-- Rollback for 0081_batch_c_aftercare (WS-C after-packing fee, refunds, help desk (F6.1.3, F6.2.3, F6.3.3)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0081 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Support tickets, refund timelines and per-shop cancellation fees are lost; wallet and finance-ledger rows they created stay. Export /admin/support first.
BEGIN;
DROP TABLE IF EXISTS "support_ticket_csat" CASCADE;
DROP TABLE IF EXISTS "support_canned_replies" CASCADE;
DROP TABLE IF EXISTS "support_ticket_events" CASCADE;
DROP TABLE IF EXISTS "support_ticket_attachments" CASCADE;
DROP TABLE IF EXISTS "support_ticket_messages" CASCADE;
DROP TABLE IF EXISTS "support_tickets" CASCADE;
DROP TABLE IF EXISTS "order_refund_events" CASCADE;
DROP TABLE IF EXISTS "order_refunds" CASCADE;
DROP TABLE IF EXISTS "order_charges" CASCADE;
DROP TABLE IF EXISTS "shop_cancellation_fee_settings" CASCADE;
DROP SEQUENCE IF EXISTS "support_ticket_seq";
COMMIT;
