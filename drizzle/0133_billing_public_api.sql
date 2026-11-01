-- split: core
-- Billing v2, phase 7 (docs/billing §8): the public REST API's OAuth2 clients (per shop, with
-- scopes) and their short-lived access tokens — hashes only. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0133.sql
CREATE TABLE IF NOT EXISTS "public_api_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_api_clients_client_uq" ON "public_api_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_api_clients_shop_idx" ON "public_api_clients" USING btree ("shop_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL REFERENCES "public_api_clients"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_api_tokens_hash_uq" ON "public_api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_api_tokens_client_idx" ON "public_api_tokens" USING btree ("client_id");
