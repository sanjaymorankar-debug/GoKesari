-- Flow spec v3, wave 1 (docs/flows-v3/wave1.md). Flags flow_f1, flow_f14, flow_f17.
--
-- * support_routing_rules: who gets a new help-desk ticket automatically (flag flow_f17) — by ticket category and,
--   optionally, the district (geo_areas code) of the ticket's shop. Admin-editable. No rule = the manual queue.
-- * support_tickets.source / source_ref: a ticket opened by the system for an event elsewhere (GST/PAN check,
--   identity review, document check, payment reconciliation, dispute, delivery-code lock, society application,
--   account recovery). One ticket per (source, source_ref): partial unique index.
-- * support_tickets.cc_dealer_user_id: the area dealer copied on a shop's ticket (read-only access).
-- * Flags: ON on the staging database (gokesari_test), OFF everywhere else.
--
-- Additive and safe to re-run: new table, nullable columns, new indexes. Nothing is dropped, renamed or deleted.
CREATE TABLE IF NOT EXISTS "support_routing_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category" text NOT NULL,
  -- geo_areas district code (e.g. MH-PUN) or a state code; NULL = every area.
  "district_code" text,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "active" boolean NOT NULL DEFAULT true,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_routing_rules_unique" ON "support_routing_rules" ("category", COALESCE("district_code", ''), "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_routing_rules_category_idx" ON "support_routing_rules" ("category") WHERE "active";
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "cc_dealer_user_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_source_ref_unique" ON "support_tickets" ("source", "source_ref") WHERE "source" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_cc_dealer_idx" ON "support_tickets" ("cc_dealer_user_id") WHERE "cc_dealer_user_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled")
VALUES
  ('flow_f1', current_database() = 'gokesari_test'),
  ('flow_f14', current_database() = 'gokesari_test'),
  ('flow_f17', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
