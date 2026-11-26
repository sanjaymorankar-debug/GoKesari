/**
 * Help-desk routing (docs/flows-v3/wave1.md, F17 steps 4; flag flow_f17; migration 0220).
 *
 *   Auto-assign  a new ticket goes to a person named in support_routing_rules for its category and the district
 *                of the ticket's shop (from the shop's PIN code). A rule for the exact district wins over one for
 *                the state, which wins over one for every area (NULL). Among the people of the best match, the one
 *                with the fewest live tickets gets it (ties: the oldest rule). Only people who can still work
 *                tickets (support staff, or Support Users) are picked. No rule or nobody eligible: the ticket stays
 *                in the manual queue, as before. Auto-assignment does not count as the first response.
 *   Area dealer  a ticket about a shop is copied to the dealer the shop is attributed to (shop_attributions,
 *                ACTIVE): read-only access (TicketAccess DEALER) and an in-app / e-mail notice.
 *
 * Both follow rule supportFlows (autoAssign, ccAreaDealer). Callers (support-tickets.ts afterTicketOpened) check
 * the flag and catch every error: a ticket is never lost because routing failed.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { stateCodeOfArea } from "@/lib/indian-states";
import { LIVE_TICKET_STATUSES, TICKET_CATEGORIES } from "@/lib/support-ticket-states";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  dealers,
  shopAttributions,
  shops,
  supportRoutingRules,
  supportTickets,
  users,
  type SupportRoutingRule,
  type SupportTicket,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable, isFeatureEnabled } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";
import { notify } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { getRule } from "@/server/services/settings";
import { STAFF_TICKET_CATEGORIES } from "@/server/rbac-support/desk";
import { appendEvent, formatIst, isSupportStaff } from "./support-tickets";

interface Actor {
  id: string;
  role: UserRole;
}

/** Every category a rule may name: the customer / shop-owner form's and the staff form's. */
export const ROUTABLE_CATEGORIES: readonly string[] = [...new Set<string>([...TICKET_CATEGORIES, ...STAFF_TICKET_CATEGORIES, "GENERAL", "PRODUCT_UPLOAD", "PRICE_UPDATE"])];

/* ----------------------------------------------------------------- matching */

/** Whether the person can still be given tickets: any role they hold works tickets (same test as assignTicket). */
async function canWorkTickets(userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role, status: users.status, deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId));
  if (!user || user.deletedAt || user.status !== "ACTIVE") return false;
  const held = [user.role, ...(await listUserRoles(userId))];
  return held.some((r) => isSupportStaff(r) || can(r, PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED));
}

/** The ticket's district: its shop's PIN code mapped to a geo_areas district (null when unknown). */
async function ticketDistrict(ticket: SupportTicket): Promise<string | null> {
  if (!ticket.shopId) return null;
  const [shop] = await db.select({ pincode: shops.pincode }).from(shops).where(eq(shops.id, ticket.shopId));
  return shop?.pincode ? districtCodeForPincode(shop.pincode).catch(() => null) : null;
}

/**
 * The person a ticket of this category in this district goes to, or null (manual queue). Exact district, then
 * state, then every area; least-loaded within the best tier.
 */
export async function pickAssignee(category: string, districtCode: string | null): Promise<string | null> {
  const rules = await db
    .select()
    .from(supportRoutingRules)
    .where(and(eq(supportRoutingRules.category, category), eq(supportRoutingRules.active, true)))
    .orderBy(asc(supportRoutingRules.createdAt));
  if (rules.length === 0) return null;
  const state = stateCodeOfArea(districtCode);
  const tiers: SupportRoutingRule[][] = [
    districtCode ? rules.filter((r) => r.districtCode === districtCode) : [],
    state && state !== districtCode ? rules.filter((r) => r.districtCode === state) : [],
    rules.filter((r) => r.districtCode === null),
  ];
  for (const tier of tiers) {
    const eligible: string[] = [];
    for (const rule of tier) if (!eligible.includes(rule.userId) && (await canWorkTickets(rule.userId))) eligible.push(rule.userId);
    if (eligible.length === 0) continue;
    const loads = await db
      .select({ userId: supportTickets.assignedToUserId, n: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(and(inArray(supportTickets.assignedToUserId, eligible), inArray(supportTickets.status, [...LIVE_TICKET_STATUSES])))
      .groupBy(supportTickets.assignedToUserId);
    const load = new Map(loads.map((l) => [l.userId, l.n]));
    // Stable: equal loads keep the rules' order (oldest first).
    return [...eligible].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
  }
  return null;
}

/* ------------------------------------------------------------------ routing */

async function autoAssign(ticket: SupportTicket, districtCode: string | null): Promise<SupportTicket> {
  if (ticket.assignedToUserId) return ticket;
  const assigneeId = await pickAssignee(ticket.category, districtCode);
  if (!assigneeId) return ticket;
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(supportTickets)
      .set({ assignedToUserId: assigneeId, updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.assignedToUserId)))
      .returning();
    if (!updated) return ticket;
    await appendEvent(tx, ticket.id, { kind: "ASSIGNED", actor: null, note: "Assigned automatically (routing rule)", isPublic: false });
    await recordAudit(
      {
        actorId: null,
        actorRole: null,
        action: AUDIT_ACTIONS.SUPPORT_TICKET_ROUTED,
        entityType: "support_ticket",
        entityId: ticket.id,
        newValue: { assignedToUserId: assigneeId, category: ticket.category, districtCode },
      },
      tx,
    );
    await emitEvent(
      {
        type: "support_ticket.assigned",
        subjectId: ticket.id,
        actor: { id: null, role: null },
        payload: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, assigneeId, resolveByLabel: formatIst(ticket.resolveBy) },
      },
      tx,
    );
    return updated;
  });
}

/** The dealer the ticket's shop is attributed to (ACTIVE attribution, dealer with an account), or null. */
async function areaDealerUserId(shopId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: dealers.userId })
    .from(shopAttributions)
    .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
    .where(and(eq(shopAttributions.shopId, shopId), eq(shopAttributions.status, "ACTIVE")));
  return row?.userId ?? null;
}

async function copyAreaDealer(ticket: SupportTicket): Promise<SupportTicket> {
  if (!ticket.shopId || ticket.ccDealerUserId) return ticket;
  const dealerUserId = await areaDealerUserId(ticket.shopId);
  if (!dealerUserId || dealerUserId === ticket.requesterId) return ticket;
  const [updated] = await db
    .update(supportTickets)
    .set({ ccDealerUserId: dealerUserId })
    .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.ccDealerUserId)))
    .returning();
  if (!updated) return ticket;
  await appendEvent(db, ticket.id, { kind: "NOTE", actor: null, note: "Area dealer copied (read-only)", isPublic: false });
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, ticket.shopId));
  await notify({
    userId: dealerUserId,
    type: NOTIFICATION_TYPES.TICKET_STATUS_CHANGED,
    title: `Ticket ${ticket.ticketNumber} for ${shop?.name ?? "a shop in your area"}`,
    body: `${ticket.subject} — you can follow it; GoKesari support is handling it.`,
    actionUrl: `/support/${ticket.id}`,
    dedupeKey: `ticket-cc-dealer:${ticket.id}:${dealerUserId}`,
  });
  return updated;
}

/**
 * Runs after a ticket is saved (flag flow_f17 checked by the caller). Returns the ticket as it now stands, or null
 * when it cannot be found.
 */
export async function routeNewTicket(ticketId: string): Promise<SupportTicket | null> {
  let [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  if (!ticket) return null;
  const rule = await getRule("supportFlows");
  if (rule.autoAssign) {
    try {
      ticket = await autoAssign(ticket, await ticketDistrict(ticket));
    } catch (error) {
      console.error("[helpdesk] auto-assign failed", ticket.ticketNumber, error);
    }
  }
  if (rule.ccAreaDealer) {
    try {
      ticket = await copyAreaDealer(ticket);
    } catch (error) {
      console.error("[helpdesk] copying the area dealer failed", ticket.ticketNumber, error);
    }
  }
  return ticket;
}

/* -------------------------------------------------------------- admin rules */

function assertRoutingManager(actor: Actor) {
  if (actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) {
    throw forbidden("Only an administrator or a Support Manager can change ticket routing.");
  }
}

async function assertFlag(): Promise<void> {
  if (!(await isFeatureEnabled("flow_f17").catch(() => false))) throw featureNotAvailable("flow_f17");
}

export interface RoutingRuleView {
  id: string;
  category: string;
  districtCode: string | null;
  userId: string;
  userLabel: string;
  active: boolean;
  createdAt: Date;
}

export async function listRoutingRules(actor: Actor): Promise<RoutingRuleView[]> {
  await assertFlag();
  assertRoutingManager(actor);
  const rows = await db
    .select({ rule: supportRoutingRules, name: users.name, email: users.email })
    .from(supportRoutingRules)
    .innerJoin(users, eq(users.id, supportRoutingRules.userId))
    .orderBy(asc(supportRoutingRules.category), asc(supportRoutingRules.districtCode), asc(supportRoutingRules.createdAt));
  return rows.map(({ rule, name, email }) => ({
    id: rule.id,
    category: rule.category,
    districtCode: rule.districtCode,
    userId: rule.userId,
    userLabel: name ?? email,
    active: rule.active,
    createdAt: rule.createdAt,
  }));
}

export interface RoutingRuleInput {
  category: string;
  districtCode?: string | null;
  userId: string;
}

export async function addRoutingRule(input: RoutingRuleInput, actor: Actor): Promise<SupportRoutingRule> {
  await assertFlag();
  assertRoutingManager(actor);
  const category = input.category.trim().toUpperCase();
  if (!ROUTABLE_CATEGORIES.includes(category)) throw validationFailed("Choose a ticket category.");
  const districtCode = input.districtCode?.trim().toUpperCase() || null;
  if (districtCode && !/^[A-Z]{2}(-[A-Z0-9]{2,12})?$/.test(districtCode)) throw validationFailed("Use a district code such as MH-PUN, a state code such as MH, or leave it empty for every area.");
  if (!/^[0-9a-f-]{36}$/i.test(input.userId) || !(await canWorkTickets(input.userId))) {
    throw validationFailed("Pick a support team member, an operator or an administrator.");
  }
  const [row] = await db
    .insert(supportRoutingRules)
    .values({ category, districtCode, userId: input.userId, createdBy: actor.id })
    .onConflictDoNothing()
    .returning();
  const saved =
    row ??
    (
      await db
        .update(supportRoutingRules)
        .set({ active: true, updatedAt: new Date() })
        .where(
          and(
            eq(supportRoutingRules.category, category),
            districtCode ? eq(supportRoutingRules.districtCode, districtCode) : isNull(supportRoutingRules.districtCode),
            eq(supportRoutingRules.userId, input.userId),
          ),
        )
        .returning()
    )[0];
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_ROUTING_CHANGED, entityType: "support_routing_rule", entityId: saved.id, newValue: { category, districtCode, userId: input.userId, active: true } });
  return saved;
}

/** Switches a rule off (kept for the record). */
export async function removeRoutingRule(id: string, actor: Actor): Promise<void> {
  await assertFlag();
  assertRoutingManager(actor);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Routing rule");
  const [row] = await db.update(supportRoutingRules).set({ active: false, updatedAt: new Date() }).where(eq(supportRoutingRules.id, id)).returning();
  if (!row) throw notFound("Routing rule");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.SUPPORT_ROUTING_CHANGED, entityType: "support_routing_rule", entityId: id, newValue: { active: false } });
}
