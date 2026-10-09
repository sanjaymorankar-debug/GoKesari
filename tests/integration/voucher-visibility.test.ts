/**
 * C4 — voucher codes: operators can see them (decision), as can admins.
 * Every other role is refused by the API. Characterises the current
 * behaviour so a later change cannot hide codes from operators, or show
 * them to anyone else, silently.
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

import { GET as listVouchersGet, POST as createVoucherPost } from "@/app/api/vouchers/route";
import { createVoucher } from "@/server/services/vouchers";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

const CODE = "DIWALI25";

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

async function as(role: UserRole) {
  const user = await createUser({ role });
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
  return user;
}

async function seedVoucher() {
  const admin = await createUser({ role: "ADMIN" });
  const today = new Date().toISOString().slice(0, 10);
  await createVoucher(
    { name: "Diwali bonus", code: CODE, bonusPercent: 10, startDate: today, endDate: today, maximumBonusPaise: null, usageLimit: null, totalBudgetPaise: null },
    { id: admin.id, role: "ADMIN" },
  );
}

describe("C4 — voucher code visibility", () => {
  for (const role of ["OPERATOR", "ADMIN"] as const) {
    it(`${role} sees the voucher code`, async () => {
      await seedVoucher();
      await as(role);
      const res = await call(listVouchersGet, "/api/vouchers");
      expect(res.status).toBe(200);
      expect(res.body.vouchers.map((v: { code: string }) => v.code)).toContain(CODE);
    });
  }

  for (const role of ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER", "SOCIETY_ADMIN"] as const) {
    it(`${role} is refused the voucher list (403) and never gets a code`, async () => {
      await seedVoucher();
      await as(role);
      const res = await call(listVouchersGet, "/api/vouchers");
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(CODE);
    });
  }

  it("signed out: 401, no code", async () => {
    await seedVoucher();
    const res = await call(listVouchersGet, "/api/vouchers");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(CODE);
  });

  it("an operator can see codes but still cannot create a voucher (admin only, unchanged)", async () => {
    await as("OPERATOR");
    const today = new Date().toISOString().slice(0, 10);
    const res = await call(createVoucherPost, "/api/vouchers", {
      method: "POST",
      body: { name: "Op voucher", code: "OPS1", bonusPercent: 5, startDate: today, endDate: today },
    });
    expect(res.status).toBe(403);
  });
});
