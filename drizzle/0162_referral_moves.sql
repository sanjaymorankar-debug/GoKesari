-- Referral moves (owner, 22-Nov-2026; src/server/dealers/referral-moves.ts): an admin asks to add / move a shop's
-- referral code, or to move a team member with his code and his shops to another dealer's (franchise) team, with
-- signed consent letters; a different admin approves. Commission earned before the move stays where it was earned;
-- one-time not yet earned and all recurring from the move go to the new team.
CREATE TABLE IF NOT EXISTS "referral_move_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL CHECK ("kind" in ('SHOPS', 'MEMBER')),
	"shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE restrict,
	"from_dealers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"from_dealer_id" uuid REFERENCES "dealers"("id") ON DELETE restrict,
	"to_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"to_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE restrict,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL CHECK ("status" in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
	"requested_by" uuid NOT NULL REFERENCES "users"("id"),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid REFERENCES "users"("id"),
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"result" jsonb,
	CONSTRAINT "referral_move_requests_decider" CHECK ("decided_by" is null or "decided_by" <> "requested_by")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_move_requests_status_idx" ON "referral_move_requests" ("status", "requested_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_move_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "referral_move_requests"("id") ON DELETE cascade,
	"kind" text NOT NULL CHECK ("kind" in ('SHOP_OWNER_CONSENT', 'FROM_DEALER_CONSENT', 'TO_DEALER_CONSENT', 'MEMBER_CONSENT', 'OTHER')),
	"shop_id" uuid,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" bytea NOT NULL,
	"uploaded_by" uuid NOT NULL REFERENCES "users"("id"),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_move_documents_request_idx" ON "referral_move_documents" ("request_id");
--> statement-breakpoint
ALTER TABLE "shop_attributions" ADD COLUMN IF NOT EXISTS "placement_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "franchise_shop_attributions" ADD COLUMN IF NOT EXISTS "attached_from" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_shop_team_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"zone_id" text NOT NULL,
	"allocation_id" uuid NOT NULL,
	"owner_dealer_id" uuid NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_shop_team_periods_zone_idx" ON "franchise_shop_team_periods" ("zone_id", "shop_id");
