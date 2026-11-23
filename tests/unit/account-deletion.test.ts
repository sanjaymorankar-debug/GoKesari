/**
 * Module 7 — self-service account deletion (docs/account-deletion-2026-11).
 * Pure rules (blockers, precheck, anonymisation) and the flag-OFF behaviour of
 * the service and the APIs. The database paths are in
 * tests/integration/account-deletion.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flagOn: false,
  requireUser: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", role: "CUSTOMER", email: "a@b.c", name: null, image: null })),
}));

vi.mock("@/server/services/feature-flags", async () => {
  const { AppError } = await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
  return {
    isFeatureEnabled: vi.fn(async () => mocks.flagOn),
    // Same shape as the real helper: a 404 AppError.
    featureNotAvailable: (key: string) =>
      new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: key }),
  };
});
vi.mock("@/server/otp/service", () => ({
  requestAccountActionOtp: vi.fn(async () => {
    throw new Error("must not send a code");
  }),
  verifyAccountActionOtp: vi.fn(async () => {
    throw new Error("must not check a code");
  }),
}));
vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/authz/guards", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/services/settings", () => ({
  getRule: vi.fn(async () => ({ maxRequestsPerIpPerWindow: 10, maxResendsPerWindow: 5, resendWindowMinutes: 15 })),
}));

import { NextRequest } from "next/server";

import { GET as statusRoute, POST as deleteRoute } from "@/app/api/profile/delete/route";
import { POST as codeRoute } from "@/app/api/profile/delete/code/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import {
  anonymisedEmail,
  anonymisedUserPatch,
  blockersFrom,
  deleteAccount,
  deletionPrecheck,
  precheckFrom,
  requestAccountDeletionCode,
  type DeletionFacts,
} from "@/server/services/account-deletion";

const USER = { id: "11111111-1111-4111-8111-111111111111", role: "CUSTOMER" as const };

function facts(overrides: Partial<DeletionFacts> = {}): DeletionFacts {
  return {
    role: "CUSTOMER",
    email: "asha@example.com",
    emailPlaceholder: false,
    openOrders: 0,
    walletBalancePaise: 0,
    walletPromotionalPaise: 0,
    openBankRefunds: 0,
    openReturns: 0,
    openDisputes: 0,
    activeShops: 0,
    staffMemberships: 0,
    rider: null,
    liveSubscriptions: 0,
    ...overrides,
  };
}

const codes = (f: DeletionFacts) => blockersFrom(f).map((b) => b.code);

beforeEach(() => {
  mocks.flagOn = false;
  resetRateLimits();
});

describe("blockers", () => {
  it("a customer with nothing open can delete", () => {
    expect(blockersFrom(facts())).toEqual([]);
    expect(precheckFrom(facts()).canDelete).toBe(true);
  });

  it("open orders, returns, disputes and bank refunds block, with counts and links", () => {
    const list = blockersFrom(facts({ openOrders: 2, openReturns: 1, openDisputes: 1, openBankRefunds: 1 }));
    expect(list.map((b) => b.code)).toEqual(["OPEN_ORDERS", "BANK_REFUND_IN_PROGRESS", "OPEN_RETURNS", "OPEN_DISPUTES"]);
    expect(list[0]).toMatchObject({ count: 2, href: "/orders" });
    expect(list[0].message).toContain("2 orders");
  });

  it("the customer's own wallet money blocks and points to the wallet (bank refund flow)", () => {
    const [b] = blockersFrom(facts({ walletBalancePaise: 12_550, walletPromotionalPaise: 0 }));
    expect(b.code).toBe("WALLET_BALANCE");
    expect(b.href).toBe("/wallet");
    expect(b.message).toMatch(/125\.50/);
  });

  it("promotional credit alone does not block; it is reported as lapsing", () => {
    const f = facts({ walletBalancePaise: 5_000, walletPromotionalPaise: 5_000 });
    expect(codes(f)).toEqual([]);
    expect(precheckFrom(f).promotionalForfeitPaise).toBe(5_000);
  });

  it("a live shop or a staff membership blocks (close the shop first)", () => {
    const list = blockersFrom(facts({ role: "SHOP_OWNER", activeShops: 1, staffMemberships: 1 }));
    expect(list.map((b) => b.code)).toEqual(["ACTIVE_SHOP", "SHOP_STAFF"]);
    expect(list[0].href).toBe("/shop/manage/hours");
  });

  it("a rider with live jobs or unsettled dues is blocked; a settled rider is not", () => {
    expect(codes(facts({ role: "DELIVERY_PARTNER", rider: { liveJobs: 1, unbatchedEarningsPaise: 0, openPayouts: 0 } }))).toEqual(["RIDER_LIVE_JOBS"]);
    expect(codes(facts({ role: "DELIVERY_PARTNER", rider: { liveJobs: 0, unbatchedEarningsPaise: 4_000, openPayouts: 0 } }))).toEqual([
      "RIDER_UNSETTLED_DUES",
    ]);
    expect(codes(facts({ role: "DELIVERY_PARTNER", rider: { liveJobs: 0, unbatchedEarningsPaise: 0, openPayouts: 1 } }))).toEqual([
      "RIDER_UNSETTLED_DUES",
    ]);
    expect(codes(facts({ role: "DELIVERY_PARTNER", rider: { liveJobs: 0, unbatchedEarningsPaise: 0, openPayouts: 0 } }))).toEqual([]);
  });

  it("staff, dealer and society admin accounts cannot delete themselves", () => {
    for (const role of ["ADMIN", "OPERATOR", "DEALER", "SOCIETY_ADMIN", "CA", "SUPPORT_USER"] as const) {
      expect(codes(facts({ role }))).toContain("ROLE_NOT_SELF_SERVICE");
    }
    for (const role of ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER"] as const) {
      expect(codes(facts({ role }))).not.toContain("ROLE_NOT_SELF_SERVICE");
    }
  });

  it("an account with only a placeholder email cannot receive the code", () => {
    expect(codes(facts({ emailPlaceholder: true }))).toEqual(["NO_EMAIL"]);
    expect(precheckFrom(facts({ emailPlaceholder: true })).maskedEmail).toBeNull();
  });

  it("live subscriptions do not block; the precheck says they will be cancelled", () => {
    const p = precheckFrom(facts({ liveSubscriptions: 3 }));
    expect(p.canDelete).toBe(true);
    expect(p.subscriptionsToCancel).toBe(3);
    expect(p.maskedEmail).not.toContain("asha@");
  });
});

describe("anonymisation", () => {
  it("replaces the email with a per-account address no mail can reach", () => {
    expect(anonymisedEmail(USER.id)).toBe(`deleted+${USER.id}@deleted.invalid`);
  });

  it("clears every personal field and marks the account DELETED", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    const patch = anonymisedUserPatch(USER.id, now);
    expect(patch).toMatchObject({
      name: null,
      email: anonymisedEmail(USER.id),
      image: null,
      phone: null,
      phoneE164: null,
      phoneVerifiedAt: null,
      gender: null,
      emailVerified: null,
      status: "DELETED",
      deletedAt: now,
    });
  });
});

describe("flag OFF (account_self_deletion_enabled)", () => {
  it("the service refuses every step with 404, before touching the account", async () => {
    await expect(deletionPrecheck(USER.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestAccountDeletionCode(USER)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteAccount(USER, { code: "123456", confirmText: "DELETE" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the APIs answer 404", async () => {
    const get = await statusRoute();
    expect(get.status).toBe(404);
    const code = await codeRoute(new NextRequest("https://gokesari.com/api/profile/delete/code", { method: "POST" }));
    expect(code.status).toBe(404);
    const del = await deleteRoute(
      new NextRequest("https://gokesari.com/api/profile/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "123456", confirmText: "DELETE" }),
      }),
    );
    expect(del.status).toBe(404);
  });
});

describe("flag ON", () => {
  it("refuses without the typed word DELETE, before checking the code", async () => {
    mocks.flagOn = true;
    await expect(deleteAccount(USER, { code: "123456", confirmText: "delete" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(deleteAccount(USER, { code: "123456", confirmText: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("the APIs need a signed-in user", async () => {
    mocks.flagOn = true;
    const { unauthenticated } = await import("@/lib/errors");
    mocks.requireUser.mockRejectedValueOnce(unauthenticated());
    const res = await statusRoute();
    expect(res.status).toBe(401);
  });
});
