-- 0043 Rider self-edit (F2): identity/bank changes wait for admin review here.
-- Additive only. Rollback: scripts/rollback-0043.sql
CREATE TABLE "delivery_partner_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"fields" text[] NOT NULL,
	"payload_encrypted" text NOT NULL,
	"masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"rejection_reason" text,
	"requested_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_partner_change_requests" ADD CONSTRAINT "delivery_partner_change_requests_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_change_requests" ADD CONSTRAINT "delivery_partner_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_change_requests" ADD CONSTRAINT "delivery_partner_change_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_partner_change_requests_one_pending" ON "delivery_partner_change_requests" USING btree ("delivery_partner_id") WHERE "delivery_partner_change_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "delivery_partner_change_requests_status_idx" ON "delivery_partner_change_requests" USING btree ("status","created_at");