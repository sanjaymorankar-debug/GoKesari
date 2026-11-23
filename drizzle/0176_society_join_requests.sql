-- docs/delta CF-006: riders ask to join a society's rider list; the society admin approves.
-- Additive: one new table, no change to any existing table. Rollback: scripts/rollback-0176.sql.
CREATE TABLE IF NOT EXISTS "society_join_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "society_id" uuid NOT NULL REFERENCES "societies"("id") ON DELETE CASCADE,
  "delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "message" text,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "society_join_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "society_join_requests_one_pending" ON "society_join_requests" ("society_id", "delivery_partner_id") WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "society_join_requests_society_idx" ON "society_join_requests" ("society_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "society_join_requests_partner_idx" ON "society_join_requests" ("delivery_partner_id");
