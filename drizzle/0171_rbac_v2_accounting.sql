-- RBAC v2, Phase 3 (docs/rbac/03-phase3-accounting.md): Accountant → CA accounting. ADDITIVE ONLY, safe to re-run.
--  * fin_periods            monthly periods the CA closes / reopens (nothing posts into a CLOSED period)
--  * fin_journal_entries    platform journal entries: DRAFT → SUBMITTED → POSTED (or REJECTED); a POSTED entry is
--    fin_journal_lines      never edited — it is corrected by a reversing entry (DB triggers enforce both)
--  * rate_change_proposals  Accountant proposes → CA approves → Admin activates (calls the existing setter)
-- Users are not referenced by foreign key (the service checks those links). Flag: rbac_v2_accounting (OFF).
-- Rollback: scripts/rollback-0171.sql.
CREATE TABLE IF NOT EXISTS "fin_periods" (
  "code" text PRIMARY KEY CHECK ("code" ~ '^[0-9]{4}-[0-9]{2}$'),
  "starts_on" date NOT NULL,
  "ends_on" date NOT NULL,
  "status" text NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','CLOSED')),
  "closed_by" uuid,
  "closed_at" timestamp with time zone,
  "reopened_by" uuid,
  "reopened_at" timestamp with time zone,
  "note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "fin_journal_entry_number_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_journal_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_number" text NOT NULL UNIQUE DEFAULT ('JE-' || lpad(nextval('fin_journal_entry_number_seq')::text, 6, '0')),
  "entry_date" date NOT NULL,
  "period_code" text NOT NULL,
  "narration" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','SUBMITTED','POSTED','REJECTED','REVERSED')),
  "total_paise" bigint NOT NULL DEFAULT 0 CHECK ("total_paise" >= 0),
  "prepared_by" uuid NOT NULL,
  "approval_request_id" uuid,
  "posted_by" uuid,
  "posted_at" timestamp with time zone,
  "reverses_entry_id" uuid REFERENCES "fin_journal_entries"("id"),
  "reversed_by_entry_id" uuid REFERENCES "fin_journal_entries"("id"),
  "rejection_comment" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_journal_entries_period_idx" ON "fin_journal_entries" ("period_code", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fin_journal_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_id" uuid NOT NULL REFERENCES "fin_journal_entries"("id") ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "account_code" text NOT NULL,
  "account_name" text NOT NULL,
  "debit_paise" bigint NOT NULL DEFAULT 0 CHECK ("debit_paise" >= 0),
  "credit_paise" bigint NOT NULL DEFAULT 0 CHECK ("credit_paise" >= 0),
  "memo" text,
  CONSTRAINT "fin_journal_lines_one_side" CHECK (("debit_paise" > 0) <> ("credit_paise" > 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_journal_lines_entry_idx" ON "fin_journal_lines" ("entry_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fin_journal_lines_account_idx" ON "fin_journal_lines" ("account_code");
--> statement-breakpoint
-- A POSTED / REVERSED entry is final: only POSTED → REVERSED (with reversed_by_entry_id) may change.
CREATE OR REPLACE FUNCTION fin_journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED','REVERSED') THEN
      RAISE EXCEPTION 'fin_journal_entries: a posted entry cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'fin_journal_entries: a reversed entry is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'REVERSED' OR NEW.reversed_by_entry_id IS NULL
       OR NEW.entry_date <> OLD.entry_date OR NEW.period_code <> OLD.period_code OR NEW.narration <> OLD.narration
       OR NEW.total_paise <> OLD.total_paise OR NEW.posted_by IS DISTINCT FROM OLD.posted_by THEN
      RAISE EXCEPTION 'fin_journal_entries: a posted entry is corrected by a reversing entry, never edited' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fin_journal_entries_guard ON "fin_journal_entries";
--> statement-breakpoint
CREATE TRIGGER fin_journal_entries_guard BEFORE UPDATE OR DELETE ON "fin_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION fin_journal_entries_guard();
--> statement-breakpoint
-- Lines change only while their entry is DRAFT or REJECTED (being prepared again).
CREATE OR REPLACE FUNCTION fin_journal_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM fin_journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF s IS NOT NULL AND s NOT IN ('DRAFT','REJECTED') THEN
    RAISE EXCEPTION 'fin_journal_lines: lines of a % entry cannot change', s USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fin_journal_lines_guard ON "fin_journal_lines";
--> statement-breakpoint
CREATE TRIGGER fin_journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "fin_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION fin_journal_lines_guard();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_change_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rate_kind" text NOT NULL CHECK ("rate_kind" IN ('COMMISSION','REGISTRATION_FEE','DELIVERY_CHARGE')),
  "scope" text,
  "scope_key" text,
  "current_value" jsonb,
  "proposed_value" jsonb NOT NULL,
  "effective_at" timestamp with time zone NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_CA' CHECK ("status" IN ('PENDING_CA','PENDING_ADMIN','SCHEDULED','ACTIVATED','REJECTED','CANCELLED','FAILED')),
  "approval_request_id" uuid,
  "proposed_by" uuid NOT NULL,
  "activated_at" timestamp with time zone,
  "apply_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_change_proposals_status_idx" ON "rate_change_proposals" ("status", "effective_at");
