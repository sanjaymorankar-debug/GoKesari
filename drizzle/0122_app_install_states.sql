-- split: core
-- docs/app-install-2026-10: the "install the GoKesari app" prompt, per signed-in person. The prompt
-- shows on every visit until the app is installed; this row keeps "Not now" presses (a count, never
-- used to stop prompting) and the platforms the person installed on, so the record holds across
-- devices. ADDITIVE ONLY; idempotent. Rollback: DROP TABLE IF EXISTS "app_install_states";
CREATE TABLE IF NOT EXISTS "app_install_states" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"decline_count" integer DEFAULT 0 NOT NULL,
	"last_declined_at" timestamp with time zone,
	"installed_platforms" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
