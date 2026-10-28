-- split: seller
-- Dealer programme (docs/dealer-programme, step 1): the territory hierarchy
-- Maharashtra → Region (division) → District → Taluka/City → Locality. ADDITIVE ONLY.
-- Seeded: the state, its 6 divisions and 36 districts, and for the Pune pilot its cities and a
-- first set of localities. A PIN code finds its area by the longest matching prefix in
-- geo_area_pincodes (a 6-digit locality PIN beats the district's "411"). Admins add more.
-- short_code is the district part of a dealer code (GKS-MH-PUN-…), unique among districts.
CREATE TABLE IF NOT EXISTS "geo_areas" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"parent_code" text REFERENCES "geo_areas"("code") ON DELETE RESTRICT,
	"short_code" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_areas_level" CHECK ("level" in ('STATE', 'REGION', 'DISTRICT', 'TALUKA', 'LOCALITY')),
	CONSTRAINT "geo_areas_status" CHECK ("status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "geo_areas_parent" CHECK (("level" = 'STATE') = ("parent_code" IS NULL)),
	CONSTRAINT "geo_areas_short_code" CHECK ("short_code" IS NULL OR "short_code" ~ '^[A-Z]{2,4}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geo_areas_parent_idx" ON "geo_areas" ("parent_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "geo_areas_district_short_code_unique" ON "geo_areas" ("short_code") WHERE "level" = 'DISTRICT';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "geo_area_pincodes" (
	"pincode_prefix" text NOT NULL,
	"area_code" text NOT NULL REFERENCES "geo_areas"("code") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_area_pincodes_pk" PRIMARY KEY ("pincode_prefix", "area_code"),
	CONSTRAINT "geo_area_pincodes_prefix" CHECK ("pincode_prefix" ~ '^[1-9][0-9]{0,5}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geo_area_pincodes_prefix_idx" ON "geo_area_pincodes" ("pincode_prefix");--> statement-breakpoint
INSERT INTO "geo_areas" ("code", "name", "level", "parent_code", "short_code") VALUES
	('MH', 'Maharashtra', 'STATE', NULL, 'MH'),
	('MH-R-KON', 'Konkan Division', 'REGION', 'MH', NULL),
	('MH-R-PUN', 'Pune Division', 'REGION', 'MH', NULL),
	('MH-R-NSK', 'Nashik Division', 'REGION', 'MH', NULL),
	('MH-R-CSN', 'Chhatrapati Sambhajinagar Division', 'REGION', 'MH', NULL),
	('MH-R-AMT', 'Amravati Division', 'REGION', 'MH', NULL),
	('MH-R-NGP', 'Nagpur Division', 'REGION', 'MH', NULL)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "geo_areas" ("code", "name", "level", "parent_code", "short_code") VALUES
	('MH-MUM', 'Mumbai City', 'DISTRICT', 'MH-R-KON', 'MUM'),
	('MH-MSU', 'Mumbai Suburban', 'DISTRICT', 'MH-R-KON', 'MSU'),
	('MH-THN', 'Thane', 'DISTRICT', 'MH-R-KON', 'THN'),
	('MH-PLG', 'Palghar', 'DISTRICT', 'MH-R-KON', 'PLG'),
	('MH-RGD', 'Raigad', 'DISTRICT', 'MH-R-KON', 'RGD'),
	('MH-RTN', 'Ratnagiri', 'DISTRICT', 'MH-R-KON', 'RTN'),
	('MH-SDG', 'Sindhudurg', 'DISTRICT', 'MH-R-KON', 'SDG'),
	('MH-PUN', 'Pune', 'DISTRICT', 'MH-R-PUN', 'PUN'),
	('MH-STR', 'Satara', 'DISTRICT', 'MH-R-PUN', 'STR'),
	('MH-SGL', 'Sangli', 'DISTRICT', 'MH-R-PUN', 'SGL'),
	('MH-SLP', 'Solapur', 'DISTRICT', 'MH-R-PUN', 'SLP'),
	('MH-KOP', 'Kolhapur', 'DISTRICT', 'MH-R-PUN', 'KOP'),
	('MH-NSK', 'Nashik', 'DISTRICT', 'MH-R-NSK', 'NSK'),
	('MH-DHL', 'Dhule', 'DISTRICT', 'MH-R-NSK', 'DHL'),
	('MH-NDB', 'Nandurbar', 'DISTRICT', 'MH-R-NSK', 'NDB'),
	('MH-JLG', 'Jalgaon', 'DISTRICT', 'MH-R-NSK', 'JLG'),
	('MH-AHN', 'Ahilyanagar', 'DISTRICT', 'MH-R-NSK', 'AHN'),
	('MH-CSN', 'Chhatrapati Sambhajinagar', 'DISTRICT', 'MH-R-CSN', 'CSN'),
	('MH-JLN', 'Jalna', 'DISTRICT', 'MH-R-CSN', 'JLN'),
	('MH-BED', 'Beed', 'DISTRICT', 'MH-R-CSN', 'BED'),
	('MH-DRV', 'Dharashiv', 'DISTRICT', 'MH-R-CSN', 'DRV'),
	('MH-LTR', 'Latur', 'DISTRICT', 'MH-R-CSN', 'LTR'),
	('MH-NND', 'Nanded', 'DISTRICT', 'MH-R-CSN', 'NND'),
	('MH-PBN', 'Parbhani', 'DISTRICT', 'MH-R-CSN', 'PBN'),
	('MH-HGL', 'Hingoli', 'DISTRICT', 'MH-R-CSN', 'HGL'),
	('MH-AMT', 'Amravati', 'DISTRICT', 'MH-R-AMT', 'AMT'),
	('MH-AKL', 'Akola', 'DISTRICT', 'MH-R-AMT', 'AKL'),
	('MH-WSM', 'Washim', 'DISTRICT', 'MH-R-AMT', 'WSM'),
	('MH-BLD', 'Buldhana', 'DISTRICT', 'MH-R-AMT', 'BLD'),
	('MH-YTL', 'Yavatmal', 'DISTRICT', 'MH-R-AMT', 'YTL'),
	('MH-NGP', 'Nagpur', 'DISTRICT', 'MH-R-NGP', 'NGP'),
	('MH-WRD', 'Wardha', 'DISTRICT', 'MH-R-NGP', 'WRD'),
	('MH-BND', 'Bhandara', 'DISTRICT', 'MH-R-NGP', 'BND'),
	('MH-GND', 'Gondia', 'DISTRICT', 'MH-R-NGP', 'GND'),
	('MH-CHD', 'Chandrapur', 'DISTRICT', 'MH-R-NGP', 'CHD'),
	('MH-GDC', 'Gadchiroli', 'DISTRICT', 'MH-R-NGP', 'GDC')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "geo_areas" ("code", "name", "level", "parent_code") VALUES
	('MH-PUN-PMC', 'Pune City', 'TALUKA', 'MH-PUN'),
	('MH-PUN-PCMC', 'Pimpri-Chinchwad', 'TALUKA', 'MH-PUN'),
	('MH-PUN-HVL', 'Haveli', 'TALUKA', 'MH-PUN')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "geo_areas" ("code", "name", "level", "parent_code") VALUES
	('MH-PUN-PMC-SHIVAJINAGAR', 'Shivajinagar', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PMC-AUNDH', 'Aundh', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PMC-KOTHRUD', 'Kothrud', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PMC-HADAPSAR', 'Hadapsar', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PMC-VIMANNAGAR', 'Viman Nagar', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PMC-BANER', 'Baner', 'LOCALITY', 'MH-PUN-PMC'),
	('MH-PUN-PCMC-PIMPRI', 'Pimpri', 'LOCALITY', 'MH-PUN-PCMC'),
	('MH-PUN-PCMC-CHINCHWAD', 'Chinchwad', 'LOCALITY', 'MH-PUN-PCMC'),
	('MH-PUN-PCMC-NIGDI', 'Nigdi', 'LOCALITY', 'MH-PUN-PCMC'),
	('MH-PUN-PCMC-WAKAD', 'Wakad / Hinjewadi', 'LOCALITY', 'MH-PUN-PCMC')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "geo_area_pincodes" ("pincode_prefix", "area_code") VALUES
	('411', 'MH-PUN'),
	('411005', 'MH-PUN-PMC-SHIVAJINAGAR'),
	('411007', 'MH-PUN-PMC-AUNDH'),
	('411038', 'MH-PUN-PMC-KOTHRUD'),
	('411028', 'MH-PUN-PMC-HADAPSAR'),
	('411014', 'MH-PUN-PMC-VIMANNAGAR'),
	('411045', 'MH-PUN-PMC-BANER'),
	('411018', 'MH-PUN-PCMC-PIMPRI'),
	('411033', 'MH-PUN-PCMC-CHINCHWAD'),
	('411044', 'MH-PUN-PCMC-NIGDI'),
	('411057', 'MH-PUN-PCMC-WAKAD')
ON CONFLICT DO NOTHING;
