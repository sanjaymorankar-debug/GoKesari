/**
 * Owner decision, 29 Oct 2026 (docs/shop-documents-2026-10):
 *
 *   - a shop whose owner promised the missing documents is never approved automatically; an
 *     admin or operator approves it after inspecting it ("Approve on promise")
 *   - live shops missing documents are reminded on the 1st and 15th (India time), reminder N of 3,
 *     e-mailed even when the owner switched shop e-mails off; at the run after the 3rd the shop is
 *     suspended automatically and the owner is e-mailed why
 *   - a promise is kept until its date; documents waiting for our check are not chased; a shop
 *     whose documents are complete starts a fresh count; the rule switches it all off
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  auditLogs,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  sellerVerifications,
  shopDocumentReminders,
  shopDocumentWaivers,
  shops,
} from "@/server/db/schema";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { promiseShopDocuments } from "@/server/services/shop-document-gate";
import { nextFollowUpDay, runShopDocumentFollowUp, shopsMissingDocuments } from "@/server/services/shop-document-follow-up";
import { approveShop, autoApproveShopIfReady } from "@/server/services/shops";
import { upsertRow } from "@/server/db/split/upsert";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
let operator: { id: string; role: "OPERATOR" };

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  operator = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" };
});

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];
const remindersOf = async (shopId: string) => db.select().from(shopDocumentReminders).where(eq(shopDocumentReminders.shopId, shopId));
const noticesOf = async (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
const emailsOf = async (userId: string, type: string) =>
  db
    .select()
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.type, type), eq(notificationDeliveries.channel, "EMAIL")));

async function setStatus(shopId: string, docType: "PAN" | "GSTIN" | "SHOP_ACT" | "FSSAI", status: "MANUAL_REVIEW" | "FAILED") {
  await upsertRow(db, sellerVerifications, {
    keys: [sellerVerifications.shopId, sellerVerifications.docType],
    values: { shopId, docType, status },
    set: { status },
  });
}

/** A live general shop with only its PAN verified: GSTIN and Shop Act are missing. */
async function liveShopMissingDocuments(options: { optOut?: boolean } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Kirana ${owner.id.slice(0, 6)}`, shopType: "GENERAL_TRADING", status: "APPROVED" });
  await verifySellerDocuments(shop.id, ["PAN"]);
  if (options.optOut) {
    // The owner switched shop e-mails off: the follow-up and the suspension still reach them.
    await db.insert(notificationPreferences).values({ userId: owner.id, category: "SHOP", channel: "EMAIL", enabled: false });
  }
  return { owner, shop };
}

describe("a promised shop waits for an admin or operator", () => {
  async function promisedPendingShop() {
    const owner = await createUser({ role: "SHOP_OWNER" });
    // Fee settled (none due), PAN verified, the rest promised.
    const shop = await createShop(owner.id, { shopType: "GENERAL_TRADING", status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id, ["PAN"]);
    const gate = await promiseShopDocuments(shop.id, { id: owner.id, role: "SHOP_OWNER" });
    expect(gate.missing.sort()).toEqual(["GSTIN", "SHOP_ACT"]);
    return { owner, shop };
  }

  it("is not approved automatically, and a plain approval is refused", async () => {
    const { shop } = await promisedPendingShop();
    await setRule("sellerVerification", { autoApproveShop: true }, admin);
    expect(await autoApproveShopIfReady(shop.id)).toBe(false);
    await expect(approveShop(shop.id, { classification: "GREEN" }, operator)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await shopRow(shop.id)).status).toBe("PENDING_APPROVAL");
  });

  it("an operator approves it on the promise; the waiver names the documents and the due date", async () => {
    const { shop } = await promisedPendingShop();
    const approved = await approveShop(shop.id, { classification: "GREEN" }, operator, { acceptDocumentsPromise: true });
    expect(approved.status).toBe("APPROVED");
    const [waiver] = await db.select().from(shopDocumentWaivers).where(eq(shopDocumentWaivers.shopId, shop.id));
    expect(waiver).toMatchObject({ waivedBy: operator.id });
    expect(waiver.missingDocTypes.sort()).toEqual(["GSTIN", "SHOP_ACT"]);
    expect(waiver.reason).toMatch(/^Owner promised the documents by \d{1,2} [A-Z][a-z]{2} \d{4}/);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.approved_without_documents")));
    expect(audit.newValue).toMatchObject({ documentsPromise: true });
  });

  it("an admin may too; a shop without a promise, or a customer, is refused", async () => {
    const { shop } = await promisedPendingShop();
    const customer = await createUser({ role: "CUSTOMER" });
    await expect(
      approveShop(shop.id, { classification: "GREEN" }, { id: customer.id, role: "CUSTOMER" }, { acceptDocumentsPromise: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await approveShop(shop.id, { classification: "KESARI" }, admin, { acceptDocumentsPromise: true })).status).toBe("APPROVED");

    const other = await createUser({ role: "SHOP_OWNER" });
    const unpromised = await createShop(other.id, { shopType: "GENERAL_TRADING", status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, unpromised.id));
    await expect(approveShop(unpromised.id, { classification: "GREEN" }, operator, { acceptDocumentsPromise: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("the 1st / 15th follow-up", () => {
  it("does nothing on another day, or with the rule off", async () => {
    const { shop } = await liveShopMissingDocuments();
    expect(await runShopDocumentFollowUp("2026-11-02")).toMatchObject({ acting: false, reminded: 0 });
    await setRule("shopDocumentFollowUp", { enabled: false }, admin);
    expect(await runShopDocumentFollowUp("2026-11-01")).toMatchObject({ acting: false });
    expect(await remindersOf(shop.id)).toHaveLength(0);
  });

  it("reminds three times, e-mails despite the opt-out, then suspends at the next run and e-mails why", async () => {
    const { owner, shop } = await liveShopMissingDocuments({ optOut: true });

    expect(await runShopDocumentFollowUp("2026-11-01")).toMatchObject({ acting: true, checked: 1, reminded: 1 });
    // A second run the same day sends nothing more.
    expect(await runShopDocumentFollowUp("2026-11-01")).toMatchObject({ reminded: 0 });
    let notes = await noticesOf(owner.id, "shop.documents_follow_up");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Submit your shop documents — reminder 1 of 3");
    expect(notes[0].body).toMatch(/still missing: GST number \(GSTIN\), Shop Act/);
    expect(notes[0].body).toMatch(/after reminder 3, your shop will be suspended automatically/);
    expect(await emailsOf(owner.id, "shop.documents_follow_up")).toHaveLength(1);

    await runShopDocumentFollowUp("2026-11-15");
    await runShopDocumentFollowUp("2026-12-01");
    notes = await noticesOf(owner.id, "shop.documents_follow_up");
    expect(notes.map((n) => n.title).sort()).toEqual([1, 2, 3].map((n) => `Submit your shop documents — reminder ${n} of 3`));
    const last = notes.find((n) => n.title.endsWith("3 of 3"))!;
    expect(last.body).toMatch(/This is the last reminder: if they are still missing on 15 Dec 2026/);
    expect((await remindersOf(shop.id)).map((r) => r.reminderNo).sort()).toEqual([1, 2, 3]);
    expect((await shopRow(shop.id)).status).toBe("APPROVED");

    expect(await runShopDocumentFollowUp("2026-12-15")).toMatchObject({ suspended: 1, reminded: 0 });
    expect((await shopRow(shop.id)).status).toBe("SUSPENDED");
    const [suspended] = await noticesOf(owner.id, "shop.suspended");
    expect(suspended.body).toMatch(/Shop documents not submitted after 3 reminders: GST number \(GSTIN\), Shop Act/);
    expect(await emailsOf(owner.id, "shop.suspended")).toHaveLength(1);
    // A reinstated shop starts a fresh count.
    expect(await remindersOf(shop.id)).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, "shop.documents_follow_up")));
    expect(audits.map((a) => (a.newValue as { outcome: string }).outcome).sort()).toEqual(["REMINDED", "REMINDED", "REMINDED", "SUSPENDED"]);
  });

  it("a promise is kept until its date, whatever the reminders say", async () => {
    const { shop } = await liveShopMissingDocuments();
    await db.update(shops).set({ documentsPromisedAt: new Date("2026-11-20T00:00:00Z"), documentsDueAt: new Date("2026-12-20T00:00:00Z") }).where(eq(shops.id, shop.id));
    for (const day of ["2026-11-01", "2026-11-15", "2026-12-01"]) await runShopDocumentFollowUp(day, new Date(`${day}T00:30:00Z`));
    expect(await runShopDocumentFollowUp("2026-12-15", new Date("2026-12-15T00:30:00Z"))).toMatchObject({ waiting: 1, suspended: 0 });
    expect((await shopRow(shop.id)).status).toBe("APPROVED");
    expect(await runShopDocumentFollowUp("2027-01-01", new Date("2027-01-01T00:30:00Z"))).toMatchObject({ suspended: 1 });
  });

  it("documents waiting for our check are not chased; complete documents clear the count", async () => {
    const { owner, shop } = await liveShopMissingDocuments();
    await runShopDocumentFollowUp("2026-11-01");
    expect(await remindersOf(shop.id)).toHaveLength(1);

    // The owner sends both; they wait for the team: nothing to chase, the count starts again.
    await setStatus(shop.id, "GSTIN", "MANUAL_REVIEW");
    await setStatus(shop.id, "SHOP_ACT", "MANUAL_REVIEW");
    const [listed] = (await shopsMissingDocuments()).filter((r) => r.shop.id === shop.id);
    expect(listed).toMatchObject({ missing: [], remindersSent: 1 });
    expect(listed.withTeam.sort()).toEqual(["GSTIN", "SHOP_ACT"]);
    expect(await runShopDocumentFollowUp("2026-11-15")).toMatchObject({ checked: 0, reminded: 0, cleared: 1 });
    expect(await remindersOf(shop.id)).toHaveLength(0);
    expect(await noticesOf(owner.id, "shop.documents_follow_up")).toHaveLength(1);

    // A check that fails puts it back on the owner: reminder 1 again.
    await setStatus(shop.id, "SHOP_ACT", "FAILED");
    await runShopDocumentFollowUp("2026-12-01");
    expect((await remindersOf(shop.id)).map((r) => r.reminderNo)).toEqual([1]);

    await verifySellerDocuments(shop.id, ["GSTIN", "SHOP_ACT"]);
    expect((await shopsMissingDocuments()).some((r) => r.shop.id === shop.id)).toBe(false);
    await runShopDocumentFollowUp("2026-12-15");
    expect(await remindersOf(shop.id)).toHaveLength(0);
    expect((await shopRow(shop.id)).status).toBe("APPROVED");
  });

  it("a food shop is chased for FSSAI too; a pending or closed shop is not chased", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const dairy = await createShop(owner.id, { name: "Dairy Follow", shopType: "DAIRY", status: "APPROVED" });
    await verifySellerDocuments(dairy.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    const pending = await createShop(owner.id, { name: "Pending Follow", shopType: "GENERAL_TRADING", status: "PENDING_APPROVAL" });
    const closed = await createShop(owner.id, { name: "Closed Follow", shopType: "GENERAL_TRADING", status: "APPROVED" });
    await db.update(shops).set({ deletedAt: new Date() }).where(eq(shops.id, closed.id));

    expect(await runShopDocumentFollowUp("2026-11-01")).toMatchObject({ checked: 1, reminded: 1 });
    const [rem] = await remindersOf(dairy.id);
    expect(rem.missingDocTypes).toEqual(["FSSAI"]);
    expect(await remindersOf(pending.id)).toHaveLength(0);
    expect(await remindersOf(closed.id)).toHaveLength(0);
  });

  it("the next reminder day: the 15th after the 1st, the 1st of the next month after the 15th", () => {
    expect(nextFollowUpDay("2026-11-01", [1, 15])).toBe("2026-11-15");
    expect(nextFollowUpDay("2026-11-15", [1, 15])).toBe("2026-12-01");
    expect(nextFollowUpDay("2026-12-20", [1, 15])).toBe("2027-01-01");
  });
});
