/**
 * Customer returns.
 *
 *   Order → select items → request → validation → approval → pickup
 *         → inspection → refund
 *
 * The rules that decide what may be returned (window, per-reason policy,
 * evidence, who bears the refund, whether a rider collects) come from the
 * `returns` rule group and are admin-tunable. Refunds go through the existing
 * finance refund (`refundDeliveredOrder`): wallet credit, ledger entries, shop
 * share, audit — a return never moves money any other way.
 */
import { randomBytes } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  RETURN_CONDITIONS,
  RETURN_REASONS,
  holdsQuantity,
  type ReturnCondition,
  type ReturnReason,
  type ReturnStatus,
} from "@/lib/return-states";
import { db } from "@/server/db";
import {
  orderItems,
  orderStatusHistory,
  orders,
  returnItems,
  returnPickups,
  returnRequests,
  returnStatusHistory,
  shops,
  storedImages,
  users,
  type ReturnItem,
  type ReturnPickup,
  type ReturnRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { refundDeliveredOrder } from "./finance";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { cancelLivePickup, createPickup, offerPickup, LIVE_PICKUP_STATUSES } from "./return-pickups";
import { transitionReturn, type ReturnActor } from "./return-transition";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

const STAFF: readonly UserRole[] = ["OPERATOR", "ADMIN"];
const isStaff = (role: UserRole) => STAFF.includes(role);

function newReturnNumber(): string {
  return `RT-${randomBytes(5).toString("hex").toUpperCase().slice(0, 8)}`;
}

export interface RequestReturnInput {
  orderId: string;
  reason: ReturnReason;
  comment?: string | null;
  items: {
    orderItemId: string;
    /** Milli-units to return (same scale as the order line). */
    quantityMilli: number;
    condition: ReturnCondition;
    comment?: string | null;
    imageIds?: string[];
  }[];
}

/** What a line is worth after fulfilment: a substitute replaces the original; a removed line is nothing. */
function effectiveLine(item: typeof orderItems.$inferSelect) {
  if (item.fulfilmentStatus === "REMOVED") return null;
  if (item.fulfilmentStatus === "SUBSTITUTED") {
    return {
      milli: item.substituteQuantityMilli ?? item.quantityMilli,
      totalPaise: item.substituteLineTotalPaise ?? item.lineTotalPaise,
      name: item.substituteNameSnapshot ?? item.productNameSnapshot,
    };
  }
  return { milli: item.quantityMilli, totalPaise: item.lineTotalPaise, name: item.productNameSnapshot };
}

/** Creates a return request; validation runs here and the request goes straight to "under review". */
export async function requestReturn(input: RequestReturnInput, actor: Actor): Promise<ReturnRequest> {
  if (!RETURN_REASONS.includes(input.reason)) throw validationFailed("Choose a reason for the return.");
  if (input.items.length === 0) throw validationFailed("Choose at least one item to return.");
  if (new Set(input.items.map((i) => i.orderItemId)).size !== input.items.length) {
    throw validationFailed("Each item can appear only once.");
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.quantityMilli) || item.quantityMilli <= 0) {
      throw validationFailed("Enter how much of each item you are returning.");
    }
    if (!RETURN_CONDITIONS.includes(item.condition)) throw validationFailed("Say what condition each item is in.");
  }

  const rules = await getRule("returns");
  const policy = rules.reasons[input.reason];
  if (!policy?.allowed) {
    throw validationFailed("Returns for this reason are not accepted. Please choose the reason that fits, or contact support.");
  }
  const imageIds = [...new Set(input.items.flatMap((i) => i.imageIds ?? []))];
  if (policy.requiresImages && imageIds.length === 0) {
    throw validationFailed("Please add at least one photo showing the problem.");
  }
  if (imageIds.length > rules.maxImagesPerReturn) {
    throw validationFailed(`You can attach at most ${rules.maxImagesPerReturn} photos.`);
  }
  if (imageIds.length > 0) {
    const owned = await db
      .select({ id: storedImages.id })
      .from(storedImages)
      .where(
        and(
          inArray(storedImages.id, imageIds),
          eq(storedImages.ownerId, actor.id),
          eq(storedImages.purpose, "RETURN_EVIDENCE"),
        ),
      );
    if (owned.length !== imageIds.length) throw validationFailed("One of the photos could not be used. Upload it again.");
  }

  const created = await db.transaction(async (tx) => {
    // Lock the order so two simultaneous requests cannot both claim the same quantity.
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update");
    if (!order || order.userId !== actor.id) throw notFound("Order");
    if (order.status !== "DELIVERED") {
      throw conflict("Only a delivered order can be returned.");
    }

    const [delivered] = await tx
      .select({ at: sql<Date>`max(${orderStatusHistory.createdAt})` })
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.newStatus, "DELIVERED")));
    const deliveredAt = delivered?.at ? new Date(delivered.at) : order.updatedAt;
    if (Date.now() > deliveredAt.getTime() + rules.windowHours * 3_600_000) {
      throw conflict(`The return window for this order (${rules.windowHours} hours after delivery) has passed.`);
    }

    const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const held = await tx
      .select({ orderItemId: returnItems.orderItemId, held: sql<number>`coalesce(sum(${returnItems.quantityMilli}), 0)::int` })
      .from(returnItems)
      .innerJoin(returnRequests, eq(returnItems.returnId, returnRequests.id))
      .where(
        and(
          eq(returnRequests.orderId, order.id),
          sql`${returnRequests.status} NOT IN ('REJECTED','RETURN_CANCELLED')`,
        ),
      )
      .groupBy(returnItems.orderItemId);
    const heldByLine = new Map(held.map((h) => [h.orderItemId, h.held]));

    const rows: { orderItemId: string; quantityMilli: number; condition: ReturnCondition; comment: string | null; imageIds: string[]; refundPaise: number }[] = [];
    for (const wanted of input.items) {
      const line = lines.find((l) => l.id === wanted.orderItemId);
      if (!line) throw validationFailed("One of those items is not part of this order.");
      const effective = effectiveLine(line);
      if (!effective) throw validationFailed(`${line.productNameSnapshot} was removed from this order and cannot be returned.`);
      const available = effective.milli - (heldByLine.get(line.id) ?? 0);
      if (wanted.quantityMilli > available) {
        throw validationFailed(
          available <= 0
            ? `${effective.name} already has a return in progress for its full quantity.`
            : `You can return at most ${available / 1000} of ${effective.name}.`,
        );
      }
      rows.push({
        orderItemId: line.id,
        quantityMilli: wanted.quantityMilli,
        condition: wanted.condition,
        comment: wanted.comment?.trim() || null,
        imageIds: wanted.imageIds ?? [],
        refundPaise: Math.round((effective.totalPaise * wanted.quantityMilli) / effective.milli),
      });
    }
    const refundAmountPaise = rows.reduce((n, r) => n + r.refundPaise, 0);
    if (refundAmountPaise > order.totalPaise) {
      throw validationFailed("The value of these items is more than what is left to refund on this order.");
    }

    const [shop] = await tx.select().from(shops).where(eq(shops.id, order.shopId));
    const [ret] = await tx
      .insert(returnRequests)
      .values({
        returnNumber: newReturnNumber(),
        orderId: order.id,
        userId: actor.id,
        shopId: order.shopId,
        reason: input.reason,
        comment: input.comment?.trim() || null,
        refundAmountPaise,
        chargeTo: policy.chargeTo,
        pickupRequired: rules.pickupByRider && Boolean(shop?.deliveryAvailable),
        pickupAddress: (order.deliveryAddressSnapshot as Record<string, unknown> | null) ?? null,
      })
      .returning();
    await tx.insert(returnItems).values(rows.map((r) => ({ ...r, returnId: ret.id })));

    const customer: ReturnActor = { id: actor.id, role: actor.role };
    await tx.insert(returnStatusHistory).values({
      returnId: ret.id,
      fromStatus: null,
      toStatus: "RETURN_REQUESTED",
      changedBy: actor.id,
      changedByRole: actor.role,
      note: input.comment?.trim() || null,
    });
    // Automatic validation passed — the request now waits for the shop's decision.
    const reviewing = await transitionReturn(tx, ret, "UNDER_REVIEW", customer, "Passed automatic checks");
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RETURN_REQUESTED,
        entityType: "return_request",
        entityId: ret.id,
        newValue: { returnNumber: ret.returnNumber, orderId: order.id, reason: input.reason, refundAmountPaise },
      },
      tx,
    );
    return { ret: reviewing, shopOwnerId: shop?.ownerId ?? null };
  });

  await notify({
    userId: actor.id,
    type: NOTIFICATION_TYPES.RETURN_REQUESTED,
    title: "Return requested",
    body: `Your return ${created.ret.returnNumber} is with the shop for review.`,
    actionUrl: `/returns/${created.ret.id}`,
  });
  if (created.shopOwnerId) {
    await notify({
      userId: created.shopOwnerId,
      type: NOTIFICATION_TYPES.RETURN_REQUESTED,
      title: "New return request",
      body: `Return ${created.ret.returnNumber} needs your review.`,
      actionUrl: "/shop/returns",
    });
  }
  return created.ret;
}

/* ----------------------------------------------------------- eligibility */

export interface ReturnableOrder {
  orderId: string;
  orderNumber: string;
  eligible: boolean;
  /** Why the order cannot be returned (window over, not delivered, nothing left...). */
  reason: string | null;
  windowEndsAt: Date | null;
  lines: {
    orderItemId: string;
    name: string;
    unit: string;
    /** Milli-units still returnable (ordered less anything already in a live return). */
    availableMilli: number;
    totalMilli: number;
    unitValuePaise: number;
  }[];
  reasons: { reason: ReturnReason; requiresImages: boolean }[];
  maxImages: number;
  pickupByRider: boolean;
}

/** What a customer may return from one order right now, and under which policy. */
export async function getReturnableOrder(orderId: string, userId: string): Promise<ReturnableOrder> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.userId !== userId) throw notFound("Order");
  const rules = await getRule("returns");
  const [delivered] = await db
    .select({ at: sql<Date>`max(${orderStatusHistory.createdAt})` })
    .from(orderStatusHistory)
    .where(and(eq(orderStatusHistory.orderId, order.id), eq(orderStatusHistory.newStatus, "DELIVERED")));
  const deliveredAt = delivered?.at ? new Date(delivered.at) : order.updatedAt;
  const windowEndsAt = new Date(deliveredAt.getTime() + rules.windowHours * 3_600_000);

  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const held = await db
    .select({ orderItemId: returnItems.orderItemId, held: sql<number>`coalesce(sum(${returnItems.quantityMilli}), 0)::int` })
    .from(returnItems)
    .innerJoin(returnRequests, eq(returnItems.returnId, returnRequests.id))
    .where(and(eq(returnRequests.orderId, order.id), sql`${returnRequests.status} NOT IN ('REJECTED','RETURN_CANCELLED')`))
    .groupBy(returnItems.orderItemId);
  const heldByLine = new Map(held.map((h) => [h.orderItemId, h.held]));

  const mapped = lines.flatMap((line) => {
    const effective = effectiveLine(line);
    if (!effective) return [];
    return [
      {
        orderItemId: line.id,
        name: effective.name,
        unit: line.unitSnapshot,
        totalMilli: effective.milli,
        availableMilli: Math.max(0, effective.milli - (heldByLine.get(line.id) ?? 0)),
        unitValuePaise: Math.round(effective.totalPaise / Math.max(1, effective.milli / 1000)),
      },
    ];
  });

  let reason: string | null = null;
  if (order.status !== "DELIVERED") reason = "Only a delivered order can be returned.";
  else if (Date.now() > windowEndsAt.getTime()) reason = `The return window (${rules.windowHours} hours after delivery) has passed.`;
  else if (mapped.every((l) => l.availableMilli === 0)) reason = "Everything in this order already has a return in progress.";

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    eligible: reason === null,
    reason,
    windowEndsAt: order.status === "DELIVERED" ? windowEndsAt : null,
    lines: mapped,
    reasons: RETURN_REASONS.filter((r) => rules.reasons[r]?.allowed).map((r) => ({
      reason: r,
      requiresImages: rules.reasons[r].requiresImages,
    })),
    maxImages: rules.maxImagesPerReturn,
    pickupByRider: rules.pickupByRider,
  };
}

/* --------------------------------------------------------------- access */

async function loadForActor(returnId: string, actor: Actor, mode: "manage" | "view") {
  const [row] = await db
    .select({ ret: returnRequests, shopOwnerId: shops.ownerId, shopName: shops.name })
    .from(returnRequests)
    .innerJoin(shops, eq(returnRequests.shopId, shops.id))
    .where(eq(returnRequests.id, returnId));
  if (!row) throw notFound("Return");
  const manages = isStaff(actor.role) || row.shopOwnerId === actor.id;
  if (mode === "manage" && !manages) throw forbidden("You cannot manage this return.");
  if (mode === "view" && !manages && row.ret.userId !== actor.id) throw notFound("Return");
  return row;
}

/** Evidence photos are visible to the customer who uploaded them, the shop the return is for, and staff. */
export async function canViewReturnImage(imageId: string, owner: string | null, actor: Actor): Promise<boolean> {
  if (owner === actor.id || isStaff(actor.role)) return true;
  const [row] = await db
    .select({ id: returnItems.id })
    .from(returnItems)
    .innerJoin(returnRequests, eq(returnItems.returnId, returnRequests.id))
    .innerJoin(shops, eq(returnRequests.shopId, shops.id))
    .where(and(eq(shops.ownerId, actor.id), sql`${returnItems.imageIds} @> ${JSON.stringify([imageId])}::jsonb`))
    .limit(1);
  return Boolean(row);
}

/* -------------------------------------------------------------- reading */

/** A row of a returns list. Like ReturnDetail, no customer address, user or staff ids. */
export interface ReturnSummary
  extends Pick<ReturnRequest, "id" | "returnNumber" | "status" | "refundAmountPaise" | "refundedPaise" | "createdAt"> {
  orderNumber: string;
  shopName: string;
  itemCount: number;
}

async function summarise(rows: Omit<ReturnSummary, "itemCount">[]): Promise<ReturnSummary[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({ returnId: returnItems.returnId, n: sql<number>`count(*)::int` })
    .from(returnItems)
    .where(inArray(returnItems.returnId, rows.map((r) => r.id)))
    .groupBy(returnItems.returnId);
  const byId = new Map(counts.map((c) => [c.returnId, c.n]));
  return rows.map((r) => ({ ...r, itemCount: byId.get(r.id) ?? 0 }));
}

const summaryQuery = () =>
  db
    .select({
      id: returnRequests.id,
      returnNumber: returnRequests.returnNumber,
      status: returnRequests.status,
      refundAmountPaise: returnRequests.refundAmountPaise,
      refundedPaise: returnRequests.refundedPaise,
      createdAt: returnRequests.createdAt,
      orderNumber: orders.orderNumber,
      shopName: shops.name,
    })
    .from(returnRequests)
    .innerJoin(orders, eq(returnRequests.orderId, orders.id))
    .innerJoin(shops, eq(returnRequests.shopId, shops.id));

export async function listReturnsForUser(userId: string): Promise<ReturnSummary[]> {
  return summarise(await summaryQuery().where(eq(returnRequests.userId, userId)).orderBy(desc(returnRequests.createdAt)).limit(100));
}

export async function listReturnsForShop(shopId: string, status?: ReturnStatus): Promise<ReturnSummary[]> {
  return summarise(
    await summaryQuery()
      .where(status ? and(eq(returnRequests.shopId, shopId), eq(returnRequests.status, status)) : eq(returnRequests.shopId, shopId))
      .orderBy(desc(returnRequests.createdAt))
      .limit(200),
  );
}

export async function listAllReturns(options: { status?: ReturnStatus; limit?: number } = {}): Promise<ReturnSummary[]> {
  return summarise(
    await summaryQuery()
      .where(options.status ? eq(returnRequests.status, options.status) : undefined)
      .orderBy(desc(returnRequests.createdAt))
      .limit(Math.min(options.limit ?? 100, 500)),
  );
}

/**
 * One return as its viewer sees it (ReturnCase renders exactly this). Built
 * field by field: the customer's pickup address, user and staff ids, and the
 * pickup's rider and attempt counters stay on the server.
 */
export interface ReturnDetail {
  ret: Pick<
    ReturnRequest,
    "id" | "returnNumber" | "status" | "reason" | "comment" | "refundAmountPaise" | "refundedPaise" | "decisionNote" | "inspectionNote"
  >;
  orderNumber: string;
  shopName: string;
  customerName: string | null;
  items: (Pick<ReturnItem, "id" | "quantityMilli" | "condition" | "comment" | "imageIds" | "refundPaise"> & {
    productName: string;
    unit: string;
  })[];
  history: Pick<typeof returnStatusHistory.$inferSelect, "id" | "toStatus" | "note" | "createdAt">[];
  /** `handoverCode` only for the customer, while the pickup is live. */
  pickup: (Pick<ReturnPickup, "status" | "scheduledFor"> & { handoverCode?: string }) | null;
  viewer: "CUSTOMER" | "SHOP" | "STAFF";
  /** Actions the viewer may take right now — the UI shows exactly these. */
  actions: string[];
}

export async function getReturnDetail(returnId: string, actor: Actor): Promise<ReturnDetail> {
  const { ret, shopName, shopOwnerId } = await loadForActor(returnId, actor, "view");
  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, ret.orderId));
  const [customer] = await db.select({ name: users.name }).from(users).where(eq(users.id, ret.userId));
  const items = await db
    .select({
      id: returnItems.id,
      quantityMilli: returnItems.quantityMilli,
      condition: returnItems.condition,
      comment: returnItems.comment,
      imageIds: returnItems.imageIds,
      refundPaise: returnItems.refundPaise,
      productName: orderItems.productNameSnapshot,
      unit: orderItems.unitSnapshot,
    })
    .from(returnItems)
    .innerJoin(orderItems, eq(returnItems.orderItemId, orderItems.id))
    .where(eq(returnItems.returnId, ret.id));
  const history = await db
    .select({
      id: returnStatusHistory.id,
      toStatus: returnStatusHistory.toStatus,
      note: returnStatusHistory.note,
      createdAt: returnStatusHistory.createdAt,
    })
    .from(returnStatusHistory)
    .where(eq(returnStatusHistory.returnId, ret.id))
    .orderBy(returnStatusHistory.createdAt);
  const [pickup] = await db
    .select({ status: returnPickups.status, scheduledFor: returnPickups.scheduledFor, handoverCode: returnPickups.handoverCode })
    .from(returnPickups)
    .where(eq(returnPickups.returnId, ret.id))
    .orderBy(desc(returnPickups.createdAt))
    .limit(1);

  const isCustomer = ret.userId === actor.id && !isStaff(actor.role) && shopOwnerId !== actor.id;
  const viewer = isStaff(actor.role) ? "STAFF" : shopOwnerId === actor.id ? "SHOP" : "CUSTOMER";
  const actions: string[] = [];
  const s = ret.status as ReturnStatus;
  if (viewer === "CUSTOMER" || ret.userId === actor.id) {
    if (["RETURN_REQUESTED", "UNDER_REVIEW", "APPROVED", "PICKUP_ASSIGNED", "PICKUP_SCHEDULED"].includes(s)) actions.push("cancel");
    if (["PICKUP_ASSIGNED", "PICKUP_SCHEDULED"].includes(s)) actions.push("schedule");
  }
  if (viewer !== "CUSTOMER") {
    if (s === "UNDER_REVIEW") actions.push("approve", "reject");
    if (s === "APPROVED" && ret.pickupRequired) actions.push("retry_pickup");
    if (s === "APPROVED" && !ret.pickupRequired) actions.push("receive");
    if (s === "PICKUP_COMPLETED") actions.push("receive");
    if (["PICKUP_COMPLETED", "INSPECTION_PENDING"].includes(s)) actions.push("inspect");
    if (["APPROVED_FOR_REFUND", "REFUND_INITIATED"].includes(s)) actions.push("issue_refund");
    if (["RIDER_EN_ROUTE"].includes(s) && viewer === "STAFF") actions.push("complete_pickup");
    if (["UNDER_REVIEW", "APPROVED", "PICKUP_ASSIGNED", "PICKUP_SCHEDULED", "RIDER_EN_ROUTE"].includes(s) && viewer === "STAFF") actions.push("cancel");
  }

  return {
    ret: {
      id: ret.id,
      returnNumber: ret.returnNumber,
      status: ret.status,
      reason: ret.reason,
      comment: ret.comment,
      refundAmountPaise: ret.refundAmountPaise,
      refundedPaise: ret.refundedPaise,
      decisionNote: ret.decisionNote,
      inspectionNote: ret.inspectionNote,
    },
    orderNumber: order?.orderNumber ?? "",
    shopName,
    customerName: viewer === "CUSTOMER" ? null : (customer?.name ?? null),
    items,
    history,
    pickup: pickup
      ? {
          status: pickup.status,
          scheduledFor: pickup.scheduledFor,
          // Only the customer is shown the code the rider must be given.
          ...(isCustomer && LIVE_PICKUP_STATUSES.includes(pickup.status as never) ? { handoverCode: pickup.handoverCode } : {}),
        }
      : null,
    viewer,
    actions,
  };
}

/* ------------------------------------------------------------- decisions */

export async function approveReturn(returnId: string, actor: Actor, note?: string): Promise<ReturnRequest> {
  const { ret } = await loadForActor(returnId, actor, "manage");
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    const approved = await transitionReturn(tx, locked, "APPROVED", actor, note, {
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNote: note?.trim() || null,
    });
    const pickup = approved.pickupRequired ? await createPickup(approved.id, tx) : null;
    return { approved, pickup };
  });
  await notify({
    userId: ret.userId,
    type: NOTIFICATION_TYPES.RETURN_APPROVED,
    title: "Return approved",
    body: result.approved.pickupRequired
      ? `Return ${ret.returnNumber} is approved. We are arranging a rider to collect the goods.`
      : `Return ${ret.returnNumber} is approved. Please take the goods to the shop.`,
    actionUrl: `/returns/${ret.id}`,
  });
  if (result.pickup) await offerPickup(result.pickup.id).catch((e) => console.error("[returns] offer failed", e));
  return result.approved;
}

export async function rejectReturn(returnId: string, actor: Actor, note: string): Promise<ReturnRequest> {
  const trimmed = note.trim();
  if (trimmed.length < 3) throw validationFailed("Tell the customer why the return is being declined.");
  const { ret } = await loadForActor(returnId, actor, "manage");
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    return transitionReturn(tx, locked, "REJECTED", actor, trimmed, {
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNote: trimmed,
    });
  });
  await notify({
    userId: ret.userId,
    type: NOTIFICATION_TYPES.RETURN_REJECTED,
    title: "Return declined",
    body: `Return ${ret.returnNumber} was declined: ${trimmed}`,
    actionUrl: `/returns/${ret.id}`,
  });
  return updated;
}

/** The customer (before the rider is on the way) or staff (until pickup) cancels the return. */
export async function cancelReturn(returnId: string, actor: Actor, note?: string): Promise<ReturnRequest> {
  const { ret, shopOwnerId } = await loadForActor(returnId, actor, "view");
  const isOwner = ret.userId === actor.id;
  if (!isOwner && !isStaff(actor.role)) throw forbidden("Only the customer or support can cancel a return.");
  if (isOwner && !isStaff(actor.role) && ["RIDER_EN_ROUTE"].includes(ret.status)) {
    throw conflict("The rider is already on the way — contact support to cancel.");
  }
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    const result = await transitionReturn(tx, locked, "RETURN_CANCELLED", actor, note ?? "Cancelled");
    await cancelLivePickup(returnId, tx);
    return result;
  });
  const recipients = new Set([ret.userId, shopOwnerId].filter((id): id is string => Boolean(id) && id !== actor.id));
  for (const userId of recipients) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.RETURN_CANCELLED,
      title: "Return cancelled",
      body: `Return ${ret.returnNumber} was cancelled.`,
      actionUrl: userId === ret.userId ? `/returns/${ret.id}` : "/shop/returns",
    });
  }
  return updated;
}

/** The goods are back with the shop (customer drop-off, or the rider delivered them). */
export async function receiveReturn(returnId: string, actor: Actor): Promise<ReturnRequest> {
  await loadForActor(returnId, actor, "manage");
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    let current = locked;
    if (current.status === "APPROVED" && !current.pickupRequired) {
      current = await transitionReturn(tx, current, "PICKUP_COMPLETED", actor, "Customer handed the goods to the shop");
    }
    return transitionReturn(tx, current, "INSPECTION_PENDING", actor, "Goods received at the shop");
  });
}

export interface InspectInput {
  outcome: "ACCEPT" | "REJECT";
  note: string;
  /** For ACCEPT: refund less than requested when only part of the goods qualify. */
  refundPaise?: number;
}

export async function inspectReturn(returnId: string, actor: Actor, input: InspectInput): Promise<ReturnRequest> {
  const note = input.note.trim();
  if (note.length < 3) throw validationFailed("Record what you found on inspection.");
  await loadForActor(returnId, actor, "manage");

  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    let current = locked;
    if (current.status === "PICKUP_COMPLETED") {
      current = await transitionReturn(tx, current, "INSPECTION_PENDING", actor, "Goods received at the shop");
    }
    const inspected = { inspectedBy: actor.id, inspectedAt: new Date(), inspectionNote: note };
    if (input.outcome === "REJECT") {
      return transitionReturn(tx, current, "REJECTED", actor, `Failed inspection: ${note}`, inspected);
    }
    const refund = input.refundPaise ?? current.refundAmountPaise;
    if (!Number.isInteger(refund) || refund <= 0 || refund > current.refundAmountPaise) {
      throw validationFailed(`The refund must be between ₹0.01 and ₹${(current.refundAmountPaise / 100).toFixed(2)}.`);
    }
    return transitionReturn(tx, current, "APPROVED_FOR_REFUND", actor, note, { ...inspected, refundAmountPaise: refund });
  });

  const [owner] = await db.select({ userId: returnRequests.userId }).from(returnRequests).where(eq(returnRequests.id, returnId));
  if (updated.status === "REJECTED") {
    await notify({
      userId: owner.userId,
      type: NOTIFICATION_TYPES.RETURN_REJECTED,
      title: "Return declined after inspection",
      body: `Return ${updated.returnNumber} did not pass inspection: ${note}`,
      actionUrl: `/returns/${updated.id}`,
    });
    return updated;
  }
  const rules = await getRule("returns");
  if (rules.autoRefundAfterInspection) return issueRefund(returnId, actor);
  return updated;
}

/**
 * Pays the refund through the finance module. Safe to call again after a
 * failure: the finance refund is idempotent on the return's own key, and the
 * return only moves on once the money has actually been credited.
 */
export async function issueRefund(returnId: string, actor: Actor): Promise<ReturnRequest> {
  await loadForActor(returnId, actor, "manage");
  const [current] = await db.select().from(returnRequests).where(eq(returnRequests.id, returnId));
  if (!current) throw notFound("Return");
  if (!["APPROVED_FOR_REFUND", "REFUND_INITIATED"].includes(current.status)) {
    throw new AppError("INVALID_STATE_TRANSITION", "This return is not ready for a refund.");
  }

  let working = current;
  if (working.status === "APPROVED_FOR_REFUND") {
    working = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
      return transitionReturn(tx, locked, "REFUND_INITIATED", actor, "Refund started");
    });
    await notify({
      userId: working.userId,
      type: NOTIFICATION_TYPES.RETURN_REFUND_INITIATED,
      title: "Refund started",
      body: `Your refund of ₹${(working.refundAmountPaise / 100).toFixed(2)} for return ${working.returnNumber} is being processed.`,
      actionUrl: `/returns/${working.id}`,
    });
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, working.orderId));
  const adjustment = await refundDeliveredOrder(
    {
      orderNumber: order.orderNumber,
      amountPaise: working.refundAmountPaise,
      reason: `Return ${working.returnNumber}`,
      chargeTo: working.chargeTo,
      requestId: `return-${working.id}`,
      // Module 2: a return's credit note; goods picked up go back into the shop's stock.
      creditNote: { reason: "RETURN", restock: working.pickupRequired },
    },
    actor,
  );

  const completed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(returnRequests).where(eq(returnRequests.id, returnId)).for("update");
    if (locked.status === "REFUND_COMPLETED") return locked;
    const done = await transitionReturn(tx, locked, "REFUND_COMPLETED", actor, "Refund credited to the wallet", {
      refundedPaise: working.refundAmountPaise,
      refundAdjustmentId: adjustment.id,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RETURN_REFUND_ISSUED,
        entityType: "return_request",
        entityId: returnId,
        newValue: { amountPaise: working.refundAmountPaise, chargeTo: working.chargeTo, adjustmentId: adjustment.id },
      },
      tx,
    );
    return done;
  });
  await notify({
    userId: completed.userId,
    type: NOTIFICATION_TYPES.RETURN_REFUND_COMPLETED,
    title: "Refund completed",
    body: `₹${(completed.refundAmountPaise / 100).toFixed(2)} for return ${completed.returnNumber} is back in your wallet.`,
    actionUrl: "/wallet",
    dedupeKey: `return-refund-completed:${completed.id}`,
  });
  return completed;
}

export { holdsQuantity };
