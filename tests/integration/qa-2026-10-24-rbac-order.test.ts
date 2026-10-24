/**
 * TC-RBAC-003 / TC-RBAC-005 (QA run 24 Oct 2026): a signed-in caller without
 * the permission, or another shop's owner, got 422 VALIDATION_FAILED (with
 * the field names) for an empty body, because the body was read before the
 * permission or ownership check. Each now answers 403 first; a caller who
 * may act still gets the route's own validation.
 */
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

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { PATCH as payoutBatchPatch } from "@/app/api/admin/payouts/batches/[id]/route";
import { PUT as cancellationFeePut } from "@/app/api/shops/[id]/cancellation-fee/route";
import { POST as segmentsPost } from "@/app/api/shops/[id]/marketing/segments/route";
import { PATCH as profileSetupPatch } from "@/app/api/shops/[id]/profile-setup/route";
import { POST as staffPost } from "@/app/api/shops/[id]/staff/route";
import { PATCH as cannedPatch } from "@/app/api/support/canned-replies/[id]/route";
import { POST as cannedPost } from "@/app/api/support/canned-replies/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const ID = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
});

function signIn(user: { id: string; email: string }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: null, image: null, role, status: "ACTIVE" } };
}

describe("TC-RBAC-003: staff routes refuse a customer before reading the body", () => {
  it.each([
    ["PATCH /api/admin/payouts/batches/[id]", payoutBatchPatch, "PATCH"],
    ["POST /api/support/canned-replies", cannedPost, "POST"],
    ["PATCH /api/support/canned-replies/[id]", cannedPatch, "PATCH"],
  ] as const)("%s → 403 for an empty body", async (_name, handler, method) => {
    signIn(await createUser(), "CUSTOMER");
    const res = await call(handler as never, `/api/x/${ID}`, { method, body: {}, params: { id: ID } });
    expect(res.status).toBe(403);
  });

  it("an admin still gets the route's validation", async () => {
    signIn(await createUser({ role: "ADMIN" }), "ADMIN");
    const res = await call(cannedPost as never, "/api/support/canned-replies", { method: "POST", body: {} });
    expect(res.status).toBe(422);
  });
});

describe("TC-RBAC-005: shop routes refuse another shop's owner before reading the body", () => {
  it.each([
    ["PUT /api/shops/[id]/cancellation-fee", cancellationFeePut, "PUT"],
    ["POST /api/shops/[id]/marketing/segments", segmentsPost, "POST"],
    ["PATCH /api/shops/[id]/profile-setup", profileSetupPatch, "PATCH"],
    ["POST /api/shops/[id]/staff", staffPost, "POST"],
  ] as const)("%s → 403 for owner B on shop A", async (_name, handler, method) => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id);
    signIn(await createUser({ role: "SHOP_OWNER" }), "SHOP_OWNER");
    const res = await call(handler as never, `/api/shops/${shopA.id}/x`, { method, body: {}, params: { id: shopA.id } });
    expect(res.status).toBe(403);
  });

  it("the shop's own owner still gets the route's validation", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    signIn(owner, "SHOP_OWNER");
    const res = await call(staffPost as never, `/api/shops/${shop.id}/staff`, { method: "POST", body: {}, params: { id: shop.id } });
    expect(res.status).toBe(422);
  });
});
