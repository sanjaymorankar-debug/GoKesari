-- Dealership & Franchise Platform, Phase 6: roles, maker-checker, regions (owner brief 23-Nov-2026, decision D9;
-- docs/dealer-platform/PHASE_6_ROLES_DASHBOARDS.md).
--
-- * user_role + BUSINESS_ADMIN, DEALERSHIP_MANAGER, FINANCE_ADMIN, REGIONAL_ADMIN, AUDITOR, READ_ONLY. A role does
--   nothing until an admin gives it to someone (the owner assigns people later). Super Admin stays the existing
--   ADMIN + SUPER_ADMIN_EMAIL (RBAC v2 bootstrap rule).
-- * staff_region_scopes: the states / districts a Regional Admin works in.
-- * feature flag dealer_platform_four_eye (OFF): when ON, publishing or changing a scheme's status, a dealer's
--   scheme change and a franchise refund wait for a second approver (Admin → Approvals).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0181.sql (enum values cannot be dropped; unused, inert).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'user_role' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''BUSINESS_ADMIN''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''DEALERSHIP_MANAGER''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''FINANCE_ADMIN''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''REGIONAL_ADMIN''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''AUDITOR''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''READ_ONLY''';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_region_scopes" (
  "user_id" uuid PRIMARY KEY,
  "area_codes" text[] NOT NULL DEFAULT '{}',
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('dealer_platform_four_eye', false) ON CONFLICT DO NOTHING;
