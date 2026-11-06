-- Onboarding Phase 2 (docs/onboarding-benchmark/phase-2, WP4): notices due at a later time. A row is
-- written (and moved on) by the user's own action — e.g. each saved registration step sets its
-- reminder 24 h ahead — and the existing every-minute notification job sends it when due.
-- No foreign keys: payload ids are checked when the notice is sent.
CREATE TABLE IF NOT EXISTS "scheduled_notices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "stage" integer NOT NULL DEFAULT 1,
  "due_at" timestamp with time zone NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sent_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_notices_key_unique" ON "scheduled_notices" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_notices_due_idx" ON "scheduled_notices" ("due_at") WHERE "sent_at" IS NULL AND "cancelled_at" IS NULL;
