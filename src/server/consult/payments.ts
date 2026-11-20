/**
 * Consultant appointments: money (docs/consult-booking-2026-11).
 *
 *  - Online: one payment intent (purpose CONSULT_BOOKING) for the fee or the
 *    advance, and another for a balance paid online later; the existing
 *    gateway (UPI, cards, net banking). Capture confirms the booking in the
 *    capture transaction; a failed / expired payment frees the held time.
 *    A capture that arrives after the hold lapsed takes the time back if it
 *    is still free, else the whole payment is refunded.
 *  - Pay at visit: the consultant records it (bookings.markOfflinePaid).
 *  - Refunds go back to the original method through the gateway, recorded in
 *    the booking's transaction and sent right after it commits (the payments
 *    reconciliation job retries any that could not be sent).
 *  - Settlement: once a booking ends, the online money it keeps is owed to
 *    the firm and GoKesari's commission (the category's rate, else 2%) is
 *    taken on everything it kept — online and at the visit — as
 *    financial_adjustments rows the next shop payout cycle pays / recovers.
 *    Settlement is incremental (a later refund or balance makes a correcting
 *    row), each row with its own idempotency key, under the booking's lock.
 *  - Receipts: one number per booking (per firm and financial year); a
 *    GST-registered firm's receipt is a tax invoice (fees are GST-inclusive).
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { CONSULT_BOOKING_PATH } from "@/lib/consult/constants";
import { commissionOnFee } from "@/lib/consult/policy";
import { financialYear } from "@/lib/consult/time";
import { conflict, notFound } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  consultBookingEvents,
  consultBookingMembers,
  consultBookings,
  consultMembers,
  consultProfiles,
  consultReceiptCounters,
  financialAdjustments,
  paymentIntents,
  paymentRefunds,
  users,
  type ConsultBooking,
  type PaymentIntentRow,
} from "@/server/db/schema";
import { createPaymentIntent, isLive, redirectUrlOf, refundPaymentIntent, type PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { ConsultActor } from "./access";
import { scheduleReminders, tellBooking } from "./notify";

/* ------------------------------------------------------------- starting */

export async function startBookingPayment(
  booking: ConsultBooking,
  part: "ADVANCE" | "BALANCE",
  actor: ConsultActor,
): Promise<{ booking: ConsultBooking; checkoutUrl: string | null; intentId: string }> {
  const amount = part === "ADVANCE" ? booking.onlineDuePaise - booking.paidOnlinePaise : booking.feePaise - booking.paidOnlinePaise - booking.paidOfflinePaise;
  if (amount <= 0) throw conflict("Nothing is due online on this booking.");
  const currentId = part === "ADVANCE" ? booking.paymentIntentId : booking.balanceIntentId;
  if (currentId) {
    const [current] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, currentId));
    if (current && isLive(current) && current.amountPaise === amount) return { booking, checkoutUrl: redirectUrlOf(current), intentId: current.id };
    if (current && (current.status === "CAPTURED" || current.status === "PARTIALLY_REFUNDED" || current.status === "REFUNDED")) throw conflict("This payment was already received.");
  }
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.purpose, "CONSULT_BOOKING"), eq(paymentIntents.referenceId, booking.id)));
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, booking.customerId));
  const created = await createPaymentIntent({
    purpose: "CONSULT_BOOKING",
    referenceId: booking.id,
    userId: booking.customerId,
    amountPaise: amount,
    customer: { id: booking.customerId, name: u?.name ?? booking.visitorName, email: u?.email ?? booking.visitorEmail ?? null, phone: u?.phone ?? booking.visitorPhone ?? null },
    description: `GoKesari appointment ${booking.bookingNumber}${part === "BALANCE" ? " (balance)" : ""}`,
    idempotencyKey: `consult:${booking.id}:${part.toLowerCase()}:${n}`,
    mode: "CHECKOUT",
    returnPath: `${CONSULT_BOOKING_PATH}/${booking.id}`,
  });
  const [updated] = await db
    .update(consultBookings)
    .set(part === "ADVANCE" ? { paymentIntentId: created.intent.id, updatedAt: new Date() } : { balanceIntentId: created.intent.id, updatedAt: new Date() })
    .where(eq(consultBookings.id, booking.id))
    .returning();
  await db.insert(consultBookingEvents).values({ bookingId: booking.id, kind: "PAYMENT_STARTED", actorId: actor.id, actorRole: actor.role, meta: { part, intentId: created.intent.id, amountPaise: amount } });
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : created.linkUrl;
  return { booking: updated, checkoutUrl, intentId: created.intent.id };
}

/* --------------------------------------------------------- capture / end */

function partOf(booking: ConsultBooking, intentId: string): "ADVANCE" | "BALANCE" {
  if (booking.balanceIntentId === intentId) return "BALANCE";
  if (booking.paymentIntentId === intentId) return "ADVANCE";
  return booking.status === "PENDING_PAYMENT" || booking.status === "EXPIRED" ? "ADVANCE" : "BALANCE";
}

/** Purpose handler (purpose-handlers.ts), inside the capture transaction. */
export async function onConsultPaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: (task: () => Promise<void>) => void): Promise<void> {
  const [b] = await client.select().from(consultBookings).where(eq(consultBookings.id, intent.referenceId)).for("update");
  if (!b) return;
  const already = await client.select({ id: consultBookingEvents.id }).from(consultBookingEvents).where(and(eq(consultBookingEvents.bookingId, b.id), eq(consultBookingEvents.kind, "PAID_ONLINE"), sql`${consultBookingEvents.meta}->>'intentId' = ${intent.id}`)).limit(1);
  if (already.length) return;
  const now = new Date();
  const part = partOf(b, intent.id);
  const paidOnline = b.paidOnlinePaise + intent.amountPaise;
  const total = paidOnline + b.paidOfflinePaise;
  const expected = part === "ADVANCE" ? b.onlineDuePaise : Math.max(0, b.feePaise - b.paidOnlinePaise - b.paidOfflinePaise);
  if (intent.amountPaise !== expected) {
    await recordAudit({ action: AUDIT_ACTIONS.CONSULT_BOOKING_PAYMENT, entityType: "consult_booking", entityId: b.id, newValue: { problem: "amount_mismatch", intentId: intent.id, intentAmount: intent.amountPaise, expected } }, client);
  }
  const paymentStatus = total >= b.feePaise ? "PAID" : "PART_PAID";
  await client.insert(consultBookingEvents).values({ bookingId: b.id, kind: "PAID_ONLINE", meta: { intentId: intent.id, amountPaise: intent.amountPaise, part } });

  const refundIds: string[] = [];
  let after: ConsultBooking;
  if (part === "ADVANCE" && b.status === "PENDING_PAYMENT") {
    after = await confirmPaid(client, b, { paidOnline, paymentStatus, intentId: intent.id, now });
  } else if (part === "ADVANCE" && b.status === "EXPIRED") {
    // Paid after the hold lapsed: take the time back if it is still free, else refund it all.
    const back = b.startsAt.getTime() > now.getTime() && (await retake(client, b));
    if (back) {
      after = await confirmPaid(client, b, { paidOnline, paymentStatus, intentId: intent.id, now, note: "Paid after the hold lapsed; the time was still free." });
    } else {
      const [u] = await client.update(consultBookings).set({ paidOnlinePaise: paidOnline, paymentStatus, paymentIntentId: intent.id, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
      const r = await refundBookingMoney(client, u, intent.amountPaise, `${b.bookingNumber}: paid after the held time was released`, `late:${intent.id}`);
      after = r.booking;
      refundIds.push(...r.refundIds);
      await client.insert(consultBookingEvents).values({ bookingId: b.id, kind: "LATE_PAYMENT_REFUNDED", meta: { intentId: intent.id } });
      await tellBooking(after, "REFUND", { amountPaise: intent.amountPaise, note: " The time you chose was taken while the payment was pending, so the whole payment is being refunded." }, client);
    }
  } else if (part === "ADVANCE" && (b.status === "CANCELLED" || b.status === "REJECTED")) {
    const [u] = await client.update(consultBookings).set({ paidOnlinePaise: paidOnline, paymentStatus, paymentIntentId: intent.id, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
    const r = await refundBookingMoney(client, u, intent.amountPaise, `${b.bookingNumber}: paid after the booking was cancelled`, `late:${intent.id}`);
    after = r.booking;
    refundIds.push(...r.refundIds);
    await tellBooking(after, "REFUND", { amountPaise: intent.amountPaise }, client);
  } else {
    const [u] = await client.update(consultBookings).set({ paidOnlinePaise: paidOnline, paymentStatus, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
    after = await issueReceipt(client, u, now);
    if (["COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"].includes(after.status)) after = await settleBooking(client, after, now);
    await tellBooking(after, "PAYMENT_RECEIVED", { amountPaise: intent.amountPaise }, client);
  }
  await recordAudit({ action: AUDIT_ACTIONS.CONSULT_BOOKING_PAYMENT, entityType: "consult_booking", entityId: b.id, newValue: { intentId: intent.id, amountPaise: intent.amountPaise, part, status: after.status } }, client);
  if (refundIds.length) {
    const send = async () => {
      const { submitRefund } = await import("@/server/payments/intents");
      for (const id of refundIds) await submitRefund(id).catch((e) => console.error("[consult] late refund deferred to the job", id, e));
    };
    if (afterCommit) afterCommit(send);
  }
}

async function confirmPaid(client: DbClient, b: ConsultBooking, input: { paidOnline: number; paymentStatus: "PAID" | "PART_PAID"; intentId: string; now: Date; note?: string }): Promise<ConsultBooking> {
  const [p] = await client.select({ manual: consultProfiles.manualApproval }).from(consultProfiles).where(eq(consultProfiles.id, b.profileId));
  const status = p?.manual ? "PENDING_APPROVAL" : "CONFIRMED";
  const [u] = await client
    .update(consultBookings)
    .set({ status, paidOnlinePaise: input.paidOnline, paymentStatus: input.paymentStatus, paymentIntentId: input.intentId, holdExpiresAt: null, confirmedAt: status === "CONFIRMED" ? input.now : null, updatedAt: input.now })
    .where(eq(consultBookings.id, b.id))
    .returning();
  const after = await issueReceipt(client, u, input.now);
  await client.insert(consultBookingEvents).values({ bookingId: b.id, kind: status === "CONFIRMED" ? "CONFIRMED" : "AWAITING_APPROVAL", fromStatus: b.status, toStatus: status, note: input.note ?? "Payment received." });
  if (status === "CONFIRMED") await scheduleReminders(after, client, input.now);
  await tellBooking(after, status === "CONFIRMED" ? "CONFIRMED" : "PENDING_APPROVAL", {}, client);
  await tellBooking(after, "PAYMENT_RECEIVED", { amountPaise: input.paidOnline - b.paidOnlinePaise }, client);
  return after;
}

/** Re-activates a lapsed booking's time if every member is still free (under their row locks). */
async function retake(client: DbClient, b: ConsultBooking): Promise<boolean> {
  const rows = await client.select().from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, b.id));
  if (!rows.length) return false;
  await client.select({ id: consultMembers.id }).from(consultMembers).where(inArray(consultMembers.id, rows.map((r) => r.memberId))).orderBy(consultMembers.id).for("update");
  for (const r of rows) {
    const [clash] = await client.execute<{ id: string }>(sql`
      select bm.id from consult_booking_members bm
      where bm.member_id = ${r.memberId} and bm.active and bm.booking_id <> ${b.id}
        and bm.share_key <> ${r.shareKey}
        and tstzrange(bm.starts_at, bm.blocks_until, '[)') && tstzrange(${r.startsAt.toISOString()}::timestamptz, ${r.blocksUntil.toISOString()}::timestamptz, '[)')
      limit 1`);
    if (clash) return false;
  }
  await client.update(consultBookingMembers).set({ active: true }).where(eq(consultBookingMembers.bookingId, b.id));
  return true;
}

/** Purpose handler for a failed / expired payment (ended-handlers.ts), inside its transaction. */
export async function onConsultPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  const [b] = await client.select().from(consultBookings).where(eq(consultBookings.id, intent.referenceId)).for("update");
  if (!b) return;
  const now = new Date();
  if (partOf(b, intent.id) === "BALANCE") {
    await client.insert(consultBookingEvents).values({ bookingId: b.id, kind: "BALANCE_PAYMENT_" + to, meta: { intentId: intent.id } });
    return;
  }
  if (b.status !== "PENDING_PAYMENT" || (b.paymentIntentId && b.paymentIntentId !== intent.id)) return;
  const [u] = await client.update(consultBookings).set({ status: "EXPIRED", paymentStatus: "FAILED", holdExpiresAt: null, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
  await client.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, b.id));
  await client.insert(consultBookingEvents).values({ bookingId: b.id, kind: "PAYMENT_" + to, fromStatus: b.status, toStatus: "EXPIRED", note: intent.failureReason ?? null, meta: { intentId: intent.id } });
  await tellBooking(u, "PAYMENT_FAILED", {}, client);
}

/* ---------------------------------------------------------------- refunds */

/**
 * Records refunds of `amount` against the booking's captured payments
 * (advance first, then balance) inside the caller's transaction. The caller
 * sends the returned refund ids to the gateway after it commits.
 */
export async function refundBookingMoney(client: DbClient, booking: ConsultBooking, amount: number, reason: string, tag: string): Promise<{ booking: ConsultBooking; refundIds: string[] }> {
  const ids = [booking.paymentIntentId, booking.balanceIntentId].filter((v): v is string => Boolean(v));
  if (!ids.length || amount <= 0) return { booking, refundIds: [] };
  const intents = await client.select().from(paymentIntents).where(inArray(paymentIntents.id, ids));
  let left = amount;
  const refundIds: string[] = [];
  for (const id of ids) {
    const intent = intents.find((i) => i.id === id);
    if (!intent || (intent.status !== "CAPTURED" && intent.status !== "PARTIALLY_REFUNDED")) continue;
    const [{ committed }] = await client
      .select({ committed: sql<number>`coalesce(sum(${paymentRefunds.amountPaise}), 0)::bigint` })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.intentId, id), inArray(paymentRefunds.status, ["PENDING", "SUCCESS"])));
    const room = intent.amountPaise - Number(committed);
    const take = Math.min(room, left);
    if (take <= 0) continue;
    const ref = await refundPaymentIntent({ intentId: id, amountPaise: take, reason: reason.slice(0, 480), idempotencyKey: `consult:${booking.id}:refund:${tag}:${id}` }, client);
    refundIds.push(ref.id);
    left -= take;
    if (left <= 0) break;
  }
  const refunded = amount - left;
  if (refunded <= 0) return { booking, refundIds };
  const [u] = await client
    .update(consultBookings)
    .set({ refundPaise: booking.refundPaise + refunded, refundStatus: "PENDING", updatedAt: new Date() })
    .where(eq(consultBookings.id, booking.id))
    .returning();
  await client.insert(consultBookingEvents).values({ bookingId: booking.id, kind: "REFUND_REQUESTED", note: reason.slice(0, 500), meta: { amountPaise: refunded, refundIds } });
  await recordAudit({ action: AUDIT_ACTIONS.CONSULT_BOOKING_REFUND, entityType: "consult_booking", entityId: booking.id, newValue: { amountPaise: refunded, reason, refundIds } }, client);
  return { booking: u, refundIds };
}

export interface RefundState {
  status: "NONE" | "PENDING" | "PARTIAL" | "REFUNDED" | "FAILED";
  requestedPaise: number;
  settledPaise: number;
  rows: { id: string; amountPaise: number; status: string; createdAt: Date; settledAt: Date | null }[];
}

/** Live refund state of a booking from the gateway's refund rows. */
export async function refundStateOf(booking: Pick<ConsultBooking, "paymentIntentId" | "balanceIntentId" | "paidOnlinePaise">, client: DbClient = db): Promise<RefundState> {
  const ids = [booking.paymentIntentId, booking.balanceIntentId].filter((v): v is string => Boolean(v));
  const rows = ids.length
    ? await client.select({ id: paymentRefunds.id, amountPaise: paymentRefunds.amountPaise, status: paymentRefunds.status, createdAt: paymentRefunds.createdAt, settledAt: paymentRefunds.settledAt }).from(paymentRefunds).where(inArray(paymentRefunds.intentId, ids))
    : [];
  if (!rows.length) return { status: "NONE", requestedPaise: 0, settledPaise: 0, rows: [] };
  const requested = rows.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amountPaise, 0);
  const settled = rows.filter((r) => r.status === "SUCCESS").reduce((n, r) => n + r.amountPaise, 0);
  const status = rows.some((r) => r.status === "FAILED") ? "FAILED" : rows.some((r) => r.status === "PENDING") ? "PENDING" : settled >= booking.paidOnlinePaise ? "REFUNDED" : "PARTIAL";
  return { status, requestedPaise: requested, settledPaise: settled, rows };
}

/* -------------------------------------------------------------- settlement */

const FINAL_FOR_MONEY = ["COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED", "EXPIRED"];

/**
 * Brings the firm's payout lines for a booking up to date (under the
 * booking's lock): + the online money kept, − GoKesari's commission on
 * everything kept (online, and money taken at the visit once completed).
 * Only for bookings that have ended; repeated calls write only differences.
 */
export async function settleBooking(client: DbClient, booking: ConsultBooking, now: Date = new Date()): Promise<ConsultBooking> {
  if (!FINAL_FOR_MONEY.includes(booking.status)) return booking;
  const onlineKept = Math.max(0, booking.paidOnlinePaise - booking.refundPaise);
  const offline = booking.status === "COMPLETED" ? booking.paidOfflinePaise : 0;
  const targetCommission = commissionOnFee(onlineKept + offline, booking.commissionBp);
  const existing = await client
    .select({ key: financialAdjustments.idempotencyKey, amount: financialAdjustments.amountPaise })
    .from(financialAdjustments)
    .where(like(financialAdjustments.idempotencyKey, `consult:${booking.id}:%`));
  const credits = existing.filter((e) => e.key.includes(":credit:"));
  const commissions = existing.filter((e) => e.key.includes(":commission:"));
  const credited = credits.reduce((n, e) => n + e.amount, 0);
  const commissioned = -commissions.reduce((n, e) => n + e.amount, 0);
  const rows: (typeof financialAdjustments.$inferInsert)[] = [];
  if (onlineKept !== credited) {
    rows.push({
      type: "SHOP_ADJUSTMENT",
      party: "SHOP",
      shopId: booking.shopId,
      amountPaise: onlineKept - credited,
      reason: `Appointment ${booking.bookingNumber}: ${onlineKept - credited >= 0 ? "fee collected online" : "correction after refund"}`,
      idempotencyKey: `consult:${booking.id}:credit:${credits.length}`,
    });
  }
  if (targetCommission !== commissioned) {
    rows.push({
      type: "SHOP_ADJUSTMENT",
      party: "SHOP",
      shopId: booking.shopId,
      amountPaise: -(targetCommission - commissioned),
      reason: `GoKesari commission ${(booking.commissionBp / 100).toFixed(2)}% on appointment ${booking.bookingNumber}`,
      idempotencyKey: `consult:${booking.id}:commission:${commissions.length}`,
    });
  }
  if (rows.length) await client.insert(financialAdjustments).values(rows).onConflictDoNothing();
  const [u] = await client
    .update(consultBookings)
    .set({ commissionPaise: targetCommission, settledAt: rows.length || !booking.settledAt ? now : booking.settledAt, updatedAt: now })
    .where(eq(consultBookings.id, booking.id))
    .returning();
  if (rows.length) await recordAudit({ action: AUDIT_ACTIONS.CONSULT_BOOKING_SETTLED, entityType: "consult_booking", entityId: booking.id, newValue: { onlineKept, offline, commissionPaise: targetCommission, rows: rows.map((r) => ({ key: r.idempotencyKey, amountPaise: r.amountPaise })) } }, client);
  return u;
}

/** Commission on money taken at the visit (completed bookings) — the same incremental settlement. */
export const settleOfflineCommission = settleBooking;

/* ---------------------------------------------------------------- receipts */

/** Gives a booking its receipt / tax-invoice number the first time money is received. */
export async function issueReceipt(client: DbClient, booking: ConsultBooking, now: Date = new Date()): Promise<ConsultBooking> {
  if (booking.receiptNumber || booking.paidOnlinePaise + booking.paidOfflinePaise <= 0) return booking;
  const fy = financialYear(now);
  const [row] = await client
    .insert(consultReceiptCounters)
    .values({ shopId: booking.shopId, fy, nextNo: 2 })
    .onConflictDoUpdate({ target: [consultReceiptCounters.shopId, consultReceiptCounters.fy], set: { nextNo: sql`${consultReceiptCounters.nextNo} + 1` } })
    .returning({ nextNo: consultReceiptCounters.nextNo });
  const number = `GKC/${fy}/${String(row.nextNo - 1).padStart(6, "0")}`;
  const [u] = await client.update(consultBookings).set({ receiptNumber: number, receiptIssuedAt: now, updatedAt: now }).where(eq(consultBookings.id, booking.id)).returning();
  return u;
}

export async function bookingIntents(booking: Pick<ConsultBooking, "id">): Promise<PaymentIntentRow[]> {
  return db.select().from(paymentIntents).where(and(eq(paymentIntents.purpose, "CONSULT_BOOKING"), eq(paymentIntents.referenceId, booking.id)));
}

export async function requireBooking(bookingId: string): Promise<ConsultBooking> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  return b;
}
