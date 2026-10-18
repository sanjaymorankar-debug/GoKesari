/**
 * Batch 2026-10 — remote checks for test.gokesari.com and gokesari.com
 * (F14.1.3, extends the #51 framework). PRODUCTION-SAFE: every check is a
 * GET of a public page, or a request the server must REFUSE (no signature,
 * no session, no cron secret) — nothing here can create, change or pay for
 * anything.
 *
 *   E2E_BASE_URL=https://test.gokesari.com CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     npx playwright test tests/e2e/batch-2026-10-remote.spec.ts --project=chromium
 *
 * Results are written to test-results/batch-2026-10-<host>.json for the
 * report (docs/test-reports/2026-10-batch.md).
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.E2E_BASE_URL ?? "https://test.gokesari.com";
const HOST = new URL(BASE_URL).host;
const IS_PROD = HOST === "gokesari.com" || HOST === "www.gokesari.com";

interface Row {
  id: string;
  title: string;
  status: "pass" | "fail";
  detail: string;
}
const OUT = `test-results/batch-2026-10-${HOST}.json`;

/**
 * Saves one case's outcome at once (merged by case id into the run's file):
 * Playwright starts a fresh worker after a failure, so an in-memory list
 * written in afterAll would lose every case before the failure.
 */
function save(row: Row) {
  mkdirSync("test-results", { recursive: true });
  const previous: { rows: Row[] } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { rows: [] };
  const rows = [...previous.rows.filter((r) => r.id !== row.id), row].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(OUT, JSON.stringify({ baseUrl: BASE_URL, at: new Date().toISOString(), rows }, null, 2));
}

/** Records the outcome of one case for the report, then rethrows a failure. */
async function tc(id: string, title: string, body: () => Promise<string | void>) {
  try {
    const detail = (await body()) ?? "";
    save({ id, title, status: "pass", detail });
  } catch (error) {
    save({ id, title, status: "fail", detail: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    throw error;
  }
}

async function status(request: APIRequestContext, path: string, init?: { method?: string; data?: unknown; headers?: Record<string, string> }) {
  const res = await request.fetch(new URL(path, BASE_URL).toString(), {
    method: init?.method ?? "GET",
    data: init?.data,
    headers: init?.headers,
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  return res;
}

test.describe(`batch 2026-10 remote checks — ${HOST}`, () => {
  test("TC-B26-R-001 home page renders", async ({ page }) =>
    tc("TC-B26-R-001", "Home page renders", async () => {
      const res = await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("body")).toContainText(/GoKesari/i);
      return `HTTP ${res?.status()}`;
    }));

  test("TC-B26-R-002 shops and search pages load", async ({ request }) =>
    tc("TC-B26-R-002", "Shops and search pages load", async () => {
      for (const path of ["/shops", "/search?q=milk"]) {
        const res = await status(request, path);
        expect(res.status(), path).toBeLessThan(400);
      }
    }));

  test("TC-B26-R-003 sign-in says the code goes to email (F1.1.2)", async ({ page }) =>
    tc("TC-B26-R-003", "Sign-in screen: OTP by email", async () => {
      await page.goto(new URL("/signin", BASE_URL).toString(), { waitUntil: "networkidle" });
      await expect(page.getByTestId("otp-signin")).toBeVisible();
      await expect(page.locator("body")).toContainText(/email/i);
    }));

  test("TC-B26-R-004 assetlinks.json is served as JSON (F15.2.3)", async ({ request }) =>
    tc("TC-B26-R-004", "Android assetlinks.json served", async () => {
      const res = await status(request, "/.well-known/assetlinks.json");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(JSON.stringify(body)).toContain("com.gokesari.app");
      return JSON.stringify(body).slice(0, 160);
    }));

  test("TC-B26-R-005 apple-app-site-association: no extension, application/json (F15.2.3)", async ({ request }) =>
    tc("TC-B26-R-005", "iOS AASA served", async () => {
      const res = await status(request, "/.well-known/apple-app-site-association");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.applinks).toBeTruthy();
      return JSON.stringify(body).slice(0, 160);
    }));

  test("TC-B26-R-006 payment webhook refuses an unsigned call (F1.7.3)", async ({ request }) =>
    tc("TC-B26-R-006", "Payment webhook rejects unsigned request", async () => {
      const res = await status(request, "/api/webhooks/payments/sandbox", {
        method: "POST",
        data: { event: "payment.captured" },
        headers: { "content-type": "application/json" },
      });
      // 401 bad signature; 503 when the site has no secret for that gateway (fail closed).
      expect([400, 401, 403, 404, 503]).toContain(res.status());
      return `HTTP ${res.status()}`;
    }));

  test("TC-B26-R-007 payout webhook refuses an unsigned call (F10.2.4)", async ({ request }) =>
    tc("TC-B26-R-007", "Payout webhook rejects unsigned request", async () => {
      const res = await status(request, "/api/webhooks/payouts/sandbox", {
        method: "POST",
        data: { event: "transfer.success" },
        headers: { "content-type": "application/json" },
      });
      expect([400, 401, 403, 404]).toContain(res.status());
      return `HTTP ${res.status()}`;
    }));

  test("TC-B26-R-008 batch cron routes refuse a call without the cron secret", async ({ request }) =>
    tc("TC-B26-R-008", "Cron routes require the cron secret", async () => {
      const seen: string[] = [];
      for (const job of ["timeout-sweep", "payments-reconcile", "payout-cycle", "broadcast-dispatch", "pmd-ingest", "document-emails", "operator-onboarding", "push-receipts", "aftercare", "auth-housekeeping"]) {
        const path = `/api/cron/${job}`;
        const res = await status(request, path, { method: "POST" });
        expect([401, 403, 404, 405], path).toContain(res.status());
        seen.push(`${path}=${res.status()}`);
      }
      return seen.join(", ");
    }));

  test("TC-B26-R-009 staff and support screens need a sign-in", async ({ request }) =>
    tc("TC-B26-R-009", "New screens require sign-in", async () => {
      const seen: string[] = [];
      for (const path of ["/admin/broadcasts", "/admin/payouts", "/admin/support", "/admin/product-browser", "/admin/platform-invoices", "/admin/statutory", "/operator", "/support", "/notifications", "/manufacturer", "/shop/support"]) {
        const res = await status(request, path);
        // Signed out: a redirect to sign-in, a 401/403, or (before deploy) a 404 — never page content.
        expect([301, 302, 303, 307, 308, 401, 403, 404], path).toContain(res.status());
        seen.push(`${path}=${res.status()}`);
      }
      return seen.join(", ");
    }));

  test("TC-B26-R-010 grievance officer published on the site (F6.3.3)", async ({ page }) =>
    tc("TC-B26-R-010", "Grievance officer details published", async () => {
      const res = await page.goto(new URL("/legal/grievance-redressal", BASE_URL).toString(), { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("body")).toContainText(/grievance officer/i);
    }));

  test("TC-B26-R-011 product page has no online reference prices (F1.4.3 dropped)", async ({ page }) =>
    tc("TC-B26-R-011", "No reference prices on product pages", async () => {
      await page.goto(new URL("/search?q=milk", BASE_URL).toString(), { waitUntil: "domcontentloaded" });
      const link = page.locator('a[href^="/products/"]').first();
      if ((await link.count()) === 0) return "no product link on the search page — nothing to check";
      await link.click();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("body")).not.toContainText(/reference prices/i);
      return page.url();
    }));

  test("TC-B26-R-012 environment banner sanity — production never shows sandbox payment pages", async ({ request }) =>
    tc("TC-B26-R-012", "Sandbox checkout refused on production", async () => {
      const res = await status(request, "/orders/pay/sandbox/00000000-0000-0000-0000-000000000000");
      if (IS_PROD) expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(res.status());
      return `HTTP ${res.status()}${IS_PROD ? " (production)" : " (test site)"}`;
    }));
});
