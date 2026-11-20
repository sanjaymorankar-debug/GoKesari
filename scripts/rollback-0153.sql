-- Rollback for drizzle/0153_health.sql (GoKesari Health). Run by hand, then delete the journal row
-- (drizzle.__drizzle_migrations) for 0153. Clinical records are retained for at least 3 years by law:
-- take a full backup of schema health before running this.
BEGIN;
DROP SCHEMA IF EXISTS health CASCADE;
DELETE FROM consult_categories c
 WHERE c.slug IN ('home-nurse', 'massage-therapist', 'caretaker-attendant', 'baby-care-japa', 'home-sample-collection')
   AND NOT EXISTS (SELECT 1 FROM consult_member_categories mc WHERE mc.category_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM consult_bookings b WHERE b.category_id = c.id);
ALTER TABLE consult_services DROP CONSTRAINT IF EXISTS consult_services_duration;
ALTER TABLE consult_services ADD CONSTRAINT consult_services_duration CHECK (duration_minutes BETWEEN 5 AND 720); -- narrow to 600 by hand only if no longer services exist
-- payment_intents_purpose_check keeps the HEALTH_* values: removing them would fail while any such intent exists.
COMMIT;
