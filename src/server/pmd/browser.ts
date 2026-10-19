/**
 * Product browser for staff (batch-2026-10 WS-D, F9.1.4, PMD-006 / PMD-007).
 *
 *   STAGING  pmd.product_master records not yet in the marketplace catalogue (every import
 *            lands here first, de-duplicated by GTIN-14)
 *   MASTER   records promoted into the catalogue (pmd.catalogue_link → public.products),
 *            which every shop can pick
 *
 * search        filter / sort / page across both, with source, licence attribution and stored images
 * duplicates    the match engine's open "possible duplicate" pairs, side by side
 * merge         the existing review merge (pipeline/review.ts mergeProducts: by pointer, merge log)
 * bulkEdit      category, HSN, GST rate, brand on staging; HSN / GST / MRP on the linked catalogue row
 *               (MRP through mrp-governance.changeMasterMrp — the master MRP; a shop's own price edits
 *               stay that shop's, unchanged). Every change is audited and in the change log.
 * promote       single or bulk, through the audited catalogue bridge (the logic scripts/pmd/promote.ts uses)
 */
import { conflict, notFound, validationFailed } from "@/lib/errors";
import type { UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { changeMasterMrp } from "@/server/services/mrp-governance";

import { appSql, type Sql } from "./db";
import { entityKey } from "./normalize/brand";
import { analyzeGtin } from "./normalize/identifiers";
import { mergeProducts, ReviewError } from "./pipeline/review";
import { getCategoryByCode } from "./taxonomy/categories";
import { promoteToCatalogue, PromotionError, type PromotionResult } from "./services/catalogue-bridge";

export interface BrowserActor {
  id: string;
  role: UserRole;
  email?: string | null;
}

export type BrowserScope = "staging" | "master" | "all";
export type BrowserSort = "name" | "quality" | "updated" | "gtin";

export interface BrowserQuery {
  scope?: BrowserScope;
  q?: string;
  brand?: string;
  category?: string;
  source?: string;
  missingHsn?: boolean;
  minQuality?: number;
  sort?: BrowserSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface BrowserRow {
  masterProductId: string;
  productName: string;
  brand: string | null;
  gtin: string | null;
  packSize: string | null;
  categoryCode: string | null;
  categoryPath: string[] | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  quality: number | null;
  scope: "STAGING" | "MASTER";
  catalogueProductId: string | null;
  mrpPaise: number | null;
  sources: string[];
  attributions: string[];
  storedImages: number;
  updatedAt: Date;
}

const SORTS: Record<BrowserSort, string> = {
  name: "m.product_name",
  quality: "m.data_quality_score",
  updated: "m.updated_at",
  gtin: "m.gtin",
};

export async function searchBrowser(query: BrowserQuery, client?: Sql): Promise<{ rows: BrowserRow[]; total: number; page: number; pageSize: number }> {
  const sql = client ?? (await appSql());
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const scope = query.scope ?? "all";
  const q = query.q?.trim() ?? "";
  const gtin = q ? analyzeGtin(q.replace(/\s/g, ""))?.gtin14 ?? null : null;
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const order = `${SORTS[query.sort ?? "updated"]} ${query.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, m.product_id`;

  const where = sql`
    m.record_status = 'ACTIVE'
    AND (${scope} = 'all' OR (${scope} = 'staging' AND l.product_id IS NULL) OR (${scope} = 'master' AND l.product_id IS NOT NULL))
    AND (${q} = '' OR m.gtin = ${gtin} OR m.product_name ILIKE ${like} OR m.search_text ILIKE ${like} OR b.brand_name ILIKE ${like})
    AND (${query.brand ?? ""} = '' OR b.brand_name ILIKE ${query.brand ?? ""})
    AND (${query.category ?? ""} = '' OR c.category_code = ${query.category ?? ""} OR c.category_code LIKE ${(query.category ?? "") + "/%"})
    AND (${query.source ?? ""} = '' OR EXISTS (SELECT 1 FROM pmd.product_source ps JOIN pmd.source s USING (source_id) WHERE ps.product_id = m.product_id AND s.source_key = ${query.source ?? ""}))
    AND (${query.missingHsn === true} = false OR m.hsn_code IS NULL)
    AND (${query.minQuality ?? -1} < 0 OR m.data_quality_score >= ${query.minQuality ?? 0})`;

  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM pmd.product_master m
    LEFT JOIN pmd.brand b ON b.brand_id = m.brand_id
    LEFT JOIN pmd.category c ON c.category_id = m.category_id
    LEFT JOIN pmd.catalogue_link l ON l.product_id = m.product_id
    WHERE ${where}`;

  const rows = await sql<
    {
      master_product_id: string;
      product_name: string;
      brand_name: string | null;
      gtin: string | null;
      pack_size: string | null;
      category_code: string | null;
      path_names: string[] | null;
      hsn_code: string | null;
      gst_rate_bp: number | null;
      data_quality_score: number | null;
      catalogue_product_id: string | null;
      mrp_paise: number | null;
      sources: string[] | null;
      attributions: string[] | null;
      stored_images: number;
      updated_at: Date;
    }[]
  >`
    SELECT m.master_product_id, m.product_name, b.brand_name, m.gtin, m.pack_size, c.category_code, c.path_names,
           m.hsn_code, m.gst_rate_bp, m.data_quality_score, l.catalogue_product_id, p.mrp_paise, m.updated_at,
           (SELECT array_agg(DISTINCT s.source_key) FROM pmd.product_source ps JOIN pmd.source s USING (source_id) WHERE ps.product_id = m.product_id) AS sources,
           (SELECT array_agg(DISTINCT a.attribution) FROM public.pmd_record_attributions a WHERE m.gtin IS NOT NULL AND a.gtin14 = m.gtin) AS attributions,
           (SELECT count(*)::int FROM public.pmd_image_assets i WHERE m.gtin IS NOT NULL AND i.gtin14 = m.gtin AND i.status = 'STORED') AS stored_images
    FROM pmd.product_master m
    LEFT JOIN pmd.brand b ON b.brand_id = m.brand_id
    LEFT JOIN pmd.category c ON c.category_id = m.category_id
    LEFT JOIN pmd.catalogue_link l ON l.product_id = m.product_id
    LEFT JOIN public.products p ON p.id = l.catalogue_product_id
    WHERE ${where}
    ORDER BY ${sql.unsafe(order)}
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

  return {
    total,
    page,
    pageSize,
    rows: rows.map((r) => ({
      masterProductId: r.master_product_id,
      productName: r.product_name,
      brand: r.brand_name,
      gtin: r.gtin,
      packSize: r.pack_size,
      categoryCode: r.category_code,
      categoryPath: r.path_names,
      hsnCode: r.hsn_code,
      gstRateBp: r.gst_rate_bp,
      quality: r.data_quality_score,
      scope: r.catalogue_product_id ? "MASTER" : "STAGING",
      catalogueProductId: r.catalogue_product_id,
      mrpPaise: r.mrp_paise,
      sources: r.sources ?? [],
      attributions: r.attributions ?? [],
      storedImages: r.stored_images,
      updatedAt: r.updated_at,
    })),
  };
}

/** Figures for the product-browser board. Each read is caught: a missing figure just shows no headline. */
export async function browserBoardCounts(client?: Sql): Promise<{ staging: number | null; master: number | null; duplicates: number | null; activeJobs: number | null; manufacturers: number | null }> {
  const sql = client ?? (await appSql());
  const one = async (q: Promise<{ n: number }[]>) => {
    try {
      return (await q)[0]?.n ?? 0;
    } catch {
      return null;
    }
  };
  const [staging, master, duplicates, activeJobs, manufacturers] = await Promise.all([
    one(sql`SELECT count(*)::int AS n FROM pmd.product_master m WHERE m.record_status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM pmd.catalogue_link l WHERE l.product_id = m.product_id)`),
    one(sql`SELECT count(*)::int AS n FROM pmd.catalogue_link`),
    one(sql`SELECT count(*)::int AS n FROM pmd.match_candidate WHERE review_status = 'PENDING'`),
    one(sql`SELECT count(*)::int AS n FROM public.pmd_ingest_jobs WHERE status IN ('QUEUED','RUNNING')`),
    one(sql`SELECT count(*)::int AS n FROM public.pmd_manufacturer_accounts`),
  ]);
  return { staging, master, duplicates, activeJobs, manufacturers };
}

/* -------------------------------------------------------------- duplicates */

export interface DuplicatePair {
  candidateId: number;
  score: number;
  status: string;
  relation: string;
  hardConflicts: string[];
  left: Record<string, unknown>;
  right: Record<string, unknown>;
}

const SIDE = `p.product_id, p.master_product_id, p.product_name, b.brand_name, p.gtin, p.pack_size, p.variant_name, p.hsn_code,
  p.gst_rate_bp, p.data_quality_score, c.category_code, (SELECT count(*)::int FROM pmd.product_source ps WHERE ps.product_id = p.product_id) AS sources,
  EXISTS (SELECT 1 FROM pmd.catalogue_link l WHERE l.product_id = p.product_id) AS in_catalogue`;

/** Open possible-duplicate pairs from the match engine, both records side by side. */
export async function listDuplicatePairs(limit = 50, client?: Sql): Promise<DuplicatePair[]> {
  const sql = client ?? (await appSql());
  const rows = await sql<{ candidate_id: number; match_score: number; match_status: string; relation: string; hard_conflicts: string[]; source_product: number | null; candidate_product: number }[]>`
    SELECT mc.candidate_id, mc.match_score, mc.match_status, mc.relation, mc.hard_conflicts, ps.product_id AS source_product, mc.candidate_product_id AS candidate_product
    FROM pmd.match_candidate mc JOIN pmd.product_source ps ON ps.product_source_id = mc.product_source_id
    WHERE mc.review_status = 'PENDING' AND ps.product_id IS NOT NULL AND ps.product_id <> mc.candidate_product_id
    ORDER BY mc.match_score DESC, mc.candidate_id LIMIT ${limit}`;
  const ids = [...new Set(rows.flatMap((r) => [r.source_product!, r.candidate_product]))];
  const sides = ids.length
    ? await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SIDE} FROM pmd.product_master p LEFT JOIN pmd.brand b ON b.brand_id = p.brand_id LEFT JOIN pmd.category c ON c.category_id = p.category_id WHERE p.product_id = ANY($1::bigint[]) AND p.record_status = 'ACTIVE'`,
        [ids as never],
      )
    : [];
  const byId = new Map(sides.map((s) => [Number(s.product_id), s]));
  return rows
    .filter((r) => byId.has(r.source_product!) && byId.has(r.candidate_product))
    .map((r) => ({
      candidateId: r.candidate_id,
      score: r.match_score,
      status: r.match_status,
      relation: r.relation,
      hardConflicts: r.hard_conflicts,
      left: byId.get(r.candidate_product)!,
      right: byId.get(r.source_product!)!,
    }));
}

/** Two records side by side (for a pair the operator picked themselves). */
export async function compareProducts(a: string, b: string, client?: Sql): Promise<{ left: Record<string, unknown>; right: Record<string, unknown> }> {
  const sql = client ?? (await appSql());
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SIDE} FROM pmd.product_master p LEFT JOIN pmd.brand b ON b.brand_id = p.brand_id LEFT JOIN pmd.category c ON c.category_id = p.category_id WHERE p.master_product_id = ANY($1::text[])`,
    [[a, b] as never],
  );
  const left = rows.find((r) => r.master_product_id === a);
  const right = rows.find((r) => r.master_product_id === b);
  if (!left || !right) throw notFound("Product");
  return { left, right };
}

/** Merges `from` into `survivor` (the person chose the survivor), closing any open review pair between them. */
export async function mergeDuplicate(
  input: { fromMasterId: string; intoMasterId: string; reason?: string | null },
  actor: BrowserActor,
  client?: Sql,
) {
  const sql = client ?? (await appSql());
  const ids = await sql<{ product_id: number; master_product_id: string }[]>`
    SELECT product_id, master_product_id FROM pmd.product_master WHERE master_product_id IN (${input.fromMasterId}, ${input.intoMasterId})`;
  const from = ids.find((r) => r.master_product_id === input.fromMasterId);
  const into = ids.find((r) => r.master_product_id === input.intoMasterId);
  if (!from || !into) throw notFound("Product");
  let result;
  try {
    result = await mergeProducts(sql, from.product_id, into.product_id, { userId: actor.id, label: actor.email ?? actor.id }, input.reason ?? "Merged in the product browser");
  } catch (error) {
    if (error instanceof ReviewError) throw conflict(error.message, { code: error.code });
    throw error;
  }
  await sql`
    UPDATE pmd.match_candidate mc SET review_status = 'CONFIRMED_SAME', reviewed_by = ${actor.id}, reviewed_at = now(), review_note = ${input.reason ?? "Merged in the product browser"}
     FROM pmd.product_source ps
    WHERE ps.product_source_id = mc.product_source_id AND mc.review_status = 'PENDING'
      AND ((ps.product_id = ${into.product_id} AND mc.candidate_product_id = ${into.product_id}) OR mc.candidate_product_id = ${from.product_id})`;
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_PRODUCTS_MERGED,
    entityType: "pmd_product",
    entityId: input.intoMasterId,
    previousValue: { from: input.fromMasterId },
    newValue: { into: input.intoMasterId, ...result, reason: input.reason ?? null },
  });
  return result;
}

/* --------------------------------------------------------------- bulk edit */

export interface BulkEditInput {
  masterProductIds: string[];
  set: { categoryCode?: string; hsnCode?: string | null; gstRateBp?: number | null; brandName?: string; mrpPaise?: number };
  reason?: string | null;
}

export interface BulkEditResult {
  updated: number;
  mrpUpdated: number;
  skipped: { masterProductId: string; reason: string }[];
}

export async function bulkEdit(input: BulkEditInput, actor: BrowserActor, client?: Sql): Promise<BulkEditResult> {
  const sql = client ?? (await appSql());
  const ids = [...new Set(input.masterProductIds)];
  if (ids.length === 0) throw validationFailed("Select at least one product.");
  if (ids.length > 500) throw validationFailed("Edit at most 500 products at a time.");
  const s = input.set;
  if (Object.values(s).every((v) => v === undefined)) throw validationFailed("Choose at least one field to change.");
  let categoryId: number | null | undefined;
  if (s.categoryCode !== undefined) {
    if (!getCategoryByCode(s.categoryCode)) throw validationFailed(`Unknown category ${s.categoryCode}.`);
    const [c] = await sql<{ category_id: number }[]>`SELECT category_id FROM pmd.category WHERE category_code = ${s.categoryCode}`;
    if (!c) throw validationFailed(`Unknown category ${s.categoryCode}.`);
    categoryId = c.category_id;
  }
  if (s.hsnCode != null && !/^\d{4}(\d{2}){0,2}$/.test(s.hsnCode)) throw validationFailed("HSN must be 4, 6 or 8 digits.");
  if (s.gstRateBp != null && (!Number.isInteger(s.gstRateBp) || s.gstRateBp < 0 || s.gstRateBp > 10000)) throw validationFailed("GST rate is in basis points (1800 = 18%).");
  if (s.mrpPaise !== undefined && (!Number.isInteger(s.mrpPaise) || s.mrpPaise <= 0)) throw validationFailed("MRP must be a whole number of paise above zero.");

  const out: BulkEditResult = { updated: 0, mrpUpdated: 0, skipped: [] };
  const label = actor.email ?? actor.id;

  let brandId: number | undefined;
  if (s.brandName !== undefined) {
    const name = s.brandName.trim();
    const key = entityKey(name);
    if (!key) throw validationFailed("Enter a brand name.");
    const [b] = await sql<{ brand_id: number }[]>`
      INSERT INTO pmd.brand (brand_name, brand_key) VALUES (${name}, ${key})
      ON CONFLICT (brand_key) DO UPDATE SET brand_key = EXCLUDED.brand_key RETURNING brand_id`;
    brandId = b.brand_id;
  }

  for (const masterId of ids) {
    const [row] = await sql<{ product_id: number; category_id: number | null; hsn_code: string | null; gst_rate_bp: number | null; brand_id: number | null; catalogue_product_id: string | null; record_status: string }[]>`
      SELECT m.product_id, m.category_id, m.hsn_code, m.gst_rate_bp, m.brand_id, m.record_status, l.catalogue_product_id
      FROM pmd.product_master m LEFT JOIN pmd.catalogue_link l ON l.product_id = m.product_id WHERE m.master_product_id = ${masterId}`;
    if (!row || row.record_status !== "ACTIVE") {
      out.skipped.push({ masterProductId: masterId, reason: "not found or not active" });
      continue;
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = (field: string, from: unknown, to: unknown) => {
      if (to === undefined || to === from) return;
      before[field] = from;
      after[field] = to;
    };
    change("category_id", row.category_id, categoryId);
    change("hsn_code", row.hsn_code, s.hsnCode);
    change("gst_rate_bp", row.gst_rate_bp, s.gstRateBp);
    change("brand_id", row.brand_id, brandId);

    if (Object.keys(after).length) {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE pmd.product_master SET
            category_id = ${"category_id" in after ? (after.category_id as number) : row.category_id},
            hsn_code = ${"hsn_code" in after ? (after.hsn_code as string | null) : row.hsn_code},
            gst_rate_bp = ${"gst_rate_bp" in after ? (after.gst_rate_bp as number | null) : row.gst_rate_bp},
            brand_id = ${"brand_id" in after ? (after.brand_id as number) : row.brand_id},
            field_sources = field_sources || ${tx.json(Object.fromEntries(Object.keys(after).map((k) => [k, "MANUAL"])) as never)},
            version = version + 1, updated_at = now()
          WHERE product_id = ${row.product_id}`;
        for (const field of Object.keys(after)) {
          await tx`
            INSERT INTO pmd.product_change_log (product_id, entity, field_name, old_value, new_value, changed_by)
            VALUES (${row.product_id}, 'product_master', ${field}, ${tx.json((before[field] ?? null) as never)}, ${tx.json((after[field] ?? null) as never)}, ${`bulk-edit:${label}`})`;
        }
        // Tax identity on the catalogue row follows the master (HSN / GST rate).
        if (row.catalogue_product_id && ("hsn_code" in after || "gst_rate_bp" in after)) {
          await tx`
            UPDATE public.products SET
              hsn_code = ${"hsn_code" in after ? (after.hsn_code as string | null) : tx`hsn_code`},
              gst_rate_bp = ${"gst_rate_bp" in after ? (after.gst_rate_bp as number | null) : tx`gst_rate_bp`}
            WHERE id = ${row.catalogue_product_id}`;
        }
      });
      out.updated += 1;
    }

    if (s.mrpPaise !== undefined) {
      if (!row.catalogue_product_id) {
        out.skipped.push({ masterProductId: masterId, reason: "MRP is kept on catalogue products — promote it first" });
      } else {
        await changeMasterMrp({ productId: row.catalogue_product_id, mrpPaise: s.mrpPaise, source: "ADMIN", reason: input.reason ?? "Product browser bulk edit" }, actor);
        out.mrpUpdated += 1;
        before.mrp = "catalogue";
        after.mrpPaise = s.mrpPaise;
      }
    }

    if (Object.keys(after).length) {
      await recordAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PMD_BULK_EDITED,
        entityType: "pmd_product",
        entityId: masterId,
        previousValue: before,
        newValue: { ...after, reason: input.reason ?? null, batchSize: ids.length },
      });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- promote */

export interface PromoteOutcome {
  masterProductId: string;
  ok: boolean;
  result?: PromotionResult;
  code?: string;
  message?: string;
}

/** Promotes each record (its own transaction each, via the catalogue bridge); one summary audit row. */
export async function promoteMany(
  masterProductIds: string[],
  actor: BrowserActor,
  opts: { minQuality?: number; note?: string | null; images?: boolean } = {},
  client?: Sql,
): Promise<{ promoted: number; adopted: number; refused: number; outcomes: PromoteOutcome[] }> {
  const sql = client ?? (await appSql());
  const ids = [...new Set(masterProductIds)];
  if (ids.length === 0) throw validationFailed("Select at least one product.");
  if (ids.length > 500) throw validationFailed("Promote at most 500 products at a time.");
  const outcomes: PromoteOutcome[] = [];
  for (const id of ids) {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await promoteToCatalogue(sql, id, { userId: actor.id, role: actor.role }, { minQuality: opts.minQuality ?? 0, note: opts.note ?? "Promoted in the product browser", images: opts.images });
        outcomes.push({ masterProductId: id, ok: true, result });
        break;
      } catch (error) {
        if ((error as { code?: string }).code === "23505" && attempt < 3) continue;
        outcomes.push({
          masterProductId: id,
          ok: false,
          code: error instanceof PromotionError ? error.code : "ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }
  const summary = {
    promoted: outcomes.filter((o) => o.ok && !o.result?.adopted).length,
    adopted: outcomes.filter((o) => o.ok && o.result?.adopted).length,
    refused: outcomes.filter((o) => !o.ok).length,
  };
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_PRODUCTS_PROMOTED,
    entityType: "pmd_product",
    entityId: ids.length === 1 ? ids[0] : null,
    newValue: { ...summary, ids: ids.slice(0, 100), refusedCodes: outcomes.filter((o) => !o.ok).map((o) => o.code) },
  });
  return { ...summary, outcomes };
}
