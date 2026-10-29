/**
 * Guest access (production-safe): every signed-in page sends a guest to
 * sign-in, every write API refuses a caller without a session, and every
 * endpoint guarded by a secret refuses a call without it. Nothing here can
 * create or change anything — each request is one the server must refuse.
 */
import { anonymous, call, callApp, fromApp, isSignInShell, pace, refusesGuest, type Answer } from "../lib/http";
import { expect, qa } from "../lib/record";
import { apiRoutes, fill, isDynamic, NO_SUCH_ID, pagePaths, PUBLIC_PAGES, PUBLIC_WRITES, SECRET_PREFIXES } from "../lib/routes";
import { IS_PROD, IS_REMOTE, TARGET } from "../lib/target";

/** Public forms with a per-IP limit of a handful of calls (5–10 per 10–60 minutes). */
const TIGHT_LIMITS = new Set(["/api/grievances", "/api/shop-registrations", "/api/shop-registrations/otp", "/api/otp/request", "/api/referral-requests"]);

const WRITE = ["POST", "PUT", "PATCH", "DELETE"] as const;

function summarize(bad: string[], total: number, what: string) {
  expect(bad, `${bad.length} of ${total} ${what}:\n${bad.join("\n")}`).toEqual([]);
  return `${total} ${what.replace(/^not /, "")}: all refused`;
}

qa(["TC-RBAC-002", "TC-AUTH-033"], "guest is sent to sign-in from every signed-in page; the account APIs answer 401", async () => {
  const guest = await anonymous();
  const pages = pagePaths().filter((p) => !PUBLIC_PAGES.has(p));
  const bad: string[] = [];
  const hostAnswers: string[] = [];
  for (const path of pages) {
    await pace();
    let res = await call(guest, "GET", fill(path));
    // A guest must never see a signed-in page: sign-in redirect, 401/403, or 404 for an id that does not exist.
    const closedToGuest = (r: Answer) => refusesGuest(r) || isSignInShell(path, r) || (isDynamic(path) && r.status === 404);
    if (!closedToGuest(res) && IS_REMOTE) {
      // A deployed site can answer oddly for a moment (a host redirect while the app restarts);
      // only an answer that is still wrong on a second look counts.
      await new Promise((r) => setTimeout(r, 5000));
      res = await call(guest, "GET", fill(path));
    }
    if (!closedToGuest(res) && IS_REMOTE && !fromApp(res.headers)) {
      // Still the host's own answer: it showed the guest nothing, so it is noted, not failed (E-01).
      hostAnswers.push(`${path} → ${res.status}${res.location ? ` ${res.location}` : ""}`);
      continue;
    }
    if (!closedToGuest(res)) bad.push(`${path} → ${res.status}${res.location ? ` ${res.location}` : ""}`);
  }
  for (const path of ["/api/wallet", "/api/orders", "/api/cart", "/api/notifications", "/api/addresses", "/api/subscriptions", "/api/profile"]) {
    const res = await call(guest, "GET", path);
    if (res.status !== 401) bad.push(`GET ${path} → ${res.status} (expected 401)`);
  }
  await guest.dispose();
  const done = summarize(bad, pages.length + 7, "signed-in pages and account APIs not closed to a guest");
  return hostAnswers.length ? `${done}; answered by the host, not the app (E-01): ${hostAnswers.join(", ")}` : done;
}, { timeout: 600_000 });

/** The write endpoints a session protects (everything but PUBLIC_WRITES and secret-guarded prefixes). */
function sessionWrites() {
  return apiRoutes()
    .filter((r) => !PUBLIC_WRITES[r.path] && !Object.keys(SECRET_PREFIXES).some((p) => r.path.startsWith(p)))
    .flatMap((r) => r.methods.filter((m): m is (typeof WRITE)[number] => (WRITE as readonly string[]).includes(m)).map((m) => ({ ...r, method: m })));
}

qa(["TC-SEC-001", "TC-RBAC-002"], "every write API refuses a caller without a session (401/403) before reading the request", async () => {
  const guest = await anonymous();
  const writes = sessionWrites();
  const bad: string[] = [];
  const hostAnswers: string[] = [];
  for (const w of writes) {
    await pace();
    // An empty JSON body and an id that exists nowhere: a route that checks the
    // session first answers 401; one that validates or looks up first leaks
    // field names or whether a record exists.
    const res = await callApp(guest, w.method, fill(w.path), w.method === "DELETE" ? undefined : {});
    if (res.status === 401 || res.status === 403) continue;
    // The host's own answer (E-01) reached no route: noted, not failed.
    if (res.host) hostAnswers.push(`${w.method} ${w.path} → ${res.status}`);
    else bad.push(`${w.method} ${w.path} → ${res.status} ${res.body?.error?.code ?? ""}`.trim());
  }
  await guest.dispose();
  const done = summarize(bad, writes.length, "session-protected write endpoints not refusing a guest");
  return hostAnswers.length ? `${done}; answered by the host, not the app (E-01): ${hostAnswers.join(", ")}` : done;
}, { timeout: 600_000 });

qa("TC-SEC-001", "public write endpoints refuse an empty call without a server error", async () => {
  const guest = await anonymous();
  const bad: string[] = [];
  const skippedRemote: string[] = [];
  const hostAnswers: string[] = [];
  let total = 0;
  for (const r of apiRoutes().filter((x) => PUBLIC_WRITES[x.path])) {
    for (const method of r.methods.filter((m) => m !== "GET")) {
      if (r.path === "/api/location" && method === "DELETE") continue; // clears the guest's own location cookie: harmless by design
      // On the sites, leave the tightly limited public forms alone: their per-IP limit (5–10 calls)
      // could be shared with real users if the host does not pass the caller's IP.
      if (IS_REMOTE && TIGHT_LIMITS.has(r.path)) {
        skippedRemote.push(r.path);
        continue;
      }
      total += 1;
      const res = await callApp(guest, method, fill(r.path), method === "DELETE" ? undefined : {});
      if (res.host) {
        hostAnswers.push(`${method} ${r.path} → ${res.status}`);
        continue;
      }
      // Refused: validation (400/422), not found (404), signature/secret (401/403), not configured (503).
      // The referral-code check only reads (a blank code is valid while referral is optional): 200 is fine.
      const readOnly = r.path === "/api/shop-registrations/referral-check" && res.status === 200;
      if ((res.status < 400 && !readOnly) || res.status === 500) bad.push(`${method} ${r.path} → ${res.status}`);
    }
  }
  await guest.dispose();
  const note = [summarize(bad, total, "public write endpoints accepting an empty call")];
  if (skippedRemote.length) note.push(`not sent on this site (tight per-IP limits): ${skippedRemote.join(", ")}`);
  if (hostAnswers.length) note.push(`answered by the host, not the app (E-01): ${hostAnswers.join(", ")}`);
  return note.join("; ");
});

qa(["TC-DSP-022", "TC-SEC-001"], "cron endpoints refuse calls with no token and with a wrong token", async () => {
  const guest = await anonymous();
  const crons = apiRoutes().filter((r) => r.path.startsWith("/api/cron/"));
  const bad: string[] = [];
  let posts = 0;
  for (const r of crons) {
    if (r.methods.includes("GET")) {
      // GET checks the secret without the shared cron rate limit, so it costs the real cron runs nothing.
      for (const headers of [{}, { authorization: "Bearer wrong-cron-secret" }] as Record<string, string>[]) {
        const res = await call(guest, "GET", fill(r.path), undefined, { headers });
        // 410: the retired legacy per-job routes (src/proxy.ts) refuse every caller, which is a refusal too.
        if (res.status !== 401 && res.status !== 403 && res.status !== 410) bad.push(`GET ${r.path} ${Object.keys(headers).length ? "wrong token" : "no token"} → ${res.status}`);
      }
    } else if (r.methods.includes("POST")) {
      // POST-only crons: one wrong-token call each, paced well under the 30-a-minute cron limit
      // (the limit is shared with the site's own cron calls).
      if (posts > 0) await new Promise((resolve) => setTimeout(resolve, 4000));
      posts += 1;
      const res = await call(guest, "POST", fill(r.path), {}, { headers: { authorization: "Bearer wrong-cron-secret" } });
      if (res.status !== 401 && res.status !== 403 && res.status !== 410) bad.push(`POST ${r.path} wrong token → ${res.status}`);
    }
  }
  await guest.dispose();
  expect(crons.length, "cron routes found").toBeGreaterThan(5);
  return summarize(bad, crons.length, "cron endpoints not refusing a missing/wrong token");
}, { timeout: 300_000, partial: "'nothing runs' is proven by the refusal; the POST of GET-capable crons is not sent, to leave the shared cron rate limit to the real runs" });

qa("TC-PAY-005", "payment webhooks reject a call with no signature and with a wrong signature", async () => {
  const guest = await anonymous();
  const bad: string[] = [];
  const event = { type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: `qa-${NO_SUCH_ID}`, order_amount: 1 }, payment: { payment_status: "SUCCESS", payment_amount: 1 } } };
  const targets = ["/api/webhooks/cashfree", "/api/webhooks/payments/cashfree", "/api/webhooks/payouts/cashfree"];
  for (const path of targets) {
    for (const headers of [{}, { "x-webhook-signature": "d3Jvbmc=", "x-webhook-timestamp": String(Date.now()) }] as Record<string, string>[]) {
      const res = await call(guest, "POST", path, event, { headers });
      // 503 = the gateway is not configured on this server (local); it still refuses.
      if (res.status < 400 || res.status === 500) bad.push(`${path} ${Object.keys(headers).length ? "wrong signature" : "no signature"} → ${res.status}`);
    }
  }
  await guest.dispose();
  return summarize(bad, targets.length * 2, "webhook calls not rejected");
}, { partial: "'no payment state changes' is proven by the refusal status only; the database is not read on remote sites" });

qa("TC-PAY-022", "order-payment webhook rejects a wrong signature", async () => {
  const guest = await anonymous();
  const res = await call(guest, "POST", "/api/webhooks/payments/cashfree", { type: "PAYMENT_SUCCESS_WEBHOOK", data: {} }, { headers: { "x-webhook-signature": "AAAA", "x-webhook-timestamp": String(Date.now()) } });
  await guest.dispose();
  expect(res.status, `wrong-signature webhook — HTTP ${res.status}`).toBeGreaterThanOrEqual(400);
  expect(res.status).not.toBe(500);
  return `wrong signature → ${res.status}`;
}, { partial: "the duplicate-valid-webhook half needs a signed webhook (gateway secret): covered by tests/integration/cashfree-order-confirmation.test.ts" });

qa("TC-PAY-016", "development top-up and settle endpoints are not usable on this site", async () => {
  const guest = await anonymous();
  const out: string[] = [];
  for (const path of ["/api/dev/settle-topup", "/api/dev/settle-registration"]) {
    const res = await call(guest, "POST", path, { paymentId: NO_SUCH_ID });
    expect([401, 403, 404], `${path} — HTTP ${res.status}`).toContain(res.status);
    out.push(`${path} → ${res.status}`);
  }
  await guest.dispose();
  return out.join("; ");
}, { partial: "checked signed out; the signed-in half is in tests/qa/signed-in" });

function closed(res: Answer) {
  return res.status === 401 || res.status === 403 || ([302, 303, 307, 308].includes(res.status) && /\/signin/.test(res.location ?? ""));
}

const PRIVATE_READS: [string[], string, string[]][] = [
  [["TC-PMD-006"], "product master APIs", ["/api/pmd/products", "/api/pmd/stats", "/api/product-master/products", "/api/product-master/brands"]],
  [["TC-FIN-031"], "invoices", [`/api/invoices/${NO_SUCH_ID}`, `/api/invoices/${NO_SUCH_ID}/pdf`]],
  [["TC-NTF-012"], "notifications", ["/api/notifications"]],
  [["TC-SPI-027"], "shop inventory", [`/api/shops/${NO_SUCH_ID}/inventory`, `/api/shops/${NO_SUCH_ID}/stock-movements`]],
  [["TC-FIN-027"], "finance APIs", ["/api/finance/settlements", "/api/finance/summary"]],
  [["TC-KPI-002", "TC-KPI-001"], "analytics", ["/api/analytics/kpis", `/api/shops/${NO_SUCH_ID}/analytics`]],
  [["TC-MKT-013"], "marketing APIs", [`/api/shops/${NO_SUCH_ID}/marketing/segments`, `/api/shops/${NO_SUCH_ID}/marketing/campaigns`]],
];

for (const [ids, what, paths] of PRIVATE_READS) {
  qa(ids, `${what} are closed to a guest`, async () => {
    const guest = await anonymous();
    const known = new Set(apiRoutes().map((r) => r.path));
    const out: string[] = [];
    const bad: string[] = [];
    for (const path of paths) {
      const res = await call(guest, "GET", path);
      // A path that is not an API route at all answers 404 — note it, it proves nothing.
      if (res.status === 404 && ![...known].some((k) => new RegExp(`^${k.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(path.split("?")[0]))) {
        out.push(`${path}: no such route`);
        continue;
      }
      if (!closed(res)) bad.push(`${path} → ${res.status}`);
      else out.push(`${path} → ${res.status}`);
    }
    await guest.dispose();
    expect(bad, bad.join("; ")).toEqual([]);
    expect(out.some((o) => !o.endsWith("no such route")), `none of ${paths.join(", ")} is a route`).toBe(true);
    return out.join("; ");
  }, { partial: "guest half only; the other-role half (customer, other shop) runs in the signed-in tier" });
}

qa(["TC-DEL-018"], "tracking API does not answer for an unknown order or token", async () => {
  const guest = await anonymous();
  const res = await call(guest, "GET", `/api/tracking/${NO_SUCH_ID}`);
  await guest.dispose();
  expect([401, 403, 404], `tracking — HTTP ${res.status}`).toContain(res.status);
  expect(res.text).not.toMatch(/latitude|longitude|phone|mobile/i);
  return `unknown tracking id → ${res.status}, no location or phone in the answer`;
}, { partial: "unknown id only; the customer / other-customer halves run in the signed-in tier" });

qa(["TC-ONB-046", "TC-DEL-024", "TC-RET-015"], "private files (KYC documents, delivery and return photos) are closed to a guest", async () => {
  const guest = await anonymous();
  const candidates = apiRoutes()
    // Catalogue product images are public by design (the storefront shows them); everything else is private.
    .filter((r) => r.methods.includes("GET") && /(document|photo|proof|evidence|kyc|image|file)/i.test(r.path) && !/^\/api\/(images\b|products\/\[[^\]]+\]\/images|cron|v1|connector|auth)/.test(r.path))
    .map((r) => r.path);
  const bad: string[] = [];
  const seen: string[] = [];
  for (const path of candidates) {
    const res = await call(guest, "GET", fill(path));
    seen.push(`${path} → ${res.status}`);
    // Public product images are the only image route a guest may read; everything else must refuse or not exist.
    if (res.status === 200) bad.push(`${path} → 200`);
    if (res.status >= 500) bad.push(`${path} → ${res.status}`);
  }
  await guest.dispose();
  expect(candidates.length, "file routes found").toBeGreaterThan(0);
  expect(bad, bad.join("; ")).toEqual([]);
  return `${candidates.length} file routes refuse a guest: ${seen.slice(0, 12).join("; ")}${seen.length > 12 ? " …" : ""}`;
}, { partial: "guest half; owner / other-shop / operator halves run in the signed-in tier" });

qa("TC-PRE-009", "the suite itself refuses writing tiers on production", async () => {
  const { tierRefusal } = await import("../lib/target");
  const note = `target ${TARGET}: guest=${tierRefusal("guest") ?? "runs"}, signed=${tierRefusal("signed") ?? "runs"}, local=${tierRefusal("local") ?? "runs"}`;
  if (IS_PROD) {
    expect(tierRefusal("signed")).not.toBeNull();
    expect(tierRefusal("local")).not.toBeNull();
  }
  expect(tierRefusal("guest")).toBeNull();
  return note;
}, { partial: "proves the suite's guard; a manual run's discipline is outside automation" });
