/**
 * Module 10 — shop staff roles and permissions (docs/shop-staff-roles-2026-11).
 *
 * Real PostgreSQL and the real route handlers: only the session source is
 * mocked. Covers flag OFF unchanged, invite → accept, per-role allow / deny on
 * migrated routes, cross-shop isolation, pause / restore / role change / remove
 * taking effect on the next request, a manager's limits, and the owner's
 * per-staff activity log.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeatureFlagKey, UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as acceptRoute } from "@/app/api/shop-staff/invitations/accept/route";
import { GET as invitationsRoute } from "@/app/api/shop-staff/invitations/route";
import { GET as inventoryGet, PATCH as inventoryPatch } from "@/app/api/shops/[id]/inventory/route";
import { GET as shopOrdersGet } from "@/app/api/shops/[id]/orders/route";
import { GET as activityGet } from "@/app/api/shops/[id]/staff/[staffId]/activity/route";
import { DELETE as staffDelete, PATCH as staffPatch } from "@/app/api/shops/[id]/staff/[staffId]/route";
import { GET as staffList, POST as staffPost } from "@/app/api/shops/[id]/staff/route";
import { GET as walletGet } from "@/app/api/shops/[id]/wallet/route";
import { PATCH as orderStatus } from "@/app/api/orders/[id]/status/route";
import { db } from "@/server/db";
import { auditLogs, featureFlags, shopStaff } from "@/server/db/schema";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

type U = { id: string; email: string; name: string | null; role: UserRole };
function signIn(user: U) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function setup() {
  const owner = (await createUser({ role: "SHOP_OWNER", name: "Owner A" })) as U;
  const otherOwner = (await createUser({ role: "SHOP_OWNER", name: "Owner B" })) as U;
  const helper = (await createUser({ role: "CUSTOMER", name: "Helper" })) as U;
  const customer = (await createUser({ role: "CUSTOMER", name: "Buyer" })) as U;
  const shopA = await createShop(owner.id, { name: "Shop A" });
  const shopB = await createShop(otherOwner.id, { name: "Shop B" });
  return { owner, otherOwner, helper, customer, shopA, shopB };
}

/** Invite `helper` to shopA with `role` as the owner, accept as helper; returns the staff row id. */
async function hire(ctx: Awaited<ReturnType<typeof setup>>, role: string, permissions: string[] = []) {
  signIn(ctx.owner);
  const invited = await call(staffPost, `/api/shops/${ctx.shopA.id}/staff`, {
    method: "POST",
    params: { id: ctx.shopA.id },
    body: { identifier: ctx.helper.email, role, permissions },
  });
  expect(invited.status).toBe(201);
  expect(invited.body.status).toBe("INVITED");
  signIn(ctx.helper);
  const accepted = await call(acceptRoute, "/api/shop-staff/invitations/accept", { method: "POST", body: { staffId: invited.body.id } });
  expect(accepted.status).toBe(200);
  return invited.body.id as string;
}

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  clearFeatureFlagCache();
});

describe("flag OFF: exactly as before", () => {
  it("POST adds catalogue staff at once; the staff member gets nothing on other shop routes", async () => {
    const ctx = await setup();
    await flag("shop_staff_roles_enabled", false);
    signIn(ctx.owner);
    const added = await call(staffPost, `/api/shops/${ctx.shopA.id}/staff`, { method: "POST", params: { id: ctx.shopA.id }, body: { identifier: ctx.helper.email } });
    expect(added.status).toBe(201);
    expect(added.body.status).toBe("ACTIVE");
    expect(added.body.role).toBe("CATALOGUE_MANAGER");
    signIn(ctx.helper);
    expect((await call(inventoryGet, `/api/shops/${ctx.shopA.id}/inventory`, { params: { id: ctx.shopA.id } })).status).toBe(403);
    expect((await call(shopOrdersGet, `/api/shops/${ctx.shopA.id}/orders`, { params: { id: ctx.shopA.id } })).status).toBe(403);
    // Invitations are not offered with the flag off.
    expect((await call(invitationsRoute, "/api/shop-staff/invitations")).body.invitations).toEqual([]);
  });

  it("role change and pause are unavailable", async () => {
    const ctx = await setup();
    await flag("shop_staff_roles_enabled", false);
    signIn(ctx.owner);
    const added = await call(staffPost, `/api/shops/${ctx.shopA.id}/staff`, { method: "POST", params: { id: ctx.shopA.id }, body: { identifier: ctx.helper.email } });
    const r = await call(staffPatch, "/x", { method: "PATCH", params: { id: ctx.shopA.id, staffId: added.body.id }, body: { suspended: true } });
    expect(r.status).toBe(404);
  });
});

describe("flag ON", () => {
  beforeEach(async () => {
    await flag("shop_staff_roles_enabled", true);
  });

  it("invite → nothing granted until accepted → ACTIVE", async () => {
    const ctx = await setup();
    signIn(ctx.owner);
    const invited = await call(staffPost, `/api/shops/${ctx.shopA.id}/staff`, {
      method: "POST",
      params: { id: ctx.shopA.id },
      body: { identifier: ctx.helper.email, role: "INVENTORY_MANAGER" },
    });
    expect(invited.status).toBe(201);
    signIn(ctx.helper);
    expect((await call(inventoryGet, `/api/shops/${ctx.shopA.id}/inventory`, { params: { id: ctx.shopA.id } })).status).toBe(403);
    const mine = await call(invitationsRoute, "/api/shop-staff/invitations");
    expect(mine.body.invitations.map((i: { id: string }) => i.id)).toEqual([invited.body.id]);
    // Someone else cannot accept it.
    signIn(ctx.otherOwner);
    expect((await call(acceptRoute, "/x", { method: "POST", body: { staffId: invited.body.id } })).status).toBe(403);
    signIn(ctx.helper);
    expect((await call(acceptRoute, "/x", { method: "POST", body: { staffId: invited.body.id } })).status).toBe(200);
    expect((await call(inventoryGet, `/api/shops/${ctx.shopA.id}/inventory`, { params: { id: ctx.shopA.id } })).status).toBe(200);
    const patched = await call(inventoryPatch, `/api/shops/${ctx.shopA.id}/inventory`, { method: "PATCH", params: { id: ctx.shopA.id }, body: { lowStockThreshold: 4 } });
    expect(patched.status).toBe(200);
  });

  it("an e-mail invitation to a person without an account is accepted once they sign in with that address", async () => {
    const ctx = await setup();
    signIn(ctx.owner);
    const invited = await call(staffPost, `/api/shops/${ctx.shopA.id}/staff`, {
      method: "POST",
      params: { id: ctx.shopA.id },
      body: { identifier: "new.helper@example.test", role: "ORDER_MANAGER" },
    });
    expect(invited.status).toBe(201);
    const [row] = await db.select().from(shopStaff).where(eq(shopStaff.id, invited.body.id));
    expect(row.userId).toBeNull();
    expect(row.inviteTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const newcomer = (await createUser({ email: "new.helper@example.test", role: "CUSTOMER" })) as U;
    signIn(ctx.helper); // a different account cannot take it
    expect((await call(acceptRoute, "/x", { method: "POST", body: { staffId: invited.body.id } })).status).toBe(403);
    signIn(newcomer);
    expect((await call(acceptRoute, "/x", { method: "POST", body: { staffId: invited.body.id } })).status).toBe(200);
    const [after] = await db.select().from(shopStaff).where(eq(shopStaff.id, invited.body.id));
    expect(after.userId).toBe(newcomer.id);
    expect(after.status).toBe("ACTIVE");
    expect(after.inviteTokenHash).toBeNull();
  });

  it("per role: order manager may move orders, not see money or stock; cross-shop refused", async () => {
    const ctx = await setup();
    await hire(ctx, "ORDER_MANAGER");
    const order = await createOrder(ctx.customer.id, ctx.shopA.id, { status: "CONFIRMED" });
    const orderB = await createOrder(ctx.customer.id, ctx.shopB.id, { status: "CONFIRMED" });
    signIn(ctx.helper);
    expect((await call(shopOrdersGet, `/api/shops/${ctx.shopA.id}/orders`, { params: { id: ctx.shopA.id } })).status).toBe(200);
    const moved = await call(orderStatus, `/api/orders/${order.id}/status`, { method: "PATCH", params: { id: order.id }, body: { status: "PREPARING" } });
    expect(moved.status).not.toBe(403);
    expect((await call(walletGet, `/api/shops/${ctx.shopA.id}/wallet`, { params: { id: ctx.shopA.id } })).status).toBe(403);
    expect((await call(inventoryGet, `/api/shops/${ctx.shopA.id}/inventory`, { params: { id: ctx.shopA.id } })).status).toBe(403);
    // Shop B: never.
    expect((await call(shopOrdersGet, `/api/shops/${ctx.shopB.id}/orders`, { params: { id: ctx.shopB.id } })).status).toBe(403);
    expect((await call(orderStatus, `/api/orders/${orderB.id}/status`, { method: "PATCH", params: { id: orderB.id }, body: { status: "PREPARING" } })).status).toBe(403);
  });

  it("pause, restore, role change and removal apply on the next request, all audited", async () => {
    const ctx = await setup();
    const staffId = await hire(ctx, "INVENTORY_MANAGER");
    const inv = () => call(inventoryGet, `/api/shops/${ctx.shopA.id}/inventory`, { params: { id: ctx.shopA.id } });
    signIn(ctx.helper);
    expect((await inv()).status).toBe(200);

    signIn(ctx.owner);
    expect((await call(staffPatch, "/x", { method: "PATCH", params: { id: ctx.shopA.id, staffId }, body: { suspended: true } })).status).toBe(200);
    signIn(ctx.helper);
    expect((await inv()).status).toBe(403);

    signIn(ctx.owner);
    expect((await call(staffPatch, "/x", { method: "PATCH", params: { id: ctx.shopA.id, staffId }, body: { suspended: false } })).status).toBe(200);
    signIn(ctx.helper);
    expect((await inv()).status).toBe(200);

    signIn(ctx.owner);
    expect((await call(staffPatch, "/x", { method: "PATCH", params: { id: ctx.shopA.id, staffId }, body: { role: "BILLING_MANAGER" } })).status).toBe(200);
    signIn(ctx.helper);
    expect((await inv()).status).toBe(403);
    expect((await call(walletGet, `/api/shops/${ctx.shopA.id}/wallet`, { params: { id: ctx.shopA.id } })).status).toBe(200);

    signIn(ctx.owner);
    expect((await call(staffDelete, "/x", { method: "DELETE", params: { id: ctx.shopA.id, staffId } })).status).toBe(204);
    signIn(ctx.helper);
    expect((await call(walletGet, `/api/shops/${ctx.shopA.id}/wallet`, { params: { id: ctx.shopA.id } })).status).toBe(403);

    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityType, "shop"), eq(auditLogs.entityId, ctx.shopA.id)))).map((a) => a.action);
    for (const a of ["shop_staff.invited", "shop_staff.invite_accepted", "shop_staff.suspended", "shop_staff.reactivated", "shop_staff.role_changed", "shop_staff.removed"]) {
      expect(actions).toContain(a);
    }
  });

  it("a manager may invite within their permissions, never another manager, never into another shop", async () => {
    const ctx = await setup();
    await hire(ctx, "MANAGER");
    const third = (await createUser({ role: "CUSTOMER" })) as U;
    signIn(ctx.helper);
    const asManager = (body: object, shopId = ctx.shopA.id) => call(staffPost, `/api/shops/${shopId}/staff`, { method: "POST", params: { id: shopId }, body });
    expect((await asManager({ identifier: third.email, role: "MANAGER" })).status).toBe(403);
    expect((await asManager({ identifier: third.email, role: "CUSTOM", permissions: ["config_access", "settings.edit"] })).status).toBe(403);
    expect((await asManager({ identifier: third.email, role: "ORDER_MANAGER" }, ctx.shopB.id)).status).toBe(403);
    expect((await asManager({ identifier: third.email, role: "ORDER_MANAGER" })).status).toBe(201);
    expect((await call(staffList, `/api/shops/${ctx.shopA.id}/staff`, { params: { id: ctx.shopA.id } })).status).toBe(200);
  });

  it("the owner sees each staff member's activity in the shop; others cannot", async () => {
    const ctx = await setup();
    const staffId = await hire(ctx, "INVENTORY_MANAGER");
    signIn(ctx.helper);
    await call(inventoryPatch, `/api/shops/${ctx.shopA.id}/inventory`, { method: "PATCH", params: { id: ctx.shopA.id }, body: { lowStockThreshold: 6 } });
    await new Promise((r) => setTimeout(r, 100)); // the guard's audit write is fire-and-forget
    signIn(ctx.owner);
    const activity = await call(activityGet, "/x", { params: { id: ctx.shopA.id, staffId } });
    expect(activity.status).toBe(200);
    const actions = activity.body.activity.map((a: { action: string }) => a.action);
    expect(actions).toContain("shop_staff.action");
    expect(actions).toContain("shop_staff.invite_accepted");
    signIn(ctx.otherOwner);
    expect((await call(activityGet, "/x", { params: { id: ctx.shopA.id, staffId } })).status).toBe(403);
  });
});
