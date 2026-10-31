/**
 * GST on every order line — worked examples per rate slab, intra-state
 * (CGST + SGST) and inter-state (IGST), tax-inclusive prices, line rounding
 * and ad-valorem cess. Amounts are in paise.
 */
import { describe, expect, it } from "vitest";

import { chargesGst } from "@/server/gst/tax-data-check";
import { lineTax, splitInclusive, splitInclusiveWithCess } from "@/server/services/invoices";

describe("GST slabs on a tax-inclusive price", () => {
  // Rs 100 of value at each slab: the price is 100 + GST.
  const slabs: [string, number, number][] = [
    ["0% (exempt / nil)", 0, 10_000],
    ["5%", 500, 10_500],
    ["12% (legacy slab, still on older listings)", 1_200, 11_200],
    ["18%", 1_800, 11_800],
    ["28% (legacy slab)", 2_800, 12_800],
    ["40% (GST 2.0 demerit slab)", 4_000, 14_000],
  ];

  for (const [name, rateBp, gross] of slabs) {
    it(`TC-GST-SLAB ${name}: Rs ${gross / 100} → taxable Rs 100, tax split intra and inter`, () => {
      const tax = gross - 10_000;
      expect(splitInclusive(gross, rateBp, "INTRA")).toEqual({
        taxablePaise: 10_000,
        cgstPaise: tax / 2,
        sgstPaise: tax / 2,
        igstPaise: 0,
      });
      expect(splitInclusive(gross, rateBp, "INTER")).toEqual({
        taxablePaise: 10_000,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: tax,
      });
    });
  }

  it("TC-GST-ROUND rounds the taxable value per line and gives the odd paisa to SGST", () => {
    // Rs 99.99 at 18%: 9999 × 10000 / 11800 = 8473.73 → 8474; tax 1525 = 762 + 763.
    expect(splitInclusive(9_999, 1_800, "INTRA")).toEqual({ taxablePaise: 8_474, cgstPaise: 762, sgstPaise: 763, igstPaise: 0 });
    expect(splitInclusive(9_999, 1_800, "INTER")).toEqual({ taxablePaise: 8_474, cgstPaise: 0, sgstPaise: 0, igstPaise: 1_525 });
    // 99 paise at 5%: 94.29 → 94; tax 5 = 2 + 3.
    expect(splitInclusive(99, 500, "INTRA")).toEqual({ taxablePaise: 94, cgstPaise: 2, sgstPaise: 3, igstPaise: 0 });
  });

  it("TC-GST-SUM the parts always add up to the price charged", () => {
    for (const rateBp of [0, 25, 300, 500, 1_200, 1_800, 2_800, 4_000]) {
      for (const cessBp of [0, 100, 1_200, 6_000]) {
        for (let gross = 1; gross < 50_000; gross += 997) {
          for (const supply of ["INTRA", "INTER"] as const) {
            const t = splitInclusiveWithCess(gross, rateBp, cessBp, supply);
            const parts = [t.taxablePaise, t.cgstPaise, t.sgstPaise, t.igstPaise, t.cessPaise];
            expect(parts.reduce((a, b) => a + b, 0)).toBe(gross);
            for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe("compensation cess (ad valorem)", () => {
  it("TC-GST-CESS 28% + 12% cess: Rs 140 → taxable 100, GST 28, cess 12", () => {
    expect(splitInclusiveWithCess(14_000, 2_800, 1_200, "INTRA")).toEqual({
      taxablePaise: 10_000,
      cgstPaise: 1_400,
      sgstPaise: 1_400,
      igstPaise: 0,
      cessPaise: 1_200,
    });
    expect(splitInclusiveWithCess(14_000, 2_800, 1_200, "INTER")).toEqual({
      taxablePaise: 10_000,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 2_800,
      cessPaise: 1_200,
    });
  });

  it("TC-GST-CESS-ROUND rounds the taxable value, then the cess, and leaves the rest as GST", () => {
    // 10001 × 10000 / 14000 = 7143.57 → 7144; cess 857.28 → 857; GST 2000.
    expect(splitInclusiveWithCess(10_001, 2_800, 1_200, "INTRA")).toEqual({
      taxablePaise: 7_144,
      cgstPaise: 1_000,
      sgstPaise: 1_000,
      igstPaise: 0,
      cessPaise: 857,
    });
  });

  it("TC-GST-CESS-NIL a cess on a 0% line is the whole tax part", () => {
    expect(splitInclusiveWithCess(11_200, 0, 1_200, "INTRA")).toEqual({ taxablePaise: 10_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 1_200 });
  });

  it("TC-GST-CESS-SHAPE a line without cess keeps the invoice line shape it always had", () => {
    expect(lineTax(11_800, 1_800, 0, "INTRA")).toEqual(splitInclusive(11_800, 1_800, "INTRA"));
    expect(lineTax(14_000, 2_800, 1_200, "INTRA")).toMatchObject({ cessBp: 1_200, cessPaise: 1_200 });
  });
});

describe("who charges GST", () => {
  it("TC-GST-REG a regular GSTIN charges GST; composition and PAN-only sellers issue a bill of supply", () => {
    expect(chargesGst({ gstin: "27AAAPL1234C1ZV", gstStatus: "REGISTERED" })).toBe(true);
    expect(chargesGst({ gstin: "27AAAPL1234C1ZV", gstStatus: "COMPOSITION" })).toBe(false);
    expect(chargesGst({ gstin: null, gstStatus: "NOT_REGISTERED" })).toBe(false);
    expect(chargesGst({ gstin: "not-a-gstin", gstStatus: "REGISTERED" })).toBe(false);
  });
});
