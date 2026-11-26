/**
 * Smart shopping (TC-SMART-…, PR #482): the cases of the 23-Nov-2026 plan that were declared manual and can run on
 * test.gokesari.com as it is on 25-Nov-2026 — with smart_list_scan_enabled, shop_photo_listing_enabled and
 * whatsapp_shop_orders_enabled all OFF there. These checks never switch a flag (the signed tier does not change
 * settings, and staging's four-eye rule needs a second admin for it), so they cover the switched-off behaviour and
 * the admin reports, which work either way. Every write sent is refused by the flag before anything is saved; the
 * wishlist body also names a product that does not exist, so even a broken flag check could not save it.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { call, expectStatus, type Answer } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const NOT_AVAILABLE = "This feature is not available.";
const NO_SUCH = "00000000-0000-4000-8000-000000000000";
const message = (res: Answer) => String(res.body?.error?.message ?? "");

async function flag(key: string): Promise<boolean | null> {
  const res = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  expectStatus(res, 200, "feature flags");
  const row = (res.body.flags as { key: string; enabled: boolean; districtCodes: string[] | null }[]).find((f) => f.key === key);
  if (!row) return false;
  return row.enabled && !row.districtCodes?.length ? true : row.enabled ? null : false;
}

async function mainText(page: Page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

qa("TC-SMART-002", "list scan switched off: no Scan tile on the home pages or in the cart, the wishlist pages are 404, and scan / save / compare / order answer 404 “This feature is not available.”", async ({ browser }) => {
  if ((await flag("smart_list_scan_enabled")) !== false) blocked("smart_list_scan_enabled is not off on this site");
  const customer = await as("customer");

  const { context, page } = await pageAs(browser, "customer");
  try {
    for (const path of ["/", "/cart"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      expect(await mainText(page), `${path}: no Scan tile`).not.toContain("Scan my shopping list");
    }
    for (const path of ["/wishlist", "/wishlist/scan"]) {
      const res = await page.goto(path);
      expect(res?.status(), `${path}`).toBe(404);
    }
  } finally {
    await context.close();
  }

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 0x00), Buffer.from([0xff, 0xd9])]);
  const scan = await call(customer, "POST", "/api/smart-list/scans", undefined, { multipart: { page: { name: "list.jpg", mimeType: "image/jpeg", buffer: jpeg } } });
  const save = await call(customer, "POST", "/api/smart-list/wishlists", { name: "QA refused", items: [{ nameEn: "QA refused item", productId: NO_SUCH, quantityAmount: 1, quantityUnit: "piece" }] });
  const compare = await call(customer, "GET", `/api/smart-list/wishlists/${NO_SUCH}/compare`);
  const order = await call(customer, "POST", `/api/smart-list/wishlists/${NO_SUCH}/order`, { shopId: NO_SUCH });
  const seen: string[] = [];
  for (const [what, res] of [["scan", scan], ["save", save], ["compare", compare], ["order", order]] as const) {
    expectStatus(res, 404, what);
    expect(message(res), what).toBe(NOT_AVAILABLE);
    expect(res.body?.error?.details?.reason ?? "FEATURE_NOT_AVAILABLE", `${what} reason`).toBe("FEATURE_NOT_AVAILABLE");
    seen.push(`${what} 404`);
  }
  const list = await call(customer, "GET", "/api/smart-list/wishlists");
  return `no tile on / and /cart; /wishlist and /wishlist/scan 404; ${seen.join(", ")}; GET wishlists still answers ${list.status} (as the case notes)`;
}, { ...signed, partial: "The Tile Board and the discovery home are read as the customer's home page only; a wishlist saved while the flag was on does not exist on staging" });

qa("TC-SMART-025", "Smart shopping dashboard: the header with the live rules, the period switch, the four cards, both tables and the links; the operator sees it; the customer is sent home", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/smart-shopping");
    await expect(page.getByRole("heading", { name: "Smart shopping" })).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    expect(text).toMatch(/Last 30 days \(IST\)\. AI provider: \S+ · radius \d+(\.\d+)? km · photos kept \d+ days\. Change these in Settings → Rules\./);
    for (const t of ["List scans", "AI match accuracy", "AI calls", "AI cost (est.)", "Scans per day", "AI calls (response time, cost)"]) expect(text.toLowerCase(), t).toContain(t.toLowerCase());
    expect(text).toMatch(/\d+ of \d+ AI matches kept · \d+ not matched by AI/);
    expect(text).toMatch(/\$\d+\.\d{2}/);
    for (const h of ["Day", "Scans", "Read", "Unreadable", "Lines", "Feature", "Calls", "Failed", "Avg s", "p95 s", "Cost $"]) await expect(page.getByRole("columnheader", { name: h, exact: true }).first()).toBeVisible();
    for (const l of ["Products added by photo →", "WhatsApp delivery stats →"]) await expect(page.getByRole("link", { name: l })).toBeVisible();
    for (const [label, days] of [["7 days", 7], ["90 days", 90], ["30 days", 30]] as const) {
      await page.getByRole("link", { name: label, exact: true }).or(page.getByRole("button", { name: label, exact: true })).first().click();
      await expect(page.getByText(new RegExp(`Last ${days} days \\(IST\\)`))).toBeVisible({ timeout: 60_000 });
    }
  } finally {
    await context.close();
  }
  const ops = await pageAs(browser, "ops");
  try {
    await ops.page.goto("/admin/smart-shopping");
    await expect(ops.page.getByRole("heading", { name: "Smart shopping" })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ops.context.close();
  }
  const cust = await pageAs(browser, "customer");
  try {
    await cust.page.goto("/admin/smart-shopping");
    await cust.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    expect(new URL(cust.page.url()).pathname, "customer sent away").not.toBe("/admin/smart-shopping");
  } finally {
    await cust.context.close();
  }
  return "header with provider, radius and retention; 7 / 90 / 30 days switch; cards and both tables; links; operator sees it; customer sent away";
}, { ...signed, partial: "Staging has no scans or AI calls yet, so only the empty figures (0, —, $0.00) are seen; the AI usage log's columns are not read (database)" });

qa("TC-SMART-033", "Products added by photo: the page and report work with the flag off; the shop owner is sent away and the report API answers 403", async ({ browser }) => {
  const report = await call(await as("admin"), "GET", "/api/admin/photo-listing/report?days=30");
  expectStatus(report, 200, "admin report");
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/photo-listing");
    await expect(page.getByRole("heading", { name: "Products added by photo" })).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    expect(text).toContain("Last 30 days. AI accuracy = fields the owner kept ÷ fields kept or changed, on published products.");
    for (const t of ["Photo reads", "Published", "Unreadable (retake)", "AI accuracy", "Shops", "Fields kept", "Fields changed", "AI cost (USD, est.)", "Published, by result", "Fields owners corrected most"]) expect(text, t).toContain(t);
  } finally {
    await context.close();
  }
  const owner = await call(await as("shop"), "GET", "/api/admin/photo-listing/report?days=30");
  expectStatus(owner, 403, "shop owner report API");
  const shop = await pageAs(browser, "shop");
  try {
    await shop.page.goto("/admin/photo-listing");
    await shop.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    expect(new URL(shop.page.url()).pathname, "shop owner sent away").not.toBe("/admin/photo-listing");
  } finally {
    await shop.context.close();
  }
  return `report API 200 (${Object.keys(report.body).slice(0, 4).join(", ")}…); page with every card and both lists while shop_photo_listing_enabled is off; shop owner sent away, API 403`;
}, { ...signed, partial: "Photo retention (deleting photos and discarding drafts after 30 days) needs the daily job on a back-dated clock" });

qa("TC-SMART-034", "Orders on WhatsApp switched off: no tile under My Shop, the settings page is 404 and the API answers 404 “This feature is not available.”", async ({ browser }) => {
  if ((await flag("whatsapp_shop_orders_enabled")) !== false) blocked("whatsapp_shop_orders_enabled is not off on this site");
  const shopId = need(world().shops.A?.id, "the test shop");
  const api = await call(await as("shop"), "GET", `/api/shops/${shopId}/whatsapp`);
  expectStatus(api, 404, "WhatsApp settings API");
  expect(message(api)).toBe(NOT_AVAILABLE);
  let status = 0;
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    expect(await mainText(page), "no Orders on WhatsApp tile").not.toContain("Orders on WhatsApp");
    // Seller Central renders its not-found page inside a page that has already started streaming, so the
    // HTTP status can be 200 while the owner sees the 404 page; the content is what is checked.
    const res = await page.goto("/shop/settings/whatsapp");
    await expect(page.getByText("This page does not exist")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("New orders on WhatsApp")).toHaveCount(0);
    status = res?.status() ?? 0;
  } finally {
    await context.close();
  }
  return `no tile under My Shop; /shop/settings/whatsapp shows the not-found page (HTTP ${status}); API 404 “This feature is not available.”`;
}, { ...signed, partial: "The switched-on half (the page, the set-up note without Meta keys, the other owner's and the operator's 403) needs the flag on" });
