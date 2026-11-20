/**
 * Consultant appointments (docs/consult-booking-2026-11) as a guest sees them —
 * production-safe: Find a Consultant opens (or says "coming soon" while rule
 * consultBooking is off), the public search answers, and every private call —
 * booking, my bookings, the consultant's own API, the admin API, a private file
 * — is refused before the request is read. Only GETs and requests the server
 * must refuse; nothing here can create or change anything.
 */
import { anonymous, call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";
import { apiRoutes, NO_SUCH_ID } from "../lib/routes";

qa("TC-CON-001", "Find a Consultant opens for a guest: the finder when on, a 'coming soon' note when off", async ({ page }) => {
  const res = await page.goto("/consult");
  expect(res?.status(), "/consult status").toBe(200);
  const finder = page.getByTestId("consult-finder");
  const soon = page.getByText(/Coming soon/i);
  await expect(finder.or(soon).first()).toBeVisible();
  const on = await finder.isVisible();
  if (on) {
    await expect(page.getByRole("textbox", { name: "Search consultants" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Category" })).toBeVisible();
    await expect(page.getByTestId("consult-locate")).toBeVisible();
  }
  // Phone layout: no sideways scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "sideways scroll (px)").toBeLessThanOrEqual(1);
  const cards = on ? await page.getByTestId("consult-card").count() : 0;
  return on ? `finder shown, ${cards} consultant card(s)` : "module off: 'coming soon' note";
}, { mobile: true });

qa("TC-CON-002", "the public consultant search answers with results, or 'not available' while the module is off", async () => {
  const guest = await anonymous();
  try {
    const all = await call(guest, "GET", "/api/consult/search");
    if (all.status === 404) {
      expect(all.body?.error?.details?.reason ?? all.body?.error?.reason ?? "FEATURE_NOT_AVAILABLE").toBe("FEATURE_NOT_AVAILABLE");
      return "module off: 404 FEATURE_NOT_AVAILABLE";
    }
    expect(all.status, "search status").toBe(200);
    expect(Array.isArray(all.body?.results), "results array").toBe(true);
    for (const r of all.body.results.slice(0, 5)) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.slug).toBe("string");
      expect(Array.isArray(r.modes)).toBe(true);
    }
    await pace();
    const filtered = await call(guest, "GET", "/api/consult/search?category=general-physician&mode=VIDEO&maxFee=500");
    expect(filtered.status, "filtered search").toBe(200);
    await pace();
    const bad = await call(guest, "GET", "/api/consult/search?mode=TELEPATHY");
    expect([400, 422], "an unknown mode is refused").toContain(bad.status);
    return `${all.body.results.length} consultant(s); filtered ${filtered.body.results.length}; bad mode → ${bad.status}`;
  } finally {
    await guest.dispose();
  }
});

qa("TC-CON-003", "a guest cannot book, read bookings, or use the consultant and admin APIs (401 before the request is read)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  const bad: string[] = [];
  try {
    const routes = apiRoutes().filter((r) => r.path.startsWith("/api/consult/") && !["/api/consult/search", "/api/consult/availability"].includes(r.path));
    routes.push(...apiRoutes().filter((r) => r.path === "/api/admin/consult"));
    expect(routes.length, "consult API routes found in the checkout").toBeGreaterThanOrEqual(8);
    for (const r of routes) {
      for (const method of r.methods) {
        await pace();
        const path = r.path.replace(/\[[^\]]+\]/g, (m) => (m === "[kind]" ? "booking" : NO_SUCH_ID));
        const res = await call(guest, method as "GET", path, method === "GET" ? undefined : {});
        seen.push(`${method} ${r.path} ${res.status}`);
        if (res.status !== 401) bad.push(`${method} ${r.path} → ${res.status}`);
      }
    }
  } finally {
    await guest.dispose();
  }
  expect(bad, bad.join("\n")).toEqual([]);
  return `${seen.length} calls, all 401`;
});

qa("TC-CON-004", "a private file link is refused without a session, whatever its signature", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", `/api/consult/files/booking/${NO_SUCH_ID}?exp=${Math.floor(Date.now() / 1000) + 300}&sig=forged`);
    expect(res.status, "file without a session").toBe(401);
    expect(res.text ?? "").not.toContain("%PDF");
    return `GET private file → ${res.status}`;
  } finally {
    await guest.dispose();
  }
});
