-- split: seller
-- D-69 (owner, 25 Oct 2026): an owner can close the shop for now (orders_paused, as
-- before) or permanently (status INACTIVE, lifecycle CLOSED; reopening is for
-- operations), and a shop whose membership was not renewed is not online.
-- membership_valid_until is set from the registration / renewal payments; null
-- (every shop before this) means no end date. closed_by has no foreign key:
-- users live in the customer database on the split layout.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "membership_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "closure_reason" text;
