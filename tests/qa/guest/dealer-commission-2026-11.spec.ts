/**
 * Dealer network and shop referrals — production-safe part of the cases added
 * on 20-Nov-2026 (docs/dealer-programme/TIERED_COMMISSION.md). Nothing here
 * signs in or writes: public pages, the shop referral link, and requests the
 * server must refuse (a referral request with a bad PIN is refused before
 * anything is saved).
 */
import { anonymous, call } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";
import { TARGET } from "../lib/target";

qa("TC-TIER-031", "guest: /dealer and the TIERED screen answer 404 while dealer_programme_enabled is off, and send to sign-in while it is on", async () => {
  const guest = await anonymous();
  try {
    const dealer = await call(guest, "GET", "/dealer");
    const tiered = await call(guest, "GET", "/admin/dealers/commission/tiered");
    if (dealer.status === 404) {
      expect(tiered.status, "the TIERED screen with the flag off").toBe(404);
      return `${TARGET}: flag off — /dealer 404, TIERED screen 404`;
    }
    expect([302, 303, 307, 308], `/dealer → ${dealer.status}`).toContain(dealer.status);
    expect(dealer.location ?? "").toBe("/signin?callbackUrl=/dealer");
    expect([302, 303, 307, 308], `TIERED screen → ${tiered.status}`).toContain(tiered.status);
    expect(tiered.location ?? "").toMatch(/^\/signin/);
    return `${TARGET}: flag on — both send a guest to sign in`;
  } finally {
    await guest.dispose();
  }
}, { partial: "a signed-in customer and dealer are in the signed / local tiers" });

qa("TC-SREF-008", "guest: /shop/register asks to sign in first; the 'Request a referral code' dialog is in the next step", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/shop/register", undefined, { maxRedirects: 3 });
    expect(res.status).toBe(200);
    expect(res.text, "no request dialog before sign-in").not.toContain('data-testid="request-referral-code"');
    // Owner, 28-Nov-2026 (#697, onboarding_v2 on): a guest starts with the referral code (step 1), then the shared
    // identity step (the login sheet); no separate sign-in card. With onboarding_v2 off: the original sign-in card.
    if (res.text.includes('data-testid="guest-shop-start"')) {
      expect(res.text).toContain('data-testid="guest-referral-code"');
      expect(res.text, "no separate sign-in card").not.toContain('data-testid="shop-register-sign-in"');
      return "v3 guest start: referral code first, sign-in comes in step 2; no request dialog before it";
    }
    expect(res.text).toContain("Step 1 of 5: sign in with your email.");
    expect(res.text).toContain('data-testid="shop-register-sign-in"');
    return "sign-in step shown; the request link comes after sign-in";
  } finally {
    await guest.dispose();
  }
}, { partial: "sending the request and its 'Request received' answer run on the local tier (writes a request and e-mails the referrals team)" });

qa("TC-SREF-009", "guest: a referral request with PIN 41100 is refused (422) with 'A PIN code is 6 digits and does not start with 0.'", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "POST", "/api/referral-requests", { name: "QA Guest", mobile: "9000000000", shopType: "STATIONERY_STORE", area: "Kothrud", city: "Pune", pincode: "41100" });
    if (res.status === 429 && /Too many/i.test(res.body?.error?.message ?? "")) blocked("the per-IP limit on referral requests is used up for now");
    expect(res.status).toBe(422);
    expect(res.body?.error?.message).toBe("A PIN code is 6 digits and does not start with 0.");
    expect(res.body?.error?.details?.fields?.pincode).toBe("A PIN code is 6 digits and does not start with 0.");
    return "PIN 41100 → 422, nothing saved";
  } finally {
    await guest.dispose();
  }
}, { partial: "the repeat-mobile 429 needs a saved request: local tier" });

qa("TC-SREF-010", "/r/SHOP… answers 307 to /shop/register?ref=<code> while rule shopReferrals is on", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/r/SHOPAB2CD");
    if (!(res.location ?? "").startsWith("/shop/register")) blocked(`rule shopReferrals is off on this site (a SHOP code goes to the customer referral flow: ${res.location})`);
    expect(res.status).toBe(307);
    expect(res.location).toBe("/shop/register?ref=SHOPAB2CD");
    return `${TARGET}: 307 → ${res.location}`;
  } finally {
    await guest.dispose();
  }
}, { partial: "'✓ Applied' in the wizard needs a signed-in person: local tier" });
