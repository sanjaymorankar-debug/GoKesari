#!/usr/bin/env node
/**
 * Part 3 flow check (docs/ux-mobile-2026-11): as a shop owner on a phone viewport —
 * price 10 "Needs Price" products with the keypad's Next, save, confirm they go
 * Live, check validation, pause and resume one, open the add-product form and
 * the new orders in one tap. Prints PASS/FAIL with timings (ms).
 *
 * Usage: node scripts/ux-audit/flow.mjs <baseUrl> <shopStorageState.json> [width] [outDir]
 * Writes test data only to the shop it is signed in as; run it on local or test shops only.
 */
import { chromium } from "playwright";

const [base, state, width = "390", outDir = "."] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 844 }, isMobile: true, hasTouch: true, storageState: state, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, note: note ?? "" });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, note: String(e).split("\n")[0].slice(0, 200) });
    await page.screenshot({ path: `${outDir}/flow-fail-${results.length}.png` }).catch(() => {});
  }
};
const count = async (label) => {
  const t = await page.getByRole("link", { name: new RegExp(`^${label} \\(\\d+\\)$`) }).first().textContent();
  return Number(/\((\d+)\)/.exec(t)[1]);
};

await page.goto(`${base}/shop`);
await page.evaluate(() => localStorage.setItem("gk-seller-tour-v1", "seen"));

await step("Home → New orders in 1 tap", async () => {
  await page.goto(`${base}/shop`);
  await page.getByTestId("shop-quick-new-orders").click();
  await page.waitForURL(/\/shop\/orders/);
  return page.url().replace(base, "");
});
await step("Home → add-product form in 1 tap", async () => {
  await page.goto(`${base}/shop`);
  await page.getByTestId("shop-quick-add-product").click();
  await page.waitForURL(/\/shop\/manage\/products/);
  return page.url().replace(base, "");
});
await step("Orders tab badge / Products tab visible on phone", async () => {
  await page.goto(`${base}/shop/orders`);
  await page.getByTestId("seller-tab-products").waitFor();
  return "tab bar shown";
});

let before = 0;
await step("Nothing selected by default; bulk tools hidden", async () => {
  await page.goto(`${base}/shop/my-products?status=NEEDS_PRICE`);
  before = await count("Needs Price");
  const sel = await page.getByText(/^Select this page \(0 of \d+ selected\)$/).count();
  const bulk = await page.getByTestId("bulk-tools").count();
  if (sel !== 1 || bulk !== 0) throw new Error(`selected text ${sel}, bulk tools ${bulk}`);
  return `Needs Price ${before}`;
});

await step("Validation: price above MRP shows inline error and blocks save", async () => {
  const row = page.getByTestId("stock-row").first();
  let mrp = await row.getByLabel(/^MRP \(₹\) for /).inputValue();
  // A row without an MRP gets one typed in (it is discarded at the end of this check).
  if (!mrp) {
    mrp = "100";
    await row.getByLabel(/^MRP \(₹\) for /).fill(mrp);
  }
  await row.getByLabel(/^Selling price \(₹\) for /).fill(String(Number(mrp) + 1));
  await row.getByText("Price cannot be more than the MRP.").waitFor();
  const disabled = await page.getByRole("button", { name: /^Save changes/ }).isDisabled();
  if (!disabled) throw new Error("save enabled with an invalid price");
  await page.getByRole("button", { name: "Discard" }).click();
  return `MRP ${mrp}, price ${Number(mrp) + 1} refused`;
});

let priced = 0;
await step("Price 10 products with keypad Next, then Save (timed)", async () => {
  const t0 = Date.now();
  const rows = page.getByTestId("stock-row");
  const n = Math.min(10, await rows.count());
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const mrp = Number((await row.getByLabel(/^MRP \(₹\) for /).inputValue()) || 0);
    const price = row.getByLabel(/^Selling price \(₹\) for /);
    if (!mrp) await row.getByLabel(/^MRP \(₹\) for /).fill("100");
    await price.click();
    await price.fill(String(Math.max(1, Math.floor((mrp || 100) * 0.9))));
    await price.press("Enter"); // keypad "Next"
  }
  const save = page.getByRole("button", { name: `Save changes (${n})` });
  await save.click();
  await page.getByTestId("stock-toast").waitFor({ timeout: 30_000 });
  priced = n;
  return `${n} prices typed and saved in ${((Date.now() - t0) / 1000).toFixed(1)} s (automated; a person needs ~6–8 s per price)`;
});

await step("Needs Price → Live after save", async () => {
  await page.goto(`${base}/shop/my-products?status=NEEDS_PRICE`);
  const after = await count("Needs Price");
  if (after !== before - priced) throw new Error(`Needs Price ${before} → ${after}, expected ${before - priced}`);
  return `Needs Price ${before} → ${after}`;
});

await step("Pause from ⋮ asks first, then Resume", async () => {
  await page.goto(`${base}/shop/my-products?status=LIVE`);
  const row = page.getByTestId("stock-row").first();
  const name = (await row.locator("p").first().textContent()).trim();
  await row.getByRole("button", { name: `More actions for ${name}` }).first().click();
  await page.getByRole("menuitem", { name: "Pause selling…" }).click();
  await page.getByText(`Pause selling ${name}?`, { exact: false }).waitFor();
  await page.getByRole("button", { name: "Pause selling", exact: true }).click();
  await page.getByTestId("stock-toast").waitFor();
  await page.goto(`${base}/shop/my-products?status=PAUSED`);
  const paused = page.getByTestId("stock-row").filter({ hasText: name });
  await paused.first().waitFor();
  await paused.first().getByRole("button", { name: `More actions for ${name}` }).first().click();
  await page.getByRole("menuitem", { name: "Resume selling" }).click();
  await page.getByTestId("stock-toast").waitFor();
  return `${name}: paused, then resumed`;
});

await step("Unsaved edit → leaving asks to confirm", async () => {
  await page.goto(`${base}/shop/my-products`);
  const row = page.getByTestId("stock-row").first();
  await row.getByLabel(/^Stock for /).fill("77");
  await row.getByTestId("row-edited").waitFor();
  let asked = false;
  page.removeAllListeners("dialog");
  page.once("dialog", (d) => {
    asked = /unsaved/.test(d.message());
    d.dismiss();
  });
  await page.getByTestId("seller-tab-orders").click();
  await page.waitForTimeout(500);
  page.on("dialog", (d) => d.accept());
  if (!asked || !page.url().includes("/shop/my-products")) throw new Error(`asked=${asked} url=${page.url()}`);
  await page.getByRole("button", { name: "Discard" }).click();
  return "confirm shown, stayed on page";
});

await page.screenshot({ path: `${outDir}/flow-end-${width}.png` });
await browser.close();
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.ms} ms | ${r.note}`);
console.log(JSON.stringify(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
