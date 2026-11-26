-- Flow spec v3, wave 5 (docs/flows-v3/wave5.md). Flags flow_f11, flow_f15, flow_f18.
--
-- * users.sessions_valid_after (flag flow_f18): sessions signed in before this time are ended on their next request
--   ("sign out on all devices" after an account recovery). NULL = no marker, as today.
-- * societies (flag flow_f15): the authorised person's name and role, the number of flats (optional), the proof
--   document (registration certificate or committee letter: number and an uploaded or scanned image), delivery
--   hours at the gate, and requires_proof (set for societies that apply while the flag is on; verification then
--   needs the proof). Existing societies keep requires_proof = false.
-- * society_riders.suspended_until / suspended_reason / suspended_by (flag flow_f15): a society pauses a rider for a
--   while instead of removing them. NULL = not suspended, as today.
-- * Flags: ON on the staging database (gokesari_test), OFF everywhere else.
--
-- Additive and safe to re-run: nullable columns and columns with defaults only. Nothing is dropped, renamed or deleted.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamptz;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "authorised_person_name" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "authorised_person_role" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "flat_count" integer;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "proof_type" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "proof_number" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "proof_image_url" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "requires_proof" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "delivery_hours_start" text;
--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN IF NOT EXISTS "delivery_hours_end" text;
--> statement-breakpoint
ALTER TABLE "society_riders" ADD COLUMN IF NOT EXISTS "suspended_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "society_riders" ADD COLUMN IF NOT EXISTS "suspended_reason" text;
--> statement-breakpoint
ALTER TABLE "society_riders" ADD COLUMN IF NOT EXISTS "suspended_by" uuid;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled")
VALUES
  ('flow_f11', current_database() = 'gokesari_test'),
  ('flow_f15', current_database() = 'gokesari_test'),
  ('flow_f18', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
