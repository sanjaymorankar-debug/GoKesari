/**
 * One-time categorisation of every product in the catalogue (public.products).
 *
 *   DRY RUN (default, READ ONLY — Postgres itself refuses any write):
 *     DATABASE_URL=<target> npx tsx scripts/categorise-products.ts [--out <dir>]
 *   Options: --fallback <category>  where products with no clear fit go
 *            (default General), e.g. --fallback Supermarket.
 *            --from-json <dir>  build the report from read-only exports
 *            (products.json, categories.json, shop-links.json) instead of a
 *            database connection — same rules, same CSV, same SHA-256.
 *   writes report.csv + report.xlsx (product ID, name, old → proposed category,
 *   counts per category, categories to create/retire, shop links to add) and
 *   prints the report's SHA-256.
 *
 *   APPLY (only after the report is approved):
 *     DATABASE_URL=<target> npx tsx scripts/categorise-products.ts --apply \
 *       --report <dir>/report.csv --approve <sha256> --actor <admin-or-operator email>
 *   applies exactly the rows in the approved CSV (edit proposed_category in the
 *   CSV before approving to override a proposal). Refuses if the file's hash
 *   does not match, or if any product changed category since the dry run.
 *   First copies the affected tables into a new schema backup_categorise_<ts>.
 *
 *   RESTORE (undo an apply):
 *     DATABASE_URL=<target> npx tsx scripts/categorise-products.ts --restore backup_categorise_<ts> --actor <email>
 *
 * The app's .env is deliberately NOT loaded, so the target is always explicit.
 * Rules: src/server/services/product-categorisation.ts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

import {
  GENERAL,
  categoriseProduct,
  cleanCategoryName,
  isShopTypeLabel,
  targetFor,
} from "../src/server/services/product-categorisation";

type Sql = postgres.Sql;
/** A connection or a transaction — the read helpers run inside either. */
type Q = Sql | postgres.TransactionSql;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/** "biscuits (Grocery Kirana)" → "Biscuits": drop the suffix migration 0038 added to de-duplicate names. */
function subcategoryName(oldName: string): string {
  const base = cleanCategoryName(oldName);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/* -------------------------------------------------------------- CSV */

const CSV_COLUMNS = [
  "product_id",
  "product_code",
  "product_name",
  "brand",
  "unit",
  "old_category_id",
  "old_category",
  "old_department",
  "proposed_category",
  "proposed_subcategory",
  "new_category",
  "decision",
  "score",
  "reason",
] as const;
type ReportRow = Record<(typeof CSV_COLUMNS)[number], string>;

function toCsv(rows: ReportRow[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c] ?? "")).join(","))].join("\n") + "\n";
}

function parseCsv(text: string): ReportRow[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n") { record.push(field); records.push(record); record = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [header, ...body] = records;
  if (!header || CSV_COLUMNS.some((c) => !header.includes(c))) fail("The report CSV does not have the expected columns.");
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as ReportRow);
}

/* --------------------------------------------------------- connection */

function connect(): { sql: Sql; label: string } {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set. Name the target database explicitly — this tool never loads .env.");
  const target = new URL(url);
  const sslmode = target.searchParams.get("sslmode");
  const sql = postgres(url, { max: 1, ssl: sslmode && sslmode !== "disable" ? "require" : false, onnotice: () => {} });
  return { sql, label: `${target.host}${target.pathname}` };
}

/* ----------------------------------------------------------- proposals */

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  brand: string | null;
  category_id: string;
  category_name: string;
  category_department: string;
  category_is_system: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  department: string;
  is_system: boolean;
}

async function loadFromDb(sql: Q) {
  const products = await sql<ProductRow[]>`
    SELECT p.id, p.code, p.name, p.description, p.unit, b.name AS brand,
           c.id AS category_id, c.name AS category_name, c.department::text AS category_department,
           c.is_system AS category_is_system
      FROM products p
      JOIN product_categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.deleted_at IS NULL
     ORDER BY p.code`;
  const categories = await sql<CategoryRow[]>`
    SELECT id, name, slug, department::text AS department, is_system FROM product_categories WHERE deleted_at IS NULL`;
  const links = await sql<ShopLinkCount[]>`
    SELECT l.category_id, count(*)::int AS shops FROM shop_product_categories l
      JOIN shops s ON s.id = l.shop_id AND s.deleted_at IS NULL
     GROUP BY l.category_id`;
  return { products: [...products], categories: [...categories], links: [...links] };
}

interface ShopLinkCount {
  category_id: string;
  shops: number;
}

/** The SQL behind each --from-json export, for whoever produces them. */
export const EXPORT_QUERIES = {
  "products.json": `SELECT p.id, p.code, p.name, p.description, p.unit, b.name AS brand, c.id AS category_id, c.name AS category_name,
      c.department::text AS category_department, c.is_system AS category_is_system
    FROM products p JOIN product_categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE p.deleted_at IS NULL ORDER BY p.code`,
  "categories.json": `SELECT id, name, slug, department::text AS department, is_system FROM product_categories WHERE deleted_at IS NULL`,
  "shop-links.json": `SELECT l.category_id, count(*)::int AS shops FROM shop_product_categories l
    JOIN shops s ON s.id = l.shop_id AND s.deleted_at IS NULL GROUP BY l.category_id`,
};

function loadFromJson(dir: string) {
  const read = <T>(file: string): T[] => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  return {
    products: read<ProductRow>("products.json").sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    categories: read<CategoryRow>("categories.json"),
    links: read<ShopLinkCount>("shop-links.json").map((l) => ({ ...l, shops: Number(l.shops) })),
  };
}

function proposeRows(products: ProductRow[], categories: CategoryRow[], fallback: string | undefined): ReportRow[] {
  const liveByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  return products.map((p) => {
    const result = categoriseProduct({
      name: p.name,
      description: p.description,
      brand: p.brand,
      unit: p.unit,
      oldCategoryName: p.category_is_system ? null : p.category_name,
      oldDepartment: p.category_department,
    });
    const usesFallback = !result.confident && Boolean(fallback);
    const proposed = usesFallback ? fallback! : result.category;
    const keepsDetail =
      result.confident &&
      !p.category_is_system &&
      !isShopTypeLabel(cleanCategoryName(p.category_name)) &&
      cleanCategoryName(p.category_name).toLowerCase() !== proposed.toLowerCase() &&
      proposed !== GENERAL;
    return {
      product_id: p.id,
      product_code: p.code,
      product_name: p.name,
      brand: p.brand ?? "",
      unit: p.unit,
      old_category_id: p.category_id,
      old_category: p.category_name,
      old_department: p.category_department,
      proposed_category: proposed,
      proposed_subcategory: keepsDetail ? subcategoryName(p.category_name) : "",
      new_category: liveByName.has(proposed.toLowerCase()) ? "no" : "yes",
      decision: result.confident ? "matched" : usesFallback ? `fallback: ${fallback} (no clear fit)` : "general (no clear fit)",
      score: String(result.score),
      reason: result.reason,
    };
  });
}

/** What the apply step will do beyond moving products, for the report. */
function planSideEffects(rows: ReportRow[], categories: CategoryRow[], links: ShopLinkCount[]) {
  const proposedNames = new Set(rows.map((r) => r.proposed_category.toLowerCase()));
  const stillUsed = new Set<string>();
  const movedAway = new Map<string, Set<string>>(); // old category id → proposed names
  for (const r of rows) {
    if (r.old_category.toLowerCase() === r.proposed_category.toLowerCase()) stillUsed.add(r.old_category_id);
    else movedAway.set(r.old_category_id, (movedAway.get(r.old_category_id) ?? new Set()).add(r.proposed_category));
  }
  const retire = categories.filter(
    (c) => !c.is_system && movedAway.has(c.id) && !stillUsed.has(c.id) && !proposedNames.has(c.name.toLowerCase()),
  );
  const shopsByCategory = new Map(links.map((l) => [l.category_id, l.shops]));
  const linkPlan = [...movedAway.entries()]
    .filter(([id]) => shopsByCategory.get(id))
    .map(([id, targets]) => ({
      from: categories.find((c) => c.id === id)?.name ?? id,
      shops: shopsByCategory.get(id) ?? 0,
      addCategories: [...targets].sort().join(", "),
    }));
  return { retire, linkPlan };
}

async function dryRun() {
  const fallback = arg("--fallback")?.trim() || undefined;
  if (fallback !== undefined && (fallback.length < 2 || fallback.length > 80)) fail("--fallback needs a category name of 2–80 characters.");
  const fromJson = arg("--from-json");
  const conn = fromJson ? null : connect();
  const label = fromJson ? `exports in ${fromJson}` : conn!.label;
  const outDir = arg("--out") ?? path.join("categorisation-reports", new Date().toISOString().replace(/[:.]/g, "-"));
  try {
    const data = fromJson ? loadFromJson(fromJson) : await conn!.sql.begin("read only", (tx) => loadFromDb(tx));
    const rows = proposeRows(data.products, data.categories, fallback);
    const { linkPlan, retire } = planSideEffects(rows, data.categories, data.links);

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.proposed_category, (counts.get(r.proposed_category) ?? 0) + 1);
    const toCreate = [...new Set(rows.filter((r) => r.new_category === "yes").map((r) => r.proposed_category))].sort();

    mkdirSync(outDir, { recursive: true });
    const csv = toCsv(rows);
    const csvPath = path.join(outDir, "report.csv");
    writeFileSync(csvPath, csv);
    const hash = createHash("sha256").update(csv).digest("hex");

    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet("Summary");
    summary.addRows([
      ["Target database", label],
      ["Generated", new Date().toISOString()],
      ["Products", rows.length],
      ["Products changing category", rows.filter((r) => r.old_category.toLowerCase() !== r.proposed_category.toLowerCase()).length],
      ["Products going to General", counts.get(GENERAL) ?? 0],
      ...(fallback ? [[`Products with no clear fit → ${fallback}`, rows.filter((r) => r.decision.startsWith("fallback")).length]] : []),
      ["Report SHA-256 (approve with this)", hash],
      [],
      ["Proposed category", "Products", "New category?"],
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => [name, n, toCreate.includes(name) ? "yes" : "no"]),
      [],
      ["Categories that will be retired (empty after the move)"],
      ...retire.map((c) => [c.name]),
    ]);
    summary.getColumn(1).width = 44;
    summary.getColumn(2).width = 18;
    const sheet = wb.addWorksheet("Products");
    sheet.columns = CSV_COLUMNS.map((c) => ({ header: c, key: c, width: c === "reason" ? 60 : c.includes("name") || c.includes("category") ? 28 : 14 }));
    sheet.addRows(rows);
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + CSV_COLUMNS.length)}1` };
    const linkSheet = wb.addWorksheet("Shop links");
    linkSheet.columns = [
      { header: "Shops carrying old category", key: "from", width: 34 },
      { header: "Shops", key: "shops", width: 8 },
      { header: "Will also carry (so nothing they saw disappears)", key: "addCategories", width: 70 },
    ];
    linkSheet.addRows(linkPlan);
    await wb.xlsx.writeFile(path.join(outDir, "report.xlsx"));

    console.log(`target    ${label}  (read-only — nothing was changed)`);
    console.log(`products  ${rows.length}`);
    console.table([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, products]) => ({ category, products, new: toCreate.includes(category) ? "yes" : "" })));
    if (retire.length) console.log(`retire    ${retire.map((c) => c.name).join(", ")}`);
    console.log(`report    ${csvPath}  and  report.xlsx`);
    console.log(`sha256    ${hash}`);
    console.log(`\nTo apply exactly this report after approval:\n  DATABASE_URL=<target> npx tsx scripts/categorise-products.ts --apply --report ${csvPath} --approve ${hash} --actor <email>`);
  } finally {
    await conn?.sql.end();
  }
}

/* --------------------------------------------------------------- apply */

async function resolveActor(sql: Q, email: string | undefined) {
  if (!email) fail("--actor <email> is required (an ADMIN or OPERATOR, recorded in the audit log).");
  const [user] = await sql<{ id: string; role: string }[]>`SELECT id, role::text FROM users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL`;
  if (!user) fail(`No user with email ${email}.`);
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") fail(`${email} is ${user.role}; only an ADMIN or OPERATOR may run this.`);
  return user;
}

async function apply() {
  const reportPath = arg("--report");
  const approved = arg("--approve");
  if (!reportPath || !approved) fail("--apply needs --report <report.csv> and --approve <sha256 printed by the dry run>.");
  const csv = readFileSync(reportPath, "utf8");
  const hash = createHash("sha256").update(csv).digest("hex");
  if (hash !== approved.toLowerCase()) fail(`The report's SHA-256 is ${hash}, not the approved ${approved}. Re-run the dry run and approve the new report.`);
  const rows = parseCsv(csv);
  for (const r of rows) {
    if (!r.proposed_category.trim()) fail(`Row for ${r.product_code} has no proposed_category.`);
  }

  const { sql, label } = connect();
  try {
    const actor = await resolveActor(sql, arg("--actor"));

    // 1. Nothing may have moved since the dry run.
    const current = await sql<{ id: string; category_id: string }[]>`
      SELECT id, category_id FROM products WHERE id = ANY(${sql.array(rows.map((r) => r.product_id))}::uuid[])`;
    const now = new Map(current.map((c) => [c.id, c.category_id]));
    const changed = rows.filter((r) => now.get(r.product_id) !== r.old_category_id);
    if (changed.length) {
      fail(`${changed.length} product(s) changed or disappeared since the dry run (e.g. ${changed.slice(0, 5).map((r) => r.product_code).join(", ")}). Re-run the dry run.`);
    }
    const [{ n: uncovered }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM products WHERE deleted_at IS NULL AND NOT (id = ANY(${sql.array(rows.map((r) => r.product_id))}::uuid[]))`;
    if (uncovered) fail(`${uncovered} product(s) were added since the dry run. Re-run the dry run so every product is covered.`);

    // 2. Backup, committed on its own so it survives a failed apply.
    const schema = `backup_categorise_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
    await sql.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`CREATE TABLE ${schema}.products AS SELECT id, category_id, subcategory_id FROM public.products`);
      await tx.unsafe(`CREATE TABLE ${schema}.product_categories AS SELECT * FROM public.product_categories`);
      await tx.unsafe(`CREATE TABLE ${schema}.product_subcategories AS SELECT * FROM public.product_subcategories`);
      await tx.unsafe(`CREATE TABLE ${schema}.shop_product_categories AS SELECT * FROM public.shop_product_categories`);
      await tx.unsafe(`CREATE TABLE ${schema}.meta (report_sha256 text, actor_id uuid, created_at timestamptz DEFAULT now())`);
      await tx.unsafe(`INSERT INTO ${schema}.meta (report_sha256, actor_id) VALUES ($1, $2)`, [hash, actor.id]);
    });
    console.log(`backup    ${schema}`);

    // 3. Apply in one transaction.
    const summary = await sql.begin(async (tx) => {
      const live = await tx<CategoryRow[]>`SELECT id, name, slug, department::text AS department, is_system FROM product_categories WHERE deleted_at IS NULL`;
      const byName = new Map(live.map((c) => [c.name.toLowerCase(), c]));
      const general = live.find((c) => c.is_system);
      if (!general) fail("The General category is missing — apply migration 0038 first.");

      const created: string[] = [];
      for (const name of [...new Set(rows.map((r) => r.proposed_category.trim()))]) {
        if (byName.has(name.toLowerCase())) continue;
        const target = targetFor(name);
        const base = slugify(name);
        const [taken] = await tx`SELECT 1 FROM product_categories WHERE slug = ${base}`;
        const [row] = await tx<CategoryRow[]>`
          INSERT INTO product_categories (department, name, slug, description, created_by)
          VALUES (${target?.department ?? "GENERAL_TRADING"}::department, ${name}, ${taken ? `${base}-${Date.now().toString(36)}` : base},
                  ${target?.description ?? null}, ${actor.id})
          RETURNING id, name, slug, department::text AS department, is_system`;
        byName.set(name.toLowerCase(), row);
        created.push(name);
      }

      // Subcategories keep the detail of the old fine-grained categories (Dairy → Milk).
      const subIds = new Map<string, string>();
      for (const r of rows) {
        if (!r.proposed_subcategory.trim()) continue;
        const cat = byName.get(r.proposed_category.trim().toLowerCase())!;
        const key = `${cat.id}:${r.proposed_subcategory.trim().toLowerCase()}`;
        if (subIds.has(key)) continue;
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM product_subcategories WHERE category_id = ${cat.id} AND lower(name) = lower(${r.proposed_subcategory.trim()}) AND deleted_at IS NULL`;
        if (existing) { subIds.set(key, existing.id); continue; }
        const slug = `${cat.slug}-${slugify(r.proposed_subcategory)}`;
        const [taken] = await tx`SELECT 1 FROM product_subcategories WHERE slug = ${slug}`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO product_subcategories (category_id, name, slug)
          VALUES (${cat.id}, ${r.proposed_subcategory.trim()}, ${taken ? `${slug}-${Date.now().toString(36)}` : slug}) RETURNING id`;
        subIds.set(key, row.id);
      }

      const moves = rows
        .map((r) => {
          const cat = byName.get(r.proposed_category.trim().toLowerCase())!;
          const sub = r.proposed_subcategory.trim() ? subIds.get(`${cat.id}:${r.proposed_subcategory.trim().toLowerCase()}`)! : null;
          return { id: r.product_id, from: r.old_category_id, to: cat.id, toName: cat.name, sub };
        })
        .filter((m) => m.from !== m.to);
      for (let i = 0; i < moves.length; i += 500) {
        const batch = moves.slice(i, i + 500);
        await tx`
          UPDATE products p SET category_id = v.cat, subcategory_id = v.sub
            FROM unnest(${tx.array(batch.map((m) => m.id))}::uuid[], ${tx.array(batch.map((m) => m.to))}::uuid[],
                        ${tx.array(batch.map((m) => m.sub ?? ""))}::text[]) AS v0(id, cat, sub_text)
            CROSS JOIN LATERAL (SELECT v0.id, v0.cat, NULLIF(v0.sub_text, '')::uuid AS sub) v
           WHERE p.id = v.id`;
      }

      // Shops keep seeing everything they saw: a shop that carried an old
      // category now carries every category its products moved to, and a shop
      // carries the new category of everything it lists.
      const linked = await tx.unsafe(`
        INSERT INTO shop_product_categories (shop_id, category_id, added_by)
        SELECT DISTINCT l.shop_id, p.category_id, $1::uuid
          FROM ${schema}.products b
          JOIN products p ON p.id = b.id AND p.category_id <> b.category_id
          JOIN ${schema}.shop_product_categories l ON l.category_id = b.category_id
        UNION
        SELECT DISTINCT sp.shop_id, p.category_id, $1::uuid
          FROM shop_products sp JOIN products p ON p.id = sp.product_id
         WHERE sp.deleted_at IS NULL
        ON CONFLICT (shop_id, category_id) DO NOTHING
        RETURNING shop_id`, [actor.id]);

      // Retire old categories left empty (never General, never a target in use).
      const keep = new Set(rows.map((r) => r.proposed_category.trim().toLowerCase()));
      const candidates = [...new Set(moves.map((m) => m.from))];
      const retired = candidates.length
        ? await tx<{ id: string; name: string }[]>`
            UPDATE product_categories c SET deleted_at = now(), is_active = false, updated_at = now()
             WHERE c.id = ANY(${tx.array(candidates)}::uuid[]) AND NOT c.is_system AND c.deleted_at IS NULL
               AND NOT (lower(c.name) = ANY(${tx.array([...keep])}::text[]))
               AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL)
            RETURNING c.id, c.name`
        : [];
      if (retired.length) {
        const ids = tx.array(retired.map((r) => r.id));
        await tx`DELETE FROM shop_product_categories WHERE category_id = ANY(${ids}::uuid[])`;
        await tx`UPDATE product_subcategories SET is_active = false, deleted_at = now()
                  WHERE category_id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`;
      }

      // Acceptance check: every live product has a live category.
      const [{ n: orphans }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM products p JOIN product_categories c ON c.id = p.category_id
         WHERE p.deleted_at IS NULL AND c.deleted_at IS NOT NULL`;
      if (orphans) throw new Error(`${orphans} product(s) would be left in a removed category — nothing was applied.`);

      // Audit: one row per moved product, per created and per retired category, plus a summary.
      const audit = [
        ...moves.map((m) => ({ action: "product.category_changed", entity_type: "product", entity_id: m.id,
          previous_value: { categoryId: m.from }, new_value: { categoryId: m.to, categoryName: m.toName, source: "categorisation", report: hash } })),
        ...created.map((name) => ({ action: "product_category.created", entity_type: "product_category", entity_id: byName.get(name.toLowerCase())!.id,
          previous_value: null, new_value: { name, source: "categorisation" } })),
        ...retired.map((r) => ({ action: "product_category.removed", entity_type: "product_category", entity_id: r.id,
          previous_value: { name: r.name }, new_value: { source: "categorisation", report: hash } })),
        { action: "product.categorisation_applied", entity_type: "product", entity_id: null, previous_value: null,
          new_value: { report: hash, backup: schema, moved: moves.length, created, retired: retired.map((r) => r.name), shopLinksAdded: linked.length } },
      ];
      for (let i = 0; i < audit.length; i += 500) {
        const batch = audit.slice(i, i + 500).map((a) => ({
          ...a,
          actor_id: actor.id,
          actor_role: actor.role,
          previous_value: a.previous_value ? tx.json(a.previous_value) : null,
          new_value: tx.json(a.new_value),
        }));
        await tx`INSERT INTO audit_logs ${tx(batch, "actor_id", "actor_role", "action", "entity_type", "entity_id", "previous_value", "new_value")}`;
      }
      return { moved: moves.length, created, retired: retired.map((r) => r.name), linked: linked.length };
    });

    const [{ n: total }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM products WHERE deleted_at IS NULL`;
    console.log(`target    ${label}`);
    console.log(`moved     ${summary.moved} of ${total} products`);
    console.log(`created   ${summary.created.join(", ") || "(none)"}`);
    console.log(`retired   ${summary.retired.join(", ") || "(none)"}`);
    console.log(`links     ${summary.linked} shop ↔ category links added`);
    console.log(`\nUndo with: DATABASE_URL=<target> npx tsx scripts/categorise-products.ts --restore ${schema} --actor <email>`);
  } finally {
    await sql.end();
  }
}

/* ------------------------------------------------------------- restore */

async function restore() {
  const schema = arg("--restore");
  if (!schema || !/^backup_categorise_\d{14}$/.test(schema)) fail("--restore needs a backup schema name like backup_categorise_20261003120000.");
  const { sql, label } = connect();
  try {
    const actor = await resolveActor(sql, arg("--actor"));
    await sql.begin(async (tx) => {
      await tx.unsafe(`UPDATE products p SET category_id = b.category_id, subcategory_id = b.subcategory_id
                         FROM ${schema}.products b WHERE b.id = p.id`);
      await tx`DELETE FROM shop_product_categories`;
      await tx.unsafe(`INSERT INTO shop_product_categories SELECT * FROM ${schema}.shop_product_categories
                         WHERE shop_id IN (SELECT id FROM shops) ON CONFLICT DO NOTHING`);
      // Rows the apply created go first, so restored names cannot clash with them.
      await tx.unsafe(`DELETE FROM product_subcategories s WHERE NOT EXISTS (SELECT 1 FROM ${schema}.product_subcategories b WHERE b.id = s.id)`);
      await tx.unsafe(`DELETE FROM product_categories c WHERE NOT c.is_system
                         AND NOT EXISTS (SELECT 1 FROM ${schema}.product_categories b WHERE b.id = c.id)`);
      await tx.unsafe(`UPDATE product_subcategories s SET deleted_at = b.deleted_at, is_active = b.is_active
                         FROM ${schema}.product_subcategories b WHERE b.id = s.id`);
      await tx.unsafe(`UPDATE product_categories c SET name = b.name, deleted_at = b.deleted_at, is_active = b.is_active,
                              department = b.department, description = b.description
                         FROM ${schema}.product_categories b WHERE b.id = c.id AND NOT c.is_system`);
      await tx`INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, new_value)
               VALUES (${actor.id}, ${actor.role}::user_role, 'product.categorisation_restored', 'product', ${tx.json({ backup: schema })})`;
    });
    console.log(`target    ${label}\nrestored  products, categories, subcategories and shop links from ${schema}`);
    console.log(`The backup schema is kept; drop it when you no longer need it: DROP SCHEMA ${schema} CASCADE;`);
  } finally {
    await sql.end();
  }
}

/* ---------------------------------------------------------------- main */

const run = process.argv.includes("--apply") ? apply : process.argv.includes("--restore") ? restore : dryRun;
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
