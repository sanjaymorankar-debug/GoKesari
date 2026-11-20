/**
 * GoKesari Health (docs/health/) as a guest sees it — production-safe: My Health and the clinic screens send a
 * guest to sign in (or say "coming soon" while rule health is off), the prescription QR check answers for a
 * token that does not exist, a share link that does not exist is refused, and every private Health API is
 * refused (401) before the request is read. Only GETs and requests the server must refuse; nothing is changed.
 */
import { anonymous, call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";
import { apiRoutes, NO_SUCH_ID } from "../lib/routes";

/**
 * Health APIs a guest may reach: protected by a token / signature (share link, telephony webhook), or public
 * discovery like Find a Consultant — doctors, home-care providers, equipment listings and the provider ID check
 * (names, qualifications, verification, prices; never patient data).
 */
const PUBLIC_HEALTH_APIS = new Set([
  "/api/health/share/[token]",
  "/api/health/telephony/webhook",
  "/api/health/doctors",
  "/api/health/care/search",
  "/api/health/care/providers/[slug]",
  "/api/health/care/id/[card]",
  "/api/health/equipment/search",
  "/api/health/equipment/listings/[id]",
]);

qa("TC-HLT-001", "My Health sends a guest to sign in", async ({ page }) => {
  const res = await page.goto("/health");
  expect(res?.status(), "/health status").toBeLessThan(500);
  await expect(page).toHaveURL(/\/signin/);
  return `redirected to ${new URL(page.url()).pathname}`;
}, { mobile: true });

qa("TC-HLT-002", "the clinic Today screen and the Health hub send a guest to sign in", async ({ page }) => {
  for (const path of ["/shop/health", "/shop/health/hub", "/shop/health/settings"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/signin/);
  }
  return "3 clinic pages → sign-in";
});

qa("TC-HLT-003", "the prescription QR check says 'not found' for a code that does not exist (no error page)", async ({ page }) => {
  const res = await page.goto("/rx/verify/AAAAAAAAAAAAAAAAAAAAAAAA");
  expect(res?.status(), "verify page status").toBe(200);
  await expect(page.getByTestId("rx-verify")).toHaveAttribute("data-status", "NOT_FOUND");
  return "NOT_FOUND shown";
}, { mobile: true });

qa("TC-HLT-004", "a share link that does not exist (or expired) is refused and returns no file", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/api/health/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status, "unknown share link").toBe(404);
    expect(res.text ?? "").not.toContain("%PDF");
    return `GET unknown share link → ${res.status}`;
  } finally {
    await guest.dispose();
  }
});

qa("TC-HLT-005", "a guest cannot use any private Health API (401 before the request is read)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  const bad: string[] = [];
  try {
    const routes = apiRoutes().filter((r) => (r.path.startsWith("/api/health/") || r.path.startsWith("/api/admin/health")) && !PUBLIC_HEALTH_APIS.has(r.path));
    expect(routes.length, "Health API routes found in the checkout").toBeGreaterThanOrEqual(20);
    for (const r of routes) {
      if (r.path === "/api/health/stream") continue; // checked below (a stream, not JSON)
      for (const method of r.methods) {
        await pace();
        const path = r.path.replace(/\[[^\]]+\]/g, NO_SUCH_ID);
        const res = await call(guest, method as "GET", path, method === "GET" ? undefined : {});
        seen.push(`${method} ${r.path} ${res.status}`);
        if (res.status !== 401) bad.push(`${method} ${r.path} → ${res.status}`);
      }
    }
    const stream = await call(guest, "GET", "/api/health/stream");
    if (stream.status !== 401) bad.push(`GET /api/health/stream → ${stream.status}`);
  } finally {
    await guest.dispose();
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return `${seen.length + 1} calls, all 401`;
}, { timeout: 300_000 }); // ~70 routes; a dev server compiles each on first call
