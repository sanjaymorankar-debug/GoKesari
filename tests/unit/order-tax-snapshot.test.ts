/**
 * The GST included in an order's lines (migration 0185), the TCS / TDS base
 * without GST, unconfirmed statutory rows on production, GST16 invoice
 * numbers and the GSTR-8 CSV. Amounts are in paise.
 */
import { describe, expect, it, vi } from "vitest";

import type { StatutoryRate } from "@/server/db/schema";
import { formatDocumentNumber } from "@/server/gst/rules";
import { orderConfirmedEmailRows } from "@/server/services/orders";
import { splitInclusiveWithCess } from "@/server/services/invoices";
import { tcsOn, tdsOn, type StatutoryResolver } from "@/server/statutory/rates";
import { includedLineTax, orderTaxSnapshot, payoutTaxableBase, type PayoutTaxItem } from "@/server/tax/order-snapshot";
import { gstr8Csv, GSTR8_CSV_HEADER } from "@/server/tax/statements";

const GST = { chargesGst: true, applyCess: true } as const;

describe("included GST per line", () => {
  it("splits an 18% line intra-state into CGST + SGST and inter-state into IGST, same taxable and tax", () => {
    const intra = includedLineTax(11_800, { gstRateBp: 1_800, cessBp: 0 }, { ...GST, supply: "INTRA" })!;
    const inter = includedLineTax(11_800, { gstRateBp: 1_800, cessBp: 0 }, { ...GST, supply: "INTER" })!;
    expect(intra).toEqual({ taxablePaise: 10_000, taxPaise: 1_800, cgstPaise: 900, sgstPaise: 900, igstPaise: 0, cessPaise: 0 });
    expect(inter).toEqual({ taxablePaise: 10_000, taxPaise: 1_800, cgstPaise: 0, sgstPaise: 0, igstPaise: 1_800, cessPaise: 0 });
  });

  it("includes cess in the tax (28% + 12% cess): taxable + tax = the line total", () => {
    const s = includedLineTax(14_000, { gstRateBp: 2_800, cessBp: 1_200 }, { ...GST, supply: "INTRA" })!;
    expect(s.taxablePaise).toBe(10_000);
    expect(s.cessPaise).toBe(1_200);
    expect(s.cgstPaise + s.sgstPaise).toBe(2_800);
    expect(s.taxPaise).toBe(4_000);
    expect(s.taxablePaise + s.taxPaise).toBe(14_000);
    // Same maths as the invoice.
    expect(s.taxablePaise).toBe(splitInclusiveWithCess(14_000, 2_800, 1_200, "INTRA").taxablePaise);
  });

  it("leaves cess out when the invoicing rule does not apply it", () => {
    const s = includedLineTax(14_000, { gstRateBp: 2_800, cessBp: 1_200 }, { chargesGst: true, applyCess: false, supply: "INTRA" })!;
    expect(s.cessPaise).toBe(0);
    expect(s.taxablePaise).toBe(10_938); // round(14000 / 1.28)
    expect(s.taxablePaise + s.taxPaise).toBe(14_000);
  });

  it("rounds per line and never loses a paisa (odd amounts, 5% and 12%)", () => {
    for (const gross of [1, 7, 99, 101, 1_049, 12_345, 99_999]) {
      for (const rate of [500, 1_200, 1_800]) {
        const s = includedLineTax(gross, { gstRateBp: rate, cessBp: 0 }, { ...GST, supply: "INTRA" })!;
        expect(s.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(gross);
        expect(s.taxablePaise + s.taxPaise).toBe(gross);
        expect(Math.abs(s.cgstPaise - s.sgstPaise)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a shop that charges no GST has no tax in its price", () => {
    expect(includedLineTax(11_800, { gstRateBp: 1_800, cessBp: 0 }, { chargesGst: false, applyCess: true, supply: "INTRA" })).toMatchObject({
      taxablePaise: 11_800,
      taxPaise: 0,
    });
  });

  it("an unknown rate stays unknown — never all-taxable", () => {
    expect(includedLineTax(11_800, { gstRateBp: null, cessBp: 0 }, { ...GST, supply: "INTRA" })).toBeNull();
  });
});

describe("order tax snapshot", () => {
  const lines = [
    { lineTotalPaise: 11_800, cls: { hsnCode: "33051090", gstRateBp: 1_800, cessBp: 0 } },
    { lineTotalPaise: 10_500, cls: { hsnCode: "0401", gstRateBp: 500, cessBp: 0 } },
    { lineTotalPaise: 14_000, cls: { hsnCode: "2202", gstRateBp: 2_800, cessBp: 1_200 } },
  ];

  it("records each line and the included total, and the order total is unchanged", () => {
    const subtotal = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
    const snap = orderTaxSnapshot(lines, { ...GST, supply: "INTRA" });
    expect(snap.lines).toEqual([
      { hsnCode: "33051090", gstRateBp: 1_800, cessBp: 0, taxablePaise: 10_000, taxPaise: 1_800 },
      { hsnCode: "0401", gstRateBp: 500, cessBp: 0, taxablePaise: 10_000, taxPaise: 500 },
      { hsnCode: "2202", gstRateBp: 2_800, cessBp: 1_200, taxablePaise: 10_000, taxPaise: 4_000 },
    ]);
    expect(snap.taxIncludedPaise).toBe(6_300);
    // The included GST is inside the prices: taxable + tax per line = what the customer pays for the goods.
    expect(snap.lines.reduce((s, l) => s + l.taxablePaise! + l.taxPaise!, 0)).toBe(subtotal);
    // Inter-state does not change the amounts recorded.
    expect(orderTaxSnapshot(lines, { ...GST, supply: "INTER" })).toEqual(snap);
  });

  it("an order with a line of unknown rate has no included total; the known lines are still recorded", () => {
    const snap = orderTaxSnapshot([...lines, { lineTotalPaise: 5_000, cls: undefined }], { ...GST, supply: "INTRA" });
    expect(snap.taxIncludedPaise).toBeNull();
    expect(snap.lines[3]).toEqual({ hsnCode: null, gstRateBp: null, cessBp: null, taxablePaise: null, taxPaise: null });
    expect(snap.lines[0].taxPaise).toBe(1_800);
  });

  it("the confirmation e-mail shows the included GST under the total, never adding it", () => {
    const rows = orderConfirmedEmailRows({
      lines: [{ name: "Shampoo", unit: "PIECE", quantityMilli: 1_000, lineTotalPaise: 11_800 }],
      deliveryFeePaise: 2_000,
      taxIncludedPaise: 1_800,
      discountPaise: 0,
      totalPaise: 13_800,
      paymentMethod: "ONLINE",
    });
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain("Tax");
    expect(rows.at(-2)).toMatchObject({ label: "Total", value: "₹138.00" });
    expect(rows.at(-1)).toEqual({ label: "Prices include GST", value: "incl. GST ₹18.00" });
    // Unknown → no GST line at all.
    const unknown = orderConfirmedEmailRows({ lines: [], deliveryFeePaise: 0, taxIncludedPaise: null, discountPaise: 0, totalPaise: 0, paymentMethod: "COD" });
    expect(unknown.some((r) => r.label.includes("GST"))).toBe(false);
  });
});

describe("TCS / TDS base without GST", () => {
  const item = (over: Partial<PayoutTaxItem>): PayoutTaxItem => ({
    fulfilmentStatus: "PENDING",
    lineTotalPaise: 11_800,
    substituteLineTotalPaise: null,
    taxablePaise: 10_000,
    gstRateBp: 1_800,
    cessBp: 0,
    live: undefined,
    ...over,
  });

  it("uses the checkout snapshot's taxable value, not the GST-inclusive goods value", () => {
    const b = payoutTaxableBase(11_800, [item({})], GST);
    expect(b).toEqual({ taxablePaise: 10_000, source: "ORDER_SNAPSHOT", unratedGrossPaise: 0 });
    expect(b.taxablePaise).toBeLessThan(11_800);
  });

  it("works it out of today's rate for an order placed before the snapshot", () => {
    const b = payoutTaxableBase(10_500, [item({ lineTotalPaise: 10_500, taxablePaise: null, gstRateBp: null, cessBp: null, live: { hsnCode: "0401", gstRateBp: 500, cessBp: 0 } })], GST);
    expect(b).toEqual({ taxablePaise: 10_000, source: "COMPUTED", unratedGrossPaise: 0 });
  });

  it("a substituted line uses the substitute's rate; a removed line is left out", () => {
    const b = payoutTaxableBase(
      10_500,
      [
        item({ fulfilmentStatus: "SUBSTITUTED", substituteLineTotalPaise: 10_500, live: { hsnCode: "0401", gstRateBp: 500, cessBp: 0 } }),
        item({ fulfilmentStatus: "REMOVED" }),
      ],
      GST,
    );
    expect(b.taxablePaise).toBe(10_000);
  });

  it("a line with no known rate adds nothing to the base and is reported", () => {
    const b = payoutTaxableBase(23_600, [item({}), item({ taxablePaise: null, gstRateBp: null, cessBp: null })], GST);
    expect(b.unratedGrossPaise).toBe(11_800);
    expect(b.taxablePaise).toBe(10_000);
  });

  it("follows the goods value in proportion (an adjusted order)", () => {
    expect(payoutTaxableBase(5_900, [item({})], GST).taxablePaise).toBe(5_000);
  });

  it("a shop that charges no GST: the base is the goods value", () => {
    expect(payoutTaxableBase(11_800, [item({ taxablePaise: null, gstRateBp: null, cessBp: null })], { chargesGst: false, applyCess: true }).taxablePaise).toBe(11_800);
  });
});

describe("unconfirmed TCS / TDS rows", () => {
  const row = (key: string, confirmedByCa: boolean): StatutoryRate =>
    ({
      id: `row-${key}-${confirmedByCa}`,
      key,
      effectiveFrom: "2024-07-10",
      effectiveTo: null,
      enabled: true,
      rateBp: key === "GST_TCS_SEC52" ? 50 : 10,
      params: {},
      confirmedByCa,
    }) as unknown as StatutoryRate;
  const resolver = (confirmed: boolean): StatutoryResolver => (async (key: string) => row(key, confirmed)) as unknown as StatutoryResolver;

  it("are skipped on production and logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await tcsOn("2026-11-20", resolver(false), { production: true })).toBeNull();
    expect(await tcsOn("2026-11-21", resolver(false), { production: true })).toBeNull();
    expect(await tdsOn("2026-11-20", resolver(false), { production: true })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2); // once per row
    warn.mockRestore();
  });

  it("are used on test and local sites as before", async () => {
    expect(await tcsOn("2026-11-20", resolver(false), { production: false })).toMatchObject({ rateBp: 50 });
    expect(await tdsOn("2026-11-20", resolver(false))).toMatchObject({ rateBp: 10 });
  });

  it("confirmed rows apply on production", async () => {
    expect(await tcsOn("2026-11-20", resolver(true), { production: true })).toMatchObject({ rateBp: 50 });
    expect(await tdsOn("2026-11-20", resolver(true), { production: true })).toMatchObject({ rateBp: 10 });
  });
});

describe("GST16 invoice numbers", () => {
  it("fit the 16-character limit, even past a million documents in a year", () => {
    for (const seq of [1, 999_999, 1_000_000, 9_999_999]) {
      for (const kind of ["INVOICE", "CREDIT_NOTE"] as const) {
        const n = formatDocumentNumber("GST16", kind, "GKMH0000123456", "2026-27", seq);
        expect(n.length).toBeLessThanOrEqual(16);
        expect(n).toMatch(/^(GK|CN)2627-\d{6,7}$/);
      }
    }
    expect(formatDocumentNumber("GST16", "INVOICE", "X", "2026-27", 1)).toBe("GK2627-000001");
  });

  it("LEGACY numbers stay as they are (longer than 16)", () => {
    expect(formatDocumentNumber("LEGACY", "INVOICE", "GKMH0000123456", "2026-27", 1)).toBe("GKMH0000123456/2026-27/000001");
  });
});

describe("GSTR-8 CSV", () => {
  it("one row per supplier, supply and place of supply, and a total", () => {
    const csv = gstr8Csv({
      gstin: "27AAACG1234A1Z5",
      fp: "112026",
      tcs: [
        { stin: "27ABCDE1234F1Z5", supplierType: "REGISTERED", supply: "B2C", pos: "27", grsval: 1000, retsup: 100, netval: 900, iamt: 0, camt: 2.25, samt: 2.25, flag: "N" },
      ],
      tcsa: [],
      summary: { suppliers: 1, grsval: 1000, retsup: 100, netval: 900, iamt: 0, camt: 2.25, samt: 2.25 },
    });
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe(GSTR8_CSV_HEADER.join(","));
    expect(rows[1]).toBe("27ABCDE1234F1Z5,REGISTERED,B2C,27,1000,100,900,0,2.25,2.25");
    expect(rows[2]).toBe("TOTAL,,,,1000,100,900,0,2.25,2.25");
  });
});
