-- Shop wallet credits for the TEST site (test.gokesari.com) ONLY. Do not run
-- against production.
--
-- Applied by the "Test database" workflow (after a backup) whenever this file
-- changes on staging, or by hand: Actions → Test database → Run workflow →
-- shop-wallet-credits (docs/event-driven-2026-10/DB_AUTOMATION.md).
--
-- Each row is one credit, written exactly as Admin → Shop wallets → Credit
-- writes it: a "Credit by GoKesari" (MANUAL_CREDIT) ledger entry, with the
-- balance after it, plus an audit record (shop_wallet.adjusted). Unlike the
-- admin page, the owner gets no notification.
--
-- Rules for editing:
--   - A row's key applies it once; running the file again changes nothing.
--   - To credit a shop again, ADD a row with a new key. Never edit or remove a
--     row that has been applied: the ledger cannot change, so correct a credit
--     with a debit in Admin → Shop wallets.
--   - Shop names are matched case-insensitively (ILIKE: % = anything). The
--     patterns are tried in order; the first that matches any shop must match
--     exactly one, otherwise the whole file is refused, nothing is written and
--     the error lists the shops on the database.
--   - All rows are applied together or not at all.
DO $$
DECLARE
  c record;
  pattern text;
  matches int;
  found_id uuid;
  w shop_wallets%ROWTYPE;
  after_paise bigint;
  threshold bigint;
BEGIN
  SELECT (value ->> 'lowBalanceThresholdPaise')::bigint INTO threshold FROM platform_settings WHERE key = 'shopWallet';
  threshold := COALESCE(threshold, 30000);

  FOR c IN
    SELECT * FROM (VALUES
      -- key (never reuse)                    shop name, then fallbacks                          amount (paise)   reason
      ('test-credit-2026-10-08-asmy-exports',     ARRAY['Asmy Exports'],     100000::bigint, 'Test credit (₹1,000) so the shop can accept orders on test'),
      ('test-credit-2026-10-08-qa-test-bakery-a', ARRAY['QA Test Bakery A'],  50000::bigint, 'Test credit (₹500) so the shop can accept orders on test'),
      ('test-credit-2026-10-08-qa-test-bakery-b', ARRAY['QA Test Bakery B'],  50000::bigint, 'Test credit (₹500) so the shop can accept orders on test')
    ) AS t(key, patterns, amount_paise, reason)
  LOOP
    IF EXISTS (SELECT 1 FROM shop_wallet_transactions WHERE idempotency_key = c.key) THEN
      RAISE NOTICE '%: already applied, skipped', c.key;
      CONTINUE;
    END IF;

    found_id := NULL;
    FOREACH pattern IN ARRAY c.patterns LOOP
      SELECT count(*) INTO matches FROM shops WHERE deleted_at IS NULL AND name ILIKE pattern;
      CONTINUE WHEN matches = 0;
      IF matches > 1 THEN
        RAISE EXCEPTION '%: "%" matches % shops (%); make the name exact. Nothing was credited.',
          c.key, pattern, matches,
          (SELECT string_agg(name, ', ' ORDER BY name) FROM shops WHERE deleted_at IS NULL AND name ILIKE pattern);
      END IF;
      SELECT id INTO found_id FROM shops WHERE deleted_at IS NULL AND name ILIKE pattern;
      EXIT;
    END LOOP;
    IF found_id IS NULL THEN
      RAISE EXCEPTION '%: no shop is named like %. Nothing was credited. Shops on this database: %',
        c.key, c.patterns,
        COALESCE((SELECT string_agg(name || ' (' || status || ')', ', ' ORDER BY name) FROM shops WHERE deleted_at IS NULL), 'none');
    END IF;

    -- The wallet is created at zero on first use (as the app does), then locked.
    INSERT INTO shop_wallets (shop_id) VALUES (found_id) ON CONFLICT (shop_id) DO NOTHING;
    SELECT * INTO w FROM shop_wallets WHERE shop_id = found_id FOR UPDATE;
    after_paise := w.balance_paise + c.amount_paise;

    -- The ledger trigger moves the balance; shop_wallets is never updated directly.
    INSERT INTO shop_wallet_transactions
      (wallet_id, shop_id, type, direction, amount_paise, balance_before_paise, balance_after_paise, reason, idempotency_key)
    VALUES
      (w.id, found_id, 'MANUAL_CREDIT', 'CREDIT', c.amount_paise, w.balance_paise, after_paise, c.reason, c.key);

    -- Back above the reminder level: the next fall below it warns the owner again.
    IF after_paise >= threshold THEN
      UPDATE shop_wallets SET low_balance_notified_at = NULL WHERE id = w.id AND low_balance_notified_at IS NOT NULL;
    END IF;

    INSERT INTO audit_logs (action, entity_type, entity_id, new_value)
    VALUES ('shop_wallet.adjusted', 'shop_wallet', w.id::text, jsonb_build_object(
      'direction', 'CREDIT', 'amountPaise', c.amount_paise, 'reason', c.reason, 'balancePaise', after_paise,
      'idempotencyKey', c.key, 'source', 'docs/shop-wallet-delivery-otp-2026-10/test-wallet-credits.sql'));

    RAISE NOTICE '%: credited % paise, balance now % paise', c.key, c.amount_paise, after_paise;
  END LOOP;
END;
$$;

-- What this file has credited, and each shop's balance now:
SELECT s.name AS shop, s.status, (t.amount_paise / 100.0)::numeric(12, 2) AS credited_rupees,
       (w.balance_paise / 100.0)::numeric(12, 2) AS balance_now_rupees,
       t.idempotency_key, t.created_at
FROM shop_wallet_transactions t
JOIN shops s ON s.id = t.shop_id
JOIN shop_wallets w ON w.id = t.wallet_id
WHERE t.idempotency_key LIKE 'test-credit-%'
ORDER BY t.seq;
