-- GoKesari's books (docs/tax-register/BOOKS.md). Flag auto_journals (OFF): each payout that is paid
-- (shop payout item, weekly shop settlement, rider payout or transfer, dealer / team commission,
-- referral commission) queues a balanced posting — payables, bank, commission income, TCS / TDS
-- payable by section, GST output on fees, s.9(5) GST. The Accountant turns it into a journal entry
-- draft (the CA approves it) or dismisses it. Additive only. Rollback: scripts/rollback-0188.sql
CREATE TABLE IF NOT EXISTS "fin_auto_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"narration" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"journal_entry_id" uuid,
	"dismissed_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fin_auto_postings_status_check" CHECK ("status" IN ('PENDING', 'DRAFTED', 'DISMISSED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fin_auto_postings_source_unique" ON "fin_auto_postings" ("source_type", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_auto_postings_status_idx" ON "fin_auto_postings" ("status", "entry_date");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('auto_journals', false) ON CONFLICT ("key") DO NOTHING;
