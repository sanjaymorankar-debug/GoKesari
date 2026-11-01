/**
 * Gig worker flow, partner side (docs/gig-worker-2026-10): features 1–5 —
 * registration details and the duplicate-mobile check, PAN and Aadhaar KYC
 * with consent (Aadhaar never stored), police verification documents in
 * private storage, location at sign-up, and the Offline / Active / Ready
 * toggle with its verification gate. KYC runs on the in-process mock vendor.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST as registerRoute } from "@/app/api/delivery-partner/route";
import { PATCH as partnerAdminRoute } from "@/app/api/delivery-partner/[id]/route";
import { PATCH as statusRoute } from "@/app/api/delivery-partner/status/route";
import { POST as backgroundDocsRoute } from "@/app/api/delivery-partner/me/background-docs/route";
import { GET as backgroundFileRoute } from "@/app/api/admin/rider-background-docs/[id]/file/route";
import { POST as panRoute } from "@/app/api/delivery-partner/me/kyc/pan/route";
import { decryptSecret } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, deliveryPartnerBackgroundDocs, deliveryPartnerKycChecks, deliveryPartners } from "@/server/db/schema";
import { decideMockDigilocker, MOCK_AADHAAR_OTP } from "@/server/kyc/adapters/mock";
import {
  approveDeliveryPartner,
  getAvailabilityGate,
  goOffline,
  goOnline,
  registerDeliveryPartner,
  setAvailabilityOverride,
} from "@/server/services/delivery-partners";
import { decideBackgroundDoc, isRiderBackgroundApproved, listMyBackgroundDocs, uploadMyBackgroundDoc } from "@/server/services/rider-background-docs";
import {
  confirmMyAadhaarOtp,
  decideRiderKycCheck,
  getMyRiderKyc,
  isRiderKycComplete,
  requestMyAadhaarOtp,
  startMyAadhaarDigilocker,
  syncMyAadhaarDigilocker,
  verifyMyPan,
} from "@/server/services/rider-kyc";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { addRiderIdentityDocument, createUser, FULL_RIDER_REGISTRATION, resetDatabase } from "../helpers/fixtures";

const AADHAAR = "234123412346"; // well-formed (Verhoeff check digit) test number
const PAN = "ABCDE1234F";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 0x20), Buffer.from("\n%%EOF")]);

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(40)]);

function signInAs(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function multipart(path: string, fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request(`http://localhost${path}`, { method: "POST", body: form });
}

const base = { fullName: "Ravi Kumar", mobile: "9876543210", vehicleType: "MOTORCYCLE" as const };

async function approvedRider(mobile = "9876543210") {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const admin = await createUser({ role: "ADMIN" });
  const partner = await registerDeliveryPartner(user.id, { ...base, mobile, ...FULL_RIDER_REGISTRATION });
  await addRiderIdentityDocument(partner.id);
  await approveDeliveryPartner(partner.id, { id: admin.id, role: "ADMIN" });
  return { user, admin, partner, adminActor: { id: admin.id, role: "ADMIN" as const } };
}

/** PAN + Aadhaar verified and both documents approved: everything the gate asks for. */
async function fullyVerified(userId: string, adminActor: { id: string; role: "ADMIN" }) {
  await verifyMyPan(userId, { pan: PAN, consentGiven: true });
  // Aadhaar by DigiLocker (the default method), approved on the mock consent page.
  const started = await startMyAadhaarDigilocker(userId, { consentGiven: true });
  decideMockDigilocker(new URL(started.url!).searchParams.get("session")!, "approve");
  await syncMyAadhaarDigilocker(userId);
  for (const type of ["POLICE_VERIFICATION", "CHARACTER_CERTIFICATE"] as const) {
    const doc = await uploadMyBackgroundDoc(userId, "DELIVERY_PARTNER", type, PDF);
    await decideBackgroundDoc(doc.id, "APPROVED", null, adminActor);
  }
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  clearRuleCache();
});

/* ---------------------------------------------------------- feature 1 */

describe("feature 1 — registration with personal details", () => {
  it("the API needs every detail of the brief, each with its own field message", async () => {
    const applicant = await createUser({ role: "CUSTOMER" });
    signInAs(applicant, "CUSTOMER");
    const missing = await call(registerRoute, "/api/delivery-partner", { method: "POST", body: base });
    expect(missing.status).toBe(422);
    const fields = missing.body.error.details.fields;
    for (const field of ["email", "dateOfBirth", "gender", "addressLine", "addressCity", "addressPincode", "vehicleRegistrationNumber", "emergencyContactName", "emergencyContactMobile", "location"]) {
      expect(fields[field], field).toEqual(expect.any(String));
    }

    const ok = await call(registerRoute, "/api/delivery-partner", { method: "POST", body: { ...base, ...FULL_RIDER_REGISTRATION } });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, ok.body.id));
    expect(row).toMatchObject({
      email: "rider@example.test",
      dateOfBirth: "1995-04-12",
      gender: "MALE",
      addressLine: "Flat 4, Shivaji Nagar, Near Bus Stand",
      addressCity: "Pune",
      addressPincode: "411005",
      vehicleRegistrationNumber: "MH12 AB 1234",
      emergencyContactName: "Sunita Kumar",
      emergencyContactMobile: "9822012345",
    });
  });

  it("refuses an under-18 date of birth, a bad PIN code and an emergency number equal to the partner's own", async () => {
    const user = await createUser();
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - 17);
    const cases: [string, Record<string, unknown>][] = [
      ["dateOfBirth", { dateOfBirth: tooYoung.toISOString().slice(0, 10) }],
      ["addressPincode", { addressPincode: "01234" }],
      ["emergencyContactMobile", { emergencyContactMobile: base.mobile }],
      ["vehicleRegistrationNumber", { vehicleRegistrationNumber: "NOT A PLATE!" }],
      ["gender", { gender: "ROBOT" }],
    ];
    for (const [field, bad] of cases) {
      await expect(
        registerDeliveryPartner(user.id, { ...base, ...FULL_RIDER_REGISTRATION, ...bad }, { required: true }),
        field,
      ).rejects.toMatchObject({ status: 422, details: { fields: { [field]: expect.any(String) } } });
    }
    // A bicycle needs no registration number.
    const cyclist = await registerDeliveryPartner(
      (await createUser()).id,
      { ...base, ...FULL_RIDER_REGISTRATION, vehicleType: "BICYCLE", vehicleRegistrationNumber: null },
      { required: true },
    );
    expect(cyclist.vehicleType).toBe("BICYCLE");
  });

  it("one partner per mobile number, across accounts (duplicate-mobile check)", async () => {
    await registerDeliveryPartner((await createUser()).id, { ...base, ...FULL_RIDER_REGISTRATION });
    await expect(registerDeliveryPartner((await createUser()).id, { ...base, ...FULL_RIDER_REGISTRATION })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { fields: { mobile: expect.stringContaining("already registered") } },
    });
  });
});

/* ---------------------------------------------------------- feature 4 */

describe("feature 4 — location at registration", () => {
  it("is required through the API, with a clear message, and saved with its time", async () => {
    const applicant = await createUser({ role: "CUSTOMER" });
    signInAs(applicant, "CUSTOMER");
    const noLocation = { ...FULL_RIDER_REGISTRATION, latitude: null, longitude: null };
    const refused = await call(registerRoute, "/api/delivery-partner", { method: "POST", body: { ...base, ...noLocation } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.fields.location).toMatch(/Share your current location/);

    const saved = await call(registerRoute, "/api/delivery-partner", { method: "POST", body: { ...base, ...FULL_RIDER_REGISTRATION } });
    expect(saved.status).toBe(201);
    const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, saved.body.id));
    expect(row.latitude).toBe("18.53");
    expect(row.longitude).toBe("73.85");
    expect(row.registrationLocationAt).toBeInstanceOf(Date);
  });
});

/* ---------------------------------------------------------- feature 2 */

describe("feature 2 — PAN and Aadhaar authorisation", () => {
  it("nothing is checked without consent", async () => {
    const { user } = await approvedRider();
    await expect(verifyMyPan(user.id, { pan: PAN, consentGiven: false })).rejects.toMatchObject({ status: 422 });
    await expect(requestMyAadhaarOtp(user.id, { aadhaar: AADHAAR, consentGiven: false })).rejects.toMatchObject({ status: 422 });
    await expect(startMyAadhaarDigilocker(user.id, { consentGiven: false })).rejects.toMatchObject({ status: 422 });
    signInAs(user, "DELIVERY_PARTNER");
    expect((await call(panRoute, "/api/delivery-partner/me/kyc/pan", { method: "POST", body: { pan: PAN, consent: false } })).status).toBe(422);
    expect(await db.select().from(deliveryPartnerKycChecks)).toHaveLength(0);
  });

  it("PAN: Verified through the provider, stored encrypted and masked, with the consent recorded", async () => {
    const { user, partner } = await approvedRider();
    const check = await verifyMyPan(user.id, { pan: "abcde1234f", consentGiven: true, ipAddress: "203.0.113.9" });
    expect(check).toMatchObject({ docType: "PAN", status: "VERIFIED", numberMasked: "XXXXX1234F" });
    const [row] = await db.select().from(deliveryPartnerKycChecks).where(eq(deliveryPartnerKycChecks.id, check.id));
    expect(row.numberEncrypted).not.toContain(PAN);
    expect(decryptSecret(row.numberEncrypted!)).toBe(PAN);
    expect(row).toMatchObject({ provider: "mock", consentVersion: expect.any(String), consentIp: "203.0.113.9" });
    expect(row.consentGivenAt).toBeInstanceOf(Date);
    const [p] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(decryptSecret(p.panNumberEncrypted!)).toBe(PAN);
    expect(p.panNumber).toBeNull();
  });

  it("PAN: Failed when the record has no such number; Pending when the name doesn't match", async () => {
    const { user } = await approvedRider();
    expect(await verifyMyPan(user.id, { pan: "ABCDE0000F", consentGiven: true })).toMatchObject({ status: "FAILED", errorCode: "not_found_at_source" });
    // Mock …7777: the record carries another name → Pending for an admin.
    expect(await verifyMyPan(user.id, { pan: "ABCDE7777F", consentGiven: true })).toMatchObject({ status: "PENDING", errorCode: "name_mismatch" });
  });

  it("Aadhaar (legacy OTP method): OTP, then Verified — and the number is never stored, only masked and tokenised", async () => {
    const { user, partner, adminActor } = await approvedRider();
    await setRule("riderVerification", { aadhaarMethod: "okyc_legacy" }, adminActor);
    const sent = await requestMyAadhaarOtp(user.id, { aadhaar: "2341 2341 2346", consentGiven: true });
    expect(sent).toMatchObject({ docType: "AADHAAR", status: "PENDING", awaitingOtp: true, numberMasked: "XXXX XXXX 2346" });

    expect(await confirmMyAadhaarOtp(user.id, "999999")).toMatchObject({ status: "PENDING", errorCode: "otp_invalid", awaitingOtp: true });
    const verified = await confirmMyAadhaarOtp(user.id, MOCK_AADHAAR_OTP);
    expect(verified).toMatchObject({ status: "VERIFIED", awaitingOtp: false });

    const [row] = await db.select().from(deliveryPartnerKycChecks).where(eq(deliveryPartnerKycChecks.id, verified.id));
    expect(row.numberEncrypted).toBeNull();
    expect(JSON.stringify(row)).not.toContain(AADHAAR);
    expect(row.numberToken).toMatch(/^[0-9a-f]{64}$/);
    // The partner's row and the audit log never carry it either.
    const [p] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(JSON.stringify(p)).not.toContain(AADHAAR);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, partner.id));
    expect(JSON.stringify(audits)).not.toContain(AADHAAR);
    expect((await getMyRiderKyc(user.id)).aadhaar?.status).toBe("VERIFIED");
  });

  it("the database itself refuses an Aadhaar row with a stored number", async () => {
    const { partner } = await approvedRider();
    await expect(
      db.insert(deliveryPartnerKycChecks).values({
        deliveryPartnerId: partner.id,
        docType: "AADHAAR",
        numberMasked: "XXXX XXXX 2346",
        numberToken: "t",
        numberEncrypted: "anything",
        provider: "mock",
        consentVersion: "v",
        consentGivenAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("too many wrong OTPs lock the attempt; an Aadhaar verified for one partner fails for another; an admin can decide by hand", async () => {
    const first = await approvedRider("9876543210");
    await setRule("riderVerification", { aadhaarMethod: "okyc_legacy" }, first.adminActor);
    await requestMyAadhaarOtp(first.user.id, { aadhaar: AADHAAR, consentGiven: true });
    await confirmMyAadhaarOtp(first.user.id, "111111");
    await confirmMyAadhaarOtp(first.user.id, "222222");
    expect(await confirmMyAadhaarOtp(first.user.id, "333333")).toMatchObject({ errorCode: "otp_locked", awaitingOtp: false });
    await expect(confirmMyAadhaarOtp(first.user.id, MOCK_AADHAAR_OTP)).rejects.toMatchObject({ code: "CONFLICT" });

    // A new OTP after the cooldown, then verified.
    await db.update(deliveryPartnerKycChecks).set({ otpRequestedAt: new Date(Date.now() - 120_000) });
    await requestMyAadhaarOtp(first.user.id, { aadhaar: AADHAAR, consentGiven: true });
    expect((await confirmMyAadhaarOtp(first.user.id, MOCK_AADHAAR_OTP)).status).toBe("VERIFIED");

    const second = await approvedRider("9876543211");
    expect(await requestMyAadhaarOtp(second.user.id, { aadhaar: AADHAAR, consentGiven: true })).toMatchObject({
      status: "FAILED",
      errorCode: "already_used",
    });

    const pending = await verifyMyPan(second.user.id, { pan: "ABCDE7777F", consentGiven: true });
    await expect(decideRiderKycCheck(pending.id, "VERIFIED", "ok", { id: second.user.id, role: "OPERATOR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await decideRiderKycCheck(pending.id, "VERIFIED", "Name matches the PAN card photo", second.adminActor)).toMatchObject({ status: "VERIFIED" });
  });
});

/* ---------------------------------------------------------- feature 3 */

describe("feature 3 — police verification form and character certificate", () => {
  it("accepts PDF, JPG and PNG only, within the configured size, decided from the bytes", async () => {
    const { user, adminActor } = await approvedRider();
    expect((await uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", PDF)).contentType).toBe("application/pdf");
    expect((await uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "CHARACTER_CERTIFICATE", png(800, 600))).contentType).toBe("image/png");
    await expect(uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", WEBP)).rejects.toMatchObject({ status: 422 });
    await expect(uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", Buffer.from("plain text, named .pdf"))).rejects.toMatchObject({
      status: 422,
    });
    await setRule("riderVerification", { maxDocumentBytes: 100_000 }, adminActor);
    await expect(
      uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", Buffer.concat([PDF, Buffer.alloc(200_000)])),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("0.1 MB") });

    // Through the route, as the app sends it.
    signInAs(user, "DELIVERY_PARTNER");
    const res = await backgroundDocsRoute(
      multipart("/api/delivery-partner/me/background-docs", { docType: "POLICE_VERIFICATION", file: new Blob([PDF], { type: "application/pdf" }) }) as never,
    );
    expect(res.status).toBe(201);
  });

  it("is stored encrypted, opens for an admin only (audited), and moves Uploaded → Under review → Rejected / Approved", async () => {
    const { user, admin, adminActor } = await approvedRider();
    const doc = await uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", PDF);
    expect(doc.status).toBe("UPLOADED");
    const [stored] = await db.select().from(deliveryPartnerBackgroundDocs).where(eq(deliveryPartnerBackgroundDocs.id, doc.id));
    expect(stored.dataEncrypted.includes(Buffer.from("%PDF-"))).toBe(false);

    const operator = await createUser({ role: "OPERATOR" });
    signInAs(operator, "OPERATOR");
    expect((await call(backgroundFileRoute as never, `/api/admin/rider-background-docs/${doc.id}/file`, { params: { id: doc.id } })).status).toBe(403);
    signInAs(user, "DELIVERY_PARTNER");
    expect((await call(backgroundFileRoute as never, `/api/admin/rider-background-docs/${doc.id}/file`, { params: { id: doc.id } })).status).toBe(403);
    signInAs(admin, "ADMIN");
    const opened = await backgroundFileRoute(new Request(`http://localhost/api/admin/rider-background-docs/${doc.id}/file`) as never, {
      params: Promise.resolve({ id: doc.id }),
    } as never);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("application/pdf");
    expect(opened.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await opened.arrayBuffer()).equals(PDF)).toBe(true);
    const viewed = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, doc.id), eq(auditLogs.action, "delivery_partner.background_doc_viewed")));
    expect(viewed).toHaveLength(1);

    expect((await decideBackgroundDoc(doc.id, "UNDER_REVIEW", null, adminActor)).status).toBe("UNDER_REVIEW");
    await expect(decideBackgroundDoc(doc.id, "REJECTED", "  ", adminActor)).rejects.toMatchObject({ status: 422 });
    const rejected = await decideBackgroundDoc(doc.id, "REJECTED", "Stamp is not readable", adminActor);
    expect(rejected).toMatchObject({ status: "REJECTED", rejectionReason: "Stamp is not readable" });

    // A new upload replaces it and starts again at Uploaded.
    const again = await uploadMyBackgroundDoc(user.id, "DELIVERY_PARTNER", "POLICE_VERIFICATION", PDF);
    expect((await listMyBackgroundDocs(user.id)).map((d) => [d.id, d.status])).toEqual([[again.id, "UPLOADED"]]);
    expect((await decideBackgroundDoc(again.id, "APPROVED", null, adminActor)).status).toBe("APPROVED");
  });
});

/* ---------------------------------------------------------- feature 5 */

describe("feature 5 — Offline / Active / Ready toggle", () => {
  it("Active and Ready are blocked until KYC and police verification are approved", async () => {
    const { user, partner, adminActor } = await approvedRider();
    await expect(goOnline(user.id, 18.52, 73.85, "READY")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("KYC") });
    await expect(goOnline(user.id, 18.52, 73.85, "ACTIVE")).rejects.toMatchObject({ code: "CONFLICT" });

    await fullyVerified(user.id, adminActor);
    expect(await isRiderKycComplete(partner.id)).toBe(true);
    expect(await isRiderBackgroundApproved(partner.id)).toBe(true);
    expect(await goOnline(user.id, 18.52, 73.85, "ACTIVE")).toMatchObject({ availability: "ACTIVE", isOnline: true });
    expect(await goOnline(user.id, 18.52, 73.85, "READY")).toMatchObject({ availability: "READY", isOnline: true });
    expect(await goOffline(user.id)).toMatchObject({ availability: "OFFLINE", isOnline: false });
  });

  it("the toggle route takes offline / active / ready; an admin (not an operator) can override the gate", async () => {
    const { user, partner, admin } = await approvedRider();
    signInAs(user, "DELIVERY_PARTNER");
    const blocked = await call(statusRoute, "/api/delivery-partner/status", { method: "PATCH", body: { action: "ready", latitude: 18.52, longitude: 73.85 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.missing).toHaveLength(2);

    const operator = await createUser({ role: "OPERATOR" });
    signInAs(operator, "OPERATOR");
    const denied = await call(partnerAdminRoute, `/api/delivery-partner/${partner.id}`, {
      method: "PATCH",
      params: { id: partner.id },
      body: { action: "override_availability", enabled: true, reason: "trial" },
    });
    expect(denied.status).toBe(403);
    signInAs(admin, "ADMIN");
    const overridden = await call(partnerAdminRoute, `/api/delivery-partner/${partner.id}`, {
      method: "PATCH",
      params: { id: partner.id },
      body: { action: "override_availability", enabled: true, reason: "Police verification submitted at the station; receipt seen" },
    });
    expect(overridden.status).toBe(200);
    expect(overridden.body).toMatchObject({ availabilityOverridden: true });

    signInAs(user, "DELIVERY_PARTNER");
    for (const action of ["active", "ready", "offline"]) {
      const res = await call(statusRoute, "/api/delivery-partner/status", {
        method: "PATCH",
        body: action === "offline" ? { action } : { action, latitude: 18.52, longitude: 73.85 },
      });
      expect(res.status, action).toBe(200);
      expect(res.body.availability).toBe(action.toUpperCase());
    }
    await setAvailabilityOverride(partner.id, false, "receipt was not genuine", { id: admin.id, role: "ADMIN" });
    expect((await getAvailabilityGate((await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, partner.id) }))!)).allowed).toBe(false);
  });

  it("with the gate rule off, approved partners go online as before", async () => {
    const { user, adminActor } = await approvedRider();
    await setRule("riderVerification", { gateAvailability: false }, adminActor);
    expect((await goOnline(user.id, 18.52, 73.85)).availability).toBe("READY");
    // `is_online` keeps tracking availability for every older reader.
    const [{ online }] = await db.execute<{ online: boolean }>(sql`select bool_and(is_online = (availability <> 'OFFLINE')) as online from delivery_partners`);
    expect(online).toBe(true);
  });
});
