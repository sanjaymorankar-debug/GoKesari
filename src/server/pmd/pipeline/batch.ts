/**
 * The set-based loader: a whole batch of source records in a handful of statements.
 *
 * The per-record loader (load.ts) is the reference for correctness: one transaction per record, every rule
 * explicit. It is also chatty - dozens of SQL round trips per record - and round trips are what a hosted database
 * charges for. This module handles, in bulk, exactly the two outcomes that dominate a real load and involve no
 * judgement, and hands everything else back to the reference loader, in stream order:
 *
 *   UNCHANGED   same content as last time            -> two UPDATEs for the whole batch
 *   NEW         no candidate master anywhere         -> multi-row INSERTs for the whole batch
 *
 * Everything else - a link to an existing master, a possible duplicate, a held record, a changed record, a record
 * with no brand or no name, a repeated source id, a record related to an earlier one in the same batch - runs
 * through loadRecord() afterwards, so every rule that needs a decision is still made by the one implementation.
 *
 * Safety net: if the bulk transaction fails for ANY reason (a concurrent worker took a GTIN, a bad value...) it
 * rolls back and its records are re-run one by one, so a bad record is isolated exactly as before.
 *
 * "Related to an earlier record" is decided with the same signals the reference loader retrieves candidates by
 * (GTIN, ISBN, brand+MPN, brand+model, same or trigram-similar core name within the brand), at a LOWER similarity
 * threshold than PostgreSQL's, so this path can only defer more, never less, than the reference would have.
 */
import type { Queryable, TransactionSql } from "../db";
import { getAttributeDefinition } from "../taxonomy/attributes";
import type { NamedEntity, NormalizedProduct } from "../types";
import { UNCATEGORISED_CODE } from "../taxonomy/categories";
import {
  buildMasterRow,
  compactOriginal,
  contentHash,
  identifierList,
  type LoadContext,
  type LoadInput,
} from "./load";
import { dateOnly, discountOf } from "./offers";
import { ensureDefinitions } from "./specs";

export interface BatchOutcome {
  bulkCreated: number;
  bulkUnchanged: number;
  /** Records handed to the per-record loader. */
  sequential: number;
  /** True when the bulk transaction failed and its records were re-run one by one. */
  fellBack: boolean;
}

interface Entry {
  idx: number;
  input: LoadInput;
  hash: string;
}

interface Creatable extends Entry {
  brandId: number;
  manufacturerId: number | null;
  categoryId: number | null;
}

/* ---------------------------------------------- intra-batch relations */

/** pg_trgm's trigram set for a string: each word padded with two spaces before and one after. */
export function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Deliberately below the reference retrieval's 0.35, so this path only ever defers more. */
const RELATED_SIMILARITY = 0.25;

/**
 * For each item, is it related to ANY earlier item of the batch? True means "the reference loader, processing in
 * stream order, could have found an earlier record when deciding this one" - so it must not be bulk-created.
 */
export function relatedToEarlier(items: { brandId: number; n: NormalizedProduct }[]): boolean[] {
  const related = new Array<boolean>(items.length).fill(false);
  const seen = new Set<string>();
  const brands = new Map<number, { names: Set<string>; index: Map<string, number[]>; sets: Set<string>[] }>();

  items.forEach(({ brandId, n }, i) => {
    let rel = false;
    const key = (k: string) => {
      if (seen.has(k)) rel = true;
      seen.add(k);
    };
    if (n.gtin?.usableForMatching) key(`g|${n.gtin.gtin14}`);
    if (n.isbn13) key(`i|${n.isbn13}`);
    if (n.mpn?.key) key(`m|${brandId}|${n.mpn.key}`);
    if (n.model?.key) key(`d|${brandId}|${n.model.key}`);

    let g = brands.get(brandId);
    if (!g) brands.set(brandId, (g = { names: new Set(), index: new Map(), sets: [] }));
    const tri = trigramSet(n.coreName);
    if (g.names.has(n.coreName)) {
      rel = true;
    } else if (tri.size > 0 && !rel) {
      const shared = new Map<number, number>();
      for (const t of tri) for (const j of g.index.get(t) ?? []) shared.set(j, (shared.get(j) ?? 0) + 1);
      for (const [j, sh] of shared) {
        if (sh / (tri.size + g.sets[j].size - sh) >= RELATED_SIMILARITY) {
          rel = true;
          break;
        }
      }
    }
    g.names.add(n.coreName);
    const at = g.sets.length;
    g.sets.push(tri);
    for (const t of tri) {
      const list = g.index.get(t);
      if (list) list.push(at);
      else g.index.set(t, [at]);
    }
    related[i] = rel;
  });
  return related;
}

/* ------------------------------------------------- brand resolution */

interface EntityTable {
  table: string;
  aliasTable: string;
  idCol: string;
  nameCol: string;
  keyCol: string;
}
const BRAND: EntityTable = { table: "pmd.brand", aliasTable: "pmd.brand_alias", idCol: "brand_id", nameCol: "brand_name", keyCol: "brand_key" };
const MAKER: EntityTable = { table: "pmd.manufacturer", aliasTable: "pmd.manufacturer_alias", idCol: "manufacturer_id", nameCol: "manufacturer_name", keyCol: "manufacturer_key" };

const compact = compactOriginal;

/**
 * Resolves every brand (or manufacturer) spelling of a batch that the run has not seen yet in a fixed number of
 * statements, however many there are. Autocommit: the rows are durable at once, so caching them is safe.
 */
async function resolveEntities(ctx: LoadContext, t: EntityTable, entities: NamedEntity[], cache: Map<string, number>): Promise<void> {
  const want = new Map<string, NamedEntity>();
  for (const e of entities) if (!cache.has(compact(e.original))) want.set(compact(e.original), e);
  if (want.size === 0) return;

  const keys = [...new Set([...want.values()].map((e) => e.key))];
  const aliases = [...want.keys()];
  const found = await ctx.sql<{ id: number; k: string | null; a: string | null }[]>`
    SELECT ${ctx.sql(t.idCol)} AS id, ${ctx.sql(t.keyCol)} AS k, NULL::text AS a FROM ${ctx.sql(t.table)} WHERE ${ctx.sql(t.keyCol)} = ANY(${keys}::text[])
    UNION ALL
    SELECT ${ctx.sql(t.idCol)}, NULL, alias_key FROM ${ctx.sql(t.aliasTable)} WHERE alias_key = ANY(${aliases}::text[])`;
  const byKey = new Map<string, number>();
  const byAlias = new Map<string, number>();
  for (const r of found) {
    if (r.k) byKey.set(r.k, r.id);
    if (r.a) byAlias.set(r.a, r.id);
  }

  // Same precedence as the one-at-a-time resolver: match by key, else by an existing alias, else create.
  const toCreate = new Map<string, NamedEntity>();
  for (const [alias, e] of want) if (!byKey.has(e.key) && !byAlias.has(alias)) toCreate.set(e.key, e);
  if (toCreate.size) {
    const rows = [...toCreate.values()].map((e) => ({ name: e.display, key: e.key, source_id: ctx.sourceId }));
    const created = await ctx.sql<{ id: number; k: string }[]>`
      INSERT INTO ${ctx.sql(t.table)} (${ctx.sql(t.nameCol)}, ${ctx.sql(t.keyCol)}, source_id)
      SELECT r.name, r.key, r.source_id FROM jsonb_to_recordset(${ctx.sql.json(rows as never)}) AS r(name text, key text, source_id int)
      ON CONFLICT (${ctx.sql(t.keyCol)}) DO UPDATE SET ${ctx.sql(t.keyCol)} = EXCLUDED.${ctx.sql(t.keyCol)}
      RETURNING ${ctx.sql(t.idCol)} AS id, ${ctx.sql(t.keyCol)} AS k`;
    for (const r of created) byKey.set(r.k, r.id);
  }

  const aliasRows: { alias_key: string; id: number; original: string; source_id: number }[] = [];
  for (const [alias, e] of want) {
    const id = byKey.get(e.key) ?? byAlias.get(alias);
    if (id == null) continue;
    aliasRows.push({ alias_key: alias, id, original: e.original, source_id: ctx.sourceId });
    cache.set(alias, id);
  }
  if (aliasRows.length) {
    await ctx.sql`
      INSERT INTO ${ctx.sql(t.aliasTable)} (alias_key, ${ctx.sql(t.idCol)}, alias_original, source_id)
      SELECT r.alias_key, r.id, r.original, r.source_id FROM jsonb_to_recordset(${ctx.sql.json(aliasRows as never)}) AS r(alias_key text, id bigint, original text, source_id int)
      ON CONFLICT (alias_key) DO NOTHING`;
  }
}

/* ------------------------------------------------------------ main */

const chunk = <T>(rows: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

const json = (tx: Queryable, rows: unknown[]) => (tx as TransactionSql).json(rows as never);

export async function loadBatch(ctx: LoadContext, inputs: LoadInput[], loadOne: (input: LoadInput) => Promise<void>): Promise<BatchOutcome> {
  const out: BatchOutcome = { bulkCreated: 0, bulkUnchanged: 0, sequential: 0, fellBack: false };
  if (inputs.length === 0) return out;
  const entries: Entry[] = inputs.map((input, idx) => ({ idx, input, hash: contentHash(input.raw.payload) }));

  /* 1. What do we already hold for these source records? */
  const held = await ctx.sql<{ source_product_id: string; product_source_id: number; product_id: number | null; content_hash: string | null }[]>`
    SELECT source_product_id, product_source_id, product_id, content_hash FROM pmd.product_source
    WHERE source_id = ${ctx.sourceId} AND source_product_id = ANY(${entries.map((e) => e.input.raw.sourceProductId)}::text[])`;
  const existing = new Map(held.map((r) => [r.source_product_id, r]));

  const seenIds = new Set<string>();
  const unchangedIds: number[] = [];
  const sequential: Entry[] = [];
  const maybe: Entry[] = [];
  for (const e of entries) {
    const sid = e.input.raw.sourceProductId;
    const ex = existing.get(sid);
    const repeated = seenIds.has(sid);
    seenIds.add(sid);
    if (repeated) sequential.push(e); // the second sighting must see the first
    else if (ex && ex.product_id != null && ex.content_hash === e.hash) unchangedIds.push(ex.product_source_id);
    else if (ex) sequential.push(e); // changed, or held for review: a decision or a merge of facts
    else if (e.input.normalized.name && e.input.normalized.brand && ctx.adapter.createsProducts) maybe.push(e);
    else sequential.push(e); // no name (may still enrich by GTIN), no brand (whole-master fuzzy search), or a price-only source
  }

  /* 2. Unchanged: note that we still see them - two statements for the whole batch. */
  if (unchangedIds.length) {
    await ctx.sql`UPDATE pmd.product_source SET last_seen_date = current_date, last_run_id = ${ctx.runId} WHERE product_source_id = ANY(${unchangedIds}::bigint[])`;
    await ctx.sql`UPDATE pmd.product_offer SET last_seen_at = now(), is_current = true WHERE product_source_id = ANY(${unchangedIds}::bigint[])`;
    ctx.counters.recordsUnchanged += unchangedIds.length;
    out.bulkUnchanged = unchangedIds.length;
  }

  /* 3. Brands and manufacturers for the candidates - durable, a few statements for the whole batch. */
  let resolvable = maybe;
  if (maybe.length) {
    try {
      await resolveEntities(ctx, BRAND, maybe.map((e) => e.input.normalized.brand!), ctx.brandCache);
      await resolveEntities(ctx, MAKER, maybe.flatMap((e) => (e.input.normalized.manufacturer ? [e.input.normalized.manufacturer] : [])), ctx.manufacturerCache);
    } catch {
      sequential.push(...maybe); // the reference loader resolves them one at a time and isolates whatever went wrong
      resolvable = [];
      out.fellBack = true;
    }
  }
  const creatable: Creatable[] = [];
  for (const e of resolvable) {
    const n = e.input.normalized;
    const brandId = ctx.brandCache.get(compact(n.brand!.original));
    if (brandId == null) {
      sequential.push(e); // an odd spelling the bulk resolver could not place: the reference loader will
      continue;
    }
    const manufacturerId = n.manufacturer ? (ctx.manufacturerCache.get(compact(n.manufacturer.original)) ?? null) : null;
    const categoryId = n.categoryCode && n.categoryCode !== UNCATEGORISED_CODE ? (ctx.ref.categoryIdByCode.get(n.categoryCode) ?? null) : null;
    creatable.push({ ...e, brandId, manufacturerId, categoryId });
  }

  /* 4. Records related to an earlier record of this batch wait for the reference loader. */
  const related = relatedToEarlier(creatable.map((c) => ({ brandId: c.brandId, n: c.input.normalized })));
  const candidates = creatable.filter((c, i) => (related[i] ? (sequential.push(c), false) : true));

  /* 5. One transaction: check the database for candidates, then insert what has none. */
  let created: Creatable[] = [];
  if (candidates.length) {
    try {
      const done = await createInBulk(ctx, candidates);
      created = done.created;
      sequential.push(...done.deferred);
      out.bulkCreated = created.length;
      // counters and follow-up work only once the transaction has COMMITTED
      ctx.counters.recordsStaged += created.length;
      ctx.counters.productsCreated += created.length;
      ctx.counters.offersUpserted += done.offers;
      done.productIds.forEach((id) => ctx.touched.add(id));
    } catch {
      out.fellBack = true;
      sequential.push(...candidates); // isolate whatever went wrong, record by record
    }
  }

  /* 6. Everything else, in stream order, through the reference loader. */
  sequential.sort((a, b) => a.idx - b.idx);
  out.sequential = sequential.length;
  for (const e of sequential) await loadOne(e.input);
  return out;
}

interface BulkResult {
  created: Creatable[];
  /** Candidates that DO have a master to compare with: left untouched for the reference loader. */
  deferred: Creatable[];
  productIds: number[];
  offers: number;
}

/**
 * Inserts the records that have no candidate master, in one transaction. Throws (rolling everything back) on any error.
 */
async function createInBulk(ctx: LoadContext, candidates: Creatable[]): Promise<BulkResult> {
  const cfg = ctx.cfg.match;
  return ctx.sql.begin(async (tx): Promise<BulkResult> => {
    const defer: Creatable[] = [];
    // Same per-brand lock the reference loader takes, in a fixed order so two batches cannot deadlock.
    const lockKeys = [...new Set(candidates.map((c) => `b:${c.input.normalized.brand!.key}`))].sort();
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('pmd:' || k, 0)) FROM (SELECT k FROM unnest(${lockKeys}::text[]) AS k ORDER BY k) s`;
    await tx`SELECT set_config('pg_trgm.similarity_threshold', ${String(cfg.trigramThreshold)}, true)`;

    /* Is there ANY master the reference loader would have retrieved as a candidate? Then it decides, not us. */
    const hit = new Set<number>();
    const gtins = candidates.flatMap((c) => (c.input.normalized.gtin?.usableForMatching ? [c.input.normalized.gtin.gtin14] : []));
    const isbns = candidates.flatMap((c) => (c.input.normalized.isbn13 ? [c.input.normalized.isbn13] : []));
    if (gtins.length || isbns.length) {
      const taken = await tx<{ id_type: string; id_value: string }[]>`
        SELECT i.id_type, i.id_value FROM pmd.product_identifier i
        JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
        WHERE (i.id_type = 'GTIN' AND i.id_value = ANY(${gtins}::text[])) OR (i.id_type = 'ISBN' AND i.id_value = ANY(${isbns}::text[]))`;
      const takenSet = new Set(taken.map((t) => `${t.id_type}|${t.id_value}`));
      candidates.forEach((c, i) => {
        const n = c.input.normalized;
        if ((n.gtin?.usableForMatching && takenSet.has(`GTIN|${n.gtin.gtin14}`)) || (n.isbn13 && takenSet.has(`ISBN|${n.isbn13}`))) hit.add(i);
      });
    }
    const scoped = candidates.flatMap((c, i) =>
      (["MPN", "MODEL"] as const).flatMap((type) => {
        const key = type === "MPN" ? c.input.normalized.mpn?.key : c.input.normalized.model?.key;
        return key ? [{ i, type, key, brand: c.brandId }] : [];
      }),
    );
    if (scoped.length) {
      const found = await tx<{ id_type: string; id_value: string; scope_brand_id: number }[]>`
        SELECT DISTINCT i.id_type, i.id_value, i.scope_brand_id FROM pmd.product_identifier i
        JOIN pmd.product_master pm ON pm.product_id = i.product_id AND pm.record_status = 'ACTIVE'
        JOIN unnest(${scoped.map((s) => s.type)}::text[], ${scoped.map((s) => s.key)}::text[], ${scoped.map((s) => s.brand)}::bigint[]) AS t(id_type, id_value, brand_id)
          ON i.id_type = t.id_type AND i.id_value = t.id_value AND i.scope_brand_id = t.brand_id`;
      const foundSet = new Set(found.map((f) => `${f.id_type}|${f.id_value}|${f.scope_brand_id}`));
      for (const s of scoped) if (foundSet.has(`${s.type}|${s.key}|${s.brand}`)) hit.add(s.i);
    }
    // Sibling (same brand, identical core name) or trigram-similar name within the brand.
    const named = await tx<{ ord: number }[]>`
      SELECT t.ord FROM unnest(${candidates.map((_, i) => i)}::int[], ${candidates.map((c) => c.brandId)}::bigint[], ${candidates.map((c) => c.input.normalized.coreName)}::text[]) AS t(ord, brand_id, core)
      WHERE EXISTS (SELECT 1 FROM pmd.product_master pm
                    WHERE pm.brand_id = t.brand_id AND pm.record_status = 'ACTIVE' AND (pm.normalized_name = t.core OR (t.core <> '' AND pm.normalized_name % t.core)))`;
    for (const r of named) hit.add(r.ord);

    const fresh = candidates.filter((c, i) => (hit.has(i) ? (defer.push(c), false) : true));
    if (fresh.length === 0) return { created: [], deferred: defer, productIds: [], offers: 0 };

    /* Ids first, so every child row can name its master without a round trip. */
    const idRows = await tx<{ id: number }[]>`SELECT nextval('pmd.product_seq')::bigint AS id FROM generate_series(1, ${fresh.length})`;
    const productIds = idRows.map((r) => r.id);
    const [{ d: today }] = await tx<{ d: string }[]>`SELECT current_date::text AS d`;
    const reliability = (ctx.ref.sourceMeta.get(ctx.sourceId)?.reliability ?? 50) as number;

    /* raw records */
    const rawRows = fresh.map((c) => ({ run_id: ctx.runId, source_id: ctx.sourceId, source_product_id: c.input.raw.sourceProductId, content_hash: c.hash, payload: c.input.raw.payload }));
    const raws = await tx<{ raw_id: number; source_product_id: string }[]>`
      INSERT INTO pmd.raw_record (run_id, source_id, source_product_id, content_hash, payload)
      SELECT run_id, source_id, source_product_id, content_hash, payload FROM jsonb_populate_recordset(NULL::pmd.raw_record, ${json(tx, rawRows)})
      ON CONFLICT (source_id, source_product_id, content_hash) DO UPDATE SET fetched_at = pmd.raw_record.fetched_at
      RETURNING raw_id, source_product_id`;
    const rawId = new Map(raws.map((r) => [r.source_product_id, r.raw_id]));

    /* masters */
    const masterRows = fresh.map((c, k) => ({
      product_id: productIds[k],
      ...buildMasterRow(ctx, c.input.normalized, { brandId: c.brandId, manufacturerId: c.manufacturerId, categoryId: c.categoryId }, 100),
    }));
    const mcols = Object.keys(masterRows[0]);
    await tx`INSERT INTO pmd.product_master (${tx(mcols)}) SELECT ${tx(mcols)} FROM jsonb_populate_recordset(NULL::pmd.product_master, ${json(tx, masterRows)})`;

    /* identifiers (a GTIN/ISBN that already belongs to someone is a collision: roll back and let the reference loader say so) */
    const identRows = fresh.flatMap((c, k) =>
      identifierList(c.input.normalized, c.brandId).map((i) => ({
        product_id: productIds[k], id_type: i.type, id_value: i.value, id_value_original: i.original, id_format: i.format ?? null,
        scope_brand_id: i.scope ?? null, is_primary: i.primary ?? false, check_digit_valid: i.check ?? null, source_id: ctx.sourceId,
      })),
    );
    if (identRows.length) {
      const got = await tx<{ product_id: number; id_type: string; id_value: string }[]>`
        INSERT INTO pmd.product_identifier (product_id, id_type, id_value, id_value_original, id_format, scope_brand_id, is_primary, check_digit_valid, source_id)
        SELECT product_id, id_type, id_value, id_value_original, id_format, scope_brand_id, is_primary, check_digit_valid, source_id
        FROM jsonb_populate_recordset(NULL::pmd.product_identifier, ${json(tx, identRows)})
        ON CONFLICT DO NOTHING RETURNING product_id, id_type, id_value`;
      const inserted = new Set(got.map((g) => `${g.product_id}|${g.id_type}|${g.id_value}`));
      for (const r of identRows) {
        if ((r.id_type === "GTIN" || r.id_type === "ISBN") && !inserted.has(`${r.product_id}|${r.id_type}|${r.id_value}`)) {
          throw Object.assign(new Error(`${r.id_type} ${r.id_value} already belongs to another product`), { code: "IDENTIFIER_COLLISION" });
        }
      }
    }

    /* specifications: a new master has one source, so every value is the preferred one */
    const unknownKeys = new Map(fresh.flatMap((c) => c.input.normalized.attributes).filter((a) => !getAttributeDefinition(a.key)).map((a) => [a.key, a] as const));
    if (unknownKeys.size) await ensureDefinitions(tx, [...unknownKeys.values()]);
    const specRows = fresh.flatMap((c, k) =>
      c.input.normalized.attributes.map((a) => ({
        product_id: productIds[k], attribute_key: a.key, value_text: a.valueText ?? null, value_num: a.valueNum ?? null, value_bool: a.valueBool ?? null,
        unit: a.unit ?? null, original_value: a.original ?? null, source_id: ctx.sourceId, source_url: c.input.normalized.sourceUrl,
        confidence: c.input.staged.sourceConfidence ?? null, is_preferred: true,
      })),
    );
    for (const part of chunk(specRows, 5000)) {
      await tx`
        INSERT INTO pmd.product_specification (product_id, attribute_key, value_text, value_num, value_bool, unit, original_value, source_id, source_url, confidence, is_preferred)
        SELECT product_id, attribute_key, value_text, value_num, value_bool, unit, original_value, source_id, source_url, confidence, is_preferred
        FROM jsonb_populate_recordset(NULL::pmd.product_specification, ${json(tx, part)})`;
    }

    /* images: first six distinct URLs, ranked in order (the reference loader stops at six too) */
    const imageRows = fresh.flatMap((c, k) =>
      [...new Set(c.input.normalized.images)].slice(0, 6).map((url, rank) => ({
        product_id: productIds[k], rank, image_url: url, image_source: ctx.adapter.definition.key, source_id: ctx.sourceId, license_note: ctx.adapter.imageLicenseNote ?? null,
      })),
    );
    if (imageRows.length) {
      await tx`
        INSERT INTO pmd.product_image (product_id, rank, image_url, image_source, source_id, license_note)
        SELECT product_id, rank, image_url, image_source, source_id, license_note FROM jsonb_populate_recordset(NULL::pmd.product_image, ${json(tx, imageRows)})
        ON CONFLICT (product_id, image_url) DO NOTHING`;
    }

    /* the source listings */
    const sourceRows = fresh.map((c, k) => {
      const n = c.input.normalized;
      const staged = c.input.staged;
      return {
        product_id: productIds[k], source_id: ctx.sourceId, source_product_id: c.input.raw.sourceProductId,
        source_url: n.sourceUrl ?? c.input.raw.url ?? null,
        source_category: n.categoryRaw.join(" | ").slice(0, 1000) || null,
        source_product_name: staged.name ?? null, source_brand: staged.brand ?? null,
        source_mrp_minor: n.offer?.mrpMinor ?? null, source_price_minor: n.offer?.priceMinor ?? null, source_currency: n.offer?.currency ?? null,
        source_rating: staged.rating ?? null, source_review_count: staged.reviewCount ?? null,
        source_availability: staged.availability ?? n.offer?.stockStatus ?? null,
        data_collection_method: ctx.adapter.collectionMethod, data_confidence: staged.sourceConfidence ?? reliability,
        match_status: "NO_CANDIDATE", match_score: null, match_rule: null, resolution: "CREATED_NEW", content_hash: c.hash,
        normalized: {
          brandKey: n.brand?.key ?? null, coreName: n.coreName, gtin14: n.gtin?.usableForMatching ? n.gtin.gtin14 : null,
          pack: n.quantity?.label ?? null, categoryCode: n.categoryCode, issues: n.issues.filter((i) => i.severity !== "INFO").map((i) => i.code),
        },
        raw_id: rawId.get(c.input.raw.sourceProductId) ?? null, last_run_id: ctx.runId,
      };
    });
    const sources = await tx<{ product_source_id: number; source_product_id: string }[]>`
      INSERT INTO pmd.product_source
        (product_id, source_id, source_product_id, source_url, source_category, source_product_name, source_brand, source_mrp_minor, source_price_minor,
         source_currency, source_rating, source_review_count, source_availability, first_seen_date, last_seen_date, data_collection_date,
         data_collection_method, data_confidence, match_status, match_score, match_rule, resolution, content_hash, normalized, raw_id, last_run_id)
      SELECT product_id, source_id, source_product_id, source_url, source_category, source_product_name, source_brand, source_mrp_minor, source_price_minor,
             source_currency, source_rating, source_review_count, source_availability, ${today}::date, ${today}::date, ${today}::date,
             data_collection_method, data_confidence, match_status, match_score, match_rule, resolution, content_hash, normalized, raw_id, last_run_id
      FROM jsonb_populate_recordset(NULL::pmd.product_source, ${json(tx, sourceRows)})
      RETURNING product_source_id, source_product_id`;
    const sourceId = new Map(sources.map((s) => [s.source_product_id, s.product_source_id]));

    /* offers and their first price-history observation */
    let offerCount = 0;
    const withOffer = fresh.flatMap((c, k) => (c.input.normalized.offer ? [{ c, k }] : []));
    if (withOffer.length) {
      const offerRows = withOffer.map(({ c, k }) => {
        const o = c.input.normalized.offer!;
        const d = discountOf(o);
        return {
          product_source_id: sourceId.get(c.input.raw.sourceProductId)!, product_id: productIds[k], source_id: ctx.sourceId,
          source_product_id: c.input.raw.sourceProductId, seller_key: o.sellerKey, seller_id: o.sellerId, seller_name: o.sellerName,
          seller_location: o.sellerLocation, seller_rating: o.sellerRating, price_minor: o.priceMinor, mrp_minor: o.mrpMinor,
          discount_minor: d.minor, discount_pct: d.pct, currency: o.currency, tax_inclusive: o.taxInclusive, stock_status: o.stockStatus,
          delivery_information: o.deliveryInformation, source_url: o.url ?? c.input.normalized.sourceUrl, collection_date: dateOnly(o.collectedAt),
          collected_at: o.collectedAt.toISOString(),
        };
      });
      const offers = await tx<{ offer_id: number; product_source_id: number }[]>`
        INSERT INTO pmd.product_offer
          (product_source_id, product_id, source_id, source_product_id, seller_key, seller_id, seller_name, seller_location, seller_rating, price_minor, mrp_minor,
           discount_minor, discount_pct, currency, tax_inclusive, stock_status, delivery_information, source_url, first_seen_at, last_seen_at,
           collection_date, collected_at, is_current)
        SELECT product_source_id, product_id, source_id, source_product_id, seller_key, seller_id, seller_name, seller_location, seller_rating, price_minor, mrp_minor,
               discount_minor, discount_pct, currency, tax_inclusive, stock_status, delivery_information, source_url, now(), now(),
               collection_date, collected_at, true
        FROM jsonb_populate_recordset(NULL::pmd.product_offer, ${json(tx, offerRows)})
        RETURNING offer_id, product_source_id`;
      const offerId = new Map(offers.map((o) => [o.product_source_id, o.offer_id]));
      offerCount = offers.length;
      const historyRows = withOffer.map(({ c, k }) => {
        const o = c.input.normalized.offer!;
        const d = discountOf(o);
        return {
          product_id: productIds[k], offer_id: offerId.get(sourceId.get(c.input.raw.sourceProductId)!)!, source_id: ctx.sourceId, seller_key: o.sellerKey,
          seller_name: o.sellerName, mrp_minor: o.mrpMinor, selling_price_minor: o.priceMinor, discount_minor: d.minor, currency: o.currency,
          stock_status: o.stockStatus, change_reason: "FIRST_SEEN", collection_date: dateOnly(o.collectedAt), collected_at: o.collectedAt.toISOString(), run_id: ctx.runId,
        };
      });
      await tx`
        INSERT INTO pmd.price_history
          (product_id, offer_id, source_id, seller_key, seller_name, mrp_minor, selling_price_minor, discount_minor, currency, stock_status, change_reason,
           collection_date, collected_at, run_id)
        SELECT product_id, offer_id, source_id, seller_key, seller_name, mrp_minor, selling_price_minor, discount_minor, currency, stock_status, change_reason,
               collection_date, collected_at, run_id
        FROM jsonb_populate_recordset(NULL::pmd.price_history, ${json(tx, historyRows)})`;
    }

    /* change log: one "created" entry per master, exactly as the reference loader writes it */
    const logRows = fresh.map((c, k) => ({
      product_id: productIds[k], entity: "product_master", field_name: "created",
      new_value: { name: c.input.normalized.name, brand: c.input.normalized.brand?.display ?? null }, source_id: ctx.sourceId, run_id: ctx.runId,
    }));
    await tx`
      INSERT INTO pmd.product_change_log (product_id, entity, field_name, old_value, new_value, source_id, run_id, changed_by)
      SELECT product_id, entity, field_name, 'null'::jsonb, new_value, source_id, run_id, 'pipeline'
      FROM jsonb_populate_recordset(NULL::pmd.product_change_log, ${json(tx, logRows)})`;

    return { created: fresh, deferred: defer, productIds, offers: offerCount };
  });
}
