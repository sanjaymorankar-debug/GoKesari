#!/usr/bin/env node
/**
 * Shop phone home (docs/ux-mobile-2026-11): today's sales shows, Accept from the home card in one tap,
 * Reject with a one-tap reason. Usage: node scripts/ux-audit/home-orders.mjs <baseUrl> <shopState.json> <shotDir>
 * Changes real orders: run it on local or test shops only.
 */
import { chromium } from "playwright";
const [base, state, dir = "."] = process.argv.slice(2);
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state, deviceScaleFactor: 2 });
const p = await c.newPage();
const out = [];
const check = async (name, fn) => { const t = Date.now(); try { out.push(`PASS | ${name} | ${Date.now() - t + (await fn() ? "" : "")} | ${await Promise.resolve("")}`); } catch (e) { out.push(`FAIL | ${name} | ${String(e).split("\n")[0].slice(0, 160)}`); } };
await p.goto(base + "/shop"); await p.evaluate(() => localStorage.setItem("gk-seller-tour-v1", "seen")); await p.goto(base + "/shop", { waitUntil: "networkidle" });
await p.screenshot({ path: `${dir}/home-orders-before.png` });
let note = "";
await check("Today's sales shown", async () => { note = (await p.getByTestId("shop-quick-today").innerText()).replace(/\n/g, " "); out.push(`  today: ${note}`); return true; });
const before = await p.getByTestId("home-new-order").count();
out.push(`  new orders on card: ${before}; heading: ${(await p.locator("#home-new-orders").innerText())}`);
await check("Accept from home in 1 tap", async () => {
  const first = p.getByTestId("home-new-order").first(); const num = (await first.locator("span.font-bold").first().innerText());
  await first.getByTestId("home-accept").click();
  await p.getByTestId("home-order-message").filter({ hasText: "accepted" }).waitFor({ timeout: 20000 });
  out.push(`  accepted ${num}`); return true;
});
await check("Reject with a one-tap reason (2 taps + confirm)", async () => {
  await p.waitForLoadState("networkidle");
  const first = p.getByTestId("home-new-order").first(); const num = (await first.locator("span.font-bold").first().innerText());
  await first.getByTestId("home-reject").click();
  await p.getByTestId("home-reject-confirm").waitFor();
  if (!(await p.getByTestId("home-reject-confirm").isDisabled())) throw new Error("confirm enabled before a reason");
  await p.getByRole("button", { name: "Items out of stock" }).click();
  await p.getByTestId("home-reject-confirm").click();
  await p.getByTestId("home-order-message").filter({ hasText: "rejected" }).waitFor({ timeout: 20000 });
  out.push(`  rejected ${num}`); return true;
});
await p.waitForTimeout(1500);
await p.screenshot({ path: `${dir}/home-orders-after.png` });
out.push(`  heading after: ${(await p.locator("#home-new-orders").innerText().catch(() => "none"))}`);
console.log(out.join("\n"));
await b.close();
