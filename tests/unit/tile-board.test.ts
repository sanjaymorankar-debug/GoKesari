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
  DO_NOW,
  hubHref,
  OPERATOR_DO_NOW,
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
import { categoryEmoji, priceUnitLabel } from "@/lib/board/product-look";
import { paginate } from "@/components/board/list-tabs";
import { IN_PROGRESS_ORDER_STATUSES, pickTab, SHOP_ORDER_TABS } from "@/lib/board/status-groups";
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
    expect(menus.reduce((n, m) => n + m.items.length, 0)).toBe(19);
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
    const operatorLinks = [
      ...[...visibleMenus(OPERATOR_MENUS, "OPERATOR"), ...visibleMenus(ADMIN_MENUS, "OPERATOR")].flatMap((m) => [m.href, ...m.items.map((i) => i.href), ...m.more.map((i) => i.href)]),
      ...visibleItems(OPERATOR_DO_NOW, "OPERATOR").map((i) => i.href),
    ];
    for (const href of operatorLinks) {
      expect(adminOnlyRoutes).not.toContain(href.split(/[?#]/)[0]);
    }
  });
});

describe("menu definitions", () => {
  const all = Object.values(MENUS).flatMap((menus) => menus.flatMap((m) => [m, ...m.items, ...(m.more ?? [])]));

  it("match the approved menu counts", () => {
    expect(CUSTOMER_MENUS).toHaveLength(6);
    expect(CUSTOMER_CATEGORIES).toHaveLength(8);
    expect(SHOP_MENUS).toHaveLength(16);
    expect(ADMIN_MENUS).toHaveLength(9);
    // The brief's six operator menus plus "Catalogue", the one home for the catalogue tools operators already had.
    expect(OPERATOR_MENUS.map((m) => m.key)).toEqual(["onboarding", "orderSupport", "riders", "societies", "vouchers", "tickets", "catalogue"]);
    expect(SHOP_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(39);
    expect(ADMIN_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(39);
    expect(OPERATOR_MENUS.reduce((n, m) => n + m.items.length, 0)).toBe(26);
  });

  it("keep every group to at most seven entries on the board (Hick's law)", () => {
    for (const menus of Object.values(MENUS)) {
      expect(menus.length).toBeLessThanOrEqual(16);
      for (const menu of menus) expect(menu.items.length, menu.key).toBeLessThanOrEqual(7);
    }
    for (const strip of Object.values(DO_NOW)) expect(strip.length).toBeLessThanOrEqual(4);
  });

  it("label every entry in all three languages", () => {
    for (const entry of [...all, ...CUSTOMER_CATEGORIES, ...Object.values(DO_NOW).flat()]) {
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
      for (const menu of menus) {
        const keys = [...menu.items, ...(menu.more ?? [])].map((i) => i.key);
        expect(new Set(keys).size, menu.key).toBe(keys.length);
      }
    }
  });
});

/* ------------------------------------------- one clear path to each function */

describe("one clear path", () => {
  /** The flat role menus the old site header carried (removed in favour of the boards). */
  const OLD_ROLE_MENUS: Record<"SHOP_OWNER" | "OPERATOR" | "ADMIN", string[]> = {
    SHOP_OWNER: [
      "/shop", "/shop/orders", "/shop/returns", "/shop/disputes", "/shop/inventory", "/shop/catalogue", "/shop/media-import",
      "/shop/staff", "/shop/product-categories", "/product-categories", "/shop/prices", "/shop/finance", "/shop/wallet",
      "/shop/delivery-staff", "/shop/legal-documents", "/shop/bank-account", "/shop/settings/integrations", "/shop/gst-returns",
      "/shop/marketing", "/shop/offers", "/shop/analytics",
    ],
    OPERATOR: [
      "/admin", "/admin/dashboard", "/admin/orders", "/admin/exceptions", "/admin/shops", "/admin/product-master", "/product-categories",
      "/admin/shop-categories", "/admin/mrp", "/admin/price-references", "/admin/finance/exceptions", "/admin/returns",
      "/admin/image-moderation", "/admin/suspensions", "/admin/societies", "/admin/ratings", "/admin/analytics", "/admin/campaigns",
      "/admin/risk", "/admin/consents", "/admin/disputes", "/admin/cod", "/admin/legal-documents", "/admin/referral-requests",
      "/admin/integrations", "/admin/self-registration",
    ],
    ADMIN: [
      "/admin", "/admin/dashboard", "/admin/orders", "/admin/exceptions", "/admin/shops", "/admin/product-master", "/product-categories",
      "/admin/shop-categories", "/admin/mrp", "/admin/price-references", "/admin/finance", "/admin/shop-wallets", "/admin/returns",
      "/admin/suspensions", "/admin/rider-earnings", "/admin/settings", "/admin/gst-config", "/admin/integrations", "/admin/self-registration",
      "/admin/societies", "/admin/ratings", "/admin/analytics", "/admin/campaigns", "/admin/risk", "/admin/consents", "/admin/disputes",
      "/admin/cod", "/admin/coupons", "/admin/delivery-slots", "/admin/image-moderation", "/admin/rider-changes", "/admin/rider-kyc",
      "/admin/customer-referrals", "/admin/status-changes", "/admin/subscriptions", "/admin/legal-documents", "/admin/referral-requests",
      "/admin/bank-accounts", "/admin/bank-refunds",
    ],
  };
  /** The sections of the old one-page admin console, each now its own page. */
  const CONSOLE_SECTIONS = [
    "shops", "overview", "compliance", "maps", "riders", "grievances", "price-approvals", "product-approvals",
    "registration-fees", "referral-codes", "users", "vouchers", "audit-log",
  ];
  /** The sections of the old one-page shop dashboard, each now its own page. */
  const SHOP_SECTIONS = ["today", "products", "location", "hours", "gst-pan", "shop-types", "registration"];

  /** Every page a role reaches in at most two clicks: board entries (one click) and menu pages' entries (two). */
  function reachable(role: "SHOP_OWNER" | "OPERATOR" | "ADMIN"): Set<string> {
    const board = role === "SHOP_OWNER" ? "shop" : role === "ADMIN" ? "admin" : "operator";
    const menus = visibleMenus(MENUS[board], role, { shopSlug: "s" }, board);
    const page = (h: string) => h.split(/[?#]/)[0];
    const home = board === "shop" ? "/shop" : "/admin";
    return new Set(
      [home, ...menus.flatMap((m) => [m.href, ...m.items.map((i) => i.href), ...m.more.map((i) => i.href)]), ...visibleItems(DO_NOW[board], role).map((i) => i.href)].map(page),
    );
  }

  it("keeps every destination of the old role menus within two clicks of the board", () => {
    for (const role of ["SHOP_OWNER", "OPERATOR", "ADMIN"] as const) {
      const can = reachable(role);
      const missing = OLD_ROLE_MENUS[role].filter((href) => !can.has(href));
      expect(missing, role).toEqual([]);
    }
  });

  it("gives every old console and dashboard section its own page, reachable from a board", () => {
    const admin = reachable("ADMIN");
    const operator = reachable("OPERATOR");
    for (const key of CONSOLE_SECTIONS) {
      expect(admin.has(`/admin/console/${key}`) || operator.has(`/admin/console/${key}`), key).toBe(true);
    }
    const shop = reachable("SHOP_OWNER");
    for (const key of SHOP_SECTIONS) expect(shop.has(`/shop/manage/${key}`), key).toBe(true);
    const consoleSource = readFileSync(path.join(APP_DIR, "admin/console/[section]/page.tsx"), "utf8");
    for (const key of CONSOLE_SECTIONS) expect(consoleSource.includes(`case "${key}"`), key).toBe(true);
    const shopSource = readFileSync(path.join(APP_DIR, "shop/manage/[section]/page.tsx"), "utf8");
    for (const key of SHOP_SECTIONS) expect(shopSource.includes(`case "${key}"`), key).toBe(true);
  });

  it("opens hub tiles on their menu page and page tiles on their own page", () => {
    const shop = visibleMenus(SHOP_MENUS, "SHOP_OWNER", { shopSlug: "s" }, "shop");
    expect(shop.find((m) => m.key === "orders")?.href).toBe("/shop/orders");
    expect(shop.find((m) => m.key === "finance")?.href).toBe("/shop/menu/finance");
    expect(hubHref("operator", "tickets")).toBe("/admin/menu/tickets");
    expect(hubHref("customer", "shops")).toBeNull();
    for (const m of visibleMenus(ADMIN_MENUS, "ADMIN", {}, "admin")) expect(m.href).toBe(`/admin/menu/${m.key}`);
  });

  it("never shows an operator an admin-only page inside a menu page either", () => {
    for (const m of visibleMenus(OPERATOR_MENUS, "OPERATOR", {}, "operator")) {
      for (const i of m.more) expect(isPermitted(i, "OPERATOR")).toBe(true);
    }
  });
});

/* ---------------------------------------------------------- lists and words */

describe("list tabs and paging", () => {
  it("count the same statuses as the board badges", () => {
    expect(SHOP_ORDER_TABS.new).toEqual(["CONFIRMED"]);
    expect(IN_PROGRESS_ORDER_STATUSES).toEqual(["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"]);
  });

  it("read a tab leniently", () => {
    expect(pickTab("packing", ["new", "packing"] as const, "new")).toBe("packing");
    expect(pickTab("PACKING", ["new", "packing"] as const, "new")).toBe("new");
    expect(pickTab(["packing", "new"], ["new", "packing"] as const, "new")).toBe("packing");
    expect(pickTab(undefined, ["new"] as const, "new")).toBe("new");
  });

  it("page through a list, clamping a page out of range", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(paginate(items, "1", 5)).toEqual({ rows: [0, 1, 2, 3, 4], page: 1, pageCount: 3 });
    expect(paginate(items, "3", 5).rows).toEqual([10, 11]);
    expect(paginate(items, "99", 5).page).toBe(3);
    expect(paginate(items, "abc", 5).page).toBe(1);
    expect(paginate([], undefined, 5)).toEqual({ rows: [], page: 1, pageCount: 1 });
  });
});

describe("product wording", () => {
  it("never prices a pack per millilitre or gram", () => {
    expect(priceUnitLabel("ml")).toBe("per pack");
    expect(priceUnitLabel("g")).toBe("per pack");
    expect(priceUnitLabel("L")).toBe("/ L");
    expect(priceUnitLabel("kg")).toBe("/ kg");
    expect(priceUnitLabel("piece")).toBe("each");
    expect(priceUnitLabel(null)).toBe("each");
  });

  it("picks a category picture for a product with no photo", () => {
    expect(categoryEmoji("Dairy", "Cow Milk")).toBe("🥛");
    expect(categoryEmoji("Bakery")).toBe("🍞");
    expect(categoryEmoji("Something else")).toBe("🛍️");
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
