/**
 * Franchise & territory zones (docs/franchise, PRs #465 / #478), P0 case of the 23-Nov-2026 plan as a guest sees it:
 * the signed-in franchise pages and every franchise write API refuse a caller without a session, while the public
 * franchise pages stay open. Guest tier (production-safe): GETs of pages and requests the server must refuse;
 * nothing here creates or changes anything.
 */
import { anonymous, call, callApp, pace, type Answer } from "../lib/http";
import { expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import { BASE_URL } from "../lib/target";

/** Where a redirect answer points (path + query, decoded), or null when it is not a redirect. */
function redirectTarget(res: Answer): string | null {
  if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) return null;
  const url = new URL(res.location, BASE_URL);
  return decodeURIComponent(`${url.pathname}${url.search}`);
}

qa("TC-FRN-008", "signed-in franchise pages send a guest to sign-in and come back; every franchise and admin-franchise write API answers 401 before reading the body; the public franchise pages stay open", async () => {
  const guest = await anonymous();
  const bad: string[] = [];
  try {
    // 1. Pages: each redirects to /signin with callbackUrl back to it.
    const pages = ["/franchise/my", `/franchise/my/receipt/${NO_SUCH_ID}`, "/admin/franchise"];
    for (const path of pages) {
      await pace();
      const res = await call(guest, "GET", path);
      const to = redirectTarget(res);
      if (to !== `/signin?callbackUrl=${path}`) bad.push(`GET ${path} → ${res.status}${res.location ? ` ${res.location}` : ""} (expected a redirect to /signin?callbackUrl=${path})`);
      if (/₹|franchise fee|Your franchise/i.test(res.text) && res.status === 200) bad.push(`GET ${path} showed franchise data to a guest`);
    }

    // 2–3. Every write answers 401 "Please sign in to continue." with an empty JSON body (DELETE: no body).
    const writes: { method: "POST" | "PUT" | "DELETE"; path: string }[] = [
      { method: "POST", path: "/api/franchise/cart" },
      { method: "POST", path: "/api/franchise/bookings" },
      { method: "POST", path: "/api/franchise/buyer" },
      { method: "POST", path: "/api/franchise/agreement" },
      { method: "POST", path: `/api/franchise/bookings/${NO_SUCH_ID}/pay` },
      { method: "POST", path: `/api/franchise/allocations/${NO_SUCH_ID}/renew` },
      { method: "DELETE", path: `/api/franchise/bookings/${NO_SUCH_ID}` },
      { method: "PUT", path: "/api/admin/franchise/config" },
      { method: "POST", path: "/api/admin/franchise/zones/status" },
      { method: "POST", path: "/api/admin/franchise/fees" },
      { method: "POST", path: "/api/admin/franchise/coupons" },
      { method: "POST", path: `/api/admin/franchise/bookings/${NO_SUCH_ID}/refund` },
    ];
    const hostAnswers: string[] = [];
    for (const w of writes) {
      await pace();
      const res = await callApp(guest, w.method, w.path, w.method === "DELETE" ? undefined : {});
      if (res.host) {
        hostAnswers.push(`${w.method} ${w.path} → ${res.status}`);
        continue;
      }
      const message = res.body?.error?.message;
      if (res.status !== 401 || message !== "Please sign in to continue.") bad.push(`${w.method} ${w.path} → ${res.status} ${res.body?.error?.code ?? ""} "${message ?? res.text.slice(0, 80)}" (expected 401 "Please sign in to continue.")`);
    }

    // The public franchise pages stay open to a guest.
    const zones = await call(guest, "GET", "/api/franchise/zones");
    expect(zones.status, "GET /api/franchise/zones (public)").toBe(200);
    const zoneId: string | undefined = zones.body?.zones?.[0]?.zoneId;
    const open = ["/franchise", "/franchise/book", ...(zoneId ? [`/franchise/zones/${zoneId}`] : []), "/dealer/commission-chart", "/app"];
    for (const path of open) {
      await pace();
      const res = await call(guest, "GET", path);
      if (res.status !== 200) bad.push(`public page ${path} → ${res.status}${res.location ? ` ${res.location}` : ""} (expected 200)`);
    }

    expect(bad, bad.join("\n")).toEqual([]);
    const done = `${pages.length} pages → /signin?callbackUrl=<page>; ${writes.length - hostAnswers.length} writes → 401 "Please sign in to continue."; public pages open: ${open.join(", ")}`;
    // The host's own answer (E-01) reached no route: noted, not failed (as in access.spec.ts).
    return hostAnswers.length ? `${done}; answered by the host, not the app (E-01): ${hostAnswers.join(", ")}` : done;
  } finally {
    await guest.dispose();
  }
}, { timeout: 300_000 });
