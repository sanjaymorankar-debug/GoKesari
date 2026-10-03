/**
 * Dispute cases (GS-058) — the lifecycle, escalation and the money.
 *
 * Runs against the real database and the real services, because the claims
 * worth pinning are all about things a mock cannot show: the state machine
 * refusing an illegal move, two reviewers racing on one order, an escalated
 * case being out of an operator's reach, and a resolution's refund landing in
 * the wallet and the ledger via the existing finance path rather than from
 * here.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { disputeEvents, financialAdjustments, orderDisputes, orders, wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  advanceDispute,
  countDisputes,
  escalateDispute,
  getDispute,
  listDisputes,
  openDispute,
  resolveDispute,
  runDisputeEscalationSweep,
} from "@/server/services/disputes";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

const GOODS = 7000;
const FEE = 1000;
const TOTAL = GOODS + FEE;

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;

/** A delivered, wallet-paid ₹80 order — the only kind that can be disputed. */
async function deliveredOrder() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { deliveryFeePaise: FEE, latitude: 0, longitude: 0 });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: GOODS, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: null,
  });
  const order = created[0];
  const ownerActor = { id: owner.id, role: "SHOP_OWNER" as const };
  await updateOrderStatus(order.id, "PREPARING", ownerActor);
  await updateOrderStatus(order.id, "READY", ownerActor);
  await updateOrderStatus(order.id, "OUT_FOR_DELIVERY", ownerActor);
  await updateOrderStatus(order.id, "DELIVERED", ownerActor);
  return { order, customer: { id: customer.id, role: "CUSTOMER" as const }, shopId: shop.id };
}

const OPEN_INPUT = {
  reason: "ITEM_DAMAGED" as const,
  description: "The milk carton arrived split and leaking.",
  disputedAmountPaise: GOODS,
};

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

describe("opening a dispute", () => {
  it("opens at L1 on a delivered order and records the payment under dispute", async () => {
    const { order, customer } = await deliveredOrder();

    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    expect(dispute.caseNumber).toMatch(/^DSP-\d{6}$/);
    expect(dispute.status).toBe("OPEN");
    expect(dispute.level).toBe("L1");
    // The payment is snapshotted, not joined: what the case was about must not
    // change when the order's own payment fields later do.
    expect(dispute.paymentMethodSnapshot).toBe("WALLET");
    expect(dispute.orderTotalPaise).toBe(TOTAL);
    expect(dispute.orderPaidAt).not.toBeNull();

    const [event] = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, dispute.id));
    expect(event).toMatchObject({ fromStatus: null, toStatus: "OPEN", toLevel: "L1", actorId: customer.id });
  });

  it("refuses an order that has not been delivered", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const shop = await createShop(owner.id, { deliveryFeePaise: FEE });
    const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: GOODS, onlineStock: 50 });
    await addToCart(customer.id, sp.id, 1);
    const { orders: created } = await checkout({ userId: customer.id, requestId: "r1", addressId: null });

    await expect(
      openDispute({ orderId: created[0].id, ...OPEN_INPUT }, { id: customer.id, role: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses somebody else's order, and refuses more than the order total", async () => {
    const { order, customer } = await deliveredOrder();
    const stranger = await createUser();

    await expect(
      openDispute({ orderId: order.id, ...OPEN_INPUT }, { id: stranger.id, role: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      openDispute({ orderId: order.id, ...OPEN_INPUT, disputedAmountPaise: TOTAL + 1 }, customer),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a second live case on the same order", async () => {
    const { order, customer } = await deliveredOrder();
    const first = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    await expect(openDispute({ orderId: order.id, ...OPEN_INPUT }, customer)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(first.caseNumber),
    });
  });

  it("allows a new case once the previous one is closed", async () => {
    const { order, customer } = await deliveredOrder();
    const operator = await createUser({ role: "OPERATOR" });
    const first = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await advanceDispute(first.id, { to: "REJECTED", note: "Not supported by the photos." }, OPERATOR(operator.id));

    const second = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("OPEN");
  });
});

describe("escalation", () => {
  it("opens straight at L2 when the amount is at or above the review limit", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 48, escalateAbovePaise: GOODS, resolveTargetHours: 120 }, ADMIN(admin.id));
    const { order, customer } = await deliveredOrder();

    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    expect(dispute.status).toBe("ESCALATED");
    expect(dispute.level).toBe("L2");
    expect(dispute.escalationTrigger).toBe("AMOUNT");
    expect(dispute.escalatedAt).not.toBeNull();
  });

  it("stays at L1 below the limit, and the amount trigger is off at zero", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 48, escalateAbovePaise: 0, resolveTargetHours: 120 }, ADMIN(admin.id));
    const { order, customer } = await deliveredOrder();

    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    expect(dispute.level).toBe("L1");
    expect(dispute.escalationTrigger).toBeNull();
  });

  it("escalates a case older than the age limit, with no actor on the event", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 24, escalateAbovePaise: 0, resolveTargetHours: 120 }, ADMIN(admin.id));
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    // Age it past the limit.
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await db.update(orderDisputes).set({ createdAt: old }).where(eq(orderDisputes.id, dispute.id));

    const result = await runDisputeEscalationSweep();
    expect(result).toMatchObject({ considered: 1, escalated: 1, failed: 0 });

    const [after] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(after.status).toBe("ESCALATED");
    expect(after.level).toBe("L2");
    expect(after.escalationTrigger).toBe("AGE");

    // An automatic escalation had no decider, and the trail says so rather
    // than attributing it to whoever happened to trigger the cron.
    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, dispute.id));
    const escalation = events.find((e) => e.toStatus === "ESCALATED")!;
    expect(escalation.actorId).toBeNull();
    expect(escalation.actorRole).toBeNull();
  });

  it("is a no-op on a second run, and leaves young cases alone", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 24, escalateAbovePaise: 0, resolveTargetHours: 120 }, ADMIN(admin.id));
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    // Young: untouched.
    expect(await runDisputeEscalationSweep()).toMatchObject({ considered: 0, escalated: 0 });

    await db
      .update(orderDisputes)
      .set({ createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) })
      .where(eq(orderDisputes.id, dispute.id));
    expect((await runDisputeEscalationSweep()).escalated).toBe(1);
    // Already L2, so the second sweep does not select it at all.
    expect(await runDisputeEscalationSweep()).toMatchObject({ considered: 0, escalated: 0 });
  });

  it("does nothing at all when the age trigger is switched off", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 0, escalateAbovePaise: 0, resolveTargetHours: 120 }, ADMIN(admin.id));
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await db
      .update(orderDisputes)
      .set({ createdAt: new Date(Date.now() - 1000 * 60 * 60 * 1000) })
      .where(eq(orderDisputes.id, dispute.id));

    expect(await runDisputeEscalationSweep()).toMatchObject({ considered: 0, escalated: 0 });
    const [after] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(after.level).toBe("L1");
  });

  it("puts an escalated case out of an operator's reach", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await escalateDispute(dispute.id, { trigger: "MANUAL", note: "Customer is a repeat complainant." }, OPERATOR(operator.id));

    await expect(
      advanceDispute(dispute.id, { to: "INVESTIGATING" }, OPERATOR(operator.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The administrator can.
    const moved = await advanceDispute(dispute.id, { to: "INVESTIGATING" }, ADMIN(admin.id));
    expect(moved.status).toBe("INVESTIGATING");
    expect(moved.level).toBe("L2");
  });

  it("refuses to escalate twice", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await escalateDispute(dispute.id, { trigger: "MANUAL", note: "Needs a second look." }, OPERATOR(operator.id));

    await expect(
      escalateDispute(dispute.id, { trigger: "MANUAL", note: "Again." }, OPERATOR(operator.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("working the lifecycle", () => {
  it("walks open → triaged → investigating → proposed, appending an event each time", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    await advanceDispute(dispute.id, { to: "TRIAGED" }, OPERATOR(operator.id));
    await advanceDispute(dispute.id, { to: "INVESTIGATING" }, OPERATOR(operator.id));
    const proposed = await advanceDispute(
      dispute.id,
      { to: "RESOLUTION_PROPOSED", proposal: "Refund the carton in full." },
      OPERATOR(operator.id),
    );
    expect(proposed.status).toBe("RESOLUTION_PROPOSED");

    const events = await db
      .select()
      .from(disputeEvents)
      .where(eq(disputeEvents.disputeId, dispute.id))
      .orderBy(disputeEvents.createdAt);
    expect(events.map((e) => e.toStatus)).toEqual(["OPEN", "TRIAGED", "INVESTIGATING", "RESOLUTION_PROPOSED"]);
    expect(events.at(-1)!.note).toContain("Refund the carton");
  });

  it("refuses a move the table does not allow", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    // OPEN cannot jump to a proposal: triage comes first.
    await expect(
      advanceDispute(dispute.id, { to: "RESOLUTION_PROPOSED", proposal: "x" }, OPERATOR(operator.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("will not reach RESOLVED or ESCALATED through advance", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    await expect(advanceDispute(dispute.id, { to: "RESOLVED" }, OPERATOR(operator.id))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(advanceDispute(dispute.id, { to: "ESCALATED" }, OPERATOR(operator.id))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("requires a proposal when proposing, and refuses work on a closed case", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const { order, customer } = await deliveredOrder();
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await advanceDispute(dispute.id, { to: "TRIAGED" }, OPERATOR(operator.id));

    await expect(
      advanceDispute(dispute.id, { to: "RESOLUTION_PROPOSED" }, OPERATOR(operator.id)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await advanceDispute(dispute.id, { to: "WITHDRAWN", note: "Customer is happy after all." }, OPERATOR(operator.id));
    await expect(
      advanceDispute(dispute.id, { to: "INVESTIGATING" }, OPERATOR(operator.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("resolving with money", () => {
  async function toProposed() {
    const operator = await createUser({ role: "OPERATOR" });
    const s = await deliveredOrder();
    const dispute = await openDispute({ orderId: s.order.id, ...OPEN_INPUT }, s.customer);
    await advanceDispute(dispute.id, { to: "TRIAGED" }, OPERATOR(operator.id));
    await advanceDispute(
      dispute.id,
      { to: "RESOLUTION_PROPOSED", proposal: "Full refund of the goods." },
      OPERATOR(operator.id),
    );
    return { ...s, dispute, operator: OPERATOR(operator.id) };
  }

  it("refunds through the finance path and records the adjustment", async () => {
    const { dispute, customer, operator } = await toProposed();
    const before = await balanceOf(customer.id);

    const resolved = await resolveDispute(
      dispute.id,
      { outcome: "REFUND_FULL", notes: "Carton was damaged in transit.", refundPaise: GOODS, chargeTo: "SHOP", requestId: "req-abcdefgh" },
      operator,
    );

    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.outcome).toBe("REFUND_FULL");
    expect(resolved.refundedPaise).toBe(GOODS);
    expect(resolved.refundAdjustmentId).not.toBeNull();

    // The money moved through finance, not from the dispute service: the
    // wallet rose and a financial adjustment exists for it.
    expect(await balanceOf(customer.id)).toBe(before + GOODS);
    const [adjustment] = await db
      .select()
      .from(financialAdjustments)
      .where(eq(financialAdjustments.id, resolved.refundAdjustmentId!));
    expect(adjustment).toBeTruthy();
  });

  it("closes without moving money when the outcome is no refund", async () => {
    const { dispute, customer, operator } = await toProposed();
    const before = await balanceOf(customer.id);

    const resolved = await resolveDispute(
      dispute.id,
      { outcome: "NO_REFUND", notes: "Photos show an intact carton.", requestId: "req-ijklmnop" },
      operator,
    );

    expect(resolved.outcome).toBe("NO_REFUND");
    expect(resolved.refundedPaise).toBeNull();
    expect(resolved.refundAdjustmentId).toBeNull();
    expect(await balanceOf(customer.id)).toBe(before);
  });

  it("refuses a refund above the disputed amount, and a full refund that is not the whole amount", async () => {
    const { dispute, operator } = await toProposed();

    await expect(
      resolveDispute(
        dispute.id,
        { outcome: "REFUND_PARTIAL", notes: "Too much.", refundPaise: GOODS + 1, requestId: "req-qrstuvwx" },
        operator,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(
      resolveDispute(
        dispute.id,
        { outcome: "REFUND_FULL", notes: "Half is not full.", refundPaise: GOODS / 2, requestId: "req-yzabcdef" },
        operator,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a refund amount on an outcome that does not refund, and a refund outcome with no amount", async () => {
    const { dispute, operator } = await toProposed();

    await expect(
      resolveDispute(
        dispute.id,
        { outcome: "NO_REFUND", notes: "Contradictory.", refundPaise: 100, requestId: "req-ghijklmn" },
        operator,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(
      resolveDispute(dispute.id, { outcome: "REFUND_PARTIAL", notes: "No amount.", requestId: "req-opqrstuv" }, operator),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("leaves the order's own status alone — the two are separate facts", async () => {
    const { dispute, order, operator } = await toProposed();
    await resolveDispute(
      dispute.id,
      { outcome: "NO_REFUND", notes: "Closed after review.", requestId: "req-wxyzabcd" },
      operator,
    );

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("DELIVERED");
  });
});

describe("reading cases", () => {
  it("shows escalated cases first in the operations queue", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const a = await deliveredOrder();
    const b = await deliveredOrder();
    await openDispute({ orderId: a.order.id, ...OPEN_INPUT }, a.customer);
    const second = await openDispute({ orderId: b.order.id, ...OPEN_INPUT }, b.customer);
    await escalateDispute(second.id, { trigger: "MANUAL", note: "Second line, please." }, OPERATOR(operator.id));

    const queue = await listDisputes({ liveOnly: true });
    expect(queue).toHaveLength(2);
    expect(queue[0].level).toBe("L2");
    expect(queue[0].caseNumber).toBe(second.caseNumber);
    expect(queue[0].orderNumber).toBeTruthy();
  });

  it("counts live, escalated and overdue cases", async () => {
    // This query is raw SQL with interpolated conditions, and an untested
    // version of it shipped a Date into a sql template that the driver could
    // not serialise — a 500 the build and typecheck both passed. Hence a test.
    const admin = await createUser({ role: "ADMIN" });
    await setRule("disputes", { escalateAfterHours: 48, escalateAbovePaise: 0, resolveTargetHours: 2 }, ADMIN(admin.id));

    expect(await countDisputes()).toEqual({ live: 0, escalated: 0, overdue: 0 });

    const a = await deliveredOrder();
    const b = await deliveredOrder();
    const c = await deliveredOrder();
    await openDispute({ orderId: a.order.id, ...OPEN_INPUT }, a.customer);
    const escalated = await openDispute({ orderId: b.order.id, ...OPEN_INPUT }, b.customer);
    const stale = await openDispute({ orderId: c.order.id, ...OPEN_INPUT }, c.customer);
    await escalateDispute(escalated.id, { trigger: "MANUAL", note: "Second line." }, ADMIN(admin.id));
    await escalateDispute(stale.id, { trigger: "MANUAL", note: "Second line." }, ADMIN(admin.id));

    expect(await countDisputes()).toEqual({ live: 3, escalated: 2, overdue: 0 });

    // Age one escalation past the 2 h resolve target.
    await db
      .update(orderDisputes)
      .set({ escalatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
      .where(eq(orderDisputes.id, stale.id));
    expect(await countDisputes()).toEqual({ live: 3, escalated: 2, overdue: 1 });

    // A closed case leaves every bucket.
    await advanceDispute(stale.id, { to: "REJECTED", note: "Closed." }, ADMIN(admin.id));
    expect(await countDisputes()).toEqual({ live: 2, escalated: 1, overdue: 0 });
  });

  it("lets the customer who raised it read the trail, and nobody else", async () => {
    const { order, customer } = await deliveredOrder();
    const stranger = await createUser();
    const operator = await createUser({ role: "OPERATOR" });
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);

    const own = await getDispute(dispute.id, customer);
    expect(own?.dispute.caseNumber).toBe(dispute.caseNumber);
    expect(own?.events).toHaveLength(1);

    expect((await getDispute(dispute.id, OPERATOR(operator.id)))?.orderNumber).toBeTruthy();
    await expect(getDispute(dispute.id, { id: stranger.id, role: "CUSTOMER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("withholds internal notes and reviewer identities from the customer", async () => {
    const { order, customer } = await deliveredOrder();
    const admin = await createUser({ role: "ADMIN" });
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    // The sort of thing staff actually write to each other, and the reason this
    // view is filtered rather than passed through.
    const internal = "Customer is a repeat complainant — check their history.";
    await escalateDispute(dispute.id, { trigger: "MANUAL", note: internal }, ADMIN(admin.id));
    await advanceDispute(
      dispute.id,
      { to: "INVESTIGATING", note: "Shop says the carton left intact." },
      ADMIN(admin.id),
    );

    const theirs = (await getDispute(dispute.id, customer))!;
    expect(theirs.internal).toBe(false);
    expect(theirs.dispute.escalationNote).toBeNull();
    expect(theirs.dispute.assignedToUserId).toBeNull();
    expect(theirs.dispute.resolvedBy).toBeNull();
    // Nothing anywhere in the payload repeats what staff wrote, and no event
    // names the reviewer.
    expect(JSON.stringify(theirs)).not.toContain("repeat complainant");
    expect(JSON.stringify(theirs)).not.toContain("left intact");
    expect(JSON.stringify(theirs)).not.toContain(admin.id);
    // They still see the case moving, which is the point of showing it at all.
    expect(theirs.events.map((e) => e.toStatus)).toEqual(["OPEN", "ESCALATED", "INVESTIGATING"]);

    // Staff lose nothing.
    const staffView = (await getDispute(dispute.id, ADMIN(admin.id)))!;
    expect(staffView.internal).toBe(true);
    expect(staffView.dispute.escalationNote).toBe(internal);
    expect(JSON.stringify(staffView)).toContain("left intact");
  });

  it("still gives the customer the resolution they were notified of", async () => {
    const { order, customer } = await deliveredOrder();
    const admin = await createUser({ role: "ADMIN" });
    const dispute = await openDispute({ orderId: order.id, ...OPEN_INPUT }, customer);
    await advanceDispute(dispute.id, { to: "TRIAGED" }, ADMIN(admin.id));
    await advanceDispute(
      dispute.id,
      { to: "RESOLUTION_PROPOSED", proposal: "We will refund the carton in full." },
      ADMIN(admin.id),
    );
    await resolveDispute(
      dispute.id,
      {
        outcome: "NO_REFUND",
        notes: "The shop re-delivered the carton the same evening.",
        requestId: "res-visible",
      },
      ADMIN(admin.id),
    );

    // resolutionNotes is the answer to their case — notifyRaiser sends them this
    // same text — so it must not be filtered out with the working notes.
    const theirs = (await getDispute(dispute.id, customer))!;
    expect(theirs.dispute.resolutionNotes).toBe("The shop re-delivered the carton the same evening.");
    expect(theirs.dispute.resolvedBy).toBeNull();
  });
});
