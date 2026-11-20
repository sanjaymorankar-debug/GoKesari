/**
 * GoKesari Health — medical equipment rentals (docs/health/, owner brief §2.7 / §4.3), against real PostgreSQL:
 *   - store profile and staff verification; listings; browse shows verified stores only
 *   - rent with the sandbox payment → CONFIRMED and stock taken → out for delivery → delivery code (wrong
 *     code counted) → ACTIVE → due reminder → extension payment moves the due date and the reminder →
 *     return pickup → condition check with damages → deposit refund (deposit − damages) → CLOSED, stock back
 *   - settlement lines: rent + delivery (+ damages) credited, 2% commission, the deposit never credited
 *   - prescription-only equipment is refused without a prescription / equipment suggestion; stock limits
 */
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { istDateKey, addDays } from "@/lib/consult/time";
import { db } from "@/server/db";
import {
  addresses,
  financialAdjustments,
  healthConsultations,
  healthEquipmentListings,
  healthEquipmentMaster,
  healthEvents,
  healthRentals,
  healthSuggestions,
  healthTimeline,
  notifications,
  paymentRefunds,
  scheduledNotices,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { ensureProfile } from "@/server/consult/setup";
import { acceptHealthNotice } from "@/server/health/patients";
import {
  browseEquipment,
  cancelRental,
  closeRental,
  createRental,
  deliverRental,
  deliveryCode,
  dispatchRental,
  extendRental,
  pendingEquipmentStores,
  rentalView,
  saveEquipmentStoreProfile,
  saveListing,
  scheduleReturn,
  sendRentalDueNotice,
  verifyEquipmentStore,
} from "@/server/health/rentals";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: ConsultActor;
let storeOwner: ConsultActor;
let customer: ConsultActor;
let other: ConsultActor;
let shopId: string;
let wheelchairId: string;
let oxygenId: string;
let addressId: string;
const actorOf = (u: { id: string; role: string; name?: string | null }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"], name: u.name ?? null });
const today = () => istDateKey(new Date());
const pay = (intentId: string, who: ConsultActor, outcome: "SUCCESS" | "FAILURE" = "SUCCESS") => simulateSandboxCheckout({ ref: intentId, viewerId: who.id, outcome });
const reload = async (id: string) => (await db.select().from(healthRentals).where(eq(healthRentals.id, id)))[0];
const adjustments = async (id: string) => db.select().from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, `healthrent:${id}:%`));

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health', 'helpdesk')`);
  admin = actorOf(await createUser({ role: "ADMIN" }));
  storeOwner = actorOf(await createUser({ role: "SHOP_OWNER", name: "Mobility Mart" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha Patil" }));
  other = actorOf(await createUser({ role: "CUSTOMER", name: "Ravi" }));
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  await setRule("health", { ...RULES.health.defaults, enabled: true }, admin);
  await setRule("helpdesk", { ...RULES.helpdesk.defaults, enabled: true }, admin);
  clearRuleCache();
  const shop = await createShop(storeOwner.id, { name: "Mobility Mart", shopType: "MEDICAL_EQUIPMENT", latitude: 18.52, longitude: 73.85 });
  shopId = shop.id;
  await saveEquipmentStoreProfile(shopId, { rentalTerms: "Rent is paid in advance.", damagePolicy: "Repair cost is taken from the deposit.", deliveryRadiusKm: 15 }, storeOwner);
  const [wc] = await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.slug, "wheelchair-manual"));
  const [ox] = await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.slug, "oxygen-concentrator"));
  wheelchairId = (await saveListing(shopId, { masterId: wc.id, forRent: true, rentDayRupees: 100, rentWeekRupees: 500, minRentDays: 3, depositRupees: 2000, deliveryRupees: 150, stock: 2 }, storeOwner)).id;
  oxygenId = (await saveListing(shopId, { masterId: ox.id, forRent: true, rentMonthRupees: 6000, depositRupees: 10000, stock: 1 }, storeOwner)).id;
  [{ id: addressId }] = await db.insert(addresses).values({ userId: customer.id, line1: "12 MG Road", city: "Pune", pincode: "411001", latitude: "18.53", longitude: "73.86", isDefault: true }).returning({ id: addresses.id });
});

describe("store verification and browsing", () => {
  it("lists a store's equipment only after GoKesari verifies it", async () => {
    expect((await pendingEquipmentStores()).map((s) => s.shopId)).toContain(shopId);
    expect((await browseEquipment({ q: "wheelchair" })).results).toHaveLength(0);
    await expect(verifyEquipmentStore(shopId, "VERIFIED", null, storeOwner)).rejects.toThrow();
    await expect(verifyEquipmentStore(shopId, "REJECTED", null, admin)).rejects.toThrow(/reason/);
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    const found = await browseEquipment({ q: "wheelchair", lat: 18.53, lng: 73.86, rent: "1" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ listingId: wheelchairId, rentWeekPaise: 50_000, depositPaise: 200_000, rxRequired: false });
    expect(found.results[0].store.distanceKm).toBeGreaterThan(0);
    // The oxygen concentrator's prescription flag came from the master list.
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, oxygenId)))[0].rxRequired).toBe(true);
    // Far away: outside the store's delivery radius.
    expect((await browseEquipment({ q: "wheelchair", lat: 19.07, lng: 72.87 })).results).toHaveLength(0);
  });
});

describe("a rental from payment to deposit refund", () => {
  it("runs the whole lifecycle with the delivery code, reminder, extension and damages", async () => {
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    const self = await acceptHealthNotice(customer);
    const start = today();
    const created = await createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: start, quantity: 1, addressId, patientId: self.id, acceptTerms: true }, customer);
    expect(created.rental).toMatchObject({ status: "PENDING_PAYMENT", rentPaise: 50_000, depositPaise: 200_000, deliveryPaise: 15_000, totalPaise: 265_000, dueDate: addDays(start, 7) });
    expect(created.rental.rentalNumber).toMatch(/^RENT-\d{4}-\d{6}$/);
    await pay(created.intentId, customer);
    let r = await reload(created.rental.id);
    expect(r).toMatchObject({ status: "CONFIRMED", paidPaise: 265_000 });
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, wheelchairId)))[0].stock).toBe(1);

    // Out for delivery; the patient's delivery code starts the rental.
    await dispatchRental(r.id, storeOwner);
    const view = await rentalView(r.id, customer);
    expect(view.deliveryCode).toBe(deliveryCode(r.id, r.otpSalt));
    await expect(rentalView(r.id, other)).rejects.toThrow();
    const wrong = view.deliveryCode === "0000" ? "1111" : "0000";
    await expect(deliverRental(r.id, wrong, storeOwner)).rejects.toThrow(/not right/);
    await expect(deliverRental(r.id, view.deliveryCode, customer)).rejects.toThrow();
    r = await deliverRental(r.id, view.deliveryCode, storeOwner);
    expect(r.status).toBe("ACTIVE");
    let adj = await adjustments(r.id);
    expect(adj.reduce((n, a) => n + a.amountPaise, 0)).toBe(65_000 - 1_300); // rent + delivery, less 2%
    expect((await db.select().from(healthTimeline).where(and(eq(healthTimeline.patientId, self.id), eq(healthTimeline.kind, "EQUIPMENT")))).length).toBe(1);

    // The due reminder is scheduled and sends the HEALTH_RENTAL_DUE notice.
    const [notice] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, `health-rental-due:${r.id}`));
    expect(notice).toMatchObject({ kind: "HEALTH_RENTAL_DUE" });
    expect(notice.payload.dueDate).toBe(addDays(start, 7));
    expect(await sendRentalDueNotice(notice)).toBe(true);
    const due = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "health.rental_due")));
    expect(due.length).toBeGreaterThan(0);

    // Extension: another payment for one more week; the due date and the reminder move.
    const ext = await extendRental(r.id, { periodCount: 1 }, customer);
    expect(ext.amountPaise).toBe(50_000);
    await pay(ext.intentId, customer);
    r = await reload(r.id);
    expect(r).toMatchObject({ dueDate: addDays(start, 14), rentPaise: 100_000, periodCount: 2, paidPaise: 315_000 });
    expect(r.extensions).toHaveLength(1);
    const [moved] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, `health-rental-due:${r.id}`));
    expect(moved.payload.dueDate).toBe(addDays(start, 14));
    expect(await sendRentalDueNotice(notice)).toBe(false); // the old reminder (old due date) is stale
    adj = await adjustments(r.id);
    expect(adj.reduce((n, a) => n + a.amountPaise, 0)).toBe(115_000 - 2_300);

    // Return pickup, then the condition check with ₹300 damage: ₹1,700 of the deposit is refunded.
    r = await scheduleReturn(r.id, { pickupAt: new Date(Date.now() + 86_400_000).toISOString() }, customer);
    expect(r.status).toBe("RETURN_SCHEDULED");
    await expect(closeRental(r.id, { conditionNote: "Armrest scratched", damageRupees: 2500 }, storeOwner)).rejects.toThrow(/at most the deposit/);
    r = await closeRental(r.id, { conditionNote: "Armrest scratched", damageRupees: 300 }, storeOwner);
    expect(r).toMatchObject({ status: "CLOSED", damagePaise: 30_000, depositRefundPaise: 170_000 });
    const refunds = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, created.intentId));
    expect(refunds.map((x) => x.amountPaise)).toEqual([170_000]);
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, wheelchairId)))[0].stock).toBe(2);
    adj = await adjustments(r.id);
    // Rent 1,000 + delivery 150 + damages 300 credited; 2% commission; the deposit never credited.
    expect(adj.filter((a) => a.idempotencyKey.includes(":credit:")).reduce((n, a) => n + a.amountPaise, 0)).toBe(145_000);
    expect(adj.filter((a) => a.idempotencyKey.includes(":commission:")).reduce((n, a) => n + a.amountPaise, 0)).toBe(-2_900);
    const names = (await db.select({ name: healthEvents.name }).from(healthEvents).where(eq(healthEvents.subjectId, r.id))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["rental.started", "rental.due_soon", "rental.extended", "rental.return_scheduled", "rental.returned", "rental.deposit_refunded"]));
    const closedView = await rentalView(r.id, customer);
    expect(closedView.refunds.map((x) => x.amountPaise)).toEqual([170_000]);
  });

  it("refunds everything when cancelled before delivery and gives the stock back", async () => {
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    const created = await createRental({ listingId: wheelchairId, periodUnit: "DAY", periodCount: 3, startDate: today(), addressId, acceptTerms: true }, customer);
    expect(created.rental.totalPaise).toBe(30_000 + 200_000 + 15_000);
    await pay(created.intentId, customer);
    const r = await cancelRental(created.rental.id, null, customer);
    expect(r.status).toBe("CANCELLED");
    expect((await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, created.intentId))).map((x) => x.amountPaise)).toEqual([245_000]);
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, wheelchairId)))[0].stock).toBe(2);
    expect(await adjustments(r.id)).toHaveLength(0);
  });

  it("frees the rental when the payment fails", async () => {
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    const created = await createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: today(), addressId, acceptTerms: true }, customer);
    await pay(created.intentId, customer, "FAILURE");
    expect((await reload(created.rental.id)).status).toBe("CANCELLED");
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, wheelchairId)))[0].stock).toBe(2);
  });
});

describe("rules on renting", () => {
  it("refuses prescription-only equipment without a prescription, and accepts the doctor's equipment suggestion", async () => {
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    const self = await acceptHealthNotice(customer);
    await expect(createRental({ listingId: oxygenId, periodUnit: "MONTH", periodCount: 1, startDate: today(), addressId, patientId: self.id, acceptTerms: true }, customer)).rejects.toThrow(/prescription/);
    // A doctor's EQUIPMENT suggestion for this patient (consultation at a clinic).
    const docOwner = await createUser({ role: "SHOP_OWNER", name: "Dr Mehta" });
    const clinic = await createShop(docOwner.id, { name: "Mehta Clinic", shopType: "DOCTOR_CLINIC" });
    await ensureProfile(clinic.id, actorOf(docOwner));
    const [m] = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${clinic.id} and is_owner`);
    const [c] = await db.insert(healthConsultations).values({ shopId: clinic.id, memberId: m.id, patientId: self.id }).returning();
    const [s] = await db.insert(healthSuggestions).values({ consultationId: c.id, patientId: self.id, memberId: m.id, type: "EQUIPMENT", details: { item: "Oxygen concentrator" } }).returning();
    // Someone else cannot use it.
    await expect(createRental({ listingId: oxygenId, periodUnit: "MONTH", periodCount: 1, startDate: today(), addressId, suggestionId: s.id, acceptTerms: true }, other)).rejects.toThrow();
    const ok = await createRental({ listingId: oxygenId, periodUnit: "MONTH", periodCount: 1, startDate: today(), addressId, suggestionId: s.id, acceptTerms: true }, customer);
    expect(ok.rental).toMatchObject({ suggestionId: s.id, patientId: self.id, totalPaise: 600_000 + 1_000_000 });
    expect((await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, s.id)))[0]).toMatchObject({ status: "BOOKED", linkedRentalId: ok.rental.id });
    // A failed payment puts the suggestion back to OPEN.
    await pay(ok.intentId, customer, "FAILURE");
    expect((await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, s.id)))[0]).toMatchObject({ status: "OPEN", linkedRentalId: null });
  });

  it("keeps to the stock, the minimum period, the start date and the delivery radius", async () => {
    await verifyEquipmentStore(shopId, "VERIFIED", null, admin);
    await expect(createRental({ listingId: wheelchairId, periodUnit: "DAY", periodCount: 1, startDate: today(), addressId, acceptTerms: true }, customer)).rejects.toThrow(/minimum rental/);
    await expect(createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: today(), quantity: 3, addressId, acceptTerms: true }, customer)).rejects.toThrow(/Only 2 available/);
    await expect(createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: addDays(today(), -1), addressId, acceptTerms: true }, customer)).rejects.toThrow(/past/);
    await expect(createRental({ listingId: wheelchairId, periodUnit: "MONTH", periodCount: 1, startDate: today(), addressId, acceptTerms: true }, customer)).rejects.toThrow(/not rented per month/);
    const [far] = await db.insert(addresses).values({ userId: customer.id, line1: "Andheri", city: "Mumbai", pincode: "400053", latitude: "19.12", longitude: "72.85" }).returning({ id: addresses.id });
    await expect(createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: today(), addressId: far.id, acceptTerms: true }, customer)).rejects.toThrow(/delivers within/);
    // The last unit: two paid rentals take both; a third paid one is refunded in full (out of stock).
    const a = await createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: today(), quantity: 2, addressId, acceptTerms: true }, customer);
    const b = await createRental({ listingId: wheelchairId, periodUnit: "WEEK", periodCount: 1, startDate: today(), quantity: 1, addressId, acceptTerms: true }, customer);
    await pay(a.intentId, customer);
    await pay(b.intentId, customer);
    expect((await reload(a.rental.id)).status).toBe("CONFIRMED");
    expect((await reload(b.rental.id)).status).toBe("CANCELLED");
    expect((await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, b.intentId))).map((x) => x.amountPaise)).toEqual([b.rental.totalPaise]);
    expect((await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, wheelchairId)))[0].stock).toBe(0);
  });
});
