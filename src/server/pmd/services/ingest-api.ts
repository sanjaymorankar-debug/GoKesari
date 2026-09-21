/**
 * Import, dry-run matching and validation for the API.
 *
 * import    writes: runs the ordinary pipeline through the `manual_import` source
 * match     read-only: "what would happen to this record?" - candidates, scores, decision
 * validate  pure: normalisation and every issue found, nothing looked up or written
 *
 * A client may supply a standard category as its slug path ("dairy/milk") in `categories`;
 * anything else in `categories` is unmapped and the product is filed as uncategorised.
 */
import { resolveConfig } from "../config";
import type { Sql } from "../db";
import { matchNormalized } from "../match/engine";
import { subjectFromNormalized } from "../match/score";
import { normalizeStaged } from "../normalize";
import { normalizeText } from "../normalize/text";
import { runIngestion, type RunSummary } from "../pipeline/run";
import { createRowsAdapter } from "../sources/adapters/rows";
import { getSourceDefinition } from "../sources/registry";
import { getTaxonomy } from "../taxonomy/categories";
import { createCategoryMapper, normalizeSourceCategory, type CategoryMapper } from "../taxonomy/mapper";
import type { NormalizedProduct, StagedProduct } from "../types";

let cachedMapper: CategoryMapper | null = null;

/** Lets API callers name a standard category by its slug path. */
export function standardCodeMapper(): CategoryMapper {
  return (cachedMapper ??= createCategoryMapper({
    tags: Object.fromEntries(getTaxonomy().map((c) => [normalizeSourceCategory(c.code), c.code])),
    keywords: [],
  }));
}

export async function importProducts(sql: Sql, rows: StagedProduct[], triggeredBy: string): Promise<RunSummary> {
  const def = getSourceDefinition("manual_import");
  if (!def) throw new Error("manual_import source is not registered");
  const adapter = createRowsAdapter({ definition: def, rows, categoryMapper: standardCodeMapper() });
  return runIngestion(sql, adapter, { mode: "IMPORT", triggeredBy });
}

export interface NormalizedSummary {
  name: string;
  coreName: string;
  brand: string | null;
  gtin14: string | null;
  gtinUsableForMatching: boolean;
  packLabel: string | null;
  categoryCode: string | null;
  gstRateBp: number | null;
  hsnCode: string | null;
  countryOfOrigin: string | null;
  attributes: { key: string; value: string | number | boolean | null; unit: string | null }[];
  offer: { priceMinor: number | null; mrpMinor: number | null; currency: string; stockStatus: string; sellerKey: string } | null;
}

function summarize(n: NormalizedProduct): NormalizedSummary {
  return {
    name: n.name,
    coreName: n.coreName,
    brand: n.brand?.display ?? null,
    gtin14: n.gtin?.gtin14 ?? null,
    gtinUsableForMatching: n.gtin?.usableForMatching ?? false,
    packLabel: n.quantity?.label ?? null,
    categoryCode: n.categoryCode,
    gstRateBp: n.gstRateBp,
    hsnCode: n.hsnCode,
    countryOfOrigin: n.countryOfOrigin,
    attributes: n.attributes.map((a) => ({ key: a.key, value: a.valueNum ?? a.valueBool ?? a.valueText ?? null, unit: a.unit ?? null })),
    offer: n.offer ? { priceMinor: n.offer.priceMinor, mrpMinor: n.offer.mrpMinor, currency: n.offer.currency, stockStatus: n.offer.stockStatus, sellerKey: n.offer.sellerKey } : null,
  };
}

export function validateProduct(staged: StagedProduct) {
  const n = normalizeStaged(staged, { categoryMapper: standardCodeMapper() });
  const blocking = n.issues.filter((i) => i.severity === "ERROR");
  return {
    valid: blocking.length === 0,
    wouldBeLoaded: blocking.length === 0,
    issues: n.issues,
    normalized: summarize(n),
  };
}

export async function matchProduct(sql: Sql, staged: StagedProduct) {
  const n = normalizeStaged(staged, { categoryMapper: standardCodeMapper() });
  const cfg = resolveConfig();
  const subject = subjectFromNormalized(n);

  if (!n.name) {
    return { decision: { action: "REJECT", reason: "NAME_MISSING" }, normalized: summarize(n), issues: n.issues, candidates: [] };
  }

  // Read-only transaction: the trigram threshold is set with set_config(..., true), which lives only inside one.
  const result = await sql.begin("read only", async (tx) => {
    let brandId: number | null = null;
    if (n.brand) {
      const alias = normalizeText(n.brand.original).replace(/ /g, "");
      const [b] = await tx<{ brand_id: number }[]>`
        SELECT brand_id FROM pmd.brand WHERE brand_key = ${n.brand.key}
        UNION ALL SELECT brand_id FROM pmd.brand_alias WHERE alias_key = ${alias} LIMIT 1`;
      brandId = b?.brand_id ?? null;
    }
    return matchNormalized(tx as unknown as Sql, n, brandId, cfg);
  });

  const ids = result.scored.map((s) => s.productId);
  const names = ids.length
    ? await sql<{ product_id: number; master_product_id: string; product_name: string; pack_size: string | null; gtin: string | null }[]>`
        SELECT product_id, master_product_id, product_name, pack_size, gtin FROM pmd.product_master WHERE product_id = ANY(${ids}::bigint[])`
    : [];
  const byId = new Map(names.map((r) => [r.product_id, r]));

  return {
    decision: {
      action: result.decision.action,
      reason: result.decision.reason,
      linksTo: result.decision.action === "LINK" && result.decision.best ? byId.get(result.decision.best.productId)?.master_product_id ?? null : null,
    },
    thresholds: { autoMerge: cfg.match.autoMergeThreshold, possible: cfg.match.possibleThreshold },
    normalized: summarize(n),
    subject,
    issues: n.issues,
    candidates: result.scored
      .sort((a, b) => b.result.score - a.result.score)
      .map((s) => ({
        masterProductId: byId.get(s.productId)?.master_product_id ?? null,
        productName: byId.get(s.productId)?.product_name ?? null,
        packSize: byId.get(s.productId)?.pack_size ?? null,
        gtin: byId.get(s.productId)?.gtin ?? null,
        score: s.result.score,
        status: s.result.status,
        relation: s.result.relation,
        rule: s.result.rule,
        hardConflicts: s.result.hardConflicts,
        notes: s.result.notes,
        components: s.result.components,
      })),
  };
}
