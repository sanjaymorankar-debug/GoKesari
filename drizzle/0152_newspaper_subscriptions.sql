-- Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11).
-- 1. A subscription may run on chosen days of the month (MONTHLY + month_days) — monthly and fortnightly magazines.
-- 2. Subscriptions submitted together (several titles from one vendor) share a bundle_id.
-- 3. periodical_titles: what a newspaper / magazine product is and when it comes out.
-- 4. Two catalogue categories under the new NEWSPAPER_VENDOR shop type, and a starter list of titles
--    sold by the copy (no price: each vendor sets their own).
-- Additive only; milk subscriptions are untouched. Rollback: scripts/rollback-0152.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'subscription_frequency' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."subscription_frequency" ADD VALUE IF NOT EXISTS ''MONTHLY''';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "month_days" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "bundle_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_bundle_idx" ON "subscriptions" ("bundle_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "periodical_titles" (
	"product_id" uuid PRIMARY KEY NOT NULL REFERENCES "products"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"language" text NOT NULL,
	"publisher" text,
	"publication" text DEFAULT 'DAILY' NOT NULL,
	"issue_weekday" integer,
	"issue_month_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodical_titles_kind" CHECK ("kind" IN ('NEWSPAPER', 'MAGAZINE')),
	CONSTRAINT "periodical_titles_publication" CHECK ("publication" IN ('DAILY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY')),
	CONSTRAINT "periodical_titles_issue_weekday" CHECK ("issue_weekday" IS NULL OR "issue_weekday" BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "periodical_titles_kind_idx" ON "periodical_titles" ("kind");
--> statement-breakpoint
-- The two categories. A live category with the same name (made by staff) is used as it is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_categories WHERE deleted_at IS NULL AND (slug = 'newspapers' OR lower(name) = 'newspapers')) THEN
    INSERT INTO product_categories (department, name, slug, description, sort_order)
    VALUES ('NEWSPAPER_VENDOR', 'Newspapers',
            CASE WHEN EXISTS (SELECT 1 FROM product_categories WHERE slug = 'newspapers')
                 THEN 'newspapers-' || left(gen_random_uuid()::text, 8) ELSE 'newspapers' END,
            'Daily newspapers in every language, delivered to your door by a local vendor.', 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM product_categories WHERE deleted_at IS NULL AND (slug = 'magazines-periodicals' OR lower(name) = 'magazines & periodicals')) THEN
    INSERT INTO product_categories (department, name, slug, description, sort_order)
    VALUES ('NEWSPAPER_VENDOR', 'Magazines & Periodicals',
            CASE WHEN EXISTS (SELECT 1 FROM product_categories WHERE slug = 'magazines-periodicals')
                 THEN 'magazines-periodicals-' || left(gen_random_uuid()::text, 8) ELSE 'magazines-periodicals' END,
            'Weekly, fortnightly and monthly magazines and periodicals.', 20);
  END IF;
END $$;
--> statement-breakpoint
-- The starter titles: one copy is the unit; subscribable; no MRP (the vendor sets the price).
WITH titles (slug, name, kind, language, publisher, publication) AS (
  VALUES
    ('newspaper-the-times-of-india', 'The Times of India', 'NEWSPAPER', 'English', 'Bennett, Coleman & Co.', 'DAILY'),
    ('newspaper-hindustan-times', 'Hindustan Times', 'NEWSPAPER', 'English', 'HT Media', 'DAILY'),
    ('newspaper-the-hindu', 'The Hindu', 'NEWSPAPER', 'English', 'The Hindu Group', 'DAILY'),
    ('newspaper-the-indian-express', 'The Indian Express', 'NEWSPAPER', 'English', 'The Indian Express Group', 'DAILY'),
    ('newspaper-the-economic-times', 'The Economic Times', 'NEWSPAPER', 'English', 'Bennett, Coleman & Co.', 'DAILY'),
    ('newspaper-mint', 'Mint', 'NEWSPAPER', 'English', 'HT Media', 'DAILY'),
    ('newspaper-business-standard', 'Business Standard', 'NEWSPAPER', 'English', 'Business Standard', 'DAILY'),
    ('newspaper-mid-day', 'Mid-Day', 'NEWSPAPER', 'English', 'Mid-Day Infomedia', 'DAILY'),
    ('newspaper-deccan-chronicle', 'Deccan Chronicle', 'NEWSPAPER', 'English', 'Deccan Chronicle Holdings', 'DAILY'),
    ('newspaper-deccan-herald', 'Deccan Herald', 'NEWSPAPER', 'English', 'The Printers (Mysore)', 'DAILY'),
    ('newspaper-the-telegraph', 'The Telegraph', 'NEWSPAPER', 'English', 'ABP Group', 'DAILY'),
    ('newspaper-dainik-bhaskar', 'Dainik Bhaskar', 'NEWSPAPER', 'Hindi', 'DB Corp', 'DAILY'),
    ('newspaper-dainik-jagran', 'Dainik Jagran', 'NEWSPAPER', 'Hindi', 'Jagran Prakashan', 'DAILY'),
    ('newspaper-amar-ujala', 'Amar Ujala', 'NEWSPAPER', 'Hindi', 'Amar Ujala', 'DAILY'),
    ('newspaper-hindustan', 'Hindustan', 'NEWSPAPER', 'Hindi', 'HT Media', 'DAILY'),
    ('newspaper-navbharat-times', 'Navbharat Times', 'NEWSPAPER', 'Hindi', 'Bennett, Coleman & Co.', 'DAILY'),
    ('newspaper-punjab-kesari', 'Punjab Kesari', 'NEWSPAPER', 'Hindi', 'Punjab Kesari Group', 'DAILY'),
    ('newspaper-rajasthan-patrika', 'Rajasthan Patrika', 'NEWSPAPER', 'Hindi', 'Patrika Group', 'DAILY'),
    ('newspaper-lokmat', 'Lokmat', 'NEWSPAPER', 'Marathi', 'Lokmat Media', 'DAILY'),
    ('newspaper-loksatta', 'Loksatta', 'NEWSPAPER', 'Marathi', 'The Indian Express Group', 'DAILY'),
    ('newspaper-maharashtra-times', 'Maharashtra Times', 'NEWSPAPER', 'Marathi', 'Bennett, Coleman & Co.', 'DAILY'),
    ('newspaper-sakal', 'Sakal', 'NEWSPAPER', 'Marathi', 'Sakal Media Group', 'DAILY'),
    ('newspaper-pudhari', 'Pudhari', 'NEWSPAPER', 'Marathi', 'Pudhari Publications', 'DAILY'),
    ('newspaper-saamana', 'Saamana', 'NEWSPAPER', 'Marathi', 'Prabodhan Prakashan', 'DAILY'),
    ('newspaper-gujarat-samachar', 'Gujarat Samachar', 'NEWSPAPER', 'Gujarati', 'Lok Prakashan', 'DAILY'),
    ('newspaper-sandesh', 'Sandesh', 'NEWSPAPER', 'Gujarati', 'Sandesh', 'DAILY'),
    ('newspaper-divya-bhaskar', 'Divya Bhaskar', 'NEWSPAPER', 'Gujarati', 'DB Corp', 'DAILY'),
    ('newspaper-malayala-manorama', 'Malayala Manorama', 'NEWSPAPER', 'Malayalam', 'Malayala Manorama', 'DAILY'),
    ('newspaper-mathrubhumi', 'Mathrubhumi', 'NEWSPAPER', 'Malayalam', 'Mathrubhumi', 'DAILY'),
    ('newspaper-eenadu', 'Eenadu', 'NEWSPAPER', 'Telugu', 'Ushodaya Enterprises', 'DAILY'),
    ('newspaper-daily-thanthi', 'Daily Thanthi', 'NEWSPAPER', 'Tamil', NULL, 'DAILY'),
    ('newspaper-dinamalar', 'Dinamalar', 'NEWSPAPER', 'Tamil', NULL, 'DAILY'),
    ('newspaper-vijay-karnataka', 'Vijay Karnataka', 'NEWSPAPER', 'Kannada', 'Bennett, Coleman & Co.', 'DAILY'),
    ('newspaper-prajavani', 'Prajavani', 'NEWSPAPER', 'Kannada', 'The Printers (Mysore)', 'DAILY'),
    ('newspaper-anandabazar-patrika', 'Anandabazar Patrika', 'NEWSPAPER', 'Bengali', 'ABP Group', 'DAILY'),
    ('magazine-india-today', 'India Today', 'MAGAZINE', 'English', 'India Today Group', 'WEEKLY'),
    ('magazine-the-week', 'The Week', 'MAGAZINE', 'English', 'Malayala Manorama', 'WEEKLY'),
    ('magazine-frontline', 'Frontline', 'MAGAZINE', 'English', 'The Hindu Group', 'FORTNIGHTLY'),
    ('magazine-chitralekha', 'Chitralekha', 'MAGAZINE', 'Gujarati', NULL, 'WEEKLY'),
    ('magazine-saptahik-sakal', 'Saptahik Sakal', 'MAGAZINE', 'Marathi', 'Sakal Media Group', 'WEEKLY'),
    ('magazine-grihshobha', 'Grihshobha', 'MAGAZINE', 'Hindi', 'Delhi Press', 'FORTNIGHTLY'),
    ('magazine-sarita', 'Sarita', 'MAGAZINE', 'Hindi', 'Delhi Press', 'FORTNIGHTLY'),
    ('magazine-champak', 'Champak', 'MAGAZINE', 'Hindi', 'Delhi Press', 'FORTNIGHTLY'),
    ('magazine-vanitha', 'Vanitha', 'MAGAZINE', 'Malayalam', 'Malayala Manorama', 'FORTNIGHTLY'),
    ('magazine-tinkle', 'Tinkle', 'MAGAZINE', 'English', 'Amar Chitra Katha', 'MONTHLY'),
    ('magazine-readers-digest', 'Reader''s Digest', 'MAGAZINE', 'English', NULL, 'MONTHLY'),
    ('magazine-competition-success-review', 'Competition Success Review', 'MAGAZINE', 'English', NULL, 'MONTHLY'),
    ('magazine-pratiyogita-darpan', 'Pratiyogita Darpan', 'MAGAZINE', 'Hindi', 'Upkar Prakashan', 'MONTHLY'),
    ('magazine-yojana', 'Yojana', 'MAGAZINE', 'English', 'Publications Division, Government of India', 'MONTHLY'),
    ('magazine-kurukshetra', 'Kurukshetra', 'MAGAZINE', 'English', 'Publications Division, Government of India', 'MONTHLY'),
    ('magazine-grihlakshmi', 'Grihlakshmi', 'MAGAZINE', 'Hindi', NULL, 'MONTHLY')
),
category AS (
  SELECT
    (SELECT id FROM product_categories WHERE deleted_at IS NULL AND (slug = 'newspapers' OR lower(name) = 'newspapers')
      ORDER BY (slug = 'newspapers') DESC LIMIT 1) AS newspapers,
    (SELECT id FROM product_categories WHERE deleted_at IS NULL AND (slug = 'magazines-periodicals' OR lower(name) = 'magazines & periodicals')
      ORDER BY (slug = 'magazines-periodicals') DESC LIMIT 1) AS magazines
),
inserted AS (
  INSERT INTO products (category_id, name, slug, description, unit, unit_size_milli, subscribable, kind)
  SELECT CASE WHEN t.kind = 'MAGAZINE' THEN c.magazines ELSE c.newspapers END,
         t.name, t.slug,
         t.language || ' ' || lower(t.publication) || ' ' || CASE WHEN t.kind = 'MAGAZINE' THEN 'magazine' ELSE 'newspaper' END
           || COALESCE(' — ' || t.publisher, '') || '. Sold by the copy; subscribe for home delivery.',
         'piece', 1000, true, 'PACKAGED'
    FROM titles t CROSS JOIN category c
   WHERE c.newspapers IS NOT NULL AND c.magazines IS NOT NULL
  ON CONFLICT (slug) DO NOTHING
  RETURNING id, slug
)
INSERT INTO periodical_titles (product_id, kind, language, publisher, publication)
SELECT p.id, t.kind, t.language, t.publisher, t.publication
  FROM titles t
  JOIN (SELECT id, slug FROM inserted UNION SELECT id, slug FROM products) p ON p.slug = t.slug
ON CONFLICT (product_id) DO NOTHING;
