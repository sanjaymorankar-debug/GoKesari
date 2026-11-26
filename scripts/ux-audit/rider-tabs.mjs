import { chromium } from "playwright";
const [base, state] = process.argv.slice(2);
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, storageState: state }); const p = await c.newPage();
for (const path of ["/delivery-partner", "/delivery-partner/documents", "/delivery-partner/apply"]) {
  await p.goto(base + path, { waitUntil: "networkidle" }); await p.waitForTimeout(300);
  const tabs = await p.locator("[data-testid^=rider-tab-]").evaluateAll((els) => els.map((e) => e.dataset.testid.replace("rider-tab-", "") + (e.getAttribute("aria-current") ? "*" : "")));
  console.log(path, "→", p.url().replace(base, ""), tabs.join(" "));
}
await p.goto(base + "/delivery-partner"); await p.getByTestId("rider-tab-documents").click(); await p.waitForURL(/documents/); console.log("Documents tab →", p.url().replace(base, ""));
await b.close();
