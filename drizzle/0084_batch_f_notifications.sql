-- batch-2026-10 WS-F: push notifications (Expo), broadcasts, notification centre.
--   push_tokens           the app's Expo push tokens per user (platform)
--   push_tickets          one Expo ticket per device a PUSH delivery went to, and its receipt (platform)
--   broadcasts            admin/operator announcements: audience, schedule, expiry, counts (platform)
--   broadcast_recipients  one row per person a broadcast reached (idempotent re-runs, read counts) (platform)
-- All four are platform tables (core database, next to users and notifications), so their
-- foreign keys stay inside one physical database. Additive only.
CREATE TABLE IF NOT EXISTS "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"app_variant" text DEFAULT 'production' NOT NULL,
	"device_id" text,
	"device_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_platform_check" CHECK ("platform" IN ('android', 'ios')),
	CONSTRAINT "push_tokens_variant_check" CHECK ("app_variant" IN ('production', 'preview'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_token_unique" ON "push_tokens" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tokens_user_active_idx" ON "push_tokens" USING btree ("user_id","active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid REFERENCES "notification_deliveries"("id") ON DELETE set null,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"push_token_id" uuid NOT NULL REFERENCES "push_tokens"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"ticket_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tickets_pending_idx" ON "push_tickets" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tickets_delivery_idx" ON "push_tickets" USING btree ("delivery_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"image_url" text,
	"link_url" text,
	"audience" jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"schedule_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"sent_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"cancelled_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"audience_estimate" integer,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"cursor_user_id" uuid,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcasts_status_check" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcasts_status_idx" ON "broadcasts" USING btree ("status","schedule_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcasts_created_idx" ON "broadcasts" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL REFERENCES "broadcasts"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"notification_id" uuid REFERENCES "notifications"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_recipients_unique" ON "broadcast_recipients" USING btree ("broadcast_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_recipients_notification_idx" ON "broadcast_recipients" USING btree ("notification_id");
