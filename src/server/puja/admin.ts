/**
 * Puja Samagri — admin and operator side (docs/puja-samagri-2026-11):
 *   - review queue: owner-created product types and products → approve, reject or merge,
 *     always with a reason for reject / merge; the owner is notified at once (in-app + push);
 *     the creating shop's own data is never changed by the decision;
 *   - master catalogue: edit (names en/hi/mr, synonyms, MRP, HSN/GST + "to verify", flags,
 *     festivals), add, retire / bring back, merge duplicates, CSV export and import;
 *   - configuration: the shop type on / off, the FSSAI toggle for edible lines, seed stock;
 *   - festival collections: banner + kit promotion by date range (IST), optionally on the home page.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  festivalCollections,
  homeBanners,
  productCatalogueAttrs,
  productCategories,
  productLocalNames,
  productMrpHistory,
  products,
  productSubcategories,
  shopAddedTypes,
  shopProducts,
  shops,
  shopTypes,
  users,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { createBanner, updateBanner } from "@/server/services/home-banners";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule, setRule } from "@/server/services/settings";
import { uniqueSlug } from "@/server/services/catalogue";

import { PUJA_FESTIVALS, PUJA_SHOP_TYPE_KEY } from "./catalogue";
import { browsePujaCatalogue, buildSearchText, type Actor } from "./service";

/* ------------------------------------------------------------- review queue */

export interface Submission {
  kind: "TYPE" | "PRODUCT";
  id: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  categoryId: string;
  categoryName: string;
  typeName: string | null;
  shopId: string | null;
  shopName: string | null;
  createdByName: string | null;
  createdAt: Date;
  status: string;
  detail: string;
  /** Approved master entries with a close name in the same category — the merge targets offered. */
  mergeCandidates: { id: string; name: string }[];
}

function words(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

function rankCandidates(name: string, pool: { id: string; name: string }[]): { id: string; name: string }[] {
  const mine = new Set(words(name));
  return pool
    .map((p) => ({ ...p, score: words(p.name).filter((w) => mine.has(w)).length }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(({ id, name }) => ({ id, name }));
}

/** Pending owner-created product types (any category) and products in the puja categories. */
export async function listSubmissions(): Promise<Submission[]> {
  const types = await db
    .select({
      t: productSubcategories,
      categoryName: productCategories.name,
      shopName: shops.name,
      createdByName: users.name,
    })
    .from(productSubcategories)
    .innerJoin(productCategories, eq(productCategories.id, productSubcategories.categoryId))
    .leftJoin(shops, eq(shops.id, productSubcategories.ownerShopId))
    .leftJoin(users, eq(users.id, productSubcategories.createdBy))
    .where(and(eq(productSubcategories.approvalStatus, "PENDING_APPROVAL"), isNull(productSubcategories.deletedAt)))
    .orderBy(desc(productSubcategories.createdAt))
    .limit(200);

  const prods = await db
    .select({
      p: products,
      categoryName: productCategories.name,
      typeName: productSubcategories.name,
      nameHi: productLocalNames.nameHi,
      nameMr: productLocalNames.nameMr,
      createdByName: users.name,
      shopId: sql<string | null>`(SELECT sp.shop_id FROM shop_products sp WHERE sp.product_id = ${products.id} ORDER BY sp.created_at LIMIT 1)`,
      shopName: sql<string | null>`(SELECT s.name FROM shop_products sp JOIN shops s ON s.id = sp.shop_id WHERE sp.product_id = ${products.id} ORDER BY sp.created_at LIMIT 1)`,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(productSubcategories, eq(productSubcategories.id, products.subcategoryId))
    .leftJoin(productLocalNames, eq(productLocalNames.productId, products.id))
    .leftJoin(users, eq(users.id, products.createdBy))
    .where(and(eq(products.approvalStatus, "PENDING_APPROVAL"), eq(productCategories.department, PUJA_SHOP_TYPE_KEY), isNull(products.deletedAt)))
    .orderBy(desc(products.createdAt))
    .limit(300);

  const catIds = [...new Set([...types.map((t) => t.t.categoryId), ...prods.map((p) => p.p.categoryId)])];
  const approvedTypes = catIds.length
    ? await db
        .select({ id: productSubcategories.id, name: productSubcategories.name, categoryId: productSubcategories.categoryId })
        .from(productSubcategories)
        .where(and(inArray(productSubcategories.categoryId, catIds), eq(productSubcategories.approvalStatus, "APPROVED"), isNull(productSubcategories.deletedAt)))
    : [];
  const approvedProducts = catIds.length
    ? await db
        .select({ id: products.id, name: products.name, categoryId: products.categoryId })
        .from(products)
        .where(and(inArray(products.categoryId, catIds), eq(products.approvalStatus, "APPROVED"), eq(products.isActive, true), isNull(products.deletedAt)))
    : [];

  const out: Submission[] = [
    ...types.map((r) => ({
      kind: "TYPE" as const,
      id: r.t.id,
      name: r.t.name,
      nameHi: r.t.nameHi,
      nameMr: r.t.nameMr,
      categoryId: r.t.categoryId,
      categoryName: r.categoryName,
      typeName: null,
      shopId: r.t.ownerShopId,
      shopName: r.shopName,
      createdByName: r.createdByName,
      createdAt: r.t.createdAt,
      status: r.t.approvalStatus,
      detail: [
        r.t.defaultUnit ? `Unit: ${r.t.defaultUnit}` : null,
        r.t.variantAttributes.length ? `Variants by: ${r.t.variantAttributes.join(", ")}` : null,
        r.t.isLoose ? "Loose" : null,
        r.t.isPerishable ? "Perishable" : null,
        r.t.isEdible ? "Edible" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      mergeCandidates: rankCandidates(r.t.name, approvedTypes.filter((a) => a.categoryId === r.t.categoryId)),
    })),
    ...prods.map((r) => ({
      kind: "PRODUCT" as const,
      id: r.p.id,
      name: r.p.name,
      nameHi: r.nameHi,
      nameMr: r.nameMr,
      categoryId: r.p.categoryId,
      categoryName: r.categoryName,
      typeName: r.typeName,
      shopId: r.shopId,
      shopName: r.shopName,
      createdByName: r.createdByName,
      createdAt: r.p.createdAt,
      status: r.p.approvalStatus,
      detail: [
        `Unit: ${r.p.unit}`,
        r.p.kind === "LOOSE" ? "Loose" : null,
        r.p.mrpPaise != null ? `MRP ₹${(r.p.mrpPaise / 100).toFixed(2)}` : "No MRP",
        r.p.hsnCode ? `HSN ${r.p.hsnCode}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      mergeCandidates: rankCandidates(r.p.name, approvedProducts.filter((a) => a.categoryId === r.p.categoryId && a.id !== r.p.id)),
    })),
  ];
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface Decision {
  kind: "TYPE" | "PRODUCT";
  id: string;
  decision: "APPROVE" | "REJECT" | "MERGE";
  reason?: string | null;
  mergeIntoId?: string | null;
}

const DECISION_WORD = { APPROVE: "approved", REJECT: "not approved", MERGE: "merged" } as const;

/**
 * Decides one submission. Approve: it joins the master for every shop. Reject: it stays only
 * in the creating shop. Merge: the master already has it (mergeIntoId); the creating shop keeps
 * its own entry and listings exactly as they are. The owner is told at once (in-app + push).
 */
export async function decideSubmission(input: Decision, actor: Actor): Promise<{ status: string }> {
  const reason = input.reason?.trim() || null;
  if (input.decision !== "APPROVE" && !reason) throw validationFailed("Give a reason — the shop owner sees it.");
  if (input.decision === "MERGE" && !input.mergeIntoId) throw validationFailed("Choose the master entry to merge into.");

  let ownerId: string | null = null;
  let name = "";
  let status = "";
  let mergeName: string | null = null;

  if (input.kind === "TYPE") {
    const [t] = await db.select().from(productSubcategories).where(eq(productSubcategories.id, input.id));
    if (!t) throw notFound("Product type");
    if (t.approvalStatus !== "PENDING_APPROVAL") throw conflict("This product type has already been decided.");
    if (input.decision === "MERGE") {
      const [target] = await db.select().from(productSubcategories).where(eq(productSubcategories.id, input.mergeIntoId!));
      if (!target || target.approvalStatus !== "APPROVED" || target.categoryId !== t.categoryId) {
        throw validationFailed("Merge into an approved product type of the same category.");
      }
      mergeName = target.name;
    }
    status = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "MERGED";
    await db.transaction(async (tx) => {
      await tx
        .update(productSubcategories)
        .set({
          approvalStatus: status as "APPROVED" | "REJECTED" | "MERGED",
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          reviewNote: reason,
          mergedIntoId: input.decision === "MERGE" ? input.mergeIntoId! : null,
        })
        .where(and(eq(productSubcategories.id, t.id), eq(productSubcategories.approvalStatus, "PENDING_APPROVAL")));
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.CATALOGUE_SUBMISSION_DECIDED,
          entityType: "product_subcategory",
          entityId: t.id,
          previousValue: { approvalStatus: "PENDING_APPROVAL" },
          newValue: { approvalStatus: status, reason, mergeIntoId: input.mergeIntoId ?? null },
        },
        tx,
      );
    });
    name = t.name;
    if (t.ownerShopId) {
      const [s] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, t.ownerShopId));
      ownerId = s?.ownerId ?? null;
    }
    ownerId = ownerId ?? t.createdBy;
  } else {
    const [p] = await db.select().from(products).where(eq(products.id, input.id));
    if (!p) throw notFound("Product");
    if (p.approvalStatus !== "PENDING_APPROVAL") throw conflict("This product has already been decided.");
    if (input.decision === "MERGE") {
      const [target] = await db.select().from(products).where(eq(products.id, input.mergeIntoId!));
      if (!target || target.approvalStatus !== "APPROVED" || target.id === p.id) throw validationFailed("Merge into an approved master product.");
      mergeName = target.name;
    }
    status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set(
          input.decision === "APPROVE"
            ? { approvalStatus: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), rejectionReason: null }
            : { approvalStatus: "REJECTED", rejectionReason: input.decision === "MERGE" ? `Merged into "${mergeName}": ${reason}` : reason },
        )
        .where(and(eq(products.id, p.id), eq(products.approvalStatus, "PENDING_APPROVAL")));
      if (input.decision === "MERGE") {
        await tx
          .insert(productCatalogueAttrs)
          .values({ productId: p.id, mergedIntoProductId: input.mergeIntoId!, updatedBy: actor.id })
          .onConflictDoUpdate({ target: productCatalogueAttrs.productId, set: { mergedIntoProductId: input.mergeIntoId!, updatedBy: actor.id, updatedAt: new Date() } });
      }
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: input.decision === "APPROVE" ? AUDIT_ACTIONS.PRODUCT_APPROVED : AUDIT_ACTIONS.CATALOGUE_SUBMISSION_DECIDED,
          entityType: "product",
          entityId: p.id,
          previousValue: { approvalStatus: "PENDING_APPROVAL" },
          newValue: { approvalStatus: status, decision: input.decision, reason, mergeIntoId: input.mergeIntoId ?? null },
        },
        tx,
      );
    });
    name = p.name;
    ownerId = p.createdBy;
    if (input.decision === "MERGE") status = "MERGED";
  }

  if (ownerId) {
    const what = input.kind === "TYPE" ? "product type" : "product";
    const body =
      input.decision === "APPROVE"
        ? `Your ${what} "${name}" is approved and is now in the master catalogue for every puja shop. Nothing changes in your shop.`
        : input.decision === "MERGE"
          ? `Your ${what} "${name}" matches "${mergeName}" in the master catalogue, so it was merged. Your shop keeps its own entry as it is. Note: ${reason}`
          : `Your ${what} "${name}" was not added to the master catalogue: ${reason}. It stays in your shop as it is.`;
    await notify({
      userId: ownerId,
      type: NOTIFICATION_TYPES.SHOP_CATALOGUE_SUBMISSION_DECIDED,
      title: `Your ${what} was ${DECISION_WORD[input.decision]}`,
      body,
      actionUrl: "/shop/puja",
      channels: ["PUSH"],
      metadata: { kind: input.kind, id: input.id, decision: input.decision },
    });
  }
  return { status };
}

/* --------------------------------------------------------- master catalogue */

export { browsePujaCatalogue as listMasterCatalogue };

export interface MasterPatch {
  name?: string;
  nameHi?: string | null;
  nameMr?: string | null;
  synonyms?: readonly string[];
  mrpPaise?: number | null;
  hsnCode?: string | null;
  gstRateBp?: number | null;
  /** false = HSN/GST confirmed by the CA. */
  taxToVerify?: boolean;
  loose?: boolean;
  perishable?: boolean;
  edible?: boolean;
  festivals?: readonly string[];
  active?: boolean;
  typeId?: string | null;
}

async function refreshSearchText(productId: string, client = db): Promise<void> {
  await client.execute(sql`
    UPDATE product_local_names l
       SET search_text = lower(concat_ws(' | ', p.name, l.name_hi, l.name_mr, s.name, s.name_hi, s.name_mr, array_to_string(l.synonyms, ' | '))),
           updated_at = now()
      FROM products p LEFT JOIN product_subcategories s ON s.id = p.subcategory_id
     WHERE p.id = l.product_id AND l.product_id = ${productId}::uuid`);
}

const FESTIVAL_KEYS = new Set<string>(PUJA_FESTIVALS.map((f) => f.key));

/** Edits one master product. MRP changes go to the MRP history; names refresh the search text. */
export async function updateMasterProduct(productId: string, patch: MasterPatch, actor: Actor) {
  const [current] = await db.select().from(products).where(eq(products.id, productId));
  if (!current) throw notFound("Product");
  if (patch.name !== undefined && patch.name.trim().length < 2) throw validationFailed("The name needs at least 2 letters.");
  if (patch.gstRateBp != null && (patch.gstRateBp < 0 || patch.gstRateBp > 4000)) throw validationFailed("GST must be between 0 and 40%.");
  if (patch.mrpPaise != null && patch.mrpPaise < 0) throw validationFailed("The MRP cannot be negative.");
  if (patch.festivals?.some((f) => !FESTIVAL_KEYS.has(f))) throw validationFailed("Unknown festival.");
  if (patch.typeId) {
    const [t] = await db.select().from(productSubcategories).where(eq(productSubcategories.id, patch.typeId));
    if (!t || t.categoryId !== current.categoryId || t.approvalStatus !== "APPROVED") throw validationFailed("Choose an approved product type of the same category.");
  }
  const loose = patch.loose ?? current.kind === "LOOSE";
  const mrp = loose ? null : patch.mrpPaise !== undefined ? patch.mrpPaise : current.mrpPaise;

  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.hsnCode !== undefined ? { hsnCode: patch.hsnCode?.trim() || null } : {}),
        ...(patch.gstRateBp !== undefined ? { gstRateBp: patch.gstRateBp } : {}),
        ...(patch.active !== undefined ? { isActive: patch.active } : {}),
        ...(patch.typeId !== undefined ? { subcategoryId: patch.typeId } : {}),
        kind: loose ? "LOOSE" : "PACKAGED",
        mrpPaise: mrp,
        ...(mrp !== current.mrpPaise ? { mrpSource: mrp == null ? null : ("ADMIN" as const), mrpUpdatedAt: new Date() } : {}),
      })
      .where(eq(products.id, productId));
    if (mrp != null && mrp !== current.mrpPaise) {
      await tx.insert(productMrpHistory).values({
        productId,
        previousMrpPaise: current.mrpPaise,
        newMrpPaise: mrp,
        source: "ADMIN",
        reason: "Puja master catalogue edit",
        changedBy: actor.id,
      });
    }
    if (patch.nameHi !== undefined || patch.nameMr !== undefined || patch.synonyms !== undefined) {
      await tx
        .insert(productLocalNames)
        .values({ productId, nameHi: patch.nameHi ?? null, nameMr: patch.nameMr ?? null, synonyms: [...(patch.synonyms ?? [])], updatedBy: actor.id })
        .onConflictDoUpdate({
          target: productLocalNames.productId,
          set: {
            ...(patch.nameHi !== undefined ? { nameHi: patch.nameHi?.trim() || null } : {}),
            ...(patch.nameMr !== undefined ? { nameMr: patch.nameMr?.trim() || null } : {}),
            ...(patch.synonyms !== undefined ? { synonyms: [...new Set(patch.synonyms.map((s) => s.trim()).filter(Boolean))] } : {}),
            updatedBy: actor.id,
            updatedAt: new Date(),
          },
        });
    }
    const attrs = {
      ...(patch.taxToVerify !== undefined ? { taxToVerify: patch.taxToVerify } : {}),
      ...(patch.perishable !== undefined ? { isPerishable: patch.perishable } : {}),
      ...(patch.edible !== undefined ? { isEdible: patch.edible } : {}),
      ...(patch.festivals !== undefined ? { festivals: [...patch.festivals] } : {}),
    };
    if (Object.keys(attrs).length) {
      await tx
        .insert(productCatalogueAttrs)
        .values({ productId, catalogue: PUJA_SHOP_TYPE_KEY, ...attrs, updatedBy: actor.id })
        .onConflictDoUpdate({ target: productCatalogueAttrs.productId, set: { ...attrs, updatedBy: actor.id, updatedAt: new Date() } });
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.MASTER_PRODUCT_UPDATED,
        entityType: "product",
        entityId: productId,
        previousValue: { name: current.name, mrpPaise: current.mrpPaise, hsnCode: current.hsnCode, gstRateBp: current.gstRateBp, isActive: current.isActive, kind: current.kind },
        newValue: { ...patch, synonyms: patch.synonyms ? [...patch.synonyms] : undefined, festivals: patch.festivals ? [...patch.festivals] : undefined },
      },
      tx,
    );
  });
  await refreshSearchText(productId);
  return { productId };
}

export interface NewMasterProduct {
  categoryId: string;
  typeId?: string | null;
  name: string;
  nameHi: string;
  nameMr: string;
  synonyms?: readonly string[];
  variant?: string | null;
  unit: string;
  mrpPaise?: number | null;
  hsnCode?: string | null;
  gstRateBp?: number | null;
  loose?: boolean;
  perishable?: boolean;
  edible?: boolean;
  festivals?: readonly string[];
}

const UNIT_MAP: Record<string, string> = { pcs: "piece", piece: "piece", pack: "pack", box: "box", dozen: "dozen", g: "g", kg: "kg", ml: "ml", L: "L" };

/** Staff add a product straight to the puja master (approved). The duplicate check runs first. */
export async function createMasterProduct(input: NewMasterProduct, actor: Actor, options: { confirmDuplicate?: boolean } = {}) {
  const name = input.name.trim();
  if (name.length < 2) throw validationFailed("The name needs at least 2 letters.");
  if (!input.nameHi.trim() || !input.nameMr.trim()) throw validationFailed("Every catalogue item needs its Hindi and Marathi names.");
  const [cat] = await db.select().from(productCategories).where(eq(productCategories.id, input.categoryId));
  if (!cat || cat.department !== PUJA_SHOP_TYPE_KEY) throw validationFailed("Choose a Puja Samagri category.");
  const same = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.categoryId, cat.id), isNull(products.deletedAt), sql`lower(${products.name}) = lower(${name})`));
  if (same.length) throw conflict(`"${same[0].name}" is already in ${cat.name}.`, { matches: same });
  const loose = Boolean(input.loose);
  const synonyms = [...new Set((input.synonyms ?? []).map((s) => s.trim()).filter(Boolean))];
  let typeNames: (string | null)[] = [];
  if (input.typeId) {
    const [t] = await db.select().from(productSubcategories).where(eq(productSubcategories.id, input.typeId));
    if (!t || t.categoryId !== cat.id) throw validationFailed("That product type is not in this category.");
    typeNames = [t.name, t.nameHi, t.nameMr];
  }
  void options;
  const productId = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(products)
      .values({
        categoryId: cat.id,
        subcategoryId: input.typeId ?? null,
        name,
        slug: uniqueSlug(`puja ${name}`),
        description: `${name} (${input.nameHi.trim()} / ${input.nameMr.trim()})`,
        imageUrl: cat.imageUrl,
        kind: loose ? "LOOSE" : "PACKAGED",
        variant: input.variant?.trim() || null,
        mrpPaise: loose ? null : (input.mrpPaise ?? null),
        mrpSource: loose || input.mrpPaise == null ? null : "ADMIN",
        hsnCode: input.hsnCode?.trim() || null,
        gstRateBp: input.gstRateBp ?? null,
        unit: UNIT_MAP[input.unit] ?? input.unit,
        approvalStatus: "APPROVED",
        createdBy: actor.id,
        approvedBy: actor.id,
        approvedAt: new Date(),
      })
      .returning({ id: products.id });
    await tx.insert(productLocalNames).values({
      productId: p.id,
      nameHi: input.nameHi.trim(),
      nameMr: input.nameMr.trim(),
      synonyms,
      searchText: buildSearchText([name, input.nameHi, input.nameMr, ...typeNames], synonyms),
      updatedBy: actor.id,
    });
    await tx.insert(productCatalogueAttrs).values({
      productId: p.id,
      catalogue: PUJA_SHOP_TYPE_KEY,
      sellUnit: input.unit,
      isPerishable: Boolean(input.perishable),
      isEdible: Boolean(input.edible),
      festivals: [...(input.festivals ?? [])].filter((f) => FESTIVAL_KEYS.has(f)),
      variantAttrs: input.variant ? { variant: input.variant } : {},
      taxToVerify: true,
      updatedBy: actor.id,
    });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.MASTER_PRODUCT_UPDATED, entityType: "product", entityId: p.id, newValue: { created: true, name, categoryId: cat.id } },
      tx,
    );
    return p.id;
  });
  return { productId };
}

/**
 * Merges a duplicate master product into another: the duplicate is retired (no shop can add it
 * any more) and remembers where it went. Shops that already list it keep their listings and
 * order history exactly as they are.
 */
export async function mergeMasterProducts(sourceId: string, targetId: string, actor: Actor, reason?: string | null) {
  if (sourceId === targetId) throw validationFailed("Choose two different products.");
  const rows = await db.select().from(products).where(inArray(products.id, [sourceId, targetId]));
  const source = rows.find((r) => r.id === sourceId);
  const target = rows.find((r) => r.id === targetId);
  if (!source || !target) throw notFound("Product");
  if (!target.isActive || target.approvalStatus !== "APPROVED") throw validationFailed("Merge into an active, approved product.");
  const listings = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(shopProducts)
    .where(and(eq(shopProducts.productId, sourceId), isNull(shopProducts.deletedAt)));
  await db.transaction(async (tx) => {
    await tx.update(products).set({ isActive: false }).where(eq(products.id, sourceId));
    await tx
      .insert(productCatalogueAttrs)
      .values({ productId: sourceId, catalogue: PUJA_SHOP_TYPE_KEY, mergedIntoProductId: targetId, updatedBy: actor.id })
      .onConflictDoUpdate({ target: productCatalogueAttrs.productId, set: { mergedIntoProductId: targetId, updatedBy: actor.id, updatedAt: new Date() } });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.MASTER_PRODUCT_MERGED,
        entityType: "product",
        entityId: sourceId,
        newValue: { mergedInto: targetId, targetName: target.name, shopListingsKept: listings[0]?.n ?? 0, reason: reason ?? null },
      },
      tx,
    );
  });
  return { merged: source.name, into: target.name, shopListingsKept: listings[0]?.n ?? 0 };
}

/* ------------------------------------------------------- CSV export / import */

export const CSV_COLUMNS = [
  "Product code", "Category", "Product type", "Name (English)", "Name (Hindi)", "Name (Marathi)", "Variant", "Synonyms",
  "Unit", "MRP (Rs)", "Loose", "Perishable", "Edible", "HSN", "GST %", "HSN/GST status", "Festivals", "Active", "Approval",
] as const;

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportMasterCatalogueCsv(): Promise<string> {
  const { items } = await browsePujaCatalogue({ includeRetired: true, limit: 600 });
  const lines = [CSV_COLUMNS.join(",")];
  for (const i of items) {
    lines.push(
      [
        i.code, i.categoryName, i.typeName, i.name, i.nameHi, i.nameMr, i.variant, i.synonyms.join("; "), i.sellUnit ?? i.unit,
        i.mrpPaise == null ? "" : (i.mrpPaise / 100).toFixed(2), i.kind === "LOOSE" ? "Yes" : "No", i.perishable ? "Yes" : "No",
        i.edible ? "Yes" : "No", i.hsnCode, i.gstRateBp == null ? "" : i.gstRateBp / 100, i.taxToVerify ? "To verify with CA" : "Verified",
        i.festivals.join("; "), i.isActive ? "Yes" : "No", i.approvalStatus,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\n") + "\n";
}

/** RFC-4180-ish CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const yes = (v: string | undefined) => /^(y|yes|true|1|हाँ|होय)$/i.test((v ?? "").trim());

export interface ImportReport {
  updated: number;
  created: number;
  unchanged: number;
  errors: { row: number; message: string }[];
}

/**
 * Bulk edit of the master from the exported CSV. A row with a product code updates that
 * product; a row without one adds a product (category and type by name). Bad rows are
 * reported and skipped; the others are applied (partial import).
 */
export async function importMasterCatalogueCsv(text: string, actor: Actor): Promise<ImportReport> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw validationFailed("The file has no rows under the header.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const need = ["Name (English)", "Category"];
  for (const n of need) if (col(n) < 0) throw validationFailed(`The header must have a "${n}" column (download the export for the layout).`);
  if (rows.length > 2001) throw validationFailed("At most 2,000 rows per file.");

  const cats = await db
    .select({ id: productCategories.id, name: productCategories.name })
    .from(productCategories)
    .where(and(eq(productCategories.department, PUJA_SHOP_TYPE_KEY), isNull(productCategories.deletedAt)));
  const types = await db
    .select({ id: productSubcategories.id, name: productSubcategories.name, categoryId: productSubcategories.categoryId })
    .from(productSubcategories)
    .where(and(inArray(productSubcategories.categoryId, cats.map((c) => c.id)), eq(productSubcategories.approvalStatus, "APPROVED")));
  const report: ImportReport = { updated: 0, created: 0, unchanged: 0, errors: [] };
  const get = (r: string[], n: string) => {
    const i = col(n);
    return i < 0 ? undefined : (r[i] ?? "").trim();
  };
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const rowNo = i + 1;
    try {
      const code = get(r, "Product code");
      const name = get(r, "Name (English)") ?? "";
      const cat = cats.find((c) => c.name.toLowerCase() === (get(r, "Category") ?? "").toLowerCase());
      if (!name) throw validationFailed("Name (English) is missing.");
      if (!cat) throw validationFailed(`Unknown category "${get(r, "Category")}".`);
      const typeName = get(r, "Product type");
      const type = typeName ? types.find((t) => t.categoryId === cat.id && t.name.toLowerCase() === typeName.toLowerCase()) : undefined;
      if (typeName && !type) throw validationFailed(`Unknown product type "${typeName}" in ${cat.name}.`);
      const mrpText = get(r, "MRP (Rs)");
      const mrp = mrpText ? Math.round(Number(mrpText) * 100) : null;
      if (mrpText && !(Number(mrpText) >= 0)) throw validationFailed("MRP must be a number of rupees.");
      const gstText = get(r, "GST %");
      const gst = gstText ? Math.round(Number(gstText) * 100) : null;
      if (gstText && !(Number(gstText) >= 0 && Number(gstText) <= 40)) throw validationFailed("GST % must be between 0 and 40.");
      const festivals = (get(r, "Festivals") ?? "").split(/[;,]/).map((f) => f.trim()).filter(Boolean);
      const badFest = festivals.find((f) => !FESTIVAL_KEYS.has(f));
      if (badFest) throw validationFailed(`Unknown festival "${badFest}".`);
      const synonyms = (get(r, "Synonyms") ?? "").split(";").map((s) => s.trim()).filter(Boolean);
      const status = get(r, "HSN/GST status");
      const patch: MasterPatch = {
        name,
        nameHi: get(r, "Name (Hindi)") || null,
        nameMr: get(r, "Name (Marathi)") || null,
        synonyms,
        mrpPaise: mrp,
        hsnCode: get(r, "HSN") || null,
        gstRateBp: gst,
        taxToVerify: status ? !/^verified$/i.test(status) : undefined,
        loose: col("Loose") >= 0 ? yes(get(r, "Loose")) : undefined,
        perishable: col("Perishable") >= 0 ? yes(get(r, "Perishable")) : undefined,
        edible: col("Edible") >= 0 ? yes(get(r, "Edible")) : undefined,
        festivals,
        active: col("Active") >= 0 ? yes(get(r, "Active")) : undefined,
        typeId: type?.id,
      };
      if (code) {
        const [p] = await db.select({ id: products.id, categoryId: products.categoryId }).from(products).where(eq(products.code, code));
        if (!p) throw validationFailed(`No product with code ${code}.`);
        if (p.categoryId !== cat.id) throw validationFailed("Moving a product to another category is not done by import.");
        await updateMasterProduct(p.id, patch, actor);
        report.updated += 1;
      } else {
        if (!patch.nameHi || !patch.nameMr) throw validationFailed("A new product needs its Hindi and Marathi names.");
        await createMasterProduct(
          {
            categoryId: cat.id,
            typeId: type?.id ?? null,
            name,
            nameHi: patch.nameHi,
            nameMr: patch.nameMr,
            synonyms,
            variant: get(r, "Variant") || null,
            unit: get(r, "Unit") || "pcs",
            mrpPaise: mrp,
            hsnCode: patch.hsnCode,
            gstRateBp: gst,
            loose: patch.loose,
            perishable: patch.perishable,
            edible: patch.edible,
            festivals,
          },
          actor,
        );
        report.created += 1;
      }
    } catch (error) {
      report.errors.push({ row: rowNo, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.MASTER_CATALOGUE_IMPORTED,
    entityType: "catalogue",
    entityId: null,
    newValue: { updated: report.updated, created: report.created, errors: report.errors.length },
  });
  return report;
}

/* ------------------------------------------------------------ configuration */

export async function getPujaConfig() {
  const [type] = await db.select().from(shopTypes).where(eq(shopTypes.key, PUJA_SHOP_TYPE_KEY));
  const rule = await getRule("pujaSamagri");
  const [counts] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM products p JOIN product_categories c ON c.id = p.category_id
        WHERE c.department = ${PUJA_SHOP_TYPE_KEY} AND p.is_active AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED') AS products,
      (SELECT count(*)::int FROM product_categories c WHERE c.department = ${PUJA_SHOP_TYPE_KEY} AND c.deleted_at IS NULL) AS categories,
      (SELECT count(*)::int FROM product_subcategories s JOIN product_categories c ON c.id = s.category_id
        WHERE c.department = ${PUJA_SHOP_TYPE_KEY} AND s.approval_status = 'APPROVED') AS types,
      (SELECT count(*)::int FROM shops s WHERE s.deleted_at IS NULL AND (s.shop_type = ${PUJA_SHOP_TYPE_KEY}
        OR EXISTS (SELECT 1 FROM shop_added_types a WHERE a.shop_id = s.id AND a.shop_type_key = ${PUJA_SHOP_TYPE_KEY}))) AS shops,
      (SELECT count(*)::int FROM product_catalogue_attrs a WHERE a.catalogue = ${PUJA_SHOP_TYPE_KEY} AND a.tax_to_verify) AS tax_to_verify,
      (SELECT count(*)::int FROM product_catalogue_attrs a WHERE a.catalogue = ${PUJA_SHOP_TYPE_KEY} AND a.is_edible) AS edible
  `)) as unknown as Record<string, number>[];
  return {
    enabled: type?.status === "ACTIVE",
    label: type?.label ?? "Puja Samagri & Temple Supplies",
    exists: Boolean(type),
    edibleNeedsFssai: rule.edibleNeedsFssai,
    seedDefaultStock: rule.seedDefaultStock,
    counts: {
      products: Number(counts?.products ?? 0),
      categories: Number(counts?.categories ?? 0),
      types: Number(counts?.types ?? 0),
      shops: Number(counts?.shops ?? 0),
      taxToVerify: Number(counts?.tax_to_verify ?? 0),
      edible: Number(counts?.edible ?? 0),
    },
  };
}

export async function setPujaConfig(input: { enabled?: boolean; edibleNeedsFssai?: boolean; seedDefaultStock?: number }, actor: Actor) {
  if (input.enabled !== undefined) {
    const [type] = await db.select().from(shopTypes).where(eq(shopTypes.key, PUJA_SHOP_TYPE_KEY));
    if (!type) throw notFound("Puja Samagri shop type");
    const status = input.enabled ? "ACTIVE" : "INACTIVE";
    if (type.status !== status) {
      await db.update(shopTypes).set({ status, updatedAt: new Date() }).where(eq(shopTypes.key, PUJA_SHOP_TYPE_KEY));
      await recordAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SETTING_CHANGED,
        entityType: "shop_type",
        entityId: PUJA_SHOP_TYPE_KEY,
        previousValue: { status: type.status },
        newValue: { status },
      });
    }
  }
  if (input.edibleNeedsFssai !== undefined || input.seedDefaultStock !== undefined) {
    const rule = await getRule("pujaSamagri");
    await setRule("pujaSamagri", { ...rule, ...(input.edibleNeedsFssai !== undefined ? { edibleNeedsFssai: input.edibleNeedsFssai } : {}), ...(input.seedDefaultStock !== undefined ? { seedDefaultStock: input.seedDefaultStock } : {}) }, actor);
  }
  return getPujaConfig();
}

/** Shops carrying the puja range (primary type or added type) — for the admin overview. */
export async function countPujaShops(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        sql`(${shops.shopType} = ${PUJA_SHOP_TYPE_KEY} OR EXISTS (SELECT 1 FROM ${shopAddedTypes} a WHERE a.shop_id = ${shops.id} AND a.shop_type_key = ${PUJA_SHOP_TYPE_KEY}))`,
      ),
    );
  return row?.n ?? 0;
}

/* ----------------------------------------------------- festival collections */

export interface FestivalInput {
  festivalKey: string;
  title: string;
  titleHi?: string | null;
  titleMr?: string | null;
  subtitle?: string | null;
  startsAt: Date;
  endsAt: Date;
  active?: boolean;
  showOnHome?: boolean;
}

export async function listFestivalCollections() {
  return db.select().from(festivalCollections).where(eq(festivalCollections.shopTypeKey, PUJA_SHOP_TYPE_KEY)).orderBy(desc(festivalCollections.startsAt)).limit(100);
}

/** The festival collections running now (IST dates are stored as instants). */
export async function liveFestivalCollections(now = new Date()) {
  try {
    return await db
      .select()
      .from(festivalCollections)
      .where(
        and(
          eq(festivalCollections.shopTypeKey, PUJA_SHOP_TYPE_KEY),
          eq(festivalCollections.active, true),
          sql`${festivalCollections.startsAt} <= ${now.toISOString()}::timestamptz AND ${festivalCollections.endsAt} > ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(festivalCollections.startsAt);
  } catch (error) {
    // Before the migration: no collections, the page still renders.
    console.error("[puja] festival collections unavailable", error);
    return [];
  }
}

export async function saveFestivalCollection(id: string | null, input: FestivalInput, actor: Actor) {
  if (!FESTIVAL_KEYS.has(input.festivalKey)) throw validationFailed("Choose a festival.");
  if (input.title.trim().length < 3) throw validationFailed("Give the collection a title.");
  if (!(input.endsAt > input.startsAt)) throw validationFailed("The end must be after the start.");
  const values = {
    festivalKey: input.festivalKey,
    title: input.title.trim(),
    titleHi: input.titleHi?.trim() || null,
    titleMr: input.titleMr?.trim() || null,
    subtitle: input.subtitle?.trim() || null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  let row;
  if (id) {
    [row] = await db.update(festivalCollections).set(values).where(eq(festivalCollections.id, id)).returning();
    if (!row) throw notFound("Festival collection");
  } else {
    [row] = await db.insert(festivalCollections).values({ ...values, shopTypeKey: PUJA_SHOP_TYPE_KEY, createdBy: actor.id }).returning();
  }
  // The home page banner for the same dates (existing home banner rotation).
  const banner = {
    title: values.title,
    subtitle: values.subtitle ?? "Puja kits and festival items from shops near you",
    imageUrl: "/images/puja/puja-ready-kits.svg",
    ctaLabel: "Shop now",
    ctaHref: `/puja?festival=${values.festivalKey}`,
    kind: "SEASONAL" as const,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    active: values.active && Boolean(input.showOnHome),
  };
  if (row.homeBannerId) {
    const [exists] = await db.select({ id: homeBanners.id }).from(homeBanners).where(eq(homeBanners.id, row.homeBannerId));
    if (exists) await updateBanner(actor, row.homeBannerId, banner);
  } else if (input.showOnHome) {
    const created = await createBanner(actor, banner);
    [row] = await db.update(festivalCollections).set({ homeBannerId: created.id }).where(eq(festivalCollections.id, row.id)).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.FESTIVAL_COLLECTION_SAVED,
    entityType: "festival_collection",
    entityId: row.id,
    newValue: { ...values, startsAt: values.startsAt.toISOString(), endsAt: values.endsAt.toISOString(), showOnHome: Boolean(input.showOnHome) },
  });
  return row;
}
