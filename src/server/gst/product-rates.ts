/**
 * The master product's own HSN code and GST rate, edited by an admin at
 * /admin/product-gst. This is the rate a tax invoice uses for a product when
 * the shop has no rate of its own; without one, the dated HSN fallback table
 * and then invoicing.defaultGstRateBp apply (services/invoices.ts).
 *
 * A change applies to invoices issued from now on: an issued invoice keeps the
 * rate in its own snapshot, so nothing already issued is re-taxed. For a
 * change that must start on a future date, use the dated HSN table at
 * /admin/gst-config. Every change is audited with the admin's reason.
 */
import { and, asc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { products, shopProducts, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { hsnFallbackRate } from "./rules";

/** GST rates in use in India (percent) — the only rates the editor accepts (TC-FLD-078). */
export const STANDARD_GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40] as const;

export const productGstSchema = z.object({
  /** 4, 6 or 8 digits (HSN / SAC); null clears it. */
  hsnCode: z
    .string()
    .trim()
    .regex(/^(\d{4}|\d{6}|\d{8})$/, "HSN: 4, 6 or 8 digits")
    .nullable(),
  /** Percent, up to two decimals (e.g. 0.25, 5, 18); null clears it. */
  gstRatePercent: z
    .number()
    .min(0, "GST rate must be between 0 and 100%.")
    .max(100, "GST rate must be between 0 and 100%.")
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Use at most two decimals.")
    // A rate that is not a GST rate (7 %) used to be saved with only a warning (TC-FLD-078).
    .refine(
      (v) => (STANDARD_GST_RATES as readonly number[]).includes(v),
      `Use a GST rate in force: ${STANDARD_GST_RATES.join(", ")}%.`,
    )
    .nullable(),
  /** Why — the CA's advice, a notification number. Kept in the audit log. */
  reason: z.string().trim().min(3, "Say why (at least 3 characters).").max(300),
});
export type ProductGstInput = z.infer<typeof productGstSchema>;

export type RateSource = "PRODUCT" | "HSN" | "DEFAULT";

export interface ProductGstRow {
  id: string;
  name: string;
  unit: string;
  unitSizeMilli: number;
  barcode: string | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  /** Shops that bill this product with their own rate (from their accounting software or a supplier bill). */
  shopOverrides: number;
  /** What a tax invoice issued today would use when the shop has no rate of its own. */
  effective: { source: RateSource; rateBp: number };
}

const listSchema = z.object({
  q: z.string().trim().max(80).optional(),
  missing: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export async function listProductGstRates(input: z.input<typeof listSchema> = {}): Promise<{ rows: ProductGstRow[]; missingTotal: number }> {
  const { q, missing, limit } = listSchema.parse(input);
  const filters = [isNull(products.deletedAt)];
  if (missing) filters.push(isNull(products.gstRateBp));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, "");
    filters.push(
      or(
        ilike(products.name, like),
        eq(products.barcode, q),
        eq(products.gtin, q),
        ...(digits.length >= 2 && digits === q ? [sql`${products.hsnCode} LIKE ${`${digits}%`}`] : []),
      )!,
    );
  }
  const overrides = db
    .select({ productId: shopProducts.productId, n: sql<number>`count(*)::int`.as("n") })
    .from(shopProducts)
    .where(isNotNull(shopProducts.gstRateBp))
    .groupBy(shopProducts.productId)
    .as("overrides");
  const [list, [{ missingTotal }], rule] = await Promise.all([
    db
      .select({
        id: products.id,
        name: products.name,
        unit: products.unit,
        unitSizeMilli: products.unitSizeMilli,
        barcode: products.barcode,
        hsnCode: products.hsnCode,
        gstRateBp: products.gstRateBp,
        shopOverrides: sql<number>`coalesce(${overrides.n}, 0)`,
      })
      .from(products)
      .leftJoin(overrides, eq(overrides.productId, products.id))
      .where(and(...filters))
      .orderBy(asc(products.name), asc(products.id))
      .limit(limit),
    db
      .select({ missingTotal: sql<number>`count(*)::int` })
      .from(products)
      .where(and(isNull(products.deletedAt), isNull(products.gstRateBp))),
    getRule("invoicing"),
  ]);
  const now = new Date();
  const rows: ProductGstRow[] = [];
  for (const p of list) {
    let effective: ProductGstRow["effective"];
    if (p.gstRateBp != null) effective = { source: "PRODUCT", rateBp: p.gstRateBp };
    else {
      const fallback = await hsnFallbackRate(p.hsnCode, now);
      effective = fallback ? { source: "HSN", rateBp: fallback.rateBp } : { source: "DEFAULT", rateBp: rule.defaultGstRateBp };
    }
    rows.push({ ...p, shopOverrides: Number(p.shopOverrides), effective });
  }
  return { rows, missingTotal: Number(missingTotal) };
}

export async function setProductGst(productId: string, input: ProductGstInput, actor: { id: string; role: UserRole }) {
  const gstRateBp = input.gstRatePercent == null ? null : Math.round(input.gstRatePercent * 100);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: products.id, name: products.name, hsnCode: products.hsnCode, gstRateBp: products.gstRateBp })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)))
      .for("update");
    if (!before) throw notFound("Product");
    if (before.hsnCode === input.hsnCode && before.gstRateBp === gstRateBp) {
      throw validationFailed("Nothing changed: the HSN code and GST rate are already these.");
    }
    const [updated] = await tx
      .update(products)
      .set({ hsnCode: input.hsnCode, gstRateBp })
      .where(eq(products.id, productId))
      .returning({ id: products.id, name: products.name, hsnCode: products.hsnCode, gstRateBp: products.gstRateBp });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_GST_CHANGED,
        entityType: "product",
        entityId: productId,
        previousValue: { hsnCode: before.hsnCode, gstRateBp: before.gstRateBp },
        newValue: { hsnCode: input.hsnCode, gstRateBp, reason: input.reason },
      },
      tx,
    );
    return updated;
  });
}
