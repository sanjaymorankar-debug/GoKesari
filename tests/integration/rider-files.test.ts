/**
 * C5 — rider photos, identity documents and ID card.
 *  - Photos and identity documents are never public: GET /api/images/{id} is
 *    signed-in and access-checked (photos: the rider, rider staff, staff of a
 *    verified society that lists the rider; documents: admins only).
 *  - The ID card lists photo, name, rider ID and the verified societies that
 *    list the rider.
 * Rule riderFiles (protectPhotos / kycDocuments / idCard).
 */
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

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

import { GET as adminDocsGet } from "@/app/api/admin/rider-documents/route";
import { POST as myDocsPost } from "@/app/api/delivery-partner/me/documents/route";
import { GET as imageGet } from "@/app/api/images/[id]/route";
import { POST as imageUpload } from "@/app/api/images/route";
import { db } from "@/server/db";
import { auditLogs, deliveryPartnerDocuments, platformSettings, users } from "@/server/db/schema";
import { saveImage } from "@/server/services/image-store";
import {
  getMyRiderIdCard,
  listMyRiderDocuments,
  riderDisplayId,
  uploadMyRiderDocument,
} from "@/server/services/rider-files";
import { updateMyRiderProfile } from "@/server/services/rider-profile";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { addSocietyRider, decideSociety, registerSociety, requestMembership, decideMembership, updateSocietyRider } from "@/server/services/societies";
import { call } from "../helpers/http";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}

type U = { id: string; email: string; name: string | null; role: UserRole };
function signIn(user: U | null) {
  state.session = user
    ? { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } }
    : null;
}

async function clearRule() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "riderFiles"));
  clearRuleCache();
}
beforeEach(async () => {
  await resetDatabase();
  await clearRule();
  state.session = null;
});
afterEach(clearRule);

const getImage = (id: string) => call(imageGet, `/api/images/${id}`, { params: { id } });

async function riderWithPhoto() {
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(riderUser.id);
  const photo = await saveImage(png(300, 300), { purpose: "PROFILE_PHOTO", ownerId: riderUser.id });
  await updateMyRiderProfile(riderUser.id, { profilePhotoUrl: `/api/images/${photo.id}` });
  return { riderUser, partner, photo };
}

async function verifiedSocietyListing(partnerMobile: string) {
  const founder = await createUser({ role: "CUSTOMER" });
  const operator = await createUser({ role: "OPERATOR" });
  const society = await registerSociety(
    { name: "Green Meadows", addressLine1: "Plot 7", area: "Baner", city: "Pune", pincode: "411045" },
    { id: founder.id, role: founder.role },
  );
  await decideSociety(society.id, "verify", { id: operator.id, role: "OPERATOR" });
  const link = await addSocietyRider(society.id, partnerMobile, true, { id: founder.id, role: "SOCIETY_ADMIN" });
  return { founder, operator, society, link };
}

describe("C5 — rider photo is not public", () => {
  it("signed out: 404 (no public link)", async () => {
    const { photo } = await riderWithPhoto();
    const res = await getImage(photo.id);
    expect(res.status).toBe(404);
  });

  it("another customer: 404", async () => {
    const { photo } = await riderWithPhoto();
    signIn(await createUser({ role: "CUSTOMER" }));
    expect((await getImage(photo.id)).status).toBe(404);
  });

  it("the rider, an operator and an admin can open it", async () => {
    const { photo, riderUser } = await riderWithPhoto();
    signIn(riderUser);
    expect((await getImage(photo.id)).status).toBe(200);
    signIn(await createUser({ role: "OPERATOR" }));
    expect((await getImage(photo.id)).status).toBe(200);
    signIn(await createUser({ role: "ADMIN" }));
    expect((await getImage(photo.id)).status).toBe(200);
  });

  it("staff of a verified society that lists the rider can open it; not once the link is revoked", async () => {
    const { photo, partner } = await riderWithPhoto();
    const { founder, link } = await verifiedSocietyListing(partner.mobile);
    signIn(founder);
    expect((await getImage(photo.id)).status).toBe(200);
    await updateSocietyRider(link.id, { revoke: true }, { id: founder.id, role: "SOCIETY_ADMIN" });
    expect((await getImage(photo.id)).status).toBe(404);
  });

  it("a mere resident of that society cannot open it", async () => {
    const { photo, partner } = await riderWithPhoto();
    const { founder, society } = await verifiedSocietyListing(partner.mobile);
    const resident = await createUser({ role: "CUSTOMER" });
    const member = await requestMembership(society.id, { id: resident.id, role: "CUSTOMER" }, "B-1");
    await decideMembership(member.id, true, { id: founder.id, role: "SOCIETY_ADMIN" });
    signIn(resident);
    expect((await getImage(photo.id)).status).toBe(404);
  });

  it("rule protectPhotos off: the original behaviour (anyone with the link)", async () => {
    const { photo } = await riderWithPhoto();
    const admin = await createUser({ role: "ADMIN" });
    await setRule("riderFiles", { protectPhotos: false }, { id: admin.id, role: "ADMIN" });
    expect((await getImage(photo.id)).status).toBe(200);
  });

  it("a rider cannot point their photo at an outside link or someone else's image", async () => {
    const { riderUser } = await riderWithPhoto();
    await expect(updateMyRiderProfile(riderUser.id, { profilePhotoUrl: "https://example.com/me.jpg" })).rejects.toThrow(/Upload your photo/);
    const other = await createUser({ role: "CUSTOMER" });
    const foreign = await saveImage(png(300, 300), { purpose: "RETURN_EVIDENCE", ownerId: other.id });
    await expect(updateMyRiderProfile(riderUser.id, { profilePhotoUrl: `/api/images/${foreign.id}` })).rejects.toThrow(/your own photo/);
  });
});

async function uploadDocViaRoute(rider: U, docType: string) {
  signIn(rider);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(png(800, 500))], "aadhaar.png", { type: "image/png" }));
  form.set("docType", docType);
  const request = new NextRequest("http://localhost/api/delivery-partner/me/documents", { method: "POST", body: form });
  const res = await (myDocsPost as unknown as (r: NextRequest, c: { params: Promise<object> }) => Promise<Response>)(request, {
    params: Promise.resolve({}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("C5 — identity documents are admin-only", () => {
  it("a rider uploads a document; only an admin can open the file (and that is audited)", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    const uploaded = await uploadDocViaRoute(riderUser, "AADHAAR");
    expect(uploaded.status).toBe(201);
    expect(JSON.stringify(uploaded.body)).not.toContain("storedImageId");
    const [doc] = await db.select().from(deliveryPartnerDocuments);
    const fileId = doc.storedImageId;

    signIn(null);
    expect((await getImage(fileId)).status).toBe(404);
    signIn(riderUser);
    expect((await getImage(fileId)).status).toBe(404);
    signIn(await createUser({ role: "OPERATOR" }));
    expect((await getImage(fileId)).status).toBe(404);
    signIn(await createUser({ role: "SOCIETY_ADMIN" }));
    expect((await getImage(fileId)).status).toBe(404);

    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);
    const res = await getImage(fileId);
    expect(res.status).toBe(200);
    const views = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "delivery_partner.document_viewed"), eq(auditLogs.actorId, admin.id)));
    expect(views).toHaveLength(1);
  });

  it("the review list is admin-only: operator 403, admin 200", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    await uploadMyRiderDocument(riderUser.id, "DELIVERY_PARTNER", "PAN", png(800, 500));
    signIn(await createUser({ role: "OPERATOR" }));
    expect((await call(adminDocsGet, "/api/admin/rider-documents")).status).toBe(403);
    signIn(await createUser({ role: "ADMIN" }));
    const res = await call(adminDocsGet, "/api/admin/rider-documents");
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].docType).toBe("PAN");
  });

  it("a non-rider cannot upload rider documents", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    const res = await uploadDocViaRoute(customer, "AADHAAR");
    expect(res.status).toBe(403);
    expect(await db.select().from(deliveryPartnerDocuments)).toHaveLength(0);
  });

  it("the generic image upload refuses the document purpose", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    signIn(riderUser);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png(800, 500))], "x.png", { type: "image/png" }));
    form.set("purpose", "RIDER_KYC_DOC");
    const request = new NextRequest("http://localhost/api/images", { method: "POST", body: form });
    const res = await (imageUpload as unknown as (r: NextRequest, c: { params: Promise<object> }) => Promise<Response>)(request, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(422); // validation error: unknown image purpose
    expect(await db.select().from(deliveryPartnerDocuments)).toHaveLength(0);
  });

  it("uploading the same type again replaces the previous one", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    await uploadMyRiderDocument(riderUser.id, "DELIVERY_PARTNER", "AADHAAR", png(800, 500));
    await uploadMyRiderDocument(riderUser.id, "DELIVERY_PARTNER", "AADHAAR", png(800, 500));
    expect(await listMyRiderDocuments(riderUser.id)).toHaveLength(1);
    expect(await db.select().from(deliveryPartnerDocuments)).toHaveLength(2);
  });

  it("rule kycDocuments off: upload refused", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("riderFiles", { kycDocuments: false }, { id: admin.id, role: "ADMIN" });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    await expect(uploadMyRiderDocument(riderUser.id, "DELIVERY_PARTNER", "AADHAAR", png(800, 500))).rejects.toThrow(/not available/);
  });
});

describe("C5 — rider ID card", () => {
  it("shows photo, name, rider ID and only verified societies with an active listing", async () => {
    const { riderUser, partner, photo } = await riderWithPhoto();
    const { society } = await verifiedSocietyListing(partner.mobile);
    // A second society that lists the rider but is then suspended does not count.
    const founder2 = await createUser({ role: "CUSTOMER" });
    const operator = await createUser({ role: "OPERATOR" });
    const other = await registerSociety(
      { name: "Blue Hills", addressLine1: "Plot 9", city: "Pune", pincode: "411045" },
      { id: founder2.id, role: founder2.role },
    );
    await decideSociety(other.id, "verify", { id: operator.id, role: "OPERATOR" });
    await addSocietyRider(other.id, partner.mobile, false, { id: founder2.id, role: "SOCIETY_ADMIN" });
    await decideSociety(other.id, "suspend", { id: operator.id, role: "OPERATOR" }, "Review");

    const card = await getMyRiderIdCard(riderUser.id);
    expect(card).not.toBeNull();
    expect(card!.fullName).toBe(partner.fullName);
    expect(card!.riderId).toBe(riderDisplayId(partner.id));
    expect(card!.riderId).toMatch(/^GKR-[0-9A-F]{8}$/);
    expect(card!.photoUrl).toBe(`/api/images/${photo.id}`);
    expect(card!.societies.map((s) => s.name)).toEqual([society.name]);
  });

  it("not issued to a rider who is not approved, or when the rule is off", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { status: "UNDER_REVIEW" });
    expect(await getMyRiderIdCard(riderUser.id)).toBeNull();
    const approved = await riderWithPhoto();
    const admin = await createUser({ role: "ADMIN" });
    await setRule("riderFiles", { idCard: false }, { id: admin.id, role: "ADMIN" });
    expect(await getMyRiderIdCard(approved.riderUser.id)).toBeNull();
  });

  it("an outside photo link is not shown on the card while photos are protected", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id);
    await db.update(users).set({ name: "R" }).where(eq(users.id, riderUser.id));
    const { deliveryPartners } = await import("@/server/db/schema");
    await db.update(deliveryPartners).set({ profilePhotoUrl: "https://example.com/me.jpg" }).where(eq(deliveryPartners.userId, riderUser.id));
    expect((await getMyRiderIdCard(riderUser.id))!.photoUrl).toBeNull();
  });
});
