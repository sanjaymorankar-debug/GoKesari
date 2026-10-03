/**
 * The explicit-save admin screens, proven at the route level.
 *
 * The point of these three screens is that a write happens only when the admin
 * presses Save, and that pressing Save is checked again on the server — a
 * crafted request body must get the same answer the UI would give. So each test
 * calls the real `route()`-wrapped handler, not the service underneath it.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { PATCH as categoryPatch } from "@/app/api/shop-categories/[id]/route";
import { POST as categoriesPost } from "@/app/api/shop-categories/route";
import { PATCH as profilePatch } from "@/app/api/users/[id]/route";
import { GET as privilegesGet, PATCH as privilegesPatch } from "@/app/api/users/[id]/privileges/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, shopCategories, userRoleGrants, users } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

/** Gives a user an ACTIVE grant, as the real role flows do. */
async function grant(userId: string, role: UserRole) {
  await db.insert(userRoleGrants).values({ userId, role, source: "ADMIN" }).onConflictDoNothing();
}

async function latestAudit(action: string, entityId: string) {
  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row;
}

/**
 * `resetDatabase()` deliberately leaves `shop_categories` alone — the list is
 * reference data seeded by the migration, not per-test fixture data. So a
 * category a test creates outlives it, and a fixed name would clash with the
 * previous run on any database that is not freshly migrated. Each test names
 * its categories uniquely and the ids are dropped afterwards.
 */
let counter = 0;
const uniqueName = (stem: string) => `${stem} ${Date.now().toString(36)}${(counter += 1)}`;
let createdCategoryIds: string[] = [];

beforeEach(async () => {
  state.session = null;
  createdCategoryIds = [];
  resetRateLimits();
  await resetDatabase();
});

afterEach(async () => {
  if (createdCategoryIds.length > 0) {
    await db.delete(shopCategories).where(inArray(shopCategories.id, createdCategoryIds));
  }
});

describe("screen 1 — shop category save", () => {
  it("records the old and new value, so a confirmation can name the change", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);

    const before = uniqueName("Grocery Store");
    const after = uniqueName("Daily Needs");

    const created = await call(categoriesPost, "/api/shop-categories", {
      method: "POST",
      body: { name: before },
    });
    expect(created.status).toBe(201);
    createdCategoryIds.push(created.body.id);

    const renamed = await call(categoryPatch, `/api/shop-categories/${created.body.id}`, {
      method: "PATCH",
      params: { id: created.body.id },
      body: { name: after, description: null, status: "ACTIVE" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe(after);
    // The screen builds "Category updated: <before> → <after>" from this.
    expect(renamed.body.previous.name).toBe(before);

    const entry = await latestAudit(AUDIT_ACTIONS.SHOP_CATEGORY_SAVED, created.body.id);
    expect(entry.actorId).toBe(admin.id);
    expect(entry.previousValue).toMatchObject({ name: before });
    expect(entry.newValue).toMatchObject({ name: after });
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("re-validates on the server even when the client would not have sent it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);
    const name = uniqueName("Bakery");
    const created = await call(categoriesPost, "/api/shop-categories", { method: "POST", body: { name } });
    expect(created.status).toBe(201);
    createdCategoryIds.push(created.body.id);

    const tooShort = await call(categoryPatch, `/api/shop-categories/${created.body.id}`, {
      method: "PATCH",
      params: { id: created.body.id },
      body: { name: "B" },
    });
    expect(tooShort.status).toBe(422);

    // Nothing was written: the admin's unsaved edit is theirs to fix and retry.
    const [row] = await db.select().from(shopCategories).where(eq(shopCategories.id, created.body.id));
    expect(row.name).toBe(name);
  });

  it("refuses a customer who calls the endpoint directly", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    signIn(customer);
    const res = await call(categoriesPost, "/api/shop-categories", {
      method: "POST",
      body: { name: uniqueName("Sneaky") },
    });
    expect(res.status).toBe(403);
  });
});

describe("screen 2 — admin privileges save", () => {
  it("applies the active role and the grants in one request, and audits old → new", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const other = await createUser({ role: "ADMIN" }); // keeps an admin in the system
    await grant(other.id, "ADMIN");
    const target = await createUser({ role: "SHOP_OWNER" });
    await grant(target.id, "SHOP_OWNER");
    signIn(admin);

    const res = await call(privilegesPatch, `/api/users/${target.id}/privileges`, {
      method: "PATCH",
      params: { id: target.id },
      body: { activeRole: "OPERATOR", heldRoles: ["CUSTOMER", "OPERATOR"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.previous).toMatchObject({ activeRole: "SHOP_OWNER" });
    expect(res.body.next).toMatchObject({ activeRole: "OPERATOR" });

    const [saved] = await db.select({ role: users.role }).from(users).where(eq(users.id, target.id));
    expect(saved.role).toBe("OPERATOR");

    const held = await db
      .select({ role: userRoleGrants.role })
      .from(userRoleGrants)
      .where(and(eq(userRoleGrants.userId, target.id), eq(userRoleGrants.status, "ACTIVE")));
    expect(held.map((h) => h.role).sort()).toEqual(["OPERATOR"]);

    const entry = await latestAudit(AUDIT_ACTIONS.USER_PRIVILEGES_UPDATED, target.id);
    expect(entry.actorId).toBe(admin.id);
    expect(entry.previousValue).toMatchObject({ activeRole: "SHOP_OWNER" });
    expect(entry.newValue).toMatchObject({ activeRole: "OPERATOR" });
  });

  it("will not let an admin remove their own last admin right", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await grant(admin.id, "ADMIN");
    const other = await createUser({ role: "ADMIN" });
    await grant(other.id, "ADMIN");
    signIn(admin);

    const res = await call(privilegesPatch, `/api/users/${admin.id}/privileges`, {
      method: "PATCH",
      params: { id: admin.id },
      body: { activeRole: "CUSTOMER", heldRoles: ["CUSTOMER"] },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("your own last administrator right");

    const [unchanged] = await db.select({ role: users.role }).from(users).where(eq(users.id, admin.id));
    expect(unchanged.role).toBe("ADMIN");
  });

  it("will not leave the platform without an administrator", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const soleOther = await createUser({ role: "ADMIN" });
    await grant(soleOther.id, "ADMIN");
    signIn(admin);

    // The acting admin's own grant is removed first, so the target is the last one.
    await db.delete(userRoleGrants).where(eq(userRoleGrants.userId, admin.id));
    await db.update(users).set({ role: "OPERATOR" }).where(eq(users.id, admin.id));

    const res = await call(privilegesPatch, `/api/users/${soleOther.id}/privileges`, {
      method: "PATCH",
      params: { id: soleOther.id },
      body: { activeRole: "CUSTOMER", heldRoles: ["CUSTOMER"] },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("only administrator account left");
  });

  it("rejects a draft whose active role is not held, and one holding both staff roles", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await grant(admin.id, "ADMIN");
    const other = await createUser({ role: "ADMIN" });
    await grant(other.id, "ADMIN");
    const target = await createUser({ role: "CUSTOMER" });
    signIn(admin);

    const notHeld = await call(privilegesPatch, `/api/users/${target.id}/privileges`, {
      method: "PATCH",
      params: { id: target.id },
      body: { activeRole: "OPERATOR", heldRoles: ["CUSTOMER"] },
    });
    expect(notHeld.status).toBe(422);

    const bothStaff = await call(privilegesPatch, `/api/users/${target.id}/privileges`, {
      method: "PATCH",
      params: { id: target.id },
      body: { activeRole: "ADMIN", heldRoles: ["CUSTOMER", "OPERATOR", "ADMIN"] },
    });
    expect(bothStaff.status).toBe(422);

    const [untouched] = await db.select({ role: users.role }).from(users).where(eq(users.id, target.id));
    expect(untouched.role).toBe("CUSTOMER");
  });

  it("is admin-only: an operator can neither read nor save privileges", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const target = await createUser({ role: "CUSTOMER" });
    signIn(operator);

    const read = await call(privilegesGet, `/api/users/${target.id}/privileges`, { params: { id: target.id } });
    expect(read.status).toBe(403);

    const write = await call(privilegesPatch, `/api/users/${target.id}/privileges`, {
      method: "PATCH",
      params: { id: target.id },
      body: { activeRole: "ADMIN", heldRoles: ["CUSTOMER", "ADMIN"] },
    });
    expect(write.status).toBe(403);
  });
});

describe("screen 3 — admin user profile save", () => {
  it("saves the editable fields, names what changed, and audits old → new", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const target = await createUser({ role: "CUSTOMER", name: "Old Name" });
    signIn(admin);

    const res = await call(profilePatch, `/api/users/${target.id}`, {
      method: "PATCH",
      params: { id: target.id },
      body: { name: "New Name", phone: "+919876543210" },
    });
    expect(res.status).toBe(200);
    expect(res.body.changedFields.sort()).toEqual(["name", "phone"]);

    const [saved] = await db
      .select({ name: users.name, phone: users.phone })
      .from(users)
      .where(eq(users.id, target.id));
    expect(saved).toMatchObject({ name: "New Name", phone: "+919876543210" });

    const entry = await latestAudit(AUDIT_ACTIONS.USER_PROFILE_UPDATED, target.id);
    expect(entry.actorId).toBe(admin.id);
    expect(entry.previousValue).toMatchObject({ name: "Old Name" });
    expect(entry.newValue).toMatchObject({ name: "New Name" });
  });

  it("rejects an invalid phone on the server and writes nothing", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const target = await createUser({ role: "CUSTOMER", name: "Keep Me" });
    signIn(admin);

    const res = await call(profilePatch, `/api/users/${target.id}`, {
      method: "PATCH",
      params: { id: target.id },
      body: { name: "Changed Too", phone: "not-a-number" },
    });
    expect(res.status).toBe(422);

    const [unchanged] = await db.select({ name: users.name }).from(users).where(eq(users.id, target.id));
    expect(unchanged.name).toBe("Keep Me");
  });

  it("needs a reason before it will change an account's status", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const target = await createUser({ role: "CUSTOMER" });
    signIn(admin);

    const noReason = await call(profilePatch, `/api/users/${target.id}`, {
      method: "PATCH",
      params: { id: target.id },
      body: { status: "SUSPENDED" },
    });
    expect(noReason.status).toBe(422);

    const withReason = await call(profilePatch, `/api/users/${target.id}`, {
      method: "PATCH",
      params: { id: target.id },
      body: { status: "SUSPENDED", statusReason: "Fraudulent orders" },
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.status).toBe("SUSPENDED");

    const [saved] = await db.select({ status: users.status }).from(users).where(eq(users.id, target.id));
    expect(saved.status).toBe("SUSPENDED");
  });

  it("is admin-only: an operator holds USER_VIEW_ANY but cannot edit a profile", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const target = await createUser({ role: "CUSTOMER", name: "Untouched" });
    signIn(operator);

    const res = await call(profilePatch, `/api/users/${target.id}`, {
      method: "PATCH",
      params: { id: target.id },
      body: { name: "Operator Was Here" },
    });
    expect(res.status).toBe(403);

    const [unchanged] = await db.select({ name: users.name }).from(users).where(eq(users.id, target.id));
    expect(unchanged.name).toBe("Untouched");
  });
});
