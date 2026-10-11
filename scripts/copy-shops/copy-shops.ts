/**
 * Copies chosen shops from the test database (test.gokesari.com) to the
 * production database (gokesari.com) — the owner's request of 11 Oct 2026:
 * copy the real shops registered on test, never its E2E / QA test shops.
 *
 * Run by the "Copy shops to production" workflow (.github/workflows/copy-shops.yml).
 * Setup and use: docs/copy-shops-2026-10/README.md. Two steps, so each
 * database's secret is needed in one job only:
 *
 *   MODE=export SOURCE_DATABASE_URL=<test> SHOPS=BKS-000001,BKS-000004 \
 *     [SOURCE_SITE=https://test.gokesari.com] BUNDLE_FILE=shops.json npx tsx scripts/copy-shops/copy-shops.ts
 *   MODE=plan|copy TARGET_DATABASE_URL=<production> BUNDLE_FILE=shops.json \
 *     [REPORT_FILE=report.md] npx tsx scripts/copy-shops/copy-shops.ts
 *
 * export only reads test: the shops and every row they need, photo bytes
 * included (bytes kept on test's disk are fetched from the test site and
 * checked against their stored checksum).
 *
 * What a shop brings with it:
 *   - its owner's account (matched to an existing production account by
 *     e-mail or phone, else created with the same id) and the SHOP_OWNER role;
 *   - the shop row, with a NEW registration number from production's own
 *     sequence (test's numbers would collide with production's later ones);
 *   - its shop categories, its catalogue products (matched to production's
 *     catalogue by id, barcode or exact name/size, else added with a new
 *     production product code), its listings with prices and stock, its
 *     product-category choices and its photos (bytes included).
 *
 * What it never brings: orders, payments, wallet balances or ledger rows,
 * invoices, sessions, test-only referral codes and registrations, admin or
 * operator roles, and anything encrypted with the test site's keys: the PAN
 * number (its last four digits come across) and the legal documents — their
 * files cannot be read with production's key, so production asks each owner
 * to upload them, with the usual grace period, the first time the shop's
 * documents are opened.
 *
 * plan does the whole copy inside one production transaction and then rolls
 * it back: every constraint is checked and the report is exact, but nothing is
 * saved (sequence numbers are read, not taken). copy commits the same work in
 * one transaction — all shops or none. A shop already on production (same id,
 * or the same name in the same PIN code) is skipped, so a second run copies
 * nothing twice.
 *
 * Prints only names, counts and ids — never a database URL.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

type Row = Record<string, unknown>;
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Everything export reads from test, by table. */
interface Bundle {
  exportedAt: string;
  source: string;
  shops: string[];
  /** Each table's column names on test, to compare with production's. */
  columns: Record<string, string>;
  rows: Record<string, Row[]>;
  /** Stored images whose bytes could not be had (kept on disk and not served). */
  missingImages: string[];
}

/** Tables export reads and copy writes; their columns must be the same on both sides. */
const TABLES = [
  "users",
  "user_consents",
  "shops",
  "shop_categories",
  "shop_category_mapping",
  "product_categories",
  "product_subcategories",
  "brands",
  "products",
  "shop_products",
  "shop_product_categories",
  "product_images",
  "stored_images",
  "stored_image_variants",
] as const;
/** Written but not exported. */
const TARGET_ONLY_TABLES = ["user_role_grants", "audit_logs"] as const;

/* ------------------------------------------------------------------ input */

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const MODE = process.env.MODE ?? "";
if (!["export", "plan", "copy"].includes(MODE)) fail(`MODE must be export, plan or copy, not "${MODE}".`);
const BUNDLE_FILE = process.env.BUNDLE_FILE || fail("BUNDLE_FILE is not set.");

const hostOf = (url: string) => {
  const u = new URL(url);
  return `${u.hostname}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
};

function connect(url: string): Sql {
  const sslmode = new URL(url).searchParams.get("sslmode");
  return postgres(url, { max: 1, prepare: false, ssl: !sslmode || sslmode === "disable" ? false : "require", onnotice: () => {} });
}

async function columnsOf(sql: Sql | Tx, table: string): Promise<string> {
  const rows = await sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table} order by column_name`;
  return rows.map((r) => r.column_name as string).join(",");
}

const IMAGE_URL = /\/api\/images\/([0-9a-f-]{36})/gi;
function imageIdsIn(...values: unknown[]): string[] {
  const ids: string[] = [];
  for (const v of values) {
    const text = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    for (const m of text.matchAll(IMAGE_URL)) ids.push(m[1].toLowerCase());
  }
  return ids;
}

/* ================================================================= export */

async function exportShops(): Promise<void> {
  const url = process.env.SOURCE_DATABASE_URL || fail("SOURCE_DATABASE_URL (the test database) is not set.");
  const site = (process.env.SOURCE_SITE ?? "https://test.gokesari.com").replace(/\/+$/, "");
  const numbers = (process.env.SHOPS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (numbers.length === 0) fail("SHOPS is empty: give the registration numbers to copy, e.g. BKS-000001,BKS-000004.");
  for (const s of numbers) if (!/^BKS-\d{6}$/.test(s)) fail(`"${s}" is not a registration number (BKS-000123).`);

  const src = connect(url);
  /** Rows as plain JSON (bytea as "\x…" hex), so they insert unchanged on the other side. */
  const read = async (table: string, where: string, params: unknown[]): Promise<Row[]> =>
    (await src.unsafe(`select row_to_json(t) as r from "${table}" t where ${where}`, params as never[])).map((x) => x.r as Row);
  const ids = (rows: Row[], key: string) => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === "string"))];

  const shops = await read("shops", "registration_number = any($1) and deleted_at is null", [numbers]);
  const missing = numbers.filter((n) => !shops.some((s) => s.registration_number === n));
  if (missing.length) fail(`Not found on test (or deleted): ${missing.join(", ")}.`);
  const shopIds = ids(shops, "id");

  const users = await read("users", "id = any($1)", [ids(shops, "owner_id")]);
  const consents = await read("user_consents", "user_id = any($1)", [ids(users, "id")]);
  const mapping = await read("shop_category_mapping", "shop_id = any($1)", [shopIds]);
  const shopCategories = await read("shop_categories", "id = any($1)", [ids(mapping, "category_id")]);
  const listings = await read("shop_products", "shop_id = any($1) and deleted_at is null", [shopIds]);
  const products = await read("products", "id = any($1)", [ids(listings, "product_id")]);
  const chosen = await read("shop_product_categories", "shop_id = any($1)", [shopIds]);
  const subcategories = await read("product_subcategories", "id = any($1)", [ids(products, "subcategory_id")]);
  const categoryIds = [...new Set([...ids(products, "category_id"), ...ids(chosen, "category_id"), ...ids(subcategories, "category_id")])];
  const categories = await read("product_categories", "id = any($1)", [categoryIds]);
  const brands = await read("brands", "id = any($1)", [ids(products, "brand_id")]);
  const images = await read(
    "product_images",
    "(product_id = any($1) and shop_product_id is null) or shop_product_id = any($2)",
    [ids(products, "id"), ids(listings, "id")],
  );

  const imageIds = [
    ...new Set([
      ...ids(images, "stored_image_id"),
      ...imageIdsIn(
        ...shops.flatMap((s) => [s.logo_url, s.photos]),
        ...products.map((p) => p.image_url),
        ...listings.map((l) => l.image_url),
        ...images.map((i) => i.url),
      ),
    ]),
  ];
  const stored = await read("stored_images", "id = any($1)", [imageIds]);
  const variants = await read("stored_image_variants", "stored_image_id = any($1)", [imageIds]);

  // Bytes kept on test's disk come from the test site — the very bytes it serves.
  const download = async (path: string): Promise<Buffer | null> => {
    try {
      const res = await fetch(`${site}${path}`, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" },
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  const missingImages: string[] = [];
  const storedOut: Row[] = [];
  for (const img of stored) {
    if (img.storage === "DB") {
      storedOut.push(img);
      continue;
    }
    const buf = await download(`/api/images/${img.id}`);
    if (!buf || createHash("sha256").update(buf).digest("hex") !== img.sha256) {
      missingImages.push(String(img.id));
      continue;
    }
    storedOut.push({ ...img, storage: "DB", storage_key: null, data: `\\x${buf.toString("hex")}` });
  }
  const variantsOut: Row[] = [];
  for (const v of variants) {
    if (!storedOut.some((s) => s.id === v.stored_image_id)) continue;
    if (v.storage === "DB") {
      variantsOut.push(v);
      continue;
    }
    const buf = await download(`/api/images/${v.stored_image_id}?size=${String(v.variant).toLowerCase()}`);
    if (buf) variantsOut.push({ ...v, storage: "DB", storage_key: null, data: `\\x${buf.toString("hex")}` });
  }

  const columns: Record<string, string> = {};
  for (const t of TABLES) columns[t] = await columnsOf(src, t);
  const bundle: Bundle = {
    exportedAt: new Date().toISOString(),
    source: hostOf(url),
    shops: numbers,
    columns,
    rows: {
      users,
      user_consents: consents,
      shops,
      shop_categories: shopCategories,
      shop_category_mapping: mapping,
      product_categories: categories,
      product_subcategories: subcategories,
      brands,
      products,
      shop_products: listings,
      shop_product_categories: chosen,
      product_images: images,
      stored_images: storedOut,
      stored_image_variants: variantsOut,
    },
    missingImages,
  };
  writeFileSync(BUNDLE_FILE, JSON.stringify(bundle));
  await src.end();

  const line = (s: string) => console.log(s);
  line(`## Exported from test (${hostOf(url)})`);
  line("");
  line("| Shop | Test number | Status | PIN | Listings |");
  line("|---|---|---|---|---|");
  for (const s of [...shops].sort((a, b) => String(a.registration_number).localeCompare(String(b.registration_number)))) {
    line(`| ${s.name} | ${s.registration_number} | ${s.status} | ${s.pincode} | ${listings.filter((l) => l.shop_id === s.id).length} |`);
  }
  line("");
  line(`${users.length} owner(s), ${products.length} catalogue product(s), ${storedOut.length} photo(s)${missingImages.length ? `, ${missingImages.length} photo(s) not available` : ""}.`);
}

/* ============================================================ plan / copy */

const report: string[] = [];
const say = (line = "") => {
  report.push(line);
  console.log(line);
};
const tally = {
  shops: 0,
  skippedShops: 0,
  newOwners: 0,
  existingOwners: 0,
  listings: 0,
  newProducts: 0,
  matchedProducts: 0,
  images: 0,
  missingImages: 0,
  categories: 0,
};

async function insert(tx: Tx, table: string, values: Row[]): Promise<void> {
  if (values.length === 0) return;
  // $1 is sent as text: postgres.js would JSON-encode a string bound straight to json.
  await tx.unsafe(`insert into "${table}" select * from json_populate_recordset(null::"${table}", $1::text::json)`, [
    JSON.stringify(values),
  ]);
}

async function one(tx: Tx, query: string, params: unknown[]): Promise<Row | undefined> {
  const [row] = await tx.unsafe(query, params as never[]);
  return row as Row | undefined;
}

const suffix = () => randomBytes(3).toString("hex");

/** The next values of a sequence: taken in copy mode, only predicted in plan mode (a sequence never rolls back). */
function sequence(tx: Tx, name: string, format: (n: number) => string) {
  let predicted: number | null = null;
  return async (): Promise<string> => {
    if (MODE === "copy") {
      const row = await one(tx, `select nextval('${name}')::bigint as n`, []);
      return format(Number(row!.n));
    }
    if (predicted === null) {
      const row = await one(tx, `select last_value::bigint as v, is_called from ${name}`, []);
      predicted = Number(row!.v) + (row!.is_called ? 1 : 0);
    } else predicted += 1;
    return format(predicted);
  };
}

async function importShops(): Promise<void> {
  const url = process.env.TARGET_DATABASE_URL || fail("TARGET_DATABASE_URL (the production database) is not set.");
  const bundle = JSON.parse(readFileSync(BUNDLE_FILE, "utf8")) as Bundle;
  if (bundle.source === hostOf(url)) fail("The bundle came from the target database itself. Stopped.");
  const dst = connect(url);

  say(`## Copy shops to production — ${MODE === "plan" ? "PLAN (nothing saved)" : "COPY"}`);
  say();
  say(`From test (${bundle.source}, exported ${bundle.exportedAt}) → ${hostOf(url)} · shops ${bundle.shops.join(", ")}`);

  // Same columns on both sides, or the rows would not fit.
  for (const table of TABLES) {
    const target = await columnsOf(dst, table);
    if (!target) fail(`Table ${table} is missing on the target.`);
    if (target !== bundle.columns[table]) fail(`Table ${table} has different columns on test and production — migrate both to the same release first.`);
  }
  for (const table of TARGET_ONLY_TABLES) if (!(await columnsOf(dst, table))) fail(`Table ${table} is missing on the target.`);

  const DRY_RUN = new Error("dry run: rolled back");
  try {
    await dst.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      await tx`set local statement_timeout = '120s'`;
      await copyShops(bundle, tx);
      if (MODE === "plan") throw DRY_RUN;
    });
  } catch (error) {
    if (error !== DRY_RUN) throw error;
  }
  await dst.end();

  say();
  say("### Totals");
  say();
  say("| | |");
  say("|---|---|");
  say(`| Shops copied | ${tally.shops} |`);
  say(`| Shops skipped (already on production) | ${tally.skippedShops} |`);
  say(`| Owner accounts created / matched to existing | ${tally.newOwners} / ${tally.existingOwners} |`);
  say(`| Listings (products with price and stock) | ${tally.listings} |`);
  say(`| Catalogue products added / matched to existing | ${tally.newProducts} / ${tally.matchedProducts} |`);
  say(`| Categories added | ${tally.categories} |`);
  say(`| Photos copied / not available | ${tally.images} / ${tally.missingImages} |`);
  say();
  say(
    MODE === "plan"
      ? "**PLAN only — production was not changed.** Run again with mode = copy to save it."
      : "**Saved to production** in one transaction.",
  );
  if (process.env.REPORT_FILE) writeFileSync(process.env.REPORT_FILE, report.join("\n") + "\n");
}

async function copyShops(bundle: Bundle, tx: Tx): Promise<void> {
  const table = (name: string) => bundle.rows[name] ?? [];
  const byId = (name: string, id: unknown) => table(name).find((r) => r.id === id);
  const nextRegistration = sequence(tx, "shop_registration_seq", (n) => `BKS-${String(n).padStart(6, "0")}`);
  const nextProductCode = sequence(tx, "product_code_seq", (n) => `P${String(n).padStart(5, "0")}`);
  const now = new Date().toISOString();

  /* ---- maps from test ids to production ids, filled as we go ---- */
  const userMap = new Map<string, string>();
  const productCategoryMap = new Map<string, string>();
  const subcategoryMap = new Map<string, string>();
  const brandMap = new Map<string, string>();
  const productMap = new Map<string, { id: string; added: boolean }>();
  const imageDone = new Map<string, boolean>(); // stored image id → present on production

  async function owner(id: string): Promise<string> {
    if (userMap.has(id)) return userMap.get(id)!;
    const u = byId("users", id) ?? fail(`Owner ${id} is missing from the export.`);
    const sameId = await one(tx, "select id, email, role from users where id = $1", [id]);
    if (sameId && String(sameId.email).toLowerCase() !== String(u.email).toLowerCase()) {
      fail(`User id ${id} exists on production with a different e-mail. Stopped.`);
    }
    let found = sameId;
    if (!found && !u.email_placeholder) found = await one(tx, "select id, role from users where lower(email) = lower($1) and deleted_at is null", [u.email]);
    if (!found && u.phone_e164) found = await one(tx, "select id, role from users where phone_e164 = $1 and deleted_at is null", [u.phone_e164]);

    let targetId: string;
    if (found) {
      targetId = String(found.id);
      tally.existingOwners += 1;
      say(`- Owner **${u.name ?? "(no name)"}**: existing production account (role ${found.role}${found.role === "CUSTOMER" ? ", now also shop owner" : ""})`);
    } else {
      targetId = id;
      // A shop owner on production, whatever they were on test (test admins stay test admins).
      await insert(tx, "users", [{ ...u, role: "SHOP_OWNER", deleted_at: null, updated_at: now }]);
      // Terms the owner accepted, as evidence on production too.
      const consents = table("user_consents").filter((c) => c.user_id === id);
      await insert(tx, "user_consents", consents);
      tally.newOwners += 1;
      say(`- Owner **${u.name ?? "(no name)"}**: new production account (${consents.length} consent record(s) kept)`);
    }
    await tx.unsafe(
      `insert into user_role_grants (user_id, role, status, source) values ($1, 'SHOP_OWNER', 'ACTIVE', 'BACKFILL')
       on conflict (user_id, role) do update set status = 'ACTIVE', revoked_by = null, revoked_at = null
       where user_role_grants.status <> 'ACTIVE'`,
      [targetId],
    );
    await tx.unsafe(`update users set role = 'SHOP_OWNER', updated_at = now() where id = $1 and role = 'CUSTOMER'`, [targetId]);
    userMap.set(id, targetId);
    return targetId;
  }

  async function productCategory(id: string): Promise<string> {
    if (productCategoryMap.has(id)) return productCategoryMap.get(id)!;
    const c = byId("product_categories", id) ?? fail(`Product category ${id} is missing from the export.`);
    const found =
      (await one(tx, "select id from product_categories where id = $1", [id])) ??
      (await one(tx, "select id from product_categories where slug = $1", [c.slug])) ??
      (await one(tx, "select id from product_categories where lower(name) = lower($1) and deleted_at is null", [c.name]));
    const target = found ? String(found.id) : id;
    if (!found) {
      await insert(tx, "product_categories", [{ ...c, is_system: false, created_by: null, deleted_at: null }]);
      tally.categories += 1;
      say(`  - product category "${c.name}" added`);
    }
    productCategoryMap.set(id, target);
    return target;
  }

  async function subcategory(id: unknown): Promise<string | null> {
    if (typeof id !== "string") return null;
    if (subcategoryMap.has(id)) return subcategoryMap.get(id)!;
    const s = byId("product_subcategories", id) ?? fail(`Product subcategory ${id} is missing from the export.`);
    const found =
      (await one(tx, "select id from product_subcategories where id = $1", [id])) ??
      (await one(tx, "select id from product_subcategories where slug = $1", [s.slug]));
    const target = found ? String(found.id) : id;
    if (!found) {
      await insert(tx, "product_subcategories", [{ ...s, category_id: await productCategory(String(s.category_id)), deleted_at: null }]);
    }
    subcategoryMap.set(id, target);
    return target;
  }

  async function brand(id: unknown): Promise<string | null> {
    if (typeof id !== "string") return null;
    if (brandMap.has(id)) return brandMap.get(id)!;
    const b = byId("brands", id) ?? fail(`Brand ${id} is missing from the export.`);
    const found =
      (await one(tx, "select id from brands where id = $1", [id])) ??
      (await one(tx, "select id from brands where slug = $1", [b.slug]));
    const target = found ? String(found.id) : id;
    if (!found) await insert(tx, "brands", [{ ...b, created_by: null, deleted_at: null }]);
    brandMap.set(id, target);
    return target;
  }

  /** Copies a stored image (and its smaller copies) unless production has it; false when its bytes are not in the export. */
  async function storedImage(id: string): Promise<boolean> {
    if (imageDone.has(id)) return imageDone.get(id)!;
    let present = Boolean(await one(tx, "select 1 from stored_images where id = $1", [id]));
    if (!present) {
      const img = byId("stored_images", id);
      if (img) {
        await insert(tx, "stored_images", [{ ...img, owner_id: img.owner_id ? (userMap.get(String(img.owner_id)) ?? null) : null }]);
        await insert(tx, "stored_image_variants", table("stored_image_variants").filter((v) => v.stored_image_id === id));
        tally.images += 1;
        present = true;
      } else tally.missingImages += 1;
    }
    imageDone.set(id, present);
    return present;
  }

  /** An image URL on production: kept when its photo came across (or is not one of ours), else dropped. */
  async function imageUrl(url: unknown): Promise<string | null> {
    if (typeof url !== "string" || !url) return null;
    for (const id of imageIdsIn(url)) if (!(await storedImage(id))) return null;
    return url;
  }

  /** Photo rows whose stored image and URL both came across. */
  async function keptPhotos(photos: Row[]): Promise<Row[]> {
    const kept: Row[] = [];
    for (const ph of photos) {
      if (typeof ph.stored_image_id === "string" && !(await storedImage(ph.stored_image_id))) continue;
      if (!(await imageUrl(ph.url))) continue;
      kept.push({ ...ph, product_id: productMap.get(String(ph.product_id))?.id ?? ph.product_id, created_by: null, moderated_by: null });
    }
    return kept;
  }

  async function product(id: string): Promise<{ id: string; added: boolean }> {
    if (productMap.has(id)) return productMap.get(id)!;
    const p = byId("products", id) ?? fail(`Product ${id} is missing from the export.`);
    const categoryId = await productCategory(String(p.category_id));
    const sameName = async () => {
      const same = await tx.unsafe(
        `select id from products where deleted_at is null and lower(name) = lower($1) and coalesce(lower(variant), '') = coalesce(lower($2), '')
           and unit = $3 and unit_size_milli = $4 and category_id = $5 limit 2`,
        [p.name, p.variant ?? null, p.unit, p.unit_size_milli, categoryId] as never[],
      );
      return same.length === 1 ? (same[0] as Row) : undefined;
    };
    const found =
      (await one(tx, "select id from products where id = $1", [id])) ??
      (p.gtin ? await one(tx, "select id from products where gtin = $1 and deleted_at is null", [p.gtin]) : undefined) ??
      (await sameName());
    if (found) {
      const result = { id: String(found.id), added: false };
      productMap.set(id, result);
      tally.matchedProducts += 1;
      return result;
    }
    const slugTaken = await one(tx, "select 1 from products where slug = $1", [p.slug]);
    await insert(tx, "products", [
      {
        ...p,
        code: await nextProductCode(),
        slug: slugTaken ? `${p.slug}-${suffix()}` : p.slug,
        category_id: categoryId,
        subcategory_id: await subcategory(p.subcategory_id),
        brand_id: await brand(p.brand_id),
        image_url: await imageUrl(p.image_url),
        created_by: null,
        approved_by: null,
        deleted_at: null,
      },
    ]);
    const result = { id, added: true };
    productMap.set(id, result);
    // The product's own catalogue photos (not a listing's).
    await insert(tx, "product_images", await keptPhotos(table("product_images").filter((i) => i.product_id === id && i.shop_product_id == null)));
    tally.newProducts += 1;
    return result;
  }

  /* ---- shop by shop ---- */
  const shops = [...table("shops")].sort((a, b) => String(a.registration_number).localeCompare(String(b.registration_number)));
  for (const s of shops) {
    const name = String(s.name);
    say();
    say(`### ${name} (test ${s.registration_number}, ${s.status}, ${[s.area, s.city, s.pincode].filter(Boolean).join(" ")})`);
    if (await one(tx, "select 1 from shops where id = $1", [s.id])) {
      tally.skippedShops += 1;
      say("- Already on production (same shop id) — skipped");
      continue;
    }
    const twin = await one(
      tx,
      "select name, registration_number from shops where lower(trim(name)) = lower(trim($1)) and pincode = $2 and deleted_at is null",
      [name, s.pincode],
    );
    if (twin) {
      tally.skippedShops += 1;
      say(`- Production already has "${twin.name}" (${twin.registration_number}) in ${s.pincode} — skipped, to avoid a duplicate`);
      continue;
    }
    if (s.shop_act_key && (await one(tx, "select 1 from shops where shop_act_key = $1 and deleted_at is null", [s.shop_act_key]))) {
      tally.skippedShops += 1;
      say("- Production already has a shop with the same Shop Act registration — skipped, to avoid a duplicate");
      continue;
    }

    const ownerId = await owner(String(s.owner_id));
    const registrationNumber = await nextRegistration();
    const slugTaken = await one(tx, "select 1 from shops where slug = $1", [s.slug]);
    const photos: string[] = [];
    for (const p of (s.photos as string[] | null) ?? []) {
      const kept = await imageUrl(p);
      if (kept) photos.push(kept);
    }
    await insert(tx, "shops", [
      {
        ...s,
        owner_id: ownerId,
        registration_number: registrationNumber,
        slug: slugTaken ? `${s.slug}-${suffix()}` : s.slug,
        logo_url: await imageUrl(s.logo_url),
        photos,
        // Test-only records production does not have.
        approved_by: null,
        shop_registration_id: null,
        registration_tier_id: null,
        registration_fee_id: null,
        referral_code_id: null,
        status_actor_id: null,
        turnover_declared_by: null,
        gst_verified_by: null,
        pan_verified_by: null,
        // Encrypted with the test site's key: unreadable on production. The last four digits stay.
        pan_number_encrypted: null,
        pan_hash: null,
      },
    ]);
    say(
      `- Shop added as **${registrationNumber}**${slugTaken ? " (web address changed: the old one is taken)" : ""}; status ${s.status}${s.latitude ? ", map location kept" : ", no map location"}`,
    );

    // Shop categories (the kind of shop), matched by slug or name.
    for (const m of table("shop_category_mapping").filter((r) => r.shop_id === s.id)) {
      const c = byId("shop_categories", m.category_id) ?? fail(`Shop category ${String(m.category_id)} is missing from the export.`);
      const found =
        (await one(tx, "select id from shop_categories where id = $1", [c.id])) ??
        (await one(tx, "select id from shop_categories where slug = $1", [c.slug])) ??
        (await one(tx, "select id from shop_categories where lower(name) = lower($1)", [c.name]));
      if (!found) {
        await insert(tx, "shop_categories", [c]);
        tally.categories += 1;
      }
      await insert(tx, "shop_category_mapping", [{ ...m, category_id: found ? found.id : c.id }]);
    }

    // Listings: price, stock and sale settings; the catalogue product matched or added first.
    const listings = table("shop_products").filter((l) => l.shop_id === s.id);
    const listingsOut: Row[] = [];
    let onNewProducts = 0;
    for (const l of listings) {
      const p = await product(String(l.product_id));
      if (p.added) onNewProducts += 1;
      listingsOut.push({ ...l, product_id: p.id, image_url: await imageUrl(l.image_url), content_updated_by: null });
    }
    await insert(tx, "shop_products", listingsOut);
    tally.listings += listingsOut.length;

    // A listing's own photos.
    const listingIds = new Set(listings.map((l) => l.id));
    const listingPhotos = await keptPhotos(table("product_images").filter((i) => listingIds.has(i.shop_product_id)));
    await insert(tx, "product_images", listingPhotos);

    // The product categories the shop chose to sell in.
    const chosen = new Map<string, Row>();
    for (const c of table("shop_product_categories").filter((r) => r.shop_id === s.id)) {
      const categoryId = await productCategory(String(c.category_id));
      if (!chosen.has(categoryId)) chosen.set(categoryId, { ...c, category_id: categoryId, added_by: null });
    }
    await insert(tx, "shop_product_categories", [...chosen.values()]);

    await insert(tx, "audit_logs", [
      {
        id: randomUUID(),
        actor_id: null,
        actor_role: null,
        action: "shop.copied_from_test",
        entity_type: "shop",
        entity_id: s.id,
        previous_value: null,
        new_value: { from: "test.gokesari.com", testRegistrationNumber: s.registration_number, registrationNumber, listings: listingsOut.length },
        ip_address: null,
        user_agent: "copy-shops workflow",
        created_at: now,
      },
    ]);
    say(
      `- ${listingsOut.length} listing(s) with prices and stock (${onNewProducts} on products new to production's catalogue), ${listingPhotos.length} listing photo(s), ${chosen.size} product categor${chosen.size === 1 ? "y" : "ies"}`,
    );
    tally.shops += 1;
  }
}

(MODE === "export" ? exportShops() : importShops()).catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
