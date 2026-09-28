-- GS-067: audit_logs is append-only. Application code only ever INSERTs
-- (src/server/services/audit.ts); this makes the database refuse UPDATE and
-- DELETE too, so a bug or a compromised app role cannot rewrite history.
-- TRUNCATE is deliberately not blocked (statement-level, owner-only; the test
-- suite relies on it). Removing this protection needs a new migration, which
-- is itself reviewed and recorded.
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
