/**
 * Dealership & Franchise Platform phase 6 (docs/dealer-platform/PHASE_6_ROLES_DASHBOARDS.md), against real PostgreSQL:
 *   - roles: a Dealership Manager drafts but cannot publish; a Finance Admin closes the month but cannot touch
 *     schemes; a Read-only user changes nothing; a Regional Admin decides only dealers in his regions
 *   - maker-checker (dealer_platform_four_eye on): publishing becomes a request; the requester cannot approve it; a
 *     second admin approves and it is applied
 *   - scheme change: a free dealer accepts Business Partner and pays → upgraded (UPGRADE); staff can move a dealer
 *     only to a version he accepted
 *   - the dashboard counts dealers by scheme, shops, commission and liability for the selected dealers
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { approvalRequests, dealerCommissionLedger, dealerCommissionMonths, dealerJoiningPayments, dealers, dealerSchemes, dealerSchemeVersions } from "@/server/db/schema";
import { decideApproval, requestDealerApproval } from "@/server/approvals";
import { closeCommissionMonth } from "@/server/dealers/monthly-payout";
import { platformDashboard } from "@/server/dealers/platform-dashboard";
import { blankTerms, createScheme, publishVersion, saveDraft, setSchemeStatus } from "@/server/dealers/scheme-admin";
import { changeDealerScheme, requestSchemeChange } from "@/server/dealers/scheme-change";
import { onJoiningFeeCaptured } from "@/server/dealers/scheme-registration";
import { currentDealerScheme } from "@/server/dealers/schemes";
import { decideDealer } from "@/server/dealers/service";
import { setRegionScope } from "@/server/dealers/staff-access";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

const R = "phase 6 test reason";
let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await db.execute(sql`TRUNCATE TABLE payment_intents CASCADE`);
  await resetSchemes();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
});

const staff = async (role: "BUSINESS_ADMIN" | "DEALERSHIP_MANAGER" | "FINANCE_ADMIN" | "REGIONAL_ADMIN" | "AUDITOR" | "READ_ONLY") => ({ id: (await createUser({ role })).id, role });

async function dealer(extra: Partial<typeof dealers.$inferInsert> = {}) {
  const u = await createUser({ role: "DEALER" });
  const [d] = await db.insert(dealers).values({ userId: u.id, legalName: `D ${u.id.slice(0, 4)}`, contactName: "D", dealerType: "INDIVIDUAL", status: "APPROVED", ...extra }).returning();
  return { dealer: d, actor: { id: u.id, role: "DEALER" as const } };
}

const versionId = async (code: string, version = 1) =>
  (await db.select({ id: dealerSchemeVersions.id }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, code), eq(dealerSchemeVersions.version, version))))[0].id;

describe("roles (phase 6)", () => {
  it("a Dealership Manager drafts but does not publish; Finance pays but does not touch schemes; Read-only changes nothing", async () => {
    const manager = await staff("DEALERSHIP_MANAGER");
    const finance = await staff("FINANCE_ADMIN");
    const reader = await staff("READ_ONLY");
    const { version } = await createScheme(manager, { code: "MGR_DRAFT", name: "Manager draft", category: "DEALERSHIP", reason: R });
    await expect(publishVersion(manager, version.id, { reason: R })).rejects.toThrow(/may not/);
    await expect(createScheme(finance, { code: "FIN_X", name: "Finance X", category: "DEALERSHIP", reason: R })).rejects.toThrow(/may not/);
    await expect(createScheme(reader, { code: "READ_X", name: "Read X", category: "DEALERSHIP", reason: R })).rejects.toThrow(/may not/);
    const business = await staff("BUSINESS_ADMIN");
    await publishVersion(business, version.id, { reason: R });
    // The month close is Finance's (and not the Business Admin's).
    const month = "2026-01";
    await expect(closeCommissionMonth(month, business, new Date("2026-03-01T00:00:00Z"))).rejects.toThrow();
    await closeCommissionMonth(month, finance, new Date("2026-03-01T00:00:00Z"));
  });

  it("a Regional Admin decides only dealers in his regions", async () => {
    const regional = await staff("REGIONAL_ADMIN");
    await setRegionScope(admin, regional.id, ["MH"]);
    const pune = (await dealer({ status: "PENDING", state: "Maharashtra" })).dealer;
    const blr = (await dealer({ status: "PENDING", state: "Karnataka" })).dealer;
    await expect(decideDealer(blr.id, { action: "REJECT", reason: "outside the region" }, regional)).rejects.toThrow(/outside your regions/);
    const r = await decideDealer(pune.id, { action: "REJECT", reason: "inside the region" }, regional);
    expect(r.dealer.status).toBe("REJECTED");
  });
});

describe("maker-checker (dealer_platform_four_eye)", () => {
  it("publishing waits for a second admin; the requester cannot approve his own request", async () => {
    await setFeatureFlag("dealer_platform_four_eye", { enabled: true, districtCodes: null }, "on (test)", admin);
    const second = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const { scheme, version } = await createScheme(admin, { code: "FOUR_EYE", name: "Four eye", category: "DEALERSHIP", reason: R });
    await saveDraft(admin, scheme.id, { versionId: version.id, terms: { ...blankTerms("DEALERSHIP"), summary: "Four-eye test scheme terms." }, reason: R });
    const pending = await requestDealerApproval({ type: "DEALER_SCHEME_PUBLISH", actor: admin, subjectType: "dealer_scheme", subjectId: scheme.id, title: "Publish", reason: R, payload: { versionId: version.id } });
    expect(pending.pendingApproval).toBe(true);
    expect((await db.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, version.id)))[0].status).toBe("DRAFT");
    await expect(decideApproval({ requestId: pending.approvalId, actor: admin, decision: "APPROVE" })).rejects.toThrow();
    await decideApproval({ requestId: pending.approvalId, actor: second, decision: "APPROVE" });
    expect((await db.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, version.id)))[0].status).toBe("PUBLISHED");
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.approvalId));
    expect(req.status).toMatch(/APPROVED|APPLIED/);
  });
});

describe("scheme change (phase 6)", () => {
  it("a free dealer accepts Business Partner, pays, and is upgraded; staff need his acceptance", async () => {
    const { dealer: d, actor } = await dealer();
    expect((await currentDealerScheme(d.id))?.schemeCode).toBe("FREE");
    const bp = await versionId("BUSINESS_PARTNER");
    const [bpRow] = await db.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, bp));
    // Staff cannot move him before he accepts.
    await expect(changeDealerScheme(admin, d.id, bp, R)).rejects.toThrow(/not accepted/);
    const res = await requestSchemeChange(actor, { versionId: bp, termsHash: bpRow.termsHash }).catch((e: Error) => e);
    // The sandbox gateway may not be the test default: either a payment opened, or it failed after the acceptance.
    const [payment] = await db.select().from(dealerJoiningPayments).where(eq(dealerJoiningPayments.dealerId, d.id));
    expect(payment).toMatchObject({ versionId: bp, totalPaise: 1_298_000 });
    if (!(res instanceof Error)) expect(res.applied).toBe(false);
    const intent = { id: payment.paymentIntentId ?? randomUUID(), purpose: "DEALER_JOINING_FEE", referenceId: payment.id, userId: actor.id, amountPaise: 1_298_000, refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRef;
    await db.transaction((tx) => onJoiningFeeCaptured(intent, tx));
    expect(await currentDealerScheme(d.id)).toMatchObject({ schemeCode: "BUSINESS_PARTNER", source: "UPGRADE" });
    // Back to Free (accepted, no charge): applied at once as a downgrade.
    const free2 = await versionId("FREE", 2);
    const [freeRow] = await db.select().from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, free2));
    const down = await requestSchemeChange(actor, { versionId: free2, termsHash: freeRow.termsHash });
    expect(down.applied).toBe(true);
    expect(await currentDealerScheme(d.id)).toMatchObject({ schemeCode: "FREE", version: 2, source: "DOWNGRADE" });
  });
});

describe("dashboard (phase 6)", () => {
  it("counts dealers by scheme and commission liability; filters by scheme", async () => {
    const a = (await dealer()).dealer;
    await dealer();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Dash shop", status: "APPROVED" });
    await db.insert(dealerCommissionLedger).values({ dealerId: a.id, shopId: shop.id, milestone: "ACTIVATED", kind: "ACCRUAL", entryType: "SCHEME_ONE_TIME", amountPaise: 20_000, status: "EARNED", accrualKey: `T:${a.id}` } as never);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const d = await platformDashboard(admin, { from: "2026-01-01", to: today });
    expect(d.dealers.total).toBe(2);
    expect(d.dealers.free).toBe(2);
    expect(d.money.liabilityPaise).toBe(20_000);
    expect(d.money.commissionAccruedPaise).toBe(20_000);
    expect(d.schemes.find((s) => s.code === "FREE")?.dealers).toBe(2);
    const bp = await platformDashboard(admin, { from: "2026-01-01", to: today, scheme: "BUSINESS_PARTNER" });
    expect(bp.dealers.total).toBe(0);
    // Read-only staff see the same numbers; a Regional Admin with no regions sees none.
    expect((await platformDashboard(await staff("READ_ONLY"), { from: "2026-01-01", to: today })).dealers.total).toBe(2);
    expect((await platformDashboard(await staff("REGIONAL_ADMIN"), { from: "2026-01-01", to: today })).dealers.total).toBe(0);
    await setSchemeStatus(admin, (await db.select().from(dealerSchemes).where(eq(dealerSchemes.code, "GROWTH_PARTNER")))[0].id, "SUSPENDED", R);
  });
});
