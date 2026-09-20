/**
 * Manual review and merging.
 *
 * The matcher never merges below its threshold; it queues. This module is what a
 * person uses to resolve that queue:
 *
 *   CONFIRMED_SAME       the two are one product - merge them (or link a held record)
 *   CONFIRMED_DIFFERENT  they are separate products - close the item
 *   SAME_FAMILY          separate products of one line (pack sizes / variants) - group them
 *
 * A merge is the only place a master is retired, and it retires it by POINTER
 * (record_status = MERGED, merged_into_product_id), never by deleting: its sources,
 * offers and full price history move to the survivor, every identifier and specification
 * is kept, and the merge is written to product_merge_log and the change log.
 */
import { resolveConfig } from "../config";
import type { Sql, TransactionSql } from "../db";
import { loadReferenceIds } from "../reference-data";
import { recomputeProductStatus } from "./offers";
import { refreshQuality } from "./quality";
import { resolveAttribute } from "./specs";

export interface ReviewActor {
  /** The application user (public.users.id) making the decision; null for a system action. */
  userId: string | null;
  /** Human-readable label written to the audit trail, e.g. an email. */
  label: string;
}

export class ReviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

/** Columns filled on the survivor from the retired master when the survivor has none. */
const FILL_COLUMNS = [
  "brand_id", "manufacturer_id", "category_id", "short_description", "long_description", "variant_name", "sku", "mpn",
  "model_number", "product_code", "net_quantity_value", "net_quantity_unit", "pack_size", "pack_count", "unit_count",
  "material", "color", "size", "shape", "gst_rate_bp", "hsn_code", "cess_bp", "net_weight_g", "gross_weight_g",
  "length_mm", "width_mm", "height_mm", "volume_ml", "product_family_id",
] as const;

export interface MergeResult {
  fromProductId: number;
  intoProductId: number;
  sourcesMoved: number;
  offersMoved: number;
  historyRowsMoved: number;
  specsMoved: number;
}

export async function mergeProducts(
  sql: Sql,
  fromProductId: number,
  intoProductId: number,
  actor: ReviewActor,
  reason: string | null,
): Promise<MergeResult> {
  if (fromProductId === intoProductId) throw new ReviewError("SAME_PRODUCT", "Cannot merge a product into itself.");

  return sql.begin(async (tx) => {
    const rows = await tx<{ product_id: number; record_status: string }[]>`
      SELECT product_id, record_status FROM pmd.product_master
      WHERE product_id IN (${fromProductId}, ${intoProductId}) ORDER BY product_id FOR UPDATE`;
    if (rows.length !== 2) throw new ReviewError("NOT_FOUND", "Both products must exist.");
    if (rows.some((r) => r.record_status !== "ACTIVE")) throw new ReviewError("NOT_ACTIVE", "Only ACTIVE products can be merged.");

    // A product already promoted to the marketplace catalogue cannot be silently absorbed.
    const links = await tx<{ product_id: number }[]>`SELECT product_id FROM pmd.catalogue_link WHERE product_id IN (${fromProductId}, ${intoProductId})`;
    if (links.length === 2) {
      throw new ReviewError("BOTH_IN_CATALOGUE", "Both products are already in the marketplace catalogue; resolve the catalogue entries first.");
    }
    if (links.length === 1 && links[0].product_id === fromProductId) {
      await tx`UPDATE pmd.catalogue_link SET product_id = ${intoProductId} WHERE product_id = ${fromProductId}`;
    }

    const sources = await tx`UPDATE pmd.product_source SET product_id = ${intoProductId} WHERE product_id = ${fromProductId}`;
    const offers = await tx`UPDATE pmd.product_offer SET product_id = ${intoProductId} WHERE product_id = ${fromProductId}`;
    const history = await tx`UPDATE pmd.price_history SET product_id = ${intoProductId} WHERE product_id = ${fromProductId}`;

    // Images: keep the survivor's, add the retired one's that are new, up to the six-image limit.
    const [{ n: haveImages }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.product_image WHERE product_id = ${intoProductId}`;
    const fromImages = await tx<{ image_id: number; image_url: string }[]>`SELECT image_id, image_url FROM pmd.product_image WHERE product_id = ${fromProductId} ORDER BY rank`;
    let rank = haveImages;
    for (const img of fromImages) {
      const dup = await tx`SELECT 1 FROM pmd.product_image WHERE product_id = ${intoProductId} AND image_url = ${img.image_url}`;
      if (dup.length === 0 && rank < 6) {
        await tx`UPDATE pmd.product_image SET product_id = ${intoProductId}, rank = ${rank++} WHERE image_id = ${img.image_id}`;
      } else {
        await tx`DELETE FROM pmd.product_image WHERE image_id = ${img.image_id}`; // a duplicate link, not history
      }
    }

    // Identifiers: every one is kept on the survivor; duplicates collapse; only one is primary.
    await tx`UPDATE pmd.product_identifier SET is_primary = false WHERE product_id = ${fromProductId}`;
    await tx`
      UPDATE pmd.product_identifier f SET product_id = ${intoProductId}
       WHERE f.product_id = ${fromProductId}
         AND NOT EXISTS (SELECT 1 FROM pmd.product_identifier i WHERE i.product_id = ${intoProductId} AND i.id_type = f.id_type AND i.id_value = f.id_value)`;
    await tx`DELETE FROM pmd.product_identifier WHERE product_id = ${fromProductId}`;

    // Specifications: each source's value survives; then every affected attribute is re-resolved.
    const moved = await tx<{ attribute_key: string }[]>`
      UPDATE pmd.product_specification f SET product_id = ${intoProductId}, is_preferred = false
       WHERE f.product_id = ${fromProductId}
         AND NOT EXISTS (SELECT 1 FROM pmd.product_specification i WHERE i.product_id = ${intoProductId} AND i.attribute_key = f.attribute_key AND i.source_id = f.source_id)
      RETURNING attribute_key`;
    await tx`DELETE FROM pmd.product_specification WHERE product_id = ${fromProductId}`;
    await tx`
      UPDATE pmd.product_attribute_conflict SET conflict_status = 'IGNORED', resolution = ${`Product merged into ${intoProductId}`}, resolution_source = 'MERGE', resolution_date = now()
       WHERE product_id = ${fromProductId} AND conflict_status = 'OPEN'`;

    // Review items that pointed at the retired master now point at the survivor.
    await tx`
      UPDATE pmd.match_candidate c SET candidate_product_id = ${intoProductId}
       WHERE c.candidate_product_id = ${fromProductId}
         AND NOT EXISTS (SELECT 1 FROM pmd.match_candidate x WHERE x.product_source_id = c.product_source_id AND x.candidate_product_id = ${intoProductId})`;
    await tx`DELETE FROM pmd.match_candidate WHERE candidate_product_id = ${fromProductId}`;

    // Fill blanks on the survivor from the retired master (never overwrite).
    await tx.unsafe(
      `UPDATE pmd.product_master s SET ${FILL_COLUMNS.map((c) => `${c} = COALESCE(s.${c}, f.${c})`).join(", ")},
              version = s.version + 1, updated_at = now(),
              match_confidence = LEAST(COALESCE(s.match_confidence, 100), COALESCE(f.match_confidence, 100))
         FROM pmd.product_master f
        WHERE s.product_id = $1 AND f.product_id = $2`,
      [intoProductId, fromProductId],
    );

    await tx`
      UPDATE pmd.product_master SET record_status = 'MERGED', merged_into_product_id = ${intoProductId}, updated_at = now()
       WHERE product_id = ${fromProductId}`;
    await tx`
      INSERT INTO pmd.product_merge_log (from_product_id, into_product_id, reason, merged_by)
      VALUES (${fromProductId}, ${intoProductId}, ${reason}, ${actor.label})`;
    await tx`
      INSERT INTO pmd.product_change_log (product_id, entity, field_name, old_value, new_value, changed_by)
      VALUES (${intoProductId}, 'product_master', 'merged_from', ${tx.json(null as never)}, ${tx.json({ fromProductId, reason } as never)}, ${actor.label}),
             (${fromProductId}, 'product_master', 'merged_into', ${tx.json(null as never)}, ${tx.json({ intoProductId, reason } as never)}, ${actor.label})`;

    const ref = await loadReferenceIds(tx);
    for (const key of new Set(moved.map((m) => m.attribute_key))) {
      await resolveAttribute(tx, { ref, sourceId: 0, runId: null, sourceUrl: null, confidence: null }, intoProductId, key);
    }
    await recomputeProductStatus(tx, [intoProductId]);
    await refreshQuality(tx, ref, resolveConfig(), [intoProductId]);

    return {
      fromProductId,
      intoProductId,
      sourcesMoved: sources.count,
      offersMoved: offers.count,
      historyRowsMoved: history.count,
      specsMoved: moved.length,
    };
  });
}

export type ReviewDecision = "CONFIRMED_SAME" | "CONFIRMED_DIFFERENT" | "SAME_FAMILY";

export interface DecisionResult {
  candidateId: number;
  decision: ReviewDecision;
  merged?: MergeResult;
  linkedHeldRecord?: boolean;
}

async function ensureSharedFamily(tx: TransactionSql, a: number, b: number): Promise<void> {
  const rows = await tx<{ product_id: number; brand_id: number | null; product_family_id: number | null; normalized_name: string; category_id: number | null }[]>`
    SELECT product_id, brand_id, product_family_id, normalized_name, category_id FROM pmd.product_master WHERE product_id IN (${a}, ${b}) FOR UPDATE`;
  if (rows.length !== 2) throw new ReviewError("NOT_FOUND", "Both products must exist.");
  const existing = rows.find((r) => r.product_family_id != null)?.product_family_id ?? null;
  let familyId = existing;
  if (familyId == null) {
    const r = rows[0];
    const [f] = await tx<{ family_id: number }[]>`
      INSERT INTO pmd.product_family (brand_id, family_key, family_name, category_id)
      VALUES (${r.brand_id}, ${`manual-${a}-${b}`}, ${r.normalized_name || "Product family"}, ${r.category_id})
      RETURNING family_id`;
    familyId = f.family_id;
  }
  await tx`UPDATE pmd.product_master SET product_family_id = ${familyId} WHERE product_id IN (${a}, ${b})`;
}

export async function decideCandidate(
  sql: Sql,
  candidateId: number,
  decision: ReviewDecision,
  actor: ReviewActor,
  note: string | null = null,
): Promise<DecisionResult> {
  // Merging opens its own transaction, so a same-product decision is committed as a unit below.
  const cand = await sql.begin(async (tx) => {
    const [c] = await tx<{ candidate_id: number; product_source_id: number; candidate_product_id: number; review_status: string }[]>`
      SELECT candidate_id, product_source_id, candidate_product_id, review_status FROM pmd.match_candidate WHERE candidate_id = ${candidateId} FOR UPDATE`;
    if (!c) throw new ReviewError("NOT_FOUND", "Review item not found.");
    if (c.review_status !== "PENDING") throw new ReviewError("ALREADY_DECIDED", `Review item is already ${c.review_status}.`);
    return c;
  });

  const [src] = await sql<{ product_id: number | null }[]>`SELECT product_id FROM pmd.product_source WHERE product_source_id = ${cand.product_source_id}`;
  const result: DecisionResult = { candidateId, decision };

  if (decision === "CONFIRMED_SAME") {
    if (src.product_id == null) {
      // A held record (e.g. a GTIN collision): attach it to the confirmed product. Clearing the
      // content hash makes the source's next run re-load it in full through the ordinary path.
      await sql`
        UPDATE pmd.product_source SET product_id = ${cand.candidate_product_id}, resolution = 'MANUAL_LINK', content_hash = NULL
         WHERE product_source_id = ${cand.product_source_id}`;
      result.linkedHeldRecord = true;
    } else if (src.product_id !== cand.candidate_product_id) {
      // The older master (lower id) survives: it carries the history and any catalogue link.
      const into = Math.min(src.product_id, cand.candidate_product_id);
      const from = Math.max(src.product_id, cand.candidate_product_id);
      result.merged = await mergeProducts(sql, from, into, actor, note ?? "Confirmed same product in review");
    }
  } else if (decision === "SAME_FAMILY") {
    if (src.product_id == null) throw new ReviewError("HELD_RECORD", "A held record has no product yet; confirm or reject it first.");
    await sql.begin((tx) => ensureSharedFamily(tx, src.product_id!, cand.candidate_product_id));
  }

  await sql`
    UPDATE pmd.match_candidate
       SET review_status = ${decision}, reviewed_by = ${actor.userId}, reviewed_at = now(), review_note = ${note}
     WHERE candidate_id = ${candidateId}`;
  await sql`SELECT pmd.refresh_dashboard()`;
  return result;
}
