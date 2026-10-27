/**
 * Shop types = the built-in ones in `src/lib/shop-types.ts` plus those staff add
 * (`shop_types` table). Staff-added types need no deploy: the type columns on
 * shops, commission rates and product categories are plain text. Changing a
 * type's name, goods, food flag or status never touches shops that already use it.
 */
import { asc, eq, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  isFoodBusinessShopType,
  registerCustomShopTypes,
  SHOP_TYPES,
  type CustomShopType,
} from "@/lib/shop-types";
import { db } from "@/server/db";
import { shopTypes, type ShopTypeRow, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

const isStaff = (role: UserRole) => role === "OPERATOR" || role === "ADMIN";

export interface ShopTypeOption {
  key: string;
  label: string;
  standardGoods: readonly string[];
  isFood: boolean;
  builtIn: boolean;
  status: "ACTIVE" | "INACTIVE";
}

const keyOf = (label: string) =>
  label
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

const cleanGoods = (goods: readonly string[] | undefined) =>
  [...new Set((goods ?? []).map((g) => g.trim()).filter(Boolean))].slice(0, 40).map((g) => g.slice(0, 80));

const CACHE_MS = 30_000;
let cache: { at: number; rows: ShopTypeRow[] } | null = null;

async function customRows(): Promise<ShopTypeRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await db.select().from(shopTypes).orderBy(asc(shopTypes.label));
  cache = { at: Date.now(), rows };
  syncRegistry(rows);
  return rows;
}

function syncRegistry(rows: ShopTypeRow[]) {
  const custom: CustomShopType[] = rows.map((r) => ({
    key: r.key,
    label: r.label,
    standardGoods: r.standardGoods,
    isFood: r.isFood,
  }));
  registerCustomShopTypes(custom);
}

/** Built-in types first, then staff-added; inactive ones only when asked (staff screens). */
export async function listShopTypes(options: { includeInactive?: boolean } = {}): Promise<ShopTypeOption[]> {
  const rows = await customRows();
  const all: ShopTypeOption[] = [
    ...SHOP_TYPES.map((t) => ({
      key: t.key as string,
      label: t.label as string,
      standardGoods: t.standardGoods as readonly string[],
      isFood: isFoodBusinessShopType(t.key),
      builtIn: true,
      status: "ACTIVE" as const,
    })),
    ...rows.map((r) => ({
      key: r.key,
      label: r.label,
      standardGoods: r.standardGoods,
      isFood: r.isFood,
      builtIn: false,
      status: r.status,
    })),
  ];
  return options.includeInactive ? all : all.filter((t) => t.status === "ACTIVE");
}

/** Every key a shop, rate or category may use — inactive staff-added types stay valid for shops that already have them. */
export async function isKnownShopType(key: string): Promise<boolean> {
  if (SHOP_TYPES.some((t) => t.key === key)) return true;
  return (await customRows()).some((r) => r.key === key);
}

/** Throws a validation error unless `key` is a built-in or an active staff-added type. */
export async function assertShopType(key: string, field = "Shop type"): Promise<void> {
  if (SHOP_TYPES.some((t) => t.key === key)) return;
  const row = (await customRows()).find((r) => r.key === key);
  if (!row || row.status !== "ACTIVE") throw validationFailed(`${field}: choose a valid shop type.`);
}

/** Server code that branches on the food flag calls this first so staff-added types are known. */
export async function loadShopTypeRegistry(): Promise<void> {
  await customRows();
}

export async function createShopType(
  input: { label: string; standardGoods?: string[]; isFood?: boolean },
  actor: Actor,
): Promise<ShopTypeRow> {
  if (!isStaff(actor.role)) throw forbidden("Only operations can manage shop types.");
  const label = input.label.trim();
  if (label.length < 2 || label.length > 80) throw validationFailed("A shop type name needs 2–80 characters.");
  const key = keyOf(label);
  if (key.length < 2) throw validationFailed("Use letters or numbers in the shop type name.");
  const taken = (await listShopTypes({ includeInactive: true })).some(
    (t) => t.key === key || t.label.toLowerCase() === label.toLowerCase(),
  );
  if (taken) throw conflict("A shop type with that name already exists.");

  const [row] = await db
    .insert(shopTypes)
    .values({
      key,
      label,
      standardGoods: cleanGoods(input.standardGoods),
      isFood: input.isFood ?? false,
      createdBy: actor.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("A shop type with that name already exists.");
  cache = null;
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_TYPE_SAVED,
    entityType: "shop_type",
    entityId: row.key,
    newValue: { label, isFood: row.isFood, status: row.status },
  });
  return row;
}

/** Edit a staff-added type. The key never changes; built-in types are code and cannot be edited here. */
export async function updateShopType(
  key: string,
  patch: { label?: string; standardGoods?: string[]; isFood?: boolean; status?: "ACTIVE" | "INACTIVE" },
  actor: Actor,
): Promise<ShopTypeRow> {
  if (!isStaff(actor.role)) throw forbidden("Only operations can manage shop types.");
  if (SHOP_TYPES.some((t) => t.key === key)) throw validationFailed("Built-in shop types cannot be edited.");
  const [current] = await db.select().from(shopTypes).where(eq(shopTypes.key, key));
  if (!current) throw notFound("Shop type");

  const set: Partial<typeof shopTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (label.length < 2 || label.length > 80) throw validationFailed("A shop type name needs 2–80 characters.");
    const clash = (await listShopTypes({ includeInactive: true })).some(
      (t) => t.key !== key && t.label.toLowerCase() === label.toLowerCase(),
    );
    if (clash) throw conflict("A shop type with that name already exists.");
    set.label = label;
  }
  if (patch.standardGoods !== undefined) set.standardGoods = cleanGoods(patch.standardGoods);
  if (patch.isFood !== undefined) set.isFood = patch.isFood;
  if (patch.status !== undefined) set.status = patch.status;

  const [row] = await db.update(shopTypes).set(set).where(eq(shopTypes.key, key)).returning();
  cache = null;
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_TYPE_SAVED,
    entityType: "shop_type",
    entityId: key,
    previousValue: { label: current.label, isFood: current.isFood, status: current.status },
    newValue: { label: row.label, isFood: row.isFood, status: row.status },
  });
  return row;
}

/** How many shops use each type, for the admin list. */
export async function shopCountsByType(): Promise<Record<string, number>> {
  const rows = (await db.execute(
    sql`select shop_type, count(*)::int as n from shops where deleted_at is null group by shop_type`,
  )) as unknown as { shop_type: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.shop_type, r.n]));
}
