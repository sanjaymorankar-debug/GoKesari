/**
 * Retests of the R2 fixes (PR #416, 19/20-Nov-2026) that a signed-out visitor
 * can see: D-131 (a real 307 to sign-in from Seller Central, except
 * registration), D-150 (guest calls to two admin APIs answer 401), D-135 (the
 * "Get the GoKesari app" prompt is one slim row on a phone) and D-137 (the
 * nearby-shops page keeps its height while it locates).
 *
 * Production-safe: page loads and requests the server must refuse. The phone
 * checks emulate a Pixel 7 themselves (one run, on the desktop project).
 */
import { anonymous, call, callApp } from "../lib/http";
import { expect, qa } from "../lib/record";
import { LAYOUT_SHIFT_RECORDER, layoutShift, phonePage } from "../lib/regression-2026-11-helpers";
import { BASE_URL } from "../lib/target";
import { world } from "../lib/world";

const IN_PAGE_SIGNIN = /http-equiv="refresh" content="\d+;url=\/signin/;

qa("TC-RGR-005", "D-131: signed out, /shop/my-products answers a real 307 to /signin; /shop/register opens and /shop/join forwards to it, never to sign-in", async ({ page }) => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const path of ["/shop/my-products", "/shop", "/shop/orders"]) {
      const res = await callApp(guest, "GET", path);
      expect(res.status, `${path} signed out (a real redirect, not a 200 page that redirects in the browser)`).toBe(307);
      expect(new URL(res.location ?? "", BASE_URL).pathname, `${path} goes to`).toBe("/signin");
      seen.push(`${path} → 307 /signin`);
    }
    const register = await callApp(guest, "GET", "/shop/register");
    expect(register.status, "/shop/register opens").toBe(200);
    expect(register.text, "/shop/register does not send to sign-in").not.toMatch(IN_PAGE_SIGNIN);
    seen.push("/shop/register → 200");
    const join = await callApp(guest, "GET", "/shop/join");
    const to = join.location ? new URL(join.location, BASE_URL).pathname : (join.text.match(/http-equiv="refresh" content="\d+;url=([^"]+)"/)?.[1] ?? "");
    expect([200, 307, 308], "/shop/join answers").toContain(join.status);
    expect(to.split("?")[0], "/shop/join forwards to registration").toBe("/shop/register");
    seen.push(`/shop/join → ${join.status} ${to}`);
  } finally {
    await guest.dispose();
  }
  await page.goto("/shop/join");
  await page.waitForURL((url) => url.pathname === "/shop/register");
  return `${seen.join("; ")}; in the browser /shop/join ends on /shop/register`;
});

qa("TC-RGR-008", "D-150: guest calls to /api/admin/support-services and /api/admin/dealer-analytics answer 401 (not 404)", async () => {
  const guest = await anonymous();
  try {
    const out: string[] = [];
    for (const path of ["/api/admin/support-services", "/api/admin/dealer-analytics"]) {
      const res = await call(guest, "GET", path);
      expect(res.status, `GET ${path} signed out`).toBe(401);
      out.push(`GET ${path} → 401`);
    }
    return out.join("; ");
  } finally {
    await guest.dispose();
  }
});

qa("TC-RGR-002", "D-135: on a phone the 'Get the GoKesari app' prompt is one slim row (about 62 px), not a large banner", async ({ browser }) => {
  const { context, page } = await phonePage(browser, null);
  try {
    await page.goto("/");
    const prompt = page.getByTestId("app-install-prompt");
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    const row = prompt.locator(":scope > div");
    const box = (await row.boundingBox())!;
    const sheet = (await prompt.boundingBox())!;
    const height = Math.round(box.height);
    expect(height, "the prompt's row").toBeLessThanOrEqual(64);
    const title = (await prompt.getByRole("heading", { name: "Get the GoKesari app" }).boundingBox())!;
    const notNow = (await prompt.getByTestId("app-install-not-now").boundingBox())!;
    const action = (await prompt.getByTestId("app-install-button").or(prompt.getByTestId("app-install-store")).first().boundingBox())!;
    // One row: the title and both buttons side by side, inside the row.
    for (const [what, b] of [["title", title], ["Not now", notNow], ["Install", action]] as const) {
      expect(b.y, `${what} inside the row (top)`).toBeGreaterThanOrEqual(box.y - 1);
      expect(b.y + b.height, `${what} inside the row (bottom)`).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    expect(Math.abs(notNow.y - action.y), "both buttons on one line").toBeLessThanOrEqual(2);
    const screen = page.viewportSize()!;
    expect(sheet.height / screen.height, "share of the screen").toBeLessThan(0.1);
    return `Pixel 7 ${screen.width}×${screen.height}: prompt row ${height} px (whole bar ${Math.round(sheet.height)} px = ${((100 * sheet.height) / screen.height).toFixed(1)}% of the screen); title, Install and Not now on one row`;
  } finally {
    await context.close();
  }
});

qa("TC-RGR-004", "D-137: the nearby shops page keeps its height while it locates (CLS ≤ 0.01)", async ({ browser }) => {
  const spot = world().location ?? { lat: 18.5204, lng: 73.8567 };
  const { context, page } = await phonePage(browser, null, { geolocation: { latitude: spot.lat, longitude: spot.lng }, permissions: ["geolocation"] });
  try {
    await page.addInitScript(LAYOUT_SHIFT_RECORDER);
    await page.goto("/shops/nearby");
    await expect(page.getByTestId("nearby-page")).toBeVisible();
    // Located and looked up: the list, the empty state or a problem with the position.
    await expect(page.getByTestId("nearby-list").or(page.getByTestId("nearby-empty")).or(page.getByTestId("nearby-problem")).first()).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(2_500);
    const cls = await layoutShift(page);
    expect(cls.error, "layout-shift entries are recorded in this browser").toBeUndefined();
    expect(cls.max, `CLS (largest session window) — ${cls.entries} shifts, ${cls.total.toFixed(4)} in all`).toBeLessThanOrEqual(0.01);
    const where = (await page.getByTestId("nearby-location").innerText()).trim();
    return `Pixel 7, position shared: located (${where.slice(0, 60)}); CLS ${cls.max.toFixed(4)} (${cls.entries} shifts, total ${cls.total.toFixed(4)})`;
  } finally {
    await context.close();
  }
}, { partial: "measured with the browser's own layout-shift entries on an unthrottled Pixel 7 profile, not a Lighthouse 4G run" });
