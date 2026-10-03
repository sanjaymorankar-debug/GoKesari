-- GS-058: dispute cases.
-- Allocates case_number defaults (DSP-000001…) — same pattern as
-- grievance_ticket_seq / shop_registration_seq elsewhere in this schema.
-- drizzle-kit cannot emit the sequence itself, so it is added by hand here;
-- without it the table's DEFAULT references a sequence that does not exist and
-- the first insert fails.
CREATE SEQUENCE IF NOT EXISTS "dispute_case_seq" AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint
CREATE TABLE "dispute_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"from_level" text,
	"to_level" text NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" text DEFAULT 'DSP-' || lpad(nextval('dispute_case_seq')::text, 6, '0') NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"raised_by_user_id" uuid,
	"grievance_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"level" text DEFAULT 'L1' NOT NULL,
	"reason" text NOT NULL,
	"description" text NOT NULL,
	"assigned_to_user_id" uuid,
	"disputed_amount_paise" bigint NOT NULL,
	"payment_method_snapshot" "payment_method" NOT NULL,
	"order_total_paise" bigint NOT NULL,
	"order_paid_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_trigger" text,
	"escalation_note" text,
	"outcome" text,
	"refunded_paise" bigint,
	"refund_adjustment_id" uuid,
	"resolution_notes" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_disputes_amount_positive" CHECK ("order_disputes"."disputed_amount_paise" > 0),
	CONSTRAINT "order_disputes_amount_within_order" CHECK ("order_disputes"."disputed_amount_paise" <= "order_disputes"."order_total_paise"),
	CONSTRAINT "order_disputes_refund_non_negative" CHECK ("order_disputes"."refunded_paise" IS NULL OR "order_disputes"."refunded_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_order_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."order_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_grievance_id_grievances_id_fk" FOREIGN KEY ("grievance_id") REFERENCES "public"."grievances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_events_dispute_idx" ON "dispute_events" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_disputes_case_number_unique" ON "order_disputes" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "order_disputes_order_idx" ON "order_disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_disputes_shop_status_idx" ON "order_disputes" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "order_disputes_raised_by_idx" ON "order_disputes" USING btree ("raised_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "order_disputes_status_created_idx" ON "order_disputes" USING btree ("status","created_at");