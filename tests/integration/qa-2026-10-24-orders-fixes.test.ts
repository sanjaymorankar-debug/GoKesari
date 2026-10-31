/**
 * Orders / riders / returns fixes from the automated QA run of 24 Oct 2026:
 *
 * TC-DEL-026 — a suspended rider could still accept the offer in hand; the
 *   offer now goes to another rider when the rider is suspended or
 *   deactivated, and an accept checks the rider may work.
 * TC-DSP-020 / TC-DSP-021 — reliability and fairness never changed the
 *   ranking (the subqueries counted the delivery row's own id).
 * TC-FLD-091 / 092 / 093, TC-DEL-030 — rider PAN, Aadhaar, bank and vehicle
 *   numbers are checked the same way at application and on edit.
 * TC-RET-003 / TC-FLD-094 — a per-piece line is returned in whole pieces.
 * TC-SPI-020 (N5) — an unopened unit that passes inspection goes back into stock.
 * TC-DEL-027 — approve only from REGISTERED / UNDER_REVIEW; reactivate needs a reason.
 * TC-DEL-015 — the rider is told of a reactivation and a deactivation.
 * TC-DSP-011 — cancelling an order ends its rider search.
 * TC-FLD-083 — the remove-line reason must be one the shop screen offers.
 * TC-FLD-101 — grievance phone checked; the lookup answers unknown and
 *   mismatched tickets the same way.
 * TC-SPI-004 (N11) — the order-confirmed e-mail lists the lines, fees and total.
 * TC-ADM-004 — Order Monitoring's date filter uses IST business days.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 90_000 });

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { PATCH as partnerPatch } from "@/app/api/delivery-partner/[id]/route";
import { POST as grievancePost } from "@/app/api/grievances/route";
import { GET as grievanceLookup } from "@/app/api/grievances/lookup/route";
import { POST as fulfilmentPost } from "@/app/api/orders/[id]/fulfilment/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  deliveryOrders,
  deliveryPartners,
  inventoryMovements,
  invStockLedger,
  notificationDeliveries,
  notifications,
  orderItems,
  orders,
  riderSearches,
  shopProducts,
} from "@/server/db/schema";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  dispatchReadyOrder,
  getRiderSearchStatus,
  runDispatchSweep,
} from "@/server/services/delivery-assignment";
import {
  approveDeliveryPartner,
  deactivateDeliveryPartner,
  reactivateDeliveryPartner,
  registerDeliveryPartner,
  rejectDeliveryPartner,
  suspendDeliveryPartner,
} from "@/server/services/delivery-partners";
import { lookupGrievance, submitGrievance } from "@/server/services/grievances";
import { cancelOrder, listOrdersForMonitoring } from "@/server/services/orders";
import { approveReturn, inspectReturn, receiveReturn, requestReturn } from "@/server/services/returns";
import { requestSensitiveChange, updateMyRiderProfile } from "@/server/services/rider-profile";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { call } from "../helpers/http";
import {
  addRiderIdentityDocument,
  createCategory,
  createDeliveryPartner,
  createOrder,
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
  resetRateLimits();
  state.session = null;
});

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111;
const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

function signInAs(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

/** An online, approved rider `km` north of the shop. */
async function rider(km: number) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, {
    status: "APPROVED",
    isOnline: true,
    latitude: kmNorth(km),
    longitude: SHOP.longitude,
    operatingRadiusKm: 10,
  });
  return { user, partner };
}

async function shopWithOwner() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: SHOP.latitude, longitude: SHOP.longitude });
  const customer = await createUser();
  return { owner, shop, customer };
}

async function readyOrder(shopId: string, customerId: string) {
  return createOrder(customerId, shopId, { status: "READY" });
}

/* ---------------------------------------------------------- TC-DEL-026 */

describe("TC-DEL-026: a suspended rider cannot take the offer in hand", () => {
  it("suspending withdraws the open offer and the order goes to the next rider; the suspended rider cannot accept it", async () => {
    const { shop, customer } = await shopWithOwner();
    const near = await rider(0.2);
    const far = await rider(1);
    const admin = await createUser({ role: "ADMIN" });
    const order = await readyOrder(shop.id, customer.id);

    const offer = await assignNearestPartner(order.id, { id: null, role: null });
    expect(offer.deliveryPartnerId).toBe(near.partner.id);

    await suspendDeliveryPartner(near.partner.id, "documents expired", ADMIN(admin.id));

    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(row).toMatchObject({ status: "OFFERED", deliveryPartnerId: far.partner.id });
    const [withdrawn] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, offer.id), eq(auditLogs.action, "delivery_order.cancelled")));
    expect(withdrawn?.previousValue).toMatchObject({ status: "OFFERED", deliveryPartnerId: near.partner.id });

    // The offer the suspended rider had is no longer theirs to accept.
    await expect(acceptDeliveryOffer(offer.id, near.user.id)).rejects.toMatchObject({ status: 403 });
    const accepted = await acceptDeliveryOffer(offer.id, far.user.id);
    expect(accepted.status).toBe("ACCEPTED");
    expect((await db.query.orders.findFirst({ where: eq(orders.id, order.id) }))?.status).toBe("ASSIGNED");
  });

  it("an accept is refused (409) for a rider whose suspension committed while the offer was still open", async () => {
    const { shop, customer } = await shopWithOwner();
    const only = await rider(0.2);
    const order = await readyOrder(shop.id, customer.id);
    const offer = await assignNearestPartner(order.id, { id: null, role: null });

    // The status change committed, the withdrawal has not run yet (or failed).
    await db.update(deliveryPartners).set({ status: "SUSPENDED", isOnline: false }).where(eq(deliveryPartners.id, only.partner.id));

    await expect(acceptDeliveryOffer(offer.id, only.user.id)).rejects.toMatchObject({ status: 409 });
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    expect(row.status).toBe("OFFERED");
    expect((await db.query.orders.findFirst({ where: eq(orders.id, order.id) }))?.status).toBe("READY");
  });

  it("with nobody else free the offer is cancelled (accept → 409); deactivating withdraws an offer too", async () => {
    const { shop, customer } = await shopWithOwner();
    const only = await rider(0.2);
    const ops = await createUser({ role: "OPERATOR" });
    signInAs(ops, "OPERATOR");

    const first = await readyOrder(shop.id, customer.id);
    const offer = await assignNearestPartner(first.id, { id: null, role: null });
    const suspend = await call(partnerPatch, `/api/delivery-partner/${only.partner.id}`, {
      method: "PATCH",
      params: { id: only.partner.id },
      body: { action: "suspend", reason: "QA suspension" },
    });
    expect(suspend.status).toBe(200);
    const [cancelled] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancellationReason: "The rider's account was suspended." });
    await expect(acceptDeliveryOffer(offer.id, only.user.id)).rejects.toMatchObject({ status: 409 });

    // Back to work (with a reason), a new offer, then the account is closed.
    expect(
      (
        await call(partnerPatch, `/api/delivery-partner/${only.partner.id}`, {
          method: "PATCH",
          params: { id: only.partner.id },
          body: { action: "reactivate", reason: "documents renewed" },
        })
      ).status,
    ).toBe(200);
    await db.update(deliveryPartners).set({ isOnline: true, availability: "READY" }).where(eq(deliveryPartners.id, only.partner.id));
    const second = await readyOrder(shop.id, customer.id);
    const offer2 = await assignNearestPartner(second.id, { id: null, role: null });
    await deactivateDeliveryPartner(only.partner.id, "left the platform", { id: ops.id, role: "OPERATOR" });
    const [closed] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer2.id));
    expect(closed.status).toBe("CANCELLED");
  });
});

/* ------------------------------------------------- TC-DSP-020 / 021 */

describe("TC-DSP-020 / TC-DSP-021: reliability and fairness change who is offered first", () => {
  /** History rows for `partnerId` on orders of their own (each delivery row needs its own order). */
  async function history(
    shopId: string,
    customerId: string,
    partnerId: string,
    rows: { status: "DELIVERED" | "REJECTED"; offeredAt: Date; declined?: boolean }[],
  ) {
    for (const r of rows) {
      const o = await createOrder(customerId, shopId, { status: "DELIVERED" });
      await db.insert(deliveryOrders).values({
        orderId: o.id,
        deliveryPartnerId: partnerId,
        status: r.status,
        offeredAt: r.offeredAt,
        rejectedPartnerIds: r.declined ? [partnerId] : [],
      });
    }
  }
  const yesterday = () => new Date(Date.now() - 26 * 3_600_000);

  it("with no history the nearer rider gets the offer (control)", async () => {
    const { shop, customer } = await shopWithOwner();
    const near = await rider(0.2);
    await rider(0.5);
    const offer = await assignNearestPartner((await readyOrder(shop.id, customer.id)).id, { id: null, role: null });
    expect(offer.deliveryPartnerId).toBe(near.partner.id);
  });

  it("TC-DSP-020: a nearer rider who declined three offers recently ranks below a reliable one", async () => {
    const { shop, customer } = await shopWithOwner();
    const near = await rider(0.2);
    const reliable = await rider(0.5);
    // Yesterday: inside the 30-day reliability window, outside today's fairness count.
    await history(shop.id, customer.id, near.partner.id, [1, 2, 3].map(() => ({ status: "REJECTED" as const, offeredAt: yesterday(), declined: true })));

    const offer = await assignNearestPartner((await readyOrder(shop.id, customer.id)).id, { id: null, role: null });
    expect(offer.deliveryPartnerId).toBe(reliable.partner.id);
  });

  it("TC-DSP-021: a nearer rider who already had five offers today ranks below one who had none", async () => {
    const { shop, customer } = await shopWithOwner();
    const near = await rider(0.2);
    const fresh = await rider(0.5);
    // Delivered, so reliability stays full: only today's offer count differs.
    await history(shop.id, customer.id, near.partner.id, [1, 2, 3, 4, 5].map(() => ({ status: "DELIVERED" as const, offeredAt: new Date() })));

    const offer = await assignNearestPartner((await readyOrder(shop.id, customer.id)).id, { id: null, role: null });
    expect(offer.deliveryPartnerId).toBe(fresh.partner.id);
  });
});

/* ------------------------------- TC-FLD-091 / 092 / 093, TC-DEL-030 */

describe("TC-FLD-091/092/093, TC-DEL-030: rider KYC, bank and vehicle numbers", () => {
  const base = { fullName: "Ravi Kumar", mobile: "9876543210", vehicleType: "MOTORCYCLE" as const };

  it("the application refuses bad numbers with the field named, and normalises the vehicle number", async () => {
    const bad: [string, Record<string, string>][] = [
      ["panNumber", { panNumber: "ABC12" }],
      ["governmentIdNumber", { governmentIdType: "Aadhaar", governmentIdNumber: "12" }],
      ["bankAccountNumber", { bankAccountNumber: "12345678" }],
      ["bankAccountNumber", { bankAccountNumber: "1234567890123456789" }],
      ["bankAccountNumber", { bankAccountNumber: "12AB34CD5678" }],
      ["bankIfsc", { bankIfsc: "SBIN000123" }],
      ["bankIfsc", { bankIfsc: "SBIN1001234" }],
      ["vehicleRegistrationNumber", { vehicleRegistrationNumber: "MH-12/AB@1234#" }],
      ["vehicleRegistrationNumber", { vehicleRegistrationNumber: "MH12@#$%^&*" }],
    ];
    for (const [field, values] of bad) {
      const user = await createUser();
      await expect(registerDeliveryPartner(user.id, { ...base, ...values }), JSON.stringify(values)).rejects.toMatchObject({
        status: 422,
        details: { fields: { [field]: expect.any(String) } },
      });
    }

    // Gig worker flow: a well-formed Aadhaar is refused here too — it is verified by OTP on the KYC step.
    await expect(
      registerDeliveryPartner((await createUser()).id, { ...base, governmentIdType: "Aadhaar", governmentIdNumber: "4321 4321 4321" }),
    ).rejects.toMatchObject({ status: 422, details: { fields: { governmentIdNumber: expect.any(String) } } });

    const user = await createUser();
    const partner = await registerDeliveryPartner(user.id, {
      ...base,
      panNumber: "abcde1234f",
      governmentIdType: "Voter ID",
      governmentIdNumber: "ABC1234567",
      bankAccountNumber: "123456789012",
      bankIfsc: "sbin0001234",
      vehicleRegistrationNumber: "  mh12 ab   1234 ",
    });
    expect(partner.vehicleRegistrationNumber).toBe("MH12 AB 1234");
    // The same number typed on the profile edit is stored the same way.
    const edited = await updateMyRiderProfile(user.id, { vehicleRegistrationNumber: "  mh12 ab 1234 " });
    expect(edited.vehicleRegistrationNumber).toBe("MH12 AB 1234");
    expect((await updateMyRiderProfile(user.id, { vehicleRegistrationNumber: "22 bh 1234 aa" })).vehicleRegistrationNumber).toBe("22 BH 1234 AA");
    await expect(updateMyRiderProfile(user.id, { vehicleRegistrationNumber: "MH12@#$%^&*" })).rejects.toMatchObject({ status: 422 });
    const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(row.vehicleRegistrationNumber).toBe("22 BH 1234 AA");
  });

  it("a change request uses the same rules (account letters, 8/19 digits, Aadhaar '12' refused; lower-case IFSC converted)", async () => {
    const user = await createUser();
    await registerDeliveryPartner(user.id, { ...base, governmentIdType: "Aadhaar" });
    for (const values of [
      { bankAccountNumber: "12AB34CD56" },
      { bankAccountNumber: "12345678" },
      { bankAccountNumber: "1234567890123456789" },
      { bankIfsc: "SBIN000123" },
      { panNumber: "ABC12" },
      { governmentIdType: "Aadhaar", governmentIdNumber: "12" },
      // The type on file is Aadhaar, so a number alone is checked as one.
      { governmentIdNumber: "12" },
    ]) {
      await expect(requestSensitiveChange(user.id, values), JSON.stringify(values)).rejects.toMatchObject({ status: 422 });
    }
    const ok = await requestSensitiveChange(user.id, { governmentIdNumber: "432143214321", bankIfsc: "sbin0001234" });
    expect(ok.masked).toEqual({ governmentIdNumber: "…4321", bankIfsc: "…1234" });
  });
});

/* ------------------------------------------ TC-RET-003 / TC-FLD-094 */

describe("TC-RET-003 / TC-FLD-094: a per-piece line is returned in whole pieces", () => {
  it("1.5 of a bread line is refused; 1 piece, and 1.5 L of a milk line, are accepted", async () => {
    const { shop, customer } = await shopWithOwner();
    const category = await createCategory({ department: "BAKERY", name: "Bread" });
    const bread = await createShopProduct(shop.id, (await createProduct(category.id, { name: "White Bread", unit: "piece" })).id, { onlinePricePaise: 4000 });
    const milk = await createShopProduct(shop.id, (await createProduct(category.id, { name: "Cow Milk", unit: "L" })).id, { onlinePricePaise: 7000 });
    const order = await createOrder(customer.id, shop.id, { status: "DELIVERED", subtotalPaise: 22_000, paidAt: new Date() });
    const [breadLine, milkLine] = await db
      .insert(orderItems)
      .values([
        { orderId: order.id, shopProductId: bread.id, productNameSnapshot: "White Bread", unitSnapshot: "piece", unitPricePaise: 4000, quantityMilli: 2000, lineTotalPaise: 8000 },
        { orderId: order.id, shopProductId: milk.id, productNameSnapshot: "Cow Milk", unitSnapshot: "L", unitPricePaise: 7000, quantityMilli: 2000, lineTotalPaise: 14_000 },
      ])
      .returning();
    const actor = { id: customer.id, role: "CUSTOMER" as const };
    const ask = (orderItemId: string, quantityMilli: number) =>
      requestReturn({ orderId: order.id, reason: "MISSING_ITEM", items: [{ orderItemId, quantityMilli, condition: "OPENED" }] }, actor);

    await expect(ask(breadLine.id, 1500)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/whole number of pieces/) });
    expect((await ask(breadLine.id, 1000)).refundAmountPaise).toBe(4000);
    expect((await ask(milkLine.id, 1500)).refundAmountPaise).toBe(10_500);
  });
});

/* ------------------------------------------------------ TC-SPI-020 (N5) */

describe("TC-SPI-020 (N5): a returned unopened unit goes back into stock", () => {
  it("accepted on inspection: the unopened unit is restocked (movement + SALE_RETURN of the order); a damaged one is not", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Ghee" });
    const shop = await createShop(owner.id, { latitude: 0, longitude: 0, deliveryAvailable: false });
    const jar = await createShopProduct(shop.id, (await createProduct(category.id, { name: "Ghee Jar", unit: "piece" })).id, {
      onlinePricePaise: 6000,
      onlineStock: 10,
    });
    await addToCart(customer.id, jar.id, 2);
    const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    const order = created[0];
    await db.update(orders).set({ status: "DELIVERED" }).where(eq(orders.id, order.id));
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const stock = async () => (await db.select({ n: shopProducts.onlineStock }).from(shopProducts).where(eq(shopProducts.id, jar.id)))[0].n;
    expect(await stock()).toBe(8);

    const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
    const returned = async (condition: "UNOPENED" | "DAMAGED") => {
      const ret = await requestReturn(
        { orderId: order.id, reason: "OTHER", items: [{ orderItemId: line.id, quantityMilli: 1000, condition }] },
        { id: customer.id, role: "CUSTOMER" },
      );
      await approveReturn(ret.id, shopActor);
      await receiveReturn(ret.id, shopActor);
      await inspectReturn(ret.id, shopActor, { outcome: "ACCEPT", note: condition === "UNOPENED" ? "Sealed, resaleable" : "Damaged" });
      return ret;
    };

    const sealed = await returned("UNOPENED");
    expect(await stock()).toBe(9);
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.shopProductId, jar.id), eq(inventoryMovements.orderId, order.id), gt(inventoryMovements.deltaUnits, 0)));
    expect(movement).toMatchObject({ deltaUnits: 1, reason: `Return ${sealed.returnNumber} of order ${order.orderNumber}` });
    const [ledger] = await db.select().from(invStockLedger).where(eq(invStockLedger.inventoryMovementId, movement.id));
    expect(ledger).toMatchObject({ movementType: "SALE_RETURN", orderId: order.id, qtyMilli: 1000 });

    await returned("DAMAGED");
    expect(await stock()).toBe(9);
  });
});

/* ------------------------------------------------- TC-DEL-027 / 015 */

describe("TC-DEL-027 / TC-DEL-015: approve and reactivate rules; every decision is told", () => {
  it("approve refuses a SUSPENDED or REJECTED rider (409); reactivate needs a reason, which is kept and audited", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const a = await registerDeliveryPartner((await createUser()).id, { fullName: "Asha", mobile: "9876543210", vehicleType: "SCOOTER" });
    const b = await registerDeliveryPartner((await createUser()).id, { fullName: "Bala", mobile: "9876543211", vehicleType: "SCOOTER" });
    await addRiderIdentityDocument(a.id); // D-57
    await approveDeliveryPartner(a.id, ADMIN(admin.id));
    await suspendDeliveryPartner(a.id, "documents expired", ADMIN(admin.id));
    await rejectDeliveryPartner(b.id, "documents unclear", ADMIN(admin.id));

    await expect(approveDeliveryPartner(a.id, ADMIN(admin.id))).rejects.toMatchObject({ status: 409 });
    await expect(approveDeliveryPartner(b.id, ADMIN(admin.id))).rejects.toMatchObject({ status: 409 });

    signInAs(admin, "ADMIN");
    const patch = (id: string, body: Record<string, unknown>) =>
      call(partnerPatch, `/api/delivery-partner/${id}`, { method: "PATCH", params: { id }, body });
    expect((await patch(a.id, { action: "reactivate" })).status).toBe(422);
    expect((await patch(a.id, { action: "reactivate", reason: "  " })).status).toBe(422);
    expect((await patch(b.id, { action: "reactivate", reason: "put a rejected rider to work" })).status).toBe(409);
    const back = await patch(a.id, { action: "reactivate", reason: "documents renewed" });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe("APPROVED");
    expect(back.body.reviewNotes).toBe("documents renewed");

    const trail = await db
      .select({ previous: auditLogs.previousValue, next: auditLogs.newValue })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, a.id), eq(auditLogs.action, "delivery_partner.status_changed")))
      .orderBy(desc(auditLogs.createdAt));
    expect(trail[0].next).toMatchObject({ status: "APPROVED", reviewNotes: "documents renewed" });
    expect(trail.map((t) => t.next)).toContainEqual(expect.objectContaining({ status: "SUSPENDED", reason: "documents expired" }));
  });

  it("the rider gets a notice when reactivated and when deactivated", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const p = await registerDeliveryPartner(user.id, { fullName: "Asha", mobile: "9876543210", vehicleType: "SCOOTER" });
    await addRiderIdentityDocument(p.id); // D-57
    await approveDeliveryPartner(p.id, ADMIN(admin.id));
    await suspendDeliveryPartner(p.id, "documents expired", ADMIN(admin.id));
    await reactivateDeliveryPartner(p.id, "documents renewed", ADMIN(admin.id));
    await deactivateDeliveryPartner(p.id, "left the platform", ADMIN(admin.id));

    const types = (await db.select({ type: notifications.type }).from(notifications).where(eq(notifications.userId, user.id))).map((n) => n.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "delivery_partner.approved",
        "delivery_partner.suspended",
        "delivery_partner.reactivated",
        "delivery_partner.deactivated",
      ]),
    );
  });
});

/* ---------------------------------------------------------- TC-DSP-011 */

describe("TC-DSP-011: cancelling an order ends its rider search", () => {
  it("a search under way is stopped as 'order cancelled' and offers no rider afterwards", async () => {
    const { owner, shop, customer } = await shopWithOwner();
    const order = await readyOrder(shop.id, customer.id);
    expect(await dispatchReadyOrder(order.id, { id: owner.id, role: "SHOP_OWNER" }, "AUTO_READY")).toBeNull(); // nobody online
    expect((await getRiderSearchStatus(order.id)).state).toBe("SEARCHING");

    await cancelOrder(order.id, { id: owner.id, role: "SHOP_OWNER" }, "Customer called to cancel");
    const after = await getRiderSearchStatus(order.id);
    expect({ state: after.state, stopReason: after.stopReason }).toEqual({ state: "STOPPED", stopReason: "ORDER_CANCELLED" });
    expect(after.message).toBe("The order was cancelled, so the search stopped.");

    await rider(0.2);
    await runDispatchSweep();
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id))).toHaveLength(0);
  });

  it("an open offer is withdrawn with the search; the sweep closes a search left open by an earlier cancellation", async () => {
    const { owner, shop, customer } = await shopWithOwner();
    await rider(0.2);
    const offered = await readyOrder(shop.id, customer.id);
    expect(await dispatchReadyOrder(offered.id, { id: owner.id, role: "SHOP_OWNER" }, "AUTO_READY")).not.toBeNull();
    await cancelOrder(offered.id, { id: owner.id, role: "SHOP_OWNER" }, "Out of stock");
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, offered.id));
    expect(row.status).toBe("CANCELLED");
    const [search] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, offered.id));
    expect(search).toMatchObject({ status: "STOPPED", stopReason: "ORDER_CANCELLED" });

    // Data from before the fix: cancelled, refunded, search still SEARCHING.
    const old = await createOrder(customer.id, shop.id, { status: "REFUNDED" });
    await db.insert(riderSearches).values({ orderId: old.id, maxAttempts: 10 });
    const sweep = await runDispatchSweep();
    expect(sweep.closed).toBeGreaterThanOrEqual(1);
    const [closed] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, old.id));
    expect(closed).toMatchObject({ status: "STOPPED", stopReason: "ORDER_CANCELLED" });
  });
});

/* ---------------------------------------------------------- TC-FLD-083 */

describe("TC-FLD-083: the remove-line reason comes from the shop screen's list", () => {
  it("'Banana' is refused; no reason keeps 'Unavailable'; 'Out of stock' is kept", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const shop = await createShop(owner.id, { latitude: 0, longitude: 0 });
    for (const name of ["Cow Milk", "Buffalo Milk", "Curd"]) {
      const sp = await createShopProduct(shop.id, (await createProduct(category.id, { name, unit: "L" })).id, { onlinePricePaise: 7000, onlineStock: 50 });
      await addToCart(customer.id, sp.id, 1);
    }
    const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    const order = created[0];
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    signInAs(owner, "SHOP_OWNER");
    const act = (body: Record<string, unknown>) =>
      call(fulfilmentPost, `/api/orders/${order.id}/fulfilment`, { method: "POST", params: { id: order.id }, body });

    expect((await act({ action: "accept" })).status).toBe(200);
    expect((await act({ action: "remove", itemId: lines[0].id, reason: "Banana" })).status).toBe(422);
    expect((await act({ action: "remove", itemId: lines[0].id })).status).toBe(200);
    expect((await act({ action: "remove", itemId: lines[1].id, reason: "Out of stock" })).status).toBe(200);
    const notes = new Map(
      (await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))).map((l) => [l.id, l.fulfilmentNote]),
    );
    expect([notes.get(lines[0].id), notes.get(lines[1].id), notes.get(lines[2].id)]).toEqual(["Unavailable", "Out of stock", null]);
  });
});

/* ---------------------------------------------------------- TC-FLD-101 */

describe("TC-FLD-101: grievance phone and lookup", () => {
  const complaint = {
    name: "Priya",
    email: "priya@example.com",
    category: "ORDER" as const,
    subject: "Late order",
    description: "My order came two hours late.",
  };

  it("an invalid phone is refused (422); a valid one is stored as the 10-digit number", async () => {
    const res = await call(grievancePost, "/api/grievances", { method: "POST", body: { ...complaint, phone: "not a phone" } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields.phone).toBeTruthy();
    const saved = await submitGrievance({ ...complaint, phone: "+91 98765 43210" });
    expect(saved.phone).toBe("9876543210");
    expect((await submitGrievance(complaint)).phone).toBeNull();
  });

  it("an unknown ticket and a known ticket with another email get the same answer", async () => {
    const saved = await submitGrievance(complaint);
    const look = (ticket: string, email: string) =>
      call(grievanceLookup, `/api/grievances/lookup?ticket=${ticket}&email=${encodeURIComponent(email)}`);
    const unknown = await look("GRV-999999", complaint.email);
    const wrongMail = await look(saved.ticketNumber, "someone-else@example.com");
    expect(unknown.status).toBe(404);
    expect([wrongMail.status, wrongMail.body.error.message]).toEqual([unknown.status, unknown.body.error.message]);
    expect((await lookupGrievance(saved.ticketNumber, "PRIYA@example.com")).id).toBe(saved.id);
  });
});

/* ------------------------------------------------------ TC-SPI-004 (N11) */

describe("TC-SPI-004 (N11): the order-confirmed e-mail lists the lines, fees and total", () => {
  it("e-mail rows: each line with quantity and amount, delivery fee, total; the in-app notice stays short", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const shop = await createShop(owner.id, { latitude: 0, longitude: 0, deliveryFeePaise: 2_000 });
    const jam = await createShopProduct(shop.id, (await createProduct(category.id, { name: "QA Jam", unit: "piece" })).id, { onlinePricePaise: 12_550, onlineStock: 20 });
    const milk = await createShopProduct(shop.id, (await createProduct(category.id, { name: "Cow Milk", unit: "L" })).id, { onlinePricePaise: 7_000, onlineStock: 20 });
    await addToCart(customer.id, jam.id, 2);
    await addToCart(customer.id, milk.id, 1);
    const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    const order = created[0];
    expect(order.totalPaise).toBe(2 * 12_550 + 7_000 + 2_000);

    const [mail] = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, customer.id), eq(notificationDeliveries.type, "order.confirmed"), eq(notificationDeliveries.channel, "EMAIL")));
    expect(mail.body).toContain(`Your order ${order.orderNumber} from ${shop.name} is confirmed.`);
    expect(mail.body).toContain("QA Jam × 2 piece: ₹251.00");
    expect(mail.body).toContain("Cow Milk × 1 L: ₹70.00");
    expect(mail.body).toContain("Delivery fee: ₹20.00");
    expect(mail.body).toContain("Total (paid from wallet): ₹341.00");
    expect(mail.html).toContain("QA Jam × 2 piece");

    const [inApp] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, customer.id), eq(notifications.type, "order.confirmed")));
    expect(inApp.body).toBe(`Your order ${order.orderNumber} from ${shop.name} is confirmed.`);
  });
});

/* ---------------------------------------------------------- TC-ADM-004 */

describe("TC-ADM-004: Order Monitoring filters by the IST business day", () => {
  it("an order placed at 01:30 IST on 24 Oct is listed under 24 Oct, not 23 Oct; 23:30 IST stays on its own day", async () => {
    const { shop, customer } = await shopWithOwner();
    const early = await createOrder(customer.id, shop.id, { status: "CONFIRMED" });
    const late = await createOrder(customer.id, shop.id, { status: "CONFIRMED" });
    await db.update(orders).set({ createdAt: new Date("2026-10-23T20:00:00Z") }).where(eq(orders.id, early.id)); // 24 Oct 01:30 IST
    await db.update(orders).set({ createdAt: new Date("2026-10-24T18:00:00Z") }).where(eq(orders.id, late.id)); // 24 Oct 23:30 IST

    const ids = async (dateFrom: string, dateTo: string) =>
      (await listOrdersForMonitoring({ dateFrom, dateTo })).map((o) => o.id).sort();
    expect(await ids("2026-10-24", "2026-10-24")).toEqual([early.id, late.id].sort());
    expect(await ids("2026-10-23", "2026-10-23")).toEqual([]);
    expect(await ids("2026-10-25", "2026-10-25")).toEqual([]);
    expect(await ids("2026-10-23", "2026-10-24")).toEqual([early.id, late.id].sort());
    // An impossible date is ignored, as before.
    expect(await ids("2026-02-31", "2026-10-24")).toEqual([early.id, late.id].sort());
  });
});
