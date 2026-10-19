/**
 * batch-2026-10 WS-A — F1.4.3 "Online reference prices" (GS-023) is DROPPED:
 * never shown to customers or shops, whatever the rule says; the public API
 * answers 404; no menu entry; the offline fetch script refuses to run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as referencesRoute } from "@/app/api/products/[id]/price-references/route";
import { ADMIN_MENUS, OPERATOR_MENUS } from "@/lib/board/menus";
import { DROPPED_ACK_FLAG, PRICE_REFERENCES_DROPPED, droppedFeatureRefusal } from "@/lib/price-references-drop";
import { db } from "@/server/db";
import { externalPriceReferences, platformSettings } from "@/server/db/schema";
import { listReferencesForProduct } from "@/server/services/price-references";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createCategory, createProduct, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

afterEach(async () => {
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["externalPrices"]));
  clearRuleCache();
});

async function productWithVerifiedReference() {
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  await db.insert(externalPriceReferences).values({
    productId: product.id,
    pricePaise: 6800,
    sourceType: "MARKET_SURVEY",
    sourceName: "Local market",
    referencedAt: new Date(),
    verificationStatus: "VERIFIED",
  });
  return { admin, product };
}

describe("F1.4.3 dropped", () => {
  it("TC-B26-A-070 the kill switch is on", () => {
    expect(PRICE_REFERENCES_DROPPED).toBe(true);
  });

  it("TC-B26-A-071 customers and shops never get references, even with the rule switched on", async () => {
    const { admin, product } = await productWithVerifiedReference();
    await setRule("externalPrices", { showToCustomers: true, showToShops: true }, admin);
    expect(await listReferencesForProduct(product.id, "CUSTOMER")).toEqual([]);
    expect(await listReferencesForProduct(product.id, "SHOP")).toEqual([]);
    // The recorded data is kept (isolated), visible only to operations.
    expect(await listReferencesForProduct(product.id, "STAFF")).toHaveLength(1);
  });

  it("TC-B26-A-072 the public API answers 404 for everyone", async () => {
    const { admin, product } = await productWithVerifiedReference();
    const anonymous = await call(referencesRoute, `/api/products/${product.id}/price-references`, { params: { id: product.id } });
    expect(anonymous.status).toBe(404);
    state.session = { user: { id: admin.id, email: admin.email, name: admin.name, image: null, role: "ADMIN", status: "ACTIVE" } };
    const staff = await call(referencesRoute, `/api/products/${product.id}/price-references`, { params: { id: product.id } });
    expect(staff.status).toBe(404);
  });

  it("TC-B26-A-073 the product page never renders the Reference prices section", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/products/[id]/page.tsx"), "utf8");
    expect(source).toContain("PRICE_REFERENCES_DROPPED ? [] : await listReferencesForProduct");
    expect(source).toContain("!PRICE_REFERENCES_DROPPED && references.length > 0");
  });

  it("TC-B26-A-074 no admin or operator menu entry leads to price references; the page says it is dropped", () => {
    const hrefs = [...ADMIN_MENUS, ...OPERATOR_MENUS].flatMap((m) => [m.href, ...m.items.map((i) => i.href), ...(m.more ?? []).map((i) => i.href)]);
    expect(hrefs).not.toContain("/admin/price-references");
    const page = readFileSync(path.join(process.cwd(), "src/app/admin/price-references/page.tsx"), "utf8");
    expect(page).toContain("PRICE_REFERENCES_DROPPED_NOTICE");
  });

  it("TC-B26-A-075 the offline fetch script refuses to run without the explicit flag", () => {
    expect(droppedFeatureRefusal(["node", "fetch-prices.ts", "--currency", "INR"])).toMatch(/F1\.4\.3 .*DROPPED/);
    expect(droppedFeatureRefusal(["node", "fetch-prices.ts", DROPPED_ACK_FLAG])).toBeNull();
    const script = readFileSync(path.join(process.cwd(), "scripts/pmd/fetch-prices.ts"), "utf8");
    expect(script).toContain("droppedFeatureRefusal(process.argv)");
  });
});
