-- Rollback of 0161_health_specialties.sql (run by hand, only if the Health groups must be undone).
-- Puts the built-in medical rows back under their old group names and retires the specialties the
-- migration added that nobody uses yet. Rows with shops, doctors or bookings on them are left ACTIVE.
BEGIN;

UPDATE "shop_categories" SET "group_name" = 'Medical — doctors and clinics', "updated_at" = now()
WHERE "group_name" LIKE 'Health — %';

UPDATE "consult_categories" SET "group_name" = 'Doctors and clinics', "updated_at" = now()
WHERE "group_name" LIKE 'Health — %';

UPDATE "shop_categories" c SET "status" = 'INACTIVE', "updated_at" = now()
WHERE c."slug" IN ('diabetologist-endocrinologist', 'gastroenterologist', 'pulmonologist', 'nephrologist', 'urologist', 'oncologist',
                   'general-surgeon', 'orthodontist', 'speech-therapist', 'dietitian-nutritionist', 'unani', 'siddha', 'naturopathy', 'scan-centre')
  AND NOT EXISTS (SELECT 1 FROM "shop_category_mapping" a WHERE a."category_id" = c."id");

UPDATE "consult_categories" c SET "status" = 'INACTIVE', "updated_at" = now()
WHERE c."slug" IN ('cardiologist', 'neurologist', 'diabetologist-endocrinologist', 'gastroenterologist', 'pulmonologist', 'nephrologist',
                   'urologist', 'oncologist', 'general-surgeon', 'orthodontist', 'psychiatrist', 'speech-therapist', 'dietitian-nutritionist',
                   'unani', 'siddha', 'naturopathy', 'diagnostic-lab-pathology', 'scan-centre')
  AND NOT EXISTS (SELECT 1 FROM "consult_member_categories" mc WHERE mc."category_id" = c."id");

COMMIT;
