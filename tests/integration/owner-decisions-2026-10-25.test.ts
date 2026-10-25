/**
 * Defects settled by the owner on 25 Oct 2026 (docs/testing/qa-defects.json).
 * Real PostgreSQL; runs on one database and on the split layout.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryPartnerDocuments, orderItems, products, shops, taxInvoices } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { approveDeliveryPartner, registerDeliveryPartner } from "@/server/services/delivery-partners";
import type { InvoiceSnapshot } from "@/server/services/invoices";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { setRule } from "@/server/services/settings";
import {
  addRiderIdentityDocument,
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const RIDER = { fullName: "Asha", mobile: "9876543210", vehicleType: "SCOOTER" as const };
const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

beforeEach(async () => {
  await resetDatabase();
});

describe("D-57: a rider is approved only with an identity document on file", () => {
  it("refuses approval with no document, with only a vehicle RC, or with only a rejected document", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner((await createUser()).id, RIDER);
    await expect(approveDeliveryPartner(partner.id, ADMIN(admin.id))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no identity document on file"),
    });

    const [rc] = await db.select().from(deliveryPartnerDocuments).where(eq(deliveryPartnerDocuments.id, (await addRiderIdentityDocument(partner.id)).id));
    await db.update(deliveryPartnerDocuments).set({ docType: "VEHICLE_RC" }).where(eq(deliveryPartnerDocuments.id, rc.id));
    await expect(approveDeliveryPartner(partner.id, ADMIN(admin.id))).rejects.toMatchObject({ status: 409 });

    const licence = await addRiderIdentityDocument(partner.id, "DRIVING_LICENCE");
    await db.update(deliveryPartnerDocuments).set({ status: "REJECTED", rejectionReason: "blurred" }).where(eq(deliveryPartnerDocuments.id, licence.id));
    await expect(approveDeliveryPartner(partner.id, ADMIN(admin.id))).rejects.toMatchObject({ status: 409 });
  });

  it("approves once an identity document is on file (submitted or accepted)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner((await createUser()).id, RIDER);
    await addRiderIdentityDocument(partner.id, "PAN");
    expect((await approveDeliveryPartner(partner.id, ADMIN(admin.id))).status).toBe("APPROVED");
  });
});

/** A GSTIN with a correct check digit. */
function gstin(stateCode: string, pan: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const body = `${stateCode}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}

describe("D-91: an order line keeps the MRP it was sold under", () => {
  it("records the product's MRP on the line and the invoice; a later MRP change does not touch it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("invoicing", { enabled: true, defaultGstRateBp: 500 }, { id: admin.id, role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "MRP Dairy" });
    await db.update(shops).set({ gstin: gstin("27", "ABCDE1234F"), gstStatus: "REGISTERED" }).where(eq(shops.id, shop.id));
    const cat = await createCategory({ department: "DAIRY", name: "Ghee" });
    const ghee = await createProduct(cat.id, { name: "Ghee 500ml", unit: "pc" });
    await db.update(products).set({ mrpPaise: 6_000 }).where(eq(products.id, ghee.id));
    const loose = await createProduct(cat.id, { name: "Loose paneer", unit: "kg" });
    const spGhee = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 5_500, onlineStock: 20 });
    const spLoose = await createShopProduct(shop.id, loose.id, { onlinePricePaise: 40_000, onlineStock: 20 });

    const { user } = await createUserWithWallet({ balancePaise: 1_000_000 });
    await addToCart(user.id, spGhee.id, 2);
    await addToCart(user.id, spLoose.id, 1);
    const { orders } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: "d91" });
    await db.update(products).set({ mrpPaise: 6_500 }).where(eq(products.id, ghee.id)); // the master changes later

    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orders[0].id));
    const byName = Object.fromEntries(lines.map((l) => [l.productNameSnapshot, l.mrpPaise]));
    expect(byName).toEqual({ "Ghee 500ml": 6_000, "Loose paneer": null });

    for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(orders[0].id, s, { id: admin.id, role: "ADMIN" });
    const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, orders[0].id));
    const snapshot = invoice.snapshot as unknown as InvoiceSnapshot;
    expect(Object.fromEntries(snapshot.lines.map((l) => [l.description, l.mrpPaise]))).toEqual({ "Ghee 500ml": 6_000, "Loose paneer": null });
  });
});
