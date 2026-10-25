/**
 * Delivery partner registration & verification (delivery-system Part 58
 * follow-up, Slice B).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import {
  approveDeliveryPartner,
  countDeliveryPartnersByStatus,
  deactivateDeliveryPartner,
  getMyDeliveryPartnerProfile,
  listDeliveryPartners,
  reactivateDeliveryPartner,
  registerDeliveryPartner,
  rejectDeliveryPartner,
  requireOwnDeliveryPartnerProfile,
  startDeliveryPartnerReview,
  suspendDeliveryPartner,
} from "@/server/services/delivery-partners";
import { createUser, resetDatabase } from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

const baseInput = {
  fullName: "Ravi Kumar",
  mobile: "9876543210",
  vehicleType: "MOTORCYCLE" as const,
};

function mockGeocodeSuccess() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "OK", results: [{ formatted_address: "Somewhere" }] }),
    }),
  );
}

describe("registerDeliveryPartner", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.unstubAllGlobals());

  it("registers with status REGISTERED and promotes a customer to DELIVERY_PARTNER", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const partner = await registerDeliveryPartner(user.id, baseInput);

    expect(partner.status).toBe("REGISTERED");
    expect(partner.userId).toBe(user.id);

    const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id));
    expect(account.role).toBe("DELIVERY_PARTNER");
  });

  it("does not downgrade an operator/admin's role", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await registerDeliveryPartner(admin.id, baseInput);

    const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, admin.id));
    expect(account.role).toBe("ADMIN");
  });

  it("rejects an invalid mobile number", async () => {
    const user = await createUser();
    await expect(
      registerDeliveryPartner(user.id, { ...baseInput, mobile: "12345" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects an invalid vehicle type", async () => {
    const user = await createUser();
    await expect(
      registerDeliveryPartner(user.id, { ...baseInput, vehicleType: "SPACESHIP" as never }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a second application from the same user", async () => {
    const user = await createUser();
    await registerDeliveryPartner(user.id, baseInput);
    await expect(registerDeliveryPartner(user.id, baseInput)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("saves unverified when no coordinates are supplied, GOOGLE_VERIFIED when they geocode", async () => {
    const noCoords = await createUser();
    const withoutCoords = await registerDeliveryPartner(noCoords.id, baseInput);
    expect(withoutCoords.locationVerified).toBe(false);

    mockGeocodeSuccess();
    const withCoords = await createUser();
    const verified = await registerDeliveryPartner(withCoords.id, {
      ...baseInput,
      latitude: 18.55,
      longitude: 73.93,
    });
    expect(verified.locationVerified).toBe(true);
    expect(verified.locationSource).toBe("GOOGLE_VERIFIED");
  });

  it("defaults the operating radius to 5km", async () => {
    const user = await createUser();
    const partner = await registerDeliveryPartner(user.id, baseInput);
    expect(partner.operatingRadiusKm).toBe(5);
  });
});

describe("verification state machine", () => {
  beforeEach(resetDatabase);

  it("approves directly from REGISTERED", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    const approved = await approveDeliveryPartner(partner.id, ADMIN(admin.id), "Looks good");
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewNotes).toBe("Looks good");
  });

  it("moves REGISTERED to UNDER_REVIEW then APPROVED", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    const underReview = await startDeliveryPartnerReview(partner.id, ADMIN(admin.id), "Checking documents");
    expect(underReview.status).toBe("UNDER_REVIEW");

    const approved = await approveDeliveryPartner(partner.id, ADMIN(admin.id));
    expect(approved.status).toBe("APPROVED");
  });

  it("rejects with a reason and requires one", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    await expect(rejectDeliveryPartner(partner.id, "", ADMIN(admin.id))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    const rejected = await rejectDeliveryPartner(partner.id, "Documents unclear", ADMIN(admin.id));
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Documents unclear");
  });

  it("suspends only an APPROVED partner, then reactivates back to APPROVED", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    await expect(
      suspendDeliveryPartner(partner.id, "policy violation", ADMIN(admin.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await approveDeliveryPartner(partner.id, ADMIN(admin.id));
    const suspended = await suspendDeliveryPartner(partner.id, "policy violation", ADMIN(admin.id));
    expect(suspended.status).toBe("SUSPENDED");

    const reactivated = await reactivateDeliveryPartner(partner.id, "appeal accepted", ADMIN(admin.id));
    expect(reactivated.status).toBe("APPROVED");
  });

  it("cannot reactivate a partner that was never suspended", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    await expect(reactivateDeliveryPartner(partner.id, "appeal accepted", ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("deactivate is terminal — no further transitions accepted", async () => {
    const applicant = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const partner = await registerDeliveryPartner(applicant.id, baseInput);

    const deactivated = await deactivateDeliveryPartner(partner.id, "requested by partner", ADMIN(admin.id));
    expect(deactivated.status).toBe("DEACTIVATED");

    await expect(approveDeliveryPartner(partner.id, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("queries and ownership", () => {
  beforeEach(resetDatabase);

  it("getMyDeliveryPartnerProfile returns null when the user hasn't applied", async () => {
    const user = await createUser();
    expect(await getMyDeliveryPartnerProfile(user.id)).toBeNull();
  });

  it("listDeliveryPartners filters by status", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const a = await createUser();
    const b = await createUser();
    const partnerA = await registerDeliveryPartner(a.id, baseInput);
    await registerDeliveryPartner(b.id, baseInput);
    await approveDeliveryPartner(partnerA.id, ADMIN(admin.id));

    const approved = await listDeliveryPartners({ status: "APPROVED" });
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe(partnerA.id);

    const registered = await listDeliveryPartners({ status: "REGISTERED" });
    expect(registered).toHaveLength(1);
  });

  it("countDeliveryPartnersByStatus tallies correctly", async () => {
    const a = await createUser();
    const b = await createUser();
    await registerDeliveryPartner(a.id, baseInput);
    await registerDeliveryPartner(b.id, baseInput);

    const counts = await countDeliveryPartnersByStatus();
    expect(counts.REGISTERED).toBe(2);
  });

  it("requireOwnDeliveryPartnerProfile refuses another user's profile", async () => {
    const owner = await createUser();
    const attacker = await createUser();
    const partner = await registerDeliveryPartner(owner.id, baseInput);

    await expect(
      requireOwnDeliveryPartnerProfile(attacker.id, partner.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const mine = await requireOwnDeliveryPartnerProfile(owner.id, partner.id);
    expect(mine.id).toBe(partner.id);
  });
});
