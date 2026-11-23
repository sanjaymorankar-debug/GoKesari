/**
 * RBAC v2 Phase 5 — shop-owner approval of changes proposed by Support (brief §4;
 * docs/rbac/04-support-and-change-requests.md).
 *
 * A Support User never overwrites approved shop data. A proposal is stored as one approval request of type
 * SHOP_CHANGE (checker SHOP_OWNER, item-by-item) with one item per field; a bulk upload is one request with
 * many items. The owner approves or rejects each item (a rejection needs a comment). Approved items are applied
 * through the SAME service functions the owner's own screens use (updateShop, updateShopProduct,
 * createShopProduct, the shop-MRP writer), acting as the owner, so every existing rule still holds (price ≤
 * MRP, pricing CHECKs, category rules). Rejected, expired and superseded items never touch live data.
 *
 *   - Superseded: an item whose live value no longer equals the value it was proposed against (the owner
 *     changed it meanwhile) is not applied; the Support User is told. Checked on apply and by the hourly sweep.
 *   - Reminders at rule rbacV2.reminderHours (24 h, 72 h); after expiryDays (7) the request EXPIRES, nothing is
 *     applied, the linked ticket goes to Pending Information and the Support Manager is told.
 *   - The linked ticket moves by itself: AWAITING_SHOP while waiting; RESOLVED when everything was applied;
 *     IN_PROGRESS (rework) when anything was rejected or superseded.
 *   - MRP changes are shop-only (shop_listing_details.mrp_paise, history in shop_mrp_history); the master
 *     product data is never written here — that is a MASTER_DATA_CORRECTION request decided by an admin.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  approvalDecisions,
  approvalRequestItems,
  approvalRequests,
  products,
  shopListingDetails,
  shopMrpHistory,
  shopProducts,
  shops,
  supportTickets,
  users,
  type ApprovalRequest,
  type ApprovalRequestItem,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { moveTicket } from "@/server/aftercare/support-tickets";
import { tellOperations } from "./desk";
import { canMoveTicket, type TicketStatus } from "@/lib/support-ticket-states";
import { getApproval, registerApprovalHandler, submitApproval, type ApplyContext } from "@/server/approvals/engine";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { createShopProduct, updateShopProduct } from "@/server/services/catalogue";
import { isFeatureEnabled, requireFeatureForRole } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { updateShop, type UpdateShopInput } from "@/server/services/shops";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";

export const SHOP_CHANGE = "SHOP_CHANGE";
export const MASTER_DATA_CORRECTION = "MASTER_DATA_CORRECTION";

interface Actor {
  id: string;
  role: UserRole;
}

/* ---------------------------------------------------------- what can change */

/** Shop fields Support may propose (GSTIN / PAN are not here: they change only through government verification). */
export const SHOP_FIELDS = [
  "name",
  "ownerName",
  "email",
  "contactPhone",
  "whatsappNumber",
  "addressLine1",
  "addressLine2",
  "area",
  "city",
  "state",
  "pincode",
  "landmark",
  "description",
] as const;
export type ShopField = (typeof SHOP_FIELDS)[number];

/** Fields of one product in the shop. Prices and MRP are paise; MRP is the shop's own (never the master). */
export const PRODUCT_FIELDS = ["onlinePricePaise", "offlinePricePaise", "shopMrpPaise", "description", "imageUrl", "isAvailable"] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

export const FIELD_LABELS: Record<ShopField | ProductField | "addProduct", string> = {
  name: "Shop name",
  ownerName: "Owner name",
  email: "E-mail",
  contactPhone: "Contact phone",
  whatsappNumber: "WhatsApp number",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  area: "Area",
  city: "City",
  state: "State",
  pincode: "PIN code",
  landmark: "Landmark",
  description: "Description",
  onlinePricePaise: "Online selling price",
  offlinePricePaise: "In-shop selling price",
  shopMrpPaise: "MRP (this shop only)",
  imageUrl: "Image",
  isAvailable: "Available",
  addProduct: "Add product to the shop",
};

export type ChangeItemInput =
  | { target: "SHOP"; field: ShopField; value: string | null }
  | { target: "SHOP_PRODUCT"; shopProductId: string; field: ProductField; value: string | number | boolean | null }
  | { target: "ADD_PRODUCT"; productId: string; onlinePricePaise: number | null; offlinePricePaise: number | null };

const PRICE_FIELDS = new Set<ProductField>(["onlinePricePaise", "offlinePricePaise", "shopMrpPaise"]);

/* ----------------------------------------------------------------- reading */

async function liveShopValue(shopId: string, field: ShopField): Promise<string | null> {
  const [row] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!row) throw notFound("Shop");
  const v = (row as Record<string, unknown>)[field];
  return v == null ? null : String(v);
}

async function liveProduct(shopProductId: string) {
  const [row] = await db
    .select({ sp: shopProducts, masterMrp: products.mrpPaise, name: products.name, shopMrp: shopListingDetails.mrpPaise })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
    .where(and(eq(shopProducts.id, shopProductId), isNull(shopProducts.deletedAt)));
  return row ?? null;
}

async function liveProductValue(shopProductId: string, field: ProductField): Promise<string | number | boolean | null> {
  const row = await liveProduct(shopProductId);
  if (!row) throw notFound("Product");
  if (field === "shopMrpPaise") return row.shopMrp ?? null;
  const v = (row.sp as Record<string, unknown>)[field];
  return (v as string | number | boolean | null) ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ---------------------------------------------------------------- validate */

function normaliseValue(item: ChangeItemInput): unknown {
  if (item.target === "ADD_PRODUCT") {
    for (const p of [item.onlinePricePaise, item.offlinePricePaise]) {
      if (p != null && (!Number.isInteger(p) || p <= 0)) throw validationFailed("Prices are whole paise above 0.");
    }
    if (item.onlinePricePaise == null && item.offlinePricePaise == null) throw validationFailed("Give an online or in-shop price for the new product.");
    return { productId: item.productId, onlinePricePaise: item.onlinePricePaise, offlinePricePaise: item.offlinePricePaise };
  }
  if (item.target === "SHOP") {
    if (!SHOP_FIELDS.includes(item.field)) throw validationFailed(`Support cannot propose a change to ${item.field}.`);
    const v = item.value == null ? null : String(item.value).trim();
    if ((item.field === "contactPhone" || item.field === "whatsappNumber") && v && !/^[6-9]\d{9}$/.test(v)) {
      throw validationFailed(`${FIELD_LABELS[item.field]}: a 10-digit Indian mobile number.`);
    }
    if (item.field === "pincode" && (!v || !/^[1-9]\d{5}$/.test(v))) throw validationFailed("PIN code: 6 digits, not starting with 0.");
    if (item.field === "name" && (!v || v.length < 2)) throw validationFailed("Shop name: at least 2 characters.");
    return v;
  }
  if (!PRODUCT_FIELDS.includes(item.field)) throw validationFailed(`Support cannot propose a change to ${item.field}.`);
  if (PRICE_FIELDS.has(item.field)) {
    const n = item.value == null ? null : Number(item.value);
    if (n == null || !Number.isInteger(n) || n <= 0) throw validationFailed(`${FIELD_LABELS[item.field]}: whole paise above 0.`);
    return n;
  }
  if (item.field === "isAvailable") return Boolean(item.value);
  return item.value == null ? null : String(item.value).trim();
}

/** Selling price must not exceed MRP — checked on the values the shop will have if every item is approved. */
async function assertPricesWithinMrp(shopId: string, items: ChangeItemInput[]): Promise<void> {
  const byProduct = new Map<string, Partial<Record<ProductField, unknown>>>();
  for (const i of items) {
    if (i.target !== "SHOP_PRODUCT") continue;
    byProduct.set(i.shopProductId, { ...(byProduct.get(i.shopProductId) ?? {}), [i.field]: normaliseValue(i) });
  }
  for (const [shopProductId, patch] of byProduct) {
    const row = await liveProduct(shopProductId);
    if (!row || row.sp.shopId !== shopId) throw validationFailed("A product in this change is not in this shop.");
    const mrp = (patch.shopMrpPaise as number | undefined) ?? row.shopMrp ?? row.masterMrp ?? null;
    for (const f of ["onlinePricePaise", "offlinePricePaise"] as const) {
      const price = (patch[f] as number | undefined) ?? row.sp[f];
      if (mrp != null && price != null && price > mrp) {
        throw validationFailed(`${row.name}: ${FIELD_LABELS[f].toLowerCase()} ₹${(price / 100).toFixed(2)} is above the MRP ₹${(mrp / 100).toFixed(2)}.`);
      }
    }
  }
}

/* ------------------------------------------------------------------ propose */

export interface ProposeInput {
  shopId: string;
  ticketId?: string | null;
  reason: string;
  items: ChangeItemInput[];
}

async function assertMayWorkOnShop(shopId: string, ticketId: string | null | undefined, actor: Actor): Promise<void> {
  if (actor.role === "ADMIN" || can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) return;
  // A Support User works only on shops of tickets assigned to them (brief §3.5).
  if (!ticketId) throw forbidden("Open the shop from a ticket assigned to you.");
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  if (!ticket || ticket.assignedToUserId !== actor.id) throw forbidden("This ticket is not assigned to you.");
  if (ticket.shopId !== shopId) throw forbidden("This ticket is about another shop.");
}

export async function proposeShopChanges(input: ProposeInput, actor: Actor): Promise<ApprovalRequest> {
  await requireFeatureForRole("rbac_v2_shop_change_requests", actor.role);
  if (!can(actor.role, PERMISSIONS.SHOP_CHANGE_PROPOSE)) throw forbidden("You cannot propose shop changes.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Say why these changes are proposed.", { fields: { reason: "At least 3 characters." } });
  if (input.items.length === 0) throw validationFailed("Nothing to change.");
  if (input.items.length > 2000) throw validationFailed("At most 2,000 changes in one request.");
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId, name: shops.name }).from(shops).where(and(eq(shops.id, input.shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  await assertMayWorkOnShop(shop.id, input.ticketId, actor);
  await assertPricesWithinMrp(shop.id, input.items);

  const items = [];
  for (const item of input.items) {
    const proposed = normaliseValue(item);
    if (item.target === "SHOP") {
      const previous = await liveShopValue(shop.id, item.field);
      if (same(previous, proposed)) continue;
      items.push({ entityType: "shop", entityId: shop.id, field: item.field, previousValue: previous, proposedValue: proposed });
    } else if (item.target === "SHOP_PRODUCT") {
      const previous = await liveProductValue(item.shopProductId, item.field);
      if (same(previous, proposed)) continue;
      items.push({ entityType: "shop_product", entityId: item.shopProductId, field: item.field, previousValue: previous, proposedValue: proposed });
    } else {
      const [existing] = await db
        .select({ id: shopProducts.id })
        .from(shopProducts)
        .where(and(eq(shopProducts.shopId, shop.id), eq(shopProducts.productId, item.productId), isNull(shopProducts.deletedAt)));
      if (existing) throw validationFailed("That product is already in the shop: propose a price change instead.");
      const [master] = await db.select({ id: products.id }).from(products).where(eq(products.id, item.productId));
      if (!master) throw notFound("Product");
      items.push({ entityType: "product", entityId: item.productId, field: "addProduct", previousValue: null, proposedValue: proposed });
    }
  }
  if (items.length === 0) throw validationFailed("Every proposed value is the same as the shop's current one.");

  const { expiryDays } = await getRule("rbacV2");
  const request = await submitApproval({
    type: SHOP_CHANGE,
    actor,
    subjectType: "shop",
    subjectId: shop.id,
    shopId: shop.id,
    title: `${items.length} change${items.length === 1 ? "" : "s"} to ${shop.name}`,
    reason,
    payload: { shopName: shop.name },
    items,
    expiresAt: new Date(Date.now() + expiryDays * 86_400_000),
    linkedTicketId: input.ticketId ?? null,
  });

  if (input.ticketId) {
    await db.transaction(async (tx) => {
      const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, input.ticketId!)).for("update");
      if (!ticket) return;
      await tx.update(supportTickets).set({ changeRequestId: request.id, subStatus: null, updatedAt: new Date() }).where(eq(supportTickets.id, ticket.id));
      const moved = await moveIfAllowed(tx, ticket, "AWAITING_SHOP", actor, `Waiting for the shop owner to approve ${items.length} change(s).`);
      await tellOperations(moved, "sent to the shop owner for approval");
    });
  }

  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_CHANGE_REQUESTED,
    title: "Changes to your shop need your approval",
    body: `GoKesari support proposed ${items.length} change${items.length === 1 ? "" : "s"} to ${shop.name}. Nothing changes until you approve. Reason: ${reason}`,
    actionUrl: "/shop/changes",
    channels: ["PUSH", "WHATSAPP"],
    dedupeKey: `shop-change:${request.id}:requested`,
  });
  return request;
}

/** Moves a linked ticket only when the move is allowed and changes something (the ticket may have moved on). */
async function moveIfAllowed(tx: Parameters<typeof moveTicket>[0], ticket: Parameters<typeof moveTicket>[1], to: TicketStatus, actor: Parameters<typeof moveTicket>[3], note: string) {
  if (ticket.status === to || !canMoveTicket(ticket.status as TicketStatus, to)) return ticket;
  return moveTicket(tx, ticket, to, actor, note);
}

/* -------------------------------------------------------------------- apply */

async function markSuperseded(tx: typeof db, request: ApprovalRequest, item: ApprovalRequestItem, why: string) {
  await tx.update(approvalRequestItems).set({ status: "SUPERSEDED", rejectionComment: why }).where(eq(approvalRequestItems.id, item.id));
  await tx.insert(approvalDecisions).values({ requestId: request.id, itemId: item.id, action: "SUPERSEDE", comment: why });
}

async function stillCurrent(item: ApprovalRequestItem): Promise<boolean> {
  if (item.entityType === "shop") return same(await liveShopValue(String(item.entityId), item.field as ShopField), item.previousValue);
  if (item.entityType === "shop_product") {
    const row = await liveProduct(String(item.entityId));
    if (!row) return false;
    return same(await liveProductValue(String(item.entityId), item.field as ProductField), item.previousValue);
  }
  return true;
}

async function applyShopChange(context: ApplyContext): Promise<void> {
  const { request } = context;
  const shopId = String(request.shopId);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  // Applied as the owner who approved: the owner's own rules apply, nothing more.
  const owner = { id: shop.ownerId, role: "SHOP_OWNER" as const };

  const applied: ApprovalRequestItem[] = [];
  const superseded: ApprovalRequestItem[] = [];
  const shopPatch: UpdateShopInput = {};
  const shopItems: ApprovalRequestItem[] = [];
  for (const item of context.approvedItems) {
    if (!(await stillCurrent(item))) {
      superseded.push(item);
      continue;
    }
    if (item.entityType === "shop") {
      (shopPatch as Record<string, unknown>)[item.field] = item.proposedValue;
      shopItems.push(item);
    }
  }
  if (shopItems.length) {
    await updateShop(shopId, shopPatch, owner);
    applied.push(...shopItems);
  }
  for (const item of context.approvedItems) {
    if (superseded.includes(item) || item.entityType === "shop") continue;
    if (item.entityType === "shop_product") {
      const id = String(item.entityId);
      if (item.field === "shopMrpPaise") {
        const previous = (await liveProduct(id))?.shopMrp ?? null;
        await db.transaction(async (tx) => {
          await tx
            .insert(shopListingDetails)
            .values({ shopProductId: id, shopId, mrpPaise: Number(item.proposedValue), updatedBy: owner.id })
            .onConflictDoUpdate({ target: shopListingDetails.shopProductId, set: { mrpPaise: Number(item.proposedValue), updatedBy: owner.id, updatedAt: new Date() } });
          await tx.insert(shopMrpHistory).values({
            shopId,
            shopProductId: id,
            previousMrpPaise: previous,
            newMrpPaise: Number(item.proposedValue),
            changedBy: owner.id,
            source: "CHANGE_REQUEST",
            approvalRequestId: request.id,
          });
        });
      } else {
        await updateShopProduct(id, { [item.field]: item.proposedValue } as never, owner);
      }
    } else if (item.entityType === "product") {
      const v = item.proposedValue as { productId: string; onlinePricePaise: number | null; offlinePricePaise: number | null };
      await createShopProduct(
        {
          shopId,
          productId: v.productId,
          onlinePricePaise: v.onlinePricePaise,
          offlinePricePaise: v.offlinePricePaise,
          onlineSaleEnabled: v.onlinePricePaise != null,
          offlineSaleEnabled: v.offlinePricePaise != null,
        },
        owner,
      );
    }
    applied.push(item);
  }

  await db.transaction(async (tx) => {
    for (const item of applied) await tx.update(approvalRequestItems).set({ finalValue: item.proposedValue as never }).where(eq(approvalRequestItems.id, item.id));
    for (const item of superseded) await markSuperseded(tx as never, request, item, "The shop changed this value after it was proposed.");
  });
  await afterOwnerDecision(request, { applied: applied.length, superseded: superseded.length });
}

/** Moves the linked ticket and tells the Support User what the owner decided. */
async function afterOwnerDecision(request: ApprovalRequest, counts: { applied: number; superseded: number }): Promise<void> {
  const { items } = await getApproval(request.id);
  const rejected = items.filter((i) => i.status === "REJECTED").length;
  const allApplied = counts.superseded === 0 && rejected === 0 && counts.applied > 0;
  if (request.linkedTicketId) {
    await db.transaction(async (tx) => {
      const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, request.linkedTicketId!)).for("update");
      if (!ticket || ticket.status === "CLOSED" || ticket.status === "RESOLVED") return;
      const note = allApplied
        ? `The shop owner approved all ${counts.applied} change(s); applied.`
        : `The shop owner decided: ${counts.applied} applied, ${rejected} rejected${counts.superseded ? `, ${counts.superseded} superseded` : ""}.`;
      if (allApplied) {
        await tx.update(supportTickets).set({ resolutionNote: note, updatedAt: new Date() }).where(eq(supportTickets.id, ticket.id));
        const moved = await moveIfAllowed(tx, { ...ticket, resolutionNote: note }, "RESOLVED", null, note);
        await tellOperations(moved, "resolved — please confirm");
      } else {
        await moveIfAllowed(tx, ticket, "IN_PROGRESS", null, note);
      }
    });
  }
  await notify({
    userId: request.requestedBy,
    type: NOTIFICATION_TYPES.STAFF_CHANGE_DECIDED,
    title: allApplied ? "Shop owner approved your changes" : "Shop owner decided on your changes",
    body: `${request.title}: ${counts.applied} applied, ${rejected} rejected${counts.superseded ? `, ${counts.superseded} superseded (the owner changed them meanwhile)` : ""}.`,
    actionUrl: request.linkedTicketId ? `/admin/support/${request.linkedTicketId}` : "/staff",
    dedupeKey: `shop-change:${request.id}:decided`,
  });
}

registerApprovalHandler({
  type: SHOP_CHANGE,
  checker: "SHOP_OWNER",
  itemDecisions: true,
  apply: applyShopChange,
  async onRejected(request) {
    await afterOwnerDecision(request, { applied: 0, superseded: 0 });
  },
});

/** Master product data is never written by Support: an admin decides, then applies it in the product master. */
registerApprovalHandler({
  type: MASTER_DATA_CORRECTION,
  checker: "ADMIN",
  async apply() {
    // Approval records the decision; the admin makes the correction in Product master (PMD), which keeps its own
    // history. No automatic write to the master shared by every retailer.
  },
});

export async function proposeMasterDataCorrection(
  input: { productId: string; field: string; proposedValue: string; reason: string; ticketId?: string | null },
  actor: Actor,
): Promise<ApprovalRequest> {
  await requireFeatureForRole("rbac_v2_shop_change_requests", actor.role);
  if (!can(actor.role, PERMISSIONS.MASTER_DATA_CORRECTION_PROPOSE)) throw forbidden("You cannot propose master data corrections.");
  const [product] = await db.select().from(products).where(eq(products.id, input.productId));
  if (!product) throw notFound("Product");
  const previous = (product as Record<string, unknown>)[input.field];
  if (previous === undefined) throw validationFailed("Unknown product field.");
  return submitApproval({
    type: MASTER_DATA_CORRECTION,
    actor,
    subjectType: "product",
    subjectId: product.id,
    title: `Master data: ${product.name} — ${input.field}`,
    reason: input.reason,
    items: [{ entityType: "product", entityId: product.id, field: input.field, previousValue: previous ?? null, proposedValue: input.proposedValue }],
    linkedTicketId: input.ticketId ?? null,
  });
}

/* -------------------------------------------------------------------- reads */

export interface OwnerChangeView {
  request: ApprovalRequest;
  items: (ApprovalRequestItem & { label: string; productName: string | null })[];
  proposedByName: string;
}

export async function listShopChangeRequests(shopId: string, actor: Actor, options: { history?: boolean } = {}): Promise<OwnerChangeView[]> {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && !can(actor.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) throw forbidden("This shop does not belong to you.");
  const requests = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.shopId, shopId),
        eq(approvalRequests.type, SHOP_CHANGE),
        options.history ? sql`${approvalRequests.status} <> 'PENDING'` : eq(approvalRequests.status, "PENDING"),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(50);
  if (requests.length === 0) return [];
  const items = await db
    .select()
    .from(approvalRequestItems)
    .where(inArray(approvalRequestItems.requestId, requests.map((r) => r.id)))
    .orderBy(asc(approvalRequestItems.position));
  const spIds = items.filter((i) => i.entityType === "shop_product").map((i) => String(i.entityId));
  const pIds = items.filter((i) => i.entityType === "product").map((i) => String(i.entityId));
  const spNames = spIds.length
    ? await db.select({ id: shopProducts.id, name: products.name }).from(shopProducts).innerJoin(products, eq(products.id, shopProducts.productId)).where(inArray(shopProducts.id, spIds))
    : [];
  const pNames = pIds.length ? await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, pIds)) : [];
  const nameOf = new Map([...spNames, ...pNames].map((r) => [r.id, r.name]));
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(requests.map((r) => r.requestedBy))]));
  const who = new Map(people.map((p) => [p.id, p.name ?? "GoKesari support"]));
  return requests.map((request) => ({
    request,
    proposedByName: who.get(request.requestedBy) ?? "GoKesari support",
    items: items
      .filter((i) => i.requestId === request.id)
      .map((i) => ({ ...i, label: FIELD_LABELS[i.field as keyof typeof FIELD_LABELS] ?? i.field, productName: i.entityType === "shop" ? null : nameOf.get(String(i.entityId)) ?? null })),
  }));
}

/* -------------------------------------------------------------------- sweep */

/** Hourly: superseded items, reminders at 24 h / 72 h, expiry after 7 days. Nothing is ever applied here. */
export async function sweepShopChangeRequests(now = new Date()): Promise<{ reminded: number; expired: number; superseded: number }> {
  if (!(await isFeatureEnabled("rbac_v2_shop_change_requests"))) return { reminded: 0, expired: 0, superseded: 0 };
  const { reminderHours } = await getRule("rbacV2");
  const pending = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, SHOP_CHANGE), eq(approvalRequests.status, "PENDING")));
  let reminded = 0;
  let expired = 0;
  let supersededCount = 0;
  for (const request of pending) {
    const [shop] = await db.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, String(request.shopId)));
    if (!shop) continue;

    if (request.expiresAt && request.expiresAt <= now) {
      await db.transaction(async (tx) => {
        await tx.update(approvalRequests).set({ status: "EXPIRED", updatedAt: now }).where(and(eq(approvalRequests.id, request.id), eq(approvalRequests.status, "PENDING")));
        await tx.update(approvalRequestItems).set({ status: "EXPIRED" }).where(and(eq(approvalRequestItems.requestId, request.id), eq(approvalRequestItems.status, "PENDING")));
        await tx.insert(approvalDecisions).values({ requestId: request.id, action: "EXPIRE", comment: "No decision from the shop owner in time; nothing applied." });
        if (request.linkedTicketId) {
          const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, request.linkedTicketId)).for("update");
          if (ticket && ticket.status !== "CLOSED" && ticket.status !== "RESOLVED") {
            await tx.update(supportTickets).set({ subStatus: "PENDING_INFORMATION", updatedAt: now }).where(eq(supportTickets.id, ticket.id));
            await moveIfAllowed(tx, ticket, "IN_PROGRESS", null, "The shop owner did not decide on the proposed changes in time: Pending Information.");
          }
        }
      });
      await recordAudit({ action: AUDIT_ACTIONS.APPROVAL_DECIDED, entityType: "approval_request", entityId: request.id, newValue: { status: "EXPIRED" } });
      const managers = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "SUPPORT_MANAGER"), eq(users.status, "ACTIVE")));
      for (const m of [...managers.map((x) => x.id), request.requestedBy]) {
        await notify({
          userId: m,
          type: NOTIFICATION_TYPES.STAFF_CHANGE_DECIDED,
          title: "Shop change request expired",
          body: `${request.title}: the owner did not decide in time. Nothing was applied; the ticket is Pending Information.`,
          actionUrl: request.linkedTicketId ? `/admin/support/${request.linkedTicketId}` : "/staff",
          dedupeKey: `shop-change:${request.id}:expired:${m}`,
        });
      }
      expired += 1;
      continue;
    }

    // Superseded: the owner changed a field after it was proposed.
    const items = await db.select().from(approvalRequestItems).where(and(eq(approvalRequestItems.requestId, request.id), eq(approvalRequestItems.status, "PENDING")));
    const stale: ApprovalRequestItem[] = [];
    for (const item of items) if (!(await stillCurrent(item))) stale.push(item);
    if (stale.length) {
      await db.transaction(async (tx) => {
        for (const item of stale) await markSuperseded(tx as never, request, item, "The shop owner changed this value after it was proposed.");
        if (stale.length === items.length) {
          await tx.update(approvalRequests).set({ status: "SUPERSEDED", updatedAt: now }).where(eq(approvalRequests.id, request.id));
        }
      });
      supersededCount += stale.length;
      await notify({
        userId: request.requestedBy,
        type: NOTIFICATION_TYPES.STAFF_CHANGE_DECIDED,
        title: "Proposed change superseded",
        body: `${request.title}: the shop owner changed ${stale.length} of the proposed field(s) themselves. Check and propose again if needed.`,
        actionUrl: request.linkedTicketId ? `/admin/support/${request.linkedTicketId}` : "/staff",
        dedupeKey: `shop-change:${request.id}:superseded:${stale.map((s) => s.id).join(",")}`.slice(0, 200),
      });
      if (stale.length === items.length) {
        if (request.linkedTicketId) {
          await db.transaction(async (tx) => {
            const [ticket] = await tx.select().from(supportTickets).where(eq(supportTickets.id, request.linkedTicketId!)).for("update");
            if (ticket && ticket.status === "AWAITING_SHOP") await moveIfAllowed(tx, ticket, "IN_PROGRESS", null, "Every proposed change was superseded by the shop owner's own edits.");
          });
        }
        continue;
      }
    }

    // Reminders.
    const ageHours = (now.getTime() - request.requestedAt.getTime()) / 3_600_000;
    const [{ n: sent }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalDecisions)
      .where(and(eq(approvalDecisions.requestId, request.id), eq(approvalDecisions.action, "REMIND")));
    const due = reminderHours.filter((h) => ageHours >= h).length;
    if (due > sent) {
      await db.insert(approvalDecisions).values({ requestId: request.id, action: "REMIND", comment: `Reminder ${sent + 1} to the shop owner` });
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.SHOP_CHANGE_REMINDER,
        title: "Changes to your shop still need your approval",
        body: `${request.title} — waiting since ${request.requestedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Nothing changes until you decide.`,
        actionUrl: "/shop/changes",
        channels: ["PUSH", "WHATSAPP"],
        dedupeKey: `shop-change:${request.id}:remind:${sent + 1}`,
      });
      reminded += 1;
    }
  }
  return { reminded, expired, superseded: supersededCount };
}

/** For pages: has this request already got a conflict with live data (shown as a warning to the owner)? */
export async function staleItemIds(requestId: string): Promise<Set<string>> {
  const items = await db.select().from(approvalRequestItems).where(and(eq(approvalRequestItems.requestId, requestId), eq(approvalRequestItems.status, "PENDING")));
  const out = new Set<string>();
  for (const i of items) if (!(await stillCurrent(i))) out.add(i.id);
  return out;
}
