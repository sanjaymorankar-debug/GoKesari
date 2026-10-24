/**
 * Purchase lists (docs/purchase-lists-2026-10).
 *
 * A customer keeps named lists of what they buy every week or every month — a
 * shopping list ("Monthly groceries") or a medicines list ("Papa's BP
 * tablets"). Each period they adjust the quantities (0 = skip it this time),
 * "check" the list — live prices, availability and delivery fees, priced
 * exactly as the cart prices them — and on confirmation the list goes to the
 * cart, where the usual checkout takes the address and payment and places the
 * order. Nothing about price is stored on a list.
 *
 * Seller / customer split: the lists are customer tables; shop_product_id
 * points at the seller database without a foreign key, so it is checked
 * before an item is written and a product that has since gone is shown as
 * "no longer sold" rather than hidden.
 */
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { lineTotalPaise } from "@/lib/money";
import { LIST_LIMITS, nextDueAt, normaliseListName, type ListFrequency, type ListKind } from "@/lib/purchase-lists";
import { db, type DbClient } from "@/server/db";
import {
  cartItems,
  carts,
  productCategories,
  products,
  purchaseListItems,
  purchaseLists,
  shopProducts,
  shops,
  users,
  type PurchaseList,
} from "@/server/db/schema";
import { isUniqueViolation } from "@/server/db/split/upsert";
import { isOnlinePurchasable } from "./catalogue";
import {
  describeUnavailability,
  getOrCreateCart,
  lockCart,
  priceLines,
  type CartSummary,
  type LineToPrice,
} from "./cart";
import { NOTIFICATION_TYPES, notify } from "./notifications";

/* ------------------------------------------------------------------ types */

export interface PurchaseListSummary {
  id: string;
  name: string;
  kind: ListKind;
  frequency: ListFrequency;
  remind: boolean;
  lastOrderedAt: Date | null;
  nextDueAt: Date;
  /** Products on the list, and how many of them are to be ordered this time (quantity above 0). */
  itemCount: number;
  activeItemCount: number;
  createdAt: Date;
}

export interface PurchaseListItemView {
  itemId: string;
  shopProductId: string;
  quantity: number;
  note: string | null;
  /** False when the shop no longer has this product at all. */
  exists: boolean;
  productName: string;
  categoryName: string | null;
  unit: string | null;
  unitSizeMilli: number | null;
  imageUrl: string | null;
  shop: { id: string; name: string; slug: string } | null;
  /** Today's online price for one unit, or null when it is not sold online now. */
  unitPricePaise: number | null;
  /** unitPrice × quantity, before offers and delivery (the check gives the exact total). */
  lineTotalPaise: number;
  /** Can be ordered online at this quantity right now. */
  purchasable: boolean;
  unavailableReason: string | null;
}

export interface PurchaseListDetail extends PurchaseListSummary {
  items: PurchaseListItemView[];
  /** Sum of the purchasable lines' estimates — before offers and delivery fees. */
  estimatedSubtotalPaise: number;
}

/** The "check": the list priced as the cart would price it, before it goes to the cart. */
export interface PurchaseListCheck {
  listId: string;
  listName: string;
  /** Lines to be ordered (quantity above 0), grouped by shop — same shape and totals as the cart. */
  preview: Omit<CartSummary, "cartId">;
  /** Items kept on the list but left out this time (quantity 0). */
  skipped: { itemId: string; productName: string }[];
  /** Items whose product the shop no longer has. */
  missing: { itemId: string; productName: string }[];
  /** Units already in the customer's cart: the confirmation asks to add to them or replace them. */
  cartItemCount: number;
}

export type ListToCartMode = "ADD" | "REPLACE";

export interface ListToCartResult {
  added: { shopProductId: string; productName: string; quantity: number }[];
  notAdded: { shopProductId: string; productName: string; reason: string }[];
  cartItemCount: number;
}

/* ------------------------------------------------------------------ lists */

const LIST_NAME_UNIQUE = "purchase_lists_user_name_unique";

function isDuplicateName(error: unknown): boolean {
  // Matched by name in the message too: the constraint name is not always passed through.
  if (!isUniqueViolation(error)) return false;
  const e = error as { constraint_name?: string; message?: string; cause?: { constraint_name?: string; message?: string } };
  const text = `${e.constraint_name ?? ""} ${e.message ?? ""} ${e.cause?.constraint_name ?? ""} ${e.cause?.message ?? ""}`;
  return text.includes(LIST_NAME_UNIQUE);
}

function checkName(raw: string): string {
  const name = normaliseListName(raw);
  if (!name) throw validationFailed("Give the list a name.");
  if (name.length > LIST_LIMITS.nameLength) {
    throw validationFailed(`Keep the name to ${LIST_LIMITS.nameLength} characters.`);
  }
  return name;
}

function checkNote(raw: string | null | undefined): string | null {
  const note = raw?.trim() ?? "";
  if (note.length > LIST_LIMITS.noteLength) {
    throw validationFailed(`Keep the note to ${LIST_LIMITS.noteLength} characters.`);
  }
  return note || null;
}

function checkQuantity(quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > LIST_LIMITS.maxQuantity) {
    throw validationFailed(`Quantity must be a whole number from 0 to ${LIST_LIMITS.maxQuantity}.`);
  }
  return quantity;
}

function summarise(list: PurchaseList, itemCount: number, activeItemCount: number): PurchaseListSummary {
  return {
    id: list.id,
    name: list.name,
    kind: list.kind,
    frequency: list.frequency,
    remind: list.remind,
    lastOrderedAt: list.lastOrderedAt,
    nextDueAt: nextDueAt(list),
    itemCount,
    activeItemCount,
    createdAt: list.createdAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids come from the URL: one that is not a uuid names nothing, and must not reach PostgreSQL as invalid input. */
function assertId(id: string, what: string): void {
  if (!UUID.test(id)) throw notFound(what);
}

/** The list, if it is this customer's; otherwise "not found" (never "forbidden", so ids cannot be probed). */
async function ownList(userId: string, listId: string, client: DbClient = db): Promise<PurchaseList> {
  assertId(listId, "List");
  const [list] = await client
    .select()
    .from(purchaseLists)
    .where(and(eq(purchaseLists.id, listId), eq(purchaseLists.userId, userId)));
  if (!list) throw notFound("List");
  return list;
}

export async function listPurchaseLists(userId: string): Promise<PurchaseListSummary[]> {
  const lists = await db
    .select()
    .from(purchaseLists)
    .where(eq(purchaseLists.userId, userId))
    .orderBy(asc(purchaseLists.createdAt), asc(purchaseLists.id));
  if (lists.length === 0) return [];

  const counts = await db
    .select({
      listId: purchaseListItems.listId,
      items: count(),
      active: sql<number>`count(*) filter (where ${purchaseListItems.quantity} > 0)`.mapWith(Number),
    })
    .from(purchaseListItems)
    .where(inArray(purchaseListItems.listId, lists.map((l) => l.id)))
    .groupBy(purchaseListItems.listId);
  const byList = new Map(counts.map((c) => [c.listId, c]));
  return lists.map((list) => summarise(list, byList.get(list.id)?.items ?? 0, byList.get(list.id)?.active ?? 0));
}

export interface SaveListInput {
  name: string;
  kind?: ListKind;
  frequency?: ListFrequency;
  remind?: boolean;
}

export async function createPurchaseList(
  userId: string,
  input: SaveListInput,
  client?: DbClient,
): Promise<PurchaseListSummary> {
  if (!client) return db.transaction((tx) => createPurchaseList(userId, input, tx));
  const name = checkName(input.name);
  // One create per customer at a time, so simultaneous creates cannot pass the cap (core database).
  await client.execute(sql`select pg_advisory_xact_lock(hashtext(${`purchase-lists:${userId}`}))`);
  const [{ lists }] = await client
    .select({ lists: count() })
    .from(purchaseLists)
    .where(eq(purchaseLists.userId, userId));
  if (lists >= LIST_LIMITS.listsPerUser) {
    throw conflict(`You can keep up to ${LIST_LIMITS.listsPerUser} lists. Delete one you no longer use first.`);
  }
  try {
    const [list] = await client
      .insert(purchaseLists)
      .values({
        userId,
        name,
        kind: input.kind ?? "SHOPPING",
        frequency: input.frequency ?? "MONTHLY",
        remind: input.remind ?? true,
      })
      .returning();
    return summarise(list, 0, 0);
  } catch (error) {
    if (isDuplicateName(error)) throw conflict(`You already have a list called "${name}".`);
    throw error;
  }
}

export async function updatePurchaseList(
  userId: string,
  listId: string,
  input: Partial<SaveListInput>,
): Promise<PurchaseListSummary> {
  await ownList(userId, listId);
  const changes: Partial<typeof purchaseLists.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) changes.name = checkName(input.name);
  if (input.kind !== undefined) changes.kind = input.kind;
  if (input.frequency !== undefined) changes.frequency = input.frequency;
  if (input.remind !== undefined) changes.remind = input.remind;
  try {
    await db.update(purchaseLists).set(changes).where(eq(purchaseLists.id, listId));
  } catch (error) {
    if (isDuplicateName(error)) throw conflict(`You already have a list called "${changes.name}".`);
    throw error;
  }
  return getPurchaseList(userId, listId);
}

export async function deletePurchaseList(userId: string, listId: string): Promise<void> {
  await ownList(userId, listId);
  await db.transaction(async (tx) => {
    // Both are customer tables (the foreign key cascades too); deleted explicitly all the same.
    await tx.delete(purchaseListItems).where(eq(purchaseListItems.listId, listId));
    await tx.delete(purchaseLists).where(eq(purchaseLists.id, listId));
  });
}

/* ------------------------------------------------------------------ items */

interface ItemRow {
  item: typeof purchaseListItems.$inferSelect;
  sp: typeof shopProducts.$inferSelect | null;
  product: typeof products.$inferSelect | null;
  category: typeof productCategories.$inferSelect | null;
  shop: typeof shops.$inferSelect | null;
}

/** The list's items with their products as the shops have them now (left joins: a product may be gone). */
async function loadItemRows(listId: string, client: DbClient = db): Promise<ItemRow[]> {
  return client
    .select({
      item: purchaseListItems,
      sp: shopProducts,
      product: products,
      category: productCategories,
      shop: shops,
    })
    .from(purchaseListItems)
    .leftJoin(shopProducts, eq(purchaseListItems.shopProductId, shopProducts.id))
    .leftJoin(products, eq(shopProducts.productId, products.id))
    .leftJoin(productCategories, eq(products.categoryId, productCategories.id))
    .leftJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(purchaseListItems.listId, listId))
    .orderBy(asc(purchaseListItems.createdAt), asc(purchaseListItems.id));
}

/** A row whose shop product, product, category and shop all still exist. */
function isComplete(row: ItemRow): row is ItemRow & { sp: NonNullable<ItemRow["sp"]>; product: NonNullable<ItemRow["product"]>; category: NonNullable<ItemRow["category"]>; shop: NonNullable<ItemRow["shop"]> } {
  return Boolean(row.sp && row.product && row.category && row.shop && !row.shop.deletedAt);
}

function purchasabilityOf(sp: NonNullable<ItemRow["sp"]>, shopStatus: string) {
  return {
    shopStatus,
    isActive: sp.isActive,
    isAvailable: sp.isAvailable,
    onlineSaleEnabled: sp.onlineSaleEnabled,
    onlinePricePaise: sp.onlinePricePaise,
    trackInventory: sp.trackInventory,
    onlineStock: sp.onlineStock,
  };
}

function itemView(row: ItemRow): PurchaseListItemView {
  if (!isComplete(row)) {
    return {
      itemId: row.item.id,
      shopProductId: row.item.shopProductId,
      quantity: row.item.quantity,
      note: row.item.note,
      exists: false,
      productName: row.product?.name ?? "A product the shop no longer sells",
      categoryName: row.category?.name ?? null,
      unit: row.product?.unit ?? null,
      unitSizeMilli: row.product?.unitSizeMilli ?? null,
      imageUrl: row.sp?.imageUrl ?? row.product?.imageUrl ?? null,
      shop: row.shop ? { id: row.shop.id, name: row.shop.name, slug: row.shop.slug } : null,
      unitPricePaise: null,
      lineTotalPaise: 0,
      purchasable: false,
      unavailableReason: "No longer sold by this shop.",
    };
  }
  // A skipped item (0) is checked for one unit, so the customer still sees whether it can be bought.
  const units = Math.max(1, row.item.quantity);
  const purchasable = isOnlinePurchasable(purchasabilityOf(row.sp, row.shop.status), units);
  const unitPrice = row.sp.onlineSaleEnabled ? row.sp.onlinePricePaise : null;
  return {
    itemId: row.item.id,
    shopProductId: row.item.shopProductId,
    quantity: row.item.quantity,
    note: row.item.note,
    exists: true,
    productName: row.product.name,
    categoryName: row.category.name,
    unit: row.product.unit,
    unitSizeMilli: row.product.unitSizeMilli,
    imageUrl: row.sp.imageUrl ?? row.product.imageUrl,
    shop: { id: row.shop.id, name: row.shop.name, slug: row.shop.slug },
    unitPricePaise: unitPrice,
    lineTotalPaise:
      unitPrice != null && purchasable && row.item.quantity > 0
        ? lineTotalPaise(unitPrice, row.item.quantity * row.product.unitSizeMilli)
        : 0,
    purchasable,
    unavailableReason: purchasable ? null : describeUnavailability(row.shop.status, row.sp),
  };
}

export async function getPurchaseList(userId: string, listId: string): Promise<PurchaseListDetail> {
  const list = await ownList(userId, listId);
  const items = (await loadItemRows(listId)).map(itemView);
  return {
    ...summarise(list, items.length, items.filter((i) => i.quantity > 0).length),
    items,
    estimatedSubtotalPaise: items.reduce((sum, i) => sum + i.lineTotalPaise, 0),
  };
}

/**
 * Throws unless customers can see the shop product: an active listing of an
 * approved shop (it lives in the seller database: no foreign key to check it).
 * Anything else is "not found", so a list cannot be used to look up a hidden
 * shop's products. Items already on a list stay when a shop is later suspended.
 */
async function assertShopProductListable(shopProductId: string, client: DbClient): Promise<void> {
  const [row] = await client
    .select({ id: shopProducts.id })
    .from(shopProducts)
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(
      and(
        eq(shopProducts.id, shopProductId),
        eq(shopProducts.isActive, true),
        eq(shops.status, "APPROVED"),
        sql`${shops.deletedAt} is null`,
      ),
    );
  if (!row) throw notFound("Product");
}

export interface AddItemResult {
  item: PurchaseListItemView;
  /** True when the product was already on the list: it is left as it was. */
  alreadyOnList: boolean;
}

export async function addPurchaseListItem(
  userId: string,
  listId: string,
  input: { shopProductId: string; quantity?: number; note?: string | null },
): Promise<AddItemResult> {
  await ownList(userId, listId);
  const quantity = checkQuantity(input.quantity ?? 1);
  const note = checkNote(input.note);
  await assertShopProductListable(input.shopProductId, db);

  // The list row is locked while its items are counted, so simultaneous adds cannot pass the cap.
  const alreadyOnList = await db.transaction(async (tx) => {
    await tx.select({ id: purchaseLists.id }).from(purchaseLists).where(eq(purchaseLists.id, listId)).for("update");
    const [existing] = await tx
      .select({ id: purchaseListItems.id })
      .from(purchaseListItems)
      .where(and(eq(purchaseListItems.listId, listId), eq(purchaseListItems.shopProductId, input.shopProductId)));
    if (existing) return true;
    const [{ items }] = await tx
      .select({ items: count() })
      .from(purchaseListItems)
      .where(eq(purchaseListItems.listId, listId));
    if (items >= LIST_LIMITS.itemsPerList) {
      throw conflict(`A list can hold up to ${LIST_LIMITS.itemsPerList} products. Start another list for the rest.`);
    }
    await tx.insert(purchaseListItems).values({ listId, shopProductId: input.shopProductId, quantity, note });
    await tx.update(purchaseLists).set({ updatedAt: new Date() }).where(eq(purchaseLists.id, listId));
    return false;
  });
  const view = (await loadItemRows(listId)).find((r) => r.item.shopProductId === input.shopProductId);
  if (!view) throw notFound("List item");
  return { item: itemView(view), alreadyOnList };
}

export async function updatePurchaseListItem(
  userId: string,
  listId: string,
  itemId: string,
  input: { quantity?: number; note?: string | null },
): Promise<PurchaseListItemView> {
  await ownList(userId, listId);
  assertId(itemId, "List item");
  const changes: Partial<typeof purchaseListItems.$inferInsert> = { updatedAt: new Date() };
  if (input.quantity !== undefined) changes.quantity = checkQuantity(input.quantity);
  if (input.note !== undefined) changes.note = checkNote(input.note);
  const [updated] = await db
    .update(purchaseListItems)
    .set(changes)
    .where(and(eq(purchaseListItems.id, itemId), eq(purchaseListItems.listId, listId)))
    .returning({ id: purchaseListItems.id });
  if (!updated) throw notFound("List item");
  await touchList(listId);
  const row = (await loadItemRows(listId)).find((r) => r.item.id === itemId);
  if (!row) throw notFound("List item");
  return itemView(row);
}

export async function removePurchaseListItem(userId: string, listId: string, itemId: string): Promise<void> {
  await ownList(userId, listId);
  assertId(itemId, "List item");
  const deleted = await db
    .delete(purchaseListItems)
    .where(and(eq(purchaseListItems.id, itemId), eq(purchaseListItems.listId, listId)))
    .returning({ id: purchaseListItems.id });
  if (deleted.length === 0) throw notFound("List item");
  await touchList(listId);
}

async function touchList(listId: string): Promise<void> {
  await db.update(purchaseLists).set({ updatedAt: new Date() }).where(eq(purchaseLists.id, listId));
}

/**
 * "Save my cart as a list": copies the cart's lines into an existing list of
 * the customer's, or into a new one. A product already on the list takes the
 * cart's quantity — the cart is what the customer just chose.
 */
export async function saveCartToList(
  userId: string,
  target: { listId: string } | SaveListInput,
): Promise<PurchaseListDetail> {
  const cart = await getOrCreateCart(userId);
  const lines = await db
    .select({ shopProductId: cartItems.shopProductId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.cartId, cart.id));
  if (lines.length === 0) throw validationFailed("Your cart is empty — add products first.");

  if ("listId" in target) await ownList(userId, target.listId);

  // A new list is created in the same transaction that fills it, so a refusal leaves no empty list behind.
  const listId = await db.transaction(async (tx) => {
    const listId = "listId" in target ? target.listId : (await createPurchaseList(userId, target, tx)).id;
    // Locked while its items are counted, as when adding one product.
    await tx.select({ id: purchaseLists.id }).from(purchaseLists).where(eq(purchaseLists.id, listId)).for("update");
    const existing = await tx
      .select({ id: purchaseListItems.id, shopProductId: purchaseListItems.shopProductId })
      .from(purchaseListItems)
      .where(eq(purchaseListItems.listId, listId));
    const byProduct = new Map(existing.map((e) => [e.shopProductId, e.id]));
    const newLines = lines.filter((l) => !byProduct.has(l.shopProductId));
    if (existing.length + newLines.length > LIST_LIMITS.itemsPerList) {
      throw conflict(`A list can hold up to ${LIST_LIMITS.itemsPerList} products. Start another list for the rest.`);
    }
    for (const line of lines) {
      const quantity = Math.min(LIST_LIMITS.maxQuantity, line.quantity);
      const itemId = byProduct.get(line.shopProductId);
      if (itemId) {
        await tx.update(purchaseListItems).set({ quantity, updatedAt: new Date() }).where(eq(purchaseListItems.id, itemId));
      } else {
        await tx.insert(purchaseListItems).values({ listId, shopProductId: line.shopProductId, quantity }).onConflictDoNothing();
      }
    }
    await tx.update(purchaseLists).set({ updatedAt: new Date() }).where(eq(purchaseLists.id, listId));
    return listId;
  });
  return getPurchaseList(userId, listId);
}

/* ------------------------------------------------------- check and order */

/**
 * Prices the list as it stands — the quantities the customer set for this
 * time, today's prices, offers, stock and delivery fees — exactly as the cart
 * would. Nothing is written.
 */
export async function checkPurchaseList(userId: string, listId: string): Promise<PurchaseListCheck> {
  const list = await ownList(userId, listId);
  const rows = await loadItemRows(listId);

  const toPrice: LineToPrice[] = [];
  const skipped: PurchaseListCheck["skipped"] = [];
  const missing: PurchaseListCheck["missing"] = [];
  for (const row of rows) {
    if (!isComplete(row)) {
      missing.push({ itemId: row.item.id, productName: row.product?.name ?? "A product the shop no longer sells" });
    } else if (row.item.quantity === 0) {
      skipped.push({ itemId: row.item.id, productName: row.product.name });
    } else {
      toPrice.push({ lineId: row.item.id, quantity: row.item.quantity, sp: row.sp, product: row.product, category: row.category, shop: row.shop });
    }
  }

  const [{ units }] = await db
    .select({ units: sql<number>`coalesce(sum(${cartItems.quantity}), 0)`.mapWith(Number) })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(eq(carts.userId, userId));

  return {
    listId: list.id,
    listName: list.name,
    preview: await priceLines(toPrice),
    skipped,
    missing,
    cartItemCount: units,
  };
}

/**
 * The customer confirmed the check: the list's lines (quantity above 0) go to
 * the cart — added to what is there, or replacing it — and the customer
 * finishes at checkout (address, delivery time, payment). A line that cannot
 * be bought online at that quantity right now is left out and reported, never
 * silently changed. The list is marked ordered, which moves its due date on.
 *
 * Everything is decided before anything is written: with nothing to order the
 * request is refused, and when no line can go in the cart is left exactly as
 * it was — REPLACE never empties a cart for nothing.
 */
export async function sendPurchaseListToCart(
  userId: string,
  listId: string,
  mode: ListToCartMode,
): Promise<ListToCartResult> {
  await ownList(userId, listId);

  // Built inside the transaction and returned from it, so a re-run on the split layout starts clean.
  return db.transaction(async (tx) => {
    // One send of a list at a time: a second send waits for the first, then adds the list again on
    // top of it (ADD) — the page disables "Confirm order" while it is sending.
    await tx.select({ id: purchaseLists.id }).from(purchaseLists).where(eq(purchaseLists.id, listId)).for("update");
    const wanted = (await loadItemRows(listId, tx)).filter((row) => row.item.quantity > 0);
    if (wanted.length === 0) {
      throw validationFailed("Nothing to order: set a quantity above 0 for at least one product.");
    }

    // The cart's lock, as an add takes it: an add at the same moment waits, or this waits for it (TC-LIST-021).
    const cart = await lockCart(userId, tx);
    const inCart = await tx
      .select({ id: cartItems.id, shopProductId: cartItems.shopProductId, quantity: cartItems.quantity })
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id));
    // What each line will be added to: the cart as it is (ADD), or nothing (REPLACE).
    const base = new Map(mode === "ADD" ? inCart.map((l) => [l.shopProductId, l]) : []);

    const added: ListToCartResult["added"] = [];
    const notAdded: ListToCartResult["notAdded"] = [];
    const writes: { shopProductId: string; quantity: number; cartItemId: string | null }[] = [];
    for (const row of wanted) {
      if (!isComplete(row)) {
        notAdded.push({ shopProductId: row.item.shopProductId, productName: row.product?.name ?? "A product the shop no longer sells", reason: "No longer sold by this shop." });
        continue;
      }
      const current = base.get(row.item.shopProductId);
      const already = current?.quantity ?? 0;
      const quantity = Math.min(LIST_LIMITS.maxQuantity, already + row.item.quantity);
      if (quantity <= already) {
        notAdded.push({
          shopProductId: row.item.shopProductId,
          productName: row.product.name,
          reason: `Your cart already has ${already} — the most one line can hold.`,
        });
        continue;
      }
      if (!isOnlinePurchasable(purchasabilityOf(row.sp, row.shop.status), quantity)) {
        notAdded.push({
          shopProductId: row.item.shopProductId,
          productName: row.product.name,
          reason: describeUnavailability(row.shop.status, row.sp),
        });
        continue;
      }
      writes.push({ shopProductId: row.item.shopProductId, quantity, cartItemId: current?.id ?? null });
      // What really went in: less than the list's quantity when the line hit the cart's cap.
      added.push({ shopProductId: row.item.shopProductId, productName: row.product.name, quantity: quantity - already });
    }

    const unitsNow = inCart.reduce((n, l) => n + l.quantity, 0);
    if (writes.length === 0) return { added, notAdded, cartItemCount: unitsNow };

    if (mode === "REPLACE") await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    for (const write of writes) {
      if (write.cartItemId) {
        await tx.update(cartItems).set({ quantity: write.quantity, updatedAt: new Date() }).where(eq(cartItems.id, write.cartItemId));
      } else {
        await tx.insert(cartItems).values({ cartId: cart.id, shopProductId: write.shopProductId, quantity: write.quantity });
      }
    }
    await tx.update(purchaseLists).set({ lastOrderedAt: new Date(), updatedAt: new Date() }).where(eq(purchaseLists.id, listId));
    const [{ units }] = await tx
      .select({ units: sql<number>`coalesce(sum(${cartItems.quantity}), 0)`.mapWith(Number) })
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id));
    return { added, notAdded, cartItemCount: units };
  });
}

/* -------------------------------------------------------------- reminders */

/**
 * Daily: an in-app reminder for each list that is due again (a week or a
 * month after it was last ordered), once per due date. Only lists with
 * something on them and the reminder left on.
 */
export async function sendPurchaseListReminders(now: Date = new Date()): Promise<{ reminded: number }> {
  const candidates = await db
    .select({ list: purchaseLists })
    .from(purchaseLists)
    .innerJoin(users, eq(users.id, purchaseLists.userId))
    .where(
      and(
        eq(purchaseLists.remind, true),
        // Not to suspended or deleted accounts.
        eq(users.status, "ACTIVE"),
        sql`exists (select 1 from ${purchaseListItems} where ${purchaseListItems.listId} = ${purchaseLists.id} and ${purchaseListItems.quantity} > 0)`,
      ),
    );

  let reminded = 0;
  for (const { list } of candidates) {
    const due = nextDueAt(list);
    if (due > now) continue;
    if (list.lastRemindedAt && list.lastRemindedAt >= due) continue;
    await notify({
      userId: list.userId,
      type: NOTIFICATION_TYPES.PURCHASE_LIST_DUE,
      vars: { listName: list.name, frequency: list.frequency === "WEEKLY" ? "weekly" : "monthly" },
      actionUrl: `/lists/${list.id}`,
      dedupeKey: `list.due:${list.id}:${due.toISOString().slice(0, 10)}`,
    });
    await db.update(purchaseLists).set({ lastRemindedAt: now }).where(eq(purchaseLists.id, list.id));
    reminded += 1;
  }
  return { reminded };
}
