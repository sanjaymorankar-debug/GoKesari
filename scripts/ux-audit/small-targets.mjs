import { chromium } from "playwright";
const [url, state] = process.argv.slice(2);
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
const p = await c.newPage();
await p.goto(url, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
const out = await p.evaluate(() => {
  const m = new Map();
  for (const t of document.querySelectorAll("a[href],button,[role=button],select,input[type=checkbox]")) {
    const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
    if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
    if (r.width >= 43.5 && r.height >= 43.5) continue;
    const key = `${t.tagName} ${(t.textContent || t.getAttribute("aria-label") || "").trim().replace(/\d+/g, "#").slice(0, 30)} ${Math.round(r.width)}×${Math.round(r.height)} | ${(t.className?.baseVal ?? t.className ?? "").toString().slice(0, 90)}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return [...m].map(([k, n]) => `${n}x ${k}`);
});
console.log(out.join("\n"));
await b.close();
