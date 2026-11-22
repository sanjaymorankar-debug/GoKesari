/**
 * GoKesari Health specialties (owner, 21-Nov-2026): the grouped list in src/lib/health/specialties.ts, the
 * migration that aligns the two category tables to it (0161) and the symptom → specialty table stay in step.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCTOR_GROUP_KEYS, HEALTH_GROUP_PREFIX, HEALTH_SPECIALTIES, HEALTH_SPECIALTY_GROUPS, healthGroupName, healthGroupOf, isDoctorGroup, OTHER_HEALTH_GROUP, plainWordsFor } from "@/lib/health/specialties";
import { SYMPTOM_SPECIALTIES, specialtiesForSymptom } from "@/lib/health/symptoms";

const drizzle = (file: string) => readFileSync(path.join(process.cwd(), "drizzle", file), "utf8");
const MIGRATION = drizzle("0161_health_specialties.sql");
// Where each slug was first seeded: shop categories 0062 (doctor-clinic) and 0098, consult categories 0153 and 0156.
const SEEDS = [drizzle("0062_legal_documents.sql"), drizzle("0098_professional_registration.sql"), drizzle("0153_consult_bookings.sql"), drizzle("0156_health.sql"), MIGRATION].join("\n");

describe("Health specialty groups", () => {
  it("are unique, carry the Health prefix and resolve both ways", () => {
    expect(new Set(HEALTH_SPECIALTY_GROUPS.map((g) => g.key)).size).toBe(HEALTH_SPECIALTY_GROUPS.length);
    expect(new Set(HEALTH_SPECIALTY_GROUPS.map((g) => g.name)).size).toBe(HEALTH_SPECIALTY_GROUPS.length);
    for (const g of HEALTH_SPECIALTY_GROUPS) {
      expect(g.name.startsWith(HEALTH_GROUP_PREFIX), g.name).toBe(true);
      expect(healthGroupOf(g.name)).toBe(g);
      expect(healthGroupName(g.key)).toBe(g.name);
    }
    expect(healthGroupOf("Doctors and clinics")).toBe(OTHER_HEALTH_GROUP);
    expect(healthGroupOf(null)).toBe(OTHER_HEALTH_GROUP);
    expect(healthGroupName("no-such-group")).toBeNull();
  });

  it("cover the agreed subcategories in the agreed order", () => {
    expect(HEALTH_SPECIALTY_GROUPS.map((g) => g.short)).toEqual(["General & family", "Specialists", "Women & child", "Dental", "Eye & ENT", "Mind", "Therapy", "AYUSH", "Diagnostics", "Animal care"]);
  });

  it("need a medical registration for every doctor group, not Therapy or Diagnostics (owner, 22-Nov-2026)", () => {
    expect(HEALTH_SPECIALTY_GROUPS.filter((g) => isDoctorGroup(g.name)).map((g) => g.key)).toEqual([...DOCTOR_GROUP_KEYS]);
    expect(isDoctorGroup("Health — Therapy")).toBe(false);
    expect(isDoctorGroup("Health — Diagnostics")).toBe(false);
    expect(isDoctorGroup("Medical — doctors and clinics")).toBe(false);
    expect(isDoctorGroup(null)).toBe(false);
  });

  it("each have at least one specialty", () => {
    for (const g of HEALTH_SPECIALTY_GROUPS) expect(HEALTH_SPECIALTIES.some((s) => s.group === g.key), g.key).toBe(true);
  });
});

describe("migration 0161", () => {
  it("only uses the Health group names, besides the two old ones it moves rows out of", () => {
    const quoted = [...MIGRATION.matchAll(/'((?:Health —|Medical —|Doctors and)[^']*)'/g)].map((m) => m[1]);
    const allowed = new Set<string>([...HEALTH_SPECIALTY_GROUPS.map((g) => g.name), "Medical — doctors and clinics", "Doctors and clinics"]);
    for (const name of quoted) expect(allowed.has(name), name).toBe(true);
  });

  it("seeds every slug of the built-in list in its table", () => {
    for (const s of HEALTH_SPECIALTIES) {
      if (s.consultSlug) expect(SEEDS.includes(`'${s.consultSlug}'`), `consult ${s.consultSlug}`).toBe(true);
      if (s.shopSlug) expect(SEEDS.includes(`'${s.shopSlug}'`), `shop ${s.shopSlug}`).toBe(true);
    }
  });

  it("never renames, deletes or re-slugs a row, and leaves Home care alone", () => {
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM/i);
    expect(MIGRATION).not.toMatch(/SET\s+"(name|slug)"/i);
    expect(MIGRATION).not.toMatch(/'Home care'/);
    // Group moves only touch rows that still carry the group they were seeded with.
    expect(MIGRATION.match(/UPDATE "(shop|consult)_categories"/g)).toHaveLength(2);
    expect(MIGRATION).toContain(`c."group_name" = 'Medical — doctors and clinics'`);
    expect(MIGRATION).toContain(`c."group_name" = 'Doctors and clinics'`);
    expect(MIGRATION.match(/WHERE NOT EXISTS/g)).toHaveLength(2);
  });

  it("is in the migration journal", () => {
    const journal = JSON.parse(drizzle(path.join("meta", "_journal.json"))) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0161_health_specialties");
  });
});

describe("symptom and plain-word search", () => {
  const consultSlugs = new Set(HEALTH_SPECIALTIES.map((s) => s.consultSlug).filter(Boolean));

  it("points every symptom at a specialty of the list", () => {
    for (const entry of SYMPTOM_SPECIALTIES) for (const slug of entry.specialties) expect(consultSlugs.has(slug), slug).toBe(true);
  });

  it("finds the new specialists from plain words", () => {
    expect(specialtiesForSymptom("heart pain")).toContain("cardiologist");
    expect(specialtiesForSymptom("kidney stone")).toContain("urologist");
    expect(specialtiesForSymptom("anxiety")).toEqual(["psychiatrist", "psychologist-counsellor"]);
    expect(specialtiesForSymptom("braces")[0]).toBe("orthodontist");
    expect(specialtiesForSymptom("thyroid")).toEqual(["general-physician", "diabetologist-endocrinologist"]);
    expect(specialtiesForSymptom("Rao")).toEqual([]);
  });

  it("shows plain words next to the specialist names", () => {
    expect(plainWordsFor("cardiologist")).toBe("Heart");
    expect(plainWordsFor("nephrologist")).toBe("Kidney");
    expect(plainWordsFor("no-such-slug")).toBeUndefined();
  });
});
