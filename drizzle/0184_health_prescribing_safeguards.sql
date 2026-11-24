-- GoKesari Health: prescribing and online-sale safeguards.
--
-- * drug_master: who reviewed a row and when (pharmacist review of the drug master), and safer column defaults
--   for rows added later (a new medicine is not sold online and not prescribed remotely until someone sets it).
-- * drug_master: Schedule X and NDPS medicines are always on the prohibited teleconsultation list and never sold
--   online; existing rows are brought in line first, then the rule is a CHECK.
-- * doctor_profiles: when staff checked the registration against the NMC / State Medical Council register.
-- Nothing here changes behaviour on its own: the switches are in the health rule (Admin → Settings).

ALTER TABLE health.drug_master ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE health.drug_master ADD COLUMN IF NOT EXISTS "reviewed_by" text;
--> statement-breakpoint
ALTER TABLE health.drug_master ADD COLUMN IF NOT EXISTS "review_note" text;
--> statement-breakpoint
ALTER TABLE health.drug_master ALTER COLUMN "tele_list" SET DEFAULT 'PROHIBITED';
--> statement-breakpoint
ALTER TABLE health.drug_master ALTER COLUMN "online_sale_allowed" SET DEFAULT false;
--> statement-breakpoint
UPDATE health.drug_master
   SET "tele_list" = 'PROHIBITED', "online_sale_allowed" = false, "updated_at" = now()
 WHERE "schedule" IN ('X', 'NDPS') AND ("tele_list" <> 'PROHIBITED' OR "online_sale_allowed");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drug_master_restricted') THEN
    ALTER TABLE health.drug_master ADD CONSTRAINT "drug_master_restricted"
      CHECK ("schedule" NOT IN ('X', 'NDPS') OR ("tele_list" = 'PROHIBITED' AND NOT "online_sale_allowed"));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE health.doctor_profiles ADD COLUMN IF NOT EXISTS "registry_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE health.doctor_profiles ADD COLUMN IF NOT EXISTS "registry_checked_by" uuid;
--> statement-breakpoint
ALTER TABLE health.doctor_profiles ADD COLUMN IF NOT EXISTS "registry_check_note" text;
