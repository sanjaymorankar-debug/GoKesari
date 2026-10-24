-- split: core
-- Repair (24 Oct 2026): 0088_revoked_sessions and the purchase-lists migration were written on
-- the same day with the same journal timestamp. The migrator applies only migrations newer
-- than the newest one recorded, so on a database where the other one was recorded first, 0088
-- was skipped and revoked_sessions never created. The test database recorded only one of the two
-- (90 → 91 migrations on 24 Oct, newest at that shared timestamp). These are 0088's statements
-- again; IF NOT EXISTS makes this a no-op wherever 0088 ran. Additive only.
CREATE TABLE IF NOT EXISTS "revoked_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_sessions_expires_idx" ON "revoked_sessions" USING btree ("expires_at");
