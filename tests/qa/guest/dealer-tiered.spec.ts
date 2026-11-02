/**
 * Dealer network (TIERED) and shop-refers-shop — production-safe checks
 * (docs/dealer-programme/TIERED_COMMISSION.md). Nothing here signs in or writes:
 * every request is one the server must refuse, or the public /r/ link.
 * On gokesari.com the rules ship off, so the shop link must behave exactly as
 * before (the customer referral flow); on test.gokesari.com they are on.
 */
import { anonymous, call } from "../lib/http";
import { expect, qa } from "../lib/record";
import { IS_PROD, TARGET } from "../lib/target";

qa("TC-SREF-007", "guest: the new dealer-team and shop-referral APIs refuse a caller without a session; nothing new opens", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    for (const [method, path] of [
      ["GET", "/api/dealer/team"],
      ["POST", "/api/dealer/team"],
      ["GET", "/api/admin/dealer-tiers"],
      ["POST", "/api/admin/dealer-tiers"],
      ["GET", "/api/admin/shop-referrals"],
      ["POST", "/api/admin/shop-referrals"],
    ] as const) {
      const res = await call(guest, method, path, method === "POST" ? { action: "acceptAgreement", version: "x" } : undefined);
      // 401 without a session; 404 where the dealer programme flag is off (the route "does not exist").
      expect([401, 403, 404], `${method} ${path} → ${res.status}`).toContain(res.status);
      seen.push(`${method} ${path} ${res.status}`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa("TC-SREF-002", "/r/SHOP… goes to Add my shop with the code where shop referrals are on; elsewhere the customer flow as before", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/r/SHOPAB2CD");
    expect([302, 303, 307, 308], `status ${res.status}`).toContain(res.status);
    if (IS_PROD) {
      // Rule shopReferrals off on gokesari.com: unchanged behaviour (sign in, the code remembered for a customer).
      expect(res.location ?? "").toMatch(/\/signin|\/refer/);
    } else {
      expect(res.location ?? "").toContain("/shop/register?ref=SHOPAB2CD");
    }
    return `${TARGET}: ${res.status} → ${res.location}`;
  } finally {
    await guest.dispose();
  }
});
