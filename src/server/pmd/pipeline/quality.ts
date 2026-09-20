/**
 * DATA_QUALITY_SCORE (0-100) per master product.
 *
 * Six weighted components, all configurable (config.quality):
 *   identifier          how strongly the product is identified (valid GTIN > MPN+brand > model/SKU > nothing)
 *   sourceReliability   the best source that speaks about it
 *   corroboration       how many independent sources agree it exists
 *   completeness        how much of what this KIND of product should have is present
 *   matchConfidence     how sure we are its linked records are really one product
 *   recency             how recently a source last saw it
 *
 * Missing data is not zero. A component with no basis (e.g. no match confidence
 * recorded) is EXCLUDED and the remaining weights are renormalised. Missing
 * *fields* do lower completeness - that is what completeness measures - and the
 * exact list is stored so a steward sees what to fix.
 */
import type { PmdConfig, QualityConfig } from "../config";
import type { Queryable } from "../db";
import type { ReferenceIds } from "../reference-data";

export type QualityGroup = "FOOD" | "ELECTRONICS" | "APPAREL" | "GENERAL";

const FOOD_L1 = new Set(["grocery", "food", "beverages", "dairy", "health-and-wellness", "pet-supplies"]);
const PACK_L1 = new Set(["grocery", "food", "beverages", "dairy", "health-and-wellness", "pet-supplies", "beauty", "personal-care"]);

export function qualityGroupFor(categoryCode: string | null): { group: QualityGroup; packSensitive: boolean } {
  const l1 = categoryCode?.split("/")[0] ?? null;
  const group: QualityGroup = !l1 ? "GENERAL" : FOOD_L1.has(l1) ? "FOOD" : l1 === "electronics" ? "ELECTRONICS" : l1 === "apparel" ? "APPAREL" : "GENERAL";
  return { group, packSensitive: l1 != null && PACK_L1.has(l1) };
}

export interface QualityInput {
  hasValidGtin: boolean;
  hasIsbn: boolean;
  hasMpn: boolean;
  hasBrand: boolean;
  hasModelSkuOrCode: boolean;
  hasSourceCodeOnly: boolean;
  sourceReliabilities: number[];
  distinctSources: number;
  matchConfidence: number | null;
  lastSeenAt: Date;
  now: Date;
  categoryLevel: number;
  categoryIsUncategorised: boolean;
  categoryCode: string | null;
  present: {
    manufacturer: boolean;
    netQuantity: boolean;
    gst: boolean;
    hsn: boolean;
    description: boolean;
    image: boolean;
    color: boolean;
    size: boolean;
  };
  specKeys: ReadonlySet<string>;
}

export interface QualityComponent {
  /** null = no basis; excluded from the score rather than counted as zero. */
  score: number | null;
  weight: number;
  detail: string;
}

export interface QualityResult {
  score: number;
  components: Record<string, QualityComponent>;
  missingFields: string[];
}

function band(bands: ReadonlyArray<readonly [number, number]>, value: number, fallback: number): number {
  for (const [limit, score] of bands) if (value <= limit) return score;
  return fallback;
}

export function computeQuality(input: QualityInput, cfg: QualityConfig): QualityResult {
  const missing: string[] = [];
  const has = (k: string) => input.specKeys.has(k);

  /* identifier */
  let identifier: number;
  let idDetail: string;
  if (input.hasValidGtin || input.hasIsbn) [identifier, idDetail] = [100, "valid GTIN/ISBN"];
  else if (input.hasMpn && input.hasBrand) [identifier, idDetail] = [70, "MPN + brand"];
  else if (input.hasModelSkuOrCode) [identifier, idDetail] = [40, "model / SKU / product code only"];
  else if (input.hasSourceCodeOnly) [identifier, idDetail] = [15, "source code only (no valid GTIN)"];
  else [identifier, idDetail] = [0, "no identifier"];
  if (!input.hasValidGtin && !input.hasIsbn) missing.push("gtin");

  /* source reliability */
  const reliability = input.sourceReliabilities.length ? Math.max(...input.sourceReliabilities) : null;

  /* corroboration */
  const corroboration = input.distinctSources > 0
    ? [...cfg.corroboration].reverse().find(([n]) => input.distinctSources >= n)?.[1] ?? 0
    : null;

  /* completeness */
  const { group, packSensitive } = qualityGroupFor(input.categoryCode);
  const fields: Array<[string, boolean, number]> = [
    ["brand", input.hasBrand, 1],
    ["manufacturer", input.present.manufacturer, 1],
    ["gst_rate", input.present.gst, 1],
    ["hsn_code", input.present.hsn, 1],
    ["description", input.present.description, 1],
    ["image", input.present.image, 1],
    ["country_of_origin", has("country_of_origin"), 0.5],
  ];
  const depth = input.categoryIsUncategorised ? 0 : input.categoryLevel >= 4 ? 1 : input.categoryLevel === 3 ? 0.75 : input.categoryLevel === 2 ? 0.5 : input.categoryLevel === 1 ? 0.25 : 0;
  let earned = depth * 1.5;
  let possible = 1.5;
  if (depth < 0.75) missing.push("category");
  if (packSensitive) fields.push(["net_quantity", input.present.netQuantity, 1]);
  if (group === "FOOD") {
    fields.push(
      ["ingredients", has("ingredients"), 1.5],
      ["nutrition", has("energy_kcal_per_100g"), 1],
      ["vegetarian_nonveg", has("vegetarian_nonveg"), 0.5],
      ["fssai_number", has("fssai_number"), 1],
    );
  } else if (group === "ELECTRONICS") {
    fields.push(
      ["model_number", has("model_number") || input.hasModelSkuOrCode, 1],
      ["warranty", has("warranty") || has("warranty_period_months"), 0.5],
      ["key_specs", ["ram_gb", "storage_gb", "display_size_in", "processor"].some(has), 1],
    );
  } else if (group === "APPAREL") {
    fields.push(["fabric", has("fabric"), 1], ["size", input.present.size, 0.5], ["color", input.present.color, 0.5]);
  }
  for (const [name, present, weight] of fields) {
    possible += weight;
    if (present) earned += weight;
    else missing.push(name);
  }
  const completeness = (100 * earned) / possible;

  /* recency */
  const ageDays = Math.max(0, (input.now.getTime() - input.lastSeenAt.getTime()) / 86_400_000);
  const recency = band(cfg.recencyBands, ageDays, cfg.staleScore);

  const w = cfg.weights;
  const components: Record<string, QualityComponent> = {
    identifier: { score: identifier, weight: w.identifier, detail: idDetail },
    sourceReliability: { score: reliability, weight: w.sourceReliability, detail: reliability == null ? "no sources" : `best source ${reliability}` },
    corroboration: { score: corroboration, weight: w.corroboration, detail: `${input.distinctSources} source(s)` },
    completeness: { score: Math.round(completeness * 100) / 100, weight: w.completeness, detail: `${missing.length} missing field(s)` },
    matchConfidence: { score: input.matchConfidence, weight: w.matchConfidence, detail: input.matchConfidence == null ? "not recorded" : `${input.matchConfidence}` },
    recency: { score: recency, weight: w.recency, detail: `${Math.round(ageDays)} day(s) since last seen` },
  };

  // Components without a basis drop out and the rest are renormalised.
  let weighted = 0;
  let totalWeight = 0;
  for (const c of Object.values(components)) {
    if (c.score == null) continue;
    weighted += c.score * c.weight;
    totalWeight += c.weight;
  }
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : 0;
  return { score, components, missingFields: [...new Set(missing)] };
}

/** Recomputes and stores the quality score for the given masters. Returns how many were updated. */
export async function refreshQuality(
  sql: Queryable,
  ref: ReferenceIds,
  cfg: PmdConfig,
  productIds: number[],
  now: Date = new Date(),
): Promise<number> {
  let updated = 0;
  for (let i = 0; i < productIds.length; i += 500) {
    const chunk = productIds.slice(i, i + 500);
    const rows = await sql<
      {
        product_id: number; gtin: string | null; isbn: string | null; mpn: string | null; brand_id: number | null;
        manufacturer_id: number | null; model_number: string | null; sku: string | null; product_code: string | null;
        net_quantity_value: number | null; gst_rate_bp: number | null; hsn_code: string | null;
        long_description: string | null; short_description: string | null; color: string | null; size: string | null;
        match_confidence: number | null; last_seen_at: Date; category_code: string | null; category_level: number | null;
        image_count: number; source_ids: number[] | null; spec_keys: string[] | null; has_source_code: boolean;
      }[]
    >`
      SELECT pm.product_id, pm.gtin, pm.isbn, pm.mpn, pm.brand_id, pm.manufacturer_id, pm.model_number, pm.sku, pm.product_code,
             pm.net_quantity_value, pm.gst_rate_bp, pm.hsn_code, pm.long_description, pm.short_description, pm.color, pm.size,
             pm.match_confidence, pm.last_seen_at, c.category_code, c.level AS category_level,
             (SELECT count(*)::int FROM pmd.product_image i WHERE i.product_id = pm.product_id) AS image_count,
             (SELECT array_agg(DISTINCT ps.source_id) FROM pmd.product_source ps WHERE ps.product_id = pm.product_id) AS source_ids,
             (SELECT array_agg(DISTINCT sp.attribute_key) FROM pmd.product_specification sp WHERE sp.product_id = pm.product_id) AS spec_keys,
             EXISTS (SELECT 1 FROM pmd.product_identifier pi WHERE pi.product_id = pm.product_id AND pi.id_type = 'SOURCE_CODE') AS has_source_code
      FROM pmd.product_master pm
      LEFT JOIN pmd.category c ON c.category_id = pm.category_id
      WHERE pm.product_id IN ${sql(chunk)}`;

    const ids: number[] = [];
    const scores: number[] = [];
    const comps: string[] = [];
    for (const r of rows) {
      const q = computeQuality(
        {
          hasValidGtin: r.gtin != null,
          hasIsbn: r.isbn != null,
          hasMpn: r.mpn != null,
          hasBrand: r.brand_id != null,
          hasModelSkuOrCode: r.model_number != null || r.sku != null || r.product_code != null,
          hasSourceCodeOnly: r.has_source_code,
          sourceReliabilities: (r.source_ids ?? []).map((id) => ref.sourceMeta.get(id)?.reliability).filter((v): v is number => v != null),
          distinctSources: (r.source_ids ?? []).length,
          matchConfidence: r.match_confidence,
          lastSeenAt: r.last_seen_at,
          now,
          categoryLevel: r.category_level ?? 0,
          categoryIsUncategorised: r.category_code == null || r.category_code.startsWith("uncategorised"),
          categoryCode: r.category_code,
          present: {
            manufacturer: r.manufacturer_id != null,
            netQuantity: r.net_quantity_value != null,
            gst: r.gst_rate_bp != null,
            hsn: r.hsn_code != null,
            description: r.long_description != null || r.short_description != null,
            image: r.image_count > 0,
            color: r.color != null,
            size: r.size != null,
          },
          specKeys: new Set(r.spec_keys ?? []),
        },
        cfg.quality,
      );
      ids.push(r.product_id);
      scores.push(q.score);
      comps.push(JSON.stringify({ components: q.components, missingFields: q.missingFields }));
    }
    if (ids.length === 0) continue;
    await sql`
      UPDATE pmd.product_master pm
         SET data_quality_score = v.score, quality_components = v.comp::jsonb, quality_computed_at = now()
        FROM (SELECT unnest(${ids}::bigint[]) AS id, unnest(${scores}::numeric[]) AS score, unnest(${comps}::text[]) AS comp) v
       WHERE pm.product_id = v.id`;
    updated += ids.length;
  }
  return updated;
}
