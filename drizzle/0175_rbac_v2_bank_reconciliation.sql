-- RBAC v2, Phase 3 follow-up (docs/rbac/03-phase3-accounting.md §Bank reconciliation): bank-statement reconciliation.
-- ADDITIVE ONLY, safe to re-run.
--  * fin_bank_statements       one imported bank statement (CSV / Excel) for one bank account and date range:
--                              OPEN (Accountant matching) → SUBMITTED (CA reviewing) → RECONCILED (signed off, final)
--  * fin_bank_statement_lines  its lines; each is MATCHED to one recorded payout / refund / posted journal entry,
--                              EXCLUDED with a reason (bank charges, interest …) or still UNMATCHED
-- A payout record is matched to at most one bank line (partial unique index). Lines change only while their
-- statement is OPEN, and a RECONCILED statement is never changed or deleted (DB triggers).
-- Existing payout, refund and finance tables are only read, never written. Users are not referenced by foreign key.
-- Flag: rbac_v2_accounting (OFF). Rollback: scripts/rollback-0175.sql.
CREATE SEQUENCE IF NOT EXISTS "fin_bank_statement_number_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_bank_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "statement_number" text NOT NULL UNIQUE DEFAULT ('BS-' || lpad(nextval('fin_bank_statement_number_seq')::text, 6, '0')),
  "account_label" text NOT NULL,
  "period_from" date NOT NULL,
  "period_to" date NOT NULL,
  "opening_balance_paise" bigint,
  "closing_balance_paise" bigint,
  "total_debit_paise" bigint NOT NULL DEFAULT 0 CHECK ("total_debit_paise" >= 0),
  "total_credit_paise" bigint NOT NULL DEFAULT 0 CHECK ("total_credit_paise" >= 0),
  "line_count" integer NOT NULL DEFAULT 0,
  "file_name" text NOT NULL,
  "file_sha256" text NOT NULL UNIQUE,
  "warnings" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','SUBMITTED','RECONCILED')),
  "uploaded_by" uuid NOT NULL,
  "approval_request_id" uuid,
  "signed_off_by" uuid,
  "signed_off_at" timestamp with time zone,
  "rejection_comment" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fin_bank_statements_period" CHECK ("period_from" <= "period_to")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_bank_statements_account_idx" ON "fin_bank_statements" ("account_label", "period_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_bank_statement_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "statement_id" uuid NOT NULL REFERENCES "fin_bank_statements"("id") ON DELETE CASCADE,
  "line_no" integer NOT NULL,
  "txn_date" date NOT NULL,
  "value_date" date,
  "description" text NOT NULL DEFAULT '',
  "reference" text,
  "debit_paise" bigint NOT NULL DEFAULT 0 CHECK ("debit_paise" >= 0),
  "credit_paise" bigint NOT NULL DEFAULT 0 CHECK ("credit_paise" >= 0),
  "balance_paise" bigint,
  "status" text NOT NULL DEFAULT 'UNMATCHED' CHECK ("status" IN ('UNMATCHED','MATCHED','EXCLUDED')),
  "match_kind" text CHECK ("match_kind" IN ('SHOP_PAYOUT','SHOP_SETTLEMENT','RIDER_PAYOUT','RIDER_TRANSFER','DEALER_PAYOUT','BANK_REFUND','JOURNAL')),
  "match_id" uuid,
  "match_method" text CHECK ("match_method" IN ('AUTO','MANUAL')),
  "matched_by" uuid,
  "matched_at" timestamp with time zone,
  "note" text,
  "suggestion" jsonb,
  CONSTRAINT "fin_bank_statement_lines_one_side" CHECK (("debit_paise" > 0) <> ("credit_paise" > 0)),
  CONSTRAINT "fin_bank_statement_lines_match" CHECK (
    ("status" = 'MATCHED' AND "match_kind" IS NOT NULL AND "match_id" IS NOT NULL)
    OR ("status" <> 'MATCHED' AND "match_kind" IS NULL AND "match_id" IS NULL)
  ),
  CONSTRAINT "fin_bank_statement_lines_excluded_note" CHECK ("status" <> 'EXCLUDED' OR coalesce(length(trim("note")), 0) >= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fin_bank_statement_lines_no_uq" ON "fin_bank_statement_lines" ("statement_id", "line_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fin_bank_statement_lines_target_uq" ON "fin_bank_statement_lines" ("match_kind", "match_id") WHERE "status" = 'MATCHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_bank_statement_lines_status_idx" ON "fin_bank_statement_lines" ("statement_id", "status");
--> statement-breakpoint
-- A RECONCILED statement is final; only OPEN ↔ SUBMITTED → RECONCILED moves, and only an OPEN one is deleted.
CREATE OR REPLACE FUNCTION fin_bank_statements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'OPEN' THEN
      RAISE EXCEPTION 'fin_bank_statements: only an open statement can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'RECONCILED' THEN
    RAISE EXCEPTION 'fin_bank_statements: a reconciled statement is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fin_bank_statements_guard ON "fin_bank_statements";
--> statement-breakpoint
CREATE TRIGGER fin_bank_statements_guard BEFORE UPDATE OR DELETE ON "fin_bank_statements"
  FOR EACH ROW EXECUTE FUNCTION fin_bank_statements_guard();
--> statement-breakpoint
-- Lines are inserted and matched only while the statement is OPEN (a cascade delete of an OPEN statement passes).
CREATE OR REPLACE FUNCTION fin_bank_statement_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM fin_bank_statements WHERE id = COALESCE(NEW.statement_id, OLD.statement_id);
  IF s IS NOT NULL AND s <> 'OPEN' THEN
    RAISE EXCEPTION 'fin_bank_statement_lines: lines of a % statement cannot change', s USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fin_bank_statement_lines_guard ON "fin_bank_statement_lines";
--> statement-breakpoint
CREATE TRIGGER fin_bank_statement_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "fin_bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION fin_bank_statement_lines_guard();
