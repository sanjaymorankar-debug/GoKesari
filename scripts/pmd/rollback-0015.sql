-- ============================================================================
-- Rollback of migration 0015 (Product Master Data Platform).
--
-- DESTRUCTIVE: drops the whole `pmd` schema - every master product, offer, price
-- observation, source record and review decision. Take a backup first:
--     pg_dump --schema=pmd -Fc -f pmd-backup.dump <database>
--
-- It touches nothing else: the marketplace tables (public.*) were never altered by
-- 0015. The only cross-schema object, pmd.catalogue_link, lives inside `pmd` and is
-- dropped with it; public.products rows that were promoted from the master stay.
--
-- The pg_trgm extension is left installed (other objects may use it).
-- Run inside psql / phpMyAdmin-equivalent for Postgres (Neon SQL editor):
-- ============================================================================
BEGIN;

DROP SCHEMA IF EXISTS pmd CASCADE;

-- Let drizzle re-apply 0015 later: forget that it ran.
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1789839463326;

COMMIT;
