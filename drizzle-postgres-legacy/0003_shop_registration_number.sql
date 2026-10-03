-- Registration numbers are allocated by a sequence for the same reason product
-- codes are: two operators registering shops at the same moment must not
-- collide on the unique index.
CREATE SEQUENCE IF NOT EXISTS "shop_registration_seq" AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint

-- Backfill existing shops before the column can be made NOT NULL.
UPDATE "shops"
SET "registration_number" = 'BKS-' || LPAD(nextval('shop_registration_seq')::text, 6, '0')
WHERE "registration_number" IS NULL;--> statement-breakpoint

ALTER TABLE "shops" ALTER COLUMN "registration_number" SET DEFAULT ('BKS-' || lpad(nextval('shop_registration_seq')::text, 6, '0'));--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "registration_number" SET NOT NULL;--> statement-breakpoint

-- Existing shops predate the fee schedule, so they carry no snapshot. Give them
-- the registration date implied by their creation so the owner's registration
-- panel has something truthful to show.
UPDATE "shops"
SET "registration_date" = "created_at"::date
WHERE "registration_date" IS NULL;
