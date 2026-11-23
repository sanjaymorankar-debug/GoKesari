/**
 * Dealership & Franchise Platform phase 4 (docs/dealer-platform/PHASE_4_BUILDER.md), against real PostgreSQL:
 *   - create a scheme (blank) and clone one; codes are unique; a reason is required; non-admins are refused
 *   - drafts are edited; saving over a published version starts the next draft; invalid terms are refused
 *   - publish: the old version is superseded, dealers on it keep it, new applicants get the new one
 *   - scheduled launch: the job publishes it when due, not before
 *   - suspend hides a scheme from applicants; Free cannot be archived; archived cannot be edited
 *   - compare lists field differences; the simulator separates GMV, revenue, payout and net
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { simulateScheme } from "@/lib/dealer-scheme-math";
import { schemeTermsSchema } from "@/lib/dealer-schemes";
import { db } from "@/server/db";
import { dealers, dealerSchemes, dealerSchemeVersions } from "@/server/db/schema";
import { blankTerms, compareVersions, createScheme, publishVersion, runScheduledSchemeLaunches, saveDraft, setSchemeStatus } from "@/server/dealers/scheme-admin";
import { offeredSchemes } from "@/server/dealers/scheme-registration";
import { currentDealerScheme } from "@/server/dealers/schemes";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  await resetSchemes();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

const R = "owner brief 23-Nov (test)";

async function newDealer() {
  const u = await createUser({ role: "DEALER" });
  const [d] = await db.insert(dealers).values({ userId: u.id, legalName: "D", contactName: "D", dealerType: "INDIVIDUAL", status: "APPROVED" }).returning();
  return d;
}

describe("scheme builder (phase 4)", () => {
  it("creates, edits, publishes; dealers on the old version keep it", async () => {
    const { scheme, version } = await createScheme(admin, { code: "silver partner", name: "Silver Partner", category: "DEALERSHIP", reason: R });
    expect(scheme).toMatchObject({ code: "SILVER_PARTNER", status: "DRAFT" });
    expect(version).toMatchObject({ version: 1, status: "DRAFT" });
    await expect(createScheme(admin, { code: "SILVER_PARTNER", name: "Again", category: "DEALERSHIP", reason: R })).rejects.toThrow(/already exists/);
    await expect(createScheme(admin, { code: "GOLD", name: "Gold", category: "DEALERSHIP", reason: "x" })).rejects.toThrow(/reason/);
    await expect(createScheme({ id: admin.id, role: "CUSTOMER" }, { code: "GOLD", name: "Gold", category: "DEALERSHIP", reason: R })).rejects.toThrow();

    const terms = { ...blankTerms("DEALERSHIP"), summary: "Silver: ₹5,000 + GST, 22% one-time.", charge: { kind: "ONE_TIME" as const, amountPaise: 500_000, gstRateBp: 1800, gstMode: "EXCLUSIVE" as const, refundable: false } };
    terms.components = [{ ...terms.components[0], rateBp: 2200 }];
    const edited = await saveDraft(admin, scheme.id, { versionId: version.id, terms, reason: R });
    expect(edited.id).toBe(version.id);
    await expect(saveDraft(admin, scheme.id, { versionId: version.id, terms: { ...terms, components: [{ ...terms.components[0], rateBp: 12_000 }] }, reason: R })).rejects.toThrow(/not complete/);
    await expect(saveDraft(admin, scheme.id, { terms, reason: R })).rejects.toThrow(/already a draft/);

    await publishVersion(admin, version.id, { reason: R });
    expect((await offeredSchemes()).map((o) => o.code)).toContain("SILVER_PARTNER");

    // A dealer goes on v1; v2 is published; he keeps v1, a new applicant is offered v2.
    const d = await newDealer();
    const { assignSchemeVersion } = await import("@/server/dealers/scheme-registration");
    await db.transaction((tx) => assignSchemeVersion(d.id, version.id, "ADMIN", "test", admin.id, tx));
    const v2 = await saveDraft(admin, scheme.id, { versionId: version.id, terms: { ...terms, components: [{ ...terms.components[0], rateBp: 2400 }] }, label: "Silver v2", reason: R });
    expect(v2.version).toBe(2);
    await publishVersion(admin, v2.id, { reason: R });
    const [v1] = await db.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, version.id));
    expect(v1.status).toBe("SUPERSEDED");
    expect((await currentDealerScheme(d.id))?.version).toBe(1);
    expect((await offeredSchemes()).find((o) => o.code === "SILVER_PARTNER")?.version).toBe(2);

    const diff = await compareVersions(version.id, v2.id);
    expect(diff.differences).toEqual([{ path: "components[registration].rateBp", from: 2200, to: 2400 }]);
  });

  it("clones a scheme and schedules its launch", async () => {
    const [gp1] = await db.select({ id: dealerSchemeVersions.id, terms: dealerSchemeVersions.terms }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, "GROWTH_PARTNER"), eq(dealerSchemeVersions.version, 1)));
    const { scheme, version } = await createScheme(admin, { code: "GROWTH_PLUS", name: "Growth Plus", category: "DEALERSHIP", cloneFromVersionId: gp1.id, reason: R });
    expect(version.terms).toEqual(schemeTermsSchema.parse(gp1.terms));
    const at = new Date(Date.now() + 2 * 3_600_000);
    await publishVersion(admin, version.id, { effectiveFrom: at, reason: R });
    expect((await db.select().from(dealerSchemes).where(eq(dealerSchemes.id, scheme.id)))[0].status).toBe("SCHEDULED");
    expect((await runScheduledSchemeLaunches(new Date())).published).toBe(0);
    expect((await offeredSchemes()).map((o) => o.code)).not.toContain("GROWTH_PLUS");
    expect((await runScheduledSchemeLaunches(new Date(at.getTime() + 1000))).published).toBe(1);
    expect((await db.select().from(dealerSchemes).where(eq(dealerSchemes.id, scheme.id)))[0].status).toBe("PUBLISHED");
  });

  it("suspends, reopens, guards Free and archived schemes", async () => {
    const [bp] = await db.select().from(dealerSchemes).where(eq(dealerSchemes.code, "BUSINESS_PARTNER"));
    await setSchemeStatus(admin, bp.id, "SUSPENDED", R);
    expect((await offeredSchemes()).map((o) => o.code)).not.toContain("BUSINESS_PARTNER");
    await setSchemeStatus(admin, bp.id, "PUBLISHED", R);
    expect((await offeredSchemes()).map((o) => o.code)).toContain("BUSINESS_PARTNER");
    const [free] = await db.select().from(dealerSchemes).where(eq(dealerSchemes.code, "FREE"));
    await expect(setSchemeStatus(admin, free.id, "EXPIRED", R)).rejects.toThrow(/default/);
    await setSchemeStatus(admin, bp.id, "SUSPENDED", R);
    await setSchemeStatus(admin, bp.id, "ARCHIVED", R);
    await expect(saveDraft(admin, bp.id, { terms: blankTerms("DEALERSHIP"), reason: R })).rejects.toThrow(/archived/);
  });

  it("simulates GMV, revenue, payout and net separately", async () => {
    const [free2] = await db.select({ t: dealerSchemeVersions.terms }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, "FREE"), eq(dealerSchemeVersions.version, 2)));
    const r = simulateScheme(schemeTermsSchema.parse(free2.t), { dealers: 1, shopsPerDealerPerMonth: 1, activationBp: 10_000, avgRegistrationFeePaise: 100_000, monthlySalesPerShopPaise: 1_000_000, platformCommissionBp: 200, months: 2 });
    // 2 shops over 2 months; month 1: 1 shop, month 2: 2 shops → GMV ₹30,000; commission 2% = ₹600.
    expect(r.totals.gmvPaise).toBe(3_000_000);
    expect(r.totals.platformCommissionPaise).toBe(60_000);
    expect(r.totals.registrationFeesPaise).toBe(200_000);
    expect(r.totals.oneTimePayoutPaise).toBe(40_000); // 20% × ₹1,000 × 2
    expect(r.totals.recurringPayoutPaise).toBe(3_000); // 5% of ₹600
    expect(r.totals.netRevenuePaise).toBe(260_000 - 43_000);
  });
});
