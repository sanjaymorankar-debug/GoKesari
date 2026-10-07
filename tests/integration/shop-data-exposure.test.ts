/**
 * What the shop APIs send back, by viewer.
 *
 * The public reads (GET /api/shops, /api/shops/[id]) give anyone only what a
 * shop card shows: no owner phone, email or address, no tax or fee details,
 * nothing about a shop that is not live. The owner's and staff's action routes return the shop without the
 * PAN ciphertext, its blind index, the Shop Act matching key or staff ids.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as approvePost } from "@/app/api/shops/[id]/approve/route";
import { POST as classificationPost } from "@/app/api/shops/[id]/classification/route";
import { PATCH as compliancePatch } from "@/app/api/shops/[id]/compliance/route";
import { POST as gstRejectPost } from "@/app/api/shops/[id]/gst/reject/route";
import { POST as gstPost } from "@/app/api/shops/[id]/gst/route";
import { POST as gstVerifyPost } from "@/app/api/shops/[id]/gst/verify/route";
import { POST as panRejectPost } from "@/app/api/shops/[id]/pan/reject/route";
import { POST as panPost } from "@/app/api/shops/[id]/pan/route";
import { POST as panVerifyPost } from "@/app/api/shops/[id]/pan/verify/route";
import { POST as rejectPost } from "@/app/api/shops/[id]/reject/route";
import { GET as shopGet, PATCH as shopPatch } from "@/app/api/shops/[id]/route";
import { GET as shopsGet, POST as shopsPost } from "@/app/api/shops/route";
import { encryptPan, panBlindIndex } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { shopCategories, shops } from "@/server/db/schema";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";
import { call } from "../helpers/http";

const PAN = "ABCDE1234F";
const OWNER_PHONE = "9999999999";

/** Never in any response, whoever asks. */
const INTERNAL_KEYS = [
  "panNumberEncrypted",
  "panHash",
  "shopActKey",
  "approvedBy",
  "gstVerifiedBy",
  "panVerifiedBy",
  "statusActorId",
  "registrationFeeId",
  "referralCodeId",
];

/** Everything an anonymous caller gets for a shop. */
const PUBLIC_SHOP_KEYS = [
  "id",
  "slug",
  "name",
  "logoUrl",
  "ownerName",
  "area",
  "city",
  "pincode",
  "shopType",
  "classification",
  "deliveryAvailable",
  "openingHours",
  "ratingAvgX100",
  "ratingCount",
].sort();

type User = { id: string; email: string; name: string | null; role: UserRole };

function signIn(user: User) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

let licence = 0;

/** A shop row with every sensitive column filled in, as a real one would be. */
async function sensitiveShop(
  ownerId: string,
  status: "APPROVED" | "PENDING_APPROVAL" = "APPROVED",
  approverId: string | null = null,
) {
  const shop = await createShop(ownerId, { status, latitude: 18.52, longitude: 73.85 });
  // A Shop Act licence is unique among live shops.
  licence += 1;
  const [row] = await db
    .update(shops)
    .set({
      email: "owner@shop.test",
      panNumberEncrypted: encryptPan(PAN),
      panHash: panBlindIndex(PAN),
      panLast4: "234F",
      panHolderName: "Ramesh Patil",
      panStatus: "PENDING_VERIFICATION",
      gstin: "27AAAAA0000A1Z5",
      gstStatus: "PENDING_VERIFICATION",
      shopActNumber: `PII/KOTHRUD/II/${10000 + licence}`,
      shopActKey: `PIIKOTHRUDII${10000 + licence}`,
      approvedBy: approverId,
      statusActorId: approverId,
      feePaymentStatus: "PAID",
    })
    .where(eq(shops.id, shop.id))
    .returning();
  return row;
}

function expectNoInternals(body: Record<string, unknown>, shop?: { panNumberEncrypted: string | null }) {
  for (const key of INTERNAL_KEYS) expect(body).not.toHaveProperty(key);
  const text = JSON.stringify(body);
  expect(text).not.toContain(PAN);
  if (shop?.panNumberEncrypted) expect(text).not.toContain(shop.panNumberEncrypted);
}

function expectPublicShop(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(PUBLIC_SHOP_KEYS);
  const text = JSON.stringify(body);
  expect(text).not.toContain(OWNER_PHONE);
  expect(text).not.toContain("owner@shop.test");
  expect(text).not.toContain("1 Test Road");
}

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

describe("GET /api/shops (public search)", () => {
  it("lists approved shops with card fields only", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const live = await sensitiveShop(owner.id, "APPROVED", owner.id);
    await sensitiveShop(owner.id, "PENDING_APPROVAL");

    const res = await call(shopsGet, "/api/shops");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [card] = res.body;
    expectPublicShop(card);
    expect(card).toMatchObject({
      id: live.id,
      slug: live.slug,
      name: "Test Dairy",
      ownerName: "Owner",
      city: "Pune",
      pincode: "411001",
      deliveryAvailable: true,
      shopType: "DAIRY",
    });
    expect(JSON.stringify(card)).not.toContain(owner.id);
  });
});

describe("GET /api/shops/[id]", () => {
  it("gives anyone an approved shop's public fields, and 404 for a shop that is not live", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const live = await sensitiveShop(owner.id, "APPROVED", owner.id);
    const pending = await sensitiveShop(owner.id, "PENDING_APPROVAL");

    const anon = await call(shopGet, `/api/shops/${live.id}`, { params: { id: live.id } });
    expect(anon.status).toBe(200);
    expectPublicShop(anon.body);
    expect(anon.body.id).toBe(live.id);

    expect((await call(shopGet, `/api/shops/${pending.id}`, { params: { id: pending.id } })).status).toBe(404);

    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    signIn(otherOwner);
    expect((await call(shopGet, `/api/shops/${pending.id}`, { params: { id: pending.id } })).status).toBe(404);
    const asOther = await call(shopGet, `/api/shops/${live.id}`, { params: { id: live.id } });
    expectPublicShop(asOther.body);
  });

  it("gives the owner and staff the shop's details in any status, without internals", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const pending = await sensitiveShop(owner.id, "PENDING_APPROVAL");
    const operator = await createUser({ role: "OPERATOR" });

    for (const viewer of [owner, operator]) {
      signIn(viewer);
      const res = await call(shopGet, `/api/shops/${pending.id}`, { params: { id: pending.id } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: pending.id,
        status: "PENDING_APPROVAL",
        phone: OWNER_PHONE,
        email: "owner@shop.test",
        addressLine1: "1 Test Road",
        panLast4: "234F",
        panStatus: "PENDING_VERIFICATION",
        gstin: "27AAAAA0000A1Z5",
        shopActNumber: pending.shopActNumber,
        serviceRadiusKm: 5,
      });
      expectNoInternals(res.body, pending);
    }
  });
});

describe("the shop owner's action responses", () => {
  it("POST /api/shops returns the new registration without PAN material or the Shop Act key", async () => {
    const owner = await createUser();
    // Seeded by migration 0035; resetDatabase leaves the category list alone.
    const [category] = await db.select({ id: shopCategories.id }).from(shopCategories).limit(1);
    signIn(owner);

    const res = await call(shopsPost, "/api/shops", {
      method: "POST",
      body: {
        name: "Shree Dairy",
        ownerName: "Ramesh Patil",
        phone: "9876543210",
        addressLine1: "12 FC Road",
        city: "Pune",
        pincode: "411004",
        shopType: "DAIRY",
        categoryIds: [category.id],
        panNumber: PAN,
        panHolderName: "Ramesh Patil",
        shopActNumber: "PII/KOTHRUD/II/12345",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      resubmitted: false,
      status: "PENDING_APPROVAL",
      panLast4: "234F",
      panStatus: "PENDING_VERIFICATION",
      shopActNumber: "PII/KOTHRUD/II/12345",
    });
    expect(res.body.registrationNumber).toMatch(/^BKS-/);
    const [stored] = await db.select().from(shops).where(eq(shops.id, res.body.id));
    expect(stored.panNumberEncrypted).toBeTruthy();
    expectNoInternals(res.body, stored);
  });

  it("PATCH /api/shops/[id], POST .../pan and POST .../gst return the shop without internals", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await sensitiveShop(owner.id, "APPROVED", admin.id);
    signIn(owner);
    const params = { id: shop.id };

    const hours = [{ day: 1, open: "07:00", close: "21:00" }];
    const patched = await call(shopPatch, `/api/shops/${shop.id}`, {
      method: "PATCH",
      body: { openingHours: hours },
      params,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.openingHours).toEqual(hours);
    expect(patched.body.phone).toBe(OWNER_PHONE);
    expectNoInternals(patched.body, shop);

    const pan = await call(panPost, `/api/shops/${shop.id}/pan`, {
      method: "POST",
      body: { panNumber: "FGHIJ5678K", holderName: "Ramesh Patil" },
      params,
    });
    expect(pan.status).toBe(200);
    expect(pan.body).toMatchObject({ panLast4: "678K", panStatus: "PENDING_VERIFICATION" });
    const [afterPan] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expectNoInternals(pan.body, afterPan);
    expect(JSON.stringify(pan.body)).not.toContain("FGHIJ5678K");

    const gst = await call(gstPost, `/api/shops/${shop.id}/gst`, {
      method: "POST",
      body: { gstin: "27BBBBB1111B1Z5" },
      params,
    });
    expect(gst.status).toBe(200);
    expect(gst.body).toMatchObject({ gstin: "27BBBBB1111B1Z5", gstStatus: "PENDING_VERIFICATION" });
    expectNoInternals(gst.body, afterPan);

    const none = await call(gstPost, `/api/shops/${shop.id}/gst`, {
      method: "POST",
      body: { notRegistered: true },
      params,
    });
    expect(none.status).toBe(200);
    expect(none.body.gstStatus).toBe("NOT_REGISTERED");
    expectNoInternals(none.body, afterPan);
  });
});

describe("staff action responses", () => {
  it("approve, classification, compliance and the GST/PAN checks return the shop without internals", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shop = await sensitiveShop(owner.id, "PENDING_APPROVAL");
    await verifySellerDocuments(shop.id);
    signIn(operator);
    const params = { id: shop.id };

    const approved = await call(approvePost, `/api/shops/${shop.id}/approve`, {
      method: "POST",
      body: { classification: "GREEN" },
      params,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: shop.id, status: "APPROVED", classification: "GREEN" });
    expect(approved.body.approvedAt).toBeTruthy();
    expectNoInternals(approved.body, shop);

    const classified = await call(classificationPost, `/api/shops/${shop.id}/classification`, {
      method: "POST",
      body: { classification: "KESARI", reason: "Meets the Kesari standard" },
      params,
    });
    expect(classified.status).toBe(200);
    expect(classified.body.classification).toBe("KESARI");
    expectNoInternals(classified.body, shop);

    const compliance = await call(compliancePatch, `/api/shops/${shop.id}/compliance`, {
      method: "PATCH",
      body: { legalBusinessName: "Shree Dairy Pvt Ltd" },
      params,
    });
    expect(compliance.status).toBe(200);
    expect(compliance.body.legalBusinessName).toBe("Shree Dairy Pvt Ltd");
    expectNoInternals(compliance.body, shop);

    const gstVerified = await call(gstVerifyPost, `/api/shops/${shop.id}/gst/verify`, {
      method: "POST",
      body: {},
      params,
    });
    expect(gstVerified.status).toBe(200);
    expect(gstVerified.body.gstStatus).toBe("REGISTERED");
    expectNoInternals(gstVerified.body, shop);

    const panVerified = await call(panVerifyPost, `/api/shops/${shop.id}/pan/verify`, {
      method: "POST",
      params,
    });
    expect(panVerified.status).toBe(200);
    expect(panVerified.body).toMatchObject({ panStatus: "VERIFIED", panLast4: "234F" });
    expectNoInternals(panVerified.body, shop);
    expect(JSON.stringify(panVerified.body)).not.toContain(operator.id);
  });

  it("reject and the GST/PAN rejections return the shop without internals", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shop = await sensitiveShop(owner.id, "PENDING_APPROVAL");
    signIn(operator);
    const params = { id: shop.id };

    const gstRejected = await call(gstRejectPost, `/api/shops/${shop.id}/gst/reject`, {
      method: "POST",
      body: { reason: "GSTIN does not match" },
      params,
    });
    expect(gstRejected.status).toBe(200);
    expect(gstRejected.body.gstStatus).toBe("VERIFICATION_FAILED");
    expectNoInternals(gstRejected.body, shop);

    const panRejected = await call(panRejectPost, `/api/shops/${shop.id}/pan/reject`, {
      method: "POST",
      body: { reason: "Name does not match" },
      params,
    });
    expect(panRejected.status).toBe(200);
    expect(panRejected.body.panStatus).toBe("VERIFICATION_FAILED");
    expectNoInternals(panRejected.body, shop);

    const rejected = await call(rejectPost, `/api/shops/${shop.id}/reject`, {
      method: "POST",
      body: { reason: "Licence photo unreadable" },
      params,
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: "REJECTED", rejectionReason: "Licence photo unreadable" });
    expectNoInternals(rejected.body, shop);
    expect(JSON.stringify(rejected.body)).not.toContain(operator.id);
  });
});
