/**
 * Task 1 (docs/db-split-2026-10): split the test database into a seller and a
 * customer database on the same server, then prove it — every row copied,
 * equal checksums, the source untouched, order → shop → product links intact
 * across the two databases, a broken link detected, and cross-database reads
 * through postgres_fdw.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orderItems } from "@/server/db/schema";
import { getOrderWithShopAndProducts } from "@/server/db/split/cross-reads";
import { assertShopExists, assertShopProductsBelongToShop } from "@/server/db/split/integrity";
import { physicalDatabase } from "@/server/db/split/ownership";
import {
  checkCrossReferences,
  connect,
  copyTables,
  crossDbReferences,
  fingerprint,
  listForeignKeys,
  prepareTarget,
  publicTables,
  setupForeignTables,
  splitTables,
  verifyCopy,
  type Sql,
} from "@/server/db/split/tools";
import { renderReport } from "@/server/db/split/report";
import { createOrder, createStandardMilkSetup, resetDatabase } from "../helpers/fixtures";

const sourceUrl = process.env.TEST_DATABASE_URL!;
const suffix = `${process.pid}_${Date.now() % 100000}`;
const sellerName = `gk_split_seller_${suffix}`;
const customerName = `gk_split_customer_${suffix}`;
const urlFor = (name: string) => {
  const u = new URL(sourceUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

let admin: Sql;
let source: Sql;
let seller: Sql;
let customer: Sql;
let fixture: Awaited<ReturnType<typeof createStandardMilkSetup>> & { orderId: string };

beforeAll(async () => {
  await resetDatabase();
  const setup = await createStandardMilkSetup();
  const order = await createOrder(setup.customer.id, setup.shop.id, { status: "CONFIRMED" });
  await db.insert(orderItems).values({
    orderId: order.id,
    shopProductId: setup.shopProduct.id,
    productNameSnapshot: "Cow Milk",
    unitSnapshot: "L",
    unitPricePaise: 7000,
    quantityMilli: 1000,
    lineTotalPaise: 7000,
  });
  fixture = { ...setup, orderId: order.id };

  admin = connect(urlFor("postgres"), 1);
  await admin.unsafe(`create database "${sellerName}"`);
  await admin.unsafe(`create database "${customerName}"`);
  source = connect(sourceUrl, 3);
  seller = connect(urlFor(sellerName), 3);
  customer = connect(urlFor(customerName), 3);
}, 120_000);

afterAll(async () => {
  await seller?.end();
  await customer?.end();
  await source?.end();
  if (admin) {
    await admin.unsafe(`drop database if exists "${sellerName}" with (force)`);
    await admin.unsafe(`drop database if exists "${customerName}" with (force)`);
    await admin.end();
  }
});

// Building two databases with every migration and copying into them is slower than a normal test.
describe("seller / customer database split", { timeout: 300_000 }, () => {
  it("builds both schemas, copies every row, and the checksums match; the source is untouched", async () => {
    const { seller: sellerTables, customer: customerTables, unowned } = splitTables(await publicTables(source));
    expect(unowned).toEqual([]);
    expect(sellerTables).toContain("pmd.product_master");
    const before = await fingerprint(source, "orders");

    const sp = await prepareTarget(seller, "seller");
    const cp = await prepareTarget(customer, "customer");
    expect(sp.keptTables.sort()).toEqual(sellerTables.sort());
    expect(cp.keptTables.sort()).toEqual(customerTables.sort());

    await copyTables(source, seller, sellerTables);
    await copyTables(source, customer, customerTables);

    const report = [...(await verifyCopy(source, seller, "seller", sellerTables)), ...(await verifyCopy(source, customer, "customer", customerTables))];
    expect(report.filter((r) => !r.ok)).toEqual([]);
    expect(report.find((r) => r.table === "shops")?.targetRows).toBe(1);
    expect(report.find((r) => r.table === "orders")?.targetRows).toBe(1);
    expect(report.find((r) => r.table === "order_items")?.targetRows).toBe(1);
    expect(await fingerprint(source, "orders")).toEqual(before);

    // Within one database the foreign keys still hold (re-created after the load).
    const sellerFks = await listForeignKeys(seller);
    expect(sellerFks.some((fk) => fk.table === "shop_products" && fk.refTable === "shops")).toBe(true);
    expect(sellerFks.every((fk) => physicalDatabase(fk.refTable) === "seller")).toBe(true);
  });

  it("keeps every order → shop → product link across the two databases", async () => {
    const fks = await listForeignKeys(source);
    const cross = crossDbReferences(fks);
    expect(cross.some((fk) => fk.table === "orders" && fk.columns[0] === "shop_id" && fk.refTable === "shops")).toBe(true);
    expect(cross.some((fk) => fk.table === "order_items" && fk.columns[0] === "shop_product_id")).toBe(true);

    const orphans = await checkCrossReferences(seller, customer, fks);
    expect(orphans.filter((o) => o.orphans > 0)).toEqual([]);
    const orderShop = orphans.find((o) => o.child === "orders" && o.columns[0] === "shop_id");
    expect(orderShop).toMatchObject({ checkedValues: 1, orphans: 0 });

    const md = renderReport({ verify: await verifyCopy(source, seller, "seller", ["shops"]), orphans, source: "src", seller: "s", customer: "c", at: "now" });
    expect(md).toContain("PASS");
  });

  it("detects a broken link (a shop missing from the seller database)", async () => {
    const fks = await listForeignKeys(source);
    await seller.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx.unsafe(`delete from shops where id = '${fixture.shop.id}'`);
    });
    const orphans = await checkCrossReferences(seller, customer, fks);
    expect(orphans.find((o) => o.child === "orders" && o.columns[0] === "shop_id")?.orphans).toBe(1);
  });

  it("reads seller tables from the customer database through postgres_fdw", async () => {
    // Fresh copy of the shop (the previous case removed it).
    await copyTables(source, seller, ["shops"]);
    await setupForeignTables(customer, { serverName: "gokesari_seller", remoteUrl: urlFor(sellerName), schema: "seller_remote", tables: ["shops", "shop_products", "products"] });
    const rows = await customer.unsafe<{ order_number: string; shop_name: string; product_name: string }[]>(`
      select o.order_number, s.name as shop_name, p.name as product_name
      from orders o
      join order_items i on i.order_id = o.id
      join seller_remote.shops s on s.id = o.shop_id
      join seller_remote.shop_products sp on sp.id = i.shop_product_id
      join seller_remote.products p on p.id = sp.product_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0].product_name).toBe("Cow Milk");
  });

  it("service-layer checks and the cross-database order read (single mode: same answers as the database's own keys)", async () => {
    await expect(assertShopExists(fixture.shop.id)).resolves.toBeUndefined();
    await expect(assertShopExists("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assertShopProductsBelongToShop(fixture.shop.id, [fixture.shopProduct.id])).resolves.toBeUndefined();
    const otherSetup = await createStandardMilkSetup();
    await expect(assertShopProductsBelongToShop(fixture.shop.id, [otherSetup.shopProduct.id])).rejects.toMatchObject({ code: "CONFLICT" });

    const read = await getOrderWithShopAndProducts(fixture.orderId);
    expect(read?.shop?.id).toBe(fixture.shop.id);
    expect(read?.items[0].product?.name).toBe("Cow Milk");
    expect(read?.brokenLinks).toEqual([]);
  });
  it("copies each table through its own short-lived reader and closes it, leaving the source pool clean", async () => {
    let opened = 0;
    let closed = 0;
    const openReader = () => {
      opened += 1;
      const reader = connect(sourceUrl, 1);
      const end = reader.end.bind(reader);
      return Object.assign(reader, {
        end: (options?: { timeout?: number }) => {
          closed += 1;
          return end(options);
        },
      }) as Sql;
    };
    const copied = await copyTables(source, seller, ["shops", "products"], undefined, { openReader, tableTimeoutMs: 60_000 });
    expect(copied.map((c) => c.table)).toEqual(["shops", "products"]);
    expect({ opened, closed }).toEqual({ opened: 2, closed: 2 });
    expect(await fingerprint(seller, "products")).toEqual(await fingerprint(source, "products"));
    // The pooled source still answers after the copies (the hang on Neon was the next query on a paused connection).
    const [{ ok }] = await source.unsafe<{ ok: number }[]>("select 1 as ok");
    expect(ok).toBe(1);
  });

  // Last case: it leaves the seller database without the foreign keys of the stalled table.
  it("stops a stalled table copy with a clear error instead of hanging", async () => {
    // Hold the SOURCE table so the COPY read waits inside the copy step (the step the time limit covers).
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const locker = connect(sourceUrl, 1);
    const holding = locker.begin(async (tx) => {
      await tx.unsafe("lock table products in access exclusive mode");
      locked();
      await held;
    });
    await lockTaken;
    try {
      const started = Date.now();
      await expect(
        copyTables(source, seller, ["products"], undefined, { openReader: () => connect(sourceUrl, 1), tableTimeoutMs: 1_000 }),
      ).rejects.toThrow(/copying products took longer than/);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      release();
      await holding;
      await locker.end();
    }
  });
});
