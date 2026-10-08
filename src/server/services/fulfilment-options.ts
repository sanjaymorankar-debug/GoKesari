/**
 * Fulfilment options and scheduling (docs/four-features-2026-10, feature 1).
 *
 * When a shop marks an order ready it chooses how the order reaches the
 * customer, and when (a date and a time slot):
 *
 *   PICKUP            the customer collects it; the shop completes it with the
 *                     pickup code the customer shows (My Orders, and email)
 *   SHOP_DELIVERY     one of the shop's own delivery people takes it, using a
 *                     private delivery link the shop shares with them; it is
 *                     completed with the customer's delivery code, exactly like
 *                     a rider's drop (code emailed when it goes out, "get a new
 *                     code", wrong-code lockout + support ticket)
 *   GOKESARI_PARTNER  the existing rider dispatch (delivery-assignment.ts),
 *                     unchanged; a later slot starts the rider search
 *                     gokesariLeadMinutes before it (fulfilment-guards.ts)
 *
 * The shop can change the option, the delivery person or the time until the
 * order is collected / out for delivery / picked up by a rider. Every set and
 * change is an event (emitEvent, in the same transaction) — the customer is
 * told at once, in the app and by email; nothing waits for a cron.
 *
 * Money: nothing here moves money. Pickup and own-delivery orders have no
 * GoKesari rider, so the shop wallet's delivery charge (finance.ts
 * walletCollectionFor: only rider-delivered orders) is never applied to them;
 * the commission applies on delivery as for every order.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  FULFILMENT_OPTION_LABELS,
  availableSlotDays,
  formatFulfilmentWindow,
  isAvailableSlot,
  slotBounds,
  slotKeyFor,
  type SlotRules,
} from "@/lib/fulfilment-options";
import { maskEmailAddress } from "@/lib/contact";
import { parsePhone } from "@/lib/phone";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  grievances,
  orderFulfilmentArrangements,
  orderItems,
  orders,
  riderSearches,
  shopDeliveryStaff,
  shops,
  users,
  type FulfilmentOption,
  type Order,
  type OrderFulfilmentArrangement,
  type ShopDeliveryStaff,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { dispatchReadyOrder, stopRiderSearch } from "./delivery-assignment";
import { DELIVERY_CODE_LENGTH, deliveryCodeMatches, generateDeliveryCode, hashDeliveryCode, sendDeliveryCodeToBuyer } from "./delivery-otp";
import { markOrderReady } from "./fulfilment";
import { fulfilmentTablesReady } from "./fulfilment-guards";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { updateOrderStatus } from "./orders";
import { getRule } from "./settings";

export interface Actor {
  id: string;
  role: UserRole;
}

export type { FulfilmentOption };

const isSupport = (actor: Actor) => can(actor.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY);

/* ======================================================= delivery staff */

export interface DeliveryStaffView {
  id: string;
  name: string;
  phoneE164: string;
  isActive: boolean;
}

const toStaffView = (row: ShopDeliveryStaff): DeliveryStaffView => ({
  id: row.id,
  name: row.name,
  phoneE164: row.phoneE164,
  isActive: row.isActive,
});

function parseStaffInput(input: { name: string; mobile: string }): { name: string; phoneE164: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw validationFailed("Enter the delivery person's name (2–80 characters).", { fields: { name: "Enter a name." } });
  const phone = parsePhone("+91", input.mobile);
  if (!phone.ok) throw validationFailed("Enter a valid 10-digit mobile number.", { fields: { mobile: phone.error } });
  return { name, phoneE164: phone.e164 };
}

export async function listDeliveryStaff(shopId: string, options: { activeOnly?: boolean } = {}): Promise<DeliveryStaffView[]> {
  if (!(await fulfilmentTablesReady())) return [];
  const rows = await db
    .select()
    .from(shopDeliveryStaff)
    .where(options.activeOnly ? and(eq(shopDeliveryStaff.shopId, shopId), eq(shopDeliveryStaff.isActive, true)) : eq(shopDeliveryStaff.shopId, shopId))
    .orderBy(sql`${shopDeliveryStaff.isActive} desc`, shopDeliveryStaff.name);
  return rows.map(toStaffView);
}

export async function addDeliveryStaff(shopId: string, input: { name: string; mobile: string }, actor: Actor): Promise<DeliveryStaffView> {
  const parsed = parseStaffInput(input);
  const [existing] = await db
    .select()
    .from(shopDeliveryStaff)
    .where(and(eq(shopDeliveryStaff.shopId, shopId), eq(shopDeliveryStaff.phoneE164, parsed.phoneE164)));
  if (existing) {
    throw conflict(
      existing.isActive
        ? `${existing.name} already has this mobile number in your team.`
        : `${existing.name} has this mobile number and is deactivated — edit and reactivate them instead.`,
    );
  }
  const [row] = await db
    .insert(shopDeliveryStaff)
    .values({ shopId, name: parsed.name, phoneE164: parsed.phoneE164, createdBy: actor.id })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_DELIVERY_STAFF_SAVED,
    entityType: "shop_delivery_staff",
    entityId: row.id,
    newValue: { shopId, name: row.name, created: true },
  });
  return toStaffView(row);
}

export async function updateDeliveryStaff(
  shopId: string,
  staffId: string,
  patch: { name?: string; mobile?: string; isActive?: boolean },
  actor: Actor,
): Promise<DeliveryStaffView> {
  const [current] = await db
    .select()
    .from(shopDeliveryStaff)
    .where(and(eq(shopDeliveryStaff.id, staffId), eq(shopDeliveryStaff.shopId, shopId)));
  if (!current) throw notFound("Delivery person");

  const parsed =
    patch.name !== undefined || patch.mobile !== undefined
      ? parseStaffInput({ name: patch.name ?? current.name, mobile: patch.mobile ?? current.phoneE164.replace(/^\+91/, "") })
      : { name: current.name, phoneE164: current.phoneE164 };
  if (parsed.phoneE164 !== current.phoneE164) {
    const [clash] = await db
      .select({ id: shopDeliveryStaff.id, name: shopDeliveryStaff.name })
      .from(shopDeliveryStaff)
      .where(and(eq(shopDeliveryStaff.shopId, shopId), eq(shopDeliveryStaff.phoneE164, parsed.phoneE164)));
    if (clash) throw conflict(`${clash.name} already has this mobile number in your team.`);
  }

  // A delivery person with an order still to deliver keeps it until the shop reassigns it.
  if (patch.isActive === false && current.isActive) {
    const open = await openDeliveriesFor(staffId);
    if (open.length > 0) {
      throw conflict(`Give ${open.join(", ")} to someone else first — ${current.name} still has to deliver ${open.length === 1 ? "it" : "them"}.`);
    }
  }

  const [row] = await db
    .update(shopDeliveryStaff)
    .set({
      name: parsed.name,
      phoneE164: parsed.phoneE164,
      ...(patch.isActive === undefined
        ? {}
        : { isActive: patch.isActive, deactivatedAt: patch.isActive ? null : new Date() }),
      updatedAt: new Date(),
    })
    .where(eq(shopDeliveryStaff.id, staffId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_DELIVERY_STAFF_SAVED,
    entityType: "shop_delivery_staff",
    entityId: staffId,
    previousValue: { name: current.name, isActive: current.isActive, phoneChanged: false },
    newValue: { name: row.name, isActive: row.isActive, phoneChanged: parsed.phoneE164 !== current.phoneE164 },
  });
  return toStaffView(row);
}

/** Order numbers still with this delivery person (ready or out for delivery). */
async function openDeliveriesFor(staffId: string): Promise<string[]> {
  const rows = await db
    .select({ orderNumber: orders.orderNumber })
    .from(orderFulfilmentArrangements)
    .innerJoin(orders, eq(orders.id, orderFulfilmentArrangements.orderId))
    .where(
      and(
        eq(orderFulfilmentArrangements.staffId, staffId),
        eq(orderFulfilmentArrangements.option, "SHOP_DELIVERY"),
        isNull(orderFulfilmentArrangements.completedAt),
        inArray(orders.status, ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"]),
      ),
    );
  return rows.map((r) => r.orderNumber);
}

/* ============================================================ the plan */

export interface PlanInput {
  option: FulfilmentOption;
  /** "YYYY-MM-DD@HH:MM" — one of availableSlotDays(). */
  slotKey: string;
  /** SHOP_DELIVERY: one of the shop's active delivery people. */
  staffId?: string | null;
}

/** Statuses in which the plan can be set or changed (see also the per-option checks). */
const PLANNABLE: readonly Order["status"][] = ["ACCEPTED", "PREPARING", "READY", "ASSIGNED"];

export async function getSlotRules(): Promise<SlotRules & { enabled: boolean; gokesariLeadMinutes: number }> {
  return getRule("fulfilmentOptions");
}

function labelFor(plan: Pick<OrderFulfilmentArrangement, "option" | "scheduledStart" | "scheduledEnd">): { optionLabel: string; whenLabel: string } {
  return { optionLabel: FULFILMENT_OPTION_LABELS[plan.option], whenLabel: formatFulfilmentWindow(plan.scheduledStart, plan.scheduledEnd) };
}

const nonce = () => randomBytes(12).toString("hex");

/**
 * Saves the plan for an order already locked by the caller (FOR UPDATE).
 * Returns what changed, for the follow-up work done after commit.
 */
async function savePlan(
  tx: DbClient,
  order: Order,
  input: PlanInput,
  actor: Actor,
): Promise<{ plan: OrderFulfilmentArrangement; previous: OrderFulfilmentArrangement | null; riderReleased: boolean }> {
  const rules = await getSlotRules();
  if (!rules.enabled) throw conflict("Pickup / delivery options are not switched on.");
  if (!PLANNABLE.includes(order.status)) {
    throw conflict(
      order.status === "CONFIRMED"
        ? "Accept the order before planning its delivery."
        : "This order's delivery can no longer be changed.",
    );
  }

  const [previous] = await tx
    .select()
    .from(orderFulfilmentArrangements)
    .where(eq(orderFulfilmentArrangements.orderId, order.id))
    .for("update");
  if (previous?.completedAt) throw conflict("This order has already been handed over.");
  if (previous?.option === "SHOP_DELIVERY" && previous.outForDeliveryAt) {
    throw conflict("The order is already out for delivery and can no longer be changed.");
  }

  // Slot: one the shop could pick now. Keeping an unchanged slot that has
  // since started (or passed) is allowed, so changing only the person works.
  const keepsSlot =
    previous != null && slotBounds(input.slotKey, rules.slotMinutes)?.start.getTime() === previous.scheduledStart.getTime();
  if (!keepsSlot && !isAvailableSlot(input.slotKey, rules)) {
    throw validationFailed("Choose one of the time slots offered.", { fields: { slotKey: "Choose a time slot." } });
  }
  const window = keepsSlot
    ? { start: previous!.scheduledStart, end: previous!.scheduledEnd }
    : slotBounds(input.slotKey, rules.slotMinutes)!;

  const [shop] = await tx.select().from(shops).where(eq(shops.id, order.shopId));
  if (!shop) throw notFound("Shop");

  let staff: ShopDeliveryStaff | null = null;
  if (input.option === "SHOP_DELIVERY" || input.option === "GOKESARI_PARTNER") {
    if (!order.deliveryAddressSnapshot) {
      throw validationFailed("This order has no delivery address — choose pickup.");
    }
  }
  if (input.option === "SHOP_DELIVERY") {
    if (!input.staffId) throw validationFailed("Choose who will deliver it.", { fields: { staffId: "Choose a delivery person." } });
    [staff] = await tx
      .select()
      .from(shopDeliveryStaff)
      .where(and(eq(shopDeliveryStaff.id, input.staffId), eq(shopDeliveryStaff.shopId, order.shopId)));
    if (!staff) throw validationFailed("Choose one of your own delivery people.", { fields: { staffId: "Unknown delivery person." } });
    if (!staff.isActive) throw validationFailed(`${staff.name} is deactivated.`, { fields: { staffId: "Deactivated." } });
  }
  if (input.option === "GOKESARI_PARTNER" && !shop.deliveryAvailable) {
    throw validationFailed("GoKesari delivery partners need delivery switched on in your shop settings — choose pickup or your own delivery.");
  }

  // The goods are with a rider once picked up: then only the rider can finish.
  const [riderRow] = await tx
    .select()
    .from(deliveryOrders)
    .where(and(eq(deliveryOrders.orderId, order.id), inArray(deliveryOrders.status, ["OFFERED", "ACCEPTED", "PICKED_UP"])))
    .for("update");
  if (riderRow?.status === "PICKED_UP") throw conflict("A rider has already picked this order up.");
  if (order.status === "ASSIGNED" && previous?.option !== "GOKESARI_PARTNER" && previous != null) {
    throw conflict("This order's delivery can no longer be changed.");
  }

  const timeMoves = previous == null || previous.scheduledStart.getTime() !== window.start.getTime();
  // A rider offered or assigned keeps the order only while it stays a GoKesari delivery for about now.
  const gokesariLater = window.start.getTime() - rules.gokesariLeadMinutes * 60_000 > Date.now();
  const releaseRider = riderRow != null && (input.option !== "GOKESARI_PARTNER" || (timeMoves && gokesariLater));

  const now = new Date();
  const fields = {
    option: input.option,
    scheduledStart: window.start,
    scheduledEnd: window.end,
    staffId: input.option === "SHOP_DELIVERY" ? staff!.id : null,
    // A new delivery person gets a new link (the old one stops working).
    staffLinkNonce:
      input.option === "SHOP_DELIVERY"
        ? previous?.option === "SHOP_DELIVERY" && previous.staffId === staff!.id && previous.staffLinkNonce
          ? previous.staffLinkNonce
          : nonce()
        : null,
    // The pickup code survives a time change; a new pickup plan gets a new code.
    codeNonce: input.option === "PICKUP" ? (previous?.option === "PICKUP" && previous.codeNonce ? previous.codeNonce : nonce()) : null,
    codeHash: null,
    codeSentAt: null,
    codeResends: 0,
    codeAttempts: previous?.option === input.option ? previous.codeAttempts : 0,
    codeLockedAt: previous?.option === input.option ? previous.codeLockedAt : null,
    updatedBy: actor.id,
    updatedAt: now,
  };

  const unchanged =
    previous != null &&
    previous.option === fields.option &&
    previous.scheduledStart.getTime() === fields.scheduledStart.getTime() &&
    (previous.staffId ?? null) === fields.staffId;
  if (unchanged) return { plan: previous!, previous, riderReleased: false };

  const [plan] = previous
    ? await tx
        .update(orderFulfilmentArrangements)
        .set({ ...fields, version: previous.version + 1 })
        .where(eq(orderFulfilmentArrangements.id, previous.id))
        .returning()
    : await tx
        .insert(orderFulfilmentArrangements)
        .values({ ...fields, orderId: order.id, shopId: order.shopId, createdBy: actor.id })
        .returning();

  if (releaseRider) await releaseRiderFor(tx, order, riderRow!, actor, "The shop changed the delivery plan.");
  if (input.option !== "GOKESARI_PARTNER") {
    await tx
      .update(riderSearches)
      .set({ status: "STOPPED", stopReason: "STOPPED_BY_SHOP", stoppedAt: now, updatedAt: now })
      .where(and(eq(riderSearches.orderId, order.id), eq(riderSearches.status, "SEARCHING")));
  } else if (previous == null || previous.option !== "GOKESARI_PARTNER" || releaseRider) {
    // A fresh automatic search when the rider is needed: now, or at the slot's lead time.
    const dispatchRules = await getRule("dispatch");
    const startAt = new Date(Math.max(now.getTime(), window.start.getTime() - rules.gokesariLeadMinutes * 60_000));
    await tx
      .update(riderSearches)
      .set({
        status: "SEARCHING",
        stopReason: null,
        stoppedAt: null,
        attempts: 0,
        maxAttempts: dispatchRules.maxAttempts,
        startedAt: startAt,
        lastAttemptAt: null,
        nextAttemptAt: null,
        supportAlertedAt: null,
        startedBy: actor.id,
        updatedAt: now,
      })
      .where(eq(riderSearches.orderId, order.id));
  }

  const labels = labelFor(plan);
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: previous ? AUDIT_ACTIONS.ORDER_FULFILMENT_CHANGED : AUDIT_ACTIONS.ORDER_FULFILMENT_SET,
      entityType: "order",
      entityId: order.id,
      previousValue: previous
        ? { option: previous.option, scheduledStart: previous.scheduledStart, staffId: previous.staffId }
        : null,
      newValue: { option: plan.option, scheduledStart: plan.scheduledStart, scheduledEnd: plan.scheduledEnd, staffId: plan.staffId, riderReleased: releaseRider },
    },
    tx,
  );
  await emitEvent(
    {
      type: previous ? "order.fulfilment_changed" : "order.fulfilment_set",
      subjectId: order.id,
      orderId: order.id,
      actor,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        buyerId: order.userId,
        shopOwnerUserId: shop.ownerId,
        shopName: shop.name,
        ...labels,
        staffName: staff?.name ?? null,
        previousLabel: previous ? `${labelFor(previous).optionLabel}, ${labelFor(previous).whenLabel}` : null,
        bySupport: actor.id !== shop.ownerId && isSupport(actor),
      },
      idempotencyKey: `fulfilment:${order.id}:v${plan.version}`,
    },
    tx,
  );
  return { plan, previous: previous ?? null, riderReleased: releaseRider };
}

/** Cancels an offered / accepted rider for this order (the shop chose otherwise). */
async function releaseRiderFor(
  tx: DbClient,
  order: Order,
  row: typeof deliveryOrders.$inferSelect,
  actor: Actor,
  reason: string,
): Promise<void> {
  await tx
    .update(deliveryOrders)
    .set({ status: "CANCELLED", cancelledAt: new Date(), cancellationReason: reason, deliveryOtpHash: null, deliveryOtp: null, updatedAt: new Date() })
    .where(eq(deliveryOrders.id, row.id));
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DELIVERY_ORDER_CANCELLED,
      entityType: "delivery_order",
      entityId: row.id,
      previousValue: { status: row.status },
      newValue: { status: "CANCELLED", reason },
    },
    tx,
  );
  const [shop] = await tx.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, order.shopId));
  const [rider] = await tx
    .select({ userId: deliveryPartners.userId })
    .from(deliveryPartners)
    .where(eq(deliveryPartners.id, row.deliveryPartnerId));
  await emitEvent(
    {
      type: "delivery.cancelled",
      subjectId: row.id,
      orderId: order.id,
      transition: { from: row.status, to: "CANCELLED" },
      actor,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        buyerId: order.userId,
        shopOwnerId: shop?.ownerId ?? null,
        shopName: shop?.name ?? "the shop",
        riderUserId: rider?.userId ?? null,
        reason,
      },
    },
    tx,
  );
  if (order.status === "ASSIGNED") {
    await updateOrderStatus(order.id, "READY", actor, reason, tx);
  }
}

/** After commit: rider search follow-up for a GoKesari plan (never undoes the plan). */
async function afterPlanSaved(orderId: string, plan: OrderFulfilmentArrangement, previous: OrderFulfilmentArrangement | null, actor: Actor) {
  try {
    if (plan.option === "GOKESARI_PARTNER") {
      await dispatchReadyOrder(orderId, actor, "AUTO_READY");
    } else if (previous?.option === "GOKESARI_PARTNER") {
      await stopRiderSearch(orderId, actor);
    }
  } catch (error) {
    console.error("[fulfilment-options] rider follow-up failed", orderId, error);
  }
}

/**
 * The shop marks a PREPARING order ready and chooses its fulfilment in one
 * step (the plan and READY commit together); or sets / changes the plan of an
 * order that is ACCEPTED, PREPARING, READY or ASSIGNED (before pickup).
 */
export async function planFulfilment(
  orderId: string,
  input: PlanInput & { markReady?: boolean },
  actor: Actor,
): Promise<{ order: Pick<Order, "id" | "orderNumber" | "status">; plan: OrderFulfilmentArrangement }> {
  let saved: Awaited<ReturnType<typeof savePlan>> | null = null;

  const current = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!current) throw notFound("Order");

  if (input.markReady && current.status === "PREPARING") {
    const ready = await markOrderReady(orderId, actor, {
      beforeReady: async (tx, locked) => {
        saved = await savePlan(tx, locked, input, actor);
      },
    });
    const result = saved as Awaited<ReturnType<typeof savePlan>> | null;
    return { order: { id: ready.id, orderNumber: ready.orderNumber, status: ready.status }, plan: result!.plan };
  }

  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order) throw notFound("Order");
    const out = await savePlan(tx, order, input, actor);
    const [after] = await tx.select().from(orders).where(eq(orders.id, orderId));
    return { ...out, order: after };
  });
  if (result.order.status === "READY") await afterPlanSaved(orderId, result.plan, result.previous, actor);
  return { order: { id: result.order.id, orderNumber: result.order.orderNumber, status: result.order.status }, plan: result.plan };
}

/* ============================================================== codes */

function secret(): string {
  return getEnv().AUTH_SECRET;
}

/** The customer's pickup code: derived, never stored. */
export function pickupCodeFor(plan: Pick<OrderFulfilmentArrangement, "id" | "codeNonce">): string | null {
  if (!plan.codeNonce) return null;
  const mac = createHmac("sha256", secret()).update(`pickup-code:${plan.id}:${plan.codeNonce}`).digest();
  return String(mac.readUInt32BE(0) % 10 ** DELIVERY_CODE_LENGTH).padStart(DELIVERY_CODE_LENGTH, "0");
}

/** The delivery person's link token: derived, never stored. */
export function staffLinkToken(plan: Pick<OrderFulfilmentArrangement, "id" | "staffLinkNonce">): string | null {
  if (!plan.staffLinkNonce) return null;
  const mac = createHmac("sha256", secret()).update(`staff-link:${plan.id}:${plan.staffLinkNonce}`).digest("base64url").slice(0, 32);
  return `${plan.id}.${mac}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanCode(raw: string | undefined): string {
  const code = (raw ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${DELIVERY_CODE_LENGTH}}$`).test(code)) {
    throw validationFailed(`Enter the ${DELIVERY_CODE_LENGTH}-digit code from the customer.`);
  }
  return code;
}

function lockedError(ticketNumber: string | null): AppError {
  return conflict(
    `Too many wrong codes — this order is on hold${ticketNumber ? ` and support ticket ${ticketNumber} has been raised` : ""}. Support will confirm it with the customer.`,
    { locked: true, ticketNumber },
  );
}

/**
 * Checks the code for `plan`; returns when it is right. A wrong code is counted
 * (committed, so the throw does not undo it); the attempt that reaches the
 * limit (rule deliveryOtp.maxAttempts) locks the plan and raises a ticket.
 */
async function checkCode(plan: OrderFulfilmentArrangement, raw: string | undefined, actor: Actor): Promise<void> {
  const rules = await getRule("deliveryOtp");
  if (plan.codeLockedAt || plan.codeAttempts >= rules.maxAttempts) {
    throw lockedError(await db.transaction((tx) => lockPlan(plan.id, plan.codeAttempts, actor, tx)));
  }
  const code = cleanCode(raw);
  const right =
    plan.option === "PICKUP"
      ? safeEqual(pickupCodeFor(plan) ?? "", code)
      : plan.codeHash != null && deliveryCodeMatches(plan.codeHash, plan.id, code);
  if (right) return;

  const outcome = await db.transaction(async (tx) => {
    const [counted] = await tx
      .update(orderFulfilmentArrangements)
      .set({ codeAttempts: sql`${orderFulfilmentArrangements.codeAttempts} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(orderFulfilmentArrangements.id, plan.id),
          isNull(orderFulfilmentArrangements.codeLockedAt),
          isNull(orderFulfilmentArrangements.completedAt),
          lt(orderFulfilmentArrangements.codeAttempts, rules.maxAttempts),
        ),
      )
      .returning({ attempts: orderFulfilmentArrangements.codeAttempts });
    const attempts = counted?.attempts ?? rules.maxAttempts;
    if (counted) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.ORDER_FULFILMENT_CODE_WRONG,
          entityType: "order",
          entityId: plan.orderId,
          newValue: { attempts, maxAttempts: rules.maxAttempts, option: plan.option },
        },
        tx,
      );
    }
    if (attempts < rules.maxAttempts) return { locked: false as const, attemptsLeft: rules.maxAttempts - attempts };
    return { locked: true as const, ticketNumber: await lockPlan(plan.id, attempts, actor, tx) };
  });
  if (outcome.locked) throw lockedError(outcome.ticketNumber);
  throw validationFailed(
    `That code does not match. ${outcome.attemptsLeft} attempt${outcome.attemptsLeft === 1 ? "" : "s"} left — ask the customer for the code in their order.`,
    { attemptsLeft: outcome.attemptsLeft },
  );
}

/** Locks the plan once, raises the support ticket (a grievance) and tells everyone. Returns the ticket number. */
async function lockPlan(planId: string, attempts: number, actor: Actor, tx: DbClient): Promise<string | null> {
  const [locked] = await tx
    .update(orderFulfilmentArrangements)
    .set({ codeLockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(orderFulfilmentArrangements.id, planId), isNull(orderFulfilmentArrangements.codeLockedAt)))
    .returning();
  const [plan] = locked ? [locked] : await tx.select().from(orderFulfilmentArrangements).where(eq(orderFulfilmentArrangements.id, planId));
  const [facts] = await tx
    .select({
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
    .where(eq(orders.id, plan.orderId));
  const subject = `${plan.option === "PICKUP" ? "Pickup" : "Delivery"} code locked — order ${facts.orderNumber}`;
  if (!locked) {
    const [existing] = await tx
      .select({ ticketNumber: grievances.ticketNumber })
      .from(grievances)
      .where(and(eq(grievances.orderId, plan.orderId), eq(grievances.subject, subject)));
    return existing?.ticketNumber ?? null;
  }
  const [ticket] = await tx
    .insert(grievances)
    .values({
      submittedByUserId: null,
      orderId: plan.orderId,
      name: facts.buyerName?.trim() || "Customer",
      email: facts.buyerEmail,
      phone: facts.buyerPhone,
      category: "ORDER",
      subject,
      description:
        `Raised automatically: ${attempts} wrong ${plan.option === "PICKUP" ? "pickup" : "delivery"} codes were entered for order ` +
        `${facts.orderNumber} from ${facts.shopName}, so the handover is locked. Call the customer, then confirm it from order monitoring.`,
      status: "OPEN",
    })
    .returning({ ticketNumber: grievances.ticketNumber });
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.ORDER_FULFILMENT_CODE_LOCKED,
      entityType: "order",
      entityId: plan.orderId,
      newValue: { attempts, ticketNumber: ticket.ticketNumber, option: plan.option },
    },
    tx,
  );
  await emitEvent(
    {
      type: "order.fulfilment_code_locked",
      subjectId: plan.orderId,
      orderId: plan.orderId,
      actor,
      payload: {
        orderId: plan.orderId,
        orderNumber: facts.orderNumber,
        buyerId: facts.buyerId,
        shopOwnerUserId: facts.shopOwnerId,
        shopName: facts.shopName,
        ...labelFor(plan),
        attempts,
        ticketNumber: ticket.ticketNumber,
        codeKind: plan.option === "PICKUP" ? "pickup" : "delivery",
      },
      idempotencyKey: `fulfilment-locked:${plan.id}:${locked.codeLockedAt!.toISOString()}`,
    },
    tx,
  );
  return ticket.ticketNumber;
}

async function loadPlanForOrder(orderId: string): Promise<{ order: Order; plan: OrderFulfilmentArrangement }> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw notFound("Order");
  const plan = await db.query.orderFulfilmentArrangements.findFirst({ where: eq(orderFulfilmentArrangements.orderId, orderId) });
  if (!plan) throw conflict("This order has no pickup / delivery plan.");
  return { order, plan };
}

/** Cash on delivery: whoever hands the order over confirms they took the cash. */
function assertCash(order: Order, cashCollected: boolean | undefined) {
  if (order.paymentMethod === "COD" && order.codCollectedAt == null && !cashCollected) {
    throw validationFailed("This is a cash-on-delivery order — confirm you collected the cash.", { cashRequired: true });
  }
}

/** The shop completes a pickup with the code the customer shows at the counter. */
export async function completePickup(
  orderId: string,
  input: { code: string; cashCollected?: boolean },
  actor: Actor,
): Promise<Pick<Order, "id" | "orderNumber" | "status">> {
  const { order, plan } = await loadPlanForOrder(orderId);
  if (plan.option !== "PICKUP") throw conflict("This order is not for pickup.");
  if (plan.completedAt || order.status === "DELIVERED") throw conflict("This order has already been collected.");
  if (order.status !== "READY") throw conflict("Mark the order ready before handing it over.");
  await checkCode(plan, input.code, actor);
  assertCash(order, input.cashCollected);
  return finish(order, plan, "PICKUP_CODE", actor, "Collected by the customer (pickup code)");
}

/** Marks the plan complete and the order DELIVERED in one transaction. */
async function finish(
  order: Order,
  plan: OrderFulfilmentArrangement,
  via: "PICKUP_CODE" | "DELIVERY_CODE" | "OPERATOR",
  actor: Actor,
  note: string,
): Promise<Pick<Order, "id" | "orderNumber" | "status">> {
  const done = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(orderFulfilmentArrangements)
      .set({ completedAt: new Date(), completedVia: via, codeHash: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(orderFulfilmentArrangements.id, plan.id), isNull(orderFulfilmentArrangements.completedAt)))
      .returning();
    if (!claimed) return null; // a double submit: the first one completed it
    const updated = await updateOrderStatus(order.id, "DELIVERED", actor, note, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.ORDER_FULFILMENT_COMPLETED,
        entityType: "order",
        entityId: order.id,
        newValue: { option: plan.option, via },
      },
      tx,
    );
    return updated;
  });
  if (done) return { id: done.id, orderNumber: done.orderNumber, status: done.status };
  const [current] = await db.select().from(orders).where(eq(orders.id, order.id));
  return { id: current.id, orderNumber: current.orderNumber, status: current.status };
}

/**
 * Own delivery: the order leaves the shop (READY → OUT_FOR_DELIVERY). A fresh
 * delivery code is stored hashed and emailed to the customer.
 */
export async function startOwnDelivery(orderId: string, actor: Actor, by?: string): Promise<Pick<Order, "id" | "orderNumber" | "status">> {
  const { order, plan } = await loadPlanForOrder(orderId);
  if (plan.option !== "SHOP_DELIVERY") throw conflict("This order is not set for your own delivery.");
  if (order.status === "OUT_FOR_DELIVERY" && plan.outForDeliveryAt) {
    return { id: order.id, orderNumber: order.orderNumber, status: order.status };
  }
  if (order.status !== "READY") throw conflict("Mark the order ready before it goes out.");
  const code = generateDeliveryCode();
  const updated = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(orderFulfilmentArrangements)
      .set({
        outForDeliveryAt: new Date(),
        codeHash: hashDeliveryCode(plan.id, code),
        codeSentAt: new Date(),
        codeResends: 0,
        codeAttempts: 0,
        codeLockedAt: null,
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(orderFulfilmentArrangements.id, plan.id), isNull(orderFulfilmentArrangements.outForDeliveryAt), eq(orderFulfilmentArrangements.option, "SHOP_DELIVERY")))
      .returning();
    if (!claimed) throw conflict("This order is already out for delivery.");
    return updateOrderStatus(order.id, "OUT_FOR_DELIVERY", actor, by ? `Out for delivery with ${by}` : "Out for delivery (shop's own delivery)", tx);
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.ORDER_FULFILMENT_CODE_SENT,
    entityType: "order",
    entityId: order.id,
    newValue: { reason: "out_for_delivery" },
  });
  await sendDeliveryCodeToBuyer(order.id, code);
  return { id: updated.id, orderNumber: updated.orderNumber, status: updated.status };
}

/** Own delivery: completed with the customer's delivery code. */
export async function completeOwnDelivery(
  orderId: string,
  input: { code: string; cashCollected?: boolean },
  actor: Actor,
): Promise<Pick<Order, "id" | "orderNumber" | "status">> {
  const { order, plan } = await loadPlanForOrder(orderId);
  if (plan.option !== "SHOP_DELIVERY") throw conflict("This order is not set for your own delivery.");
  if (plan.completedAt || order.status === "DELIVERED") {
    return { id: order.id, orderNumber: order.orderNumber, status: order.status };
  }
  if (order.status !== "OUT_FOR_DELIVERY" || !plan.outForDeliveryAt) throw conflict("Send the order out for delivery first.");
  await checkCode(plan, input.code, actor);
  assertCash(order, input.cashCollected);
  return finish(order, plan, "DELIVERY_CODE", actor, "Delivered by the shop's own delivery (delivery code)");
}

/** Operations confirm a locked (or otherwise stuck) pickup / own delivery after speaking to the customer. */
export async function confirmFulfilmentByOperator(
  orderId: string,
  input: { note: string; cashCollected?: boolean },
  actor: Actor,
): Promise<Pick<Order, "id" | "orderNumber" | "status">> {
  if (!isSupport(actor)) throw forbidden("Only operations can confirm a handover without the customer's code.");
  const note = input.note.trim();
  if (note.length < 5) throw validationFailed("Say how the handover was confirmed (at least 5 characters).");
  const { order, plan } = await loadPlanForOrder(orderId);
  if (plan.option === "GOKESARI_PARTNER") throw conflict("A GoKesari delivery is confirmed from the rider's delivery.");
  if (plan.completedAt) throw conflict("This order has already been handed over.");
  const expected = plan.option === "PICKUP" ? "READY" : "OUT_FOR_DELIVERY";
  if (order.status !== expected) throw conflict(plan.option === "PICKUP" ? "The order is not ready for pickup." : "The order is not out for delivery.");
  assertCash(order, input.cashCollected);
  return finish(order, plan, "OPERATOR", actor, `Confirmed by operations: ${note}`);
}

/* ------------------------------------------------- customer: new code */

export interface NewOwnDeliveryCodeResult {
  code: string;
  sentTo: string | null;
  resendsLeft: number;
}

/** The customer asks for a new own-delivery code (same limits as a rider's delivery code). */
export async function requestNewOwnDeliveryCode(orderId: string, buyer: Actor): Promise<NewOwnDeliveryCodeResult> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order || order.userId !== buyer.id) throw notFound("Order");
  const plan = await db.query.orderFulfilmentArrangements.findFirst({ where: eq(orderFulfilmentArrangements.orderId, orderId) });
  if (!plan || plan.option !== "SHOP_DELIVERY" || !plan.outForDeliveryAt || plan.completedAt) {
    throw conflict("A delivery code is available once your order is on the way.");
  }
  if (plan.codeLockedAt) throw conflict("This delivery is on hold after too many wrong codes. Our support team will contact you.");
  const rules = await getRule("deliveryOtp");
  if (plan.codeResends >= rules.maxResends) {
    throw new AppError("RATE_LIMITED", "You have asked for as many new codes as this delivery allows. Use the latest code from your email, or contact support.");
  }
  const code = generateDeliveryCode();
  const [updated] = await db
    .update(orderFulfilmentArrangements)
    .set({
      codeHash: hashDeliveryCode(plan.id, code),
      codeSentAt: new Date(),
      codeResends: sql`${orderFulfilmentArrangements.codeResends} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orderFulfilmentArrangements.id, plan.id),
        isNull(orderFulfilmentArrangements.codeLockedAt),
        isNull(orderFulfilmentArrangements.completedAt),
        lt(orderFulfilmentArrangements.codeResends, rules.maxResends),
        or(
          isNull(orderFulfilmentArrangements.codeSentAt),
          sql`${orderFulfilmentArrangements.codeSentAt} <= now() - make_interval(secs => ${rules.resendCooldownSeconds})`,
        ),
      ),
    )
    .returning();
  if (!updated) {
    const wait = plan.codeSentAt ? Math.ceil((plan.codeSentAt.getTime() + rules.resendCooldownSeconds * 1000 - Date.now()) / 1000) : 1;
    throw new AppError("RATE_LIMITED", `Please wait ${Math.max(wait, 1)} seconds before asking for another code.`, { retryAfterSeconds: Math.max(wait, 1) });
  }
  await recordAudit({
    actorId: buyer.id,
    actorRole: buyer.role,
    action: AUDIT_ACTIONS.ORDER_FULFILMENT_CODE_SENT,
    entityType: "order",
    entityId: orderId,
    newValue: { reason: "customer_request", resends: updated.codeResends },
  });
  const { sentTo } = await sendDeliveryCodeToBuyer(orderId, code);
  return { code, sentTo, resendsLeft: Math.max(rules.maxResends - updated.codeResends, 0) };
}

/* ======================================================== delivery link */

export interface StaffLinkView {
  orderId: string;
  orderNumber: string;
  status: Order["status"];
  shopName: string;
  shopPhone: string | null;
  staffName: string;
  whenLabel: string;
  /** Only while the delivery is open — the customer's details are not shown once it is finished. */
  customer: {
    name: string;
    phone: string | null;
    address: string;
    landmark: string | null;
    instructions: string | null;
    mapsUrl: string | null;
  } | null;
  items: { name: string; quantity: string }[];
  cashToCollectPaise: number | null;
  locked: boolean;
  canStart: boolean;
  canComplete: boolean;
}

/** The plan behind a delivery link, or a 404 for any link that is not (or no longer) valid. */
async function planForToken(token: string): Promise<{ plan: OrderFulfilmentArrangement; staff: ShopDeliveryStaff }> {
  const [id, mac] = token.split(".");
  if (!id || !mac || !/^[0-9a-f-]{36}$/.test(id)) throw notFound("Delivery");
  const plan = await db.query.orderFulfilmentArrangements.findFirst({ where: eq(orderFulfilmentArrangements.id, id) });
  if (!plan || plan.option !== "SHOP_DELIVERY" || !plan.staffId) throw notFound("Delivery");
  const expected = staffLinkToken(plan);
  if (!expected || !safeEqual(expected, token)) throw notFound("Delivery");
  const staff = await db.query.shopDeliveryStaff.findFirst({ where: eq(shopDeliveryStaff.id, plan.staffId) });
  if (!staff) throw notFound("Delivery");
  return { plan, staff };
}

export async function getStaffLinkView(token: string): Promise<StaffLinkView> {
  const { plan, staff } = await planForToken(token);
  const [row] = await db
    .select({ order: orders, shopName: shops.name, shopPhone: sql<string | null>`coalesce(${shops.contactPhone}, ${shops.phone})`, customerName: users.name, customerPhone: users.phoneE164 })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, plan.orderId));
  if (!row) throw notFound("Delivery");
  const open = !plan.completedAt && (row.order.status === "READY" || row.order.status === "OUT_FOR_DELIVERY");
  const items = await db
    .select({ name: orderItems.productNameSnapshot, unit: orderItems.unitSnapshot, quantityMilli: orderItems.quantityMilli, status: orderItems.fulfilmentStatus })
    .from(orderItems)
    .where(eq(orderItems.orderId, plan.orderId));
  const address = row.order.deliveryAddressSnapshot;
  const addressText = address ? [address.line1, address.line2, address.area, address.city, address.pincode].filter(Boolean).join(", ") : "";
  const mapsUrl = address
    ? address.latitude && address.longitude
      ? `https://www.google.com/maps/dir/?api=1&destination=${address.latitude},${address.longitude}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`
    : null;
  return {
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    status: row.order.status,
    shopName: row.shopName,
    shopPhone: row.shopPhone,
    staffName: staff.name,
    whenLabel: formatFulfilmentWindow(plan.scheduledStart, plan.scheduledEnd),
    customer: open
      ? {
          name: row.customerName?.trim() || "Customer",
          phone: row.customerPhone,
          address: addressText,
          landmark: address?.landmark ?? null,
          instructions: address?.deliveryInstructions ?? null,
          mapsUrl,
        }
      : null,
    items: open
      ? items
          .filter((i) => i.status !== "REMOVED")
          .map((i) => ({ name: i.name, quantity: `${i.quantityMilli / 1000} ${i.unit}` }))
      : [],
    cashToCollectPaise: open && row.order.paymentMethod === "COD" && !row.order.codCollectedAt ? row.order.totalPaise : null,
    locked: plan.codeLockedAt != null,
    canStart: open && row.order.status === "READY",
    canComplete: open && row.order.status === "OUT_FOR_DELIVERY" && plan.outForDeliveryAt != null && plan.codeLockedAt == null,
  };
}

/**
 * The delivery person acts through their link. They have no account, so the
 * change is recorded against the shop owner (the shop is responsible for its
 * staff) with the person's name in the note, and the owner is told.
 */
export async function actOnStaffLink(
  token: string,
  input: { action: "start" } | { action: "complete"; code: string; cashCollected?: boolean },
): Promise<StaffLinkView> {
  const { plan, staff } = await planForToken(token);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, plan.shopId));
  if (!shop) throw notFound("Delivery");
  const onBehalf: Actor = { id: shop.ownerId, role: "SHOP_OWNER" };
  const order = await db.query.orders.findFirst({ where: eq(orders.id, plan.orderId) });
  if (!order) throw notFound("Delivery");

  if (input.action === "start") {
    await startOwnDelivery(plan.orderId, onBehalf, staff.name);
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_ORDER_OUT_FOR_DELIVERY,
      title: "Out for delivery",
      body: `${staff.name} has taken order ${order.orderNumber} out for delivery.`,
      actionUrl: "/shop/orders",
      dedupeKey: `own-delivery-out:${plan.id}:${plan.version}`,
    });
  } else {
    await completeOwnDelivery(plan.orderId, { code: input.code, cashCollected: input.cashCollected }, onBehalf);
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_ORDER_DELIVERED,
      title: "Delivered",
      body: `${staff.name} delivered order ${order.orderNumber}.`,
      actionUrl: "/shop/orders",
      dedupeKey: `own-delivery-done:${plan.id}`,
    });
  }
  return getStaffLinkView(token);
}

/* ================================================================ views */

export interface ShopFulfilmentView {
  option: FulfilmentOption;
  optionLabel: string;
  whenLabel: string;
  slotKey: string;
  staff: { id: string; name: string; phoneE164: string } | null;
  /** Path of the delivery person's link (SHOP_DELIVERY, while open). */
  staffLinkPath: string | null;
  outForDelivery: boolean;
  completed: boolean;
  locked: boolean;
  /** GoKesari plan for a later slot: when the rider search starts. */
  riderSearchFrom: string | null;
}

export async function getShopFulfilmentViews(orderIds: string[]): Promise<Map<string, ShopFulfilmentView>> {
  if (orderIds.length === 0 || !(await fulfilmentTablesReady())) return new Map();
  const rows = await db
    .select({ plan: orderFulfilmentArrangements, staff: shopDeliveryStaff })
    .from(orderFulfilmentArrangements)
    .leftJoin(shopDeliveryStaff, eq(shopDeliveryStaff.id, orderFulfilmentArrangements.staffId))
    .where(inArray(orderFulfilmentArrangements.orderId, orderIds));
  const rules = await getSlotRules();
  return new Map(
    rows.map(({ plan, staff }) => {
      const token = plan.option === "SHOP_DELIVERY" && !plan.completedAt ? staffLinkToken(plan) : null;
      const from = plan.scheduledStart.getTime() - rules.gokesariLeadMinutes * 60_000;
      return [
        plan.orderId,
        {
          option: plan.option,
          ...labelFor(plan),
          slotKey: slotKeyFor(plan.scheduledStart),
          staff: staff ? { id: staff.id, name: staff.name, phoneE164: staff.phoneE164 } : null,
          staffLinkPath: token ? `/delivery/${token}` : null,
          outForDelivery: plan.outForDeliveryAt != null,
          completed: plan.completedAt != null,
          locked: plan.codeLockedAt != null,
          riderSearchFrom: plan.option === "GOKESARI_PARTNER" && from > Date.now() ? new Date(from).toISOString() : null,
        },
      ] as const;
    }),
  );
}

export interface BuyerFulfilmentView {
  option: FulfilmentOption;
  optionLabel: string;
  whenLabel: string;
  staffName: string | null;
  shopAddress: string | null;
  /** PICKUP, while the order waits at the shop: the code to show at the counter. */
  pickupCode: string | null;
  /** SHOP_DELIVERY, out for delivery: the code state (never the code itself). */
  deliveryCode: { active: boolean; locked: boolean; resendsLeft: number; maskedEmail: string } | null;
  completed: boolean;
  updated: boolean;
}

export async function getBuyerFulfilmentViews(orderIds: string[], buyer: { id: string; email: string }): Promise<Map<string, BuyerFulfilmentView>> {
  if (orderIds.length === 0 || !(await fulfilmentTablesReady())) return new Map();
  const rows = await db
    .select({
      plan: orderFulfilmentArrangements,
      staffName: shopDeliveryStaff.name,
      orderStatus: orders.status,
      buyerId: orders.userId,
      shop: { line1: shops.addressLine1, area: shops.area, city: shops.city, pincode: shops.pincode },
    })
    .from(orderFulfilmentArrangements)
    .innerJoin(orders, eq(orders.id, orderFulfilmentArrangements.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .leftJoin(shopDeliveryStaff, eq(shopDeliveryStaff.id, orderFulfilmentArrangements.staffId))
    .where(inArray(orderFulfilmentArrangements.orderId, orderIds));
  const otp = await getRule("deliveryOtp");
  const result = new Map<string, BuyerFulfilmentView>();
  for (const { plan, staffName, orderStatus, buyerId, shop } of rows) {
    if (buyerId !== buyer.id) continue;
    const waitingAtShop = plan.option === "PICKUP" && orderStatus === "READY" && !plan.completedAt && !plan.codeLockedAt;
    result.set(plan.orderId, {
      option: plan.option,
      ...labelFor(plan),
      staffName: plan.option === "SHOP_DELIVERY" ? staffName : null,
      shopAddress: plan.option === "PICKUP" ? [shop.line1, shop.area, shop.city, shop.pincode].filter(Boolean).join(", ") : null,
      pickupCode: waitingAtShop ? pickupCodeFor(plan) : null,
      deliveryCode:
        plan.option === "SHOP_DELIVERY" && plan.outForDeliveryAt && !plan.completedAt && orderStatus === "OUT_FOR_DELIVERY"
          ? {
              active: plan.codeHash != null,
              locked: plan.codeLockedAt != null,
              resendsLeft: Math.max(otp.maxResends - plan.codeResends, 0),
              maskedEmail: maskEmailAddress(buyer.email),
            }
          : null,
      completed: plan.completedAt != null,
      updated: plan.version > 1,
    });
  }
  return result;
}

/** Slot choices for the shop's planner (computed on the server's clock). */
export async function plannerOptions(): Promise<{ enabled: boolean; days: ReturnType<typeof availableSlotDays> }> {
  const rules = await getSlotRules();
  return { enabled: rules.enabled, days: rules.enabled ? availableSlotDays(rules) : [] };
}
