/**
 * Rider App v2 — pay plans, quote lock and the Available Deliveries board (docs/rider-app-v2-2026-11).
 * Rules riderPayPlans / riderJobBoard are ON by default (owner, 26-Nov-2026); switched off, nothing changes.
 */
import { eq, inArray, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, platformSettings, riderPayPlans, riderSurges } from "@/server/db/schema";
import { acceptDeliveryOffer, assignNearestPartner } from "@/server/services/delivery-assignment";
import { creditDeliveryEarnings } from "@/server/services/delivery-earnings";
import { acceptJob, listOpenJobs, passJob, quoteForOwnOffer } from "@/server/services/rider-job-board";
import { clonePlan, endSurge, listPlans, publishPlan, simulatePlan, startSurge, updateDraft } from "@/server/services/rider-pay-plans";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { PUNE_PILOT_PLAN } from "@/lib/rider-pay-plan";
import { findForbiddenRiderKeys } from "../helpers/rider-privacy-scan";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase, turnRiderZoningOff } from "../helpers/fixtures";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111;
const RULE_KEYS = ["riderPayPlans", "riderJobBoard", "dispatchBroadcast", "dispatch"];

let adminActor: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, RULE_KEYS));
  await db.delete(riderSurges);
  // Keep only the migrated default plan (0211), back to its seeded state.
  const seeded = await db.select().from(riderPayPlans).where(eq(riderPayPlans.version, 1)).orderBy(riderPayPlans.createdAt).limit(1);
  if (seeded[0]) {
    await db.delete(riderPayPlans).where(ne(riderPayPlans.planKey, seeded[0].planKey));
    await db.delete(riderPayPlans).where(ne(riderPayPlans.id, seeded[0].id));
    await db.update(riderPayPlans).set({ status: "ACTIVE", retiredAt: null }).where(eq(riderPayPlans.id, seeded[0].id));
  }
  clearRuleCache();
  const a = await createUser({ role: "ADMIN" });
  adminActor = { id: a.id, role: "ADMIN" };
  await turnRiderZoningOff();
});

async function rider(km: number) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, { isOnline: true, latitude: kmNorth(km), longitude: SHOP.longitude, operatingRadiusKm: 10 });
  return { user, partner };
}

/** A READY order offered to the nearest rider, with a 3.5 km shop → customer leg. */
async function offered(riderKms = [1.8]) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, SHOP);
  const riders = [];
  for (const km of riderKms) riders.push(await rider(km));
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY", subtotalPaise: 50_000 });
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  const [withLeg] = await db.update(deliveryOrders).set({ distanceKm: "3.5" }).where(eq(deliveryOrders.id, offer.id)).returning();
  return { shop, riders, order, offer: withLeg };
}

async function deliver(deliveryOrderId: string) {
  const now = new Date();
  await db.update(deliveryOrders).set({ status: "DELIVERED", pickedUpAt: now, deliveredAt: now }).where(eq(deliveryOrders.id, deliveryOrderId));
  return creditDeliveryEarnings(deliveryOrderId);
}

const JOB_BOARD = { maxJobs: 50, maxRadiusKm: 8, pollSeconds: 10 };
const setSwitch = (key: "riderPayPlans" | "riderJobBoard", enabled: boolean) =>
  setRule(key, (key === "riderJobBoard" ? { enabled, ...JOB_BOARD } : { enabled }) as never, adminActor);
const enable = (key: "riderPayPlans" | "riderJobBoard") => setSwitch(key, true);

async function defaultPlan() {
  return (await listPlans()).find((p) => p.scopeType === "DEFAULT" && p.inForce)!;
}

async function publishPilot(note = "Pune pilot numbers") {
  const draft = await clonePlan((await defaultPlan()).id, adminActor);
  await updateDraft(draft.id, { ...PUNE_PILOT_PLAN, name: draft.name, scopeType: "DEFAULT" }, adminActor);
  await simulatePlan(draft.id, 7, adminActor);
  return publishPlan(draft.id, { note }, adminActor);
}

describe("defaults (owner, 26-Nov-2026)", () => {
  it("RV2-000 all eight Rider App v2 switches are on when no admin has changed them", async () => {
    const keys = ["riderAppV2", "riderPayPlans", "riderJobBoard", "riderSlotBooking", "riderReferral", "riderTiers", "riderSos", "riderInsurance"] as const;
    await db.delete(platformSettings).where(inArray(platformSettings.key, [...keys]));
    clearRuleCache();
    for (const key of keys) expect({ key, enabled: (await getRule(key)).enabled }).toEqual({ key, enabled: true });
  });
});

describe("riderPayPlans switched off", () => {
  it("RV2-001 accepting locks no quote and the earning is the flat base + per-km rate as before", async () => {
    await setSwitch("riderPayPlans", false);
    const { offer, riders } = await offered();
    const accepted = await acceptDeliveryOffer(offer.id, riders[0].user.id);
    expect(accepted.quotePaise ?? null).toBeNull();
    const earning = await deliver(offer.id);
    expect(earning.quotePaise).toBeNull();
    expect(earning.totalPaise).toBe(2000 + Math.round(3.5 * 800));
  });
});

describe("riderPayPlans on", () => {
  it("RV2-002 the migrated default plan pays the same as the flat rate on the day of release", async () => {
    await enable("riderPayPlans");
    const { offer, riders } = await offered();
    const accepted = await acceptDeliveryOffer(offer.id, riders[0].user.id);
    expect(accepted.quotePaise).toBe(2000 + 2800); // ₹48.00 — already a whole rupee
    const earning = await deliver(offer.id);
    expect(earning.quotePaise).toBe(4800);
    expect(earning.totalPaise).toBe(4800);
  });

  it("RV2-003 the offer shows 'You earn ₹X' before accepting, and the same amount is locked on accept", async () => {
    await enable("riderPayPlans");
    await publishPilot();
    const { offer, riders } = await offered([1.8]);
    const shown = await quoteForOwnOffer(offer, 50_000);
    expect(shown.locked).toBe(false);
    // Pilot: base ₹20 (2 km) + 1.5 km × ₹6 = ₹29 + first mile 0.8 km × ₹3 = ₹31.40 → ₹32 (above the ₹30 minimum).
    expect(shown.earnPaise).toBe(3200);
    const accepted = await acceptDeliveryOffer(offer.id, riders[0].user.id);
    expect(accepted.quotePaise).toBe(shown.earnPaise);
    expect((await quoteForOwnOffer(accepted, 50_000)).locked).toBe(true);
  });

  it("RV2-004 publishing a new plan never changes a quote already locked", async () => {
    await enable("riderPayPlans");
    const { offer, riders } = await offered();
    await acceptDeliveryOffer(offer.id, riders[0].user.id); // locked on the migrated plan: ₹48
    await publishPilot();
    const earning = await deliver(offer.id);
    expect(earning.totalPaise).toBe(4800);
    // A new offer is priced on the new plan.
    const next = await offered([1.8]);
    expect((await quoteForOwnOffer(next.offer, 50_000)).earnPaise).toBe(3200);
  });

  it("RV2-005 publishing needs a simulator run on the draft as it is now, and a note", async () => {
    const draft = await clonePlan((await defaultPlan()).id, adminActor);
    await expect(publishPlan(draft.id, { note: "no simulation" }, adminActor)).rejects.toThrow(/simulator/i);
    await simulatePlan(draft.id, 30, adminActor);
    await updateDraft(draft.id, { ...PUNE_PILOT_PLAN, name: draft.name, scopeType: "DEFAULT" }, adminActor);
    await expect(publishPlan(draft.id, { note: "edited after the run" }, adminActor)).rejects.toThrow(/simulator/i);
    await simulatePlan(draft.id, 7, adminActor);
    await expect(publishPlan(draft.id, { note: "" }, adminActor)).rejects.toThrow(/note/i);
    const published = await publishPlan(draft.id, { note: "pilot" }, adminActor);
    expect(published.status).toBe("ACTIVE");
    const versions = await listPlans();
    expect(versions.filter((p) => p.inForce && p.scopeType === "DEFAULT")).toHaveLength(1);
    expect(versions.find((p) => p.version === 1)?.status).toBe("RETIRED");
  });

  it("RV2-006 a rain surge raises new quotes while it is on and stops when ended", async () => {
    await enable("riderPayPlans");
    await publishPilot();
    const { offer } = await offered([1.8]);
    const surge = await startSurge(
      { city: "Pune", multiplierBp: 13000, flatPaise: 1000, reason: "RAIN", endsAt: new Date(Date.now() + 3_600_000) },
      adminActor,
    );
    // ₹31.40 × 1.3 + ₹10 = ₹50.82 → ₹51
    expect((await quoteForOwnOffer(offer, 50_000)).earnPaise).toBe(5100);
    await endSurge(surge.id, adminActor);
    expect((await quoteForOwnOffer(offer, 50_000)).earnPaise).toBe(3200);
  });
});

describe("Available Deliveries (riderJobBoard)", () => {
  async function openJob() {
    const setup = await offered([0.4, 1.2, 2.0]);
    // The first rider turned it down; nobody holds it now.
    await db
      .update(deliveryOrders)
      .set({ status: "REJECTED", rejectedPartnerIds: [setup.riders[0].partner.id] })
      .where(eq(deliveryOrders.id, setup.offer.id));
    return setup;
  }

  it("RV2-010 switched off: the list is empty and accepting is refused", async () => {
    await setSwitch("riderJobBoard", false);
    const { riders, offer } = await openJob();
    const board = await listOpenJobs(riders[1].user.id);
    expect(board).toMatchObject({ enabled: false, blockedReason: "OFF", jobs: [] });
    await expect(acceptJob(riders[1].user.id, `d:${offer.id}`)).rejects.toThrow();
  });

  it("RV2-011 riders near the shop see the job with what they earn; the rider who declined does not", async () => {
    await enable("riderJobBoard");
    await enable("riderPayPlans");
    const { riders } = await openJob();
    expect((await listOpenJobs(riders[0].user.id)).jobs).toHaveLength(0);
    const board = await listOpenJobs(riders[1].user.id);
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0].earnPaise).toBeGreaterThan(0);
    expect(board.jobs[0].deliveryKm).toBe(3.5);
    expect(findForbiddenRiderKeys(board)).toEqual([]);
  });

  it("RV2-012 first accept wins: two riders at once, exactly one gets it, the other is told 'Taken'", async () => {
    await enable("riderJobBoard");
    await enable("riderPayPlans");
    const { riders, offer } = await openJob();
    const results = await Promise.allSettled([
      acceptJob(riders[1].user.id, `d:${offer.id}`),
      acceptJob(riders[2].user.id, `d:${offer.id}`),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason?.message ?? lost.reason)).toMatch(/Taken|no longer/i);
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    expect(row.status).toBe("ACCEPTED");
    expect(row.quotePaise).toBeGreaterThan(0);
  });

  it("RV2-013 passing with a reason hides the job from that rider only", async () => {
    await enable("riderJobBoard");
    const { riders, offer } = await openJob();
    await passJob(riders[1].user.id, `d:${offer.id}`, "TOO_FAR");
    expect((await listOpenJobs(riders[1].user.id)).jobs).toHaveLength(0);
    expect((await listOpenJobs(riders[2].user.id)).jobs).toHaveLength(1);
  });

  it("RV2-014 an offline rider sees nothing", async () => {
    await enable("riderJobBoard");
    const { riders } = await openJob();
    const { deliveryPartners } = await import("@/server/db/schema");
    await db.update(deliveryPartners).set({ isOnline: false, availability: "OFFLINE" }).where(eq(deliveryPartners.id, riders[1].partner.id));
    expect((await listOpenJobs(riders[1].user.id)).blockedReason).toBe("OFFLINE");
  });
});
