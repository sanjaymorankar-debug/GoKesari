/**
 * Consultant appointments (docs/consult-booking-2026-11), against real PostgreSQL:
 *   - setup: profile, team, services, hours, time off, publish rules
 *   - free / pay-at-visit / online bookings; the 10-minute hold; payment success, failure and late capture
 *   - double booking: concurrent attempts, the exclusion constraint itself, group capacity, team bookings
 *   - customer and consultant cancellation with policy refunds; reschedule limits; manual approval
 *   - completion with the customer's code; no-show; offline payment and receipt; settlement lines
 *   - privacy and permissions; disputes; discovery (nearby, filters, next free time); rule off
 */
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { db } from "@/server/db";
import {
  consultAccessLogs,
  consultBookingMembers,
  consultBookings,
  consultCategories,
  financialAdjustments,
  notifications,
  paymentIntents,
  paymentRefunds,
  scheduledNotices,
  shops,
  supportTickets,
  type ConsultBooking,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import { bookingViewer, type ConsultActor } from "@/server/consult/access";
import { consultReport, listAllBookings, saveCategory, verifyProfile } from "@/server/consult/admin";
import {
  cancelBooking,
  completeBooking,
  createBooking,
  decideBooking,
  expireLapsedHolds,
  markNoShow,
  markOfflinePaid,
  raiseDispute,
  rateBooking,
  reassignBooking,
  rescheduleBooking,
} from "@/server/consult/bookings";
import { publicAvailability, searchConsultants } from "@/server/consult/discovery";
import { readBookingFile, signedFileUrl, checkSignature, uploadBookingFile } from "@/server/consult/files";
import { completionCode } from "@/server/consult/otp";
import { addTimeOff, ensureProfile, publishProfile, publishProblems, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { bookingDetail, firmCalendar, firmDashboard, receiptView } from "@/server/consult/views";
import { sendConsultReminder } from "@/server/consult/notify";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, start: "09:00", end: "13:00" },
  { weekday, start: "16:00", end: "21:00" },
]);

let admin: ConsultActor;
let owner: ConsultActor;
let customer: ConsultActor;
let customer2: ConsultActor;
let shopId: string;
let ownerMemberId: string;
let secondMemberId: string;
let svc: { free: string; fixed: string; deposit: string; group: string; team: string; video: string };

const tomorrow = () => addDays(istDateKey(new Date()), 1);
const slot = (hhmm: string, day = tomorrow()) => istAt(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString();
const reload = async (id: string): Promise<ConsultBooking> => (await db.select().from(consultBookings).where(eq(consultBookings.id, id)))[0];
const actorOf = (u: { id: string; role: string }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"] });

async function consultRule(over: Partial<(typeof RULES)["consultBooking"]["defaults"]> = {}) {
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true, ...over }, admin);
  clearRuleCache();
}

function book(over: Record<string, unknown> = {}, who: ConsultActor = customer) {
  return createBooking({ serviceId: svc.free, memberId: ownerMemberId, mode: "IN_PERSON", start: slot("10:00"), visitorName: "Asha Patil", visitorPhone: "9876543210", consent: true, ...over }, who);
}

async function payAtSandbox(intentId: string, who: ConsultActor, outcome: "SUCCESS" | "FAILURE" | "EXPIRE" = "SUCCESS") {
  return simulateSandboxCheckout({ ref: intentId, viewerId: who.id, outcome });
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key = 'consultBooking'`);
  admin = actorOf(await createUser({ role: "ADMIN" }));
  owner = actorOf(await createUser({ role: "SHOP_OWNER", name: "Dr Mehta" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha" }));
  customer2 = actorOf(await createUser({ role: "CUSTOMER", name: "Ravi" }));
  await consultRule();
  const shop = await createShop(owner.id, { name: "Mehta Clinic", shopType: "DOCTOR_CLINIC", latitude: 18.5204, longitude: 73.8567 });
  shopId = shop.id;
  await ensureProfile(shopId, owner);
  await updateProfile(shopId, { displayName: "Mehta Family Clinic", headline: "General physician", minNoticeMinutes: 0 }, owner);
  const [gp] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "general-physician"));
  const [it] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "it-software-consultant"));
  const view = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${shopId} and is_owner`);
  ownerMemberId = view[0].id;
  await saveMember(shopId, { id: ownerMemberId, name: "Dr Anil Mehta", categoryIds: [gp.id], languages: ["English", "Marathi"], registrationNumber: "MMC-12345", registrationBody: "Maharashtra Medical Council" }, owner);
  const second = await saveMember(shopId, { name: "Dr Neha Rao", categoryIds: [it.id], languages: ["English", "Kannada"] }, owner);
  secondMemberId = second.id;
  await setMemberHours(shopId, ownerMemberId, EVERY_DAY, owner);
  await setMemberHours(shopId, secondMemberId, EVERY_DAY, owner);
  const base = { durationMinutes: 30, modes: ["IN_PERSON"], categoryId: gp.id };
  svc = {
    free: (await saveService(shopId, { ...base, name: "Free check-up", feeType: "FREE" }, owner)).id,
    fixed: (await saveService(shopId, { ...base, name: "Consultation", feeType: "FIXED", feeRupees: 500, payOnline: true, payAtVisit: true }, owner)).id,
    deposit: (await saveService(shopId, { ...base, name: "Procedure", durationMinutes: 60, feeType: "DEPOSIT", feeRupees: 2000, depositRupees: 500 }, owner)).id,
    group: (await saveService(shopId, { ...base, name: "Diet workshop", durationMinutes: 60, feeType: "FIXED", feeRupees: 300, bookingKind: "GROUP", capacity: 3, memberIds: [ownerMemberId] }, owner)).id,
    team: (await saveService(shopId, { ...base, name: "Joint review", feeType: "FREE", bookingKind: "TEAM", requiredMembers: 2 }, owner)).id,
    video: (await saveService(shopId, { ...base, name: "Video consult", feeType: "FIXED", feeRupees: 400, modes: ["VIDEO", "PHONE"], payAtVisit: false }, owner)).id,
  };
});

describe("setup and publishing", () => {
  it("lists what stops a profile from going live, then publishes and waits for certificate verification", async () => {
    const problems = await publishProblems(shopId);
    expect(problems.map((p) => p.key)).toContain(`doc:${ownerMemberId}`); // a doctor needs the council registration
    await expect(publishProfile(shopId, owner)).rejects.toThrow(/registration certificate/);
    await uploadMemberDocument(shopId, ownerMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
    const live = await publishProfile(shopId, owner);
    expect(live).toMatchObject({ status: "LIVE", verification: "PENDING" });
    const verified = await verifyProfile(live.id, { decision: "VERIFIED", members: [{ id: ownerMemberId, decision: "VERIFIED" }] }, admin);
    expect(verified.verification).toBe("VERIFIED");
  });

  it("keeps a profile unlisted until the shop is approved", async () => {
    await db.update(shops).set({ status: "PENDING_APPROVAL" }).where(eq(shops.id, shopId));
    expect((await publishProblems(shopId)).map((p) => p.key)).toContain("shop");
  });

  it("lets only the owner (or staff) change the setup", async () => {
    await expect(saveService(shopId, { name: "Extra service", durationMinutes: 30, feeType: "FREE", modes: ["IN_PERSON"] }, customer)).rejects.toThrow();
    await expect(saveService(shopId, { name: "Extra service", durationMinutes: 30, feeType: "FREE", modes: ["IN_PERSON"] }, admin)).resolves.toBeTruthy();
  });
});

describe("booking", () => {
  beforeEach(async () => {
    await uploadMemberDocument(shopId, ownerMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
    await publishProfile(shopId, owner);
  });

  it("confirms a free booking at once and schedules the 24 h and 1 h reminders", async () => {
    const { booking, checkoutUrl } = await book();
    expect(checkoutUrl).toBeNull();
    expect(booking).toMatchObject({ status: "CONFIRMED", paymentMode: "FREE", paymentStatus: "NOT_REQUIRED" });
    expect(booking.bookingNumber).toMatch(/^CB\d{4}-\d{6}$/);
    const reminders = await db.select().from(scheduledNotices).where(like(scheduledNotices.key, `consult-reminder:${booking.id}:%`));
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    // The reminder re-checks the booking when it fires.
    expect(await sendConsultReminder(reminders[0])).toBe(true);
  });

  it("never lets two customers take the same time (concurrent requests)", async () => {
    const results = await Promise.allSettled([book({}, customer), book({}, customer2), book({ visitorName: "Third" }, customer)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason?.message));
    expect(errors.every((m) => /just taken/.test(m))).toBe(true);
    const active = await db.select().from(consultBookingMembers).where(and(eq(consultBookingMembers.memberId, ownerMemberId), eq(consultBookingMembers.active, true)));
    expect(active).toHaveLength(1);
  });

  it("is guarded by the database: overlapping active rows for one member are refused", async () => {
    const { booking } = await book();
    const start = new Date(slot("10:15"));
    await expect(
      db.insert(consultBookingMembers).values({ bookingId: booking.id, memberId: ownerMemberId, startsAt: start, blocksUntil: new Date(start.getTime() + 30 * 60_000), shareKey: "intruder" }),
    ).rejects.toThrow();
  });

  it("assigns 'any available member' to the free one", async () => {
    await book();
    const { booking } = await book({ memberId: null }, customer2);
    const rows = await db.select().from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, booking.id));
    expect(rows.map((r) => r.memberId)).toEqual([secondMemberId]);
    expect(booking.anyMember).toBe(true);
  });

  it("books a team appointment on two members together", async () => {
    const { booking } = await book({ serviceId: svc.team, memberId: null, start: slot("11:00") });
    const rows = await db.select().from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, booking.id));
    expect(rows.map((r) => r.memberId).sort()).toEqual([ownerMemberId, secondMemberId].sort());
    await expect(book({ memberId: secondMemberId, start: slot("11:00") }, customer2)).rejects.toThrow(/just taken/);
  });

  it("fills a group session up to its capacity", async () => {
    const a = await book({ serviceId: svc.group, start: slot("16:00"), attendees: 2, paymentMode: "PAY_AT_VISIT" });
    expect(a.booking.feePaise).toBe(60_000); // ₹300 × 2
    const b = await book({ serviceId: svc.group, start: slot("16:00"), attendees: 1, paymentMode: "PAY_AT_VISIT" }, customer2);
    expect(b.booking.status).toBe("CONFIRMED");
    await expect(book({ serviceId: svc.group, start: slot("16:00"), attendees: 1, paymentMode: "PAY_AT_VISIT" }, customer2)).rejects.toThrow(/just taken/);
    const avail = await publicAvailability({ serviceId: svc.group, from: tomorrow(), days: 1 });
    expect(avail.days[tomorrow()].some((s) => s.start === slot("16:00"))).toBe(false);
  });

  it("holds the time during online payment, confirms on success, and issues a receipt", async () => {
    const { booking, checkoutUrl, intentId } = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    expect(booking).toMatchObject({ status: "PENDING_PAYMENT", onlineDuePaise: 50_000 });
    expect(checkoutUrl).toBeTruthy();
    expect(booking.holdExpiresAt!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    await expect(book({ serviceId: svc.fixed, paymentMode: "ONLINE" }, customer2)).rejects.toThrow(/just taken/);
    await payAtSandbox(intentId!, customer);
    const paid = await reload(booking.id);
    expect(paid).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID", paidOnlinePaise: 50_000 });
    expect(paid.receiptNumber).toMatch(/^GKC\/\d{4}-\d{2}\/000001$/);
    const receipt = await receiptView(booking.id, customer);
    expect(receipt).toMatchObject({ title: "Receipt", duePaise: 0 });
  });

  it("frees the time when the payment fails or the hold lapses", async () => {
    const first = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    await payAtSandbox(first.intentId!, customer, "FAILURE");
    expect(await reload(first.booking.id)).toMatchObject({ status: "EXPIRED", paymentStatus: "FAILED" });
    const second = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" }, customer2);
    await db.update(consultBookings).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(consultBookings.id, second.booking.id));
    expect((await expireLapsedHolds()).expired).toBe(1);
    // D-CB-09: the lapsed hold ends the payment too, and the customer is told.
    expect(await reload(second.booking.id)).toMatchObject({ status: "EXPIRED", paymentStatus: "FAILED" });
    const told = await db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, customer2.id));
    expect(told.map((n) => n.title)).toContain(`Payment for ${second.booking.bookingNumber} did not go through`);
    const third = await book({ serviceId: svc.free }, customer);
    expect(third.booking.status).toBe("CONFIRMED");
  });

  it("refunds a payment that arrives after the time was given to someone else", async () => {
    const late = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    await db.update(consultBookings).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(consultBookings.id, late.booking.id));
    await expireLapsedHolds();
    await book({ serviceId: svc.free }, customer2); // takes the released time
    await payAtSandbox(late.intentId!, customer);
    const after = await reload(late.booking.id);
    expect(after).toMatchObject({ status: "EXPIRED", paidOnlinePaise: 50_000, refundPaise: 50_000, refundStatus: "PENDING" });
    const refunds = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, late.intentId!));
    expect(refunds).toHaveLength(1);
  });

  it("takes an advance online and the balance at the visit; completion needs the customer's code; settlement pays the firm net of commission", async () => {
    const { booking, intentId } = await book({ serviceId: svc.deposit, start: slot("11:00") });
    expect(booking).toMatchObject({ paymentMode: "ONLINE", onlineDuePaise: 50_000, feePaise: 200_000 });
    await payAtSandbox(intentId!, customer);
    expect(await reload(booking.id)).toMatchObject({ status: "CONFIRMED", paymentStatus: "PART_PAID" });
    await markOfflinePaid(booking.id, { method: "UPI" }, owner);
    expect(await reload(booking.id)).toMatchObject({ paymentStatus: "PAID", paidOfflinePaise: 150_000, offlineMethod: "UPI" });
    // The appointment is tomorrow: completing now is too early.
    await expect(completeBooking(booking.id, owner, "0000")).rejects.toThrow(/15 minutes/);
    await db.update(consultBookings).set({ startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_540_000) }).where(eq(consultBookings.id, booking.id));
    const b = await reload(booking.id);
    const code = completionCode(b.id, b.otpSalt!);
    const wrong = code === "1111" ? "2222" : "1111";
    await expect(completeBooking(booking.id, owner, wrong)).rejects.toThrow(/not right/);
    expect((await reload(booking.id)).otpAttempts).toBe(1);
    // The customer sees the code on their booking; the consultant does not.
    expect((await bookingDetail(booking.id, customer)).completionCode).toBe(code);
    expect((await bookingDetail(booking.id, owner)).completionCode).toBeNull();
    const done = await completeBooking(booking.id, owner, code);
    expect(done.status).toBe("COMPLETED");
    const lines = await db.select().from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, `consult:${booking.id}:%`));
    const credit = lines.filter((l) => l.idempotencyKey.includes(":credit:")).reduce((n, l) => n + l.amountPaise, 0);
    const commission = lines.filter((l) => l.idempotencyKey.includes(":commission:")).reduce((n, l) => n + l.amountPaise, 0);
    expect(credit).toBe(50_000); // the advance collected online, owed to the firm
    expect(commission).toBe(-4_000); // 2% of ₹2,000 (online + at the visit)
    expect(lines.every((l) => l.shopId === shopId && l.status === "PENDING" && l.party === "SHOP")).toBe(true);
    await rateBooking(booking.id, { rating: 5, review: "Very kind" }, customer);
    const [p] = await db.execute<{ rating_avg_x100: number; rating_count: number }>(sql`select rating_avg_x100, rating_count from consult_profiles where shop_id = ${shopId}`);
    expect(p).toMatchObject({ rating_avg_x100: 500, rating_count: 1 });
  });

  it("refunds in full when the customer cancels early, and by the policy when late", async () => {
    const early = await book({ serviceId: svc.fixed, paymentMode: "ONLINE", start: slot("10:00", addDays(tomorrow(), 2)) });
    await payAtSandbox(early.intentId!, customer);
    const c1 = await cancelBooking(early.booking.id, customer, "Plans changed");
    expect(c1).toMatchObject({ status: "CANCELLED", cancelledBy: "CUSTOMER", refundPaise: 50_000 });
    const late = await book({ serviceId: svc.fixed, paymentMode: "ONLINE", start: slot("12:00") });
    await payAtSandbox(late.intentId!, customer);
    // Less than 24 hours before: 50% back under the Standard policy.
    await db.update(consultBookings).set({ startsAt: new Date(Date.now() + 3 * 3_600_000), endsAt: new Date(Date.now() + 3.5 * 3_600_000) }).where(eq(consultBookings.id, late.booking.id));
    const c2 = await cancelBooking(late.booking.id, customer, null);
    expect(c2.refundPaise).toBe(25_000);
    const kept = await db.select().from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, `consult:${late.booking.id}:%`));
    expect(kept.reduce((n, l) => n + l.amountPaise, 0)).toBe(25_000 - 500); // ₹250 kept, less 2% commission
    // The time is free again.
    expect((await book({ serviceId: svc.free, start: slot("10:00", addDays(tomorrow(), 2)) }, customer2)).booking.status).toBe("CONFIRMED");
  });

  it("refunds everything when the consultant cancels, with a reason", async () => {
    const b = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    await payAtSandbox(b.intentId!, customer);
    await expect(cancelBooking(b.booking.id, owner, "")).rejects.toThrow(/reason/);
    const c = await cancelBooking(b.booking.id, owner, "Doctor unwell");
    expect(c).toMatchObject({ cancelledBy: "CONSULTANT", refundPaise: 50_000 });
  });

  it("lets the customer move a booking within the policy, and the firm reassign it", async () => {
    const { booking } = await book({ start: slot("10:00", addDays(tomorrow(), 1)) });
    const moved = await rescheduleBooking(booking.id, { start: slot("11:00", addDays(tomorrow(), 1)) }, customer);
    expect(moved).toMatchObject({ rescheduleCount: 1 });
    expect(moved.startsAt.toISOString()).toBe(slot("11:00", addDays(tomorrow(), 1)));
    await rescheduleBooking(booking.id, { start: slot("12:00", addDays(tomorrow(), 1)) }, customer);
    await expect(rescheduleBooking(booking.id, { start: slot("12:30", addDays(tomorrow(), 1)) }, customer)).rejects.toThrow(/already moved/);
    const reassigned = await reassignBooking(booking.id, secondMemberId, owner);
    const rows = await db.select().from(consultBookingMembers).where(and(eq(consultBookingMembers.bookingId, reassigned.id), eq(consultBookingMembers.active, true)));
    expect(rows.map((r) => r.memberId)).toEqual([secondMemberId]);
  });

  it("asks the consultant first when manual approval is on; declining refunds in full", async () => {
    await updateProfile(shopId, { manualApproval: true }, owner);
    const b = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    await payAtSandbox(b.intentId!, customer);
    expect((await reload(b.booking.id)).status).toBe("PENDING_APPROVAL");
    const rejected = await decideBooking(b.booking.id, false, owner, "Fully booked that day");
    expect(rejected).toMatchObject({ status: "REJECTED", refundPaise: 50_000 });
    const free = await book({ serviceId: svc.free, start: slot("12:00") }, customer2);
    expect(free.booking.status).toBe("PENDING_APPROVAL");
    expect((await decideBooking(free.booking.id, true, owner, null)).status).toBe("CONFIRMED");
  });

  it("marks a no-show after the time, keeping the payment under the Standard policy", async () => {
    const b = await book({ serviceId: svc.fixed, paymentMode: "ONLINE" });
    await payAtSandbox(b.intentId!, customer);
    await expect(markNoShow(b.booking.id, owner)).rejects.toThrow(/after the appointment/);
    await db.update(consultBookings).set({ startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() + 1_200_000) }).where(eq(consultBookings.id, b.booking.id));
    const n = await markNoShow(b.booking.id, owner);
    expect(n).toMatchObject({ status: "NO_SHOW", refundPaise: 0 });
  });

  it("gives a video appointment a meeting link and takes payment online only", async () => {
    await expect(book({ serviceId: svc.video, mode: "VIDEO", paymentMode: "PAY_AT_VISIT" })).rejects.toThrow(/online when booking/);
    const v = await book({ serviceId: svc.video, mode: "VIDEO", paymentMode: "ONLINE" });
    expect(v.booking.meetingUrl).toMatch(/^https:\/\/meet\.jit\.si\/GoKesari-/);
    await expect(book({ serviceId: svc.video, mode: "IN_PERSON" })).rejects.toThrow(/not offered/);
  });

  it("respects leave", async () => {
    await addTimeOff(shopId, { memberId: ownerMemberId, kind: "LEAVE", fromDate: tomorrow(), toDate: tomorrow(), reason: "Conference" }, owner);
    await expect(book()).rejects.toThrow(/just taken/);
  });
});

describe("privacy, permissions and disputes", () => {
  beforeEach(async () => {
    await uploadMemberDocument(shopId, ownerMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
    await publishProfile(shopId, owner);
  });

  it("shows a booking only to its customer, the firm and staff, and logs the firm's and staff's looks", async () => {
    const { booking } = await book({ note: "Fever since two days" });
    await expect(bookingViewer(booking, customer2)).rejects.toThrow();
    expect((await bookingViewer(booking, customer)).viewer).toBe("CUSTOMER");
    expect((await bookingViewer(booking, owner)).viewer).toBe("FIRM");
    expect((await bookingViewer(booking, admin)).viewer).toBe("STAFF");
    await bookingDetail(booking.id, owner);
    await bookingDetail(booking.id, admin);
    const logs = await db.select().from(consultAccessLogs).where(eq(consultAccessLogs.bookingId, booking.id));
    expect(logs.map((l) => l.action).sort()).toEqual(["FIRM_VIEWED_BOOKING", "STAFF_VIEWED_BOOKING"]);
    // A team member sees only the bookings assigned to them.
    const member = await createUser({ role: "CUSTOMER", email: "neha@test.local" });
    await saveMember(shopId, { id: secondMemberId, name: "Dr Neha Rao", userEmail: "neha@test.local" }, owner);
    await expect(bookingViewer(booking, actorOf(member))).rejects.toThrow();
    const cal = await firmCalendar(shopId, actorOf(member), tomorrow(), tomorrow());
    expect(cal.members.map((m) => m.id)).toEqual([secondMemberId]);
    expect(cal.bookings).toHaveLength(0);
  });

  it("keeps attachments encrypted and serves them only through a signed link to an allowed viewer", async () => {
    const { booking } = await book();
    const up = await uploadBookingFile(booking.id, { name: "prescription.pdf", bytes: PDF }, customer);
    const [{ data }] = await db.execute<{ data: Buffer }>(sql`select data from consult_booking_files where id = ${up.id}`);
    expect(Buffer.from(data).includes(Buffer.from("%PDF"))).toBe(false);
    const url = new URL(signedFileUrl("booking", up.id, owner.id), "http://x");
    expect(checkSignature("booking", up.id, owner.id, Number(url.searchParams.get("exp")), url.searchParams.get("sig")!)).toBe(true);
    expect(checkSignature("booking", up.id, customer2.id, Number(url.searchParams.get("exp")), url.searchParams.get("sig")!)).toBe(false);
    expect((await readBookingFile(up.id, owner)).data.equals(PDF)).toBe(true);
    await expect(readBookingFile(up.id, customer2)).rejects.toThrow();
  });

  it("opens a help-desk ticket for a dispute, linked to the firm", async () => {
    const { booking } = await book();
    const d = await raiseDispute(booking.id, { reason: "The clinic was closed when I arrived." }, customer);
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, d.ticketId));
    expect(t).toMatchObject({ category: "BOOKING", shopId, priority: "HIGH" });
    await expect(raiseDispute(booking.id, { reason: "Again and again and again" }, customer)).rejects.toThrow(/already open/);
  });

  it("gives staff every booking, reports and category commission", async () => {
    await book();
    const all = await listAllBookings(admin, {});
    expect(all).toHaveLength(1);
    await expect(listAllBookings(customer, {})).rejects.toThrow();
    const report = await consultReport(admin, istDateKey(new Date()), tomorrow());
    expect(report.totals.bookings).toBe(1);
    // Categories outlive the per-test reset (no link to users): a name of its own each run.
    const name = `Speech therapist ${Date.now().toString(36)}`;
    const cat = await saveCategory({ name, groupName: "Doctors and clinics", commissionPct: 5, requiredDoc: "RCI", requiredDocLabel: "RCI registration" }, admin);
    expect(cat).toMatchObject({ commissionBp: 500, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), requiredDoc: "RCI" });
    await expect(saveCategory({ name, groupName: "Doctors and clinics" }, admin)).rejects.toThrow(/already exists/);
    const dash = await firmDashboard(shopId, owner);
    expect(dash.upcomingCount).toBe(1);
  });
});

describe("discovery", () => {
  beforeEach(async () => {
    await uploadMemberDocument(shopId, ownerMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
    await publishProfile(shopId, owner);
  });

  it("finds nearby consultants with distance, directions and the next free time, and filters", async () => {
    const near = await searchConsultants({ lat: 18.53, lng: 73.85, radiusKm: 10 });
    expect(near.results).toHaveLength(1);
    expect(near.results[0]).toMatchObject({ name: "Mehta Family Clinic", languages: expect.arrayContaining(["Marathi"]) });
    expect(near.results[0].distanceKm).toBeGreaterThan(0.5);
    expect(near.results[0].distanceKm).toBeLessThan(2);
    expect(near.results[0].directionsUrl).toContain("google.com/maps/dir");
    expect(near.results[0].nextSlot).toBeTruthy();
    expect((await searchConsultants({ lat: 19.07, lng: 72.87, radiusKm: 25 })).results).toHaveLength(0); // Mumbai is too far
    expect((await searchConsultants({ category: "general-physician" })).results).toHaveLength(1);
    expect((await searchConsultants({ category: "advocate-lawyer" })).results).toHaveLength(0);
    expect((await searchConsultants({ language: "kannada" })).results).toHaveLength(1);
    expect((await searchConsultants({ language: "tamil" })).results).toHaveLength(0);
    expect((await searchConsultants({ mode: "VIDEO" })).results).toHaveLength(1);
    expect((await searchConsultants({ mode: "HOME_VISIT" })).results).toHaveLength(0);
    expect((await searchConsultants({ maxFee: 100 })).results).toHaveLength(1); // the free check-up
    expect((await searchConsultants({ minFee: 5000 })).results).toHaveLength(0);
    expect((await searchConsultants({ q: "neha" })).results).toHaveLength(1);
    expect((await searchConsultants({ date: tomorrow() })).results).toHaveLength(1);
  });

  it("refuses new bookings while the rule is off", async () => {
    await consultRule({ enabled: false });
    await expect(book()).rejects.toThrow(/not available/);
  });
});
