/**
 * Billing v2 — production-safe part (docs/billing). Nothing here signs in or
 * writes: a caller without a session must be refused by the shop accounts
 * pages and APIs (the session is checked before the billing flag, the shop or
 * the request body).
 */
import { anonymous, call, isInPageSignInRedirect, isSignInShell, refusesGuest } from "../lib/http";
import { expect, qa } from "../lib/record";
import { world } from "../lib/world";

/** Shop A where the world names it; any id otherwise (the session is checked first). */
const SHOP = world().shops.A?.id ?? "00000000-0000-4000-8000-0000000000a1";

qa("TC-BILL-014", "guest: a shop's accounts pages send to sign-in and its billing APIs answer 401", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const path of ["/shop/accounts", "/shop/accounts/pos", "/shop/accounts/gst", "/shop/accounts/sales"]) {
      const res = await call(guest, "GET", `${path}?shop=${SHOP}`);
      const closed = refusesGuest(res) || isSignInShell(path, res) || isInPageSignInRedirect(path, res, [world().shops.A?.name ?? "\u0000"]);
      expect(closed, `${path} → ${res.status} ${res.location ?? ""}`).toBe(true);
      seen.push(`${path} ${res.status}`);
    }
    for (const [method, rest] of [
      ["GET", "sales"],
      ["POST", "sales"],
      ["GET", "pos/items"],
      ["POST", "pos/sync"],
      ["GET", "documents"],
      ["GET", "gst/link"],
      ["GET", "portal/filings"],
      ["GET", "sync"],
    ] as const) {
      const res = await call(guest, method, `/api/shops/${SHOP}/accounts/${rest}`, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${rest} → ${res.status}`).toBe(401);
      seen.push(`${method} ${rest} 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
}, { partial: "another owner, operators, a customer and a rider are in tests/qa/signed-in/billing-v2.spec.ts" });
