-- split: core
-- Owner, 28 Oct 2026: a referral code is MANDATORY at shop registration (Add my shop,
-- self-registration). Sets referral_required_shop once and records it in the change log, as
-- Admin → Referral settings would; an admin can still switch it back there. Only a site still
-- on OPTIONAL changes, so a rerun records nothing. Shops already registered are unaffected.
INSERT INTO "referral_setting_changes" ("setting_key", "old_value", "new_value", "changed_by_email", "changed_by_role")
SELECT 'referral_required_shop', COALESCE((SELECT "value" FROM "referral_settings" WHERE "key" = 'referral_required_shop'), 'OPTIONAL'), 'MANDATORY', 'owner request 28 Oct 2026 (migration 0100)', 'SYSTEM'
WHERE COALESCE((SELECT "value" FROM "referral_settings" WHERE "key" = 'referral_required_shop'), 'OPTIONAL') <> 'MANDATORY';--> statement-breakpoint
INSERT INTO "referral_settings" ("key", "value", "updated_at") VALUES ('referral_required_shop', 'MANDATORY', now())
ON CONFLICT ("key") DO UPDATE SET "value" = 'MANDATORY', "updated_at" = now()
WHERE "referral_settings"."value" <> 'MANDATORY';
