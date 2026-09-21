/**
 * The bridge from the Product Master to GoKesari's live marketplace catalogue.
 *
 *   pmd.product_master        (universal, multi-source, millions)
 *        |  promote  (this module - explicit, audited, operator/admin only)
 *        v
 *   public.products           GOKESARI_PRODUCT_CATALOG  (what shops can pick)
 *        |
 *        v
 *   public.shop_products      SHOP_PRODUCT_CATALOG      (per-shop selling price, stock)
 *
 * Rules that keep the two worlds honest:
 *   - Seller pricing NEVER crosses the bridge. Marketplace prices are observations, not
 *     GoKesari's MRP; `products.mrp_paise` is filled only from a source that may verify MRP.
 *   - Shops select an existing catalogue product; they never re-create it. Two shops selling
 *     the same master product both reference the SAME public.products row.
 *   - An existing catalogue product with the same GTIN (in ANY of its written forms) is
 *     adopted, not duplicated - GoKesari stores GTINs as scanned, so EAN-13 and UPC-A of one
 *     item would otherwise slip past its unique index.
 *   - Promotion is one transaction with its audit row; nothing half-happens.
 */
import type { Sql, TransactionSql } from "../db";
import { toEan13, toUpcA } from "../normalize/identifiers";
import { slugify } from "../taxonomy/categories";

export class PromotionError extends Error {
  constructor(public readonly code: string, message: string, public readonly reasons: string[] = []) {
    super(message);
    this.name = "PromotionError";
  }
}

export interface PromotionActor {
  userId: string;
  role: string;
}

export interface PromotionOptions {
  /** Minimum data-quality score to promote (0-100). Default 40. */
  minQuality?: number;
  note?: string | null;
  /** Link the source's image URLs to the catalogue row (default true). Turn off where the image licence or hosting is unresolved. */
  images?: boolean;
}

export interface PromotionResult {
  masterProductId: string;
  catalogueProductId: string;
  catalogueProductCode: string;
  adopted: boolean;
  created: { product: boolean; brand: boolean };
}

const MRP_TRUSTED_KINDS = ["BRAND_MANUFACTURER", "GS1", "GOVERNMENT"];

interface MasterForPromotion {
  product_id: number;
  master_product_id: string;
  record_status: string;
  product_name: string;
  short_description: string | null;
  long_description: string | null;
  gtin: string | null;
  brand_id: number | null;
  brand_name: string | null;
  manufacturer_name: string | null;
  category_id: number | null;
  category_code: string | null;
  category_level: number | null;
  gokesari_department: string | null;
  category_path: string[] | null;
  net_quantity_value: number | null;
  net_quantity_unit: string | null;
  pack_count: number | null;
  variant_name: string | null;
  hsn_code: string | null;
  gst_rate_bp: number | null;
  data_quality_score: number | null;
  country_of_origin: string | null;
}

/** GTIN forms GoKesari may have stored for the same item: GTIN-14, EAN-13, UPC-A. */
export function gtinForms(gtin14: string): string[] {
  return [gtin14, toEan13(gtin14), toUpcA(gtin14)].filter((g): g is string => !!g);
}

/** The form new catalogue rows use: EAN-13 when the code has one, else GTIN-14. */
export function catalogueGtin(gtin14: string): string {
  return toEan13(gtin14) ?? gtin14;
}

/**
 * GoKesari's convention: `net_quantity` is the printed quantity in the BASE unit (1000 with "ml"),
 * while `unit` is only how it is displayed to shoppers (1000 ml -> "L").
 */
function displayUnit(value: number | null, unit: string | null): { unit: string; netQuantity: number | null; netUnit: string | null } {
  if (value == null || !unit) return { unit: "piece", netQuantity: null, netUnit: null };
  const q = Math.round(value);
  const whole = q >= 1000 && q % 1000 === 0;
  if (unit === "g") return { unit: whole ? "kg" : "g", netQuantity: q, netUnit: "g" };
  if (unit === "ml") return { unit: whole ? "L" : "ml", netQuantity: q, netUnit: "ml" };
  return { unit: "piece", netQuantity: q, netUnit: "piece" };
}

async function uniqueSlug(tx: TransactionSql, table: "products" | "brands", base: string): Promise<string> {
  const root = slugify(base) || "item";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await tx.unsafe<{ n: number }[]>(`SELECT 1 AS n FROM public.${table} WHERE slug = $1`, [candidate]);
    if (!hit) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/** Finds the operational category for a master category: same department, L2 name if it exists, else the department's default. */
async function resolveOperationalCategory(tx: TransactionSql, m: MasterForPromotion): Promise<{ id: string } | null> {
  if (!m.gokesari_department) return null;
  const l2 = m.category_path?.[1] ?? null;
  if (l2) {
    const [byName] = await tx<{ id: string }[]>`
      SELECT id FROM public.product_categories
      WHERE department = ${m.gokesari_department}::department AND lower(name) = lower(${l2}) AND deleted_at IS NULL LIMIT 1`;
    if (byName) return byName;
  }
  const [dflt] = await tx<{ id: string }[]>`
    SELECT id FROM public.product_categories
    WHERE department = ${m.gokesari_department}::department AND deleted_at IS NULL ORDER BY sort_order, created_at LIMIT 1`;
  return dflt ?? null;
}

export async function promoteToCatalogue(
  sql: Sql,
  masterProductId: string,
  actor: PromotionActor,
  opts: PromotionOptions = {},
): Promise<PromotionResult> {
  const minQuality = opts.minQuality ?? 40;

  return sql.begin(async (tx) => {
    const [m] = await tx<MasterForPromotion[]>`
      SELECT pm.product_id, pm.master_product_id, pm.record_status, pm.product_name, pm.short_description, pm.long_description,
             pm.gtin, pm.brand_id, b.brand_name, mf.manufacturer_name, pm.category_id, c.category_code, c.level AS category_level,
             c.gokesari_department, c.path_names AS category_path, pm.net_quantity_value, pm.net_quantity_unit, pm.pack_count,
             pm.variant_name, pm.hsn_code, pm.gst_rate_bp, pm.data_quality_score,
             (SELECT sp.value_text FROM pmd.product_specification sp WHERE sp.product_id = pm.product_id AND sp.attribute_key = 'country_of_origin' AND sp.is_preferred LIMIT 1) AS country_of_origin
      FROM pmd.product_master pm
      LEFT JOIN pmd.brand b ON b.brand_id = pm.brand_id
      LEFT JOIN pmd.manufacturer mf ON mf.manufacturer_id = pm.manufacturer_id
      LEFT JOIN pmd.category c ON c.category_id = pm.category_id
      WHERE pm.master_product_id = ${masterProductId} FOR UPDATE OF pm`;
    if (!m) throw new PromotionError("NOT_FOUND", `No master product ${masterProductId}.`);

    const problems: string[] = [];
    if (m.record_status !== "ACTIVE") problems.push(`record is ${m.record_status}`);
    if (m.data_quality_score != null && m.data_quality_score < minQuality) problems.push(`data-quality score ${m.data_quality_score} is below ${minQuality}`);
    if (problems.length) throw new PromotionError("NOT_ELIGIBLE", `${masterProductId} cannot be promoted: ${problems.join("; ")}.`, problems);

    const [already] = await tx<{ catalogue_product_id: string }[]>`SELECT catalogue_product_id FROM pmd.catalogue_link WHERE product_id = ${m.product_id}`;
    if (already) throw new PromotionError("ALREADY_PROMOTED", `${masterProductId} is already in the catalogue.`);


    // Adopt an existing catalogue product with the same GTIN (any written form) instead of duplicating it.
    if (m.gtin) {
      const forms = gtinForms(m.gtin);
      const [existing] = await tx<{ id: string; code: string }[]>`
        SELECT id, code FROM public.products WHERE gtin = ANY(${forms}::text[]) AND deleted_at IS NULL LIMIT 1`;
      if (existing) {
        const [taken] = await tx`SELECT 1 FROM pmd.catalogue_link WHERE catalogue_product_id = ${existing.id}`;
        if (taken) throw new PromotionError("CATALOGUE_TAKEN", `Catalogue product ${existing.code} is already linked to another master product.`);
        await tx`INSERT INTO pmd.catalogue_link (product_id, catalogue_product_id, promoted_by, promotion_note) VALUES (${m.product_id}, ${existing.id}, ${actor.userId}, ${opts.note ?? "Adopted existing catalogue product with the same GTIN"})`;
        await audit(tx, actor, "pmd.product_adopted", existing.id, { masterProductId, adopted: true });
        return { masterProductId, catalogueProductId: existing.id, catalogueProductCode: existing.code, adopted: true, created: { product: false, brand: false } };
      }
    }

    // A NEW catalogue row needs a standard category and a marketplace category to file it under.
    if (!m.category_id) {
      throw new PromotionError("NOT_ELIGIBLE", `${masterProductId} cannot be promoted: no standard category.`, ["no standard category"]);
    }
    const category = await resolveOperationalCategory(tx, m);
    if (!category) {
      throw new PromotionError("NO_OPERATIONAL_CATEGORY", `No marketplace category exists for department ${m.gokesari_department ?? "(none)"}; create one before promoting.`, [
        "no operational category",
      ]);
    }
    // Brand: reuse by slug, or add it (brands are shared by every shop, so this is the operator's call).
    let brandId: string | null = null;
    let createdBrand = false;
    if (m.brand_name) {
      const brandSlug = slugify(m.brand_name);
      // Two promotions of the same NEW brand at once would both miss it, and the second would then pick "brand-2" as its
      // slug and create a duplicate. Queue them per brand: the second waits for the first to commit, then finds its row.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"pmd.catalogue-brand:" + brandSlug}, 0))`;
      const [b] = await tx<{ id: string }[]>`SELECT id FROM public.brands WHERE slug = ${brandSlug} AND deleted_at IS NULL`;
      if (b) brandId = b.id;
      else {
        const slug = await uniqueSlug(tx, "brands", m.brand_name);
        const [nb] = await tx<{ id: string }[]>`INSERT INTO public.brands (name, slug, created_by) VALUES (${m.brand_name}, ${slug}, ${actor.userId}) RETURNING id`;
        brandId = nb.id;
        createdBrand = true;
      }
    }

    // MRP crosses only from a source entitled to verify it. Marketplace / crowd prices never do.
    const [mrp] = await tx<{ mrp_minor: number; source_key: string; kind: string }[]>`
      SELECT o.mrp_minor, s.source_key, s.source_kind AS kind
      FROM pmd.product_offer o JOIN pmd.source s USING (source_id)
      WHERE o.product_id = ${m.product_id} AND o.mrp_minor IS NOT NULL AND o.currency = 'INR' AND s.source_kind = ANY(${MRP_TRUSTED_KINDS}::text[])
      ORDER BY o.collected_at DESC LIMIT 1`;

    const packaged = !!(m.gtin || m.net_quantity_value);
    const { unit, netQuantity, netUnit } = displayUnit(m.net_quantity_value, m.net_quantity_unit);
    const slug = await uniqueSlug(tx, "products", `${m.brand_name ? m.brand_name + " " : ""}${m.product_name}`);

    const [p] = await tx<{ id: string; code: string }[]>`
      INSERT INTO public.products
        (category_id, name, slug, description, brand_id, kind, gtin, variant, hsn_code, gst_rate_bp,
         manufacturer_name, country_of_origin, net_quantity, net_quantity_unit, unit,
         mrp_paise, mrp_source, mrp_effective_from, mrp_verification_status, mrp_updated_at,
         approval_status, approved_by, approved_at, created_by)
      VALUES (${category.id}, ${m.product_name}, ${slug}, ${m.long_description ?? m.short_description}, ${brandId},
              ${packaged ? "PACKAGED" : "LOOSE"}::product_kind, ${m.gtin ? catalogueGtin(m.gtin) : null}, ${m.variant_name},
              ${m.hsn_code}, ${m.gst_rate_bp}, ${m.manufacturer_name}, ${m.country_of_origin},
              ${netQuantity}, ${netUnit}, ${unit},
              ${mrp?.mrp_minor ?? null}, ${mrp ? (mrp.kind === "BRAND_MANUFACTURER" ? "BRAND" : mrp.kind === "GS1" ? "GS1" : "IMPORT") : null}::mrp_source,
              ${mrp ? tx`current_date` : null}, ${mrp ? "PENDING_VERIFICATION" : "UNVERIFIED"}::mrp_verification_status, ${mrp ? tx`now()` : null},
              'APPROVED'::product_approval_status, ${actor.userId}, now(), ${actor.userId})
      RETURNING id, code`;

    // Images are referenced, not copied.
    const images = opts.images === false ? [] : await tx<{ image_url: string; rank: number }[]>`SELECT image_url, rank FROM pmd.product_image WHERE product_id = ${m.product_id} ORDER BY rank LIMIT 5`;
    if (images.length) {
      await tx`UPDATE public.products SET image_url = ${images[0].image_url} WHERE id = ${p.id}`;
      for (const [i, img] of images.slice(1).entries()) {
        await tx`INSERT INTO public.product_images (product_id, url, sort_order) VALUES (${p.id}, ${img.image_url}, ${i})`;
      }
    }

    await tx`INSERT INTO pmd.catalogue_link (product_id, catalogue_product_id, promoted_by, promotion_note) VALUES (${m.product_id}, ${p.id}, ${actor.userId}, ${opts.note ?? null})`;
    await audit(tx, actor, "pmd.product_promoted", p.id, { masterProductId, catalogueProductCode: p.code, brandCreated: createdBrand, mrpFrom: mrp?.source_key ?? null });
    return { masterProductId, catalogueProductId: p.id, catalogueProductCode: p.code, adopted: false, created: { product: true, brand: createdBrand } };
  });
}

/** Written in the same transaction as the promotion, so a rolled-back promotion leaves no phantom audit entry. */
async function audit(tx: TransactionSql, actor: PromotionActor, action: string, entityId: string, detail: Record<string, unknown>): Promise<void> {
  await tx`
    INSERT INTO public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, new_value)
    VALUES (${actor.userId}, ${actor.role}::user_role, ${action}, 'product', ${entityId}, ${tx.json(detail as never)})`;
}

/** Which shops sell a master product, through the catalogue link (Section 30: "both reference MASTER_PRODUCT_ID"). */
export async function shopsSellingMasterProduct(sql: Sql, masterProductId: string) {
  return sql<{ shop_id: string; shop_name: string; catalogue_product_code: string; online_price_paise: number | null; online_stock: number }[]>`
    SELECT s.id AS shop_id, s.name AS shop_name, p.code AS catalogue_product_code, sp.online_price_paise, sp.online_stock
    FROM pmd.product_master pm
    JOIN pmd.catalogue_link cl ON cl.product_id = pm.product_id
    JOIN public.products p ON p.id = cl.catalogue_product_id
    JOIN public.shop_products sp ON sp.product_id = p.id AND sp.deleted_at IS NULL
    JOIN public.shops s ON s.id = sp.shop_id
    WHERE pm.master_product_id = ${masterProductId}
    ORDER BY s.name`;
}
