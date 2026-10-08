/**
 * The customer's delivery code (GS-043; hardened in docs/shop-wallet-delivery-otp-2026-10).
 *
 *   rider starts the drop  → a fresh 4-digit code; only a salted HMAC of it is
 *                            stored (delivery_orders.delivery_otp_hash) and the
 *                            code itself is emailed to the customer directly —
 *                            never written to the notification tables
 *   customer, any time     → "get a new code": rate-limited (rule deliveryOtp
 *                            resendCooldownSeconds / maxResends); the old code
 *                            stops working; the new one is emailed and shown
 *                            once on their order page
 *   rider enters the code  → right: the drop is confirmed and the code is spent
 *                            (delivery-assignment.ts markDelivered)
 *                            wrong: counted atomically; at maxAttempts the drop
 *                            is locked, a support ticket (grievance) is raised
 *                            and the customer, the shop and support are told
 *
 * Only the rider holding the delivery may enter a code (markDelivered's
 * ownership check), and only the order's customer may ask for one.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { maskEmailAddress } from "@/lib/contact";
import { getEnv } from "@/lib/env";
import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  grievances,
  orders,
  shops,
  users,
  type DeliveryOrder,
  type UserRole,
} from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { emitEvent } from "@/server/events/emit";
import { renderDeliveryCodeEmail } from "@/server/notifications/templates";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

export const DELIVERY_CODE_LENGTH = 4;

/* ------------------------------------------------------------- the code */

/** Crypto-random, so it cannot be predicted from timing. */
export function generateDeliveryCode(): string {
  return String(randomInt(0, 10 ** DELIVERY_CODE_LENGTH)).padStart(DELIVERY_CODE_LENGTH, "0");
}

/**
 * `salt:HMAC-SHA256(AUTH_SECRET, salt:delivery:code)` — the login OTP's scheme
 * (otp/service.ts). Keyed on the server secret, so a copy of the database
 * alone cannot be used to try all 10,000 codes; bound to the delivery, so a
 * hash copied to another row is useless.
 */
export function hashDeliveryCode(deliveryOrderId: string, code: string, salt: string = randomBytes(8).toString("hex")): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET)
    .update(`delivery-otp:${salt}:${deliveryOrderId}:${code}`)
    .digest("hex");
  return `${salt}:${mac}`;
}

export function deliveryCodeMatches(stored: string, deliveryOrderId: string, code: string): boolean {
  const [salt] = stored.split(":");
  if (!salt) return false;
  return safeEqual(stored, hashDeliveryCode(deliveryOrderId, code, salt));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True while the delivery is waiting for a customer code (hashed, or a plain one from before migration 0059). */
export function needsDeliveryCode(row: Pick<DeliveryOrder, "deliveryOtpHash" | "deliveryOtp">): boolean {
  return row.deliveryOtpHash != null || row.deliveryOtp != null;
}

/** Fields for a fresh code on a delivery row (start of the drop). */
export function freshCodeFields(deliveryOrderId: string, code: string) {
  return {
    deliveryOtpHash: hashDeliveryCode(deliveryOrderId, code),
    deliveryOtp: null,
    deliveryOtpSentAt: new Date(),
    deliveryOtpAttempts: 0,
    deliveryOtpResends: 0,
    deliveryOtpUsedAt: null,
    deliveryOtpLockedAt: null,
    deliveryOtpTicketId: null,
  } as const;
}

/* ------------------------------------------------------------ sending */

/**
 * Emails the code to the order's customer. Sent directly, never queued, so the
 * code is not stored anywhere. Never throws: a failed email must not undo the
 * start of the drop — the customer can ask for a new code from their orders
 * page, where it is also shown.
 */
export async function sendDeliveryCodeToBuyer(orderId: string, code: string): Promise<{ sentTo: string | null }> {
  try {
    const [row] = await db
      .select({ orderNumber: orders.orderNumber, shopName: shops.name, email: users.email })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .innerJoin(users, eq(users.id, orders.userId))
      .where(eq(orders.id, orderId));
    if (!row?.email) return { sentTo: null };
    await sendEmail({ to: row.email, ...renderDeliveryCodeEmail({ code, orderNumber: row.orderNumber, shopName: row.shopName }) });
    return { sentTo: maskEmailAddress(row.email) };
  } catch (error) {
    console.error("[delivery-otp] could not email the delivery code", orderId, error instanceof Error ? error.message : error);
    return { sentTo: null };
  }
}

/* ---------------------------------------------------- customer: new code */

export interface NewDeliveryCodeResult {
  /** Shown once on the customer's order page; never stored. */
  code: string;
  /** Masked email the code was also sent to, or null when email failed. */
  sentTo: string | null;
  resendsLeft: number;
  /** When the customer may ask again. */
  nextRequestAt: string;
}

const tooSoon = (seconds: number) =>
  new AppError("RATE_LIMITED", `Please wait ${seconds} seconds before asking for another code.`, { retryAfterSeconds: seconds });

/**
 * The customer asks for a new code (lost the email, or it never came). Only
 * the order's own customer, only while the drop is under way and not locked,
 * and within the resend limits. The previous code stops working at once.
 */
export async function requestNewDeliveryCode(orderId: string, buyer: Actor): Promise<NewDeliveryCodeResult> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId), columns: { id: true, userId: true } });
  // Someone else's order looks exactly like a missing one.
  if (!order || order.userId !== buyer.id) throw notFound("Order");

  const delivery = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, orderId) });
  if (!delivery || delivery.status !== "PICKED_UP" || !delivery.outForDeliveryAt) {
    throw conflict("A delivery code is available once your order is on the way.");
  }
  if (delivery.deliveryOtpLockedAt) {
    throw conflict(`This delivery is on hold after too many wrong codes. Our support team will contact you${await ticketSuffix(delivery.deliveryOtpTicketId)}.`);
  }

  const rules = await getRule("deliveryOtp");
  if (delivery.deliveryOtpResends >= rules.maxResends) {
    throw new AppError(
      "RATE_LIMITED",
      "You have asked for as many new codes as this delivery allows. Use the latest code from your email, or contact support.",
    );
  }
  if (delivery.deliveryOtpSentAt) {
    const wait = Math.ceil((delivery.deliveryOtpSentAt.getTime() + rules.resendCooldownSeconds * 1000 - Date.now()) / 1000);
    if (wait > 0) throw tooSoon(wait);
  }

  const code = generateDeliveryCode();
  // The limits are re-checked in the UPDATE itself, so two quick taps can't both pass.
  const [updated] = await db
    .update(deliveryOrders)
    .set({
      deliveryOtpHash: hashDeliveryCode(delivery.id, code),
      deliveryOtp: null,
      deliveryOtpSentAt: new Date(),
      deliveryOtpResends: sql`${deliveryOrders.deliveryOtpResends} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deliveryOrders.id, delivery.id),
        eq(deliveryOrders.status, "PICKED_UP"),
        isNotNull(deliveryOrders.outForDeliveryAt),
        isNull(deliveryOrders.deliveryOtpLockedAt),
        lt(deliveryOrders.deliveryOtpResends, rules.maxResends),
        or(
          isNull(deliveryOrders.deliveryOtpSentAt),
          sql`${deliveryOrders.deliveryOtpSentAt} <= now() - make_interval(secs => ${rules.resendCooldownSeconds})`,
        ),
      ),
    )
    .returning();
  if (!updated) throw tooSoon(Math.max(rules.resendCooldownSeconds, 1));

  await recordAudit({
    actorId: buyer.id,
    actorRole: buyer.role,
    action: AUDIT_ACTIONS.DELIVERY_CODE_SENT,
    entityType: "delivery_order",
    entityId: delivery.id,
    newValue: { reason: "customer_request", resends: updated.deliveryOtpResends },
  });
  const { sentTo } = await sendDeliveryCodeToBuyer(orderId, code);
  return {
    code,
    sentTo,
    resendsLeft: Math.max(rules.maxResends - updated.deliveryOtpResends, 0),
    nextRequestAt: new Date(updated.deliveryOtpSentAt!.getTime() + rules.resendCooldownSeconds * 1000).toISOString(),
  };
}

/* ------------------------------------------------------- rider: checking */

async function ticketSuffix(ticketId: string | null): Promise<string> {
  if (!ticketId) return "";
  const [ticket] = await db.select({ ticketNumber: grievances.ticketNumber }).from(grievances).where(eq(grievances.id, ticketId));
  return ticket ? ` (ticket ${ticket.ticketNumber})` : "";
}

function lockedError(ticketNumber: string | null): AppError {
  return conflict(
    `Too many wrong codes — this delivery is locked${ticketNumber ? ` and support ticket ${ticketNumber} has been raised` : ""}. Operations will confirm it with the customer.`,
    { locked: true, ticketNumber },
  );
}

/**
 * Checks the code the rider entered for `row` (the rider's ownership is
 * already checked). Returns when it is right; throws otherwise — a wrong code
 * is counted first (committed, so the throw does not undo it), and the
 * attempt that reaches the limit locks the drop and raises the ticket.
 */
export async function checkDeliveryCode(row: DeliveryOrder, otp: string | undefined, actor: Actor): Promise<void> {
  const rules = await getRule("deliveryOtp");
  if (row.deliveryOtpLockedAt || row.deliveryOtpAttempts >= rules.maxAttempts) {
    // Also covers a drop locked before 0059, or after the limit was lowered: it gets its ticket now.
    const ticketNumber = await db.transaction((tx) => lockDelivery(row.id, row.deliveryOtpAttempts, actor, tx));
    throw lockedError(ticketNumber);
  }

  const code = (otp ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${DELIVERY_CODE_LENGTH}}$`).test(code)) {
    throw validationFailed(`Enter the ${DELIVERY_CODE_LENGTH}-digit delivery code from the customer.`);
  }
  const right = row.deliveryOtpHash
    ? deliveryCodeMatches(row.deliveryOtpHash, row.id, code)
    : row.deliveryOtp != null && safeEqual(row.deliveryOtp, code);
  if (right) return;

  const outcome = await db.transaction(async (tx) => {
    // Atomic: concurrent wrong attempts cannot push the count past the limit.
    const [counted] = await tx
      .update(deliveryOrders)
      .set({ deliveryOtpAttempts: sql`${deliveryOrders.deliveryOtpAttempts} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(deliveryOrders.id, row.id),
          eq(deliveryOrders.status, "PICKED_UP"),
          isNull(deliveryOrders.deliveryOtpLockedAt),
          lt(deliveryOrders.deliveryOtpAttempts, rules.maxAttempts),
        ),
      )
      .returning({ attempts: deliveryOrders.deliveryOtpAttempts });
    const attempts = counted?.attempts ?? rules.maxAttempts;
    if (counted) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.DELIVERY_CODE_WRONG,
          entityType: "delivery_order",
          entityId: row.id,
          newValue: { attempts, maxAttempts: rules.maxAttempts },
        },
        tx,
      );
    }
    if (attempts < rules.maxAttempts) return { locked: false as const, attemptsLeft: rules.maxAttempts - attempts };
    return { locked: true as const, ticketNumber: await lockDelivery(row.id, attempts, actor, tx) };
  });
  if (outcome.locked) throw lockedError(outcome.ticketNumber);
  throw validationFailed(
    `That delivery code does not match. ${outcome.attemptsLeft} attempt${outcome.attemptsLeft === 1 ? "" : "s"} left — ask the customer for the latest code in their order.`,
    { attemptsLeft: outcome.attemptsLeft },
  );
}

/**
 * Locks the drop (once), raises the support ticket and tells the customer,
 * the shop and support. Returns the ticket number. Idempotent: a second call
 * returns the existing ticket.
 */
async function lockDelivery(deliveryOrderId: string, attempts: number, actor: Actor, tx: DbClient): Promise<string | null> {
  const [locked] = await tx
    .update(deliveryOrders)
    .set({ deliveryOtpLockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(deliveryOrders.id, deliveryOrderId), isNull(deliveryOrders.deliveryOtpLockedAt)))
    .returning();
  if (!locked) {
    const [current] = await tx
      .select({ ticketNumber: grievances.ticketNumber })
      .from(deliveryOrders)
      .leftJoin(grievances, eq(grievances.id, deliveryOrders.deliveryOtpTicketId))
      .where(eq(deliveryOrders.id, deliveryOrderId));
    return current?.ticketNumber ?? null;
  }

  const [facts] = await tx
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      buyerId: orders.userId,
      buyerName: users.name,
      buyerEmail: users.email,
      buyerPhone: users.phoneE164,
      shopName: shops.name,
      shopOwnerId: shops.ownerId,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, locked.orderId));
  const [rider] = await tx
    .select({ userId: deliveryPartners.userId, name: deliveryPartners.fullName })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.id, locked.deliveryPartnerId));

  // The support ticket: a grievance on the order, raised by the system (no
  // submitting user), with the customer's contact details for the call.
  const [ticket] = await tx
    .insert(grievances)
    .values({
      submittedByUserId: null,
      orderId: locked.orderId,
      name: facts.buyerName?.trim() || "Customer",
      email: facts.buyerEmail,
      phone: facts.buyerPhone,
      category: "ORDER",
      subject: `Delivery code locked — order ${facts.orderNumber}`,
      description:
        `Raised automatically: the rider (${rider?.name ?? "unknown"}) entered ${attempts} wrong delivery codes for order ` +
        `${facts.orderNumber} from ${facts.shopName}, so the drop is locked. Call the customer, then confirm the ` +
        `delivery with a proof note or mark it failed from the operations exceptions queue.`,
      status: "OPEN",
    })
    .returning({ id: grievances.id, ticketNumber: grievances.ticketNumber });
  await tx.update(deliveryOrders).set({ deliveryOtpTicketId: ticket.id }).where(eq(deliveryOrders.id, deliveryOrderId));

  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DELIVERY_CODE_LOCKED,
      entityType: "delivery_order",
      entityId: deliveryOrderId,
      newValue: { attempts, ticketNumber: ticket.ticketNumber },
    },
    tx,
  );
  await emitEvent(
    {
      type: "delivery.code_locked",
      subjectId: deliveryOrderId,
      orderId: locked.orderId,
      actor,
      payload: {
        orderId: locked.orderId,
        orderNumber: facts.orderNumber,
        buyerId: facts.buyerId,
        shopOwnerId: facts.shopOwnerId,
        riderUserId: rider?.userId ?? null,
        shopName: facts.shopName,
        attempts,
        ticketNumber: ticket.ticketNumber,
      },
      idempotencyKey: `delivery-code-locked:${deliveryOrderId}:${locked.deliveryOtpLockedAt!.toISOString()}`,
    },
    tx,
  );
  return ticket.ticketNumber;
}

/* ------------------------------------------------------ customer's view */

export interface BuyerDeliveryCodeView {
  /** A code is waiting to be given to the rider. */
  active: boolean;
  locked: boolean;
  ticketNumber: string | null;
  resendsLeft: number;
  /** ISO time from which a new code may be requested, or null when it may be now. */
  nextRequestAt: string | null;
}

/** What the customer's order card shows about the delivery code — never the code itself. */
export async function buyerDeliveryCodeView(row: DeliveryOrder): Promise<BuyerDeliveryCodeView | null> {
  if (row.status !== "PICKED_UP" || !row.outForDeliveryAt) return null;
  const rules = await getRule("deliveryOtp");
  const next = row.deliveryOtpSentAt ? row.deliveryOtpSentAt.getTime() + rules.resendCooldownSeconds * 1000 : 0;
  let ticketNumber: string | null = null;
  if (row.deliveryOtpTicketId) {
    const [ticket] = await db
      .select({ ticketNumber: grievances.ticketNumber })
      .from(grievances)
      .where(eq(grievances.id, row.deliveryOtpTicketId));
    ticketNumber = ticket?.ticketNumber ?? null;
  }
  return {
    active: needsDeliveryCode(row),
    locked: row.deliveryOtpLockedAt != null || row.deliveryOtpAttempts >= rules.maxAttempts,
    ticketNumber,
    resendsLeft: Math.max(rules.maxResends - row.deliveryOtpResends, 0),
    nextRequestAt: next > Date.now() ? new Date(next).toISOString() : null,
  };
}
