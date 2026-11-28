/**
 * Owner, 28-Nov-2026: "Remove turnover slab itself and create a button to switch it on or off by admin / operator
 * with four-eye principle for later enablement" and "fee should be flat 999 as default fee".
 *
 *   - by default the turnover slabs are off and a new shop pays the flat ₹999 + GST (migration 0230 sets the flat
 *     fee; re-running it adds nothing)
 *   - the On/Off switch is always four-eye: an admin or operator asks, a DIFFERENT admin or operator approves or
 *     rejects; the requester never approves their own request (not even the Super Admin alone)
 *   - the slabs editor (PUT /api/admin/settings) and a reset cannot flip `enabled`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));
vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

import { POST as decideRoute } from "@/app/api/approvals/[id]/decide/route";
import { DELETE as resetSettingRoute, PUT as putSettingRoute } from "@/app/api/admin/settings/route";
import { GET as switchStateRoute, POST as switchRoute } from "@/app/api/admin/turnover-fee-switch/route";
import { getEnv } from "@/lib/env";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { approvalRequests, auditLogs, featureFlags, platformSettings, registrationFees } from "@/server/db/schema";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { clearRuleCache, getRule } from "@/server/services/settings";
import { registerShop } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const CRORE = 1_00_00_000;
const withGst = (basePaise: number) => basePaise + Math.round((basePaise * 1800) / 10_000);
const MIGRATION = readFileSync(path.join(process.cwd(), "drizzle/0230_flat_registration_fee_999.sql"), "utf8");
let counter = 0;

type User = Awaited<ReturnType<typeof createUser>>;

function signIn(user: User) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

function shopInput(turnover: number | null) {
  counter += 1;
  return {
    name: `Switch Dairy ${counter}`,
    ownerName: "Ramesh Patil",
    phone: "9876543210",
    addressLine1: `${counter} FC Road`,
    city: "Pune",
    pincode: "411004",
    shopType: "DAIRY" as const,
    shopActNumber: `PII/KOTHRUD/II/${40000 + counter}`,
    annualTurnoverRupees: turnover,
  };
}

/** The code default, as on gokesari.com and test.gokesari.com (no saved override). */
async function codeDefault() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "registrationFeeByTurnover"));
  clearRuleCache();
}

async function slabsOn(): Promise<boolean> {
  clearRuleCache();
  return (await getRule("registrationFeeByTurnover")).enabled;
}

async function runMigration() {
  await db.execute(sql.raw(MIGRATION));
}

async function activeFees() {
  return db.select().from(registrationFees).where(eq(registrationFees.isActive, true));
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await codeDefault();
});

describe("flat ₹999 by default (migration 0230, slabs off)", () => {
  it("with no fee configured (production): ₹999 becomes the fee, once; a new shop pays ₹999 + GST whatever its turnover", async () => {
    expect(await activeFees()).toHaveLength(0);
    await runMigration();
    await runMigration();
    const rows = await db.select().from(registrationFees);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountPaise: 99_900, isActive: true, note: "Owner 28-Nov-2026: flat ₹999 default" });

    expect(await slabsOn()).toBe(false);
    for (const turnover of [null, 50 * CRORE]) {
      const shop = await registerShop(shopInput(turnover), { id: (await createUser()).id, role: "CUSTOMER" });
      expect(shop.registrationFeeBasePaise, `turnover ${turnover}`).toBe(99_900);
      expect(shop.registrationFeePaise).toBe(withGst(99_900));
      expect(shop.registrationFeeId).toBe(rows[0].id);
    }
  });

  it("with ₹100 in force (staging): keeps the ₹100 row as history and makes ₹999 the fee; re-running adds nothing", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRegistrationFee({ amountPaise: 10_000 }, { id: admin.id, role: "ADMIN" });
    await runMigration();
    await runMigration();
    const all = await db.select().from(registrationFees).orderBy(registrationFees.createdAt);
    expect(all.map((r) => [r.amountPaise, r.isActive])).toEqual([
      [10_000, false],
      [99_900, true],
    ]);
    const logged = await db.select().from(auditLogs).where(eq(auditLogs.action, "registration_fee.changed")).orderBy(desc(auditLogs.createdAt));
    expect(logged[0]).toMatchObject({ previousValue: { amountPaise: 10_000 }, newValue: expect.objectContaining({ amountPaise: 99_900 }) });
  });
});

describe("the On/Off switch is always four-eye (admin or operator)", () => {
  it("an operator asks → nothing changes; he cannot approve it himself; a different admin approves → slabs on, audited", async () => {
    await runMigration();
    const operator = await createUser({ role: "OPERATOR" });
    const admin = await createUser({ role: "ADMIN" });

    signIn(operator);
    const asked = await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true, reason: "Bigger shops pay more" } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ pendingApproval: true });
    expect(await slabsOn()).toBe(false);

    const view = await call(switchStateRoute, "/api/admin/turnover-fee-switch");
    expect(view.body).toMatchObject({ enabled: false, flatFeePaise: 99_900, pending: { approvalId: asked.body.approvalId, enabled: true, requestedBy: operator.id } });

    // A second request while one waits is refused.
    const again = await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true } });
    expect(again.status).toBe(409);

    const id = asked.body.approvalId as string;
    const self = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "APPROVE" } });
    expect(self.status).toBe(403);
    const selfReject = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "REJECT", comment: "no" } });
    expect(selfReject.status).toBe(403);
    expect(await slabsOn()).toBe(false);

    // Someone without the role cannot decide it.
    signIn(await createUser({ role: "CUSTOMER" }));
    const stranger = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "APPROVE" } });
    expect(stranger.status).toBe(403);

    signIn(admin);
    const approved = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "APPROVE", comment: "Agreed" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ applied: true, applyError: null, singleAdmin: false });
    expect(await slabsOn()).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "setting.changed"), eq(auditLogs.entityId, "registrationFeeByTurnover")))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit.previousValue).toMatchObject({ enabled: false });
    expect(audit.newValue).toMatchObject({ enabled: true });

    // New shops now pay by slab; the earlier flat-fee shops keep their fee.
    const shop = await registerShop(shopInput(3 * CRORE), { id: (await createUser()).id, role: "CUSTOMER" });
    expect(shop.registrationFeeBasePaise).toBe(4_99_900);
  });

  it("another operator may approve an admin's request; a rejection (with a comment) leaves the slabs off", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const operator = await createUser({ role: "OPERATOR" });
    signIn(admin);
    // Asking for what is already so is refused.
    expect((await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: false } })).status).toBe(422);
    const asked = await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true } });
    expect(asked.status).toBe(202);
    const id = asked.body.approvalId as string;

    signIn(operator);
    const noComment = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "REJECT" } });
    expect(noComment.status).toBe(422);
    const rejected = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "REJECT", comment: "Not this month" } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.request.status).toBe("REJECTED");
    expect(await slabsOn()).toBe(false);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row).toMatchObject({ status: "REJECTED", decidedBy: operator.id, appliedAt: null });
  });

  it("the Super Admin alone cannot approve their own request, and a customer cannot ask", async () => {
    const superAdmin = await createUser({ role: "ADMIN", email: getEnv().SUPER_ADMIN_EMAIL });
    signIn(superAdmin);
    const asked = await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true } });
    expect(asked.status).toBe(202);
    const id = asked.body.approvalId as string;
    const self = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "APPROVE" } });
    expect(self.status).toBe(403);
    expect(await slabsOn()).toBe(false);

    signIn(await createUser({ role: "CUSTOMER" }));
    expect((await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true } })).status).toBe(403);
  });
});

describe("the slabs editor cannot flip the switch", () => {
  const slabs = [
    { upToRupees: 2 * CRORE, feePaise: 1_49_900 },
    { upToRupees: null, feePaise: 5_99_900 },
  ];

  it("PUT /api/admin/settings saves the slabs and keeps enabled as it is", async () => {
    signIn(await createUser({ role: "ADMIN" }));
    const saved = await call(putSettingRoute, "/api/admin/settings", { method: "PUT", body: { key: "registrationFeeByTurnover", value: { enabled: true, slabs } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.value).toMatchObject({ enabled: false, slabs });
    clearRuleCache();
    expect(await getRule("registrationFeeByTurnover")).toMatchObject({ enabled: false, slabs });
  });

  it("with four-eye admin on, an approved RULE_SET keeps enabled too; a reset that would flip it is refused", async () => {
    await db.insert(featureFlags).values({ key: "rbac_v2_four_eye_admin", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
    clearFeatureFlagCache();
    const admin = await createUser({ role: "ADMIN" });
    const admin2 = await createUser({ role: "ADMIN" });
    signIn(admin);
    const put = await call(putSettingRoute, "/api/admin/settings", { method: "PUT", body: { key: "registrationFeeByTurnover", value: { enabled: true, slabs } } });
    expect(put.status).toBe(202);
    signIn(admin2);
    const id = put.body.approvalId as string;
    const approved = await call(decideRoute, `/api/approvals/${id}/decide`, { method: "POST", params: { id }, body: { decision: "APPROVE" } });
    expect(approved.body).toMatchObject({ applied: true });
    expect(await slabsOn()).toBe(false);

    // Switched on (four-eye), a reset to the defaults (off) is refused.
    signIn(admin);
    const asked = await call(switchRoute, "/api/admin/turnover-fee-switch", { method: "POST", body: { enabled: true } });
    signIn(admin2);
    await call(decideRoute, `/api/approvals/${asked.body.approvalId}/decide`, { method: "POST", params: { id: asked.body.approvalId }, body: { decision: "APPROVE" } });
    expect(await slabsOn()).toBe(true);
    await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "rbac_v2_four_eye_admin"));
    clearFeatureFlagCache();
    const reset = await call(resetSettingRoute, "/api/admin/settings?key=registrationFeeByTurnover", { method: "DELETE" });
    expect(reset.status).toBe(422);
    expect(await slabsOn()).toBe(true);
  });
});
