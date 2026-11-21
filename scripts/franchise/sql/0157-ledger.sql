-- Ledger: link columns (all nullable) and the three franchise entry types, keeping every existing type.
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "franchise_allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "franchise_zone_id" text;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "config_version" integer;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "calc_run_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_franchise_idx" ON "dealer_commission_ledger" ("franchise_allocation_id") WHERE "franchise_allocation_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
	def text;
	vals text[];
BEGIN
	SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
	WHERE c.conname = 'dealer_commission_ledger_entry_type' AND c.conrelid = 'public.dealer_commission_ledger'::regclass;
	IF def IS NULL THEN
		RETURN;
	END IF;
	SELECT array_agg(DISTINCT v) INTO vals FROM (
		SELECT (regexp_matches(def, '''([A-Z0-9_]+)''', 'g'))[1] AS v
		UNION SELECT unnest(ARRAY['ONE_TIME_FRANCHISE', 'RECURRING_BASE', 'RECURRING_BONUS'])
	) s;
	EXECUTE 'ALTER TABLE public.dealer_commission_ledger DROP CONSTRAINT dealer_commission_ledger_entry_type';
	EXECUTE format('ALTER TABLE public.dealer_commission_ledger ADD CONSTRAINT dealer_commission_ledger_entry_type CHECK ("entry_type" IN (%s))',
		(SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
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
		UNION SELECT unnest(ARRAY['FRANCHISE_FEE'])
	) s;
	EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
	EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
		(SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
