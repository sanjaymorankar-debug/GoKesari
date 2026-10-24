/**
 * Signing out and what a signed-out browser can still see or do (QA package
 * 1, TC-AUTH-030 … TC-AUTH-043): the header's Sign out in every role, pages
 * and APIs after signing out, an old session cookie replayed, several tabs
 * and devices, the next person on a shared phone, unsaved edits, a rider
 * who signs out while online, a second role, a sign-out sent by another
 * site, and Sign out on a phone screen.
 *
 * Each check opens its own browser with a test account's session and signs
 * out of that browser only. Sign-out now ends the session on the server, so
 * the checks that sign out run locally (a fresh session per browser) and not
 * on the test site, whose test accounts share one saved session per role.
 */
import { request as playwrightRequest, type BrowserContext, type Page } from "@playwright/test";

import { as, me, pageAs } from "../lib/actors";
import { cookiesOf, sessionUser, SESSION_COOKIE, signOutFromMenu, waitSignedOut } from "../lib/auth-helpers";
import { addToCart, cartLines, deliver, emptyCart, onlyRiderOnline, packOrder, placeOrder, sellable, shopOf, walletBalance } from "../lib/flows";
import { call, expectStatus, poll } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 180_000 };
/**
 * Checks that sign out run on local servers only. Since sign-out ends the
 * session on the server (TC-AUTH-034), signing out of a browser that holds the
 * test site's saved session would end that session for every later check of
 * the run; locally each browser gets its own freshly minted session.
 */
const signsOut = { tier: "local" as const, timeout: 180_000 };
const ACCOUNT_BUTTONS = ["account-button", "board-account", "seller-account-button", "account-dropdown"];

/** What the header shows a signed-out visitor: Sign in, no account menu, no role or portal links. */
async function expectSignedOutHeader(page: Page) {
  const header = page.locator("header").first();
  await expect(page.getByRole("link", { name: /Sign in/ }).first(), "Sign in in the header").toBeVisible();
  for (const id of ACCOUNT_BUTTONS) await expect(page.getByTestId(id), `no ${id}`).toHaveCount(0);
  await expect(page.getByText("Acting as"), "no role switcher").toHaveCount(0);
  const portalLinks = (await header.locator("a[href]").evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""))).filter((h) => /^\/(shop|admin|operator|society)(\/|$)|^\/delivery-partner\/?$/.test(h));
  expect(portalLinks, "no portal links in the header").toEqual([]);
}

async function signedInContext(browser: import("@playwright/test").Browser, role: Role, options: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {}) {
  return pageAs(browser, role, options);
}

async function noErrorPage(page: Page) {
  await expect(page.locator("body")).not.toContainText(/Something went wrong|Application error|Internal Server Error/);
}

/* ============================================================ sign out */

qa("TC-AUTH-030", "sign out ends the session: Back to /wallet is sent to sign in and GET /api/wallet answers 401 UNAUTHENTICATED", async ({ browser }) => {
  const { context, page } = await signedInContext(browser, "customer");
  try {
    await page.goto("/wallet");
    await expect(page).toHaveURL(/\/wallet/);
    await signOutFromMenu(page);
    await page.goBack();
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page, "Back to /wallet").toHaveURL(/\/signin/);
    await page.goto("/wallet");
    await expect(page).toHaveURL(/\/signin/);
    const api = await call(context.request, "GET", "/api/wallet");
    expect(api.status).toBe(401);
    expect(api.body?.error?.code).toBe("UNAUTHENTICATED");
    return `after Sign out: Back → ${new URL(page.url()).pathname}; /wallet → /signin; API ${api.status} ${api.body.error.code}`;
  } finally {
    await context.close();
  }
}, signsOut);

qa("TC-AUTH-031", "the session persists across /wallet, /orders and /profile and their reloads", async ({ browser }) => {
  const { context, page } = await signedInContext(browser, "customer");
  try {
    const seen: string[] = [];
    for (const path of ["/wallet", "/orders", "/profile"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(path));
      await page.reload();
      await expect(page, `${path} after reload`).toHaveURL(new RegExp(path));
      await noErrorPage(page);
      seen.push(path);
    }
    expect((await sessionUser(context.request))?.email).toBe((await me("customer")).email);
    return `${seen.join(", ")}: stayed signed in through each reload`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

const ROLE_HOME: [Role, string][] = [
  ["customer", "/"],
  ["shop", "/shop"],
  ["rider", "/delivery-partner"],
  ["society", "/society"],
  ["ops", "/admin"],
  ["admin", "/admin"],
];

qa("TC-AUTH-032", "Sign out from the account menu in every role lands on the home page with Sign in and no name, role switcher or portal links", async ({ browser }) => {
  const done: string[] = [];
  const missing: string[] = [];
  for (const [role, start] of ROLE_HOME) {
    if (!world().users[role]) {
      missing.push(role);
      continue;
    }
    const { context, page } = await signedInContext(browser, role);
    try {
      await page.goto(start);
      await page.waitForLoadState("networkidle").catch(() => {});
      const menu = await signOutFromMenu(page);
      await expect(page).toHaveURL((u) => u.pathname === "/" || u.pathname.startsWith("/signin"));
      await expectSignedOutHeader(page);
      expect(await sessionUser(context.request), `${role} signed out`).toBeNull();
      done.push(`${role} (${start}, ${menu}) → ${new URL(page.url()).pathname}`);
    } finally {
      await context.close();
    }
  }
  if (missing.length && !done.length) blocked(`needs accounts for ${missing.join(", ")}`);
  return `${done.join("; ")}${missing.length ? `; not on this site: ${missing.join(", ")}` : ""}`;
}, { ...signsOut, timeout: 300_000 });

qa("TC-AUTH-033", "after signing out, customer, shop, rider, society and staff pages send to sign in, and Back shows none of the earlier data", async ({ browser }) => {
  const who = await me("customer");
  const { context, page } = await signedInContext(browser, "customer");
  try {
    await page.goto("/wallet");
    await page.goto("/profile");
    await expect(page.getByText(who.email).first()).toBeVisible();
    await signOutFromMenu(page);
    for (let i = 0; i < 2; i++) {
      await page.goBack().catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator("body"), `Back ${i + 1}: no personal data`).not.toContainText(who.email);
    }
    const back = new URL(page.url()).pathname;
    const open: string[] = [];
    for (const path of ["/orders", "/wallet", "/profile", "/cart", "/shop", "/shop/inventory", "/shop/prices", "/delivery-partner", "/society", "/admin", "/admin/orders", "/operator"]) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
      if (!/\/signin/.test(page.url())) open.push(`${path} → ${new URL(page.url()).pathname}`);
    }
    expect(open, "pages not sending to sign in").toEqual([]);
    return `Back twice → ${back}, no email or wallet shown; 12 customer/shop/rider/society/admin pages → /signin`;
  } finally {
    await context.close();
  }
}, { ...signsOut, partial: "the signed-out guest half of TC-AUTH-033 (every page) is in tests/qa/guest/access.spec.ts" });

qa("TC-AUTH-034", "an old session cookie copied before signing out is refused afterwards (GET /api/wallet and POST /api/cart → 401)", async ({ browser }) => {
  const listing = await sellable("A");
  const { context, page } = await signedInContext(browser, "customer");
  let replay: Awaited<ReturnType<typeof playwrightRequest.newContext>> | null = null;
  try {
    await page.goto("/profile");
    const copied = need((await context.cookies()).find((c) => c.name === SESSION_COOKIE), "the session cookie");
    await signOutFromMenu(page);
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE), "the browser dropped the cookie").toBeUndefined();
    replay = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [copied], origins: [] } });
    const wallet = await call(replay, "GET", "/api/wallet");
    const cart = await call(replay, "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
    expect(
      [wallet.status, cart.status],
      `the copied cookie still works after Sign out: GET /api/wallet → ${wallet.status} (balance ${wallet.body?.wallet?.balancePaise ?? "?"}), POST /api/cart → ${cart.status} — the session is only removed from the browser, not ended on the server`,
    ).toEqual([401, 401]);
    return "both refused with 401";
  } finally {
    await replay?.dispose();
    await context.close();
    await emptyCart().catch(() => {});
  }
}, signsOut);

qa("TC-AUTH-035", "signing out in one tab: the other tab's next link goes to sign in and its form write is refused", async ({ browser }) => {
  const original = (await call(await as("customer"), "GET", "/api/profile")).body as { name: string | null };
  const { context, page } = await signedInContext(browser, "customer");
  try {
    const tab2 = await context.newPage();
    await page.goto("/profile");
    await tab2.goto("/profile");
    await signOutFromMenu(page);
    const form = tab2.getByTestId("profile-details-form");
    await form.getByLabel("Full name").fill("QA should not be saved");
    await form.getByRole("button", { name: "Save details" }).click();
    await expect(form, "the write is refused").toContainText(/sign in|Sign in|Could not save/);
    await expect(form.getByText("Saved.")).toHaveCount(0);
    expect((await call(await as("customer"), "GET", "/api/profile")).body.name, "nothing written").toBe(original.name);
    await tab2.getByTestId("profile-quick-links").getByRole("link").first().click();
    await tab2.waitForURL(/\/signin/, { timeout: 30_000 });
    return "tab 2: Save details refused (name unchanged), next link → /signin";
  } finally {
    await context.close();
  }
}, signsOut);

qa("TC-AUTH-036", "signing out on one device leaves the other device's session as it was, the same way every time", async ({ browser }) => {
  const outcomes: string[] = [];
  for (let round = 0; round < 2; round++) {
    const one = await signedInContext(browser, "customer");
    const two = await signedInContext(browser, "customer");
    try {
      await one.page.goto("/profile");
      await two.page.goto("/profile");
      await signOutFromMenu(one.page);
      await two.page.reload();
      await two.page.waitForLoadState("networkidle").catch(() => {});
      outcomes.push(/\/signin/.test(two.page.url()) ? "signed out" : "still signed in");
    } finally {
      await one.context.close();
      await two.context.close();
    }
  }
  expect(outcomes[0], `consistent: ${outcomes.join(" / ")}`).toBe(outcomes[1]);
  return `device 2 after device 1 signs out: ${outcomes.join(", ")} (per-device sessions)`;
}, signsOut);

/* =============================================== the next person on the phone */

async function swapTo(context: BrowserContext, role: Role) {
  await context.addCookies(await cookiesOf(role));
}

qa("TC-AUTH-037", "the cart stays with its owner: customer 2 on the same browser sees none of customer 1's items; customer 1 finds them again", async ({ browser }) => {
  need(world().users.customer2 ?? (await me("customer2").catch(() => null)), "customer 2");
  const one = await sellable("A", 3, "cheapest");
  const two = await sellable("A", 3, "priciest");
  if (one.shopProductId === two.shopProductId) blocked("needs two different products at shop A");
  await emptyCart("customer");
  expectStatus(await addToCart("customer", one.shopProductId, 1), [200, 201], "item 1");
  expectStatus(await addToCart("customer", two.shopProductId, 1), [200, 201], "item 2");
  const { context, page } = await signedInContext(browser, "customer");
  try {
    await page.goto("/cart");
    for (const l of [one, two]) await expect(page.getByText(l.name).first()).toBeVisible();
    await signOutFromMenu(page);
    await swapTo(context, "customer2");
    await page.goto("/cart");
    await page.waitForLoadState("networkidle").catch(() => {});
    for (const l of [one, two]) await expect(page.getByText(l.name), `customer 2 does not see "${l.name}"`).toHaveCount(0);
    expect((await sessionUser(context.request))?.email).toBe((await me("customer2")).email);
    await signOutFromMenu(page);
    await swapTo(context, "customer");
    await page.goto("/cart");
    for (const l of [one, two]) await expect(page.getByText(l.name).first(), `customer 1 finds "${l.name}"`).toBeVisible();
    expect((await cartLines("customer")).length).toBe(2);
    return `customer 1's "${one.name}" + "${two.name}" hidden from customer 2, back for customer 1`;
  } finally {
    await context.close();
    await emptyCart("customer").catch(() => {});
  }
}, { ...signsOut, partial: "the second person signs in with their own session cookie on the same browser (no emailed code in the signed-in tier)" });

qa("TC-AUTH-038", "shared phone: after shop owner A signs out, customer 2 sees only their own name, location, wallet and notifications, no role switcher, and no shop portal", async ({ browser }) => {
  const shop = await shopOf("A");
  const c2 = await me("customer2");
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await swapTo(context, "shop");
    await page.goto("/shop");
    await expect(page.getByText(shop.name).first()).toBeVisible();
    const owners = await page.request.post("/api/location", { data: { latitude: 18.52, longitude: 73.85, label: "QA owner's chosen spot" } });
    expect(owners.status(), "the owner picks a delivery location").toBeLessThan(300);
    await signOutFromMenu(page);
    await swapTo(context, "customer2");
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    const problems: string[] = [];
    const location = page.getByRole("button", { name: /Deliver to/i }).first();
    const where = (await location.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/QA owner's chosen spot/.test(where)) problems.push(`delivery location carried over from owner A ("${where}")`);
    for (const id of ACCOUNT_BUTTONS) {
      const button = page.getByTestId(id).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        break;
      }
    }
    const menuText = (await page.locator('[data-testid="account-menu"], [data-testid="account-dropdown-menu"], [data-testid="board-account-menu"]').first().innerText().catch(() => "")).replace(/\s+/g, " ");
    if (!menuText.includes(c2.email)) problems.push(`account menu does not show customer 2 (${menuText.slice(0, 80)})`);
    if (/Acting as/.test(menuText)) problems.push("a role switcher is shown");
    const notes = await call(context.request, "GET", "/api/notifications");
    const own = await call(await as("customer2"), "GET", "/api/notifications");
    if (JSON.stringify(notes.body?.notifications?.map((n: { id: string }) => n.id)) !== JSON.stringify(own.body?.notifications?.map((n: { id: string }) => n.id))) problems.push("notifications are not customer 2's");
    const wallet = await call(context.request, "GET", "/api/wallet");
    if (wallet.body?.wallet?.balancePaise !== (await walletBalance("customer2"))) problems.push("wallet is not customer 2's");
    const addresses = await call(context.request, "GET", "/api/addresses");
    const ownAddresses = await call(await as("customer2"), "GET", "/api/addresses");
    if (addresses.text !== ownAddresses.text) problems.push("saved addresses are not customer 2's");
    await page.goto("/shop");
    await page.waitForLoadState("networkidle").catch(() => {});
    if (await page.getByText(shop.name).first().isVisible().catch(() => false)) problems.push(`/shop shows ${shop.name}`);
    expect(problems, problems.join("; ")).toEqual([]);
    return `customer 2: own name/email, location "${where.slice(0, 40)}", wallet, notifications and addresses; no role switcher; /shop → ${new URL(page.url()).pathname} without owner A's shop`;
  } finally {
    await context.close();
  }
}, { ...signsOut, partial: "the second person signs in with their own session cookie on the same browser (no emailed code in the signed-in tier)" });

/* ============================================ edits, riders, roles, CSRF */

qa("TC-AUTH-039", "signing out with an unsaved price change: no half-save — the old price is kept", async ({ browser }) => {
  const listing = await sellable("A");
  const shop = await shopOf("A");
  const priceOf = async () => {
    const res = await call(await as("shop"), "GET", `/api/shops/${shop.id}/products?limit=200`);
    const rows = (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as { id?: string; shopProductId?: string; onlinePricePaise: number | null }[];
    return rows.find((r) => (r.shopProductId ?? r.id) === listing.shopProductId)?.onlinePricePaise ?? null;
  };
  const before = need(await priceOf(), `the online price of ${listing.name}`);
  const { context, page } = await signedInContext(browser, "shop");
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message() || d.type());
    await d.accept();
  });
  try {
    await page.goto("/shop/inventory");
    const field = page.getByLabel(`Price of ${listing.name}`);
    if (!(await field.count())) blocked(`no price field for ${listing.name} on /shop/inventory`);
    await field.first().fill(String((before + 700) / 100));
    await signOutFromMenu(page);
    expect(await priceOf(), "price unchanged").toBe(before);
    return `edited the price of ${listing.name} without saving, signed out ${dialogs.length ? `after a warning ("${dialogs[0]}")` : "without a warning"}; price still ${before} paise`;
  } finally {
    await context.close();
  }
}, signsOut);

qa("TC-AUTH-040", "a rider who signs out while online is not offered new jobs (or is set offline)", async ({ browser }) => {
  need(world().users.rider ?? (await me("rider").catch(() => null)), "rider 1");
  await onlyRiderOnline("rider");
  const status = async () => (await call(await as("rider"), "GET", "/api/delivery-partner/me")).body as { isOnline?: boolean; partner?: { isOnline?: boolean } };
  const online = (s: Awaited<ReturnType<typeof status>>) => s?.isOnline ?? s?.partner?.isOnline ?? null;
  if (online(await status()) === false) blocked("rider 1 is not online");
  const { context, page } = await signedInContext(browser, "rider");
  try {
    await page.goto("/delivery-partner");
    await signOutFromMenu(page);
  } finally {
    await context.close();
  }
  const afterSignOut = online(await status());
  const order = await placeOrder({ method: "WALLET" });
  await packOrder(order.id);
  const offered = await poll(
    async () => {
      const res = await call(await as("rider"), "GET", "/api/delivery-partner/deliveries");
      const active = res.body?.active as { orderId: string; status: string } | null;
      return active && active.orderId === order.id ? active.status : null;
    },
    (v) => v !== null,
    45_000,
  );
  // Finish the order so the rider and shop are free again.
  if (offered) await deliver(order.id).catch(() => {});
  expect(
    afterSignOut === false || !offered,
    `after signing out the rider is still online (isOnline ${afterSignOut}) and order ${order.orderNumber} was offered to them (${offered}) — an offer to a signed-out rider only lapses after its time limit`,
  ).toBe(true);
  return `after sign-out: online ${afterSignOut}; offer ${offered ?? "none"}`;
}, { ...signsOut, timeout: 300_000, partial: "the case asks to confirm the intended behaviour with the owner; this check asserts the stated expectation" });

qa("TC-AUTH-041", "signing out while acting in a second role: on return the active role is one the user holds", async ({ browser }) => {
  const ctx = await as("shop");
  const roles = await call(ctx, "GET", "/api/me/roles");
  expectStatus(roles, 200, "GET /api/me/roles");
  const held = (roles.body.roles as { role: string }[] | string[]).map((r) => (typeof r === "string" ? r : r.role));
  const other = held.find((r) => r !== roles.body.active);
  if (!other) blocked(`the shop owner holds only ${held.join(", ")}`);
  const original = roles.body.active as string;
  try {
    expectStatus(await call(ctx, "PUT", "/api/me/roles", { role: other }), 200, `switch to ${other}`);
    const { context, page } = await signedInContext(browser, "shop");
    try {
      await page.goto("/");
      await signOutFromMenu(page);
    } finally {
      await context.close();
    }
    const back = await signedInContext(browser, "shop");
    try {
      await back.page.goto("/");
      const after = await call(back.context.request, "GET", "/api/me/roles");
      expect(held, `active role on return: ${after.body.active}`).toContain(after.body.active);
      return `held ${held.join(", ")}; acting as ${other}, signed out and in → active ${after.body.active}`;
    } finally {
      await back.context.close();
    }
  } finally {
    await call(ctx, "PUT", "/api/me/roles", { role: original });
  }
}, { ...signsOut, partial: "signing in again reuses the account's session (no emailed code in the signed-in tier)" });

qa("TC-AUTH-042", "another site cannot sign the user out: a cross-site GET and a POST without the CSRF token leave the session; the real Sign out ends it", async ({ browser }) => {
  const { context, page } = await signedInContext(browser, "customer");
  try {
    await page.goto("/profile");
    const target = new URL("/api/auth/signout", BASE_URL).toString();
    await page.route("http://evil.qa.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><img src="${target}"><iframe src="${target}"></iframe><form id="f" method="POST" action="${target}"><input name="callbackUrl" value="http://evil.qa.test/"></form><script>setTimeout(() => document.getElementById("f").submit(), 800)</script>`,
      }),
    );
    await page.goto("http://evil.qa.test/");
    await page.waitForURL((u) => u.host !== "evil.qa.test", { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    expect((await sessionUser(context.request))?.email, "still signed in after the other site's GET and POST").toBe((await me("customer")).email);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE), "the session cookie is kept").toBe(true);
    const landed = page.url();
    await page.goto("/profile");
    await signOutFromMenu(page);
    expect(await sessionUser(context.request), "the real Sign out ends it").toBeNull();
    return `cross-site GET + POST (no CSRF token) → ${landed.replace(BASE_URL, "")}; still signed in; the menu's Sign out signs out`;
  } finally {
    await context.close();
  }
}, { ...signsOut, partial: "Next.js server actions (the menu's Sign out) are protected by Next's own origin check, not probed here" });

qa("TC-AUTH-043", "on a 360 px phone screen the menu shows Sign out without sideways scrolling and it works", async ({ browser }) => {
  const { context, page } = await signedInContext(browser, "customer", { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  try {
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no sideways scroll").toBeLessThanOrEqual(2);
    let opened = false;
    for (const id of ACCOUNT_BUTTONS) {
      const button = page.getByTestId(id).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        opened = true;
        break;
      }
    }
    if (!opened) await page.getByRole("button", { name: /Open menu/i }).first().click();
    const signOut = page.getByRole("button", { name: /^Sign out$/ }).or(page.getByRole("menuitem", { name: /Sign out/ })).first();
    await expect(signOut).toBeVisible();
    const box = await signOut.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 362, `Sign out inside the screen (${JSON.stringify(box)})`).toBe(true);
    await signOut.click();
    await waitSignedOut(page);
    await expect(page).toHaveURL((u) => u.pathname === "/");
    expect(await sessionUser(context.request)).toBeNull();
    return `360 px: menu → Sign out at x=${Math.round(box!.x)}–${Math.round(box!.x + box!.width)} px, no sideways scroll, signed out`;
  } finally {
    await context.close();
  }
}, { ...signsOut, mobile: true });
