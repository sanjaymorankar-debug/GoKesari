/**
 * Normalisation and validation of the identifiers used to stop duplicate
 * shop registrations (lib/shop-identity.ts), and the PAN blind index
 * (lib/pan-crypto.ts panBlindIndex). The identifiers below are made up —
 * syntactically valid, not real registrations.
 */
import { describe, expect, it } from "vitest";

import { panBlindIndex } from "@/lib/pan-crypto";
import {
  looseKey,
  parsePanNumber,
  parseShopActNumber,
  parseUdyamNumber,
} from "@/lib/shop-identity";

describe("parseShopActNumber", () => {
  it("gives the same key whatever the spacing, case and separators", () => {
    const keys = [
      "PII/KOTHRUD/II/12345",
      "  pii/kothrud/ii/12345 ",
      "PII - KOTHRUD - II - 12345",
      "pii.kothrud.ii.12345",
      "PII KOTHRUD II 12345",
    ].map((raw) => {
      const parsed = parseShopActNumber(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value.key;
    });
    expect(new Set(keys)).toEqual(new Set(["PIIKOTHRUDII12345"]));
  });

  it("keeps a readable display form: trimmed, uppercased, single spaces", () => {
    const parsed = parseShopActNumber("  pii/kothrud   ii/12345 ");
    expect(parsed).toEqual({
      ok: true,
      value: { display: "PII/KOTHRUD II/12345", key: "PIIKOTHRUDII12345" },
    });
  });

  it.each(["NA", "N/A", "nil", "None", "0000000", "APPLIED", "12", "ABCDEFGH"])(
    "refuses a placeholder or implausible value: %s",
    (raw) => {
      expect(parseShopActNumber(raw).ok).toBe(false);
    },
  );

  it("refuses characters outside English letters, digits and separators", () => {
    expect(parseShopActNumber("२७३१०००३१८").ok).toBe(false);
    expect(parseShopActNumber("ABC#12345").ok).toBe(false);
  });
});

describe("parsePanNumber", () => {
  it("normalises case, spaces and hyphens", () => {
    expect(parsePanNumber(" abcde 1234 f ")).toEqual({ ok: true, value: "ABCDE1234F" });
    expect(parsePanNumber("ABCDE-1234-F")).toEqual({ ok: true, value: "ABCDE1234F" });
  });

  it.each(["ABCD1234F", "ABCDE12345", "12345ABCDF", "ABCDE1234FG", ""])(
    "refuses a value not in the AAAAA9999A format: %s",
    (raw) => {
      expect(parsePanNumber(raw).ok).toBe(false);
    },
  );
});

describe("parseUdyamNumber", () => {
  it("stores a Udyam number in the canonical UDYAM-XX-00-0000000 form", () => {
    for (const raw of ["UDYAM-MH-26-0012345", "udyam mh 26 0012345", "UDYAMMH260012345"]) {
      expect(parseUdyamNumber(raw)).toEqual({ ok: true, value: "UDYAM-MH-26-0012345" });
    }
  });

  it("accepts an old Udyog Aadhaar number in its real 12-character format", () => {
    expect(parseUdyamNumber("mh26a0012345")).toEqual({ ok: true, value: "MH26A0012345" });
  });

  it("refuses a bare 12-digit number, which looks like a personal Aadhaar number", () => {
    const parsed = parseUdyamNumber("1234 5678 9012");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Aadhaar/);
  });

  it("refuses anything else", () => {
    expect(parseUdyamNumber("UDYAM-MH-26-123").ok).toBe(false);
    expect(parseUdyamNumber("hello").ok).toBe(false);
  });
});

describe("looseKey", () => {
  it("ignores case, spacing and punctuation but keeps letters of any script", () => {
    expect(looseKey("Shree  Dairy & Sweets")).toBe("shreedairysweets");
    expect(looseKey("Shree Dairy.")).toBe("shreedairy");
    // Devanagari vowel signs are combining marks — they must still count.
    expect(looseKey("श्री डेअरी")).toBe("श्रीडेअरी");
    expect(looseKey("श्री")).not.toBe(looseKey("शरी"));
    expect(looseKey(null)).toBe("");
  });
});

describe("panBlindIndex", () => {
  it("is deterministic, distinct per PAN, and does not contain the PAN", () => {
    const a = panBlindIndex("ABCDE1234F");
    expect(a).toBe(panBlindIndex("ABCDE1234F"));
    expect(a).not.toBe(panBlindIndex("ABCDE1234G"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("ABCDE1234F");
  });
});
