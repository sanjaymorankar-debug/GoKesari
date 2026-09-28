/**
 * SEC-04 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): rate limiting is
 * extended to five previously-unlimited, authenticated routes — voucher
 * preview (a code-guessing surface) and four sensitive-but-unlimited
 * shop/delivery-partner routes. One route-level test per route proves the
 * limit is actually wired in, not just present in RATE_LIMITS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as previewVoucherRoute } from "@/app/api/vouchers/preview/route";
import { GET as catalogueSearchRoute } from "@/app/api/shops/[id]/catalogue-search/route";
import { GET as priceTemplateRoute } from "@/app/api/shops/[id]/price-template/route";
import { PATCH as deliveryStatusRoute } from "@/app/api/delivery-partner/status/route";
import { POST as deliveryLocationRoute } from "@/app/api/delivery-partner/location/route";
import { RATE_LIMITS, resetRateLimits } from "@/server/api/rate-limit";
import { call } from "../helpers/http";
import {
  createDeliveryPartner,
  createShop,
  createUser,
  createVoucher,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
});

function signInAsUser(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

describe("SEC-04 rate limits", () => {
  it("POST /api/vouchers/preview: 429 after VOUCHER_PREVIEW.limit calls in the window", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    const voucher = await createVoucher();
    signInAsUser(customer);

    const { limit } = RATE_LIMITS.VOUCHER_PREVIEW;
    for (let i = 0; i < limit; i++) {
      const r = await call(previewVoucherRoute, "/api/vouchers/preview", {
        method: "POST",
        body: { code: voucher.code, amountPaise: 10_000 },
      });
      expect(r.status).toBe(200);
    }

    const blocked = await call(previewVoucherRoute, "/api/vouchers/preview", {
      method: "POST",
      body: { code: voucher.code, amountPaise: 10_000 },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("GET /api/shops/[id]/catalogue-search: 429 after MUTATION.limit calls in the window", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    signInAsUser(owner);

    const { limit } = RATE_LIMITS.MUTATION;
    for (let i = 0; i < limit; i++) {
      const r = await call(catalogueSearchRoute, `/api/shops/${shop.id}/catalogue-search`, {
        params: { id: shop.id },
      });
      expect(r.status).toBe(200);
    }

    const blocked = await call(catalogueSearchRoute, `/api/shops/${shop.id}/catalogue-search`, {
      params: { id: shop.id },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("GET /api/shops/[id]/price-template: 429 after MUTATION.limit calls in the window", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    signInAsUser(owner);

    const { limit } = RATE_LIMITS.MUTATION;
    for (let i = 0; i < limit; i++) {
      const r = await call(priceTemplateRoute, `/api/shops/${shop.id}/price-template`, {
        params: { id: shop.id },
      });
      expect(r.status).toBe(200);
    }

    const blocked = await call(priceTemplateRoute, `/api/shops/${shop.id}/price-template`, {
      params: { id: shop.id },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("PATCH /api/delivery-partner/status: 429 after MUTATION.limit calls in the window", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { status: "APPROVED" });
    signInAsUser(riderUser);

    const { limit } = RATE_LIMITS.MUTATION;
    for (let i = 0; i < limit; i++) {
      const r = await call(deliveryStatusRoute, "/api/delivery-partner/status", {
        method: "PATCH",
        body: { action: "offline" },
      });
      expect(r.status).toBe(200);
    }

    const blocked = await call(deliveryStatusRoute, "/api/delivery-partner/status", {
      method: "PATCH",
      body: { action: "offline" },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("POST /api/delivery-partner/location: 429 after MUTATION.limit calls in the window", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { status: "APPROVED", isOnline: true });
    signInAsUser(riderUser);

    const { limit } = RATE_LIMITS.MUTATION;
    for (let i = 0; i < limit; i++) {
      const r = await call(deliveryLocationRoute, "/api/delivery-partner/location", {
        method: "POST",
        body: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(r.status).toBe(204);
    }

    const blocked = await call(deliveryLocationRoute, "/api/delivery-partner/location", {
      method: "POST",
      body: { latitude: 18.5204, longitude: 73.8567 },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});
