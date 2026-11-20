/**
 * GoKesari Seller Central's frame on every /shop page (src/app/shop/layout.tsx,
 * src/components/seller/seller-shell.tsx, src/lib/seller/nav.ts): the dark top
 * bar (shop and its status pill, "View my store", EN / हिं / मरा, notifications,
 * account menu), the sidebar of tools grouped Orders / Catalogue / Payments /
 * Growth / Account with "Find a tool", the phone's ☰ drawer, and the language
 * choice kept across pages and reloads.
 *
 * Signed tier: shop A's owner only looks; nothing is changed. The language is a
 * cookie of the check's own browser context, gone when the context closes. The
 * phone check emulates a Pixel 7 itself (one run, on the desktop project).
 */
import { pageAs } from "../lib/actors";
import { expect, need, qa } from "../lib/record";
import { phonePage, sideways } from "../lib/regression-2026-11-helpers";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const GROUPS = ["Orders", "Catalogue", "Payments", "Growth", "Account"] as const;
const PILLS = ["Live", "Pending approval", "Payment pending", "Suspended", "Rejected", "Inactive"] as const;

qa("TC-UX-007", "Seller Central frame: top bar (status pill, View my store, EN / हिं / मरा, notifications, account menu), sidebar groups, Find a tool; dashboard at 1024 px and wider", async ({ browser }) => {
  const shopA = need(world().shops.A, "shop A in this site's test data");
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 1280, height: 900 } });
  const seen: string[] = [];
  try {
    await page.goto("/shop");
    const top = page.getByTestId("seller-topbar");
    await expect(top).toBeVisible();
    const shopBox = top.getByTestId("seller-shop");
    await expect(shopBox).toContainText(shopA.name);
    const pill = shopBox.getByText(new RegExp(`^(${PILLS.join("|")})$`));
    await expect(pill, `the status pill reads one of ${PILLS.join(" / ")}`).toBeVisible();
    const pillText = (await pill.innerText()).trim();
    seen.push(`pill "${pillText}"`);

    const store = top.getByTestId("seller-visit-store");
    if (pillText === "Live") {
      await expect(store, "View my store for a Live shop").toHaveText(/View my store/);
      await expect(store).toHaveAttribute("href", /^\/shops\/[^/]+$/);
    } else {
      await expect(store, "no store link while the shop is not Live").toHaveCount(0);
    }

    const languages = top.getByTestId("language-switch");
    await expect(languages.getByRole("button")).toHaveText(["EN", "हिं", "मरा"]);
    await expect(languages.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    await expect(top.getByTestId("seller-bell"), "notifications").toBeVisible();
    await top.getByTestId("seller-account-button").click();
    const menu = page.getByTestId("seller-account-menu");
    await expect(menu).toBeVisible();
    for (const item of ["Seller Central", "Seller help", "Seller terms", "Shop on GoKesari", "Sign out"]) {
      await expect(menu.getByRole("menuitem", { name: item }), `account menu: ${item}`).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    seen.push("View my store, EN / हिं / मरा, bell and account menu");

    const sidebar = page.getByTestId("seller-sidebar");
    await expect(sidebar).toBeVisible();
    for (const group of GROUPS) await expect(sidebar.getByRole("heading", { name: group, exact: true }), `sidebar group ${group}`).toBeVisible();
    await expect(page.getByTestId("seller-home"), "the Seller Central home at 1280 px").toBeVisible();

    // Find a tool.
    const find = sidebar.getByRole("searchbox", { name: "Find a Seller Central tool" });
    await expect(find).toHaveAttribute("placeholder", "Find a tool…");
    await find.fill("zzqx no such tool");
    await expect(sidebar.getByText("No tool matches")).toBeVisible();
    await find.fill("inventory");
    const hit = sidebar.getByTestId("seller-tool-hits").getByRole("link").filter({ hasText: /^Inventory/ }).first();
    await expect(hit).toBeVisible();
    await hit.click();
    await page.waitForURL((url) => url.pathname === "/shop/inventory");
    seen.push("Find a tool: 'inventory' → /shop/inventory, nonsense → 'No tool matches'");
    // The sidebar keeps its search across pages; cleared, it lists the groups again.
    await find.fill("");

    // One menu of each group: every page keeps the frame.
    for (const group of GROUPS) {
      const first = sidebar.getByRole("region", { name: group, exact: true }).getByTestId("seller-nav-menu").first();
      const href = (await first.getAttribute("href")) ?? "";
      await first.click();
      const path = href.split(/[?#]/)[0];
      await page.waitForURL((url) => url.pathname === path);
      await expect(page.getByTestId("seller-topbar"), `${path} keeps the top bar`).toBeVisible();
      await expect(page.getByTestId("seller-sidebar"), `${path} keeps the sidebar`).toBeVisible();
      seen.push(`${group} → ${path}`);
    }

    // 1024 px is still the wide layout: dashboard, no tile board.
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto("/shop");
    await expect(page.getByTestId("seller-home"), "dashboard at 1024 px").toBeVisible();
    await expect(page.getByTestId("seller-sidebar")).toBeVisible();
    await expect(page.getByTestId("board-tile").first(), "no tile board at 1024 px").toBeHidden();
    seen.push("1024 px: dashboard + sidebar");

    if (pillText === "Live") {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/shop");
      const storeHref = (await store.getAttribute("href")) ?? "";
      await store.click();
      await page.waitForURL((url) => url.pathname === storeHref);
      seen.push(`View my store → ${storeHref}`);
    }
  } finally {
    await context.close();
  }
  return seen.join("; ");
}, signed);

qa("TC-UX-008", "Seller Central on a phone: the sidebar is a ☰ drawer, /shop shows the tile board below 1024 px, nothing overflows sideways", async ({ browser }) => {
  const { context, page } = await phonePage(browser, "shop");
  const seen: string[] = [];
  try {
    // /shop on a phone: the tile board with its own compact header; the Seller Central top bar steps aside.
    await page.goto("/shop");
    await expect(page.getByTestId("board-tile").first(), "the tile board").toBeVisible();
    await expect(page.getByTestId("seller-topbar"), "the board brings its own header").toBeHidden();
    await expect(page.getByTestId("seller-sidebar"), "no sidebar on a phone").toBeHidden();
    await expect(page.getByTestId("seller-home"), "no dashboard below 1024 px").toBeHidden();
    expect(await sideways(page), "/shop overflows sideways").toBeLessThanOrEqual(2);
    seen.push("/shop: tile board, no Seller Central bar or sidebar");

    // Any other Seller Central page: the top bar with ☰, the sidebar as a drawer.
    await page.goto("/shop/inventory");
    await expect(page.getByTestId("seller-topbar")).toBeVisible();
    await expect(page.getByTestId("seller-sidebar"), "no sidebar on a phone").toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Seller menu" });
    await expect(drawer).toBeVisible();
    for (const group of GROUPS) await expect(drawer.getByRole("heading", { name: group, exact: true })).toBeVisible();
    await drawer.getByTestId("seller-nav-menu").and(page.locator('[data-key="prices"]')).click();
    await page.waitForURL((url) => url.pathname === "/shop/prices");
    await expect(drawer, "the drawer closes after a pick").toHaveCount(0);
    expect(await sideways(page), "/shop/prices overflows sideways").toBeLessThanOrEqual(2);
    seen.push("/shop/inventory: ☰ → Seller menu → Prices (drawer closed)");

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog", { name: "Seller menu" }).getByRole("link", { name: "Home", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/shop");
    await expect(page.getByTestId("board-tile").first()).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(2);
    seen.push("☰ → Home → tile board again");

    // Just below the wide layout: still the tile board on /shop and the ☰ drawer elsewhere.
    await page.setViewportSize({ width: 1023, height: 800 });
    await page.reload();
    await expect(page.getByTestId("board-tile").first(), "tile board at 1023 px").toBeVisible();
    await expect(page.getByTestId("seller-home")).toBeHidden();
    await page.goto("/shop/prices");
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(page.getByTestId("seller-sidebar")).toBeHidden();
    seen.push("1023 px: tile board on /shop, ☰ on /shop/prices");
  } finally {
    await context.close();
  }
  return `Pixel 7: ${seen.join("; ")}; no sideways overflow`;
}, signed);

qa("TC-UX-009", "the language switch changes Seller Central to हिं, then मरा, and the choice is kept across pages and reloads", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 1280, height: 900 } });
  try {
    await page.goto("/shop");
    const sidebar = page.getByTestId("seller-sidebar");
    const languages = page.getByTestId("seller-topbar").getByTestId("language-switch");
    await expect(sidebar.getByRole("heading", { name: "Catalogue", exact: true })).toBeVisible();

    await languages.getByRole("button", { name: "हिन्दी" }).click();
    await expect(sidebar.getByRole("heading", { name: "कैटलॉग", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("heading", { name: "भुगतान", exact: true })).toBeVisible();
    await expect(sidebar.getByTestId("seller-find-tool")).toHaveAttribute("placeholder", "टूल खोजें…");
    await expect(languages.getByRole("button", { name: "हिन्दी" })).toHaveAttribute("aria-pressed", "true");

    await languages.getByRole("button", { name: "मराठी" }).click();
    await expect(sidebar.getByRole("heading", { name: "कॅटलॉग", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("heading", { name: "पेमेंट", exact: true })).toBeVisible();
    await expect(sidebar.getByTestId("seller-find-tool")).toHaveAttribute("placeholder", "साधन शोधा…");

    for (const path of ["/shop/inventory", "/shop/orders"]) {
      await page.goto(path);
      await expect(page.getByTestId("seller-sidebar").getByRole("heading", { name: "कॅटलॉग", exact: true }), `${path} in Marathi`).toBeVisible();
      await expect(page.getByTestId("seller-topbar").getByTestId("language-switch").getByRole("button", { name: "मराठी" })).toHaveAttribute("aria-pressed", "true");
    }
    await page.reload();
    await expect(page.getByTestId("seller-sidebar").getByRole("heading", { name: "कॅटलॉग", exact: true }), "after a reload").toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === "gk_lang");
    expect(cookie?.value, "the choice is stored").toBe("mr");
    const years = (cookie!.expires * 1000 - Date.now()) / (365 * 86_400_000);
    return `EN → हिं (कैटलॉग / भुगतान, "टूल खोजें…") → मरा (कॅटलॉग / पेमेंट, "साधन शोधा…"); kept on /shop/inventory, /shop/orders and after a reload; gk_lang=mr for ${years.toFixed(2)} year`;
  } finally {
    await context.close();
  }
}, signed);
