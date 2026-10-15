/**
 * Inventory & Accounting (docs/inventory-accounting-2026-10): the pure rules —
 * GST maths and place of supply, unit conversion, FIFO / weighted-average
 * valuation, GST set-off and due dates, reconciliation matching, product
 * matching, local bill-text reading and the review checks.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeTotals, draftToPurchase, emptyDraft, emptyLine, f, purchaseToDraft, validateDraft, type BillDraft } from "@/lib/accounts/bill-draft";
import { parseBillDate, parseBillSheet, parseBillText } from "@/lib/accounts/bill-text-parse";
import { financialYear, invoiceTotals, isInterState, lineTax, stateOfGstin } from "@/lib/accounts/gst-math";
import { dueDatesFor, monthsBetween, quarterMonths, quarterOf, setOff } from "@/lib/accounts/gst-liability";
import { ACCOUNTS_NAV, ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { reconcile } from "@/lib/accounts/reconcile";
import { invoiceNoKey, itemKey, similarity, supplierKey } from "@/lib/accounts/text-match";
import { normaliseUnit, toStockQtyMilli } from "@/lib/accounts/units";
import { batchBalances, valueStock, type ValuationEntry } from "@/lib/accounts/valuation";
import { gstin } from "../helpers/gstin";

const SUPPLIER = gstin("27", "AABCS5678B");

describe("GST maths", () => {
  it("splits CGST/SGST within a state and IGST across states", () => {
    const intra = lineTax({ qtyMilli: 12_000, ratePaise: 55_000, gstRateBp: 1200 }, false);
    expect(intra).toMatchObject({ taxablePaise: 660_000, cgstPaise: 39_600, sgstPaise: 39_600, igstPaise: 0, totalPaise: 739_200 });
    const inter = lineTax({ qtyMilli: 12_000, ratePaise: 55_000, gstRateBp: 1200 }, true);
    expect(inter).toMatchObject({ igstPaise: 79_200, cgstPaise: 0, totalPaise: 739_200 });
  });
  it("handles fractional quantities, discounts and rounds the bill to the rupee", () => {
    const l = lineTax({ qtyMilli: 2_500, ratePaise: 4_999, discountPaise: 500, gstRateBp: 500 }, false);
    expect(l.taxablePaise).toBe(12_498 - 500); // 2.5 × ₹49.99 = ₹124.975 → ₹124.98
    const t = invoiceTotals([l]);
    expect(t.totalPaise % 100).toBe(0);
    expect(t.totalPaise - t.roundOffPaise).toBe(l.totalPaise);
  });
  it("place of supply and financial year", () => {
    expect(isInterState("27", "27")).toBe(false);
    expect(isInterState("27", "29")).toBe(true);
    expect(isInterState(null, "29")).toBe(false);
    expect(stateOfGstin(SUPPLIER)).toBe("27");
    expect(financialYear("2026-03-31")).toBe("2025-26");
    expect(financialYear("2026-04-01")).toBe("2026-27");
  });
});

describe("units", () => {
  const pouch = { unit: "L", unitSizeMilli: 500 };
  it("converts weight and volume exactly, counts as sellable units", () => {
    expect(toStockQtyMilli(6_000, "LTR", pouch)).toEqual({ ok: true, stockQtyMilli: 12_000, method: "dimension" });
    expect(toStockQtyMilli(500_000, "ml", pouch)).toMatchObject({ ok: true, stockQtyMilli: 1_000 });
    expect(toStockQtyMilli(2_500, "kg", { unit: "kg", unitSizeMilli: 1000 })).toMatchObject({ ok: true, stockQtyMilli: 2_500 });
    expect(toStockQtyMilli(24_000, "NOS", pouch)).toMatchObject({ ok: true, stockQtyMilli: 24_000 });
    expect(toStockQtyMilli(2_000, "dozen", { unit: "piece", unitSizeMilli: 1000 })).toMatchObject({ ok: true, stockQtyMilli: 24_000 });
  });
  it("asks for a conversion when units don't convert, and uses a saved one", () => {
    expect(toStockQtyMilli(1_000, "case", pouch)).toMatchObject({ ok: false, reason: "UNKNOWN_UNIT" });
    expect(toStockQtyMilli(1_000, "kg", pouch)).toMatchObject({ ok: false, reason: "DIMENSION_MISMATCH" });
    expect(toStockQtyMilli(2_000, "case", pouch, 24_000)).toEqual({ ok: true, stockQtyMilli: 48_000, method: "saved" });
  });
  it("reads Hindi / Marathi unit words", () => {
    expect(normaliseUnit("किलो")).toBe("kg");
    expect(normaliseUnit("लिटर")).toBe("l");
    expect(normaliseUnit("नग")).toBe("piece");
  });
});

describe("valuation", () => {
  const e = (id: string, movementType: ValuationEntry["movementType"], qtyMilli: number, unitCostPaise: number | null = null, reversesId: string | null = null): ValuationEntry => ({ id, movementType, qtyMilli, unitCostPaise, reversesId, entryDate: "2026-10-01" });
  const entries = [e("a", "PURCHASE", 10_000, 4000), e("b", "PURCHASE", 10_000, 6000), e("s", "SALE", -12_000)];
  it("FIFO takes the oldest cost first", () => {
    const v = valueStock(entries, "FIFO");
    expect(v.qtyMilli).toBe(8_000);
    expect(v.valuePaise).toBe(48_000);
    expect(v.outCost.get("s")).toBe(40_000 + 12_000);
  });
  it("weighted average uses the running average", () => {
    const v = valueStock(entries, "WAVG");
    expect(v.valuePaise).toBe(40_000);
    expect(v.outCost.get("s")).toBe(60_000);
  });
  it("a reversal takes back exactly the reversed purchase", () => {
    const v = valueStock([e("a", "PURCHASE", 10_000, 4000), e("b", "PURCHASE", 5_000, 9000), e("r", "REVERSAL", -5_000, 9000, "b")], "FIFO");
    expect(v.valuePaise).toBe(40_000);
    const w = valueStock([e("a", "PURCHASE", 10_000, 4000), e("b", "PURCHASE", 5_000, 9000), e("r", "REVERSAL", -5_000, 9000, "b")], "WAVG");
    expect(w.valuePaise).toBe(40_000);
  });
  it("uncosted opening stock is valued at the fallback cost and reported", () => {
    const v = valueStock([e("o", "OPENING", 3_000)], "FIFO", 2000);
    expect(v.valuePaise).toBe(6_000);
    expect(v.uncostedQtyMilli).toBe(3_000);
  });
  it("batches: unbatched sales come out of the earliest expiry first", () => {
    const left = batchBalances([{ batchId: "late", qtyMilli: 5_000, expiryDate: "2027-01-01" }, { batchId: "soon", qtyMilli: 5_000, expiryDate: "2026-11-01" }], 6_000);
    expect(left.get("soon")).toBe(0);
    expect(left.get("late")).toBe(4_000);
  });
});

describe("GST set-off (s.49 / rule 88A)", () => {
  it("uses IGST credit first, never CGST credit for SGST", () => {
    const r = setOff({ cgst: 1000, sgst: 1000, igst: 500, cess: 0 }, { cgst: 200, sgst: 1500, igst: 900, cess: 0 });
    expect(r.utilised.igstToIgst).toBe(500);
    expect(r.utilised.igstToCgst + r.utilised.igstToSgst).toBe(400);
    expect(r.cash.sgst).toBe(0);
    // CGST: 1000 − IGST credit (as much as needed) − 200 CGST credit.
    expect(r.cash.cgst).toBe(1000 - r.utilised.igstToCgst - 200);
    expect(r.carryForward.sgst).toBe(1500 - (1000 - r.utilised.igstToSgst));
    expect(r.totalCash).toBe(r.cash.cgst + r.cash.sgst + r.cash.igst + r.cash.cess);
  });
  it("leaves the least cash: IGST credit goes where CGST/SGST credit cannot reach", () => {
    const r = setOff({ cgst: 1000, sgst: 1000, igst: 0, cess: 0 }, { cgst: 1000, sgst: 0, igst: 1000, cess: 0 });
    expect(r.utilised.igstToSgst).toBe(1000);
    expect(r.totalCash).toBe(0);
  });
  it("carries unused credit forward", () => {
    const r = setOff({ cgst: 0, sgst: 0, igst: 0, cess: 0 }, { cgst: 300, sgst: 300, igst: 0, cess: 10 });
    expect(r.carryForward).toEqual({ cgst: 300, sgst: 300, igst: 0, cess: 10 });
  });
});

describe("GST due dates", () => {
  it("monthly: GSTR-1 on the 11th, GSTR-3B on the 20th", () => {
    expect(dueDatesFor("2026-09", "MONTHLY", "27").map((d) => d.dueDate)).toEqual(["2026-10-11", "2026-10-20"]);
    expect(dueDatesFor("2026-12", "MONTHLY", "27").map((d) => d.dueDate)).toEqual(["2027-01-11", "2027-01-20"]);
  });
  it("quarterly (QRMP): PMT-06 in months 1–2, GSTR-1 on the 13th and 3B on the 22nd/24th after the quarter", () => {
    expect(dueDatesFor("2026-07", "QUARTERLY", "27")).toEqual([expect.objectContaining({ returnType: "PMT06", dueDate: "2026-08-25" })]);
    expect(dueDatesFor("2026-09", "QUARTERLY", "27").map((d) => [d.returnType, d.dueDate])).toEqual([["GSTR1", "2026-10-13"], ["GSTR3B", "2026-10-22"]]);
    expect(dueDatesFor("2026-09", "QUARTERLY", "09").find((d) => d.returnType === "GSTR3B")!.dueDate).toBe("2026-10-24");
    expect(quarterOf(4)).toBe(1);
    expect(quarterOf(1)).toBe(4);
    expect(quarterMonths("2026-08")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(monthsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe("reconciliation", () => {
  const book = (id: string, invoiceNo: string, totalPaise: number, invoiceDate = "2026-09-05") => ({ id, supplierGstin: SUPPLIER, invoiceNo, invoiceDate, totalPaise, taxPaise: Math.round(totalPaise / 10) });
  const portal = (id: string, invoiceNo: string, totalPaise: number, invoiceDate = "2026-09-05") => ({ id, supplierGstin: SUPPLIER, invoiceNo, invoiceDate, totalPaise, taxPaise: Math.round(totalPaise / 10) });
  it("flags matched, mismatch, missing in books and missing on portal", () => {
    const rows = reconcile([book("b1", "INV/001", 100_000), book("b2", "INV-002", 50_000), book("b3", "INV-3", 70_000)], [portal("p1", "inv 1", 100_000), portal("p2", "INV/002", 60_000), portal("p9", "X-9", 1_000)]);
    const by = (s: string) => rows.filter((r) => r.status === s).map((r) => r.book?.id ?? r.portal?.id);
    expect(by("MATCHED")).toEqual(["b1"]);
    expect(by("AMOUNT_MISMATCH")).toEqual(["b2"]);
    expect(by("MISSING_ON_PORTAL")).toEqual(["b3"]);
    expect(by("MISSING_IN_BOOKS")).toEqual(["p9"]);
  });
  it("pairs a mistyped number when supplier, date and amounts agree", () => {
    const rows = reconcile([book("b1", "SV/77", 100_000)], [portal("p1", "SV/0077A", 100_000)]);
    expect(rows[0].status).toBe("MATCHED");
    expect(rows[0].note).toMatch(/invoice number on portal/);
  });
  it("normalises invoice numbers", () => {
    expect(invoiceNoKey("inv / 0012")).toBe(invoiceNoKey("INV-0012"));
    expect(invoiceNoKey("0012")).toBe("12");
  });
});

describe("product matching text", () => {
  it("scores the same product high and a different size low", () => {
    expect(similarity("AMUL TAAZA TONED MILK 500ML POUCH", "Amul Taaza Toned Milk 500 ml")).toBeGreaterThan(0.6);
    expect(similarity("AMUL TAAZA TONED MILK 1L", "Amul Taaza Toned Milk 500 ml")).toBeLessThan(similarity("AMUL TAAZA TONED MILK 500ML", "Amul Taaza Toned Milk 500 ml"));
  });
  it("keys", () => {
    expect(supplierKey(SUPPLIER, "x")).toBe(SUPPLIER);
    expect(supplierKey(null, "Ram  Traders")).toBe("name:ram traders");
    expect(itemKey("Ghee 1 L", "SKU-9")).toBe("code:sku-9");
  });
});

describe("local bill text reading", () => {
  const text = `SHREE VITTHAL DISTRIBUTORS
Market Yard, Pune
GSTIN: ${SUPPLIER}
TAX INVOICE
Invoice No: SV/2026/451    Date: 05/09/2026
Sr Description HSN Qty Rate Amount
1 AMUL COW GHEE 1L 0405 12 pcs 550.00 6600.00
2 MALAI PANEER 200G 0406 20 nos 80.00 1600.00
Taxable Value 8200.00
CGST 436.00
SGST 436.00
Grand Total 9072.00`;
  it("finds GSTIN, number, date, totals and item rows", () => {
    const b = parseBillText(text);
    expect(b.supplierGstin).toBe(SUPPLIER);
    expect(b.invoiceNo).toBe("SV/2026/451");
    expect(b.invoiceDate).toBe("2026-09-05");
    expect(b.total).toBe(9072);
    expect(b.cgst).toBe(436);
    expect(b.supplierName).toBe("SHREE VITTHAL DISTRIBUTORS");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[0]).toMatchObject({ qty: 12, rate: 550, amount: 6600, unit: "pcs" });
  });
  it("repairs OCR confusions in a GSTIN and ignores the shop's own GSTIN", () => {
    const own = gstin("27", "AAACK1234A");
    const ocr = SUPPLIER.slice(0, 7) + SUPPLIER.slice(7, 11).replace("5", "S") + SUPPLIER.slice(11);
    const b = parseBillText(`Buyer GSTIN ${own}\nSeller GSTIN ${ocr}`, own);
    expect(b.supplierGstin === SUPPLIER || b.supplierGstin === null).toBe(true);
  });
  it("dates", () => {
    expect(parseBillDate("5-9-26")).toBe("2026-09-05");
    expect(parseBillDate("05 Sep 2026")).toBe("2026-09-05");
    expect(parseBillDate("31/13/2026")).toBeNull();
  });
  it("spreadsheet item tables", () => {
    const s = parseBillSheet([["Bill"], [`GSTIN ${SUPPLIER}`], [], ["Item", "Qty", "Rate", "GST %", "Amount"], ["Ghee", "2", "500", "12%", "1000"], ["Total", "", "", "", "1120"]]);
    expect(s.lines).toEqual([expect.objectContaining({ description: "Ghee", qty: 2, rate: 500, gstRatePercent: 12, amount: 1000 })]);
  });
});

describe("review checks", () => {
  function draft(): BillDraft {
    const d = emptyDraft("27");
    d.supplierName = f("Shree Vitthal");
    d.supplierGstin = f(SUPPLIER);
    d.invoiceNo = f("SV/1");
    d.invoiceDate = f("2026-09-05");
    d.lines = [{ ...emptyLine("l1"), description: f("Ghee"), qtyMilli: f(12_000), ratePaise: f(55_000), gstRateBp: f(1200), taxablePaise: f(660_000), match: { shopProductId: "00000000-0000-0000-0000-000000000001", productName: "Ghee", method: "NAME", score: 0.9, suggestions: [], stockQtyMilli: 12_000 } }];
    d.totals.taxablePaise = f(660_000);
    d.totals.cgstPaise = f(39_600);
    d.totals.sgstPaise = f(39_600);
    d.totals.igstPaise = f(0);
    d.totals.totalPaise = f(739_200);
    return d;
  }
  it("a correct bill passes", () => {
    expect(validateDraft(draft(), { today: "2026-10-15" }).filter((i) => i.severity === "error")).toEqual([]);
    expect(computeTotals(draft()).totalPaise).toBe(739_200);
  });
  it("catches totals, GST maths, GSTIN, unmapped lines, future dates and low confidence", () => {
    const d = draft();
    d.supplierGstin = f("27AABCS5678B1Z0", 40);
    d.totals.totalPaise = f(700_000);
    d.lines[0].taxablePaise = f(600_000);
    d.lines.push({ ...emptyLine("l2"), description: f("Unknown"), qtyMilli: f(1000), ratePaise: f(100), gstRateBp: f(1300) });
    d.invoiceDate = f("2026-12-01");
    const codes = validateDraft(d, { today: "2026-10-15" }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["GSTIN_FORMAT", "TOTAL_GRAND", "LINE_MATH", "LINE_UNMAPPED", "LINE_GST_RATE_ODD", "INVOICE_DATE_FUTURE", "LOW_CONFIDENCE"]));
  });
  it("checks the bill against the signed e-invoice QR", () => {
    const d = draft();
    d.einvoice = { irn: "x", sellerGstin: SUPPLIER, docNo: "SV/1", docDate: "2026-09-05", totalPaise: 800_000, signatureVerified: null };
    expect(validateDraft(d, { today: "2026-10-15" }).map((i) => i.code)).toContain("EINVOICE_TOTAL");
  });
  it("draft ⇄ purchase round trip keeps every value", () => {
    const p = draftToPurchase(draft());
    expect(p.lines[0]).toMatchObject({ qtyMilli: 12_000, ratePaise: 55_000, gstRateBp: 1200, stockQtyMilli: 12_000 });
    const back = purchaseToDraft({ ...p, totals: { taxablePaise: 660_000, cgstPaise: 39_600, sgstPaise: 39_600, igstPaise: 0, cessPaise: 0, totalPaise: 739_200 } }, {}, "27");
    expect(back.lines[0].qtyMilli.value).toBe(12_000);
    expect(back.invoiceNo.value).toBe("SV/1");
  });
});

describe("module tile board", () => {
  const APP = path.join(process.cwd(), "src", "app");
  const pageExists = (href: string) => {
    const p = href.split("?")[0].split("/").filter(Boolean);
    let dir = APP;
    for (const seg of p) {
      const next = path.join(dir, seg);
      if (existsSync(next) && statSync(next).isDirectory()) {
        dir = next;
        continue;
      }
      const dyn = readdirSync(dir).find((d) => d.startsWith("[") && !d.startsWith("[..."));
      if (!dyn) return false;
      dir = path.join(dir, dyn);
    }
    return existsSync(path.join(dir, "page.tsx"));
  };
  it("has trilingual labels and every tile opens a page", () => {
    for (const t of [...ACCOUNTS_TILES, ...ACCOUNTS_NAV]) {
      expect(t.label.en && t.label.hi && t.label.mr, t.key).toBeTruthy();
      expect(pageExists(t.href), t.href).toBe(true);
    }
    expect(ACCOUNTS_TILES.length).toBeLessThanOrEqual(16);
  });
});
