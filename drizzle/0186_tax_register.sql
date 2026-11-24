-- Tax register (docs/tax-register/README.md): the Accountant proposes changes to tax settings and
-- answers questions for the CA; the CA approves (never their own) or sends back. An approved change
-- is applied through the setting's own service (statutory rows, TDS rows, GST rules, HSN rates,
-- product GST, tax fields of the settings). Flag tax_register (OFF): with it on, those settings are
-- changed only through the register. Users are not referenced by foreign key (service checks).
-- Additive only. Rollback: scripts/rollback-0186.sql
CREATE TABLE IF NOT EXISTS "tax_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"current_value" jsonb,
	"reason" text NOT NULL,
	"legal_reference" text,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposed_role" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_change_requests_status_check" CHECK ("status" IN ('SUBMITTED', 'SENT_BACK', 'WITHDRAWN', 'APPLIED', 'APPLY_FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_change_requests_status_idx" ON "tax_change_requests" ("status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_param_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"param_key" text NOT NULL,
	"value" jsonb,
	"approved_by" uuid NOT NULL,
	"change_request_id" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_param_approvals_key_idx" ON "tax_param_approvals" ("param_key", "approved_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ca_action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"area" text DEFAULT 'GST' NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"due_on" date,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ca_action_items_status_check" CHECK ("status" IN ('OPEN', 'SUBMITTED', 'NEEDS_INFO', 'APPROVED', 'CLOSED')),
	CONSTRAINT "ca_action_items_priority_check" CHECK ("priority" IN ('HIGH', 'NORMAL', 'LOW'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ca_action_items_ref_unique" ON "ca_action_items" ("ref");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ca_action_item_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "ca_action_items"("id") ON DELETE cascade,
	"author_id" uuid,
	"author_role" text,
	"kind" text DEFAULT 'NOTE' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca_action_item_notes_item_idx" ON "ca_action_item_notes" ("item_id", "created_at");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('tax_register', false) ON CONFLICT ("key") DO NOTHING;
