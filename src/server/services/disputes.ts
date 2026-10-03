/**
 * Dispute cases (GS-058).
 *
 * A dispute is the case *about* a delivered order: who raised it, what it is
 * worth, who is reviewing it, and what the decision did to the money. The
 * lifecycle and its legal moves live in `@/lib/dispute-states`, enforced here
 * and never bypassed — every change appends a `dispute_events` row, including
 * the ones the escalation sweep makes with nobody deciding them.
 *
 * Three boundaries worth stating, because each is a thing this file
 * deliberately does NOT do:
 *
 *   - It never moves money. Resolving with a refund calls the existing finance
 *     refund (`refundDeliveredOrder`), and records the adjustment it returns.
 *     "What did this dispute cost" is then answerable from the ledger, not
 *     from a number somebody typed into the case.
 *   - It does not replace `grievances`. That table is the statutory redressal
 *     record and stays a plain ladder; a dispute links to the grievance that
 *     started it.
 *   - It does not touch the order's own status. An operator marking an order
 *     DISPUTED and a dispute case existing are related but separate facts, and
 *     collapsing them would make the order state machine depend on this one.
 */
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  canMoveDispute,
  isDisputeTerminal,
  outcomeRequiresRefund,
  type DisputeLevel,
  type DisputeOutcome,
  type DisputeReason,
  type DisputeStatus,
  type EscalationTrigger,
} from "@/lib/dispute-states";
import { formatPaise } from "@/lib/money";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  disputeEvents,
  grievances,
  orderDisputes,
  orders,
  users,
  type DisputeEvent,
  type OrderDispute,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { refundDeliveredOrder } from "./finance";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

/** Statuses a case can still be worked in — the sweep's and the queue's "live" set. */
const LIVE_STATUSES: DisputeStatus[] = ["OPEN", "TRIAGED", "INVESTIGATING", "RESOLUTION_PROPOSED", "ESCALATED"];

export { LIVE_STATUSES as LIVE_DISPUTE_STATUSES };

const isStaff = (role: UserRole) => role === "OPERATOR" || role === "ADMIN";

/** Only an administrator works an escalated case: that is what escalation means. */
function assertMayWork(dispute: Pick<OrderDispute, "level">, actor: Actor): void {
  if (!isStaff(actor.role)) throw forbidden("Only operations staff may work a dispute.");
  if (dispute.level === "L2" && actor.role !== "ADMIN") {
    throw forbidden("This case is escalated — only an administrator can take it forward.");
  }
}

async function appendEvent(
  tx: DbClient,
  input: {
    disputeId: string;
    fromStatus: DisputeStatus | null;
    toStatus: DisputeStatus;
    fromLevel: DisputeLevel | null;
    toLevel: DisputeLevel;
    actor: Actor | null;
    note?: string | null;
  },
): Promise<void> {
  await tx.insert(disputeEvents).values({
    disputeId: input.disputeId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    fromLevel: input.fromLevel,
    toLevel: input.toLevel,
    actorId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    note: input.note ?? null,
  });
}

export interface OpenDisputeInput {
  orderId: string;
  reason: DisputeReason;
  description: string;
  /** What is being disputed, in paise. Must be within the order total. */
  disputedAmountPaise: number;
  /** The complaint this case came from, when it came from one. */
  grievanceId?: string | null;
}

/**
 * Opens a case against a delivered order.
 *
 * The customer who owns the order may open one, as may operations on their
 * behalf. A second live case on the same order is refused — two reviewers
 * working the same complaint is how a double refund happens.
 */
export async function openDispute(input: OpenDisputeInput, actor: Actor): Promise<OrderDispute> {
  const description = input.description.trim();
  if (description.length < 10) throw validationFailed("Describe the problem in a little more detail.");
  if (!Number.isInteger(input.disputedAmountPaise) || input.disputedAmountPaise <= 0) {
    throw validationFailed("The disputed amount must be more than zero.");
  }

  const rules = await getRule("disputes");

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        userId: orders.userId,
        shopId: orders.shopId,
        orderNumber: orders.orderNumber,
        status: orders.status,
        totalPaise: orders.totalPaise,
        paymentMethod: orders.paymentMethod,
        paidAt: orders.paidAt,
        codCollectedAt: orders.codCollectedAt,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update");
    if (!order) throw notFound("Order");

    const isOwner = order.userId === actor.id;
    if (!isOwner && !isStaff(actor.role)) throw forbidden("You can only dispute your own order.");

    // A dispute is about goods the customer has: before delivery the order's
    // own cancel and failure paths apply, and they refund differently.
    if (order.status !== "DELIVERED" && order.status !== "DISPUTED") {
      throw conflict("Only a delivered order can be disputed — cancel it instead.");
    }
    if (input.disputedAmountPaise > order.totalPaise) {
      throw validationFailed(
        `At most ${formatPaise(order.totalPaise)} can be disputed on this order.`,
      );
    }

    const [live] = await tx
      .select({ caseNumber: orderDisputes.caseNumber })
      .from(orderDisputes)
      .where(and(eq(orderDisputes.orderId, order.id), inArray(orderDisputes.status, LIVE_STATUSES)))
      .limit(1);
    if (live) {
      throw conflict(`Dispute ${live.caseNumber} is already open on this order.`);
    }

    if (input.grievanceId) {
      const [grievance] = await tx
        .select({ id: grievances.id })
        .from(grievances)
        .where(eq(grievances.id, input.grievanceId))
        .limit(1);
      if (!grievance) throw notFound("Grievance");
    }

    // The amount trigger fires at open: a case worth more than the review
    // limit never sits at L1, not even for the minute before the sweep runs.
    const escalateNow =
      rules.escalateAbovePaise > 0 && input.disputedAmountPaise >= rules.escalateAbovePaise;

    const [dispute] = await tx
      .insert(orderDisputes)
      .values({
        orderId: order.id,
        shopId: order.shopId,
        raisedByUserId: actor.id,
        grievanceId: input.grievanceId ?? null,
        status: escalateNow ? "ESCALATED" : "OPEN",
        level: escalateNow ? "L2" : "L1",
        reason: input.reason,
        description,
        disputedAmountPaise: input.disputedAmountPaise,
        paymentMethodSnapshot: order.paymentMethod,
        orderTotalPaise: order.totalPaise,
        orderPaidAt: order.paidAt ?? order.codCollectedAt ?? null,
        escalatedAt: escalateNow ? new Date() : null,
        escalationTrigger: escalateNow ? "AMOUNT" : null,
        escalationNote: escalateNow
          ? `Opened at ${formatPaise(input.disputedAmountPaise)}, at or above the ${formatPaise(rules.escalateAbovePaise)} review limit.`
          : null,
      })
      .returning();

    await appendEvent(tx, {
      disputeId: dispute.id,
      fromStatus: null,
      toStatus: dispute.status,
      fromLevel: null,
      toLevel: dispute.level,
      actor,
      note: escalateNow ? dispute.escalationNote : null,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DISPUTE_OPENED,
        entityType: "order_dispute",
        entityId: dispute.id,
        newValue: {
          caseNumber: dispute.caseNumber,
          orderNumber: order.orderNumber,
          reason: input.reason,
          disputedAmountPaise: input.disputedAmountPaise,
          status: dispute.status,
          level: dispute.level,
        },
      },
      tx,
    );

    await notify(
      {
        userId: order.userId,
        type: NOTIFICATION_TYPES.DISPUTE_OPENED,
        vars: { caseNumber: dispute.caseNumber, orderNumber: order.orderNumber },
        actionUrl: "/orders",
      },
      tx,
    );

    return dispute;
  });
}

export interface AdvanceDisputeInput {
  to: DisputeStatus;
  note?: string | null;
  /** RESOLUTION_PROPOSED only: what is being offered, sent to the customer. */
  proposal?: string | null;
}

/**
 * Moves a case along its lifecycle. Refuses anything the transition table does
 * not allow, and refuses to reach RESOLVED this way — resolving decides money
 * and goes through `resolveDispute`.
 */
export async function advanceDispute(
  disputeId: string,
  input: AdvanceDisputeInput,
  actor: Actor,
): Promise<OrderDispute> {
  if (input.to === "RESOLVED") {
    throw validationFailed("Use the resolve action: resolving a dispute records its outcome.");
  }
  if (input.to === "ESCALATED") {
    throw validationFailed("Use the escalate action, which records why.");
  }

  return db.transaction(async (tx) => {
    const dispute = await lockDispute(tx, disputeId);
    assertMayWork(dispute, actor);
    if (isDisputeTerminal(dispute.status)) {
      throw conflict(`Dispute ${dispute.caseNumber} is already closed.`);
    }
    if (!canMoveDispute(dispute.status, input.to)) {
      throw conflict(`A dispute cannot go from ${dispute.status} to ${input.to}.`);
    }
    if (input.to === "RESOLUTION_PROPOSED" && !input.proposal?.trim()) {
      throw validationFailed("Say what is being proposed — the customer is told.");
    }

    const [updated] = await tx
      .update(orderDisputes)
      .set({ status: input.to, updatedAt: new Date() })
      .where(eq(orderDisputes.id, dispute.id))
      .returning();

    await appendEvent(tx, {
      disputeId: dispute.id,
      fromStatus: dispute.status,
      toStatus: input.to,
      fromLevel: dispute.level,
      toLevel: dispute.level,
      actor,
      note: input.proposal?.trim() ?? input.note ?? null,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DISPUTE_STATUS_CHANGED,
        entityType: "order_dispute",
        entityId: dispute.id,
        previousValue: { status: dispute.status },
        newValue: { status: input.to },
      },
      tx,
    );

    if (input.to === "RESOLUTION_PROPOSED") {
      await notifyRaiser(tx, dispute, NOTIFICATION_TYPES.DISPUTE_RESOLUTION_PROPOSED, {
        caseNumber: dispute.caseNumber,
        proposal: input.proposal!.trim(),
      });
    }
    if (input.to === "REJECTED") {
      await notifyRaiser(tx, dispute, NOTIFICATION_TYPES.DISPUTE_REJECTED, {
        caseNumber: dispute.caseNumber,
        reason: input.note?.trim() || "after review",
      });
    }

    return updated;
  });
}

/**
 * Escalates a case to L2. Called by a reviewer, and by the sweep with
 * `actor: null` — an automatic escalation has no decider, and the event row
 * says so by carrying no actor rather than pretending one.
 */
export async function escalateDispute(
  disputeId: string,
  input: { trigger: EscalationTrigger; note: string },
  actor: Actor | null,
  client?: DbClient,
): Promise<OrderDispute> {
  const run = async (tx: DbClient) => {
    const dispute = await lockDispute(tx, disputeId);
    // Any staff member may escalate; the L2 guard below is what stops a case
    // being escalated twice, so assertMayWork's level check is not wanted here.
    if (actor && !isStaff(actor.role)) {
      throw forbidden("Only operations staff may escalate a dispute.");
    }
    if (isDisputeTerminal(dispute.status)) {
      throw conflict(`Dispute ${dispute.caseNumber} is already closed.`);
    }
    if (dispute.level === "L2") {
      throw conflict(`Dispute ${dispute.caseNumber} is already escalated.`);
    }
    if (!canMoveDispute(dispute.status, "ESCALATED")) {
      throw conflict(`A dispute cannot be escalated from ${dispute.status}.`);
    }

    const [updated] = await tx
      .update(orderDisputes)
      .set({
        status: "ESCALATED",
        level: "L2",
        escalatedAt: new Date(),
        escalationTrigger: input.trigger,
        escalationNote: input.note,
        updatedAt: new Date(),
      })
      .where(eq(orderDisputes.id, dispute.id))
      .returning();

    await appendEvent(tx, {
      disputeId: dispute.id,
      fromStatus: dispute.status,
      toStatus: "ESCALATED",
      fromLevel: dispute.level,
      toLevel: "L2",
      actor,
      note: input.note,
    });

    await recordAudit(
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: AUDIT_ACTIONS.DISPUTE_ESCALATED,
        entityType: "order_dispute",
        entityId: dispute.id,
        previousValue: { status: dispute.status, level: dispute.level },
        newValue: { status: "ESCALATED", level: "L2", trigger: input.trigger },
      },
      tx,
    );

    return updated;
  };

  return client ? run(client) : db.transaction(run);
}

export interface ResolveDisputeInput {
  outcome: DisputeOutcome;
  notes: string;
  /** Required for a refund outcome. Never more than the disputed amount. */
  refundPaise?: number;
  /** SHOP: comes off the shop's next settlement. PLATFORM: absorbed. */
  chargeTo?: "SHOP" | "PLATFORM";
  /** Client-generated, so a double submit cannot refund twice. */
  requestId: string;
}

/**
 * Closes a case with an outcome, moving money through the finance refund when
 * the outcome calls for it.
 *
 * The refund runs in its own transaction (it has its own locking and
 * idempotency), and the case is only marked resolved once it has returned —
 * so a failed refund leaves a case still open rather than a case claiming a
 * refund that never happened.
 */
export async function resolveDispute(
  disputeId: string,
  input: ResolveDisputeInput,
  actor: Actor,
): Promise<OrderDispute> {
  const notes = input.notes.trim();
  if (notes.length < 3) throw validationFailed("Record how the dispute was resolved.");
  if (!can(actor.role, PERMISSIONS.ORDER_REFUND)) {
    throw forbidden("You do not have permission to resolve a dispute.");
  }

  const dispute = await getDisputeRow(disputeId);
  assertMayWork(dispute, actor);
  if (isDisputeTerminal(dispute.status)) {
    throw conflict(`Dispute ${dispute.caseNumber} is already closed.`);
  }
  if (!canMoveDispute(dispute.status, "RESOLVED")) {
    throw conflict(`A dispute cannot be resolved from ${dispute.status}.`);
  }

  let refundedPaise: number | null = null;
  let refundAdjustmentId: string | null = null;

  if (outcomeRequiresRefund(input.outcome)) {
    const amount = input.refundPaise;
    if (!Number.isInteger(amount) || !amount || amount <= 0) {
      throw validationFailed("A refund outcome needs a refund amount.");
    }
    if (amount > dispute.disputedAmountPaise) {
      throw validationFailed(
        `At most ${formatPaise(dispute.disputedAmountPaise)} can be refunded — that is what was disputed.`,
      );
    }
    if (input.outcome === "REFUND_FULL" && amount !== dispute.disputedAmountPaise) {
      throw validationFailed("A full refund must be the whole disputed amount; use a partial refund instead.");
    }

    const [order] = await db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, dispute.orderId))
      .limit(1);
    if (!order) throw notFound("Order");

    const adjustment = await refundDeliveredOrder(
      {
        orderNumber: order.orderNumber,
        amountPaise: amount,
        reason: `Dispute ${dispute.caseNumber}: ${notes}`.slice(0, 500),
        chargeTo: input.chargeTo ?? "PLATFORM",
        requestId: `dispute:${dispute.id}:${input.requestId}`,
      },
      actor,
    );
    refundedPaise = amount;
    refundAdjustmentId = adjustment.id;
  } else if (input.refundPaise) {
    throw validationFailed("This outcome does not refund anything — leave the amount empty.");
  }

  return db.transaction(async (tx) => {
    const locked = await lockDispute(tx, disputeId);
    // Re-check under the lock: the refund above ran outside this transaction,
    // so another reviewer could have closed the case in between.
    if (isDisputeTerminal(locked.status)) {
      throw conflict(`Dispute ${locked.caseNumber} was closed while this resolution was being recorded.`);
    }

    const [updated] = await tx
      .update(orderDisputes)
      .set({
        status: "RESOLVED",
        outcome: input.outcome,
        refundedPaise,
        refundAdjustmentId,
        resolutionNotes: notes,
        resolvedBy: actor.id,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(orderDisputes.id, locked.id))
      .returning();

    await appendEvent(tx, {
      disputeId: locked.id,
      fromStatus: locked.status,
      toStatus: "RESOLVED",
      fromLevel: locked.level,
      toLevel: locked.level,
      actor,
      note: notes,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DISPUTE_RESOLVED,
        entityType: "order_dispute",
        entityId: locked.id,
        previousValue: { status: locked.status },
        newValue: {
          status: "RESOLVED",
          outcome: input.outcome,
          refundedPaise,
          refundAdjustmentId,
        },
      },
      tx,
    );

    await notifyRaiser(tx, locked, NOTIFICATION_TYPES.DISPUTE_RESOLVED, {
      caseNumber: locked.caseNumber,
      outcome: refundedPaise ? `${formatPaise(refundedPaise)} has been refunded.` : notes,
    });

    return updated;
  });
}

/**
 * Escalates every live L1 case older than the age threshold.
 *
 * Idempotent by construction: it only selects L1 cases, and escalating moves
 * them to L2, so a second run in the same minute finds nothing. One case
 * failing does not stop the sweep — the others are independent.
 */
export async function runDisputeEscalationSweep(now = new Date()): Promise<{
  considered: number;
  escalated: number;
  failed: number;
}> {
  const rules = await getRule("disputes");
  if (rules.escalateAfterHours <= 0) return { considered: 0, escalated: 0, failed: 0 };

  const cutoff = new Date(now.getTime() - rules.escalateAfterHours * 60 * 60 * 1000);
  const stale = await db
    .select({ id: orderDisputes.id, caseNumber: orderDisputes.caseNumber, createdAt: orderDisputes.createdAt })
    .from(orderDisputes)
    .where(
      and(
        eq(orderDisputes.level, "L1"),
        inArray(orderDisputes.status, LIVE_STATUSES),
        lte(orderDisputes.createdAt, cutoff),
      ),
    )
    .orderBy(orderDisputes.createdAt)
    .limit(200);

  let escalated = 0;
  let failed = 0;
  for (const row of stale) {
    const hours = Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000);
    try {
      await escalateDispute(
        row.id,
        {
          trigger: "AGE",
          note: `Open ${hours} h, past the ${rules.escalateAfterHours} h review limit.`,
        },
        null,
      );
      escalated += 1;
    } catch (error) {
      // A case closed or escalated between the select and the update is not a
      // failure of the sweep; anything else is worth seeing in the logs.
      failed += 1;
      console.error("[disputes] escalation sweep could not escalate", row.caseNumber, error);
    }
  }

  return { considered: stale.length, escalated, failed };
}

/* ------------------------------------------------------------------- reads */

export interface DisputeFilters {
  status?: DisputeStatus;
  level?: DisputeLevel;
  shopId?: string;
  /** Live cases only — what the operations queue wants by default. */
  liveOnly?: boolean;
  limit?: number;
}

export interface DisputeListRow {
  id: string;
  caseNumber: string;
  orderId: string;
  orderNumber: string;
  shopId: string;
  status: DisputeStatus;
  level: DisputeLevel;
  reason: DisputeReason;
  disputedAmountPaise: number;
  paymentMethodSnapshot: "WALLET" | "COD";
  escalatedAt: Date | null;
  escalationTrigger: EscalationTrigger | null;
  raisedByName: string | null;
  createdAt: Date;
}

export async function listDisputes(filters: DisputeFilters = {}): Promise<DisputeListRow[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(orderDisputes.status, filters.status));
  if (filters.level) conditions.push(eq(orderDisputes.level, filters.level));
  if (filters.shopId) conditions.push(eq(orderDisputes.shopId, filters.shopId));
  if (filters.liveOnly) conditions.push(inArray(orderDisputes.status, LIVE_STATUSES));

  return db
    .select({
      id: orderDisputes.id,
      caseNumber: orderDisputes.caseNumber,
      orderId: orderDisputes.orderId,
      orderNumber: orders.orderNumber,
      shopId: orderDisputes.shopId,
      status: orderDisputes.status,
      level: orderDisputes.level,
      reason: orderDisputes.reason,
      disputedAmountPaise: orderDisputes.disputedAmountPaise,
      paymentMethodSnapshot: orderDisputes.paymentMethodSnapshot,
      escalatedAt: orderDisputes.escalatedAt,
      escalationTrigger: orderDisputes.escalationTrigger,
      raisedByName: users.name,
      createdAt: orderDisputes.createdAt,
    })
    .from(orderDisputes)
    .innerJoin(orders, eq(orders.id, orderDisputes.orderId))
    .leftJoin(users, eq(users.id, orderDisputes.raisedByUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Escalated first, then oldest: the queue should open on what is most overdue.
    .orderBy(desc(orderDisputes.level), orderDisputes.createdAt)
    .limit(Math.min(filters.limit ?? 100, 300));
}

/**
 * An event as the customer sees it: when the case moved and to what, without
 * the note. Investigation notes are written for colleagues — "repeat
 * complainant", "shop says otherwise" — and are not the customer's to read.
 */
export type CustomerVisibleEvent = Omit<DisputeEvent, "note" | "actorId" | "actorRole">;

export interface DisputeDetail {
  dispute: OrderDispute;
  orderNumber: string;
  events: DisputeEvent[] | CustomerVisibleEvent[];
  /** False when the caller is the customer: notes and reviewer identities are withheld. */
  internal: boolean;
}

/**
 * One case with its event trail.
 *
 * Staff get the whole thing. The customer who raised it gets the shape of the
 * case — where it is, when it moved — but not the internal notes, nor which
 * member of staff did what. The service drops those fields rather than trusting
 * each caller to omit them.
 */
export async function getDispute(disputeId: string, actor: Actor): Promise<DisputeDetail | null> {
  const [row] = await db
    .select({ dispute: orderDisputes, orderNumber: orders.orderNumber })
    .from(orderDisputes)
    .innerJoin(orders, eq(orders.id, orderDisputes.orderId))
    .where(eq(orderDisputes.id, disputeId))
    .limit(1);
  if (!row) return null;

  if (row.dispute.raisedByUserId !== actor.id && !isStaff(actor.role)) {
    throw forbidden("You do not have access to this dispute.");
  }

  const events = await db
    .select()
    .from(disputeEvents)
    .where(eq(disputeEvents.disputeId, disputeId))
    .orderBy(disputeEvents.createdAt);

  if (isStaff(actor.role)) {
    return { dispute: row.dispute, orderNumber: row.orderNumber, events, internal: true };
  }

  // The customer's own view. `resolutionNotes` stays: it is the answer to their
  // case and `notifyRaiser` already sends them that same text, as grievances do.
  // What goes is `escalationNote` — written about them, for colleagues — and
  // which member of staff handled the case.
  return {
    dispute: {
      ...row.dispute,
      escalationNote: null,
      assignedToUserId: null,
      resolvedBy: null,
    },
    orderNumber: row.orderNumber,
    // Listed field by field rather than omitting `note`: a column added to
    // dispute_events later is then hidden here until somebody decides it is
    // the customer's to read, which is the safe direction for it to fail.
    events: events.map((e) => ({
      id: e.id,
      disputeId: e.disputeId,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      fromLevel: e.fromLevel,
      toLevel: e.toLevel,
      createdAt: e.createdAt,
    })),
    internal: false,
  };
}

/** Live cases on a set of orders, for showing state on an order list. */
export async function getLiveDisputesForOrders(
  orderIds: readonly string[],
): Promise<Map<string, { caseNumber: string; status: DisputeStatus; level: DisputeLevel }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: orderDisputes.orderId,
      caseNumber: orderDisputes.caseNumber,
      status: orderDisputes.status,
      level: orderDisputes.level,
    })
    .from(orderDisputes)
    .where(
      and(inArray(orderDisputes.orderId, [...orderIds]), inArray(orderDisputes.status, LIVE_STATUSES)),
    );
  return new Map(rows.map((r) => [r.orderId, { caseNumber: r.caseNumber, status: r.status, level: r.level }]));
}

export interface DisputeCounts {
  live: number;
  escalated: number;
  /** Escalated and past the resolve target — the number worth alerting on. */
  overdue: number;
}

export async function countDisputes(now = new Date()): Promise<DisputeCounts> {
  const rules = await getRule("disputes");
  const overdueCutoff = new Date(now.getTime() - rules.resolveTargetHours * 60 * 60 * 1000);
  const live = inArray(orderDisputes.status, LIVE_STATUSES);
  const atL2 = eq(orderDisputes.level, "L2");
  // Every comparison goes through a drizzle condition helper, including the
  // timestamp one: a bare `${date}` in a sql template has no column type to be
  // serialised against, and the driver rejects the Date at query time rather
  // than at compile time.
  const overdue = lte(orderDisputes.escalatedAt, overdueCutoff);

  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${live})::int`,
      escalated: sql<number>`count(*) filter (where ${atL2} and ${live})::int`,
      overdue: sql<number>`count(*) filter (where ${atL2} and ${live} and ${overdue})::int`,
    })
    .from(orderDisputes);
  return { live: Number(row?.live ?? 0), escalated: Number(row?.escalated ?? 0), overdue: Number(row?.overdue ?? 0) };
}

/* ----------------------------------------------------------------- helpers */

async function lockDispute(tx: DbClient, disputeId: string): Promise<OrderDispute> {
  const [dispute] = await tx.select().from(orderDisputes).where(eq(orderDisputes.id, disputeId)).for("update");
  if (!dispute) throw notFound("Dispute");
  return dispute;
}

async function getDisputeRow(disputeId: string): Promise<OrderDispute> {
  const [dispute] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, disputeId)).limit(1);
  if (!dispute) throw notFound("Dispute");
  return dispute;
}

async function notifyRaiser(
  tx: DbClient,
  dispute: Pick<OrderDispute, "raisedByUserId">,
  type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES],
  vars: Record<string, string>,
): Promise<void> {
  if (!dispute.raisedByUserId) return;
  await notify({ userId: dispute.raisedByUserId, type, vars, actionUrl: "/orders" }, tx);
}
