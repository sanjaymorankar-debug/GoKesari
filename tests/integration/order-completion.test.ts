/**
 * NEW-007 — order completion: shop acceptance timeout, photo proof of
 * delivery, and the shop's tax invoice per delivered order. Each is behind
 * its own rule, off by default.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  invoiceCounters,
  notifications,
  orders,
  platformSettings,
  products,
  shopProducts,
  shops,
  shopSlaEvents,
  taxInvoices,
  wallets,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  markDelivered,
  markPickedUp,
  startDelivery,
} from "@/server/services/delivery-assignment";
import { canViewDeliveryProof, proofPhotosForOrders, uploadDeliveryProof } from "@/server/services/delivery-proofs";
import { acceptOrder } from "@/server/services/fulfilment";
import {
  amountInWords,
  canViewInvoice,
  financialYearOf,
  issueInvoiceForOrder,
  renderInvoicePdf,
  splitInclusive,
  type InvoiceSnapshot,
} from "@/server/services/invoices";
import { cancelOrder, checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { acceptByFor, missedAcceptances30d, runShopAcceptanceSweep } from "@/server/services/shop-acceptance";
import {
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
  setDeliveryCode,
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
const SHOP = { latitude: 18.5, longitude: 73.85 };

beforeEach(async () => {
  await resetDatabase();
  await db
    .delete(platformSettings)
    .where(inArray(platformSettings.key, ["shopAcceptance", "deliveryProof", "invoicing", "images"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function shopWithMilk(opts: { gstin?: string; gstRateBp?: number | null } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  if (opts.gstRateBp !== undefined) {
    await db.update(products).set({ gstRateBp: opts.gstRateBp, hsnCode: "0401" }).where(eq(products.id, milk.id));
  }
  const shop = await createShop(owner.id, { name: "Dairy One", latitude: SHOP.latitude, longitude: SHOP.longitude });
  if (opts.gstin) {
    await db.update(shops).set({ gstin: opts.gstin, gstStatus: "REGISTERED" }).where(eq(shops.id, shop.id));
  }
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 10_500, onlineStock: 50 });
  return { shop, sp, owner };
}

async function placeOrder(spId: string, requestId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  const { orders: placed } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId });
  return { customer: user, order: placed[0] };
}

/* ------------------------------------------------------- acceptance timeout */

describe("shop acceptance timeout", () => {
  it("is off by default: no accept-by time and the sweep does nothing", async () => {
    const { sp } = await shopWithMilk();
    const { order } = await placeOrder(sp.id, "off");
    expect(order.acceptByAt).toBeNull();
    expect(await runShopAcceptanceSweep(new Date(Date.now() + 3_600_000))).toEqual({ reminded: 0, cancelled: 0, escalated: 0, skipped: 0 });
  });

  it("reminds the shop half-way, then cancels with a full refund and restock when time runs out", async () => {
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: 10 }, admin);
    const { sp, owner, shop } = await shopWithMilk();
    const { order, customer } = await placeOrder(sp.id, "timeout");
    expect(order.acceptByAt).not.toBeNull();
    const acceptBy = order.acceptByAt!.getTime();
    expect(Math.abs(acceptBy - (Date.now() + 10 * 60_000))).toBeLessThan(15_000);

    expect((await runShopAcceptanceSweep(new Date(acceptBy - 6 * 60_000))).reminded).toBe(0);
    expect((await runShopAcceptanceSweep(new Date(acceptBy - 4 * 60_000))).reminded).toBe(1);
    expect((await runShopAcceptanceSweep(new Date(acceptBy - 3 * 60_000))).reminded).toBe(0); // once only
    const reminders = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(reminders.some((n) => n.type === "shop.accept_reminder")).toBe(true);

    const result = await runShopAcceptanceSweep(new Date(acceptBy + 1000));
    expect(result.cancelled).toBe(1);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after.status).toBe("REFUNDED");
    expect(after.cancellationReason).toBe("The shop did not accept the order in time");
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, customer.id));
    expect(wallet.balancePaise).toBe(500_000);
    const [stock] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(stock.onlineStock).toBe(50);
    expect(await missedAcceptances30d(shop.id)).toBe(1);
    const told = await db.select().from(notifications).where(eq(notifications.userId, customer.id));
    expect(told.some((n) => n.type === "order.cancelled")).toBe(true);
  });

  it("leaves an order the shop accepted in time, and never cancels one accepted at the same moment", async () => {
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: 10 }, admin);
    const { sp, owner } = await shopWithMilk();
    const { order } = await placeOrder(sp.id, "accepted");
    await acceptOrder(order.id, { id: owner.id, role: "SHOP_OWNER" });
    const result = await runShopAcceptanceSweep(new Date(order.acceptByAt!.getTime() + 60_000));
    expect(result.cancelled).toBe(0);
    await expect(cancelOrder(order.id, null, "late", { onlyIfStatus: "CONFIRMED" })).rejects.toMatchObject({ code: "CONFLICT" });
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after.status).toBe("ACCEPTED");
  });

  it("starts the clock at opening time for an order placed while the shop is closed", async () => {
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: 10 }, admin);
    const now = new Date("2026-10-06T02:00:00Z");
    const opens = new Date("2026-10-06T03:30:00Z");
    expect((await acceptByFor(now, opens))?.toISOString()).toBe("2026-10-06T03:40:00.000Z");
    expect((await acceptByFor(now, null))?.toISOString()).toBe("2026-10-06T02:10:00.000Z");
  });
});

/* -------------------------------------------------------- photo proof */

/** A minimal PNG header — enough for the server's type and size checks. */
function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}

async function pickedUpDelivery() {
  const { sp, owner, shop } = await shopWithMilk();
  const { order, customer } = await placeOrder(sp.id, `pod-${Math.random()}`);
  await db.update(orders).set({ status: "READY" }).where(eq(orders.id, order.id));
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: SHOP.latitude, longitude: SHOP.longitude, operatingRadiusKm: 20 });
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  const rider = { id: riderUser.id, role: "DELIVERY_PARTNER" as const };
  await acceptDeliveryOffer(offer.id, rider.id);
  const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
  await markPickedUp(offer.id, rider, accepted.pickupCode!);
  await startDelivery(offer.id, rider);
  return { order, customer, owner, shop, rider, deliveryId: offer.id, otp: await setDeliveryCode(offer.id) };
}

describe("photo proof of delivery", () => {
  it("is not needed while the rule is off", async () => {
    const d = await pickedUpDelivery();
    expect((await markDelivered(d.deliveryId, d.rider, d.otp)).status).toBe("DELIVERED");
  });

  it("needs a valid photo before the order can be marked delivered, and shows it only to the order's people", async () => {
    await setRule("deliveryProof", { photoRequired: true }, admin);
    const d = await pickedUpDelivery();
    await expect(markDelivered(d.deliveryId, d.rider, d.otp)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("photo"),
    });
    await expect(uploadDeliveryProof(d.deliveryId, d.rider, Buffer.from("not an image at all, just text"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(uploadDeliveryProof(d.deliveryId, d.rider, png(20, 20))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const stranger = await createUser({ role: "DELIVERY_PARTNER" });
    await expect(uploadDeliveryProof(d.deliveryId, { id: stranger.id, role: "DELIVERY_PARTNER" }, png(400, 300))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const proof = await uploadDeliveryProof(d.deliveryId, d.rider, png(400, 300));
    expect((await markDelivered(d.deliveryId, d.rider, d.otp)).status).toBe("DELIVERED");

    const photos = await proofPhotosForOrders([d.order.id]);
    expect(photos.get(d.order.id)?.url).toBe(proof.url);
    const imageId = proof.url.split("/").pop()!;
    const other = await createUser();
    expect(await canViewDeliveryProof(imageId, { id: d.customer.id, role: "CUSTOMER" })).toBe(true);
    expect(await canViewDeliveryProof(imageId, { id: d.owner.id, role: "SHOP_OWNER" })).toBe(true);
    expect(await canViewDeliveryProof(imageId, admin)).toBe(true);
    expect(await canViewDeliveryProof(imageId, { id: other.id, role: "CUSTOMER" })).toBe(false);
  });
});

/* ---------------------------------------------------------- tax invoice */

async function deliver(orderId: string) {
  for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
    await updateOrderStatus(orderId, s, admin);
  }
}

describe("tax invoice", () => {
  it("helpers: tax out of inclusive prices, financial year, amount in words", () => {
    expect(splitInclusive(10_500, 500, "INTRA")).toEqual({ taxablePaise: 10_000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0 });
    expect(splitInclusive(10_500, 500, "INTER")).toEqual({ taxablePaise: 10_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 500 });
    expect(splitInclusive(999, 1200, "INTRA")).toEqual({ taxablePaise: 892, cgstPaise: 53, sgstPaise: 54, igstPaise: 0 });
    expect(financialYearOf(new Date("2026-03-31T20:00:00Z"))).toBe("2026-27"); // 1 Apr IST
    expect(financialYearOf(new Date("2026-03-31T10:00:00Z"))).toBe("2025-26");
    expect(amountInWords(125_050)).toBe("Rupees One Thousand Two Hundred Fifty and Fifty Paise Only");
    expect(amountInWords(1_00_00_000_00)).toBe("Rupees One Crore Only");
  });

  it("is not issued while the rule is off", async () => {
    const { sp } = await shopWithMilk();
    const { order } = await placeOrder(sp.id, "inv-off");
    await deliver(order.id);
    expect(await db.select().from(taxInvoices)).toHaveLength(0);
    expect(await issueInvoiceForOrder(order.id)).toBeNull();
  });

  it("issues a bill of supply for a shop without a GSTIN, numbered per shop and year", async () => {
    await setRule("invoicing", { enabled: true }, admin);
    const { sp, shop } = await shopWithMilk();
    const a = await placeOrder(sp.id, "inv-a");
    const b = await placeOrder(sp.id, "inv-b");
    await deliver(a.order.id);
    await deliver(b.order.id);
    const rows = await db.select().from(taxInvoices).orderBy(taxInvoices.sequence);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(rows[0].kind).toBe("BILL_OF_SUPPLY");
    const fy = financialYearOf(new Date());
    expect(rows[0].invoiceNumber).toBe(`${shop.registrationNumber}/${fy}/000001`);
    expect(rows[0]).toMatchObject({ taxablePaise: 10_500, cgstPaise: 0, sgstPaise: 0, totalPaise: 10_500 });

    const snap = rows[0].snapshot as unknown as InvoiceSnapshot;
    expect(snap.lines).toHaveLength(1); // the delivery fee is GoKesari's, not on the shop's invoice
    const invNotes = await db.select().from(notifications).where(eq(notifications.userId, a.customer.id));
    expect(invNotes.some((n) => n.type === "order.invoice_ready")).toBe(true);
  });

  it("issues a tax invoice with CGST + SGST for a GST-registered shop, IGST across states", async () => {
    await setRule("invoicing", { enabled: true }, admin);
    const { sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5", gstRateBp: 500 });
    const local = await placeOrder(sp.id, "inv-gst");
    await deliver(local.order.id);
    const [inv] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, local.order.id));
    expect(inv).toMatchObject({ kind: "TAX_INVOICE", supplyType: "INTRA", taxablePaise: 10_000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0 });

    const away = await placeOrder(sp.id, "inv-igst");
    await db.update(addresses).set({ state: "KA" }).where(eq(addresses.id, away.order.addressId!));
    await deliver(away.order.id);
    const [inter] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, away.order.id));
    expect(inter).toMatchObject({ supplyType: "INTER", igstPaise: 500, cgstPaise: 0 });
  });

  it("marks a product with no GST rate and applies the default rate", async () => {
    await setRule("invoicing", { enabled: true, defaultGstRateBp: 0 }, admin);
    const { sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5", gstRateBp: null });
    const { order } = await placeOrder(sp.id, "inv-norate");
    await deliver(order.id);
    const [inv] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id));
    const snap = inv.snapshot as unknown as InvoiceSnapshot;
    expect(snap.lines[0]).toMatchObject({ rateAssumed: true, rateBp: 0 });
    expect(snap.notes.join(" ")).toContain("no GST rate on record");
  });

  it("issues once for an order delivered before invoicing, even when asked twice at once", async () => {
    const { sp, shop } = await shopWithMilk();
    const { order, customer } = await placeOrder(sp.id, "inv-late");
    await deliver(order.id);
    await setRule("invoicing", { enabled: true }, admin);
    const [first, second] = await Promise.all([issueInvoiceForOrder(order.id), issueInvoiceForOrder(order.id)]);
    expect(first?.id).toBe(second?.id);
    const [counter] = await db.select().from(invoiceCounters).where(eq(invoiceCounters.shopId, shop.id));
    expect(counter.lastNumber).toBe(1);

    const stranger = await createUser();
    expect(await canViewInvoice(first!, { id: customer.id, role: "CUSTOMER" })).toBe(true);
    expect(await canViewInvoice(first!, { id: shop.ownerId, role: "SHOP_OWNER" })).toBe(true);
    expect(await canViewInvoice(first!, { id: stranger.id, role: "CUSTOMER" })).toBe(false);

    const pdf = renderInvoicePdf(first!).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain(first!.invoiceNumber);
    expect(pdf).toContain("BILL OF SUPPLY");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("refuses an order that has not been delivered", async () => {
    await setRule("invoicing", { enabled: true }, admin);
    const { sp } = await shopWithMilk();
    const { order } = await placeOrder(sp.id, "inv-undelivered");
    await expect(issueInvoiceForOrder(order.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const customer = await createUser();
    const other = await createOrder(customer.id, (await db.select().from(shops))[0].id, { status: "CANCELLED" });
    await expect(issueInvoiceForOrder(other.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(taxInvoices))[0].n).toBe(0);
    expect((await db.select().from(shopSlaEvents)).length).toBe(0);
  });
});
