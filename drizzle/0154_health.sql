-- GoKesari Health (docs/health/; owner brief 20-Nov-2026 10.51 IST).
-- Built on the consultant-appointments engine (0153): a doctor, nurse or therapist is a consult member
-- of a practice (a shop); appointments are consult bookings. This migration adds the clinical layer in a
-- separate schema "health" (patients and family, consent, access log, consultations, versioned
-- e-prescriptions, suggestions and referrals, medical documents, the timeline, prescription orders to
-- medical stores, home-care visits, equipment rentals, Prime listing plans and call tracking).
-- Additive only: new schema and tables, five home-care consult categories, three payment purposes.
-- Nothing changes for anyone until an admin switches rule health on.
-- Rollback: scripts/rollback-0154.sql
CREATE SCHEMA IF NOT EXISTS health;
--> statement-breakpoint
-- A person whose health record GoKesari keeps: the account holder (SELF) or someone they manage.
CREATE TABLE IF NOT EXISTS health.patients (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"linked_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"relation" text NOT NULL DEFAULT 'SELF',
	"full_name" text NOT NULL,
	"date_of_birth" date,
	"gender" text,
	"blood_group" text,
	"allergies" text[] NOT NULL DEFAULT '{}'::text[],
	"conditions" text[] NOT NULL DEFAULT '{}'::text[],
	"current_medicines" text,
	"emergency_name" text,
	"emergency_phone" text,
	"emergency_relation" text,
	"phone" text,
	"email" text,
	"abha_number" text,
	"abha_address" text,
	"record_start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link_status" text NOT NULL DEFAULT 'ACTIVE',
	"link_code_hash" text,
	"link_code_expires_at" timestamp with time zone,
	"link_code_attempts" integer NOT NULL DEFAULT 0,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_relation" CHECK ("relation" IN ('SELF', 'CHILD', 'PARENT', 'SPOUSE', 'SIBLING', 'GRANDPARENT', 'OTHER')),
	CONSTRAINT "patients_gender" CHECK ("gender" IS NULL OR "gender" IN ('FEMALE', 'MALE', 'OTHER')),
	CONSTRAINT "patients_blood" CHECK ("blood_group" IS NULL OR "blood_group" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
	CONSTRAINT "patients_link_status" CHECK ("link_status" IN ('ACTIVE', 'PENDING_APPROVAL', 'REMOVED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patients_self_uq" ON health.patients ("account_user_id") WHERE "relation" = 'SELF';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_account_idx" ON health.patients ("account_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_linked_idx" ON health.patients ("linked_user_id") WHERE "linked_user_id" IS NOT NULL;
--> statement-breakpoint
-- Consent records (DPDP Act 2023): the My Health notice, record sharing with a doctor / provider, family links.
CREATE TABLE IF NOT EXISTS health.consents (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"mode" text NOT NULL DEFAULT 'ALWAYS',
	"grantee_member_id" uuid REFERENCES "consult_members"("id") ON DELETE cascade,
	"grantee_shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade,
	"booking_id" uuid REFERENCES "consult_bookings"("id") ON DELETE set null,
	"version" text NOT NULL,
	"text_snapshot" text NOT NULL,
	"granted_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "consents_kind" CHECK ("kind" IN ('HEALTH_NOTICE', 'DOCTOR_RECORDS', 'PROVIDER_RECORDS', 'REFERRAL_RECORDS', 'FAMILY_LINK')),
	CONSTRAINT "consents_mode" CHECK ("mode" IN ('ALWAYS', 'ASK', 'OFF', 'THIS_BOOKING'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_patient_idx" ON health.consents ("patient_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_grantee_idx" ON health.consents ("grantee_member_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
-- Who viewed / printed / downloaded / shared what (shown to the patient). No clinical content here.
CREATE TABLE IF NOT EXISTS health.access_log (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE cascade,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"reason" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_log_action" CHECK ("action" IN ('VIEW', 'PRINT', 'DOWNLOAD', 'SHARE', 'EXPORT', 'BREAK_GLASS', 'CONSENT_GRANTED', 'CONSENT_REVOKED', 'UPDATE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_log_patient_idx" ON health.access_log ("patient_id", "created_at" DESC);
--> statement-breakpoint
-- Doctors: clinical details on top of the consult member (registration, council, signature).
CREATE TABLE IF NOT EXISTS health.doctor_profiles (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"practitioner_type" text NOT NULL DEFAULT 'DOCTOR',
	"full_name" text NOT NULL,
	"qualifications" text NOT NULL,
	"specialties" text[] NOT NULL DEFAULT '{}'::text[],
	"council" text NOT NULL,
	"registration_number" text NOT NULL,
	"registration_year" integer,
	"hpr_id" text,
	"signature_image" bytea,
	"signature_type" text,
	"stamp_image" bytea,
	"stamp_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_profiles_type" CHECK ("practitioner_type" IN ('DOCTOR', 'DENTIST', 'AYUSH')),
	CONSTRAINT "doctor_profiles_year" CHECK ("registration_year" IS NULL OR "registration_year" BETWEEN 1940 AND 2100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "doctor_profiles_member_uq" ON health.doctor_profiles ("member_id");
--> statement-breakpoint
-- Home-care providers (nurse, physiotherapist, massage therapist, attendant …): extra details on the consult member.
CREATE TABLE IF NOT EXISTS health.care_provider_profiles (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"provider_kind" text NOT NULL DEFAULT 'INDIVIDUAL',
	"gender" text,
	"care_categories" text[] NOT NULL DEFAULT '{}'::text[],
	"registration_body" text,
	"registration_number" text,
	"police_verification" text NOT NULL DEFAULT 'NOT_REQUIRED',
	"service_pincodes" text[] NOT NULL DEFAULT '{}'::text[],
	"service_radius_km" integer NOT NULL DEFAULT 10,
	"id_card_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_provider_kind" CHECK ("provider_kind" IN ('INDIVIDUAL', 'AGENCY')),
	CONSTRAINT "care_provider_gender" CHECK ("gender" IS NULL OR "gender" IN ('FEMALE', 'MALE', 'OTHER')),
	CONSTRAINT "care_provider_police" CHECK ("police_verification" IN ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED')),
	CONSTRAINT "care_provider_radius" CHECK ("service_radius_km" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_provider_member_uq" ON health.care_provider_profiles ("member_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_provider_card_uq" ON health.care_provider_profiles ("id_card_number");
--> statement-breakpoint
-- Medical stores (pharmacy shops) that take forwarded prescriptions: drug licence and registered pharmacist.
CREATE TABLE IF NOT EXISTS health.pharmacy_profiles (
	"shop_id" uuid PRIMARY KEY REFERENCES "shops"("id") ON DELETE cascade,
	"drug_licence_number" text NOT NULL,
	"pharmacist_name" text NOT NULL,
	"pharmacist_registration_number" text NOT NULL,
	"pharmacy_council" text,
	"accepts_prescriptions" boolean NOT NULL DEFAULT true,
	"own_delivery" boolean NOT NULL DEFAULT true,
	"cash_on_handover" boolean NOT NULL DEFAULT true,
	"delivery_radius_km" integer NOT NULL DEFAULT 5,
	"verification" text NOT NULL DEFAULT 'PENDING',
	"verification_note" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_profiles_verification" CHECK ("verification" IN ('PENDING', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "pharmacy_profiles_radius" CHECK ("delivery_radius_km" BETWEEN 1 AND 50)
);
--> statement-breakpoint
-- Equipment stores: rental terms shown to customers and the store's verification by GoKesari.
CREATE TABLE IF NOT EXISTS health.equipment_store_profiles (
	"shop_id" uuid PRIMARY KEY REFERENCES "shops"("id") ON DELETE cascade,
	"rental_terms" text,
	"damage_policy" text,
	"delivery_radius_km" integer NOT NULL DEFAULT 10,
	"verification" text NOT NULL DEFAULT 'PENDING',
	"verification_note" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_store_profiles_verification" CHECK ("verification" IN ('PENDING', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "equipment_store_profiles_radius" CHECK ("delivery_radius_km" BETWEEN 1 AND 100)
);
--> statement-breakpoint
-- Clinic-level settings (the practice is the shop): token mode, follow-up window, HFR id.
CREATE TABLE IF NOT EXISTS health.clinic_settings (
	"shop_id" uuid PRIMARY KEY REFERENCES "shops"("id") ON DELETE cascade,
	"token_mode" boolean NOT NULL DEFAULT false,
	"token_daily_limit" integer NOT NULL DEFAULT 40,
	"follow_up_days" integer NOT NULL DEFAULT 7,
	"follow_up_fee_paise" bigint,
	"hfr_id" text,
	"pay_per_booking" boolean NOT NULL DEFAULT false,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_settings_limits" CHECK ("token_daily_limit" BETWEEN 1 AND 500 AND "follow_up_days" BETWEEN 0 AND 90)
);
--> statement-breakpoint
-- Letterhead and print settings per clinic (member_id NULL) or per doctor in a clinic.
CREATE TABLE IF NOT EXISTS health.letterheads (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"member_id" uuid REFERENCES "consult_members"("id") ON DELETE cascade,
	"mode" text NOT NULL DEFAULT 'STANDARD',
	"paper" text NOT NULL DEFAULT 'A4',
	"margin_top_mm" numeric(5, 1) NOT NULL DEFAULT 15,
	"margin_bottom_mm" numeric(5, 1) NOT NULL DEFAULT 15,
	"margin_left_mm" numeric(5, 1) NOT NULL DEFAULT 15,
	"margin_right_mm" numeric(5, 1) NOT NULL DEFAULT 15,
	"header_height_mm" numeric(5, 1) NOT NULL DEFAULT 35,
	"footer_height_mm" numeric(5, 1) NOT NULL DEFAULT 15,
	"header_image" bytea,
	"header_type" text,
	"footer_image" bytea,
	"footer_type" text,
	"background_image" bytea,
	"background_type" text,
	"font_size_pt" integer NOT NULL DEFAULT 10,
	"sections" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"local_language" text NOT NULL DEFAULT 'NONE',
	"show_signature" boolean NOT NULL DEFAULT true,
	"auto_print" boolean NOT NULL DEFAULT false,
	"printer_name" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "letterheads_mode" CHECK ("mode" IN ('DIGITAL', 'PREPRINTED', 'STANDARD')),
	CONSTRAINT "letterheads_paper" CHECK ("paper" IN ('A4', 'A5', 'LETTER')),
	CONSTRAINT "letterheads_language" CHECK ("local_language" IN ('NONE', 'HI', 'MR')),
	CONSTRAINT "letterheads_font" CHECK ("font_size_pt" BETWEEN 7 AND 16),
	CONSTRAINT "letterheads_margins" CHECK ("margin_top_mm" BETWEEN 0 AND 150 AND "margin_bottom_mm" BETWEEN 0 AND 150 AND "margin_left_mm" BETWEEN 0 AND 60 AND "margin_right_mm" BETWEEN 0 AND 60 AND "header_height_mm" BETWEEN 0 AND 120 AND "footer_height_mm" BETWEEN 0 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "letterheads_scope_uq" ON health.letterheads ("shop_id", coalesce("member_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
-- Drug master: generic + brand + strength + form, schedule, and the Telemedicine Practice Guidelines list.
CREATE TABLE IF NOT EXISTS health.drug_master (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generic_name" text NOT NULL,
	"brand_name" text,
	"strength" text,
	"form" text NOT NULL DEFAULT 'TABLET',
	"manufacturer" text,
	"schedule" text NOT NULL DEFAULT 'H',
	"rx_required" boolean NOT NULL DEFAULT true,
	"tele_list" text NOT NULL DEFAULT 'A',
	"online_sale_allowed" boolean NOT NULL DEFAULT true,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drug_master_form" CHECK ("form" IN ('TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'INJECTION', 'OINTMENT', 'CREAM', 'GEL', 'DROPS', 'INHALER', 'POWDER', 'SACHET', 'SPRAY', 'SUPPOSITORY', 'PATCH', 'LOTION', 'SOLUTION', 'OTHER')),
	CONSTRAINT "drug_master_schedule" CHECK ("schedule" IN ('OTC', 'G', 'H', 'H1', 'X', 'NDPS')),
	CONSTRAINT "drug_master_tele" CHECK ("tele_list" IN ('O', 'A', 'B', 'PROHIBITED')),
	CONSTRAINT "drug_master_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drug_master_uq" ON health.drug_master (lower("generic_name"), lower(coalesce("brand_name", '')), lower(coalesce("strength", '')), "form");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_master_generic_idx" ON health.drug_master (lower("generic_name") text_pattern_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_master_brand_idx" ON health.drug_master (lower("brand_name") text_pattern_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.icd10_codes (
	"code" text PRIMARY KEY,
	"title" text NOT NULL,
	"chapter" text
);
--> statement-breakpoint
-- The clinical side of a consult booking: whose record it is, record-sharing choice, token, queue.
CREATE TABLE IF NOT EXISTS health.appointment_links (
	"booking_id" uuid PRIMARY KEY REFERENCES "consult_bookings"("id") ON DELETE cascade,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"share_records" text NOT NULL DEFAULT 'OFF',
	"visit_type" text NOT NULL DEFAULT 'NEW',
	"reason" text,
	"token_number" integer,
	"queue_order" integer,
	"called_at" timestamp with time zone,
	"referral_suggestion_id" uuid,
	"source_suggestion_id" uuid,
	"walk_in" boolean NOT NULL DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_links_share" CHECK ("share_records" IN ('ON', 'OFF', 'ASK')),
	CONSTRAINT "appointment_links_visit" CHECK ("visit_type" IN ('NEW', 'FOLLOW_UP'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_links_patient_idx" ON health.appointment_links ("patient_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.consultations (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid REFERENCES "consult_bookings"("id") ON DELETE set null,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE restrict,
	"doctor_user_id" uuid,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"mode" text NOT NULL DEFAULT 'IN_PERSON',
	"visit_type" text NOT NULL DEFAULT 'NEW',
	"status" text NOT NULL DEFAULT 'IN_PROGRESS',
	"vitals" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"chief_complaints" text,
	"history" text,
	"examination" text,
	"diagnoses" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"investigations" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"advice" text,
	"follow_up_date" date,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consultations_status" CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED')),
	CONSTRAINT "consultations_mode" CHECK ("mode" IN ('IN_PERSON', 'VIDEO', 'PHONE', 'HOME_VISIT')),
	CONSTRAINT "consultations_visit" CHECK ("visit_type" IN ('NEW', 'FOLLOW_UP'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consultations_booking_uq" ON health.consultations ("booking_id") WHERE "booking_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consultations_patient_idx" ON health.consultations ("patient_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consultations_member_idx" ON health.consultations ("member_id", "started_at" DESC);
--> statement-breakpoint
-- Versioned e-prescriptions. A version is never edited after issue; an amendment is a new version.
CREATE TABLE IF NOT EXISTS health.prescriptions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL REFERENCES health.consultations("id") ON DELETE restrict,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE restrict,
	"doctor_user_id" uuid,
	"rx_number" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"root_id" uuid,
	"supersedes_id" uuid,
	"amend_reason" text,
	"status" text NOT NULL DEFAULT 'ISSUED',
	"content" jsonb NOT NULL,
	"pdf" bytea,
	"pdf_hash" text,
	"verification_token" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" date,
	"emailed_at" timestamp with time zone,
	"print_count" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescriptions_status" CHECK ("status" IN ('ISSUED', 'SUPERSEDED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prescriptions_number_uq" ON health.prescriptions ("rx_number", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prescriptions_token_uq" ON health.prescriptions ("verification_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_patient_idx" ON health.prescriptions ("patient_id", "issued_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_consultation_idx" ON health.prescriptions ("consultation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.prescription_items (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL REFERENCES health.prescriptions("id") ON DELETE cascade,
	"line_no" integer NOT NULL,
	"drug_id" uuid REFERENCES health.drug_master("id") ON DELETE set null,
	"generic_name" text NOT NULL,
	"brand_name" text,
	"strength" text,
	"form" text NOT NULL DEFAULT 'TABLET',
	"dose" text NOT NULL,
	"frequency" text NOT NULL,
	"timing" text NOT NULL DEFAULT 'AFTER_FOOD',
	"duration_days" integer NOT NULL,
	"quantity" integer NOT NULL,
	"instructions" text,
	"instructions_local" text,
	"tele_list" text,
	"rx_required" boolean NOT NULL DEFAULT true,
	"dispensed_qty" integer NOT NULL DEFAULT 0,
	CONSTRAINT "prescription_items_timing" CHECK ("timing" IN ('BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD', 'EMPTY_STOMACH', 'BEDTIME', 'AS_NEEDED', 'ANY_TIME')),
	CONSTRAINT "prescription_items_qty" CHECK ("quantity" BETWEEN 1 AND 10000 AND "dispensed_qty" BETWEEN 0 AND "quantity" AND "duration_days" BETWEEN 0 AND 3650)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prescription_items_line_uq" ON health.prescription_items ("prescription_id", "line_no");
--> statement-breakpoint
-- Doctor suggestions and referrals. Never carry money for the doctor (NMC Code of Ethics).
CREATE TABLE IF NOT EXISTS health.suggestions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL REFERENCES health.consultations("id") ON DELETE cascade,
	"prescription_id" uuid REFERENCES health.prescriptions("id") ON DELETE set null,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE restrict,
	"type" text NOT NULL,
	"details" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"target_member_id" uuid REFERENCES "consult_members"("id") ON DELETE set null,
	"target_shop_id" uuid REFERENCES "shops"("id") ON DELETE set null,
	"urgency" text NOT NULL DEFAULT 'ROUTINE',
	"print_on_rx" boolean NOT NULL DEFAULT true,
	"share_records" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'OPEN',
	"linked_booking_id" uuid,
	"linked_rx_order_id" uuid,
	"linked_rental_id" uuid,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_type" CHECK ("type" IN ('DOCTOR_REFERRAL', 'CARE_STAFF', 'EQUIPMENT', 'LAB_TEST', 'FOLLOW_UP')),
	CONSTRAINT "suggestions_status" CHECK ("status" IN ('OPEN', 'BOOKED', 'DONE', 'CANCELLED')),
	CONSTRAINT "suggestions_urgency" CHECK ("urgency" IN ('ROUTINE', 'SOON', 'URGENT'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_patient_idx" ON health.suggestions ("patient_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_consultation_idx" ON health.suggestions ("consultation_id");
--> statement-breakpoint
-- Medical documents (lab reports, scans, discharge summaries, bills, visit notes). Files AES-GCM encrypted.
CREATE TABLE IF NOT EXISTS health.documents (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"uploaded_by" uuid,
	"source" text NOT NULL,
	"kind" text NOT NULL DEFAULT 'OTHER',
	"title" text NOT NULL,
	"document_date" date,
	"consultation_id" uuid REFERENCES health.consultations("id") ON DELETE set null,
	"prescription_id" uuid REFERENCES health.prescriptions("id") ON DELETE set null,
	"care_visit_id" uuid,
	"provider_member_id" uuid REFERENCES "consult_members"("id") ON DELETE set null,
	"provider_name" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" bytea NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_source" CHECK ("source" IN ('DOCTOR', 'LAB', 'PATIENT', 'PROVIDER', 'STORE', 'SYSTEM')),
	CONSTRAINT "documents_kind" CHECK ("kind" IN ('LAB_REPORT', 'SCAN', 'DISCHARGE_SUMMARY', 'PRESCRIPTION', 'BILL', 'VISIT_NOTE', 'OTHER'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_patient_idx" ON health.documents ("patient_id", "created_at" DESC);
--> statement-breakpoint
-- The patient's timeline: one row per event, newest first. Denormalised; the source row is ref_type / ref_id.
CREATE TABLE IF NOT EXISTS health.timeline (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE cascade,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"provider_name" text,
	"provider_member_id" uuid,
	"provider_shop_id" uuid,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_kind" CHECK ("kind" IN ('APPOINTMENT', 'CONSULTATION', 'PRESCRIPTION', 'DOCUMENT', 'MEDICINE_ORDER', 'CARE_VISIT', 'EQUIPMENT', 'REFERRAL', 'SUGGESTION', 'PROFILE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timeline_ref_uq" ON health.timeline ("patient_id", "ref_type", "ref_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeline_patient_idx" ON health.timeline ("patient_id", "occurred_at" DESC);
--> statement-breakpoint
-- Event outbox: every health state change, for the live stream, the audit trail and replay. No clinical text.
CREATE TABLE IF NOT EXISTS health.events (
	"id" bigserial PRIMARY KEY,
	"name" text NOT NULL,
	"user_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
	"shop_id" uuid,
	"subject_id" uuid,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_idx" ON health.events ("created_at");
--> statement-breakpoint
-- Expiring share links for one record item.
CREATE TABLE IF NOT EXISTS health.share_links (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE cascade,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"open_count" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_object" CHECK ("object_type" IN ('PRESCRIPTION', 'DOCUMENT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "share_links_token_uq" ON health.share_links ("token_hash");
--> statement-breakpoint
-- A doctor's prescription templates and favourite medicines.
CREATE TABLE IF NOT EXISTS health.rx_templates (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL REFERENCES "consult_members"("id") ON DELETE cascade,
	"kind" text NOT NULL DEFAULT 'TEMPLATE',
	"name" text NOT NULL,
	"content" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rx_templates_kind" CHECK ("kind" IN ('TEMPLATE', 'FAVOURITE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_templates_member_idx" ON health.rx_templates ("member_id", "kind");
--> statement-breakpoint
-- A prescription the patient forwarded to a medical store: request → quote → approve / pay → pickup or delivery.
CREATE TABLE IF NOT EXISTS health.rx_orders (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"prescription_id" uuid NOT NULL REFERENCES health.prescriptions("id") ON DELETE restrict,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"suggestion_id" uuid,
	"fulfilment" text NOT NULL,
	"pickup_at" timestamp with time zone,
	"address" jsonb,
	"distance_km" numeric(7, 2),
	"status" text NOT NULL DEFAULT 'SENT',
	"expires_at" timestamp with time zone NOT NULL,
	"quoted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"goods_paise" bigint NOT NULL DEFAULT 0,
	"discount_paise" bigint NOT NULL DEFAULT 0,
	"delivery_paise" bigint NOT NULL DEFAULT 0,
	"total_paise" bigint NOT NULL DEFAULT 0,
	"payment_mode" text,
	"payment_status" text NOT NULL DEFAULT 'NOT_DUE',
	"payment_intent_id" uuid,
	"paid_online_paise" bigint NOT NULL DEFAULT 0,
	"paid_offline_paise" bigint NOT NULL DEFAULT 0,
	"refund_paise" bigint NOT NULL DEFAULT 0,
	"commission_bp" integer NOT NULL DEFAULT 200,
	"commission_paise" bigint NOT NULL DEFAULT 0,
	"settled_at" timestamp with time zone,
	"otp_salt" text,
	"otp_attempts" integer NOT NULL DEFAULT 0,
	"delivery_person" text,
	"delivery_phone" text,
	"bill_number" text,
	"packed_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rx_orders_fulfilment" CHECK ("fulfilment" IN ('PICKUP', 'DELIVERY')),
	CONSTRAINT "rx_orders_status" CHECK ("status" IN ('SENT', 'QUOTED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'APPROVED', 'PAID', 'PACKED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED')),
	CONSTRAINT "rx_orders_payment_mode" CHECK ("payment_mode" IS NULL OR "payment_mode" IN ('ONLINE', 'CASH_ON_HANDOVER')),
	CONSTRAINT "rx_orders_payment_status" CHECK ("payment_status" IN ('NOT_DUE', 'PENDING', 'PAID', 'DUE_ON_HANDOVER', 'FAILED', 'REFUNDED')),
	CONSTRAINT "rx_orders_money" CHECK ("goods_paise" >= 0 AND "discount_paise" >= 0 AND "delivery_paise" >= 0 AND "total_paise" >= 0 AND "paid_online_paise" >= 0 AND "paid_offline_paise" >= 0 AND "refund_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rx_orders_number_uq" ON health.rx_orders ("order_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_orders_shop_idx" ON health.rx_orders ("shop_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_orders_customer_idx" ON health.rx_orders ("customer_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_orders_expiry_idx" ON health.rx_orders ("expires_at") WHERE "status" = 'SENT';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.rx_order_items (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rx_order_id" uuid NOT NULL REFERENCES health.rx_orders("id") ON DELETE cascade,
	"prescription_item_id" uuid NOT NULL REFERENCES health.prescription_items("id") ON DELETE restrict,
	"requested_qty" integer NOT NULL,
	"availability" text,
	"quoted_qty" integer NOT NULL DEFAULT 0,
	"substitute_name" text,
	"substitute_generic" text,
	"substitute_strength" text,
	"substitute_approved" boolean,
	"unit_price_paise" bigint NOT NULL DEFAULT 0,
	"discount_paise" bigint NOT NULL DEFAULT 0,
	"line_total_paise" bigint NOT NULL DEFAULT 0,
	"batch_number" text,
	"expiry_date" date,
	"dispensed_qty" integer NOT NULL DEFAULT 0,
	CONSTRAINT "rx_order_items_availability" CHECK ("availability" IS NULL OR "availability" IN ('AVAILABLE', 'PARTIAL', 'UNAVAILABLE', 'SUBSTITUTE')),
	CONSTRAINT "rx_order_items_qty" CHECK ("requested_qty" >= 1 AND "quoted_qty" >= 0 AND "quoted_qty" <= "requested_qty" AND "dispensed_qty" >= 0 AND "dispensed_qty" <= "quoted_qty")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_order_items_order_idx" ON health.rx_order_items ("rx_order_id");
--> statement-breakpoint
-- Home-care visits (a consult booking in a home-care category): on the way, OTP check-in / check-out, notes, vitals.
CREATE TABLE IF NOT EXISTS health.care_visits (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL REFERENCES "consult_bookings"("id") ON DELETE cascade,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"member_id" uuid REFERENCES "consult_members"("id") ON DELETE set null,
	"package_id" uuid,
	"session_no" integer,
	"status" text NOT NULL DEFAULT 'SCHEDULED',
	"on_the_way_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"otp_salt" text NOT NULL,
	"otp_attempts" integer NOT NULL DEFAULT 0,
	"last_latitude" double precision,
	"last_longitude" double precision,
	"last_location_at" timestamp with time zone,
	"notes" text,
	"vitals" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"share_records" boolean NOT NULL DEFAULT false,
	"sos_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_visits_status" CHECK ("status" IN ('SCHEDULED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_visits_booking_uq" ON health.care_visits ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_visits_patient_idx" ON health.care_visits ("patient_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.care_packages (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES health.patients("id") ON DELETE restrict,
	"customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"service_id" uuid REFERENCES "consult_services"("id") ON DELETE set null,
	"name" text NOT NULL,
	"sessions_total" integer NOT NULL,
	"sessions_done" integer NOT NULL DEFAULT 0,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_packages_status" CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "care_packages_sessions" CHECK ("sessions_total" BETWEEN 1 AND 200 AND "sessions_done" BETWEEN 0 AND "sessions_total")
);
--> statement-breakpoint
-- Medical equipment master list (admin) and each store's sale / rent listings.
CREATE TABLE IF NOT EXISTS health.equipment_master (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL DEFAULT 'Mobility',
	"description" text,
	"rx_required" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"sort_order" integer NOT NULL DEFAULT 100,
	CONSTRAINT "equipment_master_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_master_slug_uq" ON health.equipment_master ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.equipment_listings (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"master_id" uuid REFERENCES health.equipment_master("id") ON DELETE set null,
	"name" text NOT NULL,
	"description" text,
	"photo_url" text,
	"for_sale" boolean NOT NULL DEFAULT false,
	"sale_price_paise" bigint,
	"shop_product_id" uuid,
	"for_rent" boolean NOT NULL DEFAULT true,
	"rent_day_paise" bigint,
	"rent_week_paise" bigint,
	"rent_month_paise" bigint,
	"min_rent_days" integer NOT NULL DEFAULT 1,
	"deposit_paise" bigint NOT NULL DEFAULT 0,
	"delivery_paise" bigint NOT NULL DEFAULT 0,
	"stock" integer NOT NULL DEFAULT 1,
	"rx_required" boolean NOT NULL DEFAULT false,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_listings_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "equipment_listings_money" CHECK (coalesce("sale_price_paise", 0) >= 0 AND coalesce("rent_day_paise", 0) >= 0 AND coalesce("rent_week_paise", 0) >= 0 AND coalesce("rent_month_paise", 0) >= 0 AND "deposit_paise" >= 0 AND "delivery_paise" >= 0 AND "stock" >= 0 AND "min_rent_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_listings_shop_idx" ON health.equipment_listings ("shop_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.rentals (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rental_number" text NOT NULL,
	"listing_id" uuid NOT NULL REFERENCES health.equipment_listings("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"patient_id" uuid REFERENCES health.patients("id") ON DELETE set null,
	"suggestion_id" uuid,
	"prescription_id" uuid REFERENCES health.prescriptions("id") ON DELETE set null,
	"item_name" text NOT NULL,
	"quantity" integer NOT NULL DEFAULT 1,
	"period_unit" text NOT NULL,
	"period_count" integer NOT NULL,
	"start_date" date NOT NULL,
	"due_date" date NOT NULL,
	"rent_paise" bigint NOT NULL,
	"deposit_paise" bigint NOT NULL DEFAULT 0,
	"delivery_paise" bigint NOT NULL DEFAULT 0,
	"total_paise" bigint NOT NULL,
	"status" text NOT NULL DEFAULT 'PENDING_PAYMENT',
	"payment_intent_id" uuid,
	"paid_paise" bigint NOT NULL DEFAULT 0,
	"address" jsonb,
	"otp_salt" text NOT NULL,
	"otp_attempts" integer NOT NULL DEFAULT 0,
	"delivered_at" timestamp with time zone,
	"return_pickup_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"condition_note" text,
	"damage_paise" bigint NOT NULL DEFAULT 0,
	"deposit_refund_paise" bigint NOT NULL DEFAULT 0,
	"deposit_refunded_at" timestamp with time zone,
	"extensions" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"commission_bp" integer NOT NULL DEFAULT 200,
	"settled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rentals_unit" CHECK ("period_unit" IN ('DAY', 'WEEK', 'MONTH')),
	CONSTRAINT "rentals_status" CHECK ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'OUT_FOR_DELIVERY', 'ACTIVE', 'RETURN_SCHEDULED', 'RETURNED', 'CLOSED', 'CANCELLED')),
	CONSTRAINT "rentals_money" CHECK ("rent_paise" >= 0 AND "deposit_paise" >= 0 AND "delivery_paise" >= 0 AND "total_paise" >= 0 AND "paid_paise" >= 0 AND "damage_paise" >= 0 AND "damage_paise" <= "deposit_paise" AND "deposit_refund_paise" >= 0 AND "deposit_refund_paise" <= "deposit_paise"),
	CONSTRAINT "rentals_period" CHECK ("period_count" BETWEEN 1 AND 365 AND "quantity" BETWEEN 1 AND 50 AND "start_date" <= "due_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rentals_number_uq" ON health.rentals ("rental_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentals_shop_idx" ON health.rentals ("shop_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentals_customer_idx" ON health.rentals ("customer_id", "created_at" DESC);
--> statement-breakpoint
-- GoKesari Health Prime: listing plans (admin-built; no prices in code), subscriptions, coupons.
CREATE TABLE IF NOT EXISTS health.prime_plans (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"audience" text NOT NULL DEFAULT 'DOCTOR',
	"tier" text NOT NULL,
	"description" text,
	"features" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"quotas" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"prices" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"city" text,
	"specialty" text,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"sort_order" integer NOT NULL DEFAULT 100,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prime_plans_audience" CHECK ("audience" IN ('DOCTOR', 'CARE_PROVIDER', 'EQUIPMENT_STORE')),
	CONSTRAINT "prime_plans_tier" CHECK ("tier" IN ('FREE', 'PRIME', 'PRIME_PLUS')),
	CONSTRAINT "prime_plans_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prime_plans_code_uq" ON health.prime_plans ("code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.prime_subscriptions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"plan_id" uuid NOT NULL REFERENCES health.prime_plans("id") ON DELETE restrict,
	"tier" text NOT NULL,
	"term" text NOT NULL,
	"status" text NOT NULL DEFAULT 'PENDING_PAYMENT',
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"price_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL DEFAULT 0,
	"gst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"coupon_code" text,
	"payment_intent_id" uuid,
	"invoice_number" text,
	"auto_renew_reminders" boolean NOT NULL DEFAULT true,
	"bought_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prime_subscriptions_tier" CHECK ("tier" IN ('FREE', 'PRIME', 'PRIME_PLUS')),
	CONSTRAINT "prime_subscriptions_term" CHECK ("term" IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
	CONSTRAINT "prime_subscriptions_status" CHECK ("status" IN ('PENDING_PAYMENT', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "prime_subscriptions_money" CHECK ("price_paise" >= 0 AND "discount_paise" >= 0 AND "gst_paise" >= 0 AND "total_paise" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prime_subscriptions_shop_idx" ON health.prime_subscriptions ("shop_id", "ends_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prime_subscriptions_invoice_uq" ON health.prime_subscriptions ("invoice_number") WHERE "invoice_number" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.prime_coupons (
	"code" text PRIMARY KEY,
	"percent_off" integer NOT NULL,
	"max_uses" integer,
	"used" integer NOT NULL DEFAULT 0,
	"valid_until" timestamp with time zone,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prime_coupons_pct" CHECK ("percent_off" BETWEEN 1 AND 100),
	CONSTRAINT "prime_coupons_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
-- Virtual numbers (call tracking) behind a telephony provider interface; call log; daily profile analytics.
CREATE TABLE IF NOT EXISTS health.virtual_numbers (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"number" text NOT NULL,
	"forward_to" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"status" text NOT NULL DEFAULT 'ACTIVE',
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "virtual_numbers_status" CHECK ("status" IN ('ACTIVE', 'RELEASED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_numbers_active_uq" ON health.virtual_numbers ("number") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.call_logs (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"virtual_number_id" uuid NOT NULL REFERENCES health.virtual_numbers("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"provider_call_id" text NOT NULL,
	"caller_masked" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer NOT NULL DEFAULT 0,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_logs_status" CHECK ("status" IN ('ANSWERED', 'MISSED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_logs_provider_uq" ON health.call_logs ("provider_call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_logs_shop_idx" ON health.call_logs ("shop_id", "started_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS health.profile_stats (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"day" date NOT NULL,
	"views" integer NOT NULL DEFAULT 0,
	"calls" integer NOT NULL DEFAULT 0,
	"missed_calls" integer NOT NULL DEFAULT 0,
	"bookings" integer NOT NULL DEFAULT 0,
	PRIMARY KEY ("shop_id", "day")
);
--> statement-breakpoint
-- DPDP data requests: export of all my data, account deletion (medical records retained, hidden).
CREATE TABLE IF NOT EXISTS health.data_requests (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"status" text NOT NULL DEFAULT 'OPEN',
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_requests_kind" CHECK ("kind" IN ('EXPORT', 'DELETE')),
	CONSTRAINT "data_requests_status" CHECK ("status" IN ('OPEN', 'DONE', 'REJECTED'))
);
--> statement-breakpoint
-- Number series: prescriptions RX/<yyyy>/<n>, store orders, rentals, Prime invoices.
CREATE TABLE IF NOT EXISTS health.counters (
	"series" text PRIMARY KEY,
	"next_no" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
-- Payment intents may now carry the three health purposes (keeps whatever purposes already exist).
DO $$
DECLARE
	def text;
	vals text[];
BEGIN
	SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
	WHERE c.conname = 'payment_intents_purpose_check' AND c.conrelid = 'public.payment_intents'::regclass;
	IF def IS NULL THEN
		RETURN;
	END IF;
	SELECT array_agg(DISTINCT v) INTO vals FROM (
		SELECT (regexp_matches(def, '''([A-Z_]+)''', 'g'))[1] AS v
		UNION SELECT unnest(ARRAY['HEALTH_RX_ORDER', 'HEALTH_RENTAL', 'HEALTH_PRIME'])
	) s;
	EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
	EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
		(SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
-- Home-care shifts (8 h and 12 h) are consult services: allow services up to 12 hours. A 24-hour shift is a
-- day and a night 12-hour booking (a slot must fit inside one day's hours).
ALTER TABLE "consult_services" DROP CONSTRAINT IF EXISTS "consult_services_duration";
--> statement-breakpoint
ALTER TABLE "consult_services" ADD CONSTRAINT "consult_services_duration" CHECK ("duration_minutes" BETWEEN 5 AND 720);
--> statement-breakpoint
-- Home-care categories in the consultant category list (admin-managed like the others).
INSERT INTO "consult_categories" ("name", "slug", "group_name", "required_doc", "required_doc_label", "default_modes", "sac_code", "sensitive", "sort_order")
SELECT v.name, v.slug, 'Home care', v.doc, v.doc_label, v.modes::text[], '999312', true, v.sort
FROM (VALUES
  ('Nurse (home care)', 'home-nurse', 'OTHER', 'State Nursing Council registration', '{HOME_VISIT,IN_PERSON}', 22),
  ('Massage therapist', 'massage-therapist', 'NONE', NULL, '{HOME_VISIT,IN_PERSON}', 23),
  ('Caretaker / Attendant', 'caretaker-attendant', 'NONE', NULL, '{HOME_VISIT}', 24),
  ('Baby care / Japa', 'baby-care-japa', 'NONE', NULL, '{HOME_VISIT}', 25),
  ('Home sample collection', 'home-sample-collection', 'OTHER', 'Laboratory / phlebotomy certificate', '{HOME_VISIT}', 26)
) AS v(name, slug, doc, doc_label, modes, sort)
WHERE NOT EXISTS (SELECT 1 FROM "consult_categories" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name));
--> statement-breakpoint
INSERT INTO health.equipment_master ("name", "slug", "category", "rx_required", "sort_order")
SELECT v.name, v.slug, v.cat, v.rx, v.sort FROM (VALUES
  ('Wheelchair (manual)', 'wheelchair-manual', 'Mobility', false, 10),
  ('Wheelchair (electric)', 'wheelchair-electric', 'Mobility', false, 11),
  ('Walker', 'walker', 'Mobility', false, 12),
  ('Crutches (pair)', 'crutches', 'Mobility', false, 13),
  ('Commode chair', 'commode-chair', 'Mobility', false, 14),
  ('Hospital bed (manual)', 'hospital-bed-manual', 'Beds', false, 20),
  ('Hospital bed (motorised)', 'hospital-bed-motorised', 'Beds', false, 21),
  ('Air mattress (anti-bedsore)', 'air-mattress', 'Beds', false, 22),
  ('Oxygen concentrator', 'oxygen-concentrator', 'Respiratory', true, 30),
  ('Oxygen cylinder with regulator', 'oxygen-cylinder', 'Respiratory', true, 31),
  ('Nebulizer', 'nebulizer', 'Respiratory', false, 32),
  ('CPAP machine', 'cpap', 'Respiratory', true, 33),
  ('BiPAP machine', 'bipap', 'Respiratory', true, 34),
  ('Suction machine', 'suction-machine', 'Respiratory', true, 35),
  ('BP monitor', 'bp-monitor', 'Monitoring', false, 40),
  ('Glucometer', 'glucometer', 'Monitoring', false, 41),
  ('Pulse oximeter', 'pulse-oximeter', 'Monitoring', false, 42),
  ('Patient monitor (multi-parameter)', 'patient-monitor', 'Monitoring', true, 43),
  ('Infusion / syringe pump', 'infusion-pump', 'Monitoring', true, 44),
  ('Physiotherapy TENS unit', 'tens-unit', 'Therapy', false, 50)
) AS v(name, slug, cat, rx, sort)
WHERE NOT EXISTS (SELECT 1 FROM health.equipment_master m WHERE m."slug" = v.slug);
--> statement-breakpoint
INSERT INTO health.prime_plans ("code", "name", "audience", "tier", "description", "features", "quotas", "prices", "sort_order")
SELECT v.code, v.name, v.aud, v.tier, v.descr, v.features::jsonb, v.quotas::jsonb, v.prices::jsonb, v.sort FROM (VALUES
  ('DOCTOR_FREE', 'Free listing', 'DOCTOR', 'FREE', 'Verified profile, clinic and map, call / WhatsApp button, reviews, booking requests the clinic confirms, prescription pad.',
   '{"instantBooking": false, "priorityPlacement": false, "badge": false, "virtualNumber": false, "messaging": false, "stories": false, "analytics": false, "onlinePayments": false, "multiClinic": false, "staffLogins": false, "featured": false, "advancedAnalytics": false, "printHelper": false}',
   '{"messagesPerMonth": 0, "clinics": 1, "staffLogins": 0}', '{"MONTHLY": 0, "QUARTERLY": 0, "YEARLY": 0}', 10),
  ('DOCTOR_PRIME', 'Prime', 'DOCTOR', 'PRIME', 'Everything in Free + instant online booking, labelled priority placement, Prime badge, virtual number with call tracking, WhatsApp/SMS reminders, patient stories, analytics, online payments.',
   '{"instantBooking": true, "priorityPlacement": true, "badge": true, "virtualNumber": true, "messaging": true, "stories": true, "analytics": true, "onlinePayments": true, "multiClinic": false, "staffLogins": true, "featured": false, "advancedAnalytics": false, "printHelper": false}',
   '{"messagesPerMonth": 500, "clinics": 1, "staffLogins": 2}', '{"MONTHLY": 99900, "QUARTERLY": 269900, "YEARLY": 999900}', 20),
  ('DOCTOR_PRIME_PLUS', 'Prime Plus', 'DOCTOR', 'PRIME_PLUS', 'Everything in Prime + several clinics and doctors, more staff logins and messages, featured on the Health home page, advanced analytics, auto-print helper licence.',
   '{"instantBooking": true, "priorityPlacement": true, "badge": true, "virtualNumber": true, "messaging": true, "stories": true, "analytics": true, "onlinePayments": true, "multiClinic": true, "staffLogins": true, "featured": true, "advancedAnalytics": true, "printHelper": true}',
   '{"messagesPerMonth": 2000, "clinics": 5, "staffLogins": 10}', '{"MONTHLY": 199900, "QUARTERLY": 539900, "YEARLY": 1999900}', 30),
  ('CARE_PRIME', 'Prime (home care)', 'CARE_PROVIDER', 'PRIME', 'Priority placement, Prime badge, call tracking and analytics for home-care providers.',
   '{"instantBooking": true, "priorityPlacement": true, "badge": true, "virtualNumber": true, "messaging": true, "stories": true, "analytics": true, "onlinePayments": true}',
   '{"messagesPerMonth": 300}', '{"MONTHLY": 49900, "QUARTERLY": 134900, "YEARLY": 499900}', 40),
  ('EQUIPMENT_PRIME', 'Prime (equipment store)', 'EQUIPMENT_STORE', 'PRIME', 'Priority placement, Prime badge, call tracking and analytics for medical equipment stores.',
   '{"instantBooking": true, "priorityPlacement": true, "badge": true, "virtualNumber": true, "messaging": true, "analytics": true, "onlinePayments": true}',
   '{"messagesPerMonth": 300}', '{"MONTHLY": 49900, "QUARTERLY": 134900, "YEARLY": 499900}', 50)
) AS v(code, name, aud, tier, descr, features, quotas, prices, sort)
WHERE NOT EXISTS (SELECT 1 FROM health.prime_plans p WHERE p."code" = v.code);
--> statement-breakpoint
-- Starter drug master (admin reviews and extends it; CSV import in Admin → Health). tele_list: Telemedicine
-- Practice Guidelines 2020 — O (any mode), A (first video consult), B (follow-up only), PROHIBITED (never by video).
INSERT INTO health.drug_master ("generic_name", "strength", "form", "schedule", "rx_required", "tele_list", "online_sale_allowed")
SELECT v.g, v.s, v.f, v.sch, v.rx, v.tl, v.online FROM (VALUES
  ('Paracetamol', '500 mg', 'TABLET', 'OTC', false, 'O', true),
  ('Paracetamol', '650 mg', 'TABLET', 'OTC', false, 'O', true),
  ('Paracetamol', '120 mg/5 ml', 'SYRUP', 'OTC', false, 'O', true),
  ('Ibuprofen', '400 mg', 'TABLET', 'H', true, 'A', true),
  ('Cetirizine', '10 mg', 'TABLET', 'H', true, 'O', true),
  ('Levocetirizine', '5 mg', 'TABLET', 'H', true, 'O', true),
  ('Oral rehydration salts', '21 g', 'SACHET', 'OTC', false, 'O', true),
  ('Pantoprazole', '40 mg', 'TABLET', 'H', true, 'A', true),
  ('Omeprazole', '20 mg', 'CAPSULE', 'H', true, 'A', true),
  ('Famotidine', '20 mg', 'TABLET', 'H', true, 'A', true),
  ('Domperidone', '10 mg', 'TABLET', 'H', true, 'A', true),
  ('Ondansetron', '4 mg', 'TABLET', 'H', true, 'A', true),
  ('Amoxicillin', '500 mg', 'CAPSULE', 'H', true, 'A', true),
  ('Amoxicillin + Clavulanic acid', '625 mg', 'TABLET', 'H', true, 'A', true),
  ('Azithromycin', '500 mg', 'TABLET', 'H', true, 'A', true),
  ('Cefixime', '200 mg', 'TABLET', 'H', true, 'A', true),
  ('Ciprofloxacin', '500 mg', 'TABLET', 'H', true, 'A', true),
  ('Doxycycline', '100 mg', 'CAPSULE', 'H', true, 'A', true),
  ('Metronidazole', '400 mg', 'TABLET', 'H', true, 'A', true),
  ('Nitrofurantoin', '100 mg', 'CAPSULE', 'H', true, 'A', true),
  ('Metformin', '500 mg', 'TABLET', 'H', true, 'B', true),
  ('Glimepiride', '1 mg', 'TABLET', 'H', true, 'B', true),
  ('Amlodipine', '5 mg', 'TABLET', 'H', true, 'B', true),
  ('Telmisartan', '40 mg', 'TABLET', 'H', true, 'B', true),
  ('Losartan', '50 mg', 'TABLET', 'H', true, 'B', true),
  ('Atenolol', '50 mg', 'TABLET', 'H', true, 'B', true),
  ('Atorvastatin', '10 mg', 'TABLET', 'H', true, 'B', true),
  ('Rosuvastatin', '10 mg', 'TABLET', 'H', true, 'B', true),
  ('Aspirin', '75 mg', 'TABLET', 'H', true, 'B', true),
  ('Clopidogrel', '75 mg', 'TABLET', 'H', true, 'B', true),
  ('Levothyroxine', '50 mcg', 'TABLET', 'H', true, 'B', true),
  ('Salbutamol', '100 mcg', 'INHALER', 'H', true, 'A', true),
  ('Budesonide + Formoterol', '200/6 mcg', 'INHALER', 'H', true, 'B', true),
  ('Montelukast', '10 mg', 'TABLET', 'H', true, 'A', true),
  ('Prednisolone', '10 mg', 'TABLET', 'H', true, 'B', true),
  ('Diclofenac', '50 mg', 'TABLET', 'H', true, 'A', true),
  ('Diclofenac', '1%', 'GEL', 'OTC', false, 'O', true),
  ('Calcium carbonate + Vitamin D3', '500 mg/250 IU', 'TABLET', 'OTC', false, 'O', true),
  ('Vitamin B complex', NULL, 'CAPSULE', 'OTC', false, 'O', true),
  ('Ferrous sulphate + Folic acid', '100 mg/0.5 mg', 'TABLET', 'OTC', false, 'O', true),
  ('Multivitamin', NULL, 'TABLET', 'OTC', false, 'O', true),
  ('Clotrimazole', '1%', 'CREAM', 'OTC', false, 'O', true),
  ('Mupirocin', '2%', 'OINTMENT', 'H', true, 'A', true),
  ('Betamethasone', '0.1%', 'CREAM', 'H', true, 'A', true),
  ('Ciprofloxacin', '0.3%', 'DROPS', 'H', true, 'A', true),
  ('Carboxymethylcellulose', '0.5%', 'DROPS', 'OTC', false, 'O', true),
  ('Xylometazoline', '0.1%', 'SPRAY', 'OTC', false, 'O', true),
  ('Ambroxol', '30 mg/5 ml', 'SYRUP', 'H', true, 'A', true),
  ('Dextromethorphan', '10 mg/5 ml', 'SYRUP', 'H', true, 'A', true),
  ('Insulin glargine', '100 IU/ml', 'INJECTION', 'H', true, 'B', true),
  ('Sertraline', '50 mg', 'TABLET', 'H', true, 'B', true),
  ('Escitalopram', '10 mg', 'TABLET', 'H', true, 'B', true),
  ('Albendazole', '400 mg', 'TABLET', 'H', true, 'A', true),
  ('Ivermectin', '12 mg', 'TABLET', 'H', true, 'A', true),
  ('Fluconazole', '150 mg', 'TABLET', 'H', true, 'A', true),
  ('Acyclovir', '400 mg', 'TABLET', 'H', true, 'A', true),
  ('Cholecalciferol (Vitamin D3)', '60000 IU', 'CAPSULE', 'H', true, 'A', true),
  ('Hydroxychloroquine', '200 mg', 'TABLET', 'H', true, 'B', true),
  ('Furosemide', '40 mg', 'TABLET', 'H', true, 'B', true),
  ('Spironolactone', '25 mg', 'TABLET', 'H', true, 'B', true),
  ('Mefenamic acid', '250 mg', 'TABLET', 'H', true, 'A', true),
  ('Dicyclomine', '10 mg', 'TABLET', 'H', true, 'A', true),
  ('Lactulose', '10 g/15 ml', 'SOLUTION', 'OTC', false, 'O', true),
  ('Loperamide', '2 mg', 'CAPSULE', 'OTC', false, 'O', true),
  ('Alprazolam', '0.25 mg', 'TABLET', 'NDPS', true, 'PROHIBITED', false),
  ('Clonazepam', '0.5 mg', 'TABLET', 'NDPS', true, 'PROHIBITED', false),
  ('Tramadol', '50 mg', 'TABLET', 'NDPS', true, 'PROHIBITED', false),
  ('Zolpidem', '10 mg', 'TABLET', 'NDPS', true, 'PROHIBITED', false),
  ('Codeine phosphate', '10 mg/5 ml', 'SYRUP', 'NDPS', true, 'PROHIBITED', false),
  ('Methylphenidate', '10 mg', 'TABLET', 'X', true, 'PROHIBITED', false)
) AS v(g, s, f, sch, rx, tl, online)
WHERE NOT EXISTS (SELECT 1 FROM health.drug_master d WHERE lower(d."generic_name") = lower(v.g) AND d."brand_name" IS NULL AND lower(coalesce(d."strength", '')) = lower(coalesce(v.s, '')) AND d."form" = v.f);
--> statement-breakpoint
-- Starter ICD-10 list (WHO) for the diagnosis search; Admin → Health imports the full list as CSV.
INSERT INTO health.icd10_codes ("code", "title", "chapter") VALUES
  ('A01.0', 'Typhoid fever', 'Infectious'), ('A09', 'Infectious gastroenteritis and colitis, unspecified', 'Infectious'),
  ('A15.0', 'Tuberculosis of lung', 'Infectious'), ('A90', 'Dengue fever', 'Infectious'), ('B19.9', 'Unspecified viral hepatitis', 'Infectious'),
  ('B34.9', 'Viral infection, unspecified', 'Infectious'), ('B35.4', 'Tinea corporis', 'Infectious'), ('B37.9', 'Candidiasis, unspecified', 'Infectious'),
  ('B54', 'Unspecified malaria', 'Infectious'), ('U07.1', 'COVID-19, virus identified', 'Special'),
  ('D50.9', 'Iron deficiency anaemia, unspecified', 'Blood'), ('E03.9', 'Hypothyroidism, unspecified', 'Endocrine'),
  ('E05.9', 'Thyrotoxicosis, unspecified', 'Endocrine'), ('E10.9', 'Type 1 diabetes mellitus without complications', 'Endocrine'),
  ('E11.9', 'Type 2 diabetes mellitus without complications', 'Endocrine'), ('E28.2', 'Polycystic ovarian syndrome', 'Endocrine'),
  ('E55.9', 'Vitamin D deficiency, unspecified', 'Endocrine'), ('E66.9', 'Obesity, unspecified', 'Endocrine'),
  ('E78.5', 'Hyperlipidaemia, unspecified', 'Endocrine'), ('F32.9', 'Depressive episode, unspecified', 'Mental'),
  ('F41.1', 'Generalized anxiety disorder', 'Mental'), ('F90.0', 'Disturbance of activity and attention (ADHD)', 'Mental'),
  ('G40.9', 'Epilepsy, unspecified', 'Nervous'), ('G43.9', 'Migraine, unspecified', 'Nervous'), ('G44.2', 'Tension-type headache', 'Nervous'),
  ('G47.0', 'Disorders of initiating and maintaining sleep (insomnia)', 'Nervous'), ('G56.0', 'Carpal tunnel syndrome', 'Nervous'),
  ('H10.9', 'Conjunctivitis, unspecified', 'Eye'), ('H26.9', 'Cataract, unspecified', 'Eye'), ('H52.1', 'Myopia', 'Eye'),
  ('H61.2', 'Impacted cerumen', 'Ear'), ('H66.9', 'Otitis media, unspecified', 'Ear'),
  ('I10', 'Essential (primary) hypertension', 'Circulatory'), ('I20.9', 'Angina pectoris, unspecified', 'Circulatory'),
  ('I21.9', 'Acute myocardial infarction, unspecified', 'Circulatory'), ('I25.1', 'Atherosclerotic heart disease', 'Circulatory'),
  ('I48', 'Atrial fibrillation and flutter', 'Circulatory'), ('I50.9', 'Heart failure, unspecified', 'Circulatory'),
  ('I63.9', 'Cerebral infarction, unspecified', 'Circulatory'), ('J00', 'Acute nasopharyngitis (common cold)', 'Respiratory'),
  ('J01.9', 'Acute sinusitis, unspecified', 'Respiratory'), ('J02.9', 'Acute pharyngitis, unspecified', 'Respiratory'),
  ('J03.9', 'Acute tonsillitis, unspecified', 'Respiratory'), ('J06.9', 'Acute upper respiratory infection, unspecified', 'Respiratory'),
  ('J11.1', 'Influenza with other respiratory manifestations', 'Respiratory'), ('J18.9', 'Pneumonia, unspecified', 'Respiratory'),
  ('J20.9', 'Acute bronchitis, unspecified', 'Respiratory'), ('J30.4', 'Allergic rhinitis, unspecified', 'Respiratory'),
  ('J44.9', 'Chronic obstructive pulmonary disease, unspecified', 'Respiratory'), ('J45.9', 'Asthma, unspecified', 'Respiratory'),
  ('K02.9', 'Dental caries, unspecified', 'Digestive'), ('K05.1', 'Chronic gingivitis', 'Digestive'), ('K21.9', 'Gastro-oesophageal reflux disease without oesophagitis', 'Digestive'),
  ('K29.7', 'Gastritis, unspecified', 'Digestive'), ('K30', 'Functional dyspepsia', 'Digestive'), ('K35.8', 'Acute appendicitis, other and unspecified', 'Digestive'),
  ('K40.9', 'Inguinal hernia without obstruction or gangrene', 'Digestive'), ('K52.9', 'Noninfective gastroenteritis and colitis, unspecified', 'Digestive'),
  ('K58.9', 'Irritable bowel syndrome without diarrhoea', 'Digestive'), ('K59.0', 'Constipation', 'Digestive'),
  ('K76.0', 'Fatty (change of) liver, not elsewhere classified', 'Digestive'), ('K80.2', 'Calculus of gallbladder without cholecystitis', 'Digestive'),
  ('L20.9', 'Atopic dermatitis, unspecified', 'Skin'), ('L23.9', 'Allergic contact dermatitis, unspecified cause', 'Skin'),
  ('L30.9', 'Dermatitis, unspecified', 'Skin'), ('L50.9', 'Urticaria, unspecified', 'Skin'), ('L70.0', 'Acne vulgaris', 'Skin'),
  ('M06.9', 'Rheumatoid arthritis, unspecified', 'Musculoskeletal'), ('M10.9', 'Gout, unspecified', 'Musculoskeletal'),
  ('M17.9', 'Gonarthrosis (knee osteoarthritis), unspecified', 'Musculoskeletal'), ('M54.2', 'Cervicalgia', 'Musculoskeletal'),
  ('M54.5', 'Low back pain', 'Musculoskeletal'), ('M75.0', 'Adhesive capsulitis of shoulder (frozen shoulder)', 'Musculoskeletal'),
  ('M79.1', 'Myalgia', 'Musculoskeletal'), ('M81.0', 'Postmenopausal osteoporosis', 'Musculoskeletal'),
  ('N18.9', 'Chronic kidney disease, unspecified', 'Genitourinary'), ('N20.0', 'Calculus of kidney', 'Genitourinary'),
  ('N39.0', 'Urinary tract infection, site not specified', 'Genitourinary'), ('N92.0', 'Excessive and frequent menstruation with regular cycle', 'Genitourinary'),
  ('N94.6', 'Dysmenorrhoea, unspecified', 'Genitourinary'), ('Z34.9', 'Supervision of normal pregnancy, unspecified', 'Factors'),
  ('R05', 'Cough', 'Symptoms'), ('R07.4', 'Chest pain, unspecified', 'Symptoms'), ('R10.4', 'Other and unspecified abdominal pain', 'Symptoms'),
  ('R11', 'Nausea and vomiting', 'Symptoms'), ('R42', 'Dizziness and giddiness', 'Symptoms'), ('R50.9', 'Fever, unspecified', 'Symptoms'),
  ('R51', 'Headache', 'Symptoms'), ('R53', 'Malaise and fatigue', 'Symptoms'), ('S83.6', 'Sprain of other and unspecified parts of knee', 'Injury'),
  ('S93.4', 'Sprain of ankle', 'Injury'), ('T14.1', 'Open wound of unspecified body region', 'Injury'), ('T78.4', 'Allergy, unspecified', 'Injury'),
  ('Z00.0', 'General medical examination', 'Factors'), ('Z23', 'Need for immunization', 'Factors'), ('Z71.3', 'Dietary counselling and surveillance', 'Factors')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
-- Launch switch (owner, 20-Nov-2026 14.10 IST: "switch Health on in prod at launch"). GoKesari Health needs consultant
-- appointments on as well. Merged over the stored value exactly as Admin → Settings would (the rest of each rule
-- keeps its defaults or earlier admin choices) and written to the audit log. Turn either off in Admin → Settings.
INSERT INTO "platform_settings" ("key", "value", "updated_at")
VALUES ('consultBooking', '{"enabled": true}'::jsonb, now()), ('health', '{"enabled": true}'::jsonb, now())
ON CONFLICT ("key") DO UPDATE SET "value" = "platform_settings"."value" || '{"enabled": true}'::jsonb, "updated_at" = now();
--> statement-breakpoint
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "new_value")
VALUES
  ('setting.changed', 'platform_setting', 'consultBooking', '{"enabled": true, "by": "migration 0154_health — owner launch decision 20-Nov-2026"}'::jsonb),
  ('setting.changed', 'platform_setting', 'health', '{"enabled": true, "by": "migration 0154_health — owner launch decision 20-Nov-2026"}'::jsonb);
