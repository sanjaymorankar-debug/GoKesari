/**
 * Module 10 — shop staff roles and permissions (docs/shop-staff-roles-2026-11).
 *
 * Pure permission matrix, and the guard requireShopPermission with the
 * database, session and staff lookup replaced by in-memory fakes: allows and
 * refuses per role, cross-shop isolation, suspended/revoked refused on the
 * very next request, and flag OFF behaving exactly like requireShopAccess.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_SHOP_STAFF_PERMISSIONS,
  canGrant,
  effectivePermissions,
  normalisePermissions,
  permissionAllows,
  roleAllows,
  SHOP_STAFF_ROLE_PRESETS,
  visibleSections,
  type ShopStaffPermission,
} from "@/lib/shop-staff/permissions";

/* ------------------------------------------------------------ fakes */

type Status = "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
const state = vi.hoisted(() => ({
  flag: false,
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: string; status: "ACTIVE" } },
  shops: new Map<string, { id: string; ownerId: string }>(),
  staff: [] as { id: string; shopId: string; userId: string; status: Status; role: string; permissions: string[] }[],
  audits: [] as { action: string; entityId?: string | null }[],
  /** Rows the fake db.select() chain answers, in call order (for shopStaffAccess). */
  selectQueue: [] as unknown[][],
  currentShop: null as null | { id: string; ownerId: string },
}));

vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));
vi.mock("@/server/services/audit", () => ({
  AUDIT_ACTIONS: { AUTHZ_DENIED: "authz.denied", SHOP_STAFF_ACTION: "shop_staff.action" },
  recordAudit: async (entry: { action: string; entityId?: string | null }) => {
    state.audits.push(entry);
  },
}));
vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: async (key: string) => key === "shop_staff_roles_enabled" && state.flag,
  featureNotAvailable: () => new Error("not available"),
}));
vi.mock("@/server/db", () => {
  const chain = () => {
    const rows = state.selectQueue.shift() ?? [];
    const p = Promise.resolve(rows);
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      then: p.then.bind(p),
    };
    return c;
  };
  return {
    db: {
      select: () => chain(),
      query: { shops: { findFirst: async () => state.currentShop } },
    },
  };
});

// The guard's own lookups go through these two; faked from `state` so a test can flip status between requests.
vi.mock("@/server/services/shop-staff-access", async () => {
  const perms = await import("@/lib/shop-staff/permissions");
  return {
    SHOP_STAFF_ROLES_FLAG: "shop_staff_roles_enabled",
    shopStaffRolesEnabled: async () => state.flag,
    activeStaffGrant: async (shopId: string, userId: string) => {
      const row = state.staff.find((s) => s.shopId === shopId && s.userId === userId && s.status === "ACTIVE");
      if (!row) return null;
      const role = perms.isShopStaffRole(row.role) ? row.role : "CATALOGUE_MANAGER";
      return { staffId: row.id, role, permissions: perms.effectivePermissions(role, row.permissions) };
    },
  };
});

/** The fake db answers the guard's shop lookup with this shop (or none). */
function pickShop(id: string) {
  state.currentShop = state.shops.get(id) ?? null;
}

import { assertStaffAllows, requireShopPermission } from "@/server/authz/shop-permission";
import { PERMISSIONS } from "@/server/authz/permissions";

const SHOP_A = "00000000-0000-4000-8000-00000000000a";
const SHOP_B = "00000000-0000-4000-8000-00000000000b";
const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000b1";
const STAFF = "00000000-0000-4000-8000-0000000000c1";
const ADMIN = "00000000-0000-4000-8000-0000000000d1";

function signIn(id: string, role = "CUSTOMER") {
  state.session = { user: { id, email: `${id.slice(-2)}@example.test`, name: null, image: null, role, status: "ACTIVE" } };
}
function addStaff(role: string, permissions: string[] = [], shopId = SHOP_A, status: Status = "ACTIVE") {
  state.staff.push({ id: `staff-${state.staff.length}`, shopId, userId: STAFF, status, role, permissions });
}
async function attempt(shopId: string, permission: ShopStaffPermission, anyPermission = PERMISSIONS.ORDER_UPDATE_STATUS_ANY) {
  pickShop(shopId);
  try {
    const r = await requireShopPermission(shopId, permission, { anyPermission });
    return r.via;
  } catch (e) {
    return (e as { code?: string }).code ?? "ERROR";
  }
}

beforeEach(() => {
  state.flag = false;
  state.session = null;
  state.staff = [];
  state.audits = [];
  state.selectQueue = [];
  state.shops = new Map([
    [SHOP_A, { id: SHOP_A, ownerId: OWNER_A }],
    [SHOP_B, { id: SHOP_B, ownerId: OWNER_B }],
  ]);
});

/* ------------------------------------------------------------ matrix */

describe("permission catalogue", () => {
  it("has resource × action plus the two flags", () => {
    expect(ALL_SHOP_STAFF_PERMISSIONS).toHaveLength(9 * 7 + 2);
    expect(ALL_SHOP_STAFF_PERMISSIONS).toContain("orders.approve");
    expect(ALL_SHOP_STAFF_PERMISSIONS).toContain("financial_visibility");
  });

  it("preset roles grant what the brief lists", () => {
    expect(roleAllows("ORDER_MANAGER", [], "orders.approve")).toBe(true);
    expect(roleAllows("ORDER_MANAGER", [], "orders.cancel")).toBe(true);
    expect(roleAllows("ORDER_MANAGER", [], "billing.view")).toBe(false);
    expect(roleAllows("CATALOGUE_MANAGER", [], "catalogue.edit")).toBe(true);
    expect(roleAllows("CATALOGUE_MANAGER", [], "orders.view")).toBe(false);
    expect(roleAllows("INVENTORY_MANAGER", [], "inventory.edit")).toBe(true);
    expect(roleAllows("INVENTORY_MANAGER", [], "catalogue.edit")).toBe(false);
    expect(roleAllows("DELIVERY_MANAGER", [], "delivery.create")).toBe(true);
    expect(roleAllows("CUSTOMER_SUPPORT", [], "customers.edit")).toBe(true);
    expect(roleAllows("CUSTOMER_SUPPORT", [], "orders.edit")).toBe(false);
    expect(roleAllows("BILLING_MANAGER", [], "billing.export")).toBe(true);
    expect(roleAllows("BILLING_MANAGER", [], "reports.export")).toBe(true);
  });

  it("MANAGER: everything but settings changes (unless granted) and staff deletion", () => {
    expect(roleAllows("MANAGER", [], "orders.edit")).toBe(true);
    expect(roleAllows("MANAGER", [], "billing.view")).toBe(true);
    expect(roleAllows("MANAGER", [], "staff.create")).toBe(true);
    expect(roleAllows("MANAGER", [], "staff.delete")).toBe(false);
    expect(roleAllows("MANAGER", [], "settings.view")).toBe(true);
    expect(roleAllows("MANAGER", [], "settings.edit")).toBe(false);
    expect(roleAllows("MANAGER", ["settings.edit"], "settings.edit")).toBe(false); // still needs config_access
    expect(roleAllows("MANAGER", ["settings.edit", "config_access"], "settings.edit")).toBe(true);
  });

  it("billing needs financial_visibility; settings changes need config_access", () => {
    expect(permissionAllows(["billing.view"], "billing.view")).toBe(false);
    expect(permissionAllows(["billing.view", "financial_visibility"], "billing.view")).toBe(true);
    expect(permissionAllows(["settings.view"], "settings.view")).toBe(true);
    expect(permissionAllows(["settings.edit"], "settings.edit")).toBe(false);
  });

  it("CUSTOM grants exactly its list; unknown strings are dropped", () => {
    expect(effectivePermissions("CUSTOM", ["orders.view", "bogus", "orders.view"])).toEqual(["orders.view"]);
    expect(effectivePermissions("CUSTOM", [])).toEqual([]);
    expect(normalisePermissions(["x", "reports.view", null])).toEqual(["reports.view"]);
  });

  it("an unknown or legacy role is the old catalogue access", () => {
    expect(effectivePermissions(null, [])).toEqual(effectivePermissions("CATALOGUE_MANAGER", []));
    expect(effectivePermissions("SOMETHING", [])).toEqual([...SHOP_STAFF_ROLE_PRESETS.CATALOGUE_MANAGER].sort((a, b) => ALL_SHOP_STAFF_PERMISSIONS.indexOf(a) - ALL_SHOP_STAFF_PERMISSIONS.indexOf(b)));
  });

  it("canGrant: owner anything; a manager never MANAGER and nothing beyond their own", () => {
    const manager = effectivePermissions("MANAGER", []);
    expect(canGrant(null, "MANAGER", [])).toBe(true);
    expect(canGrant(manager, "MANAGER", [])).toBe(false);
    expect(canGrant(manager, "ORDER_MANAGER", [])).toBe(true);
    expect(canGrant(manager, "CUSTOM", ["config_access"])).toBe(false);
    expect(canGrant(manager, "CUSTOM", ["staff.delete"])).toBe(false);
  });

  it("board shows only allowed sections", () => {
    expect(visibleSections(effectivePermissions("ORDER_MANAGER", []))).toEqual(["orders", "delivery", "customers"]);
    expect(visibleSections(effectivePermissions("CATALOGUE_MANAGER", []))).toEqual(["catalogue", "inventory"]);
    expect(visibleSections(["billing.view"])).toEqual([]); // no financial_visibility
  });
});

/* ------------------------------------------------------------ guard */

describe("requireShopPermission", () => {
  it("owner passes every permission, flag on or off", async () => {
    signIn(OWNER_A, "SHOP_OWNER");
    for (const flag of [false, true]) {
      state.flag = flag;
      for (const p of ["orders.edit", "billing.view", "settings.edit", "staff.delete"] as const) expect(await attempt(SHOP_A, p)).toBe("OWNER");
    }
  });

  it("operations pass through anyPermission exactly as requireShopAccess", async () => {
    signIn(ADMIN, "ADMIN");
    expect(await attempt(SHOP_A, "orders.edit")).toBe("SUPPORT");
  });

  it("another shop's owner is refused", async () => {
    signIn(OWNER_B, "SHOP_OWNER");
    state.flag = true;
    expect(await attempt(SHOP_A, "orders.view")).toBe("FORBIDDEN");
  });

  it("flag OFF: active staff get nothing through this guard (unchanged behaviour)", async () => {
    signIn(STAFF);
    addStaff("MANAGER");
    expect(await attempt(SHOP_A, "orders.view")).toBe("FORBIDDEN");
    expect(await attempt(SHOP_A, "catalogue.edit")).toBe("FORBIDDEN");
  });

  it("flag ON: allows and refuses per role", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("ORDER_MANAGER");
    expect(await attempt(SHOP_A, "orders.edit")).toBe("STAFF");
    expect(await attempt(SHOP_A, "orders.approve")).toBe("STAFF");
    expect(await attempt(SHOP_A, "billing.view")).toBe("FORBIDDEN");
    expect(await attempt(SHOP_A, "catalogue.edit")).toBe("FORBIDDEN");
    expect(await attempt(SHOP_A, "settings.edit")).toBe("FORBIDDEN");
  });

  it("billing only with financial visibility; settings only with config access", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("CUSTOM", ["billing.view", "settings.edit"]);
    expect(await attempt(SHOP_A, "billing.view")).toBe("FORBIDDEN");
    expect(await attempt(SHOP_A, "settings.edit")).toBe("FORBIDDEN");
    state.staff[0].permissions.push("financial_visibility", "config_access");
    expect(await attempt(SHOP_A, "billing.view")).toBe("STAFF");
    expect(await attempt(SHOP_A, "settings.edit")).toBe("STAFF");
  });

  it("cross-shop isolation: staff of shop A cannot touch shop B", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("MANAGER", [], SHOP_A);
    expect(await attempt(SHOP_A, "orders.edit")).toBe("STAFF");
    expect(await attempt(SHOP_B, "orders.view")).toBe("FORBIDDEN");
  });

  it("suspended, revoked and invited are refused on the very next request", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("ORDER_MANAGER");
    expect(await attempt(SHOP_A, "orders.edit")).toBe("STAFF");
    for (const status of ["SUSPENDED", "REVOKED", "INVITED"] as const) {
      state.staff[0].status = status;
      expect(await attempt(SHOP_A, "orders.edit")).toBe("FORBIDDEN");
    }
    state.staff[0].status = "ACTIVE";
    expect(await attempt(SHOP_A, "orders.edit")).toBe("STAFF");
  });

  it("a role change applies on the next request", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("ORDER_MANAGER");
    expect(await attempt(SHOP_A, "inventory.edit")).toBe("FORBIDDEN");
    state.staff[0].role = "INVENTORY_MANAGER";
    expect(await attempt(SHOP_A, "inventory.edit")).toBe("STAFF");
    expect(await attempt(SHOP_A, "orders.edit")).toBe("FORBIDDEN");
  });

  it("a staff change is audited against the shop; a view is not", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("ORDER_MANAGER");
    await attempt(SHOP_A, "orders.view");
    expect(state.audits.filter((a) => a.action === "shop_staff.action")).toHaveLength(0);
    await attempt(SHOP_A, "orders.edit");
    expect(state.audits.filter((a) => a.action === "shop_staff.action" && a.entityId === SHOP_A)).toHaveLength(1);
  });

  it("signed out is 401; a missing shop is 404", async () => {
    expect(await attempt(SHOP_A, "orders.view")).toBe("UNAUTHENTICATED");
    signIn(OWNER_A, "SHOP_OWNER");
    expect(await attempt("00000000-0000-4000-8000-0000000000ff", "orders.view")).toBe("NOT_FOUND");
  });

  it("a list lets staff in with any one; assertStaffAllows then decides the action", async () => {
    state.flag = true;
    signIn(STAFF);
    addStaff("INVENTORY_MANAGER");
    pickShop(SHOP_A);
    const access = await requireShopPermission(SHOP_A, ["catalogue.edit", "inventory.edit"], { anyPermission: PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY });
    expect(access.via).toBe("STAFF");
    expect(() => assertStaffAllows(access, "inventory.edit")).not.toThrow();
    expect(() => assertStaffAllows(access, "catalogue.edit")).toThrow();
    expect(() => assertStaffAllows({ via: "OWNER", staff: null, user: access.user }, "catalogue.edit")).not.toThrow();
  });
});

/* ------------------------------------------------------- shopStaffAccess (real) */

describe("shopStaffAccess / shopStaffCan", () => {
  it("owner always; staff only with the flag on and the permission held", async () => {
    const real = await vi.importActual<typeof import("@/server/services/shop-staff-access")>("@/server/services/shop-staff-access");
    // owner
    state.selectQueue = [[{ ownerId: OWNER_A }]];
    expect((await real.shopStaffAccess(SHOP_A, { id: OWNER_A }, "billing.view"))?.via).toBe("OWNER");
    // flag off: staff refused without reading the staff table
    state.selectQueue = [[{ ownerId: OWNER_A }], [{ id: "s1", role: "MANAGER", permissions: [] }]];
    expect(await real.shopStaffCan(SHOP_A, { id: STAFF }, "orders.view")).toBe(false);
    // flag on
    state.flag = true;
    state.selectQueue = [[{ ownerId: OWNER_A }], [{ id: "s1", role: "ORDER_MANAGER", permissions: [] }]];
    expect(await real.shopStaffCan(SHOP_A, { id: STAFF }, "orders.edit")).toBe(true);
    state.selectQueue = [[{ ownerId: OWNER_A }], [{ id: "s1", role: "ORDER_MANAGER", permissions: [] }]];
    expect(await real.shopStaffCan(SHOP_A, { id: STAFF }, "billing.view")).toBe(false);
    // no active row (suspended / revoked / other shop) → refused
    state.selectQueue = [[{ ownerId: OWNER_A }], []];
    expect(await real.shopStaffCan(SHOP_A, { id: STAFF }, "orders.view")).toBe(false);
    // deleted / missing shop
    state.selectQueue = [[]];
    expect(await real.shopStaffCan(SHOP_A, { id: OWNER_A }, "orders.view")).toBe(false);
  });
});

/* ------------------------------------------------------- flag OFF: new staff actions are unavailable */

describe("staff management with the flag OFF", () => {
  it("invite, role change, pause and accept are unavailable; no invitations are listed", async () => {
    const svc = await import("@/server/services/shop-staff");
    const owner = { id: OWNER_A, role: "SHOP_OWNER" as const };
    await expect(svc.inviteShopStaff(SHOP_A, { identifier: "a@example.test", role: "ORDER_MANAGER" }, owner)).rejects.toThrow();
    await expect(svc.changeShopStaffRole(SHOP_A, "x", { role: "ORDER_MANAGER" }, owner)).rejects.toThrow();
    await expect(svc.setShopStaffSuspended(SHOP_A, "x", true, owner)).rejects.toThrow();
    await expect(svc.acceptShopStaffInvite({ token: "t".repeat(40) }, { id: STAFF, email: "s@example.test", role: "CUSTOMER" })).rejects.toThrow();
    expect(await svc.listMyInvitations({ id: STAFF, email: "s@example.test" })).toEqual([]);
    expect(await svc.myStaffPermissions(SHOP_A, STAFF)).toBeNull();
  });

  it("catalogue access keeps the Module 1 rule: an active CATALOGUE_MANAGER row (every pre-0198 row)", async () => {
    const svc = await import("@/server/services/shop-staff");
    const actor = { id: STAFF, role: "CUSTOMER" as const };
    state.selectQueue = [[{ ownerId: OWNER_A }], [{ id: "s1", role: "CATALOGUE_MANAGER", permissions: [] }]];
    expect(await svc.catalogueAccessFor(SHOP_A, actor)).toBe("STAFF");
    // An order manager (only possible after Module 10) does not get photo/description access.
    state.selectQueue = [[{ ownerId: OWNER_A }], [{ id: "s1", role: "ORDER_MANAGER", permissions: [] }]];
    expect(await svc.catalogueAccessFor(SHOP_A, actor)).toBeNull();
  });
});
