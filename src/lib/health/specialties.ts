/**
 * GoKesari Health specialties (owner, 21-Nov-2026): one grouped list of medical practitioners, used for
 * shop registration (shop categories), "Find a doctor" (consultant categories that need a medical
 * registration) and the admin Health → Specialties tab. The groups are the subcategories patients
 * pick first; the specialty is the second step.
 *
 * Both tables keep their own rows (admins can rename or add): migration 0160_health_specialties puts the
 * built-in medical rows into these groups and adds the missing specialties. A category an admin adds
 * later joins a group by carrying its exact `name` as its group; any other group shows as "Other doctors".
 *
 * Pure data, no imports: safe for client components and unit tests.
 */

export interface HealthSpecialtyGroup {
  key: string;
  /** Stored as `group_name` on shop_categories and consult_categories. */
  name: string;
  /** Chip label on "Find a doctor". */
  short: string;
}

export const HEALTH_GROUP_PREFIX = "Health — ";

export const HEALTH_SPECIALTY_GROUPS = [
  { key: "general", name: "Health — General & family doctors", short: "General & family" },
  { key: "specialists", name: "Health — Specialists", short: "Specialists" },
  { key: "women-child", name: "Health — Women & child", short: "Women & child" },
  { key: "dental", name: "Health — Dental", short: "Dental" },
  { key: "eye-ent", name: "Health — Eye & ENT", short: "Eye & ENT" },
  { key: "mind", name: "Health — Mind", short: "Mind" },
  { key: "therapy", name: "Health — Therapy", short: "Therapy" },
  { key: "ayush", name: "Health — AYUSH", short: "AYUSH" },
  { key: "diagnostics", name: "Health — Diagnostics", short: "Diagnostics" },
  { key: "animal", name: "Health — Animal care", short: "Animal care" },
] as const satisfies readonly HealthSpecialtyGroup[];

export type HealthGroupKey = (typeof HEALTH_SPECIALTY_GROUPS)[number]["key"];

/** Where a medical category whose group is not one of the above is shown. */
export const OTHER_HEALTH_GROUP: HealthSpecialtyGroup = { key: "other", name: "Other doctors", short: "Other doctors" };

/** The group of a stored `group_name` (exact match), or "Other doctors". */
export function healthGroupOf(groupName: string | null | undefined): HealthSpecialtyGroup {
  return HEALTH_SPECIALTY_GROUPS.find((g) => g.name === groupName) ?? OTHER_HEALTH_GROUP;
}

/** The stored group name for a group key ("specialists" → "Health — Specialists"), or null. */
export function healthGroupName(key: string | null | undefined): string | null {
  return HEALTH_SPECIALTY_GROUPS.find((g) => g.key === key)?.name ?? null;
}

export interface HealthSpecialty {
  group: HealthGroupKey;
  /** consult_categories slug ("Find a doctor" and bookings); null when the specialty has no bookable category. */
  consultSlug: string | null;
  /** shop_categories slug (registration); null when it has none. */
  shopSlug: string | null;
  name: string;
  /** Plain words shown next to the name on "Find a doctor" ("Heart"). */
  plain?: string;
}

/**
 * The built-in list (what migration 0160 aligns the two tables to). Some specialties have different slugs
 * in the two tables because each table was seeded on its own (eye-specialist / ophthalmologist); the
 * migration never renames a row that may already have doctors or shops on it.
 */
export const HEALTH_SPECIALTIES: readonly HealthSpecialty[] = [
  { group: "general", consultSlug: "general-physician", shopSlug: "general-physician", name: "General Physician", plain: "Fever, BP, sugar, general check-up" },
  { group: "general", consultSlug: null, shopSlug: "doctor-clinic", name: "Doctor / Clinic" },

  { group: "specialists", consultSlug: "cardiologist", shopSlug: "cardiologist", name: "Cardiologist", plain: "Heart" },
  { group: "specialists", consultSlug: "neurologist", shopSlug: "neurologist", name: "Neurologist", plain: "Brain and nerves" },
  { group: "specialists", consultSlug: "diabetologist-endocrinologist", shopSlug: "diabetologist-endocrinologist", name: "Diabetologist / Endocrinologist", plain: "Diabetes, thyroid, hormones" },
  { group: "specialists", consultSlug: "gastroenterologist", shopSlug: "gastroenterologist", name: "Gastroenterologist", plain: "Stomach and liver" },
  { group: "specialists", consultSlug: "pulmonologist", shopSlug: "pulmonologist", name: "Pulmonologist", plain: "Chest and lungs" },
  { group: "specialists", consultSlug: "nephrologist", shopSlug: "nephrologist", name: "Nephrologist", plain: "Kidney" },
  { group: "specialists", consultSlug: "urologist", shopSlug: "urologist", name: "Urologist", plain: "Urine, kidney stones, prostate" },
  { group: "specialists", consultSlug: "oncologist", shopSlug: "oncologist", name: "Oncologist", plain: "Cancer" },
  { group: "specialists", consultSlug: "general-surgeon", shopSlug: "general-surgeon", name: "General Surgeon", plain: "Hernia, piles, operations" },
  { group: "specialists", consultSlug: "orthopaedic", shopSlug: "orthopaedic", name: "Orthopaedic", plain: "Bones and joints" },
  { group: "specialists", consultSlug: "dermatologist", shopSlug: "dermatologist", name: "Dermatologist", plain: "Skin and hair" },

  { group: "women-child", consultSlug: "gynaecologist", shopSlug: "gynaecologist", name: "Gynaecologist", plain: "Women, pregnancy" },
  { group: "women-child", consultSlug: "paediatrician", shopSlug: "paediatrician", name: "Paediatrician", plain: "Children" },

  { group: "dental", consultSlug: "dentist", shopSlug: "dentist", name: "Dentist", plain: "Teeth" },
  { group: "dental", consultSlug: "orthodontist", shopSlug: "orthodontist", name: "Orthodontist", plain: "Braces" },

  { group: "eye-ent", consultSlug: "eye-specialist", shopSlug: "ophthalmologist", name: "Eye Specialist", plain: "Eyes" },
  { group: "eye-ent", consultSlug: "ent-specialist", shopSlug: "ent-specialist", name: "ENT Specialist", plain: "Ear, nose, throat" },

  { group: "mind", consultSlug: "psychiatrist", shopSlug: "psychiatrist-psychologist", name: "Psychiatrist", plain: "Depression, anxiety, sleep" },
  { group: "mind", consultSlug: "psychologist-counsellor", shopSlug: "psychiatrist-psychologist", name: "Psychologist / Counsellor" },

  { group: "therapy", consultSlug: "physiotherapist", shopSlug: "physiotherapist", name: "Physiotherapist" },
  { group: "therapy", consultSlug: "speech-therapist", shopSlug: "speech-therapist", name: "Speech Therapist" },
  { group: "therapy", consultSlug: "dietitian-nutritionist", shopSlug: "dietitian-nutritionist", name: "Dietitian / Nutritionist" },

  { group: "ayush", consultSlug: "ayurveda-homeopathy", shopSlug: "ayurveda", name: "Ayurveda" },
  { group: "ayush", consultSlug: "ayurveda-homeopathy", shopSlug: "homeopath", name: "Homeopathy" },
  { group: "ayush", consultSlug: "unani", shopSlug: "unani", name: "Unani" },
  { group: "ayush", consultSlug: "siddha", shopSlug: "siddha", name: "Siddha" },
  { group: "ayush", consultSlug: "naturopathy", shopSlug: "naturopathy", name: "Naturopathy" },

  { group: "diagnostics", consultSlug: "diagnostic-lab-pathology", shopSlug: "diagnostic-lab-pathology", name: "Diagnostic Lab / Pathology" },
  { group: "diagnostics", consultSlug: "scan-centre", shopSlug: "scan-centre", name: "Scan Centre (X-ray, sonography, CT, MRI)" },

  { group: "animal", consultSlug: "veterinarian", shopSlug: "veterinarian", name: "Veterinarian" },
];

/** Plain words for a consult category slug ("cardiologist" → "Heart"), when the built-in list has them. */
export function plainWordsFor(consultSlug: string): string | undefined {
  return HEALTH_SPECIALTIES.find((s) => s.consultSlug === consultSlug && s.plain)?.plain;
}
