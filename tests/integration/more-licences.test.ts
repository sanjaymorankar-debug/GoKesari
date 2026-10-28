/**
 * docs/document-upload-2026-10, "Scan a document" and "More licences", against
 * real PostgreSQL: a scanned document is filed under the type its wording (or
 * number) gives; an unrecognised one stores nothing; the optional licences go
 * to the legal-documents register for review without ever gating the shop,
 * unless the rule's otherRequirements makes one mandatory; a shop can hold
 * several named Other licences.
 *
 * The reader is replaced with fixed OCR text (deterministic).
 */
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUTO_DETECT } from "@/lib/kyc/document-extract";
import { db } from "@/server/db";
import { platformSettings, sellerDocumentUploads, shopLegalDocuments, shops } from "@/server/db/schema";
import { setDocumentReaderForTests } from "@/server/kyc/document-reader";
import { confirmUploadedDocument, getDocumentChecklist, readUploadedDocument } from "@/server/services/document-uploads";
import {
  assertLegalDocsAllowApproval,
  decideLegalDocument,
  getShopLegalStatus,
  legallyBlockedShopIds,
  listLegalDocumentsForReview,
} from "@/server/services/legal-documents";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const NEXT_YEAR = String(new Date().getFullYear() + 1);

const tradeText = `PUNE MUNICIPAL CORPORATION\nTRADE LICENCE\nLicence No : PMC/TL/2026/012345\nName of Trader : RAMESH KUMAR SHARMA\nFSSAI Licence No : 11521998000123\nValid Upto : 31/03/${NEXT_YEAR}`;

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["documentUpload", "legalDocuments", "statusModels"]));
  clearRuleCache();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});
afterEach(async () => {
  setDocumentReaderForTests(null);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["legalDocuments", "statusModels"]));
  clearRuleCache();
});

function useText(text: string) {
  setDocumentReaderForTests(async () => ({ text, engine: "tesseract", confidence: 92, imageMinSide: 1500 }));
}

async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
}

async function setup(status: "APPROVED" | "PENDING_APPROVAL" = "APPROVED") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Sharma General Stores", shopType: "ELECTRONICS_STORE", status, registrationFeePaise: 0 });
  await db.update(shops).set({ ownerName: "Ramesh Kumar Sharma", feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
  return { shop, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

const enableLegal = (overrides: Record<string, unknown> = {}) => setRule("legalDocuments", { enabled: true, ...overrides }, admin);

describe("Scan a document", () => {
  it("files a scanned trade licence under Trade licence, read as if uploaded on its card", async () => {
    const { shop, actor } = await setup();
    useText(tradeText);
    const view = await readUploadedDocument({ shopId: shop.id, docType: AUTO_DETECT, file: await photo(), source: "CAMERA", actor });
    expect(view.docType).toBe("TRADE_LICENCE");
    expect(view.fields).toMatchObject({ detectedType: "TRADE_LICENCE", number: "PMC/TL/2026/012345", validUntil: `${NEXT_YEAR}-03-31` });
    expect(view.flags.map((f) => f.code)).not.toContain("WRONG_DOCUMENT");

    // The checklist shows it on the Trade licence card, under the optional licences.
    const item = (await getDocumentChecklist(shop.id, actor)).items.find((i) => i.docType === "TRADE_LICENCE");
    expect(item).toMatchObject({ requirement: "optional", additional: true });
    expect(item?.latest?.id).toBe(view.id);
  });

  it("files a scanned PAN card under PAN", async () => {
    const { shop, actor } = await setup();
    useText("INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nRAMESH KUMAR SHARMA\nPermanent Account Number\nABCPE1234F");
    const view = await readUploadedDocument({ shopId: shop.id, docType: AUTO_DETECT, file: await photo(), actor });
    expect(view.docType).toBe("PAN");
    expect(view.fields?.number).toBe("ABCPE1234F");
  });

  it("stores nothing when it can't tell which document it is, and says to use the card", async () => {
    const { shop, actor } = await setup();
    useText("Some certificate\nIssued to Ramesh Kumar Sharma\nNo. 4471/22");
    await expect(readUploadedDocument({ shopId: shop.id, docType: AUTO_DETECT, file: await photo(), actor })).rejects.toThrow(
      /couldn't tell which document this is/,
    );
    expect(await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.shopId, shop.id))).toHaveLength(0);
  });

  it("files a drug licence the shop isn't asked for, so the owner can still review and submit it", async () => {
    const { shop, actor } = await setup();
    useText(`Drugs and Cosmetics Act\nFORM 20\nLicence No : MH-PZ1-123456\nValid Upto : 31/12/${NEXT_YEAR}`);
    const view = await readUploadedDocument({ shopId: shop.id, docType: AUTO_DETECT, file: await photo(), actor });
    expect(view.docType).toBe("DRUG_LICENCE");
    const item = (await getDocumentChecklist(shop.id, actor)).items.find((i) => i.docType === "DRUG_LICENCE");
    expect(item).toMatchObject({ requirement: "optional", additional: false });
  });
});

describe("More licences", () => {
  it("submits a trade licence to the register for review; it never gates the shop", async () => {
    await enableLegal();
    const { shop, actor } = await setup();
    useText(tradeText);
    const view = await readUploadedDocument({ shopId: shop.id, docType: "TRADE_LICENCE", file: await photo(), actor });
    const confirmed = await confirmUploadedDocument({
      shopId: shop.id,
      uploadId: view.id,
      fields: { number: "PMC/TL/2026/012345", validUntil: `${NEXT_YEAR}-03-31`, issuingCouncil: "Pune Municipal Corporation" },
      consentGiven: true,
      actor,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.verificationId).toBeNull();
    const [legal] = await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.id, confirmed.legalDocumentId!));
    expect(legal).toMatchObject({
      docType: "TRADE_LICENCE",
      status: "SUBMITTED",
      expiryDate: `${NEXT_YEAR}-03-31`,
      issuingCouncil: "Pune Municipal Corporation",
      licenceKey: "",
    });

    const status = await getShopLegalStatus(shop.id);
    expect(status.documents.map((d) => d.docType)).not.toContain("TRADE_LICENCE");
    expect(status.additional).toMatchObject([{ docType: "TRADE_LICENCE", state: "SUBMITTED", blocking: false }]);

    // Operations see it in the review queue and can reject it; the shop still trades.
    const queue = await listLegalDocumentsForReview("to_review", admin);
    expect(queue.map((r) => r.label)).toContain("Trade licence (municipal)");
    await decideLegalDocument(legal.id, { decision: "reject", reason: "The copy is cut off at the bottom." }, admin);
    expect((await getShopLegalStatus(shop.id)).restricted).toBe(false);
    expect((await legallyBlockedShopIds([shop.id])).size).toBe(0);
  });

  it("keeps several named Other licences side by side; the same name replaces its own copy", async () => {
    const { shop, actor } = await setup();
    const submit = async (licenceName: string, number: string) => {
      useText(`Licence\nLicence No : ${number}`);
      const view = await readUploadedDocument({ shopId: shop.id, docType: "OTHER_LICENCE", file: await photo(), actor });
      return confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number, licenceName }, consentGiven: true, actor });
    };
    await submit("Explosives licence", "EXP/2026/111");
    await submit("Petroleum storage licence", "PESO/2026/222");
    await submit("explosives  LICENCE", "EXP/2026/333");

    const rows = await db
      .select()
      .from(shopLegalDocuments)
      .where(and(eq(shopLegalDocuments.shopId, shop.id), eq(shopLegalDocuments.docType, "OTHER_LICENCE")));
    expect(rows.map((r) => r.licenceKey).sort()).toEqual(["EXPLOSIVES-LICENCE", "PETROLEUM-STORAGE-LICENCE"]);
    expect(rows.find((r) => r.licenceKey === "EXPLOSIVES-LICENCE")?.numberLast4).toBe("6333");

    const item = (await getDocumentChecklist(shop.id, actor)).items.find((i) => i.docType === "OTHER_LICENCE");
    expect(item?.held.sort()).toEqual(["Petroleum storage licence", "explosives LICENCE"].sort());
    expect(item?.done).toBe(false);
  });

  it("refuses an Other licence without its name", async () => {
    const { shop, actor } = await setup();
    useText("Licence\nLicence No : EXP/2026/111");
    const view = await readUploadedDocument({ shopId: shop.id, docType: "OTHER_LICENCE", file: await photo(), actor });
    await expect(
      confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "EXP/2026/111" }, consentGiven: true, actor }),
    ).rejects.toThrow(/name of the licence/);
    // Released, so the owner can fix it and submit again.
    const [row] = await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.id, view.id));
    expect(row).toMatchObject({ status: "EXTRACTED", confirmedBy: null });
  });

  it("otherRequirements makes a licence mandatory for the shop types it names", async () => {
    await enableLegal({ otherRequirements: [{ docType: "TRADE_LICENCE", shopTypes: ["ELECTRONICS_STORE"], categorySlugs: [] }] });
    const { shop, actor } = await setup("PENDING_APPROVAL");
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    await expect(assertLegalDocsAllowApproval(row)).rejects.toThrow(/Trade licence/);
    const item = (await getDocumentChecklist(shop.id, actor)).items.find((i) => i.docType === "TRADE_LICENCE");
    expect(item?.requirement).toBe("required");
    expect((await getDocumentChecklist(shop.id, actor)).missing).toContain("TRADE_LICENCE");

    useText(tradeText);
    const view = await readUploadedDocument({ shopId: shop.id, docType: "TRADE_LICENCE", file: await photo(), actor });
    await confirmUploadedDocument({ shopId: shop.id, uploadId: view.id, fields: { number: "PMC/TL/2026/012345" }, consentGiven: true, actor });
    await expect(assertLegalDocsAllowApproval(row)).resolves.toBeUndefined();
  });
});
