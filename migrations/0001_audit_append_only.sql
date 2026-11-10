-- Audit log is append-only (spec 8). Enforced in the database, not just in code.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log` BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log` BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
