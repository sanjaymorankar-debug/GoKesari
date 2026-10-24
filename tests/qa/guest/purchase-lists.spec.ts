/**
 * Purchase lists (docs/purchase-lists-2026-10) as a guest sees them —
 * production-safe: a guest is sent to sign-in from /lists and from a list's
 * page, every /api/purchase-lists route refuses a caller without a session
 * (401) before it reads the request, and product cards offer no "Add to
 * list" to a guest. Only GETs and requests the server must refuse; nothing
 * here can create or change anything.
 */
import { anonymous, call, pace, type Method } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { apiRoutes, fill, NO_SUCH_ID } from "../lib/routes";

/** The feature's API, read from the checkout (src/app/api/purchase-lists), so a new route is covered the day it lands. */
const LIST_API = "/api/purchase-lists";

qa("TC-LIST-001", "a guest opening My lists or a list's page is sent to sign-in", async ({ page }) => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const path of ["/lists", "/lists?kind=MEDICINE", `/lists/${NO_SUCH_ID}`, "/lists/not-a-list-id"]) {
      await pace();
      const res = await call(guest, "GET", path);
      expect([302, 303, 307, 308], `${path} answered ${res.status} (expected a redirect to sign-in)`).toContain(res.status);
      expect(res.location ?? "", `${path} redirects to`).toMatch(/\/signin\b/);
      seen.push(`${path} → ${res.status} ${new URL(res.location!, "http://x").pathname}`);
    }
  } finally {
    await guest.dispose();
  }
  // In the browser, too: the guest lands on the sign-in page and sees no list.
  await page.goto("/lists");
  await expect(page).toHaveURL(/\/signin\b/);
  await expect(page.getByRole("heading", { name: /Shopping lists|Medicine lists/ })).toHaveCount(0);
  return `${seen.join("; ")}; browser lands on ${new URL(page.url()).pathname}`;
}, { mobile: true });

qa("TC-LIST-002", "every /api/purchase-lists route answers 401 to a caller without a session, before reading the request", async () => {
  const routes = apiRoutes().filter((r) => r.path === LIST_API || r.path.startsWith(`${LIST_API}/`));
  const calls = routes.flatMap((r) => r.methods.map((method) => ({ path: r.path, method: method as Method })));
  // The spec's routes: list/create, read/change/delete, add item, change/remove item, check, order, from-cart.
  expect(calls.length, `routes found under ${LIST_API}: ${calls.map((c) => `${c.method} ${c.path}`).join(", ")}`).toBeGreaterThanOrEqual(11);
  const guest = await anonymous();
  const bad: string[] = [];
  try {
    for (const c of calls) {
      await pace();
      // A plausible body and ids that exist nowhere: the session check must come first,
      // so the answer says nothing about the body's fields or whether a list exists.
      const body = c.method === "GET" || c.method === "DELETE" ? undefined : { name: "QA guest", mode: "ADD", shopProductId: NO_SUCH_ID, quantity: 1 };
      const res = await call(guest, c.method, fill(c.path), body);
      if (res.status !== 401) bad.push(`${c.method} ${c.path} → ${res.status} ${res.body?.error?.code ?? ""}`.trim());
      else if (res.body?.error?.code !== "UNAUTHENTICATED") bad.push(`${c.method} ${c.path} → 401 with code ${res.body?.error?.code ?? "(none)"}`);
    }
  } finally {
    await guest.dispose();
  }
  expect(bad, `${bad.length} of ${calls.length} not refusing a guest with 401:\n${bad.join("\n")}`).toEqual([]);
  return `${calls.length} method/route pairs, all 401 UNAUTHENTICATED: ${calls.map((c) => `${c.method} ${c.path.replace(LIST_API, "…")}`).join(", ")}`;
});

qa("TC-LIST-006", "a guest's product cards show no 'Add to list' (signed-in customers only)", async ({ page }) => {
  const guest = await anonymous();
  let slug: string | null = null;
  try {
    const shops = await call(guest, "GET", "/api/shops?limit=24");
    expect(shops.status, "GET /api/shops").toBe(200);
    const list = (Array.isArray(shops.body) ? shops.body : (shops.body?.shops ?? [])) as { id: string; slug: string }[];
    for (const shop of list.slice(0, 8)) {
      await pace();
      const products = await call(guest, "GET", `/api/shops/${shop.id}/products?limit=5`);
      const rows = (Array.isArray(products.body) ? products.body : (products.body?.products ?? [])) as unknown[];
      if (products.status === 200 && rows.length) {
        slug = shop.slug;
        break;
      }
    }
  } finally {
    await guest.dispose();
  }
  if (!slug) blocked("no approved shop with products online is listed on this site");
  await page.goto(`/shops/${slug}`);
  const cards = page.getByTestId("product-card");
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  await expect(page.getByTestId("add-to-list"), "an 'Add to list' button on a guest's product card").toHaveCount(0);
  await expect(page.getByRole("button", { name: /to one of my lists/i })).toHaveCount(0);
  return `/shops/${slug}: ${count} product cards, none with 'Add to list'`;
}, { mobile: true, partial: "the guest half only: the signed-in picker is checked in tests/qa/signed-in/purchase-lists.spec.ts" });
