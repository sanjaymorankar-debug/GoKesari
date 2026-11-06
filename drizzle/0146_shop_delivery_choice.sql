-- Onboarding Phase 2 (docs/onboarding-benchmark/phase-2, WP3): the owner's answer to "How you deliver".
-- Null until asked; own staff and GoKesari partners keep delivery_available on, pickup only turns it off.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "delivery_choice" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shops" ADD CONSTRAINT "shops_delivery_choice_check"
    CHECK ("delivery_choice" IS NULL OR "delivery_choice" IN ('OWN_STAFF', 'GOKESARI_PARTNER', 'PICKUP_ONLY'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
