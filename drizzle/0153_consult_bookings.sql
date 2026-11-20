-- Consultant appointments and bookings (owner brief, 20-Nov-2026; docs/consult-booking-2026-11/).
-- New tables only, plus one widened check: payment intents may carry the CONSULT_BOOKING purpose.
-- A consultant / professional firm is an ordinary shop (registration, fee, KYC, auto-approval,
-- wallet and payouts unchanged); its booking profile, team, services, hours and bookings live here.
-- Nothing changes for anyone until an admin switches rule consultBooking on.
-- Double booking is stopped by the database: consult_booking_members carries an exclusion
-- constraint (same member, overlapping time, different share key) — btree_gist gives the
-- uuid "=" and text "<>" operators the constraint needs (a trusted extension since PG 13).
-- Rollback: scripts/rollback-0153.sql
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"group_name" text NOT NULL DEFAULT 'Other services',
	"description" text,
	"required_doc" text NOT NULL DEFAULT 'NONE',
	"required_doc_label" text,
	"default_modes" text[] NOT NULL DEFAULT '{IN_PERSON}'::text[],
	"commission_bp" integer,
	"sac_code" text,
	"sensitive" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"sort_order" integer NOT NULL DEFAULT 100,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_categories_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "consult_categories_doc" CHECK ("required_doc" IN ('NONE', 'MEDICAL_REGISTRATION', 'BAR_COUNCIL', 'ICAI', 'ICSI', 'ICMAI', 'COA', 'RCI', 'OTHER')),
	CONSTRAINT "consult_categories_commission" CHECK ("commission_bp" IS NULL OR "commission_bp" BETWEEN 0 AND 5000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_categories_slug_uq" ON "consult_categories" ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_categories_name_uq" ON "consult_categories" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_policy_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"free_cancel_hours" integer NOT NULL DEFAULT 24,
	"late_cancel_refund_pct" integer NOT NULL DEFAULT 50,
	"no_show_refund_pct" integer NOT NULL DEFAULT 0,
	"reschedule_min_hours" integer NOT NULL DEFAULT 4,
	"max_reschedules" integer NOT NULL DEFAULT 2,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"is_default" boolean NOT NULL DEFAULT false,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_policy_templates_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "consult_policy_templates_pct" CHECK ("late_cancel_refund_pct" BETWEEN 0 AND 100 AND "no_show_refund_pct" BETWEEN 0 AND 100),
	CONSTRAINT "consult_policy_templates_hours" CHECK ("free_cancel_hours" BETWEEN 0 AND 720 AND "reschedule_min_hours" BETWEEN 0 AND 720 AND "max_reschedules" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_policy_templates_name_uq" ON "consult_policy_templates" (lower("name"));
--> statement-breakpoint
-- One booking profile per shop (the firm). Location: the shop's own map pin unless overridden here.
CREATE TABLE IF NOT EXISTS "consult_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"kind" text NOT NULL DEFAULT 'INDIVIDUAL',
	"display_name" text NOT NULL,
	"headline" text,
	"about" text,
	"photo_url" text,
	"address_line" text,
	"latitude" double precision,
	"longitude" double precision,
	"policy_template_id" uuid REFERENCES "consult_policy_templates"("id") ON DELETE set null,
	"free_cancel_hours" integer NOT NULL DEFAULT 24,
	"late_cancel_refund_pct" integer NOT NULL DEFAULT 50,
	"no_show_refund_pct" integer NOT NULL DEFAULT 0,
	"reschedule_min_hours" integer NOT NULL DEFAULT 4,
	"max_reschedules" integer NOT NULL DEFAULT 2,
	"policy_note" text,
	"manual_approval" boolean NOT NULL DEFAULT false,
	"booking_window_days" integer NOT NULL DEFAULT 30,
	"min_notice_minutes" integer NOT NULL DEFAULT 60,
	"completion_otp" boolean NOT NULL DEFAULT true,
	"status" text NOT NULL DEFAULT 'DRAFT',
	"verification" text NOT NULL DEFAULT 'PENDING',
	"verification_note" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rating_avg_x100" integer NOT NULL DEFAULT 0,
	"rating_count" integer NOT NULL DEFAULT 0,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_profiles_kind" CHECK ("kind" IN ('INDIVIDUAL', 'FIRM')),
	CONSTRAINT "consult_profiles_status" CHECK ("status" IN ('DRAFT', 'LIVE', 'PAUSED', 'BLOCKED')),
	CONSTRAINT "consult_profiles_verification" CHECK ("verification" IN ('PENDING', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "consult_profiles_pct" CHECK ("late_cancel_refund_pct" BETWEEN 0 AND 100 AND "no_show_refund_pct" BETWEEN 0 AND 100),
	CONSTRAINT "consult_profiles_hours" CHECK ("free_cancel_hours" BETWEEN 0 AND 720 AND "reschedule_min_hours" BETWEEN 0 AND 720 AND "max_reschedules" BETWEEN 0 AND 10),
	CONSTRAINT "consult_profiles_window" CHECK ("booking_window_days" BETWEEN 1 AND 365 AND "min_notice_minutes" BETWEEN 0 AND 10080)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_profiles_shop_uq" ON "consult_profiles" ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_profiles_status_idx" ON "consult_profiles" ("status");
--> statement-breakpoint
-- A consultant: the owner of a one-person practice, or one member of a firm's team. Each has a calendar.
CREATE TABLE IF NOT EXISTS "consult_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL REFERENCES "consult_profiles"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"name" text NOT NULL,
	"title" text,
	"photo_url" text,
	"qualifications" text,
	"experience_years" integer,
	"languages" text[] NOT NULL DEFAULT '{}'::text[],
	"bio" text,
	"registration_number" text,
	"registration_body" text,
	"doc_status" text NOT NULL DEFAULT 'NOT_REQUIRED',
	"doc_note" text,
	"slot_minutes" integer NOT NULL DEFAULT 30,
	"buffer_minutes" integer NOT NULL DEFAULT 0,
	"max_per_slot" integer NOT NULL DEFAULT 1,
	"color" text NOT NULL DEFAULT '#c2410c',
	"is_owner" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"sort_order" integer NOT NULL DEFAULT 100,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_members_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "consult_members_doc_status" CHECK ("doc_status" IN ('NOT_REQUIRED', 'MISSING', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "consult_members_slot" CHECK ("slot_minutes" BETWEEN 5 AND 480 AND "buffer_minutes" BETWEEN 0 AND 240 AND "max_per_slot" BETWEEN 1 AND 50),
	CONSTRAINT "consult_members_experience" CHECK ("experience_years" IS NULL OR "experience_years" BETWEEN 0 AND 80)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_members_profile_idx" ON "consult_members" ("profile_id", "sort_order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_members_user_idx" ON "consult_members" ("user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_member_categories" (
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"category_id" uuid NOT NULL REFERENCES "consult_categories"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("member_id", "category_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_member_categories_category_idx" ON "consult_member_categories" ("category_id");
--> statement-breakpoint
-- The registration certificate of a member (Medical Council, Bar Council, ICAI ...), AES-GCM encrypted bytes.
CREATE TABLE IF NOT EXISTS "consult_member_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" bytea NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_member_documents_member_idx" ON "consult_member_documents" ("member_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL REFERENCES "consult_profiles"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"category_id" uuid REFERENCES "consult_categories"("id") ON DELETE set null,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL DEFAULT 30,
	"fee_type" text NOT NULL DEFAULT 'FIXED',
	"fee_paise" bigint NOT NULL DEFAULT 0,
	"deposit_paise" bigint NOT NULL DEFAULT 0,
	"modes" text[] NOT NULL DEFAULT '{IN_PERSON}'::text[],
	"booking_kind" text NOT NULL DEFAULT 'INDIVIDUAL',
	"capacity" integer NOT NULL DEFAULT 1,
	"required_members" integer NOT NULL DEFAULT 1,
	"member_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
	"pay_online" boolean NOT NULL DEFAULT true,
	"pay_at_visit" boolean NOT NULL DEFAULT true,
	"gst_rate_bp" integer NOT NULL DEFAULT 0,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"sort_order" integer NOT NULL DEFAULT 100,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_services_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "consult_services_fee_type" CHECK ("fee_type" IN ('FREE', 'FIXED', 'DEPOSIT')),
	CONSTRAINT "consult_services_kind" CHECK ("booking_kind" IN ('INDIVIDUAL', 'TEAM', 'GROUP')),
	CONSTRAINT "consult_services_duration" CHECK ("duration_minutes" BETWEEN 5 AND 600),
	CONSTRAINT "consult_services_fee" CHECK ("fee_paise" >= 0 AND "deposit_paise" >= 0 AND "deposit_paise" <= "fee_paise" AND ("fee_type" <> 'FREE' OR "fee_paise" = 0) AND ("fee_type" <> 'DEPOSIT' OR "deposit_paise" > 0)),
	CONSTRAINT "consult_services_capacity" CHECK ("capacity" BETWEEN 1 AND 500 AND "required_members" BETWEEN 1 AND 20),
	CONSTRAINT "consult_services_pay" CHECK ("pay_online" OR "pay_at_visit" OR "fee_type" = 'FREE'),
	CONSTRAINT "consult_services_gst" CHECK ("gst_rate_bp" BETWEEN 0 AND 2800),
	CONSTRAINT "consult_services_modes" CHECK (cardinality("modes") >= 1 AND "modes" <@ ARRAY['IN_PERSON', 'VIDEO', 'PHONE', 'HOME_VISIT']::text[])
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_services_profile_idx" ON "consult_services" ("profile_id", "sort_order");
--> statement-breakpoint
-- Weekly working hours: several sessions a day (10:00–13:00, 17:00–20:00), minutes after midnight IST.
CREATE TABLE IF NOT EXISTS "consult_weekly_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_weekly_hours_day" CHECK ("weekday" BETWEEN 0 AND 6),
	CONSTRAINT "consult_weekly_hours_range" CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_weekly_hours_member_idx" ON "consult_weekly_hours" ("member_id", "weekday");
--> statement-breakpoint
-- Leave, holidays, one-off blocks (no bookings) and one-off extra hours. member_id NULL: the whole firm.
CREATE TABLE IF NOT EXISTS "consult_time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL REFERENCES "consult_profiles"("id") ON DELETE cascade,
	"member_id" uuid REFERENCES "consult_members"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_time_off_kind" CHECK ("kind" IN ('LEAVE', 'HOLIDAY', 'BLOCK', 'EXTRA')),
	CONSTRAINT "consult_time_off_range" CHECK ("starts_at" < "ends_at"),
	CONSTRAINT "consult_time_off_extra_member" CHECK ("kind" <> 'EXTRA' OR "member_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_time_off_profile_idx" ON "consult_time_off" ("profile_id", "starts_at");
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "consult_booking_number_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_number" text NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"profile_id" uuid NOT NULL REFERENCES "consult_profiles"("id") ON DELETE restrict,
	"service_id" uuid NOT NULL REFERENCES "consult_services"("id") ON DELETE restrict,
	"category_id" uuid REFERENCES "consult_categories"("id") ON DELETE set null,
	"customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"booked_by" uuid,
	"booking_kind" text NOT NULL,
	"mode" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attendees" integer NOT NULL DEFAULT 1,
	"any_member" boolean NOT NULL DEFAULT false,
	"visitor_name" text NOT NULL,
	"visitor_phone" text,
	"visitor_email" text,
	"visitor_age" integer,
	"customer_note" text,
	"private_note" text,
	"visit_address" text,
	"visit_latitude" double precision,
	"visit_longitude" double precision,
	"meeting_url" text,
	"service_name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"fee_type" text NOT NULL,
	"fee_paise" bigint NOT NULL DEFAULT 0,
	"online_due_paise" bigint NOT NULL DEFAULT 0,
	"gst_rate_bp" integer NOT NULL DEFAULT 0,
	"payment_mode" text NOT NULL,
	"payment_status" text NOT NULL,
	"payment_intent_id" uuid,
	"balance_intent_id" uuid,
	"paid_online_paise" bigint NOT NULL DEFAULT 0,
	"paid_offline_paise" bigint NOT NULL DEFAULT 0,
	"offline_method" text,
	"offline_marked_by" uuid,
	"offline_marked_at" timestamp with time zone,
	"refund_paise" bigint NOT NULL DEFAULT 0,
	"refund_status" text NOT NULL DEFAULT 'NONE',
	"receipt_number" text,
	"receipt_issued_at" timestamp with time zone,
	"commission_bp" integer NOT NULL DEFAULT 0,
	"commission_paise" bigint NOT NULL DEFAULT 0,
	"settled_at" timestamp with time zone,
	"policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"hold_expires_at" timestamp with time zone,
	"otp_salt" text,
	"otp_attempts" integer NOT NULL DEFAULT 0,
	"reschedule_count" integer NOT NULL DEFAULT 0,
	"rescheduled_from" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"ticket_id" uuid,
	"rating" integer,
	"review" text,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_bookings_status" CHECK ("status" IN ('PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW', 'EXPIRED')),
	CONSTRAINT "consult_bookings_kind" CHECK ("booking_kind" IN ('INDIVIDUAL', 'TEAM', 'GROUP')),
	CONSTRAINT "consult_bookings_mode" CHECK ("mode" IN ('IN_PERSON', 'VIDEO', 'PHONE', 'HOME_VISIT')),
	CONSTRAINT "consult_bookings_fee_type" CHECK ("fee_type" IN ('FREE', 'FIXED', 'DEPOSIT')),
	CONSTRAINT "consult_bookings_payment_mode" CHECK ("payment_mode" IN ('FREE', 'ONLINE', 'PAY_AT_VISIT')),
	CONSTRAINT "consult_bookings_payment_status" CHECK ("payment_status" IN ('NOT_REQUIRED', 'PENDING', 'PART_PAID', 'PAID', 'DUE', 'FAILED')),
	CONSTRAINT "consult_bookings_refund_status" CHECK ("refund_status" IN ('NONE', 'PENDING', 'PARTIAL', 'REFUNDED', 'FAILED')),
	CONSTRAINT "consult_bookings_offline_method" CHECK ("offline_method" IS NULL OR "offline_method" IN ('CASH', 'UPI', 'CARD', 'OTHER')),
	CONSTRAINT "consult_bookings_cancelled_by" CHECK ("cancelled_by" IS NULL OR "cancelled_by" IN ('CUSTOMER', 'CONSULTANT', 'ADMIN', 'SYSTEM')),
	CONSTRAINT "consult_bookings_range" CHECK ("starts_at" < "ends_at"),
	CONSTRAINT "consult_bookings_money" CHECK ("fee_paise" >= 0 AND "online_due_paise" >= 0 AND "paid_online_paise" >= 0 AND "paid_offline_paise" >= 0 AND "refund_paise" >= 0 AND "refund_paise" <= "paid_online_paise" AND "commission_paise" >= 0),
	CONSTRAINT "consult_bookings_attendees" CHECK ("attendees" BETWEEN 1 AND 500),
	CONSTRAINT "consult_bookings_rating" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_bookings_number_uq" ON "consult_bookings" ("booking_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consult_bookings_receipt_uq" ON "consult_bookings" ("shop_id", "receipt_number") WHERE "receipt_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_bookings_shop_time_idx" ON "consult_bookings" ("shop_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_bookings_customer_idx" ON "consult_bookings" ("customer_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_bookings_status_idx" ON "consult_bookings" ("status", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_bookings_hold_idx" ON "consult_bookings" ("hold_expires_at") WHERE "status" = 'PENDING_PAYMENT';
--> statement-breakpoint
-- The calendar time a booking takes from each member it is assigned to. `active` rows block time.
-- share_key: the booking's own id for a private slot (any overlap conflicts); a session key
-- ("G:<service>:<start>" / "S:<member>:<start>") shared by the bookings of one group session or
-- one multi-patient slot, whose capacity the service checks under the member's row lock.
CREATE TABLE IF NOT EXISTS "consult_booking_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL REFERENCES "consult_bookings"("id") ON DELETE cascade,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE restrict,
	"starts_at" timestamp with time zone NOT NULL,
	"blocks_until" timestamp with time zone NOT NULL,
	"share_key" text NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	"slot" tstzrange GENERATED ALWAYS AS (tstzrange("starts_at", "blocks_until", '[)')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_booking_members_range" CHECK ("starts_at" < "blocks_until"),
	CONSTRAINT "consult_booking_members_no_overlap" EXCLUDE USING gist ("member_id" WITH =, "slot" WITH &&, "share_key" WITH <>) WHERE ("active")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_booking_members_booking_idx" ON "consult_booking_members" ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_booking_members_member_idx" ON "consult_booking_members" ("member_id", "starts_at") WHERE "active";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_booking_members_share_idx" ON "consult_booking_members" ("share_key") WHERE "active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consult_booking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL REFERENCES "consult_bookings"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_id" uuid,
	"actor_role" text,
	"note" text,
	"meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_booking_events_booking_idx" ON "consult_booking_events" ("booking_id", "created_at");
--> statement-breakpoint
-- Prescriptions, case papers ...: AES-GCM encrypted bytes, served only through a signed, access-checked link.
CREATE TABLE IF NOT EXISTS "consult_booking_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL REFERENCES "consult_bookings"("id") ON DELETE cascade,
	"uploaded_by" uuid NOT NULL,
	"uploader_side" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_booking_files_side" CHECK ("uploader_side" IN ('CUSTOMER', 'CONSULTANT'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_booking_files_booking_idx" ON "consult_booking_files" ("booking_id", "created_at");
--> statement-breakpoint
-- Who opened which private booking record or file (medical and legal privacy).
CREATE TABLE IF NOT EXISTS "consult_access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"file_id" uuid,
	"member_document_id" uuid,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_access_logs_booking_idx" ON "consult_access_logs" ("booking_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_access_logs_user_idx" ON "consult_access_logs" ("user_id", "created_at");
--> statement-breakpoint
-- Receipt / tax-invoice series per firm and financial year.
CREATE TABLE IF NOT EXISTS "consult_receipt_counters" (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"fy" text NOT NULL,
	"next_no" integer NOT NULL DEFAULT 1,
	PRIMARY KEY ("shop_id", "fy")
);
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE', 'SUPPORT_SERVICE', 'TERRITORY_FEE', 'CONSULT_BOOKING'));
--> statement-breakpoint
INSERT INTO "consult_policy_templates" ("name", "description", "free_cancel_hours", "late_cancel_refund_pct", "no_show_refund_pct", "reschedule_min_hours", "max_reschedules", "is_default")
SELECT v.name, v.description, v.fch, v.lcr, v.nsr, v.rmh, v.mr, v.d
FROM (VALUES
  ('Standard', 'Free cancellation up to 24 hours before; 50% back after that; nothing back for a no-show.', 24, 50, 0, 4, 2, true),
  ('Flexible', 'Free cancellation up to 2 hours before; 80% back after that.', 2, 80, 0, 1, 3, false),
  ('Strict', 'Free cancellation up to 48 hours before; nothing back after that.', 48, 0, 0, 24, 1, false)
) AS v(name, description, fch, lcr, nsr, rmh, mr, d)
WHERE NOT EXISTS (SELECT 1 FROM "consult_policy_templates" t WHERE lower(t."name") = lower(v.name));
--> statement-breakpoint
INSERT INTO "consult_categories" ("name", "slug", "group_name", "required_doc", "required_doc_label", "default_modes", "sac_code", "sensitive", "sort_order")
SELECT v.name, v.slug, v.grp, v.doc, v.doc_label, v.modes::text[], v.sac, v.sens, v.sort
FROM (VALUES
  ('General Physician', 'general-physician', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', '999312', true, 10),
  ('Dentist', 'dentist', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Dental Council registration', '{IN_PERSON}', '999312', true, 11),
  ('Paediatrician', 'paediatrician', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', '999312', true, 12),
  ('Gynaecologist', 'gynaecologist', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', '999312', true, 13),
  ('Dermatologist', 'dermatologist', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', '999312', true, 14),
  ('Orthopaedic', 'orthopaedic', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON}', '999312', true, 15),
  ('Eye Specialist', 'eye-specialist', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON}', '999312', true, 16),
  ('ENT Specialist', 'ent-specialist', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON}', '999312', true, 17),
  ('Psychologist / Counsellor', 'psychologist-counsellor', 'Doctors and clinics', 'RCI', 'RCI registration (or Medical Council for psychiatrists)', '{IN_PERSON,VIDEO,PHONE}', '999312', true, 18),
  ('Physiotherapist', 'physiotherapist', 'Doctors and clinics', 'OTHER', 'Physiotherapy council registration', '{IN_PERSON,HOME_VISIT}', '999312', true, 19),
  ('Ayurveda / Homeopathy', 'ayurveda-homeopathy', 'Doctors and clinics', 'MEDICAL_REGISTRATION', 'AYUSH / Homeopathy board registration', '{IN_PERSON,VIDEO}', '999312', true, 20),
  ('Veterinarian', 'veterinarian', 'Doctors and clinics', 'OTHER', 'Veterinary Council registration', '{IN_PERSON,HOME_VISIT}', '999312', false, 21),
  ('Advocate / Lawyer', 'advocate-lawyer', 'Legal and finance', 'BAR_COUNCIL', 'Bar Council enrolment', '{IN_PERSON,VIDEO,PHONE}', '998212', true, 30),
  ('Notary', 'notary', 'Legal and finance', 'BAR_COUNCIL', 'Notary appointment / Bar Council enrolment', '{IN_PERSON}', '998212', true, 31),
  ('Chartered Accountant (CA)', 'chartered-accountant', 'Legal and finance', 'ICAI', 'ICAI membership', '{IN_PERSON,VIDEO,PHONE}', '998221', true, 32),
  ('Company Secretary (CS)', 'company-secretary', 'Legal and finance', 'ICSI', 'ICSI membership', '{IN_PERSON,VIDEO,PHONE}', '998212', true, 33),
  ('Tax / GST Consultant', 'tax-gst-consultant', 'Legal and finance', 'NONE', NULL, '{IN_PERSON,VIDEO,PHONE}', '998231', true, 34),
  ('Financial Advisor', 'financial-advisor', 'Legal and finance', 'NONE', NULL, '{IN_PERSON,VIDEO,PHONE}', '997159', false, 35),
  ('IT / Software Consultant', 'it-software-consultant', 'Business and technology', 'NONE', NULL, '{VIDEO,PHONE,IN_PERSON}', '998313', false, 40),
  ('Management Consultant', 'management-consultant', 'Business and technology', 'NONE', NULL, '{IN_PERSON,VIDEO}', '998311', false, 41),
  ('Architect', 'architect', 'Home and design', 'COA', 'Council of Architecture registration', '{IN_PERSON,VIDEO}', '998321', false, 50),
  ('Interior Designer', 'interior-designer', 'Home and design', 'NONE', NULL, '{IN_PERSON,VIDEO,HOME_VISIT}', '998391', false, 51),
  ('Tutor / Coach', 'tutor-coach', 'Learning and wellness', 'NONE', NULL, '{IN_PERSON,VIDEO}', '999293', false, 60),
  ('Fitness / Yoga Trainer', 'fitness-yoga-trainer', 'Learning and wellness', 'NONE', NULL, '{IN_PERSON,VIDEO,HOME_VISIT}', '999723', false, 61),
  ('Salon / Beauty / Spa', 'salon-beauty-spa', 'Learning and wellness', 'NONE', NULL, '{IN_PERSON,HOME_VISIT}', '999721', false, 62),
  ('Electrician / Plumber / Repairs', 'home-repairs', 'Home services', 'NONE', NULL, '{HOME_VISIT}', '998729', false, 70),
  ('Appliance / Electronics Repair', 'appliance-repair', 'Home services', 'NONE', NULL, '{HOME_VISIT,IN_PERSON}', '998714', false, 71),
  ('Other professional services', 'other-professional', 'Other services', 'NONE', NULL, '{IN_PERSON,VIDEO,PHONE}', '998399', false, 99)
) AS v(name, slug, grp, doc, doc_label, modes, sac, sens, sort)
WHERE NOT EXISTS (SELECT 1 FROM "consult_categories" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name));
