/**
 * Admin screen for a master product's own HSN code and GST rate
 * (/admin/product-gst, server/gst/product-rates.ts). Real PostgreSQL.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as listRoute } from "@/app/api/admin/product-gst/route";
import { PATCH as patchRoute } from "@/app/api/admin/product-gst/[productId]/route";
import { db } from "@/server/db";
import { auditLogs, hsnTaxRates, platformSettings, products, shopProducts, shops, taxInvoices } from "@/server/db/schema";
import { listProductGstRates, setProductGst } from "@/server/gst/product-rates";
import type { InvoiceSnapshot } from "@/server/services/invoices";
import { addToCart } from "@/server/services/cart";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

function signIn(user: { id: string; role: UserRole }) {
  state.session = { user: { id: user.id, email: `${user.id}@test.local`, name: null, image: null, role: user.role, status: "ACTIVE" } };
}

/** A GSTIN with a correct check digit. */
function gstin(stateCode: string, pan: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const body = `${stateCode}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["invoicing"]));
  await db.delete(hsnTaxRates);
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule("invoicing", { enabled: true, defaultGstRateBp: 0 }, admin);
  state.session = null;
});

async function catalogue() {
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const own = await createProduct(cat.id, { name: "Amul Ghee 500ml", unit: "pc" });
  await db.update(products).set({ hsnCode: "0405", gstRateBp: 1200 }).where(eq(products.id, own.id));
  const viaHsn = await createProduct(cat.id, { name: "Paneer 200g", unit: "pc" });
  await db.update(products).set({ hsnCode: "04061000" }).where(eq(products.id, viaHsn.id));
  const bare = await createProduct(cat.id, { name: "Buttermilk", unit: "L" });
  await db.insert(hsnTaxRates).values({ hsnPrefix: "0406", rateBp: 500, cessBp: 0, effectiveFrom: "2017-07-01" });
  return { own, viaHsn, bare };
}

describe("listing", () => {
  it("shows the rate an invoice uses today and where it comes from", async () => {
    const { own, viaHsn, bare } = await catalogue();
    const { rows, missingTotal } = await listProductGstRates();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[own.id].effective).toEqual({ source: "PRODUCT", rateBp: 1200 });
    expect(by[viaHsn.id].effective).toEqual({ source: "HSN", rateBp: 500 });
    expect(by[bare.id].effective).toEqual({ source: "DEFAULT", rateBp: 0 });
    expect(missingTotal).toBe(2);
  });

  it("filters to products with no rate, and searches by name or HSN", async () => {
    const { own, viaHsn, bare } = await catalogue();
    expect((await listProductGstRates({ missing: true })).rows.map((r) => r.id).sort()).toEqual([viaHsn.id, bare.id].sort());
    expect((await listProductGstRates({ q: "ghee" })).rows.map((r) => r.id)).toEqual([own.id]);
    expect((await listProductGstRates({ q: "0406" })).rows.map((r) => r.id)).toEqual([viaHsn.id]);
  });

  it("counts shops that bill the product with their own rate", async () => {
    const { own } = await catalogue();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Dairy" });
    const sp = await createShopProduct(shop.id, own.id, { onlinePricePaise: 30_000, onlineStock: 10 });
    await db.update(shopProducts).set({ gstRateBp: 500 }).where(eq(shopProducts.id, sp.id));
    const row = (await listProductGstRates({ q: "ghee" })).rows[0];
    expect(row.shopOverrides).toBe(1);
  });
});

describe("changing a product's rate", () => {
  it("saves the HSN code and rate and records who, what and why", async () => {
    const { bare } = await catalogue();
    const updated = await setProductGst(bare.id, { hsnCode: "0403", gstRatePercent: 5, reason: "CA advice 18 Oct" }, admin);
    expect(updated).toMatchObject({ hsnCode: "0403", gstRateBp: 500 });
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "product.gst_changed"), eq(auditLogs.entityId, bare.id)));
    expect(log.actorId).toBe(admin.id);
    expect(log.previousValue).toEqual({ hsnCode: null, gstRateBp: null });
    expect(log.newValue).toEqual({ hsnCode: "0403", gstRateBp: 500, reason: "CA advice 18 Oct" });
  });

  it("can clear the rate, so invoices fall back to the HSN table", async () => {
    const { own } = await catalogue();
    await setProductGst(own.id, { hsnCode: "0406", gstRatePercent: null, reason: "Use the HSN table" }, admin);
    const row = (await listProductGstRates({ q: "ghee" })).rows[0];
    expect(row.gstRateBp).toBeNull();
    expect(row.effective).toEqual({ source: "HSN", rateBp: 500 });
  });

  it("refuses a change that changes nothing", async () => {
    const { own } = await catalogue();
    await expect(setProductGst(own.id, { hsnCode: "0405", gstRatePercent: 12, reason: "same again" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("API", () => {
  it("is admin only", async () => {
    const { own } = await catalogue();
    signIn({ id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" });
    expect((await call(listRoute, "/api/admin/product-gst")).status).toBe(403);
    const res = await call(patchRoute, `/api/admin/product-gst/${own.id}`, {
      method: "PATCH",
      params: { productId: own.id },
      body: { hsnCode: "0405", gstRatePercent: 18, reason: "not allowed" },
    });
    expect(res.status).toBe(403);
  });

  it("lists and saves for an admin, and explains bad input field by field", async () => {
    const { own, bare } = await catalogue();
    signIn(admin);
    const list = await call(listRoute, "/api/admin/product-gst?missing=1");
    expect(list.status).toBe(200);
    expect(list.body.missingTotal).toBe(2);
    expect(list.body.rows).toHaveLength(2);

    const ok = await call(patchRoute, `/api/admin/product-gst/${bare.id}`, {
      method: "PATCH",
      params: { productId: bare.id },
      body: { hsnCode: "040390", gstRatePercent: 0.25, reason: "CA advice" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.product).toMatchObject({ hsnCode: "040390", gstRateBp: 25 });

    const bad = await call(patchRoute, `/api/admin/product-gst/${own.id}`, {
      method: "PATCH",
      params: { productId: own.id },
      body: { hsnCode: "04A", gstRatePercent: 18.555, reason: "x" },
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.details.fields).sort()).toEqual(["gstRatePercent", "hsnCode", "reason"]);
  });
});

describe("invoices", () => {
  it("an issued invoice keeps its rate; the next one uses the new rate", async () => {
    const { own } = await catalogue();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Dairy GST" });
    await db.update(shops).set({ gstin: gstin("27", "ABCDE1234F"), gstStatus: "REGISTERED" }).where(eq(shops.id, shop.id));
    const sp = await createShopProduct(shop.id, own.id, { onlinePricePaise: 33_600, onlineStock: 50 });

    async function deliveredInvoiceRate(requestId: string) {
      const { user } = await createUserWithWallet({ balancePaise: 1_000_000 });
      await addToCart(user.id, sp.id, 1);
      const { orders } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId });
      for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(orders[0].id, s, admin);
      const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, orders[0].id));
      return invoice;
    }

    const before = await deliveredInvoiceRate("gst-before");
    expect((before.snapshot as unknown as InvoiceSnapshot).lines[0].rateBp).toBe(1200);

    await setProductGst(own.id, { hsnCode: "0405", gstRatePercent: 5, reason: "Rate cut" }, admin);

    const after = await deliveredInvoiceRate("gst-after");
    expect((after.snapshot as unknown as InvoiceSnapshot).lines[0].rateBp).toBe(500);
    const [reread] = await db.select().from(taxInvoices).where(eq(taxInvoices.id, before.id));
    expect((reread.snapshot as unknown as InvoiceSnapshot).lines[0].rateBp).toBe(1200);
  });
});
