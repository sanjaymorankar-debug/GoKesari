/**
 * GoKesari Health Prime + Find a doctor (docs/health/, owner brief §2.2 and §5), against real PostgreSQL:
 *   - prices come from the admin's plans (no code change), term discount only without an explicit price,
 *     city-scoped plans, GST 18% on its own line, coupons
 *   - purchase through the sandbox payment → ACTIVE, invoice number + PDF, virtual number, instant booking
 *   - renewal stacks; expiry → GRACE → EXPIRED, Free listing again, bookings untouched
 *   - telephony webhook (signed): missed call logged masked, counted, clinic told
 *   - pay-per-booking fee for a new patient; profile analytics
 *   - Find a doctor: a Prime doctor ranks above an otherwise equal Free one and is labelled; Free still
 *     listed; an unverified doctor is never listed
 */
import { createHmac } from "node:crypto";

import { and, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { db } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  consultProfiles,
  financialAdjustments,
  healthCallLogs,
  healthEvents,
  healthPrimeCoupons,
  healthPrimePlans,
  healthPrimeSubscriptions,
  healthVirtualNumbers,
  notifications,
  scheduledNotices,
  type HealthPrimePlan,
  type ScheduledNotice,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { verifyProfile } from "@/server/consult/admin";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { createHealthBooking } from "@/server/health/booking";
import { saveDoctorProfile } from "@/server/health/doctors";
import { searchDoctors } from "@/server/health/find-doctor";
import { bookingContext, doctorPublicProfile } from "@/server/health/find-doctor-views";
import { acceptHealthNotice } from "@/server/health/patients";
import {
  addMonths,
  applyPrimeExpiryNotice,
  plansForShop,
  primeShopView,
  primeTierForShop,
  profileAnalytics,
  quotePrime,
  recordProfileView,
  saveCoupon,
  savePlan,
  sendPrimeRenewalNotice,
  startPrimePurchase,
  syncInstantBooking,
} from "@/server/health/prime";
import { primeInvoice, primeInvoicePdf } from "@/server/health/prime-invoice";
import { maskCaller, recordTelephonyCall, verifyTelephonyRequest } from "@/server/health/telephony";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));
const SEEDED = ["DOCTOR_FREE", "DOCTOR_PRIME", "DOCTOR_PRIME_PLUS", "CARE_PRIME", "EQUIPMENT_PRIME"];
const actorOf = (u: { id: string; role: string; name?: string | null }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"], name: u.name ?? null });
const tomorrowAt = (hhmm: string) => istAt(addDays(istDateKey(new Date()), 1), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString();

let seedPlans: HealthPrimePlan[] = [];
let admin: ConsultActor;
let customer: ConsultActor;
let clinic: Clinic;
let regNo = 100;

interface Clinic {
  owner: ConsultActor;
  shopId: string;
  memberId: string;
  svc: string;
}

async function rules(over: Record<string, unknown> = {}) {
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  // Paid Prime is tested with the launch mode off; "launch mode" below covers primeForAll (the default).
  await setRule("health", { ...RULES.health.defaults, enabled: true, primeForAll: false, ...over } as never, admin);
  clearRuleCache();
}

async function makeClinic(name: string, opts: { verified?: boolean } = {}): Promise<Clinic> {
  const owner = actorOf(await createUser({ role: "SHOP_OWNER", name: `Owner of ${name}` }));
  const shop = await createShop(owner.id, { name, shopType: "DOCTOR_CLINIC", latitude: 18.5204, longitude: 73.8567 });
  await ensureProfile(shop.id, owner);
  await updateProfile(shop.id, { displayName: name, headline: "General physician", minNoticeMinutes: 0 }, owner);
  const [gp] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "general-physician"));
  const [{ id: memberId }] = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${shop.id} and is_owner`);
  regNo += 1;
  await saveMember(shop.id, { id: memberId, name: `Dr ${name.split(" ")[0]}`, categoryIds: [gp.id], languages: ["English", "Marathi"], registrationNumber: `MMC-${regNo}`, registrationBody: "Maharashtra Medical Council" }, owner);
  await setMemberHours(shop.id, memberId, EVERY_DAY, owner);
  const svc = (await saveService(shop.id, { name: "Consultation", durationMinutes: 15, modes: ["IN_PERSON"], categoryId: gp.id, feeType: "FREE" }, owner)).id;
  await uploadMemberDocument(shop.id, memberId, { name: "mmc.pdf", bytes: PDF }, owner);
  const live = await publishProfile(shop.id, owner);
  if (opts.verified !== false) await verifyProfile(live.id, { decision: "VERIFIED", members: [{ id: memberId, decision: "VERIFIED" }] }, admin);
  await saveDoctorProfile(memberId, { fullName: `${name.split(" ")[0]} Kulkarni`, qualifications: "MBBS", specialties: ["General Medicine"], council: "Maharashtra Medical Council", registrationNumber: `MMC-${regNo}`, registrationYear: 2010 }, owner);
  return { owner, shopId: shop.id, memberId, svc };
}

async function planId(code: string): Promise<string> {
  const [p] = await db.select({ id: healthPrimePlans.id }).from(healthPrimePlans).where(eq(healthPrimePlans.code, code));
  return p.id;
}

/** Buys a plan for the clinic and pays at the sandbox gateway; returns the subscription. */
async function buyAndPay(c: Clinic, code = "DOCTOR_PRIME", term: "MONTHLY" | "QUARTERLY" | "YEARLY" = "MONTHLY", couponCode?: string) {
  const r = await startPrimePurchase(c.shopId, { planId: await planId(code), term, couponCode }, c.owner);
  expect(r.subscription.status).toBe("PENDING_PAYMENT");
  expect(r.intentId).toBeTruthy();
  await simulateSandboxCheckout({ ref: r.intentId!, viewerId: c.owner.id, outcome: "SUCCESS" });
  const [sub] = await db.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, r.subscription.id));
  return sub;
}

async function noticeByKey(key: string): Promise<ScheduledNotice> {
  const [n] = await db.select().from(scheduledNotices).where(eq(scheduledNotices.key, key));
  expect(n, `notice ${key}`).toBeTruthy();
  return n;
}

const manualApproval = async (shopId: string) => (await db.select({ m: consultProfiles.manualApproval }).from(consultProfiles).where(eq(consultProfiles.shopId, shopId)))[0].m;

beforeAll(async () => {
  seedPlans = await db.select().from(healthPrimePlans).where(inArray(healthPrimePlans.code, SEEDED));
  expect(seedPlans).toHaveLength(5);
});

afterAll(async () => {
  for (const p of seedPlans) await db.update(healthPrimePlans).set({ prices: p.prices, status: p.status, city: p.city, specialty: p.specialty, features: p.features }).where(eq(healthPrimePlans.id, p.id));
});

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health')`);
  // Plans, coupons and counters are not under the users / shops cascade.
  await db.delete(healthPrimePlans).where(notInArray(healthPrimePlans.code, SEEDED));
  for (const p of seedPlans) await db.update(healthPrimePlans).set({ prices: p.prices, status: p.status, city: p.city, specialty: p.specialty, features: p.features, quotas: p.quotas }).where(eq(healthPrimePlans.id, p.id));
  await db.delete(healthPrimeCoupons);
  await db.execute(sql`delete from health.counters where series like 'PRIME-%' or series = 'HEALTH-VNUM'`);
  admin = actorOf(await createUser({ role: "ADMIN", name: "Admin" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha Patil" }));
  await rules();
  clinic = await makeClinic("Mehta Clinic");
});

describe("plans and prices (admin-built, never in code)", () => {
  it("prices a plan from the admin's figures, adds GST 18% on its own line, and follows a price change at once", async () => {
    const q = await quotePrime(clinic.shopId, { planId: await planId("DOCTOR_PRIME"), term: "MONTHLY" });
    expect(q).toMatchObject({ pricePaise: 99_900, discountPaise: 0, taxablePaise: 99_900, gstBp: 1800, gstPaise: 17_982, totalPaise: 117_882 });
    // Admin changes the plan: monthly ₹1,500, yearly ₹12,000, quarterly left empty (rule's term discount, 10%).
    const id = await planId("DOCTOR_PRIME");
    const [p] = await db.select().from(healthPrimePlans).where(eq(healthPrimePlans.id, id));
    await expect(savePlan({ id, code: p.code, name: p.name, audience: "DOCTOR", tier: "PRIME", features: p.features, quotas: p.quotas, pricesRupees: { MONTHLY: 1500, YEARLY: 12000 } }, clinic.owner)).rejects.toThrow(/staff/i);
    await savePlan({ id, code: p.code, name: p.name, audience: "DOCTOR", tier: "PRIME", features: p.features, quotas: p.quotas, pricesRupees: { MONTHLY: 1500, QUARTERLY: null, YEARLY: 12000 } }, admin);
    expect((await quotePrime(clinic.shopId, { planId: id, term: "MONTHLY" })).pricePaise).toBe(150_000);
    expect((await quotePrime(clinic.shopId, { planId: id, term: "YEARLY" })).pricePaise).toBe(1_200_000);
    const quarterly = await quotePrime(clinic.shopId, { planId: id, term: "QUARTERLY" });
    expect(quarterly).toMatchObject({ pricePaise: 405_000, listPaise: 450_000, termSavingPaise: 45_000, gstPaise: 72_900, totalPaise: 477_900 });
    // The term discount is a rule setting too.
    await rules({ primeTermDiscountBp: { QUARTERLY: 2000, YEARLY: 1700 } });
    expect((await quotePrime(clinic.shopId, { planId: id, term: "QUARTERLY" })).pricePaise).toBe(360_000);
    // GST rate from the rule.
    await rules({ primeGstBp: 500 });
    expect((await quotePrime(clinic.shopId, { planId: id, term: "MONTHLY" })).gstPaise).toBe(7_500);
  });

  it("shows a shop the most specific plan for its city, and never another city's plan", async () => {
    const general = await planId("DOCTOR_PRIME");
    await savePlan({ code: "DOCTOR_PRIME_PUNE", name: "Prime (Pune)", audience: "DOCTOR", tier: "PRIME", city: "Pune", features: { instantBooking: true, priorityPlacement: true, badge: true, virtualNumber: true }, pricesRupees: { MONTHLY: 799 } }, admin);
    await savePlan({ code: "DOCTOR_PRIME_MUMBAI", name: "Prime (Mumbai)", audience: "DOCTOR", tier: "PRIME", city: "Mumbai", features: { instantBooking: true }, pricesRupees: { MONTHLY: 1299 } }, admin);
    const plans = await plansForShop(clinic.shopId); // the fixture shop is in Pune
    const prime = plans.filter((p) => p.tier === "PRIME");
    expect(prime.map((p) => p.code)).toEqual(["DOCTOR_PRIME_PUNE"]);
    expect(prime[0].termPrices.MONTHLY).toBe(79_900);
    expect(plans.map((p) => p.code)).toEqual(expect.arrayContaining(["DOCTOR_FREE", "DOCTOR_PRIME_PLUS"]));
    // The general plan is not on offer to this shop any more.
    await expect(quotePrime(clinic.shopId, { planId: general, term: "MONTHLY" })).rejects.toThrow(/not found/i);
    await expect(quotePrime(clinic.shopId, { planId: await planId("DOCTOR_PRIME_MUMBAI"), term: "MONTHLY" })).rejects.toThrow(/not found/i);
  });

  it("takes a coupon's % off before GST, refuses a bad one, and counts it once paid", async () => {
    await expect(saveCoupon({ code: "WELCOME10", percentOff: 10, maxUses: 1 }, clinic.owner)).rejects.toThrow(/staff/i);
    await saveCoupon({ code: "welcome10", percentOff: 10, maxUses: 1 }, admin);
    const id = await planId("DOCTOR_PRIME");
    const q = await quotePrime(clinic.shopId, { planId: id, term: "MONTHLY", couponCode: "WELCOME10" });
    expect(q).toMatchObject({ pricePaise: 99_900, couponCode: "WELCOME10", couponPercent: 10, discountPaise: 9_990, taxablePaise: 89_910, gstPaise: 16_184, totalPaise: 106_094 });
    await expect(quotePrime(clinic.shopId, { planId: id, term: "MONTHLY", couponCode: "NOPE" })).rejects.toThrow(/not valid/);
    await saveCoupon({ code: "OLD", percentOff: 50, validUntil: new Date(Date.now() - 60_000).toISOString() }, admin);
    await expect(quotePrime(clinic.shopId, { planId: id, term: "MONTHLY", couponCode: "OLD" })).rejects.toThrow(/expired/);
    const sub = await buyAndPay(clinic, "DOCTOR_PRIME", "MONTHLY", "WELCOME10");
    expect(sub).toMatchObject({ status: "ACTIVE", discountPaise: 9_990, totalPaise: 106_094, couponCode: "WELCOME10" });
    const [c] = await db.select().from(healthPrimeCoupons).where(eq(healthPrimeCoupons.code, "WELCOME10"));
    expect(c.used).toBe(1);
    await expect(quotePrime(clinic.shopId, { planId: id, term: "MONTHLY", couponCode: "WELCOME10" })).rejects.toThrow(/used up/);
  });
});

describe("purchase, renewal and expiry", () => {
  it("activates on a sandbox payment: invoice, tax invoice PDF, virtual number, instant booking on", async () => {
    expect(await syncInstantBooking(clinic.shopId)).toBe(true); // Free + rule on → the clinic confirms requests
    expect(await manualApproval(clinic.shopId)).toBe(true);
    await expect(startPrimePurchase(clinic.shopId, { planId: await planId("DOCTOR_PRIME"), term: "MONTHLY" }, customer)).rejects.toThrow(/not found/i);
    const before = Date.now();
    const sub = await buyAndPay(clinic);
    expect(sub.status).toBe("ACTIVE");
    expect(sub.invoiceNumber).toMatch(/^PRM\/\d{4}\/000001$/);
    expect(sub.startsAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(sub.endsAt!.getTime()).toBe(addMonths(sub.startsAt!, 1).getTime());
    expect(sub.totalPaise).toBe(117_882);
    const tier = await primeTierForShop(clinic.shopId);
    expect(tier).toMatchObject({ tier: "PRIME", label: "Prime", subscriptionId: sub.id, inGrace: false });
    expect(tier.features.priorityPlacement).toBe(true);
    expect(await manualApproval(clinic.shopId)).toBe(false);
    const [vn] = await db.select().from(healthVirtualNumbers).where(eq(healthVirtualNumbers.shopId, clinic.shopId));
    expect(vn).toMatchObject({ status: "ACTIVE", provider: "mock" });
    expect(vn.number).toMatch(/^\+91 80 4\d{3} \d{4}$/);
    // Renewal reminder 7 days before the end, expiry at the end.
    expect((await noticeByKey(`health-prime-renewal:${sub.id}`)).dueAt.getTime()).toBe(sub.endsAt!.getTime() - 7 * 86_400_000);
    expect((await noticeByKey(`health-prime-expiry:${sub.id}`)).dueAt.getTime()).toBe(sub.endsAt!.getTime());
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "prime.subscribed"), eq(healthEvents.subjectId, sub.id)))).toHaveLength(1);
    // GST tax invoice (GoKesari is the supplier; intra-state: CGST + SGST = GST 18%).
    const inv = await primeInvoice(sub.id, clinic.owner);
    expect(inv).toMatchObject({ invoiceNumber: sub.invoiceNumber, taxablePaise: 99_900, gstRateBp: 1800, gstPaise: 17_982, totalPaise: 117_882, supplyType: "INTRA" });
    expect(inv.cgstPaise + inv.sgstPaise).toBe(17_982);
    const { pdf } = await primeInvoicePdf(sub.id, clinic.owner);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("GST 18%");
    await expect(primeInvoice(sub.id, customer)).rejects.toThrow(/not found/i);
    // The shop's page has it all.
    const view = await primeShopView(clinic.shopId, clinic.owner);
    expect(view.tier.tier).toBe("PRIME");
    expect(view.virtualNumber?.number).toBe(vn.number);
    expect(view.subscriptions[0].invoiceNumber).toBe(sub.invoiceNumber);
    // A renewal reminder goes out while it is not renewed.
    expect(await sendPrimeRenewalNotice(await noticeByKey(`health-prime-renewal:${sub.id}`))).toBe(true);
  });

  it("stacks a renewal after the current plan's end", async () => {
    const first = await buyAndPay(clinic, "DOCTOR_PRIME", "MONTHLY");
    const second = await buyAndPay(clinic, "DOCTOR_PRIME", "YEARLY");
    expect(second.status).toBe("ACTIVE");
    expect(second.startsAt!.getTime()).toBe(first.endsAt!.getTime());
    expect(second.endsAt!.getTime()).toBe(addMonths(first.endsAt!, 12).getTime());
    expect(second.invoiceNumber).toMatch(/\/000002$/);
    // Renewed: no reminder for the first plan.
    expect(await sendPrimeRenewalNotice(await noticeByKey(`health-prime-renewal:${first.id}`))).toBe(false);
    // Its end passes quietly (the renewal follows on), no grace.
    expect(await applyPrimeExpiryNotice(await noticeByKey(`health-prime-expiry:${first.id}`), new Date(first.endsAt!.getTime() + 60_000))).toBe(true);
    const [f] = await db.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, first.id));
    expect(f.status).toBe("EXPIRED");
    expect((await primeTierForShop(clinic.shopId, new Date(first.endsAt!.getTime() + 60_000))).subscriptionId).toBe(second.id);
  });

  it("expires through the grace days back to the Free listing, leaving bookings as they were", async () => {
    await syncInstantBooking(clinic.shopId);
    const sub = await buyAndPay(clinic);
    const self = await acceptHealthNotice(customer);
    const booked = await createHealthBooking({ patientId: self.id, serviceId: clinic.svc, memberId: clinic.memberId, mode: "IN_PERSON", start: tomorrowAt("10:00"), shareRecords: "OFF", consent: true }, customer);
    expect(booked.booking.status).toBe("CONFIRMED"); // Prime: instant booking
    const [bookingBefore] = await db.select().from(consultBookings).where(eq(consultBookings.id, booked.booking.id));
    // At the end: GRACE (still Prime) for the rule's 7 days.
    const atEnd = new Date(sub.endsAt!.getTime() + 60_000);
    expect(await applyPrimeExpiryNotice(await noticeByKey(`health-prime-expiry:${sub.id}`), atEnd)).toBe(true);
    let [s] = await db.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, sub.id));
    expect(s.status).toBe("GRACE");
    expect(s.graceUntil!.getTime()).toBe(sub.endsAt!.getTime() + 7 * 86_400_000);
    expect(await primeTierForShop(clinic.shopId, atEnd)).toMatchObject({ tier: "PRIME", inGrace: true });
    expect(await manualApproval(clinic.shopId)).toBe(false);
    // Grace over: EXPIRED, Free again, number released, the clinic confirms requests again.
    const afterGrace = new Date(s.graceUntil!.getTime() + 60_000);
    expect(await applyPrimeExpiryNotice(await noticeByKey(`health-prime-grace:${sub.id}`), afterGrace)).toBe(true);
    [s] = await db.select().from(healthPrimeSubscriptions).where(eq(healthPrimeSubscriptions.id, sub.id));
    expect(s.status).toBe("EXPIRED");
    expect((await primeTierForShop(clinic.shopId, afterGrace)).tier).toBe("FREE");
    const [vn] = await db.select().from(healthVirtualNumbers).where(eq(healthVirtualNumbers.shopId, clinic.shopId));
    expect(vn.status).toBe("RELEASED");
    expect(await manualApproval(clinic.shopId)).toBe(true);
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "prime.expired"), eq(healthEvents.subjectId, sub.id)))).toHaveLength(1);
    const [bookingAfter] = await db.select().from(consultBookings).where(eq(consultBookings.id, booked.booking.id));
    expect(bookingAfter).toEqual(bookingBefore);
    // A second run changes nothing.
    expect(await applyPrimeExpiryNotice(await noticeByKey(`health-prime-grace:${sub.id}`), afterGrace)).toBe(false);
  });
});

describe("call tracking", () => {
  it("accepts only signed webhook calls, logs a missed call masked, counts it and tells the clinic", async () => {
    await buyAndPay(clinic);
    const [vn] = await db.select().from(healthVirtualNumbers).where(eq(healthVirtualNumbers.shopId, clinic.shopId));
    const body = JSON.stringify({ callId: "call-1", virtualNumber: vn.number.replace(/\s/g, ""), caller: "+91 98765 43210", startedAt: new Date().toISOString(), durationSeconds: 0, status: "MISSED" });
    const sign = (raw: string) => createHmac("sha256", "s3cret").update(raw).digest("hex");
    expect(await verifyTelephonyRequest(body, sign(body), { secret: "s3cret" })).toEqual({ ok: true });
    expect((await verifyTelephonyRequest(body, sign(`${body} `), { secret: "s3cret" })).ok).toBe(false);
    expect((await verifyTelephonyRequest(body, null, { secret: null, nodeEnv: "production" })).ok).toBe(false);
    expect((await verifyTelephonyRequest(body, null, { secret: null, nodeEnv: "development" })).ok).toBe(true);
    expect(maskCaller("+91 98765 43210")).toBe("XXXXXX3210");
    // Through the route, signed with the environment's secret.
    const prev = process.env.HEALTH_TELEPHONY_WEBHOOK_SECRET;
    process.env.HEALTH_TELEPHONY_WEBHOOK_SECRET = "s3cret";
    try {
      const { POST } = await import("@/app/api/health/telephony/webhook/route");
      const unsigned = await POST(new NextRequest("http://localhost/api/health/telephony/webhook", { method: "POST", body }));
      expect(unsigned.status).toBe(403);
      const res = await POST(new NextRequest("http://localhost/api/health/telephony/webhook", { method: "POST", body, headers: { "x-gokesari-signature": `sha256=${sign(body)}` } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logged: true, reason: null });
    } finally {
      if (prev === undefined) delete process.env.HEALTH_TELEPHONY_WEBHOOK_SECRET;
      else process.env.HEALTH_TELEPHONY_WEBHOOK_SECRET = prev;
    }
    const [log] = await db.select().from(healthCallLogs).where(eq(healthCallLogs.providerCallId, "call-1"));
    expect(log).toMatchObject({ shopId: clinic.shopId, status: "MISSED", callerMasked: "XXXXXX3210", durationSeconds: 0 });
    expect(JSON.stringify(log)).not.toContain("98765");
    // A retried webhook changes nothing.
    expect((await recordTelephonyCall(JSON.parse(body))).logged).toBe(false);
    await recordTelephonyCall({ callId: "call-2", virtualNumber: vn.number, caller: "9822000011", startedAt: new Date().toISOString(), durationSeconds: 95, status: "ANSWERED" });
    const a = await profileAnalytics(clinic.shopId, 7);
    expect(a).toMatchObject({ calls: 2, missedCalls: 1 });
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, clinic.owner.id), eq(notifications.type, "health.call_missed")));
    expect(told).toHaveLength(1);
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "call.missed"), eq(healthEvents.subjectId, log.id)))).toHaveLength(1);
    expect((await recordTelephonyCall({ callId: "call-3", virtualNumber: "+91 80 9999 9999", startedAt: new Date().toISOString(), status: "MISSED" })).logged).toBe(false);
  });
});

describe("pay-per-booking and analytics", () => {
  it("charges a Free clinic once for a new patient, not for a returning one, and not a Prime clinic", async () => {
    await rules({ payPerBooking: true, feePerBookingPaise: 5000 });
    const self = await acceptHealthNotice(customer);
    const book = (c: Clinic, at: string) => createHealthBooking({ patientId: self.id, serviceId: c.svc, memberId: c.memberId, mode: "IN_PERSON", start: tomorrowAt(at), shareRecords: "OFF", consent: true }, customer);
    const first = await book(clinic, "10:00");
    const fees = () => db.select().from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, "healthppb:%"));
    expect(await fees()).toEqual([expect.objectContaining({ shopId: clinic.shopId, amountPaise: -5000, idempotencyKey: `healthppb:${first.booking.id}`, type: "SHOP_ADJUSTMENT", party: "SHOP" })]);
    await book(clinic, "11:00"); // returning patient
    expect(await fees()).toHaveLength(1);
    const prime = await makeClinic("Rao Clinic");
    await buyAndPay(prime);
    await book(prime, "10:00"); // new patient there, but Prime: no per-booking fee
    expect(await fees()).toHaveLength(1);
    // Analytics: views, bookings, conversion.
    for (let i = 0; i < 3; i += 1) await recordProfileView(clinic.shopId);
    expect(await profileAnalytics(clinic.shopId, 30)).toMatchObject({ views: 3, bookings: 2, conversionPct: 66.7 });
  });
});

describe("Find a doctor", () => {
  it("ranks a Prime doctor above an otherwise equal Free one (labelled), keeps the Free one, never lists an unverified one", async () => {
    const prime = await makeClinic("Rao Clinic");
    const unverified = await makeClinic("Shah Clinic", { verified: false });
    await buyAndPay(prime);
    const near = { lat: 18.5204, lng: 73.8567 };
    const r = await searchDoctors({ specialty: "general-physician", ...near });
    const ids = r.results.map((c) => c.memberId);
    expect(ids[0]).toBe(prime.memberId);
    expect(r.results[0]).toMatchObject({ tier: "PRIME", primeLabel: "Prime", boosted: true, verified: true });
    const free = r.results.find((c) => c.memberId === clinic.memberId);
    expect(free).toMatchObject({ tier: "FREE", primeLabel: null, boosted: false });
    expect(r.results[0].score - free!.score).toBe(12);
    expect(ids).not.toContain(unverified.memberId);
    // Symptom → specialty; name; the Prime filter; area.
    expect((await searchDoctors({ symptom: "fever and cough" })).results.map((c) => c.memberId)).toEqual(expect.arrayContaining([clinic.memberId, prime.memberId]));
    expect((await searchDoctors({ q: "Rao" })).results.map((c) => c.memberId)).toEqual([prime.memberId]);
    expect((await searchDoctors({ prime: "1" })).results.map((c) => c.memberId)).toEqual([prime.memberId]);
    expect((await searchDoctors({ area: "Pune" })).results).toHaveLength(2);
    expect((await searchDoctors({ symptom: "toothache" })).results).toHaveLength(0);
    // Health groups (0160, owner 21-Nov-2026): general physicians are under "General & family", not "Dental";
    // plain words typed in the search box ("fever") find the matching specialists too.
    expect((await searchDoctors({ group: "general" })).results.map((c) => c.memberId)).toEqual(expect.arrayContaining([clinic.memberId, prime.memberId]));
    expect((await searchDoctors({ group: "dental" })).results).toHaveLength(0);
    expect((await searchDoctors({ group: "general", specialty: "dentist" })).results).toHaveLength(0);
    expect((await searchDoctors({ q: "fever" })).results.map((c) => c.memberId)).toEqual(expect.arrayContaining([clinic.memberId, prime.memberId]));
    // Doctor pages: verified only; Prime shows the tracked number.
    await expect(doctorPublicProfile(unverified.memberId)).rejects.toThrow(/not found/i);
    const page = await doctorPublicProfile(prime.memberId);
    expect(page.clinics[0]).toMatchObject({ primeLabel: "Prime", virtualNumber: true });
    expect(page.clinics[0].phone).toMatch(/^\+91 80 4/);
    expect((await doctorPublicProfile(clinic.memberId)).clinics[0]).toMatchObject({ primeLabel: null, virtualNumber: false });
    // Booking screen: the unverified doctor cannot be booked.
    await expect(bookingContext(unverified.svc, unverified.memberId, customer)).rejects.toThrow(/not found/i);
    const ctx = await bookingContext(clinic.svc, clinic.memberId, customer);
    expect(ctx.doctor.memberId).toBe(clinic.memberId);
  });
});

describe("launch mode (rule health.primeForAll, owner decision 20-Nov-2026)", () => {
  it("gives every verified clinic the Prime features, sells no plan, books instantly and ranks without a paid boost", async () => {
    await rules({ primeForAll: true, freeListingManualApproval: true });
    const other = await makeClinic("Rao Clinic");
    const tier = await primeTierForShop(clinic.shopId);
    expect(tier).toMatchObject({ tier: "PRIME", included: true, subscriptionId: null });
    expect(tier.features.instantBooking).toBe(true);
    // Nothing to buy: quote and purchase are refused, the page says so.
    await expect(quotePrime(clinic.shopId, { planId: await planId("DOCTOR_PRIME"), term: "MONTHLY" })).rejects.toThrow(/nothing to buy/);
    await expect(startPrimePurchase(clinic.shopId, { planId: await planId("DOCTOR_PRIME"), term: "MONTHLY" }, clinic.owner)).rejects.toThrow(/nothing to buy/);
    const view = await primeShopView(clinic.shopId, clinic.owner);
    expect(view.launchIncluded).toBe(true);
    expect(view.termsNote).toMatch(/standard registration fee/);
    // Instant booking for everyone (no "Free listing" approval step).
    expect(await syncInstantBooking(clinic.shopId)).toBe(false);
    expect(await manualApproval(clinic.shopId)).toBe(false);
    // Search: both listed, no Prime label or boost (everyone is equal).
    const r = await searchDoctors({ specialty: "general-physician", lat: 18.5204, lng: 73.8567 });
    expect(r.results.map((c) => c.memberId)).toEqual(expect.arrayContaining([clinic.memberId, other.memberId]));
    expect(r.results.every((c) => !c.boosted && c.primeLabel === null)).toBe(true);
  });
});
