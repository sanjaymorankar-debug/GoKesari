/**
 * Billing v2 phase 5 (docs/billing §7, §8; §13 scenarios 9, 10, 12): the
 * canonical model, validation before export, Tally XML / Excel export and the
 * XML round trip, re-export and re-import without duplicates, imports from
 * Tally, Busy, Vyapar and myBillBook files (masters first, then vouchers),
 * the conflict queue, the template pack and the CSV tools. Both layouts.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { accParties, accSalesInvoices, featureFlags, products, shopProducts, syncConflicts, syncRecords } from "@/server/db/schema";
import { createParty, updateParty } from "@/server/accounts/parties";
import { createSalesInvoice } from "@/server/accounts/sales";
import { ExportBlocked, exportForTool, importForTool, resolveConflict, setUnitUqc, templatePack } from "@/server/sync/engine";
import { LAYOUTS, toToolSheets } from "@/server/sync/formats";
import { buildCanonicalBooks, validateBooks, voucherFingerprint } from "@/server/sync/model";
import { parseTallyXml, toTallyXml } from "@/server/sync/tally";
import { addDaysIso, gstin, gstShop, IST_TODAY, resetBatchE } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();
const range = { from: addDaysIso(today, -30), to: addDaysIso(today, 1) };

async function readyShop() {
  const s = await gstShop();
  const party = await createParty(s.shop.id, { kind: "CUSTOMER", name: "Hotel Sunrise", gstin: gstin("27", "AAACH1234K"), phone: "9876500001" }, s.owner.id);
  await createSalesInvoice(s.shop.id, { partyId: party.id, paymentMode: "CREDIT", lines: [{ shopProductId: s.milkSp.id, description: "Cow Milk", hsn: "0401", qtyMilli: 2000, unit: "L", ratePaise: 5_000, gstRateBp: 500 }] }, s.owner);
  return { ...s, party };
}

async function xlsxOf(sheets: { name: string; header: string[]; rows: (string | number | null)[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow(s.header);
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.insert(featureFlags).values({ key: "billing_v2", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  await createUser({ role: "ADMIN" });
});

describe("canonical model and validation (§7.1, §7.6, §2.3)", () => {
  it("lists what blocks a GST-ready export, and clears once fixed", async () => {
    const s = await gstShop();
    const gheeProductId = (await db.select().from(shopProducts).where(eq(shopProducts.id, s.gheeSp.id)))[0].productId;
    // No HSN anywhere, and a unit no GST unit code is known for.
    await db.update(products).set({ hsnCode: null, unit: "crate" }).where(eq(products.id, gheeProductId));
    const books = await buildCanonicalBooks(s.shop.id, range.from, range.to);
    const fixes = validateBooks(books);
    expect(fixes.some((f) => f.entity === "STOCK_ITEM" && /HSN/.test(f.problem))).toBe(true);
    expect(fixes.some((f) => f.entity === "UNIT" && f.key === "crate")).toBe(true);
    await expect(exportForTool(s.shop.id, "TALLY", range, s.owner)).rejects.toBeInstanceOf(ExportBlocked);
    await setUnitUqc(s.shop.id, "Crate", "box");
    await db.update(shopProducts).set({ hsnCode: "0405" }).where(eq(shopProducts.id, s.gheeSp.id));
    expect(validateBooks(await buildCanonicalBooks(s.shop.id, range.from, range.to))).toEqual([]);
  });
});

describe("Tally (§8, scenario 9)", () => {
  it("exports XML + Excel + mapping; the XML reads back the same; re-export reports unchanged", async () => {
    const s = await readyShop();
    const out = await exportForTool(s.shop.id, "TALLY", range, s.owner);
    expect(out.counts.new).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(out.bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["gokesari-tally-mapping.tsf", "gokesari-tally.xlsx", "gokesari-tally.xml"]);
    const xml = await zip.file("gokesari-tally.xml")!.async("string");
    expect(xml).toContain("<ENVELOPE>");
    expect(xml).toContain('<LEDGER NAME="Hotel Sunrise"');
    expect(xml).toContain("<HSNCODE>0401</HSNCODE>");
    expect(xml).toMatch(/<VOUCHER REMOTEID="Sales\|[\d-]+\|S2627-00001"/);

    const books = await buildCanonicalBooks(s.shop.id, range.from, range.to);
    const back = parseTallyXml(toTallyXml(books));
    expect(back.vouchers.map(voucherFingerprint).sort()).toEqual(books.vouchers.filter((v) => v.ledgerLines.length).map(voucherFingerprint).sort());
    expect(back.stockItems.find((i) => i.name === "Cow Milk")).toMatchObject({ hsn: "0401", gstRateBp: 500 });
    expect(back.ledgers.find((l) => l.name === "Hotel Sunrise")).toMatchObject({ gstin: gstin("27", "AAACH1234K"), kind: "PARTY" });

    const again = await exportForTool(s.shop.id, "TALLY", range, s.owner);
    expect(again.counts).toMatchObject({ new: 0, changed: 0 });

    // Tally's own file brought back: nothing is created twice.
    const before = (await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id))).length;
    const imported = await importForTool(s.shop.id, "TALLY", { name: "tally.xml", bytes: Buffer.from(xml) }, s.owner);
    expect(imported.vouchers.created).toBe(0);
    expect(imported.parties.created).toBe(0);
    expect((await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id))).length).toBe(before);
  });
});

describe("imports from Busy, Vyapar, myBillBook and Tally Excel (§8, scenario 10)", () => {
  for (const tool of ["BUSY", "VYAPAR", "MYBILLBOOK", "TALLY"] as const) {
    it(`${tool}: creates the party, updates the item, then the sales voucher with stock; again → unchanged`, async () => {
      const s = await gstShop();
      const L = LAYOUTS[tool];
      const sheets = toToolSheets(tool, {
        company: { name: "x", legalName: "x", gstin: null, stateCode: "27", address: "", booksFrom: range.from },
        ledgerGroups: [],
        ledgers: [{ key: "k", name: "Green Grocers", group: "Sundry Debtors", kind: "PARTY", gstin: gstin("27", "AAGCG4321L"), stateCode: "27", phone: "9800011122", openingPaise: 0 }],
        stockGroups: [],
        units: [{ symbol: "L", uqc: "LTR", decimals: 3 }],
        godowns: [],
        stockItems: [{ key: "m", name: "Cow Milk", group: "Dairy", unit: "L", hsn: "04011000", gstRateBp: 500, cessBp: 0, mrpPaise: null, salePricePaise: 5_500, barcode: null, openingQtyMilli: 0 }],
        batches: [],
        vouchers: [
          {
            key: `Sales|${today}|V-77`,
            type: "Sales",
            tallyType: "Sales",
            date: today,
            number: "V-77",
            narration: "Imported sale",
            party: "Green Grocers",
            ledgerLines: [
              { ledger: "Green Grocers", amountPaise: 10_500 },
              { ledger: "Sales Accounts", amountPaise: -10_000 },
              { ledger: "Output CGST", amountPaise: -250 },
              { ledger: "Output SGST", amountPaise: -250 },
            ],
            inventoryLines: [{ item: "Cow Milk", godown: "Shop counter", qtyMilli: -2000, ratePaise: 5_000 }],
            taxLines: [],
          },
        ],
      });
      expect(sheets.map((x) => x.name)).toEqual([L.sheets.parties, L.sheets.items, L.sheets.lines]);
      const file = { name: `${tool.toLowerCase()}.xlsx`, bytes: await xlsxOf(sheets) };
      const summary = await importForTool(s.shop.id, tool, file, s.owner);
      expect(summary.parties.created).toBe(1);
      expect(summary.items.updated).toBe(1);
      expect(summary.vouchers.created).toBe(1);
      const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, s.milkSp.id));
      expect(listing.hsnCode).toBe("04011000");
      const sales = await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id));
      expect(sales).toHaveLength(1);
      expect(sales[0].totalPaise).toBe(10_500);

      const second = await importForTool(s.shop.id, tool, file, s.owner);
      expect(second).toMatchObject({ parties: { created: 0 }, vouchers: { created: 0, unchanged: 1 }, conflicts: 0 });
      expect(await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id))).toHaveLength(1);
    });
  }
});

describe("conflicts (§7.5, scenario 12)", () => {
  it("a party changed on both sides waits for the shop; a voucher changed after exchange is never overwritten", async () => {
    const s = await readyShop();
    await exportForTool(s.shop.id, "TALLY", range, s.owner);
    await updateParty(s.shop.id, s.party.id, { phone: "9111111111" }, s.owner.id);
    const tallyChanged = toToolSheets("TALLY", {
      ...(await buildCanonicalBooks(s.shop.id, range.from, range.to)),
      ledgers: [{ key: "x", name: "Hotel Sunrise", group: "Sundry Debtors", kind: "PARTY", gstin: gstin("27", "AAACH1234K"), phone: "9222222222", openingPaise: 0 }],
      stockItems: [],
      vouchers: [],
    });
    const result = await importForTool(s.shop.id, "TALLY", { name: "t.xlsx", bytes: await xlsxOf(tallyChanged) }, s.owner);
    expect(result.conflicts).toBe(1);
    const [c] = await db.select().from(syncConflicts).where(eq(syncConflicts.shopId, s.shop.id));
    expect(c).toMatchObject({ entityType: "PARTY", status: "OPEN" });
    await resolveConflict(s.shop.id, c.id, "TAKE_INCOMING", s.owner);
    const [p] = await db.select().from(accParties).where(eq(accParties.id, s.party.id));
    expect(p.phone).toBe("9222222222");

    // The exported sale, changed in Tally afterwards, comes back: held, not applied.
    const books = await buildCanonicalBooks(s.shop.id, range.from, range.to);
    const sale = books.vouchers.find((v) => v.tallyType === "Sales")!;
    const edited = { ...sale, ledgerLines: sale.ledgerLines.map((l) => ({ ...l, amountPaise: l.amountPaise * 2 })) };
    const xml = toTallyXml({ ...books, vouchers: [edited] });
    const r2 = await importForTool(s.shop.id, "TALLY", { name: "t.xml", bytes: Buffer.from(xml) }, s.owner);
    expect(r2.conflicts).toBeGreaterThanOrEqual(1);
    const voucherConflict = await db.select().from(syncConflicts).where(and(eq(syncConflicts.shopId, s.shop.id), eq(syncConflicts.entityType, "VOUCHER")));
    expect(voucherConflict).toHaveLength(1);
    await expect(resolveConflict(s.shop.id, voucherConflict[0].id, "TAKE_INCOMING", s.owner)).rejects.toThrow(/cannot be overwritten/);
    const kept = await resolveConflict(s.shop.id, voucherConflict[0].id, "KEEP_LOCAL", s.owner);
    expect(kept.status).toBe("KEPT_LOCAL");
  });
});

describe("template pack and CSV tools (§8)", () => {
  it("has every software's templates; Zoho and Odoo export CSV files", async () => {
    const pack = await JSZip.loadAsync(await templatePack());
    const names = Object.keys(pack.files);
    for (const t of ["tally", "busy", "marg", "vyapar", "mybillbook", "zoho", "odoo", "generic"]) expect(names.some((n) => n.startsWith(`${t}/`))).toBe(true);
    expect(names).toContain("README.txt");

    const s = await readyShop();
    for (const tool of ["ZOHO", "ODOO"] as const) {
      const zip = await JSZip.loadAsync((await exportForTool(s.shop.id, tool, range, s.owner)).bytes);
      const csvs = Object.keys(zip.files).filter((n) => n.endsWith(".csv"));
      expect(csvs).toHaveLength(3);
      const contacts = await zip.file(csvs.find((n) => /contacts|partner/.test(n))!)!.async("string");
      expect(contacts).toContain("Hotel Sunrise");
    }
    const generic = await JSZip.loadAsync((await exportForTool(s.shop.id, "GENERIC", range, s.owner)).bytes);
    const json = JSON.parse(await generic.file("gokesari-books.json")!.async("string"));
    expect(json.schema).toBe("gokesari.books/1");
    const records = await db.select({ n: sql<number>`count(*)::int` }).from(syncRecords).where(eq(syncRecords.shopId, s.shop.id));
    expect(records[0].n).toBeGreaterThan(0);
  });
});
