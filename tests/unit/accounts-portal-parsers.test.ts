/**
 * GST portal file parsers (Module 2, purchase reconciliation).
 *
 * The parsers are the boundary between what gst.gov.in hands a shop owner and
 * integer paise in the reconciliation, so each real-world shape is tested:
 * GSTR-2B JSON (with and without the "data" wrapper, invoice-level amounts or
 * only items), GSTR-2A, GSTR-1 and the GSTR-2B Excel workbook with its merged
 * multi-row header.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parsePortalExcel, parsePortalJson, portalDate, rupeesToPaiseSafe } from "@/lib/gst/portal-parsers";

const SHOP = "27AAACK1234F1Z5";
const SUPPLIER_A = "27AABCA1111B1Z1";
const SUPPLIER_B = "29AABCB2222C1Z2";

const gstr2b = {
  chksum: "abc",
  data: {
    gstin: SHOP,
    rtnprd: "092026",
    version: "1.0",
    gendt: "14-10-2026",
    itcsumm: { itcavl: { nonrevsup: { igst: 0 } } },
    docdata: {
      b2b: [
        {
          ctin: SUPPLIER_A,
          trdnm: "Amul Distributors",
          supfildt: "11-10-2026",
          supprd: "092026",
          inv: [
            {
              inum: "AD/2026/0451",
              typ: "R",
              dt: "05-09-2026",
              val: 1180.5,
              pos: "27",
              rev: "N",
              itcavl: "Y",
              rsn: "",
              diffprcnt: 1,
              srctyp: "e-Invoice",
              irn: "a1b2c3",
              irngendate: "05-09-2026",
              txval: 1000.42,
              igst: 0,
              cgst: 90.04,
              sgst: 90.04,
              cess: 0,
              items: [{ num: 1801, rt: 18, txval: 1000.42, igst: 0, cgst: 90.04, sgst: 90.04, cess: 0 }],
            },
            {
              // No invoice-level amounts: summed from the items.
              inum: "AD/2026/0460",
              typ: "R",
              dt: "12-09-2026",
              val: "1,295.00",
              pos: "27",
              rev: "N",
              itcavl: "N",
              rsn: "P",
              items: [
                { num: 1, rt: 5, txval: 500, igst: 0, cgst: 12.5, sgst: 12.5, cess: 0 },
                { num: 2, rt: 18, txval: 650, igst: 0, cgst: 58.5, sgst: 58.5, cess: 0 },
              ],
            },
          ],
        },
      ],
      b2ba: [
        {
          ctin: SUPPLIER_B,
          trdnm: "Britannia Wholesale",
          inv: [{ oinum: "BW-77", oidt: "20-08-2026", inum: "BW-77A", typ: "R", dt: "21-08-2026", val: 2240, pos: "27", rev: "N", itcavl: "Y", txval: 2000, igst: 240, cgst: 0, sgst: 0, cess: 0 }],
        },
      ],
      cdnr: [
        {
          ctin: SUPPLIER_A,
          trdnm: "Amul Distributors",
          nt: [{ ntnum: "CN-12", typ: "C", suptyp: "R", dt: "20-09-2026", val: 118, pos: "27", rev: "N", itcavl: "Y", txval: 100, igst: 0, cgst: 9, sgst: 9, cess: 0 }],
        },
      ],
      impg: [{ refdt: "02-09-2026", portcd: "INNSA1", boenum: "1234567", boedt: "01-09-2026", isamd: "N", txval: 50000, igst: 9000, cess: 0 }],
      isd: [{ ctin: "27AAAAI0000A1Z9", doclist: [{ docnum: "ISD1" }] }],
    },
  },
};

describe("rupeesToPaiseSafe", () => {
  it("reads numbers and Indian-formatted text without float drift", () => {
    expect(rupeesToPaiseSafe("1,180.50")).toBe(118050);
    expect(rupeesToPaiseSafe(1180.5)).toBe(118050);
    expect(rupeesToPaiseSafe(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaiseSafe(1.005)).toBe(101);
    expect(rupeesToPaiseSafe("₹ 1,00,000")).toBe(10_000_000);
    expect(rupeesToPaiseSafe("-25.5")).toBe(-2550);
    expect(rupeesToPaiseSafe("(25.00)")).toBe(-2500);
    expect(rupeesToPaiseSafe(".5")).toBe(50);
  });

  it("gives 0 for garbage", () => {
    for (const v of ["abc", "", "1.2.3", null, undefined, NaN, Infinity, {}, [], "12abc"]) {
      expect(rupeesToPaiseSafe(v)).toBe(0);
    }
  });
});

describe("portalDate", () => {
  it("reads the portal's and Excel's date forms", () => {
    expect(portalDate("05-09-2026")).toBe("2026-09-05");
    expect(portalDate("5/9/2026")).toBe("2026-09-05");
    expect(portalDate("2026-09-05")).toBe("2026-09-05");
    expect(portalDate("05-Sep-2026")).toBe("2026-09-05");
    expect(portalDate(new Date(Date.UTC(2026, 8, 5)))).toBe("2026-09-05");
    // IST midnight stored as UTC (18:30 the day before) is still the 5th.
    expect(portalDate(new Date("2026-09-04T18:30:00Z"))).toBe("2026-09-05");
    expect(portalDate(46270)).toBe("2026-09-05");
    expect(portalDate("31-02-2026")).toBeNull();
    expect(portalDate("hello")).toBeNull();
  });
});

describe("parsePortalJson — GSTR-2B", () => {
  const parsed = parsePortalJson(JSON.stringify(gstr2b));

  it("detects the return, the shop's GSTIN and the period", () => {
    expect(parsed.returnType).toBe("GSTR2B");
    expect(parsed.gstin).toBe(SHOP);
    expect(parsed.period).toBe("2026-09");
  });

  it("reads B2B invoices with invoice-level amounts and the rate breakup", () => {
    const inv = parsed.invoices.find((i) => i.invoiceNo === "AD/2026/0451")!;
    expect(inv).toMatchObject({
      section: "B2B",
      counterpartyGstin: SUPPLIER_A,
      counterpartyName: "Amul Distributors",
      invoiceDate: "2026-09-05",
      docType: "INV",
      placeOfSupply: "27",
      reverseCharge: false,
      taxablePaise: 100042,
      igstPaise: 0,
      cgstPaise: 9004,
      sgstPaise: 9004,
      cessPaise: 0,
      totalPaise: 118050,
      itcAvailable: true,
      itcUnavailableReason: null,
      irn: "a1b2c3",
    });
    expect(inv.rates).toEqual([{ rateBp: 1800, taxablePaise: 100042, igstPaise: 0, cgstPaise: 9004, sgstPaise: 9004, cessPaise: 0 }]);
  });

  it("sums invoice amounts from items when the invoice has none", () => {
    const inv = parsed.invoices.find((i) => i.invoiceNo === "AD/2026/0460")!;
    expect(inv.taxablePaise).toBe(115000);
    expect(inv.cgstPaise).toBe(7100);
    expect(inv.sgstPaise).toBe(7100);
    expect(inv.totalPaise).toBe(129500);
    expect(inv.itcAvailable).toBe(false);
    expect(inv.itcUnavailableReason).toBe("P");
    expect(inv.rates.map((r) => r.rateBp)).toEqual([500, 1800]);
  });

  it("reads amendments, credit notes and imports", () => {
    expect(parsed.invoices.find((i) => i.section === "B2BA")).toMatchObject({ invoiceNo: "BW-77A", invoiceDate: "2026-08-21", igstPaise: 24000, counterpartyGstin: SUPPLIER_B });
    expect(parsed.invoices.find((i) => i.section === "CDNR")).toMatchObject({ invoiceNo: "CN-12", docType: "CRN", taxablePaise: 10000, totalPaise: 11800 });
    expect(parsed.invoices.find((i) => i.section === "IMPG")).toMatchObject({
      invoiceNo: "1234567",
      invoiceDate: "2026-09-01",
      counterpartyGstin: "",
      taxablePaise: 5_000_000,
      igstPaise: 900_000,
      totalPaise: 5_900_000,
    });
    expect(parsed.invoices).toHaveLength(5);
  });

  it("warns about sections it does not read", () => {
    expect(parsed.warnings.some((w) => w.includes('"isd"'))).toBe(true);
  });

  it("accepts the data content without the wrapper", () => {
    const bare = parsePortalJson(JSON.stringify(gstr2b.data));
    expect(bare.returnType).toBe("GSTR2B");
    expect(bare.period).toBe("2026-09");
    expect(bare.invoices).toHaveLength(5);
  });

  it("reads a debit note's type", () => {
    const file = { data: { gstin: SHOP, rtnprd: "102026", docdata: { cdnr: [{ ctin: SUPPLIER_A, nt: [{ ntnum: "DN-1", typ: "D", dt: "01-10-2026", val: 59, txval: 50, cgst: 4.5, sgst: 4.5 }] }] } } };
    expect(parsePortalJson(JSON.stringify(file)).invoices[0]).toMatchObject({ docType: "DBN", section: "CDNR", totalPaise: 5900 });
  });
});

describe("parsePortalJson — GSTR-2A", () => {
  const gstr2a = {
    gstin: SHOP,
    fp: "092026",
    b2b: [
      {
        ctin: SUPPLIER_B,
        cfs: "Y",
        cfs3b: "Y",
        fldtr1: "11-Oct-26",
        inv: [
          {
            chksum: "x",
            inum: "INV-9001",
            idt: "15-09-2026",
            val: 2360,
            pos: "27",
            rchrg: "N",
            inv_typ: "R",
            itms: [
              { num: 1, itm_det: { rt: 18, txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } },
              { num: 2, itm_det: { rt: 18, txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } },
            ],
          },
        ],
      },
    ],
    cdn: [{ ctin: SUPPLIER_B, cfs: "Y", nt: [{ ntty: "C", nt_num: "CR-5", nt_dt: "25-09-2026", val: 118, itms: [{ num: 1, itm_det: { rt: 18, txval: 100, iamt: 18 } }] }] }],
  };

  it("detects 2A and sums items per rate", () => {
    const parsed = parsePortalJson(JSON.stringify(gstr2a));
    expect(parsed.returnType).toBe("GSTR2A");
    expect(parsed.period).toBe("2026-09");
    const inv = parsed.invoices[0];
    expect(inv).toMatchObject({ section: "B2B", invoiceNo: "INV-9001", invoiceDate: "2026-09-15", taxablePaise: 200000, igstPaise: 36000, totalPaise: 236000, itcAvailable: null });
    expect(inv.rates).toEqual([{ rateBp: 1800, taxablePaise: 200000, igstPaise: 36000, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }]);
    expect(parsed.invoices[1]).toMatchObject({ section: "CDNR", docType: "CRN", invoiceNo: "CR-5", invoiceDate: "2026-09-25", igstPaise: 1800 });
  });
});

describe("parsePortalJson — GSTR-1", () => {
  const gstr1 = {
    gstin: SHOP,
    fp: "092026",
    gt: 0,
    cur_gt: 0,
    b2b: [
      { ctin: SUPPLIER_B, inv: [{ inum: "GK/26/101", idt: "03-09-2026", val: 590, pos: "29", rchrg: "N", inv_typ: "R", itms: [{ num: 1, itm_det: { rt: 18, txval: 500, iamt: 90, csamt: 0 } }] }] },
    ],
    cdnr: [{ ctin: SUPPLIER_B, nt: [{ ntty: "C", nt_num: "GK/CN/1", nt_dt: "10-09-2026", pos: "29", rchrg: "N", inv_typ: "R", val: 59, itms: [{ num: 1, itm_det: { rt: 18, txval: 50, iamt: 9 } }] }] }],
    b2cl: [{ pos: "07", inv: [{ inum: "GK/26/150", idt: "20-09-2026", val: 300000, itms: [{ num: 1, itm_det: { rt: 5, txval: 285714.29, iamt: 14285.71 } }] }] }],
    b2cs: [{ sply_ty: "INTRA", rt: 5, typ: "OE", pos: "27", txval: 10000, camt: 250, samt: 250, csamt: 0 }],
    hsn: { data: [{ num: 1, hsn_sc: "0401" }] },
    doc_issue: { doc_det: [] },
  };

  it("treats the counterparty as the buyer and summarises B2C", () => {
    const parsed = parsePortalJson(JSON.stringify(gstr1));
    expect(parsed.returnType).toBe("GSTR1");
    expect(parsed.invoices.find((i) => i.invoiceNo === "GK/26/101")).toMatchObject({ section: "B2B", counterpartyGstin: SUPPLIER_B, placeOfSupply: "29", igstPaise: 9000 });
    expect(parsed.invoices.find((i) => i.invoiceNo === "GK/CN/1")).toMatchObject({ section: "CDNR", docType: "CRN" });
    expect(parsed.invoices.find((i) => i.invoiceNo === "GK/26/150")).toMatchObject({ section: "OTHER", counterpartyGstin: "", placeOfSupply: "07", taxablePaise: 28571429 });
    expect(parsed.invoices.find((i) => i.invoiceNo === "B2CS-27-5")).toMatchObject({
      section: "OTHER",
      counterpartyGstin: "",
      invoiceDate: "2026-09-01",
      taxablePaise: 1_000_000,
      cgstPaise: 25000,
      sgstPaise: 25000,
      totalPaise: 1_050_000,
      rates: [{ rateBp: 500, taxablePaise: 1_000_000, igstPaise: 0, cgstPaise: 25000, sgstPaise: 25000, cessPaise: 0 }],
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("prefers the hint, and says when the file looks different", () => {
    const parsed = parsePortalJson(JSON.stringify(gstr1), "GSTR2A");
    expect(parsed.returnType).toBe("GSTR2A");
    expect(parsed.warnings[0]).toMatch(/looks like GSTR-1/);
  });
});

describe("parsePortalJson — garbage", () => {
  it("refuses non-JSON and non-returns with a clear message", () => {
    expect(() => parsePortalJson("not json")).toThrow(/not valid JSON/);
    expect(() => parsePortalJson("[1,2]")).toThrow(/not a GST return/);
    expect(() => parsePortalJson(JSON.stringify({ hello: "world" }))).toThrow(/not a GSTR-2B, GSTR-2A or GSTR-1/);
  });
});

/* ---------------------------------------------------------------- Excel */

async function gstr2bWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const readme = wb.addWorksheet("Read me");
  readme.addRow(["Goods and Services Tax - GSTR-2B"]);
  readme.addRow([]);
  readme.addRow(["Financial Year", "2026-27"]);
  readme.addRow(["Tax Period", "September"]);
  readme.addRow(["GSTIN", SHOP]);
  readme.addRow(["Legal Name", "Kesari Dairy"]);
  wb.addWorksheet("ITC Available").addRow(["Summary", 1, 2, 3]);

  const b2b = wb.addWorksheet("B2B");
  b2b.addRow(["Goods and Services Tax - GSTR 2B"]);
  b2b.addRow(["Taxable inward supplies received from registered persons"]);
  b2b.addRow([]);
  // Two-row merged header, as on the portal.
  const top = [
    "GSTIN of supplier", "Trade/Legal name", "Invoice Details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Rate(%)", "Taxable Value (₹)",
    "Tax Amount", "", "", "", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability", "Reason", "Applicable % of Tax Rate", "Source", "IRN", "IRN Date",
  ];
  const sub = ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"];
  b2b.addRow(top); // row 4
  b2b.addRow(sub); // row 5
  for (const col of ["A", "B", "G", "H", "I", "J", "O", "P", "Q", "R", "S", "T", "U", "V"]) b2b.mergeCells(`${col}4:${col}5`);
  b2b.mergeCells("C4:F4");
  b2b.mergeCells("K4:N4");
  // One invoice, two rates (one row per rate), amounts as numbers.
  b2b.addRow([SUPPLIER_A, "Amul Distributors", "AD/0451", "Regular", "05-09-2026", 1770.5, "27-Maharashtra", "No", 18, 1000.42, 0, 90.04, 90.04, 0, "Sep'26", "11-Oct-2026", "Yes", "", "", "e-Invoice", "irn-1", "05-09-2026"]);
  b2b.addRow([SUPPLIER_A, "Amul Distributors", "AD/0451", "Regular", "05-09-2026", 1770.5, "27-Maharashtra", "No", 5, 500, 0, 12.5, 12.5, 0, "Sep'26", "11-Oct-2026", "Yes", "", "", "e-Invoice", "irn-1", "05-09-2026"]);
  // A second invoice with an Excel date and text amounts.
  b2b.addRow([SUPPLIER_B, "Britannia", "BW-90", "Regular", new Date(Date.UTC(2026, 8, 18)), "11,800.00", "29-Karnataka", "Yes", 18, "10,000.00", "1,800.00", 0, 0, 0, "Sep'26", "11-Oct-2026", "No", "POS and supplier state are same", "", "", "", ""]);

  const cdnr = wb.addWorksheet("B2B-CDNR");
  cdnr.addRow(["GSTIN of supplier", "Trade/Legal name", "Note number", "Note type", "Note Supply type", "Note date", "Note Value (₹)", "Place of supply", "Supply Attract Reverse Charge", "Rate(%)", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "ITC Availability"]);
  cdnr.addRow([SUPPLIER_A, "Amul Distributors", "CN-12", "Credit note", "Regular", "20/09/2026", 118, "27", "No", 18, 100, 0, 9, 9, 0, "Yes"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parsePortalExcel — GSTR-2B workbook", () => {
  it("finds the merged header, merges rate rows and reads metadata", async () => {
    const parsed = await parsePortalExcel(await gstr2bWorkbook());
    expect(parsed.returnType).toBe("GSTR2B");
    expect(parsed.gstin).toBe(SHOP);
    expect(parsed.period).toBe("2026-09");
    expect(parsed.invoices).toHaveLength(3);

    const a = parsed.invoices.find((i) => i.invoiceNo === "AD/0451")!;
    expect(a).toMatchObject({
      section: "B2B",
      counterpartyGstin: SUPPLIER_A,
      counterpartyName: "Amul Distributors",
      invoiceDate: "2026-09-05",
      docType: "INV",
      placeOfSupply: "27",
      reverseCharge: false,
      taxablePaise: 150042,
      cgstPaise: 10254,
      sgstPaise: 10254,
      igstPaise: 0,
      totalPaise: 177050,
      itcAvailable: true,
      irn: "irn-1",
    });
    expect(a.rates).toEqual([
      { rateBp: 500, taxablePaise: 50000, igstPaise: 0, cgstPaise: 1250, sgstPaise: 1250, cessPaise: 0 },
      { rateBp: 1800, taxablePaise: 100042, igstPaise: 0, cgstPaise: 9004, sgstPaise: 9004, cessPaise: 0 },
    ]);

    const b = parsed.invoices.find((i) => i.invoiceNo === "BW-90")!;
    expect(b).toMatchObject({ invoiceDate: "2026-09-18", placeOfSupply: "29", reverseCharge: true, taxablePaise: 1_000_000, igstPaise: 180_000, totalPaise: 1_180_000, itcAvailable: false });
    expect(b.itcUnavailableReason).toBe("POS and supplier state are same");

    expect(parsed.invoices.find((i) => i.section === "CDNR")).toMatchObject({ invoiceNo: "CN-12", docType: "CRN", invoiceDate: "2026-09-20", totalPaise: 11800 });
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a plain sheet with the column titles on row 1", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Purchases");
    sheet.addRow(["GSTIN of supplier", "Invoice number", "Invoice Date", "Invoice Value", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Rate(%)"]);
    sheet.addRow([SUPPLIER_A, "X-1", "01/09/2026", 1180, 1000, 0, 90, 90, "18%"]);
    sheet.addRow(["", "", "", "", "", "", "", "", ""]);
    sheet.addRow(["Total", "", "", 1180, 1000, 0, 90, 90, ""]);
    const parsed = await parsePortalExcel(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.invoices).toHaveLength(1);
    expect(parsed.invoices[0]).toMatchObject({ section: "B2B", invoiceNo: "X-1", invoiceDate: "2026-09-01", totalPaise: 118000, rates: [{ rateBp: 1800, taxablePaise: 100000, igstPaise: 0, cgstPaise: 9000, sgstPaise: 9000, cessPaise: 0 }] });
    expect(parsed.gstin).toBeNull();
    expect(parsed.warnings).toEqual(["Purchases: 1 row(s) without an invoice number or GSTIN were skipped."]);
  });

  it("refuses a workbook without invoice columns, and non-Excel bytes", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").addRow(["Name", "Phone"]);
    await expect(parsePortalExcel(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/No sheet with invoice columns/);
    await expect(parsePortalExcel(Buffer.from("not a zip"))).rejects.toThrow(/could not be read/);
  });
});
