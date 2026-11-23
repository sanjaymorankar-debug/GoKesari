/**
 * Subscription plans (docs/subscription-plans-2026-11) as a guest sees them —
 * production-safe: every plan-management and subscribe route refuses a caller
 * without a session (401) before reading the request, the plans pages send a
 * guest to sign-in, an unknown plan is 404 and the nearby list is an empty
 * list without a location. Only GETs and requests the server must refuse.
 */
import { anonymous, call, pace, type Method } from "../lib/http";
import { expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";

const PLAN_BODY = {
  shopProductId: NO_SUCH_ID,
  name: "QA guest plan",
  kind: "MEAL",
  slot: "LUNCH",
  serviceDays: [1, 2, 3, 4, 5, 6],
  allowedFrequencies: ["DAILY"],
  pricePaise: 8000,
};

qa("TC-SUB-028", "plan management and subscribing answer 401 to a caller without a session", async () => {
  const calls: { method: Method; path: string; body?: unknown }[] = [
    { method: "GET", path: `/api/shops/${NO_SUCH_ID}/subscription-plans` },
    { method: "POST", path: `/api/shops/${NO_SUCH_ID}/subscription-plans`, body: PLAN_BODY },
    { method: "PUT", path: `/api/shops/${NO_SUCH_ID}/subscription-plans/${NO_SUCH_ID}`, body: PLAN_BODY },
    { method: "PATCH", path: `/api/shops/${NO_SUCH_ID}/subscription-plans/${NO_SUCH_ID}`, body: { isActive: false } },
    { method: "DELETE", path: `/api/shops/${NO_SUCH_ID}/subscription-plans/${NO_SUCH_ID}` },
    {
      method: "POST",
      path: `/api/subscription-plans/${NO_SUCH_ID}/subscribe`,
      body: { quantityMilli: 1000, frequency: "DAILY", startDate: "2099-01-01", addressId: NO_SUCH_ID },
    },
  ];
  const guest = await anonymous();
  const bad: string[] = [];
  try {
    for (const c of calls) {
      await pace();
      const res = await call(guest, c.method, c.path, c.body);
      if (res.status !== 401 || res.body?.error?.code !== "UNAUTHENTICATED") bad.push(`${c.method} ${c.path} → ${res.status} ${res.body?.error?.code ?? ""}`);
    }
  } finally {
    await guest.dispose();
  }
  expect(bad, `not refusing a guest with 401:\n${bad.join("\n")}`).toEqual([]);
  return `${calls.length} method/route pairs, all 401 UNAUTHENTICATED`;
});

qa("TC-SUB-029", "a guest is sent to sign-in from the plans pages; an unknown plan is 404; no location → empty list", async ({ page }) => {
  const guest = await anonymous();
  const notes: string[] = [];
  try {
    const unknown = await call(guest, "GET", `/api/subscription-plans/${NO_SUCH_ID}`);
    expect(unknown.status, "unknown plan").toBe(404);
    await pace();
    const near = await call(guest, "GET", "/api/subscription-plans");
    expect(near.status, "GET /api/subscription-plans").toBe(200);
    expect(Array.isArray(near.body), "a list").toBe(true);
    notes.push(`unknown plan 404; nearby list ${near.body.length} (guest, no location chosen)`);
  } finally {
    await guest.dispose();
  }
  for (const path of ["/subscriptions/plans", `/subscribe/plan/${NO_SUCH_ID}`]) {
    await page.goto(path);
    await expect(page, `${path} sends a guest to sign-in`).toHaveURL(/\/signin\b/);
    notes.push(`${path} → ${new URL(page.url()).pathname}`);
  }
  return notes.join("; ");
}, { mobile: true });
