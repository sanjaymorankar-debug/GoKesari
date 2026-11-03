-- FDW removal check: after cutover.sql, compares each new local table with its parked
-- foreign table (fdw_old_<schema>), which still reads the live seller database.
\set ON_ERROR_STOP on
CREATE TEMP TABLE cmp (tbl text, local_rows bigint, seller_rows bigint);
DO $$ DECLARE r record; l bigint; s bigint; BEGIN
  FOR r IN SELECT substr(n.nspname, 9) s, c.relname t FROM pg_foreign_table f JOIN pg_class c ON c.oid = f.ftrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname LIKE 'fdw_old_%' AND c.relname NOT LIKE 'rseq_%' LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.s, r.t) INTO l;
    EXECUTE format('SELECT count(*) FROM %I.%I', 'fdw_old_' || r.s, r.t) INTO s;
    INSERT INTO cmp VALUES (r.s || '.' || r.t, l, s);
  END LOOP;
END $$;
\pset format aligned
SELECT count(*) AS tables, sum(local_rows) AS local_rows, sum(seller_rows) AS seller_rows,
       count(*) FILTER (WHERE local_rows <> seller_rows) AS mismatched FROM cmp;
SELECT * FROM cmp WHERE local_rows <> seller_rows;
-- Per-table counts as CSV on stdout (psql does not expand variables inside \copy):
--   psql "$CORE_URL" -f verify.sql -o /dev/null; or redirect this last result to a file.
\pset format csv
SELECT * FROM cmp ORDER BY tbl;
SELECT (SELECT count(*) FROM pg_foreign_table f JOIN pg_class c ON c.oid=f.ftrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','pmd')) AS ft_left_in_public_pmd,
       (SELECT count(*) FROM pg_foreign_server WHERE srvname='gk_seller') AS gk_seller_servers,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT tgisinternal AND n.nspname IN ('public','pmd')) AS triggers_total,
       (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace IN ('public'::regnamespace,'pmd'::regnamespace)) AS fks_total,
       (SELECT md5(prosrc) FROM pg_proc WHERE proname='shop_kyc_complete') = md5((SELECT prosrc FROM pg_proc WHERE proname='shop_kyc_complete')) AS ok,
       position('documents_later' in (SELECT prosrc FROM pg_proc WHERE proname='shop_kyc_complete')) > 0 AS kyc_fn_is_seller_version;
SELECT 'products.code next' k, 'P'||lpad((pg_sequence_last_value('product_code_seq')+1)::text,5,'0') v, (SELECT max(code) FROM products) cur
UNION ALL SELECT 'shop_wallet_txn seq', pg_sequence_last_value('shop_wallet_transactions_seq_seq')::text, (SELECT max(seq)::text FROM shop_wallet_transactions)
UNION ALL SELECT 'pmd.product_master', pg_sequence_last_value('pmd.product_seq')::text, (SELECT count(*)::text FROM pmd.product_master);
