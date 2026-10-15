/**
 * Supplier bill → inventory (docs/inventory-accounting-2026-10, Parts 4–6),
 * against real PostgreSQL and the real local readers:
 *   soft copy — e-invoice JSON (trusted), Excel bill, PDF-less photo with a
 *   signed e-invoice QR (trusted header) read by OCR;
 *   review — matching, validation (totals, GSTIN, duplicate), edits;
 *   confirm — stock moves only on confirm; corrections are remembered for the
 *   supplier's next bill.
 */
import ExcelJS from "exceljs";
import QRCode from "qrcode";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { BillDraft } from "@/lib/accounts/bill-draft";
import { db } from "@/server/db";
import { invBillCaptures, shopProducts, shops } from "@/server/db/schema";
import { confirmCapture, createCapture, createManualCapture, dispatchCaptures, getCapture, processCapture, saveDraft } from "@/server/accounts/capture/service";
import { billEmailAddress, receiveBillEmail, shopIdFromAddress } from "@/server/accounts/inbound";
import { readFileForShop } from "@/server/accounts/files";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";
import { gstin } from "../helpers/gstin";

beforeEach(resetDatabase);

const SHOP_GSTIN = gstin("27", "AAACK1234A");
const SUPPLIER = gstin("27", "AABCS5678B");
const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const DMY = `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`;

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Capture Dairy" });
  await db.update(shops).set({ gstin: SHOP_GSTIN }).where(eq(shops.id, shop.id));
  const category = await createCategory({ department: "DAIRY", name: "Dairy" });
  const ghee = await createProduct(category.id, { name: "Amul Cow Ghee 1 L", unit: "piece" });
  await db.execute(sql`UPDATE products SET gtin = '8901262150125', hsn_code = '0405', gst_rate_bp = 1200 WHERE id = ${ghee.id}`);
  const paneer = await createProduct(category.id, { name: "Malai Paneer 200 g", unit: "piece" });
  await db.execute(sql`UPDATE products SET hsn_code = '0406', gst_rate_bp = 500 WHERE id = ${paneer.id}`);
  const gheeSp = await createShopProduct(shop.id, ghee.id, { onlineStock: 0 });
  const paneerSp = await createShopProduct(shop.id, paneer.id, { onlineStock: 0 });
  return { owner, shop, gheeSp, paneerSp, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

function einvoiceJson(invoiceNo = "SV/0001") {
  return JSON.stringify({
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: "B2B" },
    DocDtls: { Typ: "INV", No: invoiceNo, Dt: DMY },
    SellerDtls: { Gstin: SUPPLIER, LglNm: "Shree Vitthal Distributors", Stcd: "27", Addr1: "Market Yard", Loc: "Pune", Pin: 411037 },
    BuyerDtls: { Gstin: SHOP_GSTIN, LglNm: "Capture Dairy", Pos: "27", Stcd: "27" },
    ItemList: [
      { SlNo: "1", PrdDesc: "AMUL COW GHEE 1LTR", HsnCd: "04051000", Barcde: "8901262150125", Qty: 12, Unit: "NOS", UnitPrice: 550, TotAmt: 6600, Discount: 0, AssAmt: 6600, GstRt: 12, IgstAmt: 0, CgstAmt: 396, SgstAmt: 396, CesAmt: 0, TotItemVal: 7392 },
      { SlNo: "2", PrdDesc: "MALAI PANEER 200G", HsnCd: "04061000", Qty: 20, Unit: "NOS", UnitPrice: 80, TotAmt: 1600, Discount: 0, AssAmt: 1600, GstRt: 5, IgstAmt: 0, CgstAmt: 40, SgstAmt: 40, CesAmt: 0, TotItemVal: 1680 },
    ],
    ValDtls: { AssVal: 8200, CgstVal: 436, SgstVal: 436, IgstVal: 0, CesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: 9072 },
  });
}

const draftOf = async (shopId: string, id: string) => (await getCapture(shopId, id)).draft as unknown as BillDraft;

describe("soft copy: e-invoice JSON", () => {
  it("reads, matches by barcode and name, validates, and touches stock only on confirm", async () => {
    const { shop, gheeSp, paneerSp, actor } = await setup();
    const capture = await createCapture(shop.id, { files: [{ bytes: Buffer.from(einvoiceJson()), contentType: "application/json", name: "einv.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    expect(capture.status).toBe("QUEUED");
    const done = await processCapture(capture.id);
    expect(done!.status).toBe("READY_FOR_REVIEW");
    expect(done!.engine).toBe("EINVOICE_JSON");
    const draft = done!.draft as unknown as BillDraft;
    expect(draft.supplierGstin.value).toBe(SUPPLIER);
    expect(draft.lines[0].match.shopProductId).toBe(gheeSp.id);
    expect(draft.lines[0].match.method).toBe("BARCODE");
    expect(draft.lines[1].match.shopProductId).toBe(paneerSp.id);
    expect(done!.issues.filter((i) => i.severity === "error")).toEqual([]);
    // Nothing in stock yet.
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, gheeSp.id)))[0].onlineStock).toBe(0);

    const purchase = await confirmCapture(shop.id, capture.id, draft, actor);
    expect(purchase.totalPaise).toBe(907_200);
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, gheeSp.id)))[0].onlineStock).toBe(12);
    expect((await getCapture(shop.id, capture.id)).status).toBe("CONFIRMED");

    // The same bill again is flagged as a duplicate before confirming.
    const again = await createCapture(shop.id, { files: [{ bytes: Buffer.from(einvoiceJson()), contentType: "application/json", name: "einv.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    const read = await processCapture(again.id);
    expect(read!.issues.some((i) => i.code === "DUPLICATE")).toBe(true);
    await expect(confirmCapture(shop.id, again.id, read!.draft as unknown as BillDraft, actor)).rejects.toThrow(/Fix the items/);
  });

  it("the original file is stored and readable only by its shop", async () => {
    const { shop, actor } = await setup();
    const other = await createShop((await createUser({ role: "SHOP_OWNER" })).id, { name: "Other" });
    const capture = await createCapture(shop.id, { files: [{ bytes: Buffer.from(einvoiceJson()), contentType: "application/json", name: "einv.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    const { bytes } = await readFileForShop(shop.id, capture.fileIds[0]);
    expect(bytes.toString()).toContain("SellerDtls");
    await expect(readFileForShop(other.id, capture.fileIds[0])).rejects.toThrow(/not found/i);
    // Encrypted at rest.
    const [raw] = await db.execute<{ data: Buffer; encrypted: boolean }>(sql`select data, encrypted from acc_files where id = ${capture.fileIds[0]}`);
    expect(raw.encrypted).toBe(true);
    expect(Buffer.from(raw.data).toString("latin1")).not.toContain("SellerDtls");
  });
});

describe("review & correction screen", () => {
  it("flags wrong totals and a bad GSTIN; owner edits fix them; corrections are remembered for the supplier", async () => {
    const { shop, paneerSp, actor } = await setup();
    const capture = await createCapture(shop.id, { files: [{ bytes: Buffer.from(einvoiceJson("SV/0002")), contentType: "application/json", name: "einv.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    await processCapture(capture.id);
    const draft = await draftOf(shop.id, capture.id);
    draft.supplierGstin.value = "27AABCS5678B1Z0"; // wrong check digit
    draft.totals.totalPaise.value = 100_00;
    let saved = await saveDraft(shop.id, capture.id, draft);
    expect(saved.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["GSTIN_FORMAT", "TOTAL_GRAND"]));

    draft.supplierGstin.value = SUPPLIER;
    draft.totals.totalPaise.value = 907_200;
    // Line 1 becomes a new product (no barcode: a barcode that is in the master would reuse that product).
    draft.lines[0].barcode.value = null;
    draft.lines[0].match = { ...draft.lines[0].match, shopProductId: null, method: "NEW", createNew: { name: "Gir Cow Ghee 1 L", unit: "piece", hsn: "0405", gstRateBp: 1200, mrpPaise: null, sellingPricePaise: null } };
    draft.lines[1].match = { ...draft.lines[1].match, shopProductId: paneerSp.id, method: "USER" };
    saved = await saveDraft(shop.id, capture.id, draft);
    expect(saved.issues.filter((i) => i.severity === "error")).toEqual([]);
    await confirmCapture(shop.id, capture.id, saved.draft, actor);

    // Next bill from the same supplier: line 1 maps to the product the owner created.
    const next = await createCapture(shop.id, { files: [{ bytes: Buffer.from(einvoiceJson("SV/0003")), contentType: "application/json", name: "einv.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    const read = await processCapture(next.id);
    const d = read!.draft as unknown as BillDraft;
    expect(d.lines[0].match.method).toBe("SUPPLIER_MAP");
    expect(d.lines[0].match.productName).toBe("Gir Cow Ghee 1 L");
  });

  it("a blank bill can be typed in by hand", async () => {
    const { shop, gheeSp, actor } = await setup();
    const capture = await createManualCapture(shop.id, actor.id);
    const draft = capture.draft as unknown as BillDraft;
    draft.supplierName.value = "Local Vendor";
    draft.invoiceNo.value = "77";
    draft.invoiceDate.value = TODAY;
    draft.lines.push({
      id: "l1",
      description: { value: "Ghee", confidence: 100 },
      hsn: { value: null, confidence: 100 },
      barcode: { value: null, confidence: 100 },
      qtyMilli: { value: 2000, confidence: 100 },
      unit: { value: "pcs", confidence: 100 },
      ratePaise: { value: 50_000, confidence: 100 },
      discountPaise: { value: 0, confidence: 100 },
      gstRateBp: { value: 0, confidence: 100 },
      taxablePaise: { value: null, confidence: 100 },
      taxPaise: { value: null, confidence: 100 },
      totalPaise: { value: null, confidence: 100 },
      batchNo: { value: null, confidence: 100 },
      expiryDate: { value: null, confidence: 100 },
      mrpPaise: { value: null, confidence: 100 },
      match: { shopProductId: gheeSp.id, productName: null, method: "USER", score: 1, suggestions: [] },
    });
    const saved = await saveDraft(shop.id, capture.id, draft);
    expect(saved.issues.filter((i) => i.severity === "error")).toEqual([]);
    const p = await confirmCapture(shop.id, capture.id, saved.draft, actor);
    expect(p.totalPaise).toBe(100_000);
    expect(p.supplierGstin).toBeNull();
  });
});

describe("soft copy: Excel bill", () => {
  it("finds the item table and maps the lines", async () => {
    const { shop, gheeSp, actor } = await setup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bill");
    ws.addRow(["Shree Vitthal Distributors"]);
    ws.addRow([`GSTIN: ${SUPPLIER}`]);
    ws.addRow([`Invoice No: XL-55`, `Date: ${DMY}`]);
    ws.addRow([]);
    ws.addRow(["Sr", "Item Description", "HSN", "Qty", "Unit", "Rate", "GST %", "Amount"]);
    ws.addRow([1, "Amul Cow Ghee 1 L", "0405", 5, "pcs", 550, 12, 2750]);
    ws.addRow([]);
    const capture = await createCapture(shop.id, { files: [{ bytes: Buffer.from(await wb.xlsx.writeBuffer()), contentType: null, name: "bill.xlsx" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    const done = await processCapture(capture.id);
    expect(done!.engine).toBe("EXCEL");
    const d = done!.draft as unknown as BillDraft;
    expect(d.supplierGstin.value).toBe(SUPPLIER);
    expect(d.invoiceNo.value).toBe("XL-55");
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].qtyMilli.value).toBe(5000);
    expect(d.lines[0].match.shopProductId).toBe(gheeSp.id);
  });
});

describe("hard copy: photo with a signed e-invoice QR", () => {
  it("takes supplier GSTIN, number, date and total from the QR and reads the rest by OCR", async () => {
    const { shop, actor } = await setup();
    const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = [
      b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
      b64url(JSON.stringify({ data: JSON.stringify({ SellerGstin: SUPPLIER, BuyerGstin: SHOP_GSTIN, DocNo: "QR/77", DocTyp: "INV", DocDt: DMY, TotInvVal: 9072, ItemCnt: 2, MainHsnCode: "0405", Irn: "a".repeat(64), IrnDt: `${TODAY} 10:00:00` }) })),
      b64url("sig"),
    ].join(".");
    const qr = await QRCode.toBuffer(token, { errorCorrectionLevel: "M", margin: 4, scale: 4 });
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900"><rect width="100%" height="100%" fill="white"/><text x="40" y="80" font-size="44" font-family="sans-serif">TAX INVOICE</text><text x="40" y="400" font-size="36" font-family="sans-serif">Amul Cow Ghee 1 L 0405 12 550.00 6600.00</text></svg>`);
    const photo = await sharp(svg).composite([{ input: qr, left: 900, top: 40 }]).jpeg().toBuffer();
    const capture = await createCapture(shop.id, { files: [{ bytes: photo, contentType: "image/jpeg", name: "bill.jpg" }], kind: "HARD", source: "CAMERA" }, actor.id);
    const done = await processCapture(capture.id);
    expect(done!.status).toBe("READY_FOR_REVIEW");
    expect(done!.engine).toBe("EINVOICE_QR");
    const d = done!.draft as unknown as BillDraft;
    expect(d.einvoice?.docNo).toBe("QR/77");
    expect(d.supplierGstin).toEqual({ value: SUPPLIER, confidence: 100 });
    expect(d.totals.totalPaise.value).toBe(907_200);
    expect(d.invoiceDate.value).toBe(TODAY);
  }, 120_000);
});

describe("queue and forwarding", () => {
  it("the dispatcher reads waiting bills once; an unreadable file fails cleanly", async () => {
    const { shop, actor } = await setup();
    const bad = await createCapture(shop.id, { files: [{ bytes: Buffer.from('{"hello": "world"}'), contentType: "application/json", name: "x.json" }], kind: "SOFT", source: "UPLOAD" }, actor.id);
    const first = await dispatchCaptures();
    expect(first.processed).toBe(1);
    expect((await getCapture(shop.id, bad.id)).status).toBe("FAILED");
    expect((await dispatchCaptures()).processed).toBe(0);
  });

  it("a bill emailed to the shop's private address becomes a capture", async () => {
    const { shop } = await setup();
    process.env.INBOUND_EMAIL_SECRET = "test-inbound-secret";
    process.env.INBOUND_EMAIL_DOMAIN = "in.gokesari.test";
    try {
      const address = billEmailAddress(shop.id)!;
      expect(shopIdFromAddress(address)).toBe(shop.id);
      expect(shopIdFromAddress(address.replace(/-[0-9a-f]{10}@/, "-0000000000@"))).toBeNull();
      const capture = await receiveBillEmail({ to: [address], from: "supplier@example.com", subject: "Invoice", attachments: [{ filename: "einv.json", contentType: "application/json", contentBase64: Buffer.from(einvoiceJson("EM/1")).toString("base64") }] });
      expect(capture.source).toBe("EMAIL");
      const [row] = await db.select().from(invBillCaptures).where(eq(invBillCaptures.id, capture.id));
      expect(row.status).toBe("QUEUED");
    } finally {
      delete process.env.INBOUND_EMAIL_SECRET;
      delete process.env.INBOUND_EMAIL_DOMAIN;
    }
  });
});
