/**
 * Per-society authorisation of delivery partners (gig worker flow, features
 * 7 and 8, docs/gig-worker-2026-10).
 *
 *  - GoKesari's admin authorises or blocks a partner for a society
 *    (`society_partner_access`). AUTHORISED counts as listed for the society's
 *    dispatch rules; BLOCKED keeps the partner off the society's orders
 *    (delivery-eligibility.ts blockedPartnerIds) and off its rider list.
 *  - The shop owner sees, for each delivery partner who has carried the
 *    shop's orders, how many societies authorise them and how many block
 *    them, with the list of each.
 *  - Feature 8, enforced here on the server: on an order whose delivery
 *    society blocks the assigned partner, the shop gets no name, photo or
 *    mobile — only "Partner pending assignment" — in the order data and in
 *    the shop's notifications.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, or } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  orders,
  shops,
  societies,
  societyPartnerAccess,
  type DeliveryOrder,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { riderDisplayId, uploadedPhotoId } from "./rider-files";

interface Actor {
  id: string;
  role: UserRole;
}

export type SocietyAccess = "AUTHORISED" | "BLOCKED";

/** What the shop sees instead of a blocked partner (feature 8). */
export const PARTNER_PENDING_LABEL = "Partner pending assignment";
/** The same, inside a sentence of a shop notification. */
export const PARTNER_HIDDEN_IN_TEXT = "A delivery partner";

export interface SocietyRef {
  societyId: string;
  name: string;
  area: string | null;
  city: string;
  reason: string | null;
  decidedAt: Date;
}

export interface PartnerSocietyAccess {
  authorised: SocietyRef[];
  blocked: SocietyRef[];
}

/* -------------------------------------------------------------------- admin */

function requireAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw forbidden("Only a GoKesari admin can authorise or block a partner for a society.");
}

/** Admin authorises or blocks one partner for one society. A block needs a reason. */
export async function setSocietyPartnerAccess(
  input: { societyId: string; deliveryPartnerId: string; access: SocietyAccess; reason?: string | null },
  actor: Actor,
): Promise<SocietyRef & { access: SocietyAccess }> {
  requireAdmin(actor);
  const reason = input.reason?.trim() || null;
  if (input.access === "BLOCKED" && (!reason || reason.length < 3)) throw validationFailed("Give a reason for blocking the partner.");
  const [society] = await db.select().from(societies).where(and(eq(societies.id, input.societyId), isNull(societies.deletedAt)));
  if (!society) throw notFound("Society");
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, input.deliveryPartnerId), isNull(deliveryPartners.deletedAt)),
  });
  if (!partner) throw notFound("Delivery partner");

  const previous = await db.query.societyPartnerAccess.findFirst({
    where: and(eq(societyPartnerAccess.societyId, society.id), eq(societyPartnerAccess.deliveryPartnerId, partner.id)),
  });
  const now = new Date();
  // Customer-side table (not a seller table): a targeted upsert is allowed.
  const [row] = await db
    .insert(societyPartnerAccess)
    .values({ societyId: society.id, deliveryPartnerId: partner.id, access: input.access, reason, decidedBy: actor.id })
    .onConflictDoUpdate({
      target: [societyPartnerAccess.societyId, societyPartnerAccess.deliveryPartnerId],
      set: { access: input.access, reason, decidedBy: actor.id, updatedAt: now },
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_PARTNER_ACCESS_CHANGED,
    entityType: "society_partner_access",
    entityId: row.id,
    previousValue: previous ? { access: previous.access } : null,
    newValue: { societyId: society.id, deliveryPartnerId: partner.id, access: input.access, reason },
  });
  if (input.access === "BLOCKED") await withdrawSocietyOffers(partner.id, society.id, actor);
  return { societyId: society.id, name: society.name, area: society.area, city: society.city, reason, decidedAt: row.updatedAt, access: input.access };
}

/** An offer the newly blocked partner has not accepted goes to another rider. Never fails the block. */
async function withdrawSocietyOffers(partnerId: string, societyId: string, actor: Actor): Promise<void> {
  const open = await db
    .select({ id: deliveryOrders.id, orderId: deliveryOrders.orderId })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .where(and(eq(deliveryOrders.deliveryPartnerId, partnerId), eq(deliveryOrders.status, "OFFERED"), eq(orders.societyId, societyId)));
  if (open.length === 0) return;
  const { withdrawPartnerOffers } = await import("./delivery-assignment");
  await withdrawPartnerOffers(partnerId, "The rider is blocked for this society.", actor, open.map((o) => o.id)).catch((error) => {
    console.error("[society-access] withdrawing offers failed", partnerId, error);
  });
}

/** Admin removes the decision; the partner is back to the society's own list. */
export async function clearSocietyPartnerAccess(societyId: string, deliveryPartnerId: string, actor: Actor): Promise<void> {
  requireAdmin(actor);
  const [row] = await db
    .delete(societyPartnerAccess)
    .where(and(eq(societyPartnerAccess.societyId, societyId), eq(societyPartnerAccess.deliveryPartnerId, deliveryPartnerId)))
    .returning();
  if (!row) throw notFound("Society decision");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SOCIETY_PARTNER_ACCESS_CHANGED,
    entityType: "society_partner_access",
    entityId: row.id,
    previousValue: { access: row.access },
    newValue: { societyId, deliveryPartnerId, access: null },
  });
}

/** Authorised and blocked societies of one partner. */
export async function getPartnerSocietyAccess(deliveryPartnerId: string, client: DbClient = db): Promise<PartnerSocietyAccess> {
  const rows = await client
    .select({
      access: societyPartnerAccess.access,
      reason: societyPartnerAccess.reason,
      decidedAt: societyPartnerAccess.updatedAt,
      societyId: societies.id,
      name: societies.name,
      area: societies.area,
      city: societies.city,
    })
    .from(societyPartnerAccess)
    .innerJoin(societies, eq(societies.id, societyPartnerAccess.societyId))
    .where(and(eq(societyPartnerAccess.deliveryPartnerId, deliveryPartnerId), isNull(societies.deletedAt)))
    .orderBy(societies.name);
  const toRef = (r: (typeof rows)[number]): SocietyRef => ({
    societyId: r.societyId,
    name: r.name,
    area: r.area,
    city: r.city,
    reason: r.reason,
    decidedAt: r.decidedAt,
  });
  return {
    authorised: rows.filter((r) => r.access === "AUTHORISED").map(toRef),
    blocked: rows.filter((r) => r.access === "BLOCKED").map(toRef),
  };
}

/** Admin picker: societies by name, area or city. */
export async function searchSocietiesForAccess(query: string, actor: Actor): Promise<{ id: string; name: string; area: string | null; city: string; status: string }[]> {
  requireAdmin(actor);
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return db
    .select({ id: societies.id, name: societies.name, area: societies.area, city: societies.city, status: societies.status })
    .from(societies)
    .where(and(isNull(societies.deletedAt), or(ilike(societies.name, like), ilike(societies.area, like), ilike(societies.city, like))))
    .orderBy(societies.name)
    .limit(20);
}

/* ------------------------------------------------------------ feature 8 */

/** Is the partner blocked for the order's delivery society? */
export async function isPartnerHiddenForOrder(
  order: { societyId: string | null },
  deliveryPartnerId: string | null,
  client: DbClient = db,
): Promise<boolean> {
  if (!order.societyId || !deliveryPartnerId) return false;
  const [row] = await client
    .select({ id: societyPartnerAccess.id })
    .from(societyPartnerAccess)
    .where(
      and(
        eq(societyPartnerAccess.societyId, order.societyId),
        eq(societyPartnerAccess.deliveryPartnerId, deliveryPartnerId),
        eq(societyPartnerAccess.access, "BLOCKED"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Which (society, partner) pairs of these are blocked — one query for a page of orders. */
async function blockedPairs(pairs: { societyId: string | null; partnerId: string | null }[]): Promise<Set<string>> {
  const societyIds = [...new Set(pairs.map((p) => p.societyId).filter((v): v is string => Boolean(v)))];
  const partnerIds = [...new Set(pairs.map((p) => p.partnerId).filter((v): v is string => Boolean(v)))];
  if (societyIds.length === 0 || partnerIds.length === 0) return new Set();
  const rows = await db
    .select({ societyId: societyPartnerAccess.societyId, partnerId: societyPartnerAccess.deliveryPartnerId })
    .from(societyPartnerAccess)
    .where(
      and(
        inArray(societyPartnerAccess.societyId, societyIds),
        inArray(societyPartnerAccess.deliveryPartnerId, partnerIds),
        eq(societyPartnerAccess.access, "BLOCKED"),
      ),
    );
  return new Set(rows.map((r) => `${r.societyId}:${r.partnerId}`));
}

/** Delivery statuses at which a partner holds the shop's order (before that, there is no one to show). */
const HOLDING: readonly DeliveryOrder["status"][] = ["ACCEPTED", "PICKED_UP", "DELIVERED"];
/** The partner's mobile is shown to the shop only while the delivery is under way. */
const CONTACT_WHILE: readonly DeliveryOrder["status"][] = ["ACCEPTED", "PICKED_UP"];

export interface ShopOrderPartner {
  deliveryStatus: DeliveryOrder["status"];
  /** Null when no partner holds the order yet, or when their identity is hidden from the shop. */
  partner: { name: string; riderId: string; photoUrl: string | null; mobile: string | null; vehicleType: string } | null;
  /** "Partner pending assignment" when hidden or not yet assigned; the partner's name otherwise. */
  label: string;
  hidden: boolean;
}

/**
 * The partner on each of a shop's orders, as the shop may see them. The one
 * place shop-facing order data gets partner identity from — the server never
 * sends a hidden partner's name, photo or mobile to the shop.
 */
export async function getShopOrderPartners(orderIds: string[]): Promise<Map<string, ShopOrderPartner>> {
  const result = new Map<string, ShopOrderPartner>();
  if (orderIds.length === 0) return result;
  const rows = await db
    .select({
      orderId: deliveryOrders.orderId,
      status: deliveryOrders.status,
      societyId: orders.societyId,
      partnerId: deliveryPartners.id,
      name: deliveryPartners.fullName,
      mobile: deliveryPartners.mobile,
      photo: deliveryPartners.profilePhotoUrl,
      vehicleType: deliveryPartners.vehicleType,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
    .where(inArray(deliveryOrders.orderId, orderIds));
  const blocked = await blockedPairs(rows.map((r) => ({ societyId: r.societyId, partnerId: r.partnerId })));
  for (const r of rows) {
    const hidden = Boolean(r.societyId && blocked.has(`${r.societyId}:${r.partnerId}`));
    const holding = HOLDING.includes(r.status);
    const visible = holding && !hidden;
    result.set(r.orderId, {
      deliveryStatus: r.status,
      partner: visible
        ? {
            name: r.name,
            riderId: riderDisplayId(r.partnerId),
            // Only an uploaded, access-checked photo (rider-files.ts canViewRiderPhoto lets the shop open it).
            photoUrl: uploadedPhotoId(r.photo) ? r.photo : null,
            mobile: CONTACT_WHILE.includes(r.status) ? r.mobile : null,
            vehicleType: r.vehicleType,
          }
        : null,
      label: visible ? r.name : PARTNER_PENDING_LABEL,
      hidden,
    });
  }
  return result;
}

/**
 * May this shop owner open this partner's photo? Only for an order of their
 * shop the partner holds or delivered in the last 30 days, and never on an
 * order whose society blocks the partner (feature 8).
 */
export async function shopOwnerMaySeePartner(shopOwnerId: string, deliveryPartnerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({ societyId: orders.societyId })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(shops.ownerId, shopOwnerId),
        eq(deliveryOrders.deliveryPartnerId, deliveryPartnerId),
        inArray(deliveryOrders.status, [...HOLDING]),
        gte(deliveryOrders.updatedAt, since),
      ),
    )
    .limit(50);
  if (rows.length === 0) return false;
  const blocked = await blockedPairs(rows.map((r) => ({ societyId: r.societyId, partnerId: deliveryPartnerId })));
  return rows.some((r) => !r.societyId || !blocked.has(`${r.societyId}:${deliveryPartnerId}`));
}

/* ------------------------------------------------------------ feature 7 */

export interface ShopDeliveryPartner {
  deliveryPartnerId: string;
  riderId: string;
  name: string;
  photoUrl: string | null;
  vehicleType: string;
  ordersDelivered: number;
  lastOrderAt: Date;
  authorisedCount: number;
  blockedCount: number;
  authorised: SocietyRef[];
  blocked: SocietyRef[];
}

/**
 * Feature 7: the delivery partners who carried this shop's orders in the
 * last 90 days, each with the societies that authorise and block them.
 * A partner seen only on orders where their identity is hidden (feature 8)
 * is not listed. `shopId` must be the caller's own shop (checked).
 */
export async function listShopDeliveryPartners(shopId: string, actor: Actor): Promise<ShopDeliveryPartner[]> {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN") throw forbidden("This is not your shop.");
  const since = new Date(Date.now() - 90 * 86_400_000);
  const rows = await db
    .select({
      partnerId: deliveryPartners.id,
      name: deliveryPartners.fullName,
      photo: deliveryPartners.profilePhotoUrl,
      vehicleType: deliveryPartners.vehicleType,
      societyId: orders.societyId,
      status: deliveryOrders.status,
      at: deliveryOrders.updatedAt,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
    .where(and(eq(orders.shopId, shopId), inArray(deliveryOrders.status, [...HOLDING]), gte(deliveryOrders.updatedAt, since), isNull(deliveryPartners.deletedAt)))
    .orderBy(desc(deliveryOrders.updatedAt))
    .limit(1000);
  const blocked = await blockedPairs(rows.map((r) => ({ societyId: r.societyId, partnerId: r.partnerId })));
  const byPartner = new Map<string, { row: (typeof rows)[number]; delivered: number; last: Date }>();
  for (const r of rows) {
    if (r.societyId && blocked.has(`${r.societyId}:${r.partnerId}`)) continue;
    const entry = byPartner.get(r.partnerId) ?? { row: r, delivered: 0, last: r.at };
    if (r.status === "DELIVERED") entry.delivered += 1;
    if (r.at > entry.last) entry.last = r.at;
    byPartner.set(r.partnerId, entry);
  }
  const list: ShopDeliveryPartner[] = [];
  for (const [partnerId, { row, delivered, last }] of byPartner) {
    const access = await getPartnerSocietyAccess(partnerId);
    list.push({
      deliveryPartnerId: partnerId,
      riderId: riderDisplayId(partnerId),
      name: row.name,
      photoUrl: uploadedPhotoId(row.photo) ? row.photo : null,
      vehicleType: row.vehicleType,
      ordersDelivered: delivered,
      lastOrderAt: last,
      authorisedCount: access.authorised.length,
      blockedCount: access.blocked.length,
      authorised: access.authorised,
      blocked: access.blocked,
    });
  }
  return list.sort((a, b) => b.lastOrderAt.getTime() - a.lastOrderAt.getTime());
}

/** Admin view of one partner's societies, with a guard that the partner exists. */
export async function getPartnerSocietyAccessForAdmin(deliveryPartnerId: string, actor: Actor): Promise<PartnerSocietyAccess> {
  requireAdmin(actor);
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, deliveryPartnerId) });
  if (!partner) throw notFound("Delivery partner");
  if (partner.status === "DEACTIVATED") throw conflict("This partner's account is closed.");
  return getPartnerSocietyAccess(deliveryPartnerId);
}
