/**
 * Runs the Puja Samagri catalogue seed (drizzle/0155_puja_samagri_catalogue.sql) again on a
 * database — for the CLI (scripts/puja/seed-catalogue.ts) and the tests. Idempotent: every
 * insert in the file skips what already exists, so a re-run adds nothing and changes nothing.
 * Not used by the website itself (the migration seeds production and staging). Takes an
 * executor so the CLI can run it without the app's environment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const PUJA_SEED_FILE = "drizzle/0155_puja_samagri_catalogue.sql";

export type SqlExec = (text: string) => Promise<readonly Record<string, unknown>[]>;

export interface PujaCounts {
  shopType: number;
  categories: number;
  types: number;
  products: number;
  localNames: number;
  attrs: number;
  missingLocalNames: number;
  loosePriced: number;
  duplicateNames: number;
}

const COUNTS_SQL = `
  SELECT
    (SELECT count(*)::int FROM shop_types WHERE key = 'PUJA_SAMAGRI') AS shop_type,
    (SELECT count(*)::int FROM product_categories WHERE department = 'PUJA_SAMAGRI') AS categories,
    (SELECT count(*)::int FROM product_subcategories s JOIN product_categories c ON c.id = s.category_id
      WHERE c.department = 'PUJA_SAMAGRI' AND s.slug LIKE 'puja-type-%') AS types,
    (SELECT count(*)::int FROM products WHERE slug LIKE 'puja-%' AND created_by IS NULL) AS products,
    (SELECT count(*)::int FROM product_local_names l JOIN products p ON p.id = l.product_id WHERE p.slug LIKE 'puja-%' AND p.created_by IS NULL) AS local_names,
    (SELECT count(*)::int FROM product_catalogue_attrs a JOIN products p ON p.id = a.product_id WHERE a.catalogue = 'PUJA_SAMAGRI' AND p.created_by IS NULL) AS attrs,
    (SELECT count(*)::int FROM products p LEFT JOIN product_local_names l ON l.product_id = p.id
      WHERE p.slug LIKE 'puja-%' AND p.created_by IS NULL AND (coalesce(l.name_hi, '') = '' OR coalesce(l.name_mr, '') = '')) AS missing_local_names,
    (SELECT count(*)::int FROM products p WHERE p.slug LIKE 'puja-%' AND p.kind = 'LOOSE' AND p.mrp_paise IS NOT NULL) AS loose_priced,
    (SELECT count(*)::int FROM (SELECT lower(p.name) FROM products p JOIN product_categories c ON c.id = p.category_id
      WHERE c.department = 'PUJA_SAMAGRI' AND p.deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1) d) AS duplicate_names`;

export async function pujaCounts(exec: SqlExec): Promise<PujaCounts> {
  const [row] = await exec(COUNTS_SQL);
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    shopType: n("shop_type"),
    categories: n("categories"),
    types: n("types"),
    products: n("products"),
    localNames: n("local_names"),
    attrs: n("attrs"),
    missingLocalNames: n("missing_local_names"),
    loosePriced: n("loose_priced"),
    duplicateNames: n("duplicate_names"),
  };
}

export async function runPujaSeed(exec: SqlExec, root = process.cwd()): Promise<PujaCounts> {
  const text = readFileSync(path.join(root, PUJA_SEED_FILE), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.replace(/--[^\n]*\n/g, "").trim()) await exec(statement);
  }
  return pujaCounts(exec);
}
