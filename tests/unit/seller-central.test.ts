/**
 * GoKesari Seller Central — the sidebar groups every shop owner menu by job
 * (Orders, Catalogue, Payments, Growth, Account). These checks keep the
 * groups in step with SHOP_MENUS, so a tool can never drop out of the
 * portal's navigation.
 */
import { describe, expect, it } from "vitest";

import { LANGUAGES } from "@/lib/board/i18n";
import { SHOP_MENUS, visibleMenus } from "@/lib/board/menus";
import { groupSellerMenus, SELLER_NAV_GROUPS, SELLER_TEXT, shopStatusPill } from "@/lib/seller/nav";

describe("Seller Central navigation", () => {
  it("puts every shop owner menu in exactly one group", () => {
    const grouped = SELLER_NAV_GROUPS.flatMap((g) => g.menus);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(SHOP_MENUS.map((m) => m.key).sort());
  });

  it("shows a shop owner all sixteen menus, in group order", () => {
    const groups = groupSellerMenus(visibleMenus(SHOP_MENUS, "SHOP_OWNER", { shopSlug: "s" }, "shop"));
    expect(groups.map((g) => g.key)).toEqual(["orders", "catalogue", "payments", "growth", "account"]);
    expect(groups.flatMap((g) => g.menus).length).toBe(SHOP_MENUS.length);
    expect(groups[0].menus.map((m) => m.key)).toEqual(["orders", "returns", "disputes", "delivery"]);
  });

  it("drops menus the role may not see, and groups left empty", () => {
    const owner = groupSellerMenus(visibleMenus(SHOP_MENUS, "SHOP_OWNER", { shopSlug: "s" }, "shop")).flatMap((g) => g.menus.map((m) => m.key));
    const customer = groupSellerMenus(visibleMenus(SHOP_MENUS, "CUSTOMER", { shopSlug: "s" }, "shop"));
    const keys = customer.flatMap((g) => g.menus.map((m) => m.key));
    expect(keys.length).toBeLessThan(owner.length);
    expect(keys).not.toContain("finance");
    for (const g of customer) expect(g.menus.length).toBeGreaterThan(0);
  });

  it("has every Seller Central label in all three languages", () => {
    for (const text of [...Object.values(SELLER_TEXT), ...SELLER_NAV_GROUPS.map((g) => g.label)]) {
      for (const lang of LANGUAGES) expect(text[lang].trim().length).toBeGreaterThan(0);
    }
  });

  it("names the shop's status on the top bar", () => {
    expect(shopStatusPill("APPROVED").label.en).toBe("Live");
    expect(shopStatusPill("PENDING_APPROVAL").label.en).toBe("Pending approval");
    expect(shopStatusPill("SUSPENDED").label.en).toBe("Suspended");
    expect(shopStatusPill("SOMETHING_ELSE").label.en).toBe("Inactive");
  });
});
