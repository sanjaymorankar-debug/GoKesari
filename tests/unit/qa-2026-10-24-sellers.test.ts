/**
 * Seller-side fixes from the automated QA run of 24 Oct 2026 — the pure rules
 * shared by the forms and the server. Each case names its TC ID.
 */
import { describe, expect, it } from "vitest";

import { discountPercent, MAX_MRP_PAISE, parsePriceInput } from "@/lib/price-rules";
import { normaliseProductUnit, PRODUCT_UNITS } from "@/lib/product-units";
import { GSTIN_PAN_MISMATCH_MESSAGE, gstinPan, parseGstin } from "@/lib/shop-identity";
import { isShopOpenNow, shopHoursLabel } from "@/lib/shop-hours";
import { openingHoursSchema, optionalText, requiredText, shopImageUrlSchema } from "@/lib/shop-settings";
import { normalizeStaged } from "@/server/pmd/normalize";
import { parseGstRate } from "@/server/pmd/normalize/tax";
import { hasNonPositiveQuantity, parseQuantity } from "@/server/pmd/normalize/units";
import { NULL_MAPPER } from "@/server/pmd/taxonomy/mapper";
import { gstin } from "../helpers/gstin";

describe("TC-CAT-032: a rupee price box", () => {
  it("takes whole rupees and up to two decimals", () => {
    expect(parsePriceInput("58")).toEqual({ ok: true, paise: 5800 });
    expect(parsePriceInput("10.55")).toEqual({ ok: true, paise: 1055 });
    expect(parsePriceInput("10.5")).toEqual({ ok: true, paise: 1050 });
    expect(parsePriceInput("₹1,250")).toEqual({ ok: true, paise: 125000 });
    expect(parsePriceInput("0.01")).toEqual({ ok: true, paise: 1 });
  });

  it("refuses more than two decimals instead of rounding 10.555 to 1056 paise", () => {
    expect(parsePriceInput("10.555")).toMatchObject({ ok: false, error: expect.stringMatching(/2 decimals/) });
  });

  it("refuses 0, negative and text with the form's message", () => {
    for (const raw of ["0", "0.00", "-5", "abc", "1e3"]) {
      expect(parsePriceInput(raw), raw).toEqual({ ok: false, error: "Enter a price greater than 0." });
    }
  });
});

describe("TC-CAT-008: MRP discount on a product card", () => {
  it("MRP ₹60, price ₹58 → 3 % off (rounded down)", () => {
    expect(discountPercent(6000, 5800)).toBe(3);
  });

  it("nothing when the price equals or exceeds the MRP, there is no MRP, or the saving is under 1 %", () => {
    expect(discountPercent(6000, 6000)).toBeNull();
    expect(discountPercent(6000, 6500)).toBeNull();
    expect(discountPercent(null, 5800)).toBeNull();
    expect(discountPercent(100_000, 99_500)).toBeNull();
  });

  it("the MRP ceiling is ₹10 lakh (TC-FLD-079)", () => {
    expect(MAX_MRP_PAISE).toBe(100_000_000);
  });
});

describe("TC-FLD-037: shop text fields are trimmed before the length check", () => {
  it("an address of spaces is empty; padding is removed", () => {
    expect(requiredText(3, 200).safeParse("      ").success).toBe(false);
    expect(requiredText(3, 200).parse("   12 Padded Road   ")).toBe("12 Padded Road");
    expect(optionalText(200).parse("   ")).toBeNull();
    expect(optionalText(200).parse("  Near temple  ")).toBe("Near temple");
  });
});

describe("TC-FLD-052: opening hours", () => {
  const ok = (hours: unknown) => openingHoursSchema.safeParse(hours).success;

  it("refuses 25:00, words, open = close and a day twice", () => {
    expect(ok([{ day: 1, open: "25:00", close: "22:00" }])).toBe(false);
    expect(ok([{ day: 1, open: "morning", close: "night" }])).toBe(false);
    expect(ok([{ day: 1, open: "09:00", close: "09:00" }])).toBe(false);
    expect(ok([{ day: 1, open: "09:00", close: "18:00" }, { day: 1, open: "10:00", close: "20:00" }])).toBe(false);
    expect(ok([{ day: 7, open: "09:00", close: "18:00" }])).toBe(false);
  });

  it("accepts 00:00–23:59, a closed day and hours past midnight — which show as open after midnight", () => {
    const hours = [
      { day: 5, open: "18:00", close: "02:00" },
      { day: 0, open: "09:00", close: "09:00", closed: true },
      { day: 1, open: "00:00", close: "23:59" },
    ];
    expect(ok(hours)).toBe(true);
    // Friday 18:00 – Saturday 02:00 IST; Saturday 01:00 IST is 19:30 UTC on Friday.
    const saturdayOneAm = new Date("2026-10-23T19:30:00Z");
    expect(isShopOpenNow({ openingHours: hours }, saturdayOneAm)).toBe(true);
    expect(shopHoursLabel({ openingHours: hours }, saturdayOneAm)).toBe("Open till 2 AM");
  });
});

describe("TC-FLD-056: a shop logo or photo address", () => {
  it("only https and the site's own uploads", () => {
    expect(shopImageUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(shopImageUrlSchema.safeParse("data:image/png;base64,AAAA").success).toBe(false);
    expect(shopImageUrlSchema.safeParse("http://example.com/logo.png").success).toBe(false);
    expect(shopImageUrlSchema.safeParse("https://example.com/logo.png").success).toBe(true);
    expect(shopImageUrlSchema.safeParse("/api/images/00000000-0000-4000-8000-000000000001").success).toBe(true);
  });
});

describe("TC-FLD-043: GSTIN check shared by the forms and the server", () => {
  it("accepts a GSTIN with a known state code and a matching check character", () => {
    const valid = gstin("27", "ABCPE1234F");
    expect(parseGstin(` ${valid.toLowerCase()} `)).toEqual({ ok: true, value: valid });
    expect(parseGstin(gstin("97", "ABCPE1234F")).ok).toBe(true);
    expect(gstinPan(valid)).toBe("ABCPE1234F");
  });

  it("refuses state codes 00 and 99, a wrong check character and a malformed PAN part", () => {
    expect(parseGstin(gstin("00", "ABCPE1234F"))).toMatchObject({ ok: false, error: expect.stringMatching(/state code/) });
    expect(parseGstin(gstin("99", "ABCPE1234F"))).toMatchObject({ ok: false, error: expect.stringMatching(/state code/) });
    const valid = gstin("27", "ABCPE1234F");
    const wrong = valid.slice(0, 14) + (valid.endsWith("A") ? "B" : "A");
    expect(parseGstin(wrong)).toMatchObject({ ok: false, error: expect.stringMatching(/check character/) });
    expect(parseGstin("271234567890123").ok).toBe(false);
    expect(GSTIN_PAN_MISMATCH_MESSAGE).toMatch(/PAN/);
  });
});

describe("TC-FLD-074: units and pack sizes", () => {
  it("the create-product API's unit list", () => {
    expect(normaliseProductUnit("Kg")).toBe("kg");
    expect(normaliseProductUnit("litre")).toBe("L");
    expect(normaliseProductUnit("pcs")).toBe("piece");
    expect(normaliseProductUnit("bananas")).toBeNull();
    expect(normaliseProductUnit("0 kg")).toBeNull();
    expect(normaliseProductUnit("")).toBeNull();
    expect(PRODUCT_UNITS).toEqual(expect.arrayContaining(["L", "ml", "kg", "g", "piece", "pack"]));
  });

  it("the pipeline does not read -1 kg as 1 kg, and reports a negative or zero pack size", () => {
    expect(parseQuantity("-1 kg")).toBeNull();
    expect(hasNonPositiveQuantity("-1 kg")).toBe(true);
    expect(hasNonPositiveQuantity("0 kg")).toBe(true);
    expect(hasNonPositiveQuantity("1 kg")).toBe(false);
    // A hyphen joining a word or a range is not a minus sign.
    expect(parseQuantity("Atta-5kg")).toMatchObject({ unitValue: 5000, unit: "g" });
    expect(parseQuantity("1-2 kg")).toMatchObject({ unitValue: 2000, unit: "g" });
    expect(parseQuantity("Good Day Cookies - 100g")).toMatchObject({ unitValue: 100, unit: "g" });
    expect(parseQuantity("Qty: -500 g")).toBeNull();

    const n = normalizeStaged({ sourceProductId: "q", name: "Sugar", quantityText: "-1 kg" }, { categoryMapper: NULL_MAPPER });
    expect(n.quantity).toBeNull();
    expect(n.issues.find((i) => i.code === "QUANTITY_INVALID")?.severity).toBe("WARNING");
  });
});

describe("TC-FLD-078: GST rates in the pipeline", () => {
  it("-5 is not read as 5 %", () => {
    expect(parseGstRate("-5")).toBeNull();
    expect(parseGstRate(-5)).toBeNull();
    expect(parseGstRate("GST-18")).toBe(1800);
    expect(parseGstRate("GST - 18%")).toBe(1800);
    expect(parseGstRate("GST: -5%")).toBeNull();
    const n = normalizeStaged({ sourceProductId: "g", name: "Butter", gstRate: "-5" }, { categoryMapper: NULL_MAPPER });
    expect(n.gstRateBp).toBeNull();
    expect(n.issues.find((i) => i.code === "GST_RATE_INVALID")?.message).toMatch(/negative/);
  });

  it("a rate that is no GST slab (7 %) is dropped with an issue, a slab is kept", () => {
    const seven = normalizeStaged({ sourceProductId: "s", name: "Butter", gstRate: "7" }, { categoryMapper: NULL_MAPPER });
    expect(seven.gstRateBp).toBeNull();
    expect(seven.issues.map((i) => i.code)).toContain("GST_RATE_UNUSUAL");
    const twelve = normalizeStaged({ sourceProductId: "t", name: "Butter", gstRate: "12%" }, { categoryMapper: NULL_MAPPER });
    expect(twelve.gstRateBp).toBe(1200);
  });
});
