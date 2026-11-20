/**
 * Billing v2 on a site with the staging test accounts (docs/billing).
 *
 * TC-BILL-014: only the shop's owner (and an admin, for support) can open a
 * shop's books — every other account is refused before anything is read or
 * written. TC-BILL-015: with billing_v2 off for shop A's district (as on
 * test.gokesari.com outside a billing test), the billing pages go back and the
 * billing APIs answer 404. TC-BILL-008 runs only where billing_v2 is on for
 * shop A; its bill is cancelled again afterwards.
 *
 * The other billing cases need the flags switched and GST data arranged:
 * they run on the local tier (tests/qa/local/billing-v2.spec.ts).
 */
import { existsSync } from "node:fs";

import { as, pageAs, sessionFile } from "../lib/actors";
import { accounts, billingOn, istMonth, serialOf, type SalesInvoice } from "../lib/billing-v2-helpers";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { TARGET } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

const shopA = () => need(world().shops.A?.id, "shop A's id in this site's test data");

/** Whether `role` can be signed in here (a saved staging session, or a seeded local account). */
function available(role: Role): boolean {
  if (!world().users[role]) return false;
  return TARGET === "local" ? Boolean(world().users[role]?.id) : existsSync(sessionFile(role));
}

qa("TC-BILL-014", "a shop's books: its owner reads them; another owner, operator, limited operator, customer and rider are refused (403) and never see the shop", async () => {
  const id = shopA();
  const name = need(world().shops.A?.name, "shop A's name");
  const own = await accounts(await as("shop"), "GET", id, "sales");
  expectStatus(own, 200, "the owner reads his own sales");
  const refused: string[] = [];
  const skipped: string[] = [];
  for (const role of ["shopB", "ops", "oplim", "customer", "customer2", "rider"] as Role[]) {
    if (!available(role)) {
      skipped.push(role);
      continue;
    }
    const ctx = await as(role);
    for (const [method, rest] of [
      ["GET", "sales"],
      ["GET", "settings"],
      ["GET", "stock"],
      ["GET", "pos/items"],
      ["POST", "sales"],
    ] as const) {
      const res = await call(ctx, method, `/api/shops/${id}/accounts/${rest}`, method === "POST" ? {} : undefined);
      expectStatus(res, 403, `${role}: ${method} ${rest}`);
      expect(res.body?.error?.message).toBe("This shop does not belong to you.");
    }
    // The page with ?shop= opens the caller's own shop (or sends them away): never shop A's books.
    const page = await call(ctx, "GET", `/shop/accounts?shop=${id}`, undefined, { maxRedirects: 5 });
    expect(page.text.includes(name), `${role}: /shop/accounts?shop=<A> must not show "${name}"`).toBe(false);
    refused.push(role);
  }
  if (!refused.length) blocked(`no other test account can be signed in here (${skipped.join(", ")})`);
  return `owner 200; refused: ${refused.join(", ")}${skipped.length ? `; not signed in here: ${skipped.join(", ")}` : ""}`;
}, { ...signed, partial: "a dealer account (none on staging); an admin can open any shop's books for support (SYSTEM_CONFIG)" });

qa("TC-BILL-015", "billing_v2 off: POS goes back to /shop/accounts, GST returns to /shop/accounts/gst; billing APIs answer 404 'This feature is not available.'", async ({ browser }) => {
  const id = shopA();
  const owner = await as("shop");
  if (await billingOn(owner, id)) blocked("billing_v2 is on for shop A's district on this site; the flags-off case runs where it is off (and on the local tier)");
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/accounts/pos");
    await page.waitForURL((u) => u.pathname === "/shop/accounts", { timeout: 60_000 });
    await page.goto("/shop/accounts/gst/returns");
    await page.waitForURL((u) => u.pathname === "/shop/accounts/gst", { timeout: 60_000 });
    await expect(page.getByRole("link", { name: "Returns on the portal →" })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const seen: string[] = [];
  for (const rest of ["pos/items", "documents", "gst-registration", "portal/filings", `statements/tax?period=${istMonth(-1)}`]) {
    const res = await accounts(owner, "GET", id, rest);
    expectStatus(res, 404, `GET ${rest}`);
    expect(res.body?.error?.message).toBe("This feature is not available.");
    seen.push(rest.split("?")[0]);
  }
  return `pages back to /shop/accounts (returns → /shop/accounts/gst); 404 on ${seen.join(", ")}`;
}, { ...signed, mobile: true });

qa("TC-BILL-008", "POS on the site: a counter bill of 2 items gets the next number and stock goes down by 2 (the bill is cancelled again)", async ({ browser }) => {
  const id = shopA();
  const owner = await as("shop");
  if (!(await billingOn(owner, id))) blocked("flag billing_v2 is off for shop A's district on this site");
  const items = (await accounts(owner, "GET", id, "pos/items")).body as { id: string; name: string; pricePaise: number | null; stock: number }[];
  const item = need(items.find((i) => (i.pricePaise ?? 0) > 0 && i.stock >= 5), "a priced POS item with stock at shop A");
  const sales = (await accounts(owner, "GET", id, "sales")).body as SalesInvoice[];
  const last = Math.max(0, ...sales.map((s) => serialOf(s.invoiceNo)).filter(Number.isFinite));
  const { context, page } = await pageAs(browser, "shop");
  let invoiceId: string | null = null;
  try {
    await page.goto("/shop/accounts/pos");
    await page.getByLabel("Search item or barcode").fill(item.name);
    await page.getByRole("button", { name: new RegExp(`^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
    await page.getByRole("button", { name: `More ${item.name}` }).click();
    await page.getByRole("button", { name: "Make bill" }).click();
    const done = page.getByTestId("pos-done").getByRole("listitem").first();
    await expect(done).toContainText("created", { timeout: 60_000 });
    const number = need(/[A-Z]+\d{4}-\d+/.exec(await done.innerText())?.[0], "the bill number");
    expect(serialOf(number), "the next number").toBe(last + 1);
    invoiceId = ((await accounts(owner, "GET", id, "sales")).body as SalesInvoice[]).find((s) => s.invoiceNo === number)?.id ?? null;
    const after = ((await accounts(owner, "GET", id, "pos/items")).body as { id: string; stock: number }[]).find((i) => i.id === item.id);
    expect(after?.stock, "stock down by 2").toBe(item.stock - 2);
    return `${number}: 2 × ${item.name}, stock ${item.stock} → ${after?.stock}`;
  } finally {
    await context.close();
    if (invoiceId) await call(owner, "DELETE", `/api/shops/${id}/accounts/sales/${invoiceId}`, { reason: "QA TC-BILL-008 test bill" });
  }
}, signed);
