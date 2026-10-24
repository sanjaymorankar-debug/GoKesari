/**
 * Shop KYC documents (docs/document-upload-2026-10): upload against the shop,
 * read, confirm, review by operations, the overall KYC status, validation of
 * bad files by content, privacy of the files, and a rejected document being
 * replaced. The documents are made at run time: PDFs with a text layer (as a
 * GST REG-06 or an e-PAN carries one) and images of every kind.
 *
 * Local tier: fresh owners only (document reads are limited per person and
 * per shop), and operations' decisions are made on those shops.
 */
import type { APIRequestContext } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import {
  ctxFor,
  DISGUISED,
  filePart,
  freshAccount,
  gstinFor,
  image,
  needPanStorage,
  pageFor,
  pdf,
  registerShop,
  shopCategoryId,
  uniquePan,
  uniqueShopAct,
  type Account,
} from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 240_000 };

interface Kyc {
  owner: Account;
  ctx: APIRequestContext;
  shopId: string;
  shopName: string;
  pan: string;
  gstin: string;
  shopAct: string;
  fssai: string;
}

/** A pending food shop (FSSAI required) of a fresh owner, with its identifiers. */
async function kycShop(label: string): Promise<Kyc> {
  await needPanStorage();
  const owner = await freshAccount(label);
  const ctx = await ctxFor(owner);
  const pan = uniquePan();
  const shopAct = uniqueShopAct();
  const { shop } = await registerShop(ctx, {
    shopType: "DAIRY",
    categoryIds: [await shopCategoryId("Dairy Shop")],
    ownerName: "QA Seller Owner",
    shopActNumber: shopAct,
  });
  const fssai = `1${String(Date.now()).slice(-13)}`;
  return { owner, ctx, shopId: shop.id, shopName: shop.name, pan, gstin: gstinFor(pan), shopAct, fssai };
}

/** The text-layer PDF a shop would upload for each document. */
function documentPdf(k: Kyc, docType: "PAN" | "GSTIN" | "SHOP_ACT" | "FSSAI"): Buffer {
  const lines: Record<typeof docType, string[]> = {
    PAN: ["INCOME TAX DEPARTMENT", "GOVT. OF INDIA", "Permanent Account Number Card", k.pan, "Name", "QA SELLER OWNER", "Date of Birth", "01/01/1980"],
    GSTIN: ["Government of India", "Form GST REG-06", "Registration Certificate", `Registration Number : ${k.gstin}`, "Legal Name : QA SELLER OWNER", `Trade Name : ${k.shopName}`, "Date of Liability : 01/04/2020", "Period of Validity From : 01/04/2020 To : Not Applicable"],
    SHOP_ACT: ["Government of Maharashtra", "Maharashtra Shops and Establishments Act 2017", "INTIMATION RECEIPT - FORM F", `Registration No : ${k.shopAct}`, `Name of Establishment : ${k.shopName}`, "Name of Employer : QA SELLER OWNER", "Date : 01/04/2024"],
    FSSAI: ["Food Safety and Standards Authority of India", "Registration Certificate", `Registration Number : ${k.fssai}`, "Name of Food Business Operator : QA SELLER OWNER", "Valid Upto : 31/12/2030"],
  };
  return pdf(lines[docType], `kyc-${docType.toLowerCase()}-${RUN}.pdf`);
}

async function readDoc(ctx: APIRequestContext, shopId: string, docType: string, data: Buffer, name: string, mime: string) {
  return call(ctx, "POST", `/api/shops/${shopId}/documents/read`, undefined, {
    multipart: { docType, file: filePart(name, data, mime) },
  });
}

const NUMBER_OF = (k: Kyc, docType: string) => ({ PAN: k.pan, GSTIN: k.gstin, SHOP_ACT: k.shopAct, FSSAI: k.fssai })[docType] ?? "";

/**
 * Uploads, reads and confirms one document as the owner would; returns the
 * read and the confirmed view. A GST certificate's "Period of Validity From
 * <date> To Not Applicable" is read as expiring on its start date (see
 * TC-FLD-047); the owner then clears the misread date, as the screen allows.
 */
async function uploadAndConfirm(k: Kyc, docType: "PAN" | "GSTIN" | "SHOP_ACT" | "FSSAI") {
  const read = await readDoc(k.ctx, k.shopId, docType, documentPdf(k, docType), `${docType}.pdf`, "application/pdf");
  expectStatus(read, 201, `read ${docType}`);
  const blocking = (read.body.flags as { code: string; severity: string }[]).filter((f) => f.severity === "block" && !(docType === "GSTIN" && f.code === "EXPIRED"));
  expect(blocking, `${docType} read without a blocking flag`).toEqual([]);
  const confirm = await call(k.ctx, "POST", `/api/shops/${k.shopId}/documents/${read.body.id}/confirm`, {
    number: NUMBER_OF(k, docType),
    name: "QA SELLER OWNER",
    ...(docType === "FSSAI" ? { validUntil: "2030-12-31" } : { validUntil: null }),
    consent: true,
  });
  expectStatus(confirm, 200, `confirm ${docType}`);
  return { read: read.body, confirmed: confirm.body };
}

async function checklist(ctx: APIRequestContext, shopId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/documents`);
  expectStatus(res, 200, "document checklist");
  return res.body as { items: { docType: string; status: string; done: boolean; requirement: string; latest: { id: string; status: string } | null }[]; missing: string[]; fssaiRequired: boolean };
}

qa("TC-ONB-020", "KYC screens have a document upload (the earlier gap 'numbers only, no documents' is closed)", async ({ browser }) => {
  const k = await kycShop("onb020");
  const { context, page } = await pageFor(browser, k.owner);
  try {
    await page.goto(`/shop/documents?shop=${k.shopId}`);
    for (const docType of ["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]) {
      await expect(page.getByTestId(`doc-upload-${docType}`)).toBeVisible();
      await expect(page.getByTestId(`doc-upload-file-${docType}`)).toBeVisible();
    }
  } finally {
    await context.close();
  }
  return "/shop/documents shows an upload card (Upload file / Take photo) for PAN, GSTIN, Shop Act and FSSAI — the gap is closed";
}, local);

qa(["TC-ONB-044", "TC-FLD-047"], "KYC documents uploaded against the shop: GST certificate, PAN, FSSAI and Shop Act each stored, visible to the owner and operations, one overall status; a valid file is accepted and shown", async ({ browser }) => {
  const k = await kycShop("onb044");
  const before = await checklist(k.ctx, k.shopId);
  expect(before.fssaiRequired, "a dairy shop needs FSSAI").toBe(true);
  expect(before.missing.sort()).toEqual(expect.arrayContaining(["FSSAI", "PAN", "SHOP_ACT"]));
  // The owner uploads the PAN through the page (file chooser), the rest through the same API the page calls.
  const { context, page } = await pageFor(browser, k.owner);
  try {
    await page.goto(`/shop/documents?shop=${k.shopId}`);
    await page.getByTestId("doc-file-PAN").setInputFiles({ name: "pan.pdf", mimeType: "application/pdf", buffer: documentPdf(k, "PAN") });
    const review = page.getByTestId("doc-review-PAN");
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId("doc-field-number")).toHaveValue(k.pan);
    await review.getByTestId("doc-consent").check();
    await review.getByTestId("doc-verify-PAN").click();
    await expect(page.getByTestId("doc-review-PAN")).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await context.close();
  }
  const done: string[] = [];
  for (const docType of ["GSTIN", "SHOP_ACT", "FSSAI"] as const) {
    const r = await uploadAndConfirm(k, docType);
    done.push(`${docType} read by ${r.read.readerEngine} → ${r.confirmed.status}`);
  }
  const after = await checklist(k.ctx, k.shopId);
  const status = Object.fromEntries(after.items.map((i) => [i.docType, i.status]));
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]) expect(status[docType], `${docType} submitted (${JSON.stringify(status)})`).not.toBe("NOT_SUBMITTED");
  // Stored against the shop.
  const rows = await db()<{ doc_type: string; status: string }[]>`select doc_type, status from seller_document_uploads where shop_id = ${k.shopId} and status = 'CONFIRMED'`;
  expect(new Set(rows.map((r) => r.doc_type))).toEqual(new Set(["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]));
  // Operations see them, with one overall status per shop.
  const opsView = await call(await as("ops"), "GET", `/api/shops/${k.shopId}/documents`);
  expectStatus(opsView, 200, "operations open the shop's documents");
  const verification = await call(await as("ops"), "GET", `/api/shops/${k.shopId}/verifications`);
  expectStatus(verification, 200, "operations open the shop KYC");
  const overall = verification.body?.overallStatus ?? verification.body?.status ?? verification.body?.consistency?.status ?? verification.body?.summary?.status;
  const ops = await pageAs(browser, "ops");
  try {
    await ops.page.goto("/admin/document-uploads");
    await expect(ops.page.locator("main")).toContainText(k.shopName);
  } finally {
    await ops.context.close();
  }
  return `${done.join("; ")}; PAN uploaded on the page; 4 confirmed uploads stored against the shop; checklist ${JSON.stringify(status)}; operations: checklist + KYC summary (overall ${overall ?? JSON.stringify(Object.keys(verification.body ?? {}))}) and /admin/document-uploads lists the shop`;
}, local);

qa(["TC-ONB-045", "TC-FLD-047"], "KYC validation: approval is refused while a mandatory document is missing; no file, empty, oversized, .exe, HTML-as-PDF and PDF/SVG-as-JPG are refused by content with a clear message", async () => {
  const k = await kycShop("onb045");
  const missing = await call(k.ctx, "POST", `/api/shops/${k.shopId}/documents/read`, undefined, { multipart: { docType: "PAN" } });
  expect(missing.status, why(missing)).toBe(422);
  expect(missing.body?.error?.message).toMatch(/Attach the document/);
  const cases: [string, Buffer, string, string, RegExp][] = [
    ["empty file", Buffer.alloc(0), "empty.pdf", "application/pdf", /empty/i],
    ["11 MB file", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11_000_000, 0x20)]), "big.pdf", "application/pdf", /at most 10 MB/],
    [".exe", DISGUISED.exe(), "program.exe", "application/octet-stream", /PDF, JPEG, PNG or WebP/],
    ["HTML renamed .pdf", DISGUISED.html(), "page.pdf", "application/pdf", /PDF, JPEG, PNG or WebP/],
    ["SVG renamed .jpg", DISGUISED.svg(), "vector.jpg", "image/jpeg", /PDF, JPEG, PNG or WebP/],
  ];
  const seen: string[] = [];
  for (const [label, data, name, mime, message] of cases) {
    const res = await readDoc(k.ctx, k.shopId, "PAN", data, name, mime);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    expect(res.body?.error?.message, label).toMatch(message);
    seen.push(`${label} → 422`);
  }
  // A real PDF named .jpg is judged by its bytes: accepted as the PDF it is.
  const pdfAsJpg = await readDoc(k.ctx, k.shopId, "PAN", documentPdf(k, "PAN"), "photo.jpg", "image/jpeg");
  expectStatus(pdfAsJpg, 201, "a PDF named .jpg");
  expect(pdfAsJpg.body.contentType).toBe("application/pdf");
  // Mandatory documents missing: the shop cannot be approved.
  await db()`update shops set fee_payment_status = 'PAID' where id = ${k.shopId}`;
  const approve = await call(await as("ops"), "POST", `/api/shops/${k.shopId}/approve`, { classification: "GREEN" });
  expect(approve.status, why(approve)).toBe(409);
  expect(approve.body?.error?.message).toMatch(/Not yet verified|FSSAI/);
  const list = await checklist(k.ctx, k.shopId);
  expect(list.missing.length).toBeGreaterThan(0);
  return `no file → 422 "Attach the document…"; ${seen.join(", ")} (content checked); a real PDF named .jpg is stored as application/pdf; approve with ${list.missing.join(", ")} missing → 409 "${approve.body?.error?.message?.slice(0, 90)}"`;
}, { ...local, partial: "TC-FLD-047's 'valid file accepted and shown' is proven by TC-ONB-044" });

qa("TC-ONB-046", "KYC files are private: another owner, a customer and a guest get 403/404 for the file address, and a guessed id gives 404", async () => {
  const k = await kycShop("onb046a");
  const read = await readDoc(k.ctx, k.shopId, "PAN", documentPdf(k, "PAN"), "pan.pdf", "application/pdf");
  expectStatus(read, 201, "upload");
  const path = `/api/shops/${k.shopId}/documents/${read.body.id}/file`;
  const own = await call(k.ctx, "GET", path);
  expect(own.status, "the owner opens it").toBe(200);
  expect(own.headers["cache-control"]).toMatch(/no-store/);
  const other = await kycShop("onb046b");
  const guest = await anonymous();
  const answers: string[] = [];
  for (const [who, ctx] of [["another owner", other.ctx], ["customer", await as("customer")], ["guest", guest]] as const) {
    const res = await call(ctx, "GET", path);
    expect([401, 403, 404], `${who}: ${res.status}`).toContain(res.status);
    answers.push(`${who} ${res.status}`);
  }
  const guessed = await call(k.ctx, "GET", `/api/shops/${k.shopId}/documents/${NO_SUCH_ID}/file`);
  expect(guessed.status).toBe(404);
  const crossShop = await call(other.ctx, "GET", `/api/shops/${other.shopId}/documents/${read.body.id}/file`);
  expect([403, 404], "another shop's upload id under the own shop").toContain(crossShop.status);
  const listOther = await call(other.ctx, "GET", `/api/shops/${k.shopId}/documents`);
  expect([403, 404]).toContain(listOther.status);
  await guest.dispose();
  return `owner 200 (no-store); ${answers.join(", ")}; guessed id 404; the id under another shop ${crossShop.status}; another owner's checklist ${listOther.status}`;
}, { ...local, partial: "the guest half of the case is also covered in tests/qa/guest/access.spec.ts" });

qa("TC-ONB-047", "operations reject a document with a reason; the owner sees rejected with the reason, replaces it, and it returns to review; history kept", async ({ browser }) => {
  const k = await kycShop("onb047");
  const first = await uploadAndConfirm(k, "SHOP_ACT");
  const verificationId = (first.confirmed.verificationId ?? first.read.verificationId) as string | null;
  const [row] = await db()<{ id: string; status: string }[]>`select id, status from seller_verifications where shop_id = ${k.shopId} and doc_type = 'SHOP_ACT'`;
  expect(row, "a seller-verification row for the Shop Act").toBeTruthy();
  const decision = await call(await as("ops"), "POST", `/api/admin/seller-verifications/${verificationId ?? row.id}/decision`, { decision: "reject", reason: "QA: the stamp is not readable" });
  expectStatus(decision, 200, "reject the document");
  const [rejected] = await db()<{ status: string; review_note: string | null }[]>`select status, review_note from seller_verifications where id = ${row.id}`;
  expect(rejected.status, "rejected by operations").toBe("FAILED");
  const { context, page } = await pageFor(browser, k.owner);
  try {
    await page.goto(`/shop/documents?shop=${k.shopId}`);
    await expect(page.getByTestId("doc-upload-SHOP_ACT")).toContainText("Not verified");
    // The reason is on the verification page.
    await page.goto("/shop/verification");
    await expect(page.locator("main")).toContainText("QA: the stamp is not readable");
  } finally {
    await context.close();
  }
  const again = await uploadAndConfirm(k, "SHOP_ACT");
  const [now] = await db()<{ status: string }[]>`select status from seller_verifications where id = ${row.id}`;
  expect(now.status, "back to review / checked again").not.toBe("FAILED");
  const uploads = await db()<{ n: number }[]>`select count(*)::int as n from seller_document_uploads where shop_id = ${k.shopId} and doc_type = 'SHOP_ACT'`;
  expect(uploads[0].n, "both uploads kept").toBeGreaterThanOrEqual(2);
  const audits = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_id = ${row.id}`;
  return `rejected (FAILED): "Not verified" on the /shop/documents card, the reason on /shop/verification; replaced → ${now.status} (confirm ${again.confirmed.status}); ${uploads[0].n} uploads and ${audits[0].n} audit rows kept`;
}, { ...local, partial: "the documents card itself shows only 'Not verified'; the reason is on /shop/verification" });

qa("TC-FLD-047", "KYC upload: valid files are accepted — a GST certificate (REG-06 text layer), a large phone photo (4000 px); a tiny image is accepted with a low-quality warning", async () => {
  const k = await kycShop("fld047");
  const big = await readDoc(k.ctx, k.shopId, "PAN", await image(4000, 3000, "jpeg"), "phone.jpg", "image/jpeg");
  expect(big.status, why(big)).toBe(201);
  const tiny = await readDoc(k.ctx, k.shopId, "PAN", await image(200, 120, "png"), "tiny.png", "image/png");
  expect(tiny.status, why(tiny)).toBe(201);
  const codes = (tiny.body.flags as { code: string }[]).map((f) => f.code);
  expect(codes, "flagged, not silently accepted").toEqual(expect.arrayContaining(["LOW_QUALITY"]));
  // A regular taxpayer's GST certificate: "Period of Validity From 01/04/2020 To Not Applicable".
  const gst = await readDoc(k.ctx, k.shopId, "GSTIN", documentPdf(k, "GSTIN"), "gst-reg-06.pdf", "application/pdf");
  expectStatus(gst, 201, "read the GST certificate");
  const gstFlags = (gst.body.flags as { code: string; severity: string; message: string }[]);
  const note = `4000×3000 JPEG → 201 (${big.body.readerEngine}); 200×120 PNG → 201 with ${codes.join(",")}; GST REG-06 read validUntil ${gst.body.fields?.validUntil}, flags ${gstFlags.map((f) => `${f.code}/${f.severity}`).join(",") || "none"}`;
  expect(gstFlags.filter((f) => f.severity === "block"), `a valid GST certificate must not be blocked — ${note}; message: ${gstFlags[0]?.message}`).toEqual([]);
  return note;
}, local);
