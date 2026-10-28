/**
 * Dealer programme, step 1 (docs/dealer-programme): feature flags, the
 * territory hierarchy and the DEALER role.
 *
 * Covers: every flag starts off (scenario 72 — with all flags off nothing new is
 * reachable); only an admin reads or changes flags (route and service); a
 * reason is required; district scoping (scenario 73 — on for Pune only leaves
 * other districts and unknown districts off); every change logged and audited;
 * PIN codes map to the most specific area; only an admin adds areas; the DEALER
 * role has the portal and nothing staff-only.
 */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as flagsGet, PUT as flagsPut } from "@/app/api/admin/feature-flags/route";
import { GET as geoGet, POST as geoPost } from "@/app/api/geo-areas/route";
import { can, PERMISSIONS, ROLE_LABELS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { auditLogs, featureFlagChanges, geoAreas } from "@/server/db/schema";
import {
  getFeatureFlags,
  isFeatureEnabled,
  requireFeature,
  setFeatureFlag,
} from "@/server/services/feature-flags";
import { areaForPincode, districtCodeForPincode, listDistricts, saveGeoArea } from "@/server/services/geo-areas";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", email: "", name: null as string | null, role: "ADMIN" as const };

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const TEST_AREA = "MH-PUN-PMC-ZZTEST";

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
});

afterAll(async () => {
  // geo_areas is seed data and not reset between tests: remove what this file added.
  await db.delete(geoAreas).where(like(geoAreas.code, `${TEST_AREA}%`));
});

describe("feature flags", () => {
  it("every flag starts off, and requireFeature says the feature is not available (404)", async () => {
    const flags = await getFeatureFlags();
    expect(Object.values(flags).map((f) => [f.key, f.enabled])).toEqual([
      ["dealer_programme_enabled", false],
      ["gov_verification_auto_approval_enabled", false],
      ["dealer_rating_bonus_enabled", false],
      ["paid_support_services_enabled", false],
      ["shop_onboarding_wizard_enabled", false],
    ]);
    await expect(requireFeature("dealer_programme_enabled")).rejects.toMatchObject({
      status: 404,
      details: { reason: "FEATURE_NOT_AVAILABLE", feature: "dealer_programme_enabled" },
    });
  });

  it("only an admin can read or change a flag — route and service", async () => {
    for (const role of ["OPERATOR", "OPERATOR_LIMITED", "DEALER", "SHOP_OWNER", "CUSTOMER"] as const) {
      const u = await createUser({ role });
      signIn(u, role);
      expect((await call(flagsGet, "/api/admin/feature-flags")).status, role).toBe(403);
      const put = await call(flagsPut, "/api/admin/feature-flags", {
        method: "PUT",
        body: { key: "dealer_programme_enabled", enabled: true, districtCodes: null, reason: "try it" },
      });
      expect(put.status, role).toBe(403);
      await expect(
        setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "try it", { id: u.id, role }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(await isFeatureEnabled("dealer_programme_enabled")).toBe(false);
  });

  it("an admin switches the dealer programme on for Pune only; other districts stay off; logged and audited", async () => {
    signIn(admin, "ADMIN");
    const res = await call(flagsPut, "/api/admin/feature-flags", {
      method: "PUT",
      body: { key: "dealer_programme_enabled", enabled: true, districtCodes: ["mh-pun"], reason: "Pune pilot starts" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ changed: true, flag: { key: "dealer_programme_enabled", enabled: true, districtCodes: ["MH-PUN"] } });
    expect(res.body.lastChange).toMatchObject({
      flagKey: "dealer_programme_enabled",
      oldValue: { enabled: false, districtCodes: null },
      newValue: { enabled: true, districtCodes: ["MH-PUN"] },
      reason: "Pune pilot starts",
      changedByEmail: admin.email,
      changedByRole: "ADMIN",
    });

    expect(await isFeatureEnabled("dealer_programme_enabled")).toBe(true);
    expect(await isFeatureEnabled("dealer_programme_enabled", { districtCode: "MH-PUN" })).toBe(true);
    expect(await isFeatureEnabled("dealer_programme_enabled", { districtCode: "MH-MUM" })).toBe(false);
    expect(await isFeatureEnabled("dealer_programme_enabled", { districtCode: null })).toBe(false);
    await expect(requireFeature("dealer_programme_enabled", { districtCode: "MH-NSK" })).rejects.toMatchObject({ status: 404 });
    // The other flags are untouched.
    expect(await isFeatureEnabled("paid_support_services_enabled")).toBe(false);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "feature_flag.changed"));
    expect(audit).toMatchObject({ actorId: admin.id, entityType: "feature_flag", entityId: "dealer_programme_enabled" });
    expect(audit.newValue).toMatchObject({ enabled: true, districtCodes: ["MH-PUN"], reason: "Pune pilot starts" });

    // Saving the same value again changes and logs nothing.
    const again = await call(flagsPut, "/api/admin/feature-flags", {
      method: "PUT",
      body: { key: "dealer_programme_enabled", enabled: true, districtCodes: ["MH-PUN"], reason: "same again" },
    });
    expect(again.body.changed).toBe(false);
    expect(await db.select().from(featureFlagChanges)).toHaveLength(1);

    // Every district.
    await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "statewide", admin);
    expect(await isFeatureEnabled("dealer_programme_enabled", { districtCode: "MH-MUM" })).toBe(true);
    // Off again: off everywhere.
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "pause the pilot", admin);
    expect(await isFeatureEnabled("dealer_programme_enabled", { districtCode: "MH-PUN" })).toBe(false);
  });

  it("refuses a change without a reason, with an unknown district, or with an empty district list", async () => {
    signIn(admin, "ADMIN");
    const put = (body: object) => call(flagsPut, "/api/admin/feature-flags", { method: "PUT", body: { key: "dealer_programme_enabled", enabled: true, ...body } });
    expect((await put({ districtCodes: null, reason: " " })).status).toBe(422);
    expect((await put({ districtCodes: ["MH-XYZ"], reason: "pilot" })).status).toBe(422);
    expect((await put({ districtCodes: [], reason: "pilot" })).status).toBe(422);
    expect(await isFeatureEnabled("dealer_programme_enabled")).toBe(false);
  });

  it("the admin GET lists every flag and the 36 Maharashtra districts", async () => {
    signIn(admin, "ADMIN");
    const res = await call(flagsGet, "/api/admin/feature-flags");
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(5);
    expect(res.body.districts.length).toBeGreaterThanOrEqual(36);
    expect(res.body.districts.map((d: { code: string }) => d.code)).toContain("MH-PUN");
  });
});

describe("territory areas", () => {
  it("seeds the state, 6 divisions and 36 districts with unique short codes", async () => {
    const districts = (await listDistricts()).filter((d) => !d.code.startsWith(TEST_AREA));
    expect(districts).toHaveLength(36);
    expect(new Set(districts.map((d) => d.shortCode)).size).toBe(36);
    expect(districts.find((d) => d.code === "MH-PUN")).toMatchObject({ name: "Pune", shortCode: "PUN", parentCode: "MH-R-PUN" });
  });

  it("a PIN code maps to the most specific area and its district", async () => {
    expect(await areaForPincode("411038")).toMatchObject({ area: { code: "MH-PUN-PMC-KOTHRUD", level: "LOCALITY" }, district: { code: "MH-PUN" } });
    expect(await areaForPincode("411999")).toMatchObject({ area: { code: "MH-PUN" }, district: { code: "MH-PUN" } });
    expect(await areaForPincode("400001")).toBeNull();
    expect(await areaForPincode("4110")).toBeNull();
    expect(await districtCodeForPincode("411057")).toBe("MH-PUN");
    expect(await districtCodeForPincode(null)).toBeNull();
  });

  it("the API answers a signed-in user, and only an admin adds an area", async () => {
    expect((await call(geoGet, "/api/geo-areas?pincode=411038")).status).toBe(401);
    const op = await createUser({ role: "OPERATOR" });
    signIn(op, "OPERATOR");
    const got = await call(geoGet, "/api/geo-areas?parent=MH-PUN");
    expect(got.status).toBe(200);
    expect(got.body.areas.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(["MH-PUN-PMC", "MH-PUN-PCMC", "MH-PUN-HVL"]));
    const body = { code: TEST_AREA, name: "Test locality", level: "LOCALITY", parentCode: "MH-PUN-PMC", pincodePrefixes: ["411099"] };
    expect((await call(geoPost, "/api/geo-areas", { method: "POST", body })).status).toBe(403);

    signIn(admin, "ADMIN");
    const saved = await call(geoPost, "/api/geo-areas", { method: "POST", body });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await areaForPincode("411099")).toMatchObject({ area: { code: TEST_AREA }, district: { code: "MH-PUN" } });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "geo_area.saved"));
    expect(audit).toMatchObject({ actorId: admin.id, entityId: TEST_AREA });
  });

  it("refuses the wrong level for the parent, and a district without a short code", async () => {
    await expect(
      saveGeoArea({ code: `${TEST_AREA}-X`, name: "Wrong", level: "DISTRICT", parentCode: "MH-PUN-PMC" }, admin),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      saveGeoArea({ code: `${TEST_AREA}-D`, name: "No short code", level: "DISTRICT", parentCode: "MH-R-PUN" }, admin),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("DEALER role", () => {
  it("has the dealer portal and personal shopping, and nothing staff-only", () => {
    expect(ROLE_LABELS.DEALER).toBe("Dealer");
    expect(can("DEALER", PERMISSIONS.DEALER_PORTAL)).toBe(true);
    expect(can("DEALER", PERMISSIONS.ORDER_PLACE)).toBe(true);
    for (const p of [
      PERMISSIONS.SHOP_APPROVE,
      PERMISSIONS.SHOP_UPDATE_ANY,
      PERMISSIONS.REFERRAL_MANAGE,
      PERMISSIONS.REGISTRATION_FEE_MANAGE,
      PERMISSIONS.SYSTEM_CONFIG,
      PERMISSIONS.PAYOUT_APPROVE,
      PERMISSIONS.AUDIT_LOG_VIEW,
      PERMISSIONS.ORDER_VIEW_ANY,
    ]) {
      expect(can("DEALER", p), p).toBe(false);
    }
    // No other role gets the dealer portal except ADMIN (which holds everything).
    for (const role of ["CUSTOMER", "SHOP_OWNER", "OPERATOR", "OPERATOR_LIMITED", "DELIVERY_PARTNER", "SOCIETY_ADMIN"] as const) {
      expect(can(role, PERMISSIONS.DEALER_PORTAL), role).toBe(false);
    }
  });
});
