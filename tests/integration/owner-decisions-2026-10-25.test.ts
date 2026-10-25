/**
 * Defects settled by the owner on 25 Oct 2026 (docs/testing/qa-defects.json).
 * Real PostgreSQL; runs on one database and on the split layout.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryPartnerDocuments } from "@/server/db/schema";
import { approveDeliveryPartner, registerDeliveryPartner } from "@/server/services/delivery-partners";
import { addRiderIdentityDocument, createUser, resetDatabase } from "../helpers/fixtures";

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
