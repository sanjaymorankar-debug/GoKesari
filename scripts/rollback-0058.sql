-- Reverses drizzle/0058_event_layer.sql (event layer). Deploy the previous
-- build and restore the old crontab first (docs/event-driven-2026-10/ROLLBACK.md).
-- Back up first: this drops the event log and every dispute comment and
-- attachment link. Dispute photos stay in stored_images; to erase them as
-- well, run the DELETE below too.
-- Afterwards delete the 0058 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS dispute_attachments;
DROP TABLE IF EXISTS dispute_comments;
DROP TABLE IF EXISTS domain_events;
ALTER TABLE order_disputes DROP COLUMN IF EXISTS awaiting_response_since;
ALTER TABLE order_disputes DROP COLUMN IF EXISTS last_response_at;
ALTER TABLE orders DROP COLUMN IF EXISTS accept_escalated_at;
ALTER TABLE rider_searches DROP COLUMN IF EXISTS support_alerted_at;
-- Optional, erases the dispute photos:
-- DELETE FROM stored_images WHERE purpose = 'DISPUTE_EVIDENCE';
COMMIT;
