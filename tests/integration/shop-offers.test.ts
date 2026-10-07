/**
 * F8 — shop offers: a shop's own dated discount on a product or a category,
 * shown on its page and applied identically in the cart and at checkout.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orderItems, platformSettings } from "@/server/db/schema";
import { addToCart, getCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { listLiveOffersForShop, priceWithOffers, saveShopOffer } from "@/server/services/shop-offers";
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

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "shopOffers"));
  clearRuleCache();
});

const day = 86_400_000;
const live = () => ({ startsAt: new Date(Date.now() - day), endsAt: new Date(Date.now() + day) });

async function setup() {
  const admin = await createUser({ role: "ADMIN" });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const ownerActor = { id: owner.id, role: "SHOP_OWNER" };
  const milkCat = await createCategory({ department: "DAIRY", name: "Milk" });
  const breadCat = await createCategory({ department: "BAKERY", name: "Bread" });
  const milk = await createProduct(milkCat.id, { name: "Cow Milk", unit: "L" });
  const bread = await createProduct(breadCat.id, { name: "Bread", unit: "piece" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const other = await createShop(owner.id, { name: "Dairy Two" });
  const spMilk = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const spBread = await createShopProduct(shop.id, bread.id, { onlinePricePaise: 4000, onlineStock: 50 });
  const spOtherMilk = await createShopProduct(other.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  return { admin, ownerActor, shop, other, milkCat, breadCat, spMilk, spBread, spOtherMilk, customer };
}

describe("shop offers", () => {
  it("change nothing while the rule is off", async () => {
    const s = await setup();
    await saveShopOffer(s.shop.id, { title: "Milk 10% off", targetType: "PRODUCT", shopProductId: s.spMilk.id, discountType: "PERCENT", percent: 10, ...live() }, s.ownerActor);
    await addToCart(s.customer.id, s.spMilk.id, 1);
    const line = (await getCart(s.customer.id)).groups[0].lines[0];
    expect(line.unitPricePaise).toBe(7000);
    expect(line.offerTitle).toBeUndefined();
    expect(await listLiveOffersForShop(s.shop.id)).toEqual([]);
  });

  it("apply a product offer and a category offer in the cart and at checkout, only for that shop", async () => {
    const s = await setup();
    await setRule("shopOffers", { enabled: true }, { id: s.admin.id, role: "ADMIN" });
    await saveShopOffer(s.shop.id, { title: "Milk 10% off", targetType: "PRODUCT", shopProductId: s.spMilk.id, discountType: "PERCENT", percent: 10, ...live() }, s.ownerActor);
    await saveShopOffer(s.shop.id, { title: "₹5 off bread", targetType: "CATEGORY", categoryId: s.breadCat.id, discountType: "FLAT", flatPaise: 500, ...live() }, s.ownerActor);
    await addToCart(s.customer.id, s.spMilk.id, 2);
    await addToCart(s.customer.id, s.spBread.id, 1);
    await addToCart(s.customer.id, s.spOtherMilk.id, 1);

    const cart = await getCart(s.customer.id);
    const lines = cart.groups.flatMap((g) => g.lines);
    const milkLine = lines.find((l) => l.shopProductId === s.spMilk.id)!;
    expect(milkLine).toMatchObject({ unitPricePaise: 6300, listUnitPricePaise: 7000, offerTitle: "Milk 10% off" });
    expect(lines.find((l) => l.shopProductId === s.spBread.id)!.unitPricePaise).toBe(3500);
    expect(lines.find((l) => l.shopProductId === s.spOtherMilk.id)!.unitPricePaise).toBe(7000);

    const { orders: placed } = await checkout({ userId: s.customer.id, addressId: await deliveryAddressId(s.customer.id), requestId: "offers-1" });
    const own = placed.find((o) => o.shopId === s.shop.id)!;
    expect(own.subtotalPaise).toBe(2 * 6300 + 3500);
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, own.id));
    expect(items.map((i) => i.unitPricePaise).sort()).toEqual([3500, 6300]);
    expect(own.subtotalPaise).toBe(cart.groups.find((g) => g.shop.id === s.shop.id)!.subtotalPaise);

    const shown = await listLiveOffersForShop(s.shop.id);
    expect(shown.map((o) => o.label).sort()).toEqual(["10% off", "₹5 off each"]);
  });

  it("ignore expired and future offers, take the best of overlapping ones, and never price loose goods", () => {
    const base = { id: "o", shopId: "s", shopProductId: "sp", categoryId: "c", active: true, title: "", createdBy: null, createdAt: new Date(), updatedAt: new Date(), startsAt: new Date(), endsAt: new Date() };
    const target = { shopId: "s", shopProductId: "sp", categoryId: "c" };
    const pct = { ...base, targetType: "PRODUCT" as const, discountType: "PERCENT" as const, percent: 10, flatPaise: null };
    const flat = { ...base, id: "f", targetType: "CATEGORY" as const, discountType: "FLAT" as const, percent: null, flatPaise: 1500 };
    expect(priceWithOffers(10_000, target, [pct, flat]).unitPricePaise).toBe(8500);
    expect(priceWithOffers(null, target, [pct, flat])).toEqual({ unitPricePaise: null, offer: null });
    expect(priceWithOffers(1000, target, [flat]).unitPricePaise).toBe(1);
  });

  it("only counts offers inside their dates", async () => {
    const s = await setup();
    await setRule("shopOffers", { enabled: true }, { id: s.admin.id, role: "ADMIN" });
    await saveShopOffer(s.shop.id, { title: "Old offer", targetType: "PRODUCT", shopProductId: s.spMilk.id, discountType: "PERCENT", percent: 50, startsAt: new Date(Date.now() - 3 * day), endsAt: new Date(Date.now() - day) }, s.ownerActor);
    await saveShopOffer(s.shop.id, { title: "Next week", targetType: "PRODUCT", shopProductId: s.spMilk.id, discountType: "PERCENT", percent: 50, startsAt: new Date(Date.now() + day), endsAt: new Date(Date.now() + 3 * day) }, s.ownerActor);
    await addToCart(s.customer.id, s.spMilk.id, 1);
    expect((await getCart(s.customer.id)).groups[0].lines[0].unitPricePaise).toBe(7000);
  });

  it("refuses another shop's product and bad amounts", async () => {
    const s = await setup();
    await expect(
      saveShopOffer(s.shop.id, { title: "Steal", targetType: "PRODUCT", shopProductId: s.spOtherMilk.id, discountType: "PERCENT", percent: 10, ...live() }, s.ownerActor),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      saveShopOffer(s.shop.id, { title: "Too much", targetType: "PRODUCT", shopProductId: s.spMilk.id, discountType: "PERCENT", percent: 95, ...live() }, s.ownerActor),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
