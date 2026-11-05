-- Dealer commission (owner, 05-Nov-2026): there is no per-shop cap any more. A registration fee the
-- shop owner paid earns its full commission. Commission already held above the old cap is released:
-- a PENDING above-cap part becomes EARNED (approved at the next month close, or by an admin), and one
-- ON_HOLD for another reason will come back as EARNED when that hold is lifted. above_cap stays true
-- on those rows (history, and the ledger's unique key keeps the two parts apart). cap_paise is no
-- longer read.
UPDATE "dealer_commission_ledger"
SET "status" = 'EARNED',
    "note" = left(concat_ws('; ', nullif("note", ''), 'released 05-Nov-2026: the per-shop cap was removed (owner)'), 1000),
    "updated_at" = now()
WHERE "above_cap" AND "status" = 'PENDING' AND "kind" = 'ACCRUAL';
--> statement-breakpoint
UPDATE "dealer_commission_ledger"
SET "held_from_status" = 'EARNED',
    "note" = left(concat_ws('; ', nullif("note", ''), 'the per-shop cap was removed 05-Nov-2026 (owner): earned when released'), 1000),
    "updated_at" = now()
WHERE "above_cap" AND "status" = 'ON_HOLD' AND "held_from_status" = 'PENDING' AND "kind" = 'ACCRUAL';
