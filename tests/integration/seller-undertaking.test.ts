/**
 * Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11).
 *
 * - the gate is needed only with the flag on, for an owner without the current versions;
 * - an older version (the effect of bumping SELLER_UNDERTAKING_VERSION / SELLER_TERMS_VERSION) or a
 *   withdrawal asks again;
 * - POST /api/seller/undertaking refuses unless both boxes are explicitly true; 401 guest, 403 non-owner;
 * - a shop whose owner has not accepted cannot accept a NEW order, and can after accepting;
 * - an order accepted before carries on (picking starts);
 * - flag off: no effect at all.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as statusRoute, POST as acceptRoute } from "@/app/api/seller/undertaking/route";
import { SELLER_TERMS_VERSION, SELLER_UNDERTAKING_VERSION } from "@/lib/legal/seller-undertaking";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { userConsents } from "@/server/db/schema";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { acceptOrder, startPicking } from "@/server/services/fulfilment";
import {
  acceptSellerUndertaking,
  getSellerUndertakingStatus,
  hasAcceptedCurrentSellerUndertaking,
  sellerUndertakingGateApplies,
} from "@/server/services/seller-undertaking";
import { call } from "../helpers/http";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const, email: "" };

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN", email: a.email };
});

const flag = (enabled: boolean) => setFeatureFlag("seller_undertaking_gate_enabled", { enabled, districtCodes: null }, "seller undertaking test", admin);

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function ownerWithShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { registrationFeePaise: 0 });
  return { owner, shop };
}

async function confirmedOrder(shopId: string) {
  const customer = await createUser();
  return createOrder(customer.id, shopId, { status: "CONFIRMED", paidAt: new Date() });
}

describe("seller undertaking gate", () => {
  it("is needed only with the flag on, and not after accepting", async () => {
    const { owner, shop } = await ownerWithShop();
    expect(await sellerUndertakingGateApplies(owner.id)).toBe(false); // flag off (seeded OFF / missing row)
    await flag(true);
    expect(await sellerUndertakingGateApplies(owner.id)).toBe(true);

    const result = await acceptSellerUndertaking({ userId: owner.id, ip: "203.0.113.5", userAgent: "vitest" });
    expect(result).toEqual({ recorded: 2, shopIds: [shop.id] });
    expect(await sellerUndertakingGateApplies(owner.id)).toBe(false);
    const rows = await db.select().from(userConsents).where(eq(userConsents.userId, owner.id));
    expect(rows.map((r) => [r.consentType, r.version, r.shopId, r.ipAddress, r.userAgent]).sort()).toEqual(
      [
        ["SELLER_GOODS_UNDERTAKING", SELLER_UNDERTAKING_VERSION, shop.id, "203.0.113.5", "vitest"],
        ["SELLER_TERMS", SELLER_TERMS_VERSION, shop.id, "203.0.113.5", "vitest"],
      ].sort(),
    );

    // A customer with no shop is never gated.
    const customer = await createUser();
    expect(await sellerUndertakingGateApplies(customer.id)).toBe(false);
  });

  it("records one row per type per shop for an owner with several shops", async () => {
    const { owner, shop } = await ownerWithShop();
    const second = await createShop(owner.id, { name: "Second Shop", registrationFeePaise: 0 });
    const result = await acceptSellerUndertaking({ userId: owner.id });
    expect(result.recorded).toBe(4);
    expect(new Set(result.shopIds)).toEqual(new Set([shop.id, second.id]));
  });

  it("a version bump (older accepted version) or a withdrawal asks again", async () => {
    const { owner } = await ownerWithShop();
    await flag(true);
    // Accepted an earlier version of the undertaking: as if the constant had been bumped since.
    await db.insert(userConsents).values([
      { userId: owner.id, consentType: "SELLER_GOODS_UNDERTAKING", version: "2026-01-01" },
      { userId: owner.id, consentType: "SELLER_TERMS", version: SELLER_TERMS_VERSION },
    ]);
    expect(await hasAcceptedCurrentSellerUndertaking(owner.id)).toBe(false);
    expect(await sellerUndertakingGateApplies(owner.id)).toBe(true);

    await acceptSellerUndertaking({ userId: owner.id });
    expect(await hasAcceptedCurrentSellerUndertaking(owner.id)).toBe(true);

    // Old Seller Terms version only: still asked.
    const { owner: other } = await ownerWithShop();
    await db.insert(userConsents).values([
      { userId: other.id, consentType: "SELLER_GOODS_UNDERTAKING", version: SELLER_UNDERTAKING_VERSION },
      { userId: other.id, consentType: "SELLER_TERMS", version: "2026-10-24" },
    ]);
    expect(await hasAcceptedCurrentSellerUndertaking(other.id)).toBe(false);

    // A later withdrawal supersedes the grant.
    await new Promise((r) => setTimeout(r, 5));
    await db.insert(userConsents).values({ userId: owner.id, consentType: "SELLER_GOODS_UNDERTAKING", version: SELLER_UNDERTAKING_VERSION, granted: false });
    expect(await hasAcceptedCurrentSellerUndertaking(owner.id)).toBe(false);
  });
});

describe("POST/GET /api/seller/undertaking", () => {
  it("401 for a guest, 403 for a user without a shop", async () => {
    expect((await call(statusRoute, "/api/seller/undertaking")).status).toBe(401);
    expect((await call(acceptRoute, "/api/seller/undertaking", { method: "POST", body: { acceptUndertaking: true, acceptTerms: true } })).status).toBe(401);
    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    expect((await call(statusRoute, "/api/seller/undertaking")).status).toBe(403);
    expect((await call(acceptRoute, "/api/seller/undertaking", { method: "POST", body: { acceptUndertaking: true, acceptTerms: true } })).status).toBe(403);
  });

  it("refuses without both ticks, records with both", async () => {
    const { owner } = await ownerWithShop();
    await flag(true);
    signIn(owner, "SHOP_OWNER");

    const before = await call(statusRoute, "/api/seller/undertaking");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ gateEnabled: true, accepted: false, required: true, version: SELLER_UNDERTAKING_VERSION, termsVersion: SELLER_TERMS_VERSION, acceptedAt: null });

    for (const body of [
      {},
      { acceptUndertaking: true },
      { acceptTerms: true },
      { acceptUndertaking: true, acceptTerms: false },
      { acceptUndertaking: "true", acceptTerms: "true" },
    ]) {
      const refused = await call(acceptRoute, "/api/seller/undertaking", { method: "POST", body });
      expect(refused.status, JSON.stringify(body)).toBe(422);
    }
    expect(await db.select().from(userConsents).where(eq(userConsents.userId, owner.id))).toHaveLength(0);

    const accepted = await call(acceptRoute, "/api/seller/undertaking", { method: "POST", body: { acceptUndertaking: true, acceptTerms: true } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ accepted: true, required: false });
    expect(typeof accepted.body.acceptedAt).toBe("string");
    expect((await getSellerUndertakingStatus(owner.id)).accepted).toBe(true);
  });
});

describe("order acceptance", () => {
  it("refuses a NEW order until the owner accepts, then accepts it", async () => {
    const { owner, shop } = await ownerWithShop();
    await flag(true);
    const order = await confirmedOrder(shop.id);
    const actor = { id: owner.id, role: "SHOP_OWNER" as const };

    await expect(acceptOrder(order.id, actor)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("seller undertaking"),
      details: { sellerUndertaking: { required: true, url: "/shop" } },
    });
    // Straight to picking is a new acceptance too.
    await expect(startPicking(order.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });

    await acceptSellerUndertaking({ userId: owner.id });
    expect((await acceptOrder(order.id, actor)).status).toBe("ACCEPTED");
  });

  it("an order accepted before carries on", async () => {
    const { owner, shop } = await ownerWithShop();
    const order = await confirmedOrder(shop.id);
    const actor = { id: owner.id, role: "SHOP_OWNER" as const };
    expect((await acceptOrder(order.id, actor)).status).toBe("ACCEPTED"); // flag off
    await flag(true);
    expect(await hasAcceptedCurrentSellerUndertaking(owner.id)).toBe(false);
    expect((await startPicking(order.id, actor)).status).toBe("PREPARING");
  });

  it("flag off: no effect", async () => {
    const { owner, shop } = await ownerWithShop();
    const order = await confirmedOrder(shop.id);
    await flag(false);
    expect(await sellerUndertakingGateApplies(owner.id)).toBe(false);
    expect((await acceptOrder(order.id, { id: owner.id, role: "SHOP_OWNER" })).status).toBe("ACCEPTED");
    expect(await db.select().from(userConsents).where(and(eq(userConsents.userId, owner.id)))).toHaveLength(0);
  });
});
