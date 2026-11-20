/**
 * Retests of the fixes released to staging 09–20 Nov 2026 that need a signed-in
 * account (R2, PR #416 "R2 quick fixes", and PR #383 for D-147):
 *
 *   D-148  a phone's address card stacks, so the delete confirmation fits and works
 *   D-149  the app prompt sits above the bottom menu and the View cart bar; the page end is clear
 *   D-109  an unknown or malformed packing slip answers a real 404
 *   D-142  a full operator opening an /operator page lands on the matching admin page
 *   D-139  a "Verified" board entry reads "Not verified" when it is not
 *   D-140  an approved rider with checks left is told how many and which
 *   D-146  the inventory table is a keyboard-focusable, scrollable region
 *   D-147  "Packed — mark ready" waits for the customer's answer on a substitute
 *
 * Signed tier: the test accounts on their own data (two addresses made and
 * removed, one cart line, one wallet order cancelled afterwards). The phone
 * checks emulate a Pixel 7 themselves (one run, on the desktop project).
 */
import { as, me, pageAs } from "../lib/actors";
import { addToCart, emptyCart, sellable, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { abandon, checkoutLines, ensureWallet, fulfil, listingOf, orderRow, shopAct, shopCard } from "../lib/orders-helpers";
import { blocked, expect, need, qa } from "../lib/record";
import { insideScreenWidth, phonePage, sideways } from "../lib/regression-2026-11-helpers";
import { NO_SUCH_ID } from "../lib/routes";
import { listAddresses, withAddresses } from "../lib/shopping-helpers";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };

/* ------------------------------------------------------------------ D-148 */

qa("TC-RGR-001", "D-148: on a phone the address card stacks, so 'Delete this address? / Yes, delete / Keep' fits on screen and both buttons work", async ({ browser }) => {
  return withAddresses("customer", [{ label: `QA D148 keep ${RUN}` }, { label: `QA D148 delete ${RUN}` }], async ([kept, gone]) => {
    const { context, page } = await phonePage(browser, "customer");
    try {
      await page.goto("/profile/addresses");
      // The app prompt is D-149's subject; here it is put away so it covers nothing.
      const notNow = page.getByTestId("app-install-not-now");
      if (await notNow.isVisible({ timeout: 5_000 }).catch(() => false)) await notNow.click();
      // The card: the innermost block holding this address and its Edit button.
      const card = page
        .locator("div")
        .filter({ has: page.getByText(gone.line1, { exact: true }) })
        .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) })
        .last();
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      const ask = card.getByRole("group", { name: "Delete this address?" });
      await expect(ask).toBeVisible();
      const parts = [ask.getByText("Delete this address?", { exact: true }), ask.getByRole("button", { name: "Yes, delete" }), ask.getByRole("button", { name: "Keep" })];
      const boxes: string[] = [];
      for (const part of parts) {
        const fit = await insideScreenWidth(page, part);
        expect(fit.inside, `${await part.innerText()} lies inside the screen (${fit.left}–${fit.right} of ${fit.width} px)`).toBe(true);
        boxes.push(`${fit.left}–${fit.right}`);
      }
      expect(await sideways(page), "the page does not overflow sideways").toBeLessThanOrEqual(2);
      await ask.getByRole("button", { name: "Keep" }).click();
      await expect(ask).toHaveCount(0);
      await expect(page.getByText(gone.line1, { exact: true }), "Keep leaves the address").toBeVisible();
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      await card.getByRole("group", { name: "Delete this address?" }).getByRole("button", { name: "Yes, delete" }).click();
      await expect(page.getByText(gone.line1, { exact: true }), "Yes, delete removes it").toHaveCount(0);
      await expect(page.getByText(kept.line1, { exact: true }), "the other address stays").toBeVisible();
      expect((await listAddresses("customer")).some((a) => a.id === gone.id), "deleted on the server").toBe(false);
      return `Pixel 7 ${page.viewportSize()!.width} px: question, Yes, delete and Keep at ${boxes.join(", ")} px; Keep kept it, Yes, delete removed it`;
    } finally {
      await context.close();
    }
  });
}, signed);

/* ------------------------------------------------------------------ D-149 */

qa("TC-RGR-003", "D-149: with items in the cart, the app prompt sits above the bottom menu and the View cart bar, and the end of a shop page is not hidden behind them", async ({ browser }) => {
  const listing = await sellable("A", 2);
  const shop = await shopOf("A");
  await emptyCart("customer");
  expectStatus(await addToCart("customer", listing.shopProductId, 1), [200, 201], "an item in the cart");
  const { context, page } = await phonePage(browser, "customer");
  try {
    await page.goto(`/shops/${shop.slug}`);
    const prompt = page.getByTestId("app-install-prompt");
    if (!(await prompt.isVisible({ timeout: 15_000 }).catch(() => false))) blocked("the 'Get the GoKesari app' prompt does not show for this account on an Android phone (the account records the app as installed?)");
    const nav = page.getByTestId("mobile-shop-nav");
    if (!(await nav.count())) blocked("the phone bottom menu is off on this site (rule homeDiscovery)");
    const cartBar = nav.getByTestId("floating-cart");
    await expect(cartBar, "the View cart bar").toBeVisible();
    await expect(cartBar).toContainText("View cart");
    const p = (await prompt.boundingBox())!;
    const c = (await cartBar.boundingBox())!;
    const m = (await nav.getByRole("navigation").boundingBox())!;
    expect(p.y + p.height, "the prompt ends above the View cart bar").toBeLessThanOrEqual(c.y + 1);
    expect(c.y + c.height, "the View cart bar sits above the bottom menu").toBeLessThanOrEqual(m.y + 1);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(800);
    const footer = (await page.getByTestId("site-footer").boundingBox())!;
    const promptNow = (await prompt.boundingBox())!;
    expect(footer.y + footer.height, "scrolled to the end, the page's last block ends above the prompt").toBeLessThanOrEqual(promptNow.y + 1);
    return `Pixel 7 /shops/${shop.slug}: prompt ${Math.round(p.y)}–${Math.round(p.y + p.height)}, View cart ${Math.round(c.y)}–${Math.round(c.y + c.height)}, bottom menu from ${Math.round(m.y)}; at the end the footer ends at ${Math.round(footer.y + footer.height)} ≤ prompt top ${Math.round(promptNow.y)}`;
  } finally {
    await context.close();
    await emptyCart("customer");
  }
}, signed);

/* ------------------------------------------------------------------ D-109 */

qa("TC-RGR-006", "D-109: a packing slip with an unknown or a malformed order id answers a real 404 page", async ({ browser }) => {
  const shop = await as("shop");
  const seen: string[] = [];
  for (const id of [NO_SUCH_ID, "not-an-order-id"]) {
    const path = `/shop/orders/${id}/packing-slip`;
    const res = await call(shop, "GET", path);
    expect(res.status, `${path} as shop A's owner`).toBe(404);
    // The not-found UI is streamed into Next's error shell, so it is checked in the browser below.
    expect(res.text).not.toContain('data-testid="packing-slip"');
    seen.push(`${id === NO_SUCH_ID ? "unknown" : "malformed"} id → 404`);
  }
  const { context, page } = await pageAs(browser, "shop");
  try {
    for (const id of [NO_SUCH_ID, "not-an-order-id"]) {
      const res = await page.goto(`/shop/orders/${id}/packing-slip`);
      expect(res?.status(), `${id} in the browser`).toBe(404);
      await expect(page.getByTestId("not-found-state")).toBeVisible();
      await expect(page.getByTestId("packing-slip")).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
  return `${seen.join("; ")}; the browser shows the not-found page for both`;
}, signed);

/* ------------------------------------------------------------------ D-142 */

const OPERATOR_LINKS: [string, string][] = [
  ["/operator", "/admin"],
  ["/operator/shops", "/admin/shops"],
  [`/operator/shops/${NO_SUCH_ID}`, `/admin/shops/${NO_SUCH_ID}`],
  ["/operator/documents", "/admin/document-uploads"],
  ["/operator/onboard", "/admin/shop-registrations"],
  ["/operator/payments", "/admin/console/registration-fees"],
];

qa("TC-RGR-007", "D-142: a full operator opening an /operator page lands on the matching admin page; an admin is never sent to the customer home", async ({ browser }) => {
  const ops = await me("ops");
  if (ops.role !== "OPERATOR") blocked(`the ops account acts as ${ops.role}, not OPERATOR`);
  const seen: string[] = [];
  for (const [from, to] of OPERATOR_LINKS) {
    const res = await call(await as("ops"), "GET", from);
    expect(res.status, `ops: ${from}`).toBe(307);
    expect(new URL(res.location ?? "", "http://x").pathname, `ops: ${from} goes to`).toBe(to);
  }
  seen.push(`ops: ${OPERATOR_LINKS.map(([f, t]) => `${f} → ${t}`).join(", ")}`);
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/operator/shops");
    await page.waitForURL((url) => url.pathname === "/admin/shops");
  } finally {
    await context.close();
  }
  // An admin holds the limited operator's permissions: /operator goes to /admin, its pages open themselves.
  const adminUser = await me("admin");
  if (adminUser.role !== "ADMIN") blocked(`the admin account acts as ${adminUser.role}, not ADMIN`);
  const admin = await as("admin");
  const root = await call(admin, "GET", "/operator");
  expect(root.status, "admin: /operator").toBe(307);
  expect(new URL(root.location ?? "", "http://x").pathname).toBe("/admin");
  const shops = await call(admin, "GET", "/operator/shops");
  expect(shops.status, "admin: /operator/shops opens").toBe(200);
  expect(shops.text).toContain("My shops");
  seen.push("admin: /operator → /admin, /operator/shops opens (My shops), never the customer home");
  return seen.join("; ");
}, signed);

/* ------------------------------------------------------------------ D-139 */

qa("TC-RGR-009", "D-139: a 'Verified' board entry reads 'Not verified' (no green tick) when the record is not verified", async ({ browser }) => {
  const seen: string[] = [];
  let notVerified = 0;
  const { context, page } = await pageAs(browser, "shop");
  try {
    for (const menu of ["payout", "myShop"]) {
      await page.goto(`/shop/menu/${menu}`);
      const entry = page.getByTestId("hub-tile").and(page.locator('[data-key="verified"]'));
      if (!(await entry.count())) continue;
      const ticked = (await entry.getByTestId("verified-tick").count()) > 0;
      if (ticked) {
        await expect(entry, `${menu}: verified, with the tick`).toContainText("Verified");
        await expect(entry).not.toContainText("Not verified");
      } else {
        await expect(entry, `${menu}: no tick, so it must say so`).toContainText("Not verified");
        notVerified += 1;
      }
      seen.push(`/shop/menu/${menu}: ${ticked ? "Verified ✓" : "Not verified"}`);
    }
  } finally {
    await context.close();
  }
  // The phone's tile board shows the same entries under the tiles.
  const phone = await phonePage(browser, "shop");
  try {
    await phone.page.goto("/shop");
    const tags = phone.page.getByTestId("board-tag").and(phone.page.locator('[data-key="verified"]'));
    const n = await tags.count();
    for (let i = 0; i < n; i++) {
      const tag = tags.nth(i);
      if (!(await tag.isVisible())) continue;
      const ticked = (await tag.getByTestId("verified-tick").count()) > 0;
      if (ticked) await expect(tag).not.toContainText("Not verified");
      else await expect(tag).toContainText("Not verified");
      seen.push(`board tag ${i + 1}: ${ticked ? "Verified ✓" : "Not verified"}`);
    }
  } finally {
    await phone.context.close();
  }
  expect(seen.length, "Verified entries found").toBeGreaterThan(0);
  if (!notVerified) blocked(`shop A's payout bank and shop verification are both verified, so no entry should read 'Not verified' (${seen.join("; ")})`);
  return seen.join("; ");
}, signed);

/* ------------------------------------------------------------------ D-140 */

const CHECKS = ["PAN and Aadhaar verified (KYC)", "police verification form and character certificate approved", "police verification form approved"];

qa("TC-RGR-010", "D-140: an approved rider with checks outstanding reads 'You're approved — finish N more checks below to start delivering: …' with the right N", async ({ browser }) => {
  const seen: string[] = [];
  for (const role of ["rider", "rider2"] as Role[]) {
    if (!world().users[role]) continue;
    const { context, page } = await pageAs(browser, role);
    try {
      await page.goto("/delivery-partner");
      await expect(page.getByRole("heading", { name: "My Delivery Partner Application" })).toBeVisible();
      const line = page.getByText(/^You're approved — finish \d+ more checks? below to start delivering: .+\.$/);
      if (!(await line.count())) {
        const plain = (await page.getByText(/^You're approved as a delivery partner\.$|^Your (application|delivery partner account)/).first().innerText().catch(() => "")).trim();
        seen.push(`${role}: "${plain || "no status line"}"`);
        continue;
      }
      const text = (await line.innerText()).trim();
      const [, count, list] = /finish (\d+) more checks? below to start delivering: (.+)\.$/.exec(text)!;
      const named = list.split("; ");
      expect(Number(count), `N matches the checks named in "${text}"`).toBe(named.length);
      expect(text, "singular for one").toMatch(Number(count) === 1 ? /finish 1 more check below/ : /more checks below/);
      for (const check of named) expect(CHECKS, `a known check: "${check}"`).toContain(check);
      return `${role}: "${text}"`;
    } finally {
      await context.close();
    }
  }
  blocked(`no approved rider with checks outstanding on this site (${seen.join("; ")}); the local tier makes one`);
}, signed);

/* ------------------------------------------------------------------ D-146 */

qa("TC-RGR-011", "D-146: the inventory table can be reached with Tab and scrolled with the arrow keys", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop", { viewport: { width: 412, height: 915 } });
  try {
    await page.goto("/shop/inventory");
    const region = page.getByRole("region", { name: "Inventory table" });
    await expect(page.getByTestId("seller-content")).toBeVisible();
    await region.waitFor({ timeout: 30_000 }).catch(() => {});
    if (!(await region.count())) blocked("shop A's inventory page shows no table (no products)");
    await expect(region).toHaveAttribute("tabindex", "0");
    let presses = 0;
    let focused = false;
    while (!focused && presses < 250) {
      await page.keyboard.press("Tab");
      presses += 1;
      focused = await region.evaluate((el) => el === document.activeElement);
    }
    expect(focused, "Tab reaches the inventory table").toBe(true);
    const before = await region.evaluate((el) => ({ scroll: el.scrollLeft, wide: el.scrollWidth, shown: el.clientWidth }));
    if (before.wide <= before.shown + 1) return `focused after ${presses} Tab presses; the table fits ${before.shown} px, nothing to scroll`;
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate((el) => el.scrollLeft), { message: "ArrowRight scrolls the table" }).toBeGreaterThan(before.scroll);
    const after = await region.evaluate((el) => el.scrollLeft);
    await page.keyboard.press("Home");
    return `412 px: focused after ${presses} Tab presses (region "Inventory table", tabindex 0); ArrowRight scrolled it ${before.scroll} → ${after} of ${before.wide - before.shown} px`;
  } finally {
    await context.close();
  }
}, signed);

/* ------------------------------------------------------------------ D-147 */

qa("TC-RGR-012", "D-147: while the customer decides on a substitute, 'Packed — mark ready' is held (button disabled, READY refused); once they accept, mark ready works", async ({ browser }) => {
  await ensureWallet();
  const [packaged, bread] = [await listingOf("packaged"), await listingOf("sharedA")];
  need(bread.shopProductId !== packaged.shopProductId ? bread : null, "two different products at shop A");
  const placed = await checkoutLines([{ listing: packaged }]);
  const seen: string[] = [];
  try {
    expectStatus(await fulfil(placed.id, "accept"), 200, "accept");
    expectStatus(await fulfil(placed.id, "start"), 200, "start");
    const line = (await orderRow(placed.id)).items[0];
    expectStatus(await shopAct(placed.id, "substitute", { itemId: line.id, substituteShopProductId: bread.shopProductId }), 200, "offer a substitute");
    const { context, page } = await pageAs(browser, "shop");
    try {
      const card = await shopCard(page, placed.orderNumber, "packing");
      await expect(card.getByText("(waiting for customer)")).toBeVisible({ timeout: 15_000 });
      await expect(card.getByRole("button", { name: "Packed — mark ready" }), "held while the customer decides").toBeDisabled();
    } finally {
      await context.close();
    }
    const early = await fulfil(placed.id, "ready");
    expect(early.status, "READY while the customer decides").toBe(409);
    expect(why(early)).toContain("Waiting for the customer to approve or reject a substitution.");
    expect((await orderRow(placed.id)).status).toBe("PREPARING");
    seen.push(`waiting: button disabled, READY → ${early.status}, order PREPARING`);

    expectStatus(await call(await as("customer"), "PATCH", `/api/orders/${placed.id}/items/${line.id}/substitution`, { approve: true }), 200, "the customer accepts the substitute");
    let buttonAfter = "";
    const shop = await pageAs(browser, "shop");
    try {
      const card = await shopCard(shop.page, placed.orderNumber, "packing");
      await expect(card.getByText("(waiting for customer)"), "no longer waiting").toHaveCount(0);
      // The planner may still hold it for its own reasons (no slot or staff free right now), so the API proves the release.
      buttonAfter = (await card.getByRole("button", { name: "Packed — mark ready" }).isEnabled().catch(() => false)) ? "enabled" : "disabled (planner: slot / staff)";
    } finally {
      await shop.context.close();
    }
    const ready = await fulfil(placed.id, "ready");
    expectStatus(ready, 200, "mark ready after the answer");
    expect((await orderRow(placed.id)).status).toBe("READY");
    seen.push(`accepted: '(waiting for customer)' gone, button ${buttonAfter}, mark ready → READY`);
  } finally {
    await abandon(placed.id);
  }
  return `${placed.orderNumber}: ${seen.join("; ")}`;
}, signed);
