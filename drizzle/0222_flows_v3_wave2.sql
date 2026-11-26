-- Flow spec v3, wave 2 (docs/flows-v3/wave2.md). Flags flow_f2, flow_f20, flow_f3, flow_f19, flow_f16, flow_f13.
--
-- * order_cancel_requests: a customer asks the shop to cancel a packed order; the shop agrees or declines
--   (flag flow_f16). One PENDING request per order: partial unique index.
-- * order_disputes.return_request_id: the declined return a dispute was opened from (flag flow_f16). Nullable.
-- * Flags: ON on the staging database (gokesari_test), OFF everywhere else.
--
-- Additive and safe to re-run: new table, nullable column, new indexes. Nothing is dropped, renamed or deleted.
CREATE TABLE IF NOT EXISTS "order_cancel_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text,
  -- PENDING | ACCEPTED | DECLINED | WITHDRAWN | CLOSED
  "status" text NOT NULL DEFAULT 'PENDING',
  "decided_by" uuid,
  "decided_at" timestamptz,
  "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_cancel_requests_pending_uq" ON "order_cancel_requests" ("order_id") WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_cancel_requests_order_idx" ON "order_cancel_requests" ("order_id");
--> statement-breakpoint
ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "return_request_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_disputes_return_request_idx" ON "order_disputes" ("return_request_id") WHERE "return_request_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled")
VALUES
  ('flow_f2', current_database() = 'gokesari_test'),
  ('flow_f20', current_database() = 'gokesari_test'),
  ('flow_f3', current_database() = 'gokesari_test'),
  ('flow_f19', current_database() = 'gokesari_test'),
  ('flow_f16', current_database() = 'gokesari_test'),
  ('flow_f13', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
