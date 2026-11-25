-- Module 6, Hindi and Marathi for inner pages (owner brief 23-Nov-2026; docs/hindi-marathi-2026-11/).
--
-- users.preferred_lang: the language a signed-in person last chose on the EN / हिं / मरा switch ('en', 'hi' or
-- 'mr'; NULL = never chosen). The gk_lang cookie still wins; this column is the fallback on a new device and the
-- language used for that person's in-app and e-mail notifications. NULL keeps today's behaviour (English).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0194.sql (drops the column; the cookie keeps working).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_lang" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_preferred_lang_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_preferred_lang_check"
      CHECK ("preferred_lang" IS NULL OR "preferred_lang" IN ('en', 'hi', 'mr'));
  END IF;
END $$;
