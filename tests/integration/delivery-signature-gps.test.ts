/**
 * Module 4 (23-Nov-2026) — customer signature, GPS at delivery / failure and
 * the fixed failed-delivery reasons, against real PostgreSQL (migration 0196).
 * Every behaviour is behind a deliveryProof rule field that defaults off.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, deliveryProofs, orders, platformSettings } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  getMyActiveDeliveryDetail,
  markDelivered,
  markDeliveryFailed,
  markPickedUp,
  startDelivery,
} from "@/server/services/delivery-assignment";
import {
  canViewDeliveryProof,
  deliveryGpsForOrders,
  signaturesForOrders,
  uploadDeliveryProof,
} from "@/server/services/delivery-proofs";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  createCategory,
  createDeliveryPartner,
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
const AT_DOOR = { latitude: 18.5204, longitude: 73.8567, accuracyM: 11.4 };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["deliveryProof", "images"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}

async function pickedUpDelivery() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One", latitude: SHOP.latitude, longitude: SHOP.longitude });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 10_500, onlineStock: 50 });
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: placed } = await checkout({
    userId: customer.id,
    addressId: await deliveryAddressId(customer.id),
    requestId: `m4-${Math.random()}`,
  });
  const order = placed[0];
  await db.update(orders).set({ status: "READY" }).where(eq(orders.id, order.id));
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: SHOP.latitude, longitude: SHOP.longitude, operatingRadiusKm: 20 });
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  const rider = { id: riderUser.id, role: "DELIVERY_PARTNER" as const };
  await acceptDeliveryOffer(offer.id, rider.id);
  const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
  await markPickedUp(offer.id, rider, accepted.pickupCode!);
  await startDelivery(offer.id, rider);
  return { order, customer, owner, rider, deliveryId: offer.id, otp: await setDeliveryCode(offer.id) };
}

describe("rules off (default): nothing changes", () => {
  it("TC-M4-I01 no signature upload, no GPS stored, free-text failure as before", async () => {
    const d = await pickedUpDelivery();
    await expect(uploadDeliveryProof(d.deliveryId, d.rider, png(600, 240), "SIGNATURE")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const detail = await getMyActiveDeliveryDetail(d.rider.id);
    expect(detail).toMatchObject({ signatureEnabled: false, signatureRequired: false, captureGps: false, failureReasonList: false });

    // A reason code is ignored while the rule is off: free text is still needed.
    await expect(markDeliveryFailed(d.deliveryId, d.rider, null, { reasonCode: "WRONG_ADDRESS" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const failed = await markDeliveryFailed(d.deliveryId, d.rider, "Customer not at home", { position: AT_DOOR });
    expect(failed.failureReason).toBe("Customer not at home");
    expect(failed.failureReasonCode).toBeNull();
    expect(failed.failedLatitude).toBeNull();
  });

  it("TC-M4-I02 delivered without a signature and without GPS", async () => {
    const d = await pickedUpDelivery();
    const done = await markDelivered(d.deliveryId, d.rider, d.otp, undefined, AT_DOOR);
    expect(done.status).toBe("DELIVERED");
    expect(done.deliveredLatitude).toBeNull();
  });
});

describe("customer signature (deliveryProof.signatureEnabled / signatureRequired)", () => {
  it("TC-M4-I10 required signature blocks Mark delivered until uploaded; visible to the order's people only", async () => {
    await setRule("deliveryProof", { signatureEnabled: true, signatureRequired: true, captureGps: true }, admin);
    const d = await pickedUpDelivery();
    expect(await getMyActiveDeliveryDetail(d.rider.id)).toMatchObject({ signatureRequired: true, signatureUploaded: false });
    await expect(markDelivered(d.deliveryId, d.rider, d.otp)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("signature"),
    });

    const stranger = await createUser({ role: "DELIVERY_PARTNER" });
    await expect(
      uploadDeliveryProof(d.deliveryId, { id: stranger.id, role: "DELIVERY_PARTNER" }, png(600, 240), "SIGNATURE"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const sig = await uploadDeliveryProof(d.deliveryId, d.rider, png(600, 240), "SIGNATURE", {
      signerName: "  Asha  Patil ",
      position: AT_DOOR,
    });
    expect(sig.kind).toBe("SIGNATURE");
    const [row] = await db.select().from(deliveryProofs).where(eq(deliveryProofs.id, sig.id));
    expect(row).toMatchObject({ kind: "SIGNATURE", signerName: "Asha Patil", latitude: AT_DOOR.latitude, longitude: AT_DOOR.longitude });
    expect(await getMyActiveDeliveryDetail(d.rider.id)).toMatchObject({ signatureUploaded: true });

    expect((await markDelivered(d.deliveryId, d.rider, d.otp)).status).toBe("DELIVERED");

    const signatures = await signaturesForOrders([d.order.id]);
    expect(signatures.get(d.order.id)).toMatchObject({ url: sig.url, signerName: "Asha Patil" });
    expect(signatures.get(d.order.id)?.takenAt).toBeInstanceOf(Date);
    const imageId = sig.url.split("/").pop()!;
    const other = await createUser();
    expect(await canViewDeliveryProof(imageId, { id: d.customer.id, role: "CUSTOMER" })).toBe(true);
    expect(await canViewDeliveryProof(imageId, { id: d.owner.id, role: "SHOP_OWNER" })).toBe(true);
    expect(await canViewDeliveryProof(imageId, admin)).toBe(true);
    expect(await canViewDeliveryProof(imageId, { id: other.id, role: "CUSTOMER" })).toBe(false);
  });

  it("TC-M4-I11 enabled but not required: delivering without one is fine", async () => {
    await setRule("deliveryProof", { signatureEnabled: true }, admin);
    const d = await pickedUpDelivery();
    expect((await markDelivered(d.deliveryId, d.rider, d.otp)).status).toBe("DELIVERED");
  });
});

describe("GPS at delivery / failure (deliveryProof.captureGps)", () => {
  it("TC-M4-I20 the drop's position is stored and read back for the admin view", async () => {
    await setRule("deliveryProof", { captureGps: true }, admin);
    const d = await pickedUpDelivery();
    const done = await markDelivered(d.deliveryId, d.rider, d.otp, undefined, AT_DOOR);
    expect(done).toMatchObject({ deliveredLatitude: AT_DOOR.latitude, deliveredLongitude: AT_DOOR.longitude, deliveredAccuracyM: 11 });
    const gps = await deliveryGpsForOrders([d.order.id]);
    expect(gps.get(d.order.id)).toEqual({
      delivered: { latitude: AT_DOOR.latitude, longitude: AT_DOOR.longitude, accuracyM: 11 },
      failed: null,
    });
  });

  it("TC-M4-I21 a failed drop's position is stored; an invalid one is dropped", async () => {
    await setRule("deliveryProof", { captureGps: true }, admin);
    const d = await pickedUpDelivery();
    const failed = await markDeliveryFailed(d.deliveryId, d.rider, "Gate locked", { position: AT_DOOR });
    expect(failed).toMatchObject({ failedLatitude: AT_DOOR.latitude, failedLongitude: AT_DOOR.longitude });

    const e = await pickedUpDelivery();
    const bad = await markDeliveryFailed(e.deliveryId, e.rider, "Gate locked", { position: { latitude: 123, longitude: 0 } });
    expect(bad.failedLatitude).toBeNull();
  });
});

describe("fixed failed-delivery reasons (deliveryProof.failureReasons)", () => {
  it("TC-M4-I30 a listed reason stores its label and code; Other needs a note; free text still works", async () => {
    await setRule("deliveryProof", { failureReasons: true }, admin);
    const d = await pickedUpDelivery();
    await expect(markDeliveryFailed(d.deliveryId, d.rider, "", { reasonCode: "OTHER" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const failed = await markDeliveryFailed(d.deliveryId, d.rider, "called twice", { reasonCode: "PHONE_UNREACHABLE" });
    expect(failed.failureReason).toBe("Customer's phone unreachable — called twice");
    expect(failed.failureReasonCode).toBe("PHONE_UNREACHABLE");

    const e = await pickedUpDelivery();
    const free = await markDeliveryFailed(e.deliveryId, e.rider, "Customer not at home");
    expect(free).toMatchObject({ failureReason: "Customer not at home", failureReasonCode: null });
  });
});
