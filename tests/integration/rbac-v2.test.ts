/**
 * RBAC v2 Phase 2 (docs/rbac/01-assessment.md): new staff roles, permission boundaries, the
 * generic approval engine (four-eye, bootstrap single-admin, CA → Admin, shop-owner per item),
 * append-only decisions, denied-permission logging and role-scoped flags.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { approvalDecisions, auditLogs, featureFlagChanges, featureFlags, userRoleEnum, users, type UserRole } from "@/server/db/schema";
import { PERMISSIONS, ROLE_PERMISSIONS, can, type Permission } from "@/server/authz/permissions";
import { logDenied } from "@/server/authz/guards";
import {
  FOUR_EYE_TYPES,
  cancelApproval,
  decideApproval,
  emergencySuspend,
  getApproval,
  registerApprovalHandler,
  requestFourEye,
  submitApproval,
} from "@/server/approvals";
import { clearFeatureFlagCache, flagCoversRole, isFeatureEnabledForRole, setFeatureFlagRoleScope } from "@/server/services/feature-flags";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

beforeEach(resetDatabase);

const NEW_ROLES: UserRole[] = ["ACCOUNTANT", "SUPPORT_MANAGER", "SUPPORT_USER", "OPERATIONS_MANAGER", "OPERATIONS_USER"];

/* Sensitive capabilities no new staff role may hold by default (brief §11: no broad permissions). */
const NEVER_FOR_NEW_ROLES: Permission[] = [
  PERMISSIONS.USER_SET_ROLE,
  PERMISSIONS.USER_SUSPEND,
  PERMISSIONS.SYSTEM_CONFIG,
  PERMISSIONS.AUDIT_LOG_VIEW,
  PERMISSIONS.WALLET_ADJUST,
  PERMISSIONS.FINANCE_MANAGE,
  PERMISSIONS.SHOP_APPROVE,
  PERMISSIONS.SHOP_UPDATE_ANY,
  PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY,
  PERMISSIONS.PRODUCT_MRP_MANAGE,
  PERMISSIONS.REGISTRATION_FEE_MANAGE,
  PERMISSIONS.APPROVAL_DECIDE_ADMIN,
  PERMISSIONS.RATE_ACTIVATE,
  PERMISSIONS.SHOP_COST_VIEW,
  PERMISSIONS.ORDER_REFUND,
];

describe("RBAC v2 roles and permission matrix", () => {
  it("adds the five staff roles to user_role", () => {
    for (const role of NEW_ROLES) expect(userRoleEnum.enumValues).toContain(role);
  });

  it("gives no new staff role any admin-level capability", () => {
    for (const role of NEW_ROLES) {
      for (const permission of NEVER_FOR_NEW_ROLES) {
        expect(`${role} ${permission} ${can(role, permission)}`).toBe(`${role} ${permission} false`);
      }
    }
  });

  it("keeps maker and checker apart in accounting", () => {
    expect(can("ACCOUNTANT", PERMISSIONS.JOURNAL_PREPARE)).toBe(true);
    expect(can("ACCOUNTANT", PERMISSIONS.JOURNAL_APPROVE)).toBe(false);
    expect(can("ACCOUNTANT", PERMISSIONS.RATE_PROPOSE)).toBe(true);
    expect(can("ACCOUNTANT", PERMISSIONS.RATE_APPROVE)).toBe(false);
    expect(can("ACCOUNTANT", PERMISSIONS.FIN_PERIOD_CLOSE)).toBe(false);
    expect(can("CA", PERMISSIONS.JOURNAL_APPROVE)).toBe(true);
    expect(can("CA", PERMISSIONS.RATE_APPROVE)).toBe(true);
    expect(can("CA", PERMISSIONS.FIN_PERIOD_CLOSE)).toBe(true);
    expect(can("CA", PERMISSIONS.JOURNAL_PREPARE)).toBe(false);
    expect(can("CA", PERMISSIONS.RATE_ACTIVATE)).toBe(false);
    expect(can("ADMIN", PERMISSIONS.RATE_ACTIVATE)).toBe(true);
  });

  it("separates the Support Manager's queue from the Support User's assigned work", () => {
    expect(can("SUPPORT_MANAGER", PERMISSIONS.SUPPORT_TICKET_MANAGE)).toBe(true);
    expect(can("SUPPORT_MANAGER", PERMISSIONS.SUPPORT_QUEUE_MANAGE)).toBe(true);
    expect(can("SUPPORT_USER", PERMISSIONS.SUPPORT_TICKET_MANAGE)).toBe(false);
    expect(can("SUPPORT_USER", PERMISSIONS.SUPPORT_QUEUE_MANAGE)).toBe(false);
    expect(can("SUPPORT_USER", PERMISSIONS.SUPPORT_TICKET_WORK_ASSIGNED)).toBe(true);
    expect(can("SUPPORT_USER", PERMISSIONS.SHOP_CHANGE_PROPOSE)).toBe(true);
    expect(can("SUPPORT_MANAGER", PERMISSIONS.SHOP_CHANGE_PROPOSE)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.SHOP_CHANGE_DECIDE_OWN)).toBe(true);
    expect(can("SUPPORT_USER", PERMISSIONS.SHOP_CHANGE_DECIDE_OWN)).toBe(false);
  });

  it("lets the Operations User onboard (as Operator-Limited) but never edit approved shop data", () => {
    for (const p of ROLE_PERMISSIONS.OPERATOR_LIMITED) expect(can("OPERATIONS_USER", p)).toBe(true);
    expect(can("OPERATIONS_USER", PERMISSIONS.OPS_TASK_WORK_OWN)).toBe(true);
    expect(can("OPERATIONS_USER", PERMISSIONS.SHOP_GST_PAN_VERIFY)).toBe(false);
    expect(can("OPERATIONS_USER", PERMISSIONS.OPS_TEAM_MANAGE)).toBe(false);
    expect(can("OPERATIONS_MANAGER", PERMISSIONS.OPS_TEAM_MANAGE)).toBe(true);
    expect(can("OPERATIONS_MANAGER", PERMISSIONS.OPERATOR_LIMITED_ONBOARD)).toBe(false);
    // Owner, 25-Nov-2026: the Operations Manager works shop documents and registrations, as the Operator does.
    expect(can("OPERATIONS_MANAGER", PERMISSIONS.SHOP_GST_PAN_VERIFY)).toBe(true);
    expect(can("OPERATIONS_MANAGER", PERMISSIONS.SHOP_REGISTRATION_MANAGE)).toBe(true);
    expect(can("OPERATIONS_USER", PERMISSIONS.SHOP_REGISTRATION_MANAGE)).toBe(false);
  });

  it("removes nothing from the existing roles (brief §2.3 rule 4)", () => {
    // Capabilities each existing role had before RBAC v2 must all still be there.
    const before: Partial<Record<UserRole, Permission[]>> = {
      CA: [PERMISSIONS.STATUTORY_MANAGE, PERMISSIONS.COMMISSION_TDS_MANAGE, PERMISSIONS.DEALER_PAYOUTS_READ, PERMISSIONS.ORDER_PLACE],
      OPERATOR: [PERMISSIONS.SHOP_UPDATE_ANY, PERMISSIONS.SHOP_APPROVE, PERMISSIONS.SUPPORT_TICKET_MANAGE, PERMISSIONS.PRICE_REQUEST_SUBMIT, PERMISSIONS.PMD_PROMOTE],
      OPERATOR_LIMITED: [PERMISSIONS.OPERATOR_LIMITED_ONBOARD, PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS, PERMISSIONS.CONSULT_ONBOARD],
      SHOP_OWNER: [PERMISSIONS.PRICE_REQUEST_DECIDE_OWN, PERMISSIONS.SHOP_UPDATE_OWN, PERMISSIONS.EXCEL_UPLOAD_OWN],
    };
    for (const [role, permissions] of Object.entries(before) as [UserRole, Permission[]][]) {
      for (const p of permissions) expect(`${role} ${p} ${can(role, p)}`).toBe(`${role} ${p} true`);
    }
    // And the operator still cannot do what it never could.
    expect(can("OPERATOR", PERMISSIONS.USER_SET_ROLE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.APPROVAL_DECIDE_ADMIN)).toBe(false);
    // Admin holds everything, including the new capabilities.
    expect(can("ADMIN", PERMISSIONS.APPROVAL_DECIDE_ADMIN)).toBe(true);
  });

  it("gives every role a permission list (no role falls through)", () => {
    for (const role of userRoleEnum.enumValues) expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
  });
});

/* ------------------------------------------------------------- engine */

async function admin(email?: string) {
  const u = await createUser({ role: "ADMIN", email });
  return { id: u.id, role: "ADMIN" as const, email: u.email };
}

describe("approval engine — two-admin (four-eye)", () => {
  it("blocks self-approval and applies a role change once a different admin approves", async () => {
    const a1 = await admin();
    const a2 = await admin();
    const target = await createUser();
    const pending = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, a1, {
      subjectType: "user",
      subjectId: target.id,
      title: "Set role to SUPPORT_USER",
      reason: "New support hire",
      payload: { userId: target.id, role: "SUPPORT_USER" },
    });
    expect(pending.pendingApproval).toBe(true);
    // Nothing applied yet.
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].role).toBe("CUSTOMER");

    await expect(decideApproval({ requestId: pending.approvalId, actor: a1, decision: "APPROVE" })).rejects.toThrow(/different admin/);

    const result = await decideApproval({ requestId: pending.approvalId, actor: a2, decision: "APPROVE" });
    expect(result.applied).toBe(true);
    expect(result.singleAdmin).toBe(false);
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].role).toBe("SUPPORT_USER");

    const detail = await getApproval(pending.approvalId);
    expect(detail.request.status).toBe("APPROVED");
    expect(detail.decisions.map((d) => d.action)).toEqual(["SUBMIT", "APPROVE", "APPLY"]);
    await expect(decideApproval({ requestId: pending.approvalId, actor: a2, decision: "APPROVE" })).rejects.toThrow(/already been decided/);
  });

  it("refuses a non-admin checker and requires a comment to reject", async () => {
    const a1 = await admin();
    const a2 = await admin();
    const ca = await createUser({ role: "CA" });
    const target = await createUser();
    const { approvalId } = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, a1, {
      subjectType: "user", subjectId: target.id, title: "t", reason: "reason", payload: { userId: target.id, role: "ACCOUNTANT" },
    });
    await expect(decideApproval({ requestId: approvalId, actor: { id: ca.id, role: "CA" }, decision: "APPROVE" })).rejects.toThrow(/Only an admin/);
    await expect(decideApproval({ requestId: approvalId, actor: a2, decision: "REJECT" })).rejects.toThrow(/Say why/);
    const r = await decideApproval({ requestId: approvalId, actor: a2, decision: "REJECT", comment: "Not approved by HR" });
    expect(r.request.status).toBe("REJECTED");
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].role).toBe("CUSTOMER");
  });

  it("lets only the requester cancel", async () => {
    const a1 = await admin();
    const a2 = await admin();
    const target = await createUser();
    const { approvalId } = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, a1, {
      subjectType: "user", subjectId: target.id, title: "t", reason: "reason", payload: { userId: target.id, role: "ACCOUNTANT" },
    });
    await expect(cancelApproval(approvalId, a2)).rejects.toThrow(/Only the person/);
    expect((await cancelApproval(approvalId, a1)).status).toBe("CANCELLED");
  });

  it("bootstrap: the Super Admin approves alone while fewer than two admins are active, marked single-admin", async () => {
    const superAdmin = await admin("ceo@agtci.com");
    const target = await createUser();
    const { approvalId } = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, superAdmin, {
      subjectType: "user", subjectId: target.id, title: "t", reason: "first CA", payload: { userId: target.id, role: "CA" },
    });
    const r = await decideApproval({ requestId: approvalId, actor: superAdmin, decision: "APPROVE" });
    expect(r.singleAdmin).toBe(true);
    expect(r.request.singleAdmin).toBe(true);
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].role).toBe("CA");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "approval.single_admin"));
    expect(audit).toHaveLength(1);
    const { sendEmail } = await import("@/server/email/transport");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ceo@agtci.com" }));
  });

  it("bootstrap switches off once a second admin is active, and never applies to another admin", async () => {
    const superAdmin = await admin("ceo@agtci.com");
    const target = await createUser();
    const { approvalId } = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, superAdmin, {
      subjectType: "user", subjectId: target.id, title: "t", reason: "first CA", payload: { userId: target.id, role: "CA" },
    });
    await admin(); // a second active admin
    await expect(decideApproval({ requestId: approvalId, actor: superAdmin, decision: "APPROVE" })).rejects.toThrow(/two admins are active/);

    await resetDatabase();
    const lone = await admin("someone@test.local");
    const t2 = await createUser();
    const r2 = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, lone, {
      subjectType: "user", subjectId: t2.id, title: "t", reason: "second try", payload: { userId: t2.id, role: "CA" },
    });
    await expect(decideApproval({ requestId: r2.approvalId, actor: lone, decision: "APPROVE" })).rejects.toThrow(/different admin/);
  });

  it("emergency suspension applies at once; rejecting the confirmation lifts it", async () => {
    const a1 = await admin();
    const a2 = await admin();
    const target = await createUser();
    const done = await emergencySuspend(target.id, "Account takeover suspected", a1);
    expect(done.confirmBy.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].status).toBe("SUSPENDED");
    await decideApproval({ requestId: done.approvalId, actor: a2, decision: "REJECT", comment: "False alarm, verified with the owner" });
    expect((await db.select().from(users).where(eq(users.id, target.id)))[0].status).toBe("ACTIVE");
  });

  it("records a failed apply as FAILED without losing the approval", async () => {
    const a1 = await admin();
    const a2 = await admin();
    const { approvalId } = await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, a1, {
      subjectType: "user", subjectId: a1.id, title: "t", reason: "self change", payload: { userId: a1.id, role: "CUSTOMER" },
    });
    const r = await decideApproval({ requestId: approvalId, actor: a2, decision: "APPROVE" });
    expect(r.applied).toBe(false);
    expect(r.request.status).toBe("FAILED");
    expect(r.applyError).toMatch(/own role/);
  });
});

describe("approval engine — CA then Admin, shop owner per item", () => {
  const applied: string[][] = [];
  registerApprovalHandler({
    type: "TEST_RATE",
    checker: "CA_THEN_ADMIN",
    async apply() {
      applied.push(["rate"]);
    },
  });
  registerApprovalHandler({
    type: "TEST_SHOP_CHANGE",
    checker: "SHOP_OWNER",
    itemDecisions: true,
    async apply(context) {
      applied.push(context.approvedItems.map((i) => i.field));
    },
  });

  it("needs a CA, then a different admin; the Accountant cannot approve their own", async () => {
    applied.length = 0;
    const accountant = await createUser({ role: "ACCOUNTANT" });
    const ca = await createUser({ role: "CA" });
    const a1 = await admin();
    const req = await submitApproval({
      type: "TEST_RATE",
      actor: { id: accountant.id, role: "ACCOUNTANT" },
      subjectType: "commission_rate",
      title: "Commission 2% → 2.5%",
      reason: "Board decision",
    });
    await expect(decideApproval({ requestId: req.id, actor: { id: accountant.id, role: "ACCOUNTANT" }, decision: "APPROVE" })).rejects.toThrow(/Only a CA/);
    await expect(decideApproval({ requestId: req.id, actor: a1, decision: "APPROVE" })).rejects.toThrow(/Only a CA/);
    const stage = await decideApproval({ requestId: req.id, actor: { id: ca.id, role: "CA" }, decision: "APPROVE" });
    expect(stage.request.stage).toBe(2);
    expect(stage.request.status).toBe("PENDING");
    expect(applied).toHaveLength(0);
    await expect(decideApproval({ requestId: req.id, actor: { id: ca.id, role: "CA" }, decision: "APPROVE" })).rejects.toThrow(/Only an admin/);
    const done = await decideApproval({ requestId: req.id, actor: a1, decision: "APPROVE" });
    expect(done.request.status).toBe("APPROVED");
    expect(applied).toEqual([["rate"]]);
  });

  it("lets the shop owner approve some items and reject others (rejected items never apply)", async () => {
    applied.length = 0;
    const owner = await createUser({ role: "SHOP_OWNER" });
    const other = await createUser({ role: "SHOP_OWNER" });
    const support = await createUser({ role: "SUPPORT_USER" });
    const shop = await createShop(owner.id);
    const req = await submitApproval({
      type: "TEST_SHOP_CHANGE",
      actor: { id: support.id, role: "SUPPORT_USER" },
      subjectType: "shop",
      subjectId: shop.id,
      shopId: shop.id,
      title: "Product corrections",
      reason: "Owner's list of 2 corrections",
      items: [
        { entityType: "shop_product", entityId: "a", field: "mrp", previousValue: 100, proposedValue: 120 },
        { entityType: "shop_product", entityId: "b", field: "name", previousValue: "Old", proposedValue: "New" },
      ],
    });
    const { items } = await getApproval(req.id);
    await expect(decideApproval({ requestId: req.id, actor: { id: other.id, role: "SHOP_OWNER" }, decision: "APPROVE" })).rejects.toThrow(/Only the shop owner/);
    await expect(
      decideApproval({ requestId: req.id, actor: { id: owner.id, role: "SHOP_OWNER" }, decision: "APPROVE", items: [{ itemId: items[0].id, decision: "REJECT" }] }),
    ).rejects.toThrow(/Say why/);
    const r = await decideApproval({
      requestId: req.id,
      actor: { id: owner.id, role: "SHOP_OWNER" },
      decision: "APPROVE",
      items: [{ itemId: items[0].id, decision: "REJECT", comment: "MRP is still 100" }],
    });
    expect(r.request.status).toBe("PARTIALLY_APPROVED");
    expect(applied).toEqual([["name"]]);
    const after = await getApproval(req.id);
    expect(after.items.map((i) => i.status)).toEqual(["REJECTED", "APPROVED"]);
    expect(after.items[0].rejectionComment).toBe("MRP is still 100");
  });
});

describe("append-only decisions and denied logging", () => {
  it("refuses UPDATE and DELETE on approval_decisions", async () => {
    const a1 = await admin();
    const target = await createUser();
    await requestFourEye(FOUR_EYE_TYPES.USER_ROLE_SET, a1, {
      subjectType: "user", subjectId: target.id, title: "t", reason: "reason", payload: { userId: target.id, role: "CA" },
    });
    await expect(db.update(approvalDecisions).set({ comment: "edited" })).rejects.toThrow();
    await expect(db.delete(approvalDecisions)).rejects.toThrow();
  });

  it("writes one audit row per refused permission check", async () => {
    const u = await createUser({ role: "SUPPORT_USER" });
    logDenied({ id: u.id, role: "SUPPORT_USER" }, PERMISSIONS.USER_SET_ROLE, "permission");
    await vi.waitFor(async () => {
      const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "authz.denied"), eq(auditLogs.actorId, u.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(PERMISSIONS.USER_SET_ROLE);
    });
  });
});

describe("role-scoped feature flags", () => {
  it("is off for every role until switched on, then limited by the role scope", async () => {
    const a1 = await admin();
    expect(await isFeatureEnabledForRole("rbac_v2_support", "SUPPORT_USER")).toBe(false);
    await db.insert(featureFlags).values({ key: "rbac_v2_support", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
    clearFeatureFlagCache();
    expect(await isFeatureEnabledForRole("rbac_v2_support", "SUPPORT_USER")).toBe(true);
    await setFeatureFlagRoleScope("rbac_v2_support", ["SUPPORT_MANAGER"], "Pilot with the manager first", a1);
    expect(await isFeatureEnabledForRole("rbac_v2_support", "SUPPORT_USER")).toBe(false);
    expect(await isFeatureEnabledForRole("rbac_v2_support", "SUPPORT_MANAGER")).toBe(true);
    expect(flagCoversRole({ enabled: false, roleScope: null }, "ADMIN")).toBe(false);
    await expect(setFeatureFlagRoleScope("rbac_v2_support", null, "reason", { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" })).rejects.toThrow(/Only an admin/);
    const changes = await db.select().from(featureFlagChanges).where(eq(featureFlagChanges.flagKey, "rbac_v2_support"));
    expect(changes).toHaveLength(1);
  });
});
