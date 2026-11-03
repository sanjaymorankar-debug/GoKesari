-- split: seller
-- Gap report of 02-Nov-2026 (docs/referrals-dealer-2026-11/GAP_REPORT.md, A8 and A9):
-- 1. dealer_team_mapping_history: every place a team member has held (role, level, lead, from / to),
--    so TIERED commission follows the place the signer held on the shop's REGISTRATION date and an
--    admin can see who moved when and why. Existing members get one open row from their creation.
-- 2. dealer_agreement_acceptances: every acceptance of the agent agreement (version, text hash, time,
--    IP, device) — the row on the member / dealer keeps only the latest.
-- Safe to rerun. Rollback: scripts/rollback-0138.sql.
CREATE TABLE IF NOT EXISTS "dealer_team_mapping_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"member_id" uuid NOT NULL REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"team_role" text NOT NULL,
	"depth" smallint NOT NULL,
	"parent_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_team_mapping_history_window" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_team_mapping_history_member_idx" ON "dealer_team_mapping_history" ("member_id", "valid_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_team_mapping_history_dealer_idx" ON "dealer_team_mapping_history" ("dealer_id", "valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_team_mapping_history_open_unique" ON "dealer_team_mapping_history" ("member_id") WHERE "valid_to" IS NULL;--> statement-breakpoint
INSERT INTO "dealer_team_mapping_history" ("dealer_id", "member_id", "team_role", "depth", "parent_id", "valid_from", "reason")
SELECT s."dealer_id", s."id", s."team_role", s."depth", s."parent_id", s."created_at", 'existing member (0138)'
  FROM "dealer_salespeople" s
 WHERE NOT EXISTS (SELECT 1 FROM "dealer_team_mapping_history" h WHERE h."member_id" = s."id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"text_sha256" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_agreement_acceptances_payee_idx" ON "dealer_agreement_acceptances" ("dealer_id", "member_id", "accepted_at");
