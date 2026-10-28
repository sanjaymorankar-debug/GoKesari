-- split: seller
-- Owner request, 26 Oct 2026 (Add my shop):
--   * shops.annual_turnover_rupees — the annual turnover the owner declares; the
--     one-time registration fee is set from it (rule registrationFeeByTurnover).
--     Null for every shop registered before.
--   * shop_categories.group_name — the heading a category is listed under in the
--     picker. Null (every existing category) shows under "Shops and stores".
--   * Professional and office categories (CA, advocate, doctor specialities,
--     consultants), ACTIVE and editable in Admin → Shop categories. Added only
--     where no category of the same name or slug exists, so a rerun or an admin's
--     own category is never duplicated.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "annual_turnover_rupees" bigint;--> statement-breakpoint
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_annual_turnover_rupees_check";--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_annual_turnover_rupees_check" CHECK ("annual_turnover_rupees" IS NULL OR "annual_turnover_rupees" >= 0);--> statement-breakpoint
ALTER TABLE "shop_categories" ADD COLUMN IF NOT EXISTS "group_name" text;--> statement-breakpoint
INSERT INTO "shop_categories" ("name", "slug", "group_name")
SELECT v.name, v.slug, v.group_name
FROM (VALUES
  ('Chartered Accountant (CA)', 'chartered-accountant', 'Finance and legal'),
  ('Company Secretary (CS)', 'company-secretary', 'Finance and legal'),
  ('Cost Accountant (CMA)', 'cost-accountant', 'Finance and legal'),
  ('Tax / GST Consultant', 'tax-gst-consultant', 'Finance and legal'),
  ('Auditor', 'auditor', 'Finance and legal'),
  ('Advocate / Lawyer', 'advocate-lawyer', 'Finance and legal'),
  ('Notary', 'notary', 'Finance and legal'),
  ('General Physician', 'general-physician', 'Medical — doctors and clinics'),
  ('Dentist', 'dentist', 'Medical — doctors and clinics'),
  ('Paediatrician', 'paediatrician', 'Medical — doctors and clinics'),
  ('Gynaecologist', 'gynaecologist', 'Medical — doctors and clinics'),
  ('Orthopaedic', 'orthopaedic', 'Medical — doctors and clinics'),
  ('Dermatologist', 'dermatologist', 'Medical — doctors and clinics'),
  ('ENT Specialist', 'ent-specialist', 'Medical — doctors and clinics'),
  ('Ophthalmologist / Eye Specialist', 'ophthalmologist', 'Medical — doctors and clinics'),
  ('Cardiologist', 'cardiologist', 'Medical — doctors and clinics'),
  ('Neurologist', 'neurologist', 'Medical — doctors and clinics'),
  ('Psychiatrist / Psychologist', 'psychiatrist-psychologist', 'Medical — doctors and clinics'),
  ('Physiotherapist', 'physiotherapist', 'Medical — doctors and clinics'),
  ('Homeopath', 'homeopath', 'Medical — doctors and clinics'),
  ('Ayurveda', 'ayurveda', 'Medical — doctors and clinics'),
  ('Veterinarian', 'veterinarian', 'Medical — doctors and clinics'),
  ('Diagnostic Lab / Pathology', 'diagnostic-lab-pathology', 'Medical — doctors and clinics'),
  ('Management Consultant', 'management-consultant', 'Consulting and services'),
  ('IT / Software Consultant', 'it-software-consultant', 'Consulting and services'),
  ('HR / Recruitment', 'hr-recruitment', 'Consulting and services'),
  ('Education / Coaching', 'education-coaching', 'Consulting and services'),
  ('Architect', 'architect', 'Consulting and services'),
  ('Civil / Structural Engineer', 'civil-structural-engineer', 'Consulting and services'),
  ('Interior Designer', 'interior-designer', 'Consulting and services'),
  ('Real Estate Consultant', 'real-estate-consultant', 'Consulting and services'),
  ('Insurance Agent', 'insurance-agent', 'Consulting and services'),
  ('Financial Advisor / MF Distributor', 'financial-advisor', 'Consulting and services'),
  ('Other Consulting Services', 'other-consulting-services', 'Consulting and services')
) AS v(name, slug, group_name)
WHERE NOT EXISTS (
  SELECT 1 FROM "shop_categories" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name)
);--> statement-breakpoint
UPDATE "shop_categories" SET "group_name" = 'Medical — doctors and clinics'
WHERE "group_name" IS NULL AND lower("name") = 'doctor / clinic';
