/**
 * Inventory & Accounting read-only smoke test for a live site — no sign-in,
 * no test data, no writes. For gokesari.com (production) after a release, and
 * for test.gokesari.com as a baseline. Prints one JSON line per case.
 *
 *   node scripts/test-site/prod-smoke.mjs https://gokesari.com
 *
 * A failed migration stops the Hostinger build (MIGRATE_ON_BUILD=true), so the
 * module's routes answering here (401 / sign-in redirect instead of 404) also
 * shows that migration 0076 ran.
 */
import { chromium } from "@playwright/test";

const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: prod-smoke.mjs <base url>");
  process.exit(2);
}
const ENV = new URL(base).host;
const NO_SHOP = "00000000-0000-4000-8000-000000000000";
const APP_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.0.0 (android)";
const results = [];
function record(id, title, result, detail = "") {
  const row = { id, title, env: ENV, result, detail };
  results.push(row);
  console.log(JSON.stringify(row));
}
async function check(id, title, fn) {
  try {
    const [ok, detail] = await fn();
    record(id, title, ok ? "PASS" : "FAIL", detail);
  } catch (e) {
    record(id, title, "FAIL", String(e?.message ?? e).slice(0, 300));
  }
}
const get = (path, init = {}) => fetch(base + path, { redirect: "manual", ...init });
const isSignInRedirect = (r) => [302, 303, 307, 308].includes(r.status) && /\/signin/.test(r.headers.get("location") ?? "");

const PAGES = ["/shop/accounts", "/shop/accounts/capture", "/shop/accounts/bills", "/shop/accounts/purchases", "/shop/accounts/sales", "/shop/accounts/parties", "/shop/accounts/money", "/shop/accounts/stock", "/shop/accounts/gst", "/shop/accounts/gst/reconcile", "/shop/accounts/reports", "/shop/accounts/settings"];
await check("PS-PAGES", `All ${PAGES.length} module pages ask a signed-out visitor to sign in (no 404 / 500)`, async () => {
  const bad = [];
  for (const p of PAGES) {
    const r = await get(p);
    if (!isSignInRedirect(r)) bad.push(`${p} → ${r.status}`);
  }
  return [bad.length === 0, bad.length ? bad.join("; ") : "all redirect to /signin"];
});

const API = ["settings", "bills", "purchases", "sales", "parties", "stock", "gst/liability", "reports/pnl?format=json"];
await check("PS-API", "Module API refuses a request without a session (401) on every resource", async () => {
  const bad = [];
  for (const p of API) {
    const r = await get(`/api/shops/${NO_SHOP}/accounts/${p}`);
    if (r.status !== 401) bad.push(`${p} → ${r.status}`);
  }
  return [bad.length === 0, bad.length ? bad.join("; ") : `${API.length} resources → 401`];
});
await check("PS-API-WRITE", "Module API refuses a write without a session (bill upload → 401)", async () => {
  const r = await get(`/api/shops/${NO_SHOP}/accounts/bills`, { method: "POST", body: new FormData() });
  return [r.status === 401, `POST bills → ${r.status}`];
});
for (const [id, path] of [["PS-CRON-BILLS", "/api/cron/bill-captures"], ["PS-CRON-GST", "/api/cron/gst-reminders"]]) {
  await check(id, `${path} refuses a call without the cron secret`, async () => {
    const r = await get(path, { method: "POST", headers: { authorization: "Bearer wrong" } });
    return [r.status === 401 || r.status === 403, `→ ${r.status}`];
  });
}
await check("PS-INBOUND", "Bill email endpoint refuses a post without its secret", async () => {
  const r = await get("/api/inbound/bill-email", { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" });
  return [r.status === 401 || r.status === 403 || r.status === 503, `→ ${r.status}`];
});
await check("PS-SHARE", "Share target (/shop/accounts/share) sends a signed-out share to sign-in", async () => {
  const r = await get("/shop/accounts/share", { method: "POST", body: new FormData() });
  const location = r.headers.get("location") ?? "";
  // The redirect must stay on this site (not the server's own 0.0.0.0:3000 address).
  return [isSignInRedirect(r) && new URL(location, base).origin === new URL(base).origin, `→ ${r.status} ${location}`];
});
await check("PS-MANIFEST", "Web app manifest has the bill share target and the Scan bill shortcut", async () => {
  const r = await get("/manifest.webmanifest");
  const m = await r.json();
  const ok = m.share_target?.action === "/shop/accounts/share" && (m.shortcuts ?? []).some((s) => /accounts\/capture/.test(s.url));
  return [ok, `share_target ${m.share_target?.action ?? "missing"}; shortcuts ${(m.shortcuts ?? []).map((s) => s.url).join(", ")}`];
});
await check("PS-EXISTING", "Existing pages still answer (/, /shops, /signin, /shop → sign-in)", async () => {
  const out = [];
  let ok = true;
  for (const p of ["/", "/shops", "/signin"]) {
    const r = await get(p);
    out.push(`${p} ${r.status}`);
    ok &&= r.status === 200;
  }
  const s = await get("/shop");
  out.push(`/shop ${s.status}`);
  ok &&= isSignInRedirect(s);
  return [ok, out.join(", ")];
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
for (const [id, label, opts] of [
  ["PS-UI-DESKTOP", "desktop", { viewport: { width: 1280, height: 900 } }],
  ["PS-UI-ANDROID", "Android app", { viewport: { width: 393, height: 851 }, userAgent: APP_UA, isMobile: true, hasTouch: true }],
]) {
  await check(id, `Opening Bills & GST signed out (${label}) lands on the sign-in form with no page errors`, async () => {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/shop/accounts`);
    await page.getByLabel("Mobile number or email").waitFor({ timeout: 90_000 });
    const url = new URL(page.url());
    await ctx.close();
    const ok = url.pathname === "/signin" && /shop\/accounts/.test(decodeURIComponent(url.search)) && errors.length === 0;
    return [ok, `${url.pathname}${url.search}; page errors ${errors.length}`];
  });
}
await browser.close();

const passed = results.filter((r) => r.result === "PASS").length;
console.log(JSON.stringify({ summary: { env: ENV, total: results.length, passed, failed: results.length - passed } }));
process.exitCode = passed === results.length ? 0 : 1;
