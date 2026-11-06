-- Onboarding Phase B (docs/onboarding-benchmark, B3): when each shop registration first reached each
-- wizard step. Time spent on a step = the next step's time minus this one; a registration whose last
-- step is old and still OPEN was abandoned there. Read by the admin onboarding funnel.
CREATE TABLE IF NOT EXISTS "shop_onboarding_steps" (
  "draft_id" uuid NOT NULL REFERENCES "shop_registration_drafts"("id") ON DELETE CASCADE,
  "step" text NOT NULL,
  "reached_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_onboarding_steps_pk" PRIMARY KEY ("draft_id", "step")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_onboarding_steps_reached_idx" ON "shop_onboarding_steps" ("reached_at");
