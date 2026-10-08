/**
 * C2 — only a society Gokesari has verified may add riders (and mark them
 * preferred), and only approved riders can be added. Enforced at the server:
 * the route and the service refuse it for every caller, platform staff too.
 * Rule societyRiders.requireVerifiedSociety (default on); off = the original
 * behaviour.
 */
import { eq } from "drizzle-orm";
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

import { POST as addRiderPost } from "@/app/api/societies/[id]/riders/route";
import { db } from "@/server/db";
import { deliveryPartners, platformSettings, societyRiders } from "@/server/db/schema";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { addSocietyRider, decideSociety, registerSociety, updateSocietyRider } from "@/server/services/societies";
import { call } from "../helpers/http";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

const actor = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });
function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function clearRule() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "societyRiders"));
  clearRuleCache();
}
beforeEach(async () => {
  await resetDatabase();
  await clearRule();
  state.session = null;
});
afterEach(clearRule);

const RIDER_MOBILE = "9876543210";

async function setup(status: "APPLIED" | "VERIFIED" | "REJECTED" | "SUSPENDED") {
  const founder = await createUser({ role: "CUSTOMER" });
  const operator = await createUser({ role: "OPERATOR" });
  const society = await registerSociety(
    { name: "Green Meadows", addressLine1: "Plot 7, Baner Road", area: "Baner", city: "Pune", pincode: "411045", latitude: 18.559, longitude: 73.786 },
    actor(founder),
  );
  if (status !== "APPLIED") await decideSociety(society.id, "verify", actor(operator));
  if (status === "REJECTED") {
    // Only an APPLIED society can be rejected; build a fresh one for this case.
    const other = await registerSociety(
      { name: "Blue Hills", addressLine1: "Plot 9", city: "Pune", pincode: "411045" },
      actor(founder),
    );
    await decideSociety(other.id, "reject", actor(operator), "Not a real society");
    return { society: other, founder, operator };
  }
  if (status === "SUSPENDED") await decideSociety(society.id, "suspend", actor(operator), "Under review");
  return { society, founder, operator };
}

async function approvedRider(status: "APPROVED" | "UNDER_REVIEW" | "SUSPENDED" = "APPROVED") {
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  return createDeliveryPartner(riderUser.id, { status });
}

const founderActor = (u: { id: string }) => ({ id: u.id, role: "SOCIETY_ADMIN" as const });

describe("C2 — society rider list", () => {
  it("a verified society's admin can add an approved rider", async () => {
    const { society, founder } = await setup("VERIFIED");
    const rider = await approvedRider();
    const link = await addSocietyRider(society.id, RIDER_MOBILE, false, founderActor(founder));
    expect(link.deliveryPartnerId).toBe(rider.id);
    expect(link.status).toBe("ACTIVE");
  });

  for (const status of ["APPLIED", "REJECTED", "SUSPENDED"] as const) {
    it(`a ${status} society cannot add a rider — refused by the API (403), nothing written`, async () => {
      const { society, founder } = await setup(status);
      await approvedRider();
      signIn({ ...founder, role: "SOCIETY_ADMIN" });
      const res = await call(addRiderPost, `/api/societies/${society.id}/riders`, {
        method: "POST",
        body: { mobile: RIDER_MOBILE, preferred: true },
        params: { id: society.id },
      });
      expect(res.status).toBe(403);
      expect(await db.select().from(societyRiders)).toHaveLength(0);
    });
  }

  it("platform staff cannot add a rider to an unverified society either", async () => {
    const { society, operator } = await setup("APPLIED");
    await approvedRider();
    await expect(addSocietyRider(society.id, RIDER_MOBILE, false, actor(operator))).rejects.toThrow(/verified this society/);
  });

  it("only approved riders can be added (under review / suspended riders are not found)", async () => {
    const { society, founder } = await setup("VERIFIED");
    await approvedRider("UNDER_REVIEW");
    await expect(addSocietyRider(society.id, RIDER_MOBILE, false, founderActor(founder))).rejects.toThrow(/Approved delivery partner/);
    await db.update(deliveryPartners).set({ status: "SUSPENDED" });
    await expect(addSocietyRider(society.id, RIDER_MOBILE, false, founderActor(founder))).rejects.toThrow(/Approved delivery partner/);
  });

  it("after suspension: the society can still revoke a rider, but not mark one preferred", async () => {
    const { society, founder, operator } = await setup("VERIFIED");
    await approvedRider();
    const link = await addSocietyRider(society.id, RIDER_MOBILE, false, founderActor(founder));
    await decideSociety(society.id, "suspend", actor(operator), "Under review");
    await expect(updateSocietyRider(link.id, { preferred: true }, founderActor(founder))).rejects.toThrow(/verified this society/);
    const revoked = await updateSocietyRider(link.id, { revoke: true }, founderActor(founder));
    expect(revoked.status).toBe("REVOKED");
  });

  it("rule off: the original behaviour (an unverified society may add an approved rider)", async () => {
    const { society, founder } = await setup("APPLIED");
    const admin = await createUser({ role: "ADMIN" });
    await setRule("societyRiders", { requireVerifiedSociety: false }, actor(admin));
    await approvedRider();
    const link = await addSocietyRider(society.id, RIDER_MOBILE, false, founderActor(founder));
    expect(link.status).toBe("ACTIVE");
  });
});
