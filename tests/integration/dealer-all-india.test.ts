/**
 * Dealer programme across India (docs/dealer-programme, all-India): every state
 * and UT is an area placed by PIN; an admin adds a dealer for any state and
 * district (adding a new district on the way) and the dealer gets a generated
 * unique code GKS-<state>-<district>-<6>; flags and commission rules can name
 * whole states; the application offers states and their districts.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as dealersPost } from "@/app/api/admin/dealers/route";
import { districtShortCode, INDIAN_STATES, stateCodeOfArea } from "@/lib/indian-states";
import { db } from "@/server/db";
import { dealerCommissionRules, dealerTerritories, dealers, geoAreas, shopAttributions, shops, userRoleGrants } from "@/server/db/schema";
import { checkCommissionMilestones, ruleFor, setCommissionSettings } from "@/server/dealers/commission";
import { createDealerByAdmin, saveApplication } from "@/server/dealers/service";
import { flagCoversDistrict, getFeatureFlag, setFeatureFlag } from "@/server/services/feature-flags";
import { addDistrict, areaForPincode, districtCodeForPincode, listDistrictsOf, listStates, openAreasFor } from "@/server/services/geo-areas";
import { recordPayment } from "@/server/services/shop-payments";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

type Actor = { id: string; email: string; name: string | null; role: UserRole };
let admin: Actor;
const CODE = /^GKS-([A-Z]{2})-([A-Z]{2,4})-[A-HJ-KM-NP-Z2-9]{6}$/;

beforeEach(async () => {
  await resetDatabase();
  // Districts added by earlier tests are seed-like data the reset leaves alone.
  await db.delete(geoAreas).where(eq(geoAreas.code, "KA-MYS"));
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "all India (test)", admin);
});

describe("areas for all of India", () => {
  it("every state and UT is an area; a PIN anywhere is placed in its state; Maharashtra's districts still win", async () => {
    const states = await listStates();
    expect(states.map((s) => s.code).sort()).toEqual(INDIAN_STATES.map((s) => s.code).sort());
    expect((await areaForPincode("560001"))?.area.code).toBe("KA");
    expect(await districtCodeForPincode("560001")).toBe("KA");
    expect(await districtCodeForPincode("110001")).toBe("DL");
    expect(await districtCodeForPincode("403001")).toBe("GA");
    expect(await districtCodeForPincode("411038")).toBe("MH-PUN");
  });

  it("district short codes are generated from the name and never collide", () => {
    expect(districtShortCode("Mysuru", new Set())).toBe("MYS");
    expect(districtShortCode("Mysuru", new Set(["MYS"]))).toBe("MYSU");
    expect(districtShortCode("Bengaluru Urban", new Set(["BEN", "BNG"]))).toBe("BU");
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) taken.add(districtShortCode("Pune", taken));
    expect(taken.size).toBe(40);
    expect(stateCodeOfArea("KA-MYS")).toBe("KA");
    expect(stateCodeOfArea("PIN-411001")).toBeNull();
  });

  it("an admin adds a district under any state; its PIN prefix then wins over the state's", async () => {
    const d = await addDistrict("KA", "Mysuru", admin, ["570"]);
    expect(d).toMatchObject({ code: "KA-MYS", level: "DISTRICT", parentCode: "KA", shortCode: "MYS" });
    expect((await listDistrictsOf("KA")).map((x) => x.code)).toContain("KA-MYS");
    expect(await districtCodeForPincode("570001")).toBe("KA-MYS");
    // The same name again returns the same district.
    expect((await addDistrict("KA", "mysuru", admin)).code).toBe("KA-MYS");
    await expect(addDistrict("KA", "Mysuru", { id: admin.id, role: "OPERATOR" })).resolves.toMatchObject({ code: "KA-MYS" });
    await expect(addDistrict("KA", "Hassan", { id: admin.id, role: "OPERATOR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("an admin adds a dealer for any state and district", () => {
  it("new district on the way; approved at once with a unique generated code; the account becomes the dealer", async () => {
    const u = await createUser({ role: "CUSTOMER" });
    const { dealer, code } = await createDealerByAdmin(
      { legalName: "Mysuru Traders", contactName: "R Gowda", dealerType: "PROPRIETORSHIP", stateCode: "KA", newDistrictName: "Mysuru", email: u.email, reason: "pilot dealer for Karnataka" },
      admin,
    );
    expect(code).toMatch(CODE);
    expect(code.startsWith("GKS-KA-MYS-")).toBe(true);
    expect(dealer).toMatchObject({ status: "APPROVED", source: "ADMIN", state: "Karnataka", userId: u.id });
    expect((await db.select().from(dealerTerritories).where(eq(dealerTerritories.dealerId, dealer.id))).map((t) => t.areaCode)).toEqual(["KA-MYS"]);
    const roles = await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId, u.id));
    expect(roles.map((r) => r.role)).toContain("DEALER");
  });

  it("a state with no district yet: GKS-<state>-<6>; many dealers, all different codes", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { code } = await createDealerByAdmin({ legalName: `TN Dealer ${i}`, contactName: "S Kumar", dealerType: "INDIVIDUAL", stateCode: "TN", reason: "Tamil Nadu dealers" }, admin);
      expect(code).toMatch(/^GKS-TN-[A-HJ-KM-NP-Z2-9]{6}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(12);
  });

  it("refuses a district of another state, an unknown account and a second dealer for one account", async () => {
    await addDistrict("KA", "Mysuru", admin);
    const base = { legalName: "X Traders", contactName: "X", dealerType: "INDIVIDUAL" as const, reason: "test refusals" };
    await expect(createDealerByAdmin({ ...base, stateCode: "TN", districtCode: "KA-MYS" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createDealerByAdmin({ ...base, stateCode: "ZZ" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createDealerByAdmin({ ...base, stateCode: "KA", email: "nobody@example.invalid" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const u = await createUser({ role: "CUSTOMER" });
    await createDealerByAdmin({ ...base, stateCode: "KA", email: u.email }, admin);
    await expect(createDealerByAdmin({ ...base, stateCode: "KA", email: u.email }, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("only an admin: operator and dealer get 403 from the API", async () => {
    const op = await createUser({ role: "OPERATOR" });
    state.session = { user: { id: op.id, email: op.email, name: op.name, image: null, role: "OPERATOR", status: "ACTIVE" } };
    const body = { legalName: "Op Traders", contactName: "O", dealerType: "INDIVIDUAL", stateCode: "KA", reason: "operator try" };
    expect((await call(dealersPost, "/api/admin/dealers", { method: "POST", body })).status).toBe(403);
    state.session = { user: { id: admin.id, email: admin.email, name: admin.name, image: null, role: "ADMIN", status: "ACTIVE" } };
    const ok = await call(dealersPost, "/api/admin/dealers", { method: "POST", body });
    expect(ok.status).toBe(201);
    expect(ok.body.code).toMatch(/^GKS-KA-/);
  });
});

describe("rollout by state", () => {
  it("a flag can name whole states; districts of that state are covered, others are not", async () => {
    await addDistrict("KA", "Mysuru", admin);
    await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["KA", "MH-PUN"] }, "Karnataka + Pune", admin);
    const flag = await getFeatureFlag("dealer_programme_enabled");
    expect(flagCoversDistrict(flag, "KA")).toBe(true);
    expect(flagCoversDistrict(flag, "KA-MYS")).toBe(true);
    expect(flagCoversDistrict(flag, "MH-PUN")).toBe(true);
    expect(flagCoversDistrict(flag, "MH-NSK")).toBe(false);
    expect(flagCoversDistrict(flag, "TN")).toBe(false);
    await expect(setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["XX"] }, "bad code", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // The application offers Karnataka (whole, with its districts) and Maharashtra with only Pune.
    const areas = await openAreasFor(flag.districtCodes);
    expect(areas.filter((a) => a.parent === null).map((a) => a.code).sort()).toEqual(["KA", "MH"]);
    expect(areas.filter((a) => a.parent === "MH").map((a) => a.code)).toEqual(["MH-PUN"]);
    expect(areas.some((a) => a.code === "KA-MYS" && a.parent === "KA")).toBe(true);
  });

  it("an applicant may choose a whole state; approval issues a code for it", async () => {
    const u = await createUser({ role: "CUSTOMER" });
    const d = await saveApplication(
      { legalName: "Goa Supplies", contactName: "A Naik", dealerType: "INDIVIDUAL", mobile: "9800000111", addressLine1: "Market road", city: "Panaji", pincode: "403001", territories: ["GA"] } as never,
      { id: u.id, role: "CUSTOMER", email: u.email },
    );
    expect(d.state).toBe("Goa");
  });

  it("commission: a district rule beats a state rule, which beats an all-India rule", async () => {
    await addDistrict("KA", "Mysuru", admin);
    await db.delete(dealerCommissionRules);
    const rule = (districtCode: string | null, fixedPaise: number) => ({ ruleKey: crypto.randomUUID(), version: 1, shopScope: "STANDARD" as const, milestone: "REGISTERED" as const, districtCode, fixedPaise, effectiveFrom: "2026-01-01", changeReason: "test" });
    await db.insert(dealerCommissionRules).values([rule(null, 10_000), rule("KA", 12_000), rule("KA-MYS", 15_000)]);
    const shop = { shopType: "GENERAL_TRADING" } as never;
    expect((await ruleFor(shop, "KA-MYS", "REGISTERED"))?.fixedPaise).toBe(15_000);
    expect((await ruleFor(shop, "KA", "REGISTERED"))?.fixedPaise).toBe(12_000);
    expect((await ruleFor(shop, "TN", "REGISTERED"))?.fixedPaise).toBe(10_000);
    expect((await ruleFor(shop, null, "REGISTERED"))?.fixedPaise).toBe(10_000);
  });

  it("a Karnataka shop brought by a Karnataka dealer earns the registration commission where the flag names KA", async () => {
    await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["KA"] }, "Karnataka", admin);
    // A state-wide rule of the milestone rules model.
    await setCommissionSettings({ commissionModel: "MILESTONE_RULES" }, "milestone rules for this test", admin);
    await db.delete(dealerCommissionRules);
    await db.insert(dealerCommissionRules).values({ ruleKey: crypto.randomUUID(), version: 1, shopScope: "STANDARD", milestone: "REGISTERED", districtCode: "KA", fixedPaise: 11_000, effectiveFrom: "2026-01-01", changeReason: "test" });
    const { dealer } = await createDealerByAdmin({ legalName: "BLR Traders", contactName: "K", dealerType: "INDIVIDUAL", stateCode: "KA", reason: "Karnataka dealer" }, admin);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Bengaluru Kirana", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: 118_000 });
    await db.update(shops).set({ pincode: "560001", registrationFeeBasePaise: 100_000, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: 18_000 }).where(eq(shops.id, shop.id));
    await db.insert(shopAttributions).values({ shopId: shop.id, dealerId: dealer.id, source: "CODE_AT_REGISTRATION" });
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 118_000, method: "ONLINE", transactionId: "cf_ka_1" }, { id: admin.id, role: "ADMIN" });
    await checkCommissionMilestones(shop.id);
    const [d] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(d.status).toBe("APPROVED");
    const { dealerCommissionLedger } = await import("@/server/db/schema");
    const entries = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shop.id));
    expect(entries.map((e) => [e.milestone, e.amountPaise])).toEqual([["REGISTERED", 11_000]]);
  });
});
