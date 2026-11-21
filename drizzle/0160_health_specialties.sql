-- GoKesari Health specialties (owner, 21-Nov-2026): every medical practitioner under Health, in groups
-- patients can pick first (src/lib/health/specialties.ts). Same groups in the registration list
-- (shop_categories) and in "Find a doctor" (consult_categories).
--
-- Additive and safe to re-run:
--   * built-in medical rows move into the Health groups only while they still carry the group they were
--     seeded with ("Medical — doctors and clinics" / "Doctors and clinics") — an admin's own grouping stays;
--   * missing specialties are added (skipped when the slug or the name already exists);
--   * no row is renamed, deleted or re-slugged, so shops, doctors and bookings keep their categories.
-- The "Home care" group of consult_categories (Health home care) is not touched.
-- Rollback: scripts/rollback-0160.sql.

UPDATE "shop_categories" AS c SET "group_name" = v.grp, "updated_at" = now()
FROM (VALUES
  ('general-physician', 'Health — General & family doctors'),
  ('doctor-clinic', 'Health — General & family doctors'),
  ('cardiologist', 'Health — Specialists'),
  ('neurologist', 'Health — Specialists'),
  ('orthopaedic', 'Health — Specialists'),
  ('dermatologist', 'Health — Specialists'),
  ('gynaecologist', 'Health — Women & child'),
  ('paediatrician', 'Health — Women & child'),
  ('dentist', 'Health — Dental'),
  ('ophthalmologist', 'Health — Eye & ENT'),
  ('ent-specialist', 'Health — Eye & ENT'),
  ('psychiatrist-psychologist', 'Health — Mind'),
  ('physiotherapist', 'Health — Therapy'),
  ('ayurveda', 'Health — AYUSH'),
  ('homeopath', 'Health — AYUSH'),
  ('diagnostic-lab-pathology', 'Health — Diagnostics'),
  ('veterinarian', 'Health — Animal care')
) AS v(slug, grp)
WHERE c."slug" = v.slug AND c."group_name" = 'Medical — doctors and clinics';
--> statement-breakpoint
INSERT INTO "shop_categories" ("name", "slug", "group_name")
SELECT v.name, v.slug, v.grp
FROM (VALUES
  ('Diabetologist / Endocrinologist', 'diabetologist-endocrinologist', 'Health — Specialists'),
  ('Gastroenterologist', 'gastroenterologist', 'Health — Specialists'),
  ('Pulmonologist', 'pulmonologist', 'Health — Specialists'),
  ('Nephrologist', 'nephrologist', 'Health — Specialists'),
  ('Urologist', 'urologist', 'Health — Specialists'),
  ('Oncologist', 'oncologist', 'Health — Specialists'),
  ('General Surgeon', 'general-surgeon', 'Health — Specialists'),
  ('Orthodontist', 'orthodontist', 'Health — Dental'),
  ('Speech Therapist', 'speech-therapist', 'Health — Therapy'),
  ('Dietitian / Nutritionist', 'dietitian-nutritionist', 'Health — Therapy'),
  ('Unani', 'unani', 'Health — AYUSH'),
  ('Siddha', 'siddha', 'Health — AYUSH'),
  ('Naturopathy', 'naturopathy', 'Health — AYUSH'),
  ('Scan Centre (X-ray, sonography, CT, MRI)', 'scan-centre', 'Health — Diagnostics')
) AS v(name, slug, grp)
WHERE NOT EXISTS (SELECT 1 FROM "shop_categories" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name));
--> statement-breakpoint
UPDATE "consult_categories" AS c SET "group_name" = v.grp, "updated_at" = now()
FROM (VALUES
  ('general-physician', 'Health — General & family doctors'),
  ('dermatologist', 'Health — Specialists'),
  ('orthopaedic', 'Health — Specialists'),
  ('gynaecologist', 'Health — Women & child'),
  ('paediatrician', 'Health — Women & child'),
  ('dentist', 'Health — Dental'),
  ('eye-specialist', 'Health — Eye & ENT'),
  ('ent-specialist', 'Health — Eye & ENT'),
  ('psychologist-counsellor', 'Health — Mind'),
  ('physiotherapist', 'Health — Therapy'),
  ('ayurveda-homeopathy', 'Health — AYUSH'),
  ('veterinarian', 'Health — Animal care')
) AS v(slug, grp)
WHERE c."slug" = v.slug AND c."group_name" = 'Doctors and clinics';
--> statement-breakpoint
INSERT INTO "consult_categories" ("name", "slug", "group_name", "required_doc", "required_doc_label", "default_modes", "sac_code", "sensitive", "sort_order")
SELECT v.name, v.slug, v.grp, v.doc, v.doc_label, v.modes::text[], '999312', true, v.sort
FROM (VALUES
  ('Cardiologist', 'cardiologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 101),
  ('Neurologist', 'neurologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 102),
  ('Diabetologist / Endocrinologist', 'diabetologist-endocrinologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 103),
  ('Gastroenterologist', 'gastroenterologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 104),
  ('Pulmonologist', 'pulmonologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 105),
  ('Nephrologist', 'nephrologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 106),
  ('Urologist', 'urologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 107),
  ('Oncologist', 'oncologist', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO}', 108),
  ('General Surgeon', 'general-surgeon', 'Health — Specialists', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON}', 109),
  ('Orthodontist', 'orthodontist', 'Health — Dental', 'MEDICAL_REGISTRATION', 'Dental Council registration', '{IN_PERSON}', 110),
  ('Psychiatrist', 'psychiatrist', 'Health — Mind', 'MEDICAL_REGISTRATION', 'Medical Council registration', '{IN_PERSON,VIDEO,PHONE}', 111),
  ('Speech Therapist', 'speech-therapist', 'Health — Therapy', 'RCI', 'RCI registration', '{IN_PERSON,VIDEO}', 112),
  ('Dietitian / Nutritionist', 'dietitian-nutritionist', 'Health — Therapy', 'OTHER', 'Dietetics degree or IDA registration', '{IN_PERSON,VIDEO,PHONE}', 113),
  ('Unani', 'unani', 'Health — AYUSH', 'MEDICAL_REGISTRATION', 'AYUSH board registration', '{IN_PERSON,VIDEO}', 114),
  ('Siddha', 'siddha', 'Health — AYUSH', 'MEDICAL_REGISTRATION', 'AYUSH board registration', '{IN_PERSON,VIDEO}', 115),
  ('Naturopathy', 'naturopathy', 'Health — AYUSH', 'MEDICAL_REGISTRATION', 'AYUSH / naturopathy board registration', '{IN_PERSON,VIDEO}', 116),
  ('Diagnostic Lab / Pathology', 'diagnostic-lab-pathology', 'Health — Diagnostics', 'OTHER', 'Laboratory registration (state or NABL)', '{IN_PERSON,HOME_VISIT}', 117),
  ('Scan Centre (X-ray, sonography, CT, MRI)', 'scan-centre', 'Health — Diagnostics', 'OTHER', 'AERB licence / PCPNDT registration', '{IN_PERSON}', 118)
) AS v(name, slug, grp, doc, doc_label, modes, sort)
WHERE NOT EXISTS (SELECT 1 FROM "consult_categories" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name));
