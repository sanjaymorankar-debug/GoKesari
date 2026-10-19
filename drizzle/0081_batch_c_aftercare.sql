-- batch-2026-10 WS-C (aftercare): F6.1.3 after-packing cancellation fee,
-- F6.2.3 refunds (wallet / original method), F6.3.3 help desk.
-- Additive only: new tables, indexes and one sequence. No existing row changes.
CREATE TABLE IF NOT EXISTS "shop_cancellation_fee_settings" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"enabled" boolean DEFAULT true NOT NULL,
	"fee_type" text DEFAULT 'FLAT' NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"fee_bp" integer DEFAULT 0 NOT NULL,
	"cap_paise" bigint,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_cancellation_fee_type_valid" CHECK ("fee_type" IN ('FLAT', 'PERCENT')),
	CONSTRAINT "shop_cancellation_fee_non_negative" CHECK ("fee_paise" >= 0 AND "fee_bp" >= 0 AND "fee_bp" <= 10000 AND ("cap_paise" IS NULL OR "cap_paise" >= 0))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"beneficiary" text NOT NULL,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"financial_adjustment_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_charges_amount_positive" CHECK ("amount_paise" > 0),
	CONSTRAINT "order_charges_beneficiary_valid" CHECK ("beneficiary" IN ('SHOP', 'PLATFORM'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_charges_idempotency_unique" ON "order_charges" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_charges_order_idx" ON "order_charges" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"method" text NOT NULL,
	"payment_channel" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"paid_paise" bigint NOT NULL,
	"deductions_paise" bigint DEFAULT 0 NOT NULL,
	"amount_paise" bigint NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"gateway_intent_id" text,
	"gateway_refund_ref" text,
	"wallet_transaction_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"fell_back_to_wallet" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "order_refunds_method_valid" CHECK ("method" IN ('WALLET', 'ORIGINAL')),
	CONSTRAINT "order_refunds_channel_valid" CHECK ("payment_channel" IN ('WALLET', 'ONLINE', 'COD')),
	CONSTRAINT "order_refunds_status_valid" CHECK ("status" IN ('REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED')),
	CONSTRAINT "order_refunds_amounts_valid" CHECK ("amount_paise" >= 0 AND "deductions_paise" >= 0 AND "paid_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_refunds_idempotency_unique" ON "order_refunds" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_refunds_status_idx" ON "order_refunds" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_refund_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL REFERENCES "order_refunds"("id") ON DELETE cascade,
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_refund_events_refund_idx" ON "order_refund_events" USING btree ("refund_id", "created_at");
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "support_ticket_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" text DEFAULT 'TKT-' || lpad(nextval('support_ticket_seq')::text, 6, '0') NOT NULL,
	"requester_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"requester_role" text DEFAULT 'CUSTOMER' NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"order_id" uuid REFERENCES "orders"("id") ON DELETE set null,
	"shop_id" uuid,
	"dispute_id" uuid REFERENCES "order_disputes"("id") ON DELETE set null,
	"grievance_id" uuid REFERENCES "grievances"("id") ON DELETE set null,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"assigned_to_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"acknowledge_by" timestamp with time zone NOT NULL,
	"resolve_by" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"ack_breached_at" timestamp with time zone,
	"resolve_breached_at" timestamp with time zone,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_status_valid" CHECK ("status" IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_CUSTOMER','AWAITING_SHOP','RESOLVED','CLOSED','REOPENED','ESCALATED')),
	CONSTRAINT "support_tickets_priority_valid" CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_number_unique" ON "support_tickets" USING btree ("ticket_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_requester_idx" ON "support_tickets" USING btree ("requester_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_shop_idx" ON "support_tickets" USING btree ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_order_idx" ON "support_tickets" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_assignee_idx" ON "support_tickets" USING btree ("assigned_to_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE cascade,
	"author_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"author_kind" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"canned_reply_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_messages_ticket_idx" ON "support_ticket_messages" USING btree ("ticket_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE cascade,
	"message_id" uuid REFERENCES "support_ticket_messages"("id") ON DELETE set null,
	"uploaded_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_attachments_ticket_idx" ON "support_ticket_attachments" USING btree ("ticket_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_id" uuid,
	"actor_role" text,
	"note" text,
	"public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_events_ticket_idx" ON "support_ticket_events" USING btree ("ticket_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_canned_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_canned_replies_active_idx" ON "support_canned_replies" USING btree ("active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_csat" (
	"ticket_id" uuid PRIMARY KEY NOT NULL REFERENCES "support_tickets"("id") ON DELETE cascade,
	"rating" integer NOT NULL,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ticket_csat_rating_range" CHECK ("rating" BETWEEN 1 AND 5)
);
