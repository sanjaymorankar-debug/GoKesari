/**
 * Puja Samagri master catalogue (docs/puja-samagri-2026-11): the data the seed writes.
 * Brief §4 / §9 "Seed" checks that need no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PUJA_CATEGORIES, PUJA_FESTIVALS, PUJA_TYPES, parseNetQuantity, pujaCatalogue, translateVariant } from "@/server/puja/catalogue";
import { formatIst, istInputToDate } from "@/lib/puja";
import { PUJA_SEED_FILE } from "@/server/puja/seed-runner";

const rows = pujaCatalogue();

describe("puja master catalogue", () => {
  it("has 400–500 SKUs including variants, in all 15 categories", () => {
    expect(rows.length).toBeGreaterThanOrEqual(400);
    expect(rows.length).toBeLessThanOrEqual(500);
    expect(PUJA_CATEGORIES).toHaveLength(15);
    for (const c of PUJA_CATEGORIES) expect(rows.filter((r) => r.categoryNo === c.no).length, c.en).toBeGreaterThan(0);
  });

  it("gives every item an English, Hindi and Marathi name and search synonyms", () => {
    for (const r of rows) {
      expect(r.nameEn.trim(), r.slug).not.toBe("");
      expect(r.nameHi, r.slug).toMatch(/[ऀ-ॿ]/);
      expect(r.nameMr, r.slug).toMatch(/[ऀ-ॿ]/);
      expect(r.synonyms.length, r.slug).toBeGreaterThan(0);
    }
  });

  it("has unique slugs and names (no duplicates for the seed)", () => {
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.nameEn.toLowerCase())).size).toBe(rows.length);
  });

  it("leaves the price empty for loose goods", () => {
    const loose = rows.filter((r) => r.loose);
    expect(loose.length).toBeGreaterThan(10);
    for (const r of loose) expect(r.mrpPaise, r.slug).toBeNull();
  });

  it("carries a unit, HSN and a valid GST rate on every item", () => {
    const units = new Set(["pcs", "pack", "box", "dozen", "g", "kg", "ml", "L"]);
    for (const r of rows) {
      expect(units.has(r.sellUnit), r.slug).toBe(true);
      expect(r.hsnCode, r.slug).toMatch(/^\d{4,8}$/);
      expect([0, 300, 500, 1800], r.slug).toContain(r.gstRateBp);
    }
  });

  it("flags perishables (flowers) and edibles (prasad) and tags festivals with known keys", () => {
    const keys = new Set<string>(PUJA_FESTIVALS.map((f) => f.key));
    expect(rows.filter((r) => r.categoryNo === 9 && r.perishable).length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.categoryNo === 10).every((r) => r.edible)).toBe(true);
    for (const r of rows) for (const f of r.festivals) expect(keys.has(f), `${r.slug} ${f}`).toBe(true);
  });

  it("covers the brief's starter items and product types", () => {
    const names = rows.map((r) => r.nameEn.toLowerCase()).join("\n");
    for (const must of ["rose agarbatti", "bhimseni kapur", "mitti diya", "havan samagri", "kumkum", "kalash", "shree yantra", "laddu gopal poshak", "marigold", "nariyal", "rudraksha mala", "satyanarayan puja kit", "rangoli", "hanuman chalisa", "kulhad"]) {
      expect(names, must).toContain(must);
    }
    expect(new Set(rows.map((r) => r.typeKey)).size).toBe(PUJA_TYPES.length);
  });

  it("matches the generated seed SQL (re-run scripts/puja/build-catalogue.ts after editing the data)", () => {
    const seed = readFileSync(path.join(process.cwd(), PUJA_SEED_FILE), "utf8");
    expect(seed).toContain(`${rows.length} SKUs`);
    for (const r of [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]]) expect(seed).toContain(`'${r.slug}'`);
  });

  it("puts variant words into Hindi and Marathi and parses net quantities", () => {
    expect(translateVariant("Pack of 12", "hi")).toBe("पैक – 12");
    expect(translateVariant("Loose, per kg", "mr")).toBe("सुटे, प्रति किलो");
    expect(parseNetQuantity("Zipper pack 100 g")).toEqual({ qty: 100, unit: "g" });
    expect(parseNetQuantity("15 kg tin")).toEqual({ qty: 15, unit: "kg" });
    expect(parseNetQuantity("Pack of 6")).toBeNull();
  });

  it("formats and reads IST times", () => {
    expect(formatIst("2026-11-20T05:00:00.000Z")).toBe("20-Nov-2026 10.30 IST");
    expect(istInputToDate("2026-11-20T10:30").toISOString()).toBe("2026-11-20T05:00:00.000Z");
  });
});
