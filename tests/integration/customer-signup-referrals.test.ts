/**
 * Referral code at customer registration (docs/four-features-2026-10, decided
 * by the owner on 9 Oct 2026; rule customerSignupReferral).
 *
 * GoKesari issues the codes; the app checks a code when a customer registers
 * (first-time setup), as it does for shop owners: an issued code (active,
 * unexpired — hyphens kept) is recorded; a friend's code starts the existing
 * friend referral. Once per customer, before the first order.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as signupGet, POST as signupPost } from "@/app/api/me/signup-referral/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { customerReferrals, customerSignupReferrals, platformSettings, referralCodes } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { getOrCreateReferralCode } from "@/server/services/customer-referrals";
import { listSignupReferralCounts } from "@/server/services/customer-signup-referrals";
import { checkout } from "@/server/services/orders";
import { createReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["customerSignupReferral", "customerReferrals"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole = "CUSTOMER") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const give = (code: string) => call(signupPost, "/api/me/signup-referral", { method: "POST", body: { code } });

describe("referral code at customer registration", () => {
  it("switched off (default): not asked, and a code is refused", async () => {
    const customer = await createUser();
    signIn(customer);
    expect((await call(signupGet, "/api/me/signup-referral")).body).toEqual({ referral: null, ask: false });
    expect((await give("ANYCODE")).status).toBe(409);
  });

  it("a code GoKesari issued is checked and recorded once; unknown, paused and expired codes are refused on the field", async () => {
    await setRule("customerSignupReferral", { enabled: true }, admin);
    await createReferralCode({ code: "PUNE-LAUNCH", label: "Pune launch scheme" }, admin);
    const paused = await createReferralCode({ code: "OLD-SCHEME" }, admin);
    await db.update(referralCodes).set({ status: "INACTIVE" }).where(eq(referralCodes.id, paused.id));
    await createReferralCode({ code: "EXPIRED1", expiresAt: "2020-01-01" }, admin);

    const customer = await createUser();
    signIn(customer);
    expect((await call(signupGet, "/api/me/signup-referral")).body.ask).toBe(true);

    const unknown = await give("NOPE123");
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details.fields.referralCode).toBe("This referral code is not valid.");
    expect((await give("old-scheme")).body.error.details.fields.referralCode).toContain("inactive");
    expect((await give("EXPIRED1")).body.error.details.fields.referralCode).toContain("expired");

    const ok = await give(" pune-launch ");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ kind: "GOKESARI", code: "PUNE-LAUNCH", label: "Pune launch scheme" });
    // The same code again is fine; another is not.
    expect((await give("PUNE-LAUNCH")).status).toBe(200);
    expect((await give("EXPIRED1")).status).toBe(409);
    expect((await call(signupGet, "/api/me/signup-referral")).body).toMatchObject({ ask: false, referral: { kind: "GOKESARI", code: "PUNE-LAUNCH" } });

    const counts = await listSignupReferralCounts();
    expect(counts).toEqual([expect.objectContaining({ code: "PUNE-LAUNCH", kind: "GOKESARI", customers: 1, label: "Pune launch scheme" })]);
  });

  it("a friend's code starts the existing friend referral when that programme is on", async () => {
    await setRule("customerSignupReferral", { enabled: true }, admin);
    const friend = await createUser();
    const friendCode = await getOrCreateReferralCode(friend.id);
    const customer = await createUser();
    signIn(customer);

    // Friend referrals off: a friend's code is not a valid code.
    expect((await give(friendCode)).status).toBe(422);

    await setRule("customerReferrals", { enabled: true }, admin);
    const ok = await give(friendCode.toLowerCase());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ kind: "FRIEND", code: friendCode });
    const [link] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, customer.id));
    expect(link.referrerUserId).toBe(friend.id);
  });

  it("only before the first order", async () => {
    await setRule("customerSignupReferral", { enabled: true }, admin);
    await createReferralCode({ code: "PUNE-LAUNCH" }, admin);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const cat = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
    const shop = await createShop(owner.id, { name: "Dairy One" });
    const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 5_000, onlineStock: 10 });
    const { user } = await createUserWithWallet({ balancePaise: 50_000 });
    await addToCart(user.id, sp.id, 1);
    await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: `r-${Math.random()}`, paymentMethod: "WALLET" });
    signIn(user);
    expect((await call(signupGet, "/api/me/signup-referral")).body.ask).toBe(false);
    const late = await give("PUNE-LAUNCH");
    expect(late.status).toBe(409);
    expect(await db.select().from(customerSignupReferrals)).toHaveLength(0);
  });
});
