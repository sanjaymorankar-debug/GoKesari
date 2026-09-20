/**
 * The per-record loader: NORMALISED -> MATCH -> VALIDATE -> LOAD.
 *
 * One source record is processed in one transaction (advisory-locked per brand so
 * parallel workers cannot create the same product twice). Every outcome is explicit:
 *
 *   UNCHANGED       same content as last time: only last_seen moves
 *   LINKED          matched an existing master above the auto-merge threshold
 *   CREATED         no match: a new master (queued for review if a possible duplicate exists)
 *   UPDATED         already linked; new facts were applied
 *   PENDING_REVIEW  cannot be resolved automatically (e.g. GTIN collision): held, no master touched
 *   REJECTED        unusable (e.g. no name): recorded in IMPORT_ERRORS, run continues
 *
 * Nothing is deleted and nothing is overwritten silently: a changed field writes
 * product_change_log, a disagreeing spec writes PRODUCT_ATTRIBUTE_CONFLICT, and a
 * changed price writes price_history.
 */
import { createHash } from "node:crypto";

import type { PmdConfig } from "../config";
import type { Sql, TransactionSql } from "../db";
import { matchNormalized } from "../match/engine";
import { toEan13, toUpcA } from "../normalize/identifiers";
import { normalizeText } from "../normalize/text";
import type { ReferenceIds } from "../reference-data";
import type { SourceAdapter } from "../sources/adapter";
import { UNCATEGORISED_CODE } from "../taxonomy/categories";
import type { MatchDecision } from "../match/score";
import type { NamedEntity, NormalizedProduct } from "../types";
import { applyOffer } from "./offers";
import { upsertSpecs } from "./specs";

export type RecordOutcome = "CREATED" | "LINKED" | "UPDATED" | "UNCHANGED" | "PENDING_REVIEW" | "REJECTED";

export interface RunCounters {
  recordsRead: number;
  recordsStaged: number;
  recordsUnchanged: number;
  productsCreated: number;
  productsLinked: number;
  productsUpdated: number;
  offersUpserted: number;
  priceChanges: number;
  reviewQueued: number;
  conflictsOpened: number;
  errorCount: number;
}

export const emptyCounters = (): RunCounters => ({
  recordsRead: 0, recordsStaged: 0, recordsUnchanged: 0, productsCreated: 0, productsLinked: 0, productsUpdated: 0,
  offersUpserted: 0, priceChanges: 0, reviewQueued: 0, conflictsOpened: 0, errorCount: 0,
});

export interface PendingError {
  stage: "EXTRACT" | "PARSE" | "NORMALIZE" | "MATCH" | "VALIDATE" | "LOAD";
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  sourceRecordId: string | null;
  excerpt: string | null;
}

export interface LoadContext {
  sql: Sql;
  cfg: PmdConfig;
  ref: ReferenceIds;
  adapter: SourceAdapter;
  sourceId: number;
  runId: number;
  counters: RunCounters;
  /** Masters whose status/quality must be recomputed after the batch. */
  touched: Set<number>;
  errors: PendingError[];
  brandCache: Map<string, number>;
  manufacturerCache: Map<string, number>;
  sleep?: (ms: number) => Promise<void>;
}

/* ---------------------------------------------------------------- hashing */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export function contentHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/* --------------------------------------------------------- brand / maker */

const compactOriginal = (s: string) => normalizeText(s).replace(/ /g, "");

async function resolveBrand(tx: TransactionSql, ctx: LoadContext, e: NamedEntity | null): Promise<number | null> {
  if (!e) return null;
  // Cached per SPELLING: "Amul" and "AMUL India" share a brand but each spelling must still be recorded as an alias.
  const alias = compactOriginal(e.original);
  const hit = ctx.brandCache.get(alias);
  if (hit != null) return hit;

  let [row] = await tx<{ brand_id: number }[]>`SELECT brand_id FROM pmd.brand WHERE brand_key = ${e.key}`;
  if (!row) [row] = await tx<{ brand_id: number }[]>`SELECT brand_id FROM pmd.brand_alias WHERE alias_key = ${alias}`;
  if (!row) {
    [row] = await tx<{ brand_id: number }[]>`
      INSERT INTO pmd.brand (brand_name, brand_key, source_id) VALUES (${e.display}, ${e.key}, ${ctx.sourceId})
      ON CONFLICT (brand_key) DO UPDATE SET brand_key = EXCLUDED.brand_key RETURNING brand_id`;
  }
  // Keep every spelling a source used ("Samsung India") pointing at the one brand.
  await tx`
    INSERT INTO pmd.brand_alias (alias_key, brand_id, alias_original, source_id)
    VALUES (${alias}, ${row.brand_id}, ${e.original}, ${ctx.sourceId}) ON CONFLICT (alias_key) DO NOTHING`;
  ctx.brandCache.set(alias, row.brand_id);
  return row.brand_id;
}

async function resolveManufacturer(tx: TransactionSql, ctx: LoadContext, e: NamedEntity | null): Promise<number | null> {
  if (!e) return null;
  const alias = compactOriginal(e.original);
  const hit = ctx.manufacturerCache.get(alias);
  if (hit != null) return hit;

  let [row] = await tx<{ manufacturer_id: number }[]>`SELECT manufacturer_id FROM pmd.manufacturer WHERE manufacturer_key = ${e.key}`;
  if (!row) [row] = await tx<{ manufacturer_id: number }[]>`SELECT manufacturer_id FROM pmd.manufacturer_alias WHERE alias_key = ${alias}`;
  if (!row) {
    [row] = await tx<{ manufacturer_id: number }[]>`
      INSERT INTO pmd.manufacturer (manufacturer_name, manufacturer_key, source_id) VALUES (${e.display}, ${e.key}, ${ctx.sourceId})
      ON CONFLICT (manufacturer_key) DO UPDATE SET manufacturer_key = EXCLUDED.manufacturer_key RETURNING manufacturer_id`;
  }
  await tx`
    INSERT INTO pmd.manufacturer_alias (alias_key, manufacturer_id, alias_original, source_id)
    VALUES (${alias}, ${row.manufacturer_id}, ${e.original}, ${ctx.sourceId}) ON CONFLICT (alias_key) DO NOTHING`;
  ctx.manufacturerCache.set(alias, row.manufacturer_id);
  return row.manufacturer_id;
}

/* ------------------------------------------------------------ small pieces */

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

interface ChangeEntry {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

async function logChanges(tx: TransactionSql, ctx: LoadContext, productId: number, entity: string, changes: ChangeEntry[]): Promise<void> {
  for (const c of changes) {
    await tx`
      INSERT INTO pmd.product_change_log (product_id, entity, field_name, old_value, new_value, source_id, run_id, changed_by)
      VALUES (${productId}, ${entity}, ${c.field}, ${tx.json((c.oldValue ?? null) as never)}, ${tx.json((c.newValue ?? null) as never)},
              ${ctx.sourceId}, ${ctx.runId}, 'pipeline')`;
  }
}

async function upsertIdentifiers(tx: TransactionSql, ctx: LoadContext, productId: number, n: NormalizedProduct, brandId: number | null): Promise<void> {
  type Ident = { type: string; value: string; original: string; format?: string; primary?: boolean; check?: boolean; scope?: number | null };
  const list: Ident[] = [];

  if (n.gtin) {
    if (n.gtin.usableForMatching) {
      list.push({ type: "GTIN", value: n.gtin.gtin14, original: n.gtin.original, format: n.gtin.format, primary: true, check: true });
    } else if (!n.gtin.checkDigitValid) {
      list.push({ type: "SOURCE_CODE", value: n.gtin.original.replace(/[\s-]/g, ""), original: n.gtin.original, format: n.gtin.format, check: false });
    } else {
      list.push({ type: "INTERNAL_BARCODE", value: n.gtin.gtin14, original: n.gtin.original, format: n.gtin.format, check: true });
    }
  }
  if (n.isbn13) list.push({ type: "ISBN", value: n.isbn13, original: n.isbn13, format: "ISBN-13", check: true });
  if (n.mpn) list.push({ type: "MPN", value: n.mpn.key, original: n.mpn.original, scope: brandId });
  if (n.model) list.push({ type: "MODEL", value: n.model.key, original: n.model.original, scope: brandId });
  if (n.sku) list.push({ type: "SKU", value: n.sku.toUpperCase(), original: n.sku, scope: brandId });
  if (n.productCode) list.push({ type: "PRODUCT_CODE", value: n.productCode.toUpperCase(), original: n.productCode, scope: brandId });

  for (const i of list) {
    await tx`
      INSERT INTO pmd.product_identifier (product_id, id_type, id_value, id_value_original, id_format, scope_brand_id, is_primary, check_digit_valid, source_id)
      VALUES (${productId}, ${i.type}, ${i.value}, ${i.original}, ${i.format ?? null}, ${i.scope ?? null}, ${i.primary ?? false}, ${i.check ?? null}, ${ctx.sourceId})
      ON CONFLICT DO NOTHING`;
    if (i.type === "GTIN" || i.type === "ISBN") {
      // GTIN / ISBN identify exactly one product. If another master owns it, that is a collision, not a merge.
      const [owner] = await tx<{ product_id: number }[]>`SELECT product_id FROM pmd.product_identifier WHERE id_type = ${i.type} AND id_value = ${i.value}`;
      if (owner && owner.product_id !== productId) {
        throw Object.assign(new Error(`${i.type} ${i.value} already belongs to product ${owner.product_id}`), { code: "IDENTIFIER_COLLISION" });
      }
    }
  }
}

async function upsertImages(tx: TransactionSql, ctx: LoadContext, productId: number, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.product_image WHERE product_id = ${productId}`;
  let rank = n;
  for (const url of urls) {
    if (rank >= 6) break;
    const [r] = await tx<{ image_id: number }[]>`
      INSERT INTO pmd.product_image (product_id, rank, image_url, image_source, source_id, license_note)
      VALUES (${productId}, ${rank}, ${url}, ${ctx.adapter.definition.key}, ${ctx.sourceId}, ${ctx.adapter.imageLicenseNote ?? null})
      ON CONFLICT (product_id, image_url) DO NOTHING RETURNING image_id`;
    if (r) rank++;
  }
}

async function ensureFamily(tx: TransactionSql, productId: number, brandId: number | null, n: NormalizedProduct, categoryId: number | null): Promise<void> {
  // A family is "same brand, identical core name": pack sizes and variants of one line.
  if (brandId == null) return;
  const sibs = await tx<{ product_id: number; product_family_id: number | null }[]>`
    SELECT product_id, product_family_id FROM pmd.product_master
    WHERE brand_id = ${brandId} AND normalized_name = ${n.coreName} AND record_status = 'ACTIVE' AND product_id <> ${productId} LIMIT 50`;
  if (sibs.length === 0) return;
  let familyId = sibs.find((s) => s.product_family_id != null)?.product_family_id ?? null;
  if (familyId == null) {
    const familyName = n.coreName ? titleCase(n.coreName) : (n.brand?.display ?? "Family");
    const [f] = await tx<{ family_id: number }[]>`
      INSERT INTO pmd.product_family (brand_id, family_key, family_name, category_id)
      VALUES (${brandId}, ${n.coreName}, ${familyName}, ${categoryId})
      ON CONFLICT (COALESCE(brand_id, 0), family_key) DO UPDATE SET family_name = pmd.product_family.family_name
      RETURNING family_id`;
    familyId = f.family_id;
  }
  const members = [...sibs.map((s) => s.product_id), productId];
  await tx`UPDATE pmd.product_master SET product_family_id = ${familyId}
           WHERE product_id = ANY(${members}::bigint[]) AND product_family_id IS NULL`;
}

async function recordCandidates(
  tx: TransactionSql,
  ctx: LoadContext,
  productSourceId: number,
  decision: MatchDecision,
  linkedTo: number | null,
): Promise<number> {
  let queued = 0;
  if (linkedTo != null && decision.best) {
    const b = decision.best.result;
    await tx`
      INSERT INTO pmd.match_candidate (product_source_id, candidate_product_id, match_score, match_status, relation, reasons, hard_conflicts, review_status, created_run_id)
      VALUES (${productSourceId}, ${linkedTo}, ${b.score}, ${b.status}, ${b.relation},
              ${tx.json({ rule: b.rule, components: b.components, notes: b.notes } as never)}, ${b.hardConflicts}, 'AUTO_LINKED', ${ctx.runId})
      ON CONFLICT (product_source_id, candidate_product_id) DO UPDATE SET match_score = EXCLUDED.match_score, match_status = EXCLUDED.match_status,
        reasons = EXCLUDED.reasons WHERE pmd.match_candidate.review_status IN ('PENDING','AUTO_LINKED')`;
  }
  for (const c of decision.queue) {
    if (c.productId === linkedTo) continue;
    const r = c.result;
    const [row] = await tx<{ candidate_id: number }[]>`
      INSERT INTO pmd.match_candidate (product_source_id, candidate_product_id, match_score, match_status, relation, reasons, hard_conflicts, review_status, created_run_id)
      VALUES (${productSourceId}, ${c.productId}, ${r.score}, ${r.status}, ${r.relation},
              ${tx.json({ rule: r.rule, components: r.components, notes: r.notes } as never)}, ${r.hardConflicts}, 'PENDING', ${ctx.runId})
      ON CONFLICT (product_source_id, candidate_product_id) DO UPDATE SET match_score = EXCLUDED.match_score, match_status = EXCLUDED.match_status,
        reasons = EXCLUDED.reasons, hard_conflicts = EXCLUDED.hard_conflicts WHERE pmd.match_candidate.review_status = 'PENDING'
      RETURNING candidate_id`;
    if (row) queued++;
  }
  return queued;
}

/* ------------------------------------------------------------- master ops */

interface MasterFull {
  product_id: number;
  brand_id: number | null;
  manufacturer_id: number | null;
  category_id: number | null;
  product_name: string;
  normalized_name: string;
  search_text: string;
  short_description: string | null;
  long_description: string | null;
  variant_name: string | null;
  sku: string | null;
  mpn: string | null;
  model_number: string | null;
  product_code: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  isbn: string | null;
  net_quantity_value: number | null;
  net_quantity_unit: string | null;
  pack_size: string | null;
  pack_count: number | null;
  unit_count: number | null;
  field_sources: Record<string, number>;
  version: number;
  match_confidence: number | null;
  [column: string]: unknown;
}

function packColumns(n: NormalizedProduct) {
  const q = n.quantity;
  return {
    net_quantity_value: q?.unitValue ?? null,
    net_quantity_unit: q?.unit ?? null,
    pack_size: q?.label ?? null,
    pack_count: q ? q.multiplier : null,
    unit_count: q?.unit === "pcs" ? q.total : null,
  };
}

async function createMaster(
  tx: TransactionSql,
  ctx: LoadContext,
  n: NormalizedProduct,
  ids: { brandId: number | null; manufacturerId: number | null; categoryId: number | null },
  matchConfidence: number,
): Promise<number> {
  const g = n.gtin?.usableForMatching ? n.gtin.gtin14 : null;
  const fieldSources: Record<string, number> = { product_name: ctx.sourceId };
  if (ids.categoryId != null) fieldSources.category_id = ctx.sourceId;
  if (n.description) fieldSources.long_description = ctx.sourceId;
  if (n.shortDescription) fieldSources.short_description = ctx.sourceId;

  const row = {
    brand_id: ids.brandId,
    manufacturer_id: ids.manufacturerId,
    category_id: ids.categoryId,
    gtin: g,
    ean: g ? toEan13(g) : null,
    upc: g ? toUpcA(g) : null,
    isbn: n.isbn13,
    sku: n.sku,
    mpn: n.mpn?.original ?? null,
    model_number: n.model?.original ?? null,
    product_code: n.productCode,
    product_name: n.name,
    normalized_name: n.coreName,
    search_text: n.searchText,
    short_description: n.shortDescription,
    long_description: n.description,
    variant_name: n.variant,
    key_features: tx.json([]),
    search_keywords: n.keywords,
    net_weight_g: n.netWeightG,
    gross_weight_g: n.grossWeightG,
    length_mm: nn(n.dimensionsMm?.length),
    width_mm: nn(n.dimensionsMm?.width),
    height_mm: nn(n.dimensionsMm?.height),
    volume_ml: n.volumeMl,
    ...packColumns(n),
    material: n.material,
    color: n.color?.display ?? null,
    size: n.size?.display ?? null,
    shape: n.shape,
    gst_rate_bp: n.gstRateBp,
    hsn_code: n.hsnCode,
    cess_bp: n.cessBp,
    match_confidence: matchConfidence,
    created_run_id: ctx.runId,
    field_sources: tx.json(fieldSources),
  };
  const [m] = await tx<{ product_id: number }[]>`INSERT INTO pmd.product_master ${tx(row as never, ...(Object.keys(row) as never[]))} RETURNING product_id`;
  await logChanges(tx, ctx, m.product_id, "product_master", [{ field: "created", oldValue: null, newValue: { name: n.name, brand: n.brand?.display ?? null } }]);
  return m.product_id;
}

/** Survivorship for a linked master: fill blanks, replace only when this source outranks the current one. */
async function updateMaster(
  tx: TransactionSql,
  ctx: LoadContext,
  productId: number,
  n: NormalizedProduct,
  ids: { brandId: number | null; manufacturerId: number | null; categoryId: number | null },
  linkScore: number | null,
  specPatch: Record<string, string | number | null>,
): Promise<boolean> {
  const [m] = await tx<MasterFull[]>`SELECT * FROM pmd.product_master WHERE product_id = ${productId} FOR UPDATE`;
  const myPrecedence = ctx.ref.sourceMeta.get(ctx.sourceId)?.specPrecedence ?? 50;
  const fs: Record<string, number> = { ...(m.field_sources ?? {}) };
  const patch: Record<string, unknown> = {};
  const changes: ChangeEntry[] = [];

  const set = (field: string, next: unknown, prev: unknown, provenance = true) => {
    patch[field] = next;
    changes.push({ field, oldValue: prev, newValue: next });
    if (provenance) fs[field] = ctx.sourceId;
  };
  /** Fill if blank; replace only if this source outranks the one that supplied the current value. */
  const survive = (field: string, next: unknown, prev: unknown) => {
    if (next == null || next === "") return;
    if (prev == null || prev === "") return set(field, next, prev);
    if (next === prev) return;
    const curSource = fs[field];
    const curPrecedence = curSource != null ? (ctx.ref.sourceMeta.get(curSource)?.specPrecedence ?? 100) : 100;
    if (myPrecedence < curPrecedence) set(field, next, prev);
  };
  const fill = (field: string, next: unknown, prev: unknown) => {
    if (next != null && next !== "" && (prev == null || prev === "")) set(field, next, prev, false);
  };

  survive("product_name", n.name || null, m.product_name);
  if (patch.product_name) {
    patch.normalized_name = n.coreName;
    patch.search_text = n.searchText;
  }
  survive("short_description", n.shortDescription, m.short_description);
  survive("long_description", n.description, m.long_description);
  if (ids.categoryId != null) survive("category_id", ids.categoryId, m.category_id);
  fill("brand_id", ids.brandId, m.brand_id);
  fill("manufacturer_id", ids.manufacturerId, m.manufacturer_id);
  fill("variant_name", n.variant, m.variant_name);
  fill("sku", n.sku, m.sku);
  fill("mpn", n.mpn?.original, m.mpn);
  fill("model_number", n.model?.original, m.model_number);
  fill("product_code", n.productCode, m.product_code);
  fill("isbn", n.isbn13, m.isbn);
  if (n.gtin?.usableForMatching && m.gtin == null) {
    fill("gtin", n.gtin.gtin14, m.gtin);
    fill("ean", toEan13(n.gtin.gtin14), m.ean);
    fill("upc", toUpcA(n.gtin.gtin14), m.upc);
  }
  const pack = packColumns(n);
  for (const [k, v] of Object.entries(pack)) fill(k, v, m[k]);

  // Winning spec values (colour, GST, weights...) project onto their columns when they changed.
  for (const [col, value] of Object.entries(specPatch)) {
    const same = typeof value === "number" ? Number(m[col]) === value : m[col] === value;
    if (!same && !(col in patch)) set(col, value, m[col], false);
  }

  if (linkScore != null && (m.match_confidence == null || linkScore < m.match_confidence)) patch.match_confidence = linkScore;

  const businessChange = changes.length > 0;
  const toWrite: Record<string, unknown> = {
    ...patch,
    ...(businessChange ? { field_sources: tx.json(fs), version: m.version + 1, updated_at: new Date() } : {}),
    last_seen_at: new Date(),
  };
  await tx`UPDATE pmd.product_master SET ${tx(toWrite as never, ...(Object.keys(toWrite) as never[]))} WHERE product_id = ${productId}`;
  if (businessChange) await logChanges(tx, ctx, productId, "product_master", changes);
  return businessChange;
}

/* --------------------------------------------------------- source record */

interface SourceRowArgs {
  productId: number | null;
  n: NormalizedProduct;
  raw: { sourceProductId: string; url?: string };
  staged: { name?: string | null; brand?: string | null; rating?: number | null; reviewCount?: number | null; availability?: string | null; sourceConfidence?: number | null };
  rawId: number | null;
  hash: string;
  match: { status: string; score: number | null; rule: string | null; resolution: string };
}

async function upsertSourceRow(tx: TransactionSql, ctx: LoadContext, a: SourceRowArgs): Promise<number> {
  const { n, staged } = a;
  const reliability = ctx.ref.sourceMeta.get(ctx.sourceId)?.reliability ?? 50;
  const snapshot = {
    brandKey: n.brand?.key ?? null,
    coreName: n.coreName,
    gtin14: n.gtin?.usableForMatching ? n.gtin.gtin14 : null,
    pack: n.quantity?.label ?? null,
    categoryCode: n.categoryCode,
    issues: n.issues.filter((i) => i.severity !== "INFO").map((i) => i.code),
  };
  const [row] = await tx<{ product_source_id: number }[]>`
    INSERT INTO pmd.product_source
      (product_id, source_id, source_product_id, source_url, source_category, source_product_name, source_brand,
       source_mrp_minor, source_price_minor, source_currency, source_rating, source_review_count, source_availability,
       first_seen_date, last_seen_date, data_collection_date, data_collection_method, data_confidence,
       match_status, match_score, match_rule, resolution, content_hash, normalized, raw_id, last_run_id)
    VALUES (${a.productId}, ${ctx.sourceId}, ${a.raw.sourceProductId}, ${n.sourceUrl ?? a.raw.url ?? null},
            ${n.categoryRaw.join(" | ").slice(0, 1000) || null}, ${staged.name ?? null}, ${staged.brand ?? null},
            ${n.offer?.mrpMinor ?? null}, ${n.offer?.priceMinor ?? null}, ${n.offer?.currency ?? null},
            ${staged.rating ?? null}, ${staged.reviewCount ?? null}, ${staged.availability ?? n.offer?.stockStatus ?? null},
            current_date, current_date, current_date, ${ctx.adapter.collectionMethod}, ${staged.sourceConfidence ?? reliability},
            ${a.match.status}, ${a.match.score}, ${a.match.rule}, ${a.match.resolution}, ${a.hash}, ${tx.json(snapshot as never)}, ${a.rawId}, ${ctx.runId})
    ON CONFLICT (source_id, source_product_id) DO UPDATE SET
      product_id = COALESCE(EXCLUDED.product_id, pmd.product_source.product_id),
      source_url = EXCLUDED.source_url, source_category = EXCLUDED.source_category,
      source_product_name = EXCLUDED.source_product_name, source_brand = EXCLUDED.source_brand,
      source_mrp_minor = EXCLUDED.source_mrp_minor, source_price_minor = EXCLUDED.source_price_minor,
      source_currency = EXCLUDED.source_currency, source_rating = EXCLUDED.source_rating,
      source_review_count = EXCLUDED.source_review_count, source_availability = EXCLUDED.source_availability,
      last_seen_date = current_date, data_collection_date = current_date, data_collection_method = EXCLUDED.data_collection_method,
      data_confidence = EXCLUDED.data_confidence, match_status = EXCLUDED.match_status, match_score = EXCLUDED.match_score,
      match_rule = EXCLUDED.match_rule, resolution = EXCLUDED.resolution, content_hash = EXCLUDED.content_hash,
      normalized = EXCLUDED.normalized, raw_id = EXCLUDED.raw_id, last_run_id = EXCLUDED.last_run_id
    RETURNING product_source_id`;
  return row.product_source_id;
}

/* ----------------------------------------------------------------- main */

export interface LoadInput {
  raw: { sourceProductId: string; url?: string; payload: Record<string, unknown> };
  staged: SourceRowArgs["staged"] & { name?: string | null };
  normalized: NormalizedProduct;
}

function isTransient(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return ["40001", "40P01", "55P03", "57P01", "08006", "08003", "08000", "CONNECTION_CLOSED", "CONNECTION_ENDED", "ECONNRESET"].includes(String(code));
}

function isGtinRace(e: unknown): boolean {
  const err = e as { code?: string; constraint_name?: string };
  return err?.code === "23505" && /gtin_uq|identifier_global_uq/.test(err.constraint_name ?? "");
}

export async function loadRecord(ctx: LoadContext, input: LoadInput): Promise<RecordOutcome> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = 3;
  let raceRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.sql.begin((tx) => loadInTransaction(tx, ctx, input));
    } catch (e) {
      if (isTransient(e) && attempt < maxRetries) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      // Two workers created the same GTIN at once: retry, which now finds the winner and links to it.
      if (isGtinRace(e) && raceRetries++ < 2) continue;
      throw e;
    }
  }
}

async function loadInTransaction(tx: TransactionSql, ctx: LoadContext, input: LoadInput): Promise<RecordOutcome> {
  const { raw, staged, normalized: n } = input;
  const cfg = ctx.cfg;
  const hash = contentHash(raw.payload);
  const sourceId = ctx.sourceId;
  const today = new Date();

  // Serialise per brand so two workers cannot both decide "no such product" for the same brand.
  const lockKey = n.brand?.key ? `b:${n.brand.key}` : n.gtin?.usableForMatching ? `g:${n.gtin.gtin14}` : `n:${n.coreName.slice(0, 40)}`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"pmd:" + lockKey}, 0))`;

  const [existing] = await tx<{ product_source_id: number; product_id: number | null; content_hash: string | null }[]>`
    SELECT product_source_id, product_id, content_hash FROM pmd.product_source
    WHERE source_id = ${sourceId} AND source_product_id = ${raw.sourceProductId}`;

  // Same content as last time and already resolved: nothing to do but note we still see it.
  if (existing && existing.product_id != null && existing.content_hash === hash) {
    await tx`UPDATE pmd.product_source SET last_seen_date = current_date, last_run_id = ${ctx.runId} WHERE product_source_id = ${existing.product_source_id}`;
    await tx`UPDATE pmd.product_offer SET last_seen_at = now(), is_current = true WHERE product_source_id = ${existing.product_source_id}`;
    ctx.counters.recordsUnchanged++;
    return "UNCHANGED";
  }

  // Keep the raw payload (changed content only) for traceability and replay.
  let [rawRow] = await tx<{ raw_id: number }[]>`
    INSERT INTO pmd.raw_record (run_id, source_id, source_product_id, content_hash, payload)
    VALUES (${ctx.runId}, ${sourceId}, ${raw.sourceProductId}, ${hash}, ${tx.json(raw.payload as never)})
    ON CONFLICT (source_id, source_product_id, content_hash) DO NOTHING RETURNING raw_id`;
  if (!rawRow) {
    [rawRow] = await tx<{ raw_id: number }[]>`
      SELECT raw_id FROM pmd.raw_record WHERE source_id = ${sourceId} AND source_product_id = ${raw.sourceProductId} AND content_hash = ${hash}`;
  }
  ctx.counters.recordsStaged++;

  /* ----- resolve brand / manufacturer / category -------------------------- */
  const brandId = await resolveBrand(tx, ctx, n.brand);
  const manufacturerId = await resolveManufacturer(tx, ctx, n.manufacturer);
  const categoryId = n.categoryCode && n.categoryCode !== UNCATEGORISED_CODE ? (ctx.ref.categoryIdByCode.get(n.categoryCode) ?? null) : null;
  const ids = { brandId, manufacturerId, categoryId };

  /* ----- a record with no name may still enrich a product we already know -- */
  let enrichTarget: number | null = null;
  if (!n.name) {
    if (n.gtin?.usableForMatching) {
      const [hit] = await tx<{ product_id: number }[]>`
        SELECT i.product_id FROM pmd.product_identifier i JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
        WHERE i.id_type = 'GTIN' AND i.id_value = ${n.gtin.gtin14}`;
      enrichTarget = hit?.product_id ?? null;
    }
    if (enrichTarget == null) {
      ctx.errors.push({ stage: "VALIDATE", severity: "ERROR", code: "NAME_MISSING", message: "Product has no name and no known product to attach to; not loaded.", sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(raw.payload).slice(0, 400) });
      ctx.counters.errorCount++;
      return "REJECTED";
    }
  }

  /* ----- decide: link, create, or hold ----------------------------------- */
  let productId: number | null = existing?.product_id ?? enrichTarget;
  let outcome: RecordOutcome;
  let match: SourceRowArgs["match"];
  let decision: MatchDecision | null = null;
  let specPatch: Record<string, string | number | null> = {};

  if (productId != null) {
    // Already linked (or enrichment by GTIN): no re-match.
    match = { status: "EXACT_MATCH", score: 100, rule: enrichTarget != null ? "ENRICH_BY_GTIN" : "PREVIOUSLY_LINKED", resolution: "LINKED_EXISTING" };
    outcome = "UPDATED";
  } else {
    const result = await matchNormalized(tx, n, brandId, cfg);
    decision = result.decision;
    const best = decision.best?.result ?? null;
    const status = best?.status ?? "NO_CANDIDATE";
    const base = { status, score: best?.score ?? null, rule: best?.rule ?? null };

    if (decision.action === "LINK" && decision.best) {
      productId = decision.best.productId;
      match = { ...base, resolution: "LINKED_EXISTING" };
      outcome = "LINKED";
    } else if (decision.action === "HOLD") {
      match = { ...base, resolution: "PENDING_REVIEW" };
      outcome = "PENDING_REVIEW";
    } else if (!ctx.adapter.createsProducts) {
      // A price-only / enrichment source never mints a master: with nothing to attach to, say so and stop.
      ctx.errors.push({ stage: "MATCH", severity: "ERROR", code: "NO_MASTER_TO_ATTACH", message: "This source may only price or enrich products that already exist, and none matches; not loaded.", sourceRecordId: raw.sourceProductId, excerpt: JSON.stringify(raw.payload).slice(0, 400) });
      ctx.counters.errorCount++;
      return "REJECTED";
    } else {
      const confidence = decision.action === "CREATE_AND_QUEUE" ? 70 : 100;
      productId = await createMaster(tx, ctx, n, ids, confidence);
      match = { ...base, resolution: "CREATED_NEW" };
      outcome = "CREATED";
    }
  }

  const productSourceId = await upsertSourceRow(tx, ctx, {
    productId,
    n,
    raw,
    staged,
    rawId: rawRow?.raw_id ?? null,
    hash,
    match,
  });

  if (decision) {
    const queued = await recordCandidates(tx, ctx, productSourceId, decision, outcome === "LINKED" ? productId : null);
    ctx.counters.reviewQueued += queued;
  }

  if (productId == null) return outcome; // held for review: no master exists to enrich

  /* ----- enrich the master -------------------------------------------------- */
  await upsertIdentifiers(tx, ctx, productId, n, brandId);
  const spec = await upsertSpecs(
    tx,
    { ref: ctx.ref, sourceId, runId: ctx.runId, sourceUrl: n.sourceUrl, confidence: staged.sourceConfidence ?? null },
    productId,
    n.attributes,
  );
  ctx.counters.conflictsOpened += spec.conflictsOpened;
  specPatch = spec.masterPatch;

  let changed = false;
  if (outcome !== "CREATED") {
    changed = await updateMaster(tx, ctx, productId, n, ids, match.score, specPatch);
  } else {
    await tx`UPDATE pmd.product_master SET last_seen_at = ${today} WHERE product_id = ${productId}`;
    await ensureFamily(tx, productId, brandId, n, categoryId);
  }
  await upsertImages(tx, ctx, productId, n.images);

  /* ----- offer and price history -------------------------------------------- */
  if (n.offer) {
    const res = await applyOffer(tx, {
      productSourceId,
      productId,
      sourceId,
      sourceProductId: raw.sourceProductId,
      sourceUrl: n.sourceUrl,
      runId: ctx.runId,
      offer: n.offer,
    });
    if (res.kind !== "STALE_IGNORED") ctx.counters.offersUpserted++;
    if (res.kind === "PRICE_CHANGED") ctx.counters.priceChanges++;
    if (res.outlier) {
      ctx.errors.push({
        stage: "VALIDATE", severity: "WARNING", code: "PRICE_OUTLIER",
        message: `Price moved from ${res.outlier.previousMinor / 100} to ${res.outlier.nextMinor / 100} (5x or more); recorded, please verify.`,
        sourceRecordId: raw.sourceProductId, excerpt: null,
      });
    }
  }

  ctx.touched.add(productId);
  if (outcome === "CREATED") ctx.counters.productsCreated++;
  else if (outcome === "LINKED") ctx.counters.productsLinked++;
  else if (changed || spec.changedKeys.length > 0) ctx.counters.productsUpdated++;
  else if (outcome === "UPDATED" && !changed) ctx.counters.recordsUnchanged++;
  return outcome;
}
