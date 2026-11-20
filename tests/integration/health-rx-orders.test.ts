/**
 * GoKesari Health "Get medicines" (src/server/health/rx-orders.ts), against real PostgreSQL:
 *   - pickup end to end with the pickup code (wrong codes counted), bill, dispensed quantities, cash settlement
 *   - delivery end to end: radius, online payment (sandbox) incl. a failed try, delivery code, short supply refunded
 *   - substitutes: same generic + strength only; each must be approved; a rejected one drops to 0
 *   - dispensed quantity can never pass the prescribed quantity (two stores racing; ordering more afterwards)
 *   - restricted (NDPS / Schedule X) medicines cannot be ordered online
 *   - the store's reply window: expiry by the scheduled notice, "send to another store", late quotes refused
 *   - cancellation with a full refund; no cancel after packing
 *   - privacy: a store sees only prescriptions sent to it, and every look is logged
 *   - settlement rows: online money kept, minus 2% commission on everything kept
 *   - pharmacy profile and verification
 */
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { decryptBytes } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  addresses,
  consultCategories,
  financialAdjustments,
  healthAccessLog,
  healthDocuments,
  healthDrugMaster,
  healthEvents,
  healthPrescriptionItems,
  healthRxOrderItems,
  healthRxOrders,
  healthTimeline,
  paymentRefunds,
  scheduledNotices,
  supportTickets,
  type HealthRxOrder,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { verifyProfile } from "@/server/consult/admin";
import { decideBooking } from "@/server/consult/bookings";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { createHealthBooking } from "@/server/health/booking";
import { startConsultation } from "@/server/health/consultations";
import { saveDoctorProfile } from "@/server/health/doctors";
import { acceptHealthNotice } from "@/server/health/patients";
import { issuePrescription, prescriptionView } from "@/server/health/prescriptions";
import {
  approveRxOrder,
  cancelRxOrder,
  completeRxOrder,
  createRxOrder,
  declineRxOrder,
  dispatchRxOrder,
  expireRxOrderNotice,
  myRxOrders,
  newRxCode,
  packRxOrder,
  payRxOrder,
  pendingPharmacies,
  quoteRxOrder,
  readyRxOrder,
  reportRxProblem,
  rxBillPdf,
  rxOrderDetail,
  rxOrderOptions,
  savePharmacyProfile,
  storeCancelRxOrder,
  storeRxInbox,
  verifyPharmacy,
} from "@/server/health/rx-orders";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));
const actorOf = (u: { id: string; role: string; name?: string | null }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"], name: u.name ?? null });
const tomorrowAt = (hhmm: string) => istAt(addDays(istDateKey(new Date()), 1), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString();
const nextYear = () => `${new Date().getUTCFullYear() + 1}-06-30`;

let admin: ConsultActor;
let doctor: ConsultActor;
let customer: ConsultActor;
let stranger: ConsultActor;
let storeOwnerA: ConsultActor;
let storeOwnerB: ConsultActor;
let storeA: string;
let storeB: string;
let patientId: string;
let rxId: string;
let addressNear: string;
let addressFar: string;
let item: { para: string; amox: string; alpra: string };

const reload = async (id: string): Promise<HealthRxOrder> => (await db.select().from(healthRxOrders).where(eq(healthRxOrders.id, id)))[0];
const linesOf = (id: string) => db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, id));
const lineFor = async (orderId: string, prescriptionItemId: string) => (await linesOf(orderId)).find((l) => l.prescriptionItemId === prescriptionItemId)!;
const dispensed = async (prescriptionItemId: string) => (await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.id, prescriptionItemId)))[0].dispensedQty;
const adjustments = (orderId: string) => db.select().from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, `healthrx:${orderId}:%`));

async function pharmacy(owner: ConsultActor, name: string, latitude: number, longitude: number, over: Record<string, unknown> = {}): Promise<string> {
  const shop = await createShop(owner.id, { name, shopType: "PHARMACY", latitude, longitude });
  await savePharmacyProfile(shop.id, { drugLicenceNumber: "MH-PZ-20/21-12345", pharmacistName: "Sunil Kale", pharmacistRegistrationNumber: "MSPC-55667", pharmacyCouncil: "Maharashtra State Pharmacy Council", deliveryRadiusKm: 5, ...over }, owner);
  await verifyPharmacy(shop.id, "VERIFIED", null, admin);
  return shop.id;
}

/** Sends the prescription (Paracetamol + Amoxicillin by default) to a store. */
function send(over: Record<string, unknown> = {}, who: ConsultActor = customer) {
  return createRxOrder(
    {
      prescriptionId: rxId,
      shopId: storeA,
      items: [
        { prescriptionItemId: item.para, qty: 10 },
        { prescriptionItemId: item.amox, qty: 15 },
      ],
      fulfilment: "PICKUP",
      pickupAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      latitude: 18.53,
      longitude: 73.86,
      ...over,
    },
    who,
  );
}

/** Store quotes every line as available at ₹2.50 / ₹12 (Amoxicillin ₹5 off). */
async function quoteAll(orderId: string, owner: ConsultActor = storeOwnerA, deliveryPaise = 0) {
  const lines = await linesOf(orderId);
  return quoteRxOrder(
    orderId,
    {
      items: lines.map((l) => (l.prescriptionItemId === item.para ? { id: l.id, availability: "AVAILABLE", unitPricePaise: 250 } : { id: l.id, availability: "AVAILABLE", unitPricePaise: 1200, discountPaise: 500 })),
      deliveryPaise,
    },
    owner,
  );
}

async function billLines(orderId: string, qty: (prescriptionItemId: string, quoted: number) => number = (_p, q) => q) {
  const lines = await linesOf(orderId);
  return lines.map((l) => {
    const n = qty(l.prescriptionItemId, l.quotedQty);
    return { id: l.id, dispensedQty: n, batchNumber: n ? `B${l.id.slice(0, 4).toUpperCase()}` : null, expiryDate: n ? nextYear() : null };
  });
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health')`);
  admin = actorOf(await createUser({ role: "ADMIN" }));
  doctor = actorOf(await createUser({ role: "SHOP_OWNER", name: "Dr Anil Mehta" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha Patil" }));
  stranger = actorOf(await createUser({ role: "CUSTOMER", name: "Ravi" }));
  storeOwnerA = actorOf(await createUser({ role: "SHOP_OWNER", name: "Shree Medical owner" }));
  storeOwnerB = actorOf(await createUser({ role: "SHOP_OWNER", name: "Om Pharmacy owner" }));
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  // Instant booking for the test clinic (a Free-listed clinic otherwise confirms each request by hand).
  await setRule("health", { ...RULES.health.defaults, enabled: true, freeListingManualApproval: false }, admin);
  clearRuleCache();

  // A verified doctor with a clinic and an in-person service.
  const clinic = await createShop(doctor.id, { name: "Mehta Clinic", shopType: "DOCTOR_CLINIC", latitude: 18.5204, longitude: 73.8567 });
  await ensureProfile(clinic.id, doctor);
  await updateProfile(clinic.id, { displayName: "Mehta Family Clinic", headline: "General physician", minNoticeMinutes: 0 }, doctor);
  const [gp] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "general-physician"));
  const [{ id: memberId }] = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${clinic.id} and is_owner`);
  await saveMember(clinic.id, { id: memberId, name: "Dr Anil Mehta", categoryIds: [gp.id], languages: ["English"], registrationNumber: "MMC-12345", registrationBody: "Maharashtra Medical Council" }, doctor);
  await setMemberHours(clinic.id, memberId, EVERY_DAY, doctor);
  const svc = (await saveService(clinic.id, { name: "Consultation", durationMinutes: 15, modes: ["IN_PERSON"], categoryId: gp.id, feeType: "FREE" }, doctor)).id;
  await uploadMemberDocument(clinic.id, memberId, { name: "mmc.pdf", bytes: PDF }, doctor);
  const live = await publishProfile(clinic.id, doctor);
  await verifyProfile(live.id, { decision: "VERIFIED", members: [{ id: memberId, decision: "VERIFIED" }] }, admin);
  await saveDoctorProfile(memberId, { fullName: "Anil Mehta", qualifications: "MBBS, MD", specialties: ["General Medicine"], council: "Maharashtra Medical Council", registrationNumber: "MMC-12345", registrationYear: 2008 }, doctor);

  // The patient's booking → consultation → prescription (via the real health functions).
  const self = await acceptHealthNotice(customer);
  patientId = self.id;
  const { booking } = await createHealthBooking({ patientId, serviceId: svc, memberId, mode: "IN_PERSON", start: tomorrowAt("10:00"), reason: "Fever", shareRecords: "OFF", consent: true }, customer);
  if (booking.status === "PENDING_APPROVAL") await decideBooking(booking.id, true, doctor, null);
  const consultation = await startConsultation({ memberId, bookingId: booking.id }, doctor);
  const drug = async (g: string, s: string) => (await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, g), eq(healthDrugMaster.strength, s))))[0].id;
  const issued = await issuePrescription(
    consultation.id,
    {
      items: [
        { drugId: await drug("Paracetamol", "500 mg"), genericName: "Paracetamol", dose: "1 tablet", frequency: "1-1-1", timing: "AFTER_FOOD", durationDays: 3, quantity: 10 },
        { drugId: await drug("Amoxicillin", "500 mg"), genericName: "Amoxicillin", dose: "1 capsule", frequency: "1-1-1", timing: "AFTER_FOOD", durationDays: 5, quantity: 15 },
        { drugId: await drug("Alprazolam", "0.25 mg"), genericName: "Alprazolam", dose: "1 tablet", frequency: "0-0-1", timing: "BEDTIME", durationDays: 10, quantity: 10 },
      ],
      acknowledgeWarnings: true,
    },
    doctor,
  );
  rxId = issued.prescription.id;
  const items = await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, rxId));
  item = { para: items.find((i) => i.genericName === "Paracetamol")!.id, amox: items.find((i) => i.genericName === "Amoxicillin")!.id, alpra: items.find((i) => i.genericName === "Alprazolam")!.id };

  // Two verified medical stores in Pune; the customer's addresses (one near store A, one 30 km away).
  storeA = await pharmacy(storeOwnerA, "Shree Medical", 18.521, 73.857);
  storeB = await pharmacy(storeOwnerB, "Om Pharmacy", 18.54, 73.88, { cashOnHandover: false });
  [{ id: addressNear }] = await db.insert(addresses).values({ userId: customer.id, line1: "12 MG Road", city: "Pune", pincode: "411001", latitude: "18.5300", longitude: "73.8600", isDefault: true, addressType: "HOME", recipientPhone: "9876543210" }).returning({ id: addresses.id });
  [{ id: addressFar }] = await db.insert(addresses).values({ userId: customer.id, line1: "Farm house", city: "Talegaon", pincode: "410507", latitude: "18.7350", longitude: "73.6750", addressType: "OTHER" }).returning({ id: addresses.id });
});

describe("choosing medicines and a store", () => {
  it("offers only what may be ordered online, nearest verified stores first", async () => {
    const o = await rxOrderOptions({ prescriptionId: rxId, latitude: 18.53, longitude: 73.86 }, customer);
    const alpra = o.items.find((i) => i.id === item.alpra)!;
    expect(alpra).toMatchObject({ allowed: false, restricted: true });
    expect(o.items.find((i) => i.id === item.para)).toMatchObject({ allowed: true, remaining: 10 });
    expect(o.stores.map((s) => s.name)).toEqual(["Shree Medical", "Om Pharmacy"]);
    expect(o.stores[0]).toMatchObject({ open: true, favourite: false, cashOnHandover: true });
    expect(o.responseMinutes).toBe(15);
    // NDPS / Schedule X never goes online; more than prescribed is refused.
    await expect(send({ items: [{ prescriptionItemId: item.alpra, qty: 1 }] })).rejects.toThrow(/Not sold online/);
    await expect(send({ items: [{ prescriptionItemId: item.para, qty: 11 }] })).rejects.toThrow(/at most 10/);
    // Someone else cannot use the prescription; an unverified store is not offered and refuses requests.
    await expect(rxOrderOptions({ prescriptionId: rxId }, stranger)).rejects.toThrow(/not found/i);
    const pending = await createShop(storeOwnerB.id, { name: "New Chemist", shopType: "PHARMACY", latitude: 18.53, longitude: 73.86 });
    await savePharmacyProfile(pending.id, { drugLicenceNumber: "MH-1", pharmacistName: "Neha Joshi", pharmacistRegistrationNumber: "MSPC-1" }, storeOwnerB);
    expect((await pendingPharmacies(admin)).map((p) => p.shopName)).toEqual(["New Chemist"]);
    expect((await rxOrderOptions({ prescriptionId: rxId, latitude: 18.53, longitude: 73.86 }, customer)).stores.map((s) => s.name)).not.toContain("New Chemist");
    await expect(send({ shopId: pending.id })).rejects.toThrow(/not verified/);
  });
});

describe("pickup", () => {
  it("runs end to end: request, quote, approve (cash), pack, ready, pickup code, bill, settlement", async () => {
    const sent = await send();
    expect(sent).toMatchObject({ status: "SENT", fulfilment: "PICKUP" });
    expect(sent.orderNumber).toMatch(/^MED-\d{4}-\d{6}$/);
    expect(sent.expiresAt.getTime() - sent.createdAt.getTime()).toBe(15 * 60_000);
    const [notice] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, `health-rx-expiry:${sent.id}`));
    expect(notice).toMatchObject({ kind: "HEALTH_RX_EXPIRY" });
    expect((await storeRxInbox(storeA, storeOwnerA)).map((o) => o.id)).toEqual([sent.id]);
    // The same prescription cannot go to the same store twice while it is open.
    await expect(send()).rejects.toThrow(/already with Shree Medical/);

    const quoted = await quoteAll(sent.id);
    // 10 × ₹2.50 + 15 × ₹12 − ₹5 = ₹200
    expect(quoted).toMatchObject({ status: "QUOTED", goodsPaise: 20_500, discountPaise: 500, totalPaise: 20_000 });
    const [n] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, `health-rx-expiry:${sent.id}`));
    expect(n.cancelledAt).not.toBeNull();

    const approved = await approveRxOrder(sent.id, { paymentMode: "CASH_ON_HANDOVER" }, customer);
    expect(approved.checkoutUrl).toBeNull();
    expect(approved.order).toMatchObject({ status: "APPROVED", paymentStatus: "DUE_ON_HANDOVER" });
    await expect(completeRxOrder(sent.id, { code: "0000", billNumber: "B-1", items: await billLines(sent.id) }, storeOwnerA)).rejects.toThrow(/at handover/);
    await packRxOrder(sent.id, storeOwnerA);
    await expect(cancelRxOrder(sent.id, "changed my mind", customer)).rejects.toThrow(/already packed/);
    const ready = await readyRxOrder(sent.id, storeOwnerA);
    expect(ready.status).toBe("READY_FOR_PICKUP");

    const mine = await rxOrderDetail(sent.id, customer);
    expect(mine.code).toMatch(/^\d{4}$/);
    expect(mine.can).toMatchObject({ newCode: true, cancel: false });
    const theirs = await rxOrderDetail(sent.id, storeOwnerA);
    expect(theirs.code).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain("otpSalt");
    const wrong = mine.code === "1234" ? "4321" : "1234";
    await expect(completeRxOrder(sent.id, { code: wrong, billNumber: "B-1001", items: await billLines(sent.id) }, storeOwnerA)).rejects.toThrow(/4 tries left/);
    expect((await reload(sent.id)).otpAttempts).toBe(1);
    // An expired batch is refused.
    const expiredBatch = (await billLines(sent.id)).map((l) => ({ ...l, expiryDate: "2020-01-31" }));
    await expect(completeRxOrder(sent.id, { code: mine.code!, billNumber: "B-1001", items: expiredBatch }, storeOwnerA)).rejects.toThrow(/expired/);

    const done = await completeRxOrder(sent.id, { code: mine.code!, billNumber: "B-1001", items: await billLines(sent.id) }, storeOwnerA);
    expect(done).toMatchObject({ status: "COMPLETED", billNumber: "B-1001", paymentStatus: "PAID", paidOfflinePaise: 20_000, totalPaise: 20_000, commissionPaise: 400 });
    expect(await dispensed(item.para)).toBe(10);
    expect(await dispensed(item.amox)).toBe(15);
    expect((await lineFor(sent.id, item.para)).batchNumber).toMatch(/^B/);

    // The bill: a store document in the patient's record, encrypted at rest.
    const [doc] = await db.select().from(healthDocuments).where(eq(healthDocuments.patientId, patientId));
    expect(doc).toMatchObject({ source: "STORE", kind: "BILL", prescriptionId: rxId, providerName: "Shree Medical" });
    expect(doc.data.includes(Buffer.from("%PDF"))).toBe(false);
    const pdf = decryptBytes(doc.data);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("B-1001");
    expect((await rxBillPdf(sent.id, customer)).pdf.equals(pdf)).toBe(true);
    expect((await rxBillPdf(sent.id, storeOwnerA)).pdf.equals(pdf)).toBe(true);
    await expect(rxBillPdf(sent.id, stranger)).rejects.toThrow(/not found/i);

    // Timeline and events.
    const [t] = await db.select().from(healthTimeline).where(and(eq(healthTimeline.patientId, patientId), eq(healthTimeline.kind, "MEDICINE_ORDER")));
    expect(t.title).toMatch(/Medicines received from Shree Medical/);
    const names = (await db.select({ name: healthEvents.name }).from(healthEvents).where(eq(healthEvents.subjectId, sent.id))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["rx.forwarded", "rx.quoted", "rx.approved", "order.ready_for_pickup", "order.completed"]));

    // Cash at handover: no online money to pass on; 2% commission on the ₹200 kept.
    const rows = await adjustments(sent.id);
    expect(rows.map((r) => [r.idempotencyKey, r.amountPaise])).toEqual([[`healthrx:${sent.id}:commission:0`, -400]]);
    // A store the customer used becomes a favourite.
    const o = await rxOrderOptions({ prescriptionId: rxId, latitude: 18.54, longitude: 73.88 }, customer);
    expect(o.stores[0]).toMatchObject({ name: "Shree Medical", favourite: true });
  });

  it("locks the code after 5 wrong tries until the patient asks for a new one", async () => {
    const o = await send({ items: [{ prescriptionItemId: item.para, qty: 4 }] });
    await quoteAll(o.id);
    await approveRxOrder(o.id, { paymentMode: "CASH_ON_HANDOVER" }, customer);
    await readyRxOrder(o.id, storeOwnerA);
    const code = (await rxOrderDetail(o.id, customer)).code!;
    const wrong = code === "1111" ? "2222" : "1111";
    for (let i = 0; i < 5; i++) await expect(completeRxOrder(o.id, { code: wrong, billNumber: "B-9", items: await billLines(o.id) }, storeOwnerA)).rejects.toThrow(/not right/);
    await expect(completeRxOrder(o.id, { code, billNumber: "B-9", items: await billLines(o.id) }, storeOwnerA)).rejects.toThrow(/Too many wrong codes/);
    await newRxCode(o.id, customer);
    const fresh = (await rxOrderDetail(o.id, customer)).code!;
    await expect(completeRxOrder(o.id, { code: fresh, billNumber: "B-9", items: await billLines(o.id) }, storeOwnerA)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(await dispensed(item.para)).toBe(4);
  });
});

describe("delivery", () => {
  it("runs end to end: radius, online payment (a failed try, then paid), delivery code, short supply refunded, settlement", async () => {
    await expect(send({ fulfilment: "DELIVERY", addressId: addressFar })).rejects.toThrow(/delivers up to 5 km/);
    const sent = await send({ fulfilment: "DELIVERY", addressId: addressNear, pickupAt: null });
    expect(sent.address).toMatchObject({ line1: "12 MG Road", pincode: "411001", recipientPhone: "9876543210" });
    expect(Number(sent.distanceKm)).toBeGreaterThan(0);
    const quoted = await quoteAll(sent.id, storeOwnerA, 3_000);
    expect(quoted).toMatchObject({ deliveryPaise: 3_000, totalPaise: 23_000 });

    const first = await approveRxOrder(sent.id, { paymentMode: "ONLINE" }, customer);
    expect(first.order).toMatchObject({ status: "QUOTED", paymentMode: "ONLINE", paymentStatus: "PENDING" });
    expect(first.intentId).toBeTruthy();
    await simulateSandboxCheckout({ ref: first.intentId!, viewerId: customer.id, outcome: "FAILURE" });
    expect(await reload(sent.id)).toMatchObject({ status: "QUOTED", paymentStatus: "FAILED" });
    const again = await payRxOrder(sent.id, customer);
    expect(again.intentId).not.toBe(first.intentId);
    await simulateSandboxCheckout({ ref: again.intentId, viewerId: customer.id, outcome: "SUCCESS" });
    expect(await reload(sent.id)).toMatchObject({ status: "PAID", paymentStatus: "PAID", paidOnlinePaise: 23_000 });

    await expect(readyRxOrder(sent.id, storeOwnerA)).rejects.toThrow(/for delivery/);
    await expect(dispatchRxOrder(sent.id, { deliveryPerson: "Raju", deliveryPhone: "123" }, storeOwnerA)).rejects.toThrow();
    const out = await dispatchRxOrder(sent.id, { deliveryPerson: "Raju Pawar", deliveryPhone: "+91 98765 43211" }, storeOwnerA);
    expect(out).toMatchObject({ status: "OUT_FOR_DELIVERY", deliveryPerson: "Raju Pawar", deliveryPhone: "9876543211" });
    const code = (await rxOrderDetail(sent.id, customer)).code!;

    // Only 10 of the 15 Amoxicillin were supplied: billed ₹2.50×10 + ₹12×10 − ₹3.33 + ₹30 delivery.
    const done = await completeRxOrder(sent.id, { code, billNumber: "D-77", items: await billLines(sent.id, (p, q) => (p === item.amox ? 10 : q)) }, storeOwnerA);
    const billed = 2_500 + 12_000 - 333 + 3_000;
    expect(done).toMatchObject({ status: "COMPLETED", totalPaise: billed, refundPaise: 23_000 - billed });
    expect(await dispensed(item.amox)).toBe(10);
    const refunds = await db.select().from(paymentRefunds).where(like(paymentRefunds.idempotencyKey, `healthrx:${sent.id}:refund:short:%`));
    expect(refunds.map((r) => r.amountPaise)).toEqual([23_000 - billed]);

    // Online money kept goes to the store; 2% of everything kept comes back to GoKesari.
    const rows = await adjustments(sent.id);
    const byKey = Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.amountPaise]));
    expect(byKey).toEqual({ [`healthrx:${sent.id}:credit:0`]: billed, [`healthrx:${sent.id}:commission:0`]: -Math.round(billed * 0.02) });
    expect((await reload(sent.id)).commissionPaise).toBe(Math.round(billed * 0.02));
    // The remaining Amoxicillin can still be ordered (15 prescribed, 10 supplied).
    const o = await rxOrderOptions({ prescriptionId: rxId }, customer);
    expect(o.items.find((i) => i.id === item.amox)).toMatchObject({ remaining: 5, allowed: true });
  });

  it("refuses cash at handover where the store takes online payment only", async () => {
    const o = await send({ shopId: storeB });
    await quoteAll(o.id, storeOwnerB);
    await expect(approveRxOrder(o.id, { paymentMode: "CASH_ON_HANDOVER" }, customer)).rejects.toThrow(/online payment only/);
  });
});

describe("substitutes", () => {
  it("allows only the same generic and strength, and needs the patient's decision on each", async () => {
    const o = await send();
    const para = await lineFor(o.id, item.para);
    const amox = await lineFor(o.id, item.amox);
    const base = { id: para.id, availability: "AVAILABLE", unitPricePaise: 250 };
    await expect(
      quoteRxOrder(o.id, { items: [base, { id: amox.id, availability: "SUBSTITUTE", substituteName: "Mox 250", substituteGeneric: "Amoxicillin", substituteStrength: "250 mg", unitPricePaise: 900 }] }, storeOwnerA),
    ).rejects.toThrow(/same medicine/);
    await expect(
      quoteRxOrder(o.id, { items: [base, { id: amox.id, availability: "SUBSTITUTE", substituteName: "Azee", substituteGeneric: "Azithromycin", substituteStrength: "500 mg", unitPricePaise: 900 }] }, storeOwnerA),
    ).rejects.toThrow(/same medicine/);
    const quoted = await quoteRxOrder(o.id, { items: [base, { id: amox.id, availability: "SUBSTITUTE", substituteName: "Mox 500", substituteGeneric: "amoxicillin", substituteStrength: "500MG", unitPricePaise: 900 }] }, storeOwnerA);
    expect(quoted.totalPaise).toBe(2_500 + 13_500);
    expect(await lineFor(o.id, item.amox)).toMatchObject({ availability: "SUBSTITUTE", substituteName: "Mox 500", substituteApproved: null, quotedQty: 15 });

    await expect(approveRxOrder(o.id, { paymentMode: "CASH_ON_HANDOVER" }, customer)).rejects.toThrow(/each substitute/);
    const r = await approveRxOrder(o.id, { paymentMode: "CASH_ON_HANDOVER", substitutes: { [amox.id]: false } }, customer);
    expect(r.order).toMatchObject({ status: "APPROVED", totalPaise: 2_500 });
    expect(await lineFor(o.id, item.amox)).toMatchObject({ substituteApproved: false, quotedQty: 0, lineTotalPaise: 0 });
    // A rejected substitute cannot be supplied.
    await readyRxOrder(o.id, storeOwnerA);
    const code = (await rxOrderDetail(o.id, customer)).code!;
    const lines = (await billLines(o.id)).map((l) => (l.id === amox.id ? { ...l, dispensedQty: 15, batchNumber: "X", expiryDate: nextYear() } : l));
    await expect(completeRxOrder(o.id, { code, billNumber: "S-1", items: lines }, storeOwnerA)).rejects.toThrow(/cannot be supplied/);
    await completeRxOrder(o.id, { code, billNumber: "S-1", items: await billLines(o.id) }, storeOwnerA);
    expect(await dispensed(item.amox)).toBe(0);
  });

  it("marks partial and unavailable lines", async () => {
    const o = await send();
    const para = await lineFor(o.id, item.para);
    const amox = await lineFor(o.id, item.amox);
    await expect(quoteRxOrder(o.id, { items: [{ id: para.id, availability: "UNAVAILABLE" }, { id: amox.id, availability: "UNAVAILABLE" }] }, storeOwnerA)).rejects.toThrow(/decline/);
    await expect(quoteRxOrder(o.id, { items: [{ id: para.id, availability: "PARTIAL", quotedQty: 10, unitPricePaise: 250 }, { id: amox.id, availability: "UNAVAILABLE" }] }, storeOwnerA)).rejects.toThrow(/between 1 and 9/);
    const q = await quoteRxOrder(o.id, { items: [{ id: para.id, availability: "PARTIAL", quotedQty: 6, unitPricePaise: 250 }, { id: amox.id, availability: "UNAVAILABLE" }] }, storeOwnerA);
    expect(q.totalPaise).toBe(1_500);
  });
});

describe("dispensed quantity never passes the prescribed quantity", () => {
  it("lets only one of two stores racing for the same medicines complete, then refuses more", async () => {
    const a = await send({ items: [{ prescriptionItemId: item.para, qty: 10 }] });
    const b = await send({ shopId: storeB, items: [{ prescriptionItemId: item.para, qty: 10 }] });
    await quoteAll(a.id, storeOwnerA);
    await quoteAll(b.id, storeOwnerB);
    await approveRxOrder(a.id, { paymentMode: "CASH_ON_HANDOVER" }, customer);
    const pb = await approveRxOrder(b.id, { paymentMode: "ONLINE" }, customer);
    await simulateSandboxCheckout({ ref: pb.intentId!, viewerId: customer.id, outcome: "SUCCESS" });
    await readyRxOrder(a.id, storeOwnerA);
    await readyRxOrder(b.id, storeOwnerB);
    const codeA = (await rxOrderDetail(a.id, customer)).code!;
    const codeB = (await rxOrderDetail(b.id, customer)).code!;
    const results = await Promise.allSettled([
      completeRxOrder(a.id, { code: codeA, billNumber: "A-1", items: await billLines(a.id) }, storeOwnerA),
      completeRxOrder(b.id, { code: codeB, billNumber: "B-1", items: await billLines(b.id) }, storeOwnerB),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(String(failed.reason?.message)).toMatch(/more than the doctor prescribed/);
    expect(await dispensed(item.para)).toBe(10);
    // The losing order is untouched (the whole completion rolled back): no bill, no settlement, still at handover.
    const loser = (await reload(a.id)).status === "COMPLETED" ? b.id : a.id;
    expect((await reload(loser)).status).toBe("READY_FOR_PICKUP");
    expect(await adjustments(loser)).toHaveLength(0);
    expect((await linesOf(loser))[0].dispensedQty).toBe(0);
    // Nothing is left to order.
    await expect(send({ shopId: storeA, items: [{ prescriptionItemId: item.para, qty: 1 }] })).rejects.toThrow(/supplied in full/);
    // The database itself refuses an over-dispense.
    await expect(db.update(healthPrescriptionItems).set({ dispensedQty: 11 }).where(eq(healthPrescriptionItems.id, item.para))).rejects.toThrow();
    // The store that lost cancels; the online payment goes back in full.
    if (loser === b.id) {
      const c = await storeCancelRxOrder(b.id, "Stock already supplied elsewhere", storeOwnerB);
      expect(c).toMatchObject({ status: "CANCELLED", paymentStatus: "REFUNDED", refundPaise: c.totalPaise });
    }
  });
});

describe("the store's reply window", () => {
  it("expires an unanswered request, refuses a late quote and offers another store with the same choice", async () => {
    const o = await send({ items: [{ prescriptionItemId: item.para, qty: 5 }] });
    const [notice] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, `health-rx-expiry:${o.id}`));
    // Not due yet: nothing happens.
    expect(await expireRxOrderNotice(notice)).toBe(false);
    expect((await reload(o.id)).status).toBe("SENT");
    expect(await expireRxOrderNotice(notice, new Date(Date.now() + 16 * 60_000))).toBe(true);
    expect((await reload(o.id)).status).toBe("EXPIRED");
    expect(await expireRxOrderNotice(notice, new Date(Date.now() + 17 * 60_000))).toBe(false);
    await expect(quoteAll(o.id)).rejects.toThrow(/already answered|closed/);
    const mine = await rxOrderDetail(o.id, customer);
    expect(mine.can.sendElsewhere).toBe(true);
    // The store that let it lapse no longer sees the prescription.
    const theirs = await rxOrderDetail(o.id, storeOwnerA);
    expect(theirs.prescription).toBeNull();
    expect(theirs.lines).toHaveLength(0);
    const opts = await rxOrderOptions({ prescriptionId: rxId, fromOrderId: o.id }, customer);
    expect(opts.preselect).toEqual([{ prescriptionItemId: item.para, qty: 5 }]);
    const again = await send({ shopId: storeB, items: opts.preselect, fromOrderId: o.id });
    expect(again.status).toBe("SENT");
  });

  it("expires a request at quote time when the reply window has passed", async () => {
    const o = await send();
    await db.update(healthRxOrders).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(healthRxOrders.id, o.id));
    await expect(quoteAll(o.id)).rejects.toThrow(/time to reply has passed/);
    expect((await reload(o.id)).status).toBe("EXPIRED");
  });

  it("lets the store decline with a reason", async () => {
    const o = await send();
    await expect(declineRxOrder(o.id, "", storeOwnerA)).rejects.toThrow(/why/);
    const d = await declineRxOrder(o.id, "Out of stock", storeOwnerA);
    expect(d).toMatchObject({ status: "DECLINED", declineReason: "Out of stock" });
    expect((await rxOrderDetail(o.id, customer)).can.sendElsewhere).toBe(true);
  });
});

describe("cancellation and problems", () => {
  it("refunds an online payment in full when the patient cancels before packing", async () => {
    const o = await send();
    await quoteAll(o.id);
    const p = await approveRxOrder(o.id, { paymentMode: "ONLINE" }, customer);
    await simulateSandboxCheckout({ ref: p.intentId!, viewerId: customer.id, outcome: "SUCCESS" });
    expect((await reload(o.id)).status).toBe("PAID");
    const c = await cancelRxOrder(o.id, "Bought elsewhere", customer);
    expect(c).toMatchObject({ status: "CANCELLED", paymentStatus: "REFUNDED", refundPaise: 20_000 });
    const refunds = await db.select().from(paymentRefunds).where(like(paymentRefunds.idempotencyKey, `healthrx:${o.id}:refund:cancel:%`));
    expect(refunds.map((r) => r.amountPaise)).toEqual([20_000]);
    expect(await adjustments(o.id)).toHaveLength(0);
    expect((await db.select({ name: healthEvents.name }).from(healthEvents).where(eq(healthEvents.subjectId, o.id))).map((e) => e.name)).toContain("rx.cancelled");
  });

  it("opens a help-desk ticket linked to the store", async () => {
    const o = await send();
    await quoteAll(o.id);
    const t = await reportRxProblem(o.id, { reason: "The store quoted a much higher price than the MRP." }, customer);
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, t.ticketId));
    expect(ticket).toMatchObject({ shopId: storeA, priority: "HIGH", category: "ORDER" });
    expect(ticket.description).not.toMatch(/Amoxicillin|Paracetamol/);
    await expect(reportRxProblem(o.id, { reason: "Again and again and again" }, customer)).rejects.toThrow(/already open/);
    await expect(reportRxProblem(o.id, { reason: "Not my order at all, really." }, stranger)).rejects.toThrow(/not found/i);
  });
});

describe("privacy", () => {
  it("shows a store only the prescriptions sent to it, and logs each look", async () => {
    const o = await send();
    await expect(rxOrderDetail(o.id, storeOwnerB)).rejects.toThrow(/not found/i);
    await expect(prescriptionView(rxId, storeOwnerB)).rejects.toThrow(/not found/i);
    await expect(rxOrderDetail(o.id, stranger)).rejects.toThrow(/not found/i);
    await expect(storeRxInbox(storeA, storeOwnerB)).rejects.toThrow(/not found/i);
    const view = await rxOrderDetail(o.id, storeOwnerA);
    expect(view.viewer).toBe("STORE");
    expect(view.prescription).toMatchObject({ registration: "MMC-12345" });
    expect(view.checks).toMatchObject({ doctorVerified: true, qrValid: true, withinValidity: true, itemsAllowedOnline: true });
    expect(view.lines.map((l) => l.genericName)).toEqual(["Paracetamol", "Amoxicillin"]);
    const logs = await db.select().from(healthAccessLog).where(and(eq(healthAccessLog.patientId, patientId), eq(healthAccessLog.actorRole, "STORE")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    // Events carry ids and statuses only.
    const events = await db.select().from(healthEvents).where(eq(healthEvents.subjectId, o.id));
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Paracetamol|Amoxicillin|Asha/);
    expect((await myRxOrders(customer)).map((x) => x.id)).toEqual([o.id]);
    expect(await myRxOrders(stranger)).toEqual([]);
  });
});

describe("pharmacy profile", () => {
  it("goes back to review when the licence changes, and only staff verify", async () => {
    await expect(verifyPharmacy(storeA, "VERIFIED", null, storeOwnerA)).rejects.toThrow(/staff/);
    await expect(savePharmacyProfile(storeA, { drugLicenceNumber: "MH-PZ-20/21-12345", pharmacistName: "Sunil Kale", pharmacistRegistrationNumber: "MSPC-55667", pharmacyCouncil: "Maharashtra State Pharmacy Council", deliveryRadiusKm: 8 }, storeOwnerB)).rejects.toThrow(/not found/i);
    const same = await savePharmacyProfile(storeA, { drugLicenceNumber: "MH-PZ-20/21-12345", pharmacistName: "Sunil Kale", pharmacistRegistrationNumber: "MSPC-55667", pharmacyCouncil: "Maharashtra State Pharmacy Council", deliveryRadiusKm: 8 }, storeOwnerA);
    expect(same).toMatchObject({ verification: "VERIFIED", deliveryRadiusKm: 8 });
    const changed = await savePharmacyProfile(storeA, { drugLicenceNumber: "MH-PZ-20/21-99999", pharmacistName: "Sunil Kale", pharmacistRegistrationNumber: "MSPC-55667" }, storeOwnerA);
    expect(changed.verification).toBe("PENDING");
    await expect(send()).rejects.toThrow(/not verified/);
    await expect(verifyPharmacy(storeA, "REJECTED", "", admin)).rejects.toThrow(/reason/);
    expect((await verifyPharmacy(storeA, "VERIFIED", null, admin)).verification).toBe("VERIFIED");
  });
});
