/**
 * docs/document-upload-2026-10 against real PostgreSQL: upload → read →
 * review → Verify & Approve, the flags that force a re-upload, secure
 * storage, the admin view, and the FSSAI rule for food shops (Task 3).
 *
 * The reader is replaced with fixed OCR text for most cases (deterministic);
 * one case runs the real local OCR engine and the real PDF text reader.
 */
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { auditLogs, platformSettings, sellerDocumentUploads, sellerVerificationFiles, sellerVerifications, shopLegalDocuments, shops } from "@/server/db/schema";
import { setDocumentReaderForTests } from "@/server/kyc/document-reader";
import {
  confirmUploadedDocument,
  fssaiStatus,
  getDocumentChecklist,
  getUploadFile,
  listUploadsForReview,
  readUploadedDocument,
} from "@/server/services/document-uploads";
import { profileSetupView } from "@/server/registration/profile";
import { approveShop } from "@/server/services/shops";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  // resetDatabase runs older tests with the FSSAI rule off; these cases run it as shipped (on).
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["documentUpload", "statusModels"]));
  clearRuleCache();
});
afterEach(async () => {
  setDocumentReaderForTests(null);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["statusModels"]));
  clearRuleCache();
});

const NEXT_YEAR = String(new Date().getFullYear() + 1);

const fssaiText = (validUntil: string, name = "RAMESH KUMAR SHARMA") =>
  `Food Safety and Standards Authority of India\nLicense Number : 11521998000123\nName of Licensee : ${name}\nAddress of Premises : 1 Test Road, Pune 411001\nValid Upto : ${validUntil}`;

function useText(text: string, confidence = 92) {
  setDocumentReaderForTests(async () => ({ text, engine: "tesseract", confidence, imageMinSide: 1500 }));
}

async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
}

async function setup(shopType: "DAIRY" | "ELECTRONICS_STORE" = "DAIRY", status: "APPROVED" | "PENDING_APPROVAL" = "APPROVED") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Gokul Dairy", shopType, status, registrationFeePaise: 0 });
  await db.update(shops).set({ ownerName: "Ramesh Kumar Sharma", feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
  return { owner, shop, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

describe("read → review → Verify & Approve", () => {
  it("reads an FSSAI photo, pre-fills the fields, and stores the file and fields encrypted", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText(`31/03/${NEXT_YEAR}`));
    const file = await photo();

    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file, source: "CAMERA", actor });
    expect(view.fields).toMatchObject({ detectedType: "FSSAI", number: "11521998000123", name: "RAMESH KUMAR SHARMA", validUntil: `${NEXT_YEAR}-03-31` });
    expect(view.flags).toEqual([]);
    expect(view.blocking).toBe(false);

    const [row] = await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.id, view.id));
    expect(row.source).toBe("CAMERA");
    expect(row.extractedEncrypted).not.toContain("11521998000123");
    expect(row.dataEncrypted?.equals(file)).toBe(false);
    expect((await getUploadFile(view.id, actor)).data.equals(file)).toBe(true);
    // The audit log records flag codes only — never the number.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, view.id));
    expect(JSON.stringify(audits)).not.toContain("11521998000123");
  });

  it("Verify & Approve submits to seller verification and the legal-documents register, and moves the file", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText(`31/03/${NEXT_YEAR}`));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });

    const confirmed = await confirmUploadedDocument({
      shopId: shop.id,
      uploadId: view.id,
      fields: { number: "11521998000123", name: "RAMESH KUMAR SHARMA", address: "1 Test Road, Pune 411001", validUntil: `${NEXT_YEAR}-03-31` },
      consentGiven: true,
      actor,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.verificationId).not.toBeNull();
    expect(confirmed.legalDocumentId).not.toBeNull();
    expect(confirmed.fieldsCorrected).toEqual([]);

    const [verification] = await db.select().from(sellerVerifications).where(and(eq(sellerVerifications.shopId, shop.id), eq(sellerVerifications.docType, "FSSAI")));
    expect(["VERIFIED", "MANUAL_REVIEW", "PENDING"]).toContain(verification.status);
    const files = await db.select().from(sellerVerificationFiles).where(eq(sellerVerificationFiles.verificationId, verification.id));
    expect(files).toHaveLength(1);
    const [legal] = await db.select().from(shopLegalDocuments).where(and(eq(shopLegalDocuments.shopId, shop.id), eq(shopLegalDocuments.docType, "FSSAI")));
    expect(legal).toMatchObject({ status: "SUBMITTED", expiryDate: `${NEXT_YEAR}-03-31` });
    const [row] = await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.id, view.id));
    expect(row.dataEncrypted).toBeNull();

    expect((await fssaiStatus(shop)).onFile).toBe(true);
    // A second click returns the same result and submits nothing twice.
    const again = await confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: true, actor });
    expect(again.id).toBe(view.id);
    expect(await db.select().from(sellerVerificationFiles).where(eq(sellerVerificationFiles.shopId, shop.id))).toHaveLength(1);
  });

  it("records fields the owner corrected, for the admin", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText(`31/03/${NEXT_YEAR}`).replace("11521998000123", "1152199800012"));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    expect(view.flags.map((f) => f.code)).toContain("NUMBER_NOT_FOUND");
    await confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: true, actor });

    const admin = await createUser({ role: "ADMIN" });
    const review = await listUploadsForReview({ id: admin.id, role: "ADMIN" }, { flaggedOnly: true });
    expect(review).toHaveLength(1);
    expect(review[0].fieldsCorrected).toEqual(expect.arrayContaining(["number"]));
    expect(review[0].confirmed?.number).toBe("11521998000123");
    // Customers and other shop owners can't see uploads.
    const other = await createUser({ role: "SHOP_OWNER" });
    await expect(listUploadsForReview({ id: other.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getUploadFile(view.id, { id: other.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses consent-less submissions and someone else's shop", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText(`31/03/${NEXT_YEAR}`));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    await expect(
      confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: false, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor: { id: stranger.id, role: "SHOP_OWNER" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("mismatch flags and re-upload", () => {
  it("blocks an expired FSSAI licence: flagged on read, refused on submit", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText("31/03/2024"));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    expect(view.flags).toContainEqual(expect.objectContaining({ code: "EXPIRED", severity: "block" }));

    await expect(
      confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: "2024-03-31" }, consentGiven: true, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reupload: true } });
    expect((await fssaiStatus(shop)).onFile).toBe(false);
  });

  it("asks for a re-upload of an unreadable photo and refuses to submit it", async () => {
    const { shop, actor } = await setup();
    useText("~ ~ .", 10);
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    expect(view.flags).toContainEqual(expect.objectContaining({ code: "UNREADABLE", severity: "block" }));
    await expect(
      confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: true, actor }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reupload: true } });
  });

  it("flags a name that differs from the registration", async () => {
    const { shop, actor } = await setup();
    useText(fssaiText(`31/03/${NEXT_YEAR}`, "SURESH PATIL TRADERS"));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    expect(view.flags.map((f) => f.code)).toContain("NAME_MISMATCH");
  });

  it("refuses files that are not a PDF or an image", async () => {
    const { shop, actor } = await setup();
    await expect(readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: Buffer.from("hello, not a document"), actor })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("FSSAI mandatory for food shops (Task 3)", () => {
  it("a food shop cannot be approved without a valid FSSAI licence; it can once one is uploaded", async () => {
    const { shop, actor } = await setup("DAIRY", "PENDING_APPROVAL");
    const admin = await createUser({ role: "ADMIN" });
    const adminActor = { id: admin.id, role: "ADMIN" as const };
    await setRule("statusModels", { ...(await getRule("statusModels")), enforceTransitions: false }, adminActor);

    await expect(approveShop(shop.id, { classification: "KESARI" }, adminActor)).rejects.toMatchObject({ code: "CONFLICT", details: { fssaiRequired: true } });

    const checklist = await getDocumentChecklist(shop.id, actor);
    expect(checklist.fssaiRequired).toBe(true);
    expect(checklist.missing).toContain("FSSAI");

    useText(fssaiText(`31/03/${NEXT_YEAR}`));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    await confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: true, actor });

    const approved = await approveShop(shop.id, { classification: "KESARI" }, adminActor);
    expect(approved.status).toBe("APPROVED");
  });

  it("a non-food shop is not asked for FSSAI", async () => {
    const { shop, actor } = await setup("ELECTRONICS_STORE", "PENDING_APPROVAL");
    const checklist = await getDocumentChecklist(shop.id, actor);
    expect(checklist.fssaiRequired).toBe(false);
    expect(checklist.items.map((i) => i.docType)).not.toContain("FSSAI");
  });

  it("self-registration profile is incomplete for a food shop until FSSAI is on file", async () => {
    const { shop, actor } = await setup();
    const before = await profileSetupView(shop.id, actor);
    expect(before.missing).toContain("FSSAI licence");
    expect(before.fssai.blocker).toBeTruthy();

    useText(fssaiText(`31/03/${NEXT_YEAR}`));
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor });
    await confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` }, consentGiven: true, actor });
    const after = await profileSetupView(shop.id, actor);
    expect(after.missing).not.toContain("FSSAI licence");
    expect(after.fssai.onFile).toBe(true);
  });

  it("the rule can be switched off (back to remind-only)", async () => {
    const { shop, actor } = await setup();
    const admin = await createUser({ role: "ADMIN" });
    await setRule("documentUpload", { ...(await getRule("documentUpload")), fssaiMandatoryForFood: false }, { id: admin.id, role: "ADMIN" });
    expect((await profileSetupView(shop.id, actor)).missing).not.toContain("FSSAI licence");
  });
});

describe("real readers", () => {
  it("reads a photographed FSSAI licence with the local OCR engine", async () => {
    const { shop, actor } = await setup();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="600"><rect width="100%" height="100%" fill="white"/>
      <text x="40" y="80" font-size="40" font-family="DejaVu Sans, Arial, sans-serif">Food Safety and Standards Authority of India</text>
      <text x="40" y="170" font-size="40" font-family="DejaVu Sans, Arial, sans-serif">License Number : 11521998000123</text>
      <text x="40" y="260" font-size="40" font-family="DejaVu Sans, Arial, sans-serif">Name of Licensee : RAMESH KUMAR SHARMA</text>
      <text x="40" y="350" font-size="40" font-family="DejaVu Sans, Arial, sans-serif">Valid Upto : 31/03/${NEXT_YEAR}</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: png, actor });
    expect(view.readerEngine).toBe("tesseract");
    expect(view.fields?.number).toBe("11521998000123");
    expect(view.fields?.validUntil).toBe(`${NEXT_YEAR}-03-31`);
  });

  it("reads a PDF certificate's own text", async () => {
    const { shop, actor } = await setup();
    const lines = ["Food Safety and Standards Authority of India", "License Number : 11521998000123", `Valid Upto : 31/03/${NEXT_YEAR}`];
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: minimalPdf(lines), actor });
    expect(view.readerEngine).toBe("pdf-text");
    expect(view.fields?.number).toBe("11521998000123");
    expect(view.fields?.validUntil).toBe(`${NEXT_YEAR}-03-31`);
  });
});

/** A one-page PDF with the given lines as real text (Helvetica). */
function minimalPdf(lines: string[]): Buffer {
  const content = ["BT", "/F1 14 Tf", "50 750 Td", "18 TL", ...lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
