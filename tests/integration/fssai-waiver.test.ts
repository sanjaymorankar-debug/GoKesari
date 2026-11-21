/**
 * Owner request, 21-Nov-2026 (migration 0159, services/fssai-waiver.ts):
 *
 *   - an admin can approve a food shop without its FSSAI licence, with a written reason; the owner
 *     then has documentUpload.fssaiWaiverDays (30) to upload it and is told the due date
 *   - an operator cannot; without the override the FSSAI gate still refuses
 *   - a shop whose only unverified seller document is FSSAI is covered by the same override; one
 *     with any other document missing is not
 *   - the 1st / 15th follow-up suspends the shop after the due date if no valid licence is on file
 *   - an admin can upload the licence the owner sent to GoKesari, on the owner's behalf
 *   - a licence over the register's file limit is refused when it is uploaded, not at Verify & Approve
 */
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addDays, todayIn, type IsoDate } from "@/lib/dates";
import { db } from "@/server/db";
import {
  auditLogs,
  notifications,
  platformSettings,
  shopDocumentWaivers,
  shopFssaiWaivers,
  shopLegalDocuments,
  shops,
} from "@/server/db/schema";
import { setDocumentReaderForTests } from "@/server/kyc/document-reader";
import { confirmUploadedDocument, fssaiStatus, readUploadedDocument } from "@/server/services/document-uploads";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { nextFollowUpDay, runShopDocumentFollowUp } from "@/server/services/shop-document-follow-up";
import { approveShop } from "@/server/services/shops";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

const DAY = 86_400_000;
const NEXT_YEAR = String(new Date().getFullYear() + 1);
const REASON = "Owner showed the FSSAI application receipt at the shop.";

let admin: { id: string; role: "ADMIN" };
let operator: { id: string; role: "OPERATOR" };

beforeEach(async () => {
  await resetDatabase();
  // resetDatabase runs older tests with the FSSAI rule off; these cases run it as shipped (on).
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["documentUpload", "statusModels", "uploads"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  operator = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" };
});
afterEach(async () => {
  setDocumentReaderForTests(null);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["statusModels", "uploads"]));
  clearRuleCache();
});

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];

/** A dairy waiting for approval, fee settled, every seller document but FSSAI verified. */
async function dairyWithoutFssai() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Shriniwas Dairy", shopType: "DAIRY", status: "PENDING_APPROVAL", registrationFeePaise: 0 });
  await db.update(shops).set({ ownerName: "Ramesh Kumar Sharma", feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
  await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
  return { owner, shop: await shopRow(shop.id) };
}

function useFssaiText(validUntil: string) {
  const text = `Food Safety and Standards Authority of India\nLicense Number : 11521998000123\nName of Licensee : RAMESH KUMAR SHARMA\nAddress of Premises : 1 Test Road, Pune 411001\nValid Upto : ${validUntil}`;
  setDocumentReaderForTests(async () => ({ text, engine: "tesseract", confidence: 92, imageMinSide: 1500 }));
}

const photo = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();

describe("approve without FSSAI", () => {
  it("is refused without the override, and to an operator", async () => {
    const { shop } = await dairyWithoutFssai();
    await expect(approveShop(shop.id, { classification: "GREEN" }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approveShop(shop.id, { classification: "GREEN" }, operator, { waiveFssai: { reason: REASON } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await shopRow(shop.id)).status).toBe("PENDING_APPROVAL");
    expect(await db.select().from(shopFssaiWaivers)).toHaveLength(0);
  });

  it("an admin approves with a reason: the licence is due in 30 days, recorded, audited and told to the owner", async () => {
    const { owner, shop } = await dairyWithoutFssai();
    const before = Date.now();
    const approved = await approveShop(shop.id, { classification: "GREEN" }, admin, { waiveFssai: { reason: REASON } });
    expect(approved.status).toBe("APPROVED");

    const [waiver] = await db.select().from(shopFssaiWaivers).where(eq(shopFssaiWaivers.shopId, shop.id));
    expect(waiver).toMatchObject({ reason: REASON, waivedBy: admin.id });
    const days = (waiver.dueAt.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    // Only FSSAI was missing: the documents waiver names it alone (it moves the shop out of KYC_PENDING).
    const docWaivers = await db.select().from(shopDocumentWaivers).where(eq(shopDocumentWaivers.shopId, shop.id));
    expect(docWaivers.map((w) => w.missingDocTypes)).toEqual([["FSSAI"]]);

    // The legal-documents register gets the same deadline (orders are not refused before it).
    const [legal] = await db
      .select()
      .from(shopLegalDocuments)
      .where(and(eq(shopLegalDocuments.shopId, shop.id), eq(shopLegalDocuments.docType, "FSSAI")));
    expect(legal.graceUntil?.getTime()).toBe(waiver.dueAt.getTime());

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.approved_without_fssai")));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(admin.id);

    const notice = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.licence_grace_notice")));
    expect(notice).toHaveLength(1);
    expect(notice[0].body).toMatch(/FSSAI licence is mandatory/);
    expect(notice[0].actionUrl).toBe(`/shop/documents?shop=${shop.id}`);
  });

  it("does not cover another missing seller document", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY", status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN"]); // no Shop Act

    await expect(approveShop(shop.id, { classification: "GREEN" }, admin, { waiveFssai: { reason: REASON } })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/Shop Act/),
    });
    expect(await db.select().from(shopFssaiWaivers)).toHaveLength(0);
    expect(await db.select().from(shopDocumentWaivers)).toHaveLength(0);
  });

  it("works together with Approve without documents", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY", status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));

    const approved = await approveShop(shop.id, { classification: "GREEN" }, admin, {
      waiveDocuments: { reason: REASON },
      waiveFssai: { reason: REASON },
    });
    expect(approved.status).toBe("APPROVED");
    expect(await db.select().from(shopFssaiWaivers)).toHaveLength(1);
  });

  it("records nothing when a valid licence is already on file", async () => {
    const { shop } = await dairyWithoutFssai();
    await verifySellerDocuments(shop.id, ["FSSAI"]);
    await db
      .insert(shopLegalDocuments)
      .values({ shopId: shop.id, docType: "FSSAI", status: "SUBMITTED", expiryDate: `${NEXT_YEAR}-03-31` });
    expect((await fssaiStatus(shop)).onFile).toBe(true);
    const approved = await approveShop(shop.id, { classification: "GREEN" }, admin, { waiveFssai: { reason: REASON } });
    expect(approved.status).toBe("APPROVED");
    expect(await db.select().from(shopFssaiWaivers)).toHaveLength(0);
  });
});

describe("follow-up after approval without FSSAI", () => {
  /** The first reminder day (1st / 15th) on or after `from`. */
  const reminderDayFrom = (from: Date): IsoDate => nextFollowUpDay(addDays(todayIn("Asia/Kolkata", from), -1), [1, 15]);

  it("reminds before the due date and suspends after it when no licence is on file", async () => {
    const { owner, shop } = await dairyWithoutFssai();
    await approveShop(shop.id, { classification: "GREEN" }, admin, { waiveFssai: { reason: REASON } });
    const [waiver] = await db.select().from(shopFssaiWaivers).where(eq(shopFssaiWaivers.shopId, shop.id));

    const early = reminderDayFrom(new Date(Date.now() + 2 * DAY));
    expect(await runShopDocumentFollowUp(early, new Date(`${early}T00:30:00Z`))).toMatchObject({ reminded: 1, suspended: 0 });
    const reminder = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.documents_follow_up")));
    expect(reminder[0].actionUrl).toBe(`/shop/documents?shop=${shop.id}`);

    const late = reminderDayFrom(new Date(waiver.dueAt.getTime() + DAY));
    expect(await runShopDocumentFollowUp(late, new Date(`${late}T00:30:00Z`))).toMatchObject({ suspended: 1 });
    expect((await shopRow(shop.id)).status).toBe("SUSPENDED");
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.documents_follow_up")))
      .orderBy(auditLogs.createdAt)
      .then((rows) => rows.slice(-1));
    expect(audit.newValue).toMatchObject({ outcome: "SUSPENDED", fssaiWaiverDue: true });
  });

  it("does not suspend on the FSSAI date once a licence is on file", async () => {
    const { shop } = await dairyWithoutFssai();
    await approveShop(shop.id, { classification: "GREEN" }, admin, { waiveFssai: { reason: REASON } });
    const [waiver] = await db.select().from(shopFssaiWaivers).where(eq(shopFssaiWaivers.shopId, shop.id));
    // Submitted (with the team for its check), with a valid expiry: on file, though not VERIFIED yet.
    await db
      .update(shopLegalDocuments)
      .set({ status: "SUBMITTED", expiryDate: `${NEXT_YEAR}-03-31` })
      .where(and(eq(shopLegalDocuments.shopId, shop.id), eq(shopLegalDocuments.docType, "FSSAI")));

    const late = reminderDayFrom(new Date(waiver.dueAt.getTime() + DAY));
    expect(await runShopDocumentFollowUp(late, new Date(`${late}T00:30:00Z`))).toMatchObject({ suspended: 0 });
    expect((await shopRow(shop.id)).status).toBe("APPROVED");
  });
});

describe("admin uploads the owner's licence", () => {
  it("an admin uploads the FSSAI licence the owner sent; the shop can then be approved normally", async () => {
    const { shop } = await dairyWithoutFssai();
    useFssaiText(`31/03/${NEXT_YEAR}`);
    const view = await readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: await photo(), actor: admin });
    const confirmed = await confirmUploadedDocument({
      shopId: shop.id,
      uploadId: view.id,
      fields: { number: "11521998000123", validUntil: `${NEXT_YEAR}-03-31` },
      consentGiven: true,
      actor: admin,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    expect((await fssaiStatus(shop)).onFile).toBe(true);

    // The FSSAI government check runs on its own; here it has passed.
    await verifySellerDocuments(shop.id, ["FSSAI"]);
    const approved = await approveShop(shop.id, { classification: "GREEN" }, admin);
    expect(approved.status).toBe("APPROVED");
    expect(await db.select().from(shopFssaiWaivers)).toHaveLength(0);
  });

  it("refuses a licence file over the register's limit when it is uploaded", async () => {
    const { shop } = await dairyWithoutFssai();
    await setRule("uploads", { ...(await getRule("uploads")), sellerDocumentMaxBytes: 100_000 }, admin);
    const noise = Buffer.alloc(600 * 600 * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) % 251;
    const big = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    expect(big.length).toBeGreaterThan(100_000);
    useFssaiText(`31/03/${NEXT_YEAR}`);
    await expect(readUploadedDocument({ shopId: shop.id, docType: "FSSAI", file: big, actor: admin })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/at most 0\.1 MB/),
    });
  });
});
