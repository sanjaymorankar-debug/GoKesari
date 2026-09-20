/**
 * The platform collects product facts, never people.
 *
 * Open data carries the usernames of the volunteers who edited a record. Those names must never
 * reach the database - not in the staged payload, and not in the excerpt logged with an error.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runIngestion } from "@/server/pmd/pipeline/run";
import { createOpenFactsAdapter, stripContributors } from "@/server/pmd/sources/adapters/open-facts";
import { createOpenPricesAdapter, stripPersonalData } from "@/server/pmd/sources/adapters/open-prices";
import { GTIN, pmdSql, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const PEOPLE = ["alice_the_contributor", "bob_the_editor", "carol_the_checker", "dave_the_photographer", "erin_the_uploader"];

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

const noPersonIn = (text: string) => {
  for (const p of PEOPLE) expect(text, `${p} leaked`).not.toContain(p);
};

describe("contributor data is stripped by the adapters", () => {
  it("Open*Facts: removes every column that names a person, keeps the product facts", () => {
    const row = {
      code: GTIN.TEA, product_name: "Masala Tea 250 g", brands: "Acme", last_modified_t: "1700000000",
      creator: PEOPLE[0], last_modified_by: PEOPLE[1], last_updated_by: PEOPLE[1], created_by: PEOPLE[0], owner: PEOPLE[4],
      owners_tags: PEOPLE[4], contributors: PEOPLE[0], contributors_tags: PEOPLE[0], editors: PEOPLE[1], editors_tags: PEOPLE[1],
      checkers: PEOPLE[2], checkers_tags: PEOPLE[2], photographers: PEOPLE[3], photographers_tags: PEOPLE[3],
      informers: PEOPLE[0], informers_tags: PEOPLE[0], correctors_tags: PEOPLE[1],
    };
    const clean = stripContributors(row);
    expect(Object.keys(clean).sort()).toEqual(["brands", "code", "last_modified_t", "product_name"]);
    noPersonIn(JSON.stringify(clean));
  });

  it("Open Prices: removes owner, proof and the product creator, keeps the price and the store", () => {
    const item = {
      id: 7, product_code: GTIN.TEA, price: 90, currency: "INR", date: "2026-09-01",
      owner: PEOPLE[0], proof: { id: 3, file_path: "u/erin_the_uploader.jpg", owner: PEOPLE[4] }, proof_id: 3,
      product: { code: GTIN.TEA, product_name: "Masala Tea 250 g", creator: PEOPLE[1] },
      location: { osm_name: "Corner Shop", osm_id: 42 },
    };
    const clean = stripPersonalData(item) as typeof item & { product: Record<string, unknown> };
    expect(clean).not.toHaveProperty("owner");
    expect(clean).not.toHaveProperty("proof");
    expect(clean).not.toHaveProperty("proof_id");
    expect(clean.product).not.toHaveProperty("creator");
    expect(clean).toMatchObject({ price: 90, location: { osm_name: "Corner Shop" }, product: { product_name: "Masala Tea 250 g" } });
    noPersonIn(JSON.stringify(clean));
  });
});

describe("contributor data never reaches the database", () => {
  it("Open*Facts run: staged payloads and error excerpts hold no usernames", async () => {
    const rows = [
      { code: GTIN.TEA, product_name: "Masala Tea 250 g", brands: "Acme", quantity: "250 g", creator: PEOPLE[0], last_modified_by: PEOPLE[1], checkers_tags: PEOPLE[2], photographers_tags: PEOPLE[3] },
      // no name -> an error row, whose excerpt must be sanitised too
      { code: GTIN.MILK_1L, product_name: "", brands: "Acme", creator: PEOPLE[0], editors_tags: PEOPLE[1], informers_tags: PEOPLE[4] },
    ];
    const res = await runIngestion(sql, createOpenFactsAdapter("food", { mode: "rows", rows }), { mode: "PILOT" });
    expect(res.counters).toMatchObject({ productsCreated: 1, errorCount: 1 });

    const raw = await sql<{ payload: string }[]>`SELECT payload::text AS payload FROM pmd.raw_record`;
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.map((r) => r.payload).join("\n")).toContain("Masala Tea"); // the facts are there...
    noPersonIn(raw.map((r) => r.payload).join("\n")); //                      ...the people are not

    const errs = await sql<{ excerpt: string | null; message: string }[]>`SELECT raw_excerpt::text AS excerpt, message FROM pmd.import_error`;
    expect(errs.length).toBeGreaterThan(0);
    noPersonIn(errs.map((e) => `${e.excerpt ?? ""} ${e.message}`).join("\n"));
  });

  it("Open Prices run: no owner, proof or creator is stored", async () => {
    const rows = [
      {
        id: 1, type: "PRODUCT", product_code: GTIN.TEA, price: 90, price_per: "UNIT", currency: "INR", date: "2026-09-01",
        owner: PEOPLE[0], proof: { id: 3, file_path: "u/erin_the_uploader.jpg" }, proof_id: 3,
        product: { code: GTIN.TEA, product_name: "Masala Tea 250 g", brands: "Acme", quantity: "250 g", creator: PEOPLE[1] },
        location: { osm_name: "Corner Shop", osm_id: 42, osm_type: "NODE", osm_address_city: "Pune", osm_address_country: "India" },
      },
      // no usable price -> error row; the excerpt must not carry the owner either
      { id: 2, type: "PRODUCT", product_code: GTIN.MILK_1L, price: null, currency: "INR", date: "2026-09-01", owner: PEOPLE[4], product: { creator: PEOPLE[2] } },
    ];
    const res = await runIngestion(sql, createOpenPricesAdapter({ mode: "rows", rows }), { mode: "PILOT" });
    expect(res.counters).toMatchObject({ productsCreated: 1, offersUpserted: 1, errorCount: 1 });

    const raw = await sql<{ payload: string }[]>`SELECT payload::text AS payload FROM pmd.raw_record`;
    noPersonIn(raw.map((r) => r.payload).join("\n"));
    const errs = await sql<{ excerpt: string | null }[]>`SELECT raw_excerpt::text AS excerpt FROM pmd.import_error`;
    noPersonIn(errs.map((e) => e.excerpt ?? "").join("\n"));
  });
});
