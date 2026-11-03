-- FDW removal cut-over: seller tables become ordinary tables in this database under
-- their current names. One transaction; on any error nothing changes.
-- Generated 02-Nov-2026 from a schema-only dump of the seller database.
-- pre.sql / post.sql are not kept in the repo: make them for each site from
--   pg_dump -Fc --schema-only -n public -n pmd <seller db>  ->  pg_restore -l, split at
--   pre-data / post-data, CREATE FUNCTION -> CREATE OR REPLACE FUNCTION.
-- Run on a Neon branch first; see docs/db-fdw-removal-2026-11/PHASE1_FINDINGS.md.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '30s';

-- 1. Park the foreign tables (kept, not dropped) and retire the server name, so the
--    site and both migration runners stop seeing a split layout (they look for "gk_seller").
CREATE SCHEMA fdw_old_public;
CREATE SCHEMA fdw_old_pmd;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname s, c.relname t FROM pg_foreign_table f
             JOIN pg_class c ON c.oid = f.ftrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_foreign_server sv ON sv.oid = f.ftserver
            WHERE sv.srvname = 'gk_seller' AND n.nspname IN ('public','pmd') LOOP
    EXECUTE format('ALTER FOREIGN TABLE %I.%I SET SCHEMA %I', r.s, r.t, 'fdw_old_' || r.s);
  END LOOP;
END $$;
-- The core's stand-ins for the seller's identity sequences make way for the real ones.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES ('pmd','category_category_id_seq'),('pmd','category_mapping_mapping_id_seq'),('pmd','import_error_error_id_seq'),('pmd','ingestion_run_run_id_seq'),('pmd','job_job_id_seq'),('pmd','match_candidate_candidate_id_seq'),('pmd','price_history_price_history_id_seq'),('pmd','product_attribute_conflict_conflict_id_seq'),('pmd','product_change_log_change_id_seq'),('pmd','product_family_family_id_seq'),('pmd','product_identifier_identifier_id_seq'),('pmd','product_image_image_id_seq'),('pmd','product_merge_log_merge_id_seq'),('pmd','product_offer_offer_id_seq'),('pmd','product_source_product_source_id_seq'),('pmd','product_specification_spec_id_seq'),('pmd','raw_record_raw_id_seq'),('pmd','source_source_id_seq'),('public','shop_wallet_transactions_seq_seq')) v(s, q) LOOP
    IF to_regclass(format('%I.%I', r.s, r.q)) IS NOT NULL THEN
      EXECUTE format('ALTER SEQUENCE %I.%I SET SCHEMA %I', r.s, r.q, 'fdw_old_' || r.s);
    END IF;
  END LOOP;
END $$;
ALTER SERVER gk_seller RENAME TO gk_seller_retired;

-- 2. Tables, partitions, views, identity columns and the seller's (current) functions.
\ir pre.sql
SET LOCAL search_path TO "$user", public;

-- 3. Data, before indexes, constraints and triggers (no trigger fires on the copy).
DO $$ DECLARE r record; cols text; BEGIN
  FOR r IN SELECT n.nspname s, c.relname t, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public','pmd') AND c.relkind IN ('r','p') AND NOT c.relispartition
              AND to_regclass(format('%I.%I', 'fdw_old_' || n.nspname, c.relname)) IS NOT NULL LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
      FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
    EXECUTE format('INSERT INTO %I.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM %I.%I',
                   r.s, r.t, cols, cols, 'fdw_old_' || r.s, r.t);
  END LOOP;
END $$;

-- 4. Keys, indexes, foreign keys between seller tables, triggers.
\ir post.sql
SET LOCAL search_path TO "$user", public;

-- 5. Sequences: past every value already issued by the core, the seller database or a row.
DO $$ DECLARE r record; remote bigint; parked bigint; col_max bigint; v bigint; owner record; BEGIN
  FOR r IN SELECT * FROM (VALUES ('public','shop_registration_seq'),('pmd','brand_seq'),('pmd','category_category_id_seq'),('pmd','category_mapping_mapping_id_seq'),('pmd','import_error_error_id_seq'),('pmd','ingestion_run_run_id_seq'),('pmd','job_job_id_seq'),('pmd','manufacturer_seq'),('pmd','match_candidate_candidate_id_seq'),('pmd','price_history_price_history_id_seq'),('pmd','product_attribute_conflict_conflict_id_seq'),('pmd','product_change_log_change_id_seq'),('pmd','product_family_family_id_seq'),('pmd','product_identifier_identifier_id_seq'),('pmd','product_image_image_id_seq'),('pmd','product_seq'),('pmd','product_merge_log_merge_id_seq'),('pmd','product_offer_offer_id_seq'),('pmd','product_source_product_source_id_seq'),('pmd','product_specification_spec_id_seq'),('pmd','raw_record_raw_id_seq'),('pmd','source_source_id_seq'),('public','dispute_case_seq'),('public','grievance_ticket_seq'),('public','product_code_seq'),('public','product_import_sku_seq'),('public','shop_wallet_transactions_seq_seq'),('public','support_ticket_seq')) v(s, q) LOOP
    EXECUTE format('CREATE FOREIGN TABLE %I.%I (last_value bigint, is_called boolean) SERVER gk_seller_retired OPTIONS (schema_name %L, table_name %L)',
                   'fdw_old_' || r.s, 'rseq_' || r.q, r.s, r.q);
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %I.%I', 'fdw_old_' || r.s, 'rseq_' || r.q) INTO remote;
    parked := NULL; col_max := NULL;
    IF to_regclass(format('%I.%I', 'fdw_old_' || r.s, r.q)) IS NOT NULL THEN
      parked := pg_sequence_last_value(format('%I.%I', 'fdw_old_' || r.s, r.q)::regclass);
    END IF;
    SELECT d.refobjid::regclass AS tbl, a.attname INTO owner FROM pg_depend d
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.objid = format('%I.%I', r.s, r.q)::regclass AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i');
    IF FOUND THEN EXECUTE format('SELECT max(%I)::bigint FROM %s', owner.attname, owner.tbl) INTO col_max; END IF;
    v := greatest(coalesce(pg_sequence_last_value(format('%I.%I', r.s, r.q)::regclass), 0), coalesce(remote, 0), coalesce(parked, 0), coalesce(col_max, 0));
    IF v > 0 THEN PERFORM setval(format('%I.%I', r.s, r.q)::regclass, v, true); END IF;
    RAISE NOTICE 'sequence %.%: core %, seller %, parked %, rows % -> %', r.s, r.q,
      pg_sequence_last_value(format('%I.%I', r.s, r.q)::regclass), remote, parked, col_max, v;
  END LOOP;
END $$;

-- 6. Every parked foreign table has its local table or view; nothing is still linked.
DO $$ DECLARE missing text; BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO missing FROM pg_foreign_table f
    JOIN pg_class c ON c.oid = f.ftrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname LIKE 'fdw_old_%' AND c.relname NOT LIKE 'rseq_%'
     AND to_regclass(format('%I.%I', substr(n.nspname, 9), c.relname)) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'no local table for: %', missing; END IF;
  IF EXISTS (SELECT 1 FROM pg_foreign_table f JOIN pg_class c ON c.oid = f.ftrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ('public','pmd')) THEN RAISE EXCEPTION 'foreign tables left in public/pmd'; END IF;
END $$;
COMMIT;
