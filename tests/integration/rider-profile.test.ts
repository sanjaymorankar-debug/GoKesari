/** F2 — rider self-edit: everyday fields apply at once; identity/bank changes wait for admin review. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { decryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { auditLogs, deliveryPartnerChangeRequests, deliveryPartners } from "@/server/db/schema";
import {
  decideChangeRequest,
  getMyLatestChangeRequest,
  listPendingChangeRequests,
  requestSensitiveChange,
  updateMyRiderProfile,
} from "@/server/services/rider-profile";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);

async function setup() {
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(riderUser.id);
  const admin = await createUser({ role: "ADMIN" });
  return { riderUser, partner, admin: { id: admin.id, role: "ADMIN" as const } };
}

describe("updateMyRiderProfile", () => {
  it("applies everyday fields immediately and audits field names only", async () => {
    const { riderUser, partner } = await setup();
    const updated = await updateMyRiderProfile(riderUser.id, {
      fullName: "Ravi Kumar",
      mobile: "98765 43211",
      vehicleType: "SCOOTER",
      vehicleRegistrationNumber: "mh12 ab 1234",
      operatingRadiusKm: 8,
      profilePhotoUrl: "/api/images/abc",
    });
    expect(updated).toMatchObject({
      fullName: "Ravi Kumar",
      mobile: "9876543211",
      vehicleType: "SCOOTER",
      vehicleRegistrationNumber: "MH12 AB 1234",
      operatingRadiusKm: 8,
    });
    expect(updated).not.toHaveProperty("bankAccountNumberEncrypted");
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, partner.id));
    expect(JSON.stringify(audit.newValue)).not.toContain("9876543211");
  });

  it("validates input", async () => {
    const { riderUser } = await setup();
    await expect(updateMyRiderProfile(riderUser.id, { mobile: "12345" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateMyRiderProfile(riderUser.id, { operatingRadiusKm: 500 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateMyRiderProfile(riderUser.id, { profilePhotoUrl: "javascript:alert(1)" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses someone who is not a rider", async () => {
    const stranger = await createUser();
    await expect(updateMyRiderProfile(stranger.id, { fullName: "X Y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("sensitive changes", () => {
  it("are held for review, encrypted, and only applied on approval", async () => {
    const { riderUser, partner, admin } = await setup();
    const req = await requestSensitiveChange(riderUser.id, { bankAccountNumber: "123456789012", bankIfsc: "sbin0001234" });
    expect(req.status).toBe("PENDING");
    expect(req.payloadEncrypted).not.toContain("123456789012");
    expect(req.masked).toEqual({ bankAccountNumber: "…9012", bankIfsc: "…1234" });

    let [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(row.bankAccountNumberEncrypted).toBeNull();

    const queue = await listPendingChangeRequests(admin);
    expect(queue).toHaveLength(1);
    expect(queue[0]).not.toHaveProperty("payloadEncrypted");

    await decideChangeRequest(req.id, { decision: "approve" }, admin);
    [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(decryptSecret(row.bankAccountNumberEncrypted!)).toBe("123456789012");
    expect(decryptSecret(row.bankIfscEncrypted!)).toBe("SBIN0001234");
  });

  it("a new request supersedes a pending one; rejection needs a reason and leaves details unchanged", async () => {
    const { riderUser, partner, admin } = await setup();
    const first = await requestSensitiveChange(riderUser.id, { panNumber: "ABCPE1234F" });
    const second = await requestSensitiveChange(riderUser.id, { panNumber: "ABCPE1235F" });
    const [old] = await db.select().from(deliveryPartnerChangeRequests).where(eq(deliveryPartnerChangeRequests.id, first.id));
    expect(old.status).toBe("SUPERSEDED");

    await expect(decideChangeRequest(second.id, { decision: "reject" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await decideChangeRequest(second.id, { decision: "reject", reason: "PAN card photo unclear" }, admin);
    const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(row.panNumberEncrypted).toBeNull();
    expect(await getMyLatestChangeRequest(riderUser.id)).toMatchObject({ status: "REJECTED", rejectionReason: "PAN card photo unclear" });
    await expect(decideChangeRequest(second.id, { decision: "approve" }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates PAN and IFSC shape, and only admins can review", async () => {
    const { riderUser } = await setup();
    await expect(requestSensitiveChange(riderUser.id, { panNumber: "BAD" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(requestSensitiveChange(riderUser.id, { bankIfsc: "12" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(requestSensitiveChange(riderUser.id, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const req = await requestSensitiveChange(riderUser.id, { drivingLicenceNumber: "MH1220110012345" });
    await expect(
      decideChangeRequest(req.id, { decision: "approve" }, { id: riderUser.id, role: "DELIVERY_PARTNER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
