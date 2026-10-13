/**
 * docs/db-split-2026-10: every table has exactly one owner, so a new table
 * can't be added without deciding which database it lives in.
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { CUSTOMER_READS_FROM_SELLER, physicalDatabase, SELLER_READS_FROM_CORE, TABLE_OWNERSHIP, tablesOwnedBy } from "@/server/db/split/ownership";

const schemaTables = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t))
  .filter((c) => !c.schema || c.schema === "public")
  .map((c) => c.name);

describe("seller / customer table ownership", () => {
  it("names an owner for every table in the schema, and no table that doesn't exist", () => {
    const owned = Object.keys(TABLE_OWNERSHIP);
    expect(schemaTables.filter((t) => !owned.includes(t))).toEqual([]);
    expect(owned.filter((t) => !schemaTables.includes(t))).toEqual([]);
  });

  it("puts the core entities where the brief says", () => {
    for (const t of ["shops", "shop_products", "products", "seller_verifications", "seller_document_uploads", "shop_wallets", "shop_settlements"]) {
      expect(physicalDatabase(t)).toBe("seller");
    }
    for (const t of ["users", "addresses", "carts", "orders", "order_items", "wallets", "order_ratings", "subscriptions"]) {
      expect(physicalDatabase(t)).toBe("customer");
    }
    expect(tablesOwnedBy("seller").length + tablesOwnedBy("customer").length).toBe(Object.keys(TABLE_OWNERSHIP).length);
  });

  it("only reads remote tables that the other side owns", () => {
    expect(CUSTOMER_READS_FROM_SELLER.every((t) => physicalDatabase(t) === "seller")).toBe(true);
    expect(SELLER_READS_FROM_CORE.every((t) => physicalDatabase(t) === "customer")).toBe(true);
  });
});

describe("split connections", () => {
  it("drops libpq-only URL settings (Neon's channel_binding) that Postgres would refuse as session settings", async () => {
    const { connect } = await import("@/server/db/split/tools");
    const sql = connect("postgresql://u:p@db.example.test:5432/gokesari_seller?sslmode=require&channel_binding=require", 1);
    try {
      expect(sql.options.database).toBe("gokesari_seller");
      expect(sql.options.connection).not.toHaveProperty("channel_binding");
      expect(sql.options.ssl).toBe("require");
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

describe("split database check", () => {
  it("names the roles that point at the same database, pooled or direct host, without the password", async () => {
    const { sameDatabaseClash } = await import("@/server/db/split/tools");
    const base = "postgresql://u:secret@ep-x.c-4.aws.neon.tech";
    expect(sameDatabaseClash({ SOURCE: `${base}/neondb`, SELLER: `${base}/seller_db`, CUSTOMER: `${base}/customer_db` })).toBeNull();
    const clash = sameDatabaseClash({
      SOURCE: "postgresql://u:secret@ep-x-pooler.c-4.aws.neon.tech/neondb?sslmode=require",
      SELLER: `${base}/neondb?sslmode=require&channel_binding=require`,
      CUSTOMER: `${base}/customer_db`,
    });
    expect(clash).toBe("SOURCE and SELLER are both neondb on ep-x.c-4.aws.neon.tech");
    expect(clash).not.toContain("secret");
  });
});
