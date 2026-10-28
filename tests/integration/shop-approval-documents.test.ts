/**
 * Shop approval queue, documents: the queue tells "nothing uploaded" apart from
 * "uploaded, waiting for review", operations can remind the owner to upload,
 * and an admin can approve without the seller documents with a written reason
 * (migration 0109, shop_document_waivers).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminNextAction, reminderSentText } from "@/lib/shop-onboarding";
import { db } from "@/server/db";
import {
  auditLogs,
  notificationDeliveries,
  notifications,
  platformSettings,
  sellerVerifications,
  shopDocumentWaivers,
  shops,
  statusChanges,
} from "@/server/db/schema";
import { upsertRow } from "@/server/db/split/upsert";
import { emailChannel, smsChannel } from "@/server/notifications/channels";
import { getShopOnboarding } from "@/server/services/shop-onboarding";
import { clearRuleCache } from "@/server/services/settings";
import { approveShop, remindShopDocuments } from "@/server/services/shops";
import { recordPayment, waiveRegistrationFee } from "@/server/services/shop-payments";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "statusModels"));
  clearRuleCache();
});

/** A non-food shop waiting for approval with its fee settled. */
async function pendingShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 0 });
  await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
  return { owner, shop };
}

async function submit(shopId: string, docType: "PAN" | "GSTIN" | "SHOP_ACT", status: "PENDING" | "FAILED") {
  await upsertRow(db, sellerVerifications, {
    keys: [sellerVerifications.shopId, sellerVerifications.docType],
    values: { shopId, docType, status },
    set: { status },
  });
}

describe("queue wording", () => {
  it("says plainly when the owner has uploaded nothing", async () => {
    const { shop } = await pendingShop();
    const facts = (await getShopOnboarding([shop.id])).get(shop.id)!;
    expect(facts.documentsUploaded).toBe(0);
    expect(facts.notUploadedDocuments).toEqual(["PAN", "GST number (GSTIN)", expect.stringMatching(/Shop Act/)]);
    expect(adminNextAction(facts).text).toMatch(/has not uploaded any documents yet.*remind the owner/);
  });

  it("splits what to review, what was not accepted and what is not uploaded", async () => {
    const { shop } = await pendingShop();
    await submit(shop.id, "PAN", "PENDING");
    await submit(shop.id, "GSTIN", "FAILED");
    const facts = (await getShopOnboarding([shop.id])).get(shop.id)!;
    expect(facts.inReviewDocuments).toEqual(["PAN"]);
    expect(facts.sendAgainDocuments).toEqual(["GST number (GSTIN)"]);
    const text = adminNextAction(facts).text;
    expect(text).toContain("To review: PAN.");
    expect(text).toContain("Not accepted, owner must upload again: GST number (GSTIN).");
    expect(text).toMatch(/Not uploaded yet: .*Shop Act/);
  });
});

describe("remind owner to upload", () => {
  it("notifies the owner once a day with what is missing, and audits it", async () => {
    const { owner, shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    await submit(shop.id, "PAN", "PENDING"); // being reviewed: not the owner's to send

    const first = await remindShopDocuments(shop.id, OPERATOR(operator.id));
    expect(first.sent).toBe(true);
    expect(first.documents).not.toContain("PAN");
    const sent = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/GST number \(GSTIN\)/);
    expect(sent[0].actionUrl).toBe("/shop/verification");

    const second = await remindShopDocuments(shop.id, OPERATOR(operator.id));
    expect(second.sent).toBe(false);
    expect(await db.select().from(notifications).where(eq(notifications.userId, owner.id))).toHaveLength(1);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.documents_reminded")));
    expect(audit).toHaveLength(1);
  });

  it("names only the channels that can deliver: no SMS where no provider is set up", async () => {
    const { owner, shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    vi.spyOn(emailChannel, "isAvailable").mockReturnValue(true);
    vi.spyOn(smsChannel, "isAvailable").mockReturnValue(false);

    const result = await remindShopDocuments(shop.id, OPERATOR(operator.id));
    expect(result.channels).toEqual(["IN_APP", "EMAIL"]);
    const queued = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, owner.id));
    expect(queued.map((d) => d.channel)).toEqual(["EMAIL"]); // no SMS row to be skipped later
    expect(reminderSentText("Asha", result.channels)).toBe("Reminder sent to Asha in the app and by e-mail.");
  });

  it("includes SMS when a provider is set up and the owner has a mobile number", async () => {
    const { shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    vi.spyOn(emailChannel, "isAvailable").mockReturnValue(true);
    vi.spyOn(smsChannel, "isAvailable").mockReturnValue(true);

    const result = await remindShopDocuments(shop.id, OPERATOR(operator.id));
    expect(result.channels).toEqual(expect.arrayContaining(["IN_APP", "EMAIL", "SMS"]));
    expect(result.channels).toHaveLength(3);
  });

  it("leaves e-mail out when e-mail is not set up on the server", async () => {
    const { shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    vi.spyOn(emailChannel, "isAvailable").mockReturnValue(false);
    vi.spyOn(smsChannel, "isAvailable").mockReturnValue(false);

    const result = await remindShopDocuments(shop.id, OPERATOR(operator.id));
    expect(result.channels).toEqual(["IN_APP"]);
    expect(reminderSentText("Asha", result.channels)).toBe("Reminder sent to Asha in the app.");
  });

  it("refuses when the owner has nothing left to upload", async () => {
    const { shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    await expect(remindShopDocuments(shop.id, OPERATOR(operator.id))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("approve without documents", () => {
  it("lets an admin approve a KYC_PENDING shop with a reason, and records the waiver", async () => {
    const { shop } = await pendingShop();
    const admin = await createUser({ role: "ADMIN" });
    const reason = "Documents checked in person at the shop";

    const approved = await approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id), {
      waiveDocuments: { reason },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.lifecycleStatus).toBe("ACTIVE");

    const [waiver] = await db.select().from(shopDocumentWaivers).where(eq(shopDocumentWaivers.shopId, shop.id));
    expect(waiver).toMatchObject({ reason, waivedBy: admin.id, missingDocTypes: ["PAN", "GSTIN", "SHOP_ACT"] });

    const moves = await db
      .select({ from: statusChanges.fromStatus, to: statusChanges.toStatus })
      .from(statusChanges)
      .where(eq(statusChanges.entityId, shop.id));
    // Both moves happen in one transaction (same timestamp), so no order is asserted.
    expect(moves).toEqual(
      expect.arrayContaining([
        { from: "KYC_PENDING", to: "VERIFIED" },
        { from: "VERIFIED", to: "ACTIVE" },
      ]),
    );
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.approved_without_documents")));
    expect(audit).toHaveLength(1);
  });

  it("is refused to an operator, and changes nothing", async () => {
    const { shop } = await pendingShop();
    const operator = await createUser({ role: "OPERATOR" });
    await expect(
      approveShop(shop.id, { classification: "GREEN" }, OPERATOR(operator.id), {
        waiveDocuments: { reason: "Operator should not be able to do this" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(shopDocumentWaivers)).toHaveLength(0);
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.lifecycleStatus).toBe("KYC_PENDING");
  });

  it("still requires the registration fee, and leaves no waiver behind", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 500_000 });
    await expect(
      approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id), {
        waiveDocuments: { reason: "Documents checked in person at the shop" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { feePaymentStatus: "PENDING" } });
    expect(await db.select().from(shopDocumentWaivers)).toHaveLength(0);
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.status).toBe("PENDING_APPROVAL");
    expect(after.lifecycleStatus).toBe("KYC_PENDING");
  });

  it("does not loosen the normal Approve for a shop without documents", async () => {
    const { shop } = await pendingShop();
    const admin = await createUser({ role: "ADMIN" });
    await expect(approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { lifecycleStatus: "KYC_PENDING" },
    });
  });
});

describe("waive the registration fee from the queue", () => {
  async function unpaidShop() {
    const owner = await createUser({ role: "SHOP_OWNER" });
    return createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 10_000 });
  }

  it("lets an admin waive it with a reason; the shop then reads as settled and can be approved", async () => {
    const shop = await unpaidShop();
    const admin = await createUser({ role: "ADMIN" });
    const result = await waiveRegistrationFee(shop.id, "Launch offer agreed with the owner", ADMIN(admin.id));
    expect(result.feePaymentStatus).toBe("PAID");
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.registrationFeePaise).toBe(0);
    expect(after.feePaymentStatus).toBe("PAID");
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.registration_fee_waived")));
    expect(audit).toHaveLength(1);

    const approved = await approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id), {
      waiveDocuments: { reason: "Documents checked in person at the shop" },
    });
    expect(approved.lifecycleStatus).toBe("ACTIVE");
  });

  it("is refused to an operator", async () => {
    const shop = await unpaidShop();
    const operator = await createUser({ role: "OPERATOR" });
    await expect(waiveRegistrationFee(shop.id, "Operator should not waive", OPERATOR(operator.id))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("is refused once part of the fee is paid, and for a settled fee", async () => {
    const shop = await unpaidShop();
    const admin = await createUser({ role: "ADMIN" });
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 4_000 }, ADMIN(admin.id));
    await expect(waiveRegistrationFee(shop.id, "Launch offer agreed with the owner", ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/already paid/),
    });
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 6_000 }, ADMIN(admin.id));
    await expect(waiveRegistrationFee(shop.id, "Launch offer agreed with the owner", ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/already settled/),
    });
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.registrationFeePaise).toBe(10_000);
  });
});
