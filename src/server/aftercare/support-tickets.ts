/**
 * F6.3.3 (SM-006) — help desk and customer grievance portal.
 *
 * One ticket for customers and shop owners, raised from an order or the
 * /support portal, worked by support at /admin/support:
 *
 *   - state machine: lib/support-ticket-states.ts (registered in
 *     lib/state-machines.ts, so emitEvent checks every move);
 *   - SLA clock fixed at receipt from rule helpdesk (Consumer Protection
 *     (E-Commerce) Rules, 2020, Rule 4: acknowledge within 48 hours, redress
 *     within one month); the hourly help-desk job escalates breaches;
 *   - public replies and internal notes (never shown outside support);
 *   - canned replies (admin keeps the list);
 *   - a 1–5 rating once the ticket is closed;
 *   - every status change notifies the requester, the assignee and — while
 *     support waits for the shop — the shop's owner (catalog.ts).
 *
 * Who may see a ticket: support (SUPPORT_TICKET_MANAGE), the requester, and
 * the owner of the ticket's shop only while it is AWAITING_SHOP. Anyone else
 * gets "not found".
 *
 * Disputes keep their own flow (shop + support); a ticket raised on an order
 * with a live dispute links to it instead of duplicating it. A grievance
 * filed on the statutory form opens a linked ticket (rule
 * helpdesk.ticketForGrievances); the ticket's status is mirrored back onto
 * the grievance so the grievance register stays true.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  canMoveTicket,
  isTicketLive,
  LIVE_TICKET_STATUSES,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUS_LABELS,
  TICKET_TRANSITIONS,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/support-ticket-states";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  grievances,
  orders,
  shops,
  supportCannedReplies,
  supportTicketAttachments,
  supportTicketCsat,
  supportTicketEvents,
  supportTicketMessages,
  supportTickets,
  users,
  type Grievance,
  type GrievanceStatus,
  type SupportCannedReply,
  type SupportTicket,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { detectImage } from "@/server/services/image-store";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getLiveDisputesForOrders } from "@/server/services/disputes";
import { getRule } from "@/server/services/settings";

export interface Actor {
  id: string;
  role: UserRole;
}
type SystemActor = Actor | null;

export type TicketAccess = "STAFF" | "REQUESTER" | "SHOP";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function isSupportStaff(role: UserRole): boolean {
  return can(role, PERMISSIONS.SUPPORT_TICKET_MANAGE);
}

export function formatIst(date: Date): string {
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

const excerpt = (text: string) => (text.length > 140 ? `${text.slice(0, 137)}…` : text);

/* ------------------------------------------------------------- access */

async function shopOwnerOf(shopId: string | null, client: DbClient = db): Promise<string | null> {
  if (!shopId) return null;
  const [shop] = await client.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  return shop?.ownerId ?? null;
}

export async function ticketAccess(ticket: SupportTicket, actor: Actor, client: DbClient = db): Promise<TicketAccess | null> {
  if (isSupportStaff(actor.role)) return "STAFF";
  if (ticket.requesterId && ticket.requesterId === actor.id) return "REQUESTER";
  if (ticket.status === "AWAITING_SHOP" && ticket.shopId && (await shopOwnerOf(ticket.shopId, client)) === actor.id) return "SHOP";
  return null;
}

async function loadForActor(
  tx: DbClient,
  ticketId: string,
  actor: Actor,
  lock = false,
): Promise<{ ticket: SupportTicket; access: TicketAccess }> {
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) throw notFound("Ticket");
  const query = tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  const [ticket] = lock ? await query.for("update") : await query;
  if (!ticket) throw notFound("Ticket");
  const access = await ticketAccess(ticket, actor, tx);
  if (!access) throw notFound("Ticket");
  return { ticket, access };
}

/* ------------------------------------------------------------ helpers */

export interface SlaView {
  acknowledgeBy: Date;
  resolveBy: Date;
  acknowledged: boolean;
  resolved: boolean;
  ackRemainingMs: number | null;
  resolveRemainingMs: number | null;
  ackBreached: boolean;
  resolveBreached: boolean;
}

export function slaFor(ticket: Pick<SupportTicket, "acknowledgeBy" | "resolveBy" | "acknowledgedAt" | "resolvedAt" | "status">, now = new Date()): SlaView {
  const acknowledged = ticket.acknowledgedAt != null;
  const resolved = ticket.resolvedAt != null || ticket.status === "CLOSED";
  return {
    acknowledgeBy: ticket.acknowledgeBy,
    resolveBy: ticket.resolveBy,
    acknowledged,
    resolved,
    ackRemainingMs: acknowledged ? null : ticket.acknowledgeBy.getTime() - now.getTime(),
    resolveRemainingMs: resolved ? null : ticket.resolveBy.getTime() - now.getTime(),
    ackBreached: acknowledged ? ticket.acknowledgedAt!.getTime() > ticket.acknowledgeBy.getTime() : now > ticket.acknowledgeBy,
    resolveBreached: resolved
      ? (ticket.resolvedAt ?? now).getTime() > ticket.resolveBy.getTime()
      : now > ticket.resolveBy,
  };
}

async function appendEvent(
  tx: DbClient,
  ticketId: string,
  input: { kind: string; from?: string | null; to?: string | null; actor: SystemActor; note?: string | null; isPublic?: boolean },
) {
  await tx.insert(supportTicketEvents).values({
    ticketId,
    kind: input.kind,
    fromStatus: input.from ?? null,
    toStatus: input.to ?? null,
    actorId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    note: input.note ?? null,
    public: input.isPublic ?? true,
  });
}

const GRIEVANCE_STATUS_FOR: Record<TicketStatus, GrievanceStatus> = {
  OPEN: "OPEN",
  ACKNOWLEDGED: "IN_PROGRESS",
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_CUSTOMER: "IN_PROGRESS",
  AWAITING_SHOP: "IN_PROGRESS",
  ESCALATED: "IN_PROGRESS",
  REOPENED: "IN_PROGRESS",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
};

/** Keeps the statutory grievance register in step with its linked ticket. */
async function syncGrievance(tx: DbClient, ticket: SupportTicket, to: TicketStatus, note: string | null, actor: SystemActor) {
  if (!ticket.grievanceId) return;
  const [grievance] = await tx.select().from(grievances).where(eq(grievances.id, ticket.grievanceId));
  if (!grievance) return;
  const status = GRIEVANCE_STATUS_FOR[to];
  if (grievance.status === status) return;
  await tx
    .update(grievances)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === "RESOLVED" ? { resolvedAt: new Date(), resolutionNotes: note ?? grievance.resolutionNotes ?? "Resolved through the help desk." } : {}),
      ...(ticket.assignedToUserId ? { assignedToUserId: ticket.assignedToUserId } : {}),
    })
    .where(eq(grievances.id, grievance.id));
  await recordAudit(
    {
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.GRIEVANCE_UPDATED,
      entityType: "grievance",
      entityId: grievance.id,
      previousValue: { status: grievance.status },
      newValue: { status, viaTicket: ticket.ticketNumber },
    },
    tx,
  );
}

/**
 * The one way a ticket's status changes: checked against the state machine,
 * timestamped, logged, mirrored to a linked grievance and announced.
 */
async function moveTicket(
  tx: DbClient,
  ticket: SupportTicket,
  to: TicketStatus,
  actor: SystemActor,
  note: string | null,
): Promise<SupportTicket> {
  const from = ticket.status as TicketStatus;
  if (!canMoveTicket(from, to)) {
    throw conflict(`A ticket that is ${TICKET_STATUS_LABELS[from].toLowerCase()} cannot be moved to ${TICKET_STATUS_LABELS[to].toLowerCase()}.`);
  }
  const now = new Date();
  const patch: Partial<typeof supportTickets.$inferInsert> = { status: to, updatedAt: now };
  if (!ticket.acknowledgedAt && to !== "OPEN") patch.acknowledgedAt = now;
  if (to === "RESOLVED") {
    patch.resolvedAt = now;
    patch.resolutionNote = note ?? ticket.resolutionNote;
  }
  if (to === "CLOSED") patch.closedAt = now;
  if (to === "REOPENED") {
    patch.reopenCount = ticket.reopenCount + 1;
    patch.resolvedAt = null;
  }
  if (to === "ESCALATED") {
    patch.escalationLevel = ticket.escalationLevel + 1;
    patch.escalatedAt = now;
  }
  const [updated] = await tx.update(supportTickets).set(patch).where(eq(supportTickets.id, ticket.id)).returning();
  await appendEvent(tx, ticket.id, { kind: "STATUS", from, to, actor, note });
  await syncGrievance(tx, updated, to, note, actor);
  await recordAudit(
    {
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.SUPPORT_TICKET_UPDATED,
      entityType: "support_ticket",
      entityId: ticket.id,
      previousValue: { status: from },
      newValue: { status: to, note },
    },
    tx,
  );
  const [order] = updated.orderId
    ? await tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, updated.orderId))
    : [];
  const csat = to === "CLOSED" && (await getRule("helpdesk")).csatEnabled && updated.requesterId != null;
  await emitEvent(
    {
      type: "support_ticket.status_changed",
      subjectId: ticket.id,
      transition: { from, to },
      actor: actor ?? { id: null, role: null },
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: to,
        statusLabel: TICKET_STATUS_LABELS[to],
        note,
        requesterId: updated.requesterId,
        assigneeId: updated.assignedToUserId,
        shopOwnerId: to === "AWAITING_SHOP" ? await shopOwnerOf(updated.shopId, tx) : null,
        orderNumber: order?.orderNumber ?? null,
        csat,
      },
    },
    tx,
  );
  return updated;
}

/* ------------------------------------------------------------- raising */

export interface CreateTicketInput {
  category: TicketCategory;
  subject: string;
  description: string;
  orderId?: string | null;
  /** Shop owners raising a ticket about their shop (not an order). */
  shopId?: string | null;
  priority?: TicketPriority;
}

function validateTicketInput(input: CreateTicketInput) {
  const fields: Record<string, string> = {};
  if (!TICKET_CATEGORIES.includes(input.category)) fields.category = "Choose what the ticket is about.";
  if (input.subject.trim().length < 3) fields.subject = "Enter a subject.";
  if (input.subject.trim().length > 200) fields.subject = "Keep the subject under 200 characters.";
  if (input.description.trim().length < 10) fields.description = "Describe the problem in a bit more detail.";
  if (input.description.trim().length > 5000) fields.description = "Keep the description under 5000 characters.";
  if (input.priority && !TICKET_PRIORITIES.includes(input.priority)) fields.priority = "Unknown priority.";
  if (Object.keys(fields).length) throw validationFailed("Please check the highlighted fields.", { fields });
}

async function slaDeadlines(receivedAt: Date) {
  const rule = await getRule("helpdesk");
  return {
    acknowledgeBy: new Date(receivedAt.getTime() + rule.acknowledgeWithinHours * HOUR),
    resolveBy: new Date(receivedAt.getTime() + rule.resolveWithinDays * DAY),
  };
}

async function announceCreated(tx: DbClient, ticket: SupportTicket, actor: SystemActor, requesterLabel: string, fromGrievance = false) {
  await emitEvent(
    {
      type: "support_ticket.created",
      subjectId: ticket.id,
      transition: { from: null, to: "OPEN" },
      actor: actor ?? { id: null, role: null },
      idempotencyKey: `support_ticket:${ticket.id}:created`,
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        categoryLabel: TICKET_CATEGORY_LABELS[ticket.category as TicketCategory] ?? ticket.category,
        requesterId: ticket.requesterId,
        requesterLabel,
        acknowledgeByLabel: formatIst(ticket.acknowledgeBy),
        resolveByLabel: formatIst(ticket.resolveBy),
        fromGrievance,
      },
    },
    tx,
  );
}

/** A customer or shop owner raises a ticket (optionally about one of their orders). */
export async function createTicket(input: CreateTicketInput, actor: Actor): Promise<SupportTicket> {
  if (!can(actor.role, PERMISSIONS.SUPPORT_TICKET_RAISE)) throw forbidden("You cannot raise support tickets.");
  const rule = await getRule("helpdesk");
  if (!rule.enabled) throw conflict("The help desk is not available right now. Please use the complaint form.");
  validateTicketInput(input);

  let shopId: string | null = null;
  let orderId: string | null = null;
  let disputeId: string | null = null;
  let requesterRole: string = actor.role;
  if (input.orderId) {
    const [row] = await db
      .select({ id: orders.id, userId: orders.userId, shopId: orders.shopId, ownerId: shops.ownerId })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, input.orderId));
    // Only the order's buyer or its shop's owner may raise a ticket on it.
    if (!row || (row.userId !== actor.id && row.ownerId !== actor.id)) throw notFound("Order");
    orderId = row.id;
    shopId = row.shopId;
    requesterRole = row.userId === actor.id ? "CUSTOMER" : "SHOP_OWNER";
    const live = await getLiveDisputesForOrders([row.id]);
    disputeId = live.get(row.id)?.id ?? null;
  } else if (input.shopId) {
    const owner = await shopOwnerOf(input.shopId);
    if (owner !== actor.id) throw notFound("Shop");
    shopId = input.shopId;
    requesterRole = "SHOP_OWNER";
  }

  const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, actor.id));
  const now = new Date();
  const { acknowledgeBy, resolveBy } = await slaDeadlines(now);
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .insert(supportTickets)
      .values({
        requesterId: actor.id,
        requesterRole,
        requesterName: user?.name ?? null,
        requesterEmail: user?.email ?? null,
        orderId,
        shopId,
        disputeId,
        category: input.category,
        subject: input.subject.trim(),
        description: input.description.trim(),
        priority: input.priority ?? "NORMAL",
        acknowledgeBy,
        resolveBy,
        createdAt: now,
      })
      .returning();
    await appendEvent(tx, ticket.id, { kind: "CREATED", to: "OPEN", actor, note: disputeId ? "Linked to the order's open dispute." : null });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SUPPORT_TICKET_CREATED,
        entityType: "support_ticket",
        entityId: ticket.id,
        newValue: { ticketNumber: ticket.ticketNumber, category: ticket.category, orderId, shopId },
      },
      tx,
    );
    await announceCreated(tx, ticket, actor, user?.name ?? user?.email ?? "a user");
    return ticket;
  });
}

/**
 * The statutory grievance form also opens a ticket (rule
 * helpdesk.ticketForGrievances), keeping the GRV- number in the subject.
 * Never throws: the grievance is already filed whatever happens here.
 */
export async function mirrorGrievanceToTicket(grievance: Grievance): Promise<SupportTicket | null> {
  try {
    const rule = await getRule("helpdesk");
    if (!rule.enabled || !rule.ticketForGrievances) return null;
    const [existing] = await db.select().from(supportTickets).where(eq(supportTickets.grievanceId, grievance.id));
    if (existing) return existing;
    const order = grievance.orderId ? await db.query.orders.findFirst({ where: eq(orders.id, grievance.orderId) }) : null;
    const { acknowledgeBy, resolveBy } = await slaDeadlines(grievance.createdAt);
    return await db.transaction(async (tx) => {
      const [ticket] = await tx
        .insert(supportTickets)
        .values({
          requesterId: grievance.submittedByUserId,
          requesterRole: "CUSTOMER",
          requesterName: grievance.name,
          requesterEmail: grievance.email,
          orderId: order?.id ?? null,
          shopId: order?.shopId ?? null,
          grievanceId: grievance.id,
          category: "GRIEVANCE",
          subject: `${grievance.ticketNumber}: ${grievance.subject}`.slice(0, 200),
          description: grievance.description,
          acknowledgeBy,
          resolveBy,
          createdAt: grievance.createdAt,
        })
        .returning();
      await appendEvent(tx, ticket.id, { kind: "CREATED", to: "OPEN", actor: null, note: `Opened from grievance ${grievance.ticketNumber}.` });
      await announceCreated(tx, ticket, null, grievance.name, true);
      return ticket;
    });
  } catch (error) {
    console.error("[helpdesk] could not open a ticket for grievance", grievance.ticketNumber, error);
    return null;
  }
}

/* ------------------------------------------------------------- reading */

export interface TicketListRow {
  id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: TicketStatus;
  priority: string;
  requesterLabel: string | null;
  orderNumber: string | null;
  assigneeName: string | null;
  createdAt: Date;
  updatedAt: Date;
  sla: SlaView;
  escalationLevel: number;
}

const assignee = users;

async function listRows(where: SQL | undefined, limit = 200): Promise<TicketListRow[]> {
  const rows = await db
    .select({ ticket: supportTickets, orderNumber: orders.orderNumber, assigneeName: assignee.name, assigneeEmail: assignee.email })
    .from(supportTickets)
    .leftJoin(orders, eq(orders.id, supportTickets.orderId))
    .leftJoin(assignee, eq(assignee.id, supportTickets.assignedToUserId))
    .where(where)
    .orderBy(desc(supportTickets.updatedAt))
    .limit(limit);
  const now = new Date();
  return rows.map(({ ticket, orderNumber, assigneeName, assigneeEmail }) => ({
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status as TicketStatus,
    priority: ticket.priority,
    requesterLabel: ticket.requesterName ?? ticket.requesterEmail,
    orderNumber: orderNumber ?? null,
    assigneeName: assigneeName ?? assigneeEmail ?? null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    sla: slaFor(ticket, now),
    escalationLevel: ticket.escalationLevel,
  }));
}

/** "My tickets" in the portal. */
export async function listMyTickets(actor: Actor): Promise<TicketListRow[]> {
  return listRows(eq(supportTickets.requesterId, actor.id));
}

/** The shop owner's queue: tickets about their shops' orders that wait for the shop. */
export async function listShopTickets(actor: Actor): Promise<TicketListRow[]> {
  const owned = await db.select({ id: shops.id }).from(shops).where(eq(shops.ownerId, actor.id));
  if (owned.length === 0) return [];
  return listRows(
    and(
      inArray(supportTickets.shopId, owned.map((s) => s.id)),
      eq(supportTickets.status, "AWAITING_SHOP"),
    ),
  );
}

export type QueueKey = "open" | "unassigned" | "mine" | "breached" | "escalated" | "awaiting" | "resolved" | "all";

export interface QueueFilters {
  queue?: QueueKey;
  status?: TicketStatus;
  category?: TicketCategory;
  search?: string;
}

/** The support console's queues. Staff only. */
export async function listTicketQueue(actor: Actor, filters: QueueFilters = {}): Promise<TicketListRow[]> {
  if (!isSupportStaff(actor.role)) throw forbidden("Only support can see the ticket queues.");
  const now = new Date();
  const live = inArray(supportTickets.status, [...LIVE_TICKET_STATUSES]);
  const conditions: SQL[] = [];
  switch (filters.queue ?? "open") {
    case "open":
      conditions.push(live);
      break;
    case "unassigned":
      conditions.push(live, isNull(supportTickets.assignedToUserId));
      break;
    case "mine":
      conditions.push(live, eq(supportTickets.assignedToUserId, actor.id));
      break;
    case "breached":
      conditions.push(
        live,
        or(
          and(isNull(supportTickets.acknowledgedAt), lt(supportTickets.acknowledgeBy, now)),
          lt(supportTickets.resolveBy, now),
          // Stamped by the SLA job (a late acknowledgement does not undo a breach).
          isNotNull(supportTickets.ackBreachedAt),
          isNotNull(supportTickets.resolveBreachedAt),
        )!,
      );
      break;
    case "escalated":
      conditions.push(eq(supportTickets.status, "ESCALATED"));
      break;
    case "awaiting":
      conditions.push(inArray(supportTickets.status, ["AWAITING_CUSTOMER", "AWAITING_SHOP"]));
      break;
    case "resolved":
      conditions.push(inArray(supportTickets.status, ["RESOLVED", "CLOSED"]));
      break;
    case "all":
      break;
  }
  if (filters.status) conditions.push(eq(supportTickets.status, filters.status));
  if (filters.category) conditions.push(eq(supportTickets.category, filters.category));
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${supportTickets.ticketNumber} ILIKE ${term}`,
        sql`${supportTickets.subject} ILIKE ${term}`,
        sql`coalesce(${supportTickets.requesterEmail}, '') ILIKE ${term}`,
      )!,
    );
  }
  return listRows(conditions.length ? and(...conditions) : undefined);
}

export async function queueCounts(actor: Actor): Promise<Record<QueueKey, number>> {
  const keys: QueueKey[] = ["open", "unassigned", "mine", "breached", "escalated", "awaiting", "resolved", "all"];
  const entries = await Promise.all(keys.map(async (k) => [k, (await listTicketQueue(actor, { queue: k })).length] as const));
  return Object.fromEntries(entries) as Record<QueueKey, number>;
}

export interface TicketDetail {
  ticket: SupportTicket;
  access: TicketAccess;
  statusLabel: string;
  categoryLabel: string;
  orderNumber: string | null;
  disputeId: string | null;
  grievanceNumber: string | null;
  assigneeName: string | null;
  sla: SlaView;
  messages: {
    id: string;
    authorKind: string;
    authorLabel: string;
    body: string;
    internal: boolean;
    createdAt: Date;
  }[];
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number; internal: boolean; createdAt: Date }[];
  events: { kind: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: Date }[];
  csat: { rating: number; comment: string | null } | null;
  /** What this viewer may do next. */
  can: {
    reply: boolean;
    close: boolean;
    reopen: boolean;
    rate: boolean;
    manage: boolean;
    nextStatuses: TicketStatus[];
  };
}

export async function getTicketDetail(ticketId: string, actor: Actor): Promise<TicketDetail> {
  const { ticket, access } = await loadForActor(db, ticketId, actor);
  const staff = access === "STAFF";
  const [messages, files, events, [csat], [order], [assigneeRow], [grievance]] = await Promise.all([
    db
      .select({ m: supportTicketMessages, name: users.name, email: users.email })
      .from(supportTicketMessages)
      .leftJoin(users, eq(users.id, supportTicketMessages.authorId))
      .where(eq(supportTicketMessages.ticketId, ticket.id))
      .orderBy(asc(supportTicketMessages.createdAt)),
    db
      .select({
        id: supportTicketAttachments.id,
        fileName: supportTicketAttachments.fileName,
        contentType: supportTicketAttachments.contentType,
        sizeBytes: supportTicketAttachments.sizeBytes,
        internal: supportTicketAttachments.internal,
        createdAt: supportTicketAttachments.createdAt,
      })
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticket.id))
      .orderBy(asc(supportTicketAttachments.createdAt)),
    db.select().from(supportTicketEvents).where(eq(supportTicketEvents.ticketId, ticket.id)).orderBy(asc(supportTicketEvents.createdAt)),
    db.select().from(supportTicketCsat).where(eq(supportTicketCsat.ticketId, ticket.id)),
    ticket.orderId ? db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, ticket.orderId)) : Promise.resolve([]),
    ticket.assignedToUserId
      ? db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, ticket.assignedToUserId))
      : Promise.resolve([]),
    ticket.grievanceId
      ? db.select({ ticketNumber: grievances.ticketNumber }).from(grievances).where(eq(grievances.id, ticket.grievanceId))
      : Promise.resolve([]),
  ]);
  const rule = await getRule("helpdesk");
  const status = ticket.status as TicketStatus;
  const reopenOpen =
    status === "RESOLVED" && ticket.resolvedAt != null && Date.now() - ticket.resolvedAt.getTime() <= rule.reopenWithinDays * DAY;
  return {
    ticket,
    access,
    statusLabel: TICKET_STATUS_LABELS[status],
    categoryLabel: TICKET_CATEGORY_LABELS[ticket.category as TicketCategory] ?? ticket.category,
    orderNumber: order?.orderNumber ?? null,
    disputeId: ticket.disputeId,
    grievanceNumber: grievance?.ticketNumber ?? null,
    assigneeName: staff ? (assigneeRow?.name ?? assigneeRow?.email ?? null) : null,
    sla: slaFor(ticket),
    // Internal notes and staff-only files never leave support.
    messages: messages
      .filter(({ m }) => staff || !m.internal)
      .map(({ m, name, email }) => ({
        id: m.id,
        authorKind: m.authorKind,
        authorLabel:
          m.authorKind === "STAFF" ? (staff ? (name ?? email ?? "Support") : "GoKesari support") : m.authorKind === "SHOP" ? "The shop" : (name ?? "Customer"),
        body: m.body,
        internal: m.internal,
        createdAt: m.createdAt,
      })),
    attachments: files.filter((f) => staff || !f.internal),
    events: events
      .filter((e) => staff || e.public)
      .map((e) => ({ kind: e.kind, fromStatus: e.fromStatus, toStatus: e.toStatus, note: e.note, createdAt: e.createdAt })),
    csat: csat ? { rating: csat.rating, comment: csat.comment } : null,
    can: {
      reply: access === "SHOP" ? status === "AWAITING_SHOP" : status !== "CLOSED" && (staff || status !== "RESOLVED"),
      close: access === "REQUESTER" && status === "RESOLVED",
      reopen: access === "REQUESTER" && reopenOpen,
      rate: access === "REQUESTER" && status === "CLOSED" && rule.csatEnabled && !csat,
      manage: staff,
      nextStatuses: staff ? [...TICKET_TRANSITIONS[status]] : [],
    },
  };
}

/* ---------------------------------------------------------- working it */

/** Status change by support (any legal move) or by the requester (close / reopen a resolved ticket). */
export async function changeTicketStatus(ticketId: string, to: TicketStatus, actor: Actor, note?: string | null): Promise<SupportTicket> {
  return db.transaction(async (tx) => {
    const { ticket, access } = await loadForActor(tx, ticketId, actor, true);
    const trimmed = note?.trim() || null;
    if (access === "STAFF") {
      if (to === "RESOLVED" && !trimmed && !ticket.resolutionNote) throw validationFailed("Say how the ticket was resolved.");
      return moveTicket(tx, ticket, to, actor, trimmed);
    }
    if (access === "REQUESTER") {
      if (ticket.status !== "RESOLVED" || (to !== "CLOSED" && to !== "REOPENED")) {
        throw forbidden("You can close or reopen your ticket once it is resolved.");
      }
      if (to === "REOPENED") {
        const { reopenWithinDays } = await getRule("helpdesk");
        if (!ticket.resolvedAt || Date.now() - ticket.resolvedAt.getTime() > reopenWithinDays * DAY) {
          throw conflict(`A ticket can be reopened within ${reopenWithinDays} days of being resolved. Please raise a new ticket.`);
        }
        if (!trimmed) throw validationFailed("Tell us why the problem is not solved.");
      }
      return moveTicket(tx, ticket, to, actor, trimmed);
    }
    throw forbidden("The shop replies to a ticket; support changes its status.");
  });
}

export async function assignTicket(ticketId: string, assigneeId: string | null, actor: Actor): Promise<SupportTicket> {
  if (!isSupportStaff(actor.role)) throw notFound("Ticket");
  return db.transaction(async (tx) => {
    const { ticket } = await loadForActor(tx, ticketId, actor, true);
    if (assigneeId) {
      const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, assigneeId));
      if (!user || !isSupportStaff(user.role)) throw validationFailed("Assign the ticket to an operator or administrator.");
    }
    let [updated] = await tx
      .update(supportTickets)
      .set({ assignedToUserId: assigneeId, updatedAt: new Date() })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    await appendEvent(tx, ticket.id, { kind: "ASSIGNED", actor, note: assigneeId ? `Assigned` : "Unassigned", isPublic: false });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SUPPORT_TICKET_UPDATED,
        entityType: "support_ticket",
        entityId: ticket.id,
        previousValue: { assignedToUserId: ticket.assignedToUserId },
        newValue: { assignedToUserId: assigneeId },
      },
      tx,
    );
    if (assigneeId) {
      await emitEvent(
        {
          type: "support_ticket.assigned",
          subjectId: ticket.id,
          actor,
          payload: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, assigneeId, resolveByLabel: formatIst(ticket.resolveBy) },
        },
        tx,
      );
      // Taking a ticket on acknowledges it.
      if (updated.status === "OPEN" || updated.status === "REOPENED") {
        updated = await moveTicket(tx, updated, "ACKNOWLEDGED", actor, null);
      }
    }
    return updated;
  });
}

async function escalate(tx: DbClient, ticket: SupportTicket, actor: SystemActor, why: string): Promise<SupportTicket> {
  const updated = ticket.status === "ESCALATED" ? ticket : await moveTicket(tx, ticket, "ESCALATED", actor, why);
  await emitEvent(
    {
      type: "support_ticket.escalated",
      subjectId: ticket.id,
      actor: actor ?? { id: null, role: null },
      payload: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, why, assigneeId: updated.assignedToUserId },
    },
    tx,
  );
  return updated;
}

/** Manual escalation by support. */
export async function escalateTicket(ticketId: string, actor: Actor, why: string): Promise<SupportTicket> {
  if (!isSupportStaff(actor.role)) throw notFound("Ticket");
  if (why.trim().length < 3) throw validationFailed("Say why the ticket is escalated.");
  return db.transaction(async (tx) => {
    const { ticket } = await loadForActor(tx, ticketId, actor, true);
    if (!canMoveTicket(ticket.status as TicketStatus, "ESCALATED")) {
      throw conflict(`A ${TICKET_STATUS_LABELS[ticket.status as TicketStatus].toLowerCase()} ticket cannot be escalated.`);
    }
    return escalate(tx, ticket, actor, why.trim());
  });
}

/** Fills {{ticketNumber}}, {{name}} and {{orderNumber}} in a canned reply. */
export function renderCannedReply(body: string, vars: { ticketNumber: string; name?: string | null; orderNumber?: string | null }): string {
  return body
    .replace(/\{\{\s*ticketNumber\s*\}\}/g, vars.ticketNumber)
    .replace(/\{\{\s*name\s*\}\}/g, vars.name?.trim() || "there")
    .replace(/\{\{\s*orderNumber\s*\}\}/g, vars.orderNumber ?? "your order");
}

export interface ReplyInput {
  body?: string | null;
  /** Staff only: a note the requester and the shop never see. */
  internal?: boolean;
  /** Staff only: insert this canned reply (its text comes first). */
  cannedReplyId?: string | null;
  /** Staff only: the status to move to with this reply (e.g. AWAITING_CUSTOMER). */
  thenStatus?: TicketStatus | null;
}

/**
 * A reply or an internal note. A requester's reply puts a ticket that waited
 * for them back to work; a shop's reply hands it back to support; support's
 * first public reply acknowledges it.
 */
export async function replyToTicket(ticketId: string, actor: Actor, input: ReplyInput) {
  return db.transaction(async (tx) => {
    const { ticket, access } = await loadForActor(tx, ticketId, actor, true);
    const status = ticket.status as TicketStatus;
    const staff = access === "STAFF";
    if ((input.internal || input.cannedReplyId || input.thenStatus) && !staff) throw forbidden("Only support can do that.");
    if (status === "CLOSED") throw conflict("This ticket is closed. Please raise a new ticket.");
    if (access === "REQUESTER" && status === "RESOLVED") throw conflict("This ticket is resolved — reopen it if the problem is not solved.");
    if (access === "SHOP" && status !== "AWAITING_SHOP") throw notFound("Ticket");

    let body = input.body?.trim() ?? "";
    let cannedReplyId: string | null = null;
    if (input.cannedReplyId) {
      const [canned] = await tx.select().from(supportCannedReplies).where(eq(supportCannedReplies.id, input.cannedReplyId));
      if (!canned || !canned.active) throw notFound("Canned reply");
      const [order] = ticket.orderId ? await tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, ticket.orderId)) : [];
      const rendered = renderCannedReply(canned.body, { ticketNumber: ticket.ticketNumber, name: ticket.requesterName, orderNumber: order?.orderNumber });
      body = body ? `${rendered}\n\n${body}` : rendered;
      cannedReplyId = canned.id;
    }
    if (body.length < 2) throw validationFailed("Write a reply.");
    if (body.length > 5000) throw validationFailed("Keep the reply under 5000 characters.");

    const authorKind = staff ? "STAFF" : access === "SHOP" ? "SHOP" : "REQUESTER";
    const [message] = await tx
      .insert(supportTicketMessages)
      .values({ ticketId: ticket.id, authorId: actor.id, authorKind, body, internal: Boolean(input.internal), cannedReplyId })
      .returning();
    await appendEvent(tx, ticket.id, {
      kind: input.internal ? "NOTE" : "REPLY",
      actor,
      note: input.internal ? "Internal note added" : `${authorKind === "STAFF" ? "Support" : authorKind === "SHOP" ? "The shop" : "The requester"} replied`,
      isPublic: !input.internal,
    });

    let current = (await tx.select().from(supportTickets).where(eq(supportTickets.id, ticket.id)))[0];
    await tx.update(supportTickets).set({ updatedAt: new Date() }).where(eq(supportTickets.id, ticket.id));
    if (!input.internal) {
      const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
      await emitEvent(
        {
          type: "support_ticket.replied",
          subjectId: ticket.id,
          actor,
          payload: {
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            authorLabel: authorKind === "STAFF" ? "GoKesari support" : authorKind === "SHOP" ? "The shop" : (author?.name ?? "The customer"),
            excerpt: excerpt(body),
            authorKind,
            requesterId: ticket.requesterId,
            assigneeId: ticket.assignedToUserId,
            shopOwnerId: status === "AWAITING_SHOP" ? await shopOwnerOf(ticket.shopId, tx) : null,
          },
        },
        tx,
      );
      if (authorKind === "REQUESTER" && status === "AWAITING_CUSTOMER") current = await moveTicket(tx, current, "IN_PROGRESS", actor, "The requester replied.");
      if (authorKind === "SHOP") current = await moveTicket(tx, current, "IN_PROGRESS", actor, "The shop replied.");
      if (authorKind === "STAFF" && !input.thenStatus && (status === "OPEN" || status === "REOPENED")) {
        current = await moveTicket(tx, current, "IN_PROGRESS", actor, null);
      }
    }
    if (staff && input.thenStatus && input.thenStatus !== current.status) {
      current = await moveTicket(tx, current, input.thenStatus, actor, input.thenStatus === "RESOLVED" ? body : null);
    }
    return { message, ticket: current };
  });
}

/* ---------------------------------------------------------- attachments */

function detectFile(bytes: Buffer): string | null {
  const image = detectImage(bytes);
  if (image) return image.contentType;
  if (bytes.length > 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export async function addTicketAttachment(
  ticketId: string,
  actor: Actor,
  file: { name: string; bytes: Buffer },
  options: { internal?: boolean; messageId?: string | null } = {},
) {
  const rule = await getRule("helpdesk");
  return db.transaction(async (tx) => {
    const { ticket, access } = await loadForActor(tx, ticketId, actor, true);
    if (options.internal && access !== "STAFF") throw forbidden("Only support can add staff-only files.");
    if (ticket.status === "CLOSED") throw conflict("This ticket is closed.");
    if (file.bytes.length === 0) throw validationFailed("The file is empty.");
    if (file.bytes.length > rule.maxAttachmentBytes) {
      throw validationFailed(`Files can be at most ${(rule.maxAttachmentBytes / 1_000_000).toFixed(1)} MB.`);
    }
    const contentType = detectFile(file.bytes);
    if (!contentType) throw validationFailed("Attach a photo (JPEG, PNG or WebP) or a PDF.");
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticket.id));
    if (count >= rule.maxAttachmentsPerTicket) throw conflict(`A ticket can have at most ${rule.maxAttachmentsPerTicket} files.`);
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const [row] = await tx
      .insert(supportTicketAttachments)
      .values({
        ticketId: ticket.id,
        messageId: options.messageId ?? null,
        uploadedBy: actor.id,
        fileName: safeName,
        contentType,
        sizeBytes: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        internal: Boolean(options.internal),
        data: file.bytes,
      })
      .returning({ id: supportTicketAttachments.id, fileName: supportTicketAttachments.fileName, contentType: supportTicketAttachments.contentType });
    await appendEvent(tx, ticket.id, { kind: "ATTACHMENT", actor, note: `File added: ${safeName}`, isPublic: !options.internal });
    return row;
  });
}

export async function readTicketAttachment(ticketId: string, attachmentId: string, actor: Actor) {
  const { access } = await loadForActor(db, ticketId, actor);
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw notFound("File");
  const [file] = await db
    .select()
    .from(supportTicketAttachments)
    .where(and(eq(supportTicketAttachments.id, attachmentId), eq(supportTicketAttachments.ticketId, ticketId)));
  if (!file || (file.internal && access !== "STAFF")) throw notFound("File");
  return file;
}

/* ------------------------------------------------------------------ CSAT */

export async function submitCsat(ticketId: string, actor: Actor, input: { rating: number; comment?: string | null }) {
  const rule = await getRule("helpdesk");
  if (!rule.csatEnabled) throw conflict("Ratings are not being collected right now.");
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw validationFailed("Rate from 1 to 5.");
  return db.transaction(async (tx) => {
    const { ticket, access } = await loadForActor(tx, ticketId, actor, true);
    if (access !== "REQUESTER") throw forbidden("Only the person who raised the ticket can rate it.");
    if (ticket.status !== "CLOSED") throw conflict("You can rate the help you got once the ticket is closed.");
    const [row] = await tx
      .insert(supportTicketCsat)
      .values({ ticketId: ticket.id, rating: input.rating, comment: input.comment?.trim().slice(0, 1000) || null, createdBy: actor.id })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict("You have already rated this ticket.");
    await appendEvent(tx, ticket.id, { kind: "CSAT", actor, note: `Rated ${input.rating}/5`, isPublic: true });
    return row;
  });
}

/* -------------------------------------------------------- canned replies */

function assertCannedManager(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE)) throw forbidden("Only an administrator can change canned replies.");
}

export async function listCannedReplies(actor: Actor, options: { includeInactive?: boolean } = {}): Promise<SupportCannedReply[]> {
  if (!isSupportStaff(actor.role)) throw forbidden("Only support can use canned replies.");
  return db
    .select()
    .from(supportCannedReplies)
    .where(options.includeInactive ? undefined : eq(supportCannedReplies.active, true))
    .orderBy(asc(supportCannedReplies.title));
}

export interface CannedReplyInput {
  title: string;
  body: string;
  category?: string | null;
  active?: boolean;
}

function validateCanned(input: CannedReplyInput) {
  if (input.title.trim().length < 2 || input.title.trim().length > 120) throw validationFailed("Give the canned reply a short title.");
  if (input.body.trim().length < 5 || input.body.trim().length > 5000) throw validationFailed("Write the reply text (5–5000 characters).");
}

export async function createCannedReply(input: CannedReplyInput, actor: Actor): Promise<SupportCannedReply> {
  assertCannedManager(actor);
  validateCanned(input);
  const [row] = await db
    .insert(supportCannedReplies)
    .values({ title: input.title.trim(), body: input.body.trim(), category: input.category ?? null, active: input.active ?? true, createdBy: actor.id, updatedBy: actor.id })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_CANNED_REPLY_CHANGED, entityType: "support_canned_reply", entityId: row.id, newValue: { title: row.title } });
  return row;
}

export async function updateCannedReply(id: string, input: CannedReplyInput, actor: Actor): Promise<SupportCannedReply> {
  assertCannedManager(actor);
  validateCanned(input);
  const [row] = await db
    .update(supportCannedReplies)
    .set({ title: input.title.trim(), body: input.body.trim(), category: input.category ?? null, active: input.active ?? true, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(supportCannedReplies.id, id))
    .returning();
  if (!row) throw notFound("Canned reply");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_CANNED_REPLY_CHANGED, entityType: "support_canned_reply", entityId: id, newValue: { title: row.title, active: row.active } });
  return row;
}

/** Retires a canned reply (kept for the history of messages that used it). */
export async function deleteCannedReply(id: string, actor: Actor): Promise<void> {
  assertCannedManager(actor);
  const [row] = await db.update(supportCannedReplies).set({ active: false, updatedBy: actor.id, updatedAt: new Date() }).where(eq(supportCannedReplies.id, id)).returning();
  if (!row) throw notFound("Canned reply");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_CANNED_REPLY_CHANGED, entityType: "support_canned_reply", entityId: id, newValue: { retired: true } });
}

/** Operators and admins a ticket can be assigned to. */
export async function listAssignableStaff(): Promise<{ id: string; label: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(inArray(users.role, ["OPERATOR", "ADMIN"]))
    .orderBy(asc(users.name))
    .limit(200);
  return rows.map((u) => ({ id: u.id, label: `${u.name ?? u.email} (${u.role === "ADMIN" ? "admin" : "operator"})` }));
}

/* ------------------------------------------------------------- SLA job */

/**
 * The hourly help-desk job: escalates live tickets that missed the
 * acknowledgement or resolution deadline (rule helpdesk.escalateOnBreach),
 * stamping each breach once, and closes resolved tickets nobody reopened
 * within autoCloseResolvedAfterDays. Idempotent.
 */
export async function runHelpdeskSlaSweep(now = new Date()): Promise<{ ackBreaches: number; resolveBreaches: number; escalated: number; autoClosed: number }> {
  const rule = await getRule("helpdesk");
  const live = inArray(supportTickets.status, [...LIVE_TICKET_STATUSES]);
  const candidates = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        live,
        or(
          and(isNull(supportTickets.acknowledgedAt), isNull(supportTickets.ackBreachedAt), lt(supportTickets.acknowledgeBy, now)),
          and(isNull(supportTickets.resolveBreachedAt), lt(supportTickets.resolveBy, now)),
        ),
      ),
    )
    .limit(500);
  let ackBreaches = 0;
  let resolveBreaches = 0;
  let escalated = 0;
  for (const { id } of candidates) {
    try {
      await db.transaction(async (tx) => {
        const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).for("update");
        if (!ticket || !isTicketLive(ticket.status)) return;
        const reasons: string[] = [];
        const patch: Partial<typeof supportTickets.$inferInsert> = {};
        if (!ticket.acknowledgedAt && !ticket.ackBreachedAt && ticket.acknowledgeBy < now) {
          patch.ackBreachedAt = now;
          reasons.push(`not acknowledged within ${rule.acknowledgeWithinHours} hours`);
          ackBreaches += 1;
        }
        if (!ticket.resolveBreachedAt && ticket.resolveBy < now) {
          patch.resolveBreachedAt = now;
          reasons.push(`not resolved within ${rule.resolveWithinDays} days`);
          resolveBreaches += 1;
        }
        if (reasons.length === 0) return;
        const [stamped] = await tx.update(supportTickets).set(patch).where(eq(supportTickets.id, id)).returning();
        const why = `SLA breached: ${reasons.join(" and ")} (Consumer Protection (E-Commerce) Rules, 2020, Rule 4).`;
        await appendEvent(tx, id, { kind: "SLA_BREACH", actor: null, note: why, isPublic: false });
        if (rule.escalateOnBreach && (stamped.status === "ESCALATED" || canMoveTicket(stamped.status as TicketStatus, "ESCALATED"))) {
          await escalate(tx, stamped, null, why);
          escalated += 1;
        }
      });
    } catch (error) {
      console.error("[helpdesk] SLA sweep failed for ticket", id, error);
    }
  }

  const closeBefore = new Date(now.getTime() - rule.autoCloseResolvedAfterDays * DAY);
  const resolved = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(eq(supportTickets.status, "RESOLVED"), lt(supportTickets.resolvedAt, closeBefore)))
    .limit(500);
  let autoClosed = 0;
  for (const { id } of resolved) {
    try {
      await db.transaction(async (tx) => {
        const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).for("update");
        if (!ticket || ticket.status !== "RESOLVED") return;
        await moveTicket(tx, ticket, "CLOSED", null, `Closed automatically ${rule.autoCloseResolvedAfterDays} days after it was resolved.`);
        autoClosed += 1;
      });
    } catch (error) {
      console.error("[helpdesk] auto-close failed for ticket", id, error);
    }
  }
  return { ackBreaches, resolveBreaches, escalated, autoClosed };
}

/** Tickets raised on an order (the order screen shows them). */
export async function listTicketsForOrder(orderId: string, actor: Actor): Promise<TicketListRow[]> {
  const rows = await listRows(eq(supportTickets.orderId, orderId), 20);
  if (isSupportStaff(actor.role)) return rows;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const own = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(inArray(supportTickets.id, ids), eq(supportTickets.requesterId, actor.id)));
  const allowed = new Set(own.map((r) => r.id));
  return rows.filter((r) => allowed.has(r.id));
}
