/**
 * Event layer — disputes: opening gives the customer a case number at once and
 * tells the shop and support; the shop and support can comment and move the
 * case, each update notifying the other parties; a case left unanswered past
 * the SLA is escalated to an administrator by the hourly check.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { disputeAttachments, disputeComments, notifications, orderDisputes } from "@/server/db/schema";
import { saveImage } from "@/server/services/image-store";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { addToCart } from "@/server/services/cart";
import {
  addDisputeComment,
  advanceDispute,
  canViewDisputeImage,
  getDispute,
  openDispute,
  runDisputeEscalationSweep,
} from "@/server/services/disputes";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

const notesFor = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

/** A minimal PNG header — enough for the image store's type and size checks. */
function fakePng(): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(800, 16);
  buf.writeUInt32BE(600, 20);
  return buf;
}

async function deliveredOrder() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const operator = await createUser({ role: "OPERATOR" });
  const admin = await createUser({ role: "ADMIN" });
  const stranger = await createUser({ role: "CUSTOMER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Shree Dairy", latitude: 0, longitude: 0 });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  const order = created[0];
  const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
  for (const status of ["PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
    await updateOrderStatus(order.id, status, shopActor);
  }
  return {
    order,
    customer: { id: customer.id, role: "CUSTOMER" as const },
    shop: shopActor,
    operator: { id: operator.id, role: "OPERATOR" as const },
    admin: { id: admin.id, role: "ADMIN" as const },
    stranger: { id: stranger.id, role: "CUSTOMER" as const },
  };
}

const OPEN = { reason: "ITEM_DAMAGED" as const, description: "The milk carton arrived split and leaking.", disputedAmountPaise: 7000 };

describe("opening", () => {
  it("creates the ticket with its photos and tells the customer the number, the shop and support at once", async () => {
    const s = await deliveredOrder();
    const photo = await saveImage(fakePng(), { purpose: "DISPUTE_EVIDENCE", ownerId: s.customer.id });
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN, imageIds: [photo.id] }, s.customer);

    expect(dispute.awaitingResponseSince).not.toBeNull();
    expect(await db.select().from(disputeAttachments).where(eq(disputeAttachments.disputeId, dispute.id))).toHaveLength(1);

    const [buyerNote] = await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_OPENED);
    expect(buyerNote.body).toContain(dispute.caseNumber);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.SHOP_DISPUTE_OPENED)).toHaveLength(1);
    expect(await notesFor(s.operator.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_OPENED)).toHaveLength(1);
    expect(await notesFor(s.admin.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_OPENED)).toHaveLength(1);

    // The photo is the case's: its customer, shop and support may see it; nobody else.
    expect(await canViewDisputeImage(photo.id, photo.ownerId, s.shop)).toBe(true);
    expect(await canViewDisputeImage(photo.id, photo.ownerId, s.operator)).toBe(true);
    expect(await canViewDisputeImage(photo.id, photo.ownerId, s.stranger)).toBe(false);
  });

  it("refuses someone else's photo", async () => {
    const s = await deliveredOrder();
    const photo = await saveImage(fakePng(), { purpose: "DISPUTE_EVIDENCE", ownerId: s.stranger.id });
    await expect(openDispute({ orderId: s.order.id, ...OPEN, imageIds: [photo.id] }, s.customer)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("the conversation", () => {
  it("each reply notifies the other parties; a shop reply stops the response clock, a customer message restarts it", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);

    await addDisputeComment(dispute.id, { body: "We packed it carefully — sending a photo of the packing.", clientRequestId: "shop-reply-1" }, s.shop);
    expect(await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(1);
    expect(await notesFor(s.operator.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(1);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(0);
    let [row] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(row.awaitingResponseSince).toBeNull();
    expect(row.lastResponseAt).not.toBeNull();

    await addDisputeComment(dispute.id, { body: "It was leaking at the door.", clientRequestId: "buyer-reply-1" }, s.customer);
    [row] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(row.awaitingResponseSince).not.toBeNull();
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(1);
  });

  it("a double-tapped Send posts and notifies once", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    const input = { body: "Any update?", clientRequestId: "same-tap-123" };
    const first = await addDisputeComment(dispute.id, input, s.customer);
    const second = await addDisputeComment(dispute.id, input, s.customer);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(disputeComments).where(eq(disputeComments.disputeId, dispute.id))).toHaveLength(1);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(1);
  });

  it("an internal note reaches support only and is hidden from the customer and the shop", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    await addDisputeComment(dispute.id, { body: "Third complaint this month.", internal: true, clientRequestId: "note-1" }, s.operator);

    expect(await notesFor(s.admin.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(1);
    expect(await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(0);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_COMMENT)).toHaveLength(0);
    expect((await getDispute(dispute.id, s.customer))!.comments).toHaveLength(0);
    expect((await getDispute(dispute.id, s.shop))!.comments).toHaveLength(0);
    expect((await getDispute(dispute.id, s.operator))!.comments).toHaveLength(1);

    await expect(
      addDisputeComment(dispute.id, { body: "psst", internal: true, clientRequestId: "note-2" }, s.shop),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("someone not on the case can neither read nor write it", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    await expect(getDispute(dispute.id, s.stranger)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addDisputeComment(dispute.id, { body: "hello", clientRequestId: "x-1234567" }, s.stranger)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("status updates", () => {
  it("once triaged, the shop may propose a resolution — the customer is told — but nothing else", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    // The approved lifecycle: support triages before anyone proposes.
    await expect(
      advanceDispute(dispute.id, { to: "RESOLUTION_PROPOSED", proposal: "Replacement" }, s.shop),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await advanceDispute(dispute.id, { to: "TRIAGED" }, s.operator);
    await advanceDispute(dispute.id, { to: "RESOLUTION_PROPOSED", proposal: "A free replacement tomorrow." }, s.shop);

    const [note] = await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_RESOLUTION_PROPOSED);
    expect(note.body).toContain("free replacement");
    expect(await notesFor(s.admin.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_UPDATED)).toHaveLength(2);
    await expect(advanceDispute(dispute.id, { to: "REJECTED", note: "no" }, s.shop)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("support moving the case notifies the customer and the shop", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    await advanceDispute(dispute.id, { to: "TRIAGED" }, s.operator);
    expect(await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_UPDATED)).toHaveLength(1);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_UPDATED)).toHaveLength(1);
    // The operator who moved it is not told; the other staff are.
    expect(await notesFor(s.operator.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_UPDATED)).toHaveLength(0);
    expect(await notesFor(s.admin.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_UPDATED)).toHaveLength(1);
  });
});

describe("response SLA (hourly check)", () => {
  it("escalates a case nobody answered within 24 h to the administrators, once", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    const later = new Date(Date.now() + 25 * 3_600_000);

    expect(await runDisputeEscalationSweep(later)).toMatchObject({ escalated: 1 });
    expect(await runDisputeEscalationSweep(later)).toMatchObject({ escalated: 0 });

    const [row] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(row).toMatchObject({ status: "ESCALATED", level: "L2", escalationTrigger: "SLA" });
    expect(await notesFor(s.admin.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_ESCALATED)).toHaveLength(1);
    expect(await notesFor(s.operator.id, NOTIFICATION_TYPES.SUPPORT_DISPUTE_ESCALATED)).toHaveLength(0);
    expect(await notesFor(s.customer.id, NOTIFICATION_TYPES.DISPUTE_UPDATED)).toHaveLength(1);
    expect(await notesFor(s.shop.id, NOTIFICATION_TYPES.DISPUTE_UPDATED)).toHaveLength(1);
  });

  it("a case the shop answered is not escalated for the SLA", async () => {
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN }, s.customer);
    await addDisputeComment(dispute.id, { body: "Looking into it now.", clientRequestId: "shop-1-abcdef" }, s.shop);
    // 25 h on: answered, and younger than the 48 h age limit.
    expect(await runDisputeEscalationSweep(new Date(Date.now() + 25 * 3_600_000))).toMatchObject({ escalated: 0 });
  });
});
