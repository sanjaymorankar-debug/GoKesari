-- Shop welcome kit, personalised (docs/shop-welcome-kit-2026-11, owner brief 26-Nov-2026).
--
-- * inv_settings.banner_upi_qr: the text of a payment QR the owner uploaded for the banner's "Pay here (UPI)"
--   panel (checked in the app: upi://pay, a valid payee address, no fixed amount). Optional; when empty the
--   banner builds the UPI QR from inv_settings.upi_vpa, and with neither the banner has no UPI panel.
-- * Rule shopWelcomeKit.safetyNetFrom = the moment this migration ran: from then on the every-15-minutes
--   safety net queues the welcome kit for any shop that went live without one. Shops live before this
--   moment are never e-mailed automatically (admin bulk send only). A stored value is kept (re-run safe).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0213-shop-banner-upi-qr.sql.
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "banner_upi_qr" text;
--> statement-breakpoint
INSERT INTO "platform_settings" ("key", "value", "updated_at")
VALUES ('shopWelcomeKit', jsonb_build_object('safetyNetEnabled', true, 'safetyNetFrom', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now())
ON CONFLICT ("key") DO NOTHING;
