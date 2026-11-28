-- Shop onboarding v3 order (owner, 28-Nov-2026; docs/onboarding-v2-2026-11/README.md "v3 order").
-- A registration started while flag onboarding_v2 is on keeps flow_version 'v2' (every v2 safeguard — the fee paid on
-- the draft, the ledger sweep, the agreement gate — applies unchanged) and gets flow_order 'v3': referral → identity
-- (the customer login sheet) → seller agreement accepted early (template text, ticks + typed name) → GST / PAN → fee →
-- shop type → address + pin → live → licences after go-live. Drafts started before keep flow_order NULL (the v2 order).
-- The early acceptance is stored on the draft and applied to the personalised agreement when the shop row is created.
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "flow_order" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_name" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_ip" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_user_agent" text;
--> statement-breakpoint
-- [{ docType, version, legalDocumentId, templateSha256 }] of the published texts shown, plus the ticks given.
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_documents" jsonb;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "early_agreement_applied_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" DROP CONSTRAINT IF EXISTS "shop_registration_drafts_flow_order";
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD CONSTRAINT "shop_registration_drafts_flow_order" CHECK ("flow_order" IS NULL OR "flow_order" in ('v3'));
--> statement-breakpoint
-- Owner, 28-Nov-2026 (~11.50 IST): an EXPIRED licence at registration is promised for renewal instead of blocking.
-- The entry stays option LATER / status PROMISED (chased by the documents follow-up like a missing promised one);
-- expired_on is the expiry date the owner was shown, renewal_promised_at when the renewal was promised.
ALTER TABLE "registration_licence_entries" ADD COLUMN IF NOT EXISTS "expired_on" text;
--> statement-breakpoint
ALTER TABLE "registration_licence_entries" ADD COLUMN IF NOT EXISTS "renewal_promised_at" timestamp with time zone;
