-- 0058 Event layer (docs/event-driven-2026-10): real-time events instead of
--   minute polling. Additive only — three new tables and four nullable columns;
--   no existing row is changed.
--   domain_events        one row per business event, written by emitEvent()
--                        in the same transaction as the status change;
--                        idempotency_key makes an event happen at most once.
--   dispute_comments     the customer / shop / support conversation on a case.
--   dispute_attachments  photos on a case (stored_images, DISPUTE_EVIDENCE).
--   order_disputes.awaiting_response_since / last_response_at   response SLA clock.
--   orders.accept_escalated_at          shop-acceptance timeout escalated to support.
--   rider_searches.support_alerted_at   "no rider accepted" alert sent to support.
-- Rollback: scripts/rollback-0058.sql
CREATE TABLE "dispute_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"comment_id" uuid,
	"stored_image_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"author_id" uuid,
	"author_party" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"order_id" uuid,
	"from_status" text,
	"to_status" text,
	"actor_id" uuid,
	"actor_role" "user_role",
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"notified" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_disputes" ADD COLUMN "awaiting_response_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD COLUMN "last_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accept_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rider_searches" ADD COLUMN "support_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_dispute_id_order_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."order_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_comment_id_dispute_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."dispute_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_stored_image_id_stored_images_id_fk" FOREIGN KEY ("stored_image_id") REFERENCES "public"."stored_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_comments" ADD CONSTRAINT "dispute_comments_dispute_id_order_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."order_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_comments" ADD CONSTRAINT "dispute_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_attachments_dispute_idx" ON "dispute_attachments" USING btree ("dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_attachments_image_unique" ON "dispute_attachments" USING btree ("stored_image_id");--> statement-breakpoint
CREATE INDEX "dispute_comments_dispute_idx" ON "dispute_comments" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_comments_request_unique" ON "dispute_comments" USING btree ("dispute_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_idempotency_unique" ON "domain_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "domain_events_subject_idx" ON "domain_events" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "domain_events_order_idx" ON "domain_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "domain_events_type_idx" ON "domain_events" USING btree ("type","created_at");