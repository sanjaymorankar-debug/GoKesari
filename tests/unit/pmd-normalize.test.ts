/**
 * Product Master Data Platform - normalisation.
 * Covers the brief's normalisation examples (1 kg / 1000 g / 1,000 grams -> 1000 g),
 * identifier validation, brand identity, tax and country handling.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeColor,
  normalizeCountry,
  normalizeSize,
  parseBoolean,
  parseStockStatus,
  toMinorUnits,
} from "@/server/pmd/normalize/attributes";
import { entityKey, looksLikeCompany, normalizeEntity, splitBrandList } from "@/server/pmd/normalize/brand";
import {
  analyzeGtin,
  gs1CheckDigit,
  isbn10To13,
  normalizeAlnumKey,
  toEan13,
  toUpcA,
} from "@/server/pmd/normalize/identifiers";
import { buildCoreName, normalizeStaged } from "@/server/pmd/normalize";
import { gstSlabStatus, isValidGstin, normalizeFssai, normalizeHsn, parseGstRate } from "@/server/pmd/normalize/tax";
import { levenshtein, normalizeText, presentString, stem, tokensEquivalent, trigramSimilarity } from "@/server/pmd/normalize/text";
import { parseDimensions, parseMeasure, parseQuantity, stripQuantityFromText } from "@/server/pmd/normalize/units";
import { NULL_MAPPER } from "@/server/pmd/taxonomy/mapper";

describe("normalizeText", () => {
  it.each([
    ["Haldiram's Aloo Bhujia", "haldirams aloo bhujia"],
    ["  SAMSUNG   Galaxy-S23  ", "samsung galaxy s23"],
    ["Tea & Coffee", "tea and coffee"],
    ["Café Crème", "cafe creme"],
    ["1,000 grams", "1000 grams"],
    ["Milk 1.5 L", "milk 1.5 l"],
    ["Toned Milk 3%", "toned milk 3%"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it("keeps Devanagari intact (only Latin accents are folded)", () => {
    expect(normalizeText("अमूल दूध")).toBe("अमूल दूध");
  });

  it("treats placeholders as missing, not as data", () => {
    for (const v of ["N/A", "none", "  ", "-", "Not Available", null, undefined]) {
      expect(presentString(v)).toBeNull();
    }
    expect(presentString("Amul")).toBe("Amul");
  });
});

describe("string similarity helpers", () => {
  it("levenshtein is bounded and exact for short strings", () => {
    expect(levenshtein("taaza", "taza")).toBe(1);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abcdef", "uvwxyz", 2)).toBeGreaterThan(2);
  });

  it("tokens are equivalent across spelling variants but never across numbers or short words", () => {
    expect(tokensEquivalent("taaza", "taza")).toBe(true);
    expect(tokensEquivalent("cola", "coal")).toBe(false);
    expect(tokensEquivalent("500", "501")).toBe(false);
    expect(tokensEquivalent("s23", "s24")).toBe(false);
  });

  it("stems plurals identically on both sides", () => {
    expect(stem("biscuits")).toBe("biscuit");
    expect(stem("glass")).toBe("glass");
  });

  it("trigram similarity matches pg_trgm's definition (identical = 1, disjoint = 0)", () => {
    expect(trigramSimilarity("amul butter", "amul butter")).toBe(1);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
    expect(trigramSimilarity("amul taaza", "amul taza")).toBeGreaterThan(0.5);
  });
});

describe("quantity & pack parsing", () => {
  it("normalises the brief's example - 1 kg, 1000 g, 1,000 grams - to one value", () => {
    const forms = ["1 kg", "1000 g", "1,000 grams", "1000g", "1.0 KG", "Net Wt. 1 Kg"];
    for (const f of forms) {
      const q = parseQuantity(f);
      expect(q, f).not.toBeNull();
      expect(q).toMatchObject({ unitValue: 1000, unit: "g", multiplier: 1, total: 1000, label: "1000 g" });
    }
  });

  it("preserves the original text", () => {
    expect(parseQuantity("1,000 grams")?.original).toBe("1,000 grams");
  });

  it.each([
    ["0.5 kg", 500, "g"],
    ["500g", 500, "g"],
    ["250 mg", 0.25, "g"],
    ["1.5 L", 1500, "ml"],
    ["750 ML", 750, "ml"],
    ["1 litre", 1000, "ml"],
    ["12 pcs", 12, "pcs"],
    ["1 dozen", 12, "pcs"],
    ["100 g (3.5 oz)", 100, "g"],
  ])("%s -> %d %s", (text, value, unit) => {
    expect(parseQuantity(text)).toMatchObject({ unitValue: value, unit });
  });

  it("converts imperial units", () => {
    expect(parseQuantity("12 fl oz")?.unitValue).toBeCloseTo(354.88, 1);
    expect(parseQuantity("1 lb")?.unitValue).toBeCloseTo(453.59, 1);
  });

  it("reads multipacks and keeps size and count apart (2 x 500 g is not 1 kg)", () => {
    expect(parseQuantity("6 x 200 ml")).toMatchObject({ unitValue: 200, multiplier: 6, total: 1200, label: "6 x 200 ml" });
    expect(parseQuantity("200ml x 6")).toMatchObject({ unitValue: 200, multiplier: 6 });
    expect(parseQuantity("2 x 500g")).toMatchObject({ unitValue: 500, multiplier: 2, total: 1000 });
    expect(parseQuantity("500 g, pack of 2")).toMatchObject({ unitValue: 500, multiplier: 2 });
    expect(parseQuantity("Pack of 3")).toMatchObject({ unit: "pcs", multiplier: 3, total: 3 });
    // A structured multipack wins over the bare total that may precede it.
    expect(parseQuantity("1 kg (2 x 500 g)")).toMatchObject({ unitValue: 500, multiplier: 2 });
  });

  it("returns null - never zero or one - when there is no quantity", () => {
    expect(parseQuantity("Amul Butter")).toBeNull();
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity("0 g")).toBeNull();
  });

  it("does not read the 'g' in a word as a unit", () => {
    expect(parseQuantity("2 gram")).toMatchObject({ unitValue: 2, unit: "g" });
    expect(parseQuantity("5 gallery")).toBeNull();
  });

  it("strips quantity phrases from names without corrupting overlapping spans", () => {
    expect(stripQuantityFromText("Amul Taaza Toned Milk 1 L Pouch")).toBe("amul taaza toned milk pouch");
    expect(stripQuantityFromText("Good Day Butter Cookies 6 x 50 g")).toBe("good day butter cookies");
    expect(stripQuantityFromText("Maggi Noodles 70 g pack of 4")).toBe("maggi noodles");
  });

  it("title parsing is stricter than an explicit quantity field", () => {
    const title = { fromTitle: true };
    // "5G" is a network generation, not five grams; "2 in 1" is not two inches; "6 mm" is a spec, not a pack.
    expect(parseQuantity("Samsung Galaxy S23 5G", title)).toBeNull();
    expect(parseQuantity("HP 2 in 1 Laptop", title)).toBeNull();
    expect(parseQuantity("Yoga Mat 6 mm", title)).toBeNull();
    expect(stripQuantityFromText("Yoga Mat 6 mm", title)).toBe("yoga mat 6 mm");
    expect(stripQuantityFromText("Samsung Galaxy S23 5G", title)).toBe("samsung galaxy s23 5g");
    // Real pack sizes in titles still parse.
    expect(parseQuantity("Amul Butter 500 g", title)).toMatchObject({ unitValue: 500, unit: "g" });
    expect(parseQuantity("Nescafe Sachet 5 g", title)).toMatchObject({ unitValue: 5, unit: "g" });
    // An explicit quantity field is trusted as written.
    expect(parseQuantity("5g")).toMatchObject({ unitValue: 5, unit: "g" });
    expect(parseQuantity("2 in")).toMatchObject({ unit: "mm" });
  });

  it("parseMeasure only answers in the requested dimension", () => {
    expect(parseMeasure("2 kg", "g")).toBe(2000);
    expect(parseMeasure("2 kg", "ml")).toBeNull();
    expect(parseMeasure("330 ml", "ml")).toBe(330);
  });

  it("parses dimensions into millimetres and needs all three axes", () => {
    expect(parseDimensions("10 x 20 x 30 cm")).toEqual({ length: 100, width: 200, height: 300 });
    expect(parseDimensions("5 x 5 x 5 in")).toEqual({ length: 127, width: 127, height: 127 });
    expect(parseDimensions("10 x 20 cm")).toBeNull();
    expect(parseDimensions("10 x 20 x 30 kg")).toBeNull();
  });
});

describe("GTIN / ISBN identifiers", () => {
  it("computes the GS1 check digit", () => {
    expect(gs1CheckDigit("400638133393")).toBe(1);
    expect(gs1CheckDigit("890105889578")).toBe(0);
  });

  it("canonicalises EAN-13, UPC-A and GTIN-14 of the same item to one GTIN-14", () => {
    const ean = analyzeGtin("0036000291452")!;
    const upc = analyzeGtin("036000291452")!;
    const g14 = analyzeGtin("00036000291452")!;
    expect(ean.gtin14).toBe(upc.gtin14);
    expect(upc.gtin14).toBe(g14.gtin14);
    expect(upc.format).toBe("GTIN-12");
    expect(ean.format).toBe("GTIN-13");
    expect(toEan13(upc.gtin14)).toBe("0036000291452");
    expect(toUpcA(upc.gtin14)).toBe("036000291452");
  });

  it("accepts an Indian EAN and strips separators", () => {
    const g = analyzeGtin("890 1058-895780")!;
    expect(g).toMatchObject({ gtin14: "08901058895780", checkDigitValid: true, usableForMatching: true });
  });

  it("flags a wrong check digit and refuses to let it drive a match", () => {
    const g = analyzeGtin("8901058895781")!;
    expect(g.checkDigitValid).toBe(false);
    expect(g.usableForMatching).toBe(false);
  });

  it("rejects things that are not barcodes", () => {
    for (const v of ["abc", "12345", "0000000000000", "1111111111111", "", null, undefined]) {
      expect(analyzeGtin(v as never), String(v)).toBeNull();
    }
  });

  it("marks in-store, coupon and serial ranges as unusable for matching", () => {
    const inStore = analyzeGtin("2000000000008")!;
    expect(inStore).toMatchObject({ checkDigitValid: true, restricted: "IN_STORE", usableForMatching: false });
    const coupon = analyzeGtin("9900000000004");
    if (coupon) expect(coupon.usableForMatching).toBe(false);
  });

  it("validates ISBNs and promotes ISBN-10 to ISBN-13", () => {
    expect(isbn10To13("0-306-40615-2")).toBe("9780306406157");
    expect(isbn10To13("0306406153")).toBeNull();
    const book = analyzeGtin("9780306406157")!;
    expect(book.isbn13).toBe("9780306406157");
    expect(book.usableForMatching).toBe(true);
    expect(analyzeGtin("0306406152")!.gtin14).toBe("09780306406157");
  });

  it("builds MPN/model keys ignoring punctuation and rejects placeholders", () => {
    expect(normalizeAlnumKey("SM-S918B/DS")).toEqual({ key: "SMS918BDS", original: "SM-S918B/DS" });
    expect(normalizeAlnumKey("sm s918b ds")?.key).toBe("SMS918BDS");
    for (const v of ["N/A", "ab", "0000", "unknown", "", null]) expect(normalizeAlnumKey(v as never), String(v)).toBeNull();
  });
});

describe("brand & manufacturer identity", () => {
  it("resolves Samsung, SAMSUNG and Samsung India to one brand key", () => {
    const keys = ["Samsung", "SAMSUNG", "Samsung India", "Samsung India Pvt. Ltd."].map(entityKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("samsung");
  });

  it("preserves the original spelling", () => {
    expect(normalizeEntity("Samsung India")).toMatchObject({ key: "samsung", display: "Samsung India", original: "Samsung India" });
  });

  it("closes up spacing and apostrophes", () => {
    expect(entityKey("Good Day")).toBe(entityKey("GoodDay"));
    expect(entityKey("Haldiram's")).toBe(entityKey("Haldirams"));
    expect(entityKey("The Body Shop")).toBe("bodyshop");
  });

  it("never strips a name down to nothing", () => {
    expect(entityKey("India")).toBe("india");
    expect(entityKey("India Gate")).toBe("indiagate");
  });

  it("splits multi-brand fields, dedupes, and identifies company names", () => {
    expect(splitBrandList("Amul, Gujarat Cooperative Milk Marketing Federation, AMUL")).toEqual([
      "Amul",
      "Gujarat Cooperative Milk Marketing Federation",
    ]);
    expect(looksLikeCompany("Gujarat Cooperative Milk Marketing Federation")).toBe(true);
    expect(looksLikeCompany("Amul")).toBe(false);
    expect(normalizeEntity("N/A")).toBeNull();
  });
});

describe("tax normalisation", () => {
  it.each([
    ["18%", 1800], ["GST 5", 500], [18, 1800], ["IGST@12.0%", 1200], ["0.18", 1800], ["0.25%", 25], ["0", 0], ["28 %", 2800],
  ])("GST %s -> %d bp", (raw, bp) => {
    expect(parseGstRate(raw)).toBe(bp);
  });

  it("rejects nonsense and out-of-range rates", () => {
    expect(parseGstRate("abc")).toBeNull();
    expect(parseGstRate(150)).toBeNull();
    expect(parseGstRate(null)).toBeNull();
  });

  it("classifies slabs as current, legacy or unusual", () => {
    expect(gstSlabStatus(500)).toBe("CURRENT");
    expect(gstSlabStatus(1800)).toBe("CURRENT");
    expect(gstSlabStatus(1200)).toBe("LEGACY");
    expect(gstSlabStatus(2800)).toBe("LEGACY");
    expect(gstSlabStatus(1700)).toBe("UNUSUAL");
  });

  it("normalises HSN to digits and enforces length and goods chapters", () => {
    expect(normalizeHsn("1905.31.00")).toBe("19053100");
    expect(normalizeHsn("0401")).toBe("0401");
    expect(normalizeHsn("190")).toBeNull();
    expect(normalizeHsn("999999")).toBeNull();
    expect(normalizeHsn("ab1234")).toBeNull();
  });

  it("validates FSSAI and GSTIN structure", () => {
    expect(normalizeFssai("10012011000123")).toBe("10012011000123");
    expect(normalizeFssai("3001201100012")).toBeNull();
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1")).toBe(false);
  });
});

describe("colour, size, country, money, stock", () => {
  it("normalises colour phrases and families", () => {
    expect(normalizeColor("Midnight Black")).toMatchObject({ key: "midnight black", family: "black" });
    expect(normalizeColor("Space Gray Colour")).toMatchObject({ key: "space grey", family: "grey" });
    expect(normalizeColor("n/a")).toBeNull();
  });

  it("folds apparel sizes", () => {
    expect(normalizeSize("Extra Large")?.display).toBe("XL");
    expect(normalizeSize("M")?.display).toBe("M");
    expect(normalizeSize("Free Size")?.display).toBe("FREE SIZE");
    expect(normalizeSize("32")?.display).toBe("32");
  });

  it("maps country spellings to one name", () => {
    for (const v of ["India", "IN", "IND", "Made in India", "Bharat", "product of india"]) {
      expect(normalizeCountry(v)?.name, v).toBe("India");
    }
    expect(normalizeCountry("Gujarat, India")?.name).toBe("India");
    expect(normalizeCountry("USA")?.name).toBe("United States");
    expect(normalizeCountry("Atlantis")).toMatchObject({ recognised: false });
  });

  it("converts money to integer minor units and refuses ambiguous input", () => {
    expect(toMinorUnits("₹1,299.00")).toBe(129900);
    expect(toMinorUnits("Rs. 99")).toBe(9900);
    expect(toMinorUnits(117.5)).toBe(11750);
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
    expect(toMinorUnits("99-120")).toBeNull();
    expect(toMinorUnits("free")).toBeNull();
    expect(toMinorUnits(-5)).toBeNull();
  });

  it("reads stock and boolean text", () => {
    expect(parseStockStatus("In Stock")).toBe("IN_STOCK");
    expect(parseStockStatus("Currently unavailable")).toBe("OUT_OF_STOCK");
    expect(parseStockStatus("Only 3 left")).toBe("LIMITED");
    expect(parseStockStatus("???")).toBe("UNKNOWN");
    expect(parseStockStatus(null)).toBe("UNKNOWN");
    expect(parseBoolean("Yes")).toBe(true);
    expect(parseBoolean("0")).toBe(false);
    expect(parseBoolean("maybe")).toBeNull();
  });
});

describe("normalizeStaged", () => {
  const ctx = { categoryMapper: NULL_MAPPER, now: new Date("2026-09-19T00:00:00Z") };

  it("builds the canonical product from a messy record", () => {
    const n = normalizeStaged(
      {
        sourceProductId: "8901058895780",
        name: "Amul Taaza Toned Milk 1 L Pouch",
        brand: "Amul, Gujarat Co-operative Milk Marketing Federation",
        gtin: "8901058895780",
        countryOfOrigin: "Made in India",
        gstRate: "5%",
        hsnCode: "0401.20.00",
      },
      ctx,
    );
    expect(n.brand?.key).toBe("amul");
    expect(n.manufacturer?.display).toBe("Gujarat Co-operative Milk Marketing Federation");
    expect(n.gtin?.gtin14).toBe("08901058895780");
    expect(n.quantity).toMatchObject({ unitValue: 1000, unit: "ml", label: "1000 ml" });
    expect(n.coreName).toBe("taaza toned milk pouch");
    expect(n.countryOfOrigin).toBe("India");
    expect(n.gstRateBp).toBe(500);
    expect(n.hsnCode).toBe("04012000");
    expect(n.categoryCode).toBe("uncategorised/unmapped");
    expect(n.issues.some((i) => i.severity === "ERROR")).toBe(false);
  });

  it("projects tracked facts into attributes so each keeps its own source", () => {
    const n = normalizeStaged(
      { sourceProductId: "x", name: "Test Phone", color: "Midnight Black", model: "SM-S918B", gstRate: 18 },
      ctx,
    );
    const keys = n.attributes.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["color", "model_number", "gst_rate_bp"]));
    expect(n.attributes.find((a) => a.key === "gst_rate_bp")).toMatchObject({ valueNum: 1800 });
  });

  it("records issues instead of throwing", () => {
    const n = normalizeStaged(
      { sourceProductId: "bad", name: "", gtin: "8901058895781", gstRate: "abc", hsnCode: "12", offer: { price: "free", mrp: 10 } },
      ctx,
    );
    const codes = n.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["NAME_MISSING", "GTIN_CHECK_DIGIT_INVALID", "GST_RATE_INVALID", "HSN_INVALID", "PRICE_UNPARSEABLE"]));
    expect(n.issues.find((i) => i.code === "NAME_MISSING")?.severity).toBe("ERROR");
    expect(n.gtin?.usableForMatching).toBe(false);
  });

  it("flags a selling price above MRP (Legal Metrology) but keeps the data", () => {
    const n = normalizeStaged({ sourceProductId: "p", name: "Item", offer: { price: 120, mrp: 100, sellerName: "S" } }, ctx);
    expect(n.issues.map((i) => i.code)).toContain("PRICE_ABOVE_MRP");
    expect(n.offer).toMatchObject({ priceMinor: 12000, mrpMinor: 10000 });
  });

  it("normalises an offer to minor units and derives a stable seller key", () => {
    const n = normalizeStaged(
      { sourceProductId: "p", name: "Item", offer: { price: "₹117.50", sellerName: "Big Bazaar", stock: "in stock", collectedAt: "2026-09-01" } },
      ctx,
    );
    expect(n.offer).toMatchObject({ priceMinor: 11750, currency: "INR", stockStatus: "IN_STOCK", sellerKey: "big bazaar" });
    expect(n.offer?.collectedAt.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("keeps missing values as null, not zero", () => {
    const n = normalizeStaged({ sourceProductId: "p", name: "Mystery Item" }, ctx);
    expect(n.quantity).toBeNull();
    expect(n.gstRateBp).toBeNull();
    expect(n.hsnCode).toBeNull();
    expect(n.netWeightG).toBeNull();
    expect(n.offer).toBeNull();
  });

  it("treats placeholder names as no name instead of inventing a product called '1'", () => {
    for (const junk of ["Loading…", "1", "2", "xx", "Unknown", "e", "  ", "1234"]) {
      const n = normalizeStaged({ sourceProductId: "j", name: junk }, ctx);
      expect(n.name, junk).toBe("");
      expect(n.issues.map((i) => i.code), junk).toContain("NAME_MISSING");
    }
    // Real short names survive.
    for (const real of ["Axe", "RED", "Vim", "Tang", "Egg"]) {
      expect(normalizeStaged({ sourceProductId: "j", name: real }, ctx).name).toBe(real);
    }
  });

  it("buildCoreName removes the brand however it is spaced and keeps a brand-only name empty", () => {
    expect(buildCoreName("Britannia Good Day Butter Cookies 100 g", "britannia")).toBe("good day butter cookies");
    expect(buildCoreName("Good Day Butter 100 g", "goodday")).toBe("butter");
    expect(buildCoreName("Coca-Cola 500 ml", "cocacola")).toBe("");
  });
});
