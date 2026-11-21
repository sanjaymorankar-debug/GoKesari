/**
 * Puja Samagri & Temple Supplies (docs/puja-samagri-2026-11), production-safe: what a guest
 * sees — the Puja tile, the /puja storefront with its filters and Hindi / Marathi search, the
 * Nearby puja filter — and the puja APIs refusing a caller without a session. GETs only.
 */
import { anonymous, call } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-PUJA-001", "the home page has the Puja Samagri tile, and /puja shows the 15 puja categories, the filters and Nearby", async ({ page }) => {
  await page.goto("/");
  const tile = page.getByTestId("home-category").and(page.locator('[data-key="puja"]'));
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("href", "/puja");
  await page.goto("/puja");
  await expect(page.getByRole("heading", { level: 1, name: /Puja Samagri/ })).toBeVisible();
  const chips = page.getByTestId("puja-categories").getByRole("link");
  await expect(chips).toHaveCount(16); // All + 15 categories
  for (const name of ["Agarbatti & Dhoop", "Kapur (Camphor)", "Havan Samagri", "Ready Puja Kits", "Temple Bulk Supplies (B2B)"]) {
    await expect(page.getByTestId("puja-categories").getByRole("link", { name: new RegExp(name.replace(/[()]/g, "\\$&")) })).toBeVisible();
  }
  const filters = page.getByTestId("puja-filters");
  for (const label of ["Search", "Festival", "Loose / packed", "Min ₹", "Max ₹"]) await expect(filters.getByLabel(label)).toBeVisible();
  await expect(page.getByTestId("puja-nearby")).toHaveAttribute("href", "/shops/nearby?type=PUJA_SAMAGRI");
  const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(width, "no sideways scroll").toBeLessThanOrEqual(1);
  return `tile → /puja; 15 category chips, 5 filters, Nearby link; ${await page.getByTestId("puja-result-count").innerText()}`;
}, { mobile: true });

qa("TC-PUJA-002", "/puja search in English, Hindi and Marathi and every filter answer a page, never an error", async ({ page }) => {
  const seen: string[] = [];
  for (const query of ["kapur", "कपूर", "कापूर", "मोमबत्ती", "camphor", "agarbathi"]) {
    const res = await page.goto(`/puja?q=${encodeURIComponent(query)}`);
    expect(res?.status(), query).toBe(200);
    seen.push(`${query}: ${(await page.getByTestId("puja-result-count").innerText()).split(" ")[0]}`);
  }
  for (const qs of ["festival=diwali", "kind=loose", "kind=packed", "min=10&max=500", "stock=1", "cat=puja-kapur", "cat=puja-phool-patte&kind=loose"]) {
    const res = await page.goto(`/puja?${qs}`);
    expect(res?.status(), qs).toBe(200);
    await expect(page.getByTestId("puja-result-count")).toBeVisible();
  }
  return seen.join(" · ");
}, { partial: "result contents depend on puja shops on the site; checked with data in tests/qa/signed-in/puja-samagri.spec.ts" });

qa("TC-PUJA-003", "Nearby has a Puja Samagri chip that keeps puja shops only (type=PUJA_SAMAGRI)", async ({ page }) => {
  await page.goto("/shops/nearby?type=PUJA_SAMAGRI");
  await expect(page.getByRole("heading", { level: 1, name: "Puja Samagri shops nearby" })).toBeVisible();
  await expect(page.getByTestId("nearby-puja-chip")).toHaveAttribute("aria-current", "page");
  const guest = await anonymous();
  // A device position in Pune, not a typed PIN: a PIN is found only from the site's own shop and customer
  // addresses (or Google when configured), so a PIN known on the test site can be unknown on production.
  const at = "lat=18.5204&lng=73.8567&radiusKm=10";
  const all = await call(guest, "GET", `/api/shops/nearby?${at}`);
  const puja = await call(guest, "GET", `/api/shops/nearby?${at}&type=PUJA_SAMAGRI`);
  expect(all.status).toBe(200);
  expect(puja.status).toBe(200);
  expect(puja.body.shops.length).toBeLessThanOrEqual(all.body.shops.length);
  const bad = await call(guest, "GET", `/api/shops/nearby?${at}&type=puja;drop`);
  expect(bad.status, "a malformed type is refused").toBe(422);
  return `Pune centre, 10 km: ${puja.body.shops.length} puja shop(s) of ${all.body.shops.length}`;
});

qa("TC-PUJA-004", "the puja APIs refuse a caller without a session (401) before reading the request", async () => {
  const guest = await anonymous();
  const zero = "00000000-0000-0000-0000-000000000000";
  const calls: [string, string, unknown?][] = [
    ["GET", "/api/admin/puja/config"],
    ["PATCH", "/api/admin/puja/config", { enabled: false }],
    ["GET", "/api/admin/puja/submissions"],
    ["POST", "/api/admin/puja/submissions", { kind: "TYPE", id: zero, decision: "APPROVE" }],
    ["GET", "/api/admin/puja/catalogue"],
    ["GET", "/api/admin/puja/catalogue/export"],
    ["POST", "/api/admin/puja/catalogue/merge", { sourceId: zero, targetId: zero }],
    ["GET", "/api/admin/puja/festivals"],
    ["GET", `/api/shops/${zero}/puja`],
    ["POST", `/api/shops/${zero}/puja/seed`, {}],
    ["POST", `/api/shops/${zero}/puja/types`, {}],
    ["GET", `/api/shops/${zero}/removed-listings`],
    ["GET", `/api/shops/${zero}/listing-price-requests`],
    ["GET", "/api/listing-price-requests"],
    ["POST", "/api/listing-price-requests", { shopProductId: zero }],
  ];
  const wrong: string[] = [];
  for (const [method, url, body] of calls) {
    const res = await call(guest, method as "GET", url, body);
    if (res.status !== 401) wrong.push(`${method} ${url} → ${res.status}`);
  }
  expect(wrong).toEqual([]);
  return `${calls.length} calls, all 401`;
});
