/**
 * Onboarding a licensed / partner CSV feed by configuration alone - against a real PostgreSQL.
 *
 * The feed, mapping and category map are the same files the data-source guide tells an
 * operator to copy (docs/product-master/examples), so the documentation cannot drift from
 * what the platform actually does with them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runIngestion } from "@/server/pmd/pipeline/run";
import { standardCodeMapper } from "@/server/pmd/services/ingest-api";
import { createCsvFeedAdapter, type FeedMapping } from "@/server/pmd/sources/adapters/csv-feed";
import { getSourceDefinition } from "@/server/pmd/sources/registry";
import { chainMappers, createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { count, pmdSql, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const EXAMPLES = join(process.cwd(), "docs", "product-master", "examples");
const json = <T,>(name: string): T => JSON.parse(readFileSync(join(EXAMPLES, name), "utf8")) as T;

const feed = () =>
  createCsvFeedAdapter({
    definition: getSourceDefinition("partner_feed")!,
    input: { path: join(EXAMPLES, "partner-feed.sample.csv") },
    mapping: json<FeedMapping>("partner-feed.mapping.json"),
    categoryMapper: chainMappers(createCategoryMapper({ tags: json<Record<string, string>>("partner-feed.categories.json"), keywords: [] }), standardCodeMapper()),
  });

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

describe("partner CSV feed, onboarded by mapping", () => {
  it("accounts for every row: loaded, linked, or recorded as an error - none vanish", async () => {
    const run = await runIngestion(sql, feed(), { mode: "IMPORT", batchSize: 50 });
    const c = run.counters;
    expect(c.recordsRead).toBe(13);
    expect(c.productsCreated + c.productsLinked + c.errorCount).toBe(13);
    expect(c).toMatchObject({ productsCreated: 8, productsLinked: 1, errorCount: 4 });
    expect(run.status).toBe("PARTIAL");

    const errors = await sql<{ source_record_id: string; error_code: string }[]>`
      SELECT source_record_id, error_code FROM pmd.import_error WHERE severity = 'ERROR' ORDER BY source_record_id`;
    expect(errors).toEqual([
      { source_record_id: "XX-9001", error_code: "NAME_MISSING" },
      { source_record_id: "XX-9002", error_code: "NAME_MISSING" },
      { source_record_id: "row-13", error_code: "NO_SOURCE_ID" },
      { source_record_id: "row-14", error_code: "ROW_WIDTH" },
    ]);
  });

  it("merges the same product listed twice by a second seller into one master with two offers", async () => {
    await runIngestion(sql, feed(), { mode: "IMPORT" });
    const rice = await sql<{ product_id: number }[]>`SELECT product_id FROM pmd.product_master WHERE gtin = '08901234000014'`;
    expect(rice).toHaveLength(1);
    const offers = await sql<{ seller_name: string; price_minor: number; stock_status: string }[]>`
      SELECT seller_name, price_minor::int AS price_minor, stock_status FROM pmd.product_offer WHERE product_id = ${rice[0].product_id} ORDER BY price_minor`;
    expect(offers).toEqual([
      { seller_name: "Metro Mart", price_minor: 18500, stock_status: "LIMITED" },
      { seller_name: "Acme Retail", price_minor: 18900, stock_status: "IN_STOCK" },
    ]);
    // the second listing's own spelling of the brand is kept as an alias, not a second brand
    expect(await count(sql, "pmd.brand", "brand_key LIKE 'acmefarms%'")).toBe(1);
  });

  it("keeps different pack sizes and colours as separate masters, and groups pack sizes into a family", async () => {
    await runIngestion(sql, feed(), { mode: "IMPORT" });
    const rows = await sql<{ product_name: string; product_family_id: number | null }[]>`
      SELECT product_name, product_family_id FROM pmd.product_master ORDER BY product_id`;
    const byName = (needle: string) => rows.find((r) => r.product_name.includes(needle))!;
    expect(byName("Rice 1 kg").product_family_id).not.toBeNull();
    expect(byName("Rice 1 kg").product_family_id).toBe(byName("Rice 5 kg").product_family_id);
    expect(byName("500 ml (Pack of 6)").product_family_id).toBe(byName("Toned Milk 500 ml").product_family_id);
    expect(rows.filter((r) => r.product_name.includes("Zenith Z5"))).toHaveLength(2);
  });

  it("stores mapped attributes as specifications, categories via the map, and NULL where nothing maps", async () => {
    await runIngestion(sql, feed(), { mode: "IMPORT" });
    const specs = await sql<{ attribute_key: string; value_num: string | null }[]>`
      SELECT s.attribute_key, s.value_num FROM pmd.product_specification s JOIN pmd.product_master p USING (product_id)
      WHERE p.product_name LIKE '%Midnight Black%' AND s.attribute_key IN ('ram_gb', 'storage_gb') ORDER BY 1`;
    expect(specs.map((s) => [s.attribute_key, Number(s.value_num)])).toEqual([["ram_gb", 8], ["storage_gb", 128]]);

    const cats = await sql<{ product_name: string; category_code: string | null }[]>`
      SELECT p.product_name, c.category_code FROM pmd.product_master p LEFT JOIN pmd.category c USING (category_id) ORDER BY p.product_id`;
    expect(cats.find((c) => c.product_name.includes("Ghee"))?.category_code).toBe("dairy/ghee");
    expect(cats.find((c) => c.product_name.includes("Mustard"))?.category_code).toBeNull();
  });

  it("uses a code with a wrong check digit as a source code only, and flags a price above MRP without dropping it", async () => {
    await runIngestion(sql, feed(), { mode: "IMPORT" });
    const mustard = await sql<{ gtin: string | null; id_type: string | null }[]>`
      SELECT p.gtin, i.id_type FROM pmd.product_master p LEFT JOIN pmd.product_identifier i ON i.product_id = p.product_id
      WHERE p.product_name LIKE '%Mustard%'`;
    expect(mustard[0].gtin).toBeNull();
    expect(mustard.map((m) => m.id_type)).toEqual(["SOURCE_CODE"]);
    const warn = await sql<{ error_code: string }[]>`SELECT error_code FROM pmd.import_error WHERE severity = 'WARNING' ORDER BY error_code`;
    expect(warn.map((w) => w.error_code)).toEqual(expect.arrayContaining(["GTIN_CHECK_DIGIT_INVALID", "PRICE_ABOVE_MRP", "NAME_PLACEHOLDER"]));
    expect(await count(sql, "pmd.product_master", "product_name LIKE '%Ghee%'")).toBe(1);
  });

  it("is idempotent: a second run of the same file changes nothing", async () => {
    await runIngestion(sql, feed(), { mode: "IMPORT" });
    const before = { masters: await count(sql, "pmd.product_master"), offers: await count(sql, "pmd.product_offer"), history: await count(sql, "pmd.price_history") };
    const again = await runIngestion(sql, feed(), { mode: "INCREMENTAL" });
    expect(again.counters).toMatchObject({ productsCreated: 0, recordsUnchanged: 9, priceChanges: 0 });
    expect({ masters: await count(sql, "pmd.product_master"), offers: await count(sql, "pmd.product_offer"), history: await count(sql, "pmd.price_history") }).toEqual(before);
  });
});
