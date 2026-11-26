import { chromium } from "playwright";
const [base, state] = process.argv.slice(2);
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, storageState: state }); const p = await c.newPage();
await p.goto(base + "/delivery-partner", { waitUntil: "networkidle" });
for (const k of ["earnings", "payouts"]) {
  await p.getByTestId(`rider-tab-${k}`).click(); await p.waitForTimeout(600);
  const top = await p.locator(`#rider-${k}`).evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const cur = await p.getByTestId(`rider-tab-${k}`).getAttribute("aria-current");
  console.log(k, "section top", top, "px; tab current:", cur);
}
await p.screenshot({ path: process.argv[4] });
const small = await p.evaluate(() => [...document.querySelectorAll("a[href],button")].filter((t) => { const r = t.getBoundingClientRect(); return r.width && r.height && (r.width < 43.5 || r.height < 43.5); }).map((t) => (t.textContent || "").trim().slice(0, 20) + " " + Math.round(t.getBoundingClientRect().width) + "×" + Math.round(t.getBoundingClientRect().height)));
console.log("small targets:", small.length, small.slice(0, 6));
await b.close();
