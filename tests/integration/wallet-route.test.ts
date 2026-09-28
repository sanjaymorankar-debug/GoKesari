/**
 * Route-level tests for POST /api/wallet/topup and POST /api/wallet/verify
 * (Phase 1a — see docs/gokesari-audit/GOKESARI_IMPLEMENTATION_ROADMAP.md and
 * GAP-006). Service-level payment logic is already well covered
 * (payments.test.ts, cashfree-order-confirmation.test.ts, webhook-signature.test.ts);
 * this file covers the route layer — auth, validation, status codes — on
 * top of it. `global.fetch` is stubbed for the verify tests exactly as
 * cashfree-order-confirmation.test.ts already does, so this stays offline.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST as topupRoute } from "@/app/api/wallet/topup/route";
import { POST as verifyRoute } from "@/app/api/wallet/verify/route";
import { db } from "@/server/db";
import { wallets } from "@/server/db/schema";
import { createTopUpOrder } from "@/server/services/payments";
import { call } from "../helpers/http";
import { createUserWithWallet, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});
afterEach(() => vi.unstubAllGlobals());

function signInAsUser(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;

describe("POST /api/wallet/topup", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const r = await call(topupRoute, "/api/wallet/topup", { method: "POST", body: { amountPaise: 500_000 } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a non-positive amount with 422", async () => {
    const { user } = await createUserWithWallet();
    signInAsUser({ ...user, role: "CUSTOMER" });

    const r = await call(topupRoute, "/api/wallet/topup", { method: "POST", body: { amountPaise: -100 } });
    expect(r.status).toBe(422);
  });

  it("creates a payment intent without moving any money", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    signInAsUser({ ...user, role: "CUSTOMER" });

    const r = await call(topupRoute, "/api/wallet/topup", { method: "POST", body: { amountPaise: 500_000 } });
    expect(r.status).toBe(200);
    expect(r.body.amountPaise).toBe(500_000);
    expect(r.body.gatewayOrderId).toBeTruthy();
    expect(await balanceOf(user.id)).toBe(0);
  });
});

describe("POST /api/wallet/verify", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const r = await call(verifyRoute, "/api/wallet/verify", { method: "POST", body: { gatewayOrderId: "x" } });
    expect(r.status).toBe(401);
  });

  it("credits the wallet when Cashfree confirms a SUCCESS payment", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await createTopUpOrder(user.id, 500_000);
    mockFetchOnce(200, [{ cf_payment_id: "cf_pay_route_1", payment_status: "SUCCESS" }]);

    signInAsUser({ ...user, role: "CUSTOMER" });
    const r = await call(verifyRoute, "/api/wallet/verify", {
      method: "POST",
      body: { gatewayOrderId: intent.gatewayOrderId },
    });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.balancePaise).toBe(500_000);
    expect(await balanceOf(user.id)).toBe(500_000);
  });

  it("credits nothing and returns an error when Cashfree does not confirm payment", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await createTopUpOrder(user.id, 500_000);
    mockFetchOnce(200, []); // no SUCCESS attempt reported

    signInAsUser({ ...user, role: "CUSTOMER" });
    const r = await call(verifyRoute, "/api/wallet/verify", {
      method: "POST",
      body: { gatewayOrderId: intent.gatewayOrderId },
    });

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("re-verifying an already-settled order is idempotent, not a second credit", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await createTopUpOrder(user.id, 500_000);
    mockFetchOnce(200, [{ cf_payment_id: "cf_pay_route_2", payment_status: "SUCCESS" }]);
    signInAsUser({ ...user, role: "CUSTOMER" });

    const first = await call(verifyRoute, "/api/wallet/verify", {
      method: "POST",
      body: { gatewayOrderId: intent.gatewayOrderId },
    });
    expect(first.status).toBe(200);

    const second = await call(verifyRoute, "/api/wallet/verify", {
      method: "POST",
      body: { gatewayOrderId: intent.gatewayOrderId },
    });
    expect(second.status).toBe(200);
    expect(second.body.alreadyProcessed).toBe(true);
    expect(await balanceOf(user.id)).toBe(500_000); // not credited twice
  });

  it("rejects verifying an order id that does not belong to the caller", async () => {
    const { user: owner } = await createUserWithWallet({ balancePaise: 0 });
    const { user: other } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await createTopUpOrder(owner.id, 500_000);

    signInAsUser({ ...other, role: "CUSTOMER" });
    const r = await call(verifyRoute, "/api/wallet/verify", {
      method: "POST",
      body: { gatewayOrderId: intent.gatewayOrderId },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(owner.id)).toBe(0);
  });
});
