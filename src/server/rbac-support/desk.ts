/**
 * RBAC v2 Phases 4 and 7 — the support desk on top of the existing help desk (support_tickets), and the
 * Operations → Support handover (docs/rbac/04-support-and-change-requests.md).
 *
 *   Teams          staff_team_members: an admin (or the team's manager) puts Support Users under a Support
 *                  Manager and Operations Users under an Operations Manager.
 *   Staff tickets  Operations, Support and admins raise a ticket about any shop they may work on (an
 *                  Operations User: shops they onboarded, or the shop of an Operations task assigned to them).
 *                  It lands in the Support Manager's queue at once.
 *   Manager        assigns / reassigns (existing assignTicket), sets priority (due date from rule
 *                  rbacV2.slaHoursByPriority, never later than the statutory help-desk deadline), side status
 *                  (Pending Information / On Hold / Rejected) — the status CHECK itself is unchanged.
 *   Support User   sees and works only the tickets assigned to them (ticketAccess in support-tickets.ts).
 *   Handover       a ticket raised by Operations, once RESOLVED, is confirmed (CLOSED) by the Operations User who
 *                  raised it, or by the Support Manager after rule rbacV2.confirmHours (48 h). Operations is told
 *                  at assignment, at awaiting-owner and at resolution.
 * Lifecycle shown with the brief's names: OPEN = New, ACKNOWLEDGED+assignee = Assigned, IN_PROGRESS,
 * AWAITING_SHOP = Awaiting Shop Owner, RESOLVED, CLOSED, REOPENED, ESCALATED, + sub_status.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { LIVE_TICKET_STATUSES, TICKET_PRIORITIES, canMoveTicket, type TicketStatus } from "@/lib/support-ticket-states";
import { db } from "@/server/db";
import { shops, staffTeamMembers, supportTickets, users, type StaffTeam, type SupportTicket, type UserRole } from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { announceCreated, appendEvent, assignTicket, moveTicket, slaDeadlines } from "@/server/aftercare/support-tickets";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled, requireFeatureForRole } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";

interface Actor {
  id: string;
  role: UserRole;
}

/** Staff-raised ticket topics (brief §8). Customer and shop-owner forms keep their own list. */
export const STAFF_TICKET_CATEGORIES = [
  "SHOP_REGISTRATION",
  "SHOP_VERIFICATION",
  "PRODUCT_UPLOAD",
  "PRODUCT_CORRECTION",
  "PRICE_UPDATE",
  "MRP_CORRECTION",
  "GST_TAX",
  "ORDER",
  "REFUND_PAYMENT",
  "WALLET",
  "SUBSCRIPTION",
  "SELLER_SETTLEMENT",
  "DEALER_FRANCHISE",
  "LOGIN_AUTH",
  "TECHNICAL",
  "OTHER",
] as const;
export type StaffTicketCategory = (typeof STAFF_TICKET_CATEGORIES)[number];
export const STAFF_TICKET_CATEGORY_LABELS: Record<StaffTicketCategory, string> = {
  SHOP_REGISTRATION: "Shop registration",
  SHOP_VERIFICATION: "Shop verification",
  PRODUCT_UPLOAD: "Product upload",
  PRODUCT_CORRECTION: "Product correction",
  PRICE_UPDATE: "Price update",
  MRP_CORRECTION: "MRP correction",
  GST_TAX: "GST / tax information",
  ORDER: "Orders",
  REFUND_PAYMENT: "Payments / refunds",
  WALLET: "Wallet",
  SUBSCRIPTION: "Subscription",
  SELLER_SETTLEMENT: "Seller settlement",
  DEALER_FRANCHISE: "Dealer / franchise",
  LOGIN_AUTH: "Login / authentication",
  TECHNICAL: "Technical",
  OTHER: "General",
};

/** The brief's lifecycle names over the stored status (+ side status). */
export function briefStatusLabel(ticket: Pick<SupportTicket, "status" | "assignedToUserId" | "subStatus">): string {
  if (ticket.subStatus === "PENDING_INFORMATION") return "Pending Information";
  if (ticket.subStatus === "ON_HOLD") return "On Hold";
  if (ticket.subStatus === "REJECTED") return "Rejected";
  switch (ticket.status) {
    case "OPEN":
      return ticket.assignedToUserId ? "Assigned" : "New";
    case "ACKNOWLEDGED":
      return "Assigned";
    case "IN_PROGRESS":
      return "In Progress";
    case "AWAITING_SHOP":
      return "Awaiting Shop Owner";
    case "AWAITING_CUSTOMER":
      return "Awaiting Requester";
    case "RESOLVED":
      return "Resolved";
    case "CLOSED":
      return "Closed";
    case "REOPENED":
      return "Reopened";
    case "ESCALATED":
      return "Escalated";
    default:
      return ticket.status;
  }
}

/* ------------------------------------------------------------------- teams */

const TEAM_MEMBER_ROLE: Record<StaffTeam, UserRole> = { SUPPORT: "SUPPORT_USER", OPERATIONS: "OPERATIONS_USER" };
const TEAM_MANAGER_ROLE: Record<StaffTeam, UserRole> = { SUPPORT: "SUPPORT_MANAGER", OPERATIONS: "OPERATIONS_MANAGER" };

async function roleOf(userId: string): Promise<UserRole | null> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role ?? null;
}

export async function addTeamMember(team: StaffTeam, managerUserId: string, memberUserId: string, actor: Actor) {
  if (actor.role !== "ADMIN" && !(actor.id === managerUserId && actor.role === TEAM_MANAGER_ROLE[team])) {
    throw forbidden("Only an admin or the team's own manager can change a team.");
  }
  if ((await roleOf(managerUserId)) !== TEAM_MANAGER_ROLE[team]) throw validationFailed(`The manager must hold the ${TEAM_MANAGER_ROLE[team]} role.`);
  if ((await roleOf(memberUserId)) !== TEAM_MEMBER_ROLE[team]) throw validationFailed(`The member must hold the ${TEAM_MEMBER_ROLE[team]} role.`);
  return db.transaction(async (tx) => {
    await tx
      .update(staffTeamMembers)
      .set({ active: false, removedAt: new Date() })
      .where(and(eq(staffTeamMembers.team, team), eq(staffTeamMembers.memberUserId, memberUserId), eq(staffTeamMembers.active, true)));
    const [row] = await tx.insert(staffTeamMembers).values({ team, managerUserId, memberUserId, addedBy: actor.id }).returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STAFF_TEAM_CHANGED, entityType: "staff_team_member", entityId: row.id, newValue: { team, managerUserId, memberUserId } }, tx);
    return row;
  });
}

export async function removeTeamMember(team: StaffTeam, memberUserId: string, actor: Actor): Promise<void> {
  const [row] = await db
    .select()
    .from(staffTeamMembers)
    .where(and(eq(staffTeamMembers.team, team), eq(staffTeamMembers.memberUserId, memberUserId), eq(staffTeamMembers.active, true)));
  if (!row) throw notFound("Team member");
  if (actor.role !== "ADMIN" && actor.id !== row.managerUserId) throw forbidden("Only an admin or the team's own manager can change a team.");
  await db.update(staffTeamMembers).set({ active: false, removedAt: new Date() }).where(eq(staffTeamMembers.id, row.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.STAFF_TEAM_CHANGED, entityType: "staff_team_member", entityId: row.id, previousValue: { team, memberUserId }, newValue: { active: false } });
}

export async function listTeam(team: StaffTeam, managerUserId: string): Promise<{ userId: string; name: string; email: string }[]> {
  return db
    .select({ userId: users.id, name: sql<string>`coalesce(${users.name}, ${users.email})`, email: users.email })
    .from(staffTeamMembers)
    .innerJoin(users, eq(users.id, staffTeamMembers.memberUserId))
    .where(and(eq(staffTeamMembers.team, team), eq(staffTeamMembers.managerUserId, managerUserId), eq(staffTeamMembers.active, true)))
    .orderBy(asc(users.name));
}

/* ----------------------------------------------------- Operations task hook */

/** Phase 6 (Operations) registers how to read a task; Phase 7 uses it to scope and link a handover ticket. */
export interface OpsTaskRef {
  id: string;
  assigneeUserId: string | null;
  shopId: string | null;
}
let opsTaskLookup: ((id: string) => Promise<OpsTaskRef | null>) | null = null;
export function registerOpsTaskLookup(fn: (id: string) => Promise<OpsTaskRef | null>): void {
  opsTaskLookup = fn;
}

/* ------------------------------------------------------------ staff tickets */

export interface StaffTicketInput {
  shopId: string;
  category: StaffTicketCategory;
  subject: string;
  description: string;
  priority?: (typeof TICKET_PRIORITIES)[number];
  opsTaskId?: string | null;
}

async function assertMayRaiseFor(shopId: string, opsTaskId: string | null | undefined, actor: Actor): Promise<void> {
  if (actor.role === "ADMIN" || can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE) || can(actor.role, PERMISSIONS.OPS_TEAM_MANAGE)) return;
  if (can(actor.role, PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED)) {
    const [mine] = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(and(eq(supportTickets.shopId, shopId), eq(supportTickets.assignedToUserId, actor.id)))
      .limit(1);
    if (mine) return;
  }
  if (can(actor.role, PERMISSIONS.OPS_TASK_WORK_OWN)) {
    const [shop] = await db.select({ onboardedBy: shops.onboardedByUserId }).from(shops).where(eq(shops.id, shopId));
    if (shop?.onboardedBy === actor.id) return;
    if (opsTaskId && opsTaskLookup) {
      const task = await opsTaskLookup(opsTaskId);
      if (task && task.assigneeUserId === actor.id && task.shopId === shopId) return;
    }
  }
  throw forbidden("You can raise tickets only for shops you work on.");
}

export async function raiseStaffTicket(input: StaffTicketInput, actor: Actor): Promise<SupportTicket> {
  await requireFeatureForRole("rbac_v2_support", actor.role);
  if (!can(actor.role, PERMISSIONS.SUPPORT_TICKET_RAISE) && actor.role !== "ADMIN") throw forbidden("You cannot raise tickets.");
  if (!STAFF_TICKET_CATEGORIES.includes(input.category)) throw validationFailed("Choose what the ticket is about.");
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject.length < 3 || subject.length > 200) throw validationFailed("Subject: 3 to 200 characters.");
  if (description.length < 10 || description.length > 5000) throw validationFailed("Describe the problem (10 to 5,000 characters).");
  const priority = input.priority ?? "NORMAL";
  if (!TICKET_PRIORITIES.includes(priority)) throw validationFailed("Unknown priority.");
  const [shop] = await db.select({ id: shops.id, name: shops.name }).from(shops).where(and(eq(shops.id, input.shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  await assertMayRaiseFor(shop.id, input.opsTaskId, actor);

  const [me] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, actor.id));
  const now = new Date();
  const { acknowledgeBy, resolveBy } = await slaDeadlines(now);
  const due = await priorityDue(now, priority, resolveBy);
  const ticket = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(supportTickets)
      .values({
        requesterId: actor.id,
        requesterRole: actor.role,
        requesterName: me?.name ?? null,
        requesterEmail: me?.email ?? null,
        shopId: shop.id,
        category: input.category,
        subject,
        description,
        priority,
        acknowledgeBy,
        resolveBy: due,
        createdAt: now,
        raisedByStaff: true,
        opsTaskId: input.opsTaskId ?? null,
      })
      .returning();
    await appendEvent(tx, row.id, { kind: "CREATED", to: "OPEN", actor, note: `Raised by staff (${actor.role}) about ${shop.name}.` });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_TICKET_CREATED, entityType: "support_ticket", entityId: row.id, newValue: { ticketNumber: row.ticketNumber, category: row.category, shopId: shop.id, opsTaskId: row.opsTaskId } },
      tx,
    );
    await announceCreated(tx, row, actor, me?.name ?? me?.email ?? "staff");
    return row;
  });
  // Instantly in the Support Managers' queue.
  const managers = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "SUPPORT_MANAGER"), eq(users.status, "ACTIVE")));
  for (const m of managers) {
    await notify({
      userId: m.id,
      type: NOTIFICATION_TYPES.STAFF_TICKET_UPDATE,
      title: `New ticket ${ticket.ticketNumber}`,
      body: `${STAFF_TICKET_CATEGORY_LABELS[input.category]} — ${shop.name}: ${subject}`,
      actionUrl: `/admin/support/${ticket.id}`,
      dedupeKey: `staff-ticket:${ticket.id}:new:${m.id}`,
    });
  }
  return ticket;
}

async function priorityDue(from: Date, priority: string, statutoryResolveBy: Date): Promise<Date> {
  if (!(await isFeatureEnabled("rbac_v2_support"))) return statutoryResolveBy;
  const { slaHoursByPriority } = await getRule("rbacV2");
  const hours = slaHoursByPriority[priority as keyof typeof slaHoursByPriority] ?? slaHoursByPriority.NORMAL;
  const due = new Date(from.getTime() + hours * 3_600_000);
  return due < statutoryResolveBy ? due : statutoryResolveBy;
}

/* ----------------------------------------------------------- manager actions */

export interface ManagerUpdate {
  assigneeId?: string | null;
  priority?: (typeof TICKET_PRIORITIES)[number];
  subStatus?: "PENDING_INFORMATION" | "ON_HOLD" | "REJECTED" | null;
  dueAt?: string | null;
  note?: string | null;
}

export async function managerUpdateTicket(ticketId: string, update: ManagerUpdate, actor: Actor): Promise<SupportTicket> {
  await requireFeatureForRole("rbac_v2_support", actor.role);
  if (!can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) throw forbidden("Only a Support Manager runs the queue.");
  if (update.assigneeId !== undefined) {
    await assignTicket(ticketId, update.assigneeId, actor);
  }
  const ticket = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).for("update");
    if (!current) throw notFound("Ticket");
    const patch: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date(), managerUserId: current.managerUserId ?? actor.id };
    const changes: Record<string, unknown> = {};
    if (update.priority && update.priority !== current.priority) {
      if (!TICKET_PRIORITIES.includes(update.priority)) throw validationFailed("Unknown priority.");
      patch.priority = update.priority;
      patch.resolveBy = await priorityDue(current.createdAt, update.priority, current.resolveBy);
      changes.priority = update.priority;
    }
    if (update.dueAt !== undefined && update.dueAt !== null) {
      const due = new Date(update.dueAt);
      if (Number.isNaN(due.getTime())) throw validationFailed("Due date: a valid date and time.");
      // Never later than the statutory deadline the ticket got when it was received.
      if (due > current.resolveBy && !patch.resolveBy) throw validationFailed("A due date cannot be later than the ticket's statutory deadline.");
      patch.resolveBy = due;
      changes.dueAt = due.toISOString();
    }
    if (update.subStatus !== undefined && update.subStatus !== current.subStatus) {
      patch.subStatus = update.subStatus;
      changes.subStatus = update.subStatus;
    }
    const [row] = await tx.update(supportTickets).set(patch).where(eq(supportTickets.id, ticketId)).returning();
    if (Object.keys(changes).length) {
      await appendEvent(tx, ticketId, { kind: "UPDATED", actor, note: `${Object.entries(changes).map(([k, v]) => `${k}: ${v ?? "—"}`).join("; ")}${update.note ? ` — ${update.note}` : ""}`, isPublic: false });
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_TICKET_UPDATED, entityType: "support_ticket", entityId: ticketId, previousValue: { priority: current.priority, subStatus: current.subStatus, resolveBy: current.resolveBy }, newValue: changes }, tx);
    }
    return row;
  });
  if (update.assigneeId) {
    await notify({
      userId: update.assigneeId,
      type: NOTIFICATION_TYPES.STAFF_TICKET_UPDATE,
      title: `Ticket ${ticket.ticketNumber} assigned to you`,
      body: ticket.subject,
      actionUrl: `/admin/support/${ticket.id}`,
      dedupeKey: `staff-ticket:${ticket.id}:assigned:${update.assigneeId}:${Date.now()}`,
    });
    await tellOperations(ticket, "assigned to the support team");
  }
  return ticket;
}

/** Brief §7.6: the Operations User who raised a ticket hears at assignment, awaiting-owner and resolution. */
export async function tellOperations(ticket: SupportTicket, what: string): Promise<void> {
  if (!ticket.raisedByStaff || !ticket.requesterId) return;
  if (!["OPERATIONS_USER", "OPERATIONS_MANAGER"].includes(ticket.requesterRole)) return;
  await notify({
    userId: ticket.requesterId,
    type: NOTIFICATION_TYPES.STAFF_TICKET_UPDATE,
    title: `Your ticket ${ticket.ticketNumber} was ${what}`,
    body: ticket.subject,
    actionUrl: `/staff/support/raised`,
    dedupeKey: `staff-ticket:${ticket.id}:ops:${what}:${ticket.status}`,
  });
}

/** Handover close: the Operations User who raised it (or a Support Manager) confirms a RESOLVED ticket. */
export async function confirmResolution(ticketId: string, actor: Actor, note?: string | null): Promise<SupportTicket> {
  await requireFeatureForRole("rbac_v2_support", actor.role);
  return db.transaction(async (tx) => {
    const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).for("update");
    if (!ticket) throw notFound("Ticket");
    const raiser = ticket.requesterId === actor.id && ticket.raisedByStaff;
    if (!raiser && !can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) throw forbidden("Only whoever raised the ticket, or a Support Manager, confirms it.");
    if (ticket.status !== "RESOLVED") throw conflict("Only a resolved ticket can be confirmed.");
    return moveTicket(tx, ticket, "CLOSED", actor, note?.trim() || (raiser ? "Confirmed by the person who raised it." : "Confirmed by the Support Manager."));
  });
}

/* ------------------------------------------------------------------- reads */

export interface DeskTicketRow {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  briefStatus: string;
  priority: string;
  shopId: string | null;
  shopName: string | null;
  resolveBy: Date;
  overdue: boolean;
  assigneeId: string | null;
  changeRequestId: string | null;
}

async function toRows(rows: SupportTicket[]): Promise<DeskTicketRow[]> {
  const shopIds = [...new Set(rows.map((r) => r.shopId).filter(Boolean))] as string[];
  const names = shopIds.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, shopIds)) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const now = Date.now();
  return rows.map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    status: t.status,
    briefStatus: briefStatusLabel(t),
    priority: t.priority,
    shopId: t.shopId,
    shopName: t.shopId ? nameOf.get(t.shopId) ?? null : null,
    resolveBy: t.resolveBy,
    overdue: (LIVE_TICKET_STATUSES as readonly string[]).includes(t.status) && t.resolveBy.getTime() < now,
    assigneeId: t.assignedToUserId,
    changeRequestId: t.changeRequestId,
  }));
}

/** The Support User's own work: tickets assigned to them, live first. */
export async function listMyAssignedTickets(actor: Actor): Promise<DeskTicketRow[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.assignedToUserId, actor.id), inArray(supportTickets.status, [...LIVE_TICKET_STATUSES, "RESOLVED"])))
    .orderBy(asc(supportTickets.resolveBy))
    .limit(200);
  return toRows(rows);
}

/** The Support Manager's live queue (plus resolved tickets waiting for confirmation), newest first. */
export async function listSupportQueue(): Promise<DeskTicketRow[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(inArray(supportTickets.status, [...LIVE_TICKET_STATUSES, "RESOLVED"]))
    .orderBy(desc(supportTickets.createdAt))
    .limit(200);
  return toRows(rows);
}

/** Tickets a staff member raised (Operations' view of the handover). */
export async function listRaisedTickets(actor: Actor): Promise<DeskTicketRow[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.requesterId, actor.id), eq(supportTickets.raisedByStaff, true)))
    .orderBy(desc(supportTickets.createdAt))
    .limit(200);
  return toRows(rows);
}

export interface WorkloadRow {
  userId: string;
  name: string;
  open: number;
  awaitingOwner: number;
  overdue: number;
  resolved7d: number;
  avgResolutionHours: number | null;
}

/** Support Manager dashboard: counts by queue, and workload per Support User of the team. */
export async function supportDashboard(actor: Actor): Promise<{ counts: Record<string, number>; avgResolutionHours: number | null; team: WorkloadRow[] }> {
  if (!can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) throw forbidden("Only a Support Manager sees the team dashboard.");
  const live = inArray(supportTickets.status, [...LIVE_TICKET_STATUSES]);
  const [c] = await db
    .select({
      newCount: sql<number>`count(*) filter (where ${supportTickets.status} = 'OPEN' and ${supportTickets.assignedToUserId} is null)::int`,
      assigned: sql<number>`count(*) filter (where ${supportTickets.status} in ('OPEN','ACKNOWLEDGED') and ${supportTickets.assignedToUserId} is not null)::int`,
      inProgress: sql<number>`count(*) filter (where ${supportTickets.status} = 'IN_PROGRESS')::int`,
      pending: sql<number>`count(*) filter (where ${supportTickets.subStatus} is not null and ${supportTickets.status} not in ('RESOLVED','CLOSED'))::int`,
      awaitingOwner: sql<number>`count(*) filter (where ${supportTickets.status} = 'AWAITING_SHOP')::int`,
      resolved: sql<number>`count(*) filter (where ${supportTickets.status} = 'RESOLVED')::int`,
      overdue: sql<number>`count(*) filter (where ${supportTickets.status} in ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_CUSTOMER','AWAITING_SHOP','ESCALATED','REOPENED') and ${supportTickets.resolveBy} < now())::int`,
      avgHours: sql<number | null>`avg(extract(epoch from (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 3600) filter (where ${supportTickets.resolvedAt} > now() - interval '30 days')`,
    })
    .from(supportTickets);
  const team = await listTeam("SUPPORT", actor.id);
  const ids = team.map((t) => t.userId);
  const per = ids.length
    ? await db
        .select({
          userId: supportTickets.assignedToUserId,
          open: sql<number>`count(*) filter (where ${live})::int`,
          awaitingOwner: sql<number>`count(*) filter (where ${supportTickets.status} = 'AWAITING_SHOP')::int`,
          overdue: sql<number>`count(*) filter (where ${live} and ${supportTickets.resolveBy} < now())::int`,
          resolved7d: sql<number>`count(*) filter (where ${supportTickets.resolvedAt} > now() - interval '7 days')::int`,
          avgHours: sql<number | null>`avg(extract(epoch from (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 3600) filter (where ${supportTickets.resolvedAt} is not null)`,
        })
        .from(supportTickets)
        .where(inArray(supportTickets.assignedToUserId, ids))
        .groupBy(supportTickets.assignedToUserId)
    : [];
  const byUser = new Map(per.map((p) => [p.userId, p]));
  return {
    counts: {
      new: c?.newCount ?? 0,
      assigned: c?.assigned ?? 0,
      inProgress: c?.inProgress ?? 0,
      pending: c?.pending ?? 0,
      awaitingOwner: c?.awaitingOwner ?? 0,
      resolved: c?.resolved ?? 0,
      overdue: c?.overdue ?? 0,
    },
    avgResolutionHours: c?.avgHours == null ? null : Math.round(Number(c.avgHours) * 10) / 10,
    team: team.map((m) => {
      const p = byUser.get(m.userId);
      return {
        userId: m.userId,
        name: m.name,
        open: p?.open ?? 0,
        awaitingOwner: p?.awaitingOwner ?? 0,
        overdue: p?.overdue ?? 0,
        resolved7d: p?.resolved7d ?? 0,
        avgResolutionHours: p?.avgHours == null ? null : Math.round(Number(p.avgHours) * 10) / 10,
      };
    }),
  };
}

/* ------------------------------------------------------------------- sweep */

/**
 * Hourly: overdue tickets escalate to their Support Manager (or every Support Manager), once per ticket; staff
 * tickets resolved more than rbacV2.confirmHours ago and not yet confirmed are put to the Support Manager.
 */
export async function sweepSupportDesk(): Promise<{ overdueAlerts: number; confirmAlerts: number }> {
  if (!(await isFeatureEnabled("rbac_v2_support"))) return { overdueAlerts: 0, confirmAlerts: 0 };
  const { confirmHours } = await getRule("rbacV2");
  const managers = (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "SUPPORT_MANAGER"), eq(users.status, "ACTIVE")))).map((m) => m.id);
  const overdue = await db
    .select()
    .from(supportTickets)
    .where(and(inArray(supportTickets.status, [...LIVE_TICKET_STATUSES]), lt(supportTickets.resolveBy, new Date())))
    .limit(500);
  let overdueAlerts = 0;
  for (const t of overdue) {
    for (const m of t.managerUserId ? [t.managerUserId] : managers) {
      await notify({
        userId: m,
        type: NOTIFICATION_TYPES.STAFF_TICKET_UPDATE,
        title: `Overdue: ticket ${t.ticketNumber}`,
        body: `${t.subject} — due ${t.resolveBy.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.`,
        actionUrl: `/admin/support/${t.id}`,
        dedupeKey: `staff-ticket:${t.id}:overdue:${t.resolveBy.toISOString()}`,
      });
      overdueAlerts += 1;
    }
  }
  const unconfirmed = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, "RESOLVED"),
        eq(supportTickets.raisedByStaff, true),
        isNotNull(supportTickets.resolvedAt),
        lt(supportTickets.resolvedAt, new Date(Date.now() - confirmHours * 3_600_000)),
      ),
    )
    .limit(500);
  let confirmAlerts = 0;
  for (const t of unconfirmed) {
    for (const m of t.managerUserId ? [t.managerUserId] : managers) {
      await notify({
        userId: m,
        type: NOTIFICATION_TYPES.STAFF_TICKET_UPDATE,
        title: `Confirm ticket ${t.ticketNumber}`,
        body: `Resolved ${confirmHours} hours ago and not confirmed by whoever raised it. Confirm to close it.`,
        actionUrl: `/admin/support/${t.id}`,
        dedupeKey: `staff-ticket:${t.id}:confirm`,
      });
      confirmAlerts += 1;
    }
  }
  return { overdueAlerts, confirmAlerts };
}

export function canMoveBrief(from: string, to: TicketStatus): boolean {
  return canMoveTicket(from as TicketStatus, to);
}
