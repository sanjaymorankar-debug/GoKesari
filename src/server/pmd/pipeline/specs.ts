/**
 * Specifications, provenance and conflict handling.
 *
 * Every category-specific fact is stored once PER SOURCE (product_specification has
 * one row per product x attribute x source), never overwritten. When sources
 * disagree about the same attribute:
 *
 *   - a PRODUCT_ATTRIBUTE_CONFLICT row is written (nothing is silently overwritten);
 *   - the source with the better spec precedence (manufacturer > GS1 > government >
 *     licensed feed > marketplace > open data) wins the "preferred" flag, and the
 *     conflict is AUTO_RESOLVED with the rule recorded;
 *   - if the sources are equally authoritative the conflict stays OPEN for a person,
 *     and the previously preferred value stays in force until they decide.
 *
 * Attributes flagged with a master column (colour, GST rate, weights...) are then
 * projected onto product_master from the preferred value.
 */
import type { Queryable } from "../db";
import type { ReferenceIds } from "../reference-data";
import { ATTRIBUTE_DEFINITIONS, getAttributeDefinition, type AttributeDefinition } from "../taxonomy/attributes";
import type { NormalizedAttribute } from "../types";

interface SpecRow {
  spec_id: number;
  source_id: number;
  value_text: string | null;
  value_num: number | null;
  value_bool: boolean | null;
  unit: string | null;
  is_preferred: boolean;
  collected_at: Date;
}

export function canonicalValue(v: { valueText?: string | null; valueNum?: number | null; valueBool?: boolean | null }): string {
  if (v.valueNum != null) return `n:${Number(v.valueNum.toFixed(6))}`;
  if (v.valueBool != null) return `b:${v.valueBool}`;
  return `t:${(v.valueText ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

const rowCanonical = (r: SpecRow) => canonicalValue({ valueText: r.value_text, valueNum: r.value_num, valueBool: r.value_bool });

export function displayValue(v: { valueText?: string | null; valueNum?: number | null; valueBool?: boolean | null; unit?: string | null }): string {
  if (v.valueNum != null) return `${Number(v.valueNum.toFixed(6))}${v.unit ? ` ${v.unit}` : ""}`;
  if (v.valueBool != null) return v.valueBool ? "Yes" : "No";
  return v.valueText ?? "";
}

export interface SpecContext {
  ref: ReferenceIds;
  sourceId: number;
  /** Null when a person (not an ingestion run) triggers the re-resolution, e.g. a merge. */
  runId: number | null;
  sourceUrl: string | null;
  confidence: number | null;
}

export interface SpecOutcome {
  conflictsOpened: number;
  /** Master columns whose preferred value changed, ready for UPDATE. */
  masterPatch: Record<string, string | number | null>;
  changedKeys: string[];
}

/** Auto-registers attribute keys a source sends that the registry does not know yet. */
async function ensureDefinitions(sql: Queryable, attrs: NormalizedAttribute[]): Promise<void> {
  for (const a of attrs) {
    if (getAttributeDefinition(a.key)) continue;
    const type = a.valueNum != null ? "NUMBER" : a.valueBool != null ? "BOOLEAN" : "TEXT";
    const label = a.key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    await sql`
      INSERT INTO pmd.attribute_definition (attribute_key, attribute_label, attribute_group, data_type)
      VALUES (${a.key}, ${label}, 'OTHER', ${type})
      ON CONFLICT (attribute_key) DO NOTHING`;
  }
}

const MASTER_COLUMN_BY_KEY = new Map(
  ATTRIBUTE_DEFINITIONS.filter((d) => d.masterColumn).map((d) => [d.key, d.masterColumn!] as const),
);
const INTEGER_COLUMNS = new Set(["gst_rate_bp", "cess_bp"]);

/** Upserts this source's values, then re-resolves every attribute whose value actually changed. */
export async function upsertSpecs(
  sql: Queryable,
  ctx: SpecContext,
  productId: number,
  attrs: NormalizedAttribute[],
): Promise<SpecOutcome> {
  const outcome: SpecOutcome = { conflictsOpened: 0, masterPatch: {}, changedKeys: [] };
  if (attrs.length === 0) return outcome;
  await ensureDefinitions(sql, attrs);

  const existing = new Map(
    (await sql<(SpecRow & { attribute_key: string })[]>`
      SELECT spec_id, attribute_key, source_id, value_text, value_num, value_bool, unit, is_preferred, collected_at
      FROM pmd.product_specification WHERE product_id = ${productId} AND source_id = ${ctx.sourceId}`).map((r) => [r.attribute_key, r]),
  );

  for (const a of attrs) {
    const prev = existing.get(a.key);
    if (prev && rowCanonical(prev) === canonicalValue(a)) continue; // unchanged: no write, no conflict re-check
    await sql`
      INSERT INTO pmd.product_specification
        (product_id, attribute_key, value_text, value_num, value_bool, unit, original_value, source_id, source_url, confidence)
      VALUES (${productId}, ${a.key}, ${a.valueText ?? null}, ${a.valueNum ?? null}, ${a.valueBool ?? null}, ${a.unit ?? null},
              ${a.original ?? null}, ${ctx.sourceId}, ${ctx.sourceUrl}, ${ctx.confidence})
      ON CONFLICT (product_id, attribute_key, source_id) DO UPDATE SET
        value_text = EXCLUDED.value_text, value_num = EXCLUDED.value_num, value_bool = EXCLUDED.value_bool,
        unit = EXCLUDED.unit, original_value = EXCLUDED.original_value, source_url = EXCLUDED.source_url,
        confidence = EXCLUDED.confidence, collected_at = now()`;
    outcome.changedKeys.push(a.key);
  }

  for (const key of outcome.changedKeys) {
    const res = await resolveAttribute(sql, ctx, productId, key);
    outcome.conflictsOpened += res.opened;
    if (res.preferred && MASTER_COLUMN_BY_KEY.has(key)) {
      const col = MASTER_COLUMN_BY_KEY.get(key)!;
      const p = res.preferred;
      const value = p.value_num != null ? (INTEGER_COLUMNS.has(col) ? Math.round(p.value_num) : p.value_num) : p.value_text;
      outcome.masterPatch[col] = value;
    }
  }
  return outcome;
}

interface Ranked extends SpecRow {
  canonical: string;
  precedence: number;
  reliability: number;
  sourceKey: string;
}

/** Recomputes the preferred value and the conflict rows for one product x attribute. */
export async function resolveAttribute(
  sql: Queryable,
  ctx: SpecContext,
  productId: number,
  key: string,
): Promise<{ opened: number; preferred: SpecRow | null }> {
  const def: AttributeDefinition | undefined = getAttributeDefinition(key);
  const rows = await sql<SpecRow[]>`
    SELECT spec_id, source_id, value_text, value_num, value_bool, unit, is_preferred, collected_at
    FROM pmd.product_specification WHERE product_id = ${productId} AND attribute_key = ${key}`;
  if (rows.length === 0) return { opened: 0, preferred: null };

  const ranked: Ranked[] = rows
    .map((r) => {
      const meta = ctx.ref.sourceMeta.get(r.source_id);
      return { ...r, canonical: rowCanonical(r), precedence: meta?.specPrecedence ?? 50, reliability: meta?.reliability ?? 50, sourceKey: meta?.key ?? String(r.source_id) };
    })
    .sort((a, b) => a.precedence - b.precedence || b.reliability - a.reliability || +b.collected_at - +a.collected_at || a.spec_id - b.spec_id);

  const winner = ranked[0];
  const differing = ranked.filter((r) => r.canonical !== winner.canonical);
  let opened = 0;
  let preferredId = winner.spec_id;

  if (differing.length && (def?.trackConflicts ?? true)) {
    let anyOpen = false;
    const currentPairs = new Set<string>();
    for (const other of differing) {
      const autoResolved = winner.precedence < other.precedence;
      if (!autoResolved) anyOpen = true;
      const v1 = displayValue({ valueText: winner.value_text, valueNum: winner.value_num, valueBool: winner.value_bool, unit: winner.unit });
      const v2 = displayValue({ valueText: other.value_text, valueNum: other.value_num, valueBool: other.value_bool, unit: other.unit });
      currentPairs.add(`${winner.sourceKey}|${other.sourceKey}|${v1}|${v2}`);
      const [c] = await sql<{ inserted: boolean }[]>`
        INSERT INTO pmd.product_attribute_conflict
          (product_id, attribute_key, value_1, source_1, value_2, source_2, conflict_status, resolution, resolution_source, resolution_date, detected_run_id)
        VALUES (${productId}, ${key}, ${v1}, ${winner.sourceKey}, ${v2}, ${other.sourceKey},
                ${autoResolved ? "AUTO_RESOLVED" : "OPEN"},
                ${autoResolved ? `Preferred ${winner.sourceKey} (spec precedence ${winner.precedence} beats ${other.precedence})` : null},
                ${autoResolved ? "RULE:SPEC_PRECEDENCE" : null},
                ${autoResolved ? sql`now()` : null}, ${ctx.runId})
        ON CONFLICT (product_id, attribute_key, source_1, source_2, md5(value_1 || chr(31) || value_2)) DO UPDATE SET
          conflict_status = CASE WHEN pmd.product_attribute_conflict.conflict_status IN ('MANUALLY_RESOLVED','IGNORED')
                                 THEN pmd.product_attribute_conflict.conflict_status ELSE EXCLUDED.conflict_status END
        RETURNING (xmax = 0) AS inserted`;
      if (c.inserted && !autoResolved) opened++;
    }

    // Stale OPEN conflicts for this attribute whose values no longer differ are closed, not left dangling.
    const open = await sql<{ conflict_id: number; source_1: string; source_2: string; value_1: string; value_2: string }[]>`
      SELECT conflict_id, source_1, source_2, value_1, value_2 FROM pmd.product_attribute_conflict
      WHERE product_id = ${productId} AND attribute_key = ${key} AND conflict_status = 'OPEN'`;
    for (const o of open) {
      if (!currentPairs.has(`${o.source_1}|${o.source_2}|${o.value_1}|${o.value_2}`)) {
        await sql`
          UPDATE pmd.product_attribute_conflict
             SET conflict_status = 'AUTO_RESOLVED', resolution = 'Values no longer differ', resolution_source = 'RULE:CONVERGED', resolution_date = now()
           WHERE conflict_id = ${o.conflict_id}`;
      }
    }

    // While a conflict between equally authoritative sources is open, do NOT silently flip the value in force.
    if (anyOpen) {
      const current = ranked.find((r) => r.is_preferred);
      if (current) preferredId = current.spec_id;
    }
  } else {
    // Sources agree (or the attribute is not conflict-tracked): close anything left over.
    await sql`
      UPDATE pmd.product_attribute_conflict
         SET conflict_status = 'AUTO_RESOLVED', resolution = 'Sources now agree', resolution_source = 'RULE:CONVERGED', resolution_date = now()
       WHERE product_id = ${productId} AND attribute_key = ${key} AND conflict_status = 'OPEN'`;
  }

  // Exactly one preferred row per attribute. Two statements: the partial unique index is immediate.
  await sql`UPDATE pmd.product_specification SET is_preferred = false WHERE product_id = ${productId} AND attribute_key = ${key} AND is_preferred AND spec_id <> ${preferredId}`;
  await sql`UPDATE pmd.product_specification SET is_preferred = true WHERE spec_id = ${preferredId} AND NOT is_preferred`;

  return { opened, preferred: rows.find((r) => r.spec_id === preferredId) ?? null };
}
