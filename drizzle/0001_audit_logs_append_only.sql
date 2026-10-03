-- GS-067: audit_logs is append-only. Application code only ever INSERTs
-- (src/server/services/audit.ts); this makes the database refuse UPDATE and
-- DELETE too, so a bug or a compromised app role cannot rewrite history.
-- TRUNCATE is deliberately not blocked (it is owner-only, does not fire row
-- triggers, and the test suite relies on it). Removing this protection needs a
-- new migration, which is itself reviewed and recorded.
--
-- Ported from the Postgres original (drizzle-postgres-legacy/0018). Two
-- differences, both forced by MySQL: a trigger handles one event, so
-- BEFORE UPDATE OR DELETE becomes two triggers; and there is no RAISE, so the
-- refusal is SIGNAL SQLSTATE '45000' — the generic "unhandled user-defined
-- exception", which surfaces as errno 1644.
DROP TRIGGER IF EXISTS `audit_logs_no_update`;
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only: UPDATE is not allowed';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_logs_no_delete`;
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only: DELETE is not allowed';
