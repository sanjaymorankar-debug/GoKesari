/**
 * Dealership & Franchise Platform phase 1 (owner brief 23-Nov-2026; docs/dealer-platform/), against real PostgreSQL:
 *   - the four seed schemes and their terms are valid; joining charges with GST (D3)
 *   - a new dealer starts on Free Dealership; GoKesari Direct has no scheme
 *   - published terms cannot change or be deleted; drafts can; only allowed status moves
 *   - scheme history cannot be deleted or rewritten
 *   - paying for a franchise zone moves the dealer to Territory Franchise; a refund moves him back to the
 *     version he had before, even after a newer Free version is published (existing terms protected, D8)
 *   - the dealer logo (CF-011 reuse): flag off → 404; on → upload / remove; flag limited to other districts → 404
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { DELETE as logoDelete, POST as logoPost } from "@/app/api/dealer/logo/route";
import { SHOP_LOGO_FLAG } from "@/lib/delta/shop-logo";
import { chargeTotals, describeCharge, schemeTermsSchema } from "@/lib/dealer-schemes";
import { FRANCHISE_AGREEMENT_VERSION } from "@/lib/franchise";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  dealers,
  dealerSchemeAssignments,
  dealerSchemes,
  dealerSchemeVersions,
  franchiseBookings,
  franchiseCampaigns,
  franchiseConfigVersions,
  franchiseZones,
} from "@/server/db/schema";
import { currentDealerScheme, dealerSchemeHistory, listSchemes } from "@/server/dealers/schemes";
import { directDealer } from "@/server/dealers/attribution";
import { acceptFranchiseAgreement, onFranchiseFeeCaptured, refundBooking, reserveZones } from "@/server/franchise/booking";
import { saveFranchiseConfig } from "@/server/franchise/config";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  // The state before 0179 (Free v1 offered, Business / Growth Partner drafts): these cases test phase 1.
  await resetSchemes(["FREE"], { freeVersion: 1 });
  await db.update(franchiseZones).set({ status: "AVAILABLE", statusReason: null, reservedForDealerId: null, reservedUntil: null, maxOwners: 2 });
  await db.delete(franchiseConfigVersions);
  await db.update(franchiseCampaigns).set({ closedAt: null, closedReason: null, ownersAtClose: null, areasAtClose: null });
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  await saveFranchiseConfig({ bookingOpen: true, allowProvisionalSale: true, promoFeePaise: null }, { reason: "open for the tests" }, admin);
});

async function newDealer(extra: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  const [d] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: `Dealer ${user.id.slice(0, 4)}`, contactName: "Ravi", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", ...extra })
    .returning();
  return { dealer: d, user, actor: { id: user.id, role: "DEALER" as const } };
}

async function payFor(bookingId: string) {
  const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  const intent = { id: b.paymentIntentId ?? randomUUID(), purpose: "FRANCHISE_FEE", referenceId: b.id, userId: null, amountPaise: Number(b.totalPaise), refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRef;
  const after: (() => Promise<void>)[] = [];
  await db.transaction((tx) => onFranchiseFeeCaptured(intent, tx, (task) => after.push(task)));
  for (const task of after) await task();
}

const versionOf = async (code: string, version: number) =>
  (await db.select({ v: dealerSchemeVersions }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, code), eq(dealerSchemeVersions.version, version))))[0].v;

describe("seed schemes", () => {
  it("has the four schemes with valid terms; Free and Franchise published, BP and GP drafts", async () => {
    const schemes = await listSchemes();
    expect(schemes.map((s) => [s.code, s.status])).toEqual([
      ["FREE", "PUBLISHED"],
      ["BUSINESS_PARTNER", "DRAFT"],
      ["GROWTH_PARTNER", "DRAFT"],
      ["TERRITORY_FRANCHISE", "PUBLISHED"],
    ]);
    for (const s of schemes) for (const v of s.versions) expect(schemeTermsSchema.safeParse(v.terms).success).toBe(true);
    const free = schemes[0];
    expect(free.current?.version).toBe(1);
    expect(free.current?.terms.calculation).toBe("LEGACY_DEALER");
    const brief = free.versions.find((v) => v.version === 2)!.terms;
    expect(brief.components.map((c) => [c.kind, c.rateBp, c.durationMonths])).toEqual([
      ["ONE_TIME", 2000, null],
      ["RECURRING", 500, 12],
    ]);
    expect(free.current?.termsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adds GST on top of the Business and Growth Partner fees (D3)", async () => {
    const bp = (await versionOf("BUSINESS_PARTNER", 1)).terms.charge;
    const gp = (await versionOf("GROWTH_PARTNER", 1)).terms.charge;
    expect(chargeTotals(bp)).toEqual({ basePaise: 1_100_000, gstPaise: 198_000, totalPaise: 1_298_000 });
    expect(chargeTotals(gp).totalPaise).toBe(2_478_000);
    expect(describeCharge(bp)).toBe("₹11,000 + 18% GST = ₹12,980");
    expect(chargeTotals({ kind: "ONE_TIME", amountPaise: 1_180_000, gstRateBp: 1800, gstMode: "INCLUSIVE", refundable: false })).toEqual({ basePaise: 1_000_000, gstPaise: 180_000, totalPaise: 1_180_000 });
  });

  it("refuses terms that do not add up", () => {
    const terms = structuredClone(schemeTermsSchema.parse({ ...baseTerms() }));
    expect(schemeTermsSchema.safeParse({ ...terms, components: [{ ...terms.components[0], rateBp: 6000 }, { ...terms.components[0], id: "b", rateBp: 6000 }] }).success).toBe(false);
    expect(schemeTermsSchema.safeParse({ ...terms, charge: { ...terms.charge, kind: "FREE", amountPaise: 500 } }).success).toBe(false);
    expect(schemeTermsSchema.safeParse({ ...terms, exclusivity: "EXCLUSIVE" }).success).toBe(false);
    expect(schemeTermsSchema.safeParse({ ...terms, components: [{ id: "t", label: "Team", kind: "TEAM_OVERRIDE", basis: "SHOP_REGISTRATION_FEE", rateBp: 400, frequency: "ONCE", shopScope: "TEAM", level: 1, durationMonths: null }] }).success).toBe(false);
  });
});

describe("assignments", () => {
  it("puts a new dealer on Free Dealership version 1; GoKesari Direct gets none", async () => {
    const { dealer } = await newDealer();
    const s = await currentDealerScheme(dealer.id);
    expect(s).toMatchObject({ schemeCode: "FREE", version: 1, source: "AUTO", status: "ACTIVE" });
    expect(s!.termsHash).toBe((await versionOf("FREE", 1)).termsHash);
    const direct = await directDealer();
    expect(await currentDealerScheme(direct.id)).toBeNull();
  });

  it("keeps published terms and history unchangeable", async () => {
    const v1 = await versionOf("FREE", 1);
    await expect(db.update(dealerSchemeVersions).set({ terms: { ...v1.terms, summary: "changed after publishing" } }).where(eq(dealerSchemeVersions.id, v1.id))).rejects.toThrow();
    await expect(db.delete(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, v1.id))).rejects.toThrow();
    await expect(db.update(dealerSchemeVersions).set({ status: "DRAFT" }).where(eq(dealerSchemeVersions.id, v1.id))).rejects.toThrow();
    // A draft may still be edited (its fingerprint follows) and deleted.
    const [draft] = await db.insert(dealerSchemeVersions).values({ schemeId: v1.schemeId, version: 3, status: "DRAFT", terms: v1.terms }).returning();
    expect(draft.termsHash).toBe(v1.termsHash);
    const [edited] = await db.update(dealerSchemeVersions).set({ terms: { ...v1.terms, summary: "Free dealership, edited while a draft." } }).where(eq(dealerSchemeVersions.id, draft.id)).returning();
    expect(edited.termsHash).not.toBe(v1.termsHash);
    await db.delete(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, draft.id));

    const { dealer } = await newDealer();
    const [a] = await db.select().from(dealerSchemeAssignments).where(eq(dealerSchemeAssignments.dealerId, dealer.id));
    await expect(db.delete(dealerSchemeAssignments).where(eq(dealerSchemeAssignments.id, a.id))).rejects.toThrow();
    await expect(db.update(dealerSchemeAssignments).set({ acceptedTerms: { ...a.acceptedTerms, summary: "rewritten" } }).where(eq(dealerSchemeAssignments.id, a.id))).rejects.toThrow();
    await db.update(dealerSchemeAssignments).set({ status: "ENDED", endsAt: new Date(), endReason: "test" }).where(eq(dealerSchemeAssignments.id, a.id));
    await expect(db.update(dealerSchemeAssignments).set({ endReason: "again" }).where(eq(dealerSchemeAssignments.id, a.id))).rejects.toThrow();
  });

  it("moves a dealer to the franchise when he pays, and back to his own Free version on refund (D8)", async () => {
    const owner = await newDealer();
    await acceptFranchiseAgreement(owner.actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: "127.0.0.1", userAgent: "vitest" });
    const r = await reserveZones(owner.actor, { zoneIds: ["GKZ-PUN-07"] });
    expect((await currentDealerScheme(owner.dealer.id))?.schemeCode).toBe("FREE"); // reserved, not paid
    await payFor(r.booking.id);
    expect(await currentDealerScheme(owner.dealer.id)).toMatchObject({ schemeCode: "TERRITORY_FRANCHISE", version: 1, source: "FRANCHISE_BOOKING" });

    // GoKesari publishes the brief's Free terms (version 2): new dealers get them, this dealer keeps version 1.
    const v1 = await versionOf("FREE", 1);
    const [v2] = await db.select().from(dealerSchemeVersions).where(and(eq(dealerSchemeVersions.schemeId, v1.schemeId), eq(dealerSchemeVersions.version, 2)));
    await db.update(dealerSchemeVersions).set({ status: "SUPERSEDED" }).where(eq(dealerSchemeVersions.id, v1.id));
    await db.update(dealerSchemeVersions).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(dealerSchemeVersions.id, v2.id));
    const later = await newDealer();
    expect((await currentDealerScheme(later.dealer.id))?.version).toBe(2);

    await refundBooking(r.booking.id, "changed his mind", admin);
    const history = await dealerSchemeHistory(owner.dealer.id);
    expect(history.map((h) => [h.schemeCode, h.version, h.status, h.source])).toEqual([
      ["FREE", 1, "ACTIVE", "FRANCHISE_ENDED"],
      ["TERRITORY_FRANCHISE", 1, "SUPERSEDED", "FRANCHISE_BOOKING"],
      ["FREE", 1, "SUPERSEDED", "AUTO"],
    ]);
    expect(history[0].endsAt).toBeNull();
    expect(history[1].endReason).toMatch(/franchise ended: zone GKZ-PUN-07 cancelled/);
  });
});

describe("dealer logo (CF-011 reuse)", () => {
  let jpeg: Buffer;
  const signIn = (u: { id: string; email: string; name: string | null }, role: UserRole) => {
    state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role, status: "ACTIVE" } };
  };
  const upload = () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "logo.jpg");
    return logoPost(new Request("http://x/api/dealer/logo", { method: "POST", body: form }) as unknown as NextRequest);
  };

  beforeEach(async () => {
    jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 230, g: 120, b: 20 } } }).jpeg().toBuffer();
  });

  it("is off without the flag, works with it, and follows a district-limited flag", async () => {
    const { dealer, user } = await newDealer({ pincode: "411004" });
    signIn(user, "DEALER");
    expect((await upload()).status).toBe(404);

    await setFeatureFlag(SHOP_LOGO_FLAG, { enabled: true, districtCodes: null }, "on (test)", admin);
    const res = await upload();
    expect(res.status).toBe(201);
    const { logoUrl } = await res.json();
    expect(logoUrl).toMatch(/^\/api\/images\//);
    expect((await db.select().from(dealers).where(eq(dealers.id, dealer.id)))[0].logoUrl).toBe(logoUrl);

    // On only for another state's districts: this Pune dealer does not get it.
    await setFeatureFlag(SHOP_LOGO_FLAG, { enabled: true, districtCodes: ["KA"] }, "Karnataka only (test)", admin);
    expect((await upload()).status).toBe(404);
    await setFeatureFlag(SHOP_LOGO_FLAG, { enabled: true, districtCodes: null }, "on (test)", admin);

    expect((await logoDelete()).status).toBe(200);
    expect((await db.select().from(dealers).where(eq(dealers.id, dealer.id)))[0].logoUrl).toBeNull();
  });

  it("refuses someone who is not a dealer", async () => {
    await setFeatureFlag(SHOP_LOGO_FLAG, { enabled: true, districtCodes: null }, "on (test)", admin);
    const customer = await createUser({ role: "CUSTOMER" });
    signIn(customer, "CUSTOMER");
    expect((await upload()).status).toBe(403);
  });
});

function baseTerms() {
  return {
    summary: "A test scheme with a one-time commission.",
    calculation: "SCHEME",
    charge: { kind: "ONE_TIME", amountPaise: 100_000, gstRateBp: 1800, gstMode: "EXCLUSIVE", refundable: false },
    validityMonths: 12,
    renewal: { allowed: true, chargePaise: 0, windowDays: 30 },
    geography: { scope: "ALL_INDIA", codes: [] },
    exclusivity: "NONE",
    maxDealersPerTerritory: null,
    territoryBooking: false,
    teamBuilding: false,
    commissionBudgetBp: null,
    components: [{ id: "a", label: "One-time", kind: "ONE_TIME", basis: "SHOP_REGISTRATION_FEE", rateBp: 2000, frequency: "ONCE", shopScope: "OWN", durationMonths: null }],
    benefits: [],
    eligibility: [],
    paymentConditions: [],
  };
}
