/**
 * docs/guest-checkout-2026-11: order tracking without signing in, and the combined timeline of a
 * multi-shop purchase.
 *
 *  - getTrackingView(target): what /track/<token> shows — per shop: status, items, totals, the
 *    expected delivery time and a live-map link (the order page; the map itself needs sign-in).
 *    Personal data shown: the customer's first name and a masked mobile only — no address, no e-mail.
 *  - lookupByMobileDigits / requestTrackingCode / verifyTrackingCode: the /track form (order
 *    reference + the last 4 digits of the account's mobile, or e-mail + a one-time code). Every
 *    failure gives the same answer, so the form cannot be used to learn which references exist.
 *  - guestTrackingPath(userId, …): the link put in order e-mails of guest-created accounts.
 *
 * Reads only, except the audit rows of lookups.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { maskEmailAddress, normalizeEmail, isValidEmail } from "@/lib/contact";
import { validationFailed } from "@/lib/errors";
import { formatQuantity } from "@/lib/money";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import { orderGroups, orderItems, orders, orderStatusHistory, shops, users } from "@/server/db/schema";
import { requestOrderTrackOtp, verifyOrderTrackOtp } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { buildGroupTimeline, type ChildStatus, type GroupTimeline } from "./timeline";
import { signTrackingToken, trackingPath, type TrackingTarget } from "./token";

/** Both flags: guest checkout builds on the guest cart (owner brief 23-Nov-2026). */
export async function isGuestCheckoutOn(): Promise<boolean> {
  const [cart, checkout] = await Promise.all([
    isFeatureEnabled("guest_cart_enabled").catch(() => false),
    isFeatureEnabled("guest_checkout_enabled").catch(() => false),
  ]);
  return cart && checkout;
}

/** Status words a customer sees (kept here so this module does not load the whole order service). */
export const CUSTOMER_STATUS_LABELS: Record<ChildStatus, string> = {
  PENDING: "Placed — waiting for the shop",
  CONFIRMED: "Confirmed",
  ACCEPTED: "Accepted by shop",
  PREPARING: "Being packed",
  READY: "Packed, ready to go",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "Picked up by rider",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNED: "Returned to shop",
  DISPUTED: "Delivered — complaint open",
  CANCELLED: "Cancelled",
  PAYMENT_FAILED: "Payment failed",
  WALLET_INSUFFICIENT: "Waiting for payment",
  REFUND_PENDING: "Refund on its way",
  REFUNDED: "Refunded",
};

export const statusLabel = (s: ChildStatus): string => CUSTOMER_STATUS_LABELS[s] ?? s;

/** "Asha" from "Asha Kulkarni"; nothing when there is no name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : null;
}

export interface TrackingOrderView {
  id: string;
  orderNumber: string;
  shopName: string;
  status: ChildStatus;
  statusLabel: string;
  items: { name: string; quantity: string; lineTotalPaise: number; removed: boolean }[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  discountPaise: number;
  totalPaise: number;
  paymentMethod: string;
  promisedByAt: Date | null;
  /** The order page with the live map (sign-in needed); set while a rider has it. */
  liveTrackingUrl: string | null;
}

export interface TrackingView {
  kind: TrackingTarget["kind"];
  reference: string;
  placedAt: Date;
  customer: { firstName: string | null; maskedPhone: string | null };
  orders: TrackingOrderView[];
  totalPaise: number;
  timeline: GroupTimeline;
}

const LIVE_STATUSES: ReadonlySet<ChildStatus> = new Set(["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"]);

/** Timeline over the given orders, from their status history. */
export async function timelineForOrders(
  children: { id: string; shopName: string; status: ChildStatus }[],
): Promise<GroupTimeline> {
  const ids = children.map((c) => c.id);
  const history =
    ids.length === 0
      ? []
      : await db
          .select({ orderId: orderStatusHistory.orderId, status: orderStatusHistory.newStatus, at: orderStatusHistory.createdAt })
          .from(orderStatusHistory)
          .where(inArray(orderStatusHistory.orderId, ids))
          .orderBy(asc(orderStatusHistory.createdAt));
  return buildGroupTimeline(
    children.map((c) => ({ ...c, statusLabel: statusLabel(c.status) })),
    history.map((h) => ({ orderId: h.orderId, status: h.status as ChildStatus, at: h.at })),
    statusLabel,
  );
}

/** What /track/<token> shows, or null when the order or group no longer exists. */
export async function getTrackingView(target: TrackingTarget): Promise<TrackingView | null> {
  let reference: string;
  let placedAt: Date;
  let userId: string;
  let orderRows: (typeof orders.$inferSelect & { shopName: string })[];

  const select = { order: orders, shopName: shops.name };
  if (target.kind === "G") {
    const group = await db.query.orderGroups.findFirst({ where: eq(orderGroups.id, target.id) });
    if (!group) return null;
    reference = group.reference;
    placedAt = group.createdAt;
    userId = group.userId;
    const rows = await db
      .select(select)
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.orderGroupId, group.id))
      .orderBy(asc(orders.createdAt));
    orderRows = rows.map((r) => ({ ...r.order, shopName: r.shopName }));
  } else {
    const rows = await db.select(select).from(orders).innerJoin(shops, eq(shops.id, orders.shopId)).where(eq(orders.id, target.id));
    if (rows.length === 0) return null;
    reference = rows[0].order.orderNumber;
    placedAt = rows[0].order.createdAt;
    userId = rows[0].order.userId;
    orderRows = rows.map((r) => ({ ...r.order, shopName: r.shopName }));
  }
  // Defence in depth: every child must belong to the account that owns the group.
  orderRows = orderRows.filter((o) => o.userId === userId);
  if (orderRows.length === 0) return null;

  const ids = orderRows.map((o) => o.id);
  const [items, [account]] = await Promise.all([
    db
      .select({
        orderId: orderItems.orderId,
        name: orderItems.productNameSnapshot,
        unit: orderItems.unitSnapshot,
        quantityMilli: orderItems.quantityMilli,
        lineTotalPaise: orderItems.lineTotalPaise,
        fulfilmentStatus: orderItems.fulfilmentStatus,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids)),
    db.select({ name: users.name, phoneE164: users.phoneE164 }).from(users).where(eq(users.id, userId)),
  ]);

  const views: TrackingOrderView[] = orderRows.map((o) => {
    const status = o.status as ChildStatus;
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      shopName: o.shopName,
      status,
      statusLabel: statusLabel(status),
      items: items
        .filter((i) => i.orderId === o.id)
        .map((i) => ({
          name: i.name,
          quantity: formatQuantity(i.quantityMilli, i.unit),
          lineTotalPaise: i.lineTotalPaise,
          removed: i.fulfilmentStatus === "REMOVED",
        })),
      subtotalPaise: o.subtotalPaise,
      deliveryFeePaise: o.deliveryFeePaise,
      discountPaise: o.discountPaise,
      totalPaise: o.totalPaise,
      paymentMethod: o.paymentMethod,
      promisedByAt: o.promisedByAt,
      liveTrackingUrl: LIVE_STATUSES.has(status) ? `/orders/${o.id}` : null,
    };
  });

  return {
    kind: target.kind,
    reference,
    placedAt,
    customer: { firstName: firstNameOf(account?.name), maskedPhone: account?.phoneE164 ? maskPhone(account.phoneE164) : null },
    orders: views,
    totalPaise: views.reduce((n, o) => n + o.totalPaise, 0),
    timeline: await timelineForOrders(views.map((v) => ({ id: v.id, shopName: v.shopName, status: v.status }))),
  };
}

/* --------------------------------------------------------------- lookup */

/** The one answer every failed lookup gets. */
export const LOOKUP_FAILED = "We could not find an order with those details. Check the order reference and try again.";

interface ResolvedReference {
  target: TrackingTarget;
  userId: string;
}

/** "GK-…" is a multi-shop purchase, anything else an order number. Case and spaces ignored. */
export async function resolveReference(input: string): Promise<ResolvedReference | null> {
  const ref = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{2}-\d{8}-[A-Z0-9]{4,8}$/.test(ref)) return null;
  if (ref.startsWith("GK-")) {
    const group = await db.query.orderGroups.findFirst({ where: eq(orderGroups.reference, ref) });
    return group ? { target: { kind: "G", id: group.id }, userId: group.userId } : null;
  }
  const [order] = await db.select({ id: orders.id, userId: orders.userId, groupId: orders.orderGroupId }).from(orders).where(eq(orders.orderNumber, ref)).limit(1);
  if (!order) return null;
  // A shop order inside a multi-shop purchase opens the whole purchase.
  return { target: order.groupId ? { kind: "G", id: order.groupId } : { kind: "O", id: order.id }, userId: order.userId };
}

async function liveAccount(userId: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, phoneE164: users.phoneE164, status: users.status, emailPlaceholder: users.emailPlaceholder })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return row && row.status === "ACTIVE" ? row : null;
}

function auditLookup(input: { mode: string; ok: boolean; reference: string; ip: string | null; userId?: string | null; reason?: string }) {
  return recordAudit({
    actorId: null,
    action: AUDIT_ACTIONS.GUEST_TRACKING_LOOKUP,
    entityType: "order_tracking",
    entityId: input.userId ?? null,
    newValue: { mode: input.mode, ok: input.ok, reference: input.reference.slice(0, 32), ...(input.reason ? { reason: input.reason } : {}) },
    ipAddress: input.ip,
  });
}

/** Reference + the last 4 digits of the account's mobile → a tracking link. */
export async function lookupByMobileDigits(input: { reference: string; last4: string; ip?: string | null }): Promise<{ url: string }> {
  const ip = input.ip ?? null;
  const digits = input.last4.replace(/\D/g, "");
  const fail = async (reason: string, userId?: string): Promise<never> => {
    await auditLookup({ mode: "mobile", ok: false, reference: input.reference, ip, userId, reason });
    throw validationFailed(LOOKUP_FAILED);
  };
  if (digits.length !== 4) return fail("malformed");
  const resolved = await resolveReference(input.reference);
  if (!resolved) return fail("no_reference");
  const account = await liveAccount(resolved.userId);
  if (!account?.phoneE164 || account.phoneE164.slice(-4) !== digits) return fail("digits_mismatch", resolved.userId);
  await auditLookup({ mode: "mobile", ok: true, reference: input.reference, ip, userId: resolved.userId });
  return { url: trackingPath(resolved.target) };
}

/**
 * Reference + e-mail → a one-time code to that e-mail, only if the e-mail is the one on the order's
 * account. The answer is the same either way.
 */
export async function requestTrackingCode(input: { reference: string; email: string; ip?: string | null }): Promise<{ maskedEmail: string }> {
  const ip = input.ip ?? null;
  if (!isValidEmail(input.email)) throw validationFailed("Enter a valid email address, e.g. name@example.com.");
  const email = normalizeEmail(input.email);
  const resolved = await resolveReference(input.reference);
  const account = resolved ? await liveAccount(resolved.userId) : null;
  if (resolved && account && !account.emailPlaceholder && account.email === email) {
    await requestOrderTrackOtp({ email, userId: account.id, ip });
  } else {
    await auditLookup({ mode: "email_request", ok: false, reference: input.reference, ip, userId: resolved?.userId, reason: resolved ? "email_mismatch" : "no_reference" });
  }
  return { maskedEmail: maskEmailAddress(email) };
}

/** Reference + e-mail + the code → a tracking link. */
export async function verifyTrackingCode(input: { reference: string; email: string; code: string; ip?: string | null }): Promise<{ url: string }> {
  const ip = input.ip ?? null;
  const fail = async (reason: string, userId?: string): Promise<never> => {
    await auditLookup({ mode: "email_verify", ok: false, reference: input.reference, ip, userId, reason });
    throw validationFailed(LOOKUP_FAILED);
  };
  if (!isValidEmail(input.email)) return fail("malformed");
  const email = normalizeEmail(input.email);
  const resolved = await resolveReference(input.reference);
  if (!resolved) return fail("no_reference");
  const account = await liveAccount(resolved.userId);
  if (!account || account.email !== email) return fail("email_mismatch", resolved.userId);
  await verifyOrderTrackOtp({ email, userId: account.id, code: input.code, ip });
  await auditLookup({ mode: "email_verify", ok: true, reference: input.reference, ip, userId: resolved.userId });
  return { url: trackingPath(resolved.target) };
}

/* ------------------------------------------------------- e-mailed link */

/**
 * The order e-mails' button target for this account: the no-sign-in tracking link when guest
 * checkout is on and the account was made by guest checkout; otherwise null (the caller keeps
 * "/orders", as before).
 */
export async function guestTrackingLinkFor(userId: string): Promise<((target: { orderId: string; orderGroupId: string | null }) => string) | null> {
  if (!(await isGuestCheckoutOn())) return null;
  const [row] = await db.select({ guestCreated: users.guestCreated }).from(users).where(eq(users.id, userId));
  if (!row?.guestCreated) return null;
  return ({ orderId, orderGroupId }) => `/track/${signTrackingToken(orderGroupId ? { kind: "G", id: orderGroupId } : { kind: "O", id: orderId })}`;
}
