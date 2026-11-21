-- Mailbox rotation (owner, 21-Nov-2026; src/server/email/mailbox-pool.ts).
-- Hostinger lets each mailbox send about 100 e-mails in any 24 hours. With EMAIL_POOL set, the app sends
-- from several mailboxes in turn, each up to EMAIL_POOL_DAILY_CAP (90) in a rolling 24 hours. This table
-- records each send (SENT) and each refusal by the mail server (REFUSED) per mailbox, so the count holds
-- across restarts. No recipient or message content is stored. Rows older than two days are deleted by the
-- hourly auth-housekeeping cron.
-- Additive only: nothing reads or writes it until EMAIL_POOL is set.
-- Rollback: DROP TABLE IF EXISTS "email_mailbox_sends";
CREATE TABLE IF NOT EXISTS "email_mailbox_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_mailbox_sends_outcome" CHECK ("outcome" IN ('SENT', 'REFUSED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_mailbox_sends_mailbox_created_idx" ON "email_mailbox_sends" USING btree ("mailbox", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_mailbox_sends_created_idx" ON "email_mailbox_sends" USING btree ("created_at");
