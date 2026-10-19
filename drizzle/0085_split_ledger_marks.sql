-- split: seller
-- Seller / customer split (docs/db-split-2026-10/CODE_SPLIT_PLAN.md): the stock-ledger
-- triggers skip their own rows when the inventory module writes the ledger itself.
-- The module said so with a session setting (gokesari.inv_ledger_managed), which
-- cannot reach the seller database through postgres_fdw. It now also leaves a mark
-- row; the row's own trigger stamps it with the transaction id of the database it
-- lands in, so inv_ledger_managed() finds it in the same transaction on one database
-- or two. Additive: the session setting keeps working as before.
CREATE TABLE IF NOT EXISTS "inv_ledger_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"xact" xid8,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_ledger_marks_xact_idx" ON "inv_ledger_marks" USING btree ("xact");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_marks_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.xact := pg_current_xact_id();
  -- A mark only matters inside its own transaction: clear old ones as new ones arrive.
  DELETE FROM inv_ledger_marks WHERE created_at < now() - interval '1 day';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS inv_ledger_marks_stamp ON inv_ledger_marks;
--> statement-breakpoint
CREATE TRIGGER inv_ledger_marks_stamp BEFORE INSERT ON inv_ledger_marks FOR EACH ROW EXECUTE FUNCTION inv_ledger_marks_stamp();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_managed() RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT coalesce(current_setting('gokesari.inv_ledger_managed', true), '') = 'on'
      OR EXISTS (SELECT 1 FROM inv_ledger_marks WHERE xact = pg_current_xact_id())
$$;
