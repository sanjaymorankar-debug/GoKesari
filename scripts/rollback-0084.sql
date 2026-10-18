-- Rollback for 0084_batch_f_notifications (WS-F push tokens, broadcasts (F13.1.2, F3.3.2)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0084 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Registered devices and broadcast history are lost; notifications already delivered stay in the inbox.
BEGIN;
DROP TABLE IF EXISTS "broadcast_recipients" CASCADE;
DROP TABLE IF EXISTS "broadcasts" CASCADE;
DROP TABLE IF EXISTS "push_tickets" CASCADE;
DROP TABLE IF EXISTS "push_tokens" CASCADE;
COMMIT;
