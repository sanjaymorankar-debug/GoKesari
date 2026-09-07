/**
 * Product Master identity and MRP (Product Master brief §5, §7, §11–§14).
 *
 * Two rules drive everything here:
 *
 *  1. **One master row per real-world product.** GTIN is the primary
 *     duplicate key; where there is no GTIN (loose goods, generics) we fall
 *     back to brand + name + pack size + variant and only *flag* a possible
 *     duplicate — never auto-merge, because "Cow Milk 1L" from two shops
 *     may genuinely be two different products.
 *
 *  2. **MRP belongs to the master, selling price belongs to the shop.**
 *     A shop owner can never write `products.mrp_paise` directly (§13);
 *     they raise a verification request instead, which an admin decides.
 *     Every accepted change appends to product_mrp_history, which is never
 *     deleted.
 */
import { and, eq, ilike, isNull, ne, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  brands,
  productMrpHistory,
  products,
  type MrpSource,
  type Product,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

/** Roles allowed to write the master MRP directly (§13, §31). */
const MRP_WRITERS: readonly UserRole[] = ["ADMIN", "OPERATOR"];

/**
 * Strips separators and validates a scanned/typed GTIN. Accepts GTIN-8/12/13/14
 * (which covers EAN-8, UPC-A, EAN-13) and stores digits only, so the same
 * physical barcode always resolves to one master row regardless of how the
 * scanner formatted it.
 */
export function normalizeGtin(raw: string): string {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) {
    throw validationFailed("A GTIN/barcode must contain digits only.");
  }
  if (![8, 12, 13, 14].includes(digits.length)) {
    throw validationFailed("A GTIN must be 8, 12, 13 or 14 digits (EAN-8, UPC-A, EAN-13 or GTIN-14).");
  }
  return digits;
}

/** §7's first lookup step: always search Gokesari's own master before any external provider. */
export async function findProductByGtin(rawGtin: string): Promise<Product | null> {
  const gtin = normalizeGtin(rawGtin);
  const product = await db.query.products.findFirst({
    where: and(eq(products.gtin, gtin), isNull(products.deletedAt)),
  });
  return product ?? null;
}

export interface DuplicateCandidate {
  product: Product;
  reason: "GTIN" | "BRAND_NAME_PACK";
}

/**
 * §11. An exact GTIN hit is a definite duplicate; a brand+name+pack+variant
 * match is only ever *potential*, and is returned for a human to judge.
 */
export async function findDuplicateCandidates(input: {
  gtin?: string | null;
  brandId?: string | null;
  name: string;
  netQuantity?: number | null;
  netQuantityUnit?: string | null;
  variant?: string | null;
  excludeProductId?: string;
}): Promise<DuplicateCandidate[]> {
  const notItself = input.excludeProductId ? [ne(products.id, input.excludeProductId)] : [];

  if (input.gtin) {
    const gtin = normalizeGtin(input.gtin);
    const exact = await db.query.products.findFirst({
      where: and(eq(products.gtin, gtin), isNull(products.deletedAt), ...notItself),
    });
    if (exact) return [{ product: exact, reason: "GTIN" }];
  }

  const name = input.name.trim();
  if (!name) return [];

  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        ilike(products.name, name),
        input.brandId ? eq(products.brandId, input.brandId) : isNull(products.brandId),
        input.netQuantity != null
          ? eq(products.netQuantity, input.netQuantity)
          : isNull(products.netQuantity),
        input.variant ? ilike(products.variant, input.variant) : isNull(products.variant),
        ...notItself,
      ),
    )
    .limit(10);

  return rows.map((product) => ({ product, reason: "BRAND_NAME_PACK" as const }));
}

export interface SetMrpInput {
  productId: string;
  mrpPaise: number;
  source: MrpSource;
  effectiveFrom?: string | null;
  reason?: string | null;
}

/**
 * Writes the master MRP and appends to history. Admin/operator only —
 * a shop owner reaching this throws FORBIDDEN, which is §13's whole point.
 */
export async function setMasterMrp(input: SetMrpInput, actor: Actor): Promise<Product> {
  if (!MRP_WRITERS.includes(actor.role)) {
    throw forbidden("Only an administrator or operator can change the master MRP.");
  }
  if (!Number.isInteger(input.mrpPaise) || input.mrpPaise < 0) {
    throw validationFailed("MRP must be a whole, non-negative amount in paise.");
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .for("update");
    if (!current) throw notFound("Product");

    const [updated] = await tx
      .update(products)
      .set({
        mrpPaise: input.mrpPaise,
        mrpSource: input.source,
        mrpEffectiveFrom: input.effectiveFrom ?? null,
        mrpUpdatedAt: new Date(),
        // An admin/operator writing the value is what verifies it; an
        // import or seller submission stays unverified until reviewed.
        mrpVerificationStatus:
          input.source === "ADMIN" || input.source === "GS1" || input.source === "BRAND"
            ? "VERIFIED"
            : "UNVERIFIED",
      })
      .where(eq(products.id, input.productId))
      .returning();

    await tx.insert(productMrpHistory).values({
      productId: input.productId,
      previousMrpPaise: current.mrpPaise,
      newMrpPaise: input.mrpPaise,
      source: input.source,
      effectiveFrom: input.effectiveFrom ?? null,
      reason: input.reason?.trim() || null,
      changedBy: actor.id,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_MRP_CHANGED,
        entityType: "product",
        entityId: input.productId,
        previousValue: { mrpPaise: current.mrpPaise, source: current.mrpSource },
        newValue: { mrpPaise: input.mrpPaise, source: input.source },
      },
      tx,
    );

    return updated;
  });
}

/**
 * §13's seller path. A shop owner who believes the master MRP is wrong
 * doesn't edit it — they flag it, which parks the product in
 * PENDING_VERIFICATION for an admin to resolve. The master value itself is
 * left untouched until then.
 */
export async function submitMrpCorrection(
  productId: string,
  claimedMrpPaise: number,
  actor: Actor,
  note?: string,
): Promise<Product> {
  if (!Number.isInteger(claimedMrpPaise) || claimedMrpPaise < 0) {
    throw validationFailed("Enter the printed MRP as a whole, non-negative amount.");
  }
  const current = await db.query.products.findFirst({ where: eq(products.id, productId) });
  if (!current) throw notFound("Product");
  if (current.mrpPaise === claimedMrpPaise) {
    throw conflict("That is already the recorded MRP for this product.");
  }

  const [updated] = await db
    .update(products)
    .set({ mrpVerificationStatus: "PENDING_VERIFICATION" })
    .where(eq(products.id, productId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_MRP_CORRECTION_SUBMITTED,
    entityType: "product",
    entityId: productId,
    previousValue: { mrpPaise: current.mrpPaise },
    // The claim is recorded in the audit trail only — it must never leak
    // into products.mrp_paise without an admin accepting it.
    newValue: { claimedMrpPaise, note: note?.trim() || null },
  });

  return updated;
}

export async function getMrpHistory(productId: string) {
  return db
    .select()
    .from(productMrpHistory)
    .where(eq(productMrpHistory.productId, productId))
    .orderBy(sql`${productMrpHistory.createdAt} DESC`)
    .limit(100);
}

/**
 * §12's backfill list: PACKAGED products still missing an MRP. LOOSE goods
 * are excluded because they legitimately never have one.
 */
export async function listProductsMissingMrp(limit = 200): Promise<Product[]> {
  return db
    .select()
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        eq(products.kind, "PACKAGED"),
        isNull(products.mrpPaise),
      ),
    )
    .limit(limit);
}

/** Attaches identity/tax metadata to an existing master product. Admin/operator only. */
export async function updateProductIdentity(
  productId: string,
  patch: {
    brandId?: string | null;
    subcategoryId?: string | null;
    kind?: "PACKAGED" | "LOOSE";
    gtin?: string | null;
    barcode?: string | null;
    variant?: string | null;
    hsnCode?: string | null;
    gstRateBp?: number | null;
    manufacturerName?: string | null;
    manufacturerAddress?: string | null;
    countryOfOrigin?: string | null;
    netQuantity?: number | null;
    netQuantityUnit?: string | null;
  },
  actor: Actor,
  client: DbClient = db,
): Promise<Product> {
  if (!MRP_WRITERS.includes(actor.role)) {
    throw forbidden("Only an administrator or operator can edit master product details.");
  }
  const current = await client.query.products.findFirst({ where: eq(products.id, productId) });
  if (!current) throw notFound("Product");

  const gtin = patch.gtin ? normalizeGtin(patch.gtin) : patch.gtin;
  if (gtin) {
    const clash = await client.query.products.findFirst({
      where: and(eq(products.gtin, gtin), ne(products.id, productId), isNull(products.deletedAt)),
    });
    if (clash) {
      throw conflict(`GTIN ${gtin} already belongs to "${clash.name}".`);
    }
  }
  if (patch.brandId) {
    const brand = await client.query.brands.findFirst({ where: eq(brands.id, patch.brandId) });
    if (!brand) throw notFound("Brand");
  }
  if (patch.gstRateBp != null && (patch.gstRateBp < 0 || patch.gstRateBp > 10000)) {
    throw validationFailed("GST rate must be between 0 and 100%.");
  }

  const [updated] = await client
    .update(products)
    .set({
      ...(patch.brandId !== undefined ? { brandId: patch.brandId } : {}),
      ...(patch.subcategoryId !== undefined ? { subcategoryId: patch.subcategoryId } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(gtin !== undefined ? { gtin } : {}),
      ...(patch.barcode !== undefined ? { barcode: patch.barcode } : {}),
      ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
      ...(patch.hsnCode !== undefined ? { hsnCode: patch.hsnCode } : {}),
      ...(patch.gstRateBp !== undefined ? { gstRateBp: patch.gstRateBp } : {}),
      ...(patch.manufacturerName !== undefined ? { manufacturerName: patch.manufacturerName } : {}),
      ...(patch.manufacturerAddress !== undefined
        ? { manufacturerAddress: patch.manufacturerAddress }
        : {}),
      ...(patch.countryOfOrigin !== undefined ? { countryOfOrigin: patch.countryOfOrigin } : {}),
      ...(patch.netQuantity !== undefined ? { netQuantity: patch.netQuantity } : {}),
      ...(patch.netQuantityUnit !== undefined ? { netQuantityUnit: patch.netQuantityUnit } : {}),
    })
    .where(eq(products.id, productId))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_IDENTITY_UPDATED,
    entityType: "product",
    entityId: productId,
    previousValue: { gtin: current.gtin, brandId: current.brandId, hsnCode: current.hsnCode },
    newValue: { gtin: updated.gtin, brandId: updated.brandId, hsnCode: updated.hsnCode },
  });

  return updated;
}
