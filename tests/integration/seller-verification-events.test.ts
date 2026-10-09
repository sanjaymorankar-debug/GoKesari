/**
 * Event layer — seller verification runs on submission: the seller hears the
 * result at once, a manual review reaches support with a link, every decision
 * notifies the seller and the other reviewers, a fully verified shop can be
 * approved without a person, and documents stuck in review are chased daily.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { domainEvents, notifications, sellerVerifications, shops } from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { adminDecideVerification, submitSellerDocument } from "@/server/services/seller-verification";
import { remindStuckReviews } from "@/server/services/seller-verification-jobs";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});
afterEach(() => setKycAdapterForTests(null));

const notesFor = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const operator = await createUser({ role: "OPERATOR" });
  const admin = await createUser({ role: "ADMIN" });
  const shop = await createShop(owner.id, { name: "Shree Dairy", status: "PENDING_APPROVAL" });
  return {
    owner,
    operator,
    admin,
    shop,
    actor: { id: owner.id, role: "SHOP_OWNER" as const },
    adminActor: { id: admin.id, role: "ADMIN" as const },
  };
}

describe("seller verification events", () => {
  it("a verified document is confirmed to the seller the moment it is submitted", async () => {
    const { owner, shop, actor } = await setup();
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_DOCUMENT_VERIFIED)).toHaveLength(1);
    const [event] = await db.select().from(domainEvents).where(eq(domainEvents.type, "seller_document.checked"));
    expect(event).toMatchObject({ toStatus: "VERIFIED", subjectType: "seller_verification" });
  });

  it("manual review: the seller is told what is pending and support gets a review link", async () => {
    const { owner, operator, admin, shop, actor } = await setup();
    const view = await submitSellerDocument({
      shopId: shop.id,
      docType: "SHOP_ACT",
      number: "PMC/SHOP/12345",
      consentGiven: true,
      actor,
    });
    expect(view.status).toBe("MANUAL_REVIEW");

    const [sellerNote] = await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_DOCUMENT_IN_REVIEW);
    expect(sellerNote.body).toContain("Shop Act");
    for (const staff of [operator, admin]) {
      const [alert] = await notesFor(staff.id, NOTIFICATION_TYPES.SUPPORT_SELLER_REVIEW);
      expect(alert.actionUrl).toBe("/admin/seller-verification");
    }
  });

  it("asking for more information notifies the seller with what is needed, and the other reviewers", async () => {
    const { owner, operator, shop, actor, adminActor } = await setup();
    const view = await submitSellerDocument({ shopId: shop.id, docType: "SHOP_ACT", number: "PMC/SHOP/12345", consentGiven: true, actor });
    const decided = await adminDecideVerification(view.id!, { decision: "more_info", reason: "Upload a clearer photo of the certificate." }, adminActor);
    expect(decided).toMatchObject({ status: "FAILED", lastErrorCode: "more_info_requested" });

    const [sellerNote] = await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_DOCUMENT_ATTENTION);
    expect(sellerNote.title).toContain("More information needed");
    expect(sellerNote.body).toContain("clearer photo");
    expect(await notesFor(operator.id, NOTIFICATION_TYPES.SUPPORT_SELLER_DECIDED)).toHaveLength(1);
    // The reviewer who decided is not told about their own decision.
    expect(await notesFor(adminActor.id, NOTIFICATION_TYPES.SUPPORT_SELLER_DECIDED)).toHaveLength(0);
  });

  it("auto-approve (rule on): the last verified document approves the shop at once", async () => {
    const { owner, operator, shop, actor, adminActor } = await setup();
    await setRule("sellerVerification", { autoApproveShop: true }, adminActor);
    // No classification yet: the rule's default (GREEN) is assigned.
    await db.update(shops).set({ feePaymentStatus: "PAID", classification: null }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id, ["GSTIN", "SHOP_ACT", "FSSAI", "UDYAM"]);

    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });

    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after).toMatchObject({ status: "APPROVED", classification: "GREEN" });
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_APPROVED)).toHaveLength(1);
    expect(await notesFor(operator.id, NOTIFICATION_TYPES.SUPPORT_SHOP_AUTO_APPROVED)).toHaveLength(1);
  });

  it("auto-approve off (the default): a fully verified shop still waits for a person", async () => {
    const { shop, actor } = await setup();
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id, ["GSTIN", "SHOP_ACT", "FSSAI", "UDYAM"]);
    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor });
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.status).toBe("PENDING_APPROVAL");
  });

  it("documents stuck in review are chased once a day", async () => {
    const { operator, shop, actor } = await setup();
    await submitSellerDocument({ shopId: shop.id, docType: "SHOP_ACT", number: "PMC/SHOP/12345", consentGiven: true, actor });
    await db
      .update(sellerVerifications)
      .set({ updatedAt: new Date(Date.now() - 30 * 3_600_000) })
      .where(eq(sellerVerifications.shopId, shop.id));

    expect(await remindStuckReviews(new Date(), 24)).toBe(1);
    expect(await remindStuckReviews(new Date(), 24)).toBe(0);
    const [reminder] = await notesFor(operator.id, NOTIFICATION_TYPES.SUPPORT_SELLER_REVIEW_REMINDER);
    expect(reminder.body).toContain("1 seller document");
  });
});
