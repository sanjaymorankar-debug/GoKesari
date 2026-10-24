-- split: core
-- QA 24 Oct 2026, TC-AUTH-034: Sign out ends the session on the server, not only in the
-- browser. Sessions are stateless Auth.js JWTs, so a copy of the session cookie taken
-- before signing out kept working until it expired (30 days). Sign out now lists the
-- session's id here and every request refuses a listed id (src/server/auth-sessions.ts).
-- A row is kept until every copy of the token has expired; the auth-housekeeping job then
-- deletes it. Platform table (identity), so it lives in the core. Additive only.
CREATE TABLE IF NOT EXISTS "revoked_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_sessions_expires_idx" ON "revoked_sessions" USING btree ("expires_at");
