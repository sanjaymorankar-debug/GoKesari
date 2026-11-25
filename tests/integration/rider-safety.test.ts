/**
 * Rider App v2 — SOS, emergency contact and insurance (rules riderSos / riderInsurance, off by default).
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { auditLogs, notifications, platformSettings, riderInsurancePolicies, riderNominees, riderSosEvents } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { getMyInsuranceView, saveMyNominee, savePolicy } from "@/server/services/rider-insurance";
import { acknowledgeSos, closeSos, getMySosStatus, listSosEvents, raiseSos, updateMyEmergencyContact } from "@/server/services/rider-sos";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeEach(async () => {
  await resetDatabase();
  await db.delete(riderInsurancePolicies);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["riderSos", "riderInsurance"]));
  clearRuleCache();
});

async function setup() {
  const admin = await createUser({ role: "ADMIN" });
  const operator = await createUser({ role: "OPERATOR" });
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(riderUser.id);
  return { admin, operator, rider: { id: riderUser.id, role: "DELIVERY_PARTNER" as const }, partner };
}

describe("rider SOS", () => {
  it("is refused while the rule is off", async () => {
    const { rider } = await setup();
    await expect(raiseSos(rider, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("alerts support once, keeps one open event, and tells the rider on acknowledge", async () => {
    const { admin, operator, rider, partner } = await setup();
    await setRule("riderSos", { enabled: true, emergencyNumber: "112" }, { id: admin.id, role: "ADMIN" });

    const first = await raiseSos(rider, { latitude: 18.52, longitude: 73.85, accuracyM: 20 });
    expect(first).toMatchObject({ emergencyNumber: "112", status: "OPEN", alreadyOpen: false });
    const again = await raiseSos(rider, {});
    expect(again).toMatchObject({ id: first.id, alreadyOpen: true });
    expect(await db.select().from(riderSosEvents).where(eq(riderSosEvents.deliveryPartnerId, partner.id))).toHaveLength(1);

    const alerts = await db.select().from(notifications).where(eq(notifications.type, NOTIFICATION_TYPES.RIDER_SOS_RAISED));
    expect(alerts.map((n) => n.userId).sort()).toEqual([admin.id, operator.id].sort());
    expect(alerts[0].body).toContain("https://www.google.com/maps?q=18.520000,73.850000");

    const [row] = await listSosEvents();
    expect(row).toMatchObject({ status: "OPEN", riderMobile: "9876543210", orderNumber: null });

    await acknowledgeSos(first.id, { id: admin.id, role: "ADMIN" });
    await expect(acknowledgeSos(first.id, { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getMySosStatus(rider.id)).event?.status).toBe("ACKNOWLEDGED");
    const told = await db.select().from(notifications).where(eq(notifications.type, NOTIFICATION_TYPES.RIDER_SOS_ACKNOWLEDGED));
    expect(told.map((n) => n.userId)).toEqual([rider.id]);

    await closeSos(first.id, "Rider fell, ambulance came, fine now.", { id: admin.id, role: "ADMIN" });
    expect((await getMySosStatus(rider.id)).event).toBeNull();
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, first.id));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it("updates the emergency contact and refuses the rider's own number", async () => {
    const { rider } = await setup();
    await expect(updateMyEmergencyContact(rider, { name: "Asha", mobile: "9876543210" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await updateMyEmergencyContact(rider, { name: "Asha", mobile: "9123456780", relation: "Wife" })).toEqual({
      name: "Asha",
      mobile: "9123456780",
      relation: "Wife",
    });
  });
});

describe("rider insurance", () => {
  const policy = {
    insurer: "Test Insurance Co",
    policyNumber: "POL-1",
    healthCoverPaise: 10_000_000,
    accidentCoverPaise: 50_000_000,
    opdCoverPaise: 500_000,
    minDeliveries: 0,
    lookbackDays: 30,
    validFrom: "2026-01-01",
    validTo: "2099-12-31",
    hospitals: [{ name: "City Hospital", city: "Pune" }],
    isActive: true,
  };

  it("shows coming soon without a policy, then the card; one active policy at a time", async () => {
    const { admin, rider } = await setup();
    await setRule("riderInsurance", { enabled: true }, { id: admin.id, role: "ADMIN" });
    expect((await getMyInsuranceView(rider.id))?.policy).toBeNull();

    const a = await savePolicy(policy, { id: admin.id, role: "ADMIN" });
    const b = await savePolicy({ ...policy, policyNumber: "POL-2" }, { id: admin.id, role: "ADMIN" });
    const rows = await db.select().from(riderInsurancePolicies);
    expect(rows.find((r) => r.id === a.id)?.isActive).toBe(false);
    expect(rows.find((r) => r.id === b.id)?.isActive).toBe(true);

    const view = await getMyInsuranceView(rider.id);
    expect(view?.policy?.policyNumber).toBe("POL-2");
    expect(view?.eligibility?.active).toBe(true);

    const told = await db.select().from(notifications).where(eq(notifications.type, NOTIFICATION_TYPES.RIDER_INSURANCE_STATUS));
    expect(told.map((n) => n.userId)).toContain(rider.id);

    await saveMyNominee(rider, { name: "Sita Devi", relation: "Mother", mobile: "9123456780", dateOfBirth: "1970-01-15" });
    await saveMyNominee(rider, { name: "Sita Devi", relation: "Mother", mobile: null, dateOfBirth: null });
    expect(await db.select().from(riderNominees)).toHaveLength(1);
    expect((await getMyInsuranceView(rider.id))?.nominee).toEqual({ name: "Sita Devi", relation: "Mother", mobile: null, dateOfBirth: null });
  });
});
