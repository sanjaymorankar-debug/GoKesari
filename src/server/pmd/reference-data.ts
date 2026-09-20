/**
 * Reference data: sources, category taxonomy, attribute registry, category mappings.
 *
 * The TypeScript definitions are the single source of truth; this module makes the
 * database match them. Every function is idempotent. Human edits are respected: a manual
 * category mapping (mapped_by <> 'SYSTEM') is never overwritten, and a steward who disabled
 * a source keeps it disabled.
 *
 * `ensureReferenceData()` is called at the start of every run, so it must be cheap when
 * nothing changed: it compares a fingerprint of the definitions with the one stored in
 * pmd.reference_state and syncs only when they differ (or when forced). Two lessons are
 * built in:
 *   - re-upserting ~1,600 rows on every run costs seconds over a network, and would time
 *     out the import API against a hosted database;
 *   - `INSERT ... ON CONFLICT` evaluates the identity default before it notices the
 *     conflict, so upserting rows that already exist burns one identity value each. That
 *     exhausted the smallint sequence behind source_id after ~800 runs. Existing rows are
 *     therefore UPDATEd; only genuinely new rows are INSERTed.
 */
import { createHash } from "node:crypto";

import { SOURCE_KIND_DEFAULTS } from "./config";
import type { Queryable } from "./db";
import { getSourceDefinition, SOURCE_REGISTRY } from "./sources/registry";
import { ATTRIBUTE_DEFINITIONS } from "./taxonomy/attributes";
import { getTaxonomy } from "./taxonomy/categories";
import { createCategoryMapper, normalizeSourceCategory, type CategoryMapper, type CategoryRules } from "./taxonomy/mapper";
import type { SourceDefinition } from "./types";

export interface ReferenceIds {
  sourceIdByKey: Map<string, number>;
  categoryIdByCode: Map<string, number>;
  /** spec_precedence per source id (lower wins) and reliability, for survivorship and quality. */
  sourceMeta: Map<number, { key: string; specPrecedence: number; reliability: number; kind: string }>;
  /** false when the database already matched the code and nothing was written; absent from plain reads. */
  synced?: boolean;
}

export async function upsertSources(sql: Queryable, defs: readonly SourceDefinition[] = SOURCE_REGISTRY): Promise<void> {
  const existing = new Set((await sql<{ source_key: string }[]>`SELECT source_key FROM pmd.source`).map((r) => r.source_key));
  for (const d of defs) {
    const kindDefaults = SOURCE_KIND_DEFAULTS[d.kind];
    const reliability = d.reliability ?? kindDefaults.reliability;
    const specPrecedence = d.specPrecedence ?? kindDefaults.specPrecedence;
    const mapping = sql.json((d.fieldMapping ?? {}) as never);

    if (existing.has(d.key)) {
      await sql`
        UPDATE pmd.source SET
          source_name = ${d.name}, source_kind = ${d.kind}, access_method = ${d.accessMethod}, status = ${d.status},
          -- a steward's "disabled" sticks; a source that is no longer ACTIVE can never stay enabled
          enabled = CASE WHEN ${d.status} = 'ACTIVE' THEN enabled ELSE false END,
          reliability = ${reliability}, spec_precedence = ${specPrecedence},
          legal_basis = ${d.legalBasis}, license_name = ${d.licenseName ?? null}, terms_url = ${d.termsUrl ?? null},
          robots_policy = ${d.robotsPolicy ?? null}, api_endpoint = ${d.apiEndpoint ?? null}, auth_env_var = ${d.authEnvVar ?? null},
          collection_frequency = ${d.collectionFrequency ?? null}, rate_limit_per_min = ${d.rateLimitPerMin ?? null},
          parser_key = ${d.parserKey ?? null}, field_mapping = ${mapping}, retry_max = ${d.retryMax ?? 3}, notes = ${d.notes ?? null}
        WHERE source_key = ${d.key}`;
    } else {
      // A concurrent seeder may have inserted it a moment ago: DO NOTHING, the next sync updates it.
      await sql`
        INSERT INTO pmd.source (
          source_key, source_name, source_kind, access_method, status, enabled, reliability, spec_precedence,
          legal_basis, license_name, terms_url, robots_policy, api_endpoint, auth_env_var, collection_frequency,
          rate_limit_per_min, parser_key, field_mapping, retry_max, notes
        ) VALUES (
          ${d.key}, ${d.name}, ${d.kind}, ${d.accessMethod}, ${d.status}, ${d.status === "ACTIVE"},
          ${reliability}, ${specPrecedence},
          ${d.legalBasis}, ${d.licenseName ?? null}, ${d.termsUrl ?? null}, ${d.robotsPolicy ?? null},
          ${d.apiEndpoint ?? null}, ${d.authEnvVar ?? null}, ${d.collectionFrequency ?? null},
          ${d.rateLimitPerMin ?? null}, ${d.parserKey ?? null}, ${mapping},
          ${d.retryMax ?? 3}, ${d.notes ?? null}
        )
        ON CONFLICT (source_key) DO NOTHING`;
    }
  }
}

export async function upsertCategories(sql: Queryable): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const pathIds = new Map<string, number[]>();
  const existing = new Map(
    (await sql<{ category_id: number; category_code: string; path_ids: number[] }[]>`SELECT category_id, category_code, path_ids FROM pmd.category`).map(
      (r) => [r.category_code, r] as const,
    ),
  );

  for (const c of getTaxonomy()) {
    const parentId = c.parentCode ? ids.get(c.parentCode)! : null;
    const known = existing.get(c.code);
    let categoryId: number;
    let currentPath: number[];
    if (known) {
      await sql`
        UPDATE pmd.category SET parent_id = ${parentId}, level = ${c.level}, name = ${c.name}, slug = ${c.slug},
          path_names = ${c.pathNames}, gokesari_department = ${c.department}, sort_order = ${c.sortOrder}
        WHERE category_id = ${known.category_id}`;
      categoryId = known.category_id;
      currentPath = known.path_ids;
    } else {
      const [row] = await sql<{ category_id: number; path_ids: number[] }[]>`
        INSERT INTO pmd.category (category_code, parent_id, level, name, slug, path_names, path_ids, gokesari_department, sort_order)
        VALUES (${c.code}, ${parentId}, ${c.level}, ${c.name}, ${c.slug}, ${c.pathNames}, '{}'::int4[], ${c.department}, ${c.sortOrder})
        ON CONFLICT (category_code) DO UPDATE SET
          parent_id = EXCLUDED.parent_id, level = EXCLUDED.level, name = EXCLUDED.name, slug = EXCLUDED.slug,
          path_names = EXCLUDED.path_names, gokesari_department = EXCLUDED.gokesari_department, sort_order = EXCLUDED.sort_order
        RETURNING category_id, path_ids`;
      categoryId = row.category_id;
      currentPath = row.path_ids;
    }
    ids.set(c.code, categoryId);
    const full = [...(c.parentCode ? pathIds.get(c.parentCode)! : []), categoryId];
    pathIds.set(c.code, full);
    if (currentPath.join(",") !== full.join(",")) {
      await sql`UPDATE pmd.category SET path_ids = ${full}::int4[] WHERE category_id = ${categoryId}`;
    }
  }
  return ids;
}

export async function upsertAttributeDefinitions(sql: Queryable): Promise<void> {
  let order = 0;
  for (const a of ATTRIBUTE_DEFINITIONS) {
    await sql`
      INSERT INTO pmd.attribute_definition (attribute_key, attribute_label, attribute_group, data_type, canonical_unit, source_authority, track_conflicts, description, sort_order)
      VALUES (${a.key}, ${a.label}, ${a.group}, ${a.dataType}, ${a.unit ?? null}, ${a.authority ?? "SPEC"}, ${a.trackConflicts ?? true}, ${a.description ?? null}, ${order++})
      ON CONFLICT (attribute_key) DO UPDATE SET
        attribute_label = EXCLUDED.attribute_label, attribute_group = EXCLUDED.attribute_group, data_type = EXCLUDED.data_type,
        canonical_unit = EXCLUDED.canonical_unit, source_authority = EXCLUDED.source_authority,
        track_conflicts = EXCLUDED.track_conflicts, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order`;
  }
}

/** Registers a source's exact tag mappings in pmd.category_mapping (never overwrites a manual mapping). */
export async function upsertCategoryMappings(
  sql: Queryable,
  sourceKey: string,
  rules: CategoryRules,
  categoryIdByCode: Map<string, number>,
): Promise<number> {
  const [src] = await sql<{ source_id: number }[]>`SELECT source_id FROM pmd.source WHERE source_key = ${sourceKey}`;
  if (!src) throw new Error(`unknown source ${sourceKey}`);
  let n = 0;
  for (const [tag, code] of Object.entries(rules.tags)) {
    const catId = categoryIdByCode.get(code);
    if (!catId) throw new Error(`category mapping for ${sourceKey}:${tag} points at unknown category ${code}`);
    await sql`
      INSERT INTO pmd.category_mapping (source_id, source_category, source_category_original, standard_category_id, match_type, confidence, mapped_by)
      VALUES (${src.source_id}, ${normalizeSourceCategory(tag)}, ${tag}, ${catId}, 'EXACT', 90, 'SYSTEM')
      ON CONFLICT (source_id, source_category) DO UPDATE SET
        standard_category_id = EXCLUDED.standard_category_id, source_category_original = EXCLUDED.source_category_original
      WHERE pmd.category_mapping.mapped_by = 'SYSTEM'`;
    n++;
  }
  return n;
}

/**
 * Stewards' manual overrides, loaded at run start and consulted BEFORE the built-in
 * rules, so a correction made in the database wins over the shipped defaults.
 */
export async function loadManualCategoryMapper(sql: Queryable, sourceKey: string): Promise<CategoryMapper> {
  const rows = await sql<{ source_category: string; category_code: string }[]>`
    SELECT cm.source_category, c.category_code
    FROM pmd.category_mapping cm
    JOIN pmd.source s ON s.source_id = cm.source_id
    JOIN pmd.category c ON c.category_id = cm.standard_category_id
    WHERE s.source_key = ${sourceKey} AND cm.mapped_by <> 'SYSTEM' AND cm.is_active`;
  return createCategoryMapper({ tags: Object.fromEntries(rows.map((r) => [r.source_category, r.category_code])), keywords: [] });
}

export async function loadReferenceIds(sql: Queryable): Promise<ReferenceIds> {
  const sources = await sql<{ source_id: number; source_key: string; spec_precedence: number; reliability: number; source_kind: string }[]>`
    SELECT source_id, source_key, spec_precedence, reliability, source_kind FROM pmd.source`;
  const cats = await sql<{ category_id: number; category_code: string }[]>`SELECT category_id, category_code FROM pmd.category`;
  return {
    sourceIdByKey: new Map(sources.map((s) => [s.source_key, s.source_id])),
    categoryIdByCode: new Map(cats.map((c) => [c.category_code, c.category_id])),
    sourceMeta: new Map(
      sources.map((s) => [s.source_id, { key: s.source_key, specPrecedence: s.spec_precedence, reliability: s.reliability, kind: s.source_kind }]),
    ),
  };
}

/** Bump when the sync logic itself changes, so databases that already match the data re-sync once. */
const SYNC_VERSION = 1;

/** Hash of everything ensureReferenceData() writes. Equal hash = the database already matches the code. */
export function referenceFingerprint(shippedMappingTags: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: SYNC_VERSION,
        sources: SOURCE_REGISTRY,
        kindDefaults: SOURCE_KIND_DEFAULTS,
        taxonomy: getTaxonomy(),
        attributes: ATTRIBUTE_DEFINITIONS,
        mappings: shippedMappingTags,
      }),
    )
    .digest("hex");
}

/**
 * Makes the database match the code - but only when it does not already. Safe to call at the start
 * of every run and in test setup: when the stored fingerprint matches it costs two statements.
 * `force` re-syncs regardless (e.g. after a manual repair of a reference table).
 */
export async function ensureReferenceData(sql: Queryable, opts: { force?: boolean } = {}): Promise<ReferenceIds> {
  const { OPEN_FACTS_RULES } = await import("./sources/mappings/open-facts");
  const hash = referenceFingerprint(OPEN_FACTS_RULES.tags);
  if (!opts.force) {
    const [state] = await sql<{ content_hash: string }[]>`SELECT content_hash FROM pmd.reference_state`;
    if (state?.content_hash === hash) return { ...(await loadReferenceIds(sql)), synced: false };
  }

  await upsertSources(sql);
  const categoryIds = await upsertCategories(sql);
  await upsertAttributeDefinitions(sql);
  for (const key of ["open_food_facts", "open_beauty_facts", "open_products_facts", "open_pet_food_facts", "open_prices"]) {
    if (getSourceDefinition(key)) await upsertCategoryMappings(sql, key, OPEN_FACTS_RULES, categoryIds);
  }
  await sql`
    INSERT INTO pmd.reference_state (singleton, content_hash) VALUES (true, ${hash})
    ON CONFLICT (singleton) DO UPDATE SET content_hash = EXCLUDED.content_hash, applied_at = now()`;
  return { ...(await loadReferenceIds(sql)), synced: true };
}
