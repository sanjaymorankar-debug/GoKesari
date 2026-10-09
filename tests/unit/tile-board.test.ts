/**
 * Tile Board home screens (approved design "Theme 1 Tile Board") — the pure
 * rules: language parsing, badge formatting, permission filtering, link
 * placeholders, and that every link on every board lands on a real route.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ICON_NAMES } from "@/components/board/icons";
import { formatCount, formatRupees } from "@/lib/board/format";
import { DEFAULT_LANG, LANGUAGES, ORDER_STATUS_TEXT, parseLang, tr, UI } from "@/lib/board/i18n";
import {
  ADMIN_DO_NOW,
  ADMIN_MENUS,
  allDefinedHrefs,
  COUNT_KEYS,
  CUSTOMER_CATEGORIES,
  CUSTOMER_MENUS,
  isPermitted,
  MENUS,
  OPERATOR_MENUS,
  resolveHref,
  SHOP_DO_NOW,
  SHOP_MENUS,
  visibleItems,
  visibleMenus,
  type BoardItem,
} from "@/lib/board/menus";
import { PERMISSIONS } from "@/server/authz/permissions";

const APP_DIR = path.join(process.cwd(), "src", "app");

describe("parseLang", () => {
  it("accepts the three languages", () => {
    expect(parseLang("en")).toBe("en");
    expect(parseLang("hi")).toBe("hi");
    expect(parseLang("mr")).toBe("mr");
  });

  it("reads case, whitespace and region tags leniently", () => {
    expect(parseLang(" MR ")).toBe("mr");
    expect(parseLang("hi-IN")).toBe("hi");
    expect(parseLang("mr_IN")).toBe("mr");
  });

  it("falls back to English for anything else", () => {
    for (const value of [undefined, null, "", "fr", "marathi", "<script>", 42, {}]) {
      expect(parseLang(value)).toBe(DEFAULT_LANG);
    }
    expect(DEFAULT_LANG).toBe("en");
  });

  it("picks the language's text, English when a translation is blank", () => {
    expect(tr({ en: "Cart", hi: "कार्ट", mr: "" }, "mr")).toBe("Cart");
    expect(tr(UI.viewCart, "mr")).toBe("कार्ट पहा");
  });
});

describe("formatCount", () => {
  it("shows small counts as they are", () => {
    expect(formatCount(1)).toBe("1");
    expect(formatCount(128)).toBe("128");
    expect(formatCount(999)).toBe("999");
  });

  it("shortens thousands, lakhs and crores without rounding up", () => {
    expect(formatCount(9600)).toBe("9.6k");
    expect(formatCount(17_900)).toBe("17.9k");
    expect(formatCount(18_000)).toBe("18k");
    expect(formatCount(9_999)).toBe("9.9k");
    expect(formatCount(99_999)).toBe("99.9k");
    expect(formatCount(120_000)).toBe("1.2L");
    expect(formatCount(34_000_000)).toBe("3.4Cr");
  });

  it("shows no badge for a figure that was not read", () => {
    expect(formatCount(undefined)).toBeNull();
    expect(formatCount(null)).toBeNull();
    expect(formatCount(Number.NaN)).toBeNull();
    expect(formatCount(-3)).toBeNull();
    expect(formatCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("hides zero unless asked to show it", () => {
    expect(formatCount(0)).toBeNull();
    expect(formatCount(0, { showZero: true })).toBe("0");
  });

  it("formats rupees from paise", () => {
    expect(formatRupees(125_000)).toBe("₹1,250");
    expect(formatRupees(18_650)).toBe("₹186.50");
    expect(formatRupees(undefined)).toBeNull();
  });
});

describe("resolveHref", () => {
  it("fills placeholders and URL-encodes them", () => {
    expect(resolveHref("/shops/{shopSlug}", { shopSlug: "kesari-dairy" })).toBe("/shops/kesari-dairy");
    expect(resolveHref("/orders#order-{activeOrderNumber}", { activeOrderNumber: "GK 1/2" })).toBe("/orders#order-GK%201%2F2");
  });

  it("uses the fallback when a value is missing or empty", () => {
    expect(resolveHref("/subscriptions/{subscriptionId}", {}, "/subscriptions")).toBe("/subscriptions");
    expect(resolveHref("/subscriptions/{subscriptionId}", { subscriptionId: "" }, "/subscriptions")).toBe("/subscriptions");
  });

  it("returns null when there is no value and no fallback", () => {
    expect(resolveHref("/shops/{shopSlug}", {})).toBeNull();
  });

  it("leaves links without placeholders alone", () => {
    expect(resolveHref("/shops?open=1", {})).toBe("/shops?open=1");
  });

  it("hides an item whose link cannot be resolved", () => {
    const items: BoardItem[] = [{ key: "share", label: UI.cart, href: "/shops/{shopSlug}" }];
    expect(visibleItems(items, "SHOP_OWNER", {})).toEqual([]);
    expect(visibleItems(items, "SHOP_OWNER", { shopSlug: "x" })[0].href).toBe("/shops/x");
  });
});

describe("permission filtering", () => {
  const keys = (role: Parameters<typeof visibleMenus>[1], menus = ADMIN_MENUS) =>
    visibleMenus(menus, role).flatMap((m) => m.items.map((i) => `${m.key}.${i.key}`));

  it("shows an admin every admin entry", () => {
    const total = ADMIN_MENUS.reduce((n, m) => n + m.items.length, 0);
    expect(keys("ADMIN")).toHaveLength(total);
    expect(visibleItems(ADMIN_DO_NOW, "ADMIN")).toHaveLength(ADMIN_DO_NOW.length);
  });

  it("hides admin-only entries from an operator", () => {
    const operator = keys("OPERATOR");
    for (const adminOnly of ["settings.rules", "settings.slots", "settings.coupons", "payments.settlements", "payments.refunds", "payments.riderPay", "payments.walletAdj", "privileges.roles", "productMaster.review"]) {
      expect(operator).not.toContain(adminOnly);
    }
    expect(operator).toContain("disputes.open");
  });

  it("drops a whole tile when nothing in it is permitted", () => {
    expect(visibleMenus(ADMIN_MENUS, "CUSTOMER")).toEqual([]);
    expect(visibleMenus(OPERATOR_MENUS, "CUSTOMER")).toEqual([]);
  });

  it("keeps the shop owner's finance, marketing and analytics only for a shop owner", () => {
    const owner = visibleMenus(SHOP_MENUS, "SHOP_OWNER", { shopSlug: "s" }).map((m) => m.key);
    expect(owner).toEqual(SHOP_MENUS.map((m) => m.key));
    const customer = visibleMenus(SHOP_MENUS, "CUSTOMER", { shopSlug: "s" }).map((m) => m.key);
    expect(customer).not.toContain("finance");
    expect(customer).not.toContain("marketing");
    expect(customer).not.toContain("analytics");
    expect(visibleItems(SHOP_DO_NOW, "SHOP_OWNER")).toHaveLength(3);
  });

  it("shows a customer all six tiles and every submenu", () => {
    const menus = visibleMenus(CUSTOMER_MENUS, "CUSTOMER");
    expect(menus.map((m) => m.key)).toEqual(["shops", "orders", "subscriptions", "wallet", "tracking", "profile"]);
    expect(menus.reduce((n, m) => n + m.items.length, 0)).toBe(18);
  });

  it("treats a list of permissions as any-of", () => {
    const entry = { permission: [PERMISSIONS.AUDIT_LOG_VIEW, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED] as const };
    expect(isPermitted(entry, "OPERATOR")).toBe(true);
    expect(isPermitted(entry, "CUSTOMER")).toBe(false);
    expect(isPermitted({}, "CUSTOMER")).toBe(true);
  });

  /**
   * Pages that send anyone but an administrator back to "/" (checked by hand
   * in each page). An operator must never be offered a link to them.
   */
  it("never offers an operator a page that redirects operators home", () => {
    const adminOnlyRoutes = [
      "/admin/coupons", "/admin/customer-referrals", "/admin/delivery-slots", "/admin/rider-kyc", "/admin/settings",
      "/admin/bank-accounts", "/admin/bank-refunds", "/admin/gst-config", "/admin/shop-wallets", "/admin/rider-earnings", "/admin/finance",
    ];
    const operatorLinks = [...visibleMenus(OPERATOR_MENUS, "OPERATOR"), ...visibleMenus(ADMIN_MENUS, "OPERATOR")].flatMap((m) => [m.href, ...m.items.map((i) => i.href)]);
    for (const href of operatorLinks) {
      expect(adminOnlyRoutes).not.toContain(href.split(/[?#]/)[0]);
    }
  });
});

describe("menu definitions", () => {
  const all = Object.values(MENUS).flatMap((menus) => menus.flatMap((m) => [m, ...m.items]));

  it("match the approved menu counts", () => {
    expect(CUSTOMER_MENUS).toHaveLength(6);
    expect(CUSTOMER_CATEGORIES).toHaveLength(8);
    expect(SHOP_MENUS).toHaveLength(16);
    expect(ADMIN_MENUS).toHaveLength(9);
    expect(OPERATOR_MENUS).toHaveLength(6);
    expect(SHOP_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(39);
    expect(ADMIN_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(39);
    expect(OPERATOR_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(22);
  });

  it("label every entry in all three languages", () => {
    for (const entry of [...all, ...CUSTOMER_CATEGORIES, ...SHOP_DO_NOW, ...ADMIN_DO_NOW]) {
      for (const lang of LANGUAGES) expect(entry.label[lang].trim(), `${entry.key} ${lang}`).not.toBe("");
    }
    for (const text of [...Object.values(UI), ...Object.values(ORDER_STATUS_TEXT)]) {
      for (const lang of LANGUAGES) expect(text[lang].trim()).not.toBe("");
    }
  });

  it("use only known icons and count keys", () => {
    for (const entry of all) {
      if (entry.icon) expect(ICON_NAMES).toContain(entry.icon);
      if (entry.count) expect(COUNT_KEYS).toContain(entry.count);
    }
  });

  it("give each entry in a tile a distinct key", () => {
    for (const menus of Object.values(MENUS)) {
      expect(new Set(menus.map((m) => m.key)).size).toBe(menus.length);
      for (const menu of menus) expect(new Set(menu.items.map((i) => i.key)).size).toBe(menu.items.length);
    }
  });
});

/* ---------------------------------------------------------- route existence */

/** Every page route under src/app as segment lists ("[id]" segments match anything). */
function pageRoutes(dir = APP_DIR, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api" || name.startsWith("_")) continue;
      // Route groups "(x)" add no URL segment.
      out.push(...pageRoutes(full, /^\(.*\)$/.test(name) ? prefix : [...prefix, name]));
    } else if (name === "page.tsx") {
      out.push(prefix);
    }
  }
  return out;
}

function routeExists(href: string, routes: string[][]): boolean {
  const pathname = href.split(/[?#]/)[0];
  const segments = pathname.split("/").filter(Boolean);
  return routes.some(
    (route) =>
      route.length === segments.length &&
      route.every((seg, i) => (seg.startsWith("[") ? !segments[i].includes("{") || /^\{\w+\}$/.test(segments[i]) : seg === segments[i])),
  );
}

/** All source text under src, for checking that #anchors exist. */
function sourceText(dir = path.join(process.cwd(), "src")): string {
  return readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sourceText(full) : /\.tsx?$/.test(name) ? readFileSync(full, "utf8") : "";
    })
    .join("\n");
}

describe("board links", () => {
  const routes = pageRoutes();
  const hrefs = allDefinedHrefs();

  it("are all internal paths", () => {
    for (const href of hrefs) expect(href.startsWith("/"), href).toBe(true);
  });

  it("each point at a page that exists under src/app", () => {
    expect(existsSync(APP_DIR)).toBe(true);
    const missing = hrefs.filter((href) => !routeExists(href, routes));
    expect(missing).toEqual([]);
  });

  it("each #anchor exists as an id somewhere in the source", () => {
    const source = sourceText();
    const anchors = [...new Set(hrefs.filter((h) => h.includes("#")).map((h) => h.split("#")[1]))];
    for (const anchor of anchors) {
      const id = anchor.replace(/\{\w+\}/, "");
      const found = anchor.includes("{") ? source.includes(`id={\`${id}`) : source.includes(`id="${id}"`);
      expect(found, `#${anchor}`).toBe(true);
    }
  });

  it("detects a link to a page that does not exist", () => {
    expect(routeExists("/admin/no-such-page", routes)).toBe(false);
    expect(routeExists("/subscriptions/{subscriptionId}", routes)).toBe(true);
    expect(routeExists("/shops?delivery=true", routes)).toBe(true);
  });
});
